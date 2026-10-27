import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/api/server.js";
import { HubStore, settingsFromEnv } from "../src/hub/store.js";
import { Hub, buildHubServer } from "../src/hub/server.js";
import { tempProject } from "./helpers.js";

// Security scan (task 01M3NR0PMHXV0X2PRCHNJAQWV8): every response carries the headers that keep the board from
// being framed or sniffed, and scripts come from this origin only.
test("security headers on pages and API alike, no HSTS over plain http", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  try {
    for (const url of ["/", "/api/health", "/nope.js"]) {
      const r = await app.inject({ url, headers: { host: "localhost" } });
      assert.equal(r.headers["x-frame-options"], "DENY", url);
      assert.equal(r.headers["x-content-type-options"], "nosniff", url);
      assert.equal(r.headers["referrer-policy"], "no-referrer", url);
      const csp = String(r.headers["content-security-policy"]);
      assert.match(csp, /frame-ancestors 'none'/, url);
      assert.match(csp, /script-src 'self'(;|$)/, "no inline scripts");
      assert.equal(r.headers["strict-transport-security"], undefined, "plain http: no HSTS");
    }
  } finally {
    await app.close();
    t.cleanup();
  }
});

test("hub address and proxy settings from the environment win over hub.yaml, and are never written to it", () => {
  assert.deepEqual(
    settingsFromEnv({ CORTEX_PUBLIC_URL: "https://mcp.example.com/", CORTEX_TRUST_PROXY: "1", CORTEX_ALLOWED_HOSTS: "MCP.example.com, localhost" }),
    {
      public_url: "https://mcp.example.com",
      trust_proxy: true,
      allowed_hosts: ["mcp.example.com", "localhost"],
    },
  );
  assert.deepEqual(settingsFromEnv({}), {});
  assert.equal(settingsFromEnv({ CORTEX_TRUST_PROXY: "no" }).trust_proxy, false);

  const root = mkdtempSync(join(tmpdir(), "cortex-env-"));
  const before = process.env.CORTEX_PUBLIC_URL;
  try {
    HubStore.init(join(root, "hub"), { org: "Acme", host: "127.0.0.1", port: 4747, public_url: "https://old.example.com" }).close();
    process.env.CORTEX_PUBLIC_URL = "https://tunnel.example.com";
    const store = new HubStore(join(root, "hub"));
    assert.equal(store.settings.public_url, "https://tunnel.example.com");
    store.saveSettings({ commit_seconds: 30 });
    store.close();
    delete process.env.CORTEX_PUBLIC_URL;
    const again = new HubStore(join(root, "hub"));
    assert.equal(again.settings.public_url, "https://old.example.com", "the environment value never reached hub.yaml");
    again.close();
  } finally {
    if (before === undefined) delete process.env.CORTEX_PUBLIC_URL;
    else process.env.CORTEX_PUBLIC_URL = before;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hub behind an https proxy sends HSTS, and its host allowlist ignores case", async () => {
  const root = mkdtempSync(join(tmpdir(), "cortex-hsts-"));
  const store = HubStore.init(join(root, "hub"), { org: "Acme", host: "127.0.0.1", port: 4747, trust_proxy: true, allowed_hosts: ["mcp.example.com"] });
  const app = buildHubServer(new Hub(store));
  try {
    const r = await app.inject({ url: "/api/health", headers: { host: "MCP.Example.com", "x-forwarded-proto": "https" } });
    assert.equal(r.statusCode, 200);
    assert.match(String(r.headers["strict-transport-security"]), /max-age=\d+/);
    assert.equal((await app.inject({ url: "/api/health", headers: { host: "evil.example.com" } })).statusCode, 403);
  } finally {
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
