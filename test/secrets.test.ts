import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/api/sessions.js";
import { loadTokens } from "../src/core/project.js";
import { tempProject } from "./helpers.js";

const posix = process.platform !== "win32";

test("the secrets file is owner-only, and an older loose one is tightened on first read", { skip: !posix && "no POSIX modes on Windows" }, () => {
  const t = tempProject();
  try {
    const file = join(t.init.dir, ".secrets.yaml");
    assert.equal(statSync(file).mode & 0o777, 0o600, "written 0600 by init");
    chmodSync(file, 0o644); // what init wrote before this rule
    utimesSync(file, new Date(), new Date(Date.now() + 5000)); // a new mtime, so the cached copy is not used
    loadTokens(t.init.dir);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    t.cleanup();
  }
});

test("tokens are cached, but a changed file is read again", () => {
  const t = tempProject();
  try {
    const file = join(t.init.dir, ".secrets.yaml");
    assert.equal(t.cortex.actorByToken(t.init.tokens.owner)?.id, "owner");
    assert.equal(loadTokens(t.init.dir), loadTokens(t.init.dir), "same parsed object while the file is unchanged");

    // Rotate the owner's token by hand, as a person would after a leak.
    writeFileSync(file, readFileSync(file, "utf8").replace(t.init.tokens.owner, "ctx_rotated_token_value"));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.equal(t.cortex.actorByToken(t.init.tokens.owner), null, "the old token stops working without a restart");
    assert.equal(t.cortex.actorByToken("ctx_rotated_token_value")?.id, "owner");
    assert.equal(t.cortex.actorByToken("ctx_rotated_token_valuX"), null);
    assert.equal(t.cortex.actorByToken(""), null);
  } finally {
    t.cleanup();
  }
});

test("a project made before sessions gets .sessions.json added to its .gitignore", () => {
  const t = tempProject();
  try {
    const gi = join(t.init.dir, ".gitignore");
    writeFileSync(gi, ".index/\n.secrets.yaml"); // older init, and no trailing newline
    const store = new SessionStore(t.init.dir);
    const key = store.create("owner");
    assert.equal(readFileSync(gi, "utf8"), ".index/\n.secrets.yaml\n.sessions.json\n");
    store.create("owner");
    assert.equal(readFileSync(gi, "utf8").match(/\.sessions\.json/g)?.length, 1, "added once");
    if (posix) assert.equal(statSync(join(t.init.dir, ".sessions.json")).mode & 0o777, 0o600);

    assert.equal(store.resolve(key), "owner");
    assert.equal(store.resolve(key, Date.now() + 31 * 24 * 3600 * 1000), null, "expires after 30 days");
    store.revoke(key);
    assert.equal(store.resolve(key), null);
    assert.equal(store.count("owner"), 1);
  } finally {
    t.cleanup();
  }
});
