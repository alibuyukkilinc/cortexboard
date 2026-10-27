import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cortex } from "../src/core/cortex.js";
import { BOOTSTRAP_TAG, initProject } from "../src/core/init.js";
import { loadProject } from "../src/core/project.js";
import { estimateTokens } from "../src/util/text.js";

// A project that never used Cortex: the task that fills the tree used to be text printed by
// `cortexboard bootstrap` on the machine that ran init. An agent connecting through a hub never saw it.

function fresh(language: string, run: (c: Cortex, taskId: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "cortex-bootstrap-"));
  try {
    const r = initProject(root, "Arsa", { language, branches: ["backend", "frontend"], timezone: "UTC" });
    const c = new Cortex(loadProject(root), { embedder: null });
    try {
      run(c, r.bootstrapTask!);
    } finally {
      c.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("init opens the bootstrap task for @ai, in the project's language", () => {
  fresh("tr", (c, id) => {
    const { item } = c.items.get(id);
    assert.equal(item.type, "task");
    assert.equal(item.status, "todo");
    assert.equal(item.assignee, "@ai");
    assert.deepEqual(item.tags, [BOOTSTRAP_TAG]);
    assert.equal(item.title, "Bilgi ağacını koddan doldur (ilk kurulum)");
    assert.match(item.body, /# Cortex bootstrap task/);
    assert.match(item.body, /move it to "review" when you finish/, "the task body says how to close the task");
    assert.match(item.body, /Turkish/, "and which language to write in");

    const ai = c.actor("ai-agent");
    assert.deepEqual(
      c.items.inbox(ai).items.map((i) => i.id),
      [id],
      "the first agent that connects finds it in its inbox",
    );
  });
});

test("the brief points a fresh project at the bootstrap task, and stops once the tree is described", () => {
  fresh("en", (c, id) => {
    const ai = c.actor("ai-agent");
    const brief = c.brief(ai);
    assert.equal(brief.next.length, 1, "one next step while the tree is empty");
    assert.match(brief.next[0], /Knowledge tree not filled yet: do the "bootstrap" task/);
    assert.equal(brief.attention.inbox.top[0].id, id);
    assert.ok(estimateTokens(brief) < 800, `brief is ${estimateTokens(brief)} tokens`);

    c.putNode(c.actor("owner"), { path: "", title: "Arsa", summary: "Land listings: search, parcels, offers." });
    const after = c.brief(ai);
    assert.equal(after.next.length, 4, "the usual hints are back");
    assert.match(after.next[0], /cortex_update_status/, "and, with no project status yet, a nudge to write one");
    assert.ok(!after.next.some((n) => n.includes("not filled yet")));
  });
});

test("init can skip the task (tests and tools that count items)", () => {
  const root = mkdtempSync(join(tmpdir(), "cortex-bootstrap-"));
  try {
    const r = initProject(root, "Arsa", { language: "en", bootstrapTask: false });
    assert.equal(r.bootstrapTask, null);
    const c = new Cortex(loadProject(root), { embedder: null });
    try {
      assert.equal(c.items.list({}).total, 0);
    } finally {
      c.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
