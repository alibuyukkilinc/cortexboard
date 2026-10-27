import { axe, expect, open, test } from "./fixtures";

// Voice typing in a real browser. The speech service is replaced by a fake that "hears" what the test puts in
// window.__say, so the flow runs without a microphone: the mic shows in the focused field, speech lands in it
// as typing would (React state included), and Escape stops listening.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    class FakeRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        (window as unknown as { __rec: FakeRecognition }).__rec = this;
      }
      stop() {
        this.onend?.();
      }
    }
    const w = window as unknown as Record<string, unknown>;
    w.SpeechRecognition = FakeRecognition; // Chromium has both names; the board prefers the unprefixed one
    w.webkitSpeechRecognition = FakeRecognition;
    w.__say = (text: string, isFinal = true) => (w.__rec as FakeRecognition).onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text } }] });
  });
});

test("speech goes into the focused field, and the mic follows focus", async ({ board }) => {
  await open(board, "board/task");
  const search = board.getByRole("search").getByRole("textbox");
  await search.click();
  const mic = board.getByRole("button", { name: /^(Type by voice|Sesle yaz)$/ });
  await expect(mic).toBeVisible();
  await mic.click();
  await expect(search).toBeFocused(); // the click kept the caret in the field
  await expect(board.getByRole("button", { name: /^(Stop voice typing|Sesle yazmayı durdur)$/ })).toHaveAttribute("aria-pressed", "true");

  await board.evaluate(() => (window as unknown as { __say: (t: string, f?: boolean) => void }).__say("rate lim", false));
  await expect(board.locator(".dictation-bubble")).toHaveText("rate lim");
  await board.evaluate(() => (window as unknown as { __say: (t: string) => void }).__say("rate limiting"));
  await expect(search).toHaveValue("Rate limiting");
  await board.keyboard.press("Escape");
  await expect(mic).toBeVisible();
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await board.keyboard.press("Enter");
  await expect(board).toHaveURL(/#\/search\?q=Rate(\+|%20)limiting/);

  // In a dialog: the new item's title, filled by voice, is what gets saved.
  await open(board, "board/task");
  await board.getByRole("button", { name: /^(New|Yeni)$/ }).click();
  const title = board.getByRole("dialog").getByRole("textbox").first();
  await title.focus();
  await board.keyboard.press("Control+Shift+Space");
  await board.evaluate(() => (window as unknown as { __say: (t: string) => void }).__say("sesli başlık"));
  await expect(title).toHaveValue(/^(Sesli|Sesli) başlık$/);
  expect(await axe(board)).toEqual([]);
});

// A dialog slides in when it opens and its first field is focused on the way: the mic must end up centred in
// the field once the dialog stops moving, not where the field was mid-animation (issue 01M3P0Y1ETHVN73PKNYRMHGFG1).
test("the mic sits in the field of a dialog that is still sliding in", async ({ board }) => {
  await open(board, "board/task");
  await board.getByRole("button", { name: /^(New|Yeni)$/ }).click();
  const title = board.getByRole("dialog").getByRole("textbox").first();
  await title.focus();
  const mic = board.locator(".dictation");
  await expect(mic).toBeVisible();
  // Once the dialog has stopped moving (its pop animation is 0.18 s, and content arriving late can still push the
  // field down) the mic is centred in it. Waited for, not slept on: a busy machine paints frames late.
  await expect
    .poll(
      async () => {
        const [field, button] = await Promise.all([title.boundingBox(), mic.boundingBox()]);
        return Math.abs(button!.y + button!.height / 2 - (field!.y + field!.height / 2));
      },
      { timeout: 5000 },
    )
    .toBeLessThan(1);
});
