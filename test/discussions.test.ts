import { test } from "node:test";
import assert from "node:assert/strict";
import type { Actor, CortexError, Item } from "../src/core/types.js";
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

const OPTS = ["Stay on PostgreSQL", "Move to MySQL"];

function setup() {
  const t = tempProject();
  const ai2: Actor = { id: "ai-2", kind: "ai" };
  t.cortex.project.config.actors.push(ai2);
  const view = (actor: Actor, stance: string, body = "I read the code.") =>
    t.cortex.items.reply(actor, id, { body, fields: { kind: "opinion", stance, confidence: "high", evidence: ["src/db.ts:1-20"] } });
  const { id } = t.cortex.items.create(t.human, {
    type: "discussion",
    title: "MySQL instead of PostgreSQL?",
    body: "Hosting is cheaper.",
    fields: { options: OPTS, participants: ["ai-agent", "ai-2"] },
  });
  return { t, ai2, id, view };
}

test("a discussion needs at least two distinct options", () => {
  const t = tempProject();
  try {
    const e = err(() => t.cortex.items.create(t.human, { type: "discussion", title: "x", fields: { options: ["only one"] } }));
    assert.equal(e.code, "invalid_item");
    const dup = err(() => t.cortex.items.create(t.human, { type: "discussion", title: "x", fields: { options: ["A", "a"] } }));
    assert.ok((dup.hint as { issues: string[] }).issues.some((i) => i.includes("different")));
  } finally {
    t.cleanup();
  }
});

test("blind round: a participant sees the others' views only after posting; the author always sees them", () => {
  const { t, ai2, id, view } = setup();
  try {
    view(t.ai, "Stay on PostgreSQL", "JSONB is used in 14 places.");
    const before = t.cortex.items.get(id, { viewer: ai2 });
    assert.equal(before.replies.length, 1);
    assert.equal(before.replies[0]!.sealed, true);
    assert.equal(before.replies[0]!.body, "");
    assert.equal(before.discussion!.sees_all, false);
    assert.equal(before.discussion!.tally, undefined, "no counts while blind");
    assert.equal(before.discussion!.asks_you, true);

    const author = t.cortex.items.get(id, { viewer: t.human });
    assert.equal(author.replies[0]!.body, "JSONB is used in 14 places.");

    view(ai2, "Move to MySQL");
    const after = t.cortex.items.get(id, { viewer: ai2 });
    assert.ok(after.replies.every((r) => !r.sealed));
    assert.equal(after.discussion!.asks_you, false);
  } finally {
    t.cleanup();
  }
});

test("blind round keeps views out of search and list previews", async () => {
  const { t, id, view } = setup();
  try {
    view(t.ai, "Stay on PostgreSQL", "zebracorn evidence nobody else should see");
    const hits = await t.cortex.search("zebracorn", {});
    assert.equal(hits.results.length, 0);
    const row = t.cortex.items.list({ type: "discussion", preview: true }).items[0] as { last_reply?: unknown };
    assert.equal(row.last_reply, undefined);

    t.cortex.items.update(t.human, id, { status: "deliberating" });
    assert.equal((await t.cortex.search("zebracorn", {})).results.length, 1, "searchable once views open");
  } finally {
    t.cleanup();
  }
});

test("phase and participant rules for views", () => {
  const { t, ai2, id, view } = setup();
  try {
    assert.equal(err(() => view(t.ai, "Use SQLite")).code, "invalid_reply", "stance must be an option");
    assert.equal(
      err(() => t.cortex.items.reply(t.ai, id, { body: "x", fields: { kind: "opinion", stance: OPTS[0] } })).code,
      "invalid_item",
      "an opinion needs evidence",
    );
    assert.equal(
      err(() => t.cortex.items.reply(t.ai, id, { body: "x", fields: { kind: "rebuttal", stance: OPTS[0] } })).code,
      "invalid_reply",
      "no rebuttals in the blind round",
    );
    const outsider: Actor = { id: "ai-3", kind: "ai" };
    t.cortex.project.config.actors.push(outsider);
    assert.equal(err(() => view(outsider, OPTS[0]!)).code, "invalid_reply", "only invited participants vote");
    t.cortex.items.reply(outsider, id, { body: "Just a note", fields: { kind: "comment" } });

    view(ai2, OPTS[1]!);
    t.cortex.items.update(t.human, id, { status: "deliberating" });
    t.cortex.items.reply(ai2, id, { body: "Changed my mind", fields: { kind: "rebuttal", stance: OPTS[0] } });
    assert.equal(err(() => t.cortex.items.update(t.human, id, { status: "voted" })).code, "invalid_transition", "voting goes through the count");
  } finally {
    t.cleanup();
  }
});

test("inbox and counts ask invited participants for their view", () => {
  const { t, ai2, id, view } = setup();
  try {
    assert.ok(t.cortex.items.inbox(t.ai).items.some((i) => i.id === id && i.reason === "discussion_needs_your_view"));
    assert.deepEqual(t.cortex.discussions.askingFor(ai2), [id]);
    assert.deepEqual(t.cortex.discussions.askingFor(t.human), [], "the author is not asked");
    view(t.ai, OPTS[0]!);
    assert.ok(!t.cortex.items.inbox(t.ai).items.some((i) => i.reason === "discussion_needs_your_view"));
    const row = t.cortex.discussions.list(ai2).discussions[0]!;
    assert.deepEqual(row.posted, ["ai-agent"]);
    assert.deepEqual(row.waiting_on, ["ai-2"]);
    assert.equal(row.tally, undefined);
  } finally {
    t.cleanup();
  }
});

test("close-vote: the latest stance counts, the majority becomes a proposed decision, accepting it decides the discussion", () => {
  const { t, ai2, id, view } = setup();
  try {
    view(t.ai, OPTS[0]!);
    view(ai2, OPTS[1]!);
    t.cortex.items.update(t.human, id, { status: "deliberating" });
    t.cortex.items.reply(ai2, id, { body: "Your JSONB point convinced me", fields: { kind: "rebuttal", stance: OPTS[0] } });

    const r = t.cortex.discussions.closeVote(t.ai, id);
    assert.equal(r.tally.leader, OPTS[0]);
    assert.deepEqual(r.tally.votes[0]!.voters.sort(), ["ai-2", "ai-agent"]);
    const disc = t.cortex.itemStore.read(id)!;
    assert.equal(disc.status, "voted");
    const decision = t.cortex.itemStore.read(disc.fields.outcome as string) as Item;
    assert.equal(decision.type, "decision");
    assert.equal(decision.status, "proposed");
    assert.deepEqual(decision.links?.items, [id]);
    assert.match(String(decision.fields.alternatives), /Move to MySQL: 0 vote/);

    assert.equal(err(() => t.cortex.items.update(t.ai, decision.id, { status: "accepted" })).code, "forbidden");
    t.cortex.items.update(t.human, decision.id, { status: "accepted" });
    assert.equal(t.cortex.itemStore.read(id)!.status, "decided");
    assert.equal(err(() => t.cortex.items.reply(t.ai, id, { body: "late", fields: { kind: "rebuttal", stance: OPTS[1] } })).code, "invalid_reply");
  } finally {
    t.cleanup();
  }
});

test("a tie leaves the call to a person, who decides; an overridden proposal is rejected", () => {
  const { t, ai2, id, view } = setup();
  try {
    view(t.ai, OPTS[0]!);
    view(ai2, OPTS[1]!);
    const tie = t.cortex.discussions.closeVote(t.human, id);
    assert.equal(tie.tally.tie, true);
    assert.equal(tie.decision, undefined);
    assert.equal(t.cortex.itemStore.read(id)!.status, "voted");

    assert.equal(err(() => t.cortex.discussions.decide(t.ai, id, OPTS[1]!)).code, "forbidden");
    const d = t.cortex.discussions.decide(t.human, id, OPTS[1]!);
    const disc = t.cortex.itemStore.read(id)!;
    assert.equal(disc.status, "decided");
    assert.equal(disc.fields.outcome, d.decision.id);
    assert.equal(t.cortex.itemStore.read(d.decision.id)!.status, "accepted");
  } finally {
    t.cleanup();
  }
});

test("deciding for the option the majority proposed accepts that proposal instead of making a second one", () => {
  const { t, ai2, id, view } = setup();
  try {
    view(t.ai, OPTS[0]!);
    view(ai2, OPTS[0]!);
    const proposed = t.cortex.discussions.closeVote(t.human, id).decision!.id;
    const d = t.cortex.discussions.decide(t.human, id, OPTS[0]!);
    assert.equal(d.decision.id, proposed);
    assert.equal(t.cortex.itemStore.read(proposed)!.status, "accepted");
    assert.equal(t.cortex.itemStore.read(id)!.status, "decided");
    assert.equal(t.cortex.items.list({ type: "decision" }).total, 1);
  } finally {
    t.cleanup();
  }
});

test("a person overriding a proposed majority rejects that proposal", () => {
  const { t, ai2, id, view } = setup();
  try {
    view(t.ai, OPTS[0]!);
    view(ai2, OPTS[0]!);
    const r = t.cortex.discussions.closeVote(t.human, id);
    const proposed = r.decision!.id;
    t.cortex.discussions.decide(t.human, id, OPTS[1]!);
    assert.equal(t.cortex.itemStore.read(proposed)!.status, "rejected");
  } finally {
    t.cleanup();
  }
});

test("REST: GET /items/:id seals views for the caller; /discussions lists; /counts has the badge", async () => {
  const { t, id, view } = setup();
  const app = buildServer(t.cortex);
  const H = (token: string) => ({ authorization: `Bearer ${token}` });
  try {
    view(t.human, OPTS[0]!, "owner view"); // the author may post too
    const res = await app.inject({ method: "GET", url: `/api/items/${id}`, headers: H(t.init.tokens["ai-agent"]!) });
    const body = res.json() as { replies: { sealed?: boolean }[]; discussion: { asks_you: boolean } };
    assert.equal(body.replies[0]!.sealed, true);
    assert.equal(body.discussion.asks_you, true);

    const list = (await app.inject({ method: "GET", url: "/api/discussions", headers: H(t.init.tokens["ai-agent"]!) })).json() as { asks_you: number };
    assert.equal(list.asks_you, 1);
    const counts = (await app.inject({ method: "GET", url: "/api/counts", headers: H(t.init.tokens["ai-agent"]!) })).json() as { discussions: number };
    assert.equal(counts.discussions, 1);

    const decide = await app.inject({
      method: "POST",
      url: `/api/discussions/${id}/decide`,
      headers: H(t.init.tokens["ai-agent"]!),
      payload: { option: OPTS[0] },
    });
    assert.equal(decide.statusCode, 403);
  } finally {
    await app.close();
    t.cleanup();
  }
});
