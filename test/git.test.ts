import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "../src/git/git.js";
import { gitProject } from "./helpers.js";

test("git: a move is reported as a rename even when only the old path is asked about", () => {
  const p = gitProject();
  try {
    const git = new Git(p.root);
    renameSync(join(p.root, "src/pay/iyzico.ts"), join(p.root, "src/pay/provider.ts"));
    p.commit("move");
    assert.deepEqual(git.changedFiles(p.first, ["src/pay/iyzico.ts"]), [{ file: "src/pay/iyzico.ts", status: "renamed", renamed_to: "src/pay/provider.ts" }]);
    assert.deepEqual(git.changedFiles(p.first, ["src/auth"]), [], "an untouched folder has no changes");
  } finally {
    p.cleanup();
  }
});

test("git: touched ranges come from -U0 hunks, in the old file's line numbers", () => {
  const p = gitProject();
  try {
    const git = new Git(p.root);
    p.edit("src/auth/login.ts", "line 10\n", "line 10 changed\n"); // replace one line
    const after = (from: string, to: string) => p.edit("src/auth/login.ts", from, to);
    p.commit("one");
    const one = p.git("rev-parse", "HEAD");
    after("line 50\nline 51\nline 52\n", "line 50\n"); // delete two lines
    p.commit("two");
    after("line 80\n", "line 80\ninserted\n"); // insert after 80
    p.commit("three");
    assert.deepEqual(git.touchedRanges(p.first, "src/auth/login.ts"), [
      [10, 10],
      [51, 52],
      [80.5, 80.5],
    ]);
    assert.deepEqual(git.touchedRanges(one, "src/auth/login.ts"), [
      [51, 52],
      [80.5, 80.5],
    ]);
    assert.equal(git.commitsSince(p.first, "src/auth/login.ts").length, 3);
    assert.equal(git.commitsSince(p.first, "src/auth/login.ts")[0].subject, "three", "newest first");
  } finally {
    p.cleanup();
  }
});

test("git: outside a repository everything answers 'unknown' instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "cortex-nogit-"));
  try {
    const git = new Git(dir);
    assert.equal(git.available(), false);
    assert.equal(git.head(), null);
    assert.equal(git.commitExists("0123456789abcdef"), false);
    assert.equal(git.changedFiles("HEAD", ["a.ts"]), null);
    assert.equal(git.touchedRanges("HEAD", "a.ts"), null);
    assert.deepEqual(git.commitsSince("HEAD", "a.ts"), []);
    assert.deepEqual(git.untracked(["a.ts"]), []);
    assert.equal(git.formattingOnly("HEAD", "a.ts"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git: a hash that is not a commit, or not a hash at all, does not exist", () => {
  const p = gitProject();
  try {
    const git = new Git(p.root);
    assert.equal(git.commitExists(p.first), true);
    assert.equal(git.commitExists(p.first.slice(0, 7)), true, "short hashes work");
    assert.equal(git.commitExists("--help"), false, "never passed to git as an option");
    assert.equal(git.commitExists("0123456789abcdef0123456789abcdef01234567"), false);
  } finally {
    p.cleanup();
  }
});
