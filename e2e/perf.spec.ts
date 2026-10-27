import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, open, test } from "./fixtures";

// Measurements on a large project, not pass/fail checks yet: the numbers the performance budget is set
// against (Cortex: frontend performance node). Skipped unless PERF=1, and meant for a seeded project:
//   npx tsx scripts/seed-large.ts <dir>
//   PERF=1 E2E_PROJECT=<dir> npx playwright test perf --project=wide-light
test.skip(!process.env.PERF, "set PERF=1 (and E2E_PROJECT to a seeded project) to measure");
test.setTimeout(180_000);

for (const route of ["inbox", "board/task", "approvals", "activity", "knowledge/backend"]) {
  test(`first paint and data on ${route}`, async ({ board }) => {
    const t0 = Date.now();
    await open(board, route, 90_000);
    const ready = Date.now() - t0;
    const fcp = await board.evaluate(() => performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? -1);
    const nodes = await board.evaluate(() => document.querySelectorAll("main *").length);
    console.log(`PERF ${route}: first paint ${fcp.toFixed(0)} ms, data drawn ${ready} ms, ${nodes} DOM nodes in main`);
    expect(ready).toBeGreaterThan(0);
  });
}

test("requests one write triggers on an open screen", async ({ board, request }) => {
  await open(board, "board/task", 90_000);
  await board.waitForTimeout(1000);
  const seen: string[] = [];
  board.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/") && u.pathname !== "/api/events") seen.push(u.pathname + u.search);
  });
  const tokens = JSON.parse(readFileSync(join(import.meta.dirname, ".state", "tokens.json"), "utf8")) as Record<string, string>;
  const r = await request.post("/api/activity", {
    headers: { authorization: `Bearer ${tokens["ai-agent"]}` },
    data: { action: "docs", summary: "perf probe", why: "Counting the requests one write causes." },
  });
  expect(r.status()).toBe(201);
  await board.waitForTimeout(2000);
  console.log(`PERF one write → ${seen.length} requests: ${seen.join(", ")}`);
});
