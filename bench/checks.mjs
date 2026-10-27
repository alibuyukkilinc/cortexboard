// Scores one task right after it ran, against the run's repo as that task left it (later tasks change it).
// Every check is automatic; the answer key in tasks.json is there for a human (or judge model) second look.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, run } from "./lib.mjs";

const rx = (s) => new RegExp(s, "isu");

const HIDDEN_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { tempProject } from "./test/helpers.ts";

test("hidden: a report counts days in the project's zone, UTC when none is set", () => {
  for (const tz of ["Europe/Istanbul", "America/New_York", "Asia/Tokyo"]) {
    const t = tempProject();
    try {
      t.cortex.project.config.timezone = tz;
      const r = t.cortex.reports.build({ since: "3d" });
      assert.equal(r.period.timezone, tz);
      assert.equal(r.daily.length, 3);
    } finally {
      t.cleanup();
    }
  }
  const t = tempProject();
  try {
    delete t.cortex.project.config.timezone;
    assert.equal(t.cortex.reports.build({ since: "7d" }).period.timezone, "UTC");
  } finally {
    t.cleanup();
  }
});
`;

// What the run changed since it started: committed and uncommitted diffs plus new files (not ignored ones).
export function changes(repo, baseSha) {
  const diffFiles = git(repo, "diff", "--name-only", baseSha).split("\n").filter(Boolean);
  const untracked = git(repo, "ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
  const files = [...new Set([...diffFiles, ...untracked])].filter((f) => existsSync(join(repo, f)));
  return files.map((f) => ({ file: f.replace(/\\/g, "/"), text: safeRead(join(repo, f)) }));
}

function safeRead(p) {
  try {
    const b = readFileSync(p);
    return b.includes(0) ? "" : b.toString("utf8");
  } catch {
    return "";
  }
}

function runCmd(repo, cmd) {
  const r = run(cmd, [], { cwd: repo, shell: true, encoding: "utf8", timeout: 300_000 });
  return { ok: r.status === 0, tail: `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").slice(-6).join("\n") };
}

// Lines taken out of a file since the run began: adding a regression test is fine, weakening one is not.
export function removedLines(repo, baseSha, path) {
  return git(repo, "diff", "--numstat", baseSha, "--", path)
    .split("\n")
    .filter(Boolean)
    .reduce((s, l) => s + (Number(l.split("\t")[1]) || 0), 0);
}

// Only what this task changed: files whose content differs from the snapshot taken before it ran.
export function snapshot(repo, baseSha) {
  return new Map(changes(repo, baseSha).map((x) => [x.file, x.text]));
}

// Checks read from the answer alone, so a later fix to a pattern can be re-applied (bench/rescore.mjs).
// `none`: the answer states what the check is there to catch (e.g. the superseded rule as current) → 0.
export const ANSWER_KINDS = new Set(["answer", "count"]);
// A sentence that quotes the old rule as old ("the former 'drafts stay' decision was superseded") is not the claim.
const QUOTING_OLD = /eski|eskiden|önceki|yürürlükten|kaldırıl|değiştiril|superseded|artık|yerine|former|previous/iu;
function statesAsCurrent(pattern, answer) {
  return answer.split(/(?<=[.!?])\s+|\n+/).some((sentence) => rx(pattern).test(sentence) && !QUOTING_OLD.test(sentence));
}

export function scoreAnswerCheck(c, answer) {
  const wrong = (c.none ?? []).find((p) => statesAsCurrent(p, answer));
  if (wrong) return { got: 0, note: `states the wrong thing: /${wrong}/` };
  if (c.kind === "answer") return { got: c.any.some((p) => rx(p).test(answer)) ? c.points : 0, note: "" };
  const hit = c.all.filter((p) => rx(p).test(answer)).length;
  return { got: Math.round(((c.points * hit) / c.all.length) * 100) / 100, note: `${hit}/${c.all.length}` };
}

export function scoreTask(task, { repo, baseSha, before, answer }) {
  const results = [];
  let changed;
  const lazyChanges = () => (changed ??= changes(repo, baseSha).filter((x) => before.get(x.file) !== x.text));
  const pathChanged = (path) => lazyChanges().some((x) => x.file === path || x.file.startsWith(path + "/"));
  for (const c of task.checks) {
    let got = 0;
    let note = "";
    switch (c.kind) {
      case "answer":
      case "count":
        ({ got, note } = scoreAnswerCheck(c, answer));
        break;
      case "file_any": {
        const f = lazyChanges().find((x) => c.all.every((p) => rx(p).test(x.text)));
        got = f ? c.points : 0;
        note = f ? f.file : "no changed file matches";
        break;
      }
      case "record": {
        // A record outside the code: anything the run wrote that is not under src/, test/, web/ or e2e/.
        const f = lazyChanges().find((x) => !/^(src|test|web|e2e)\//.test(x.file) && c.all.every((p) => rx(p).test(x.text)));
        got = f ? c.points : 0;
        note = f ? f.file : "no record found";
        break;
      }
      case "changed":
        got = pathChanged(c.path) ? c.points : 0;
        break;
      case "unchanged":
        got = pathChanged(c.path) ? 0 : c.points;
        break;
      case "no_removals": {
        const removed = removedLines(repo, baseSha, c.path);
        got = removed ? 0 : c.points;
        note = removed ? `${removed} line(s) removed` : "";
        break;
      }
      case "cmd": {
        const r = runCmd(repo, c.cmd);
        got = r.ok ? c.points : 0;
        note = r.ok ? "exit 0" : r.tail;
        break;
      }
      case "hidden": {
        const f = join(repo, ".bench-hidden.test.ts");
        writeFileSync(f, HIDDEN_TEST);
        try {
          const r = runCmd(repo, "node --import tsx --test --test-timeout=60000 .bench-hidden.test.ts");
          got = r.ok ? c.points : 0;
          note = r.ok ? "pass" : r.tail;
        } finally {
          rmSync(f, { force: true });
        }
        break;
      }
      default:
        throw new Error(`unknown check kind ${c.kind}`);
    }
    results.push({ label: c.label, kind: c.kind, points: c.points, got, ...(note ? { note } : {}) });
  }
  const max = results.reduce((s, r) => s + r.points, 0);
  const got = Math.round(results.reduce((s, r) => s + r.got, 0) * 100) / 100;
  return { got, max, checks: results };
}

// Reaching outside the run's copy for the project's knowledge: the real checkout next door, or the owner's hub
// folder (~/.cortex, which holds hub.db and every hub project's knowledge). Only what the agent itself ran or
// read counts (tool inputs), not files that merely mention these paths.
const OUTSIDE = [/htdocs[\\/]+aimcp(?![\w-])/i, /(USERPROFILE|HOME|~|Users[\\/]+[^\\/"']+)['"]?\)?[\\/,\s'"]*\.cortex\b/i, /hub\.db/i];
export function escapes(logText, agent) {
  const inputs = [];
  for (const line of logText.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (agent === "opencode" && e.type === "tool_use") inputs.push(JSON.stringify(e.part?.state?.input ?? ""));
    if (agent === "claude" && e.type === "assistant") for (const c of e.message?.content ?? []) if (c.type === "tool_use") inputs.push(JSON.stringify(c.input));
    if (agent === "codex" && e.type === "item.completed" && e.item) {
      if (e.item.type === "command_execution") inputs.push(e.item.command ?? "");
      if (e.item.type === "mcp_tool_call") inputs.push(JSON.stringify(e.item.arguments ?? ""));
    }
  }
  return inputs.filter((s) => OUTSIDE.some((r) => r.test(s))).map((s) => s.slice(0, 200));
}
// Looking around (ls ~/.cortex) is flagged; reading the real project's knowledge voids the task: the real checkout,
// or hub.db, which maps every hub project to its folder.
export const voids = (inputs) => inputs.some((s) => /htdocs[\\/]+aimcp(?![\w-])|hub\.db/i.test(s));

// The two lines every answer ends with (see tasks.json "suffix").
export function selfReport(answer) {
  const d = /ZORLUK\s*[:：]\s*\**\s*(kolay|orta|zor)/i.exec(answer)?.[1]?.toLowerCase() ?? null;
  const c = /EM[İI]NL[İI]K\s*[:：]\s*\**\s*(\d{1,3})/iu.exec(answer)?.[1];
  return { difficulty: d, confidence: c === undefined ? null : Number(c) };
}
