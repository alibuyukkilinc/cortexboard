import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Index, INDEX_VERSION } from "../src/index/db.js";

// An older Cortex (e.g. an MCP from npm) next to a newer one (a hub from source) on the same project.
function legacyIndex(dir: string, version: number): void {
  const db = new DatabaseSync(join(dir, "cortex.db"));
  db.exec(`
    CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE embeddings (kind TEXT NOT NULL, ref TEXT NOT NULL, model TEXT NOT NULL, hash TEXT NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (kind, ref));
    INSERT INTO embeddings VALUES ('node', 'backend', 'm', 'h', x'00000000');
    PRAGMA user_version = ${version};`);
  db.close();
}

test("each index version keeps its own file and leaves an older version's index alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "cortex-index-"));
  try {
    legacyIndex(dir, 8);
    const index = new Index(dir);
    index.close();
    assert.ok(existsSync(join(dir, `cortex-v${INDEX_VERSION}.db`)));

    const old = new DatabaseSync(join(dir, "cortex.db"), { readOnly: true });
    assert.equal((old.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 8);
    assert.equal(old.prepare("PRAGMA table_info(items)").all().length, 2);
    old.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new index file starts with the embeddings of the older one", () => {
  const dir = mkdtempSync(join(tmpdir(), "cortex-index-"));
  try {
    legacyIndex(dir, 8);
    const index = new Index(dir);
    assert.deepEqual(
      index.embeddings().map((e) => [e.kind, e.ref, e.model, e.hash]),
      [["node", "backend", "m", "h"]],
    );
    index.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
