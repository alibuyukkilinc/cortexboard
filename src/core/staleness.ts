import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CORTEX_DIR } from "./project.js";
import type { Cortex } from "./cortex.js";
import type { CommitInfo, FileChange } from "../git/git.js";
import { CortexError } from "./types.js";
import { symbolBody } from "../git/symbol.js";
import { Git } from "../git/git.js";

// high: the knowledge is probably wrong now (linked lines rewritten, file deleted or moved).
// medium: the file it describes changed somewhere; worth a look.
// low: only formatting changed (whitespace, re-wrapping, what the project's Prettier would rewrite); nothing
// the knowledge could describe.
export type Severity = "high" | "medium" | "low";
const RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };

export interface StaleChange {
  file: string;
  status: FileChange["status"];
  severity: Severity;
  renamed_to?: string;
  symbol?: string;
  lines?: string; // the linked range that was touched
  formatting_only?: boolean;
  commits: number;
  last?: CommitInfo;
}

export interface StaleInfo {
  path: string;
  verified_at_commit: string;
  reason: "changed" | "unknown_commit";
  severity: Severity;
  changes: StaleChange[];
  // Set while someone has put this off. A new commit to any of the changed files lifts it on its own.
  snoozed?: { at: string; by: string };
}

export interface CodeLink {
  file: string;
  lines?: string | null;
  symbol?: string | null;
}

interface Snooze {
  at: string;
  by: string;
  fingerprint: string;
}

const THROTTLE_MS = 3000;

// What counts: brief, inbox and menu counters show only this; low and snoozed are informational.
const FILE_LIMIT = 60_000;
const TOTAL_LIMIT = 250_000;

export const actionable = (s: StaleInfo) => !s.snoozed && s.severity !== "low";

// "Is this knowledge still true?" Derived from git, never written into node files (that would churn history).
// A node is stale when code it links to changed after the commit it was verified at; with a line range,
// only changes touching those lines count.
export class StalenessService {
  readonly git: Git;
  private head: string | null | undefined;
  private checkedAt = 0;
  private dirty = true;
  private stale = new Map<string, StaleInfo>();
  private snoozes: SnoozeStore;
  private verdictFile: VerdictFile;
  // Git answers for "what changed in file F between commit C and HEAD" only change when HEAD does.
  // Every node/draft write marks the list dirty and recomputes it; with this, the recompute (and
  // /brief, /stale, approvals in between) re-asks git nothing it already asked at this HEAD.
  private caches = new Caches();
  private cachesHead: string | null = null;

  constructor(private c: Cortex) {
    this.git = new Git(c.project.root);
    this.snoozes = new SnoozeStore(c.project.dir);
    this.verdictFile = new VerdictFile(c.project.dir);
    this.git.verdicts = this.verdictFile.load();
    c.events.on("change", (e: { type: string; entry?: { action: string } }) => {
      if (e.type === "reindex" || e.entry?.action.startsWith("node.") || e.entry?.action.startsWith("draft.")) this.dirty = true;
    });
  }

  enabled(): boolean {
    return this.git.available();
  }

  currentHead(): string | null {
    return this.git.head();
  }

  // What the code a stale node describes went through since it was verified: one patch per file, cut to a
  // size a page can show (FILE_LIMIT each, TOTAL_LIMIT in all). The file list says which were cut.
  diff(path: string): { from: string; head: string | null; files: { file: string; patch: string; truncated: boolean }[]; truncated: boolean } {
    const info = this.get(path);
    if (!info) throw new CortexError("not_stale", `"${path}" is not stale: nothing changed since it was verified.`, 400);
    if (info.reason === "unknown_commit") {
      throw new CortexError("unknown_commit", `This clone does not have commit ${info.verified_at_commit}, so there is no diff to show.`, 409);
    }
    const files = [...new Set(info.changes.flatMap((c) => [c.file, ...(c.renamed_to ? [c.renamed_to] : [])]))];
    const raw = this.git.diff(info.verified_at_commit, files);
    if (raw === null) throw new CortexError("git_failed", "git could not produce the diff.", 500);
    const out: { file: string; patch: string; truncated: boolean }[] = [];
    let total = 0;
    let cut = false;
    for (const chunk of raw.split(/^(?=diff --git )/m).filter((c) => c.trim())) {
      const file = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk)?.[2] ?? "?";
      if (total >= TOTAL_LIMIT) {
        cut = true;
        out.push({ file, patch: "", truncated: true });
        continue;
      }
      const room = Math.min(FILE_LIMIT, TOTAL_LIMIT - total);
      const long = chunk.length > room;
      const patch = long ? chunk.slice(0, chunk.lastIndexOf("\n", room) + 1) : chunk;
      total += patch.length;
      cut ||= long;
      out.push({ file, patch, truncated: long });
    }
    return { from: info.verified_at_commit, head: this.currentHead(), files: out, truncated: cut };
  }

  // How much of it anyone is shown (config staleness). Everything that reports staleness goes through get()
  // and list(), so this one filter quiets the brief, board, reports, search and the hint after logged work.
  // Knowledge kept outside the code (a hub's folder) defaults to off: it serves a team, where file-level
  // alerts on busy files were almost all noise (decision 01M3MXCREN98XN2E1VABABQTSR).
  level(): "all" | "high" | "off" {
    const v = this.c.project.config.staleness;
    if (v === "all" || v === "high" || v === "off") return v;
    return resolve(this.c.project.dir) === resolve(this.c.project.root, CORTEX_DIR) ? "high" : "off";
  }

  private shown(s: StaleInfo): boolean {
    const level = this.level();
    return level === "all" || (level === "high" && s.severity === "high");
  }

  get(path: string): StaleInfo | undefined {
    this.refresh();
    const s = this.stale.get(path);
    return s && this.shown(s) ? this.withSnooze(s) : undefined;
  }

  list(): StaleInfo[] {
    this.refresh();
    return [...this.stale.values()]
      .filter((s) => this.shown(s))
      .map((s) => this.withSnooze(s))
      .sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.path.localeCompare(b.path));
  }

  actionable(): StaleInfo[] {
    return this.list().filter(actionable);
  }

  // Put a stale node off until its code changes again. Kept under .index/ (never committed): it is a
  // personal to-do state, and writing it into the tree would churn git history for nothing.
  snooze(path: string, by: string): StaleInfo {
    const s = this.get(path);
    if (!s) throw new Error(`"${path}" is not stale.`);
    this.snoozes.set(path, { at: new Date().toISOString(), by, fingerprint: fingerprint(s) });
    this.c.events.emit("change", { type: "stale", path }); // open boards update their counters
    return this.withSnooze(s);
  }

  unsnooze(path: string): void {
    this.snoozes.delete(path);
    this.c.events.emit("change", { type: "stale", path });
  }

  // Changes to `links` since `commit`, with severity. Empty when nothing the links cover moved.
  changesSince(commit: string, links: CodeLink[]): StaleChange[] | null {
    if (!this.git.available() || !this.git.commitExists(commit)) return null;
    const head = this.git.head();
    if (!head) return null;
    const caches = this.cachesFor(head);
    const files = [...new Set(links.map((l) => l.file.normalize("NFC")))];
    const changed = caches.get(caches.changed, `${commit}\0${files.join("\0")}`, () => this.git.changedFiles(commit, files));
    if (changed === null) return null;
    this.prefetchFormatting([{ commit, changed }], caches);
    return this.evaluate(commit, changed, links, caches);
  }

  // `force` recomputes even at the same HEAD. `checkHead` skips the throttle but recomputes only if HEAD
  // moved: for callers that just saw a commit happen (an AI logging its change right after committing).
  refresh(force = false, checkHead = false): void {
    if (!this.git.available()) return;
    const now = Date.now();
    if (!force && !checkHead && !this.dirty && now - this.checkedAt < THROTTLE_MS) return;
    this.checkedAt = now;
    const head = this.git.head();
    if (!force && !this.dirty && head === this.head) return;
    this.head = head;
    this.dirty = false;
    this.stale = head ? this.compute(head) : new Map();
  }

  private withSnooze(s: StaleInfo): StaleInfo {
    const z = this.snoozes.get(s.path);
    if (!z) return s;
    // Anything new on these files (another commit, a different status) wakes it up again.
    if (z.fingerprint !== fingerprint(s)) {
      this.snoozes.delete(s.path);
      return s;
    }
    return { ...s, snoozed: { at: z.at, by: z.by } };
  }

  private cachesFor(head: string): Caches {
    if (head !== this.cachesHead) {
      this.caches = new Caches();
      this.cachesHead = head;
    }
    return this.caches;
  }

  private compute(head: string): Map<string, StaleInfo> {
    const caches = this.cachesFor(head);
    const byPath = new Map<string, CodeLink[]>();
    for (const l of this.c.index.nodeCodeLinks()) {
      const list = byPath.get(l.path) ?? [];
      list.push({ file: l.file.normalize("NFC"), lines: l.lines, symbol: l.symbol });
      byPath.set(l.path, list);
    }

    // Group nodes by the commit they were verified at: one `git diff` per distinct commit.
    const byCommit = new Map<string, string[]>();
    const out = new Map<string, StaleInfo>();
    for (const path of byPath.keys()) {
      const verified = this.c.tree.read(path)?.verified_at_commit;
      if (!verified || head.startsWith(verified)) continue;
      if (!caches.get(caches.exists, verified, () => this.git.commitExists(verified))) {
        // History was rewritten under it: nothing to compare against, so someone has to look.
        out.set(path, { path, verified_at_commit: verified, reason: "unknown_commit", severity: "medium", changes: [] });
        continue;
      }
      byCommit.set(verified, [...(byCommit.get(verified) ?? []), path]);
    }

    const groups = [...byCommit].map(([commit, paths]) => {
      const files = [...new Set(paths.flatMap((p) => byPath.get(p)!.map((l) => l.file)))];
      const changed = caches.get(caches.changed, `${commit}\0${files.join("\0")}`, () => this.git.changedFiles(commit, files)) ?? [];
      return { commit, paths, changed };
    });
    this.prefetchFormatting(groups, caches);
    for (const { commit, paths, changed } of groups) {
      if (!changed.length) continue;
      for (const path of paths) {
        const changes = this.evaluate(commit, changed, byPath.get(path)!, caches);
        if (changes.length) out.set(path, { path, verified_at_commit: commit, reason: "changed", severity: worst(changes), changes });
      }
    }
    return out;
  }

  // "Formatting only?" for every modified file of every commit group in one batch: at most one
  // Prettier process per recompute. Verdicts are remembered by file contents in .index/, see Git.
  private prefetchFormatting(groups: { commit: string; changed: FileChange[] }[], caches: Caches): void {
    const pairs = groups.flatMap(({ commit, changed }) =>
      changed.filter((c) => c.status === "modified" && !caches.cosmetic.has(`${commit}\0${c.file}`)).map((c) => ({ from: commit, file: c.file })),
    );
    if (!pairs.length) return;
    const known = this.git.verdicts.size;
    for (const [key, cosmetic] of this.git.formattingOnlyPairs(pairs)) caches.cosmetic.set(key, cosmetic);
    if (this.git.verdicts.size !== known) this.verdictFile.save(this.git.verdicts);
  }

  private evaluate(commit: string, changed: FileChange[], links: CodeLink[], caches: Caches): StaleChange[] {
    const changes: StaleChange[] = [];
    for (const raw of links) {
      const link = { ...raw, file: raw.file.normalize("NFC") };
      for (const ch of changed.filter((c) => c.file === link.file || c.file.startsWith(`${link.file}/`))) {
        let scopedSymbol = false;
        if (link.symbol && ch.status === "modified" && ch.file === link.file) {
          const before = caches.get(caches.contents, `${commit}\0${ch.file}`, () => this.git.contentAt(commit, ch.file));
          const after = caches.get(caches.contents, `HEAD\0${ch.file}`, () => this.git.contentAt("HEAD", ch.file));
          const a = before === null ? null : symbolBody(before, link.symbol);
          const b = after === null ? null : symbolBody(after, link.symbol);
          if (a !== null && b !== null) {
            if (a === b) continue;
            scopedSymbol = true;
          }
        }
        const range = !link.symbol && link.lines && ch.status === "modified" && ch.file === link.file ? parseLines(link.lines) : null;
        if (range) {
          const touched = caches.get(caches.ranges, `${commit}\0${ch.file}`, () => this.git.touchedRanges(commit, ch.file));
          if (touched && !touched.some(([a, b]) => a <= range[1] && b >= range[0])) continue; // changed elsewhere in the file
        }
        const cosmetic = ch.status === "modified" && caches.get(caches.cosmetic, `${commit}\0${ch.file}`, () => this.git.formattingOnly(commit, ch.file));
        const severity: Severity = ch.status !== "modified" ? "high" : cosmetic ? "low" : range || scopedSymbol ? "high" : "medium";
        const list = caches.get(caches.commits, `${commit}\0${ch.file}`, () => this.git.commitsSince(commit, ch.file));
        changes.push({
          file: ch.file,
          status: ch.status,
          severity,
          ...(ch.renamed_to ? { renamed_to: ch.renamed_to } : {}),
          ...(range ? { lines: link.lines! } : {}),
          ...(link.symbol ? { symbol: link.symbol } : {}),
          ...(cosmetic ? { formatting_only: true } : {}),
          commits: list.length,
          ...(list[0] ? { last: list[0] } : {}),
        });
      }
    }
    return changes;
  }
}

// Keyed by "<commit>\0<file>" (or the file list); valid for one HEAD, see StalenessService.cachesFor.
class Caches {
  changed = new Map<string, FileChange[] | null>();
  exists = new Map<string, boolean>();
  contents = new Map<string, string | null>();
  ranges = new Map<string, [number, number][] | null>();
  commits = new Map<string, CommitInfo[]>();
  cosmetic = new Map<string, boolean>();
  get<T>(m: Map<string, T>, key: string, load: () => T): T {
    if (!m.has(key)) m.set(key, load());
    return m.get(key)!;
  }
}

function worst(changes: StaleChange[]): Severity {
  return changes.reduce<Severity>((w, c) => (RANK[c.severity] > RANK[w] ? c.severity : w), "low");
}

// What a snooze was given for: the changed files, how they changed, and the newest commit on each.
function fingerprint(s: StaleInfo): string {
  return (
    s.changes
      .map((c) => `${c.file}:${c.status}:${c.last?.hash ?? ""}`)
      .sort()
      .join("|") || s.reason
  );
}

// "Formatting only" verdicts by blob pair. Pure facts about two file contents, so they never go stale;
// kept in the rebuildable .index/ so a restart does not re-run Prettier over every stale file.
class VerdictFile {
  private file: string;
  constructor(cortexDir: string) {
    this.file = join(cortexDir, ".index", "formatting.json");
  }
  load(): Map<string, boolean> {
    try {
      return new Map(Object.entries(JSON.parse(readFileSync(this.file, "utf8")) as Record<string, boolean>));
    } catch {
      return new Map();
    }
  }
  save(m: Map<string, boolean>): void {
    // Newest last; past the cap the oldest are forgotten (a forgotten verdict is just asked again).
    const entries = [...m].slice(-20_000);
    try {
      if (!existsSync(dirname(this.file))) mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(entries)), "utf8");
    } catch {
      // read-only checkout: keep them in memory only
    }
  }
}

// Re-read when the file changes on disk, so an MCP process and the board see each other's snoozes.
class SnoozeStore {
  private file: string;
  private data: Record<string, Snooze> = {};
  private mtime = -1;

  constructor(cortexDir: string) {
    this.file = join(cortexDir, ".index", "snoozes.json");
  }

  get(path: string): Snooze | undefined {
    this.load();
    return this.data[path];
  }

  set(path: string, z: Snooze): void {
    this.load();
    this.data[path] = z;
    this.save();
  }

  delete(path: string): void {
    this.load();
    if (!(path in this.data)) return;
    delete this.data[path];
    this.save();
  }

  private load(): void {
    let m = 0;
    try {
      m = statSync(this.file).mtimeMs;
    } catch {
      this.data = {};
      this.mtime = 0;
      return;
    }
    if (m === this.mtime) return;
    try {
      this.data = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Snooze>;
    } catch {
      this.data = {}; // a broken cache file only costs the snoozes
    }
    this.mtime = m;
  }

  private save(): void {
    if (!existsSync(dirname(this.file))) mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), "utf8");
    this.mtime = statSync(this.file).mtimeMs;
  }
}

function parseLines(lines: string): [number, number] | null {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(lines);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return [Math.min(a, b), Math.max(a, b)];
}
