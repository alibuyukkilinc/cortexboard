import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/api/server.js";
import { MAX_VERSIONS } from "../src/store/items.js";
import { tempProject } from "./helpers.js";

const err = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e as { code: string; status: number; hint?: Record<string, unknown> };
  }
  throw new Error("expected an error");
};

const spec =
  ["## Goal", "Ship the export.", "", "## Handoff", "Left off at the CSV writer; the date column still needs a timezone.", ""].join("\n") +
  "Details. ".repeat(30);

test("a change to what an item says keeps the previous state as a version; a status move does not", () => {
  const t = tempProject();
  try {
    const id = t.cortex.items.create(t.human, { type: "task", title: "Export", body: spec }).id;
    t.cortex.items.update(t.human, id, { status: "todo" });
    t.cortex.items.reply(t.human, id, { body: "Starting.", status: "doing" });
    assert.equal(t.cortex.items.history(id).versions.length, 0, "moving the card is recorded by its replies, not as versions");

    t.cortex.items.update(t.human, id, { title: "Export invoices" });
    t.cortex.items.update(t.human, id, { body: "Rewritten.", fields: { priority: "high" } });
    const h = t.cortex.items.history(id);
    assert.equal(h.versions.length, 2);
    assert.deepEqual(h.versions[0].changed, ["body", "fields"], "the newest version differs from the item in body and fields");
    assert.deepEqual(h.versions[1].changed, ["title"]);
    assert.equal(h.versions[1].title, "Export");

    // A claim's handoff note is content too: overwriting it keeps the old one.
    t.cortex.items.claim(t.ai, id, { action: "claim", note: "Left off at the CSV writer." });
    t.cortex.items.claim(t.ai, id, { action: "release", note: "" });
    const withNote = t.cortex.items.history(id).versions[0];
    assert.deepEqual(withNote.changed, ["handoff_note"]);

    // Only the newest MAX_VERSIONS stay.
    for (let i = 0; i < MAX_VERSIONS + 5; i++) t.cortex.items.update(t.human, id, { title: `Export ${i}` });
    assert.equal(t.cortex.items.history(id).versions.length, MAX_VERSIONS);
  } finally {
    t.cleanup();
  }
});

test("a lost section comes back with one restore, and the restore can itself be undone", () => {
  const t = tempProject();
  try {
    const id = t.cortex.items.create(t.human, { type: "task", title: "Export", body: spec }).id;
    t.cortex.items.claim(t.ai, id, { action: "claim" });
    t.cortex.items.claim(t.ai, id, { action: "release", note: "CSV writer done." });
    t.cortex.items.update(t.ai, id, { body: "## Goal\nShip the export.", confirm_shrink: true, status: "doing" });
    const lost = t.cortex.items.get(id).item;
    assert.ok(!lost.body.includes("Handoff"));

    const v = t.cortex.items.history(id).versions[0].version;
    const r = t.cortex.items.restore(t.human, id, v);
    assert.equal(r.applied, true);
    const back = t.cortex.items.get(id).item;
    assert.equal(back.body, spec.trimEnd());
    assert.equal(back.status, "doing", "restoring content does not move the card");
    assert.equal(back.handoff_note, "CSV writer done.");

    // The state the restore replaced is a version now: undoing the restore is one more restore.
    const undo = t.cortex.items.history(id).versions[0];
    assert.ok(!undo.changed.includes("title"));
    t.cortex.items.restore(t.human, id, undo.version);
    assert.equal(t.cortex.items.get(id).item.body, "## Goal\nShip the export.");
    assert.equal(err(() => t.cortex.items.restore(t.human, id, "01ZZZZZZZZZZZZZZZZZZZZZZZZ")).code, "not_found");
  } finally {
    t.cleanup();
  }
});

test("append adds to the body; an agent cannot cut a body in half by accident", () => {
  const t = tempProject();
  try {
    const id = t.cortex.items.create(t.human, { type: "task", title: "Export", body: spec }).id;
    t.cortex.items.update(t.ai, id, { body: "## Notes\nTimezone fixed.", body_mode: "append" });
    const body = t.cortex.items.get(id).item.body;
    assert.ok(body.startsWith(spec.trimEnd()), "the old body stays as it was");
    assert.ok(body.endsWith("\n\n## Notes\nTimezone fixed."));

    const e = err(() => t.cortex.items.update(t.ai, id, { body: "## Goal\nShip it." }));
    assert.equal(e.code, "body_shrink");
    assert.equal(e.status, 409);
    assert.match(String(e.hint?.hint), /append/);
    assert.equal(t.cortex.items.get(id).item.body, body, "nothing was written");

    t.cortex.items.update(t.ai, id, { body: "## Goal\nShip it.", confirm_shrink: true });
    // A person editing decides for themselves; short bodies are ordinary edits for anyone.
    t.cortex.items.update(t.human, id, { body: spec });
    t.cortex.items.update(t.human, id, { body: "x" });
    const short = t.cortex.items.create(t.human, { type: "task", title: "Short", body: "Two lines.\nOf text." }).id;
    t.cortex.items.update(t.ai, short, { body: "One." });
  } finally {
    t.cleanup();
  }
});

test("REST: history, one version, restore; an agent's restore under review becomes a draft", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const H = (who: string) => ({ host: "localhost:4747", authorization: `Bearer ${t.init.tokens[who]}` });
  try {
    const id = t.cortex.items.create(t.human, { type: "decision", title: "Use Redis", fields: { context: "Sessions." } }).id;
    t.cortex.items.update(t.human, id, { title: "Use Redis for sessions" });
    const h = (await app.inject({ url: `/api/items/${id}/history`, headers: H("owner") })).json();
    assert.equal(h.versions.length, 1);
    assert.equal(h.max, 20);
    const v = h.versions[0].version;
    const one = (await app.inject({ url: `/api/items/${id}/history/${v}`, headers: H("owner") })).json();
    assert.equal(one.item.title, "Use Redis");

    // Where agents write through review, a restore from one waits for a person too.
    t.cortex.project.config.approval.decision = "review";
    const ai = await app.inject({ method: "POST", url: `/api/items/${id}/restore`, headers: H("ai-agent"), payload: { version: v } });
    assert.equal(ai.statusCode, 202);
    assert.ok(ai.json().draft_id);
    const human = await app.inject({ method: "POST", url: `/api/items/${id}/restore`, headers: H("owner"), payload: { version: v } });
    assert.equal(human.statusCode, 200);
    assert.equal(t.cortex.items.get(id).item.title, "Use Redis");
    assert.equal((await app.inject({ method: "POST", url: `/api/items/${id}/restore`, headers: H("owner"), payload: {} })).statusCode, 400);
  } finally {
    await app.close();
    t.cleanup();
  }
});
