import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Cortex } from "../core/cortex.js";
import { reportToMarkdown } from "../core/reportMarkdown.js";
import type { Activity, NodeSummary } from "../core/types.js";
import { CortexError } from "../core/types.js";
import { actionable } from "../core/staleness.js";
import type { InboxReason } from "../core/items.js";
import { INBOX_ORDER } from "../core/items.js";
import { MAX_ATTACHMENT_BYTES, isSafeImage, isText, mediaType } from "../store/attachments.js";
import type { DocKind } from "../index/db.js";
import type { Access, ItemRef } from "./access.js";
import { hidden, need } from "./access.js";
import type { ChatKind } from "../core/chatApprovals.js";
import { chatApprovals, chatSettings } from "../core/chatApprovals.js";
import type { ChatAnswer } from "../core/chat.js";
import type { Perm } from "./access.js";
import type { FormSchema, PromptPlan, PromptStatus } from "../core/chatPrompts.js";
import { planKind } from "../core/chatPrompts.js";
import { currentVia } from "../core/provenance.js";
import { shortIdSuffix } from "../util/text.js";

// One row of a person's inbox: an item, a draft or a stale node. `at` only sorts, it is not sent.
type InboxRow = { reason: InboxReason; id: string; title: string; at: string; blocking?: boolean; [k: string]: unknown };

export interface LinkedProject {
  id: string;
  name: string;
  summary: string;
  readable: boolean; // the caller is a member there too; otherwise the link is listed but reads are refused
}

declare module "fastify" {
  interface FastifyRequest {
    cortex: Cortex;
    access?: Access;
    // Set by the hub when a read is aimed at a linked project (?project=<id>): req.cortex is that project.
    crossProject?: string;
    linkedProjects?: () => LinkedProject[];
    // Where this project's API is reached from outside, e.g. https://hub.example.com/api/p/shop. Set by the
    // host; attachments carry full addresses from it, since an agent on another machine cannot use a bare name.
    apiBase?: string;
    // Signed in on the board with a session cookie: the person at their own browser, not a token a process
    // holds. Answers to questions asked on the board count only from here.
    boardSession?: boolean;
  }
}

type Q = Record<string, string | undefined>;
const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
const bool = (v: string | undefined) => (v === "true" ? true : v === "false" ? false : undefined);
const list = (v: string | undefined) =>
  v
    ? v
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : undefined;

// Every response carries _meta so AIs notice rule changes without re-reading the rules.
const ok = (req: FastifyRequest, data: object) => ({ ...(req.crossProject ? { project: req.crossProject } : {}), ...data, _meta: req.cortex.meta() });

const itemOf =
  (c: Cortex) =>
  (id: string): ItemRef | null =>
    c.index.getItem(id);

const withUrls = <T extends { name: string }>(req: FastifyRequest, id: string, files: T[]) =>
  req.apiBase ? files.map((f) => ({ ...f, url: `${req.apiBase}/items/${encodeURIComponent(id)}/files/${encodeURIComponent(f.name)}` })) : files;

// Visibility helpers: with no access object (single-project mode) everything is visible.
const seesNode = (req: FastifyRequest, path: string) => !req.access || req.access.seesNode(path);
const seesItem = (req: FastifyRequest, i: ItemRef | null) => !!i && (!req.access || req.access.seesItem(i));
const seesActivity = (req: FastifyRequest, a: Activity) => !req.access || req.access.seesActivity(a, itemOf(req.cortex));
const itemVisibleOr404 = (req: FastifyRequest, id: string) => {
  if (!seesItem(req, req.cortex.index.getItem(id))) throw hidden(`Item ${id}`);
};

// Item routes and refs take the full id or the short one the board shows (#ZKFBA9), so a person can say
// "do ZKFBA9" and the AI opens that card.
const FULL_ID = /^[0-9A-Z]{26}$/;
const ITEM_ROUTE = /\/(items|discussions)\/:id(\/|$)/;

// The full id for a short one, among the items this caller sees. Unchanged when it is a full id, cannot be a
// short id or matches nothing (the route then answers its usual not-found); several matches are refused.
function resolveItemId(req: FastifyRequest, ref: string): string {
  if (FULL_ID.test(ref)) return ref;
  const suffix = shortIdSuffix(ref);
  if (!suffix) return ref;
  const items = req.cortex.index
    .itemIdsEndingWith(suffix)
    .map((id) => req.cortex.index.getItem(id))
    .filter((i) => seesItem(req, i));
  if (items.length > 1) {
    throw new CortexError("ambiguous_id", `"${ref}" matches ${items.length} items. Use more characters or the full id.`, 409, {
      candidates: items.map((i) => ({ id: i!.id, type: i!.type, title: i!.title })),
    });
  }
  return items[0]?.id ?? ref;
}

// Refs mix item ids and knowledge paths. Paths are lower-case slugs, so only "#..." or an upper-case code is
// read as a short id, and a code that matches no item stays as it was.
const resolveRef = (req: FastifyRequest, ref: string) => (/^#|^[0-9A-Z]{4,25}$/.test(ref) ? resolveItemId(req, ref) : ref);

function pruneTree(req: FastifyRequest, n: NodeSummary): NodeSummary {
  if (!n.children) return n;
  const kids = n.children.filter((k) => seesNode(req, k.path)).map((k) => pruneTree(req, k));
  return { ...n, children: kids, ...(n.child_count !== undefined ? { child_count: kids.length } : {}) };
}

// The project API, mounted at /api (single project) or /api/p/:project (hub). Handlers read the project from
// req.cortex and the caller's role from req.access, both set by the host server before the handler runs.
// Open live streams per project (per Cortex instance), and how many one project may hold.
const streams = new WeakMap<object, number>();
const sseLimitOf = () => Math.max(1, Number(process.env.CORTEX_SSE_LIMIT) || 50); // env: for tests and small machines

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  // ?project=<id> reads a linked project. Only the hub can serve that (it knows the other projects and the
  // caller's membership there); anywhere else the parameter must fail loudly, not answer from this project.
  app.addHook("preHandler", async (req) => {
    const target = (req.query as Q | undefined)?.project;
    if (!target || req.crossProject || target === (req.params as Q | undefined)?.project) return;
    throw new CortexError("not_linked", "Reading another project needs a team server (hub) with linked projects.", 400);
  });
  // Short ids to full ones before any handler reads them (after the host chose the project and the access).
  app.addHook("preHandler", async (req) => {
    const params = req.params as Q | undefined;
    if (params?.id && ITEM_ROUTE.test(req.routeOptions.url ?? "")) params.id = resolveItemId(req, params.id);
    const query = req.query as Q | undefined;
    if (query?.ref) query.ref = resolveRef(req, query.ref);
    const b = req.body as { refs?: unknown; ref?: unknown; decisions?: unknown } | undefined;
    if (!b || typeof b !== "object" || Buffer.isBuffer(b)) return;
    if (Array.isArray(b.refs)) b.refs = b.refs.map((r) => (typeof r === "string" ? resolveRef(req, r) : r));
    if (typeof b.ref === "string") b.ref = resolveRef(req, b.ref);
    if (Array.isArray(b.decisions)) {
      for (const d of b.decisions as { id?: unknown }[]) if (d && typeof d.id === "string") d.id = resolveItemId(req, d.id);
    }
  });

  app.get("/me", async (req) => {
    const c = req.cortex;
    return ok(req, {
      actor: { id: req.actor.id, kind: req.actor.kind },
      project: c.project.config.project,
      actors: c.project.config.actors.map(({ id, kind }) => ({ id, kind })),
      item_types: c.itemTypes(),
      ...(c.repoUrl() ? { repo_url: c.repoUrl() } : {}),
      ...(req.access ? { role: req.access.role, perms: PERMS.filter((p) => req.access!.can(p)), restricted: req.access.restricted } : {}),
    });
  });

  // Live updates for the board: every write or reindex (including other processes, via the file watcher).
  // Each open board holds one stream; past the cap a new one is told to retry rather than piling up forever.
  app.get("/events", (req, reply) => {
    const c = req.cortex;
    const sseLimit = sseLimitOf();
    const open = streams.get(c) ?? 0;
    if (open >= sseLimit) {
      return reply
        .code(503)
        .header("retry-after", "30")
        .send({ error: { code: "too_many_streams", message: `At most ${sseLimit} live connections per project. Retry shortly.` } });
    }
    streams.set(c, open + 1);
    // Our own listeners count too; without this Node warns about a "leak" at the 11th open board.
    c.events.setMaxListeners(sseLimit + 20);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    reply.raw.write(": connected\n\n");
    const onChange = (e: { type: string; entry?: Activity; path?: string }) => {
      // Members who see only part of the project do not get other people's entries, just a "something changed" ping.
      const entry = e.entry && !seesActivity(req, e.entry) ? undefined : e.entry;
      // `kind` says what changed (item, node, draft, stale, log, ...) so a board refreshes only the lists it
      // touches. The ref goes only with an entry the member may see.
      const kind = e.entry ? (e.entry.system ? e.entry.action.split(".")[0] : "log") : e.type;
      const ref = entry ? entry.refs?.[0] : e.type === "stale" && e.path !== undefined && seesNode(req, e.path) ? e.path : undefined;
      reply.raw.write(`data: ${JSON.stringify({ type: e.type, kind, ...(ref !== undefined ? { ref } : {}), ...(entry ? { entry } : {}) })}\n\n`);
    };
    const ping = setInterval(() => reply.raw.write(": ping\n\n"), 25000);
    c.events.on("change", onChange);
    let done = false;
    const end = () => {
      if (done) return; // close and error can both fire
      done = true;
      clearInterval(ping);
      c.events.off("change", onChange);
      streams.set(c, (streams.get(c) ?? 1) - 1);
    };
    req.raw.on("close", end);
    req.raw.on("error", end);
    reply.raw.on("error", end);
  });

  // ---- rules ----------------------------------------------------------------

  app.get("/rules", async (req) => ok(req, req.cortex.rules()));
  app.get("/rules/:name", async (req) => ok(req, req.cortex.rules((req.params as Q).name)));
  app.get("/rules/:name/source", async (req) => ok(req, req.cortex.rulesSource((req.params as Q).name!)));
  app.put("/rules/:name/source", async (req) => {
    need(req, "edit_rules");
    const source = ((req.body ?? {}) as { source?: unknown }).source;
    if (typeof source !== "string") throw new CortexError("invalid_request", "Send { source: <yaml string> }.", 400);
    return ok(req, req.cortex.saveRules(req.actor, (req.params as Q).name!, source));
  });

  // ---- knowledge --------------------------------------------------------------

  app.get("/brief", async (req) => {
    const b = req.cortex.brief(req.actor, num((req.query as Q).budget), req.access?.itemSql() ?? null);
    const linked = req.linkedProjects?.() ?? [];
    if (linked.length) (b as Record<string, unknown>).linked = linked;
    const ask = askHumans(req);
    if (ask) (b.attention as Record<string, unknown>).ask_humans = ask;
    if (!req.access) return ok(req, b);
    const stale = b.attention.stale_nodes;
    const staleTop = stale?.top.filter((s) => seesNode(req, s.path)) ?? [];
    return ok(req, {
      ...b,
      branches: b.branches.filter((x) => seesNode(req, x.path)),
      attention: {
        ...b.attention,
        ...(stale ? { stale_nodes: { count: staleTop.length, top: staleTop } } : {}),
      },
      recent_activity: b.recent_activity.filter((a) => seesActivity(req, req.cortex.index.getActivity(a.id)!)),
      you: { ...b.you, role: req.access.role },
    });
  });

  const treeHandler = async (req: FastifyRequest) => {
    const q = req.query as Q;
    const path = (req.params as Q)["*"] ?? q.path ?? "";
    if (!seesNode(req, path)) throw hidden(`Node "${path}"`);
    const t = req.cortex.treeView(path, num(q.depth) ?? 1, num(q.budget));
    return ok(req, { ...t, node: pruneTree(req, t.node) });
  };
  app.get("/tree", treeHandler);
  app.get("/tree/*", treeHandler);

  const nodeGet = async (req: FastifyRequest) => {
    const path = (req.params as Q)["*"] ?? "";
    if (!seesNode(req, path)) throw hidden(`Node "${path}"`);
    return ok(req, req.cortex.nodeView(path));
  };
  const nodePut = async (req: FastifyRequest, reply: FastifyReply) => {
    need(req, "write_knowledge");
    const path = (req.params as Q)["*"] ?? "";
    if (!seesNode(req, path)) throw hidden(`Node "${path}"`);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = req.cortex.putNode(req.actor, { ...body, path } as never);
    return reply.code(result.applied ? 200 : 202).send(ok(req, result));
  };
  app.get("/node", nodeGet);
  app.get("/node/*", nodeGet);
  app.put("/node", nodePut);
  app.put("/node/*", nodePut);
  app.delete("/node/*", async (req) => {
    need(req, "delete_knowledge");
    const path = (req.params as Q)["*"] ?? "";
    if (!seesNode(req, path)) throw hidden(`Node "${path}"`);
    return ok(req, req.cortex.deleteNode(req.actor, path, (req.query as Q).reason));
  });

  // ---- reports ----------------------------------------------------------------

  app.get("/report", async (req, reply) => {
    need(req, "reports");
    if (req.access?.restricted) throw new CortexError("forbidden", "Reports cover the whole project; your membership sees only part of it.", 403);
    const q = req.query as Q;
    const report = req.cortex.reports.build({ since: q.since, until: q.until });
    if (q.format === "md") return reply.type("text/markdown; charset=utf-8").send(reportToMarkdown(report, q.lang === "tr" ? "tr" : "en"));
    return ok(req, { report });
  });

  // ---- code links & staleness ---------------------------------------------------

  app.get("/code", async (req) => {
    const files = list((req.query as Q).files) ?? [];
    const { closed, ...r } = req.cortex.codeContext(files, { includeClosed: bool((req.query as Q).include_closed) });
    // Only what this caller may see is counted: a member with a narrow view learns nothing about the rest.
    const closedCount = closed.filter((id) => !req.access || seesItem(req, req.cortex.index.getItem(id))).length;
    const more = closedCount ? { closed_items: closedCount, closed_hint: "Finished or no longer current; include_closed: true lists them." } : {};
    // The accepted decisions this work will be checked against when it is logged (decision 01M3MXD9VVDQJSDEFX60PQTAWH).
    const checks = req.cortex.ruleChecks.select(files, req.access?.itemSql() ?? null);
    const withChecks = {
      ...r,
      ...more,
      ...(checks.asked.length ? { decisions_to_check: checks.asked, ...(checks.also.length ? { decisions_also: checks.also } : {}) } : {}),
    };
    if (!req.access) return ok(req, withChecks);
    return ok(req, {
      ...withChecks,
      knowledge: r.knowledge.filter((k) => seesNode(req, k.path as string)),
      items: r.items.filter((i) => seesItem(req, req.cortex.index.getItem(i.id as string))),
    });
  });
  // The board's sidebar badges. They used to pull the inbox, every draft and every stale node on each
  // live event, from whatever page was open, only to show three numbers: 12 KB a time on a real project.
  app.get("/counts", async (req) => {
    const stale = req.cortex.staleness
      .list()
      .filter((n) => seesNode(req, n.path))
      .filter(actionable).length;
    return ok(req, {
      inbox: inboxFor(req, 0, 0, false).count,
      approvals: visibleDrafts(req, false).length,
      stale,
      discussions: req.cortex.discussions.askingFor(req.actor, req.access?.itemSql() ?? null).length,
      // Items waiting on this person, per type (review, assigned, answered questions, proposed decisions...).
      waiting: req.cortex.items.inbox(req.actor, 0, req.access?.itemSql() ?? null, { reviewer: !req.access || req.access.can("approve") }).by_type,
    });
  });
  app.get("/stale", async (req) => {
    const s = req.cortex.staleness;
    const nodes = s
      .list()
      .filter((n) => seesNode(req, n.path))
      .map((n) => ({ ...n, title: req.cortex.tree.read(n.path)?.title ?? n.path }));
    return ok(req, { enabled: s.enabled(), head: s.currentHead(), actionable: nodes.filter(actionable).length, nodes });
  });
  // Put a stale node off until its code changes again. People only: an AI that snoozes its own
  // warnings would be hiding exactly the work this list exists for.
  app.post("/snooze/*", async (req) => {
    need(req, "write_knowledge");
    if (req.actor.kind !== "human") throw new CortexError("forbidden", "Only people can snooze stale knowledge. Verify or update the node instead.", 403);
    const path = (req.params as Q)["*"] ?? "";
    if (!seesNode(req, path)) throw hidden(`Node "${path}"`);
    if (!req.cortex.staleness.get(path)) throw new CortexError("not_stale", `"${path}" is not stale.`, 400);
    return ok(req, req.cortex.staleness.snooze(path, req.actor.id));
  });
  app.delete("/snooze/*", async (req) => {
    need(req, "write_knowledge");
    req.cortex.staleness.unsnooze((req.params as Q)["*"] ?? "");
    return ok(req, { message: "Snooze lifted." });
  });
  // A stale node's code diff since it was verified, and "ask an agent to update it" (a task for @ai).
  app.get("/stale/diff/*", async (req) => {
    const path = (req.params as Q)["*"] ?? "";
    if (!seesNode(req, path)) throw hidden(`Node "${path}"`);
    return ok(req, req.cortex.staleness.diff(path));
  });
  app.post("/stale/request-update/*", async (req, reply) => {
    need(req, "write_items");
    const path = (req.params as Q)["*"] ?? "";
    if (!seesNode(req, path)) throw hidden(`Node "${path}"`);
    const r = req.cortex.requestNodeUpdate(req.actor, path);
    return reply.code(r.existing ? 200 : 201).send(ok(req, r));
  });
  // "Verify every formatting-only one" on the stale page: { paths }. Each is a normal verify, so an AI's become drafts.
  app.post("/verify", async (req) => {
    need(req, "write_knowledge");
    const paths = ((req.body ?? {}) as { paths?: string[] }).paths ?? [];
    for (const p of paths) if (!seesNode(req, p)) throw hidden(`Node "${p}"`);
    return ok(req, req.cortex.verifyMany(req.actor, paths));
  });
  app.post("/verify/*", async (req, reply) => {
    need(req, "write_knowledge");
    const path = (req.params as Q)["*"] ?? "";
    if (!seesNode(req, path)) throw hidden(`Node "${path}"`);
    const r = req.cortex.verifyNode(req.actor, path, ((req.body ?? {}) as Q).note);
    return reply.code(r.applied ? 200 : 202).send(ok(req, r));
  });

  app.get("/search", async (req) => {
    const q = req.query as Q;
    const r = await req.cortex.search(q.q ?? "", {
      kinds: list(q.kind) as DocKind[] | undefined,
      under: q.path,
      status: q.status,
      type: q.type,
      limit: num(q.limit),
      budget: num(q.budget),
      archived: bool(q.archived),
      actor: q.actor,
      assignee: q.assignee,
      since: q.since,
      until: q.until,
    });
    if (!req.access) return ok(req, r);
    const visible = r.results.filter((h) => {
      if (h.kind === "node") return seesNode(req, h.path as string);
      if (h.kind === "item") return seesItem(req, req.cortex.index.getItem(h.id as string));
      const a = req.cortex.index.getActivity(h.id as string);
      return !!a && seesActivity(req, a);
    });
    return ok(req, { ...r, results: visible });
  });

  // ---- saved views -----------------------------------------------------------------------
  // A person's own named filters; nobody else sees them.
  app.get("/views", async (req) => ok(req, { views: req.cortex.views.list(req.actor) }));
  app.put("/views", async (req) => ok(req, { view: req.cortex.views.save(req.actor, (req.body ?? {}) as never) }));
  app.delete("/views/:id", async (req) => {
    req.cortex.views.remove(req.actor, (req.params as Q).id!);
    return ok(req, { deleted: true });
  });

  // ---- references ----------------------------------------------------------------------
  // Previews for the ids a page shows (item and activity ULIDs in Markdown): one request for all of them.
  // An id the caller may not see, or that names nothing, comes back as null.
  app.get("/refs", async (req) => {
    const c = req.cortex;
    const ids = [...new Set((list((req.query as Q).ids) ?? []).filter((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)))];
    if (ids.length > 100) throw new CortexError("invalid_request", "At most 100 ids per request.", 400);
    const refs: Record<string, unknown> = {};
    for (const id of ids) {
      const item = c.index.getItem(id);
      if (item) {
        refs[id] = seesItem(req, item)
          ? {
              kind: "item",
              type: item.type,
              title: item.title,
              status: item.status,
              ...(item.assignee ? { assignee: item.assignee } : {}),
              updated_at: item.updated_at,
            }
          : null;
        continue;
      }
      const a = c.index.getActivity(id);
      refs[id] = a && seesActivity(req, a) ? { kind: "activity", actor: a.actor, at: a.at, action: a.action, summary: a.summary } : null;
    }
    return ok(req, { refs });
  });

  // ---- project status ------------------------------------------------------------------
  // Where the project stands and what is next. Project-wide, so members who see only part of it get none.
  const wholeProject = (req: FastifyRequest) => {
    if (req.access?.restricted) throw new CortexError("forbidden", "The project status covers the whole project; your membership sees only part of it.", 403);
  };
  app.get("/status", async (req) => {
    wholeProject(req);
    return ok(req, { status: req.cortex.status.get() });
  });
  app.get("/status/history", async (req) => {
    wholeProject(req);
    return ok(req, { versions: req.cortex.status.history() });
  });
  // Written directly, by people and agents alike: a status that waits on review is already out of date.
  app.put("/status", async (req) => {
    need(req, "write_knowledge");
    wholeProject(req);
    return ok(req, req.cortex.status.put(req.actor, (req.body ?? {}) as { body?: unknown; reason?: unknown }));
  });

  // ---- inbox ----------------------------------------------------------------------

  // An agent's inbox is its items. A person's is one queue of everything waiting on them: reviewed work to
  // check, drafts to approve, decisions, their items and knowledge gone stale. Counted, filtered and paged
  // here, so the board makes one request and the numbers match the sidebar.
  // Visibility is part of every query, so `count` is the true number, not "what was left of one page".
  // `full: false`: only the count matters (the sidebar), so drafts are not diffed against their targets.
  const inboxFor = (req: FastifyRequest, limit: number, offset = 0, full = true) => {
    const c = req.cortex;
    const visible = req.access?.itemSql() ?? null;
    if (req.actor.kind !== "human") return c.items.inbox(req.actor, limit, visible);
    const reviewer = !req.access || req.access.can("approve");
    const items: InboxRow[] = c.items.inbox(req.actor, Number.MAX_SAFE_INTEGER, visible, { reviewer }).items.map((i) => ({ ...i, at: i.updated_at }));
    const drafts: InboxRow[] = (reviewer ? visibleDrafts(req, full) : []).map((d) => ({
      kind: "draft",
      reason: "draft_to_approve",
      id: d.id,
      draft_kind: d.kind,
      target: d.target,
      title: d.title,
      summary: d.summary,
      proposed_by: d.proposed_by,
      changes: d.changes,
      at: d.proposed_at,
    }));
    // Only what needs a person: formatting-only changes and snoozed nodes wait on the stale page instead.
    const stale: InboxRow[] = c.staleness
      .list()
      .filter((n) => seesNode(req, n.path))
      .filter(actionable)
      .map((n) => ({
        kind: "stale",
        reason: "stale_knowledge",
        id: n.path,
        path: n.path,
        title: c.index.getNode(n.path)?.title ?? n.path,
        severity: n.severity,
        changed_files: n.changes.map((ch) => ch.file),
        at: "",
      }));
    const rank = (r: InboxRow) => INBOX_ORDER.indexOf(r.reason);
    const all = [...items, ...drafts, ...stale].sort(
      (a, b) => Number(!!b.blocking) - Number(!!a.blocking) || rank(a) - rank(b) || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0),
    );
    const by_reason: Partial<Record<InboxReason, number>> = {};
    for (const r of all) by_reason[r.reason] = (by_reason[r.reason] ?? 0) + 1;
    return { count: all.length, by_reason, offset, items: all.slice(offset, offset + limit).map(({ at: _at, ...r }) => r) };
  };

  // ---- approvals ------------------------------------------------------------------

  // Reviewers see every draft they can see; everyone else sees the drafts they proposed.
  const visibleDrafts = (req: FastifyRequest, changes = true) => {
    const drafts = req.cortex.listDrafts({ changes });
    if (!req.access) return drafts;
    return req.access.can("approve")
      ? drafts.filter((d) => (d.kind === "node" ? seesNode(req, d.target) : seesItem(req, req.cortex.index.getItem(d.target))))
      : drafts.filter((d) => d.proposed_by === req.actor.id);
  };

  // What a person could settle with one answer in the AI chat (MCP cortex_pending_approvals).
  const pendingForChat = (req: FastifyRequest) => chatApprovals(req.cortex, { visible: req.access?.itemSql() ?? null, drafts: visibleDrafts(req, false) });
  // For an AI: how many answers it could get in the chat right now, and the tool that asks. Left out when none.
  function askHumans(req: FastifyRequest) {
    // Only the MCP server knows whether a person stands behind the session; it drops this line when none does.
    if (req.actor.kind !== "ai") return null;
    const n = pendingForChat(req).length;
    return n ? { count: n, next: "cortex_pending_approvals, then ask the person in this chat with cortex_ask_human / cortex_review_drafts" } : null;
  }
  // ---- answers from the AI chat -------------------------------------------------------------------

  // What each kind of answer needs from the person's role: the same as doing it on the board.
  const ANSWER_PERM: Record<ChatKind, Perm> = { draft: "approve", decision: "write_items", question: "ask", transition: "write_items" };
  const answerOf = (b: Record<string, unknown>): ChatAnswer => {
    const kind = b.kind as ChatKind;
    if (!(kind in ANSWER_PERM)) throw new CortexError("validation", "kind is draft, decision, question or transition.", 400);
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    return {
      kind,
      ids: Array.isArray(b.ids) ? b.ids.map(String) : undefined,
      target_id: str(b.target_id),
      to: str(b.to),
      answer: str(b.answer) ?? "",
      note: str(b.note),
    };
  };
  const personOnly = (req: FastifyRequest) => {
    if (req.actor.kind !== "human") throw new CortexError("forbidden", "Only a person's own answer counts here.", 403);
  };
  const checkTarget = (req: FastifyRequest, a: ChatAnswer) => {
    if (a.target_id) itemVisibleOr404(req, a.target_id);
  };
  // The person's answer given in the AI chat (the MCP server sends it with the person's credentials, after
  // the person answered in the client). Where it came from travels as provenance, set by the host.
  app.post("/chat/apply", async (req) => {
    personOnly(req);
    const a = answerOf((req.body ?? {}) as Record<string, unknown>);
    need(req, ANSWER_PERM[a.kind]);
    checkTarget(req, a);
    return ok(req, { result: req.cortex.chat.apply(req.actor, a) });
  });
  // Relayed answers waiting for the person to confirm them (chat.relayed: pending).
  const visibleRelayed = (req: FastifyRequest) => {
    const all = req.cortex.chat.relayed();
    if (req.actor.kind === "human" && (!req.access || req.access.can("approve"))) {
      return all.filter((r) => !r.target_id || !req.cortex.itemStore.exists(r.target_id) || seesItem(req, req.cortex.index.getItem(r.target_id)));
    }
    return all.filter((r) => r.ai_actor === req.actor.id);
  };
  app.get("/chat/relayed", async (req) => ok(req, { answers: visibleRelayed(req) }));
  app.post("/chat/relayed", async (req, reply) => {
    need(req, "ask");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const a = answerOf(b);
    checkTarget(req, a);
    const human = typeof b.human === "string" ? b.human : "";
    if (!req.cortex.project.config.actors.some((x) => x.id === human && x.kind === "human")) {
      throw new CortexError("validation", "human: the person who answered (a human actor id).", 400);
    }
    const r = req.cortex.chat.queue(req.actor, { ...a, human, verbatim: typeof b.verbatim === "string" ? b.verbatim : "" });
    return reply.code(201).send(ok(req, { queued: r }));
  });
  app.post("/chat/relayed/:id/confirm", async (req) => {
    personOnly(req);
    const r = req.cortex.chat.getRelayed((req.params as Q).id!);
    need(req, ANSWER_PERM[r.kind]);
    checkTarget(req, r);
    return ok(req, req.cortex.chat.confirm(req.actor, r.id));
  });
  app.delete("/chat/relayed/:id", async (req) => {
    const b = (req.body ?? {}) as { reason?: string };
    return ok(req, req.cortex.chat.discard(req.actor, (req.params as Q).id!, b.reason));
  });
  // Questions an AI asks on the board, for clients that cannot show them in the chat (decision
  // 01M3PCTFYV4WPM0APNNJJ9YJQG). The AI opens one; only the person it names answers, from their own board
  // session; the answer is applied here as theirs, whether or not the AI is still waiting.
  const PROMPT_PERM: Record<ReturnType<typeof planKind>, Perm> = { ...ANSWER_PERM, capture_item: "write_items", capture_node: "write_knowledge" };
  const promptTarget = (p: PromptPlan) => ("target_id" in p ? p.target_id : undefined);
  const ownPrompt = (req: FastifyRequest, id: string) => {
    const p = req.cortex.prompts.get(id);
    if (p.human !== req.actor.id && p.ai_actor !== req.actor.id) throw new CortexError("not_found", `No question "${id}".`, 404);
    return p;
  };
  app.post("/chat/prompts", async (req, reply) => {
    need(req, "ask");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const human = typeof b.human === "string" ? b.human : "";
    if (!req.cortex.project.config.actors.some((x) => x.id === human && x.kind === "human")) {
      throw new CortexError("validation", "human: the person to ask (a human actor id).", 400);
    }
    const plan = b.plan as PromptPlan | undefined;
    if (!plan || !["draft", "decision", "question", "transition", "capture"].includes(plan.kind)) {
      throw new CortexError("validation", "plan: what the answer does (kind draft, decision, question, transition or capture).", 400);
    }
    const target = promptTarget(plan);
    if (target) itemVisibleOr404(req, target);
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const p = req.cortex.prompts.open(req.actor, {
      human,
      session: str(b.session) || undefined,
      title: str(b.title) || plan.kind,
      message: str(b.message),
      schema: b.schema as FormSchema,
      plan,
      perm: PROMPT_PERM[planKind(plan)],
    });
    return reply.code(201).send(ok(req, { prompt: p }));
  });
  // A person sees the questions waiting for them; an AI, the ones it asked.
  app.get("/chat/prompts", async (req) => {
    const q = req.query as Q;
    const status = q.status === "all" ? undefined : ((q.status as PromptStatus | undefined) ?? "open");
    const prompts = req.cortex.prompts.list(req.actor.kind === "human" ? { human: req.actor.id, status } : { ai: req.actor.id, status });
    return ok(req, { prompts });
  });
  app.get("/chat/prompts/:id", async (req) => ok(req, { prompt: ownPrompt(req, (req.params as Q).id!) }));
  app.post("/chat/prompts/:id/answer", async (req) => {
    personOnly(req);
    // Not a token, a chat key or the MCP server's path for the person: those are all held by a process the
    // AI runs in. The whole point of asking on the board is that the answer comes from the person's browser.
    if (!req.boardSession || currentVia()) {
      throw new CortexError("board_only", "A question asked on the board is answered on the board, signed in as yourself.", 403);
    }
    const p = ownPrompt(req, (req.params as Q).id!);
    need(req, p.perm as Perm);
    const target = promptTarget(p.plan);
    if (target) itemVisibleOr404(req, target);
    const b = (req.body ?? {}) as { answer?: Record<string, unknown> };
    return ok(req, { prompt: req.cortex.prompts.answer(req.actor, p.id, b.answer ?? {}) });
  });

  // Take back an answer given in the chat: the approver's call, like approving.
  app.post("/chat/undo/:entry", async (req) => {
    personOnly(req);
    need(req, "approve");
    return ok(req, req.cortex.chat.undo(req.actor, (req.params as Q).entry!));
  });

  app.get("/approvals/chat", async (req) => {
    const rows = pendingForChat(req);
    return ok(req, { count: rows.length, items: rows, settings: { ...chatSettings(req.cortex, !!req.access), language: req.cortex.language() } });
  });

  // Paged when asked (limit, offset); `total` is always the whole list.
  app.get("/approvals", async (req) => {
    const q = req.query as Q;
    const drafts = visibleDrafts(req);
    const offset = num(q.offset) ?? 0;
    const limit = num(q.limit);
    return ok(req, { drafts: limit === undefined ? drafts.slice(offset) : drafts.slice(offset, offset + limit), total: drafts.length });
  });
  app.get("/approvals/:id", async (req) => {
    const r = req.cortex.getDraft((req.params as Q).id!);
    if (req.access && !req.access.can("approve") && r.draft.proposed_by !== req.actor.id) throw hidden("Draft");
    return ok(req, r);
  });
  // Bulk review: { ids, force?, verify_at_head? } / { ids, reason? }. Answers 200 with per-draft results even when some fail.
  app.post("/approvals/approve", async (req) => {
    need(req, "approve");
    const body = (req.body ?? {}) as { ids?: string[]; force?: boolean; verify_at_head?: boolean };
    return ok(req, req.cortex.approveMany(req.actor, body.ids ?? [], body.force === true, { verifyAtHead: body.verify_at_head === true }));
  });
  app.post("/approvals/reject", async (req) => {
    need(req, "approve");
    const body = (req.body ?? {}) as { ids?: string[]; reason?: string };
    return ok(req, req.cortex.rejectMany(req.actor, body.ids ?? [], body.reason));
  });
  app.post("/approvals/:id/approve", async (req) => {
    need(req, "approve");
    const q = req.query as Q;
    return ok(req, req.cortex.approve(req.actor, (req.params as Q).id!, q.force === "true", { verifyAtHead: q.verify_at_head === "true" }));
  });
  app.post("/approvals/:id/reject", async (req) => {
    need(req, "approve");
    return ok(req, req.cortex.reject(req.actor, (req.params as Q).id!, ((req.body ?? {}) as Q).reason));
  });

  // ---- items ----------------------------------------------------------------------

  app.get("/inbox", async (req) => {
    const q = req.query as Q;
    const ask = askHumans(req);
    return ok(req, { ...inboxFor(req, num(q.limit) ?? 20, num(q.offset) ?? 0), ...(ask ? { ask_humans: ask } : {}) });
  });
  app.get("/items", async (req) => {
    const q = req.query as Q;
    const r = req.cortex.items.list({
      type: q.type,
      status: q.status,
      assignee: q.assignee,
      author: q.author,
      path: q.path,
      open: bool(q.open),
      since: q.since,
      until: q.until,
      milestone: q.milestone,
      limit: num(q.limit),
      cursor: q.cursor,
      preview: bool(q.preview),
      // Filtered before LIMIT/OFFSET: full pages and a true total for members who see part of the project.
      visible: req.access?.itemSql() ?? null,
    });
    return ok(req, r);
  });
  // One page per status column; a column pages on with GET /items?status=&cursor=.
  app.get("/board", async (req) => {
    const q = req.query as Q;
    if (!q.type) throw new CortexError("invalid_request", "Pass the item type: /board?type=task.", 400);
    return ok(
      req,
      req.cortex.items.board({
        type: q.type,
        path: q.path,
        assignee: q.assignee,
        author: q.author,
        since: q.since,
        until: q.until,
        milestone: q.milestone,
        per_status: num(q.per_status),
        visible: req.access?.itemSql() ?? null,
      }),
    );
  });
  // Branches matching a text, for pickers: { path, title } of the ones this member may see.
  app.get("/branches", async (req) => {
    const q = req.query as Q;
    const limit = Math.min(num(q.limit) ?? 20, 50);
    const found = req.cortex.index.findNodes((q.q ?? "").trim(), limit * 2);
    return ok(req, { branches: found.filter((b) => seesNode(req, b.path)).slice(0, limit) });
  });
  app.post("/items", async (req, reply) => {
    const body = (req.body ?? {}) as { type?: string; category_path?: string };
    need(req, body.type === "question" ? "ask" : "write_items");
    // Members limited to some branches file new items inside them.
    if (req.access?.restricted && body.category_path && !seesNode(req, body.category_path)) throw hidden(`Branch "${body.category_path}"`);
    const r = req.cortex.items.create(req.actor, body as never);
    return reply.code(r.applied ? 201 : 202).send(ok(req, r));
  });
  app.get("/items/:id", async (req) => {
    const id = (req.params as Q).id!;
    itemVisibleOr404(req, id);
    const q = req.query as Q;
    const got = req.cortex.items.get(id, { replies: num(q.replies), budget: num(q.budget), viewer: req.actor });
    // Waiting for this person's check: the page offers what the inbox row does (same rules, same moves).
    const review = req.cortex.items.reviewFor(req.actor, got.item.id, { reviewer: !req.access || req.access.can("approve") });
    const out = got.attachments ? { ...got, attachments: withUrls(req, got.item.id, got.attachments) } : got;
    return ok(req, review ? { ...out, review } : out);
  });
  // Tick or untick one task box: { line, checked, if_rev }.
  app.patch("/items/:id/checklist", async (req, reply) => {
    need(req, "write_items");
    const id = (req.params as Q).id!;
    itemVisibleOr404(req, id);
    const r = req.cortex.items.setChecklistBox(req.actor, id, (req.body ?? {}) as { line?: unknown; checked?: unknown; if_rev?: unknown });
    return reply.code(r.applied ? 200 : 202).send(ok(req, r));
  });
  // Earlier versions of an item (newest first), one of them in full, and bringing one back.
  app.get("/items/:id/history", async (req) => {
    const id = (req.params as Q).id!;
    itemVisibleOr404(req, id);
    return ok(req, req.cortex.items.history(id));
  });
  app.get("/items/:id/history/:version", async (req) => {
    const { id, version } = req.params as Q;
    itemVisibleOr404(req, id!);
    return ok(req, req.cortex.items.version(id!, version!));
  });
  app.post("/items/:id/restore", async (req, reply) => {
    need(req, "write_items");
    const id = (req.params as Q).id!;
    itemVisibleOr404(req, id);
    const body = (req.body ?? {}) as { version?: string; reason?: string };
    if (!body.version) throw new CortexError("invalid_request", "Pass the version to restore.", 400, { example: { version: "01J9Z..." } });
    const r = req.cortex.items.restore(req.actor, id, body.version, body.reason);
    return reply.code(r.applied ? 200 : 202).send(ok(req, r));
  });
  app.patch("/items/:id", async (req, reply) => {
    need(req, "write_items");
    const id = (req.params as Q).id!;
    itemVisibleOr404(req, id);
    const r = req.cortex.items.update(req.actor, id, (req.body ?? {}) as never);
    return reply.code(r.applied ? 200 : 202).send(ok(req, r));
  });
  app.post("/items/:id/claim", async (req, reply) => {
    need(req, "write_items");
    const id = (req.params as Q).id!;
    itemVisibleOr404(req, id);
    const r = req.cortex.items.claim(req.actor, id, (req.body ?? {}) as never);
    return reply.code(200).send(ok(req, r));
  });
  app.post("/items/:id/replies", async (req, reply) => {
    const id = (req.params as Q).id!;
    itemVisibleOr404(req, id);
    // Viewers may answer and follow up on questions and take part in discussions; everything else needs write access.
    const type = req.cortex.index.getItem(id)?.type;
    need(req, type === "question" || type === "discussion" ? "ask" : "write_items");
    return reply.code(201).send(ok(req, req.cortex.items.reply(req.actor, id, (req.body ?? {}) as never)));
  });
  // ---- archive --------------------------------------------------------------------
  // Records that no longer apply leave everyday view (search, brief, tree, lists) but stay in the files.
  // Anyone who reads sees the suggestions and the archive; archiving needs write access (an AI's archiving
  // becomes drafts); bringing back and deleting for good are for people who approve.

  const isItemRef = (ref: string) => /^[0-9A-Z]{26}$/.test(ref);
  const refsVisibleOr404 = (req: FastifyRequest, refs: string[]) => {
    for (const r of refs) {
      if (isItemRef(r)) itemVisibleOr404(req, r);
      else if (!seesNode(req, r)) throw hidden(`Node "${r}"`);
    }
  };
  const refsOf = (req: FastifyRequest): string[] => {
    const b = (req.body ?? {}) as { refs?: unknown; ref?: unknown };
    const refs = Array.isArray(b.refs) ? b.refs : b.ref !== undefined ? [b.ref] : [];
    if (!refs.length || refs.some((r) => typeof r !== "string")) {
      throw new CortexError("invalid_request", "Send { refs: [...] }: item ids or knowledge paths.", 400, {
        example: { refs: ["01J9Z...", "backend/old-queue"] },
      });
    }
    return refs as string[];
  };

  app.get("/archive/candidates", async (req) => {
    const r = req.cortex.archive.candidates(req.access?.itemSql() ?? null);
    return ok(req, { ...r, candidates: r.candidates.filter((c) => c.kind === "item" || seesNode(req, c.ref)) });
  });
  app.get("/archive", async (req) => {
    const r = req.cortex.archive.list(req.access?.itemSql() ?? null);
    return ok(req, { archived: r.archived.filter((a) => a.kind === "item" || seesNode(req, a.ref)) });
  });
  app.post("/archive", async (req) => {
    const refs = refsOf(req);
    if (refs.some(isItemRef)) need(req, "write_items");
    if (refs.some((r) => !isItemRef(r))) need(req, "write_knowledge");
    refsVisibleOr404(req, refs);
    return ok(req, req.cortex.archive.archive(req.actor, refs, ((req.body ?? {}) as { reason?: string }).reason));
  });
  app.post("/archive/restore", async (req) => {
    need(req, "approve");
    const refs = refsOf(req);
    refsVisibleOr404(req, refs);
    return ok(req, req.cortex.archive.restore(req.actor, refs));
  });
  app.post("/archive/purge", async (req) => {
    need(req, "approve");
    const [ref] = refsOf(req);
    refsVisibleOr404(req, [ref!]);
    return ok(req, req.cortex.archive.purge(req.actor, ref!));
  });

  // ---- discussions ----------------------------------------------------------------
  // A discussion is an item (created with POST /items, views are replies); these add the list with vote
  // counts, the count that proposes a decision, and a person's final call.

  app.get("/discussions", async (req) => {
    return ok(req, req.cortex.discussions.list(req.actor, { open: bool((req.query as Q).open), visible: req.access?.itemSql() ?? null }));
  });
  app.post("/discussions/:id/close-vote", async (req) => {
    need(req, "write_items");
    const id = (req.params as Q).id!;
    itemVisibleOr404(req, id);
    return ok(req, req.cortex.discussions.closeVote(req.actor, id));
  });
  app.post("/discussions/:id/decide", async (req) => {
    need(req, "approve");
    const id = (req.params as Q).id!;
    itemVisibleOr404(req, id);
    const option = ((req.body ?? {}) as { option?: unknown }).option;
    if (typeof option !== "string") throw new CortexError("invalid_request", "Send { option }: one of the discussion's options.", 400);
    return ok(req, req.cortex.discussions.decide(req.actor, id, option));
  });

  // ---- attachments ---------------------------------------------------------------
  // Upload is the raw file as the request body (any content type) with its name in ?name=, so the
  // board can send a pasted screenshot as-is and no multipart parser is needed. Files are served back
  // with the type from their extension; anything that could run in the page (SVG, HTML) is a download.

  app.get("/items/:id/files", async (req) => {
    const id = (req.params as Q).id!;
    itemVisibleOr404(req, id);
    return ok(req, { files: withUrls(req, id, req.cortex.items.attachments(id)) });
  });
  app.get("/items/:id/files/:name", async (req, reply) => {
    const { id, name } = req.params as Q;
    itemVisibleOr404(req, id!);
    const data = req.cortex.itemStore.readAttachment(id!, name!);
    if (!data) throw new CortexError("not_found", `No file "${name}" on this item.`, 404);
    const type = mediaType(name!);
    // PDFs are downloads too: the sandbox policy below keeps browsers from rendering them inline anyway.
    const inline = (isSafeImage(type) || isText(type)) && (req.query as Q).download === undefined;
    return reply
      .header("content-type", isText(type) ? `${type}; charset=utf-8` : type)
      .header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name!)}`)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'")
      .header("cache-control", "private, max-age=300")
      .send(data);
  });
  app.register(async (files) => {
    // Every body in this scope is bytes, whatever its declared type (a .json file is still a file).
    files.removeAllContentTypeParsers();
    files.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MAX_ATTACHMENT_BYTES + 1 }, (_req, body, done) => done(null, body));
    files.post("/items/:id/files", { bodyLimit: MAX_ATTACHMENT_BYTES + 1 }, async (req, reply) => {
      need(req, "write_items");
      const id = (req.params as Q).id!;
      itemVisibleOr404(req, id);
      const name = (req.query as Q).name ?? "";
      if (!name.trim()) throw new CortexError("invalid_file", "Send the file name as ?name=, e.g. ?name=screenshot.png", 400);
      if (!Buffer.isBuffer(req.body)) throw new CortexError("invalid_file", "Send the file itself as the request body.", 400);
      const r = req.cortex.items.attach(req.actor, id, name, req.body);
      return reply.code(201).send(ok(req, { ...r, file: withUrls(req, r.id, [r.file])[0] }));
    });
  });
  app.delete("/items/:id/files/:name", async (req) => {
    need(req, "write_items");
    const { id, name } = req.params as Q;
    itemVisibleOr404(req, id!);
    return ok(req, req.cortex.items.detach(req.actor, id!, name!));
  });

  app.post("/ask", async (req, reply) => {
    need(req, "ask");
    const b = (req.body ?? {}) as { about?: string; title?: string; body?: string; assignee?: string; blocking?: boolean };
    if (!b.about || !b.title) {
      throw new CortexError("invalid_request", "Send { about, title }.", 400, {
        example: {
          about: "01J9Z... (activity id) | 01J9Y... (item id) | backend/auth (node path)",
          title: "Why did you disable the cache here?",
          blocking: false,
        },
      });
    }
    const r = req.cortex.items.ask(req.actor, { about: b.about, title: b.title, body: b.body, assignee: b.assignee, blocking: b.blocking });
    return reply.code(r.applied ? 201 : 202).send(ok(req, r));
  });

  // ---- activity -------------------------------------------------------------------

  app.post("/activity", async (req, reply) => {
    need(req, "log_activity");
    return reply.code(201).send(ok(req, req.cortex.activity.log(req.actor, (req.body ?? {}) as never, req.access?.itemSql() ?? null)));
  });
  // Answers for the decisions a logged piece of work was checked against, given after it was logged.
  app.post("/activity/:id/rules", async (req) => {
    need(req, "log_activity");
    const id = (req.params as Q).id!;
    if (!seesActivity(req, req.cortex.activity.get(id))) throw hidden("Activity");
    const b = (req.body ?? {}) as { decisions?: unknown };
    return ok(req, req.cortex.ruleChecks.answer(req.actor, id, (b.decisions ?? []) as never));
  });
  // The exceptions over a period: decisions broken, and decisions never answered.
  app.get("/rule-checks", async (req) => {
    const q = req.query as Q;
    return ok(
      req,
      req.cortex.ruleChecks.report({ since: q.since, until: q.until }, (a) => seesActivity(req, a)),
    );
  });
  app.get("/activity", async (req) => {
    const q = req.query as Q;
    const r = req.cortex.activity.list({
      since: q.since,
      until: q.until,
      before: q.before,
      actor: q.actor,
      ref: q.ref,
      include_system: bool(q.include_system),
      chat: bool(q.chat),
      limit: num(q.limit),
    });
    // Answers from the chat say whether the board can take them back.
    const entries = r.entries.map((a) => {
      const undo = a.via ? req.cortex.chat.undoState(a) : null;
      return undo ? { ...a, undo } : a;
    });
    // The cursor comes from the unfiltered page, so a member's next page starts where this one stopped.
    return ok(req, { ...r, entries: req.access ? entries.filter((a) => seesActivity(req, a)) : entries });
  });
  app.get("/activity/:id", async (req) => {
    const a = req.cortex.activity.get((req.params as Q).id!);
    if (!seesActivity(req, a)) throw hidden("Activity");
    return ok(req, { entry: a });
  });
}

export const PERMS = [
  "read",
  "ask",
  "write_items",
  "write_knowledge",
  "delete_knowledge",
  "approve",
  "edit_rules",
  "manage_members",
  "reports",
  "log_activity",
] as const;
