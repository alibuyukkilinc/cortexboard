// Shared paths and helpers for the benchmark (round 10: multi-session work, several model families).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(BENCH, "..");
// Outside the repo on purpose: Claude Code reads every CLAUDE.md up the tree, and this repo's would leak Cortex
// into the baseline arm. Override with BENCH_WORK; Codex must trust the folder it lands in.
export const WORK = process.env.BENCH_WORK ?? resolve(REPO, "..", "cortex-bench-work");
export const FIXTURES = join(WORK, "fixtures");
export const RUNS = join(WORK, "runs");
export const TOOLS = join(WORK, "tools");
export const RESULTS = join(BENCH, "results");
export const CORTEX_VERSION = process.env.BENCH_CORTEX_VERSION ?? "0.6.0";
export const CORTEX_CLI = join(TOOLS, "node_modules", "cortexboard", "dist", "cli.js");

export const tasks = () => JSON.parse(readFileSync(join(BENCH, "tasks.json"), "utf8"));

export function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", ...opts }).trim();
}

export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32", ...opts });
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}

export function writeJson(p, v) {
  ensureDir(dirname(p));
  writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
}

export function readJson(p, fallback) {
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback;
}

export function args(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

export const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
