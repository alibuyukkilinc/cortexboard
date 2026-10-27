import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/api/server.js";
import { Cortex } from "../src/core/cortex.js";
import { initProject, resolveBranches } from "../src/core/init.js";
import { loadProject } from "../src/core/project.js";
import type { CortexError } from "../src/core/types.js";
import { tempProject } from "./helpers.js";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as CortexError).code;
  }
  return "no_error";
};

test("init --branches: pick template branches, add your own, skip the rest", () => {
  assert.equal(resolveBranches().length, 7, "no choice = full template");
  const picked = resolveBranches(["backend", " Frontend ", "api-gateway", "backend", "a/b"]);
  assert.deepEqual(
    picked.map(([p]) => p),
    ["backend", "frontend", "api-gateway"],
  );
  assert.deepEqual(picked[2], ["api-gateway", "Api gateway", "Knowledge about api gateway."]);
  assert.throws(() => resolveBranches(["Bad Name!"]), /Invalid path segment/);

  const root = mkdtempSync(join(tmpdir(), "cortex-branches-"));
  try {
    initProject(root, "shop", { language: "tr", branches: ["backend", "frontend"] });
    const cortex = new Cortex(loadProject(root), { embedder: null });
    try {
      assert.deepEqual(
        cortex.brief(cortex.actor("ai-agent")).branches.map((b) => b.path),
        ["backend", "frontend"],
      );
    } finally {
      cortex.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init --lang tr: a Turkish project opens on a Turkish tree, and reports still see the placeholders", () => {
  assert.deepEqual(resolveBranches(["backend", "api-gateway"], "tr"), [
    ["backend", "Arka uç", "API'ler, iş mantığı, veri erişimi ve arka plan işleri."],
    ["api-gateway", "Api gateway", "api gateway hakkında bilgi."],
  ]);
  assert.equal(resolveBranches(["backend"], "de")[0][1], "Backend", "a language with no seed falls back to English");
  assert.equal(resolveBranches(["backend"])[0][1], "Backend", "no language given is English, never the machine's locale");

  const root = mkdtempSync(join(tmpdir(), "cortex-lang-"));
  try {
    initProject(root, "Kargo", { language: "tr", branches: ["backend", "mobile"], timezone: "UTC" });
    const cortex = new Cortex(loadProject(root), { embedder: null });
    try {
      assert.equal(cortex.node("backend").title, "Arka uç");
      assert.match(cortex.node("backend").summary, /arka plan işleri\. \(henüz belgelenmedi\)$/);
      assert.match(cortex.node("").summary, /^Kargo: proje özeti henüz yazılmadı/);
      // Turkish seed text still counts as "not documented yet": root + the two branches.
      assert.equal(cortex.reports.build({ since: "1d" }).knowledge.undocumented, 3);
    } finally {
      cortex.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("humans delete knowledge that does not apply; children and open items must go first", async () => {
  const t = tempProject();
  try {
    assert.equal(
      code(() => t.cortex.deleteNode(t.ai, "mobile")),
      "forbidden",
    );
    assert.equal(
      code(() => t.cortex.deleteNode(t.human, "")),
      "invalid_request",
    );
    assert.equal(
      code(() => t.cortex.deleteNode(t.human, "nope")),
      "not_found",
    );

    t.cortex.putNode(t.human, { path: "backend/queue", title: "Queue", summary: "Redis queue." });
    assert.equal(
      code(() => t.cortex.deleteNode(t.human, "backend")),
      "has_children",
    );

    const issue = t.cortex.items.create(t.human, { type: "issue", title: "Jobs retry forever", category_path: "backend/queue", fields: { severity: "low" } });
    assert.equal(
      code(() => t.cortex.deleteNode(t.human, "backend/queue")),
      "has_open_items",
    );
    t.cortex.items.update(t.human, issue.id, { status: "closed" });

    const r = t.cortex.deleteNode(t.human, "backend/queue", "moved to another service");
    assert.equal(r.applied, true);
    assert.equal(
      code(() => t.cortex.node("backend/queue")),
      "not_found",
    );
    assert.equal((await t.cortex.search("redis queue", { kinds: ["node"] })).results.length, 0);
    // backend/ went back from a folder to a single file, and a reindex does not resurrect anything.
    assert.equal(existsSync(join(t.cortex.project.dir, "tree", "backend")), false);
    assert.equal(existsSync(join(t.cortex.project.dir, "tree", "backend.md")), true);
    assert.equal(t.cortex.node("backend").title, "Backend");
    t.cortex.reindex();
    assert.equal(t.cortex.treeView("backend").node.child_count, 0);
    assert.equal(
      t.cortex.index.queryActivity({ includeSystem: true, limit: 5 }).some((a) => a.action === "node.deleted"),
      true,
    );

    t.cortex.deleteNode(t.human, "mobile");
    assert.equal(
      t.cortex.brief(t.ai).branches.some((b) => b.path === "mobile"),
      false,
    );
  } finally {
    t.cleanup();
  }
});

test("REST: DELETE /api/node is human-only and explains refusals", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const H = (token: string) => ({ host: "localhost:4747", authorization: `Bearer ${token}` });
  try {
    assert.equal((await app.inject({ method: "DELETE", url: "/api/node/seo", headers: H(t.init.tokens["ai-agent"]) })).statusCode, 403);
    t.cortex.putNode(t.human, { path: "seo/sitemap", title: "Sitemap", summary: "Daily." });
    const refused = await app.inject({ method: "DELETE", url: "/api/node/seo", headers: H(t.init.tokens.owner) });
    assert.equal(refused.statusCode, 409);
    assert.deepEqual(refused.json().error.hint.children, ["seo/sitemap"]);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/node/seo/sitemap", headers: H(t.init.tokens.owner) })).statusCode, 200);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/node/seo", headers: H(t.init.tokens.owner) })).statusCode, 200);
  } finally {
    await app.close();
    t.cleanup();
  }
});
