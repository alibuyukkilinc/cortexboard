import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/api/server.js";
import { tempProject } from "./helpers.js";

// The board's type tabs carry what waits on you in each type: the inbox queue, counted per type.

test("counts says how many items of each type wait on this person", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const as = (token: string) => ({ host: "localhost:4747", authorization: `Bearer ${token}` });
  try {
    const { cortex: c, human, ai } = t;
    const task = c.items.create(ai, { type: "task", title: "Limiter" });
    c.items.reply(ai, task.id, { body: "Done: limiter.", status: "review" }); // waits on a person to review
    c.items.create(ai, { type: "decision", title: "Use SQLite", fields: { context: "One file" } }); // proposed
    c.items.create(ai, { type: "question", title: "Keep sessions 30 days?", assignee: "@humans" });
    c.items.create(human, { type: "note", title: "Staging resets on Monday" }); // waits on no one

    const owner = (await app.inject({ url: "/api/counts", headers: as(t.init.tokens.owner) })).json();
    assert.deepEqual(owner.waiting, { task: 1, decision: 1, question: 1 });
    assert.equal(owner.inbox >= 3, true);

    // The agent reviews nothing and decides nothing: its own queue is empty here.
    const agent = (await app.inject({ url: "/api/counts", headers: as(t.init.tokens["ai-agent"]) })).json();
    assert.deepEqual(agent.waiting, {});
  } finally {
    await app.close();
    t.cleanup();
  }
});
