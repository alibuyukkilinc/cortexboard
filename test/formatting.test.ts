import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { sameCode } from "../src/git/git.js";
import { gitProject } from "./helpers.js";

test("sameCode: what a formatter does is the same code, anything else is not", () => {
  assert.ok(sameCode("f(a, b)", "f(\n  a,\n  b,\n)"), "re-wrapped with a trailing comma");
  assert.ok(sameCode("xs.map((x) => x + 1)", "xs.map(x => x + 1)"), "parentheses around a lone arrow parameter");
  assert.ok(!sameCode("return x", "returnx"), "a space between two words is not formatting");
  assert.ok(!sameCode("f(a, b)", "f(b, a)"));
  assert.ok(!sameCode("const ttl = 15", "const ttl = 16"));
});

// A project with Prettier installed: formatting sweeps are asked of it, and it decides.
function withPrettier(p: ReturnType<typeof gitProject>) {
  const modules = resolve("node_modules");
  symlinkSync(modules, join(p.root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  p.write("package.json", "{}\n");
  p.write(".prettierrc.json", '{ "printWidth": 40 }\n');
  p.write(".gitignore", "node_modules\n");
}

test("a formatting sweep is low; a real change in the same sweep is not", () => {
  const p = gitProject();
  try {
    withPrettier(p);
    p.write("src/pay/limits.ts", 'export const limits = { daily: 1000, monthly: 20000, currency: "TRY" };\n');
    p.write("src/pay/fees.ts", "export const fee = (amount: number) => amount * 0.02;\n");
    p.commit("limits and fees");
    p.cortex.putNode(p.human, { path: "backend/limits", title: "Limits", summary: "x", links: { code: [{ file: "src/pay/limits.ts" }] } });
    p.cortex.putNode(p.human, { path: "backend/fees", title: "Fees", summary: "x", links: { code: [{ file: "src/pay/fees.ts" }] } });

    // What `prettier --write` makes of the first (printWidth 40), and a real edit to the second.
    p.write("src/pay/limits.ts", 'export const limits = {\n  daily: 1000,\n  monthly: 20000,\n  currency: "TRY",\n};\n');
    p.write("src/pay/fees.ts", "export const fee = (amount: number) =>\n  amount * 0.03;\n");
    p.commit("format, and raise the fee");

    p.cortex.staleness.refresh(true);
    assert.equal(p.cortex.staleness.get("backend/limits")?.severity, "low");
    assert.equal(p.cortex.staleness.get("backend/fees")?.severity, "medium", "0.02 -> 0.03 is not formatting");

    // The verdicts are kept by file contents: a restart does not ask Prettier again.
    assert.ok(existsSync(join(p.root, ".cortex/.index/formatting.json")));
  } finally {
    unlinkSync(join(p.root, "node_modules")); // the link only: never let a recursive delete walk into the real node_modules
    p.cleanup();
  }
});
