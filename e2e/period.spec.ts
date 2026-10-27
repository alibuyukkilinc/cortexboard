import { readFileSync } from "node:fs";
import { join } from "node:path";
import { axe, expect, open, test } from "./fixtures";

// UI-11: the report opens on this week and answers "which epic is where" on the same screen: a milestone
// timeline and the epics with their task boxes. The projects share one server, so each run names its own
// milestone and looks only for that.
const tokens = () => JSON.parse(readFileSync(join(import.meta.dirname, ".state", "tokens.json"), "utf8")) as Record<string, string>;
const as = (who: string) => ({ authorization: `Bearer ${tokens()[who]}` });

test("the week report shows milestones on a timeline and epics with their progress", async ({ board, request }, info) => {
  const ms = `M-${info.project.name}`;
  const post = (data: object) => request.post("/api/items", { headers: as("ai-agent"), data });
  const epic = await post({ type: "task", title: `Checkout epic ${ms}`, body: "- [x] cart\n- [ ] payment", fields: { milestone: ms, due: "2020-01-10" } });
  expect(epic.status()).toBe(201);
  await post({ type: "task", title: `Receipt ${ms}`, fields: { milestone: ms } });

  await open(board, "reports");
  await expect(board.locator(".segmented button.on")).toHaveText(/This week|Bu hafta/);
  await expect(board.locator(".week-label")).toBeVisible();

  const row = board.locator(".tl-chart-row", { hasText: ms });
  await expect(row).toBeVisible();
  await expect(row.locator(".chip.danger")).toBeVisible(); // its target is in the past
  await row.locator(".tl-bar").focus();
  await expect(board.locator(".viz-tip")).toContainText("0/2");

  const epicRow = board.locator(".list-row", { hasText: `Checkout epic ${ms}` });
  await expect(epicRow.locator("[role=progressbar]")).toHaveAttribute("aria-valuenow", "1");

  // The previous week is one click back, and the period stays in the URL.
  await board.getByRole("button", { name: /Previous week|Önceki hafta/ }).click();
  await expect(board).toHaveURL(/#\/reports\?week=\d{4}-\d{2}-\d{2}/);
  await board.getByRole("button", { name: /Next week|Sonraki hafta/ }).click();
  await expect(board).toHaveURL(/#\/reports$/);
  // The page dims while the new period loads; check it once the report is drawn.
  await expect(board.locator(".is-loading")).toHaveCount(0);
  expect(await axe(board)).toEqual([]);

  // A milestone's bar opens the board on its items, the milestone shown as a filter that can be removed.
  await board.locator(".tl-chart-row", { hasText: ms }).locator(".tl-bar").click();
  await expect(board).toHaveURL(new RegExp(`#/board/task\\?milestone=${ms}`));
  await expect(board.locator(".kcard")).toHaveCount(2);
  await board.getByRole("button", { name: new RegExp(`(Remove filter|Filtreyi kaldır): ${ms}`) }).click();
  await expect(board).toHaveURL(/#\/board\/task$/);
});
