import { readFileSync } from "node:fs";
import { join } from "node:path";
import { axe, expect, open, test } from "./fixtures";

// A draft that removes most of a page is read and approved on its own: it stays out of "select all", says
// why in the drawer, and its diff reads in both views. Paths carry the project name: the server is shared.
const tokens = () => JSON.parse(readFileSync(join(import.meta.dirname, ".state", "tokens.json"), "utf8")) as Record<string, string>;
const as = (who: string) => ({ authorization: `Bearer ${tokens()[who]}` });

test("a risky draft stays out of a batch and shows its diff in both views", async ({ board, request }, info) => {
  const path = `backend/rules-${info.project.name}`;
  const body = Array.from({ length: 20 }, (_, i) => `Rule ${i}: sessions expire after ${i + 5} minutes.`).join("\n");
  await request.put(`/api/node/${path}`, {
    headers: as("owner"),
    data: { title: `Rules ${info.project.name}`, summary: "Session rules.", body, reason: "seed" },
  });
  const put = await request.put(`/api/node/${path}`, {
    headers: as("ai-agent"),
    data: {
      title: `Rules ${info.project.name}`,
      summary: "Session rules.",
      body: body.split("\n").slice(0, 3).join("\n").replace("5 minutes", "15 minutes"),
      reason: "Trim",
      confirm_shrink: true,
    },
  });
  expect(put.status()).toBe(202);

  await open(board, "approvals");
  const row = board.locator(".list-row", { hasText: `Rules ${info.project.name}` });
  await expect(row.locator(".row-check")).toBeDisabled();
  await expect(row.locator(".diff-size")).toContainText("−18 +1");
  await board.locator("#approvals-approvals-selectall").check();
  await expect(row.locator(".row-check")).not.toBeChecked();

  await row.locator(".press-title").click();
  const dialog = board.getByRole("dialog");
  await expect(dialog.locator(".notice.warn")).toBeVisible();
  // Changed words are marked inside the changed line.
  await expect(dialog.locator(".diffv del:not(.whole)").first()).toHaveText("5");
  for (const view of [/^(Unified|Birleşik)$/, /^(Side by side|Yan yana)$/]) {
    await dialog.getByRole("button", { name: view }).click();
    await expect(dialog.getByRole("button", { name: view })).toHaveAttribute("aria-pressed", "true");
    expect(await axe(board)).toEqual([]);
  }
});
