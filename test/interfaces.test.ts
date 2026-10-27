import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/api/server.js";
import { localApi } from "../src/mcp/client.js";
import { buildMcpServer, FULL_ONLY } from "../src/mcp/server.js";
import { tempProject } from "./helpers.js";

test("REST: auth, host check, brief, draft flow", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const H = (token?: string, host = "localhost:4747") => ({ host, ...(token ? { authorization: `Bearer ${token}` } : {}) });
  try {
    assert.equal((await app.inject({ url: "/api/health", headers: H() })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/brief", headers: H() })).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/brief", headers: H("wrong") })).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/brief", headers: H(t.init.tokens.owner, "evil.com") })).statusCode, 403);

    const brief = await app.inject({ url: "/api/brief", headers: H(t.init.tokens["ai-agent"]) });
    assert.equal(brief.statusCode, 200);
    assert.equal(brief.json().you.id, "ai-agent");
    assert.match(brief.json()._meta.rules_version, /^r-[0-9a-f]{8}$/);

    const put = await app.inject({
      method: "PUT",
      url: "/api/node/backend/cache",
      headers: H(t.init.tokens["ai-agent"]),
      payload: { title: "Cache", summary: "Redis, 5 min TTL.", reason: "documenting" },
    });
    assert.equal(put.statusCode, 202);
    const draftId = put.json().draft_id;

    assert.equal((await app.inject({ method: "POST", url: `/api/approvals/${draftId}/approve`, headers: H(t.init.tokens["ai-agent"]) })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: `/api/approvals/${draftId}/approve`, headers: H(t.init.tokens.owner) })).statusCode, 200);

    const node = await app.inject({ url: "/api/node/backend/cache", headers: H(t.init.tokens.owner) });
    assert.equal(node.json().node.summary, "Redis, 5 min TTL.");

    const tree = await app.inject({ url: "/api/tree/backend?depth=1", headers: H(t.init.tokens.owner) });
    assert.equal(tree.json().node.children[0].path, "backend/cache");

    const search = await app.inject({ url: "/api/search?q=redis", headers: H(t.init.tokens.owner) });
    assert.equal(search.json().results[0].path, "backend/cache");

    const bad = await app.inject({ method: "PUT", url: "/api/node/backend/x", headers: H(t.init.tokens.owner), payload: { title: "x" } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, "invalid_node");
    assert.ok(bad.json().error.hint.example);

    assert.equal((await app.inject({ url: "/api/rules/node", headers: H(t.init.tokens.owner) })).json().rules.node.type, "node");
  } finally {
    await app.close();
    t.cleanup();
  }
});

test("MCP: tools list and a brief -> search -> update round trip", async () => {
  const t = tempProject();
  const server = buildMcpServer(await localApi(t.cortex, t.ai), { tools: "full" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = (await client.listTools()).tools.map((x) => x.name).sort();
    assert.deepEqual(tools, [
      "cortex_activity",
      "cortex_answer_rules",
      "cortex_archive",
      "cortex_ask",
      "cortex_brief",
      "cortex_claim",
      "cortex_close_vote",
      "cortex_code_context",
      "cortex_create_item",
      "cortex_discuss",
      "cortex_discussions",
      "cortex_finish",
      "cortex_inbox",
      "cortex_item",
      "cortex_item_file",
      "cortex_items",
      "cortex_log_activity",
      "cortex_node",
      "cortex_reply",
      "cortex_report",
      "cortex_rules",
      "cortex_search",
      "cortex_tree",
      "cortex_update_item",
      "cortex_update_node",
      "cortex_update_status",
      "cortex_verify_node",
    ]);

    // The default core set leaves out only the rarely used tools, and nothing the instructions name.
    const core = buildMcpServer(await localApi(t.cortex, t.ai));
    const [c1, c2] = InMemoryTransport.createLinkedPair();
    const coreClient = new Client({ name: "core", version: "1" });
    await Promise.all([core.connect(c1), coreClient.connect(c2)]);
    const coreTools = (await coreClient.listTools()).tools.map((x) => x.name);
    assert.deepEqual(
      tools.filter((x) => !coreTools.includes(x)),
      [...FULL_ONLY].sort(),
    );
    const named = coreClient.getInstructions()!.match(/cortex_[a-z_]+/g)!;
    for (const n of named.filter((x) => tools.includes(x))) assert.ok(coreTools.includes(n), `${n} is named in the instructions`);
    await coreClient.close();

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { isError: !!r.isError, data: JSON.parse(r.content[0].text) };
    };

    assert.equal((await call("cortex_brief")).data.you.id, "ai-agent");
    const up = await call("cortex_update_node", {
      path: "server/deploy",
      title: "Deploy",
      summary: "GitHub Actions to a VPS.",
      code_files: [{ file: ".github/workflows/deploy.yml" }],
      reason: "documenting deploy",
    });
    assert.equal(up.data.applied, false);
    t.cortex.approve(t.human, up.data.draft_id);
    assert.equal((await call("cortex_search", { q: "vps" })).data.results[0].path, "server/deploy");
    assert.equal((await call("cortex_node", { path: "server/deploy" })).data.node.links.code[0].file, ".github/workflows/deploy.yml");

    const missing = await call("cortex_node", { path: "server/nope" });
    assert.equal(missing.isError, true);
    assert.equal(missing.data.error.code, "not_found");
  } finally {
    await client.close();
    t.cleanup();
  }
});

test("REST: items, replies, inbox, ask and activity", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const as = (who: "owner" | "ai-agent") => ({ host: "localhost", authorization: `Bearer ${t.init.tokens[who]}` });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/items",
      headers: as("owner"),
      payload: { type: "issue", title: "Checkout 500", category_path: "backend", assignee: "@ai", fields: { severity: "high" } },
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().id;

    const bad = await app.inject({ method: "POST", url: "/api/items", headers: as("owner"), payload: { type: "issue", title: "x" } });
    assert.equal(bad.statusCode, 400);
    assert.ok(bad.json().error.hint.rules.example, "errors teach the rules");

    const inbox = await app.inject({ url: "/api/inbox", headers: as("ai-agent") });
    assert.equal(inbox.json().items[0].id, id);

    const got = await app.inject({ url: `/api/items/${id}`, headers: as("ai-agent") });
    assert.equal(got.json().rules_url, "/api/rules/issue");

    assert.equal((await app.inject({ method: "PATCH", url: `/api/items/${id}`, headers: as("ai-agent"), payload: { status: "in_progress" } })).statusCode, 200);
    const reply = await app.inject({
      method: "POST",
      url: `/api/items/${id}/replies`,
      headers: as("ai-agent"),
      payload: { body: "Fixed the null cart.", fields: { resolution: "fixed", commits: ["abc1234"], files: ["src/cart.ts"] }, status: "review" },
    });
    assert.equal(reply.statusCode, 201);
    assert.equal(reply.json().status, "review");

    const act = await app.inject({
      method: "POST",
      url: "/api/activity",
      headers: as("ai-agent"),
      payload: { action: "fix", summary: "Guard against empty cart", why: "Checkout crashed on empty carts", refs: [id] },
    });
    assert.equal(act.statusCode, 201);
    const feed = await app.inject({ url: `/api/activity?ref=${id}`, headers: as("owner") });
    assert.equal(feed.json().entries[0].summary, "Guard against empty cart");

    const ask = await app.inject({ method: "POST", url: "/api/ask", headers: as("owner"), payload: { about: act.json().id, title: "Did you add a test?" } });
    assert.equal(ask.statusCode, 201);
    const aiInbox = await app.inject({ url: "/api/inbox", headers: as("ai-agent") });
    assert.ok(aiInbox.json().items.some((i: { id: string }) => i.id === ask.json().id));

    const search = await app.inject({ url: "/api/search?q=empty%20cart&kind=activity", headers: as("owner") });
    assert.equal(search.json().results[0].kind, "activity");
    assert.equal((await app.inject({ url: "/api/search?q=x&kind=bogus", headers: as("owner") })).statusCode, 400);

    const list = await app.inject({ url: "/api/items?type=issue&open=true", headers: as("owner") });
    assert.equal(list.json().total, 1);
  } finally {
    await app.close();
    t.cleanup();
  }
});

test("MCP: an AI answers its inbox and logs its work", async () => {
  const t = tempProject();
  const server = buildMcpServer(await localApi(t.cortex, t.ai), { tools: "full" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { isError: !!r.isError, data: JSON.parse(r.content[0].text) };
    };

    const q = t.cortex.items.create(t.human, { type: "question", title: "Which cache do we use?", assignee: "@ai" });
    const inbox = await call("cortex_inbox");
    assert.equal(inbox.data.items[0].id, q.id);

    const answered = await call("cortex_reply", { id: q.id, body: "Redis, 5 minute TTL." });
    assert.equal(answered.data.status, "answered");

    const logged = await call("cortex_log_activity", { action: "investigation", summary: "Checked cache config" });
    assert.equal(logged.isError, false);
    const rejected = await call("cortex_log_activity", { action: "fix", summary: "No reason given" });
    assert.equal(rejected.isError, true);
    assert.equal(rejected.data.error.code, "invalid_activity");

    const decision = await call("cortex_create_item", { type: "decision", title: "Cache with Redis", fields: { context: "Need shared cache" } });
    assert.equal(decision.data.status, "proposed");
    const accept = await call("cortex_update_item", { id: decision.data.id, status: "accepted" });
    assert.equal(accept.isError, true);
    assert.equal(accept.data.error.code, "forbidden");

    const rules = await call("cortex_rules", { name: "issue" });
    assert.equal(rules.data.rules.issue.type, "issue");
  } finally {
    await client.close();
    t.cleanup();
  }
});
