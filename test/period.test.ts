import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { reportToMarkdown } from "../src/core/reportMarkdown.js";
import { tempProject } from "./helpers.js";

// UI-11: "what happened this week, and which epic is where" from one report: epics are items with task
// boxes, milestones group tasks and issues and take their target from the latest due date.

test("the report lists epics with their boxes and groups milestones with a target and progress", () => {
  const t = tempProject();
  const { cortex: c, human, ai } = t;
  try {
    const epic = c.items.create(ai, {
      type: "task",
      title: "Checkout epic",
      body: "- [x] cart\n- [ ] payment\n- [ ] receipt",
      fields: { milestone: "v1", due: "2020-01-10" },
    });
    c.items.create(ai, { type: "task", title: "Receipt mail", fields: { milestone: "v1", due: "2020-01-05" } });
    const bug = c.items.create(human, { type: "issue", title: "Double charge", category_path: "backend", fields: { severity: "high", milestone: "v1" } });
    c.items.update(human, bug.id, { status: "closed" });
    c.items.create(ai, { type: "task", title: "Later", fields: { milestone: "v2" } });
    c.items.create(ai, { type: "task", title: "No milestone, no boxes" });

    const r = c.reports.build({ since: "7d" });
    assert.deepEqual(
      r.epics.map((e) => [e.title, e.done, e.total, e.milestone, e.open]),
      [["Checkout epic", 1, 3, "v1", true]],
    );
    assert.equal(r.epics[0].id, epic.id);

    const [v1, v2] = r.milestones;
    assert.equal(v1.name, "v1");
    assert.deepEqual([v1.total, v1.done, v1.open, v1.epics, v1.closed_in_period], [3, 1, 2, 1, 1]);
    assert.equal(v1.target, "2020-01-10", "the latest due date is the target");
    assert.equal(v1.overdue, true);
    assert.equal(v2.name, "v2");
    assert.equal(v2.target, null, "no due dates, no target; it sorts after the dated ones");

    const md = reportToMarkdown(r, "en");
    assert.match(md, /## Milestones/);
    assert.match(md, /\| v1 \| 1 \/ 3 \| 2020-01-10 \*\*overdue\*\* \| 1 \|/);
    assert.match(md, /Checkout epic — 1\/3 · v1/);

    // The timeline's bars open the board on their milestone.
    assert.equal(c.items.list({ milestone: "v1" }).total, 3);
    const board = c.items.board({ type: "task", milestone: "v1" });
    assert.equal(
      board.columns.reduce((n, col) => n + col.total, 0),
      2,
    );
  } finally {
    t.cleanup();
  }
});

test("a project whose schema files predate milestones still accepts the field", () => {
  const t = tempProject();
  try {
    const file = join(t.root, ".cortex", "rules", "task.schema.yaml");
    const schema = YAML.parse(readFileSync(file, "utf8")) as { fields: Record<string, unknown> };
    delete schema.fields.milestone;
    writeFileSync(file, YAML.stringify(schema));
    const task = t.cortex.items.create(t.ai, { type: "task", title: "Old project", fields: { milestone: "Beta" } });
    assert.equal(t.cortex.items.get(task.id).item.fields?.milestone, "Beta");
    // Only work items carry a milestone.
    assert.throws(
      () => t.cortex.items.create(t.ai, { type: "note", title: "n", fields: { milestone: "Beta" } }),
      (e: { hint?: { errors?: { path: string; message: string }[] } }) =>
        !!e.hint?.errors?.some((x) => x.path.endsWith("milestone") && /unknown field/.test(x.message)),
    );
  } finally {
    t.cleanup();
  }
});
