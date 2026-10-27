import { expect, open, test } from "./fixtures";

// Cumulative layout shift while a screen loads its data: content arriving must not push what is already shown.
// Budget 0.05 (Google calls under 0.1 "good"; a board that people scan and click fast should do better).
const BUDGET = 0.05;

type Shift = { value: number; hadRecentInput: boolean; startTime: number; sources: { node?: Node; previousRect: DOMRect; currentRect: DOMRect }[] };

test.beforeEach(async ({ page }) => {
  // This measures a screen loading, not live updates: other tests write to the same server in parallel, and
  // their changes arriving over the live stream would move rows here. Without the stream, only loading counts.
  await page.route("**/api/events", (r) => r.abort());
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number; __shifts: string[] };
    w.__cls = 0;
    w.__shifts = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as Shift[]) {
        if (e.hadRecentInput) continue;
        w.__cls += e.value;
        // What moved, so a failure says where to look.
        const what = e.sources.map((s) => {
          const el = s.node instanceof Element ? `${s.node.tagName.toLowerCase()}.${[...s.node.classList].join(".")}` : String(s.node?.nodeName);
          return `${el} y${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)}`;
        });
        w.__shifts.push(`${e.value.toFixed(3)} at ${e.startTime.toFixed(0)}ms: ${what.join(", ")}`);
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
});

for (const route of ["inbox", "board/task", "approvals", "activity", "knowledge/backend"]) {
  test(`${route} loads without layout shift`, async ({ board }) => {
    await open(board, route);
    await board.waitForTimeout(800); // late arrivals: badges, live status, fonts
    const { cls, shifts } = await board.evaluate(() => {
      const w = window as unknown as { __cls: number; __shifts: string[] };
      return { cls: w.__cls, shifts: w.__shifts };
    });
    expect(cls, `CLS ${cls.toFixed(3)}\n${shifts.join("\n")}`).toBeLessThan(BUDGET);
  });
}
