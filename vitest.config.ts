import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Unit and component tests for the web board (web/test). The server's tests run on node:test (`npm test`);
// flows in a real browser are Playwright's (e2e/, `npm run e2e`).
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["web/test/**/*.test.{ts,tsx}"],
    environment: "happy-dom",
    setupFiles: ["web/test/setup.ts"],
  },
});
