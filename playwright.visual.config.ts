import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Pixel regression (e2e/visual.spec.ts), apart from the flows: its own fresh server on its own port, so no other
// test's writes change what a screen looks like. Reference images are rendered on Linux, where CI runs
// (.github/workflows/visual-baselines.yml makes them); fonts render differently on each OS.
//   npm run build && npm run e2e:visual
const port = 4798;

export default defineConfig({
  ...base,
  testMatch: "visual.spec.ts",
  testIgnore: [],
  use: { ...base.use, baseURL: `http://localhost:${port}` },
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  expect: { ...base.expect, toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled", caret: "hide" } },
  webServer: {
    command: "npx tsx e2e/server.ts",
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    env: { E2E_PORT: String(port), E2E_TOKENS: "tokens-visual.json" },
    stdout: "pipe",
  },
});
