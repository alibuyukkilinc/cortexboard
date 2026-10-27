import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isOpenWork, loadSchema } from "../src/core/schema.js";
import { tempProject } from "./helpers.js";

// An accepted decision is settled work: it still has a transition left (accepted → superseded), so it is
// not "terminal", but nobody is waiting on it. Before this it was counted as open work everywhere.

test("an accepted decision stops counting as open work", () => {
  const t = tempProject();
  try {
    const d = t.cortex.items.create(t.ai, { type: "decision", title: "Use iyzico", category_path: "backend", fields: { context: "TRY installments" } });
    assert.equal(t.cortex.index.openItemsUnder(""), 1, "while proposed it waits for a human");

    t.cortex.items.update(t.human, d.id, { status: "accepted" });
    assert.equal(t.cortex.index.openItemsUnder(""), 0);
    assert.equal(t.cortex.index.openItemsUnder("backend"), 0);
    assert.equal(t.cortex.items.list({ open: true }).total, 0);
    assert.deepEqual(
      t.cortex.items.list({ open: false }).items.map((i) => i.id),
      [d.id],
      "it is findable as settled work",
    );
    assert.equal(t.cortex.brief(t.human).branches.find((b) => b.path === "backend")?.open_items, undefined);
    assert.equal(t.cortex.items.inbox(t.human).count, 0, "no longer sits in the inbox as a decision to review");

    // Settled is not the same as terminal: the one transition it still has must keep working.
    assert.equal(t.cortex.items.update(t.human, d.id, { status: "superseded" }).status, "superseded");
    assert.equal(t.cortex.index.openItemsUnder(""), 0);
  } finally {
    t.cleanup();
  }
});

test("other types are unaffected and closed issues still count as closed in reports", () => {
  const t = tempProject();
  try {
    const issue = t.cortex.items.create(t.human, { type: "issue", title: "Double charge", category_path: "backend", fields: { severity: "high" } });
    const task = t.cortex.items.create(t.human, { type: "task", title: "Ship it" });
    assert.equal(t.cortex.index.openItemsUnder(""), 2);

    t.cortex.items.update(t.human, issue.id, { status: "closed" });
    t.cortex.items.update(t.human, task.id, { status: "done" });
    assert.equal(t.cortex.index.openItemsUnder(""), 0);

    const r = t.cortex.reports.build({ since: "1d" });
    assert.equal(r.totals.items_closed.by_type.issue, 1, "closing is still counted as closing");
    assert.equal(r.totals.items_closed.by_type.task, 1);
    assert.equal(r.attention.open_issues, 0);
  } finally {
    t.cleanup();
  }
});

test("accepted decisions still surface as the why behind linked code", () => {
  const t = tempProject();
  try {
    t.cortex.putNode(t.human, { path: "backend/pay", title: "Ödeme", summary: "iyzico.", links: { code: [{ file: "src/pay.ts" }] } });
    const d = t.cortex.items.create(t.human, { type: "decision", title: "Use iyzico", category_path: "backend/pay", fields: { context: "TRY installments" } });
    t.cortex.items.update(t.human, d.id, { status: "accepted" });

    const ctx = t.cortex.codeContext(["src/pay.ts"]);
    assert.deepEqual(
      ctx.items.map((i) => i.id),
      [d.id],
      "an accepted decision is exactly the context an AI needs before editing",
    );
  } finally {
    t.cleanup();
  }
});

test("code context leaves out finished work and dead decisions, counts them, and lists them on request", async () => {
  const t = tempProject();
  try {
    const c = t.cortex;
    c.putNode(t.human, { path: "backend/pay", title: "Ödeme", summary: "iyzico.", links: { code: [{ file: "src/pay.ts" }] } });
    const decide = (title: string, status: string) => {
      const d = c.items.create(t.human, { type: "decision", title, category_path: "backend/pay", fields: { context: "x" } });
      // proposed → accepted → superseded: the only way a decision is replaced.
      for (const step of status === "superseded" ? ["accepted", "superseded"] : status === "proposed" ? [] : [status]) {
        c.items.update(t.human, d.id, { status: step });
      }
      return d.id;
    };
    const current = decide("Use iyzico", "accepted");
    const old = decide("Use PayTR", "superseded");
    const proposed = decide("Add Stripe", "proposed");
    const openTask = c.items.create(t.human, { type: "task", title: "Refunds", links: { code: [{ file: "src/pay.ts" }] } }).id;
    const doneTask = c.items.create(t.human, { type: "task", title: "Checkout", links: { code: [{ file: "src/pay.ts" }] } }).id;
    c.items.update(t.human, doneTask, { status: "done" });

    const ctx = c.codeContext(["src/pay.ts"]);
    assert.deepEqual(new Set(ctx.items.map((i) => i.id)), new Set([current, proposed, openTask]), "what still applies, and what is still open");
    assert.deepEqual(new Set(ctx.closed), new Set([old, doneTask]));
    const all = c.codeContext(["src/pay.ts"], { includeClosed: true });
    assert.equal(all.items.length, 5);
    assert.equal(all.closed.length, 0);

    // Over the API the closed ones become one count.
    const { buildServer } = await import("../src/api/server.js");
    const app = buildServer(c);
    const res = await app.inject({
      url: "/api/code?files=src/pay.ts",
      headers: { host: "localhost:4747", authorization: `Bearer ${t.init.tokens["ai-agent"]}` },
    });
    assert.equal(res.json().closed_items, 2);
    assert.equal(res.json().closed, undefined, "ids stay inside");
    await app.close();
  } finally {
    t.cleanup();
  }
});

test("projects created before `resolved` existed are fixed by upgrading, without touching their rules file", () => {
  const t = tempProject();
  try {
    // Rewrite the decision schema the way init used to write it: no `resolved` key at all.
    const file = join(t.root, ".cortex/rules/decision.schema.yaml");
    writeFileSync(
      file,
      [
        "type: decision",
        "statuses: [proposed, accepted, rejected, superseded]",
        "initial: proposed",
        "terminal: [rejected, superseded]",
        "transitions: { proposed: [accepted, rejected], accepted: [superseded], rejected: [proposed], superseded: [] }",
        "human_only_statuses: [accepted, rejected]",
        "fields:",
        "  context: { type: text, required: true }",
      ].join("\n"),
    );
    const schema = loadSchema(join(t.root, ".cortex/rules"), "decision")!;
    assert.deepEqual(schema.resolved, ["accepted"], "the built-in default fills the gap");
    assert.equal(isOpenWork(schema, "accepted"), false);
    assert.equal(isOpenWork(schema, "proposed"), true);

    // A rules edit re-decides the flag for items already in the index, without re-reading any item file.
    const d = t.cortex.items.create(t.human, { type: "decision", title: "X", fields: { context: "y" } });
    t.cortex.items.update(t.human, d.id, { status: "accepted" });
    assert.equal(t.cortex.sync(["rules/decision.schema.yaml"]).reterm >= 0, true);
    assert.equal(t.cortex.index.openItemsUnder(""), 0);
  } finally {
    t.cleanup();
  }
});
