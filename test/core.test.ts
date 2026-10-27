import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { initProject } from "../src/core/init.js";
import { Cortex } from "../src/core/cortex.js";
import { loadProject } from "../src/core/project.js";
import type { CortexError } from "../src/core/types.js";
import { estimateTokens, ulid } from "../src/util/text.js";
import { tempProject } from "./helpers.js";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as CortexError).code;
  }
  return "no_error";
};

test("ids made in the same millisecond still sort in the order they were made", () => {
  const now = Date.now();
  const sameMs = Array.from({ length: 50 }, () => ulid(now));
  assert.deepEqual(sameMs, [...sameMs].sort(), 'a report\'s "newest first" must not depend on the machine');
  assert.equal(new Set(sameMs).size, 50);
  assert.ok(ulid(now) < ulid(now + 1), "later milliseconds still sort later");

  const burst = Array.from({ length: 2000 }, () => ulid());
  assert.deepEqual(burst, [...burst].sort());
});

test("init creates the layout, default branches and git-ignored secrets", () => {
  const t = tempProject();
  try {
    const dir = join(t.root, ".cortex");
    for (const p of ["cortex.config.yaml", ".secrets.yaml", "rules/_global.yaml", "tree/_node.md", "tree/backend.md", "tree/seo.md"]) {
      assert.ok(existsSync(join(dir, p)), `missing ${p}`);
    }
    assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /\.secrets\.yaml/);
    assert.equal(
      code(() => initProject(t.root)),
      "already_initialized",
    );
  } finally {
    t.cleanup();
  }
});

test("brief is small and lists the top-level branches", () => {
  const t = tempProject();
  try {
    const brief = t.cortex.brief(t.ai);
    assert.deepEqual(
      brief.branches.map((b) => b.path),
      ["backend", "code-structure", "frontend", "mobile", "security", "seo", "server"],
    );
    assert.ok(brief.rules.global.length > 0);
    assert.ok(estimateTokens(brief) < 800, `brief is ${estimateTokens(brief)} tokens`);
  } finally {
    t.cleanup();
  }
});

test("humans write directly; a leaf becomes a branch when it gets a child", () => {
  const t = tempProject();
  try {
    const r1 = t.cortex.putNode(t.human, { path: "backend/auth", title: "Auth", summary: "Login and sessions." });
    assert.equal(r1.applied, true);
    t.cortex.putNode(t.human, { path: "backend/auth/jwt-refresh", title: "JWT refresh", summary: "15 min access, 30 day refresh.", body: "Details" });

    assert.ok(existsSync(join(t.root, ".cortex/tree/backend/auth/_node.md")));
    const view = t.cortex.treeView("backend", 2);
    assert.equal(view.node.children?.[0].path, "backend/auth");
    assert.equal(view.node.children?.[0].children?.[0].path, "backend/auth/jwt-refresh");
    assert.equal("body" in (view.node.children?.[0].children?.[0] ?? {}), false, "tree must never include bodies");
    assert.equal(t.cortex.node("backend/auth/jwt-refresh").body, "Details");

    const id = t.cortex.node("backend/auth").id;
    t.cortex.putNode(t.human, { path: "backend/auth", title: "Auth", summary: "Changed." });
    assert.equal(t.cortex.node("backend/auth").id, id, "id stays stable across updates");
  } finally {
    t.cleanup();
  }
});

test("AI writes become drafts that only humans can approve", () => {
  const t = tempProject();
  try {
    const r = t.cortex.putNode(t.ai, { path: "backend/payments", title: "Payments", summary: "Stripe checkout.", reason: "found in code" });
    assert.equal(r.applied, false);
    assert.ok(r.draft_id);
    assert.equal(
      code(() => t.cortex.node("backend/payments")),
      "not_found",
    );
    assert.equal(t.cortex.brief(t.ai).attention.pending_approvals.count, 1);

    assert.equal(
      code(() => t.cortex.approve(t.ai, r.draft_id!)),
      "forbidden",
    );
    t.cortex.approve(t.human, r.draft_id!);
    const n = t.cortex.node("backend/payments");
    assert.equal(n.status, "active");
    assert.equal(n.updated_by, "ai-agent");
    assert.equal(t.cortex.listDrafts().length, 0);
  } finally {
    t.cleanup();
  }
});

test("approving a draft over a node that changed meanwhile needs force", () => {
  const t = tempProject();
  try {
    const d = t.cortex.putNode(t.ai, { path: "backend", title: "Backend", summary: "AI version." });
    t.cortex.putNode(t.human, { path: "backend", title: "Backend", summary: "Human edited in the meantime." });
    assert.equal(
      code(() => t.cortex.approve(t.human, d.draft_id!)),
      "conflict",
    );
    t.cortex.approve(t.human, d.draft_id!, true);
    assert.equal(t.cortex.node("backend").summary, "AI version.");
  } finally {
    t.cleanup();
  }
});

test("invalid writes explain the rule and show an example", () => {
  const t = tempProject();
  try {
    try {
      t.cortex.putNode(t.human, { path: "backend/x", title: "", summary: "x".repeat(301) });
      assert.fail("should throw");
    } catch (e) {
      const err = e as CortexError;
      assert.equal(err.code, "invalid_node");
      const hint = err.hint as { issues: string[]; example: object };
      assert.ok(hint.issues.some((i) => i.startsWith("summary")));
      assert.ok(hint.example);
    }
    assert.equal(
      code(() => t.cortex.putNode(t.human, { path: "nope/child", title: "a", summary: "b" })),
      "parent_missing",
    );
    assert.equal(
      code(() => t.cortex.putNode(t.ai, { path: "nope/child", title: "a", summary: "b" })),
      "parent_missing",
    );
    assert.equal(
      code(() => t.cortex.node("../../etc/passwd")),
      "invalid_path",
    );
    assert.equal(
      code(() => t.cortex.putNode(t.human, { path: "Backend/..", title: "a", summary: "b" })),
      "invalid_path",
    );
  } finally {
    t.cleanup();
  }
});

test("search folds Turkish characters and ranks titles first", async () => {
  const t = tempProject();
  try {
    t.cortex.putNode(t.human, { path: "backend/auth", title: "Kullanıcı girişi", summary: "Şifre ve oturum yönetimi.", tags: ["güvenlik"] });
    t.cortex.putNode(t.human, { path: "frontend/login-page", title: "Login page", summary: "Form that calls the auth API." });

    assert.equal((await t.cortex.search("kullanici girisi")).results[0]?.path, "backend/auth");
    assert.equal((await t.cortex.search("KULLANICI")).results[0]?.path, "backend/auth");
    assert.equal((await t.cortex.search("sifre")).results[0]?.path, "backend/auth");
    assert.equal((await t.cortex.search("guvenlik")).results[0]?.path, "backend/auth");
    assert.equal((await t.cortex.search("login")).results[0]?.path, "frontend/login-page");
    assert.deepEqual(
      (await t.cortex.search("auth", { under: "frontend" })).results.map((r) => r.path),
      ["frontend/login-page"],
    );
    // Falls back to OR when no node has every term.
    assert.ok((await t.cortex.search("kullanici xyzzy")).results.length > 0);
    assert.equal("body" in (await t.cortex.search("login")).results[0], false);
  } finally {
    t.cleanup();
  }
});

test("search reaches other forms of an inflected word, without displacing exact matches", async () => {
  const t = tempProject();
  try {
    t.cortex.putNode(t.human, {
      path: "backend/staleness",
      title: "Eskime tespiti",
      summary: "Eskimiş düğümler ertelenebilir; erteleme yalnızca insanlar içindir.",
    });
    t.cortex.putNode(t.human, { path: "frontend/pages", title: "Pano ekranları", summary: "Her sayfa ayrı bir dosyada." });
    t.cortex.putNode(t.human, { path: "backend/items", title: "Kalemler", summary: "Kalem sayfalar halinde listelenir." });

    // "ertelemek" appears nowhere as written; its stem "ertele" matches "erteleme" and "ertelenebilir".
    assert.equal((await t.cortex.search("eskimiş bilgiyi ertelemek")).results[0]?.path, "backend/staleness");
    assert.equal((await t.cortex.search("ertelemek")).results[0]?.path, "backend/staleness");
    // Words as written win: "sayfalar" matches one node, so the stem "sayfa" (the other node) is never tried.
    assert.deepEqual(
      (await t.cortex.search("sayfalar")).results.map((r) => r.path),
      ["backend/items"],
    );
    // Short words are never cut: "sayfa" matches as a prefix, as before.
    assert.equal((await t.cortex.search("sayfa")).results.length, 2);
  } finally {
    t.cleanup();
  }
});

test("the index is disposable: delete it, reopen, nothing is lost", async () => {
  const t = tempProject();
  try {
    t.cortex.putNode(t.human, { path: "security/secrets", title: "Secrets", summary: "Stored in vault, never in git." });
    t.cortex.close();
    rmSync(join(t.root, ".cortex/.index"), { recursive: true, force: true });
    const fresh = new Cortex(loadProject(t.root), { embedder: null });
    assert.equal((await fresh.search("vault")).results[0]?.path, "security/secrets");
    fresh.close();
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("unknown paths suggest close matches", () => {
  const t = tempProject();
  try {
    t.cortex.putNode(t.human, { path: "backend/auth", title: "Auth", summary: "Login." });
    try {
      t.cortex.node("backend/authentication");
      assert.fail();
    } catch (e) {
      assert.ok(((e as CortexError).hint as { did_you_mean: string[] }).did_you_mean.includes("backend/auth"));
    }
  } finally {
    t.cleanup();
  }
});

test("Node version check: 22.16 is the minimum (node:sqlite has FTS5 from there)", async () => {
  const { nodeTooOld, NODE_TOO_OLD_MESSAGE } = await import("../src/util/runtime-check.js");
  assert.equal(nodeTooOld("22.15.1"), true);
  assert.equal(nodeTooOld("22.13.0"), true);
  assert.equal(nodeTooOld("20.18.0"), true);
  assert.equal(nodeTooOld("22.16.0"), false);
  assert.equal(nodeTooOld("24.1.0"), false);
  assert.match(NODE_TOO_OLD_MESSAGE("22.13.0"), /Node\.js 22\.16 or newer \(you have 22\.13\.0\)/);
});

test("brief fits its token budget: summaries shrink, branches and rules stay", async () => {
  const t = tempProject();
  try {
    // A project like a real one: many branches with full-length summaries.
    for (let i = 0; i < 12; i++) {
      t.cortex.putNode(t.human, {
        path: `branch-${i}`,
        title: `Branch ${i}`,
        summary: `${"Bu dal projenin bir parçasını anlatır ve özeti uzundur. ".repeat(5)}`.slice(0, 300),
      });
      t.cortex.items.create(t.human, { type: "question", title: `Soru ${i}`, assignee: "@ai", fields: { blocking: true } });
    }
    const brief = t.cortex.brief(t.ai);
    const size = estimateTokens(brief);
    assert.ok(size <= 800, `brief is ${size} tokens`);
    assert.equal(brief.branches.length, 19, "every branch is still listed (7 from init + 12)");
    assert.ok(brief.trimmed, "the brief says it was shortened");
    assert.equal(brief.rules.global.length, t.cortex.globalRules().length, "rules are never trimmed");
    assert.ok(brief.attention.inbox.count >= 12, "counts stay honest even when the list is short");

    // A caller that can afford more gets more.
    const big = t.cortex.brief(t.ai, 4000);
    assert.ok(estimateTokens(big) > size);
    assert.ok(
      big.branches.every((b) => !b.summary.endsWith("…")),
      "with room, summaries are complete",
    );
  } finally {
    t.cleanup();
  }
});
