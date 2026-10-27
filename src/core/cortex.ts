import { createHash, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { existsSync, readFileSync, readdirSync, realpathSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { DocKind, IndexedNode, ItemFlags, SqlFilter } from "../index/db.js";
import { Index } from "../index/db.js";
import { ActivityStore } from "../store/activity.js";
import { DraftStore } from "../store/drafts.js";
import { ItemStore } from "../store/items.js";
import { TreeStore, normalizePath } from "../store/tree.js";
import { estimateTokens, nowIso, shortHash, shorten, ulid } from "../util/text.js";
import type { Embedder } from "../search/embedder.js";
import { TransformersEmbedder } from "../search/embedder.js";
import { semanticEnabled } from "../search/runtime.js";
import { SemanticIndex } from "../search/semantic.js";
import { BOOTSTRAP_TAG, isPlaceholder } from "./init.js";
import { ActivityService } from "./activity.js";
import { RuleCheckService } from "./ruleCheck.js";
import type { StaleChange, StaleInfo } from "./staleness.js";
import { StalenessService, actionable } from "./staleness.js";
import { ReportService } from "./reports.js";
import { StatusService } from "./status.js";
import { ViewService } from "./views.js";
import { githubRepoUrl } from "../git/git.js";
import { ItemService, itemRevision, shrinks } from "./items.js";
import { BIG_NODE_CHARS, editBody, sectionTitles } from "./nodeEdit.js";
import { DiscussionService } from "./discussions.js";
import { ArchiveService } from "./archive.js";
import { Webhooks } from "./webhooks.js";
import { ChatService } from "./chat.js";
import { PromptService } from "./chatPrompts.js";
import type { SyncStats } from "./sync.js";
import { SyncService, changedFiles, missingRecords, stampFiles } from "./sync.js";
import type { Project } from "./project.js";
import { loadTokens, paths, rulesVersion } from "./project.js";
import type { ItemSchema } from "./schema.js";
import { DEFAULT_SCHEMAS, describeSchema, isOpenWork, loadActivitySchema, loadSchema } from "./schema.js";
import type { Actor, Draft, Item, KnowledgeNode, NodeSummary } from "./types.js";
import type { DraftChanges } from "./diff.js";
import { draftChanges } from "./diff.js";
import { CortexError } from "./types.js";
import { LANG_CODE, languageRule } from "./language.js";

export const NodeInput = z.object({
  path: z.string(),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(300),
  body: z.string().default(""),
  tags: z.array(z.string().max(40)).max(20).optional(),
  links: z
    .object({
      code: z
        .array(z.object({ file: z.string().transform((f) => f.normalize("NFC")), lines: z.string().optional(), symbol: z.string().min(1).optional() }))
        .optional(), // NFC: same file, same key on every OS
      items: z.array(z.string()).optional(),
    })
    .optional(),
  verified_at_commit: z.string().optional(),
  reason: z.string().max(500).optional(),
  // An AI whose knowledge writes apply directly can still ask for a person's review of one it is unsure of
  // (decision 01M3MXD1644M8SBHHT2RHP8XDB: review is the exception, not every write).
  review: z.boolean().optional(),
  // Part of the body (nodeEdit.ts): "append" adds to the end; `section` changes or adds one heading's part.
  body_mode: z.enum(["replace", "append"]).optional(),
  section: z.string().min(1).max(200).optional(),
  // An AI cutting a body to less than half says it means it.
  confirm_shrink: z.boolean().optional(),
});
export type NodeInput = z.input<typeof NodeInput>;

const NODE_EXAMPLE = {
  path: "backend/auth/jwt-refresh",
  title: "JWT refresh flow",
  summary: "Access token 15 min, refresh token 30 days, rotation on every refresh.",
  body: "## Flow\n...",
  tags: ["auth", "security"],
  links: { code: [{ file: "src/auth/refresh.ts", lines: "10-80" }] },
  reason: "Documented while adding rate limiting",
};

const NON_ITEM_RULES = new Set(["node", "activity"]);
const RRF_K = 60; // standard Reciprocal Rank Fusion constant
const BRIEF_BUDGET = 800; // tokens; the spec's promise for the session opener

// Content hash of a node, so conflict detection does not depend on clock resolution.
export function nodeRevision(n: KnowledgeNode): string {
  return shortHash(JSON.stringify([n.title, n.summary, n.body, n.tags ?? [], n.links ?? {}, n.status, n.updated_at]));
}

// Handed-in work older than this is called out: in the agent's brief, and marked on the board.
export const REVIEW_REMIND_DAYS = 3;

export interface WriteResult {
  applied: boolean;
  warning?: string;
  hint?: string;
  stale_changes?: StaleChange[];
  path?: string;
  id?: string;
  draft_id?: string;
  message: string;
}

export class Cortex {
  readonly tree: TreeStore;
  readonly drafts: DraftStore;
  readonly itemStore: ItemStore;
  readonly activityStore: ActivityStore;
  readonly index: Index;
  readonly items: ItemService;
  readonly discussions: DiscussionService;
  readonly archive: ArchiveService;
  readonly webhooks: Webhooks;
  readonly activity: ActivityService;
  readonly ruleChecks: RuleCheckService;
  readonly chat: ChatService;
  readonly prompts: PromptService;
  // "change" fires after every write and every reindex; the web board streams it to browsers.
  readonly events = new EventEmitter();
  private p: ReturnType<typeof paths>;
  private watcher?: FSWatcher;

  readonly semantic: SemanticIndex;
  readonly staleness: StalenessService;
  readonly reports: ReportService;
  readonly status: StatusService;
  readonly views: ViewService;
  private syncService: SyncService;
  private syncTimer?: NodeJS.Timeout;

  // `embedder` overrides the semantic backend (tests pass a fake; null turns semantic search off).
  constructor(
    readonly project: Project,
    opts: { embedder?: (() => Embedder) | null } = {},
  ) {
    this.p = paths(project.dir);
    this.tree = new TreeStore(this.p.tree);
    this.drafts = new DraftStore(this.p.drafts);
    this.itemStore = new ItemStore(this.p.items);
    this.activityStore = new ActivityStore(this.p.activity);
    this.index = new Index(this.p.index);
    this.items = new ItemService(this);
    this.discussions = new DiscussionService(this);
    this.archive = new ArchiveService(this);
    this.webhooks = new Webhooks(this);
    this.activity = new ActivityService(this);
    this.ruleChecks = new RuleCheckService(this);
    this.chat = new ChatService(this, this.p.chat);
    this.prompts = new PromptService(this, join(this.project.dir, ".prompts"));
    const wantSemantic = project.config.search?.semantic !== false && semanticEnabled();
    const factory = opts.embedder !== undefined ? opts.embedder : wantSemantic ? () => new TransformersEmbedder() : null;
    this.semantic = new SemanticIndex(this.index, factory);
    this.staleness = new StalenessService(this);
    this.reports = new ReportService(this);
    this.status = new StatusService(this);
    this.views = new ViewService(this);
    this.syncService = new SyncService(this);
    // Every write and reindex emits "change"; batch them into one embedding pass.
    this.events.on("change", () => {
      clearTimeout(this.syncTimer);
      if (!this.closed) this.syncTimer = setTimeout(() => this.semantic.sync(), 200);
    });
    this.openIndex();
    this.semantic.sync();
  }

  // A full rebuild reads and parses every file, which took over 20 seconds on a year-sized project. The
  // index remembers each file's mtime and size, so opening re-reads only what changed while Cortex was
  // closed (a git pull, hand edits). No stamps (a new or upgraded index) means a full rebuild.
  private openIndex(): void {
    const before = this.index.fileStamps();
    if (!before.size) {
      this.reindex();
      return;
    }
    const now = stampFiles(this.project.dir);
    const changed = changedFiles(before, now);
    // Stamps only know files that existed at the last open; one created since and deleted while closed
    // shows up here, as a record the index has and the disk does not.
    const missing = missingRecords(this.index.indexedRecords(), now.keys());
    if (missing === "rescan") {
      this.reindex();
      return;
    }
    changed.push(...missing);
    if (!changed.length) return;
    const r = this.syncService.run(changed);
    if ("rescan" in r) {
      this.reindex();
      return;
    }
    // A record that could not be read (half written) keeps the old stamps, so the next open tries again.
    if (!r.errors.length) this.index.setFileStamps(now);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.syncTimer);
    clearTimeout(this.watchTimer);
    clearInterval(this.headPoll);
    this.semantic.close();
    this.watcher?.close();
    this.index.close();
  }

  private closed = false;
  private watchTimer?: NodeJS.Timeout;
  private pending = new Set<string>();
  private pendingAll = false;

  // Picks up hand edits, git pulls and writes from other Cortex processes (e.g. MCP next to the API).
  watch(onError: (e: unknown) => void = () => {}): void {
    // The long, real path: Node 24.20's libuv asserts and aborts the process (0xC0000409) when a watch is
    // opened through a Windows 8.3 short name (C:\Users\RUNNER~1\..., typical for temp folders), because
    // the events come back under the long name. realpath.native expands it; elsewhere it is a no-op.
    let dir = this.project.dir;
    try {
      dir = realpathSync.native(dir);
    } catch {
      // unreadable path: watch it as given
    }
    this.watcher = watch(dir, { recursive: true }, (_event, file) => {
      if (this.closed) return;
      // Node can report a change without naming the file; then we have no choice but to rebuild.
      if (file == null) this.pendingAll = true;
      else {
        const f = String(file).replace(/\\/g, "/");
        // .git: a hub keeps its projects' knowledge in a git repository of its own.
        if (f.startsWith(".index") || f.startsWith(".prompts") || /^\.git(\/|$)/.test(f) || f === ".secrets.yaml" || f === ".sessions.json") return;
        this.pending.add(f);
      }
      clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => {
        const paths = [...this.pending];
        const all = this.pendingAll;
        this.pending.clear();
        this.pendingAll = false;
        try {
          if (all) this.reindex();
          else for (const e of this.sync(paths).errors) onError(e.error);
        } catch (e) {
          // Usually a half-written file during git checkout; the next event retries.
          this.pendingAll = true;
          onError(e);
        }
      }, 300);
    });
    // Without a listener an 'error' event kills the process. Windows emits EPERM when the watched folder
    // is deleted or moved, even just after close() (closing is asynchronous there). Report it and keep
    // serving from the index; after close() it is expected and ignored.
    this.watcher.on("error", (e) => {
      if (!this.closed) onError(e);
    });
    // Commits happen outside .cortex; poll HEAD so staleness (and open boards) update without a restart.
    let head = this.staleness.currentHead();
    this.headPoll = setInterval(() => {
      if (this.closed) return;
      const now = this.staleness.currentHead();
      if (now !== head) {
        head = now;
        this.events.emit("change", { type: "git", head });
      }
    }, 5000);
    this.headPoll.unref();
  }

  private headPoll?: NodeJS.Timeout;

  // Index only what these paths (relative to .cortex) name. Falls back to a full rebuild when a
  // change cannot be pinned to single records — a moved branch, a vanished log, an unknown shape.
  sync(changed: string[]): SyncStats {
    const r = this.syncService.run(changed);
    if ("rescan" in r) {
      this.reindex();
      return { nodes: 0, items: 0, drafts: 0, activity: 0, reterm: 0, errors: [] };
    }
    // Same event shape as a full reindex: the board's live stream, the semantic debounce and
    // staleness all key off it. Staying quiet when nothing changed keeps them from spinning.
    if (r.nodes || r.items || r.drafts || r.activity || r.reterm) this.events.emit("change", { type: "reindex" });
    return r;
  }

  reindex(): { nodes: number; items: number; activity: number } {
    // Stamped before reading: a file that changes during the rebuild looks changed next time, never the reverse.
    const stamps = stampFiles(this.project.dir);
    const nodes = this.tree.all();
    const memo = new Map<string, ItemSchema | null>();
    const schemaOf = (t: string) => (memo.has(t) ? memo.get(t)! : (memo.set(t, this.schema(t)), memo.get(t)!));
    const items = this.itemStore.allIds().flatMap((id) => {
      const item = this.itemStore.read(id);
      if (!item) return [];
      return [
        {
          item,
          replies: this.itemStore.replies(id),
          flags: this.itemFlags(item.type, item.status, schemaOf(item.type)),
          files: this.itemStore.fileSummary(id),
        },
      ];
    });
    const activity = this.activityStore.all();
    this.index.reindex({ nodes, items, activity, drafts: this.drafts.list() });
    this.index.setFileStamps(stamps);
    this.events.emit("change", { type: "reindex" });
    return { nodes: nodes.length, items: items.length, activity: activity.length };
  }

  // Single source for "is this finished / is it still waiting", used by reindex, the item service and sync.
  itemFlags(type: string, status: string, schema = this.schema(type)): ItemFlags {
    if (!schema) return { terminal: false, open: true };
    return { terminal: schema.terminal.includes(status), open: isOpenWork(schema, status) };
  }

  // Where commit links point: project.repo_url when set, else git's "origin" when it is GitHub, else none
  // (hashes stay plain text). The remote is asked once per process.
  repoUrl(): string | null {
    const set = this.project.config.project.repo_url?.trim();
    if (set) return /^https?:\/\//i.test(set) ? set.replace(/\/+$/, "") : null;
    if (this.origin === undefined) this.origin = githubRepoUrl(this.staleness.git.originUrl());
    return this.origin;
  }
  private origin: string | null | undefined;

  meta() {
    return { rules_version: rulesVersion(this.project.dir) };
  }

  // ---- actors -------------------------------------------------------------

  actor(id: string | undefined): Actor {
    const a = this.project.config.actors.find((x) => x.id === id);
    if (!a) {
      throw new CortexError("unknown_actor", `Unknown actor "${id ?? ""}". Actors are defined in .cortex/cortex.config.yaml.`, 401, {
        known_actors: this.project.config.actors.map((x) => x.id),
      });
    }
    return a;
  }

  // Compares hashes in constant time and checks every entry, so response time says nothing about how
  // much of a guessed token was right, or which actor it was close to.
  actorByToken(token: string | undefined): Actor | null {
    if (!token) return null;
    const want = createHash("sha256").update(token).digest();
    let id: string | undefined;
    for (const [actor, t] of Object.entries(loadTokens(this.project.dir))) {
      if (typeof t === "string" && timingSafeEqual(createHash("sha256").update(t).digest(), want)) id = actor;
    }
    return id ? this.actor(id) : null;
  }

  // ---- schemas ------------------------------------------------------------

  schema(type: string): ItemSchema | null {
    if (NON_ITEM_RULES.has(type) || !/^[a-z][a-z0-9-]{0,39}$/.test(type)) return null;
    return loadSchema(this.p.rules, type);
  }

  // What a new item of each type must carry: "category_path" when the type needs a branch, "fields.<name>" for
  // each required field. Conditional requirements (require_when) are in cortex_rules(type).
  itemTypeRequirements(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const type of this.itemTypes()) {
      const schema = this.schema(type);
      if (!schema) continue;
      out[type] = [
        ...(schema.category_required ? ["category_path"] : []),
        ...Object.entries(schema.fields)
          .filter(([, spec]) => spec.required)
          .map(([name]) => `fields.${name}`),
      ];
    }
    return out;
  }

  // Built-in types plus any custom type a human defined as rules/<type>.schema.yaml.
  itemTypes(): string[] {
    const custom = existsSync(this.p.rules)
      ? readdirSync(this.p.rules)
          .filter((f) => f.endsWith(".schema.yaml"))
          .map((f) => f.slice(0, -".schema.yaml".length))
          .filter((t) => !NON_ITEM_RULES.has(t))
      : [];
    return [...new Set([...Object.keys(DEFAULT_SCHEMAS), ...custom])];
  }

  activitySchema() {
    return loadActivitySchema(this.p.rules);
  }

  // ---- reading ------------------------------------------------------------

  // The session opener: small, stable, and everything an AI needs to decide where to look next.
  // It is trimmed to fit `budget` tokens: first the branch summaries get shorter, then the lists,
  // because a project with many branches or a long queue must not turn the opener into a wall of text.
  brief(actor: Actor, budget = BRIEF_BUDGET, visible: SqlFilter | null = null) {
    const root = this.tree.read("");
    const branches = this.index.children("").map((n) => {
      const open = this.index.openItemsUnder(n.path);
      return {
        path: n.path,
        title: n.title,
        summary: n.summary,
        child_count: this.index.childCount(n.path),
        ...(open ? { open_items: open } : {}),
      };
    });
    const setup =
      root && isPlaceholder(root.summary)
        ? `Knowledge tree not filled yet: do the "${BOOTSTRAP_TAG}" task in your inbox first (none? ask a human to run \`cortexboard bootstrap\`)`
        : null;
    const drafts = this.drafts.list();
    const mine = actor.kind === "human" ? drafts : drafts.filter((d) => d.proposed_by === actor.id);
    const allStale = this.staleness.list();
    const stale = allStale.filter(actionable);
    const yours = this.staleFromYourChanges(actor, stale);
    // Work this agent handed in that has waited on a person for days: worth a reminder in the chat
    // (task 01M3P48AXZTQT6QGJY8TW8V1G6). The board shows the same rows with how long they have waited.
    const remindBefore = new Date(Date.now() - REVIEW_REMIND_DAYS * 86_400_000).toISOString();
    const waiting =
      actor.kind === "ai"
        ? this.index
            .queryItems({ open: true, status: "review", limit: 200, offset: 0 })
            .items.filter((i) => i.last_reply_by === actor.id && i.updated_at < remindBefore)
        : [];
    const unchecked = actor.kind === "ai" ? this.ruleChecks.unansweredBy(actor.id, new Date(Date.now() - 14 * 86_400_000).toISOString()) : [];
    const inbox = this.items.inbox(actor, 5, visible);
    // The rest of the open queue, what waits on others: "what is going on here" without a cortex_items call.
    // Inbox items are left out so the brief never spends tokens listing the same item twice.
    const inboxIds = new Set(this.items.inbox(actor, 200, visible).items.map((i) => i.id));
    const others = this.index.queryItems({ open: true, visible, limit: 200, offset: 0 }).items.filter((i) => !inboxIds.has(i.id));
    const recent = this.index.queryActivity({ includeSystem: false, limit: 3 }).map((a) => ({ id: a.id, actor: a.actor, at: a.at, summary: a.summary }));
    // Where the project stands, as its last reader left it. Project-wide, so a member who sees only part of
    // the project does not get it.
    const status = visible ? undefined : this.status.get();
    const statusHint =
      status === null
        ? "cortex_update_status: write where the project stands and what is next; the next session starts from it"
        : status?.stale
          ? `Project status is stale (${status.reason === "days" ? `${status.days_old} days old` : `${status.changes_since} changes since`}): update it with cortex_update_status before you finish`
          : null;

    const build = ([chars, rows, activity, statusChars]: [number, number, number, number]) => ({
      project: {
        name: this.project.config.project.name,
        summary: root?.summary ?? this.project.config.project.summary ?? "",
      },
      ...(status !== undefined
        ? {
            status: status
              ? {
                  body: shorten(status.body, statusChars),
                  updated_at: status.updated_at,
                  updated_by: status.updated_by,
                  ...(status.stale ? { stale: { reason: status.reason, days_old: status.days_old, changes_since: status.changes_since } } : {}),
                }
              : null,
          }
        : {}),
      you: actor,
      branches: branches.map((b) => ({ ...b, summary: shorten(b.summary, chars) })),
      // Says out loud that this brief was shortened (cortex_tree has the full text), in as few tokens as it costs.
      ...(chars < 300 ? { trimmed: true } : {}),
      attention: {
        inbox: {
          count: inbox.count,
          top: inbox.items.slice(0, rows).map(({ id, type, title, reason, blocking }) => ({ id, type, title, reason, ...(blocking ? { blocking } : {}) })),
        },
        // Open work waiting on someone else: humans, other agents, or nobody yet. Left out when empty.
        ...(others.length
          ? {
              open_elsewhere: {
                count: others.length,
                top: others
                  .slice(0, rows)
                  .map((i) => ({ id: i.id, type: i.type, title: i.title, status: i.status, ...(i.assignee ? { assignee: i.assignee } : {}) })),
              },
            }
          : {}),
        // Count + a few: after a bootstrap there can be dozens, and the brief must stay small.
        pending_approvals: {
          count: mine.length,
          top: mine.slice(0, rows).map((d) => ({ draft_id: d.id, kind: d.kind, target: d.target, proposed_by: d.proposed_by })),
        },
        // Knowledge whose code changed since it was verified: fix it or verify it when you touch that area.
        // Only high and medium count; formatting-only and snoozed ones are left out of the brief.
        ...(stale.length
          ? {
              stale_nodes: {
                count: stale.length,
                top: stale.slice(0, rows).map((s) => ({ path: s.path, severity: s.severity, files: s.changes.map((c) => c.file) })),
                // Stale because of files you logged changing: yours to close first.
                ...(yours.length ? { from_your_changes: yours.slice(0, rows) } : {}),
              },
            }
          : {}),
        // Your logged work of the last two weeks with decisions you never said you followed: answer them
        // (cortex_answer_rules) before people see them as unanswered.
        ...(waiting.length
          ? {
              waiting_on_review: {
                count: waiting.length,
                top: waiting.slice(0, rows).map((i) => ({ id: i.id, title: i.title, days: Math.floor((Date.now() - Date.parse(i.updated_at)) / 86_400_000) })),
                next: "Remind the person: cortex_ask_human kind transition (it goes to the board if the chat cannot ask).",
              },
            }
          : {}),
        ...(unchecked.length ? { unanswered_rule_checks: { count: unchecked.length, top: unchecked.slice(0, rows) } } : {}),
      },
      recent_activity: recent.slice(0, activity),
      search: ["ready", "indexing"].includes(this.semantic.status().state) ? "hybrid" : "keyword",
      // The language rule is the first global rule; no separate field, every token counts here.
      // Each type with what it must have, "issue(category_path,severity)", so an agent's first create is valid in
      // as few tokens as the plain list cost; cortex_rules(type) has the rest.
      rules: {
        version: rulesVersion(this.project.dir),
        global: this.globalRules(),
        item_types: Object.entries(this.itemTypeRequirements()).map(([type, req]) =>
          req.length ? `${type}(${req.map((r) => r.replace(/^fields[.]/, "")).join(",")})` : type,
        ),
      },
      // A project nobody has described yet has one next step, filling the tree; the usual hints can wait.
      next: setup
        ? [setup]
        : [
            ...(statusHint ? [statusHint] : []),
            "cortex_inbox for everything waiting on you",
            "cortex_search(q) before changing anything you don't fully understand",
            "cortex_tree(path) / cortex_node(path) to drill down; cortex_log_activity after each change",
          ],
    });
    // Steps tried in order until the brief fits: shorter branch summaries, then fewer rows.
    // The fourth number is how much of the project status fits (GET /status has all of it).
    const steps: [number, number, number, number][] = [
      [300, 5, 3, 1200], // full summaries
      [160, 5, 3, 900],
      [160, 3, 2, 700],
      [100, 3, 2, 500],
      [60, 2, 1, 400],
      [0, 1, 1, 300], // last resort: titles only; cortex_tree has the summaries
    ];
    let out = build(steps[0]);
    for (const step of steps.slice(1)) {
      if (estimateTokens(out) <= budget) break;
      out = build(step);
    }
    return out;
  }

  // Worth a warning: formatting-only changes and snoozed nodes are not.
  private isStale(path: string): boolean {
    const s = this.staleness.get(path);
    return !!s && actionable(s);
  }

  // Stale nodes whose changed files this actor logged in the last two weeks.
  private staleFromYourChanges(actor: Actor, stale: StaleInfo[]): string[] {
    if (!stale.length) return [];
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const files = new Set(this.index.queryActivity({ actor: actor.id, since, includeSystem: false, limit: 200 }).flatMap((a) => a.files ?? []));
    if (!files.size) return [];
    return stale.filter((s) => s.changes.some((c) => files.has(c.file))).map((s) => s.path);
  }

  treeView(path: string, depth = 1, budget?: number) {
    const p = normalizePath(path);
    const self = this.index.getNode(p);
    if (!self) throw this.notFound(p);
    const d = Math.min(Math.max(depth, 0), 5);
    let used = 0;
    let truncated = false;
    const build = (n: IndexedNode, level: number): NodeSummary => {
      const s: NodeSummary = { path: n.path, title: n.title, summary: n.summary, status: this.isStale(n.path) ? "stale" : n.status };
      const open = this.index.openItemsUnder(n.path);
      if (open) s.open_items = open;
      used += estimateTokens(s);
      const kids = this.index.children(n.path);
      if (level < d && kids.length > 0) {
        s.children = [];
        for (const k of kids) {
          if (budget && used > budget) {
            truncated = true;
            break;
          }
          s.children.push(build(k, level + 1));
        }
      }
      if (!s.children || s.children.length < kids.length) s.child_count = kids.length;
      return s;
    };
    const node = build(self, 0);
    return { node, truncated, ...(truncated ? { hint: "Budget reached. Open a child path directly." } : {}) };
  }

  // A node plus whether it can still be trusted: what the API and MCP return.
  nodeView(path: string) {
    const node = this.node(path);
    const stale = this.staleness.get(node.path);
    return {
      node,
      ...(stale
        ? {
            staleness: {
              ...stale,
              hint: "The linked code changed after this was written. Check the changes, then update the node or verify it (cortex_verify_node).",
            },
          }
        : {}),
    };
  }

  // Everything Cortex knows about some files: read this before editing them.
  // By default only what still applies: open items and accepted decisions. Finished work, closed issues,
  // decided discussions and rejected or superseded decisions cost an agent tokens and say nothing about the
  // code as it is; they are counted (`closed_items`) and come with includeClosed.
  codeContext(files: string[], opts: { includeClosed?: boolean } = {}) {
    if (!files.length) throw new CortexError("invalid_request", "Pass at least one file or directory path.", 400, { example: ["src/auth/login.ts"] });
    const links = this.index.linksForFiles(files.map((f) => f.normalize("NFC")));
    const nodes = new Map<string, Record<string, unknown>>();
    const items = new Map<string, Record<string, unknown>>();
    const closed = new Set<string>();
    const applies = (i: { open: boolean; type: string; status: string }) => i.open || (i.type === "decision" && i.status === "accepted");
    const consider = (i: { id: string; type: string; title: string; status: string; open: boolean }, via: string) => {
      if (items.has(i.id)) return;
      if (!opts.includeClosed && !applies(i)) {
        closed.add(i.id);
        return;
      }
      closed.delete(i.id);
      items.set(i.id, { id: i.id, type: i.type, title: i.title, status: i.status, via });
    };
    for (const l of links) {
      if (l.kind === "node") {
        const n = this.index.getNode(l.ref);
        if (!n) continue;
        const cur = (nodes.get(l.ref) ?? { path: n.path, title: n.title, summary: n.summary, files: [] as string[] }) as { files: string[] } & Record<
          string,
          unknown
        >;
        cur.files.push(l.lines ? `${l.file}:${l.lines}` : l.file);
        if (this.isStale(n.path)) cur.stale = true;
        nodes.set(l.ref, cur);
      } else {
        const i = this.index.getItem(l.ref);
        if (i) consider(i, "code link");
      }
    }
    // Open items and decisions filed under the matched knowledge also concern these files.
    for (const path of nodes.keys()) {
      for (const i of this.index.queryItems({ under: path, limit: 20, offset: 0 }).items) {
        if (i.open || i.type === "decision") consider(i, path);
      }
    }
    return {
      files,
      knowledge: [...nodes.values()],
      items: [...items.values()],
      closed: [...closed], // ids; the API turns them into a count after its visibility check
      ...(nodes.size === 0 ? { hint: "No knowledge links these files yet. After your change, link them from the relevant node (links.code)." } : {}),
    };
  }

  // "Still true" without changing content: moves the node's verification point to HEAD.
  verifyNode(actor: Actor, path: string, note?: string): WriteResult {
    const head = this.staleness.currentHead();
    if (!head) throw new CortexError("no_git", "Verification needs a git repository with at least one commit.", 400);
    const n = this.node(path);
    const { id: _id, status: _s, updated_by: _u, updated_at: _a, ...content } = n;
    return this.putNode(actor, { ...content, verified_at_commit: head, reason: note ?? `Verified still accurate at ${head.slice(0, 7)}` });
  }

  verifyMany(actor: Actor, paths: string[]) {
    if (!Array.isArray(paths) || !paths.length)
      throw new CortexError("invalid_request", "Pass the node paths to verify.", 400, { example: { paths: ["backend/auth"] } });
    const done: WriteResult[] = [];
    const failed: { path: string; code: string; message: string }[] = [];
    for (const p of new Set(paths)) {
      try {
        done.push(this.verifyNode(actor, p));
      } catch (e) {
        const err = e instanceof CortexError ? e : new CortexError("internal", String(e), 500);
        failed.push({ path: p, code: err.code, message: err.message });
      }
    }
    return {
      done: done.map((r) => r.path!),
      drafts: done.filter((r) => !r.applied).length,
      failed,
      message: `${done.length} verified${failed.length ? `, ${failed.length} failed` : ""}.`,
    };
  }

  // "Ask an agent to update this": a task for @ai, filed under the node's branch and linked to it and its
  // changed files, so it lands in an agent's inbox with everything it needs. One open request per node: asking
  // again returns the one already open.
  requestNodeUpdate(actor: Actor, path: string): { applied: boolean; id: string; existing: boolean; message: string } {
    const p = normalizePath(path);
    const node = this.node(p);
    const info = this.staleness.get(p);
    if (!info) throw new CortexError("not_stale", `"${p}" is not stale: its code has not changed since it was verified.`, 400);
    const open = this.index.queryItems({ type: "task", under: p, open: true, limit: 200, offset: 0 }).items;
    for (const i of open) {
      const item = this.itemStore.read(i.id);
      if (item?.tags?.includes(STALE_UPDATE_TAG) && item.links?.nodes?.includes(p)) {
        return { applied: false, id: i.id, existing: true, message: "An update request for this node is already open." };
      }
    }
    const tr = this.language() === "tr";
    const files = info.changes.map((c) => `- \`${c.renamed_to ?? c.file}\`${c.status === "deleted" ? (tr ? " (silindi)" : " (deleted)") : ""}`);
    const body = (
      tr
        ? [
            `\`${p || "(kök)"}\` bilgi düğümü eskidi: anlattığı kod ${info.verified_at_commit.slice(0, 7)} commit'inde doğrulandıktan sonra değişti.`,
            "",
            "## Değişen dosyalar",
            ...files,
            "",
            "## Yapılacak",
            `1. \`cortex_node("${p}")\` ile düğümü oku; staleness bölümü değişen dosyaları ve commit'leri gösterir.`,
            "2. Kodu kontrol et.",
            "3. Düğüm artık yanlışsa `cortex_update_node` ile güncelle; hâlâ doğruysa `cortex_verify_node` ile doğrula.",
            "4. Bu göreve ne yaptığını yazarak `review`'a al.",
          ]
        : [
            `The knowledge node \`${p || "(root)"}\` is stale: the code it describes changed after it was verified at ${info.verified_at_commit.slice(0, 7)}.`,
            "",
            "## Changed files",
            ...files,
            "",
            "## To do",
            `1. Read the node with \`cortex_node("${p}")\`; its staleness section lists the changed files and commits.`,
            "2. Check the code.",
            "3. If the node is now wrong, update it with `cortex_update_node`; if it still holds, verify it with `cortex_verify_node`.",
            "4. Reply on this task saying what you did, and move it to `review`.",
          ]
    ).join("\n");
    const r = this.items.create(actor, {
      type: "task",
      title: shorten(tr ? `Bilgiyi güncelle: ${node.title}` : `Update the knowledge: ${node.title}`, 160),
      body,
      assignee: "@ai",
      ...(p ? { category_path: p } : {}),
      tags: [STALE_UPDATE_TAG],
      links: { nodes: [p], code: info.changes.map((c) => ({ file: c.renamed_to ?? c.file })).slice(0, 50) },
    });
    return { applied: r.applied, id: r.id, existing: false, message: r.message };
  }

  node(path: string): KnowledgeNode {
    const p = normalizePath(path);
    const n = this.tree.read(p);
    if (!n) throw this.notFound(p);
    return n;
  }

  // One search over knowledge, items (decisions, issues, questions...) and activity: "why did we do X?" lands here.
  // Hybrid when the semantic index is available: keyword and meaning rankings fused with Reciprocal Rank Fusion.
  async search(
    q: string,
    opts: {
      kinds?: DocKind[];
      under?: string;
      status?: string;
      type?: string;
      limit?: number;
      budget?: number;
      archived?: boolean;
      // Who wrote it (item author, node's last editor, activity actor), who it is assigned to (items only), and
      // when it last changed: [since, until), ISO dates or datetimes.
      actor?: string;
      assignee?: string;
      since?: string;
      until?: string;
    } = {},
  ) {
    if (!q || !q.trim()) throw new CortexError("empty_query", "Query is empty.", 400, { example: "/api/search?q=jwt refresh" });
    const badKind = opts.kinds?.find((k) => !["node", "item", "activity"].includes(k)); // "draft" is internal
    if (badKind) throw new CortexError("invalid_query", `Unknown kind "${badKind}".`, 400, { kinds: ["node", "item", "activity"] });
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    // Pending knowledge drafts are searched with nodes and come back as nodes with status "draft".
    const kinds: DocKind[] | undefined = opts.kinds && (opts.kinds.includes("node") ? [...opts.kinds, "draft"] : opts.kinds);
    const filter = { kinds, under: opts.under ? normalizePath(opts.under) : undefined, status: opts.status, type: opts.type };
    const narrowed = !!(opts.actor || opts.assignee || opts.since || opts.until);
    // Filters applied after ranking need a deeper pool, or a narrow filter leaves the page half empty.
    const pool = Math.max(limit * (narrowed ? 10 : 3), 30);
    const keyword = this.index.search(q, { ...filter, limit: pool });
    const semantic = await this.semantic.search(q, filter, pool).catch(() => null);

    const fused = new Map<string, { kind: DocKind; ref: string; score: number; keyword: boolean; semantic: boolean }>();
    const add = (kind: DocKind, ref: string, rank: number, via: "keyword" | "semantic") => {
      const k = `${kind}:${ref}`;
      const cur = fused.get(k) ?? { kind, ref, score: 0, keyword: false, semantic: false };
      cur.score += 1 / (RRF_K + rank + 1);
      cur[via] = true;
      fused.set(k, cur);
    };
    keyword.forEach((h, i) => add(h.kind, h.ref, i, "keyword"));
    semantic?.forEach((h, i) => add(h.kind, h.ref, i, "semantic"));
    // Archived records, and activity older than the search window, stay out unless asked for: they are
    // why the archive exists (they cost tokens and crowd out what still applies).
    const activityCutoff = this.archive.activityCutoff();
    const current = (kind: DocKind, ref: string) => {
      if (opts.archived) return true;
      if (kind === "item") return !this.index.getItem(ref)?.archived;
      if (kind === "node") return !this.index.getNode(ref)?.archived;
      if (kind === "activity") return (this.index.getActivity(ref)?.at ?? "") >= activityCutoff;
      return true;
    };
    const inRange = (at: string | null | undefined) => !!at && (!opts.since || at >= opts.since) && (!opts.until || at < opts.until);
    const dated = !!(opts.since || opts.until);
    const matches = (kind: DocKind, ref: string) => {
      if (!narrowed) return true;
      if (kind === "item") {
        const i = this.index.getItem(ref);
        return !!i && (!opts.actor || i.author === opts.actor) && (!opts.assignee || i.assignee === opts.assignee) && (!dated || inRange(i.updated_at));
      }
      if (opts.assignee) return false; // only items are assigned
      if (kind === "node" || kind === "draft") {
        const n = kind === "node" ? this.index.getNode(ref) : null;
        return !!n && (!opts.actor || n.updated_by === opts.actor) && (!dated || inRange(n.updated_at));
      }
      const a = this.index.getActivity(ref);
      return !!a && (!opts.actor || a.actor === opts.actor) && (!dated || inRange(a.at));
    };
    const ranked = [...fused.values()]
      .filter((h) => current(h.kind, h.ref) && matches(h.kind, h.ref))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const results: Record<string, unknown>[] = [];
    let used = 0;
    let truncated = false;
    for (const h of ranked) {
      const described = this.describeHit(h.kind, h.ref, Math.round(h.score * 10000) / 10000);
      if (!described) continue;
      const r = { ...described, match: h.keyword && h.semantic ? "both" : h.keyword ? "keyword" : "semantic" };
      used += estimateTokens(r);
      if (opts.budget && used > opts.budget && results.length > 0) {
        truncated = true;
        break;
      }
      results.push(r);
    }
    return { query: q, mode: semantic ? "hybrid" : "keyword", semantic: this.semantic.status(), results, truncated };
  }

  private describeHit(kind: DocKind, ref: string, score: number): Record<string, unknown> | null {
    if (kind === "draft") {
      const d = this.drafts.get(ref);
      if (!d || d.kind !== "node") return null;
      return {
        kind: "node",
        path: d.target,
        title: d.data.title,
        summary: d.data.summary,
        status: "draft",
        draft_id: d.id,
        proposed_by: d.proposed_by,
        score,
        note: "Not approved yet: may be wrong or change.",
      };
    }
    if (kind === "node") {
      const n = this.index.getNode(ref);
      return n && { kind, path: n.path, title: n.title, summary: n.summary, status: this.isStale(n.path) ? "stale" : n.status, score };
    }
    if (kind === "item") {
      const i = this.index.getItem(ref);
      const full = i && this.itemStore.read(ref);
      return (
        i && {
          kind,
          id: i.id,
          type: i.type,
          title: i.title,
          status: i.status,
          ...(i.category_path ? { category_path: i.category_path } : {}),
          summary: snippet(full?.body ?? ""),
          score,
        }
      );
    }
    const a = this.index.getActivity(ref);
    return a && { kind, id: a.id, actor: a.actor, at: a.at, action: a.action, summary: a.summary, ...(a.why ? { why: snippet(a.why) } : {}), score };
  }

  // ---- node writes --------------------------------------------------------

  putNode(actor: Actor, input: NodeInput): WriteResult {
    // What is left out keeps its value: title and summary always, and on a partial edit (a section, an
    // append) also tags and links, so changing one paragraph does not mean sending the node again.
    const before = typeof input?.path === "string" ? this.tree.read(normalizePath(input.path)) : null;
    const partial = input?.section !== undefined || input?.body_mode === "append";
    if (before) {
      input = {
        ...input,
        title: input.title ?? before.title,
        summary: input.summary ?? before.summary,
        ...(partial ? { tags: input.tags ?? before.tags, links: input.links ?? before.links } : {}),
      };
    }
    const parsed = NodeInput.safeParse(input);
    if (!parsed.success) {
      throw new CortexError("invalid_node", "Node does not match the schema.", 400, {
        issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        rules: "title 1-120 chars, summary 1-300 chars (required, keep it short: it is what other AIs read first)",
        example: NODE_EXAMPLE,
      });
    }
    const { reason, review, body_mode, section, confirm_shrink, ...data } = parsed.data;
    const path = normalizePath(data.path);
    const existing = this.tree.read(path);
    if (section !== undefined || body_mode === "append") data.body = editBody(existing?.body ?? "", { body: data.body, body_mode, section });
    // The same guard as items: an AI replacing a body with less than half of it is most likely sending a part
    // as the whole. `section` or `body_mode: "append"` change a part; confirm_shrink says the cut is meant.
    if (actor.kind === "ai" && !confirm_shrink && existing && shrinks(existing.body, data.body)) {
      throw new CortexError("body_shrink", "This would remove more than half of the node's body.", 409, {
        hint: 'To change one part, pass section: "<heading>" (or body_mode: "append"); to cut it on purpose, confirm_shrink: true.',
        sections: sectionTitles(existing.body),
      });
    }
    if (data.links?.code?.length && this.staleness.enabled()) {
      if (data.verified_at_commit) {
        if (!this.staleness.git.commitExists(data.verified_at_commit)) {
          throw new CortexError("invalid_node", `verified_at_commit "${data.verified_at_commit}" is not a commit in this repository.`, 400);
        }
      } else {
        // Whoever writes the node vouches for it as of now.
        data.verified_at_commit = this.staleness.currentHead() ?? undefined;
      }
    }
    const node: KnowledgeNode = {
      ...data,
      path,
      id: existing?.id ?? ulid(),
      ...(existing?.archived ? { archived: existing.archived } : {}), // editing an archived node does not bring it back
      status: "active",
      updated_by: actor.id,
      updated_at: nowIso(),
    };

    const policy = actor.policy?.node ?? this.project.config.approval.node ?? "review";
    if (actor.kind === "ai" && policy === "human_only") {
      throw new CortexError("forbidden", "Only humans may change knowledge nodes in this project.", 403);
    }
    if (actor.kind === "ai" && (policy === "review" || review === true)) {
      // Validate the parent now, so the AI hears about a broken path immediately rather than at approval time.
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : path === "" ? null : "";
      if (parent !== null && !this.tree.exists(parent) && !this.drafts.list().some((d) => d.kind === "node" && d.target === parent)) {
        throw new CortexError("parent_missing", `Parent "${parent}" does not exist. Create the parent branch first.`, 400, {
          create_first: parent,
        });
      }
      // Revising your own pending proposal replaces it, so reviewers see one draft per node, not a pile.
      const previous = this.drafts.list().find((d) => d.kind === "node" && d.target === path && d.proposed_by === actor.id);
      if (previous) this.removeDraft(previous.id);
      const draftId = this.saveDraft({
        kind: "node",
        target: path,
        proposed_by: actor.id,
        reason,
        base_rev: existing ? nodeRevision(existing) : undefined,
        data: node,
      });
      return {
        applied: false,
        path,
        draft_id: draftId,
        message: `${previous ? "Replaced your earlier draft." : "Saved as draft."} A human must approve it before it becomes active.`,
      };
    }

    this.writeNode(node);
    const untracked = this.staleness.enabled() ? this.staleness.git.untracked((data.links?.code ?? []).map((l) => l.file)) : [];
    const entry = this.activity.system(
      actor.id,
      "node.updated",
      `${existing ? "Updated" : "Created"} node "${path || "(root)"}"${reason ? `: ${reason}` : ""}`,
      [path],
    );
    this.chat.remember(entry, { type: "node", path, before: existing }); // written from a chat answer: undoable
    return {
      applied: true,
      path,
      message: existing ? "Node updated." : "Node created.",
      ...(node.body.length > BIG_NODE_CHARS
        ? {
            hint: `This node is ${Math.round(node.body.length / 1000)} KB: costly to read and to change. Consider moving its sections into child nodes (${path || "(root)"}/<name>) and keeping a short overview here; edit parts with section: "<heading>".`,
          }
        : {}),
      // Linking code that is not committed yet is allowed, but nothing can tell when it changes.
      ...(untracked.length ? { warning: `Not in git yet, so staleness cannot follow them until they are committed: ${untracked.join(", ")}` } : {}),
    };
  }

  // Humans only. For branches that do not apply to the project, or knowledge that is simply gone.
  // Kept in git history, so it can be brought back; children and open items must be dealt with first.
  deleteNode(actor: Actor, path: string, reason?: string): WriteResult {
    if (actor.kind !== "human") {
      throw new CortexError("forbidden", "Only humans can delete knowledge. If a node is wrong, propose a fix with cortex_update_node or ask @humans.", 403);
    }
    const p = normalizePath(path);
    if (p === "") throw new CortexError("invalid_request", "The project root cannot be deleted.", 400);
    this.node(p); // 404 with suggestions
    const children = this.index.children(p).map((c) => c.path);
    if (children.length)
      throw new CortexError("has_children", `"${p}" still has ${children.length} child node(s). Delete or move them first.`, 409, { children });
    const open = this.index.queryItems({ under: p, open: true, limit: 20, offset: 0 }).items;
    if (open.length) {
      throw new CortexError("has_open_items", `${open.length} open item(s) are filed under "${p}". Close them or move them to another branch first.`, 409, {
        items: open.map((i) => ({ id: i.id, type: i.type, title: i.title })),
      });
    }
    this.tree.remove(p);
    this.index.deleteNode(p);
    this.activity.system(actor.id, "node.deleted", `Deleted node "${p}"${reason ? `: ${reason}` : ""}`, [p]);
    return { applied: true, path: p, message: "Node deleted. It stays in git history." };
  }

  // Also used by ChatService to put back what a chat answer replaced.
  writeNode(node: KnowledgeNode): void {
    this.tree.write(node);
    this.index.upsertNode(node);
  }

  // ---- drafts & approval --------------------------------------------------

  saveDraft(d: Omit<Draft, "id" | "proposed_at">): string {
    const draft = { ...d, id: ulid(), proposed_at: nowIso() } as Draft;
    this.drafts.save(draft);
    this.index.upsertDraft(draft);
    this.activity.system(
      d.proposed_by,
      "draft.proposed",
      `Proposed a change to ${d.kind} "${d.kind === "node" ? d.target || "(root)" : d.data.title}"`,
      [d.target],
      { kind: d.kind, proposed_by: d.proposed_by },
    );
    return draft.id;
  }

  private removeDraft(id: string): void {
    this.drafts.remove(id);
    this.index.removeDraft(id);
  }

  // `verifyAtHead`: the approver has checked the draft against the current code, so pin it there even though
  // the linked files changed after it was proposed.
  approve(actor: Actor, draftId: string, force = false, opts: { verifyAtHead?: boolean } = {}): WriteResult {
    this.requireHuman(actor);
    const d = this.draftOr404(draftId);
    let warning: StaleChange[] | undefined;
    const before = this.draftTarget(d); // kept when the approval came from the chat, so the board can undo it
    if (d.kind === "node") {
      const current = this.tree.read(d.target);
      if (!force && current && d.base_rev !== nodeRevision(current)) throw this.conflict(current.updated_by, current.updated_at);
      const pin = this.pinOnApproval(d.data, opts.verifyAtHead === true);
      warning = pin.changed;
      this.writeNode({ ...d.data, ...(pin.commit ? { verified_at_commit: pin.commit } : {}), status: "active", updated_at: nowIso() });
    } else {
      const current = this.itemStore.read(d.target);
      if (!force && current && d.base_rev !== itemRevision(current)) throw this.conflict(current.updated_by, current.updated_at);
      this.items.applyDraft({ ...d.data, updated_at: nowIso() });
    }
    this.removeDraft(d.id);
    const entry = this.activity.system(actor.id, "draft.approved", `Approved ${d.proposed_by}'s change to ${d.kind} "${d.target || "(root)"}"`, [d.target], {
      kind: d.kind,
      proposed_by: d.proposed_by,
    });
    this.chat.remember(
      entry,
      d.kind === "node"
        ? { type: "node", path: d.target, before: before as KnowledgeNode | null }
        : { type: "item", id: d.target, before: before as Item | null },
    );
    return {
      applied: true,
      ...(d.kind === "node" ? { path: d.target } : { id: d.target }),
      message: `Approved draft from ${d.proposed_by}.`,
      ...(warning?.length
        ? {
            warning: "stale_after_approval",
            stale_changes: warning,
            hint: "The linked code changed after this draft was proposed, so it stays pinned to the commit it was written at. Approve with verify_at_head once you have checked it against the current code.",
          }
        : {}),
    };
  }

  // A draft is written against the code at its proposal commit. By approval time HEAD has usually moved on,
  // and keeping the old pin made every approved draft stale on arrival. So: if none of its linked files
  // changed in between, the draft describes HEAD equally well and is pinned there. If they did change,
  // the old pin stays (a real code change is never skipped silently) unless the approver vouches for HEAD.
  private pinOnApproval(node: KnowledgeNode, verifyAtHead: boolean): { commit?: string; changed?: StaleChange[] } {
    const links = node.links?.code ?? [];
    const from = node.verified_at_commit;
    const head = this.staleness.currentHead();
    if (!links.length || !from || !head || head.startsWith(from)) return {};
    if (verifyAtHead) return { commit: head };
    const changed = this.staleness.changesSince(from, links);
    if (changed === null) return {}; // commit unknown to this clone: leave it for staleness to report
    return changed.length ? { changed } : { commit: head };
  }

  reject(actor: Actor, draftId: string, reason?: string): WriteResult {
    this.requireHuman(actor);
    const d = this.draftOr404(draftId);
    this.removeDraft(d.id);
    const entry = this.activity.system(
      actor.id,
      "draft.rejected",
      `Rejected ${d.proposed_by}'s change to ${d.kind} "${d.target || "(root)"}"${reason ? `: ${reason}` : ""}`,
      [d.target],
      { kind: d.kind, proposed_by: d.proposed_by },
    );
    this.chat.remember(entry, { type: "draft", draft: d });
    return { applied: false, ...(d.kind === "node" ? { path: d.target } : { id: d.target }), message: "Draft rejected." };
  }

  // Bulk review after a bootstrap. Parents go before children so a new branch and its leaves can be approved together.
  // One failure (e.g. a conflict) does not stop the rest; each is reported.
  // A risky draft (one that removes much of what is there) is never approved in a batch: it fails here with
  // "risky_draft" and must be opened and approved on its own, after reading it.
  approveMany(actor: Actor, ids: string[], force = false, opts: { verifyAtHead?: boolean } = {}) {
    return this.many(actor, ids, (id) => {
      if (this.draftChanges(this.draftOr404(id)).risky) {
        throw new CortexError("risky_draft", "This draft removes much of what is there. Open it and approve it on its own.", 409);
      }
      return this.approve(actor, id, force, opts);
    });
  }

  rejectMany(actor: Actor, ids: string[], reason?: string) {
    return this.many(actor, ids, (id) => this.reject(actor, id, reason));
  }

  private many(actor: Actor, ids: string[], fn: (id: string) => WriteResult) {
    this.requireHuman(actor);
    if (!Array.isArray(ids) || !ids.length) throw new CortexError("invalid_request", "Pass the draft ids to act on.", 400, { example: { ids: ["01J9Z..."] } });
    const depth = (id: string) => {
      const d = this.drafts.get(id);
      return d?.kind === "node" ? (d.target === "" ? 0 : d.target.split("/").length) : 99;
    };
    const ordered = [...new Set(ids)].map((id) => ({ id, depth: depth(id) })).sort((a, b) => a.depth - b.depth);
    const done: string[] = [];
    const failed: { id: string; code: string; message: string }[] = [];
    const staleAfter: string[] = []; // approved, but still stale: the code moved after they were proposed
    for (const { id } of ordered) {
      try {
        if (fn(id).warning === "stale_after_approval") staleAfter.push(id);
        done.push(id);
      } catch (e) {
        const err = e instanceof CortexError ? e : new CortexError("internal", String(e), 500);
        failed.push({ id, code: err.code, message: err.message });
      }
    }
    return {
      done,
      failed,
      ...(staleAfter.length ? { stale_after_approval: staleAfter } : {}),
      message: `${done.length} done${failed.length ? `, ${failed.length} failed` : ""}${staleAfter.length ? `, ${staleAfter.length} still stale` : ""}.`,
    };
  }

  // Each draft with the size of its change (lines added and removed, risky), for the list and the inbox.
  // `changes: false` skips reading the targets, for callers that only count.
  listDrafts(opts: { changes?: boolean } = {}) {
    return this.drafts.list().map((draft) => {
      const { data, ...d } = draft;
      const c = opts.changes === false ? null : this.draftChanges(draft);
      return {
        ...d,
        title: data.title,
        summary: d.kind === "node" ? (data as KnowledgeNode).summary : snippet(data.body),
        ...(c ? { changes: { added: c.body.added, removed: c.body.removed, fields: c.fields.length, new: c.new, risky: c.risky } } : {}),
      };
    });
  }

  getDraft(id: string) {
    const d = this.draftOr404(id);
    const current = this.draftTarget(d);
    return { draft: d, current, changes: draftChanges(current, d.data) };
  }

  private draftTarget(d: Draft): KnowledgeNode | Item | null {
    return d.kind === "node" ? this.tree.read(d.target) : this.itemStore.read(d.target);
  }

  draftChanges(d: Draft): DraftChanges {
    return draftChanges(this.draftTarget(d), d.data);
  }

  // ---- rules --------------------------------------------------------------

  private globalDoc(): { rules?: string[]; language?: string } {
    const file = join(this.p.rules, "_global.yaml");
    if (!existsSync(file)) return {};
    return (YAML.parse(readFileSync(file, "utf8")) ?? {}) as { rules?: string[]; language?: string };
  }

  // The language humans chose for everything written into Cortex (knowledge, items, replies, activity).
  language(): string | null {
    return this.globalDoc().language ?? null;
  }

  // The language rule goes first: it applies to every write, and AIs read the top of a list most reliably.
  globalRules(): string[] {
    const rules = this.globalDoc().rules ?? [];
    const lang = this.language();
    return lang ? [languageRule(lang), ...rules] : rules;
  }

  rules(name?: string) {
    const version = rulesVersion(this.project.dir);
    const one = (n: string): unknown => {
      if (n === "_global") return { ...(this.language() ? { language: this.language() } : {}), rules: this.globalRules() };
      if (n === "activity") return this.activitySchema();
      const s = this.schema(n);
      if (s) return describeSchema(s);
      const file = join(this.p.rules, `${n}.schema.yaml`);
      if (/^[a-z_][a-z0-9_-]*$/.test(n) && existsSync(file)) return YAML.parse(readFileSync(file, "utf8"));
      return null;
    };
    if (name) {
      const r = one(name);
      if (!r) throw new CortexError("not_found", `No rules named "${name}".`, 404, { available: ["_global", "node", "activity", ...this.itemTypes()] });
      return { version, rules: { [name]: r } };
    }
    const names = ["_global", "node", "activity", ...this.itemTypes()];
    return { version, rules: Object.fromEntries(names.map((n) => [n, one(n)]).filter(([, r]) => r)) };
  }

  // Raw YAML so humans edit exactly what is on disk (comments included).
  rulesSource(name: string): { name: string; file: string; source: string; exists: boolean } {
    const file = this.rulesFile(name);
    const full = join(this.p.rules, file);
    if (existsSync(full)) return { name, file, source: readFileSync(full, "utf8"), exists: true };
    const s = this.schema(name);
    return { name, file, source: s ? YAML.stringify(s) : "", exists: false };
  }

  saveRules(actor: Actor, name: string, source: string): { name: string; version: string; message: string } {
    if (actor.kind !== "human") throw new CortexError("forbidden", "Rules belong to humans. Propose a change by opening a question for @humans.", 403);
    const file = this.rulesFile(name);
    let parsed: unknown;
    try {
      parsed = YAML.parse(source);
    } catch (e) {
      throw new CortexError("invalid_rules", `YAML error: ${(e as Error).message}`, 400);
    }
    const issues = validateRulesDoc(name, parsed);
    if (issues.length) throw new CortexError("invalid_rules", `The ${name} rules are not valid.`, 400, { issues });
    writeFileSync(join(this.p.rules, file), source.endsWith("\n") ? source : `${source}\n`, "utf8");
    this.activity.system(actor.id, "rules.updated", `Updated rules "${name}"`);
    return { name, version: rulesVersion(this.project.dir), message: "Rules saved. AIs will see the new rules_version on their next call." };
  }

  private rulesFile(name: string): string {
    if (name === "_global") return "_global.yaml";
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name))
      throw new CortexError("invalid_rules", `Invalid rules name "${name}". Use lowercase letters, digits and dashes.`, 400);
    return `${name}.schema.yaml`;
  }

  // ---- helpers ------------------------------------------------------------

  // Also used by ItemService.update()'s optional if_rev check, outside the draft-approval path.
  conflict(by: string, at: string) {
    return new CortexError("conflict", "The target changed after this draft was proposed. Review the diff, then approve with force.", 409, {
      current_updated_by: by,
      current_updated_at: at,
    });
  }

  private requireHuman(actor: Actor) {
    if (actor.kind !== "human") throw new CortexError("forbidden", "Only human actors can approve or reject drafts.", 403);
  }

  private draftOr404(id: string): Draft {
    const d = this.drafts.get(id);
    if (!d) throw new CortexError("not_found", `Draft ${id} not found.`, 404);
    return d;
  }

  private notFound(path: string) {
    const suggestions = path ? this.index.search(path.replace(/[/-]/g, " "), { kinds: ["node"], limit: 3 }).map((h) => h.ref) : [];
    return new CortexError("not_found", `No node at "${path}".`, 404, suggestions.length ? { did_you_mean: suggestions } : undefined);
  }
}

// Tag on the tasks "ask an agent to update this" opens, so asking twice finds the first one.
const STALE_UPDATE_TAG = "stale-update";

const FIELD_TYPES = ["string", "text", "enum", "number", "boolean", "date", "datetime", "tree_path", "actor", "item_ref", "commit", "url", "evidence", "list"];
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function validateFieldSpecs(prefix: string, fields: unknown, issues: string[]) {
  if (fields === undefined || fields === null) return;
  if (typeof fields !== "object" || Array.isArray(fields)) return void issues.push(`${prefix}: must be a map of field name -> spec`);
  for (const [k, spec] of Object.entries(fields as Record<string, Record<string, unknown>>)) {
    if (!spec || typeof spec !== "object") {
      issues.push(`${prefix}.${k}: must be an object like { type: string }`);
      continue;
    }
    if (!FIELD_TYPES.includes(spec.type as string)) issues.push(`${prefix}.${k}.type: must be one of ${FIELD_TYPES.join(", ")}`);
    if (spec.type === "enum" && !(isStrList(spec.values) && spec.values.length)) issues.push(`${prefix}.${k}.values: an enum needs a non-empty list of values`);
    if (spec.type === "list" && spec.of !== undefined && (!FIELD_TYPES.includes(spec.of as string) || spec.of === "list"))
      issues.push(`${prefix}.${k}.of: invalid element type`);
  }
}

// Structural check before a human's rules edit is written, so a typo cannot break every write.
export function validateRulesDoc(name: string, doc: unknown): string[] {
  const issues: string[] = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return ["the document must be a YAML map"];
  const d = doc as Record<string, unknown>;
  if (name === "_global") {
    if (!isStrList(d.rules)) issues.push("rules: must be a list of strings");
    if (d.language !== undefined && !(typeof d.language === "string" && LANG_CODE.test(d.language))) {
      issues.push('language: a language code such as "tr" or "en"');
    }
    return issues;
  }
  if (name === "activity") {
    if (!isStrList(d.actions) || !d.actions.length) issues.push("actions: must be a non-empty list of strings");
    if (d.why_required_for !== undefined && !isStrList(d.why_required_for)) issues.push("why_required_for: must be a list of actions");
    return issues;
  }
  if (name === "node") return issues;

  if (d.type !== name) issues.push(`type: must be "${name}" (the file name)`);
  const statuses = isStrList(d.statuses) ? d.statuses : [];
  if (!statuses.length) issues.push("statuses: must be a non-empty list of strings");
  const inStatuses = (s: unknown) => typeof s === "string" && statuses.includes(s);
  if (!inStatuses(d.initial)) issues.push("initial: must be one of statuses");
  for (const key of ["terminal", "resolved", "human_only_statuses"]) {
    if (d[key] !== undefined && !(isStrList(d[key]) && (d[key] as string[]).every(inStatuses))) issues.push(`${key}: must list statuses`);
  }
  if (d.transitions !== undefined && d.transitions !== "any") {
    if (typeof d.transitions !== "object" || Array.isArray(d.transitions)) issues.push('transitions: must be "any" or a map of status -> [next statuses]');
    else
      for (const [from, to] of Object.entries(d.transitions as Record<string, unknown>)) {
        if (!inStatuses(from)) issues.push(`transitions.${from}: unknown status`);
        if (!isStrList(to) || !to.every(inStatuses)) issues.push(`transitions.${from}: must list statuses`);
      }
  }
  validateFieldSpecs("fields", d.fields, issues);
  if (d.reply_required !== undefined && d.reply_required !== null) {
    const rr = d.reply_required as Record<string, unknown>;
    if (typeof rr !== "object" || Array.isArray(rr)) issues.push("reply_required: must be a map like { statuses: [review], default: true }");
    else {
      if (!(isStrList(rr.statuses) && rr.statuses.every(inStatuses))) issues.push("reply_required.statuses: must list statuses");
      if (typeof rr.default !== "boolean") issues.push("reply_required.default: must be true or false");
    }
  }
  const reply = d.reply as Record<string, unknown> | undefined;
  if (reply) {
    validateFieldSpecs("reply.fields", reply.fields, issues);
    for (const [i, r] of ((reply.on_reply as Record<string, unknown>[] | undefined) ?? []).entries()) {
      if (!inStatuses(r.from) || !inStatuses(r.to)) issues.push(`reply.on_reply[${i}]: from and to must be statuses`);
      if (!["assignee", "not_author", "author", "anyone"].includes(r.by as string))
        issues.push(`reply.on_reply[${i}].by: assignee | not_author | author | anyone`);
    }
  }
  return issues;
}

function snippet(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
