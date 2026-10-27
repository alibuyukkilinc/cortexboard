import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions } from "fastify";
import { initProject } from "../src/core/init.js";
import { hashPassword } from "../src/hub/crypto.js";
import { Hub, HUB_COOKIE, buildHubServer } from "../src/hub/server.js";
import { RateLimiter } from "../src/hub/limiter.js";
import type { HubSettings } from "../src/hub/store.js";
import { HubStore, INVITE_DAYS } from "../src/hub/store.js";

// A hub with two projects and an organization admin (ada@example.com / correct-horse-1).
async function setup(settings: Partial<HubSettings> = {}) {
  const root = mkdtempSync(join(tmpdir(), "cortex-hub-"));
  const store = HubStore.init(join(root, "hub"), { org: "Acme", host: "127.0.0.1", port: 4747, ...settings });
  const admin = store.createUser({ email: "ada@example.com", name: "Ada", org_admin: true });
  store.setPassword(admin.id, await hashPassword("correct-horse-1"));
  for (const id of ["shop", "blog"]) {
    const dir = join(root, id);
    initProject(dir, id, { language: "en", timezone: "UTC", bootstrapTask: false });
    store.addProject({ id, name: id, path: dir });
  }
  const hub = new Hub(store);
  const app = buildHubServer(hub);
  const call = (o: InjectOptions & { cookie?: string; token?: string; csrf?: boolean }) =>
    app.inject({
      ...o,
      headers: {
        ...(o.headers ?? {}),
        ...(o.cookie ? { cookie: `${HUB_COOKIE}=${o.cookie}` } : {}),
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        ...(o.csrf !== false && o.cookie ? { "x-cortex-csrf": "1" } : {}),
      },
    });
  const login = async (email: string, password: string) => {
    const r = await call({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    assert.equal(r.statusCode, 200, r.body);
    return r.cookies.find((c) => c.name === HUB_COOKIE)!.value;
  };
  const cleanup = async () => {
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, store, hub, app: app as FastifyInstance, call, login, admin, cleanup };
}

// Admin creates a person, they accept the invite and pick a password; returns their session.
async function invite(t: Awaited<ReturnType<typeof setup>>, adminCookie: string, email: string, name: string, projects: { id: string; role: string }[] = []) {
  const r = await t.call({ method: "POST", url: "/api/admin/users", cookie: adminCookie, payload: { email, name, projects } });
  assert.equal(r.statusCode, 201, r.body);
  const token = r.json().invite_url.split("/invite/")[1];
  const accepted = await t.call({ method: "POST", url: `/api/auth/invite/${token}`, payload: { password: "long-enough-pw" } });
  assert.equal(accepted.statusCode, 200, accepted.body);
  return { id: r.json().user.id as string, cookie: accepted.cookies.find((c) => c.name === HUB_COOKIE)!.value };
}

test("hub sign-in: password, session cookie, CSRF, rate limit, invites", async () => {
  const t = await setup();
  try {
    assert.equal((await t.call({ url: "/api/hub/me" })).statusCode, 401);
    assert.equal((await t.call({ method: "POST", url: "/api/auth/login", payload: { email: "ada@example.com", password: "wrong" } })).statusCode, 401);
    const cookie = await t.login("ADA@example.com", "correct-horse-1"); // email is case-insensitive
    const me = (await t.call({ url: "/api/hub/me", cookie })).json();
    assert.equal(me.principal.org_admin, true);
    assert.deepEqual(me.projects.map((p: { id: string }) => p.id).sort(), ["blog", "shop"], "org admins see every project");

    // Cookie writes need the CSRF header.
    assert.equal((await t.call({ method: "POST", url: "/api/admin/users", cookie, csrf: false, payload: {} })).statusCode, 403);

    // Invite: weak password refused, link works once.
    const r = await t.call({ method: "POST", url: "/api/admin/users", cookie, payload: { email: "bob@example.com", name: "Bob" } });
    const token = r.json().invite_url.split("/invite/")[1];
    assert.equal((await t.call({ url: `/api/auth/invite/${token}` })).json().email, "bob@example.com");
    assert.equal((await t.call({ method: "POST", url: `/api/auth/invite/${token}`, payload: { password: "short" } })).statusCode, 400);
    assert.equal((await t.call({ method: "POST", url: `/api/auth/invite/${token}`, payload: { password: "long-enough-pw" } })).statusCode, 200);
    assert.equal((await t.call({ method: "POST", url: `/api/auth/invite/${token}`, payload: { password: "long-enough-pw" } })).statusCode, 404);
    await t.login("bob@example.com", "long-enough-pw");

    // Disabled users lose their sessions and cannot sign in.
    const bob = t.store.userByEmail("bob@example.com")!;
    const bobCookie = await t.login("bob@example.com", "long-enough-pw");
    assert.equal((await t.call({ method: "PATCH", url: `/api/admin/users/${bob.id}`, cookie, payload: { disabled: true } })).statusCode, 200);
    assert.equal((await t.call({ url: "/api/hub/me", cookie: bobCookie })).statusCode, 401);
    assert.equal((await t.call({ method: "POST", url: "/api/auth/login", payload: { email: "bob@example.com", password: "long-enough-pw" } })).statusCode, 401);

    // Ten wrong passwords, then the door closes for a while (even for the right one).
    for (let i = 0; i < 10; i++) await t.call({ method: "POST", url: "/api/auth/login", payload: { email: "ada@example.com", password: "nope" } });
    assert.equal(
      (await t.call({ method: "POST", url: "/api/auth/login", payload: { email: "ada@example.com", password: "correct-horse-1" } })).statusCode,
      429,
    );
  } finally {
    await t.cleanup();
  }
});

test("hub roles: non-members are out, viewers read and ask, members write, only admins manage", async () => {
  const t = await setup();
  try {
    const admin = await t.login("ada@example.com", "correct-horse-1");
    const eve = await invite(t, admin, "eve@example.com", "Eve");
    assert.equal((await t.call({ url: "/api/p/shop/brief", cookie: eve.cookie })).statusCode, 403, "not a member yet");
    assert.equal((await t.call({ url: "/api/admin/users", cookie: eve.cookie })).statusCode, 403, "not an org admin");
    assert.equal((await t.call({ url: "/api/hub/me", cookie: eve.cookie })).json().projects.length, 0);

    await t.call({ method: "PUT", url: `/api/p/shop/members/${eve.id}`, cookie: admin, payload: { role: "viewer" } });
    const brief = await t.call({ url: "/api/p/shop/brief", cookie: eve.cookie });
    assert.equal(brief.statusCode, 200);
    assert.equal(brief.json().you.role, "viewer");
    assert.equal((await t.call({ method: "POST", url: "/api/p/shop/items", cookie: eve.cookie, payload: { type: "task", title: "Nope" } })).statusCode, 403);
    assert.equal(
      (await t.call({ method: "POST", url: "/api/p/shop/items", cookie: eve.cookie, payload: { type: "question", title: "Why?" } })).statusCode,
      201,
    );
    assert.equal((await t.call({ method: "PUT", url: "/api/p/shop/node/backend", cookie: eve.cookie, payload: { title: "B", summary: "x" } })).statusCode, 403);
    assert.equal((await t.call({ url: "/api/p/blog/brief", cookie: eve.cookie })).statusCode, 403, "membership is per project");

    await t.call({ method: "PUT", url: `/api/p/shop/members/${eve.id}`, cookie: admin, payload: { role: "member" } });
    const me = (await t.call({ url: "/api/p/shop/me", cookie: eve.cookie })).json();
    assert.equal(me.role, "member");
    assert.ok(me.perms.includes("write_knowledge") && !me.perms.includes("edit_rules"));
    assert.ok(
      me.actors.some((a: { id: string }) => a.id === eve.id),
      "hub members are actors in the project",
    );
    const put = await t.call({ method: "PUT", url: "/api/p/shop/node/backend", cookie: eve.cookie, payload: { title: "Backend", summary: "Node API." } });
    assert.equal(put.statusCode, 200, "people write knowledge directly");
    assert.equal(
      (await t.call({ method: "PUT", url: "/api/p/shop/rules/_global/source", cookie: eve.cookie, payload: { source: "rules: []\n" } })).statusCode,
      403,
    );
    assert.equal((await t.call({ method: "PUT", url: `/api/p/shop/members/${t.admin.id}`, cookie: eve.cookie, payload: { role: "viewer" } })).statusCode, 403);

    // The last owner cannot be removed.
    assert.equal((await t.call({ method: "PUT", url: `/api/p/shop/members/${t.admin.id}`, cookie: admin, payload: { role: "owner" } })).statusCode, 200);
    assert.equal((await t.call({ method: "DELETE", url: `/api/p/shop/members/${t.admin.id}`, cookie: admin })).statusCode, 409);
  } finally {
    await t.cleanup();
  }
});

test("hub visibility: 'own' scope and branch limits hide the rest of the project", async () => {
  const t = await setup();
  try {
    const admin = await t.login("ada@example.com", "correct-horse-1");
    const fe = await invite(t, admin, "fe@example.com", "Frontend Dev", [{ id: "shop", role: "member" }]);
    const own = await invite(t, admin, "own@example.com", "Contractor", [{ id: "shop", role: "member" }]);
    await t.call({ method: "PUT", url: `/api/p/shop/members/${fe.id}`, cookie: admin, payload: { branches: ["frontend"] } });
    await t.call({ method: "PUT", url: `/api/p/shop/members/${own.id}`, cookie: admin, payload: { scope: "own" } });

    const mk = async (title: string, category_path: string, assignee?: string) =>
      (
        await t.call({
          method: "POST",
          url: "/api/p/shop/items",
          cookie: admin,
          payload: { type: "task", title, category_path, ...(assignee ? { assignee } : {}) },
        })
      ).json().id;
    const feTask = await mk("Fix the cart button", "frontend");
    const beTask = await mk("Speed up checkout API", "backend");
    const ownTask = await mk("Write the invoice export", "backend", own.id);

    const titles = async (cookie: string) =>
      (await t.call({ url: "/api/p/shop/items", cookie }))
        .json()
        .items.map((i: { title: string }) => i.title)
        .sort();
    assert.deepEqual(await titles(fe.cookie), ["Fix the cart button"]);
    assert.deepEqual(await titles(own.cookie), ["Write the invoice export"]);
    assert.equal((await titles(admin)).length, 3);

    assert.equal((await t.call({ url: `/api/p/shop/items/${beTask}`, cookie: fe.cookie })).statusCode, 404, "hidden, not just forbidden");
    assert.equal((await t.call({ url: `/api/p/shop/items/${feTask}`, cookie: fe.cookie })).statusCode, 200);
    assert.equal((await t.call({ url: `/api/p/shop/items/${ownTask}`, cookie: own.cookie })).statusCode, 200);

    // Branch limits apply to the tree, nodes and search.
    const tree = (await t.call({ url: "/api/p/shop/tree?depth=1", cookie: fe.cookie })).json();
    assert.deepEqual(
      tree.node.children.map((c: { path: string }) => c.path),
      ["frontend"],
    );
    assert.equal((await t.call({ url: "/api/p/shop/node/backend", cookie: fe.cookie })).statusCode, 404);
    const found = (await t.call({ url: "/api/p/shop/search?q=checkout", cookie: fe.cookie })).json().results;
    assert.equal(found.length, 0);
    const adminFound = (await t.call({ url: "/api/p/shop/search?q=checkout", cookie: admin })).json().results;
    assert.ok(
      adminFound.some((h: { id?: string }) => h.id === beTask),
      "the item is there; the branch limit hides it",
    );
    assert.equal(
      (await t.call({ method: "POST", url: "/api/p/shop/items", cookie: fe.cookie, payload: { type: "task", title: "x", category_path: "backend" } }))
        .statusCode,
      404,
    );

    // Partial views get no project-wide report.
    assert.equal((await t.call({ url: "/api/p/shop/report", cookie: fe.cookie })).statusCode, 403);
    assert.equal((await t.call({ url: "/api/p/shop/report", cookie: admin })).statusCode, 200);

    // The sidebar badges count what each member can see, the same as the lists behind them.
    const counts = async (cookie: string) => (await t.call({ url: "/api/p/shop/counts", cookie })).json();
    assert.equal((await counts(own.cookie)).inbox, 1, "the one task assigned to the contractor");
    assert.equal((await counts(fe.cookie)).inbox, 0);
  } finally {
    await t.cleanup();
  }
});

test("a membership granted outside the API (cortexboard hub member) is live at once", async () => {
  const t = await setup();
  try {
    const admin = await t.login("ada@example.com", "correct-horse-1");
    const made = await t.call({
      method: "POST",
      url: "/api/admin/agents",
      cookie: admin,
      payload: { id: "opencode", projects: [{ id: "blog", role: "contributor" }] },
    });
    assert.equal(made.statusCode, 201, made.body);
    const token = made.json().token as string;

    // The agent exists but was never given this project: the refusal names it.
    const refused = await t.call({ url: "/api/p/shop/brief", token });
    assert.equal(refused.statusCode, 403);
    assert.match(refused.json().error.message, /not a member of "shop"/);

    // What `cortexboard hub member shop opencode` does, from a second process, while the hub runs.
    t.store.setMember("shop", "opencode", { role: "contributor" });

    const allowed = await t.call({ url: "/api/p/shop/brief", token });
    assert.equal(allowed.statusCode, 200, "no restart needed");
    // The project's actor list caught up too, so the newcomer can be assigned work.
    const actors = (await t.call({ url: "/api/p/shop/me", token })).json().actors as { id: string }[];
    assert.ok(
      actors.some((a) => a.id === "opencode"),
      actors.map((a) => a.id).join(","),
    );
  } finally {
    await t.cleanup();
  }
});

test("hub AI agents: tokens, reader / contributor / trusted, never approve", async () => {
  const t = await setup();
  try {
    const admin = await t.login("ada@example.com", "correct-horse-1");
    const mkAgent = async (id: string, role: string) => {
      const r = await t.call({ method: "POST", url: "/api/admin/agents", cookie: admin, payload: { id, projects: [{ id: "shop", role }] } });
      assert.equal(r.statusCode, 201, r.body);
      return r.json().token as string;
    };
    const reader = await mkAgent("scout", "reader");
    const contributor = await mkAgent("claude-code", "contributor");
    const trusted = await mkAgent("docs-bot", "trusted");
    assert.equal((await t.call({ method: "POST", url: "/api/admin/agents", cookie: admin, payload: { id: "claude-code" } })).statusCode, 409);

    assert.equal((await t.call({ url: "/api/p/shop/brief", token: reader })).statusCode, 200);
    assert.equal((await t.call({ method: "POST", url: "/api/p/shop/items", token: reader, payload: { type: "task", title: "x" } })).statusCode, 403);

    const node = { title: "Queue", summary: "Redis queue, 3 retries." };
    const draft = await t.call({ method: "PUT", url: "/api/p/shop/node/backend/queue", token: contributor, payload: node });
    assert.equal(draft.statusCode, 202, "contributor knowledge writes become drafts");
    assert.equal(
      (await t.call({ method: "PUT", url: "/api/p/shop/node/backend/cache", token: trusted, payload: { title: "Cache", summary: "5 min." } })).statusCode,
      200,
      "trusted writes directly",
    );

    // An AI can never approve, whatever its role.
    assert.equal((await t.call({ method: "POST", url: `/api/p/shop/approvals/${draft.json().draft_id}/approve`, token: trusted })).statusCode, 403);
    assert.equal((await t.call({ method: "POST", url: `/api/p/shop/approvals/${draft.json().draft_id}/approve`, cookie: admin })).statusCode, 200);

    // Agents are scoped to their projects; rotating the token kills the old one.
    assert.equal((await t.call({ url: "/api/p/blog/brief", token: contributor })).statusCode, 403);
    const fresh = (await t.call({ method: "POST", url: "/api/admin/agents/claude-code/token", cookie: admin })).json().token;
    assert.equal((await t.call({ url: "/api/p/shop/brief", token: contributor })).statusCode, 401);
    assert.equal((await t.call({ url: "/api/p/shop/brief", token: fresh })).statusCode, 200);
    // Agents cannot use organization admin endpoints.
    assert.equal((await t.call({ url: "/api/admin/users", token: fresh })).statusCode, 403);
  } finally {
    await t.cleanup();
  }
});

test("hub projects: register a folder, create its knowledge on request, unregister without touching files", async () => {
  const t = await setup();
  try {
    const admin = await t.login("ada@example.com", "correct-horse-1");
    const folder = join(t.root, "new-app");
    (await import("node:fs")).mkdirSync(folder);
    assert.equal((await t.call({ method: "POST", url: "/api/admin/projects", cookie: admin, payload: { path: folder } })).statusCode, 400, "needs init: true");
    const r = await t.call({
      method: "POST",
      url: "/api/admin/projects",
      cookie: admin,
      payload: { path: folder, name: "New App", init: true, language: "tr", branches: "backend,mobile" },
    });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().project.id, "new-app");
    const brief = (await t.call({ url: "/api/p/new-app/brief", cookie: admin })).json();
    assert.match(brief.rules.global[0], /Turkish/);
    assert.deepEqual(
      brief.branches.map((b: { path: string }) => b.path),
      ["backend", "mobile"],
      "the chosen branches, not the whole template",
    );
    // The first agent on the hub finds the task that fills the tree; nobody has to paste a prompt.
    const tasks = (await t.call({ url: "/api/p/new-app/items?type=task", cookie: admin })).json();
    assert.equal(tasks.items[0].assignee, "@ai");
    assert.match(tasks.items[0].title, /Bilgi ağacını koddan doldur/);
    assert.equal((await t.call({ method: "DELETE", url: "/api/admin/projects/new-app", cookie: admin })).statusCode, 200);
    assert.equal((await t.call({ url: "/api/p/new-app/brief", cookie: admin })).statusCode, 404);
    // The knowledge went to the hub's folder (decision 01M3MXCE60DW7T897TRC43C6AR), not into the code folder.
    assert.ok((await import("node:fs")).existsSync(join(t.store.dir, "projects", "new-app", "cortex.config.yaml")));
    assert.ok(!(await import("node:fs")).existsSync(join(folder, ".cortex")));
  } finally {
    await t.cleanup();
  }
});

test("MCP over the hub: same tools, and the agent's role still decides", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { remoteApi } = await import("../src/mcp/client.js");
  const { buildMcpServer } = await import("../src/mcp/server.js");
  const t = await setup();
  const mcp: { close: () => Promise<void> }[] = [];
  try {
    const admin = await t.login("ada@example.com", "correct-horse-1");
    const token = async (id: string, role: string) =>
      (await t.call({ method: "POST", url: "/api/admin/agents", cookie: admin, payload: { id, projects: [{ id: "shop", role }] } })).json().token as string;
    const writer = await token("claude-code", "contributor");
    const reader = await token("scout", "reader");
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${(t.app.server.address() as { port: number }).port}`;

    const connect = async (tok: string) => {
      const server = buildMcpServer(remoteApi(url, "shop", tok));
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "1" });
      await Promise.all([server.connect(a), client.connect(b)]);
      mcp.push(client);
      return client;
    };
    const call = async (c: Awaited<ReturnType<typeof connect>>, name: string, args: Record<string, unknown> = {}) => {
      const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { error: r.isError === true, data: JSON.parse(r.content[0].text) };
    };

    const agent = await connect(writer);
    assert.equal((await agent.listTools()).tools.length, 20, "the same core tool set as a local project");
    const brief = await call(agent, "cortex_brief");
    assert.equal(brief.data.you.id, "claude-code");
    assert.equal(brief.data.you.role, "contributor");

    const wrote = await call(agent, "cortex_update_node", { path: "backend/queue", title: "Kuyruk", summary: "Redis.", reason: "documenting" });
    assert.equal(wrote.data.applied, false, "a contributor's knowledge write waits for approval");
    const item = await call(agent, "cortex_create_item", { type: "task", title: "From MCP over the hub", fields: {} });
    assert.equal(item.data.applied, true);

    const scout = await connect(reader);
    const refused = await call(scout, "cortex_create_item", { type: "task", title: "Nope", fields: {} });
    assert.equal(refused.error, true);
    assert.equal(refused.data.error.code, "forbidden");
    assert.equal(refused.data.error.hint.needs, "write_items");
    assert.equal((await call(scout, "cortex_brief")).data.you.role, "reader");

    // A wrong token is refused, and an unreachable hub says so instead of hanging.
    const stranger = await connect("ctx_nope");
    assert.equal((await call(stranger, "cortex_brief")).data.error.code, "unauthorized");
  } finally {
    for (const c of mcp) await c.close();
    await t.cleanup();
  }
});

test("MCP over HTTP: an AI that is not on this machine gets the same tools and the same role", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const t = await setup();
  const clients: { close: () => Promise<void> }[] = [];
  try {
    const admin = await t.login("ada@example.com", "correct-horse-1");
    const token = (
      await t.call({ method: "POST", url: "/api/admin/agents", cookie: admin, payload: { id: "remote-bot", projects: [{ id: "shop", role: "contributor" }] } })
    ).json().token;
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${(t.app.server.address() as { port: number }).port}`;

    const connect = async (tok: string, project = "shop") => {
      const client = new Client({ name: "remote", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/mcp/p/${project}`), { requestInit: { headers: { authorization: `Bearer ${tok}` } } }),
      );
      clients.push(client);
      return client;
    };
    const call = async (c: Awaited<ReturnType<typeof connect>>, name: string, args: Record<string, unknown> = {}) => {
      const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { error: r.isError === true, data: JSON.parse(r.content[0].text) };
    };

    const bot = await connect(token);
    assert.equal((await bot.listTools()).tools.length, 20, "the core set by default");
    const full = new Client({ name: "remote-full", version: "1" });
    await full.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp/p/shop?tools=full`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
    );
    clients.push(full);
    assert.equal((await full.listTools()).tools.length, 27, "?tools=full adds the rarely used ones");
    const brief = await call(bot, "cortex_brief");
    assert.equal(brief.data.you.id, "remote-bot");
    assert.equal(brief.data.you.role, "contributor");
    assert.equal((await call(bot, "cortex_update_node", { path: "backend/x", title: "X", summary: "y", reason: "test" })).data.applied, false, "still a draft");
    assert.equal((await call(bot, "cortex_create_item", { type: "task", title: "Over HTTP", fields: {} })).data.applied, true);

    // Wrong token and a project the agent is not in are refused at connect time.
    await assert.rejects(() => connect("ctx_nope"), /Unknown or disabled agent token/);
    await assert.rejects(() => connect(token, "blog"), /not a member/);

    // With the person's chat key next to the token: the approval tools, and questions go to the board
    // (stateless HTTP cannot show them in the chat), answered there from the person's own session.
    t.store.setMember("shop", t.admin.id, { role: "owner" });
    t.store.setMember("blog", t.admin.id, { role: "owner" });
    const keyFor = async (project: string) =>
      (await t.call({ method: "POST", url: "/api/hub/chat-tokens", cookie: admin, payload: { project } })).json().secret as string;
    const shopKey = await keyFor("shop");
    const withKey = async (key: string) => {
      const client = new Client({ name: "remote-person", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/mcp/p/shop`), {
          requestInit: { headers: { authorization: `Bearer ${token}`, "x-cortex-human-token": key } },
        }),
      );
      clients.push(client);
      return client;
    };
    const blogKey = await keyFor("blog");
    await assert.rejects(() => withKey(blogKey), /not a person's key for/);
    const person = await withKey(shopKey);
    const names = (await person.listTools()).tools.map((x) => x.name);
    assert.ok(names.includes("cortex_ask_human") && names.includes("cortex_pending_approvals"), "approvals are offered with a person");

    const task = (await call(person, "cortex_create_item", { type: "task", title: "Ship over HTTP", reply_required: false, fields: {} })).data.id as string;
    await call(person, "cortex_update_item", { id: task, status: "review" });
    const onBoard = async () => {
      for (let i = 0; i < 200; i++) {
        const [p] = (await t.call({ url: "/api/p/shop/chat/prompts", cookie: admin })).json().prompts as { id: string }[];
        if (p) return t.call({ method: "POST", url: `/api/p/shop/chat/prompts/${p.id}/answer`, cookie: admin, payload: { answer: { answer: "yes" } } });
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("no question reached the board");
    };
    const [asked, answered] = await Promise.all([call(person, "cortex_ask_human", { kind: "transition", target_id: task, to: "done" }), onBoard()]);
    assert.equal(answered.statusCode, 200, answered.body);
    assert.equal(asked.data.asked_on_board, true);
    assert.equal(asked.data.answered, true);
    assert.equal(asked.data.recorded_as.actor, t.admin.id);
    assert.equal(t.hub.cortex("shop").items.get(task).item.status, "done");
  } finally {
    for (const c of clients) await c.close();
    await t.cleanup();
  }
});

test("a project's owner can invite people and create agent tokens, without becoming an org admin", async () => {
  const t = await setup();
  try {
    const admin = await t.login("ada@example.com", "correct-horse-1");
    const lead = await invite(t, admin, "lead@example.com", "Mobil Lider", [{ id: "shop", role: "owner" }]);
    const worker = await invite(t, admin, "dev@example.com", "Geliştirici", [{ id: "shop", role: "member" }]);

    // A member cannot; the owner can.
    assert.equal(
      (await t.call({ method: "POST", url: "/api/p/shop/members/invite", cookie: worker.cookie, payload: { email: "x@example.com", name: "X" } })).statusCode,
      403,
    );
    const r = await t.call({
      method: "POST",
      url: "/api/p/shop/members/invite",
      cookie: lead.cookie,
      payload: { email: "yeni@example.com", name: "Yeni Kişi", role: "member", scope: "own" },
    });
    assert.equal(r.statusCode, 201, r.body);
    assert.match(r.json().invite_url, /\/invite\/inv_/);
    const created = t.store.userByEmail("yeni@example.com")!;
    assert.equal(created.org_admin, false, "a project owner never hands out organization admin");
    assert.deepEqual(
      t.store.memberships(created.id).map((m) => m.project_id),
      ["shop"],
      "only the project they run",
    );
    assert.equal(t.store.member("shop", created.id)!.scope, "own");
    assert.equal((await t.call({ url: "/api/admin/users", cookie: lead.cookie })).statusCode, 403, "still not an org admin");

    // Inviting someone who already has an account just adds them; no new password link.
    const again = await t.call({
      method: "POST",
      url: "/api/p/shop/members/invite",
      cookie: lead.cookie,
      payload: { email: "dev@example.com", name: "Geliştirici", role: "viewer" },
    });
    assert.equal(again.json().invite_url, undefined);
    assert.equal(t.store.member("shop", worker.id)!.role, "viewer");

    // Agents: created, listed and rotated by the project owner, scoped to this project.
    const agent = await t.call({
      method: "POST",
      url: "/api/p/shop/agents",
      cookie: lead.cookie,
      payload: { id: "shop-bot", name: "Shop Bot", role: "contributor" },
    });
    assert.equal(agent.statusCode, 201, agent.body);
    const token = agent.json().token;
    assert.equal((await t.call({ url: "/api/p/shop/brief", token })).statusCode, 200);
    assert.equal((await t.call({ url: "/api/p/blog/brief", token })).statusCode, 403, "the new agent sees only this project");
    assert.deepEqual(
      (await t.call({ url: "/api/p/shop/agents", cookie: lead.cookie })).json().agents.map((a: { id: string }) => a.id),
      ["shop-bot"],
    );

    const rotated = (await t.call({ method: "POST", url: "/api/p/shop/agents/shop-bot/token", cookie: lead.cookie })).json().token;
    assert.equal((await t.call({ url: "/api/p/shop/brief", token })).statusCode, 401, "the old token stopped working");
    assert.equal((await t.call({ url: "/api/p/shop/brief", token: rotated })).statusCode, 200);

    // Another project's owner cannot touch this agent's token.
    await t.call({ method: "PUT", url: `/api/p/blog/members/${lead.id}`, cookie: admin, payload: { role: "owner" } });
    assert.equal((await t.call({ method: "POST", url: "/api/p/blog/agents/shop-bot/token", cookie: lead.cookie })).statusCode, 404);
  } finally {
    await t.cleanup();
  }
});

test("members/candidates never leaks the whole hub roster to a non-org-admin project owner", async () => {
  const t = await setup();
  try {
    const admin = await t.login("ada@example.com", "correct-horse-1");
    const lead = await invite(t, admin, "lead@example.com", "Mağaza Lideri", [{ id: "shop", role: "owner" }]);
    const blogger = await invite(t, admin, "blogger@example.com", "Blog Sahibi", [{ id: "blog", role: "owner" }]);

    // Not an org admin, and administers no other project yet: sees nobody unrelated to "shop".
    const before = await t.call({ url: "/api/p/shop/members/candidates", cookie: lead.cookie });
    assert.equal(before.statusCode, 200);
    assert.equal(
      before.json().candidates.some((c: { id: string }) => c.id === blogger.id),
      false,
      "a stranger from another project must not appear",
    );

    // An org admin still sees the full roster.
    const asAdmin = await t.call({ url: "/api/p/shop/members/candidates", cookie: admin });
    assert.equal(
      asAdmin.json().candidates.some((c: { id: string }) => c.id === blogger.id),
      true,
      "org admins keep seeing everyone (regression)",
    );

    // Once lead also administers "blog", blog's people become visible as candidates for "shop" too.
    await t.call({ method: "PUT", url: `/api/p/blog/members/${lead.id}`, cookie: admin, payload: { role: "owner" } });
    const after = await t.call({ url: "/api/p/shop/members/candidates", cookie: lead.cookie });
    assert.equal(
      after.json().candidates.some((c: { id: string }) => c.id === blogger.id),
      true,
      "known through a project lead also administers",
    );

    // Inviting a genuinely new person by email never depended on the candidates list.
    const fresh = await t.call({
      method: "POST",
      url: "/api/p/shop/members/invite",
      cookie: lead.cookie,
      payload: { email: "brand-new@example.com", name: "Yeni" },
    });
    assert.equal(fresh.statusCode, 201, fresh.body);
  } finally {
    await t.cleanup();
  }
});

test("usage meter: counts each call once, per person and per agent, and stays out of the projects", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const t = await setup();
  const clients: { close: () => Promise<void> }[] = [];
  try {
    const admin = await t.login("ada@example.com", "correct-horse-1");
    const token = (
      await t.call({ method: "POST", url: "/api/admin/agents", cookie: admin, payload: { id: "meter-bot", projects: [{ id: "shop", role: "contributor" }] } })
    ).json().token;
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${(t.app.server.address() as { port: number }).port}`;

    // A person browsing, and an agent working over MCP.
    await t.call({ url: "/api/p/shop/brief", cookie: admin });
    await t.call({ url: "/api/p/shop/items", cookie: admin });
    const client = new Client({ name: "meter", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp/p/shop`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(client);
    await client.callTool({ name: "cortex_brief", arguments: {} });
    await client.callTool({ name: "cortex_search", arguments: { q: "backend" } });

    const usage = (await t.call({ url: "/api/admin/usage?since=7d", cookie: admin })).json();
    const bot = usage.by_principal.find((r: { principal: string }) => r.principal === "meter-bot");
    const person = usage.by_principal.find((r: { principal: string }) => r.principal === t.admin.id);
    assert.equal(bot.calls, 2, "one row per tool call, not one per inner request");
    assert.equal(bot.kind, "ai");
    assert.ok(bot.tokens > 0 && bot.tokens === Math.round(bot.bytes / 4));
    assert.equal(person.calls, 2, "people are metered too");
    assert.ok(
      usage.by_route.some((r: { route: string }) => r.route.startsWith("MCP GET /brief")),
      "the route says which tool it was",
    );
    assert.equal(usage.totals.calls, 4);
    assert.equal(usage.daily.at(-1).ai + usage.daily.at(-1).human, 4, "today's row carries the calls");
    assert.ok(usage.daily.length >= 7, "quiet days are on the chart too, not skipped");

    // Per project, for whoever may read that project's reports; and never mixed with another project.
    const mine = (await t.call({ url: "/api/p/shop/usage?since=7d", cookie: admin })).json();
    assert.equal(mine.totals.calls, usage.totals.calls);
    assert.equal((await t.call({ url: "/api/p/blog/usage?since=7d", cookie: admin })).json().totals.calls, 0);

    // A member without report rights cannot look, and the numbers never enter the project's files.
    const eve = await invite(t, admin, "eve@example.com", "Eve", [{ id: "shop", role: "member" }]);
    await t.call({ method: "PUT", url: `/api/p/shop/members/${eve.id}`, cookie: admin, payload: { role: "member", scope: "own" } });
    assert.equal((await t.call({ url: "/api/p/shop/usage", cookie: eve.cookie })).statusCode, 403, "partial views get no project-wide numbers");
    assert.equal((await t.call({ url: "/api/admin/usage", cookie: eve.cookie })).statusCode, 403);
    assert.equal(
      t.hub
        .cortex("shop")
        .index.queryActivity({ includeSystem: true, limit: 100 })
        .filter((a) => a.summary.includes("usage")).length,
      0,
    );
  } finally {
    for (const c of clients) await c.close();
    await t.cleanup();
  }
});

test("hub hardening: a Host allowlist has no localhost back door", async () => {
  const t = await setup({ allowed_hosts: ["cortex.acme.com"] });
  try {
    assert.equal((await t.call({ url: "/api/health", headers: { host: "localhost" } })).statusCode, 403, "a proxy can forward anything as localhost");
    assert.equal((await t.call({ url: "/api/health", headers: { host: "127.0.0.1:4747" } })).statusCode, 403);
    assert.equal((await t.call({ url: "/api/health", headers: { host: "cortex.acme.com" } })).statusCode, 200);
  } finally {
    await t.cleanup();
  }
  const open = await setup(); // no list: no Host check at all
  try {
    assert.equal((await open.call({ url: "/api/health", headers: { host: "anything.example" } })).statusCode, 200);
  } finally {
    await open.cleanup();
  }
});

test("hub hardening: guessing agent tokens is braked per address, over REST and MCP", async () => {
  const t = await setup();
  try {
    const { token } = t.store.createAgent({ id: "bot" }, t.admin.id);
    t.store.setMember("shop", "bot", { role: "contributor" });
    for (let i = 0; i < 5; i++) assert.equal((await t.call({ url: "/api/p/shop/brief", token: `ctx_guess_${i}` })).statusCode, 401);
    for (let i = 5; i < 10; i++) await t.call({ method: "POST", url: "/mcp/p/shop", token: `ctx_guess_${i}`, payload: {} });
    const eleventh = await t.call({ url: "/api/p/shop/brief", token: "ctx_guess_10" });
    assert.equal(eleventh.statusCode, 429);
    assert.equal((await t.call({ method: "POST", url: "/mcp/p/shop", token: "ctx_guess_11", payload: {} })).statusCode, 429);
    // Another address is not affected, and a good token works from there.
    assert.equal((await t.call({ url: "/api/p/shop/brief", token, remoteAddress: "10.0.0.9" })).statusCode, 200);
  } finally {
    await t.cleanup();
  }
});

test("hub hardening: the limiter's memory stays bounded", () => {
  const l = new RateLimiter(3, 1000, 100);
  try {
    for (let i = 0; i < 1000; i++) l.fail(`ip-${i}`, 0);
    assert.ok(l.size <= 100, `size ${l.size}`);
    for (let i = 0; i < 3; i++) l.fail("attacker", 10);
    assert.equal(l.blocked("attacker", 10), true, "a fresh key still counts after old ones were dropped");
    l.sweep(5000);
    assert.equal(l.size, 0, "everything expired is swept");
    assert.equal(l.blocked("attacker", 5000), false);
  } finally {
    l.stop();
  }
});

test("hub hardening: invites live 48 hours, work once, and dead links are braked", async () => {
  const t = await setup();
  try {
    assert.equal(INVITE_DAYS, 2);
    const cookie = await t.login("ada@example.com", "correct-horse-1");
    const r = await t.call({ method: "POST", url: "/api/admin/users", cookie, payload: { email: "eve@example.com", name: "Eve" } });
    const token = r.json().invite_url.split("/invite/")[1] as string;
    const eve = t.store.userByEmail("eve@example.com")!;

    // Expired: pushed past its deadline directly in the store.
    (t.store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db
      .prepare("UPDATE invites SET expires_at = ? WHERE user_id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), eve.id);
    assert.equal((await t.call({ url: `/api/auth/invite/${token}` })).statusCode, 404);

    // A fresh one works once.
    const again = (await t.call({ method: "POST", url: `/api/admin/users/${eve.id}/invite`, cookie })).json().invite_url.split("/invite/")[1];
    assert.equal((await t.call({ method: "POST", url: `/api/auth/invite/${again}`, payload: { password: "long-enough-pw" } })).statusCode, 200);
    assert.equal((await t.call({ url: `/api/auth/invite/${again}` })).statusCode, 404, "used");

    for (let i = 0; i < 18; i++) await t.call({ url: `/api/auth/invite/nope-${i}` });
    assert.equal((await t.call({ url: "/api/auth/invite/nope-last" })).statusCode, 429);
  } finally {
    await t.cleanup();
  }
});

test("hub hardening: the session cookie's Secure flag follows the setting, the listen address and the proxy", async () => {
  const secureFlag = async (settings: Partial<HubSettings>, headers: Record<string, string> = {}) => {
    const t = await setup(settings);
    try {
      const r = await t.call({ method: "POST", url: "/api/auth/login", headers, payload: { email: "ada@example.com", password: "correct-horse-1" } });
      assert.equal(r.statusCode, 200);
      return /;\s*Secure/i.test(String(r.headers["set-cookie"]));
    } finally {
      await t.cleanup();
    }
  };
  assert.equal(await secureFlag({}), false, "loopback only: plain http is fine");
  assert.equal(await secureFlag({ host: "0.0.0.0" }), true, "on the network: Secure by default");
  assert.equal(await secureFlag({ host: "0.0.0.0", cookie_secure: false }), false, "an explicit choice wins");
  assert.equal(await secureFlag({ trust_proxy: true }, { "x-forwarded-proto": "https" }), true, "https behind a trusted proxy");
  assert.equal(await secureFlag({}, { "x-forwarded-proto": "https" }), false, "an untrusted header is ignored");
});

test("hub links: an org admin links projects from the board, comments kept, the project's agents made readers", async () => {
  const t = await setup();
  try {
    const admin = await t.login("ada@example.com", "correct-horse-1");
    const { token } = t.store.createAgent({ id: "shop-bot" }, t.admin.id);
    t.store.setMember("shop", "shop-bot", { role: "contributor" });
    const put = (payload: object, cookie = admin) => t.call({ method: "PUT", url: "/api/admin/projects/shop/links", cookie, payload });

    assert.equal((await put({ linked: ["nope"] })).statusCode, 400, "unknown project");
    assert.equal((await put({ linked: ["shop"] })).statusCode, 400, "itself");
    const r = await put({ linked: ["blog"], grant_readers: true });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().granted, [{ project: "blog", agent: "shop-bot" }]);
    assert.equal(t.store.member("blog", "shop-bot")?.role, "reader");

    const cfg = (await import("node:fs")).readFileSync(join(t.root, "shop", ".cortex", "cortex.config.yaml"), "utf8");
    assert.match(cfg, /^# Cortex project settings/, "the file's comments stay");
    assert.match(cfg, /linked: \[ blog \]/);
    const list = (await t.call({ url: "/api/admin/projects", cookie: admin })).json().projects as { id: string; linked: string[] }[];
    assert.deepEqual(list.find((p) => p.id === "shop")?.linked, ["blog"]);

    // Live at once: the agent reads the linked project without a restart.
    const brief = (await t.call({ url: "/api/p/shop/brief", token })).json();
    assert.deepEqual(
      brief.linked.map((l: { id: string; readable: boolean }) => [l.id, l.readable]),
      [["blog", true]],
    );

    // Unlinking removes the key; members are left as they are.
    assert.deepEqual((await put({ linked: [] })).json().linked, []);
    assert.doesNotMatch((await import("node:fs")).readFileSync(join(t.root, "shop", ".cortex", "cortex.config.yaml"), "utf8"), /linked/);
  } finally {
    await t.cleanup();
  }
});

test("hub me: tells the board the hub's own address, for ready-made setup commands", async () => {
  const t = await setup({ public_url: "https://cortex.example.com/" });
  try {
    const admin = await t.login("ada@example.com", "correct-horse-1");
    assert.equal((await t.call({ url: "/api/hub/me", cookie: admin })).json().hub_url, "https://cortex.example.com");
  } finally {
    await t.cleanup();
  }
});

test("hub delete: a person or an agent goes for good, history stays, the id is never handed out again", async () => {
  const t = await setup();
  try {
    const admin = await t.login("ada@example.com", "correct-horse-1");
    const { token } = t.store.createAgent({ id: "old-bot" }, t.admin.id);
    t.store.setMember("shop", "old-bot", { role: "contributor" });
    assert.equal((await t.call({ url: "/api/p/shop/brief", token })).statusCode, 200);

    assert.equal((await t.call({ method: "DELETE", url: "/api/admin/agents/old-bot", cookie: admin })).statusCode, 200);
    assert.equal((await t.call({ url: "/api/p/shop/brief", token })).statusCode, 401, "the token stops at once");
    assert.equal(t.store.member("shop", "old-bot"), null);
    assert.throws(() => t.store.createAgent({ id: "old-bot" }, t.admin.id), /already used/, "a retired id is not reused");

    const bob = await invite(t, admin, "bob@example.com", "Bob", [{ id: "shop", role: "member" }]);
    assert.equal((await t.call({ method: "DELETE", url: `/api/admin/users/${bob.id}`, cookie: admin })).statusCode, 200);
    assert.equal((await t.call({ url: "/api/hub/me", cookie: bob.cookie })).statusCode, 401, "their sessions end");
    assert.equal(t.store.member("shop", bob.id), null);

    assert.equal((await t.call({ method: "DELETE", url: `/api/admin/users/${t.admin.id}`, cookie: admin })).statusCode, 403, "not yourself");
    const other = t.store.createUser({ email: "cy@example.com", name: "Cy", org_admin: true });
    t.store.updateUser(other.id, { disabled: true });
    assert.throws(() => t.store.deleteUser(t.admin.id, other.id), /only organization admin/);
  } finally {
    await t.cleanup();
  }
});

test("hub agent token from a project: only for someone who manages every project the agent works on", async () => {
  const t = await setup();
  try {
    const admin = await t.login("ada@example.com", "correct-horse-1");
    const owner = await invite(t, admin, "olga@example.com", "Olga", [{ id: "shop", role: "owner" }]);
    t.store.createAgent({ id: "both-bot" }, t.admin.id);
    t.store.setMember("shop", "both-bot", { role: "contributor" });
    t.store.setMember("blog", "both-bot", { role: "reader" });
    const reset = () => t.call({ method: "POST", url: "/api/p/shop/agents/both-bot/token", cookie: owner.cookie });

    const refused = await reset();
    assert.equal(refused.statusCode, 403, "the token would act on blog too");
    assert.match(refused.json().error.message, /blog/);
    assert.equal((await t.call({ method: "POST", url: "/api/p/shop/agents/both-bot/token", cookie: admin })).statusCode, 200, "an org admin may");

    t.store.removeMember("blog", "both-bot");
    const ok = await reset();
    assert.equal(ok.statusCode, 200, ok.body);
    assert.match(ok.json().token, /^ctx_/);
  } finally {
    await t.cleanup();
  }
});
