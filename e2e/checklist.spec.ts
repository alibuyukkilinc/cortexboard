import { readFileSync } from "node:fs";
import { join } from "node:path";
import { axe, expect, open, test } from "./fixtures";

// An epic's steps: the board card shows how many are done, and a step is ticked in the drawer (UI-6).
// Each project makes its own epic: the server is shared.
const tokens = () => JSON.parse(readFileSync(join(import.meta.dirname, ".state", "tokens.json"), "utf8")) as Record<string, string>;
const as = (who: string) => ({ authorization: `Bearer ${tokens()[who]}` });

test("a 13-step epic shows its progress on the board and a step is ticked in the drawer", async ({ board, request }, info) => {
  const title = `Epic (${info.project.name})`;
  const steps = Array.from({ length: 13 }, (_, i) => `- [${i < 4 ? "x" : " "}] Step ${i + 1}`).join("\n");
  const created = await request.post("/api/items", { headers: as("owner"), data: { type: "task", title, body: `## Steps\n${steps}` } });
  const { id } = (await created.json()) as { id: string };

  await open(board, "board/task");
  const card = board.locator(".kcard", { hasText: title });
  await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "4");
  await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "13");

  await open(board, `item/${id}`);
  const drawer = board.getByRole("dialog");
  const boxes = drawer.locator(".md input[type=checkbox]");
  await expect(boxes).toHaveCount(13);
  await expect(boxes.nth(4)).toBeEnabled();
  await boxes.nth(4).check();
  await expect(drawer.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "5");
  expect(await axe(board)).toEqual([]);

  const item = (await (await request.get(`/api/items/${id}`, { headers: as("owner") })).json()) as { item: { body: string } };
  expect(item.item.body).toContain("- [x] Step 5");
});
