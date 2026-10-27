import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { localApi } from "../src/mcp/client.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { estimateTokens } from "../src/util/text.js";
import { tempProject } from "./helpers.js";

// "What is open and who moves next?" A/B runs showed agents listing items, then opening them one by one
// (about 20 calls for five questions). The brief, a previewed list and a batch read answer it in one or two.

test("the brief shows open work waiting on others, without repeating the inbox", () => {
  const t = tempProject();
  try {
    const mine = t.cortex.items.create(t.human, { type: "task", title: "Prepare the npm release", category_path: "backend", assignee: "@ai" });
    const q = t.cortex.items.create(t.ai, { type: "question", title: "UTC or project timezone?", category_path: "backend", assignee: "@humans" });
    const brief = t.cortex.brief(t.ai);
    assert.deepEqual(
      brief.attention.inbox.top.map((i) => i.id),
      [mine.id],
    );
    assert.equal(brief.attention.open_elsewhere?.count, 1);
    assert.deepEqual(brief.attention.open_elsewhere?.top, [
      { id: q.id, type: "question", title: "UTC or project timezone?", status: "open", assignee: "@humans" },
    ]);
    assert.ok(estimateTokens(brief) < 800, `brief is ${estimateTokens(brief)} tokens`);
  } finally {
    t.cleanup();
  }
});

test("a previewed list carries the gist and the last reply; the plain list stays lean", () => {
  const t = tempProject();
  try {
    const q = t.cortex.items.create(t.ai, {
      type: "question",
      title: "UTC or project timezone?",
      body: "Days are UTC now.\n\nWork done in Turkey between 00:00 and 03:00 lands on the previous day. " + "x".repeat(400),
      category_path: "backend",
      assignee: "@humans",
    });
    t.cortex.items.reply(t.human, q.id, { body: "add it", status: "answered" });

    const [row] = t.cortex.items.list({ open: true, preview: true }).items as {
      gist?: string;
      last_reply?: { by: string; to?: string; text: string };
    }[];
    assert.match(row.gist!, /^Days are UTC now\. Work done in Turkey/, "whitespace is flattened");
    assert.ok(row.gist!.length <= 201 && row.gist!.endsWith("…"), "the gist is short");
    assert.deepEqual({ by: row.last_reply!.by, to: row.last_reply!.to, text: row.last_reply!.text }, { by: t.human.id, to: "answered", text: "add it" });

    const [plain] = t.cortex.items.list({ open: true }).items as Record<string, unknown>[];
    assert.equal(plain.gist, undefined);
    assert.equal(plain.last_reply, undefined);
  } finally {
    t.cleanup();
  }
});

test("MCP: cortex_items preview and cortex_item with several ids in one call", async () => {
  const t = tempProject();
  const server = buildMcpServer(await localApi(t.cortex, t.ai), { tools: "full" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "open-queue-test", version: "1" });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { error: r.isError, data: JSON.parse(r.content[0].text) };
  };
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const d = t.cortex.items.create(t.ai, {
      type: "decision",
      title: "Mobile joins as its own project",
      category_path: "backend",
      fields: { context: "Separate repo" },
    });
    const i = t.cortex.items.create(t.human, {
      type: "issue",
      title: "How should mobile join?",
      body: "Three people and an AI.",
      category_path: "backend",
      assignee: "@ai",
      fields: { severity: "medium" },
    });

    const listed = (await call("cortex_items", { open: true, preview: true })).data;
    assert.equal(listed.items.find((x: { id: string }) => x.id === i.id).gist, "Three people and an AI.");

    const both = await call("cortex_item", { ids: [d.id, i.id, "01NOPE"] });
    assert.ok(!both.error);
    assert.deepEqual(
      both.data.items.slice(0, 2).map((x: { item: { id: string } }) => x.item.id),
      [d.id, i.id],
    );
    assert.equal(both.data.items[2].id, "01NOPE");
    assert.equal(both.data.items[2].error.code, "not_found", "one missing id does not fail the others");
    assert.ok(both.data._meta && !both.data.items[0]._meta, "_meta once, not per item");

    assert.equal((await call("cortex_item", { id: i.id })).data.item.title, "How should mobile join?", "a single id still works");
    assert.ok((await call("cortex_item", {})).error, "no id at all is refused");
  } finally {
    await client.close();
    t.cleanup();
  }
});
