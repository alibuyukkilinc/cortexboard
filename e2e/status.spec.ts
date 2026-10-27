import { readFileSync } from "node:fs";
import { join } from "node:path";
import { axe, expect, open, test } from "./fixtures";

// The project status sits on top of Notifications and says when it has gone stale (UI-4). There is one per
// project and the server is shared, so this runs in a single project: parallel runs would overwrite it.
const tokens = () => JSON.parse(readFileSync(join(import.meta.dirname, ".state", "tokens.json"), "utf8")) as Record<string, string>;
const as = (who: string) => ({ authorization: `Bearer ${tokens()[who]}` });

test("the status card shows the status, marks it stale after many changes, and is edited in place", async ({ board, request }, info) => {
  test.skip(info.project.name !== "wide-light", "one status per project: checked once");
  const put = await request.put("/api/status", { headers: as("ai-agent"), data: { body: "Export shipped.\n\nNext: invoices PDF." } });
  expect(put.status()).toBe(200);
  await open(board, "inbox");
  const card = board.locator(".status-card");
  await expect(card).toContainText("Next: invoices PDF.");
  await expect(card.locator(".chip.warn")).toHaveCount(0);

  // 20 logged changes (the default limit) later, the same status is stale.
  for (let i = 0; i < 20; i++) {
    await request.post("/api/activity", { headers: as("ai-agent"), data: { action: "fix", summary: `Fix ${i}`, why: "Status staleness probe." } });
  }
  await expect(card.locator(".chip.warn")).toBeVisible();
  expect(await axe(board)).toEqual([]);

  await card.getByRole("button", { name: /^(Edit|Düzenle)$/ }).click();
  await card.locator("textarea").fill("Invoices PDF done. Next: refunds.");
  await card.getByRole("button", { name: /^(Save|Kaydet)$/ }).click();
  await expect(card).toContainText("Next: refunds.");
  await expect(card.locator(".chip.warn")).toHaveCount(0);
});
