import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { tempProject } from "./helpers.js";

test("a task reply carries evidence (commits or links) and how the acceptance criteria were met", () => {
  const t = tempProject();
  try {
    const id = t.cortex.items.create(t.human, { type: "task", title: "Export", assignee: "@ai" }).id;
    t.cortex.items.reply(t.ai, id, {
      body: "Done.",
      status: "review",
      fields: { evidence: ["a1b2c3d", "https://github.com/acme/shop/pull/12"], acceptance: "- CSV opens in Excel: checked with the sample file." },
    });
    const r = t.cortex.items.get(id).replies[0];
    assert.deepEqual(r.fields?.evidence, ["a1b2c3d", "https://github.com/acme/shop/pull/12"]);
    assert.throws(
      () => t.cortex.items.reply(t.ai, id, { body: "More.", fields: { evidence: ["see chat"] } }),
      (e: { hint?: { issues?: string[] } }) => /commit hash or an http\(s\) link/.test(e.hint?.issues?.[0] ?? ""),
    );
  } finally {
    t.cleanup();
  }
});

test("a project whose task rules predate reply fields gets them from the built-in type", () => {
  const t = tempProject();
  try {
    const file = join(t.root, ".cortex/rules/task.schema.yaml");
    const doc = YAML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    delete doc.reply;
    writeFileSync(file, YAML.stringify(doc));
    assert.ok(t.cortex.schema("task")?.reply?.fields?.evidence, "falls back to the built-in reply fields");
    // A project that defines its own reply fields keeps exactly those.
    writeFileSync(file, YAML.stringify({ ...doc, reply: { fields: { hours: { type: "number" } } } }));
    assert.deepEqual(Object.keys(t.cortex.schema("task")?.reply?.fields ?? {}), ["hours"]);
  } finally {
    t.cleanup();
  }
});
