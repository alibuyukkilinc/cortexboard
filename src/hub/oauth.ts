import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyPassword } from "./crypto.js";
import { RateLimiter } from "./limiter.js";
import { ROLE_PERMS } from "./roles.js";
import type { HubStore, User } from "./store.js";
import type { Hub } from "./server.js";

// OAuth 2.1 for the MCP endpoint, so a client that cannot be given a header can still connect: claude.ai and the
// Claude desktop app ("Add custom connector") only take a URL, then look for an authorization server (MCP
// authorization spec: protected resource metadata, RFC 8414 metadata, dynamic client registration, PKCE).
// The person signs in on the hub and picks the agent the client acts as; the token is that agent in that one
// project, plus the person for approvals (what `--human-token` gives a stdio client).

const CODE_TTL = 5 * 60_000;
const REQUEST_TTL = 15 * 60_000;
const WINDOW = 15 * 60_000;

type Params = { client_id: string; redirect_uri: string; state?: string; code_challenge: string; project: string };
type Pending = Params & { user: string; expires: number };
type Code = Params & { user: string; agent: string; expires: number };

const b64url = (b: Buffer) => b.toString("base64url");
const s256 = (v: string) => b64url(createHash("sha256").update(v).digest());
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// claude.ai, claude.com and every hosted client come over https; desktop and CLI clients listen on loopback.
export function redirectAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

// The project the client wants, from the resource it was given (…/mcp/p/<project>), as RFC 8707 asks.
export function projectFromResource(resource: string | undefined): string | null {
  const m = /\/mcp\/p\/([^/?#]+)\/?$/.exec(resource ?? "");
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

const TEXT = {
  en: {
    signIn: "Sign in to connect",
    signInBody: "wants to connect to Cortex. Sign in with your Cortex account first.",
    email: "Email",
    password: "Password",
    signInBtn: "Sign in",
    badLogin: "Email or password is not correct.",
    tooMany: "Too many attempts. Try again in 15 minutes.",
    title: "Connect an AI to Cortex",
    body: "{c} will work in project {p} as the AI agent you pick below. Questions that need your approval are asked of you, {u}.",
    agent: "Acts as AI agent",
    newAgent: "New agent:",
    allow: "Allow",
    deny: "Cancel",
    note: "You can disconnect it at any time on the board (avatar menu → Approve from the AI chat).",
    notMember: "You are not a member of project {p}.",
    notManager: "Only a project owner or admin can connect an AI to {p}: ask one of them, or ask for an agent token.",
    noProject: "Which project?",
    pick: "Continue",
    badRequest: "This connection request is not valid",
    expired: "This page has expired. Start connecting again from your AI app.",
  },
  tr: {
    signIn: "Bağlanmak için giriş yapın",
    signInBody: "Cortex'e bağlanmak istiyor. Önce Cortex hesabınızla giriş yapın.",
    email: "E-posta",
    password: "Şifre",
    signInBtn: "Giriş yap",
    badLogin: "E-posta ya da şifre yanlış.",
    tooMany: "Çok fazla deneme. 15 dakika sonra tekrar deneyin.",
    title: "Bir AI'ı Cortex'e bağla",
    body: "{c}, {p} projesinde aşağıda seçtiğiniz AI ajanı olarak çalışacak. Onay gereken sorular size, {u}, sorulur.",
    agent: "Hangi AI ajanı olarak",
    newAgent: "Yeni ajan:",
    allow: "İzin ver",
    deny: "Vazgeç",
    note: "Bağlantıyı panoda istediğiniz zaman kaldırabilirsiniz (profil menüsü → AI sohbetinden onay).",
    notMember: "{p} projesinin üyesi değilsiniz.",
    notManager: "{p} projesine AI'ı yalnız proje sahibi ya da yöneticisi bağlayabilir: onlardan isteyin ya da bir ajan token'ı isteyin.",
    noProject: "Hangi proje?",
    pick: "Devam",
    badRequest: "Bu bağlantı isteği geçersiz",
    expired: "Bu sayfanın süresi doldu. Bağlanmayı AI uygulamanızdan yeniden başlatın.",
  },
};
type Lang = keyof typeof TEXT;
const langOf = (req: FastifyRequest): Lang => (/^\s*tr\b/i.test(String(req.headers["accept-language"] ?? "")) ? "tr" : "en");

const CSS = `body{font-family:system-ui,sans-serif;background:#f6f7f9;color:#1d2330;margin:0;display:flex;justify-content:center;padding:3rem 1rem}
main{background:#fff;border:1px solid #dde1e8;border-radius:12px;padding:1.75rem;max-width:30rem;width:100%}
h1{font-size:1.25rem;margin:0 0 .75rem}label{display:block;font-weight:600;margin:.9rem 0 .3rem}
input,select{width:100%;box-sizing:border-box;padding:.55rem .65rem;border:1px solid #c5cbd6;border-radius:8px;font:inherit}
.row{display:flex;gap:.6rem;margin-top:1.4rem}button{padding:.6rem 1.1rem;border-radius:8px;border:1px solid #c5cbd6;background:#fff;font:inherit;cursor:pointer}
button.primary{background:#2f5bd3;border-color:#2f5bd3;color:#fff}.err{color:#b42318}.faint{color:#667085;font-size:.875rem}
.radio{display:flex;gap:.5rem;align-items:center;font-weight:400;margin:.4rem 0;white-space:nowrap}.radio input[type=radio]{width:auto}
@media (prefers-color-scheme:dark){body{background:#12151b;color:#e6e8ec}main{background:#1a1e26;border-color:#2c323d}input,select,button{background:#12151b;color:#e6e8ec;border-color:#3a414e}.faint{color:#98a2b3}}`;

function html(reply: FastifyReply, title: string, body: string, status = 200) {
  // The consent form answers with a redirect to the client (claude.ai): form-action must allow it.
  return reply
    .code(status)
    .header("cache-control", "no-store")
    .header(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'",
    )
    .type("text/html; charset=utf-8")
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`,
    );
}

const hidden = (fields: Record<string, string | undefined>) =>
  Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v!)}">`)
    .join("");

export function registerOAuth(
  app: FastifyInstance,
  ctx: {
    hub: Hub;
    baseUrl: () => string;
    sessionUser: (req: FastifyRequest) => User | null;
    setSession: (req: FastifyRequest, reply: FastifyReply, token: string) => unknown;
  },
): void {
  const store: HubStore = ctx.hub.store;
  const pending = new Map<string, Pending>();
  const codes = new Map<string, Code>();
  const limits = { register: new RateLimiter(20, WINDOW), login: new RateLimiter(10, WINDOW), token: new RateLimiter(30, WINDOW) };
  app.addHook("onClose", async () => Object.values(limits).forEach((l) => l.stop()));
  const sweep = () => {
    const now = Date.now();
    for (const m of [pending, codes] as Map<string, { expires: number }>[]) for (const [k, v] of m) if (v.expires < now) m.delete(k);
  };

  const issuer = () => ctx.baseUrl();
  const resourceUrl = (project: string) => `${issuer()}/mcp/p/${encodeURIComponent(project)}`;

  // ---- discovery -------------------------------------------------------------------------------

  const resourceMeta = (project?: string) => ({
    resource: project ? resourceUrl(project) : issuer(),
    authorization_servers: [issuer()],
    bearer_methods_supported: ["header"],
    resource_name: project ? `Cortex: ${project}` : "Cortex",
  });
  app.get("/.well-known/oauth-protected-resource", async () => resourceMeta());
  app.get("/.well-known/oauth-protected-resource/mcp/p/:project", async (req) => resourceMeta((req.params as { project: string }).project));

  const serverMeta = () => ({
    issuer: issuer(),
    authorization_endpoint: `${issuer()}/oauth/authorize`,
    token_endpoint: `${issuer()}/oauth/token`,
    registration_endpoint: `${issuer()}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["cortex"],
  });
  // Some clients look under the resource's path or for OpenID configuration; the answer is the same.
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/*", "/.well-known/openid-configuration"])
    app.get(path, async () => serverMeta());

  // OAuth endpoints take form posts; the parser is scoped to them, the rest of the hub stays JSON only.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );

    // ---- dynamic client registration (RFC 7591) ----------------------------------------------

    scope.post("/oauth/register", async (req, reply) => {
      if (limits.register.blocked(req.ip)) return reply.code(429).send({ error: "slow_down", error_description: "Too many registrations." });
      limits.register.fail(req.ip); // every registration counts: it is open to anyone
      const b = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
      const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
      if (!uris.length || uris.length > 10 || !uris.every(redirectAllowed))
        return reply.code(400).send({ error: "invalid_redirect_uri", error_description: "Send https redirect_uris (or http on localhost)." });
      const c = store.registerOAuthClient(typeof b.client_name === "string" ? b.client_name : "", uris);
      return reply.code(201).send({
        client_id: c.id,
        client_id_issued_at: Math.floor(Date.parse(c.created_at) / 1000),
        client_name: c.name,
        redirect_uris: c.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    });

    // ---- authorize: sign in, pick the agent, consent ------------------------------------------

    // Checks what can be checked before anyone signs in. A bad client or redirect is never redirected to.
    const parse = (q: Record<string, string | undefined>): { params: Params | null; client?: string; error?: string } => {
      const client = store.oauthClient(q.client_id);
      if (!client) return { params: null, error: "unknown client_id" };
      if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) return { params: null, error: "redirect_uri is not registered" };
      if (q.response_type !== "code") return { params: null, error: "response_type must be code" };
      if (!q.code_challenge || (q.code_challenge_method ?? "plain") !== "S256") return { params: null, error: "PKCE (S256) is required" };
      const project = projectFromResource(q.resource) ?? q.project ?? "";
      return {
        client: client.name,
        params: { client_id: client.id, redirect_uri: q.redirect_uri, state: q.state, code_challenge: q.code_challenge, project },
      };
    };

    const loginPage = (reply: FastifyReply, l: Lang, client: string, query: string, error?: string) => {
      const t = TEXT[l];
      return html(
        reply,
        t.signIn,
        `<h1>${esc(t.signIn)}</h1><p><b>${esc(client)}</b> ${esc(t.signInBody)}</p>${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/oauth/login">${hidden({ next: query })}
<label for="e">${esc(t.email)}</label><input id="e" name="email" type="email" autocomplete="username" required autofocus>
<label for="p">${esc(t.password)}</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<div class="row"><button class="primary" type="submit">${esc(t.signInBtn)}</button></div></form>`,
        error ? 401 : 200,
      );
    };

    const canManage = (projectId: string, user: User) => {
      const m = ctx.hub.membership(projectId, { kind: "human", user });
      if (!m) return "member" as const;
      return (ROLE_PERMS[m.role] ?? []).includes("manage_members") ? ("ok" as const) : ("manager" as const);
    };

    scope.get("/oauth/authorize", async (req, reply) => {
      sweep();
      const q = req.query as Record<string, string | undefined>;
      const l = langOf(req);
      const t = TEXT[l];
      const { params, client, error } = parse(q);
      if (!params) return html(reply, t.badRequest, `<h1>${esc(t.badRequest)}</h1><p class="err">${esc(error!)}</p>`, 400);
      const query = new URLSearchParams(q as Record<string, string>).toString();
      const user = ctx.sessionUser(req);
      if (!user) return loginPage(reply, l, client!, query);

      // No project in the URL the person gave their AI: let them pick one they can connect.
      if (!params.project || !store.project(params.project)) {
        const mine = store.projects().filter((p) => canManage(p.id, user) === "ok");
        const keep = { ...q, project: undefined };
        return html(
          reply,
          t.title,
          `<h1>${esc(t.title)}</h1><form method="get" action="/oauth/authorize">${hidden(keep)}
<label for="pr">${esc(t.noProject)}</label><select id="pr" name="project">${mine.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.id)})</option>`).join("")}</select>
<div class="row"><button class="primary" type="submit">${esc(t.pick)}</button></div></form>`,
        );
      }
      const pname = store.project(params.project)!.name;
      const may = canManage(params.project, user);
      if (may !== "ok") {
        const msg = (may === "member" ? t.notMember : t.notManager).replace("{p}", pname);
        return html(reply, t.title, `<h1>${esc(t.title)}</h1><p class="err">${esc(msg)}</p>`, 403);
      }

      const id = b64url(randomBytes(24));
      pending.set(id, { ...params, user: user.id, expires: Date.now() + REQUEST_TTL });
      const agents = store
        .members(params.project)
        .filter((m) => m.kind === "ai")
        .map((m) => store.agent(m.principal))
        .filter((a) => a && !a.disabled);
      const suggested = `claude-${user.id}`.slice(0, 40);
      const options = agents
        .map(
          (a, i) =>
            `<label class="radio"><input type="radio" name="agent" value="${esc(a!.id)}"${i === 0 ? " checked" : ""}> ${esc(a!.name)} (${esc(a!.id)})</label>`,
        )
        .join("");
      return html(
        reply,
        t.title,
        `<h1>${esc(t.title)}</h1><p>${esc(t.body)
          .replace("{c}", `<b>${esc(client!)}</b>`)
          .replace("{p}", `<b>${esc(pname)}</b>`)
          .replace("{u}", esc(user.name))}</p>
<form method="post" action="/oauth/authorize">${hidden({ request: id })}
<label>${esc(t.agent)}</label>${options}
<label class="radio"><input type="radio" name="agent" value="__new"${agents.length ? "" : " checked"}> ${esc(t.newAgent)}
<input name="new_agent" value="${esc(store.agent(suggested) ? "" : suggested)}" pattern="[a-z0-9][a-z0-9_\\-]{0,39}" aria-label="${esc(t.newAgent)}"></label>
<div class="row"><button class="primary" type="submit" name="action" value="allow">${esc(t.allow)}</button><button type="submit" name="action" value="deny">${esc(t.deny)}</button></div>
<p class="faint">${esc(t.note)}</p></form>`,
      );
    });

    // The sign-in form of the authorize page. `next` is only ever the authorize query: no open redirect.
    scope.post("/oauth/login", async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, string | undefined>;
      const l = langOf(req);
      const next = new URLSearchParams(b.next ?? "");
      const client = store.oauthClient(next.get("client_id") ?? undefined)?.name ?? "MCP client";
      const key = `${req.ip}|${(b.email ?? "").trim().toLowerCase()}`;
      if (limits.login.blocked(key)) return loginPage(reply, l, client, next.toString(), TEXT[l].tooMany);
      const user = store.userByEmail(b.email ?? "");
      const good = await verifyPassword(b.password ?? "", user?.password ?? null);
      if (!user || !good || user.disabled) {
        limits.login.fail(key);
        return loginPage(reply, l, client, next.toString(), TEXT[l].badLogin);
      }
      limits.login.clear(key);
      ctx.setSession(req, reply, store.createSession(user.id));
      return reply.redirect(`/oauth/authorize?${next.toString()}`, 303);
    });

    scope.post("/oauth/authorize", async (req, reply) => {
      sweep();
      const b = (req.body ?? {}) as Record<string, string | undefined>;
      const l = langOf(req);
      const t = TEXT[l];
      const p = pending.get(b.request ?? "");
      const user = ctx.sessionUser(req);
      // The request id is random and tied to the signed-in person: another site cannot submit this form for them.
      if (!p || !user || p.user !== user.id) return html(reply, t.badRequest, `<h1>${esc(t.badRequest)}</h1><p class="err">${esc(t.expired)}</p>`, 400);
      pending.delete(b.request!);
      const back = new URL(p.redirect_uri);
      if (p.state !== undefined) back.searchParams.set("state", p.state);
      back.searchParams.set("iss", issuer());
      if (b.action !== "allow") {
        back.searchParams.set("error", "access_denied");
        return reply.redirect(back.toString(), 302);
      }
      if (canManage(p.project, user) !== "ok") return html(reply, t.title, `<p class="err">${esc(t.notManager.replace("{p}", p.project))}</p>`, 403);
      let agent = b.agent ?? "";
      try {
        if (agent === "__new") {
          agent = (b.new_agent ?? "").trim().toLowerCase();
          if (!store.agent(agent)) store.createAgent({ id: agent, name: agent }, user.id);
          if (!store.member(p.project, agent)) {
            store.setMember(p.project, agent, { role: "trusted" }); // a new agent in its own project: decision 01M3MXD1644M8SBHHT2RHP8XDB
            ctx.hub.syncActors(p.project);
          }
        }
      } catch (e) {
        return html(reply, t.title, `<h1>${esc(t.title)}</h1><p class="err">${esc((e as Error).message)}</p>`, 400);
      }
      const a = store.agent(agent);
      if (!a || a.disabled || store.member(p.project, agent)?.kind !== "ai")
        return html(reply, t.title, `<h1>${esc(t.title)}</h1><p class="err">${esc(`No agent "${agent}" in ${p.project}.`)}</p>`, 400);
      const code = b64url(randomBytes(32));
      codes.set(code, { ...p, agent, expires: Date.now() + CODE_TTL });
      back.searchParams.set("code", code);
      return reply.redirect(back.toString(), 302);
    });

    // ---- token -------------------------------------------------------------------------------

    scope.post("/oauth/token", async (req, reply) => {
      sweep();
      reply.header("cache-control", "no-store");
      // bad: a guess (unknown client, code or token) counts against the address.
      const fail = (error: string, description: string, status = 400, bad = false) => {
        if (bad) limits.token.fail(req.ip);
        return reply.code(status).send({ error, error_description: description });
      };
      if (limits.token.blocked(req.ip)) return fail("slow_down", "Too many bad requests. Try again in 15 minutes.", 429);
      const b = (req.body ?? {}) as Record<string, string | undefined>;
      // client_secret_basic: the client id may come in the Authorization header instead of the body.
      const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? "");
      const clientId = b.client_id ?? (basic ? decodeURIComponent(Buffer.from(basic[1], "base64").toString("utf8").split(":")[0]) : undefined);
      if (!store.oauthClient(clientId)) return fail("invalid_client", "Unknown client_id.", 401, true);

      if (b.grant_type === "authorization_code") {
        const c = codes.get(b.code ?? "");
        codes.delete(b.code ?? ""); // single use, whatever happens next
        if (!c || c.expires < Date.now() || c.client_id !== clientId) return fail("invalid_grant", "The code is unknown, used or expired.", 400, true);
        if (b.redirect_uri && b.redirect_uri !== c.redirect_uri) return fail("invalid_grant", "redirect_uri does not match.");
        if (!b.code_verifier || s256(b.code_verifier) !== c.code_challenge) return fail("invalid_grant", "PKCE verification failed.", 400, true);
        const tokens = store.issueOAuthTokens({ client_id: c.client_id, user_id: c.user, project_id: c.project, agent_id: c.agent });
        return { ...tokens, token_type: "Bearer", scope: "cortex" };
      }
      if (b.grant_type === "refresh_token") {
        const tokens = b.refresh_token ? store.refreshOAuthTokens(b.refresh_token, clientId!) : null;
        if (!tokens) return fail("invalid_grant", "The refresh token is unknown or expired.", 400, true);
        return { ...tokens, token_type: "Bearer", scope: "cortex" };
      }
      return fail("unsupported_grant_type", "Use authorization_code or refresh_token.");
    });
  });
}
