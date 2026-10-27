import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { localApi } from "../src/mcp/client.js";
import { statusPath } from "../src/mcp/finish.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { tempProject } from "./helpers.js";

async function session() {
  const t = tempProject();
  const api = await localApi(t.cortex, t.ai);
  const server = buildMcpServer(api);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "finish", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: !!r.isError, data: JSON.parse(r.content[0].text) };
  };
  return {
    ...t,
    call,
    async done() {
      await client.close();
      await api.close();
      t.cleanup();
    },
  };
}

test("statusPath: the shortest way the rules allow", () => {
  const issue = {
    statuses: ["open", "in_progress", "review", "closed"],
    transitions: { open: ["in_progress", "closed"], in_progress: ["review", "open", "closed"], review: ["closed", "in_progress"], closed: ["open"] },
  };
  assert.deepEqual(statusPath(issue, "open", "review"), ["in_progress", "review"]);
  assert.deepEqual(statusPath(issue, "in_progress", "review"), ["review"]);
  assert.deepEqual(statusPath(issue, "review", "review"), []);
  assert.equal(statusPath({ statuses: ["a", "b", "c"], transitions: { a: ["b"], b: [], c: [] } }, "a", "c"), null);
  assert.deepEqual(statusPath({ statuses: ["a", "b", "c"], transitions: "any" }, "a", "c"), ["c"]);
});

test("cortex_finish: log, reply and status (through the step between), claim released, project status, in one call", async () => {
  const s = await session();
  try {
    s.cortex.putNode(s.human, { path: "backend", title: "Backend", summary: "API" });
    const issue = s.cortex.items.create(s.ai, { type: "issue", title: "Refund twice", category_path: "backend", fields: { severity: "high" } });
    s.cortex.items.claim(s.ai, issue.id, { action: "claim" });

    const r = await s.call("cortex_finish", {
      item: issue.id,
      action: "fix",
      summary: "Refund is idempotent",
      why: "The callback came twice",
      files: ["src/pay/refund.ts"],
      commits: ["abc1234"],
      reply: "Fixed: the refund keeps its key. Test: pay, refund twice.",
      reply_fields: { resolution: "fixed" },
      status: "review",
      project_status: "**Where:** refunds fixed, in review.",
    });
    assert.equal(r.isError, false, JSON.stringify(r.data));
    assert.equal(r.data.finished, true, JSON.stringify(r.data));
    assert.deepEqual(
      r.data.steps.map((x: { step: string }) => x.step),
      ["log", "reply", "release", "project_status"],
    );

    const { item, replies } = s.cortex.items.get(issue.id);
    assert.equal(item.status, "review", "open → in_progress → review, the rules' way");
    assert.equal(item.claimed_by, undefined, "claim released");
    const last = replies.at(-1)!;
    assert.match(last.body, /refund keeps its key/);
    assert.deepEqual(last.fields, { resolution: "fixed", commits: ["abc1234"], files: ["src/pay/refund.ts"] }, "commits and files fill the reply fields");
    const log = s.cortex.index.queryActivity({ includeSystem: false, limit: 5 })[0];
    assert.equal(log.summary, "Refund is idempotent");
    assert.deepEqual(log.refs, [issue.id]);
    assert.match(s.cortex.status.get()?.body ?? "", /refunds fixed/);
  } finally {
    await s.done();
  }
});

test("cortex_finish: stops at the failing step and says what is left", async () => {
  const s = await session();
  try {
    const task = s.cortex.items.create(s.ai, { type: "task", title: "Ship" });
    const r = await s.call("cortex_finish", { item: task.id, summary: "Shipped", why: "Asked for", reply: "Done.", status: "nowhere", project_status: "x" });
    assert.equal(r.data.finished, false);
    assert.equal(r.data.failed, "reply");
    assert.deepEqual(r.data.left, ["release", "project_status"]);
    assert.equal(r.data.steps[0].ok, true, "the log was written before the failure");
    assert.equal(s.cortex.items.get(task.id).item.status, "backlog", "the card did not move");
  } finally {
    await s.done();
  }
});
