import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cortex, validateRulesDoc } from "../src/core/cortex.js";
import { loadProject } from "../src/core/project.js";
import { itemRevision } from "../src/core/items.js";
import type { Actor, CortexError } from "../src/core/types.js";
import { estimateTokens } from "../src/util/text.js";
import { buildServer } from "../src/api/server.js";
import { tempProject } from "./helpers.js";

function err(fn: () => unknown): CortexError {
  try {
    fn();
  } catch (e) {
    return e as CortexError;
  }
  throw new Error("expected an error");
}

test("init writes editable schemas for every built-in type", () => {
  const t = tempProject();
  try {
    for (const type of ["task", "issue", "question", "note", "decision", "discussion", "activity"]) {
      assert.ok(existsSync(join(t.root, `.cortex/rules/${type}.schema.yaml`)), type);
    }
    assert.ok(existsSync(join(t.root, ".cortex/.gitattributes")));
    assert.deepEqual(t.cortex.itemTypes(), ["task", "issue", "question", "note", "decision", "discussion"]);
  } finally {
    t.cleanup();
  }
});

test("issues are validated against their schema and explain how to fix it", () => {
  const t = tempProject();
  try {
    const e = err(() => t.cortex.items.create(t.ai, { type: "issue", title: "Login 500", fields: { colour: "red" } }));
    assert.equal(e.code, "invalid_item");
    const hint = e.hint as { issues: string[]; rules: { example: object; fields: object } };
    assert.ok(hint.issues.some((i) => i.startsWith("category_path")));
    assert.ok(hint.issues.some((i) => i.startsWith("severity: required")));
    assert.ok(hint.issues.some((i) => i.startsWith("colour: unknown field")));
    assert.ok(hint.rules.example, "the rules and an example travel with the error");

    assert.equal(err(() => t.cortex.items.create(t.ai, { type: "bug", title: "x" })).code, "unknown_type");
    assert.equal(
      err(() => t.cortex.items.create(t.ai, { type: "issue", title: "x", category_path: "nope", fields: { severity: "low" } })).code,
      "invalid_item",
    );

    const r = t.cortex.items.create(t.ai, { type: "issue", title: "Login returns 500", category_path: "backend", fields: { severity: "high" } });
    assert.equal(r.applied, true);
    assert.equal(r.status, "open");
    const dirs = readdirSync(join(t.root, ".cortex/items")).filter((d) => d !== ".gitkeep");
    assert.deepEqual(dirs, [`${r.id}-login-returns-500`]);
  } finally {
    t.cleanup();
  }
});

test("status transitions follow the schema; humans may force", () => {
  const t = tempProject();
  try {
    const { id } = t.cortex.items.create(t.human, { type: "issue", title: "Slow page", category_path: "frontend", fields: { severity: "low" } });
    const e = err(() => t.cortex.items.update(t.ai, id, { status: "review" }));
    assert.equal(e.code, "invalid_transition");
    assert.deepEqual((e.hint as { allowed_from_here: string[] }).allowed_from_here, ["in_progress", "closed"]);
    assert.equal(err(() => t.cortex.items.update(t.ai, id, { status: "review", force: true })).code, "invalid_transition", "AIs cannot force");
    assert.equal(t.cortex.items.update(t.human, id, { status: "review", force: true }).status, "review");
    assert.equal(err(() => t.cortex.items.update(t.ai, id, { status: "wontfix" })).code, "invalid_status");
  } finally {
    t.cleanup();
  }
});

test("AI can propose a decision but only a human can accept it", async () => {
  const t = tempProject();
  try {
    const d = t.cortex.items.create(t.ai, {
      type: "decision",
      title: "Use iyzico for card payments",
      category_path: "backend",
      body: "All card payments go through iyzico.",
      fields: { context: "Need installments in TRY.", alternatives: "Stripe: no installments in TR." },
    });
    assert.equal(d.status, "proposed");
    const inbox = t.cortex.items.inbox(t.human);
    assert.deepEqual(
      inbox.items.map((i) => [i.id, i.reason]),
      [[d.id, "decision_needs_review"]],
    );

    assert.equal(err(() => t.cortex.items.update(t.ai, d.id, { status: "accepted" })).code, "forbidden");
    assert.equal(t.cortex.items.update(t.human, d.id, { status: "accepted" }).status, "accepted");
    assert.equal(t.cortex.items.inbox(t.human).count, 0);

    // "Why did we pick iyzico?" is answered by search, not by re-reading docs.
    const hits = (await t.cortex.search("neden iyzico taksit", { kinds: ["item"] })).results;
    assert.equal(hits[0]?.id, d.id);
    assert.equal((await t.cortex.search("installments", { type: "decision" })).results[0]?.id, d.id);
  } finally {
    t.cleanup();
  }
});

test("question round trip: AI asks humans, human answers, AI closes", () => {
  const t = tempProject();
  try {
    const low = t.cortex.items.create(t.ai, { type: "question", title: "Which log level in prod?", assignee: "@humans" });
    const q = t.cortex.items.create(t.ai, {
      type: "question",
      title: "Should guest checkout create an account?",
      assignee: "@humans",
      fields: { blocking: true },
    });
    const humanInbox = t.cortex.items.inbox(t.human);
    assert.deepEqual(
      humanInbox.items.map((i) => i.id),
      [q.id, low.id],
      "blocking questions come first",
    );
    assert.equal(humanInbox.items[0].reason, "assigned_to_group");
    assert.equal(t.cortex.items.inbox(t.ai).count, 0, "the asker is not asked");

    const r = t.cortex.items.reply(t.human, q.id, { body: "No, keep it guest-only." });
    assert.equal(r.status, "answered", "answering moves the question automatically");
    assert.deepEqual(
      t.cortex.items.inbox(t.ai).items.map((i) => [i.id, i.reason]),
      [[q.id, "your_question_answered"]],
    );
    assert.ok(!t.cortex.items.inbox(t.human).items.some((i) => i.id === q.id), "no longer waiting on humans");

    t.cortex.items.update(t.ai, q.id, { status: "closed" });
    assert.equal(t.cortex.items.inbox(t.ai).count, 0);
    const full = t.cortex.items.get(q.id);
    assert.equal(full.replies.length, 1);
    assert.deepEqual(full.replies[0].status_change, { from: "open", to: "answered" });
  } finally {
    t.cleanup();
  }
});

test("a 'fixed' reply must carry commits and files", () => {
  const t = tempProject();
  try {
    const { id } = t.cortex.items.create(t.human, {
      type: "issue",
      title: "Crash on save",
      category_path: "backend",
      assignee: "ai-agent",
      fields: { severity: "critical" },
    });
    assert.deepEqual(
      t.cortex.items.inbox(t.ai).items.map((i) => i.reason),
      ["assigned_to_you"],
    );
    t.cortex.items.update(t.ai, id, { status: "in_progress" });

    const e = err(() => t.cortex.items.reply(t.ai, id, { body: "Fixed.", fields: { resolution: "fixed" }, status: "review" }));
    assert.equal(e.code, "invalid_item");
    assert.match((e.hint as { issues: string[] }).issues[0], /commits and changed files/);

    const r = t.cortex.items.reply(t.ai, id, {
      body: "Null check added.",
      fields: { resolution: "fixed", commits: ["a1b2c3d"], files: ["src/save.ts"] },
      status: "review",
    });
    assert.equal(r.status, "review");
    assert.deepEqual(
      t.cortex.items.inbox(t.human).items.map((i) => [i.id, i.reason]),
      [[id, "review_waiting_on_you"]],
      "the human author sees the fix as work to check",
    );
    assert.equal(err(() => t.cortex.items.reply(t.ai, id, { body: "x", fields: { resolution: "done" } })).code, "invalid_item");
  } finally {
    t.cleanup();
  }
});

test("activity: why is required for changes, refs must exist, humans can ask about any entry", async () => {
  const t = tempProject();
  try {
    const bad = err(() => t.cortex.activity.log(t.ai, { action: "fix", summary: "Patched login", refs: ["backend/nope"] }));
    assert.equal(bad.code, "invalid_activity");
    const issues = (bad.hint as { issues: string[] }).issues;
    assert.ok(issues.some((i) => i.startsWith("why: required")));
    assert.ok(issues.some((i) => i.startsWith("refs:")));
    assert.equal(err(() => t.cortex.activity.log(t.ai, { action: "hack", summary: "x" })).code, "invalid_activity");

    const a = t.cortex.activity.log(t.ai, {
      action: "fix",
      summary: "Rate-limit login",
      why: "Brute-force attempts seen in logs",
      files: ["src/auth/login.ts"],
      commit: "d4e5f6a",
      refs: ["backend"],
    });
    assert.equal(t.cortex.activity.list({}).entries[0].id, a.id);
    assert.equal(t.cortex.activity.list({ ref: "backend" }).entries.length, 1);
    assert.equal((await t.cortex.search("brute force")).results[0]?.id, a.id, "the reason is searchable");

    const q = t.cortex.items.ask(t.human, { about: a.id, title: "Why 5 attempts and not 10?" });
    const item = t.cortex.items.get(q.id).item;
    assert.equal(item.assignee, "ai-agent", "routed to whoever did it");
    assert.deepEqual(item.links?.activity, [a.id]);
    assert.equal(item.category_path, "backend");
    assert.equal(t.cortex.items.inbox(t.ai).items[0].id, q.id);

    // Asking about your own work goes to the other side.
    t.cortex.putNode(t.human, { path: "backend/cache", title: "Cache", summary: "Redis." });
    const self = t.cortex.items.ask(t.human, { about: "backend/cache", title: "Is this still true?" });
    assert.equal(t.cortex.items.get(self.id).item.assignee, "@ai");

    assert.equal(err(() => t.cortex.items.ask(t.human, { about: "nowhere/at-all", title: "?" })).code, "not_found");

    const audit = t.cortex.activity.list({ include_system: true }).entries;
    assert.ok(audit.some((e) => e.system && e.action === "item.created"));
    assert.ok(!t.cortex.activity.list({}).entries.some((e) => e.system), "system entries are hidden by default");
  } finally {
    t.cleanup();
  }
});

test("review policy turns AI item writes into drafts", () => {
  const t = tempProject();
  try {
    t.cortex.project.config.approval.task = "review";
    const r = t.cortex.items.create(t.ai, { type: "task", title: "Refactor checkout", category_path: "backend" });
    assert.equal(r.applied, false);
    assert.equal(err(() => t.cortex.items.get(r.id)).code, "not_found");
    assert.equal(t.cortex.listDrafts()[0].kind, "item");

    t.cortex.approve(t.human, r.draft_id!);
    assert.equal(t.cortex.items.get(r.id).item.title, "Refactor checkout");

    const edit = t.cortex.items.update(t.ai, r.id, { title: "Refactor checkout flow" });
    t.cortex.items.update(t.human, r.id, { title: "Human changed it meanwhile" });
    assert.equal(err(() => t.cortex.approve(t.human, edit.draft_id!)).code, "conflict");

    t.cortex.project.config.approval.note = "human_only";
    assert.equal(err(() => t.cortex.items.create(t.ai, { type: "note", title: "x" })).code, "forbidden");
    assert.equal(t.cortex.items.create(t.human, { type: "note", title: "x" }).applied, true);
  } finally {
    t.cleanup();
  }
});

test("custom item types come from a rules file", () => {
  const t = tempProject();
  try {
    writeFileSync(
      join(t.root, ".cortex/rules/incident.schema.yaml"),
      [
        "type: incident",
        "statuses: [open, mitigated, resolved]",
        "initial: open",
        "terminal: [resolved]",
        "transitions: { open: [mitigated], mitigated: [resolved] }",
        "fields:",
        "  started_at: { type: datetime, required: true }",
        "  impact: { type: enum, values: [minor, major], required: true }",
      ].join("\n"),
    );
    assert.ok(t.cortex.itemTypes().includes("incident"));
    const e = err(() => t.cortex.items.create(t.human, { type: "incident", title: "API down", fields: { started_at: "yesterday", impact: "major" } }));
    assert.match((e.hint as { issues: string[] }).issues[0], /ISO-8601/);
    const ok = t.cortex.items.create(t.human, { type: "incident", title: "API down", fields: { started_at: "2026-09-22T08:00:00Z", impact: "major" } });
    assert.equal(ok.status, "open");
    assert.equal((t.cortex.rules("incident").rules.incident as { type: string }).type, "incident");
  } finally {
    t.cleanup();
  }
});

test("brief surfaces the inbox and open items, and stays small", () => {
  const t = tempProject();
  try {
    for (let i = 0; i < 8; i++) {
      t.cortex.items.create(t.human, {
        type: "issue",
        title: `Bug number ${i} in the payment flow`,
        category_path: "backend",
        assignee: "@ai",
        fields: { severity: "medium" },
      });
    }
    t.cortex.activity.log(t.ai, { action: "investigation", summary: "Read the payment module" });
    const brief = t.cortex.brief(t.ai);
    assert.equal(brief.attention.inbox.count, 8);
    assert.equal(brief.attention.inbox.top.length, 5);
    assert.equal(brief.branches.find((b) => b.path === "backend")?.open_items, 8);
    assert.equal(brief.recent_activity[0].summary, "Read the payment module");
    assert.ok(estimateTokens(brief) < 800, `brief is ${estimateTokens(brief)} tokens`);
    assert.equal(t.cortex.treeView("").node.children?.find((c) => c.path === "backend")?.open_items, 8);

    const page1 = t.cortex.items.list({ type: "issue", limit: 5 });
    assert.equal(page1.items.length, 5);
    assert.equal(page1.total, 8);
    const page2 = t.cortex.items.list({ type: "issue", limit: 5, cursor: page1.next_cursor! });
    assert.equal(page2.items.length, 3);
    assert.equal(page2.next_cursor, null);
    assert.equal("body" in page1.items[0], false, "lists never include bodies");
  } finally {
    t.cleanup();
  }
});

test("items, replies and activity survive an index rebuild", async () => {
  const t = tempProject();
  try {
    const q = t.cortex.items.create(t.ai, { type: "question", title: "Staging URL?", assignee: "owner" });
    t.cortex.items.reply(t.human, q.id, { body: "staging.example.com" });
    t.cortex.activity.log(t.ai, { action: "docs", summary: "Documented staging" });
    t.cortex.close();
    rmSync(join(t.root, ".cortex/.index"), { recursive: true, force: true });

    const fresh = new Cortex(loadProject(t.root), { embedder: null });
    try {
      assert.equal(fresh.items.get(q.id).replies[0].body, "staging.example.com");
      assert.equal(fresh.items.inbox(fresh.actor("ai-agent")).items[0].reason, "your_question_answered");
      assert.equal(fresh.activity.list({}).entries[0].summary, "Documented staging");
      assert.equal((await fresh.search("staging example")).results[0]?.id, q.id, "reply text is searchable");
    } finally {
      fresh.close();
    }
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("replies are trimmed newest-first to fit a budget", () => {
  const t = tempProject();
  try {
    const { id } = t.cortex.items.create(t.human, { type: "task", title: "Long discussion" });
    for (let i = 0; i < 20; i++) t.cortex.items.reply(i % 2 ? t.ai : t.human, id, { body: `Reply ${i} `.repeat(20) });
    const last3 = t.cortex.items.get(id, { replies: 3 });
    assert.equal(last3.replies.length, 3);
    assert.equal(last3.replies_omitted, 17);
    assert.match(last3.replies[2].body, /^Reply 19/);
    const budgeted = t.cortex.items.get(id, { budget: 400 });
    assert.ok(budgeted.replies.length < 20 && budgeted.replies.length > 0);
    assert.match(budgeted.replies[budgeted.replies.length - 1].body, /^Reply 19/);
  } finally {
    t.cleanup();
  }
});

test("update() with if_rev: mismatched rev conflicts, matching rev applies, omitted rev keeps old last-write-wins behavior", () => {
  const t = tempProject();
  try {
    const { id } = t.cortex.items.create(t.human, { type: "task", title: "Rate limiting" });
    const rev = t.cortex.items.get(id).rev;

    const stale = err(() => t.cortex.items.update(t.ai, id, { body: "AI's edit", if_rev: "not-the-real-rev" }));
    assert.equal(stale.code, "conflict");
    assert.equal((stale.hint as { current_updated_by: string }).current_updated_by, t.human.id);

    const ok = t.cortex.items.update(t.ai, id, { body: "AI's edit", if_rev: rev });
    assert.equal(ok.applied, true);

    // No if_rev at all: still last-write-wins, unchanged from before this feature.
    const r2 = t.cortex.items.update(t.human, id, { body: "human's edit, no if_rev" });
    assert.equal(r2.applied, true);
  } finally {
    t.cleanup();
  }
});

test("claim: unclaimed succeeds, a second actor is refused while held, releasing frees it, force lets a human take over", () => {
  const t = tempProject();
  const ai2: Actor = { id: "ai-2", kind: "ai" };
  try {
    const { id } = t.cortex.items.create(t.human, { type: "task", title: "Add rate limiting" });

    const claimed = t.cortex.items.claim(t.ai, id, { action: "claim" });
    assert.equal(claimed.applied, true);
    assert.equal(t.cortex.itemStore.read(id)!.claimed_by, t.ai.id);

    // Same actor re-claiming is idempotent, not a conflict.
    assert.equal(t.cortex.items.claim(t.ai, id, { action: "claim" }).applied, true);

    const conflict = err(() => t.cortex.items.claim(ai2, id, { action: "claim" }));
    assert.equal(conflict.code, "conflict");
    assert.equal((conflict.hint as { held_by: string }).held_by, t.ai.id);

    // An AI cannot force its way in.
    assert.equal(err(() => t.cortex.items.claim(ai2, id, { action: "claim", force: true })).code, "conflict");

    // A human can.
    assert.equal(t.cortex.items.claim(t.human, id, { action: "claim", force: true }).applied, true);
    assert.equal(t.cortex.itemStore.read(id)!.claimed_by, t.human.id);

    // Only the holder may release; then anyone can claim again.
    assert.equal(err(() => t.cortex.items.claim(t.ai, id, { action: "release" })).code, "forbidden");
    const released = t.cortex.items.claim(t.human, id, { action: "release", note: "handed to the AI, see body" });
    assert.equal(released.applied, true);
    assert.equal(t.cortex.itemStore.read(id)!.claimed_by, undefined);
    assert.equal(t.cortex.itemStore.read(id)!.handoff_note, "handed to the AI, see body");
    assert.equal(t.cortex.items.claim(ai2, id, { action: "claim" }).applied, true);
  } finally {
    t.cleanup();
  }
});

test("claim: a stale claim (past the TTL) can be taken without force", () => {
  const t = tempProject();
  const ai2: Actor = { id: "ai-2", kind: "ai" };
  try {
    const { id } = t.cortex.items.create(t.human, { type: "task", title: "Add rate limiting" });
    t.cortex.items.claim(t.ai, id, { action: "claim" });

    // Simulate the claim aging past the 2h TTL without waiting.
    const current = t.cortex.itemStore.read(id)!;
    const aged = { ...current, claimed_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() };
    t.cortex.itemStore.write(aged);
    t.cortex.index.upsertItem(aged, t.cortex.itemStore.replies(id), false);

    assert.equal(t.cortex.items.claim(ai2, id, { action: "claim" }).applied, true);
    assert.equal(t.cortex.itemStore.read(id)!.claimed_by, ai2.id);
  } finally {
    t.cleanup();
  }
});

test("claiming and releasing never change itemRevision: an unrelated pending draft's base_rev survives claim activity", () => {
  const t = tempProject();
  try {
    const { id } = t.cortex.items.create(t.human, { type: "task", title: "Add rate limiting" });
    const before = itemRevision(t.cortex.itemStore.read(id)!);

    t.cortex.items.claim(t.ai, id, { action: "claim" });
    t.cortex.items.claim(t.ai, id, { action: "release", note: "left off here" });

    const after = itemRevision(t.cortex.itemStore.read(id)!);
    assert.equal(after, before, "claim/release must not touch the fields itemRevision hashes");
    assert.equal(t.cortex.items.get(id).rev, before);
  } finally {
    t.cleanup();
  }
});

test("REST: POST /items/:id/claim wires through to ItemService.claim, conflict comes back as 409", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const H = (token: string) => ({ host: "localhost:4747", authorization: `Bearer ${token}` });
  try {
    const { id } = t.cortex.items.create(t.human, { type: "task", title: "Add rate limiting" });
    const first = await app.inject({ method: "POST", url: `/api/items/${id}/claim`, headers: H(t.init.tokens["ai-agent"]), payload: { action: "claim" } });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().status, "backlog");

    const second = await app.inject({ method: "POST", url: `/api/items/${id}/claim`, headers: H(t.init.tokens.owner), payload: { action: "claim" } });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error.hint.held_by, "ai-agent");
  } finally {
    await app.close();
    t.cleanup();
  }
});

test("finishing a task or issue needs a reply: an AI cannot move it with a bare status change", () => {
  const t = tempProject();
  try {
    const task = t.cortex.items.create(t.human, { type: "task", title: "Edit listings in the panel" }).id;
    assert.equal(t.cortex.items.get(task).item.reply_required, true, "on by default");
    t.cortex.items.update(t.ai, task, { status: "doing" }); // not a finishing status

    const e = err(() => t.cortex.items.update(t.ai, task, { status: "review", reason: "done" }));
    assert.equal(e.code, "reply_required");
    assert.match(JSON.stringify(e.hint), /cortex_reply/);
    assert.equal(t.cortex.items.get(task).item.status, "doing", "nothing moved");

    // The reply path carries the outcome onto the card and moves it in one step.
    t.cortex.items.reply(t.ai, task, { body: "Added inline edit; commit abc1234; test by editing a row.", status: "review" });
    const read = t.cortex.items.get(task);
    assert.equal(read.item.status, "review");
    assert.equal(read.replies.at(-1)?.status_change?.to, "review");

    // Issues too, and the same reply can carry the fix fields.
    const issue = t.cortex.items.create(t.human, { type: "issue", title: "500 on login", category_path: "backend", fields: { severity: "high" } }).id;
    t.cortex.items.update(t.ai, issue, { status: "in_progress" });
    assert.equal(err(() => t.cortex.items.update(t.ai, issue, { status: "review" })).code, "reply_required");

    // A person moving the card is the one deciding: not stopped.
    t.cortex.items.update(t.human, issue, { status: "review" });
    assert.equal(t.cortex.items.get(issue).item.status, "review");
  } finally {
    t.cleanup();
  }
});

test("the reply rule can be turned off per card, by people only", () => {
  const t = tempProject();
  try {
    const off = t.cortex.items.create(t.human, { type: "task", title: "Bump a version", reply_required: false }).id;
    assert.equal(t.cortex.items.get(off).item.reply_required, false);
    t.cortex.items.update(t.ai, off, { status: "review" });
    assert.equal(t.cortex.items.get(off).item.status, "review", "flag off: old behaviour");

    const on = t.cortex.items.create(t.human, { type: "task", title: "Rewrite search" }).id;
    assert.equal(err(() => t.cortex.items.update(t.ai, on, { reply_required: false })).code, "forbidden", "an AI cannot waive it");
    t.cortex.items.update(t.human, on, { reply_required: false });
    t.cortex.items.update(t.ai, on, { status: "review" });
    assert.equal(t.cortex.items.get(on).item.status, "review");

    // Types without the rule carry no flag and are never stopped.
    const note = t.cortex.items.create(t.ai, { type: "note", title: "Staging resets Mondays" }).id;
    assert.equal(t.cortex.items.get(note).item.reply_required, undefined);
    t.cortex.items.update(t.ai, note, { status: "archived" });
  } finally {
    t.cleanup();
  }
});

test("reply rule: older projects fall back to the built-in rule, and rules edits are checked", () => {
  const t = tempProject();
  try {
    // A schema file written before the rule existed has no reply_required key.
    const file = join(t.root, ".cortex/rules/task.schema.yaml");
    const src = readFileSync(file, "utf8").replace(/reply_required:\n(\s+.*\n)+?(?=\S)/, "");
    assert.ok(!src.includes("reply_required"));
    writeFileSync(file, src, "utf8");
    assert.deepEqual(t.cortex.schema("task")?.reply_required, { statuses: ["review", "done"], default: true });

    // An item written before the flag existed follows the type's default.
    const id = t.cortex.items.create(t.human, { type: "task", title: "Old card" }).id;
    const item = t.cortex.items.get(id).item;
    delete item.reply_required;
    t.cortex.itemStore.write(item);
    t.cortex.items.update(t.ai, id, { status: "doing" });
    assert.equal(err(() => t.cortex.items.update(t.ai, id, { status: "review" })).code, "reply_required");

    assert.deepEqual(validateRulesDoc("task", { ...taskDoc(), reply_required: { statuses: ["shipped"], default: "yes" } }), [
      "reply_required.statuses: must list statuses",
      "reply_required.default: must be true or false",
    ]);
    assert.deepEqual(validateRulesDoc("task", { ...taskDoc(), reply_required: { statuses: ["review"], default: false } }), []);
  } finally {
    t.cleanup();
  }
});

function taskDoc() {
  return { type: "task", statuses: ["backlog", "doing", "review", "done"], initial: "backlog", terminal: ["done"], transitions: "any", fields: {} };
}
