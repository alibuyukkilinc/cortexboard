import { axe, expect, open, test } from "./fixtures";

// UI-9: messages sit beside the fields they are about, and a decision starts from its template.
test("the new item form shows errors beside fields and starts a decision from its template", async ({ board }) => {
  await open(board, "board/issue");
  await board
    .getByRole("button", { name: /^(\+ )?(New|Yeni)$/ })
    .first()
    .click();
  const dialog = board.getByRole("dialog");
  await dialog.locator("#items-item-title").fill("Crash on save");
  await dialog.locator("#items-item-category").selectOption("");
  await dialog.getByRole("button", { name: /^(Create|Oluştur)$/ }).click();
  const branchErr = dialog.locator("#items-item-category-err");
  await expect(branchErr).toBeVisible();
  await expect(dialog.locator("#items-item-category")).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.locator("#f-severity-err")).toBeVisible();
  expect(await axe(board)).toEqual([]);

  await dialog.locator("#items-board-type").selectOption("decision");
  await expect(dialog.locator("#items-item-body")).toHaveValue(/## (Context|Bağlam)/);
  await expect(dialog.locator("#f-alternatives")).toBeVisible();
});
