import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAgentHint } from "../src/core/agentFiles.js";
import { AGENT_HINT } from "../src/core/init.js";

test("agent files: the hint is added to files that exist, once, without touching what is there", () => {
  const root = mkdtempSync(join(tmpdir(), "cortex-agent-"));
  try {
    writeFileSync(join(root, "CLAUDE.md"), "# House rules\n\nUse tabs.\n\n\n");
    assert.deepEqual(appendAgentHint(root, AGENT_HINT), ["CLAUDE.md"]);
    assert.equal(existsSync(join(root, "AGENTS.md")), false, "a missing file is not created");

    const text = readFileSync(join(root, "CLAUDE.md"), "utf8");
    assert.ok(text.startsWith("# House rules\n\nUse tabs.\n\n<!-- cortex:start -->"), "trailing blank lines trimmed, one gap before the hint");
    assert.ok(text.endsWith("<!-- cortex:end -->\n"));

    assert.deepEqual(appendAgentHint(root, AGENT_HINT), [], "a second run changes nothing");
    assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), text);

    // AGENTS.md written by hand with the marker already in it: left alone.
    writeFileSync(join(root, "AGENTS.md"), "Notes\n<!-- cortex:start -->\nmine\n<!-- cortex:end -->\n");
    assert.deepEqual(appendAgentHint(root, AGENT_HINT), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent files: a CLAUDE.md that only imports AGENTS.md is left alone, the hint goes to AGENTS.md once", () => {
  const root = mkdtempSync(join(tmpdir(), "cortex-agent-"));
  try {
    writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n");
    writeFileSync(join(root, "AGENTS.md"), "# Rules\n");
    assert.deepEqual(appendAgentHint(root, AGENT_HINT), ["AGENTS.md"]);
    assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
