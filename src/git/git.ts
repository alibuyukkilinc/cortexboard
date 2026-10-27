import { execFileSync } from "node:child_process";
import { type Pair, prettierVerdicts } from "./formatting.js";

export interface CommitInfo {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface FileChange {
  file: string; // path as linked (relative to the project root)
  status: "modified" | "deleted" | "renamed";
  renamed_to?: string;
}

// Thin wrapper over the git CLI. Every call is scoped to the project root and returns paths relative to it,
// so it works when .cortex lives in a subfolder of a monorepo too. Any git failure degrades to "unknown".
export class Git {
  private ok: boolean | null = null;

  constructor(private cwd: string) {}

  calls = 0; // git processes started; tests use it to prove repeated reads are served from cache

  // core.quotepath=false: otherwise git prints "src/\303\266deme.ts" for src/ödeme.ts, and no linked file with a
  // non-ASCII name ever matches. Output is NFC, so a name typed on macOS (NFD) and on Windows compare equal.
  private run(args: string[]): string | null {
    this.calls++;
    try {
      const out = execFileSync("git", ["-c", "core.quotepath=false", ...args], {
        cwd: this.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      });
      return out.normalize("NFC");
    } catch {
      return null;
    }
  }

  // A positive answer is permanent; a negative one is re-checked now and then, so `git init` after startup is noticed.
  available(): boolean {
    if (this.ok) return true;
    if (this.ok === false && Date.now() - this.checkedAt < 30_000) return false;
    this.checkedAt = Date.now();
    this.ok = this.run(["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
    return this.ok;
  }
  private checkedAt = 0;

  head(): string | null {
    if (!this.available()) return null;
    return this.run(["rev-parse", "HEAD"])?.trim() || null; // null in a repo with no commits yet
  }

  // The fetch URL of "origin", as configured (ssh or https), or null.
  originUrl(): string | null {
    if (!this.available()) return null;
    return this.run(["remote", "get-url", "origin"])?.trim() || null;
  }

  commitExists(hash: string): boolean {
    return /^[0-9a-f]{7,40}$/i.test(hash) && this.run(["cat-file", "-e", `${hash}^{commit}`]) !== null;
  }

  // Which of these paths git does not know about yet. Knowledge can link them, but staleness cannot
  // follow a file that was never committed, so the writer is told.
  untracked(paths: string[]): string[] {
    if (!paths.length || !this.available()) return [];
    const out = this.run(["ls-files", "--error-unmatch", "--", ...paths]);
    if (out === null) {
      // At least one path is unknown; ask one by one to say exactly which.
      return paths.filter((p) => this.run(["ls-files", "--error-unmatch", "--", p]) === null);
    }
    return [];
  }

  // Files among `paths` (files or directories) that differ between `from` and HEAD, in one git call.
  changedFiles(from: string, paths: string[]): FileChange[] | null {
    if (!paths.length) return [];
    const out = this.run(["diff", "--name-status", "-M", "--relative", from, "HEAD", "--", ...paths]);
    if (out === null) return null;
    const changes: FileChange[] = out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [code, a, b] = line.split("\t");
        if (code.startsWith("R")) return { file: a, status: "renamed" as const, renamed_to: b };
        if (code.startsWith("D")) return { file: a, status: "deleted" as const };
        return { file: a, status: "modified" as const };
      });
    // A pathspec hides the rename target, so git reports a move as a deletion. Look for renames repo-wide, only when needed.
    if (changes.some((c) => c.status === "deleted")) {
      const renames = new Map<string, string>();
      for (const line of (this.run(["diff", "--name-status", "-M", "--diff-filter=R", "--relative", from, "HEAD"]) ?? "").split("\n")) {
        const [code, a, b] = line.split("\t");
        if (code?.startsWith("R")) renames.set(a, b);
      }
      for (const c of changes) {
        const to = c.status === "deleted" ? renames.get(c.file) : undefined;
        if (to) Object.assign(c, { status: "renamed", renamed_to: to });
      }
    }
    return changes;
  }

  contentAt(rev: string, file: string): string | null {
    return this.run(["show", `${rev}:./${file}`]);
  }

  // Line ranges (in the `from` version) touched between `from` and HEAD. Insertions lie between old lines: adding before or after a linked range does not rewrite it.
  touchedRanges(from: string, file: string): [number, number][] | null {
    const out = this.run(["diff", "-U0", "--inter-hunk-context=0", "--relative", from, "HEAD", "--", file]);
    if (out === null) return null;
    const ranges: [number, number][] = [];
    for (const m of out.matchAll(/^@@ -(\d+)(?:,(\d+))? /gm)) {
      const start = Number(m[1]);
      const len = m[2] === undefined ? 1 : Number(m[2]);
      ranges.push(len === 0 ? [start + 0.5, start + 0.5] : [start, start + len - 1]);
    }
    return ranges;
  }

  // True when `file` changed between `from` and HEAD only in the ways a formatter changes code.
  // First the cheap check: whitespace and blank lines only (`--quiet` exits 0 for no difference).
  // That misses what formatters actually do (re-wrap a call over several lines, add trailing commas,
  // parenthesize a lone arrow parameter), so if it fails both versions are compared after normalizing those.
  // What is still undecided after that goes to the project's own Prettier, all files in one process
  // (formatting.ts); a project without Prettier keeps the conservative answer.
  //
  // The verdict depends only on the two file contents, so it is keyed by their blob ids and kept in
  // `verdicts` (which the caller may persist): an unrelated commit, or a restart, costs no re-check.
  formattingOnly(from: string, file: string): boolean {
    return this.formattingOnlyPairs([{ from, file }]).get(`${from}\0${file}`) ?? false;
  }

  verdicts = new Map<string, boolean>(); // "<blob before>:<blob after>" -> formatting only

  // Many (commit, file) pairs at once: one `ls-tree` per commit, and at most one Prettier process in total.
  formattingOnlyPairs(pairs: { from: string; file: string }[]): Map<string, boolean> {
    const out = new Map<string, boolean>();
    if (!pairs.length) return out;
    const files = [...new Set(pairs.map((p) => p.file))];
    const trees = new Map<string, Map<string, string>>();
    const blobsAt = (rev: string) => {
      if (!trees.has(rev)) trees.set(rev, this.blobs(rev, files));
      return trees.get(rev)!;
    };
    const pending: (Pair & { key: string; id: string })[] = [];
    for (const { from, file } of pairs) {
      const id = `${from}\0${file}`;
      const a = blobsAt(from).get(file);
      const b = blobsAt("HEAD").get(file);
      if (!a || !b) {
        out.set(id, false);
        continue;
      }
      const key = `${a}:${b}`;
      const known = this.verdicts.get(key);
      if (known !== undefined) {
        out.set(id, known);
        continue;
      }
      if (this.run(["diff", "-w", "--ignore-blank-lines", "--quiet", a, b]) !== null) {
        this.verdicts.set(key, true);
        out.set(id, true);
        continue;
      }
      const before = this.run(["cat-file", "blob", a]);
      const after = before === null ? null : this.run(["cat-file", "blob", b]);
      if (before === null || after === null) out.set(id, false);
      else if (sameCode(before, after)) {
        this.verdicts.set(key, true);
        out.set(id, true);
      } else if (!mayBeFormatting(before, after)) {
        this.verdicts.set(key, false); // a formatter cannot have made this difference: no need to ask one
        out.set(id, false);
      } else if (!pending.some((p) => p.key === key)) pending.push({ file, before, after, key, id });
      else pending.find((p) => p.key === key)!.id += `\n${id}`; // same contents asked for twice
    }
    const verdicts = prettierVerdicts(this.cwd, pending);
    pending.forEach((p, i) => {
      const v = verdicts?.[i] ?? false;
      if (verdicts) this.verdicts.set(p.key, v); // without Prettier, do not remember a guess
      for (const id of p.id.split("\n")) out.set(id, v);
    });
    return out;
  }

  // Blob id of each of `files` at `rev`, in one call. Paths are relative to the project root.
  private blobs(rev: string, files: string[]): Map<string, string> {
    const out = new Map<string, string>();
    const text = this.run(["ls-tree", "-r", rev, "--", ...files]) ?? "";
    for (const line of text.split("\n")) {
      const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
      if (m) out.set(m[2], m[1]);
    }
    return out;
  }

  // The unified diff of these files between `from` and HEAD (renames followed), or null when git cannot say.
  diff(from: string, paths: string[]): string | null {
    if (!paths.length) return "";
    return this.run(["diff", "--no-color", "--no-ext-diff", "-M", "--relative", from, "HEAD", "--", ...paths]);
  }

  commitsSince(from: string, file: string, limit = 20): CommitInfo[] {
    const out = this.run(["log", `--max-count=${limit}`, "--format=%H%x09%an%x09%aI%x09%s", "--relative", `${from}..HEAD`, "--", file]);
    if (!out) return [];
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [hash, author, date, ...subject] = l.split("\t");
        return { hash, author, date, subject: subject.join("\t") };
      });
  }
}

// Equal once formatting is taken out: whitespace between tokens (kept, as one space, only where it
// separates two words, so `return x` never equals `returnx`), trailing commas before a closing bracket,
// and parentheses around a single arrow-function parameter. Deliberately crude: it errs toward "real
// change", which only costs a look; calling a real change formatting would hide it.
export function sameCode(a: string, b: string): boolean {
  return normalizeCode(a) === normalizeCode(b);
}

function normalizeCode(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/ (?![\w$])|(?<![\w$]) /g, "") // drop a space unless it sits between two word characters
    .replace(/,(?=[)\]}>])/g, "")
    .replace(/\(([\w$]+)\)=>/g, "$1=>");
}

// A necessary condition for "only a formatter changed this": equal once every character a formatter
// adds or removes (whitespace, brackets and braces, commas, semicolons, quotes, escapes, union bars) is gone.
// Different here means different for sure; equal here still needs the real formatter to confirm.
function mayBeFormatting(a: string, b: string): boolean {
  const strip = (s: string) => s.replace(/[\s()[\]{},;'"`|\\]/g, ""); // {}: JSX gains {" "} when re-wrapped
  return strip(a) === strip(b);
}

// A web address for commits, from a remote URL: only GitHub, whose commit pages are known to live at
// <repo>/commit/<hash>. Anything else (GitLab, a bare server) gives null and hashes stay plain text.
export function githubRepoUrl(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const m = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}
