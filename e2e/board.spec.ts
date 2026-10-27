import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, open, test } from "./fixtures";

// Board cards are a title button stretched over the card (PressCard): check that the card still does what
// a card does, with a mouse and with the keyboard.
const owner = () => (JSON.parse(readFileSync(join(import.meta.dirname, ".state", "tokens.json"), "utf8")) as Record<string, string>).owner;

test.describe("board cards", () => {
  test.skip(({ isMobile }) => isMobile, "dragging is a mouse gesture; phones use the move menu");

  test("a card is dragged to another column, clicked open, and reached by keyboard", async ({ board, request }) => {
    const title = `Drag me ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const made = await request.post("/api/items", { headers: { authorization: `Bearer ${owner()}` }, data: { type: "task", title } });
    expect(made.status()).toBe(201);

    await open(board, "board/task");
    const card = board.locator(".kcard", { hasText: title });
    const columns = board.locator(".column");
    await expect(columns.nth(0).locator(".kcard", { hasText: title })).toBeVisible();

    await card.dragTo(columns.nth(1));
    await expect(columns.nth(1).locator(".kcard", { hasText: title })).toBeVisible();

    // Clicking the card away from its title still opens it.
    const moved = columns.nth(1).locator(".kcard", { hasText: title });
    const box = (await moved.boundingBox())!;
    await board.mouse.click(box.x + box.width - 6, box.y + 6);
    await expect(board.getByRole("dialog").getByRole("heading", { name: title })).toBeVisible();
    await board.keyboard.press("Escape");

    // And the title is a button: Enter opens it from the keyboard.
    await moved.getByRole("button", { name: title }).focus();
    await board.keyboard.press("Enter");
    await expect(board.getByRole("dialog").getByRole("heading", { name: title })).toBeVisible();
  });
});

// Each type tab has its icon, and a tab with work waiting on you says how much (the seed has a proposed decision
// and a question for @humans; other tests may settle them, so any waiting tab will do).
test("type tabs show an icon and what waits on you", async ({ board }) => {
  await open(board, "board/task");
  const tabs = board.locator(".type-tabs a");
  await expect(tabs.first().locator("svg")).toBeVisible();
  expect(await tabs.locator("svg").count()).toBe(await tabs.count());
  const badge = board.locator(".tab-badge").first();
  await expect(badge).toBeVisible();
  await expect(badge.locator(".sr-only")).toHaveText(/(waiting on you|sizi bekliyor)/);
});

// A card created on the board opens over the board, and closing it goes back there (issue 01M3NPA6SARRNCF3D5S76PPGM7:
// it used to land on Notifications every time).
test("a new card opens over the page it was made on and closes back to it", async ({ board }) => {
  const title = `Stay on the board ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await open(board, "board/task");
  await board.locator(".page-head .btn.primary").click();
  await board
    .getByRole("dialog")
    .getByRole("textbox", { name: /^(Title|Başlık)/ })
    .fill(title);
  await board.getByRole("button", { name: /^(Create|Oluştur)$/ }).click();
  await expect(board.getByRole("dialog").getByRole("heading", { name: title })).toBeVisible();
  await expect(board.locator(".type-tabs")).toBeVisible(); // the board is still underneath
  await board.keyboard.press("Escape");
  await expect(board).toHaveURL(/#\/board\/task$/);
});
