import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullProject } from "../src/hub/gitSync.js";

// The hub pulls, never commits or pushes (decision 01M3AM8C7QZG19TBK055EJYWXA). A bare "origin", a developer
// clone that pushes, and the hub's checkout that pulls.
function repos() {
  const root = mkdtempSync(join(tmpdir(), "cortex-pull-"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=d@x", "-c", "user.name=D", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  const origin = join(root, "origin.git");
  mkdirSync(origin);
  git(origin, "init", "-q", "--bare", "-b", "main");
  const dev = join(root, "dev");
  git(root, "clone", "-q", origin, dev);
  git(dev, "checkout", "-q", "-b", "main");
  mkdirSync(join(dev, ".cortex"));
  writeFileSync(join(dev, "app.ts"), "export const v = 1;\n");
  writeFileSync(join(dev, ".cortex", "note.md"), "one\n");
  git(dev, "add", "-A");
  git(dev, "commit", "-q", "-m", "first");
  git(dev, "push", "-q", "-u", "origin", "main");
  const hub = join(root, "hub");
  git(root, "clone", "-q", origin, hub);
  const commit = (cwd: string, file: string, text: string) => {
    writeFileSync(join(cwd, file), text);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", `change ${file}`);
  };
  return { root, git, dev, hub, commit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("pull: fast-forwards to the upstream and reports it", async () => {
  const r = repos();
  try {
    assert.equal((await pullProject(r.hub)).status, "up_to_date");
    r.commit(r.dev, "app.ts", "export const v = 2;\n");
    r.git(r.dev, "push", "-q");
    const p = await pullProject(r.hub);
    assert.equal(p.status, "pulled", p.message);
    assert.equal(p.behind, 0);
    assert.equal(r.git(r.hub, "rev-parse", "HEAD"), r.git(r.dev, "rev-parse", "HEAD"));
  } finally {
    r.cleanup();
  }
});

test("pull: knowledge the hub wrote is left in place and counted, never committed", async () => {
  const r = repos();
  try {
    writeFileSync(join(r.hub, ".cortex", "note.md"), "edited on the hub\n");
    writeFileSync(join(r.hub, ".cortex", "new.md"), "new\n");
    r.commit(r.dev, "app.ts", "export const v = 3;\n"); // touches other files: fast-forward still possible
    r.git(r.dev, "push", "-q");
    const p = await pullProject(r.hub);
    assert.equal(p.status, "pulled", p.message);
    assert.equal(p.pending, 2);
    assert.equal(r.git(r.hub, "log", "-1", "--format=%s"), "change app.ts", "no commit of its own");
  } finally {
    r.cleanup();
  }
});

test("pull: stops instead of overwriting, merging or resetting", async () => {
  const r = repos();
  try {
    // An incoming change to a file the hub edited: git refuses, the edit survives.
    writeFileSync(join(r.hub, ".cortex", "note.md"), "hub edit\n");
    r.commit(r.dev, ".cortex/note.md", "dev edit\n");
    r.git(r.dev, "push", "-q");
    const conflict = await pullProject(r.hub);
    assert.equal(conflict.status, "failed");
    assert.match(conflict.message, /fast-forward/);
    assert.equal(execFileSync("git", ["show", ":0:.cortex/note.md"], { cwd: r.hub, encoding: "utf8" }).trim(), "one", "index untouched");

    // A local commit on the hub checkout: diverged, a person decides.
    r.git(r.hub, "checkout", "-q", "--", ".cortex/note.md");
    r.commit(r.hub, "local.md", "local\n");
    const diverged = await pullProject(r.hub);
    assert.equal(diverged.status, "skipped");
    assert.equal(diverged.ahead, 1);
  } finally {
    r.cleanup();
  }
});

test("pull: a folder without git or without an upstream is skipped with the reason", async () => {
  const r = repos();
  try {
    const plain = join(r.root, "plain");
    mkdirSync(plain);
    assert.equal((await pullProject(plain)).status, "skipped");
    r.git(r.hub, "checkout", "-q", "-b", "topic");
    const p = await pullProject(r.hub);
    assert.equal(p.status, "skipped");
    assert.match(p.message, /upstream/);
  } finally {
    r.cleanup();
  }
});
