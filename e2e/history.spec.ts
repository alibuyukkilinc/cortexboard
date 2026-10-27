import { readFileSync } from "node:fs";
import { join } from "node:path";
import { axe, expect, open, test } from "./fixtures";

// A handoff section an agent overwrote comes back from the item's History in one click (UI-3). Each project
// makes its own item: the server is shared.
const tokens = () => JSON.parse(readFileSync(join(import.meta.dirname, ".state", "tokens.json"), "utf8")) as Record<string, string>;
const as = (who: string) => ({ authorization: `Bearer ${tokens()[who]}` });

test("a lost handoff section comes back from History", async ({ board, request }, info) => {
  const title = `Export invoices (${info.project.name})`;
  const body = ["## Goal", "Ship the export.", "", "## Handoff", "Left off at the CSV writer; dates need a timezone.", "", "Details. ".repeat(30)].join("\n");
  const created = await request.post("/api/items", { headers: as("owner"), data: { type: "task", title, body } });
  const { id } = (await created.json()) as { id: string };
  const shrink = await request.patch(`/api/items/${id}`, { headers: as("ai-agent"), data: { body: "## Goal\nShip the export." } });
  expect(shrink.status(), "an agent cannot cut the body in half by accident").toBe(409);
  await request.patch(`/api/items/${id}`, { headers: as("ai-agent"), data: { body: "## Goal\nShip the export.", confirm_shrink: true } });

  await open(board, `item/${id}`);
  const drawer = board.getByRole("dialog");
  await expect(drawer.getByText("Left off at the CSV writer")).toHaveCount(0);
  await drawer.locator("details.history > summary").click();
  await drawer.locator(".history-row").first().click();
  await expect(drawer.locator(".diffv")).toBeVisible();
  expect(await axe(board)).toEqual([]);

  await drawer.getByRole("button", { name: /^(Restore this version|Bu sürüme dön)$/ }).click();
  const confirm = board.getByRole("dialog", { name: /^(Restore this version|Bu sürüme dön)$/ });
  await confirm.getByRole("button", { name: /^(Restore this version|Bu sürüme dön)$/ }).click();
  await expect(drawer.getByText("Left off at the CSV writer; dates need a timezone.")).toBeVisible();
});
