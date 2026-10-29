import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { hashPassword } from "../src/hub/crypto.js";
import { Hub, HUB_COOKIE, buildHubServer } from "../src/hub/server.js";
import { HubStore } from "../src/hub/store.js";

// Email through Resend (src/hub/mail.ts): admin settings, the test message and "forgot password".

type Sent = { url: string; auth: string; body: { from: string; to: string[]; subject: string; text: string; html?: string } };

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "cortex-hub-mail-"));
  const store = HubStore.init(join(root, "hub"), { org: "Acme", host: "127.0.0.1", port: 4747, public_url: "https://cortex.example.com" });
  const admin = store.createUser({ email: "ada@example.com", name: "Ada", org_admin: true });
  store.setPassword(admin.id, await hashPassword("correct-horse-1"));
  const hub = new Hub(store);
  const sent: Sent[] = [];
  let status = 200;
  hub.mailFetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, auth: (init.headers as Record<string, string>).Authorization, body: JSON.parse(init.body as string) });
    return new Response(status === 200 ? '{"id":"e1"}' : '{"name":"validation_error","message":"domain not verified"}', { status });
  }) as typeof fetch;
  const app = buildHubServer(hub);
  const call = (o: InjectOptions & { cookie?: string }) =>
    app.inject({ ...o, headers: { ...(o.headers ?? {}), ...(o.cookie ? { cookie: `${HUB_COOKIE}=${o.cookie}`, "x-cortex-csrf": "1" } : {}) } });
  const login = async (email: string, password: string) =>
    (await call({ method: "POST", url: "/api/auth/login", payload: { email, password } })).cookies.find((c) => c.name === HUB_COOKIE)?.value;
  const cleanup = async () => {
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, store, hub, call, login, sent, fail: (s: number) => (status = s), cleanup };
}

const KEY = "re_test_1234567890abcd";

test("hub mail: admins set Resend up, the key never comes back, a test email reaches them", async () => {
  const t = await setup();
  try {
    const cookie = (await t.login("ada@example.com", "correct-horse-1"))!;
    assert.equal((await t.call({ url: "/api/health" })).json().mail, false);
    assert.equal((await t.call({ url: "/api/admin/mail" })).statusCode, 401);

    const bad = await t.call({ method: "PUT", url: "/api/admin/mail", cookie, payload: { provider: "resend", from: "not an address", api_key: KEY } });
    assert.equal(bad.statusCode, 400);
    assert.equal(
      (await t.call({ method: "PUT", url: "/api/admin/mail", cookie, payload: { provider: "resend", from: "a@b.co" } })).statusCode,
      400,
      "no key yet",
    );

    const saved = await t.call({
      method: "PUT",
      url: "/api/admin/mail",
      cookie,
      payload: { provider: "resend", from: "Cortex <no-reply@example.com>", api_key: KEY },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json(), { provider: "resend", from: "Cortex <no-reply@example.com>", key_last4: "abcd", key_from_env: false, ready: true });
    assert.doesNotMatch(JSON.stringify((await t.call({ url: "/api/admin/mail", cookie })).json()), /re_test/);
    assert.doesNotMatch(readFileSync(join(t.store.dir, "hub.yaml"), "utf8"), /re_test/, "the key stays out of hub.yaml");
    if (process.platform !== "win32") assert.equal(statSync(join(t.store.dir, "mail.secrets.yaml")).mode & 0o777, 0o600);
    assert.equal((await t.call({ url: "/api/health" })).json().mail, true);

    // Changing the sender keeps the key.
    await t.call({ method: "PUT", url: "/api/admin/mail", cookie, payload: { provider: "resend", from: "ops@example.com" } });
    const r = await t.call({ method: "POST", url: "/api/admin/mail/test", cookie });
    assert.equal(r.json().to, "ada@example.com");
    assert.equal(t.sent[0].url, "https://api.resend.com/emails");
    assert.equal(t.sent[0].auth, `Bearer ${KEY}`);
    assert.deepEqual(t.sent[0].body.to, ["ada@example.com"]);
    assert.equal(t.sent[0].body.from, "ops@example.com");

    // Resend's refusal reaches the admin, without the key.
    t.fail(422);
    const failed = await t.call({ method: "POST", url: "/api/admin/mail/test", cookie });
    assert.equal(failed.statusCode, 502);
    assert.match(failed.json().error.message, /domain not verified/);
    assert.doesNotMatch(failed.body, /re_test/);

    await t.call({ method: "PUT", url: "/api/admin/mail", cookie, payload: { provider: "off" } });
    assert.deepEqual((await t.call({ url: "/api/admin/mail", cookie })).json().key_last4, null);
    assert.equal((await t.call({ url: "/api/health" })).json().mail, false);
  } finally {
    await t.cleanup();
  }
});

test("hub mail: forgot password emails a one-hour link, says the same for unknown addresses, and is braked", async () => {
  const t = await setup();
  try {
    assert.equal((await t.call({ method: "POST", url: "/api/auth/forgot", payload: { email: "ada@example.com" } })).statusCode, 409, "email off");
    const cookie = (await t.login("ada@example.com", "correct-horse-1"))!;
    await t.call({ method: "PUT", url: "/api/admin/mail", cookie, payload: { provider: "resend", from: "Cortex <no-reply@example.com>", api_key: KEY } });

    const unknown = await t.call({ method: "POST", url: "/api/auth/forgot", payload: { email: "nobody@example.com" } });
    assert.equal(unknown.statusCode, 200);
    await t.hub.mailing;
    assert.equal(t.sent.length, 0, "nothing goes to an address without an account");

    const r = await t.call({ method: "POST", url: "/api/auth/forgot", payload: { email: "ADA@example.com" } });
    assert.deepEqual(r.json(), unknown.json(), "same answer either way");
    await t.hub.mailing;
    assert.equal(t.sent.length, 1);
    const link = /https:\/\/cortex\.example\.com\/invite\/(inv_[\w-]+)/.exec(t.sent[0].body.text)?.[1];
    assert.ok(link, t.sent[0].body.text);
    assert.ok(t.sent[0].body.html?.includes(link));

    const expires = (t.store.db.prepare("SELECT expires_at FROM invites WHERE user_id = ?").get("ada") as { expires_at: string }).expires_at;
    const minutes = (Date.parse(expires) - Date.now()) / 60_000;
    assert.ok(minutes > 55 && minutes <= 60, `valid one hour, got ${minutes}`);

    // The link sets a new password once; the old one stops working.
    assert.equal((await t.call({ method: "POST", url: `/api/auth/invite/${link}`, payload: { password: "a-brand-new-pw" } })).statusCode, 200);
    assert.equal(await t.login("ada@example.com", "correct-horse-1"), undefined);
    assert.ok(await t.login("ada@example.com", "a-brand-new-pw"));
    assert.equal((await t.call({ url: `/api/auth/invite/${link}` })).statusCode, 404);

    // Three per address in 15 minutes: one was sent above.
    await t.call({ method: "POST", url: "/api/auth/forgot", payload: { email: "ada@example.com" } });
    await t.call({ method: "POST", url: "/api/auth/forgot", payload: { email: "ada@example.com" } });
    assert.equal((await t.call({ method: "POST", url: "/api/auth/forgot", payload: { email: "ada@example.com" } })).statusCode, 429);
  } finally {
    await t.cleanup();
  }
});
