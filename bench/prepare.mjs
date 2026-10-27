// Builds the two fixtures every run starts from, outside the repo (see WORK in lib.mjs):
//   cortex   : this repo at HEAD with its .cortex/ knowledge, Cortex instructions in CLAUDE.md / AGENTS.md
//   baseline : the same code with .cortex/ removed from the whole history, neutral CLAUDE.md / AGENTS.md
// Both get the same planted bug (T7) in one innocuous commit, no git remote (nothing can be pushed), and share
// one node_modules. The published cortexboard (CORTEX_VERSION) is installed once; it serves the cortex arm's MCP.
//   node bench/prepare.mjs [--force]
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { args, CORTEX_CLI, CORTEX_VERSION, ensureDir, FIXTURES, git, readJson, REPO, run, TOOLS, WORK } from "./lib.mjs";

const opts = args();
const log = (m) => console.log(`[prepare] ${m}`);

const COMMON = `Commands: \`npm test\` · \`npm run typecheck\` · \`npm run build\`. One test file: \`node --import tsx --test test/<name>.test.ts\`.
`;

const CORTEX_NOTES = `# Cortex (this repository)

This repo is Cortex, a shared project brain for humans and AIs (TypeScript, Node 22+).
${COMMON}
## Project knowledge: Cortex
This project's knowledge lives in Cortex (the \`cortex\` MCP tools), not in markdown files.
- Session start: call \`cortex_brief\`, then \`cortex_inbox\` for questions and issues waiting on you.
- Before changing code you don't fully understand: \`cortex_search\`, then \`cortex_tree\` / \`cortex_node\`.
- Before editing files: \`cortex_code_context(files)\` shows the knowledge, decisions and open items that cover them.
- After a meaningful change: \`cortex_log_activity\` (what, why, files, commit), and update the relevant node.
- When the person states a lasting decision or rule: \`cortex_capture\`.
- Before you finish: \`cortex_update_status\`. \`cortex_finish\` does log, card reply, status and claim in one call.
Write Cortex content in the project language (Turkish).
`;

const BASELINE_NOTES = `# Cortex (this repository)

This repo is Cortex, a shared project brain for humans and AIs (TypeScript, Node 22+).
${COMMON}`;

// T7: the report ignores the project's time zone. One line, with a plausible comment.
function plantBug(dir) {
  const f = join(dir, "src/core/reports.ts");
  const src = readFileSync(f, "utf8");
  const from = `    const tz = this.c.project.config.timezone ?? "UTC";`;
  if (!src.includes(from)) throw new Error("planted bug: anchor line not found in src/core/reports.ts");
  writeFileSync(f, src.replace(from, `    const tz = "UTC"; // one zone for every reader; the board converts when it draws`));
  git(dir, "add", "src/core/reports.ts");
  git(dir, "commit", "-q", "-m", "Reports: simplify period setup");
}

function writeNotes(dir, text) {
  writeFileSync(join(dir, "CLAUDE.md"), text);
  writeFileSync(join(dir, "AGENTS.md"), text);
  rmSync(join(dir, ".mcp.json"), { force: true }); // the runner passes the MCP config itself
  git(dir, "add", "-A", "CLAUDE.md", "AGENTS.md", ".mcp.json");
  git(dir, "commit", "-q", "-m", "Agent notes");
}

function clone(to) {
  rmSync(to, { recursive: true, force: true });
  git(WORK, "clone", "-q", "--no-hardlinks", REPO, to);
  git(to, "remote", "remove", "origin");
  // Release tags point at the original commits; in the baseline they would keep .cortex reachable.
  const tags = git(to, "tag", "--list").split("\n").filter(Boolean);
  if (tags.length) git(to, "tag", "-d", ...tags);
  git(to, "config", "user.name", "bench");
  git(to, "config", "user.email", "bench@example.invalid");
  git(to, "config", "core.autocrlf", "false");
}

ensureDir(WORK);
ensureDir(FIXTURES);

// 1. The published package, for the cortex arm's MCP server.
const installed = readJson(join(TOOLS, "node_modules", "cortexboard", "package.json"), {}).version;
if (installed !== CORTEX_VERSION || opts.force) {
  log(`installing cortexboard@${CORTEX_VERSION}`);
  ensureDir(TOOLS);
  const r = run("npm", ["install", `cortexboard@${CORTEX_VERSION}`, "--prefix", TOOLS, "--no-audit", "--no-fund"], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("npm install cortexboard failed");
}

// 2. Base clone with node_modules (shared by both fixtures and every run through a junction).
const base = join(FIXTURES, "base");
const head = git(REPO, "rev-parse", "HEAD");
if (opts.force || !existsSync(join(base, "node_modules")) || git(base, "rev-parse", "HEAD") !== head) {
  log(`cloning ${head.slice(0, 7)} and installing dependencies`);
  clone(base);
  const r = run("npm", ["ci", "--no-audit", "--no-fund", "--ignore-scripts"], {
    cwd: base,
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
  });
  if (r.status !== 0) throw new Error("npm ci failed");
}

// 3. cortex arm.
const cortex = join(FIXTURES, "cortex");
log("cortex fixture");
clone(cortex);
writeNotes(cortex, CORTEX_NOTES);
plantBug(cortex);
const idx = run("node", [CORTEX_CLI, "reindex", "--dir", cortex], { encoding: "utf8" });
if (idx.status !== 0) throw new Error(`reindex failed: ${idx.stderr}`);

// 4. baseline arm: no .cortex anywhere in history, so `git show` cannot reach it either.
const baseline = join(FIXTURES, "baseline");
log("baseline fixture (removing .cortex from history, takes a minute)");
clone(baseline);
const fb = run("git", ["filter-branch", "-f", "--prune-empty", "--index-filter", "git rm -r -q --cached --ignore-unmatch .cortex", "HEAD"], {
  cwd: baseline,
  encoding: "utf8",
  shell: false,
  env: { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: "1" },
});
if (fb.status !== 0) throw new Error(`filter-branch failed: ${fb.stderr}`);
rmSync(join(baseline, ".git", "refs", "original"), { recursive: true, force: true });
git(baseline, "reflog", "expire", "--expire=now", "--all");
git(baseline, "gc", "-q", "--prune=now");
rmSync(join(baseline, ".cortex"), { recursive: true, force: true });
writeNotes(baseline, BASELINE_NOTES);
plantBug(baseline);
if (git(baseline, "log", "--all", "--oneline", "--", ".cortex")) throw new Error("baseline still has .cortex in its history");

writeFileSync(join(FIXTURES, "fixture.json"), JSON.stringify({ repo_head: head, cortex_version: CORTEX_VERSION, made_at: new Date().toISOString() }, null, 2));
log(`done: ${FIXTURES}`);
