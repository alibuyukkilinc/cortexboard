import { test } from "node:test";
import assert from "node:assert/strict";
import { editBody } from "../src/core/nodeEdit.js";
import type { Actor } from "../src/core/types.js";
import { tempProject } from "./helpers.js";

// An agent whose knowledge writes apply directly (a Trusted hub agent), as in this repository.
const trusted = (ai: Actor): Actor => ({ ...ai, policy: { node: "auto" } });

const BODY = [
  "Intro line.",
  "",
  "## Hub",
  "Hub text.",
  "",
  "### Hub detail",
  "Detail.",
  "",
  "## Backups",
  "Old backup text.",
  "",
  "```md",
  "## not a heading",
  "```",
  "",
].join("\n");

test("editBody: a section is its heading down to the next heading of the same or a higher level", () => {
  const out = editBody(BODY, { body: "New hub text.", section: "hub" });
  assert.match(out, /## Hub\nNew hub text\.\n\n## Backups/, "the sub-heading under it goes with it; the heading stays");
  assert.doesNotMatch(out, /Hub detail/);
  assert.match(out, /Old backup text/, "other sections untouched");
  assert.match(out, /^Intro line\./);

  const renamed = editBody(BODY, { body: "## Backups (BunnyCDN, Drive)\nNew.", section: "Backups" });
  assert.match(renamed, /## Backups \(BunnyCDN, Drive\)\nNew\./, "text with its own heading replaces the heading too");
  assert.doesNotMatch(renamed, /Old backup text/);
  assert.doesNotMatch(renamed, /## not a heading\n```/, "a heading inside a code block was part of the section, not a new one");

  const appended = editBody(BODY, { body: "One more line.", section: "Hub detail", body_mode: "append" });
  assert.match(appended, /### Hub detail\nDetail\.\n\nOne more line\.\n\n## Backups/);

  const added = editBody(BODY, { body: "Why it exists.", section: "History" });
  assert.match(added, /## History\n\nWhy it exists\.\n$/, "a missing section is added at the end");

  assert.equal(editBody("a", { body: "b", body_mode: "append" }), "a\n\nb");
  assert.equal(editBody("a", { body: "b" }), "b");
});

test("update node by section: only that part is sent, the rest (title, summary, links) stays", () => {
  const t = tempProject();
  try {
    const c = t.cortex;
    c.putNode(t.human, { path: "backend", title: "Backend", summary: "API" });
    c.putNode(t.human, { path: "backend/hub", title: "Hub", summary: "Team server.", body: BODY, links: { code: [{ file: "src/hub/server.ts" }] } });

    const r = c.putNode(trusted(t.ai), { path: "backend/hub", body: "Now encrypted.", section: "Backups", reason: "backups changed" } as never);
    assert.equal(r.applied, true);
    const n = c.node("backend/hub");
    assert.equal(n.title, "Hub");
    assert.equal(n.summary, "Team server.");
    assert.deepEqual(n.links?.code, [{ file: "src/hub/server.ts" }], "links kept on a partial edit");
    assert.match(n.body, /## Backups\nNow encrypted\./);
    assert.match(n.body, /Hub text\./);
  } finally {
    t.cleanup();
  }
});

test("an AI sending a part as the whole is stopped; a big node gets a hint to split", () => {
  const t = tempProject();
  try {
    const c = t.cortex;
    c.putNode(t.human, { path: "backend", title: "Backend", summary: "API", body: "x".repeat(400) });
    const err = (() => {
      try {
        c.putNode(trusted(t.ai), { path: "backend", title: "Backend", summary: "API", body: "only this", reason: "edit" });
      } catch (e) {
        return e as { code: string };
      }
    })();
    assert.equal(err?.code, "body_shrink");
    assert.equal(
      c.putNode(trusted(t.ai), { path: "backend", title: "Backend", summary: "API", body: "only this", reason: "cut", confirm_shrink: true } as never).applied,
      true,
    );
    assert.equal(c.putNode(t.human, { path: "backend", title: "Backend", summary: "API", body: "" }).applied, true, "people are not stopped");

    const big = c.putNode(t.human, { path: "backend", title: "Backend", summary: "API", body: "y".repeat(9000) });
    assert.match(big.hint ?? "", /child nodes/);
  } finally {
    t.cleanup();
  }
});
