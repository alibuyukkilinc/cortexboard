import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createLoginCode } from "../src/api/auth.js";

// UI-12: the main screens look the same as their reference images, on a phone and a wide screen, light and
// dark (run with playwright.visual.config.ts). References are rendered on Linux by the "Visual baselines"
// workflow and committed under e2e/__screenshots__; a screen without one is skipped, not failed, so the suite
// can land before its first references. Times are masked: "2 min ago" changes between runs.
const SHOTS = ["inbox", "board/task", "knowledge/backend/auth", "approvals", "activity"];

for (const route of SHOTS) {
  test(`${route} looks the same`, async ({ page }, info) => {
    const name = `${route.replace(/\//g, "-")}.png`;
    test.skip(
      info.config.updateSnapshots !== "all" && !existsSync(info.snapshotPath(name)),
      "no reference image yet: run the Visual baselines workflow and commit e2e/__screenshots__",
    );
    const tokens = JSON.parse(readFileSync(join(import.meta.dirname, ".state", "tokens-visual.json"), "utf8")) as Record<string, string>;
    await page.goto(`/login?code=${encodeURIComponent(createLoginCode("owner", tokens.owner))}`);
    await expect(page.locator(".sidebar")).toBeVisible();
    await page.goto(`/#/${route}`);
    await expect(page.locator(".skeleton")).toHaveCount(0);
    await expect(page).toHaveScreenshot(name, { fullPage: true, mask: [page.locator("time"), page.locator(".live")] });
  });
}
