// Re-applies the answer checks of tasks.json to every saved result, from the full answers kept in the run's
// folder. Checks on the repo (files, tests) ran against a state that is gone, so they keep their score.
//   node bench/rescore.mjs
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ANSWER_KINDS, escapes, removedLines, scoreAnswerCheck, voids } from "./checks.mjs";
import { git, readJson, RESULTS, RUNS, tasks, writeJson } from "./lib.mjs";

const suite = tasks();
let changedRuns = 0;
for (const f of readdirSync(RESULTS).filter((x) => x.endsWith(".json"))) {
  const path = join(RESULTS, f);
  const r = readJson(path);
  let changed = false;
  for (const t of r.tasks) {
    const def = suite.tasks.find((x) => x.id === t.id);
    const file = join(RUNS, r.run_id, "answers", `${t.id}.md`);
    const answer = existsSync(file) ? readFileSync(file, "utf8") : (t.answer_excerpt ?? "");
    const repo = join(RUNS, r.run_id, "repo");
    const checks = def.checks.map((c, i) => {
      const old = t.score.checks[i];
      // Only lines removed from a file, which later tasks do not undo: safe to read from the repo as it ended.
      if (c.kind === "no_removals" && existsSync(repo)) {
        const base = git(repo, "log", "--format=%H", "-1", "--grep=Reports: simplify period setup");
        const removed = removedLines(repo, base, c.path);
        return { label: c.label, kind: c.kind, points: c.points, got: removed ? 0 : c.points, ...(removed ? { note: `${removed} line(s) removed` } : {}) };
      }
      if (!ANSWER_KINDS.has(c.kind)) return { ...old, got: old.raw ?? old.got, raw: old.raw ?? old.got };
      const { got, note } = scoreAnswerCheck(c, answer);
      return { label: c.label, kind: c.kind, points: c.points, got, ...(note ? { note } : {}) };
    });
    if (t.is_error && t.tool_calls === 0) for (const c of checks) c.got = 0; // the session never started
    const log = join(RUNS, r.run_id, "logs", `${t.id}.jsonl`);
    if (existsSync(log)) {
      t.outside = escapes(readFileSync(log, "utf8"), r.agent);
      t.voided = voids(t.outside);
      if (t.voided) for (const c of checks) c.got = 0; // read the real project's knowledge from outside the copy
    }
    const got = Math.round(checks.reduce((s, c) => s + c.got, 0) * 100) / 100;
    if (got !== t.score.got) {
      console.log(`${r.run_id} ${t.id}: ${t.score.got} -> ${got}`);
      changed = true;
    }
    t.score = { got, max: checks.reduce((s, c) => s + c.points, 0), checks };
  }
  if (changed) changedRuns++;
  writeJson(path, r);
}
console.log(`[rescore] ${changedRuns} runs changed`);
