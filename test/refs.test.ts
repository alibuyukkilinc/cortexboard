import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/api/server.js";
import { githubRepoUrl } from "../src/git/git.js";
import { tempProject } from "./helpers.js";

test("commit links go to GitHub only: other remotes leave hashes as text", () => {
  for (const remote of [
    "git@github.com:acme/shop.git",
    "https://github.com/acme/shop",
    "https://github.com/acme/shop.git",
    "ssh://git@github.com/acme/shop.git",
    "https://token@github.com/acme/shop.git/",
  ]) {
    assert.equal(githubRepoUrl(remote), "https://github.com/acme/shop", remote);
  }
  for (const remote of ["git@gitlab.com:acme/shop.git", "https://git.example.com/acme/shop.git", "", null]) {
    assert.equal(githubRepoUrl(remote), null, String(remote));
  }
});

test("the board learns the repo address from the config, and previews 30 ids in one request", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const H = { host: "localhost:4747", authorization: `Bearer ${t.init.tokens.owner}` };
  try {
    t.cortex.project.config.project.repo_url = "https://github.com/acme/shop/";
    assert.equal((await app.inject({ url: "/api/me", headers: H })).json().repo_url, "https://github.com/acme/shop");
    t.cortex.project.config.project.repo_url = "javascript:alert(1)";
    assert.equal((await app.inject({ url: "/api/me", headers: H })).json().repo_url, undefined, "only http(s) addresses become links");

    const ids = Array.from({ length: 29 }, (_, i) => t.cortex.items.create(t.human, { type: "note", title: `Note ${i}` }).id);
    const logged = t.cortex.activity.log(t.ai, { action: "fix", summary: "Fixed the export", why: "Broken dates.", commits: ["a1b2c3d", "e4f5a6b"] });
    const unknown = "01ZZZZZZZZZZZZZZZZZZZZZZZZ";
    const res = await app.inject({ url: `/api/refs?ids=${[...ids, logged.id, unknown, "not-an-id"].join(",")}`, headers: H });
    assert.equal(res.statusCode, 200);
    const refs = res.json().refs;
    assert.equal(Object.keys(refs).length, 31, "30 known ids and one unknown; malformed ones are ignored");
    assert.deepEqual({ ...refs[ids[3]], updated_at: undefined }, { kind: "item", type: "note", title: "Note 3", status: "active", updated_at: undefined });
    assert.equal(refs[logged.id].kind, "activity");
    assert.equal(refs[logged.id].summary, "Fixed the export");
    assert.equal(refs[unknown], null);

    const many = Array.from({ length: 101 }, (_, i) => `01ZZZZZZZZZZZZZZZZZZZZZ${String(i).padStart(3, "0")}`.slice(0, 26));
    assert.equal((await app.inject({ url: `/api/refs?ids=${many.join(",")}`, headers: H })).statusCode, 400);
  } finally {
    await app.close();
    t.cleanup();
  }
});

test("an activity entry takes several commits; one commit still works; a bad hash is refused", () => {
  const t = tempProject();
  try {
    const a = t.cortex.activity.log(t.ai, { action: "fix", summary: "Two-step fix", why: "Follow-up.", commits: ["a1b2c3d", "E4F5A6B7"] });
    assert.deepEqual(t.cortex.activity.get(a.id).commits, ["a1b2c3d", "E4F5A6B7"]);
    const b = t.cortex.activity.log(t.ai, { action: "fix", summary: "One commit", why: "Old style.", commit: "a1b2c3d" });
    assert.equal(t.cortex.activity.get(b.id).commit, "a1b2c3d");
    assert.throws(() => t.cortex.activity.log(t.ai, { action: "fix", summary: "Bad", why: "x", commits: ["not-a-hash"] }), /does not match/);
  } finally {
    t.cleanup();
  }
});
