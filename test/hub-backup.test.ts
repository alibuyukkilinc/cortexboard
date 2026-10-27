import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configureBackup, listBackups, open, restoreBackup, runBackup, tar, untar } from "../src/hub/backup.js";
import { hashPassword } from "../src/hub/crypto.js";
import { registerProject } from "../src/hub/knowledge.js";
import { Hub, HUB_COOKIE, buildHubServer } from "../src/hub/server.js";
import { HubStore } from "../src/hub/store.js";

// A stand-in for BunnyCDN Storage: PUT stores, GET on the folder lists (JSON), GET on a file reads, DELETE removes.
async function fakeBunny() {
  const files = new Map<string, { body: Buffer; checksum?: string; at: string }>();
  const seenKeys: string[] = [];
  const server = createServer((req, res) => {
    seenKeys.push(String(req.headers.accesskey ?? ""));
    if (req.headers.accesskey !== "zone-password") return void res.writeHead(401).end("Unauthorized");
    const url = decodeURIComponent(req.url ?? "");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "PUT") {
        files.set(url, { body: Buffer.concat(chunks), checksum: req.headers.checksum as string | undefined, at: new Date().toISOString() });
        return void res.writeHead(201).end();
      }
      if (req.method === "DELETE") return void res.writeHead(files.delete(url) ? 200 : 404).end();
      if (url.endsWith("/")) {
        const rows = [...files.entries()]
          .filter(([k]) => k.startsWith(url))
          .map(([k, v]) => ({ ObjectName: k.slice(url.length), Length: v.body.length, LastChanged: v.at, IsDirectory: false }));
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows));
      }
      const f = files.get(url);
      return f ? void res.writeHead(200).end(f.body) : void res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { files, seenKeys, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(r)) };
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "cortex-backup-"));
  const store = HubStore.init(join(root, "hub"), { org: "Acme", host: "127.0.0.1", port: 4747 });
  const admin = store.createUser({ email: "ada@example.com", name: "Ada", org_admin: true });
  store.setPassword(admin.id, await hashPassword("correct-horse-1"));
  mkdirSync(join(root, "app"));
  await registerProject(store, { path: join(root, "app"), init: true, language: "en" });
  const bunny = await fakeBunny();
  return { root, store, admin, bunny, cleanup: async () => (store.close(), await bunny.close(), rmSync(root, { recursive: true, force: true })) };
}

test("backup: the passphrase is shown once, the archive leaves encrypted, old ones are pruned", async () => {
  const t = await setup();
  try {
    const first = configureBackup(t.store, { storage_zone: "zone", endpoint: t.bunny.url, access_key: "zone-password", keep: 2 });
    assert.ok(first.passphrase && first.passphrase.length >= 24);
    assert.equal(configureBackup(t.store, { keep: 2 }).passphrase, undefined, "never shown again");
    assert.match(readFileSync(join(t.store.dir, "hub.yaml"), "utf8"), /^# Cortex hub settings/, "hub.yaml keeps its comments");
    assert.doesNotMatch(readFileSync(join(t.store.dir, "hub.yaml"), "utf8"), /zone-password/, "the key is not in hub.yaml");

    const r = await runBackup(t.store);
    assert.equal(r.status, "ok", r.message);
    const [path, stored] = [...t.bunny.files.entries()][0]!;
    assert.match(path, /^\/zone\/cortex-hub\/cortex-hub-.*\.cxbk$/);
    assert.equal(stored.checksum, createHash("sha256").update(stored.body).digest("hex").toUpperCase());
    assert.ok(!stored.body.includes(Buffer.from("ustar")) && !stored.body.includes(Buffer.from("Ada")), "nothing readable leaves the machine");

    for (let i = 0; i < 2; i++) {
      await new Promise((r) => setTimeout(r, 5));
      assert.equal((await runBackup(t.store)).status, "ok");
    }
    assert.equal((await listBackups(t.store)).length, 2, "keep: 2");

    // A wrong key fails loudly, and says so.
    configureBackup(t.store, { access_key: "wrong" });
    const failed = await runBackup(t.store);
    assert.equal(failed.status, "failed");
    assert.match(failed.message, /401/);
  } finally {
    await t.cleanup();
  }
});

test("backup: restore brings back the hub and the projects' knowledge, without secrets or indexes", async () => {
  const t = await setup();
  try {
    const { passphrase } = configureBackup(t.store, { storage_zone: "zone", endpoint: t.bunny.url, access_key: "zone-password" });
    writeFileSync(join(t.store.dir, "projects", "app", ".secrets.yaml"), "tokens: {}\n");
    mkdirSync(join(t.store.dir, "projects", "app", ".index"), { recursive: true });
    writeFileSync(join(t.store.dir, "projects", "app", ".index", "x.db"), "cache");
    assert.equal((await runBackup(t.store)).status, "ok");
    const [name] = (await listBackups(t.store)).map((b) => b.name);

    const to = join(t.root, "restored");
    const r = await restoreBackup(t.store, name!, to);
    assert.ok(r.files > 5);
    const db = new DatabaseSync(join(to, "hub", "hub.db"), { readOnly: true });
    assert.equal((db.prepare("SELECT name FROM users").get() as { name: string }).name, "Ada");
    db.close();
    assert.ok(existsSync(join(to, "hub", "projects", "app", "cortex.config.yaml")));
    assert.ok(existsSync(join(to, "hub", "projects", "app", ".git")), "knowledge history comes along");
    const archived = untar(open([...t.bunny.files.values()][0]!.body, passphrase!)).map((e) => e.name);
    assert.ok(!archived.some((n) => n.includes("backup.secrets")), "the storage key is never in the archive");
    // The restored hub keeps the key that opened it, so its next backups use the same one.
    assert.match(readFileSync(join(to, "hub", "backup.secrets.yaml"), "utf8"), new RegExp(`passphrase: ${passphrase}`));
    assert.ok(!existsSync(join(to, "hub", "projects", "app", ".index")), "indexes are rebuilt, not backed up");
    assert.ok(!existsSync(join(to, "hub", "projects", "app", ".secrets.yaml")), "machine-local tokens stay out");

    // From a downloaded file on another machine, with the passphrase written down at setup.
    const file = join(t.root, "copy.cxbk");
    writeFileSync(file, [...t.bunny.files.values()][0]!.body);
    await assert.rejects(restoreBackup(null, file, join(t.root, "r2"), "not-it"), /passphrase does not open/);
    assert.ok((await restoreBackup(null, file, join(t.root, "r3"), passphrase)).files > 5);
    await assert.rejects(restoreBackup(null, file, to, passphrase), /not empty/);
  } finally {
    await t.cleanup();
  }
});

test("backup: the tar format round-trips long paths and binary data", () => {
  const long = `projects/app/items/${"x".repeat(60)}/replies/${"y".repeat(60)}.md`;
  const entries = [
    { name: long, data: Buffer.from("hello"), mtime: 1_700_000_000_000 },
    { name: "hub/hub.db", data: Buffer.from([0, 1, 2, 255]), mtime: 1_700_000_000_000 },
  ];
  const back = untar(tar(entries));
  assert.deepEqual(
    back.map((e) => [e.name, e.data.toString("hex")]),
    entries.map((e) => [e.name, e.data.toString("hex")]),
  );
  assert.throws(() => open(Buffer.from("nope"), "x"), /Not a Cortex backup/);
});

test("backup over the board: org admins only, and the storage key never comes back out", async () => {
  const t = await setup();
  const hub = new Hub(t.store);
  const app = buildHubServer(hub);
  try {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ada@example.com", password: "correct-horse-1" } });
    const cookie = login.cookies.find((c) => c.name === HUB_COOKIE)!.value;
    const call = (method: "GET" | "PUT" | "POST", url: string, payload?: object) =>
      app.inject({ method, url, payload, headers: { cookie: `${HUB_COOKIE}=${cookie}`, "x-cortex-csrf": "1" } });
    const put = await call("PUT", "/api/admin/backup", { storage_zone: "zone", endpoint: t.bunny.url, access_key: "zone-password" });
    assert.equal(put.statusCode, 200, put.body);
    assert.ok(put.json().passphrase);
    const got = (await call("GET", "/api/admin/backup")).json();
    assert.equal(got.has_access_key, true);
    assert.doesNotMatch(JSON.stringify(got), /zone-password/);
    const run = (await call("POST", "/api/admin/backup/run")).json();
    assert.equal(run.result.status, "ok", run.result.message);
    assert.equal((await call("GET", "/api/admin/backup")).json().last.status, "ok");
    assert.equal((await call("GET", "/api/admin/backup/list")).json().backups.length, 1);
    assert.equal((await app.inject({ method: "GET", url: "/api/admin/backup" })).statusCode, 401);
  } finally {
    await app.close();
    await t.cleanup();
  }
});
