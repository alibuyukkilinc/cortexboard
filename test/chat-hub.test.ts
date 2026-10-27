import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { initProject } from "../src/core/init.js";
import { hashPassword } from "../src/hub/crypto.js";
import { Hub, HUB_COOKIE, buildHubServer } from "../src/hub/server.js";
import { HubStore } from "../src/hub/store.js";
import { remoteApi, withRemoteHuman } from "../src/mcp/client.js";
import { buildMcpServer } from "../src/mcp/server.js";

// Approving from the AI chat on a team server: the person makes a chat key on the board, their MCP server
// uses it next to the agent's token, and the hub records the answer as theirs, with their role.
test("hub: a chat key lets a person approve from the AI chat, with their own role and nothing more", async () => {
  const root = mkdtempSync(join(tmpdir(), "cortex-chat-hub-"));
  const store = HubStore.init(join(root, "hub"), { org: "Acme", host: "127.0.0.1", port: 4747 });
  const admin = store.createUser({ email: "ada@example.com", name: "Ada", org_admin: true });
  store.setPassword(admin.id, await hashPassword("correct-horse-1"));
  for (const id of ["shop", "blog"]) {
    const dir = join(root, id);
    initProject(dir, id, { language: "en", timezone: "UTC", bootstrapTask: false });
    store.addProject({ id, name: id, path: dir });
  }
  const bob = store.createUser({ email: "bob@example.com", name: "Bob" });
  store.setPassword(bob.id, await hashPassword("long-enough-pw"));
  store.setMember("shop", bob.id, { role: "member" });
  const vic = store.createUser({ email: "vic@example.com", name: "Vic" });
  store.setPassword(vic.id, await hashPassword("long-enough-pw"));
  store.setMember("shop", vic.id, { role: "viewer" });
  const { token: agentToken } = store.createAgent({ id: "claude-code" }, admin.id);
  store.setMember("shop", "claude-code", { role: "contributor" });

  const hub = new Hub(store);
  const app = buildHubServer(hub);
  const call = (o: InjectOptions & { cookie?: string; token?: string; via?: object }) =>
    app.inject({
      ...o,
      headers: {
        ...(o.cookie ? { cookie: `${HUB_COOKIE}=${o.cookie}`, "x-cortex-csrf": "1" } : {}),
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        ...(o.via ? { "x-cortex-via": Buffer.from(JSON.stringify(o.via)).toString("base64url") } : {}),
      },
    });
  const login = async (email: string, password: string) =>
    (await call({ method: "POST", url: "/api/auth/login", payload: { email, password } })).cookies.find((c) => c.name === HUB_COOKIE)!.value;
  const clients: Client[] = [];
  try {
    // Keys are made on the board, per project, only where the person is a member.
    const bobSession = await login("bob@example.com", "long-enough-pw");
    const made = await call({ method: "POST", url: "/api/hub/chat-tokens", cookie: bobSession, payload: { project: "shop", label: "laptop" } });
    assert.equal(made.statusCode, 201, made.body);
    const bobKey = made.json().secret as string;
    assert.equal((await call({ method: "POST", url: "/api/hub/chat-tokens", cookie: bobSession, payload: { project: "blog" } })).statusCode, 403);
    const vicSession = await login("vic@example.com", "long-enough-pw");
    const vicKey = (await call({ method: "POST", url: "/api/hub/chat-tokens", cookie: vicSession, payload: { project: "shop" } })).json().secret as string;

    // What a chat key may do on its own: read its project with a via header, record answers, nothing else.
    const via = { channel: "chat-elicitation", ai_actor: "claude-code" };
    assert.equal((await call({ method: "GET", url: "/api/p/shop/brief", token: bobKey })).json().error.code, "via_required");
    assert.equal((await call({ method: "GET", url: "/api/p/shop/brief", token: bobKey, via })).statusCode, 200);
    assert.equal((await call({ method: "GET", url: "/api/p/blog/brief", token: bobKey, via })).json().error.code, "chat_key_scope");
    assert.equal((await call({ method: "PUT", url: "/api/p/shop/status", token: bobKey, via, payload: { body: "x" } })).json().error.code, "chat_key_scope");
    assert.equal((await call({ method: "GET", url: "/api/hub/chat-tokens", token: bobKey, via })).json().error.code, "chat_key_scope");
    assert.equal((await call({ method: "POST", url: "/api/p/shop/approvals/approve", token: bobKey, via, payload: { ids: [] } })).statusCode, 403);

    // A question asked on the board: the agent opens it, Bob's chat key (held by his MCP server) cannot answer
    // it, his board session can.
    const card = hub.cortex("shop").items.create(hub.cortex("shop").actor("claude-code"), { type: "task", title: "Ship", reply_required: false });
    hub.cortex("shop").items.update(hub.cortex("shop").actor("claude-code"), card.id, { status: "review" });
    const asked = await call({
      method: "POST",
      url: "/api/p/shop/chat/prompts",
      token: agentToken,
      payload: {
        human: bob.id,
        title: "close?",
        message: "Close Ship?",
        schema: { type: "object", properties: { answer: { type: "string", enum: ["yes", "no"] } }, required: ["answer"] },
        plan: { kind: "transition", target_id: card.id, to: "done" },
      },
    });
    assert.equal(asked.statusCode, 201, asked.body);
    const pid = asked.json().prompt.id as string;
    const answerUrl = `/api/p/shop/chat/prompts/${pid}/answer`;
    assert.equal(
      (await call({ method: "POST", url: answerUrl, token: bobKey, via, payload: { answer: { answer: "yes" } } })).json().error.code,
      "chat_key_scope",
    );
    assert.equal(
      (await call({ method: "POST", url: answerUrl, cookie: vicSession, payload: { answer: { answer: "yes" } } })).statusCode,
      404,
      "not Vic's question",
    );
    const byBob = await call({ method: "POST", url: answerUrl, cookie: bobSession, payload: { answer: { answer: "yes" } } });
    assert.equal(byBob.statusCode, 200, byBob.body);
    assert.equal(hub.cortex("shop").items.get(card.id).item.status, "done");

    // The agent proposes; Bob approves in the chat through his own MCP server.
    await app.listen({ port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const shop = hub.cortex("shop");
    shop.putNode(shop.actor("owner"), { path: "backend", title: "Backend", summary: "API" });
    shop.putNode(shop.actor("claude-code"), { path: "backend/queue", title: "Queue", summary: "Redis streams." });
    assert.equal(shop.listDrafts().length, 1);

    const shown: string[] = [];
    const connect = async (key?: string) => {
      const api = remoteApi(url, "shop", agentToken);
      const server = buildMcpServer(key ? await withRemoteHuman(api, url, "shop", key) : api);
      const client = new Client({ name: "chat-hub", version: "1" }, { capabilities: { elicitation: { form: {} } } });
      client.setRequestHandler(ElicitRequestSchema, async (req) => {
        shown.push((req.params as { message: string }).message);
        return { action: "accept", content: { d1: "approve" } };
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      clients.push(client);
      return async (name: string, args: Record<string, unknown> = {}) => {
        const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
        return { error: r.isError === true, data: JSON.parse(r.content[0].text) };
      };
    };

    const plain = await connect();
    assert.equal((await clients.at(-1)!.listTools()).tools.length, 20, "no chat key: no approval tools, the usual core 20");
    assert.equal((await plain("cortex_brief")).data.attention.ask_humans, undefined);

    // A viewer is never asked: their role could not approve on the board either.
    const asVic = await connect(vicKey);
    const refused = await asVic("cortex_review_drafts");
    assert.equal(refused.data.error.code, "not_permitted");
    assert.equal(shown.length, 0, "the viewer was not shown a question");

    const asBob = await connect(bobKey);
    assert.equal((await asBob("cortex_brief")).data.attention.ask_humans.count, 1);
    const r = await asBob("cortex_review_drafts");
    assert.equal(r.error, false, JSON.stringify(r.data));
    assert.equal(r.data.recorded_as.actor, bob.id);
    assert.match(shown[0], /Redis streams\./);
    assert.equal(shop.node("backend/queue").status, "active");
    const audit = shop.index.queryActivity({ includeSystem: true, chat: true, limit: 10 }).find((e) => e.action === "draft.approved")!;
    assert.equal(audit.actor, bob.id);
    assert.equal(audit.via?.channel, "chat-elicitation");
    assert.equal(audit.via?.ai_actor, "claude-code");

    // Revoked: the key stops working at once.
    const [key] = store.chatTokens(bob.id);
    assert.equal((await call({ method: "DELETE", url: `/api/hub/chat-tokens/${key.id}`, cookie: bobSession })).statusCode, 200);
    assert.equal((await call({ method: "GET", url: "/api/p/shop/brief", token: bobKey, via })).statusCode, 401);
  } finally {
    for (const c of clients) await c.close();
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
