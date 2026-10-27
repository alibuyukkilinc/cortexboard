import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/api/server.js";
import { diffLines, diffRows, diffWords, draftChanges } from "../src/core/diff.js";
import { tempProject } from "./helpers.js";

test("line and word diffs mark only what changed", () => {
  assert.deepEqual(
    diffLines("a\nb\nc", "a\nB\nc").map((l) => `${l.kind}:${l.text}`),
    ["same:a", "del:b", "add:B", "same:c"],
  );
  assert.deepEqual(diffWords("Redis, 5 min TTL.", "Redis, 10 min TTL."), [
    { kind: "same", text: "Redis, " },
    { kind: "del", text: "5" },
    { kind: "add", text: "10" },
    { kind: "same", text: " min TTL." },
  ]);
  assert.deepEqual(
    diffWords("Önbellek süresi kısa", "Önbellek süresi uzun").filter((p) => p.kind !== "same"),
    [
      { kind: "del", text: "kısa" },
      { kind: "add", text: "uzun" },
    ],
    "Turkish letters are part of a word",
  );
});

test("rows pair a replaced line with its replacement and fold long unchanged runs", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 10", "line ten");
  const rows = diffRows(before, after, 3);
  const del = rows.find((r) => r.kind === "del");
  const add = rows.find((r) => r.kind === "add");
  assert.deepEqual(del, { kind: "del", text: "line 10", old: 11, pair: "line ten" });
  assert.deepEqual(add, { kind: "add", text: "line ten", new: 11, pair: "line 10" });
  const folds = rows.filter((r) => r.kind === "fold");
  assert.equal(folds.length, 2, "one fold before the change, one after");
  assert.deepEqual(
    folds.map((f) => (f.kind === "fold" ? f.lines.length : 0)),
    [7, 6],
  );
  assert.equal(rows.filter((r) => r.kind === "same").length, 6, "three lines of context on each side");
});

test("a 500-line diff is computed well under the 100 ms drawing budget", () => {
  const before = Array.from({ length: 500 }, (_, i) => `Line ${i}: ${"words ".repeat(i % 12)}`).join("\n");
  const after = before
    .split("\n")
    .map((l, i) => (i % 7 === 0 ? `${l} changed` : l))
    .filter((_, i) => i % 11 !== 0)
    .join("\n");
  const t0 = performance.now();
  diffRows(before, after);
  const ms = performance.now() - t0;
  assert.ok(ms < 100, `${ms.toFixed(1)} ms`);
});

test("draftChanges lists changed fields and calls a large removal risky", () => {
  const page = Array.from({ length: 20 }, (_, i) => `Paragraph ${i}.`).join("\n");
  const current = { title: "Cache", summary: "Redis.", body: page, fields: { severity: "high" } };
  const small = draftChanges(current, { ...current, body: page.replace("Paragraph 3.", "Paragraph three."), fields: { severity: "low" } });
  assert.deepEqual(small.fields, [{ name: "fields.severity", before: "high", after: "low" }]);
  assert.deepEqual(small.body, { added: 1, removed: 1 });
  assert.equal(small.risky, false);

  const gutted = draftChanges(current, { ...current, body: "Paragraph 0.\nParagraph 1." });
  assert.equal(gutted.body.removed, 18);
  assert.equal(gutted.risky, true);
  assert.equal(gutted.risky_reason, "large_removal");

  // Editing every line loses nothing; neither does rewriting a short page; a new record has nothing to lose.
  assert.equal(draftChanges(current, { ...current, body: page.replaceAll("Paragraph", "Section") }).risky, false);
  assert.equal(draftChanges({ title: "x", body: "a\nb\nc" }, { title: "x", body: "d" }).risky, false);
  const fresh = draftChanges(null, { title: "New", body: "Hello" });
  assert.equal(fresh.new, true);
  assert.equal(fresh.risky, false);
});

test("a risky draft is refused in a batch but can be approved on its own; the list carries each draft's size", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const H = { host: "localhost:4747", authorization: `Bearer ${t.init.tokens.owner}` };
  try {
    const body = Array.from({ length: 12 }, (_, i) => `Fact ${i}.`).join("\n");
    t.cortex.putNode(t.human, { path: "backend/cache", title: "Cache", summary: "Redis.", body });
    t.cortex.putNode(t.human, { path: "backend/queue", title: "Queue", summary: "Jobs.", body: "One." });
    const risky = t.cortex.putNode(t.ai, { path: "backend/cache", title: "Cache", summary: "Redis.", body: "Fact 0.", reason: "trim" }).draft_id!;
    const fine = t.cortex.putNode(t.ai, { path: "backend/queue", title: "Queue", summary: "Jobs.", body: "One.\nTwo.", reason: "add" }).draft_id!;

    const list = (await app.inject({ url: "/api/approvals", headers: H })).json();
    const size = (id: string) => list.drafts.find((d: { id: string }) => d.id === id).changes;
    assert.deepEqual(size(risky), { added: 0, removed: 11, fields: 0, new: false, risky: true });
    assert.deepEqual(size(fine), { added: 1, removed: 0, fields: 0, new: false, risky: false });
    assert.equal(list.total, 2);
    const page = (await app.inject({ url: "/api/approvals?limit=1&offset=1", headers: H })).json();
    assert.equal(page.drafts.length, 1);
    assert.equal(page.total, 2);

    const one = (await app.inject({ url: `/api/approvals/${risky}`, headers: H })).json();
    assert.equal(one.changes.risky, true);
    assert.deepEqual(one.changes.body, { added: 0, removed: 11 });

    const bulk = (await app.inject({ method: "POST", url: "/api/approvals/approve", headers: H, payload: { ids: [risky, fine] } })).json();
    assert.deepEqual(bulk.done, [fine]);
    assert.deepEqual(
      bulk.failed.map((f: { id: string; code: string }) => [f.id, f.code]),
      [[risky, "risky_draft"]],
    );
    const single = await app.inject({ method: "POST", url: `/api/approvals/${risky}/approve`, headers: H });
    assert.equal(single.statusCode, 200, "on its own, after reading, it goes through");
    assert.equal(t.cortex.tree.read("backend/cache")?.body.trim(), "Fact 0.");

    // The inbox's draft rows carry the same size, so a risky one gets no quick approve.
    const again = t.cortex.putNode(t.ai, { path: "backend/queue", title: "Queue", summary: "Jobs.", body: "", reason: "empty" }).draft_id!;
    const inbox = (await app.inject({ url: "/api/inbox", headers: H })).json();
    assert.equal(inbox.items.find((r: { id: string }) => r.id === again)?.changes?.new, false);
  } finally {
    await app.close();
    t.cleanup();
  }
});
