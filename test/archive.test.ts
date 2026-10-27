import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { CortexError } from "../src/core/types.js";
import { buildServer } from "../src/api/server.js";
import { tempProject } from "./helpers.js";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

function err(fn: () => unknown): CortexError {
  try {
    fn();
  } catch (e) {
    return e as CortexError;
  }
  throw new Error("expected an error");
}

// A solved one-off server problem, finished long ago, plus things that must not be suggested.
function setup() {
  const t = tempProject();
  const c = t.cortex;
  const old = c.items.create(t.human, {
    type: "issue",
    title: "Nginx 502 after the certificate renewal",
    category_path: "backend",
    body: "Root cause: the renewal hook restarted the wrong service. quokkaword",
    fields: { severity: "high" },
  }).id;
  c.items.update(t.human, old, { status: "closed" });
  const fresh = c.items.create(t.human, { type: "issue", title: "Closed yesterday", category_path: "backend", fields: { severity: "low" } }).id;
  c.items.update(t.human, fresh, { status: "closed" });
  const open = c.items.create(t.human, { type: "issue", title: "Still open", category_path: "backend", fields: { severity: "low" } }).id;
  const accepted = c.items.create(t.human, { type: "decision", title: "Use Postgres", fields: { context: "x" } }).id;
  c.items.update(t.human, accepted, { status: "accepted" });
  // Age the finished ones on disk, as if they were closed two months ago.
  for (const id of [old, accepted]) {
    const item = c.itemStore.read(id)!;
    c.itemStore.write({ ...item, updated_at: ago(60) });
  }
  c.reindex();
  return { t, c, old, fresh, open, accepted };
}

test("archive: candidates are finished and old; open work, fresh closes and accepted decisions are not", () => {
  const { t, c, old } = setup();
  try {
    const refs = c.archive.candidates().candidates.map((x) => x.ref);
    assert.deepEqual(refs, [old]);
  } finally {
    t.cleanup();
  }
});

test("archive: an archived record leaves search, lists and the tree, and is still readable and searchable on request", async () => {
  const { t, c, old } = setup();
  try {
    assert.equal((await c.search("quokkaword")).results.length, 1);
    const r = c.archive.archive(t.human, [old], "One-off: the renewal hook was fixed for good.");
    assert.equal(r.results[0]!.applied, true);

    assert.equal((await c.search("quokkaword")).results.length, 0, "out of default search");
    assert.equal((await c.search("quokkaword", { archived: true })).results.length, 1, "found when asked for");
    assert.ok(!c.items.list({ type: "issue" }).items.some((i) => i.id === old));
    const read = c.items.get(old).item;
    assert.equal(read.archived?.reason, "One-off: the renewal hook was fixed for good.");
    assert.ok(read.updated_at < ago(59), "archiving keeps the real last change");

    c.reindex(); // survives a rebuild from files (the state is in the item file, not only the index)
    assert.equal((await c.search("quokkaword")).results.length, 0);

    c.archive.restore(t.human, [old]);
    assert.equal((await c.search("quokkaword")).results.length, 1);
  } finally {
    t.cleanup();
  }
});

test("archive: only finished items; an AI's archiving is a draft with its reason", () => {
  const { t, c, old, open, accepted } = setup();
  try {
    assert.equal(c.archive.archive(t.human, [open]).results[0]!.error?.code, "not_finished");
    assert.equal(c.archive.archive(t.human, [accepted]).results[0]!.error?.code, "not_finished", "an accepted decision still applies");
    assert.equal(err(() => c.archive.archive(t.ai, [old], "old")).code, "reason_required");

    const r = c.archive.archive(t.ai, [old], "The renewal hook was replaced; this cannot happen again.");
    assert.equal(r.results[0]!.applied, false);
    const draftId = r.results[0]!.draft_id!;
    assert.ok(!c.itemStore.read(old)!.archived, "nothing changes before approval");
    assert.equal(c.getDraft(draftId).draft.reason, "Archive: The renewal hook was replaced; this cannot happen again.");

    c.approve(t.human, draftId);
    assert.ok(c.itemStore.read(old)!.archived);
    assert.equal(err(() => c.archive.restore(t.ai, [old])).code, "forbidden");
  } finally {
    t.cleanup();
  }
});

test("archive: knowledge nodes leave the tree and staleness; purge deletes only what is archived, people only", () => {
  const { t, c, old } = setup();
  try {
    c.putNode(t.human, {
      path: "backend/old-queue",
      title: "Old queue",
      summary: "RabbitMQ setup we removed",
      body: "",
      links: { code: [{ file: "src/queue.ts" }] },
    } as never);
    assert.ok(c.index.children("backend").some((n) => n.path === "backend/old-queue"));
    assert.equal(c.archive.archive(t.human, ["backend"]).results[0]!.error?.code, "has_children");

    c.archive.archive(t.human, ["backend/old-queue"], "Queue removed in March.");
    assert.ok(!c.index.children("backend").some((n) => n.path === "backend/old-queue"), "out of the tree");
    assert.equal(c.codeContext(["src/queue.ts"]).knowledge.length, 0, "no longer covers the code");
    assert.equal(c.node("backend/old-queue").archived?.reason, "Queue removed in March.", "still readable by path");

    // Editing an archived node keeps it archived.
    c.putNode(t.human, { path: "backend/old-queue", title: "Old queue", summary: "RabbitMQ setup we removed (2025)", body: "" } as never);
    assert.ok(c.node("backend/old-queue").archived);

    assert.equal(err(() => c.archive.purge(t.human, "backend")).code, "not_archived");
    assert.equal(err(() => c.archive.purge(t.ai, old)).code, "forbidden");
    c.archive.archive(t.human, [old]);
    const dir = join(t.root, ".cortex", "items");
    c.archive.purge(t.human, old);
    assert.equal(c.itemStore.read(old), null);
    assert.ok(!existsSync(join(dir, old)));
    c.archive.purge(t.human, "backend/old-queue");
    assert.equal(c.tree.read("backend/old-queue"), null);
  } finally {
    t.cleanup();
  }
});

test("archive: old activity leaves default search, the files keep it", async () => {
  const { t, c } = setup();
  try {
    const cfg = join(t.root, ".cortex", "cortex.config.yaml");
    writeFileSync(cfg, YAML.stringify({ ...YAML.parse(readFileSync(cfg, "utf8")), archive: { activity_days: 1 } }));
    c.project.config.archive = { activity_days: 1 };
    const e = c.activity.log(t.ai, { action: "investigation", summary: "Traced the wombatword timeout to DNS" });
    assert.equal((await c.search("wombatword")).results.length, 1, "recent activity is found");
    c.project.config.archive = { activity_days: 1 };
    // Pretend the entry is two days old.
    const row = c.index.getActivity(e.id)!;
    c.index.addActivity({ ...row, id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ", at: ago(2), summary: "Old wombatword entry" });
    const hits = (await c.search("wombatword")).results as { id: string }[];
    assert.ok(!hits.some((h) => h.id === "01ZZZZZZZZZZZZZZZZZZZZZZZZ"));
    assert.ok(((await c.search("wombatword", { archived: true })).results as { id: string }[]).some((h) => h.id === "01ZZZZZZZZZZZZZZZZZZZZZZZZ"));
  } finally {
    t.cleanup();
  }
});

test("archive: REST, permissions and the AI tool path", async () => {
  const { t, old } = setup();
  const app = buildServer(t.cortex);
  const H = (token: string) => ({ host: "localhost:4747", authorization: `Bearer ${token}` });
  try {
    const cand = await app.inject({ method: "GET", url: "/api/archive/candidates", headers: H(t.init.tokens["ai-agent"]!) });
    assert.equal(cand.statusCode, 200);
    assert.deepEqual(
      (cand.json() as { candidates: { ref: string }[] }).candidates.map((x) => x.ref),
      [old],
    );

    const propose = await app.inject({
      method: "POST",
      url: "/api/archive",
      headers: H(t.init.tokens["ai-agent"]!),
      payload: { refs: [old], reason: "Solved for good; the hook was rewritten." },
    });
    assert.equal(propose.statusCode, 200, propose.body);
    assert.ok((propose.json() as { results: { draft_id?: string }[] }).results[0]!.draft_id);

    const purge = await app.inject({ method: "POST", url: "/api/archive/purge", headers: H(t.init.tokens["ai-agent"]!), payload: { ref: old } });
    assert.equal(purge.statusCode, 403);
  } finally {
    await app.close();
    t.cleanup();
  }
});
