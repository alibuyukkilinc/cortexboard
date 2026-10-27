import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempProject } from "./helpers.js";

test("hand edits on disk are picked up without a restart", async () => {
  const t = tempProject();
  const errors: unknown[] = [];
  try {
    t.cortex.watch((e) => errors.push(e));
    writeFileSync(
      join(t.root, ".cortex/tree/backend.md"),
      "---\nid: 01HANDEDIT0000000000000000\ntitle: Backend\nsummary: Laravel API ve kuyruklar.\nstatus: active\nupdated_by: owner\nupdated_at: 2026-09-22T12:00:00Z\n---\n\nElle yazıldı.\n",
    );
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(errors, []);
    assert.equal((await t.cortex.search("laravel")).results[0]?.path, "backend");
  } finally {
    t.cleanup();
  }
});

test("a file deleted on disk leaves the index", async () => {
  const t = tempProject();
  const errors: unknown[] = [];
  try {
    t.cortex.watch((e) => errors.push(e));
    assert.ok((await t.cortex.search("seo")).results.some((r) => r.path === "seo"));
    rmSync(join(t.root, ".cortex/tree/seo.md"));
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(errors, []);
    assert.equal(
      (await t.cortex.search("seo")).results.some((r) => r.path === "seo"),
      false,
    );
  } finally {
    t.cleanup();
  }
});

test("hand edits inside a folder created after watching started are picked up", async () => {
  const t = tempProject();
  const errors: unknown[] = [];
  try {
    t.cortex.watch((e) => errors.push(e));
    t.cortex.putNode(t.human, { path: "backend/odeme", title: "Ödeme", summary: "iyzico." }); // promotes backend.md -> backend/_node.md
    await new Promise((r) => setTimeout(r, 500));
    writeFileSync(
      join(t.root, ".cortex/tree/backend/onbellek.md"),
      "---\nid: 01HANDEDIT0000000000000001\ntitle: Önbellek\nsummary: Redis ile 5 dakikalık önbellek.\nstatus: active\nupdated_by: owner\nupdated_at: 2026-09-22T12:00:00Z\n---\n\nElle.\n",
    );
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(errors, []);
    assert.equal((await t.cortex.search("önbellek")).results[0]?.path, "backend/onbellek");
  } finally {
    t.cleanup();
  }
});
