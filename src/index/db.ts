import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Activity, Draft, Item, KnowledgeNode, NodeStatus, Reply } from "../core/types.js";
import { CortexError } from "../core/types.js";
import { NODE_TOO_OLD_MESSAGE } from "../util/runtime-check.js";
import { fold, shortHash } from "../util/text.js";
import { parentPath } from "../store/tree.js";
import { isSealed } from "../core/discussions.js";
import { countChecklist } from "../core/checklist.js";

export interface IndexedNode {
  path: string;
  parent: string | null;
  title: string;
  summary: string;
  status: NodeStatus;
  tags: string[];
  updated_at: string;
  updated_by: string;
  archived: boolean;
}

// Both come from the rules, not from the item file: a rules edit changes them without any file changing.
export interface ItemFlags {
  terminal: boolean;
  open: boolean;
}

// Attachments as the board card shows them: how many, and which picture is the cover.
export interface FileSummary {
  count: number;
  cover: string | null;
}
const NO_FILES: FileSummary = { count: 0, cover: null };

export interface IndexedItem {
  id: string;
  type: string;
  title: string;
  status: string;
  terminal: boolean; // no transition leads out of this status
  open: boolean; // still waiting for someone (see isOpenWork)
  category_path: string | null;
  author: string;
  assignee: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  blocking: boolean;
  created_at: string;
  updated_at: string;
  reply_count: number;
  last_reply_by: string | null;
  attachment_count: number;
  cover: string | null; // file name of the first picture, shown on the board card
  level: string | null; // fields.priority, or fields.severity for issues
  due: string | null; // fields.due, YYYY-MM-DD
  has_body: boolean;
  archived: boolean;
  checklist: { done: number; total: number }; // task boxes in the body (- [ ] / - [x])
}

export interface ReportItem {
  id: string;
  type: string;
  title: string;
  status: string;
  open: boolean;
  author: string;
  assignee: string | null;
  blocking: boolean;
  created_at: string;
  severity: string | null;
  answered_at: string | null; // first reply from someone other than the author
  answered_by: string | null;
  resolution: string | null; // the latest reply's fields.resolution (a closed issue: fixed, wontfix...)
  updated_at: string;
  archived: boolean;
  due: string | null;
  milestone: string | null;
  checklist: { done: number; total: number };
}

// "draft" is internal: pending knowledge drafts, searchable so an AI can find what is waiting for review.
// The public API only knows node | item | activity; drafts come back as nodes with status "draft".
export type DocKind = "node" | "item" | "activity" | "draft";

export interface DocText {
  kind: DocKind;
  ref: string;
  scope: string;
  status: string;
  type: string;
  text: string;
  hash: string;
}

export interface SearchRow {
  kind: DocKind;
  ref: string;
  score: number;
}

export interface SearchOptions {
  kinds?: DocKind[];
  under?: string;
  status?: string;
  type?: string;
  limit: number;
}

// A WHERE fragment over the items table, with its arguments. Used for visibility: applied before
// LIMIT/OFFSET so a member who sees part of a project gets full pages and a true total.
export interface SqlFilter {
  sql: string;
  args: (string | number)[];
}

export interface ItemQuery {
  type?: string;
  status?: string;
  assignee?: string[];
  author?: string;
  under?: string;
  open?: boolean;
  visible?: SqlFilter | null;
  archived?: "exclude" | "only" | "include"; // default exclude: archived items are out of everyday view
  since?: string; // updated_at >= since
  until?: string; // updated_at < until
  milestone?: string; // fields.milestone
  limit: number;
  offset: number;
}

// Folded (lowercase, no diacritics) Turkish and English filler words, skipped only in the any-term fallback.
const STOPWORDS = new Set(
  (
    "mi mu mı mü ve veya ile de da ki bu su o bir icin gibi ne neden nasil nerede hangi var yok mi daha en cok " +
    "olan olarak ama fakat ya ise diye kadar sonra once icinde uzerinde " +
    "the a an and or of to in on for with is are was were be do does did we you it this that what why how where which"
  ).split(" "),
);

// Bump when the table layout changes; a new version gets a new file, rebuilt from the files.
export const INDEX_VERSION = 12; // 12: code symbols; 8: archived; 9: severity, first answer and resolution, for reports; 10: checklist counts; 11: milestone

// The index is a disposable cache: everything here can be rebuilt from the files with reindex().
export class Index {
  private db: DatabaseSync;

  constructor(indexDir: string) {
    mkdirSync(indexDir, { recursive: true });
    // One file per layout. Versions that share a project (a hub from source, an MCP from npm) used to share
    // cortex.db: whichever opened last dropped and rebuilt the tables, and the other one's inserts then
    // failed with "table items has N columns but M values were supplied". Apart, each keeps its own index in
    // step with the files through its watcher.
    const file = join(indexDir, `cortex-v${INDEX_VERSION}.db`);
    const fresh = !existsSync(file);
    this.db = new DatabaseSync(file);
    // NORMAL skips the fsync on every commit; in WAL mode that can lose the last writes on a power cut but
    // never corrupts the file, and anything lost is rebuilt from the files by reindex().
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    try {
      this.db.exec("CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x); DROP TABLE temp.fts5_probe;");
    } catch {
      this.db.close();
      throw new CortexError("node_too_old", NODE_TOO_OLD_MESSAGE(), 500);
    }
    const v = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (v !== INDEX_VERSION) {
      this.db.exec(`
        DROP TABLE IF EXISTS nodes; DROP TABLE IF EXISTS nodes_fts;
        DROP TABLE IF EXISTS items; DROP TABLE IF EXISTS activity; DROP TABLE IF EXISTS docs_fts; DROP TABLE IF EXISTS doc_text; DROP TABLE IF EXISTS code_links; DROP TABLE IF EXISTS file_stamps;
        PRAGMA user_version = ${INDEX_VERSION};`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        path TEXT PRIMARY KEY, parent TEXT, title TEXT NOT NULL, summary TEXT NOT NULL,
        status TEXT NOT NULL, tags TEXT NOT NULL, updated_at TEXT, updated_by TEXT,
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent);
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
        terminal INTEGER NOT NULL, open_work INTEGER NOT NULL, category_path TEXT, author TEXT NOT NULL, assignee TEXT,
        claimed_by TEXT, claimed_at TEXT,
        blocking INTEGER NOT NULL, created_at TEXT, updated_at TEXT,
        reply_count INTEGER NOT NULL, last_reply_by TEXT,
        attachment_count INTEGER NOT NULL DEFAULT 0, cover TEXT,
        level TEXT, due TEXT, has_body INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        severity TEXT, answered_at TEXT, answered_by TEXT, resolution TEXT,
        checklist_done INTEGER NOT NULL DEFAULT 0, checklist_total INTEGER NOT NULL DEFAULT 0,
        milestone TEXT
      );
      CREATE INDEX IF NOT EXISTS items_assignee ON items(assignee, open_work);
      CREATE INDEX IF NOT EXISTS items_category ON items(category_path);
      CREATE TABLE IF NOT EXISTS activity (
        id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
        summary TEXT NOT NULL, refs TEXT NOT NULL, system INTEGER NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activity_at ON activity(at);
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        kind UNINDEXED, ref UNINDEXED, scope UNINDEXED, status UNINDEXED, type UNINDEXED,
        title, summary, body, tags,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      -- Which knowledge nodes and items point at which code (files or directories, relative to the project root).
      CREATE TABLE IF NOT EXISTS code_links (kind TEXT NOT NULL, ref TEXT NOT NULL, file TEXT NOT NULL, lines TEXT, symbol TEXT);
      CREATE INDEX IF NOT EXISTS code_links_file ON code_links(file);
      -- Raw text of every searchable document, the input for semantic embeddings. fts_rowid points at the
      -- document's row in docs_fts, whose kind and ref columns cannot be looked up without a full scan.
      CREATE TABLE IF NOT EXISTS doc_text (
        kind TEXT NOT NULL, ref TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL, type TEXT NOT NULL,
        text TEXT NOT NULL, hash TEXT NOT NULL, fts_rowid INTEGER NOT NULL, PRIMARY KEY (kind, ref)
      );
      -- What each file under .cortex looked like (mtime and size) when last indexed. Opening a project compares
      -- them with the disk and indexes only what changed while Cortex was not running.
      CREATE TABLE IF NOT EXISTS file_stamps (path TEXT PRIMARY KEY, stamp TEXT NOT NULL);
      -- Embeddings survive reindexes and index upgrades: recomputing them is the expensive part.
      CREATE TABLE IF NOT EXISTS embeddings (
        kind TEXT NOT NULL, ref TEXT NOT NULL, model TEXT NOT NULL, hash TEXT NOT NULL, vec BLOB NOT NULL,
        PRIMARY KEY (kind, ref)
      );
    `);
    if (fresh) this.adoptEmbeddings(indexDir, file);
  }

  // A new index file starts with the embeddings of the newest older one: recomputing them is the slow part,
  // and they depend only on the text (the hash) and the model, never on the table layout.
  private adoptEmbeddings(indexDir: string, current: string): void {
    const older = readdirSync(indexDir)
      .filter((f) => /^cortex(-v\d+)?\.db$/.test(f))
      .map((f) => join(indexDir, f))
      .filter((f) => f !== current)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const f of older) {
      try {
        this.db.prepare("ATTACH DATABASE ? AS old").run(f);
        try {
          const cols = this.db
            .prepare("PRAGMA old.table_info(embeddings)")
            .all()
            .map((c) => c.name as string);
          if (!["kind", "ref", "model", "hash", "vec"].every((c) => cols.includes(c))) continue;
          const r = this.db.prepare("INSERT OR IGNORE INTO embeddings SELECT kind, ref, model, hash, vec FROM old.embeddings").run();
          if (r.changes) return;
        } finally {
          this.db.exec("DETACH DATABASE old");
        }
      } catch {
        // Locked or unreadable: the embeddings are recomputed instead.
      }
    }
  }

  close(): void {
    this.db.close();
  }

  private tx(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  reindex(data: {
    nodes: KnowledgeNode[];
    items: { item: Item; replies: Reply[]; flags: ItemFlags; files?: FileSummary }[];
    activity: Activity[];
    drafts?: Draft[];
  }): void {
    this.tx(() => {
      this.db.exec("DELETE FROM nodes; DELETE FROM items; DELETE FROM activity; DELETE FROM docs_fts; DELETE FROM doc_text; DELETE FROM code_links;");
      for (const n of data.nodes) this.insertNode(n);
      for (const i of data.items) this.insertItem(i.item, i.replies, i.flags, i.files);
      for (const a of data.activity) this.insertActivity(a);
      for (const d of data.drafts ?? []) this.insertDraft(d);
    });
  }

  // What the index holds, as records on disk would name them: opening compares these with the files to
  // find what was deleted while Cortex was closed.
  indexedRecords(): { items: string[]; nodes: string[]; drafts: string[]; activityFiles: string[] } {
    const col = (sql: string) =>
      this.db
        .prepare(sql)
        .all()
        .map((r) => Object.values(r)[0] as string);
    return {
      items: col("SELECT id FROM items"),
      nodes: col("SELECT path FROM nodes"),
      drafts: col("SELECT ref FROM doc_text WHERE kind = 'draft'"),
      // ActivityStore writes each entry to activity/<first 10 chars of at>/<actor>.jsonl.
      activityFiles: col("SELECT DISTINCT substr(at, 1, 10) || '/' || actor || '.jsonl' FROM activity"),
    };
  }

  fileStamps(): Map<string, string> {
    const rows = this.db.prepare("SELECT path, stamp FROM file_stamps").all() as { path: string; stamp: string }[];
    return new Map(rows.map((r) => [r.path, r.stamp]));
  }

  setFileStamps(stamps: Map<string, string>): void {
    this.tx(() => {
      this.db.exec("DELETE FROM file_stamps");
      const stmt = this.db.prepare("INSERT INTO file_stamps VALUES (?, ?)");
      for (const [path, stamp] of stamps) stmt.run(path, stamp);
    });
  }

  // ---- drafts (search only) -------------------------------------------------

  upsertDraft(d: Draft): void {
    if (d.kind !== "node") return;
    this.tx(() => {
      this.deleteDoc("draft", d.id);
      this.insertDraft(d);
    });
  }

  removeDraft(id: string): void {
    this.deleteDoc("draft", id);
  }

  private insertDraft(d: Draft): void {
    if (d.kind !== "node") return;
    const n = d.data;
    this.insertDoc("draft", d.id, d.target, "draft", "", `${n.title} ${d.target.replace(/[/-]/g, " ")}`, n.summary, n.body, (n.tags ?? []).join(" "));
  }

  // ---- nodes --------------------------------------------------------------

  upsertNode(node: KnowledgeNode): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM nodes WHERE path = ?").run(node.path);
      this.db.prepare("DELETE FROM code_links WHERE kind = 'node' AND ref = ?").run(node.path);
      this.deleteDoc("node", node.path);
      this.insertNode(node);
    });
  }

  private insertNode(n: KnowledgeNode): void {
    // An archived node's code links are dropped: it must not turn stale or show up in code context.
    if (!n.archived) this.insertCodeLinks("node", n.path, n.links?.code);
    const tags = n.tags ?? [];
    this.db
      .prepare("INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(n.path, parentPath(n.path), n.title, n.summary, n.status, JSON.stringify(tags), n.updated_at ?? null, n.updated_by ?? null, n.archived ? 1 : 0);
    // Path segments are indexed with the title so "auth" finds "backend/auth/*".
    this.insertDoc("node", n.path, n.path, n.status, "", `${n.title} ${n.path.replace(/[/-]/g, " ")}`, n.summary, n.body, tags.join(" "));
  }

  deleteNode(path: string): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM nodes WHERE path = ?").run(path);
      this.db.prepare("DELETE FROM code_links WHERE kind = 'node' AND ref = ?").run(path);
      this.deleteDoc("node", path);
    });
  }

  getNode(path: string): IndexedNode | null {
    const row = this.db.prepare("SELECT * FROM nodes WHERE path = ?").get(path);
    return row ? toNode(row) : null;
  }

  children(path: string): IndexedNode[] {
    return this.db.prepare("SELECT * FROM nodes WHERE parent = ? AND archived = 0 ORDER BY path").all(path).map(toNode);
  }

  childCount(path: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE parent = ? AND archived = 0").get(path) as { c: number }).c;
  }

  // Branches whose path or title contains the text (case-insensitive), for a picker that asks the server
  // instead of downloading the whole tree. Archived ones stay out.
  findNodes(text: string, limit: number): { path: string; title: string }[] {
    const like = `%${text.replace(/[!%_]/g, (c) => "!" + c)}%`;
    return this.db
      .prepare(
        "SELECT path, title FROM nodes WHERE archived = 0 AND path != '' AND (path LIKE ? ESCAPE '!' OR title LIKE ? ESCAPE '!') ORDER BY length(path), path LIMIT ?",
      )
      .all(like, like, limit) as { path: string; title: string }[];
  }

  // Path and summary of every node (archived ones included), for reports.
  nodeSummaries(): { path: string; summary: string }[] {
    return this.db.prepare("SELECT path, summary FROM nodes").all() as { path: string; summary: string }[];
  }

  archivedNodes(): IndexedNode[] {
    return this.db.prepare("SELECT * FROM nodes WHERE archived = 1 ORDER BY path").all().map(toNode);
  }

  // Open items filed under this node or any node below it.
  openItemsUnder(path: string): number {
    const sql =
      path === ""
        ? "SELECT COUNT(*) AS c FROM items WHERE open_work = 1"
        : "SELECT COUNT(*) AS c FROM items WHERE open_work = 1 AND (category_path = ? OR category_path LIKE ?)";
    const args = path === "" ? [] : [path, `${path}/%`];
    return (this.db.prepare(sql).get(...args) as { c: number }).c;
  }

  // ---- items --------------------------------------------------------------

  upsertItem(item: Item, replies: Reply[], flags: ItemFlags, files: FileSummary = NO_FILES): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM items WHERE id = ?").run(item.id);
      this.db.prepare("DELETE FROM code_links WHERE kind = 'item' AND ref = ?").run(item.id);
      this.deleteDoc("item", item.id);
      this.insertItem(item, replies, flags, files);
    });
  }

  private insertItem(i: Item, replies: Reply[], flags: ItemFlags, files: FileSummary = NO_FILES): void {
    if (!i.archived) this.insertCodeLinks("item", i.id, i.links?.code);
    const last = replies[replies.length - 1];
    // The first reply from someone other than the author: how reports measure "time to an answer".
    const answer = replies.find((r) => r.author !== i.author);
    const resolution = [...replies].reverse().find((r) => r.fields?.resolution)?.fields?.resolution;
    const checklist = countChecklist(i.body);
    this.db.prepare("INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      i.id,
      i.type,
      i.title,
      i.status,
      flags.terminal ? 1 : 0,
      flags.open ? 1 : 0,
      i.category_path ?? null,
      i.author,
      i.assignee ?? null,
      i.claimed_by ?? null,
      i.claimed_at ?? null,
      i.fields?.blocking === true ? 1 : 0,
      i.created_at,
      i.updated_at,
      replies.length,
      last?.author ?? null,
      files.count,
      files.cover,
      // What a board card shows at a glance: the priority (tasks) or severity (issues), a due date.
      typeof i.fields?.priority === "string" ? i.fields.priority : typeof i.fields?.severity === "string" ? i.fields.severity : null,
      typeof i.fields?.due === "string" ? i.fields.due : null,
      i.body?.trim() ? 1 : 0,
      i.archived ? 1 : 0,
      i.fields?.severity === undefined ? null : String(i.fields.severity),
      answer?.created_at ?? null,
      answer?.author ?? null,
      resolution === undefined ? null : String(resolution),
      checklist.done,
      checklist.total,
      typeof i.fields?.milestone === "string" && i.fields.milestone.trim() ? i.fields.milestone.trim() : null,
    );
    const fieldText = Object.values(i.fields ?? {})
      .filter((v) => typeof v === "string")
      .join(" ");
    // A discussion's blind round keeps its views out of search: a participant could otherwise read them before posting.
    const replyText = isSealed(i) ? "" : replies.map((r) => r.body).join(" ");
    this.insertDoc(
      "item",
      i.id,
      i.category_path ?? "",
      i.status,
      i.type,
      i.title,
      i.body.slice(0, 300),
      `${i.body} ${fieldText} ${replyText}`,
      (i.tags ?? []).join(" "),
    );
  }

  deleteItem(id: string): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM code_links WHERE kind = 'item' AND ref = ?").run(id);
      this.deleteDoc("item", id);
    });
  }

  // Whether a status counts as finished comes from the rules, not from the item file, so a rules
  // edit changes it without any file changing. Recomputing the flag beats re-reading every item.
  retermItems(flagsOf: (type: string, status: string) => ItemFlags): number {
    const pairs = this.db.prepare("SELECT DISTINCT type, status FROM items").all() as { type: string; status: string }[];
    let changed = 0;
    this.tx(() => {
      const stmt = this.db.prepare("UPDATE items SET terminal = ?, open_work = ? WHERE type = ? AND status = ? AND (terminal != ? OR open_work != ?)");
      for (const p of pairs) {
        const f = flagsOf(p.type, p.status);
        const [t, o] = [f.terminal ? 1 : 0, f.open ? 1 : 0];
        changed += stmt.run(t, o, p.type, p.status, t, o).changes as number;
      }
    });
    return changed;
  }

  // Everything a report needs about every item (archived ones included), without reading a file.
  reportItems(): ReportItem[] {
    return this.db
      .prepare(
        "SELECT id, type, title, status, open_work, author, assignee, blocking, created_at, severity, answered_at, answered_by, resolution, updated_at, archived, due, milestone, checklist_done, checklist_total FROM items",
      )
      .all()
      .map((r) => ({
        id: r.id as string,
        type: r.type as string,
        title: r.title as string,
        status: r.status as string,
        open: r.open_work === 1,
        author: r.author as string,
        assignee: (r.assignee as string | null) ?? null,
        blocking: r.blocking === 1,
        created_at: r.created_at as string,
        severity: (r.severity as string | null) ?? null,
        answered_at: (r.answered_at as string | null) ?? null,
        answered_by: (r.answered_by as string | null) ?? null,
        resolution: (r.resolution as string | null) ?? null,
        updated_at: (r.updated_at as string | null) ?? (r.created_at as string),
        archived: r.archived === 1,
        due: (r.due as string | null) ?? null,
        milestone: (r.milestone as string | null) ?? null,
        checklist: { done: (r.checklist_done as number | null) ?? 0, total: (r.checklist_total as number | null) ?? 0 },
      }));
  }

  getItem(id: string): IndexedItem | null {
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id);
    return row ? toItem(row) : null;
  }

  // Ids ending with a short id (the board shows the last characters). A scan, but over one short column.
  itemIdsEndingWith(suffix: string, limit = 10): string[] {
    return this.db
      .prepare("SELECT id FROM items WHERE substr(id, ?) = ? ORDER BY id LIMIT ?")
      .all(-suffix.length, suffix, limit)
      .map((r) => String((r as { id: unknown }).id));
  }

  queryItems(q: ItemQuery): { items: IndexedItem[]; total: number } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.type) (where.push("type = ?"), args.push(q.type));
    if (q.status) (where.push("status = ?"), args.push(q.status));
    if (q.author) (where.push("author = ?"), args.push(q.author));
    if (q.open !== undefined) (where.push("open_work = ?"), args.push(q.open ? 1 : 0));
    if (q.assignee?.length) (where.push(`assignee IN (${q.assignee.map(() => "?").join(",")})`), args.push(...q.assignee));
    if (q.under) (where.push("(category_path = ? OR category_path LIKE ?)"), args.push(q.under, `${q.under}/%`));
    if (q.visible) (where.push(`(${q.visible.sql})`), args.push(...q.visible.args));
    if (q.since) (where.push("updated_at >= ?"), args.push(q.since));
    if (q.until) (where.push("updated_at < ?"), args.push(q.until));
    if (q.milestone) (where.push("milestone = ?"), args.push(q.milestone));
    if (q.archived !== "include") where.push(q.archived === "only" ? "archived = 1" : "archived = 0");
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM items ${w}`).get(...args) as { c: number }).c;
    const items = this.db
      .prepare(`SELECT * FROM items ${w} ORDER BY blocking DESC, updated_at DESC LIMIT ? OFFSET ?`)
      .all(...args, q.limit, q.offset)
      .map(toItem);
    return { items, total };
  }

  // ---- activity -----------------------------------------------------------

  // Entries someone wrote (what + why) after an instant: how much happened since the project status.
  countLoggedSince(at: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM activity WHERE system = 0 AND at > ?").get(at) as { c: number }).c;
  }

  addActivity(a: Activity): void {
    this.tx(() => this.insertActivity(a));
  }

  // The log is append-only, so a day's file is re-read whole whenever it grows. Entries already
  // indexed are skipped rather than re-inserted: re-inserting thousands of old lines is wasted work.
  hasActivity(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM activity WHERE id = ?").get(id) !== undefined;
  }

  private insertActivity(a: Activity): void {
    this.db
      .prepare("INSERT OR REPLACE INTO activity VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(a.id, a.at, a.actor, a.action, a.summary, JSON.stringify(a.refs ?? []), a.system ? 1 : 0, JSON.stringify(a));
    // System entries repeat what items/nodes already say; keep them out of search to avoid noise.
    if (!a.system) {
      this.insertDoc("activity", a.id, "", "", a.action, a.summary, a.why ?? "", `${(a.files ?? []).join(" ")} ${(a.refs ?? []).join(" ")}`, a.actor);
    }
  }

  // `before`: an entry id; only older entries come back (the next page of a feed, newest first).
  queryActivity(q: {
    since?: string;
    until?: string;
    before?: string;
    actor?: string;
    ref?: string;
    includeSystem: boolean;
    chat?: boolean; // only what a person said in the AI chat (entries carrying via), audit entries included
    limit: number;
  }): Activity[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.since) (where.push("at >= ?"), args.push(q.since));
    if (q.until) (where.push("at < ?"), args.push(q.until));
    if (q.before) (where.push("id < ?"), args.push(q.before));
    if (q.actor) (where.push("actor = ?"), args.push(q.actor));
    if (q.chat) where.push("json_extract(json, '$.via') IS NOT NULL");
    else if (!q.includeSystem) where.push("system = 0");
    if (q.ref) (where.push("EXISTS (SELECT 1 FROM json_each(activity.refs) WHERE value = ?)"), args.push(q.ref));
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT json FROM activity ${w} ORDER BY id DESC LIMIT ?`)
      .all(...args, q.limit)
      .map((r) => JSON.parse(r.json as string) as Activity);
  }

  // Every entry (audit entries included) in [since, until), oldest first: the raw material for reports.
  activityBetween(since: string, until: string): Activity[] {
    return this.db
      .prepare("SELECT json FROM activity WHERE at >= ? AND at < ? ORDER BY id")
      .all(since, until)
      .map((r) => JSON.parse(r.json as string) as Activity);
  }

  getActivity(id: string): Activity | null {
    const row = this.db.prepare("SELECT json FROM activity WHERE id = ?").get(id);
    return row ? (JSON.parse(row.json as string) as Activity) : null;
  }

  // ---- search -------------------------------------------------------------

  private insertDoc(kind: DocKind, ref: string, scope: string, status: string, type: string, title: string, summary: string, body: string, tags: string) {
    this.deleteDoc(kind, ref); // never two search rows for one document
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO docs_fts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(kind, ref, scope, status, type, fold(title), fold(summary), fold(body), fold(tags));
    // Title and summary first: the model only reads the first few hundred tokens.
    const text = [title, summary, body]
      .map((x) => x.trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, 2000);
    this.db.prepare("INSERT INTO doc_text VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(kind, ref, scope, status, type, text, shortHash(text), lastInsertRowid);
  }

  // By rowid: matching docs_fts on kind and ref scanned the whole search table, once per write.
  private deleteDoc(kind: DocKind, ref: string) {
    const row = this.db.prepare("DELETE FROM doc_text WHERE kind = ? AND ref = ? RETURNING fts_rowid").get(kind, ref) as { fts_rowid: number } | undefined;
    if (row) this.db.prepare("DELETE FROM docs_fts WHERE rowid = ?").run(row.fts_rowid);
  }

  // ---- code links ---------------------------------------------------------

  private insertCodeLinks(kind: DocKind, ref: string, links: { file: string; lines?: string; symbol?: string }[] | undefined) {
    const stmt = this.db.prepare("INSERT INTO code_links VALUES (?, ?, ?, ?, ?)");
    for (const l of links ?? []) stmt.run(kind, ref, normalizeFile(l.file), l.lines ?? null, l.symbol ?? null);
  }

  nodeCodeLinks(): { path: string; file: string; lines: string | null; symbol: string | null }[] {
    return this.db.prepare("SELECT ref AS path, file, lines, symbol FROM code_links WHERE kind = 'node'").all() as {
      path: string;
      file: string;
      lines: string | null;
      symbol: string | null;
    }[];
  }

  // Links that cover any of the files: exact match, a linked directory containing the file, or a file inside an asked-about directory.
  linksForFiles(files: string[]): { kind: DocKind; ref: string; file: string; lines: string | null }[] {
    const out = new Map<string, { kind: DocKind; ref: string; file: string; lines: string | null }>();
    const stmt = this.db.prepare(
      // substr instead of LIKE: "_" and "%" are common in file names and must not act as wildcards.
      "SELECT kind, ref, file, lines FROM code_links WHERE file = :f " +
        "OR substr(:f, 1, length(file) + 1) = file || '/' OR substr(file, 1, length(:f) + 1) = :f || '/'",
    );
    for (const f of files.map(normalizeFile)) {
      for (const r of stmt.all({ f }) as { kind: DocKind; ref: string; file: string; lines: string | null }[]) out.set(`${r.kind}:${r.ref}:${r.file}`, r);
    }
    return [...out.values()];
  }

  // ---- semantic -----------------------------------------------------------

  docTexts(): DocText[] {
    return this.db.prepare("SELECT kind, ref, scope, status, type, text, hash FROM doc_text").all() as unknown as DocText[];
  }

  embeddings(): { kind: DocKind; ref: string; model: string; hash: string; vec: Float32Array }[] {
    return this.db
      .prepare("SELECT * FROM embeddings")
      .all()
      .map((r) => {
        const b = r.vec as Uint8Array;
        return {
          kind: r.kind as DocKind,
          ref: r.ref as string,
          model: r.model as string,
          hash: r.hash as string,
          vec: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)),
        };
      });
  }

  putEmbeddings(rows: { kind: DocKind; ref: string; model: string; hash: string; vec: Float32Array }[]): void {
    this.tx(() => {
      const stmt = this.db.prepare("INSERT OR REPLACE INTO embeddings VALUES (?, ?, ?, ?, ?)");
      for (const r of rows) stmt.run(r.kind, r.ref, r.model, r.hash, new Uint8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength));
    });
  }

  deleteEmbeddings(keys: { kind: DocKind; ref: string }[]): void {
    if (!keys.length) return;
    this.tx(() => {
      const stmt = this.db.prepare("DELETE FROM embeddings WHERE kind = ? AND ref = ?");
      for (const k of keys) stmt.run(k.kind, k.ref);
    });
  }

  search(query: string, opts: SearchOptions): SearchRow[] {
    const terms = fold(query).match(/[\p{L}\p{N}]+/gu) ?? [];
    if (terms.length === 0) return [];
    const exact = (list: string[]) => list.map((t) => `"${t}"*`);
    // Each term or its stem: an inflected word finds its other forms ("ertelemek" finds "erteleme" and
    // "ertelenebilir"), and the full word still ranks higher because it matches both.
    const stemmed = (list: string[]) =>
      list.map((t) => {
        const s = stem(t);
        return s === t ? `"${t}"*` : `("${t}"* OR "${s}"*)`;
      });
    // Prefer documents matching every term as written, then every term by its stem.
    // Stems only as a fallback: used from the start they widen matches that were already right.
    const all = this.runSearch(exact(terms).join(" AND "), opts);
    if (all.length > 0) return all;
    const allStemmed = this.runSearch(stemmed(terms).join(" AND "), opts);
    if (allStemmed.length >= opts.limit || terms.length === 1) return allStemmed;
    // Then any term, but not filler words: "mı", "ve", "the" would match half the project.
    // Whole words here: with stems, "any term" matches too much and pushes the right record down.
    // A few stem matches must not hide these either, so they fill the rest of the page.
    const meaningful = terms.filter((t) => !STOPWORDS.has(t));
    if (meaningful.length === 0) return allStemmed;
    const seen = new Set(allStemmed.map((r) => `${r.kind} ${r.ref}`));
    const any = this.runSearch(exact(meaningful).join(" OR "), opts).filter((r) => !seen.has(`${r.kind} ${r.ref}`));
    return [...allStemmed, ...any].slice(0, opts.limit);
  }

  private runSearch(match: string, opts: SearchOptions): SearchRow[] {
    const where: string[] = ["docs_fts MATCH ?"];
    const args: (string | number)[] = [match];
    if (opts.kinds?.length) (where.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`), args.push(...opts.kinds));
    if (opts.under) (where.push("(scope = ? OR scope LIKE ?)"), args.push(opts.under, `${opts.under}/%`));
    if (opts.status) (where.push("status = ?"), args.push(opts.status));
    if (opts.type) (where.push("type = ?"), args.push(opts.type));
    args.push(opts.limit);
    const sql = `
      SELECT kind, ref, bm25(docs_fts, 0, 0, 0, 0, 0, 5.0, 3.0, 1.0, 4.0) AS rank
      FROM docs_fts WHERE ${where.join(" AND ")}
      ORDER BY rank LIMIT ?`;
    return this.db
      .prepare(sql)
      .all(...args)
      .map((r) => ({ kind: r.kind as DocKind, ref: r.ref as string, score: Math.round(-(r.rank as number) * 1000) / 1000 }));
  }
}

// A crude, language-free stem for prefix search: Turkish piles suffixes onto a root ("erteleme-k",
// "sayfa-lar-ı"), so dropping up to three trailing letters, never below five, reaches most roots.
// Short words stay whole: four-letter prefixes match too much.
const MIN_STEM = 5;
export function stem(term: string): string {
  return term.length <= MIN_STEM ? term : term.slice(0, Math.max(MIN_STEM, term.length - 3));
}

function toNode(r: Record<string, unknown>): IndexedNode {
  return {
    path: r.path as string,
    parent: (r.parent as string | null) ?? null,
    title: r.title as string,
    summary: r.summary as string,
    status: r.status as NodeStatus,
    tags: JSON.parse((r.tags as string) || "[]"),
    updated_at: r.updated_at as string,
    updated_by: r.updated_by as string,
    archived: r.archived === 1,
  };
}

function toItem(r: Record<string, unknown>): IndexedItem {
  return {
    id: r.id as string,
    type: r.type as string,
    title: r.title as string,
    status: r.status as string,
    terminal: r.terminal === 1,
    open: r.open_work === 1,
    category_path: (r.category_path as string | null) ?? null,
    author: r.author as string,
    assignee: (r.assignee as string | null) ?? null,
    claimed_by: (r.claimed_by as string | null) ?? null,
    claimed_at: (r.claimed_at as string | null) ?? null,
    blocking: r.blocking === 1,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    reply_count: r.reply_count as number,
    last_reply_by: (r.last_reply_by as string | null) ?? null,
    attachment_count: (r.attachment_count as number | null) ?? 0,
    cover: (r.cover as string | null) ?? null,
    level: (r.level as string | null) ?? null,
    due: (r.due as string | null) ?? null,
    has_body: r.has_body === 1,
    archived: r.archived === 1,
    checklist: { done: (r.checklist_done as number | null) ?? 0, total: (r.checklist_total as number | null) ?? 0 },
  };
}

export function normalizeFile(f: string): string {
  return f.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
