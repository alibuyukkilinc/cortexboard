import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildServer } from "../src/api/server.js";
import { tempProject } from "./helpers.js";

// UI-10: nothing is lost past 500 cards, feeds page with a cursor, filters narrow search, and a person's
// saved views follow them from the phone to the desk.

test("the board asks one page per column and loses nothing: 530 cards, every one reachable", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const H = { host: "localhost:4747", authorization: `Bearer ${t.init.tokens.owner}` };
  try {
    for (let i = 0; i < 530; i++) t.cortex.items.create(t.human, { type: "note", title: `Note ${i}` });
    for (let i = 0; i < 3; i++) t.cortex.items.create(t.human, { type: "task", title: `Task ${i}`, assignee: "@ai" });
    const board = (await app.inject({ url: "/api/board?type=note&per_status=20", headers: H })).json();
    const active = board.columns.find((c: { status: string }) => c.status === "active");
    assert.equal(active.total, 530);
    assert.equal(active.items.length, 20, "the page holds a first page, not everything");

    // Following the cursor reaches every card exactly once.
    const seen = new Set<string>(active.items.map((i: { id: string }) => i.id));
    let cursor = active.next_cursor;
    while (cursor) {
      const page = (await app.inject({ url: `/api/items?type=note&status=active&limit=100&cursor=${cursor}`, headers: H })).json();
      for (const i of page.items) seen.add(i.id);
      cursor = page.next_cursor;
    }
    assert.equal(seen.size, 530);

    const tasks = (await app.inject({ url: "/api/board?type=task&assignee=@ai", headers: H })).json();
    assert.equal(tasks.columns.find((c: { status: string }) => c.status === "backlog").total, 3);
    assert.equal((await app.inject({ url: "/api/board", headers: H })).statusCode, 400);
  } finally {
    await app.close();
    t.cleanup();
  }
});

test("the activity feed pages back with a cursor, and lists and search filter by person and date", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const H = { host: "localhost:4747", authorization: `Bearer ${t.init.tokens.owner}` };
  try {
    for (let i = 0; i < 25; i++) t.cortex.activity.log(t.ai, { action: "fix", summary: `Fix number ${i} in the export`, why: "Because." });
    const first = (await app.inject({ url: "/api/activity?limit=10", headers: H })).json();
    assert.equal(first.entries.length, 10);
    const second = (await app.inject({ url: `/api/activity?limit=10&before=${first.next_cursor}`, headers: H })).json();
    assert.equal(second.entries.length, 10);
    assert.ok(second.entries[0].id < first.entries[9].id, "the next page starts where the first stopped");
    const third = (await app.inject({ url: `/api/activity?limit=10&before=${second.next_cursor}`, headers: H })).json();
    assert.equal(third.entries.length, 5);
    assert.equal(third.next_cursor, null);

    const mine = t.cortex.items.create(t.human, { type: "task", title: "Export invoices", assignee: "ai-agent" }).id;
    t.cortex.items.create(t.ai, { type: "task", title: "Export receipts", assignee: "owner" });
    const byAssignee = (await app.inject({ url: "/api/search?q=export&kind=item&assignee=ai-agent", headers: H })).json();
    assert.deepEqual(
      byAssignee.results.map((r: { id: string }) => r.id),
      [mine],
    );
    const byActor = (await app.inject({ url: "/api/search?q=export&kind=activity&actor=owner", headers: H })).json();
    assert.equal(byActor.results.length, 0, "the fixes were logged by the agent");
    const future = (await app.inject({ url: "/api/items?type=task&since=2999-01-01", headers: H })).json();
    assert.equal(future.total, 0);
    const now = (await app.inject({ url: "/api/items?type=task&since=2000-01-01", headers: H })).json();
    assert.equal(now.total, 2);
  } finally {
    await app.close();
    t.cleanup();
  }
});

test("saved views are a person's own, kept on the server and out of git; branches are searched on the server", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const H = (who: string) => ({ host: "localhost:4747", authorization: `Bearer ${t.init.tokens[who]}` });
  try {
    const put = await app.inject({
      method: "PUT",
      url: "/api/views",
      headers: H("owner"),
      payload: { name: "My AI issues", page: "board", query: "board/issue?assignee=@ai" },
    });
    assert.equal(put.statusCode, 200);
    const id = put.json().view.id;
    // Saving the same name again replaces it.
    await app.inject({
      method: "PUT",
      url: "/api/views",
      headers: H("owner"),
      payload: { name: "my ai issues", page: "board", query: "board/issue?assignee=@ai&path=backend" },
    });
    const list = (await app.inject({ url: "/api/views", headers: H("owner") })).json().views;
    assert.equal(list.length, 1);
    assert.equal(list[0].id, id);
    assert.equal(list[0].query, "board/issue?assignee=@ai&path=backend");
    assert.deepEqual((await app.inject({ url: "/api/views", headers: H("ai-agent") })).json().views, [], "nobody else sees it");
    assert.equal(
      (await app.inject({ method: "PUT", url: "/api/views", headers: H("owner"), payload: { name: "x", page: "board", query: "javascript:1" } })).statusCode,
      400,
    );
    assert.ok(readFileSync(join(t.root, ".cortex/.gitignore"), "utf8").split("\n").includes("views/"));
    assert.equal((await app.inject({ method: "DELETE", url: `/api/views/${id}`, headers: H("owner") })).statusCode, 200);
    assert.deepEqual((await app.inject({ url: "/api/views", headers: H("owner") })).json().views, []);

    t.cortex.putNode(t.human, { path: "backend/payments", title: "Payments", summary: "iyzico." });
    t.cortex.putNode(t.human, { path: "frontend/pay-button", title: "Pay button", summary: "x" });
    const found = (await app.inject({ url: "/api/branches?q=pay", headers: H("owner") })).json().branches;
    assert.deepEqual(
      found.map((b: { path: string }) => b.path),
      ["backend/payments", "frontend/pay-button"],
    );
  } finally {
    await app.close();
    t.cleanup();
  }
});
