import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildServer } from "../src/api/server.js";
import { shortId, shortIdSuffix } from "../src/util/text.js";
import { tempProject } from "./helpers.js";

test("a typed short id reads as a ULID ending: #, case and Crockford look-alikes do not matter", () => {
  assert.equal(shortIdSuffix("#zkfba9"), "ZKFBA9");
  assert.equal(shortIdSuffix(" ZKFBA9 "), "ZKFBA9");
  assert.equal(shortIdSuffix("o1il23"), "011123", "O reads as 0, I and L as 1");
  assert.equal(shortIdSuffix("ABC"), null, "too short to mean one item");
  assert.equal(shortIdSuffix("backend/storage"), null);
  assert.equal(shortIdSuffix("ZKFBU9"), null, "U is not in the alphabet");
  assert.equal(shortId("01M34Q58BQ0DK61N2VZ5ZKFBA9"), "ZKFBA9");
});

test("the API and so the MCP tools take the short id the board shows, and refuse one that matches two items", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const H = { host: "localhost:4747", authorization: `Bearer ${t.init.tokens.owner}` };
  try {
    const task = t.cortex.items.create(t.human, { type: "task", title: "Ship the export" });
    const short = shortId(task.id);

    for (const ref of [short, `#${short}`, short.toLowerCase(), task.id]) {
      const res = await app.inject({ url: `/api/items/${encodeURIComponent(ref)}`, headers: H });
      assert.equal(res.statusCode, 200, ref);
      assert.equal(res.json().item.id, task.id, ref);
    }
    const patched = await app.inject({ method: "PATCH", url: `/api/items/${short}`, headers: H, payload: { title: "Ship the CSV export" } });
    assert.equal(patched.statusCode, 200);
    assert.equal(t.cortex.index.getItem(task.id)?.title, "Ship the CSV export");

    // Refs in the activity log are stored as full ids; a lower-case knowledge path is left alone.
    const logged = await app.inject({
      method: "POST",
      url: "/api/activity",
      headers: H,
      payload: { action: "investigation", summary: "Looked at the export", refs: [`#${short}`, "backend"] },
    });
    assert.equal(logged.statusCode, 201);
    assert.deepEqual(t.cortex.activity.get(logged.json().id).refs, [task.id, "backend"]);

    // An unknown short id is the usual not-found, never a guess.
    assert.equal((await app.inject({ url: "/api/items/ZZZZZZ", headers: H })).statusCode, 404);

    // A second item with the same ending (rare, but possible): the short id is refused with both candidates,
    // and the full id still works.
    const items = join(t.root, ".cortex", "items");
    const folder = readdirSync(items).find((n) => n.startsWith(task.id))!;
    const twin = task.id.slice(0, 10) + (task.id[10] === "0" ? "1" : "0") + task.id.slice(11);
    cpSync(join(items, folder), join(items, twin), { recursive: true });
    const md = join(items, twin, "item.md");
    writeFileSync(md, readFileSync(md, "utf8").replace(task.id, twin));
    t.cortex.reindex();
    const ambiguous = await app.inject({ url: `/api/items/${short}`, headers: H });
    assert.equal(ambiguous.statusCode, 409);
    assert.equal(ambiguous.json().error.code, "ambiguous_id");
    assert.deepEqual(
      ambiguous
        .json()
        .error.hint.candidates.map((c: { id: string }) => c.id)
        .sort(),
      [task.id, twin].sort(),
    );
    assert.equal((await app.inject({ url: `/api/items/${task.id}`, headers: H })).statusCode, 200);
    assert.equal((await app.inject({ url: `/api/items/${twin.slice(-16)}`, headers: H })).json().item.id, twin, "more characters settle it");
  } finally {
    await app.close();
    t.cleanup();
  }
});
