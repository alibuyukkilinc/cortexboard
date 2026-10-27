import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { localApi } from "../src/mcp/client.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { fieldError } from "../src/core/items.js";
import { tempProject } from "./helpers.js";

// UI-9's acceptance: an agent that reads only the brief sends a valid decision on its first try.
test("MCP: an agent fills a decision from the brief's item_types and gets it right the first time", async () => {
  const t = tempProject();
  const server = buildMcpServer(await localApi(t.cortex, t.ai));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { isError: !!r.isError, data: JSON.parse(r.content[0].text) };
    };
    const brief = (await call("cortex_brief")).data;
    const types = brief.rules.item_types as string[];
    assert.ok(types.includes("task"));
    assert.ok(types.includes("issue(category_path,severity)"));
    // What an agent does: find the type, fill every name in the parentheses.
    const decision = types.find((x) => x.startsWith("decision"))!;
    const required = /\((.*)\)/.exec(decision)?.[1].split(",") ?? [];
    assert.deepEqual(required, ["context"]);
    const fields = Object.fromEntries(required.filter((r) => r !== "category_path").map((r) => [r, `The ${r}, in a sentence.`]));
    const created = await call("cortex_create_item", { type: "decision", title: "Use Redis for sessions", body: "We keep sessions in Redis.", fields });
    assert.equal(created.isError, false, JSON.stringify(created.data));
    assert.ok(created.data.id);

    // A write that misses one says which field, as a path a form can put the message beside.
    const bad = await call("cortex_create_item", { type: "issue", title: "Crash", fields: {} });
    assert.equal(bad.isError, true);
    const errors = (bad.data.error?.hint ?? bad.data.hint).errors as { path: string; message: string }[];
    assert.deepEqual(errors.map((e) => e.path).sort(), ["category_path", "fields.severity"]);
  } finally {
    await client.close();
    t.cleanup();
  }
});

test("an issue line becomes a path and a message; a line without a path is about the whole record", () => {
  assert.deepEqual(fieldError("fields.severity: required"), { path: "fields.severity", message: "required" });
  assert.deepEqual(fieldError("links.items[0]: no item"), { path: "links.items[0]", message: "no item" });
  assert.deepEqual(fieldError("(root): expected object"), { path: "", message: "(root): expected object" });
  assert.deepEqual(fieldError("A 'fixed' resolution must list the commits"), { path: "", message: "A 'fixed' resolution must list the commits" });
});
