import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMarkdown } from "../src/core/init.js";

// What the bootstrap task imports ends up in the committed .cortex/. A real project had an ignored
// docs/ai/infra.local.md with server keys, and the old walk listed it; it also stopped at 50 files.

function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "cortex-md-"));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  return root;
}

test("in a git repo the markdown list comes from git: ignored files never appear", () => {
  const root = repo({
    ".gitignore": "*.local.md\n",
    "README.md": "# App",
    "docs/ai/infra.local.md": "password: hunter2",
    "docs/ai/01-mimari.md": "# Mimari",
    "docs/ödeme.md": "# Ödeme",
    "node_modules/pkg/README.md": "vendored",
  });
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "README.md"], { cwd: root }); // one tracked, the rest untracked but not ignored
    assert.deepEqual(findMarkdown(root), ["README.md", "docs/ai/01-mimari.md", "docs/ödeme.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outside git the walk skips *.local.md, and a large docs folder is not cut at 50", () => {
  const files: Record<string, string> = { "notes.local.md": "secret" };
  for (let i = 0; i < 60; i++) files[`docs/${String(i).padStart(2, "0")}.md`] = "# Doc";
  const root = repo(files);
  try {
    const found = findMarkdown(root);
    assert.equal(found.length, 60);
    assert.ok(!found.includes("notes.local.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
