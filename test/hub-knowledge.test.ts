import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../src/core/init.js";
import { knowledgeDir, moveKnowledge, openHubProject, registerProject } from "../src/hub/knowledge.js";
import { Hub } from "../src/hub/server.js";
import { HubStore } from "../src/hub/store.js";

// A hub keeps a project's knowledge in its own folder (decision 01M3MXCE60DW7T897TRC43C6AR): the code folder stays
// clean, the hub commits the knowledge there and never pushes.
function setup() {
  const root = mkdtempSync(join(tmpdir(), "cortex-hubk-"));
  const store = HubStore.init(join(root, "hub"), { org: "Acme", host: "127.0.0.1", port: 4747 });
  const code = join(root, "app");
  mkdirSync(code);
  writeFileSync(join(code, "main.ts"), "export const v = 1;\n");
  const log = (dir: string) => execFileSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf8" }).trim().split("\n");
  return { root, store, code, log, cleanup: () => (store.close(), rmSync(root, { recursive: true, force: true })) };
}

test("hub knowledge: a new project's knowledge goes to the hub, the code folder gets nothing", async () => {
  const t = setup();
  try {
    const r = await registerProject(t.store, { path: t.code, name: "App", init: true, language: "en" });
    assert.equal(r.where, "hub");
    const dir = knowledgeDir(t.store.dir, "app");
    assert.ok(existsSync(join(dir, "cortex.config.yaml")));
    assert.ok(!existsSync(join(t.code, ".cortex")));
    assert.deepEqual(t.log(dir), ["Cortex: project created"]);
    const p = openHubProject(t.store.dir, t.store.project("app")!);
    assert.equal(p.root, t.code, "code links, git and staleness still look at the code folder");
    assert.equal(p.dir, dir);
  } finally {
    t.cleanup();
  }
});

test("hub knowledge: the hub commits what changed, with no git identity configured", async () => {
  const t = setup();
  try {
    await registerProject(t.store, { path: t.code, init: true, language: "en" });
    const hub = new Hub(t.store);
    const c = hub.cortex("app");
    c.putNode({ id: "owner", kind: "human" }, { path: "backend", title: "Backend", summary: "The API." } as never);
    await hub.commitAll();
    const dir = knowledgeDir(t.store.dir, "app");
    assert.equal(t.log(dir).length, 2);
    await hub.commitAll();
    assert.equal(t.log(dir).length, 2, "nothing changed, nothing committed");
    const ignored = execFileSync("git", ["ls-files"], { cwd: dir, encoding: "utf8" });
    assert.doesNotMatch(ignored, /\.secrets\.yaml|\.index\//, "tokens and the index stay out of history");
    c.close();
  } finally {
    t.cleanup();
  }
});

test("hub knowledge: --in-repo keeps the old layout, and move-knowledge brings it over", async () => {
  const t = setup();
  try {
    const r = await registerProject(t.store, { path: t.code, init: true, language: "en", knowledge: "repo" });
    assert.equal(r.where, "repo");
    assert.ok(existsSync(join(t.code, ".cortex", "cortex.config.yaml")));
    mkdirSync(join(t.code, ".cortex", ".index"), { recursive: true });
    writeFileSync(join(t.code, ".cortex", ".index", "cortex.db"), "cache");

    const m = await moveKnowledge(t.store, "app");
    const dir = knowledgeDir(t.store.dir, "app");
    assert.equal(m.to, dir);
    assert.ok(!existsSync(join(t.code, ".cortex")), "the repository copy is gone");
    assert.ok(existsSync(join(dir, "tree")));
    assert.ok(!existsSync(join(dir, ".index")), "the index is rebuilt, not copied");
    assert.equal(openHubProject(t.store.dir, t.store.project("app")!).dir, dir);
    await assert.rejects(moveKnowledge(t.store, "app"), /already in the hub/);
  } finally {
    t.cleanup();
  }
});

test("hub knowledge: a folder that already has .cortex is registered as it is", async () => {
  const t = setup();
  try {
    initProject(t.code, "app", { language: "en", bootstrapTask: false });
    const r = await registerProject(t.store, { path: t.code });
    assert.equal(r.where, "repo");
    assert.equal(r.created, undefined);
  } finally {
    t.cleanup();
  }
});

test("hub knowledge: a moved .cortex without its .gitignore still keeps tokens out of history", async () => {
  const t = setup();
  try {
    await registerProject(t.store, { path: t.code, init: true, language: "en", knowledge: "repo" });
    rmSync(join(t.code, ".cortex", ".gitignore"));
    await moveKnowledge(t.store, "app");
    const dir = knowledgeDir(t.store.dir, "app");
    const files = execFileSync("git", ["ls-files"], { cwd: dir, encoding: "utf8" });
    assert.doesNotMatch(files, /\.secrets\.yaml/);
    assert.ok(!existsSync(join(t.code, ".cortex.moving")), "the staging folder is cleaned up");
  } finally {
    t.cleanup();
  }
});
