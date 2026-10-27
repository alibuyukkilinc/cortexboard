import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { InjectOptions } from "fastify";
import { initProject } from "../src/core/init.js";
import { hashPassword } from "../src/hub/crypto.js";
import { projectFromResource, redirectAllowed } from "../src/hub/oauth.js";
import { Hub, HUB_COOKIE, buildHubServer } from "../src/hub/server.js";
import { HubStore } from "../src/hub/store.js";

// A claude.ai-style connector: no headers to set, only a URL. It finds the hub's authorization server from the
// 401, registers itself, sends the person to sign in and consent, and gets a token for one agent in one project.
async function setup() {
  for (const k of ["CORTEX_PUBLIC_URL", "CORTEX_TRUST_PROXY", "CORTEX_ALLOWED_HOSTS"]) delete process.env[k]; // this test sets its own address
  const root = mkdtempSync(join(tmpdir(), "cortex-oauth-"));
  const store = HubStore.init(join(root, "hub"), { org: "Acme", host: "127.0.0.1", port: 4747, public_url: "https://hub.example.com" });
  const admin = store.createUser({ email: "ada@example.com", name: "Ada" });
  store.setPassword(admin.id, await hashPassword("correct-horse-1"));
  const bob = store.createUser({ email: "bob@example.com", name: "Bob" });
  store.setPassword(bob.id, await hashPassword("correct-horse-2"));
  for (const id of ["shop", "blog"]) {
    const dir = join(root, id);
    initProject(dir, id, { language: "en", timezone: "UTC", bootstrapTask: false });
    store.addProject({ id, name: id, path: dir });
  }
  store.setMember("shop", admin.id, { role: "owner" });
  store.setMember("shop", bob.id, { role: "member" });
  const hub = new Hub(store);
  const app = buildHubServer(hub);
  const call = (o: InjectOptions & { cookie?: string }) =>
    app.inject({ ...o, headers: { ...(o.headers ?? {}), ...(o.cookie ? { cookie: `${HUB_COOKIE}=${o.cookie}` } : {}) } });
  const form = (url: string, body: Record<string, string>, cookie?: string) =>
    call({ method: "POST", url, cookie, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(body).toString() });
  const cleanup = async () => {
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { store, hub, app, call, form, admin, cleanup };
}

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

test("oauth helpers: redirect addresses and the project in the resource", () => {
  assert.ok(redirectAllowed(REDIRECT));
  assert.ok(redirectAllowed("http://localhost:33418/callback"));
  assert.ok(!redirectAllowed("http://evil.example.com/cb"));
  assert.ok(!redirectAllowed("javascript:alert(1)"));
  assert.equal(projectFromResource("https://hub.example.com/mcp/p/shop"), "shop");
  assert.equal(projectFromResource("https://hub.example.com/mcp/p/my%20app/"), "my app");
  assert.equal(projectFromResource("https://hub.example.com/other"), null);
});

test("oauth: a connector signs in, the person picks an agent, the token works over MCP", async () => {
  const t = await setup();
  const clients: Client[] = [];
  try {
    // 1. No token: 401 with where to look, then both metadata documents.
    const first = await t.call({ method: "POST", url: "/mcp/p/shop", payload: {} });
    assert.equal(first.statusCode, 401);
    assert.match(
      String(first.headers["www-authenticate"]),
      /resource_metadata="https:\/\/hub\.example\.com\/\.well-known\/oauth-protected-resource\/mcp\/p\/shop"/,
    );
    const prm = (await t.call({ url: "/.well-known/oauth-protected-resource/mcp/p/shop" })).json();
    assert.equal(prm.resource, "https://hub.example.com/mcp/p/shop");
    assert.deepEqual(prm.authorization_servers, ["https://hub.example.com"]);
    const meta = (await t.call({ url: "/.well-known/oauth-authorization-server" })).json();
    assert.equal(meta.registration_endpoint, "https://hub.example.com/oauth/register");
    assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);

    // 2. Dynamic registration; a non-loopback http redirect is refused.
    assert.equal((await t.call({ method: "POST", url: "/oauth/register", payload: { redirect_uris: ["http://evil.example.com/cb"] } })).statusCode, 400);
    const reg = await t.call({ method: "POST", url: "/oauth/register", payload: { client_name: "Claude", redirect_uris: [REDIRECT] } });
    assert.equal(reg.statusCode, 201, reg.body);
    const clientId = reg.json().client_id as string;

    // 3. Authorize: a redirect that was not registered gets an error page, never a redirect.
    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      resource: "https://hub.example.com/mcp/p/shop",
    });
    const bad = await t.call({ url: `/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: "https://evil.example.com/cb" })}` });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.headers.location, undefined);

    // Not signed in: the sign-in form; a wrong password stays on it.
    const signIn = await t.call({ url: `/oauth/authorize?${q}` });
    assert.equal(signIn.statusCode, 200);
    assert.match(signIn.body, /action="\/oauth\/login"/);
    assert.equal((await t.form("/oauth/login", { email: "ada@example.com", password: "nope", next: q.toString() })).statusCode, 401);
    const loggedIn = await t.form("/oauth/login", { email: "ada@example.com", password: "correct-horse-1", next: q.toString() });
    assert.equal(loggedIn.statusCode, 303);
    assert.equal(loggedIn.headers.location, `/oauth/authorize?${q}`);
    const cookie = loggedIn.cookies.find((c) => c.name === HUB_COOKIE)!.value;

    // Consent: the project has no agent yet, so a new one is proposed.
    const consent = await t.call({ url: `/oauth/authorize?${q}`, cookie });
    assert.equal(consent.statusCode, 200);
    assert.match(String(consent.headers["content-security-policy"]), /form-action 'self' https:/, "the redirect to claude.ai is allowed");
    const request = /name="request" value="([^"]+)"/.exec(consent.body)![1];
    // Another person's session cannot use this request.
    const bobCookie = (await t.form("/oauth/login", { email: "bob@example.com", password: "correct-horse-2", next: q.toString() })).cookies.find(
      (c) => c.name === HUB_COOKIE,
    )!.value;
    assert.equal((await t.form("/oauth/authorize", { request, action: "allow", agent: "__new", new_agent: "claude-x" }, bobCookie)).statusCode, 400);
    // Bob is a member, not a manager: he cannot hand an agent's identity to an app.
    assert.equal((await t.call({ url: `/oauth/authorize?${q}`, cookie: bobCookie })).statusCode, 403);

    const allowed = await t.form("/oauth/authorize", { request, action: "allow", agent: "__new", new_agent: "claude-ada" }, cookie);
    assert.equal(allowed.statusCode, 302, allowed.body);
    const back = new URL(String(allowed.headers.location));
    assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
    assert.equal(back.searchParams.get("state"), "xyz");
    assert.equal(t.store.member("shop", "claude-ada")?.role, "trusted");
    const code = back.searchParams.get("code")!;

    // 4. Token: PKCE must match; the code is single use.
    const token = (body: Record<string, string>) => t.form("/oauth/token", body);
    const wrong = await token({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: "x".repeat(43) });
    assert.equal(wrong.json().error, "invalid_grant");
    // That attempt burned the code: start again.
    const consent2 = await t.call({ url: `/oauth/authorize?${q}`, cookie });
    assert.match(consent2.body, /value="claude-ada" checked/, "the agent made last time is offered");
    const request2 = /name="request" value="([^"]+)"/.exec(consent2.body)![1];
    const code2 = new URL(
      String((await t.form("/oauth/authorize", { request: request2, action: "allow", agent: "claude-ada" }, cookie)).headers.location),
    ).searchParams.get("code")!;
    const issued = await token({ grant_type: "authorization_code", code: code2, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    assert.equal(issued.statusCode, 200, issued.body);
    const { access_token, refresh_token } = issued.json() as { access_token: string; refresh_token: string };
    assert.equal((await token({ grant_type: "authorization_code", code: code2, client_id: clientId, code_verifier: verifier })).json().error, "invalid_grant");

    // 5. MCP with the token: the agent, plus the person for approvals; only in its own project.
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${(t.app.server.address() as { port: number }).port}`;
    const connect = async (tok: string, project = "shop") => {
      const c = new Client({ name: "claude-ai", version: "1" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp/p/${project}`), { requestInit: { headers: { authorization: `Bearer ${tok}` } } }));
      clients.push(c);
      return c;
    };
    const claude = await connect(access_token);
    const brief = (await claude.callTool({ name: "cortex_brief", arguments: {} })) as { content: { text: string }[] };
    assert.equal(JSON.parse(brief.content[0].text).you.id, "claude-ada");
    const names = (await claude.listTools()).tools.map((x) => x.name);
    assert.ok(names.includes("cortex_ask_human"), "approvals are offered: the person consented");
    await assert.rejects(() => connect(access_token, "blog"), /only works in .{0,2}shop/);
    assert.equal((await t.call({ url: "/api/p/blog/tree", headers: { authorization: `Bearer ${access_token}` } })).statusCode, 403);
    assert.equal((await t.call({ url: "/api/p/shop/tree", headers: { authorization: `Bearer ${access_token}` } })).statusCode, 200);

    // 6. Refresh rotates both tokens; the person sees the connection and can end it.
    const refreshed = await token({ grant_type: "refresh_token", refresh_token, client_id: clientId });
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    assert.equal(
      (await token({ grant_type: "refresh_token", refresh_token, client_id: clientId })).json().error,
      "invalid_grant",
      "the old refresh token is spent",
    );
    const fresh = refreshed.json().access_token as string;
    assert.equal((await t.call({ method: "POST", url: "/mcp/p/shop", headers: { authorization: `Bearer ${access_token}` }, payload: {} })).statusCode, 401);
    const conns = (await t.call({ url: "/api/hub/connections", cookie })).json().connections as { id: string; client: string; agent_id: string }[];
    assert.equal(conns.length, 1);
    assert.equal(conns[0].client, "Claude");
    assert.equal(conns[0].agent_id, "claude-ada");
    assert.equal((await t.call({ method: "DELETE", url: `/api/hub/connections/${conns[0].id}`, cookie, headers: { "x-cortex-csrf": "1" } })).statusCode, 200);
    const gone = await t.call({ method: "POST", url: "/mcp/p/shop", headers: { authorization: `Bearer ${fresh}` }, payload: {} });
    assert.equal(gone.statusCode, 401);
    assert.match(String(gone.headers["www-authenticate"]), /resource_metadata=/);
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    await t.cleanup();
  }
});

test("oauth: deny sends the person back with access_denied", async () => {
  const t = await setup();
  try {
    const clientId = (await t.call({ method: "POST", url: "/oauth/register", payload: { redirect_uris: [REDIRECT] } })).json().client_id as string;
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      state: "s1",
    });
    const cookie = (await t.form("/oauth/login", { email: "ada@example.com", password: "correct-horse-1", next: q.toString() })).cookies.find(
      (c) => c.name === HUB_COOKIE,
    )!.value;
    // No resource: the person picks the project first.
    const pick = await t.call({ url: `/oauth/authorize?${q}`, cookie });
    assert.match(pick.body, /name="project"/);
    const consent = await t.call({ url: `/oauth/authorize?${q}&project=shop`, cookie });
    const request = /name="request" value="([^"]+)"/.exec(consent.body)![1];
    const r = await t.form("/oauth/authorize", { request, action: "deny" }, cookie);
    const back = new URL(String(r.headers.location));
    assert.equal(back.searchParams.get("error"), "access_denied");
    assert.equal(back.searchParams.get("state"), "s1");
    assert.equal(t.store.oauthConnections(t.admin.id).length, 0);
  } finally {
    await t.cleanup();
  }
});

// The MCP SDK's own OAuth client, the flow claude.ai and Claude Code follow: 401 → discovery → registration →
// the person's browser (here: inject with their session) → code → token → connected.
test("oauth: the MCP SDK client connects with only the URL", async () => {
  const t = await setup();
  const clients: Client[] = [];
  try {
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${(t.app.server.address() as { port: number }).port}`;
    t.store.settings.public_url = url; // discovery documents point at public_url
    const cookie = (await t.form("/oauth/login", { email: "ada@example.com", password: "correct-horse-1", next: "" })).cookies.find(
      (c) => c.name === HUB_COOKIE,
    )!.value;

    let info: OAuthClientInformationFull | undefined;
    let tokens: OAuthTokens | undefined;
    let verifier = "";
    let authorizeAt: URL | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: "http://localhost:9/callback",
      clientMetadata: { client_name: "SDK test", redirect_uris: ["http://localhost:9/callback"], token_endpoint_auth_method: "none" },
      clientInformation: () => info,
      saveClientInformation: (i) => void (info = i),
      tokens: () => tokens,
      saveTokens: (x) => void (tokens = x),
      redirectToAuthorization: (u) => void (authorizeAt = u),
      saveCodeVerifier: (v) => void (verifier = v),
      codeVerifier: () => verifier,
    };
    const transport = () => new StreamableHTTPClientTransport(new URL(`${url}/mcp/p/shop`), { authProvider: provider });

    const first = transport();
    await assert.rejects(() => new Client({ name: "sdk", version: "1" }).connect(first), /Unauthorized/);
    assert.ok(authorizeAt, "the SDK found the authorization server and registered");
    assert.equal(authorizeAt.searchParams.get("resource"), `${url}/mcp/p/shop`);

    const consent = await t.call({ url: `${authorizeAt.pathname}${authorizeAt.search}`, cookie });
    const request = /name="request" value="([^"]+)"/.exec(consent.body)![1];
    const allowed = await t.form("/oauth/authorize", { request, action: "allow", agent: "__new", new_agent: "claude-sdk" }, cookie);
    await first.finishAuth(new URL(String(allowed.headers.location)).searchParams.get("code")!);

    const client = new Client({ name: "sdk", version: "1" });
    await client.connect(transport());
    clients.push(client);
    const brief = (await client.callTool({ name: "cortex_brief", arguments: {} })) as { content: { text: string }[] };
    assert.equal(JSON.parse(brief.content[0].text).you.id, "claude-sdk");
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    await t.cleanup();
  }
});
