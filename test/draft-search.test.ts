import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder, tempProject } from "./helpers.js";

type Hit = { kind: string; path?: string; status?: string; draft_id?: string; proposed_by?: string };
const hits = (r: { results: Record<string, unknown>[] }) => r.results as Hit[];

test("pending knowledge drafts are searchable, labelled draft, and leave the index when resolved", async () => {
  const t = tempProject();
  try {
    const d = t.cortex.putNode(t.ai, { path: "backend/queue", title: "Kuyruk", summary: "Redis tabanlı iş kuyruğu, 3 deneme." });
    let r = hits(await t.cortex.search("redis kuyruk"));
    assert.equal(r.length, 1);
    const { kind, path, status, draft_id, proposed_by } = r[0];
    assert.deepEqual(
      { kind, path, status, draft_id, proposed_by },
      { kind: "node", path: "backend/queue", status: "draft", draft_id: d.draft_id, proposed_by: "ai-agent" },
    );

    // Filters: drafts ride with nodes, never with items or a non-draft status.
    assert.equal(hits(await t.cortex.search("redis", { kinds: ["item"] })).length, 0);
    assert.equal(hits(await t.cortex.search("redis", { kinds: ["node"] })).length, 1);
    assert.equal(hits(await t.cortex.search("redis", { status: "active" })).length, 0);
    assert.equal(hits(await t.cortex.search("redis", { under: "frontend" })).length, 0);

    // A revision replaces the old draft in search too.
    const d2 = t.cortex.putNode(t.ai, { path: "backend/queue", title: "Kuyruk", summary: "Redis tabanlı iş kuyruğu, 5 deneme." });
    r = hits(await t.cortex.search("redis kuyruk"));
    assert.deepEqual(
      r.map((h) => h.draft_id),
      [d2.draft_id],
    );

    // Survives a full reindex (hand edits, git pull).
    t.cortex.reindex();
    assert.equal(hits(await t.cortex.search("redis")).length, 1);

    t.cortex.approve(t.human, d2.draft_id!);
    r = hits(await t.cortex.search("redis kuyruk"));
    assert.deepEqual(
      r.map((h) => [h.status, h.draft_id]),
      [["active", undefined]],
      "only the approved node remains",
    );

    const d3 = t.cortex.putNode(t.ai, { path: "backend/cache", title: "Önbellek", summary: "Memcached." });
    assert.equal(hits(await t.cortex.search("memcached")).length, 1);
    t.cortex.reject(t.human, d3.draft_id!);
    assert.equal(hits(await t.cortex.search("memcached")).length, 0);
  } finally {
    t.cleanup();
  }
});

test("drafts are found by meaning too", async () => {
  const fake = new FakeEmbedder();
  const t = tempProject("demo", { embedder: () => fake });
  try {
    t.cortex.putNode(t.ai, { path: "backend/odeme", title: "Ödeme", summary: "iyzico ile kart tahsilatı." });
    t.cortex.semantic.sync();
    await t.cortex.semantic.idle();
    const r = hits(await t.cortex.search("payment provider"));
    assert.equal(r[0]?.status, "draft");
    assert.equal(r[0]?.path, "backend/odeme");
  } finally {
    t.cleanup();
  }
});
