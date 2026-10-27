import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/api/server.js";
import { tempProject } from "./helpers.js";

// A person's inbox is one queue: reviewed work, drafts, decisions, their items and stale knowledge, counted
// and paged on the server. An agent's inbox stays what it was.

test("a person's inbox holds reviewed work, drafts and decisions; an agent's does not change", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const as = (who: string) => ({ host: "localhost:4747", authorization: `Bearer ${t.init.tokens[who]}` });
  try {
    // An agent finishes a task and an issue: both wait for a person to check.
    const task = t.cortex.items.create(t.human, { type: "task", title: "Export invoices", assignee: "@ai" }).id;
    t.cortex.items.reply(t.ai, task, { body: "Done, see commit a1b2c3d.", status: "review" });
    const issue = t.cortex.items.create(t.human, { type: "issue", title: "Crash on save", category_path: "backend", fields: { severity: "high" } }).id;
    t.cortex.items.update(t.ai, issue, { status: "in_progress" });
    t.cortex.items.reply(t.ai, issue, { body: "Null check.", fields: { resolution: "fixed", commits: ["a1b2c3d"], files: ["src/save.ts"] }, status: "review" });
    // Something the person moved to review themselves is not theirs to check.
    const own = t.cortex.items.create(t.human, { type: "task", title: "My own work" }).id;
    t.cortex.items.reply(t.human, own, { body: "Ready.", status: "review" });
    t.cortex.items.create(t.ai, { type: "decision", title: "Use Redis for sessions", fields: { context: "Sticky sessions hurt deploys." } });
    t.cortex.putNode(t.ai, { path: "backend/cache", title: "Cache", summary: "Redis, 5 min TTL." }); // a draft

    const res = await app.inject({ url: "/api/inbox?limit=50", headers: as("owner") });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    const rows = body.items as { id: string; reason: string; moves?: { approve?: string; send_back?: string }; kind?: string }[];
    assert.deepEqual(
      rows.map((r) => r.reason),
      ["review_waiting_on_you", "review_waiting_on_you", "draft_to_approve", "decision_needs_review"],
      "ordered by what needs the person first",
    );
    assert.ok(!rows.some((r) => r.id === own));
    assert.deepEqual(rows.find((r) => r.id === task)?.moves, { approve: "done", send_back: "doing" });
    assert.deepEqual(rows.find((r) => r.id === issue)?.moves, { approve: "closed", send_back: "in_progress" }, "from the issue's transitions");
    assert.equal(rows.find((r) => r.reason === "draft_to_approve")?.kind, "draft");
    assert.deepEqual(body.by_reason, { review_waiting_on_you: 2, draft_to_approve: 1, decision_needs_review: 1 });
    assert.equal(body.count, 4);

    // Paged on the server, the count stays the whole queue; the sidebar badge is the same number.
    const page = (await app.inject({ url: "/api/inbox?limit=1&offset=1", headers: as("owner") })).json();
    assert.equal(page.count, 4);
    assert.deepEqual(
      page.items.map((r: { id: string }) => r.id),
      [rows[1].id],
    );
    assert.equal((await app.inject({ url: "/api/counts", headers: as("owner") })).json().inbox, 4);

    // The agent's inbox is its own items, as before: no review rows, no drafts.
    const ai = (await app.inject({ url: "/api/inbox", headers: as("ai-agent") })).json();
    assert.ok(!ai.items.some((r: { reason: string }) => ["review_waiting_on_you", "draft_to_approve", "stale_knowledge"].includes(r.reason)));
    assert.equal(ai.by_reason, undefined);

    // Approving from the row settles it.
    await app.inject({ method: "PATCH", url: `/api/items/${task}`, headers: as("owner"), payload: { status: "done" } });
    assert.equal((await app.inject({ url: "/api/counts", headers: as("owner") })).json().inbox, 3);
  } finally {
    await app.close();
    t.cleanup();
  }
});

test("the live stream says what changed, so a board refreshes only what it shows", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  try {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const ctrl = new AbortController();
    const res = await fetch(`${address}/api/events`, { headers: { authorization: `Bearer ${t.init.tokens.owner}` }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    const read = async (want: (e: Record<string, unknown>) => boolean) => {
      let buf = "";
      for (;;) {
        const { value } = await reader.read();
        buf += new TextDecoder().decode(value);
        for (const chunk of buf.split("\n\n")) {
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (line) {
            const e = JSON.parse(line.slice(6)) as Record<string, unknown>;
            if (want(e)) return e;
          }
        }
      }
    };
    const id = t.cortex.items.create(t.human, { type: "note", title: "Hello" }).id;
    const item = await read((e) => e.kind === "item");
    assert.equal(item.ref, id);
    t.cortex.putNode(t.human, { path: "backend/x", title: "X", summary: "x" });
    assert.equal((await read((e) => e.kind === "node")).ref, "backend/x");
    t.cortex.activity.log(t.ai, { action: "fix", summary: "Fixed it", why: "Because" });
    assert.equal((await read((e) => e.kind === "log")).type, "activity");
    ctrl.abort();
  } finally {
    await app.close();
    t.cleanup();
  }
});

test("an item waiting on a person's check carries the inbox row's review on its own page", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const as = (who: string) => ({ host: "localhost:4747", authorization: `Bearer ${t.init.tokens[who]}` });
  try {
    const task = t.cortex.items.create(t.human, { type: "task", title: "Export invoices", assignee: "@ai" }).id;
    const page = async (who: string) => (await app.inject({ url: `/api/items/${task}`, headers: as(who) })).json();
    assert.equal((await page("owner")).review, undefined, "not handed in yet");

    t.cortex.items.reply(t.ai, task, { body: "Done.\n\nTo test:\n- [ ] Export March\n- [ ] Open the file", status: "review" });
    const review = (await page("owner")).review;
    assert.deepEqual(review.moves, { approve: "done", send_back: "doing" });
    assert.deepEqual(review.to_test, ["Export March", "Open the file"]);
    assert.ok(review.waiting_since);
    assert.equal((await page("ai-agent")).review, undefined, "an agent checks nothing");

    // Sent back by the person: their reply is the last one, so it no longer waits on them.
    await app.inject({ method: "POST", url: `/api/items/${task}/replies`, headers: as("owner"), payload: { body: "Missing totals.", status: "doing" } });
    assert.equal((await page("owner")).review, undefined);
  } finally {
    await app.close();
    t.cleanup();
  }
});
