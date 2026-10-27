// The board under test: a real Cortex server on localhost with a small, fixed project behind it.
// Playwright starts this (playwright.config.ts → webServer). It serves the last build in dist/web, so run
// `npm run build` first.
//
//   E2E_PROJECT=<dir>  use an existing project instead (e.g. one made by scripts/seed-large.ts, to measure)
//   E2E_PORT=<n>       default 4799
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/api/server.js";
import { Cortex } from "../src/core/cortex.js";
import { initProject } from "../src/core/init.js";
import { loadProject, loadTokens } from "../src/core/project.js";

const port = Number(process.env.E2E_PORT ?? 4799);
const given = process.env.E2E_PROJECT;
const root = given ?? mkdtempSync(join(tmpdir(), "cortex-e2e-"));
if (!given) initProject(root, "e2e", { language: "en", timezone: "UTC", bootstrapTask: false });

const cortex = new Cortex(loadProject(root), { embedder: null });
if (!given) seed(cortex);

// The fixtures log in as the owner with a signed code made from this token (see e2e/fixtures.ts).
const stateDir = join(import.meta.dirname, ".state");
mkdirSync(stateDir, { recursive: true });
// A second server (the visual run, playwright.visual.config.ts) writes its own file, so neither logs into the other.
writeFileSync(join(stateDir, process.env.E2E_TOKENS ?? "tokens.json"), JSON.stringify(loadTokens(join(root, ".cortex"))));

const app = buildServer(cortex);
await app.listen({ port, host: "127.0.0.1" });
console.log(`e2e board on http://localhost:${port} (project ${root})`);

const stop = async () => {
  await app.close();
  cortex.close();
  if (!given) rmSync(root, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

// Something on every screen: open work in each column, a question and a decision waiting on a person, an
// AI draft to approve, and a few activity entries.
function seed(c: Cortex) {
  const human = c.actor("owner");
  const ai = c.actor("ai-agent");
  c.putNode(human, { path: "backend", title: "Backend", summary: "API server, storage and the rules behind them.", body: "## Backend\n\nFastify API." });
  c.putNode(human, { path: "backend/auth", title: "Auth", summary: "Login links and sessions.", body: "Signed login codes, HttpOnly cookie." });
  c.putNode(human, { path: "frontend", title: "Frontend", summary: "The web board.", body: "React + Vite." });
  const task = c.items.create(ai, {
    type: "task",
    title: "Add rate limiting to login",
    category_path: "backend/auth",
    assignee: "@ai",
    body: "## Steps\n- [x] Design\n- [ ] Build\n- [ ] Test",
  });
  c.items.reply(ai, task.id, { body: "Done: limiter in `src/api/limiter.ts`.\n\n```bash\nnpm test\n```", status: "review" });
  c.items.create(human, { type: "task", title: "Write the release notes", category_path: "frontend", assignee: "owner" });
  c.items.create(ai, { type: "issue", title: "Login returns 500 on a wrong password", category_path: "backend/auth", fields: { severity: "high" } });
  c.items.create(ai, {
    type: "question",
    title: "Should sessions last 30 days?",
    category_path: "backend/auth",
    assignee: "@humans",
    fields: { blocking: true },
  });
  c.items.create(ai, {
    type: "decision",
    title: "Use signed login links",
    category_path: "backend/auth",
    fields: { context: "The board needs a login without passwords." },
  });
  c.items.create(human, { type: "note", title: "Staging runs on port 4800", category_path: "backend" });
  c.putNode(ai, {
    path: "backend/auth",
    title: "Auth",
    summary: "Login links and sessions.",
    body: "Signed login codes, HttpOnly cookie.\n\nCodes expire after 10 minutes.",
    reason: "Add expiry",
  });
  c.activity.log(ai, {
    action: "code_change",
    summary: "Add login rate limiting",
    why: "Brute-force attempts in the logs.",
    files: ["src/api/limiter.ts"],
    refs: [task.id],
  });
  c.activity.log(human, { action: "docs", summary: "Document the staging port", why: "People kept asking." });
}
