import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Cortex } from "../src/core/cortex.js";
import { loadProject } from "../src/core/project.js";
import type { Embedder } from "../src/search/embedder.js";
import { FakeEmbedder, tempProject } from "./helpers.js";

function withFake() {
  const fake = new FakeEmbedder();
  const t = tempProject("demo", { embedder: () => fake });
  return { ...t, fake };
}

test("semantic search finds meaning across languages without shared words", async () => {
  const t = withFake();
  try {
    t.cortex.putNode(t.human, {
      path: "frontend/perf",
      title: "Sayfa yavaş açılıyordu",
      summary: "Görseller lazy-load yapıldı, ilk yükleme 3.2 sn'den 1.1 sn'ye indi.",
    });
    t.cortex.putNode(t.human, { path: "backend/odeme", title: "Ödeme", summary: "iyzico ile kart tahsilatı." });
    t.cortex.putNode(t.human, { path: "security/secrets", title: "Gizli anahtarlar", summary: "Üretimde Vault." });
    t.cortex.semantic.sync();
    await t.cortex.semantic.idle();
    const st = t.cortex.semantic.status();
    assert.equal(st.state, "ready");
    assert.equal(st.indexed, st.total);

    t.cortex.putNode(t.human, {
      path: "backend/siparis",
      title: "Sipariş iki kez onaylanıyordu",
      summary: "Webhook tekrarı aynı kaydı ikinci kez işliyordu; artık tekil.",
    });
    t.cortex.semantic.sync();
    await t.cortex.semantic.idle();

    const r = await t.cortex.search("orders were confirmed twice");
    assert.equal(r.mode, "hybrid");
    assert.equal(r.results[0]?.path, "backend/siparis", "English query, Turkish document, no common word");
    assert.equal(r.results[0]?.match, "semantic");

    // Nothing related: the similarity threshold keeps noise out.
    const none = await t.cortex.search("karpuz fiyatları");
    assert.equal(none.results.filter((x) => x.match !== "keyword").length, 0);
  } finally {
    t.cleanup();
  }
});

test("hybrid ranking puts documents found by both keyword and meaning first", async () => {
  const t = withFake();
  try {
    t.cortex.putNode(t.human, { path: "backend/odeme", title: "Ödeme akışı", summary: "iyzico ile checkout." });
    t.cortex.putNode(t.human, { path: "backend/fatura", title: "Fatura", summary: "Ödeme sonrası e-fatura kesilir." });
    t.cortex.putNode(t.human, { path: "backend/kart", title: "Kayıtlı kartlar", summary: "Kart saklama iyzico tarafında." });
    t.cortex.semantic.sync();
    await t.cortex.semantic.idle();
    const r = await t.cortex.search("ödeme akışı");
    assert.equal(r.results[0]?.path, "backend/odeme");
    assert.equal(r.results[0]?.match, "both");
    assert.ok(
      r.results.some((x) => x.path === "backend/kart" && x.match === "semantic"),
      "meaning-only matches are still listed",
    );
  } finally {
    t.cleanup();
  }
});

test("filters apply to semantic hits too", async () => {
  const t = withFake();
  try {
    t.cortex.putNode(t.human, { path: "backend/odeme", title: "Ödeme", summary: "iyzico." });
    t.cortex.items.create(t.human, { type: "decision", title: "Payment provider", category_path: "backend", fields: { context: "Need card payments" } });
    t.cortex.activity.log(t.ai, { action: "investigation", summary: "Checked checkout code" });
    t.cortex.semantic.sync();
    await t.cortex.semantic.idle();

    const items = await t.cortex.search("tahsilat", { kinds: ["item"] });
    assert.deepEqual(
      items.results.map((x) => x.kind),
      ["item"],
    );
    const underFront = await t.cortex.search("tahsilat", { under: "frontend" });
    assert.equal(underFront.results.length, 0);
    const decisions = await t.cortex.search("tahsilat", { type: "decision" });
    assert.equal(decisions.results[0]?.type, "decision");
  } finally {
    t.cleanup();
  }
});

test("embeddings are incremental and survive restarts", async () => {
  const t = withFake();
  try {
    t.cortex.putNode(t.human, { path: "backend/odeme", title: "Ödeme", summary: "iyzico." });
    t.cortex.semantic.sync();
    await t.cortex.semantic.idle();
    const first = t.fake.embedded;
    assert.ok(first > 0);

    // One edit -> exactly one document re-embedded.
    t.cortex.putNode(t.human, { path: "backend/odeme", title: "Ödeme", summary: "iyzico ve taksit." });
    t.cortex.semantic.sync();
    await t.cortex.semantic.idle();
    const afterEdit = t.fake.embedded;
    // +1 for the node; the edit also writes one audit activity, which is not a searchable document.
    assert.equal(afterEdit - first, 1);

    // A deleted file disappears from the vector store after a reindex.
    t.cortex.putNode(t.human, { path: "backend/eski", title: "Eski modül", summary: "Kaldırılacak." });
    t.cortex.semantic.sync();
    await t.cortex.semantic.idle();
    rmSync(join(t.root, ".cortex/tree/backend/eski.md"));
    t.cortex.reindex();
    t.cortex.semantic.sync();
    await t.cortex.semantic.idle();
    assert.ok(!t.cortex.index.embeddings().some((e) => e.ref === "backend/eski"));

    // Restart: vectors come from SQLite, nothing is embedded again (apart from the model warm-up).
    t.cortex.close();
    const fake2 = new FakeEmbedder();
    const again = new Cortex(loadProject(t.root), { embedder: () => fake2 });
    try {
      await again.semantic.idle();
      assert.equal(fake2.embedded, 1, "only the warm-up call");
      assert.equal((await again.search("taksit")).results[0]?.path, "backend/odeme");
    } finally {
      again.close();
    }
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("a broken model never breaks search: it falls back to keywords", async () => {
  const broken: Embedder = { model: "broken", embed: async () => Promise.reject(new Error("onnx failed to load")) };
  const t = tempProject("demo", { embedder: () => broken });
  try {
    t.cortex.putNode(t.human, { path: "backend/odeme", title: "Ödeme", summary: "iyzico." });
    t.cortex.semantic.sync();
    await t.cortex.semantic.idle();
    assert.equal(t.cortex.semantic.status().state, "error");
    assert.match(t.cortex.semantic.status().error ?? "", /onnx failed/);
    const r = await t.cortex.search("odeme");
    assert.equal(r.mode, "keyword");
    assert.equal(r.results[0]?.path, "backend/odeme");
    assert.equal(t.cortex.brief(t.ai).search, "keyword");
  } finally {
    t.cleanup();
  }
});

test("without an embedder search stays keyword-only and says so", async () => {
  const t = tempProject();
  try {
    const r = await t.cortex.search("backend");
    assert.equal(r.mode, "keyword");
    assert.equal(r.semantic.state, "off");
    assert.equal(r.results[0]?.match, "keyword");
  } finally {
    t.cleanup();
  }
});
