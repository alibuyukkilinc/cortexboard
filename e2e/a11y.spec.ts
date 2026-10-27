import { axe, expect, open, SCREENS, test } from "./fixtures";

// Every screen, in each project (phone and wide, light and dark), passes axe's WCAG A/AA rules.

for (const route of SCREENS) {
  test(`${route} passes axe`, async ({ board }) => {
    await open(board, route);
    expect(await axe(board)).toEqual([]);
  });
}

test("an open item drawer passes axe and holds focus", async ({ board }) => {
  await open(board, "board/task");
  await board.locator(".kcard", { hasText: "Add rate limiting to login" }).click();
  const dialog = board.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Add rate limiting to login" })).toBeVisible();
  expect(await axe(board)).toEqual([]);
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
});

test("the new item dialog passes axe", async ({ board }) => {
  await open(board, "board/task");
  await board.getByRole("button", { name: /new/i }).first().click();
  await expect(board.getByRole("dialog")).toBeVisible();
  expect(await axe(board)).toEqual([]);
});

test("a draft under review passes axe", async ({ board }) => {
  await open(board, "approvals");
  // The list refreshes when another page writes to the shared server, which can swallow a click that landed just
  // before: click and wait for the drawer together, and go again if it did not open.
  await expect(async () => {
    await board.locator(".list-row", { hasText: "Auth" }).first().click();
    await expect(board.getByRole("dialog")).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 15_000 });
  expect(await axe(board)).toEqual([]);
});
