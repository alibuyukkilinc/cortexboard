import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildServer } from "../src/api/server.js";
import { bootstrapPrompt } from "../src/core/init.js";
import { gitProject, tempProject } from "./helpers.js";

test("bulk approve: parents before children, failures reported without stopping the rest", () => {
  const t = tempProject();
  try {
    // Proposed child-first on purpose: a new branch and its leaf must still approve together.
    const leaf = t.cortex.putNode(t.ai, { path: "payments", title: "Payments", summary: "branch" });
    const child = t.cortex.putNode(t.ai, { path: "payments/iyzico", title: "iyzico", summary: "leaf" });
    const conflicted = t.cortex.putNode(t.ai, { path: "backend", title: "Backend", summary: "AI version." });
    t.cortex.putNode(t.human, { path: "backend", title: "Backend", summary: "Human edited meanwhile." });

    assert.throws(() => t.cortex.approveMany(t.ai, [leaf.draft_id!]), /Only human/);
    const r = t.cortex.approveMany(t.human, [child.draft_id!, conflicted.draft_id!, leaf.draft_id!, "01ZZZZZZZZZZZZZZZZZZZZZZZZ"]);
    assert.deepEqual(r.done.sort(), [leaf.draft_id!, child.draft_id!].sort());
    assert.deepEqual(r.failed.map((f) => f.code).sort(), ["conflict", "not_found"]);
    assert.equal(t.cortex.node("payments/iyzico").summary, "leaf");
    assert.equal(t.cortex.node("backend").summary, "Human edited meanwhile.");
    assert.equal(t.cortex.listDrafts().length, 1, "the conflicted draft stays for a one-by-one look");

    const rej = t.cortex.rejectMany(t.human, [conflicted.draft_id!], "outdated");
    assert.equal(rej.done.length, 1);
    assert.equal(t.cortex.listDrafts().length, 0);
  } finally {
    t.cleanup();
  }
});

test("an AI revising its own pending draft replaces it; other actors' drafts stay", () => {
  const t = tempProject();
  try {
    const first = t.cortex.putNode(t.ai, { path: "backend", title: "Backend", summary: "v1" });
    const second = t.cortex.putNode(t.ai, { path: "backend", title: "Backend", summary: "v2" });
    assert.match(second.message, /Replaced your earlier draft/);
    const drafts = t.cortex.listDrafts();
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].id, second.draft_id);
    assert.notEqual(first.draft_id, second.draft_id);
    assert.equal(drafts[0].summary, "v2");
  } finally {
    t.cleanup();
  }
});

test("writing language is a human rule: first in the brief, validated, changes rules_version", () => {
  const t = tempProject();
  try {
    assert.equal(t.cortex.language(), "en");
    assert.match(t.cortex.brief(t.ai).rules.global[0], /English \(en\)/);

    const file = join(t.cortex.project.dir, "rules", "_global.yaml");
    const before = t.cortex.meta().rules_version;
    const bad = readFileSync(file, "utf8").replace("language: en", "language: Türkçe!!");
    assert.throws(
      () => t.cortex.saveRules(t.human, "_global", bad),
      (e: { hint?: { issues?: string[] } }) => !!e.hint?.issues?.some((i) => i.startsWith("language:")),
    );
    assert.throws(() => t.cortex.saveRules(t.ai, "_global", bad), /humans/);

    t.cortex.saveRules(t.human, "_global", readFileSync(file, "utf8").replace("language: en", "language: tr"));
    const brief = t.cortex.brief(t.ai);
    assert.match(brief.rules.global[0], /Turkish \(tr\)/);
    assert.notEqual(t.cortex.meta().rules_version, before);
    assert.match(bootstrapPrompt("demo", [], "tr"), /Turkish \(tr\)/);

    // No language key (older projects): no rule, nothing breaks.
    writeFileSync(file, "rules:\n  - Be nice.\n");
    assert.equal(t.cortex.language(), null);
    assert.deepEqual(t.cortex.brief(t.ai).rules.global, ["Be nice."]);
  } finally {
    t.cleanup();
  }
});

test("REST: /counts answers the sidebar badges without sending the lists", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const H = (token: string) => ({ host: "localhost:4747", authorization: `Bearer ${token}` });
  try {
    t.cortex.putNode(t.ai, { path: "backend/a", title: "A", summary: "a" });
    t.cortex.putNode(t.ai, { path: "backend/b", title: "B", summary: "b" });
    t.cortex.items.create(t.ai, { type: "question", title: "Which queue?", assignee: "@humans", fields: { blocking: true } });

    const counts = await app.inject({ url: "/api/counts", headers: H(t.init.tokens.owner) });
    assert.equal(counts.statusCode, 200);
    const body = counts.json();
    assert.equal(body.approvals, 2);
    assert.equal(body.inbox, 3, "the whole queue a person sees: the question and the two drafts");
    assert.equal(body.stale, 0);

    // The point of the endpoint: a badge costs a few hundred bytes, not the lists behind it.
    const list = await app.inject({ url: "/api/approvals", headers: H(t.init.tokens.owner) });
    assert.equal(list.json().drafts.length, 2);
    assert.ok(counts.body.length * 4 < list.body.length, `counts ${counts.body.length}B vs approvals ${list.body.length}B`);

    // An AI counts only the drafts it proposed itself, the same rule the list follows.
    const asAi = await app.inject({ url: "/api/counts", headers: H(t.init.tokens["ai-agent"]) });
    assert.equal(asAi.json().approvals, 2, "in a single project every actor sees every draft");
  } finally {
    await app.close();
    t.cleanup();
  }
});

test("REST: bulk approve and reject are human-only and report per draft", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const H = (token: string) => ({ host: "localhost:4747", authorization: `Bearer ${token}` });
  try {
    const a = t.cortex.putNode(t.ai, { path: "backend/a", title: "A", summary: "a" }).draft_id!;
    const b = t.cortex.putNode(t.ai, { path: "backend/b", title: "B", summary: "b" }).draft_id!;
    const asAi = await app.inject({ method: "POST", url: "/api/approvals/approve", headers: H(t.init.tokens["ai-agent"]), payload: { ids: [a] } });
    assert.equal(asAi.statusCode, 403);
    const empty = await app.inject({ method: "POST", url: "/api/approvals/approve", headers: H(t.init.tokens.owner), payload: { ids: [] } });
    assert.equal(empty.statusCode, 400);
    const ok = await app.inject({ method: "POST", url: "/api/approvals/approve", headers: H(t.init.tokens.owner), payload: { ids: [a] } });
    assert.deepEqual(ok.json().done, [a]);
    const rej = await app.inject({ method: "POST", url: "/api/approvals/reject", headers: H(t.init.tokens.owner), payload: { ids: [b], reason: "no" } });
    assert.deepEqual(rej.json().done, [b]);
    assert.equal(t.cortex.listDrafts().length, 0);
  } finally {
    await app.close();
    t.cleanup();
  }
});

test("brief stays small after a bootstrap with dozens of drafts", async () => {
  const { estimateTokens } = await import("../src/util/text.js");
  const t = tempProject();
  try {
    for (let i = 0; i < 30; i++) t.cortex.putNode(t.ai, { path: `backend/part-${i}`, title: `Part ${i}`, summary: `Subsystem number ${i} of the backend.` });
    const brief = t.cortex.brief(t.ai);
    assert.equal(brief.attention.pending_approvals.count, 30);
    assert.equal(brief.attention.pending_approvals.top.length, 5);
    assert.ok(estimateTokens(brief) < 800, `brief is ${estimateTokens(brief)} tokens`);
  } finally {
    t.cleanup();
  }
});

test("approving a draft pins it to HEAD when its files did not change since it was proposed", () => {
  const p = gitProject();
  try {
    const draft = p.cortex.putNode(p.ai, {
      path: "backend/auth",
      title: "Auth",
      summary: "Tokens.",
      reason: "doc",
      links: { code: [{ file: "src/auth/token.ts" }] },
    });
    p.write("README.md", "# demo\nunrelated\n");
    const head = p.commit("unrelated work while the draft waited");

    const r = p.cortex.approve(p.human, draft.draft_id!);
    assert.equal(r.warning, undefined);
    assert.equal(p.cortex.node("backend/auth").verified_at_commit, head, "not the commit it was proposed at");
    p.cortex.staleness.refresh(true);
    assert.equal(p.cortex.staleness.get("backend/auth"), undefined, "approved knowledge is not stale on arrival");
  } finally {
    p.cleanup();
  }
});

test("approving a draft whose files changed keeps the old pin and says so, unless the approver vouches for HEAD", () => {
  const p = gitProject();
  try {
    const put = (path: string) =>
      p.cortex.putNode(p.ai, { path, title: path, summary: "ttl is 15.", reason: "doc", links: { code: [{ file: "src/auth/token.ts" }] } });
    const a = put("backend/auth");
    const b = put("backend/token");
    p.write("src/auth/token.ts", "export const ttl = 60;\n");
    const head = p.commit("ttl 60");

    const r = p.cortex.approve(p.human, a.draft_id!);
    assert.equal(r.warning, "stale_after_approval");
    assert.equal(r.stale_changes?.[0].file, "src/auth/token.ts");
    assert.equal(p.cortex.node("backend/auth").verified_at_commit, p.first);
    p.cortex.staleness.refresh(true);
    assert.ok(p.cortex.staleness.get("backend/auth"), "a real code change is never skipped silently");

    const bulk = p.cortex.approveMany(p.human, [b.draft_id!], false, { verifyAtHead: true });
    assert.deepEqual(bulk.done, [b.draft_id]);
    assert.equal(bulk.stale_after_approval, undefined);
    assert.equal(p.cortex.node("backend/token").verified_at_commit, head);
  } finally {
    p.cleanup();
  }
});

test("an AI whose knowledge writes apply directly can still send one for review", () => {
  const t = tempProject();
  try {
    t.cortex.project.config.approval.node = "auto";
    const direct = t.cortex.putNode(t.ai, { path: "backend", title: "Backend", summary: "The API." });
    assert.equal(direct.applied, true);
    const asked = t.cortex.putNode(t.ai, { path: "backend", title: "Backend", summary: "A guess about the API.", review: true, reason: "not sure" });
    assert.equal(asked.applied, false);
    assert.ok(asked.draft_id);
    assert.equal(t.cortex.node("backend").summary, "The API.", "the live node is untouched until a person approves");
  } finally {
    t.cleanup();
  }
});
