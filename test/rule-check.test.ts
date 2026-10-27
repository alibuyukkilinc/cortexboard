import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/api/server.js";
import { gitProject } from "./helpers.js";

// Decision 01M3MXD9VVDQJSDEFX60PQTAWH: logged work is checked against the accepted decisions governing its files;
// people see only what was broken or never answered.
function setup() {
  const p = gitProject();
  const c = p.cortex;
  c.putNode(p.human, { path: "backend", title: "Backend", summary: "The API." });
  c.putNode(p.human, { path: "backend/auth", title: "Auth", summary: "Login.", links: { code: [{ file: "src/auth/login.ts" }] } });
  c.putNode(p.human, { path: "backend/pay", title: "Pay", summary: "Payments.", links: { code: [{ file: "src/pay/iyzico.ts" }] } });
  const decide = (title: string, category_path?: string) => {
    const r = c.items.create(p.human, { type: "decision", title, category_path, fields: { context: "why" } } as never) as { id: string };
    c.items.update(p.human, r.id, { status: "accepted" } as never);
    return r.id;
  };
  const d = {
    branch: decide("Backend answers in under 200 ms", "backend"), // above the linked node
    auth: decide("Passwords are hashed with scrypt", "backend/auth"), // the linked node itself
    pay: decide("Refunds go through the provider", "backend/pay"), // another node: not these files
    root: decide("Everything in English", undefined), // no branch: never asked
  };
  return { p, c, d };
}

test("rule check: the decisions of the linked node and the branches above it, not other nodes or the root", () => {
  const { p, c, d } = setup();
  try {
    const ids = c.ruleChecks
      .applicable(["src/auth/login.ts"])
      .map((x) => x.id)
      .sort();
    assert.deepEqual(ids, [d.branch, d.auth].sort());
    assert.deepEqual(c.ruleChecks.applicable(["README.md"]), [], "a file no knowledge links is governed by nothing");
  } finally {
    p.cleanup();
  }
});

test("rule check: answers at log time, a broken one needs its reason, the rest is flagged not refused", () => {
  const { p, c, d } = setup();
  try {
    assert.throws(
      () =>
        c.activity.log(p.ai, {
          action: "fix",
          summary: "Faster login",
          why: "slow",
          files: ["src/auth/login.ts"],
          decisions: [{ id: d.auth, verdict: "broken" }],
        }),
      (e: unknown) => JSON.stringify(e).includes("say why"),
    );
    const r = c.activity.log(p.ai, {
      action: "fix",
      summary: "Faster login",
      why: "slow",
      files: ["src/auth/login.ts"],
      decisions: [{ id: d.auth, verdict: "broken", note: "bcrypt kept for old hashes" }],
    }) as { id: string; rule_check: { unanswered: { id: string }[]; broken: { id: string }[] }; rule_check_hint?: string };
    assert.deepEqual(
      r.rule_check.broken.map((x) => x.id),
      [d.auth],
    );
    assert.deepEqual(
      r.rule_check.unanswered.map((x) => x.id),
      [d.branch],
    );
    assert.match(r.rule_check_hint ?? "", /cortex_answer_rules/);

    // The AI is reminded in its brief, and answers later.
    const brief = c.brief(p.ai).attention as { unanswered_rule_checks?: { count: number } };
    assert.equal(brief.unanswered_rule_checks?.count, 1);
    const later = c.ruleChecks.answer(p.ai, r.id, [{ id: d.branch, verdict: "followed" }]);
    assert.equal(later.rule_check!.unanswered.length, 0);
    assert.equal((c.brief(p.ai).attention as { unanswered_rule_checks?: unknown }).unanswered_rule_checks, undefined);

    // Only the actor who logged it (or a person) answers for it.
    c.project.config.actors.push({ id: "other-ai", kind: "ai" });
    assert.throws(() => c.ruleChecks.answer(c.actor("other-ai"), r.id, [{ id: d.branch, verdict: "n/a" }]), /Only the actor/);

    // The report lists the exception, not the rule that was kept.
    const rep = c.ruleChecks.report();
    assert.equal(rep.counts.entries, 1);
    assert.equal(rep.counts.followed, 1);
    assert.equal(rep.counts.broken, 1);
    assert.equal(rep.broken[0]!.decision.note, "bcrypt kept for old hashes");
    assert.equal(rep.unanswered.length, 0);
    assert.equal(c.reports.build({ since: "7d" }).rule_checks.counts.broken, 1);
  } finally {
    p.cleanup();
  }
});

test("rule check: work with no files, or on files no decision governs, carries no check", () => {
  const { p, c } = setup();
  try {
    const a = c.activity.log(p.ai, { action: "investigation", summary: "Looked around" }) as { id: string; rule_check?: unknown };
    assert.equal(a.rule_check, undefined);
    assert.equal(c.activity.get(a.id).rule_check, undefined);
    const b = c.activity.log(p.ai, { action: "docs", summary: "Readme", files: ["README.md"] }) as { rule_check?: unknown };
    assert.equal(b.rule_check, undefined);
    assert.equal(c.ruleChecks.report().counts.entries, 0);
  } finally {
    p.cleanup();
  }
});

test("rule check over REST: code context names what will be checked, answers come after the log", async () => {
  const { p, d } = setup();
  const app = buildServer(p.cortex);
  const as = (who: "owner" | "ai-agent") => ({ host: "localhost", authorization: `Bearer ${p.init.tokens[who]}` });
  try {
    const ctx = (await app.inject({ url: "/api/code?files=src/auth/login.ts", headers: as("ai-agent") })).json();
    assert.deepEqual(ctx.decisions_to_check.map((x: { id: string }) => x.id).sort(), [d.branch, d.auth].sort());
    const logged = await app.inject({
      method: "POST",
      url: "/api/activity",
      headers: as("ai-agent"),
      payload: { action: "fix", summary: "Login", why: "bug", files: ["src/auth/login.ts"] },
    });
    assert.equal(logged.statusCode, 201, logged.body);
    const id = logged.json().id as string;
    assert.equal(logged.json().rule_check.unanswered.length, 2);
    const answered = await app.inject({
      method: "POST",
      url: `/api/activity/${id}/rules`,
      headers: as("ai-agent"),
      payload: {
        decisions: [
          { id: d.branch, verdict: "followed" },
          { id: d.auth, verdict: "n/a" },
        ],
      },
    });
    assert.equal(answered.statusCode, 200, answered.body);
    const rep = (await app.inject({ url: "/api/rule-checks?since=7d", headers: as("owner") })).json();
    assert.equal(rep.counts.unanswered, 0);
    assert.equal(rep.counts.not_applicable, 1);
  } finally {
    await app.close();
    p.cleanup();
  }
});

test("rule check: the most specific decisions are asked about, up to the cap; the broader rest is listed", () => {
  const { p, c, d } = setup();
  try {
    assert.deepEqual(
      c.ruleChecks.applicable(["src/auth/login.ts"]).map((x) => x.id),
      [d.auth, d.branch],
      "the node's own decision before the branch above it",
    );
    c.project.config.decision_checks = { max_asked: 1 };
    const sel = c.ruleChecks.select(["src/auth/login.ts"]);
    assert.deepEqual(
      sel.asked.map((x) => x.id),
      [d.auth],
    );
    assert.deepEqual(
      sel.also.map((x) => x.id),
      [d.branch],
    );
    const r = c.activity.log(p.ai, { action: "fix", summary: "Login", why: "bug", files: ["src/auth/login.ts"] }) as {
      id: string;
      rule_check: { unanswered: { id: string }[]; also?: { id: string }[] };
    };
    assert.deepEqual(
      r.rule_check.unanswered.map((x) => x.id),
      [d.auth],
      "only the asked one waits for an answer",
    );
    assert.deepEqual(
      r.rule_check.also?.map((x) => x.id),
      [d.branch],
    );
  } finally {
    p.cleanup();
  }
});
