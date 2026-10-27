import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/api/server.js";
import { reportToMarkdown } from "../src/core/reportMarkdown.js";
import { parsePeriod } from "../src/core/reports.js";
import type { CortexError } from "../src/core/types.js";
import { localApi } from "../src/mcp/client.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { tempProject } from "./helpers.js";

test("an open-ended report includes an entry written in the same millisecond", () => {
  const t = tempProject();
  try {
    // The write and the report share one millisecond, as they do on a fast CI machine.
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    try {
      t.cortex.activity.log(t.ai, { action: "fix", summary: "Same-millisecond fix", why: "Race" });
      assert.equal(t.cortex.reports.build({ since: "1d" }).totals.activity.logged.total, 1);
    } finally {
      mock.timers.reset();
    }
  } finally {
    t.cleanup();
  }
});

test("periods: relative, absolute and invalid", () => {
  const now = Date.parse("2026-09-22T12:00:00Z");
  assert.equal(parsePeriod("7d", undefined, now).since, "2026-09-16T00:00:00.000Z");
  assert.equal(parsePeriod("2w", undefined, now).days, 14);
  assert.deepEqual(parsePeriod("2026-09-01", "2026-09-08", now), {
    since: "2026-09-01T00:00:00.000Z",
    until: "2026-09-08T00:00:00.000Z",
    days: 7,
    timezone: "UTC",
  });
  for (const [s, u] of [
    ["yesterday", undefined],
    ["2026-09-10", "2026-09-01"],
    ["400d", undefined],
  ] as const) {
    assert.throws(
      () => parsePeriod(s, u, now),
      (e: CortexError) => e.code === "invalid_period",
    );
  }
});

// A small but complete week: questions, an issue fix, a decision, drafts approved and rejected.
function busyWeek() {
  const t = tempProject();
  const { cortex: c, human, ai } = t;

  const q = c.items.create(ai, { type: "question", title: "Guest checkout?", assignee: "@humans" });
  c.items.reply(human, q.id, { body: "No." });
  c.items.update(ai, q.id, { status: "closed" });
  c.items.create(ai, { type: "question", title: "Which queue?", assignee: "@humans", fields: { blocking: true } });

  const issue = c.items.create(human, { type: "issue", title: "Double charge", category_path: "backend", fields: { severity: "critical" } });
  c.items.update(ai, issue.id, { status: "in_progress" });
  c.items.reply(ai, issue.id, { body: "Idempotency key.", fields: { resolution: "fixed", commits: ["abc1234"], files: ["pay.ts"] }, status: "review" });
  c.items.update(human, issue.id, { status: "closed" });
  c.items.create(human, { type: "issue", title: "Slow search", category_path: "frontend", fields: { severity: "low" } });

  const d = c.items.create(ai, { type: "decision", title: "Use iyzico", fields: { context: "TRY installments" } });
  c.items.update(human, d.id, { status: "accepted" });

  const good = c.putNode(ai, { path: "backend/pay", title: "Payments", summary: "iyzico, idempotent callback.", reason: "fix" });
  c.approve(human, good.draft_id!);
  const bad = c.putNode(ai, { path: "backend/cache", title: "Cache", summary: "Guessing: Redis?", reason: "guess" });
  c.reject(human, bad.draft_id!, "not verified");
  c.putNode(ai, { path: "backend/queue", title: "Queue", summary: "Pending review.", reason: "found" }); // stays pending

  c.activity.log(ai, { action: "fix", summary: "Idempotent iyzico callback", why: "Late webhooks charged twice", files: ["pay.ts"] });
  c.activity.log(ai, { action: "investigation", summary: "Read the queue code" }); // no why: allowed for investigation
  return { ...t, q, issue, d };
}

test("the report counts what happened, what waits, and how far to trust each AI", () => {
  const t = busyWeek();
  try {
    const r = t.cortex.reports.build({ since: "7d" });
    const T = r.totals;

    assert.equal(T.questions.asked, 2);
    assert.equal(T.questions.answered, 1);
    assert.ok(T.questions.median_answer_hours !== null && T.questions.median_answer_hours < 1);
    assert.equal(T.questions.open_blocking, 1);
    assert.deepEqual(T.items_closed.by_type, { question: 1, issue: 1 });
    assert.equal(T.items_created.by_type.issue, 2);
    assert.deepEqual(T.decisions, { proposed: 1, accepted: 1, rejected: 0 });
    assert.deepEqual({ ...T.approvals, oldest_pending_days: undefined }, { proposed: 3, approved: 1, rejected: 1, pending: 1, oldest_pending_days: undefined });
    assert.equal(T.ai_logged_changes, 2);
    assert.equal(T.ai_changes_without_why, 1);

    const closed = r.highlights.closed_issues[0];
    assert.equal(closed.title, "Double charge");
    assert.equal(closed.resolution, "fixed");
    assert.equal(r.highlights.decisions[0].status, "accepted");
    assert.equal(r.highlights.ai_changes[0].summary, "Read the queue code", "newest first");
    assert.equal(r.highlights.ai_changes[1].why, "Late webhooks charged twice");

    const ai = r.actors.find((a) => a.id === "ai-agent")!;
    assert.deepEqual(ai.drafts, { proposed: 3, approved: 1, rejected: 1 });
    assert.equal(ai.approval_rate, 0.5);
    assert.equal(ai.logged, 2);

    assert.equal(r.attention.open_issues, 1);
    assert.equal(r.attention.issue_aging[0].count, 1);
    assert.deepEqual(r.attention.issue_aging[0].by_severity, { low: 1 });
    assert.equal(r.attention.pending_approvals[0].target, "backend/queue");
    assert.equal(r.attention.blocking_questions[0].title, "Which queue?");

    assert.equal(r.knowledge.undocumented, 8, "root + 7 default branches still carry the placeholder");
    assert.equal(r.knowledge.updated_in_period, 1, "the approved node draft");
    assert.equal(r.daily.length, 7, "today plus the six days before it");
    assert.equal(
      r.daily.reduce((s, d) => s + d.ai + d.human, 0),
      T.activity.logged.total,
    );
    assert.equal(
      r.daily.reduce((s, d) => s + d.system, 0),
      T.activity.system.total,
    );
  } finally {
    t.cleanup();
  }
});

test("the headline counts logged work, not the audit trail behind it", () => {
  const t = tempProject();
  const { cortex: c, human, ai } = t;
  try {
    c.activity.log(ai, { action: "fix", summary: "Fixed the callback", why: "Charged twice" });
    c.activity.log(human, { action: "config", summary: "Raised the queue limit", why: "Backlog" });
    for (let i = 0; i < 10; i++) c.items.create(ai, { type: "note", title: `Note ${i}` }); // 10 audit entries
    const r = c.reports.build({ since: "7d" });
    assert.deepEqual(r.totals.activity.logged, { total: 2, ai: 1, human: 1, unknown: 0 });
    assert.equal(r.totals.activity.system.total, 10);
    const today = r.daily.at(-1)!;
    assert.deepEqual({ ai: today.ai, human: today.human, system: today.system }, { ai: 1, human: 1, system: 10 });
    assert.match(reportToMarkdown(r, "en"), /\| Logged activity \| 2 \(by AI 1 · by humans 1\) · 10 audit entries \|/);
  } finally {
    t.cleanup();
  }
});

test("an actor the config does not know is counted as what it was, or as unknown, never as a person", () => {
  const t = tempProject();
  const { cortex: c, ai } = t;
  try {
    // Another client's AI writing through the API: the entry records what it was.
    c.activity.log({ id: "chatgpt", kind: "ai" }, { action: "fix", summary: "Fixed the cache", why: "Stale pages" });
    c.activity.log(ai, { action: "fix", summary: "Fixed the queue", why: "Stuck jobs" });
    // An old entry from before actor_kind, by a member since removed from the config.
    const at = new Date().toISOString();
    const dir = join(t.root, ".cortex/activity", at.slice(0, 10));
    mkdirSync(dir, { recursive: true });
    const old = { id: "01M0000000000000000000000C", at, actor: "antigravity", action: "fix", summary: "Old fix", why: "Old reason", refs: [], system: false };
    appendFileSync(join(dir, "antigravity.jsonl"), JSON.stringify(old) + "\n");
    c.reindex();

    const r = c.reports.build({ since: "1d" });
    assert.deepEqual(r.totals.activity.logged, { total: 3, ai: 2, human: 0, unknown: 1 });
    assert.equal(r.totals.ai_logged_changes, 2);
    assert.equal(r.actors.find((a) => a.id === "chatgpt")?.kind, "ai");
    assert.equal(r.actors.find((a) => a.id === "antigravity")?.kind, "unknown");
    assert.equal(r.daily.at(-1)!.unknown, 1);
    assert.match(reportToMarkdown(r, "en"), /by AI 2 · by humans 0 · unknown actor 1\)/);
    assert.equal(c.index.activityBetween(r.period.since, r.period.until).find((e) => e.actor === "chatgpt")?.actor_kind, "ai");
  } finally {
    t.cleanup();
  }
});

test("events outside the period are left out", () => {
  const t = busyWeek();
  try {
    const r = t.cortex.reports.build({ since: "2020-01-01", until: "2020-01-08" });
    assert.equal(r.totals.activity.logged.total + r.totals.activity.system.total, 0);
    assert.equal(r.totals.questions.answered, 0);
    assert.equal(r.attention.open_issues, 1, "what is waiting is always as of now");
  } finally {
    t.cleanup();
  }
});

test("old audit entries without structured meta are still understood", () => {
  const t = tempProject();
  try {
    const at = new Date().toISOString();
    const dir = join(t.root, ".cortex/activity", at.slice(0, 10));
    mkdirSync(dir, { recursive: true });
    const lines = [
      {
        id: "01M0000000000000000000000A",
        at,
        actor: "owner",
        action: "item.updated",
        summary: 'Updated issue "Legacy bug" (review → closed)',
        refs: ["01M0000000000000000000000Z"],
        system: true,
      },
      {
        id: "01M0000000000000000000000B",
        at,
        actor: "owner",
        action: "draft.rejected",
        summary: 'Rejected ai-agent\'s change to node "backend"',
        refs: ["backend"],
        system: true,
      },
    ];
    appendFileSync(join(dir, "owner.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    // The item file is gone, so the type comes from nowhere: the close cannot be attributed, the rejection can.
    t.cortex.reindex();
    const r = t.cortex.reports.build({ since: "1d" });
    assert.equal(r.actors.find((a) => a.id === "ai-agent")?.drafts.rejected, 1);
  } finally {
    t.cleanup();
  }
});

test("markdown in both languages, over REST and MCP", async () => {
  const t = busyWeek();
  const app = buildServer(t.cortex);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  try {
    const r = t.cortex.reports.build({ since: "7d" });
    const en = reportToMarkdown(r, "en");
    const tr = reportToMarkdown(r, "tr");
    assert.match(en, /^# Cortex report/);
    assert.match(en, /## What the AI did, and why/);
    assert.match(en, /_Late webhooks charged twice_/);
    assert.match(tr, /^# Cortex raporu/);
    assert.match(tr, /## İnsanları bekleyenler/);
    assert.match(tr, /\| ai-agent \| ai \| 2 \|/);

    // Pipes in titles must not break tables.
    t.cortex.items.create(t.human, { type: "note", title: "a | b" });
    assert.doesNotMatch(reportToMarkdown(t.cortex.reports.build({ since: "7d" }), "en"), /[^\\]\| b/);

    const h = { host: "localhost", authorization: `Bearer ${t.init.tokens.owner}` };
    const md = await app.inject({ url: "/api/report?since=7d&format=md&lang=tr", headers: h });
    assert.match(String(md.headers["content-type"]), /markdown/);
    assert.match(md.body, /Cortex raporu/);
    const json = await app.inject({ url: "/api/report?since=2w", headers: h });
    assert.equal(json.json().report.period.days, 14);
    assert.equal((await app.inject({ url: "/api/report?since=soon", headers: h })).statusCode, 400);

    const server = buildMcpServer(await localApi(t.cortex, t.ai), { tools: "full" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = (await client.callTool({ name: "cortex_report", arguments: { since: "7d", format: "markdown", lang: "en" } })) as {
      content: { text: string }[];
    };
    assert.match(JSON.parse(res.content[0].text).markdown, /# Cortex report/);
  } finally {
    await client.close();
    await app.close();
    t.cleanup();
  }
});

test("reports count days in the project's time zone", async () => {
  const { addDays, dayKey, startOfDay } = await import("../src/util/time.js");
  // 01:30 in Istanbul is still the previous day in UTC.
  const lateNight = Date.parse("2026-09-21T22:30:00Z");
  assert.equal(dayKey(lateNight, "UTC"), "2026-09-21");
  assert.equal(dayKey(lateNight, "Europe/Istanbul"), "2026-09-22");
  assert.equal(new Date(startOfDay("2026-09-22", "Europe/Istanbul")).toISOString(), "2026-09-21T21:00:00.000Z");
  // A DST change day: New York gains an hour on 2026-11-01, the day still starts at local midnight.
  assert.equal(new Date(startOfDay("2026-11-01", "America/New_York")).toISOString(), "2026-11-01T04:00:00.000Z");
  assert.equal(new Date(startOfDay("2026-11-02", "America/New_York")).toISOString(), "2026-11-02T05:00:00.000Z");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");

  const now = Date.parse("2026-09-22T12:00:00Z");
  const p = parsePeriod("7d", undefined, now, "Europe/Istanbul");
  assert.equal(p.since, "2026-09-15T21:00:00.000Z", "7 Istanbul days: 16-22 September");
  assert.equal(p.timezone, "Europe/Istanbul");
  assert.equal(parsePeriod("2026-09-01", "2026-09-08", now, "Europe/Istanbul").since, "2026-08-31T21:00:00.000Z");

  const t = tempProject();
  try {
    t.cortex.project.config.timezone = "Europe/Istanbul";
    const r = t.cortex.reports.build({ since: "7d" });
    assert.equal(r.daily.length, 7);
    assert.equal(r.daily.at(-1)!.date, dayKey(Date.now(), "Europe/Istanbul"));
    assert.match(reportToMarkdown(r, "tr"), /Europe\/Istanbul/);
  } finally {
    t.cleanup();
  }
});

test("an unknown time zone in cortex.config.yaml is refused with a clear message", async () => {
  const { writeFileSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { loadProject } = await import("../src/core/project.js");
  const t = tempProject();
  try {
    const file = join(t.cortex.project.dir, "cortex.config.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("timezone: UTC", "timezone: Mars/Olympus"));
    assert.throws(() => loadProject(t.root), /Unknown timezone "Mars\/Olympus"/);
  } finally {
    t.cleanup();
  }
});
