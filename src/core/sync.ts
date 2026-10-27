import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Cortex } from "./cortex.js";

// Keeping the index in step with files that changed outside this process (hand edits, git pull,
// another Cortex). Rebuilding everything was fine when a project was small, but its cost tracks
// total history: a file change cost 1.6s once the activity log reached 20k entries.
//
// Everything here works at the record level, never the file level: a changed file only names a
// record, and the record is then re-read from the store. That way a rename (a/b.md -> a/b/_node.md)
// and a delete need no event ordering — the store simply answers "gone" or "here is the new state".

export type SyncTarget = { k: "node"; path: string } | { k: "item"; id: string } | { k: "draft"; id: string } | { k: "activity"; file: string };

// rescan: this change cannot be resolved record by record, rebuild everything.
// rules: the schemas changed, so which statuses count as finished may have changed.
export type PathMapping = { target: SyncTarget } | { rescan: true } | { rules: true } | null;

export interface SyncStats {
  nodes: number;
  items: number;
  drafts: number;
  activity: number;
  reterm: number;
  errors: { target: string; error: unknown }[];
}

const ULID = /^[0-9A-Z]{26}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const RESCAN = { rescan: true } as const;

// Which record does a path under .cortex belong to? Pure, so it can be tested on its own.
export function mapPath(raw: string): PathMapping {
  // NFC: macOS reports decomposed names (o + combining diaeresis); everything else here is composed.
  const rel = String(raw).normalize("NFC").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!rel || rel.split("/").includes("..")) return null;
  const cut = rel.indexOf("/");
  const root = cut === -1 ? rel : rel.slice(0, cut);
  const rest = cut === -1 ? "" : rel.slice(cut + 1);

  switch (root) {
    case "rules":
      return rest ? { rules: true } : RESCAN;
    case "tree":
      return tree(rest);
    case "items":
      return items(rest);
    case "activity":
      return activity(rest);
    case "drafts":
      return drafts(rest);
    default:
      return null; // .index, .secrets.yaml, cortex.config.yaml, anything we do not index
  }
}

// A directory event (no extension) cannot name one record: a whole branch may have moved.
const isDir = (base: string) => base.lastIndexOf(".") <= 0;

function tree(rest: string): PathMapping {
  if (!rest) return RESCAN;
  const base = rest.slice(rest.lastIndexOf("/") + 1);
  if (base.startsWith(".")) return null; // editor swap files, .DS_Store
  if (isDir(base)) return RESCAN;
  if (!base.endsWith(".md")) return null;
  // Derived literally, the same way TreeStore.all() derives it, so full and incremental agree.
  if (base === "_node.md") return { target: { k: "node", path: rest === "_node.md" ? "" : rest.slice(0, -"/_node.md".length) } };
  return { target: { k: "node", path: rest.slice(0, -3) } };
}

function items(rest: string): PathMapping {
  if (!rest) return RESCAN;
  // Any depth under the item's folder means the same item: item.md, replies/<id>.md, or the folder itself.
  const id = rest.split("/")[0].slice(0, 26);
  return ULID.test(id) ? { target: { k: "item", id } } : null;
}

function activity(rest: string): PathMapping {
  if (!rest) return RESCAN;
  const parts = rest.split("/");
  // A day folder appearing or disappearing takes the whole log with it; only a file names entries.
  if (parts.length !== 2 || !DAY.test(parts[0]) || !parts[1].endsWith(".jsonl")) return RESCAN;
  return { target: { k: "activity", file: rest } };
}

function drafts(rest: string): PathMapping {
  if (!rest) return RESCAN;
  return rest.endsWith(".md") && ULID.test(rest.slice(0, -3)) ? { target: { k: "draft", id: rest.slice(0, -3) } } : null;
}

// Every indexed file under .cortex (path relative to it, as mapPath takes it) with its mtime and size.
// Listing and stat-ing is far cheaper than reading and parsing, so opening a project compares these
// with what the index saw last time and re-reads only the difference.
const INDEXED = ["rules", "tree", "items", "activity", "drafts"];
export function stampFiles(cortexDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const sub of INDEXED) {
    let entries;
    try {
      entries = readdirSync(join(cortexDir, sub), { recursive: true, withFileTypes: true });
    } catch {
      continue; // not created yet
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const full = join(e.parentPath, e.name);
      const st = statSync(full, { throwIfNoEntry: false });
      if (st) out.set(relative(cortexDir, full).replace(/\\/g, "/").normalize("NFC"), `${st.mtimeMs}:${st.size}`);
    }
  }
  return out;
}

// Paths that were added, removed or changed between two stampFiles() results.
export function changedFiles(before: Map<string, string>, now: Map<string, string>): string[] {
  const changed = [...now].filter(([p, s]) => before.get(p) !== s).map(([p]) => p);
  for (const p of before.keys()) if (!now.has(p)) changed.push(p);
  return changed;
}

// Records the index holds that no file on disk names any more, as paths sync() understands. A vanished
// activity file cannot be undone entry by entry, so it asks for a rebuild.
export function missingRecords(
  indexed: { items: string[]; nodes: string[]; drafts: string[]; activityFiles: string[] },
  files: Iterable<string>,
): string[] | "rescan" {
  const items = new Set<string>();
  const nodes = new Set<string>();
  const drafts = new Set<string>();
  const activity = new Set<string>();
  for (const f of files) {
    const m = mapPath(f);
    if (!m || !("target" in m)) continue;
    const t = m.target;
    if (t.k === "item" && f.endsWith("/item.md")) items.add(t.id);
    else if (t.k === "node") nodes.add(t.path);
    else if (t.k === "draft") drafts.add(t.id);
    else if (t.k === "activity") activity.add(t.file);
  }
  if (indexed.activityFiles.some((f) => !activity.has(f))) return "rescan";
  return [
    ...indexed.items.filter((id) => !items.has(id)).map((id) => `items/${id}/item.md`),
    ...indexed.nodes.filter((p) => !nodes.has(p)).map((p) => (p === "" ? "tree/_node.md" : `tree/${p}.md`)),
    ...indexed.drafts.filter((id) => !drafts.has(id)).map((id) => `drafts/${id}.md`),
  ];
}

export class SyncService {
  constructor(private c: Cortex) {}

  // Returns { rescan: true } when the change cannot be applied record by record; the caller rebuilds.
  run(changed: string[]): SyncStats | { rescan: true } {
    const targets = new Map<string, SyncTarget>();
    let rules = false;
    for (const path of changed) {
      const m = mapPath(path);
      if (m === null) continue;
      if ("rescan" in m) return RESCAN;
      if ("rules" in m) {
        rules = true;
        continue;
      }
      targets.set(JSON.stringify(m.target), m.target);
    }

    const stats: SyncStats = { nodes: 0, items: 0, drafts: 0, activity: 0, reterm: 0, errors: [] };
    for (const t of targets.values()) {
      try {
        const applied = this.apply(t);
        if (applied === "rescan") return RESCAN;
        stats[applied.kind] += applied.n;
      } catch (error) {
        // One unreadable file (half written during a checkout) must not stop the rest; the next
        // event on it retries, and until then that single record keeps its previous index entry.
        stats.errors.push({ target: JSON.stringify(t), error });
      }
    }
    if (rules) stats.reterm = this.c.index.retermItems((type, status) => this.c.itemFlags(type, status));
    return stats;
  }

  private apply(t: SyncTarget): { kind: "nodes" | "items" | "drafts" | "activity"; n: number } | "rescan" {
    switch (t.k) {
      case "node": {
        const node = this.c.tree.read(t.path);
        if (node) this.c.index.upsertNode(node);
        else this.c.index.deleteNode(t.path);
        return { kind: "nodes", n: 1 };
      }
      case "item": {
        const item = this.c.itemStore.read(t.id);
        if (!item) {
          this.c.index.deleteItem(t.id);
          return { kind: "items", n: 1 };
        }
        this.c.index.upsertItem(item, this.c.itemStore.replies(t.id), this.c.itemFlags(item.type, item.status), this.c.itemStore.fileSummary(t.id));
        return { kind: "items", n: 1 };
      }
      case "draft": {
        const d = this.c.drafts.get(t.id);
        if (d) this.c.index.upsertDraft(d);
        else this.c.index.removeDraft(t.id);
        return { kind: "drafts", n: 1 };
      }
      case "activity": {
        // The log only ever grows. A file that vanished means someone changed branches, and there is
        // no way to tell which rows to drop from here.
        const entries = this.c.activityStore.readFile(t.file);
        if (entries === null) return "rescan";
        // Only the entries appended since last time: re-inserting the rest would duplicate their
        // search rows, and clearing those first costs a full FTS scan each (db.ts deleteDoc).
        let added = 0;
        for (const a of entries) {
          if (this.c.index.hasActivity(a.id)) continue;
          this.c.index.addActivity(a);
          added++;
        }
        return { kind: "activity", n: added };
      }
    }
  }
}
