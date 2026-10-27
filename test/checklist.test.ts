import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/api/server.js";
import { countChecklist, parseChecklist, setBox } from "../src/core/checklist.js";
import { tempProject } from "./helpers.js";

const body = [
  "## Steps",
  "- [x] Design",
  "- [ ] Build",
  "  - [x] API",
  "    * [ ] nested twice",
  "1. [X] ordered",
  "2) [ ] ordered too",
  "> - [ ] quoted",
  "- [ ]no space is not a box",
  "- not a box [ ]",
  "",
  "```md",
  "- [ ] an example inside a code block",
  "~~~",
  "- [ ] still inside: a fence of the other kind does not close",
  "```",
  "~~~~",
  "- [x] inside a tilde block",
  "~~~",
  "- [x] still inside: too short to close",
  "~~~~",
  "- [ ] Test",
].join("\n");

test("the parser counts boxes at any depth and skips code blocks", () => {
  const boxes = parseChecklist(body);
  assert.deepEqual(
    boxes.map((b) => [b.line, b.checked, b.text, b.depth]),
    [
      [1, true, "Design", 0],
      [2, false, "Build", 0],
      [3, true, "API", 2],
      [4, false, "nested twice", 4],
      [5, true, "ordered", 0],
      [6, false, "ordered too", 0],
      [7, false, "quoted", 0],
      [21, false, "Test", 0],
    ],
  );
  assert.deepEqual(countChecklist(body), { done: 3, total: 8 });
  const ticked = setBox(body, 4, true)!;
  assert.equal(ticked.split("\n")[4], "    * [x] nested twice");
  assert.equal(setBox(body, 12, true), null, "a line inside a code block is not a box");
  assert.equal(setBox(body, 0, true), null);
});

test("a 13-step epic shows its progress in lists; ticking goes through versions and if_rev", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const H = { host: "localhost:4747", authorization: `Bearer ${t.init.tokens.owner}` };
  try {
    const steps = Array.from({ length: 13 }, (_, i) => `- [${i < 5 ? "x" : " "}] Step ${i + 1}`).join("\n");
    const id = t.cortex.items.create(t.human, { type: "task", title: "Epic", body: `## Steps\n${steps}` }).id;
    t.cortex.items.create(t.human, { type: "task", title: "Plain" });
    const list = (await app.inject({ url: "/api/items?type=task", headers: H })).json().items;
    assert.deepEqual(list.find((i: { id: string }) => i.id === id).checklist, { done: 5, total: 13 });
    assert.equal(list.find((i: { title: string }) => i.title === "Plain").checklist, undefined, "no boxes, no field");

    const rev = (await app.inject({ url: `/api/items/${id}`, headers: H })).json().rev;
    const first = await app.inject({ method: "PATCH", url: `/api/items/${id}/checklist`, headers: H, payload: { line: 6, checked: true, if_rev: rev } });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json().checklist, { done: 6, total: 13 });
    assert.notEqual(first.json().rev, rev);
    // A second click made from the same, now old, revision is refused.
    const second = await app.inject({ method: "PATCH", url: `/api/items/${id}/checklist`, headers: H, payload: { line: 7, checked: true, if_rev: rev } });
    assert.equal(second.statusCode, 409);
    const third = await app.inject({
      method: "PATCH",
      url: `/api/items/${id}/checklist`,
      headers: H,
      payload: { line: 7, checked: true, if_rev: first.json().rev },
    });
    assert.equal(third.statusCode, 200);

    assert.equal(t.cortex.items.history(id).versions.length, 2, "each tick is a version");
    const bad = await app.inject({ method: "PATCH", url: `/api/items/${id}/checklist`, headers: H, payload: { line: 0, checked: true } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.hint.boxes.length, 13, "a wrong line answers with the boxes there are");
  } finally {
    await app.close();
    t.cleanup();
  }
});
