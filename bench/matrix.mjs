// Runs several agent/model/arm combinations, a few at a time (each in its own copy, so they do not collide).
//   node bench/matrix.mjs [--models claude-haiku-4-5-20251001,claude-sonnet-5-5] [--arms cortex,baseline] [--parallel 3] [--tasks T1,T2]
import { spawn } from "node:child_process";
import { join } from "node:path";
import { args, BENCH } from "./lib.mjs";

const opts = args();
const models = String(opts.models ?? "claude-haiku-4-5-20251001,claude-sonnet-5-5,claude-opus-5-5,claude-fable-5-1").split(",");
const arms = String(opts.arms ?? "cortex,baseline").split(",");
const agent = opts.agent ?? "claude";
const parallel = Number(opts.parallel ?? 3);
const jobs = models.flatMap((m) => arms.map((a) => ({ model: m, arm: a })));

async function one({ model, arm }) {
  const a = [join(BENCH, "run.mjs"), "--agent", agent, "--model", model, "--arm", arm];
  if (typeof opts.tasks === "string") a.push("--tasks", opts.tasks);
  if (typeof opts.effort === "string") a.push("--effort", opts.effort);
  await new Promise((res) => {
    const c = spawn(process.execPath, a, { stdio: ["ignore", "pipe", "pipe"] });
    const tag = `${model.replace(/^claude-/, "")}/${arm}`;
    const pipe = (d) =>
      String(d)
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((l) => console.log(`${tag.padEnd(28)} ${l}`));
    c.stdout.on("data", pipe);
    c.stderr.on("data", pipe);
    c.on("close", res);
  });
}

const queue = [...jobs];
await Promise.all(
  Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
    while (queue.length) await one(queue.shift());
  }),
);
console.log("[matrix] all runs finished");
