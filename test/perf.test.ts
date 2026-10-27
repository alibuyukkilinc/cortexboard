import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitProject, tempProject } from "./helpers.js";

// Counted, not timed: wall-clock limits flake on shared CI machines, a count of folder listings does not.
test("a full reindex lists the items folder once, not once per item", () => {
  const t = tempProject();
  try {
    const n = 500;
    const store = t.cortex.itemStore;
    const atStart = store.scans;
    for (let i = 0; i < n; i++) t.cortex.items.create(t.human, { type: "note", title: `Note ${i}` });
    // Each create adds a folder; the store records its own addition instead of listing everything again.
    assert.ok(store.scans - atStart <= 2, `${store.scans - atStart} folder listings for ${n} creates`);
    const before = store.scans;
    t.cortex.reindex();
    const scans = store.scans - before;
    assert.ok(scans <= 2, `${scans} folder listings for ${n} items`);

    // And a lookup of an unknown id does not list the folder again while nothing changed.
    const again = store.scans;
    for (let i = 0; i < 50; i++) store.read("01ZZZZZZZZZZZZZZZZZZZZZZZZ");
    assert.ok(store.scans - again <= 1, "at most one listing for the first miss, then the folder's mtime says nothing moved");

    // A folder added by someone else (git pull, another process) is still found.
    const id = "01ZZZZZZZZZZZZZZZZZZZZZZZY";
    mkdirSync(join(t.root, `.cortex/items/${id}-by-hand`));
    writeFileSync(join(t.root, `.cortex/items/${id}-by-hand/item.md`), "---\ntype: note\ntitle: By hand\nstatus: open\nauthor: owner\n---\n");
    assert.equal(store.read(id)?.title, "By hand");
  } finally {
    t.cleanup();
  }
});

test("staleness asks git once per HEAD: /brief, /stale and recomputes after writes reuse the answers", () => {
  const p = gitProject();
  try {
    for (const [path, file] of [
      ["backend/auth", "src/auth/token.ts"],
      ["backend/pay", "src/pay/iyzico.ts"],
    ]) {
      p.cortex.putNode(p.human, { path, title: path, summary: "x", links: { code: [{ file }] } });
    }
    p.write("src/auth/token.ts", "export const ttl = 30;\n");
    p.write("src/pay/iyzico.ts", "export const provider = 'x';\n");
    p.commit("change both");

    const git = p.cortex.staleness.git;
    p.cortex.staleness.refresh(true);
    const first = git.calls;
    assert.equal(p.cortex.staleness.list().length, 2);

    // A write elsewhere marks the list dirty and forces a recompute: no new git diff/log per node.
    p.cortex.putNode(p.human, { path: "backend/other", title: "Other", summary: "no code" });
    p.cortex.staleness.refresh(true);
    p.cortex.brief(p.human);
    p.cortex.staleness.list();
    const extra = git.calls - first;
    assert.ok(extra <= 2, `${extra} git calls for a recompute at the same HEAD (only rev-parse HEAD is expected)`);

    // A new commit is a new HEAD: the answers are asked again.
    p.write("src/auth/token.ts", "export const ttl = 60;\n");
    p.commit("ttl 60");
    const beforeNew = git.calls;
    p.cortex.staleness.refresh(true);
    assert.ok(git.calls - beforeNew > 2);
  } finally {
    p.cleanup();
  }
});
