import { readFileSync } from "node:fs";
import { join } from "node:path";
import { axe, expect, open, test } from "./fixtures";

// UI-7's acceptance: a person's task, its steps ticked and closed with evidence from a phone. Runs on every
// project (phones included); each makes its own task.
const tokens = () => JSON.parse(readFileSync(join(import.meta.dirname, ".state", "tokens.json"), "utf8")) as Record<string, string>;
const as = (who: string) => ({ authorization: `Bearer ${tokens()[who]}` });

test("a person's task is ticked step by step and closed with evidence", async ({ board, request }, info) => {
  const title = `Renew the TLS certificate (${info.project.name})`;
  const body = "## Steps\n- [ ] Order the certificate\n- [ ] Install it on the load balancer\n\n## Acceptance criteria\n- The site shows the new expiry date";
  const created = await request.post("/api/items", { headers: as("ai-agent"), data: { type: "task", title, body, assignee: "owner" } });
  const { id } = (await created.json()) as { id: string };

  await open(board, `item/${id}`);
  const drawer = board.getByRole("dialog");
  const panel = drawer.locator(".done-panel");
  await expect(panel).toBeVisible();
  await expect(drawer.locator(".md section.acceptance")).toContainText("new expiry date");
  const boxes = drawer.locator(".md input[type=checkbox]");
  await boxes.nth(0).check();
  await expect(panel.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
  await boxes.nth(1).check();
  await expect(panel.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");

  await panel.getByLabel(/Evidence|Kanıt/).fill("not a link");
  await expect(panel.locator(".field-error")).toBeVisible();
  await expect(panel.getByRole("button", { name: /^(I did it|Yaptım)$/ })).toBeDisabled();
  await panel.getByLabel(/Evidence|Kanıt/).fill("https://ssl.example.com/order/42");
  await expect(panel.getByRole("button", { name: /^(I did it|Yaptım)$/ })).toBeEnabled();
  expect(await axe(board)).toEqual([]);
  await panel.getByRole("button", { name: /^(I did it|Yaptım)$/ }).click();
  await expect(panel).toHaveCount(0);

  const item = (await (await request.get(`/api/items/${id}`, { headers: as("owner") })).json()) as {
    item: { status: string };
    replies: { fields?: { evidence?: string[] } }[];
  };
  expect(item.item.status).toBe("done");
  expect(item.replies.at(-1)?.fields?.evidence).toEqual(["https://ssl.example.com/order/42"]);
});
