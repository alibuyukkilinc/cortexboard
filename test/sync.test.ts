import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { Cortex } from "../src/core/cortex.js";
import { loadProject } from "../src/core/project.js";
import { mapPath } from "../src/core/sync.js";
import { tempProject } from "./helpers.js";

const node = (id: string, title: string, summary: string, body = "") =>
  `---\nid: ${id}\ntitle: ${title}\nsummary: ${summary}\nstatus: active\nupdated_by: owner\nupdated_at: 2026-09-23T12:00:00Z\n---\n\n${body}\n`;

test("mapPath names the record a changed file belongs to", () => {
  assert.deepEqual(mapPath("tree/_node.md"), { target: { k: "node", path: "" } });
  assert.deepEqual(mapPath("tree/backend.md"), { target: { k: "node", path: "backend" } });
  assert.deepEqual(mapPath("tree/backend/auth/_node.md"), { target: { k: "node", path: "backend/auth" } });
  assert.deepEqual(mapPath("tree\\backend\\auth.md"), { target: { k: "node", path: "backend/auth" } }, "Windows separators");

  const id = "01M35AS75BZVM32EFWX3HBCW4H";
  assert.deepEqual(mapPath(`items/${id}-some-slug/item.md`), { target: { k: "item", id } });
  assert.deepEqual(mapPath(`items/${id}/item.md`), { target: { k: "item", id } }, "a folder without a slug");
  assert.deepEqual(mapPath(`items/${id}-s/replies/01M35AS75BZVM32EFWX3HBCW5A.md`), { target: { k: "item", id } }, "a reply is part of its item");
  assert.deepEqual(mapPath(`drafts/${id}.md`), { target: { k: "draft", id } });
  assert.deepEqual(mapPath("activity/2026-09-23/owner.jsonl"), { target: { k: "activity", file: "2026-09-23/owner.jsonl" } });

  // Rebuild everything: these cannot be pinned to one record.
  assert.deepEqual(mapPath("tree/backend"), { rescan: true }, "a folder event may be a moved branch");
  assert.deepEqual(mapPath("activity/2026-09-23"), { rescan: true });
  assert.deepEqual(mapPath("rules/task.schema.yaml"), { rules: true });

  // Not indexed at all.
  for (const p of [".index/cortex.db", ".secrets.yaml", "cortex.config.yaml", "tree/.DS_Store", "tree/backend.md.swp", "items/not-an-id/item.md", ""]) {
    assert.equal(mapPath(p), null, p);
  }
});

test("sync indexes only what changed, and drops what was deleted", async () => {
  const t = tempProject();
  try {
    const file = join(t.root, ".cortex/tree/redis.md");
    writeFileSync(file, node("01SYNC00000000000000000001", "Redis", "Onbellek katmani."));
    const added = t.cortex.sync(["tree/redis.md"]);
    assert.deepEqual(added.errors, []);
    assert.equal(added.nodes, 1);
    assert.equal((await t.cortex.search("onbellek")).results[0]?.path, "redis");

    rmSync(file);
    t.cortex.sync(["tree/redis.md"]);
    assert.equal(t.cortex.index.getNode("redis"), null, "the node is gone from the index");
    assert.equal((await t.cortex.search("onbellek")).results.length, 0);
  } finally {
    t.cleanup();
  }
});

test("sync follows a node promoted to a branch by hand, without duplicating it", async () => {
  const t = tempProject();
  try {
    const dir = join(t.root, ".cortex/tree");
    mkdirSync(join(dir, "backend"), { recursive: true });
    renameSync(join(dir, "backend.md"), join(dir, "backend/_node.md"));
    t.cortex.sync(["tree/backend.md", "tree/backend/_node.md"]);

    const hits = (await t.cortex.search("backend")).results.filter((r) => r.path === "backend");
    assert.equal(hits.length, 1, "exactly one row survives the move");
    assert.ok(t.cortex.index.getNode("backend"), "still indexed under the same path");
  } finally {
    t.cleanup();
  }
});

test("sync picks up an item's new reply and forgets a deleted item", async () => {
  const t = tempProject();
  try {
    const { id } = t.cortex.items.create(t.human, { type: "task", title: "Kuyruk", body: "Isler birikiyor." });
    const items = join(t.root, ".cortex/items");
    const folder = readdirSync(items).find((n) => n.startsWith(id))!;
    const dir = join(items, folder);
    mkdirSync(join(dir, "replies"), { recursive: true });
    writeFileSync(join(dir, "replies", "01SYNC00000000000000000002.md"), "---\nauthor: owner\ncreated_at: 2026-09-23T12:00:00Z\n---\n\nRabbitMQ denendi.\n");
    t.cortex.sync([`items/${folder}/replies/01SYNC00000000000000000002.md`]);
    assert.equal(t.cortex.index.getItem(id)?.reply_count, 1);
    assert.ok(
      (await t.cortex.search("rabbitmq")).results.some((r) => r.id === id),
      "the reply body is searchable",
    );

    rmSync(dir, { recursive: true, force: true });
    t.cortex.sync([`items/${folder}/item.md`]);
    assert.equal(t.cortex.index.getItem(id), null);
  } finally {
    t.cleanup();
  }
});

test("syncing the same activity file twice leaves one search hit, not two", async () => {
  const t = tempProject();
  try {
    t.cortex.activity.log(t.human, { action: "deploy", summary: "Surum yayinlandi", why: "Musteri bekliyordu" });
    const day = new Date().toISOString().slice(0, 10);
    const rel = `${day}/owner.jsonl`;
    t.cortex.sync([`activity/${rel}`]);
    t.cortex.sync([`activity/${rel}`]);
    const hits = (await t.cortex.search("yayinlandi")).results;
    assert.equal(hits.length, 1, "re-reading a log file must not duplicate its search rows");
  } finally {
    t.cleanup();
  }
});

test("a broken file is skipped, its neighbours still index, and it recovers when fixed", async () => {
  const t = tempProject();
  try {
    const dir = join(t.root, ".cortex/tree");
    writeFileSync(join(dir, "bozuk.md"), "---\nthis: is: not: valid: yaml\n  - [\n---\ngovde\n");
    writeFileSync(join(dir, "saglam.md"), node("01SYNC00000000000000000003", "Saglam", "Duzgun bir dugum."));
    const r = t.cortex.sync(["tree/bozuk.md", "tree/saglam.md"]);
    assert.equal(r.errors.length, 1, "only the broken one failed");
    assert.ok(t.cortex.index.getNode("saglam"), "its neighbour was still indexed");

    writeFileSync(join(dir, "bozuk.md"), node("01SYNC00000000000000000004", "Bozuk", "Artik duzeldi."));
    assert.deepEqual(t.cortex.sync(["tree/bozuk.md"]).errors, []);
    assert.ok(t.cortex.index.getNode("bozuk"));
  } finally {
    t.cleanup();
  }
});

test("a rules change re-decides which items count as open, without touching item files", () => {
  const t = tempProject();
  try {
    t.cortex.items.create(t.human, { type: "task", title: "Bitmis is" });
    t.cortex.items.update(t.human, t.cortex.items.list({ type: "task" }).items[0].id, { status: "review" });
    assert.equal(t.cortex.index.queryItems({ open: true, limit: 50, offset: 0 }).total, 1, "review is open by default");

    const file = join(t.root, ".cortex/rules/task.schema.yaml");
    const schema = YAML.parse(readFileSync(file, "utf8"));
    schema.terminal = ["done", "review"];
    writeFileSync(file, YAML.stringify(schema));

    const r = t.cortex.sync(["rules/task.schema.yaml"]);
    assert.ok(r.reterm > 0, "the terminal flag was recomputed");
    assert.equal(t.cortex.index.queryItems({ open: true, limit: 50, offset: 0 }).total, 0, "review now counts as finished");
  } finally {
    t.cleanup();
  }
});

test("an unmappable change falls back to a full rebuild", async () => {
  const t = tempProject();
  try {
    writeFileSync(join(t.root, ".cortex/tree/gizli.md"), node("01SYNC00000000000000000005", "Gizli", "Kimse haber vermedi."));
    // Nothing named this file; a folder event is all we got.
    t.cortex.sync(["tree/backend"]);
    assert.ok(t.cortex.index.getNode("gizli"), "the rebuild found it anyway");
  } finally {
    t.cleanup();
  }
});

test("a decomposed (macOS) path maps to the same record as the composed one", () => {
  const composed = "activity/2026-09-23/özge.jsonl"; // ö as one code point
  const decomposed = "activity/2026-09-23/özge.jsonl"; // o + combining diaeresis, as macOS reports it
  assert.notEqual(composed, decomposed);
  assert.deepEqual(mapPath(decomposed), mapPath(composed));
  assert.deepEqual(mapPath(decomposed), { target: { k: "activity", file: "2026-09-23/özge.jsonl" } });
});

test("reopening indexes only what changed while Cortex was closed", () => {
  const t = tempProject();
  try {
    const keep = t.cortex.items.create(t.human, { type: "note", title: "Stays as it was" }).id;
    const gone = t.cortex.items.create(t.human, { type: "note", title: "Deleted while closed" }).id;
    const edit = t.cortex.items.create(t.human, { type: "note", title: "Edited while closed" }).id;
    t.cortex.close();

    const dirOf = (id: string) =>
      join(
        t.root,
        ".cortex/items",
        readdirSync(join(t.root, ".cortex/items")).find((n) => n.startsWith(id))!,
      );
    rmSync(dirOf(gone), { recursive: true });
    const file = join(dirOf(edit), "item.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("Edited while closed", "Edited by hand, renamed"));
    writeFileSync(join(t.root, ".cortex/tree/redis.md"), node("01SYNC00000000000000000009", "Redis", "Onbellek katmani."));

    const reopened = new Cortex(loadProject(t.root), { embedder: null });
    try {
      assert.equal(reopened.index.getItem(keep)?.title, "Stays as it was");
      assert.equal(reopened.index.getItem(gone), null, "a deleted item leaves the index");
      assert.equal(reopened.index.getItem(edit)?.title, "Edited by hand, renamed", "a hand edit is picked up");
      assert.equal(reopened.index.getNode("redis")?.title, "Redis", "a new node is picked up");
    } finally {
      reopened.close();
    }
    // Opening again with nothing changed finds nothing to do and keeps the same answers.
    const third = new Cortex(loadProject(t.root), { embedder: null });
    try {
      assert.equal(third.index.getItem(edit)?.title, "Edited by hand, renamed");
      assert.equal(third.index.getItem(gone), null);
    } finally {
      third.close();
    }
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});
