// API timings on a large project (make one with scripts/seed-large.ts): the reads the board makes when a
// person opens its screens, each repeated, reported as p50/p95 and response size.
//
//   npx tsx scripts/perf-baseline.ts <project dir> [--runs 20]
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildServer } from "../src/api/server.js";
import { Cortex } from "../src/core/cortex.js";
import { loadProject, loadTokens } from "../src/core/project.js";

const { positionals, values } = parseArgs({ allowPositionals: true, options: { runs: { type: "string", default: "20" } } });
if (!positionals[0]) {
  console.error("usage: npx tsx scripts/perf-baseline.ts <project dir> [--runs n]");
  process.exit(2);
}
const root = resolve(positionals[0]);
const runs = Number(values.runs);

let t0 = performance.now();
const cortex = new Cortex(loadProject(root), { embedder: null });
const openMs = performance.now() - t0;
const app = buildServer(cortex);
const headers = { host: "localhost", authorization: `Bearer ${loadTokens(resolve(root, ".cortex")).owner}` };

// What each screen asks for on open (see web/src/pages/*), plus the sidebar badges every screen loads.
const READS: [string, string][] = [
  ["counts (every screen)", "/api/counts"],
  ["inbox", "/api/inbox?limit=100"],
  ["approvals", "/api/approvals"],
  ["stale", "/api/stale"],
  ["board (task)", "/api/items?type=task&limit=500"],
  ["tree (pickers)", "/api/tree?depth=5"],
  ["activity", "/api/activity?limit=200"],
  ["search", "/api/search?q=login&limit=30"],
  ["report 7d", "/api/report?since=7d"],
];

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
console.log(`Project ${root}\nOpen + index check: ${openMs.toFixed(0)} ms\n`);
console.log(`${"read".padEnd(24)} ${"p50 ms".padStart(8)} ${"p95 ms".padStart(8)} ${"KB".padStart(8)}`);
for (const [name, url] of READS) {
  const times: number[] = [];
  let bytes = 0;
  for (let i = 0; i < runs; i++) {
    t0 = performance.now();
    const r = await app.inject({ url, headers });
    times.push(performance.now() - t0);
    if (r.statusCode !== 200) throw new Error(`${url}: ${r.statusCode} ${r.body.slice(0, 200)}`);
    bytes = r.rawPayload.length;
  }
  console.log(`${name.padEnd(24)} ${pct(times, 50).toFixed(1).padStart(8)} ${pct(times, 95).toFixed(1).padStart(8)} ${(bytes / 1024).toFixed(0).padStart(8)}`);
}
await app.close();
cortex.close();
