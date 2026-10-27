import { defineConfig, devices } from "@playwright/test";

// Flows in a real browser: the board served by e2e/server.ts, on a phone and a wide screen, light and dark.
// CI runs this on Linux only (.github/workflows/ci.yml → e2e). Locally: npm run build && npm run e2e
const port = Number(process.env.E2E_PORT ?? 4799);
const wide = { viewport: { width: 1440, height: 900 } };
const phone = { ...devices["Pixel 7"], viewport: { width: 375, height: 812 } }; // Chromium with touch, at the smallest common width

export default defineConfig({
  testDir: "e2e",
  testIgnore: "visual.spec.ts", // pixel regression has its own server: playwright.visual.config.ts
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"], ["html", { open: "never" }]] : "list", // "github": a failing test shows up as an annotation on the run
  // Reduced motion turns transitions off (styles.css): axe then measures a button, not a button halfway through a fade.
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure", reducedMotion: "reduce" },
  // Parallel pages share one server, and another page's write refreshes the lists that show it: give loads room.
  expect: { timeout: 15_000 },
  projects: [
    { name: "wide-light", use: { ...wide, colorScheme: "light" } },
    { name: "wide-dark", use: { ...wide, colorScheme: "dark" } },
    { name: "phone-light", use: { ...phone, colorScheme: "light" } },
    { name: "phone-dark", use: { ...phone, colorScheme: "dark" } },
  ],
  webServer: {
    command: "npx tsx e2e/server.ts",
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: !process.env.CI,
    env: { E2E_PORT: String(port), ...(process.env.E2E_PROJECT ? { E2E_PROJECT: process.env.E2E_PROJECT } : {}) },
    stdout: "pipe",
  },
});
