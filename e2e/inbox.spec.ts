import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, open, test } from "./fixtures";

// The inbox is one queue a person works through: finished work is approved from its row. Each test makes its
// own records (the server is shared by every project in playwright.config.ts), titled with the project name
// so runs never find each other's rows. How many requests a change causes is counted in web/test/live.test.tsx:
// here, pages of the other projects write at the same time.
const tokens = () => JSON.parse(readFileSync(join(import.meta.dirname, ".state", "tokens.json"), "utf8")) as Record<string, string>;
const as = (who: string) => ({ authorization: `Bearer ${tokens()[who]}` });

test("finished work is approved from its inbox row", async ({ board, request }, info) => {
  const title = `Export invoices (${info.project.name})`;
  const created = await request.post("/api/items", { headers: as("owner"), data: { type: "task", title, assignee: "@ai" } });
  const { id } = (await created.json()) as { id: string };
  await request.post(`/api/items/${id}/replies`, { headers: as("ai-agent"), data: { body: "Done in a1b2c3d.", status: "review" } });

  await open(board, "inbox");
  const row = board.locator(".inbox-row", { hasText: title });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /^(Approve|Onayla)$/ }).click();
  await expect(row).toHaveCount(0);
  const item = (await (await request.get(`/api/items/${id}`, { headers: as("owner") })).json()) as { item: { status: string } };
  expect(item.item.status).toBe("done");
});

test("the card itself offers the check: the same try-list, ticked in either place, and send back", async ({ board, request }, info) => {
  const title = `Refund twice (${info.project.name})`;
  const created = await request.post("/api/items", { headers: as("owner"), data: { type: "task", title, assignee: "@ai" } });
  const { id } = (await created.json()) as { id: string };
  const handIn = "Done.\n\nTo test:\n- [ ] Refund the same payment twice\n- [ ] Check the report";
  await request.post(`/api/items/${id}/replies`, { headers: as("ai-agent"), data: { body: handIn, status: "review" } });

  await open(board, "inbox");
  const row = board.locator(".inbox-row", { hasText: title });
  await row.getByLabel("Refund the same payment twice").check();
  await row.locator(".title").click();

  const panel = board.locator(".review-panel");
  await expect(panel.getByLabel("Refund the same payment twice")).toBeChecked();
  await expect(panel.getByLabel("Check the report")).not.toBeChecked();
  await panel.getByRole("button", { name: /^(Send back|Geri gönder)$/ }).click();
  const ask = board.getByRole("dialog", { name: /^(Send back|Geri gönder)$/ });
  await ask.getByRole("textbox").fill("The report shows two refunds.");
  await ask.getByRole("button", { name: /^(Send back|Geri gönder)$/ }).click();
  await expect(panel).toHaveCount(0);
  const item = (await (await request.get(`/api/items/${id}`, { headers: as("owner") })).json()) as { item: { status: string } };
  expect(item.item.status).toBe("doing");
});
