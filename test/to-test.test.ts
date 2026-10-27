import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { toTest } from "../src/core/toTest.js";
import { tempProject } from "./helpers.js";

test("toTest: the list under a 'to test' heading, else the open boxes, else nothing", () => {
  const reply = [
    "Done: refunds are idempotent (abc1234).",
    "",
    "**Denemen gerekenler:**",
    "- [ ] Pay, then refund twice: one refund.",
    "- [x] `npm test` passes",
    "  (all 270)",
    "",
    "Details: the key is stored on the payment.",
    "- [ ] not a step: after the list",
  ].join("\n");
  assert.deepEqual(toTest(reply), ["Pay, then refund twice: one refund.", "`npm test` passes (all 270)"]);
  assert.deepEqual(toTest("Summary.\n\n## To test\n\n1. Open the board\n2. Click Send\n\n## Notes\n- x"), ["Open the board", "Click Send"]);
  assert.deepEqual(toTest("Nasıl denenir: `npm test` (tüm paket)"), ["`npm test` (tüm paket)"]);
  assert.deepEqual(toTest("Did it.\n- [ ] Restart the hub\n- [x] built\n- [ ] Ask for a card"), ["Restart the hub", "Ask for a card"]);
  assert.deepEqual(toTest("Just a note, nothing to try."), []);
});

test("review rows carry what to try and since when; the agent's brief names work waiting for days", () => {
  const t = tempProject();
  try {
    const c = t.cortex;
    const task = c.items.create(t.ai, { type: "task", title: "Ship refunds" });
    c.items.reply(t.ai, task.id, { body: "Refunds ship.\n\nDenemen gerekenler:\n- [ ] Refund twice\n- [ ] Check the report", status: "review" });

    const row = (c.items.inbox(t.human, 20).items as { id: string; reason: string; to_test?: string[]; waiting_since?: string }[]).find(
      (i) => i.id === task.id,
    )!;
    assert.equal(row.reason, "review_waiting_on_you");
    assert.deepEqual(row.to_test, ["Refund twice", "Check the report"]);
    assert.ok(row.waiting_since);

    assert.equal((c.brief(t.ai) as { attention: Record<string, unknown> }).attention.waiting_on_review, undefined, "not yet: handed in today");
    const later = Date.now() + 4 * 86_400_000;
    mock.method(Date, "now", () => later);
    const waiting = (c.brief(t.ai) as { attention: { waiting_on_review?: { count: number; top: { id: string; days: number }[] } } }).attention
      .waiting_on_review;
    mock.restoreAll();
    assert.equal(waiting?.count, 1);
    assert.equal(waiting?.top[0].id, task.id);
    assert.equal(waiting?.top[0].days, 4);
  } finally {
    mock.restoreAll();
    t.cleanup();
  }
});
