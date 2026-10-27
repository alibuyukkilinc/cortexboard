import { existsSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CSRF_HEADER } from "../api/auth.js";
import { baseServer, SAFE_METHODS } from "../api/server.js";
import { projectRoutes } from "../api/routes.js";
import { Cortex } from "../core/cortex.js";
import type { Actor } from "../core/types.js";
import { CortexError } from "../core/types.js";
import { buildAccess } from "./access.js";
import { PASSWORD_MIN, hashPassword, verifyPassword } from "./crypto.js";
import { ROLE_PERMS, ROLE_POLICY } from "./roles.js";
import type { Agent, HubStore, Member, OAuthGrant, Principal, User } from "./store.js";
import { SESSION_DAYS } from "./store.js";
import { RateLimiter } from "./limiter.js";
import { HUMAN_KEY_HEADER, registerMcpHttp } from "./mcpHttp.js";
import { registerOAuth } from "./oauth.js";
import type { PullResult } from "./gitSync.js";
import { pullProject } from "./gitSync.js";
import { commitKnowledge, knowledgeDir, knowledgeWhere, openHubProject, readLinked, registerProject } from "./knowledge.js";
import { saveLinked } from "../core/project.js";
import type { BackupResult } from "./backup.js";
import { cancelRestore, hubTarget, pendingRestore, stageRestore } from "./backup.js";
import { BackupRunner } from "../backup/core.js";
import { registerBackupRoutes } from "../backup/routes.js";
import { resolve as resolvePath } from "node:path";
import type { McpApi } from "../mcp/client.js";
import type { Access } from "../api/access.js";
import type { Via } from "../core/provenance.js";
import { provenance } from "../core/provenance.js";

// Reads a caller may aim at a linked project (?project=<id>): knowledge and items, nothing that writes,
// nothing about people's queues. Paths are relative to /api/p/:project.
const CROSS_READS = /^\/(search|tree|node|items)(\/|$)/;

// Whatever the caller's role over there, a linked read is read-only.
const readOnly = (a: Access): Access => ({ ...a, can: (p) => p === "read" && a.can(p) });

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
    chatVia?: Via; // a request made with a person's chat key: where their answer came from
  }
}

// What a chat key may do: read, and write what a person's answer in the AI chat writes (apply an answer,
// capture a note, decision or node). Paths are relative to /api/p/:project.
const CHAT_KEY_WRITES = [/^POST \/chat\/apply$/, /^POST \/items$/, /^POST \/items\/[^/]+\/replies$/, /^PUT \/node(\/.*)?$/];
export const VIA_HEADER = "x-cortex-via";

// The MCP server sends where the answer came from as base64url JSON. Only the fields provenance knows are kept.
function parseVia(raw: unknown): Via | null {
  if (typeof raw !== "string" || raw.length > 8000) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    if (v.channel !== "chat-elicitation" && v.channel !== "chat-relayed") return null;
    if (typeof v.ai_actor !== "string" || !/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(v.ai_actor)) return null;
    const s = (k: string, max: number) => (typeof v[k] === "string" ? { [k]: (v[k] as string).slice(0, max) } : {});
    return {
      channel: v.channel,
      ai_actor: v.ai_actor,
      ...s("session", 64),
      ...s("shown_hash", 64),
      ...s("verbatim", 2000),
      // A relayed answer is unverified whatever the sender claims.
      ...(v.channel === "chat-relayed" ? { unverified: true } : {}),
    };
  } catch {
    return null;
  }
}

export const HUB_COOKIE = "cortex_hub";
type Q = Record<string, string | undefined>;

// One running Cortex per registered project, opened on first use and kept watching its folder.
export class Hub {
  private open = new Map<string, { cortex: Cortex; fileActors: Actor[] }>();

  // The last pull per project, for the board. Kept in memory: after a restart the next pull refills it.
  readonly pulls = new Map<string, PullResult>();
  private pulling = new Set<string>();
  private pullTimer: NodeJS.Timeout | null = null;

  constructor(readonly store: HubStore) {}

  // Fast-forwards one project's checkout. One pull per project at a time; a second request waits for nothing
  // and gets the running one's answer from the next read of `pulls`.
  async pull(projectId: string): Promise<PullResult> {
    const p = this.store.project(projectId);
    if (!p) throw new CortexError("not_found", `No project "${projectId}".`, 404);
    if (this.pulling.has(projectId))
      return this.pulls.get(projectId) ?? { at: new Date().toISOString(), status: "skipped", message: "A pull is already running." };
    this.pulling.add(projectId);
    try {
      const r = await pullProject(p.path);
      this.pulls.set(projectId, r);
      // New files arrive through the folder watcher; a new HEAD through the staleness poll. Nothing else to do.
      if (r.status === "failed") console.error(`⚠ ${projectId}: ${r.message}`);
      return r;
    } finally {
      this.pulling.delete(projectId);
    }
  }

  // Knowledge the hub holds in its own folder is committed there, never pushed: history and undo without
  // anyone having to remember a commit. Every `seconds` (hub.yaml commit_seconds, default 60; 0 = off).
  async commitAll(): Promise<void> {
    for (const p of this.store.projects()) {
      if (knowledgeWhere(this.store.dir, p) !== "hub") continue;
      const r = await commitKnowledge(knowledgeDir(this.store.dir, p.id));
      if (r.error) console.error(`⚠ ${p.id}: could not commit knowledge: ${r.error}`);
    }
  }

  // Backups (src/hub/backup.ts, src/backup/core.ts): one at a time; the last result is kept in the hub folder
  // so a restart still knows when the last one ran.
  readonly backups = new BackupRunner(() => hubTarget(this.store));

  get lastBackup(): BackupResult | null {
    return this.backups.last;
  }

  backupNow(): Promise<BackupResult> {
    return this.backups.now();
  }

  get backupRunning(): boolean {
    return this.backups.isRunning;
  }

  startBackups(): void {
    this.backups.start();
  }

  // Set by `hub start`: stops this process and starts the hub again (a staged restore is applied on the way).
  restarter: (() => Promise<void>) | null = null;

  startCommitting(seconds: number): void {
    if (!(seconds > 0)) return;
    const timer = setInterval(() => void this.commitAll().catch(() => {}), seconds * 1000);
    timer.unref();
  }

  // Every project in turn, every `minutes`. Off unless hub.yaml asks for it (pull_minutes).
  startPulling(minutes: number): void {
    if (!(minutes > 0)) return;
    const run = async () => {
      for (const p of this.store.projects()) await this.pull(p.id).catch(() => {});
    };
    void run();
    this.pullTimer = setInterval(() => void run(), minutes * 60_000);
    this.pullTimer.unref();
  }

  cortex(projectId: string): Cortex {
    const cached = this.open.get(projectId);
    if (cached) return cached.cortex;
    const p = this.store.project(projectId);
    if (!p) throw new CortexError("not_found", `No project "${projectId}".`, 404);
    const cortex = new Cortex(openHubProject(this.store.dir, p));
    cortex.watch((e) => console.error(`⚠ ${projectId}: reindex failed: ${(e as Error).message}`));
    this.open.set(projectId, { cortex, fileActors: [...cortex.project.config.actors] });
    this.syncActors(projectId);
    return cortex;
  }

  // The core knows actors from the project file (history: owner, ai-agent...). Hub members are added in
  // memory so assignments, mentions and reports recognise them; nothing is written to the repository.
  syncActors(projectId: string): void {
    const o = this.open.get(projectId);
    if (!o) return;
    const members = this.store.members(projectId).map((m) => ({ id: m.principal, kind: m.kind }));
    const ids = new Set(members.map((m) => m.id));
    o.cortex.project.config.actors = [...members, ...o.fileActors.filter((a) => !ids.has(a.id))];
  }

  // Organization admins act as owners everywhere, so a project can never be locked out.
  membership(projectId: string, principal: Principal): Member | null {
    const id = principal.kind === "human" ? principal.user.id : principal.agent.id;
    const m = this.store.member(projectId, id);
    if (m) return m;
    if (principal.kind === "human" && principal.user.org_admin)
      return { project_id: projectId, principal: id, kind: "human", role: "owner", scope: "all", branches: [] };
    return null;
  }

  // Drops a project's open Cortex, so the next request opens it again (after its folder changed).
  forget(projectId: string): void {
    this.open.get(projectId)?.cortex.close();
    this.open.delete(projectId);
  }

  close(): void {
    if (this.pullTimer) clearInterval(this.pullTimer);
    this.backups.stop();
    for (const { cortex } of this.open.values()) cortex.close();
    this.open.clear();
  }
}

// "7d", "30d" or a date, like the report periods.
function sinceIso(since?: string): string {
  const rel = /^(\d{1,3})\s*d$/i.exec(since ?? "7d");
  if (rel) return new Date(Date.now() - Number(rel[1]) * 86400_000).toISOString();
  const t = Date.parse(since!);
  return isNaN(t) ? new Date(Date.now() - 7 * 86400_000).toISOString() : new Date(t).toISOString();
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const WINDOW = 15 * 60_000;

export function buildHubServer(hub: Hub): FastifyInstance {
  const store = hub.store;
  const app = baseServer({ trustProxy: store.settings.trust_proxy === true });
  // Per 15 minutes: 10 wrong passwords per address+email, 10 bad agent tokens or 20 dead invite links per address.
  const limits = { login: new RateLimiter(10, WINDOW), token: new RateLimiter(10, WINDOW), invite: new RateLimiter(20, WINDOW) };
  app.addHook("onClose", async () => Object.values(limits).forEach((l) => l.stop()));
  // An explicit setting wins. Otherwise Secure unless the hub only listens on this machine: guessing from
  // public_url missed hubs reached over plain LAN addresses, where a session cookie must not travel in clear.
  const secure = () => store.settings.cookie_secure ?? !LOOPBACK.has(store.settings.host);
  const baseUrl = () => (store.settings.public_url ?? `http://localhost:${store.settings.port}`).replace(/\/+$/, "");
  const inviteUrl = (token: string) => `${baseUrl()}/invite/${token}`;
  const setSession = (req: FastifyRequest, reply: FastifyReply, token: string) =>
    reply.setCookie(HUB_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: secure() || req.protocol === "https",
      path: "/",
      maxAge: SESSION_DAYS * 86400,
    });

  const PUBLIC = new Set(["/api/health", "/api/auth/login"]);

  app.addHook("onRequest", async (req, reply) => {
    const allowed = store.settings.allowed_hosts;
    if (allowed?.length) {
      const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
      // No silent localhost exception: behind a proxy any request can claim "Host: localhost".
      if (!allowed.includes(host)) {
        return reply.code(403).send({ error: { code: "forbidden_host", message: "Unknown host." } });
      }
    }
    const path = req.url.split("?")[0];
    const auth = req.headers.authorization ?? "";
    // Agent tokens can only be guessed by trying: every bad one counts against the address, REST and MCP alike.
    let agent: Agent | null = null;
    let chat: { user: User; project_id: string } | null = null;
    let oauth: OAuthGrant | null = null; // a connector's token (src/hub/oauth.ts)
    if (auth.startsWith("Bearer ") && (path.startsWith("/api/") || path.startsWith("/mcp/"))) {
      if (limits.token.blocked(req.ip))
        return reply.code(429).send({ error: { code: "rate_limited", message: "Too many bad tokens. Try again in 15 minutes." } });
      agent = store.agentByToken(auth.slice(7));
      if (!agent && path.startsWith("/api/")) chat = store.chatTokenUser(auth.slice(7));
      if (!agent && !chat) oauth = store.oauthGrant(auth.slice(7));
      if (!agent && !chat && !oauth) limits.token.fail(req.ip);
    }
    if (!path.startsWith("/api/") || PUBLIC.has(path) || path.startsWith("/api/auth/invite/")) return;

    if (auth.startsWith("Bearer ")) {
      if (oauth) {
        // One person let one client act as one agent in one project. Without a "via" header the token is that
        // agent; with one it carries that person's answers from the chat, exactly as their chat key would.
        const m = /^\/api\/p\/([^/]+)/.exec(path);
        if (!m || decodeURIComponent(m[1]) !== oauth.project_id)
          return reply.code(403).send({ error: { code: "token_scope", message: `This connection only works in "${oauth.project_id}".` } });
        if (req.headers[VIA_HEADER] === undefined) agent = oauth.agent;
        else chat = { user: oauth.user, project_id: oauth.project_id };
      }
      if (agent) req.principal = { kind: "ai", agent };
      else if (chat) {
        // A person's chat key: their project only, reads and chat answers only, and always with where the answer came from.
        const m = /^\/api\/p\/([^/]+)(\/.*)?$/.exec(path);
        const route = `${req.method} ${m?.[2] ?? "/"}`;
        if (!m || decodeURIComponent(m[1]) !== chat.project_id || !(SAFE_METHODS.has(req.method) || CHAT_KEY_WRITES.some((r) => r.test(route)))) {
          return reply
            .code(403)
            .send({ error: { code: "chat_key_scope", message: "A chat key only reads its project and records answers given in the AI chat." } });
        }
        const via = parseVia(req.headers[VIA_HEADER]);
        if (!via) return reply.code(400).send({ error: { code: "via_required", message: `A chat key needs the ${VIA_HEADER} header.` } });
        req.principal = { kind: "human", user: chat.user };
        req.chatVia = via;
      }
    } else {
      const user = store.sessionUser(req.cookies[HUB_COOKIE]);
      if (user) {
        if (!SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== "1") {
          return reply.code(403).send({ error: { code: "csrf", message: `Missing ${CSRF_HEADER} header.` } });
        }
        req.principal = { kind: "human", user };
        req.boardSession = true;
      }
    }
    if (!req.principal) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Sign in on the board, or send 'Authorization: Bearer <agent token>'." } });
    }
  });

  // Everything a chat-key request writes carries where the answer came from. Callback style on purpose:
  // the rest of the request runs inside the provenance context started here.
  app.addHook("onRequest", (req, _reply, done) => (req.chatVia ? provenance.run(req.chatVia, done) : done()));

  const me = (req: FastifyRequest): User => {
    if (req.principal?.kind !== "human") throw new CortexError("forbidden", "Only people can do this.", 403);
    return req.principal.user;
  };
  // The person themselves, signed in on the board: a chat key cannot manage chat keys.
  const boardPerson = (req: FastifyRequest): User => {
    if (req.chatVia) throw new CortexError("forbidden", "Sign in on the board to manage chat keys.", 403);
    return me(req);
  };
  const orgAdmin = (req: FastifyRequest): User => {
    const u = me(req);
    if (!u.org_admin) throw new CortexError("forbidden", "Only organization admins can do this.", 403);
    return u;
  };

  const INTERNAL = "x-cortex-internal";
  app.addHook("onSend", async (req, _reply, payload) => {
    const m = /^\/api\/p\/([^/?]+)(\/[^?]*)?/.exec(req.url);
    if (!m || !req.principal || req.headers[INTERNAL]) return payload;
    const id = req.principal.kind === "human" ? req.principal.user.id : req.principal.agent.id;
    const size = typeof payload === "string" ? Buffer.byteLength(payload) : 0;
    store.record({ project: decodeURIComponent(m[1]), principal: id, kind: req.principal.kind, route: `${req.method} ${m[2] ?? "/"}`, bytes: size });
    return payload;
  });
  // A meter, not a log: three months is plenty to answer "how much did this agent read last month?".
  store.forgetUsageBefore(new Date(Date.now() - 90 * 86400_000).toISOString());

  app.get("/api/health", async () => ({ ok: true, mode: "hub", org: store.settings.org }));

  // ---- sign in -------------------------------------------------------------------------------

  app.post("/api/auth/login", async (req, reply) => {
    const { email = "", password = "" } = (req.body ?? {}) as { email?: string; password?: string };
    const key = `${req.ip}|${email.trim().toLowerCase()}`;
    if (limits.login.blocked(key)) throw new CortexError("rate_limited", "Too many attempts. Try again in 15 minutes.", 429);
    const user = store.userByEmail(email);
    const good = await verifyPassword(password, user?.password ?? null);
    if (!user || !good || user.disabled) {
      limits.login.fail(key);
      throw new CortexError("invalid_login", "Email or password is not correct.", 401);
    }
    limits.login.clear(key);
    setSession(req, reply, store.createSession(user.id));
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    store.endSession(req.cookies[HUB_COOKIE]);
    return reply.clearCookie(HUB_COOKIE, { path: "/" }).send({ ok: true });
  });

  // Invite links set the first password, and later serve as password resets.
  // Invite tokens are random, but a door that answers "no" forever invites guessing: dead links count per address.
  const inviteFor = (req: FastifyRequest) => {
    if (limits.invite.blocked(req.ip)) throw new CortexError("rate_limited", "Too many invalid links. Try again in 15 minutes.", 429);
    const u = store.inviteUser((req.params as Q).token!);
    if (!u) {
      limits.invite.fail(req.ip);
      throw new CortexError("invalid_invite", "This link has expired or was already used. Ask an admin for a new one.", 404);
    }
    return u;
  };

  app.get("/api/auth/invite/:token", async (req) => {
    const u = inviteFor(req);
    return { email: u.email, name: u.name, org: store.settings.org };
  });

  app.post("/api/auth/invite/:token", async (req, reply) => {
    const token = (req.params as Q).token!;
    const u = inviteFor(req);
    const { password = "" } = (req.body ?? {}) as { password?: string };
    if (password.length < PASSWORD_MIN) throw new CortexError("weak_password", `Use at least ${PASSWORD_MIN} characters.`, 400);
    store.setPassword(u.id, await hashPassword(password));
    store.useInvite(token);
    setSession(req, reply, store.createSession(u.id));
    return { ok: true };
  });

  app.get("/api/hub/me", async (req) => {
    const p = req.principal!;
    const id = p.kind === "human" ? p.user.id : p.agent.id;
    const projects = store
      .projects()
      .map((pr) => ({ ...pr, member: hub.membership(pr.id, p) }))
      .filter((pr) => pr.member)
      .map((pr) => ({ id: pr.id, name: pr.name, role: pr.member!.role }));
    return {
      org: store.settings.org,
      hub_url: baseUrl(), // the address people and agents reach the hub at (public_url), for ready-made setup commands
      principal:
        p.kind === "human"
          ? { id, kind: "human", email: p.user.email, name: p.user.name, org_admin: p.user.org_admin }
          : { id, kind: "ai", name: p.agent.name },
      projects,
    };
  });

  // ---- a person's chat approval keys ------------------------------------------------------------

  // AI apps connected through OAuth (claude.ai connectors): the person sees and ends their own.
  app.get("/api/hub/connections", async (req) => ({ connections: store.oauthConnections(boardPerson(req).id) }));
  app.delete("/api/hub/connections/:id", async (req) => {
    store.revokeOAuthConnection(boardPerson(req).id, (req.params as Q).id!);
    return { ok: true };
  });

  app.get("/api/hub/chat-tokens", async (req) => ({ tokens: store.chatTokens(boardPerson(req).id) }));
  app.post("/api/hub/chat-tokens", async (req, reply) => {
    const u = boardPerson(req);
    const { project = "", label = "" } = (req.body ?? {}) as { project?: string; label?: string };
    if (!hub.membership(project, { kind: "human", user: u })) throw new CortexError("forbidden", `${u.id} is not a member of "${project}".`, 403);
    const r = store.createChatToken(u.id, project, label);
    return reply.code(201).send({ ...r, note: "Copy the key now: it is shown only once." });
  });
  app.delete("/api/hub/chat-tokens/:id", async (req) => {
    store.revokeChatToken(boardPerson(req).id, (req.params as Q).id!);
    return { ok: true };
  });

  // ---- organization admin ----------------------------------------------------------------------

  app.get("/api/admin/users", async (req) => {
    orgAdmin(req);
    return { users: store.users().map((u) => ({ ...u, projects: store.memberships(u.id).map((m) => ({ id: m.project_id, role: m.role })) })) };
  });
  app.post("/api/admin/users", async (req, reply) => {
    orgAdmin(req);
    const b = (req.body ?? {}) as { email?: string; name?: string; org_admin?: boolean; projects?: { id: string; role?: string }[] };
    const user = store.createUser({ email: b.email ?? "", name: b.name ?? "", org_admin: b.org_admin });
    for (const p of b.projects ?? []) {
      store.setMember(p.id, user.id, { role: p.role });
      hub.syncActors(p.id);
    }
    return reply.code(201).send({ user, invite_url: inviteUrl(store.createInvite(user.id)) });
  });
  app.patch("/api/admin/users/:id", async (req) => {
    const admin = orgAdmin(req);
    const id = (req.params as Q).id!;
    const b = (req.body ?? {}) as { name?: string; org_admin?: boolean; disabled?: boolean };
    if (id === admin.id && (b.disabled || b.org_admin === false)) throw new CortexError("forbidden", "You cannot lock yourself out.", 403);
    return { user: store.updateUser(id, b) };
  });
  // Delete a person or an agent for good. Their history in the projects stays; the id is never reused.
  app.delete("/api/admin/users/:id", async (req) => {
    const admin = orgAdmin(req);
    const id = (req.params as Q).id!;
    if (id === admin.id) throw new CortexError("forbidden", "You cannot delete yourself.", 403);
    for (const p of store.deleteUser(id, admin.id).projects) hub.syncActors(p);
    return { ok: true };
  });
  app.delete("/api/admin/agents/:id", async (req) => {
    const admin = orgAdmin(req);
    for (const p of store.deleteAgent((req.params as Q).id!, admin.id).projects) hub.syncActors(p);
    return { ok: true };
  });
  app.post("/api/admin/users/:id/invite", async (req) => {
    orgAdmin(req);
    const id = (req.params as Q).id!;
    if (!store.user(id)) throw new CortexError("not_found", `No user "${id}".`, 404);
    return { invite_url: inviteUrl(store.createInvite(id)) };
  });

  app.get("/api/admin/agents", async (req) => {
    orgAdmin(req);
    return { agents: store.agents().map((a) => ({ ...a, projects: store.memberships(a.id).map((m) => ({ id: m.project_id, role: m.role })) })) };
  });
  app.post("/api/admin/agents", async (req, reply) => {
    const admin = orgAdmin(req);
    const b = (req.body ?? {}) as { id?: string; name?: string; projects?: { id: string; role?: string }[] };
    const r = store.createAgent({ id: b.id ?? "", name: b.name }, admin.id);
    for (const p of b.projects ?? []) {
      store.setMember(p.id, r.agent.id, { role: p.role ?? "trusted" }); // a new agent in its own project: decision 01M3MXD1644M8SBHHT2RHP8XDB
      hub.syncActors(p.id);
    }
    return reply.code(201).send({ ...r, note: "Copy the token now: it is shown only once." });
  });
  app.post("/api/admin/agents/:id/token", async (req) => {
    orgAdmin(req);
    return { token: store.rotateAgentToken((req.params as Q).id!), note: "The old token stopped working." };
  });
  app.patch("/api/admin/agents/:id", async (req) => {
    orgAdmin(req);
    return { agent: store.updateAgent((req.params as Q).id!, (req.body ?? {}) as { name?: string; disabled?: boolean }) };
  });

  // Backups to BunnyCDN Storage or Google Drive (task 01M3NQYNRX7X7Z3660KFA2WHZQ). A restore is staged and
  // applied by the next start: the running hub's database cannot be swapped under it.
  registerBackupRoutes(app, "/api/admin/backup", {
    guard: (req) => orgAdmin(req).id,
    target: () => hubTarget(store),
    runner: hub.backups,
    extra: () => ({ pending_restore: pendingRestore(store.dir), can_restart: !!hub.restarter }),
    restore: async (_req, by, name, opts) => ({ staged: await stageRestore(store, name, by, opts), can_restart: !!hub.restarter }),
    cancelRestore: () => cancelRestore(store.dir),
  });
  // Restarts the hub process after answering, so the board can wait for it to come back.
  app.post("/api/admin/restart", async (req, reply) => {
    orgAdmin(req);
    const restart = hub.restarter;
    if (!restart) throw new CortexError("not_supported", "This hub was not started with `hub start`: restart it yourself.", 409);
    reply.raw.on("finish", () => setTimeout(() => void restart(), 200));
    return { restarting: true };
  });

  // Deliberately out of the way: usage is operational detail, looked at when someone asks
  // "why is this agent so expensive?", not part of the daily flow.
  app.get("/api/admin/usage", async (req) => {
    orgAdmin(req);
    const q = req.query as Q;
    const kind = q.kind === "human" || q.kind === "ai" ? q.kind : undefined;
    return { ...store.usage(sinceIso(q.since), { project: q.project, kind }), projects: store.projects().map((p) => ({ id: p.id, name: p.name })) };
  });

  app.get("/api/admin/projects", async (req) => {
    orgAdmin(req);
    return {
      projects: store.projects().map((p) => ({
        ...p,
        members: store.members(p.id).length,
        exists: existsSync(p.path) && knowledgeWhere(store.dir, p) !== null,
        knowledge: knowledgeWhere(store.dir, p),
        linked: readLinked(store.dir, p),
        pull: hub.pulls.get(p.id) ?? null,
      })),
      pull_minutes: store.settings.pull_minutes ?? 0,
    };
  });
  // Register a code folder. Its knowledge is created on request (init: true), in the hub's folder unless
  // knowledge: "repo" asks for <folder>/.cortex; a folder that already has .cortex keeps it there.
  app.post("/api/admin/projects", async (req, reply) => {
    const admin = orgAdmin(req);
    const b = (req.body ?? {}) as {
      path?: string;
      id?: string;
      name?: string;
      init?: boolean;
      language?: string;
      branches?: string[] | string;
      knowledge?: string;
    };
    if (!b.path?.trim()) throw new CortexError("invalid_project", "Send the project folder as path.", 400);
    const branches = typeof b.branches === "string" ? b.branches.split(",") : b.branches;
    const r = await registerProject(store, {
      path: b.path,
      id: b.id,
      name: b.name,
      init: b.init,
      language: b.language,
      branches: branches?.map((x) => String(x).trim()).filter(Boolean),
      knowledge: b.knowledge === "repo" ? "repo" : "hub",
    });
    store.setMember(r.id, admin.id, { role: "owner" });
    return reply.code(201).send({ project: { ...store.project(r.id), knowledge: r.where } });
  });
  // Point a project at its code folder on this machine (a restored hub, a moved checkout). Knowledge held in the
  // hub's folder stays put; the code folder is where code links and pulls look.
  app.put("/api/admin/projects/:id/path", async (req) => {
    orgAdmin(req);
    const id = (req.params as Q).id!;
    const raw = String(((req.body ?? {}) as { path?: string }).path ?? "").trim();
    if (!raw) throw new CortexError("invalid_project", "Send the folder as path.", 400);
    const path = resolvePath(raw);
    if (!existsSync(path)) throw new CortexError("invalid_project", `Folder not found: ${path}`, 400);
    const p = store.setProjectPath(id, path);
    hub.forget(id);
    return { project: { ...p, exists: knowledgeWhere(store.dir, p) !== null, knowledge: knowledgeWhere(store.dir, p) } };
  });
  // Which projects this one reads from (linked). Written to its cortex.config.yaml and applied at once. A link
  // is not access: grant_readers adds the project's AI agents as Readers where they are not members yet, the
  // step people otherwise forget (an agent linked but not a member gets 403 over there).
  app.put("/api/admin/projects/:id/links", async (req) => {
    orgAdmin(req);
    const id = (req.params as Q).id!;
    if (!store.project(id)) throw new CortexError("not_found", `No project "${id}".`, 404);
    const b = (req.body ?? {}) as { linked?: unknown; grant_readers?: unknown };
    if (!Array.isArray(b.linked)) throw new CortexError("invalid_request", "Send linked as a list of project ids.", 400, { example: { linked: ["backend"] } });
    const linked = [...new Set(b.linked.map((x) => String(x).trim()).filter(Boolean))];
    const unknown = linked.filter((x) => !store.project(x));
    if (unknown.length) throw new CortexError("invalid_request", `No such project: ${unknown.join(", ")}.`, 400);
    if (linked.includes(id)) throw new CortexError("invalid_request", "A project cannot link to itself.", 400);
    saveLinked(hub.cortex(id).project, linked);
    const granted: { project: string; agent: string }[] = [];
    if (b.grant_readers === true) {
      for (const m of store.members(id).filter((x) => x.kind === "ai")) {
        for (const target of linked) {
          if (store.member(target, m.principal)) continue;
          store.setMember(target, m.principal, { role: "reader" });
          hub.syncActors(target);
          granted.push({ project: target, agent: m.principal });
        }
      }
    }
    return { linked, granted };
  });
  app.delete("/api/admin/projects/:id", async (req) => {
    orgAdmin(req);
    store.removeProject((req.params as Q).id!);
    return { ok: true, note: "Unregistered. The project folder and its knowledge are untouched." };
  });

  // ---- one project: the regular API plus members ----------------------------------------------

  app.register(
    async (scope) => {
      scope.addHook("preHandler", async (req) => {
        const projectId = (req.params as Q).project!;
        if (!store.project(projectId)) throw new CortexError("not_found", `No project "${projectId}".`, 404);
        const p = req.principal!;
        const m = hub.membership(projectId, p);
        // Name both sides: an agent's refusal is read in someone else's log, where "this project" means nothing.
        if (!m) throw new CortexError("forbidden", `${p.kind === "human" ? p.user.id : p.agent.id} is not a member of "${projectId}".`, 403);
        req.cortex = hub.cortex(projectId);
        // A membership granted outside the API (`cortexboard hub member`) is live at once: the row decides
        // access, and the actor list catches up here so assignments and reports name the newcomer too.
        if (!req.cortex.project.config.actors.some((a) => a.id === m.principal)) hub.syncActors(projectId);
        req.access = buildAccess(m);
        req.actor = { id: m.principal, kind: m.kind, ...(ROLE_POLICY[m.role] ? { policy: ROLE_POLICY[m.role] } : {}) };

        const linked = req.cortex.project.config.linked ?? [];
        req.linkedProjects = () =>
          linked
            .filter((id) => store.project(id))
            .map((id) => {
              const readable = !!hub.membership(id, p);
              return { id, name: store.project(id)!.name, summary: readable ? (hub.cortex(id).tree.read("")?.summary ?? "") : "", readable };
            });

        // A read aimed at a linked project: switch to that project, with the caller's membership there.
        const target = (req.query as Q | undefined)?.project;
        if (target && target !== projectId) {
          const route = (req.routeOptions.url ?? "").replace(/^\/api\/p\/:project/, "");
          if (!SAFE_METHODS.has(req.method) || !CROSS_READS.test(route)) {
            throw new CortexError("cross_project_read_only", "Linked projects can only be searched and read (search, tree, node, items).", 400);
          }
          if (!linked.includes(target)) {
            throw new CortexError("not_linked", `"${target}" is not linked from "${projectId}".`, 400, {
              linked,
              hint: `An owner adds it under linked: in ${projectId}'s .cortex/cortex.config.yaml.`,
            });
          }
          if (!store.project(target)) throw new CortexError("not_found", `No project "${target}".`, 404);
          const tm = hub.membership(target, p);
          if (!tm) throw new CortexError("forbidden", `${m.principal} is not a member of "${target}" (linked from "${projectId}").`, 403);
          req.cortex = hub.cortex(target);
          req.access = readOnly(buildAccess(tm));
          req.actor = { id: tm.principal, kind: tm.kind };
          req.crossProject = target;
        }
        // Full file addresses for agents elsewhere: the public address, else the one this request came in on
        // (an MCP call replayed in-process has none of its own). A linked item's files sit under its own project.
        const origin = store.settings.public_url ?? (req.headers[INTERNAL] ? baseUrl() : `${req.protocol}://${req.host}`);
        req.apiBase = `${origin.replace(/\/+$/, "")}/api/p/${encodeURIComponent(req.crossProject ?? projectId)}`;
      });

      await scope.register(projectRoutes);

      scope.get("/usage", async (req) => {
        if (!req.access!.can("reports")) throw new CortexError("forbidden", "Your role cannot read reports.", 403);
        // Same rule as the project report: someone who sees only part of the project gets no project-wide numbers.
        if (req.access!.restricted) throw new CortexError("forbidden", "These numbers cover the whole project; your membership sees only part of it.", 403);
        const q = req.query as Q;
        const kind = q.kind === "human" || q.kind === "ai" ? q.kind : undefined;
        return store.usage(sinceIso(q.since), { project: (req.params as Q).project!, kind });
      });

      // Where this project's checkout stands against its upstream, and how much hub-written knowledge waits
      // for a person to commit. The hub only ever pulls; committing stays with people.
      scope.get("/git", async (req) => {
        const projectId = (req.params as Q).project!;
        return { pull_minutes: store.settings.pull_minutes ?? 0, last: hub.pulls.get(projectId) ?? null };
      });
      scope.post("/git/pull", async (req) => {
        if (req.actor.kind !== "human" || !req.access!.can("approve")) {
          throw new CortexError("forbidden", "Only people who can approve may pull this project's checkout.", 403);
        }
        return { result: await hub.pull((req.params as Q).project!) };
      });

      scope.get("/members", async (req) => {
        const projectId = (req.params as Q).project!;
        const describe = (m: Member) => {
          const u = m.kind === "human" ? store.user(m.principal) : null;
          const a = m.kind === "ai" ? store.agent(m.principal) : null;
          return { ...m, name: u?.name ?? a?.name ?? m.principal, ...(u && req.access!.can("manage_members") ? { email: u.email } : {}) };
        };
        return { members: store.members(projectId).map(describe) };
      });
      // People and agents this caller may add to this project without typing an id/email from scratch.
      // An organization admin already manages the whole hub and sees everyone. Anyone else (a project
      // owner/admin who is not an org admin) only sees people and agents already known to them through
      // another project they also administer — never the whole hub's roster, which would leak identities
      // across unrelated projects. Inviting someone genuinely new by email, or creating a new agent, does
      // not go through this list and is unaffected.
      scope.get("/members/candidates", async (req) => {
        if (!req.access!.can("manage_members")) throw new CortexError("forbidden", "Your role cannot manage members.", 403);
        const projectId = (req.params as Q).project!;
        const taken = new Set(store.members(projectId).map((m) => m.principal));
        const p = req.principal!;
        const isOrgAdmin = p.kind === "human" && p.user.org_admin;
        const callerId = p.kind === "human" ? p.user.id : p.agent.id;
        const visible = isOrgAdmin
          ? { users: store.users(), agents: store.agents() }
          : (() => {
              const otherProjects = new Set(
                store
                  .memberships(callerId)
                  .filter((m) => m.project_id !== projectId && (m.role === "owner" || m.role === "admin"))
                  .map((m) => m.project_id),
              );
              const ids = new Set([...otherProjects].flatMap((pid) => store.members(pid).map((m) => m.principal)));
              return { users: store.users().filter((u) => ids.has(u.id)), agents: store.agents().filter((a) => ids.has(a.id)) };
            })();
        return {
          candidates: [
            ...visible.users.filter((u) => !u.disabled && !taken.has(u.id)).map((u) => ({ id: u.id, name: u.name, kind: "human" })),
            ...visible.agents.filter((a) => !a.disabled && !taken.has(a.id)).map((a) => ({ id: a.id, name: a.name, kind: "ai" })),
          ],
        };
      });
      scope.put("/members/:principal", async (req) => {
        if (!req.access!.can("manage_members")) throw new CortexError("forbidden", "Your role cannot manage members.", 403);

        const { project, principal } = req.params as Q;
        const b = (req.body ?? {}) as { role?: string; scope?: string; branches?: string[] };
        // Only owners hand out or take away ownership.
        const current = store.member(project!, principal!);
        if ((b.role === "owner" || current?.role === "owner") && req.access!.role !== "owner") {
          throw new CortexError("forbidden", "Only owners can change ownership.", 403);
        }
        const m = store.setMember(project!, principal!, b);
        hub.syncActors(project!);
        return { member: m };
      });
      // A project's owner or admin can bring people and AI agents in without an organization admin.
      // What they hand out is scoped to this project: never organization admin, never another project.
      const canManage = (req: FastifyRequest) => {
        if (!req.access!.can("manage_members")) throw new CortexError("forbidden", "Your role cannot manage members.", 403);
      };

      scope.post("/members/invite", async (req, reply) => {
        canManage(req);
        const project = (req.params as Q).project!;
        const b = (req.body ?? {}) as { email?: string; name?: string; role?: string; scope?: string; branches?: string[] };
        const existing = b.email ? store.userByEmail(b.email) : null;
        const user = existing ?? store.createUser({ email: b.email ?? "", name: b.name ?? "" });
        const member = store.setMember(project, user.id, { role: b.role, scope: b.scope, branches: b.branches });
        hub.syncActors(project);
        // Someone who already has a password signs in as usual; a new person needs a link to set one.
        const invite_url = user.has_password ? undefined : inviteUrl(store.createInvite(user.id));
        return reply.code(201).send({ user: { id: user.id, name: user.name, email: user.email }, member, ...(invite_url ? { invite_url } : {}) });
      });

      scope.get("/agents", async (req) => {
        canManage(req);
        const project = (req.params as Q).project!;
        const agents = store
          .members(project)
          .filter((m) => m.kind === "ai")
          .map((m) => ({ ...store.agent(m.principal), role: m.role }))
          .filter((a) => a.id);
        return { agents };
      });

      scope.post("/agents", async (req, reply) => {
        canManage(req);
        const project = (req.params as Q).project!;
        const b = (req.body ?? {}) as { id?: string; name?: string; role?: string };
        const r = store.createAgent({ id: b.id ?? "", name: b.name }, req.actor.id);
        store.setMember(project, r.agent.id, { role: b.role ?? "trusted" }); // decision 01M3MXD1644M8SBHHT2RHP8XDB
        hub.syncActors(project);
        return reply.code(201).send({ ...r, note: "Copy the token now: it is shown only once." });
      });

      scope.post("/agents/:id/token", async (req) => {
        canManage(req);
        const { project, id } = req.params as Q;
        // Only agents that work on this project, so one project cannot reset another project's agent.
        if (store.member(project!, id!)?.kind !== "ai") throw new CortexError("not_found", `No agent "${id}" in this project.`, 404);
        // A token acts in every project the agent belongs to. Resetting it hands the new token to whoever asked,
        // so they must be able to manage all of those projects, not only this one.
        const principal = req.principal!;
        const elsewhere = store
          .memberships(id!)
          .map((m) => m.project_id)
          .filter((p) => {
            const m = hub.membership(p, principal);
            return !m || !(ROLE_PERMS[m.role as keyof typeof ROLE_PERMS] ?? []).includes("manage_members");
          });
        if (elsewhere.length) {
          throw new CortexError("forbidden", `This agent also works on ${elsewhere.join(", ")}; ask an organization admin for a new token.`, 403);
        }
        return { token: store.rotateAgentToken(id!), note: "The old token stopped working." };
      });

      scope.delete("/members/:principal", async (req) => {
        if (!req.access!.can("manage_members")) throw new CortexError("forbidden", "Your role cannot manage members.", 403);
        const { project, principal } = req.params as Q;
        const current = store.member(project!, principal!);
        if (current?.role === "owner" && req.access!.role !== "owner") throw new CortexError("forbidden", "Only owners can remove an owner.", 403);
        if (current?.role === "owner" && store.members(project!).filter((m) => m.role === "owner").length === 1) {
          throw new CortexError("last_owner", "This is the project's only owner. Add another owner first.", 409);
        }
        store.removeMember(project!, principal!);
        hub.syncActors(project!);
        return { ok: true };
      });
    },
    { prefix: "/api/p/:project" },
  );

  // A connector that can only be given a URL (claude.ai, the Claude desktop app) signs in here: src/hub/oauth.ts.
  registerOAuth(app, { hub, baseUrl, sessionUser: (req) => store.sessionUser(req.cookies[HUB_COOKIE]), setSession });

  // MCP over HTTP for agents that do not run on this machine. Every tool call goes through the same
  // routes, token check and role as REST: the MCP endpoint just replays it into this server.
  // humanKey: the person's chat key (x-cortex-human-token), as `--human-token` does for stdio: the
  // approval tools are offered and what the person answers is recorded as theirs, through the same
  // chat-key path (scope, role, via) a remote MCP server would use.
  const mcpResourceMeta = (project: string) => `${baseUrl()}/.well-known/oauth-protected-resource/mcp/p/${encodeURIComponent(project)}`;
  registerMcpHttp(
    app,
    (project, token, humanKey) => {
      // A connector's OAuth token is the agent and the person in one: approvals go out as that person.
      const grant = store.agentByToken(token) ? null : store.oauthGrant(token);
      if (grant && grant.project_id !== project) throw new CortexError("forbidden", `This connection only works in "${grant.project_id}".`, 403);
      const agent = grant?.agent ?? store.agentByToken(token);
      if (!agent) throw new CortexError("unauthorized", "Unknown or disabled agent token.", 401);
      if (!store.project(project)) throw new CortexError("not_found", `No project "${project}".`, 404);
      if (!hub.membership(project, { kind: "ai", agent })) throw new CortexError("forbidden", `${agent.id} is not a member of "${project}".`, 403);
      const base = `/api/p/${encodeURIComponent(project)}`;
      const caller =
        (bearer: string, principal: string, kind: "ai" | "human", via?: Via): McpApi["call"] =>
        async (method, path, opts = {}) => {
          const query = new URLSearchParams();
          for (const [k, v] of Object.entries(opts.query ?? {})) {
            if (v === undefined || v === null || v === "") continue;
            query.set(k, Array.isArray(v) ? v.join(",") : String(v));
          }
          const q = query.toString();
          const started = Date.now();
          const res = await app.inject({
            method: method as "GET",
            url: `${base}${path}${q ? `?${q}` : ""}`,
            headers: {
              authorization: `Bearer ${bearer}`,
              [INTERNAL]: "1",
              ...(via ? { [VIA_HEADER]: Buffer.from(JSON.stringify(via)).toString("base64url") } : {}),
            },
            ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
          });
          store.record({
            project,
            principal,
            kind,
            route: `MCP ${method} ${path || "/"}`,
            bytes: Buffer.byteLength(res.body ?? ""),
            ms: Date.now() - started,
          });
          if (res.statusCode >= 400) {
            const e = (res.json() as { error?: { code?: string; message?: string; hint?: unknown } }).error ?? {};
            throw new CortexError(e.code ?? "error", e.message ?? `Request failed (${res.statusCode}).`, res.statusCode, e.hint);
          }
          return opts.binary ? res.rawPayload : opts.text ? res.body : res.json();
        };
      const api: McpApi = { where: `${project} @ ${store.settings.org}`, call: caller(token, agent.id, "ai"), close: async () => {} };
      if (grant) {
        const person = hub.membership(project, { kind: "human", user: grant.user });
        return person ? { ...api, human: { id: person.principal, as: (via: Via) => ({ call: caller(token, person.principal, "human", via) }) } } : api;
      }
      if (!humanKey) return api;
      const chat = store.chatTokenUser(humanKey);
      const person = chat && chat.project_id === project ? hub.membership(project, { kind: "human", user: chat.user }) : null;
      if (!chat || !person) {
        throw new CortexError(
          "forbidden",
          `The chat key in ${HUMAN_KEY_HEADER} is not a person's key for "${project}".`,
          403,
          "Make one on the board for this project (avatar menu → approve from the AI chat), or leave the header out.",
        );
      }
      return { ...api, human: { id: person.principal, as: (via: Via) => ({ call: caller(humanKey, person.principal, "human", via) }) } };
    },
    { resourceMetadata: mcpResourceMeta },
  );

  app.addHook("onClose", async () => hub.close());
  return app;
}
