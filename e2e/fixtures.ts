import { readFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Page } from "@playwright/test";
import { createLoginCode } from "../src/api/auth.js";

// Every test starts signed in as the project owner, the way a person does: through a signed login link.
export const test = base.extend<{ board: Page }>({
  board: async ({ page }, run) => {
    const tokens = JSON.parse(readFileSync(join(import.meta.dirname, ".state", "tokens.json"), "utf8")) as Record<string, string>;
    await page.goto(`/login?code=${encodeURIComponent(createLoginCode("owner", tokens.owner))}`);
    await expect(page.locator(".sidebar")).toBeVisible();
    await run(page); // Playwright's "use", renamed: the React hooks lint rule reads any "use" call as a hook
  },
});
export { expect };

// Open a screen and wait until it has drawn its data: no loading skeleton left.
export async function open(page: Page, route: string, timeout?: number) {
  await page.goto(`/#/${route}`);
  await expect(page.locator("main.main")).toBeVisible();
  await expect(page.locator(".skeleton")).toHaveCount(0, { timeout });
  await expect(page.locator(".page-gate.waiting")).toHaveCount(0, { timeout }); // PageGate holds a page hidden while it loads
}

// WCAG 2.1 A and AA rules. Serious and critical findings fail the test; minor ones are reported only.
export async function axe(page: Page) {
  // A control fading between disabled and enabled, or a dialog still sliding, is measured halfway between two
  // colours and fails contrast for a moment that no one sees. Let every running animation and transition finish
  // (a screen never animates for good, so this ends by itself; 3 s at most), then a frame to settle.
  await page.evaluate(async () => {
    const running = Promise.allSettled(document.getAnimations().map((a) => a.finished));
    await Promise.race([running, new Promise((r) => setTimeout(r, 3000))]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const blocking = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  // The first node's own message says why (e.g. the measured contrast ratio and both colors).
  return blocking.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.nodes
        .map((n) => n.target.join(" "))
        .slice(0, 3)
        .join(" | ")} — ${v.nodes[0]?.failureSummary?.replace(/\s+/g, " ")}`,
  );
}

// Every screen of the board, for the checks that run on each (axe, phone layout).
export const SCREENS = [
  "inbox",
  "board/task",
  "board/issue",
  "discussions",
  "approvals",
  "knowledge/backend/auth",
  "stale",
  "activity",
  "archive",
  "reports",
  "rules",
  "guide",
  "search?q=login",
];
