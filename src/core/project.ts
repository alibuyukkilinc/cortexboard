import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import type { CortexConfig } from "./types.js";
import { CortexError } from "./types.js";
import { shortHash } from "../util/text.js";
import { isTimeZone } from "../util/time.js";

export const CORTEX_DIR = ".cortex";

export interface Project {
  root: string; // repository root (parent of .cortex)
  dir: string; // .cortex directory
  config: CortexConfig;
}

export function paths(dir: string) {
  return {
    config: join(dir, "cortex.config.yaml"),
    secrets: join(dir, ".secrets.yaml"),
    rules: join(dir, "rules"),
    tree: join(dir, "tree"),
    items: join(dir, "items"),
    activity: join(dir, "activity"),
    drafts: join(dir, "drafts"),
    chat: join(dir, "chat"),
    index: join(dir, ".index"),
  };
}

// Walk up from cwd until a .cortex folder is found, like git does with .git.
export function findProjectRoot(start = process.cwd()): string | null {
  let cur = resolve(start);
  while (true) {
    if (existsSync(join(cur, CORTEX_DIR, "cortex.config.yaml"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// Same bytes on every OS, so diffs do not flip with core.autocrlf. And the activity log merges by
// union: two machines appending to the same actor's file on the same day (the same AI actor on two
// laptops, or one person on two) would otherwise conflict on every pull. Its lines are independent
// entries with unique ids, and the index sorts them, so keeping both sides' lines is the right merge.
export const MERGE_RULE = "activity/**/*.jsonl merge=union";
export const GITATTRIBUTES = `* text=auto eol=lf\n${MERGE_RULE}\n`;

// Projects created before the merge rule get it added once. It is Cortex's own file in its own folder;
// without it, the first parallel day ends in a conflict nobody can resolve by hand without tooling.
function ensureMergeRule(dir: string): void {
  const file = join(dir, ".gitattributes");
  try {
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (text.split(/\r?\n/).includes(MERGE_RULE)) return;
    writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${MERGE_RULE}\n`, "utf8");
  } catch {
    // read-only checkout: merges there are someone else's concern
  }
}

// Saved views are one person's filters: they stay out of git. Projects made before they existed get the line.
function ensureIgnored(dir: string, line: string): void {
  const file = join(dir, ".gitignore");
  try {
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (text.split(/\r?\n/).includes(line)) return;
    writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`, "utf8");
  } catch {
    // read-only checkout
  }
}

export function loadProject(start?: string): Project {
  const root = findProjectRoot(start);
  if (!root) {
    throw new CortexError("not_initialized", "No .cortex folder found. Run `npx cortexboard init` first.", 404);
  }
  return openProject(root, join(root, CORTEX_DIR));
}

// The knowledge folder and the code it describes, given separately: a hub keeps a project's knowledge in its
// own folder (decision 01M3MXCE60DW7T897TRC43C6AR), while code links, git and staleness still look at `root`.
export function openProject(root: string, dir: string): Project {
  ensureMergeRule(dir);
  ensureIgnored(dir, "views/");
  const config = YAML.parse(readFileSync(paths(dir).config, "utf8")) as CortexConfig;
  config.port ??= 4747;
  config.actors ??= [];
  config.approval ??= {};
  for (const a of config.actors) {
    // Actor ids end up in file names (activity/<day>/<actor>.jsonl), so keep them boring.
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(a.id ?? "") || (a.kind !== "human" && a.kind !== "ai")) {
      throw new CortexError(
        "invalid_config",
        `Invalid actor ${JSON.stringify(a)} in cortex.config.yaml: id must be letters, digits, - or _, kind must be human or ai.`,
        500,
      );
    }
  }
  if (config.timezone !== undefined && !isTimeZone(String(config.timezone))) {
    throw new CortexError("invalid_config", `Unknown timezone "${config.timezone}" in cortex.config.yaml. Use a name like Europe/Istanbul or UTC.`, 500);
  }
  return { root, dir, config };
}

// Every API request resolves a token, so the file is parsed once and re-read only when it changes on disk
// (a hand-edited or rotated token is picked up on the next request, no restart).
const tokenCache = new Map<string, { stamp: string; tokens: Record<string, string> }>();

export function loadTokens(dir: string): Record<string, string> {
  const file = paths(dir).secrets;
  let stamp: string;
  try {
    const st = statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    tokenCache.delete(file);
    return {};
  }
  const hit = tokenCache.get(file);
  if (hit?.stamp === stamp) return hit.tokens;
  secureSecretsFile(file);
  const tokens = (YAML.parse(readFileSync(file, "utf8"))?.tokens ?? {}) as Record<string, string>;
  tokenCache.set(file, { stamp, tokens });
  return tokens;
}

// The secrets file holds API keys: owner read/write only. Files written before this rule get fixed on first read.
// Windows has no POSIX modes; there the user profile's ACLs already keep other accounts out.
export function secureSecretsFile(file: string): void {
  if (process.platform === "win32") return;
  try {
    if (statSync(file).mode & 0o077) chmodSync(file, 0o600);
  } catch {
    // not ours to change (read-only mount, other owner): reading still works
  }
}

// Rules version = hash of every file under rules/. AIs re-fetch rules only when this changes.
export function rulesVersion(dir: string): string {
  const rulesDir = paths(dir).rules;
  if (!existsSync(rulesDir)) return "r-none";
  const parts: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else parts.push(name, readFileSync(p, "utf8"));
    }
  };
  walk(rulesDir);
  return "r-" + shortHash(parts.join("\0"));
}

// Rewrites `linked` in cortex.config.yaml, keeping the file's comments and layout, and updates the running
// project. A hub's organization admin edits it from the board instead of by hand.
export function saveLinked(project: Project, linked: string[]): void {
  const file = paths(project.dir).config;
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  if (linked.length) doc.set("linked", doc.createNode(linked, { flow: true }));
  else doc.delete("linked");
  writeFileSync(file, doc.toString(), "utf8");
  project.config.linked = linked.length ? [...linked] : undefined;
}
