import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import YAML from "yaml";
import { open, untar } from "../src/backup/archive.js";
import { BackupRunner, backupStatus, configureBackup, googleConnectPoll, googleConnectStart, listBackups, runBackup } from "../src/backup/core.js";
import { projectTarget, restoreProject } from "../src/backup/project.js";
import { buildServer } from "../src/api/server.js";
import { applyPendingRestore, hubTarget, pendingRestore } from "../src/hub/backup.js";
import { hashPassword } from "../src/hub/crypto.js";
import { registerProject } from "../src/hub/knowledge.js";
import { Hub, HUB_COOKIE, buildHubServer } from "../src/hub/server.js";
import { HubStore } from "../src/hub/store.js";
import { tempProject } from "./helpers.js";

// Second round of the backup task (01M3NQYNRX7X7Z3660KFA2WHZQ): the person's own passphrase, Google Drive,
// restore and download from the board, a project's code folder, and backups of a project with no hub.

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(r)) };
}

const body = (req: IncomingMessage) =>
  new Promise<Buffer>((r) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => r(Buffer.concat(chunks)));
  });

async function fakeBunny() {
  const files = new Map<string, { body: Buffer; at: string }>();
  const server = createServer((req, res) => void handle(req, res));
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.accesskey !== "zone-password") return void res.writeHead(401).end("Unauthorized");
    const url = decodeURIComponent(req.url ?? "");
    const data = await body(req);
    if (req.method === "PUT") return void (files.set(url, { body: data, at: new Date().toISOString() }), res.writeHead(201).end());
    if (req.method === "DELETE") return void res.writeHead(files.delete(url) ? 200 : 404).end();
    if (url.endsWith("/")) {
      const rows = [...files.entries()]
        .filter(([k]) => k.startsWith(url) && !k.slice(url.length).includes("/"))
        .map(([k, v]) => ({ ObjectName: k.slice(url.length), Length: v.body.length, LastChanged: v.at, IsDirectory: false }));
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows));
    }
    const f = files.get(url);
    return f ? void res.writeHead(200).end(f.body) : void res.writeHead(404).end();
  }
  return { files, ...(await listen(server)) };
}

// OAuth device flow + the parts of the Drive API the provider uses.
async function fakeGoogle() {
  const files = new Map<string, { id: string; name: string; parents: string[]; mimeType?: string; body: Buffer; createdTime: string }>();
  const sessions = new Map<string, { name: string; parents: string[] }>();
  let n = 0;
  let polls = 0;
  const server = createServer((req, res) => void handle(req, res));
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const s = /^\/upload-session\/(.+)$/.exec(req.url ?? "");
    if (s) {
      // Upload sessions carry no bearer token (the address is the credential), as on Google.
      const meta = sessions.get(s[1]!);
      const data = await body(req);
      if (!meta) return void res.writeHead(404).end();
      const id = `f${++n}`;
      files.set(id, { id, ...meta, body: data, createdTime: new Date(Date.now() + n).toISOString() });
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id }));
    }
    const url = new URL(req.url ?? "/", "http://x");
    const data = await body(req);
    const json = (code: number, o: unknown) => void res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(o));
    if (url.pathname === "/device/code") {
      const f = new URLSearchParams(data.toString());
      if (f.get("scope") !== "https://www.googleapis.com/auth/drive.file") return json(400, { error: "invalid_scope" });
      return json(200, { device_code: "dev-1", user_code: "ABCD-EFGH", verification_url: "https://www.google.com/device", expires_in: 600, interval: 1 });
    }
    if (url.pathname === "/token") {
      const f = new URLSearchParams(data.toString());
      if (f.get("client_secret") !== "client-secret") return json(401, { error: "invalid_client" });
      if (f.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code")
        return ++polls < 2 ? json(428, { error: "authorization_pending" }) : json(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
      if (f.get("grant_type") === "refresh_token" && f.get("refresh_token") === "rt-1") return json(200, { access_token: "at-2", expires_in: 3600 });
      return json(400, { error: "invalid_grant" });
    }
    if (!/^Bearer at-[12]$/.test(req.headers.authorization ?? "")) return json(401, { error: "unauthenticated" });
    if (url.pathname === "/drive/v3/files" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const byName = /name = '([^']+)' and mimeType = 'application\/vnd.google-apps.folder'/.exec(q);
      const inParent = /'([^']+)' in parents/.exec(q);
      const rows = [...files.values()].filter((f) =>
        byName ? f.name === byName[1] && f.mimeType === "application/vnd.google-apps.folder" : inParent ? f.parents.includes(inParent[1]!) : false,
      );
      return json(200, { files: rows.map((f) => ({ id: f.id, name: f.name, size: String(f.body.length), createdTime: f.createdTime })) });
    }
    if (url.pathname === "/drive/v3/files" && req.method === "POST") {
      const meta = JSON.parse(data.toString()) as { name: string; mimeType: string };
      const id = `f${++n}`;
      files.set(id, { id, name: meta.name, parents: [], mimeType: meta.mimeType, body: Buffer.alloc(0), createdTime: new Date().toISOString() });
      return json(200, { id });
    }
    if (url.pathname === "/upload/drive/v3/files" && url.searchParams.get("uploadType") === "resumable") {
      const meta = JSON.parse(data.toString()) as { name: string; parents: string[] };
      const s = `s${++n}`;
      sessions.set(s, meta);
      return void res.writeHead(200, { location: `${g.url}/upload-session/${s}` }).end();
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (m && req.method === "GET") {
      const f = files.get(m[1]!);
      return f ? void res.writeHead(200).end(f.body) : json(404, {});
    }
    if (m && req.method === "DELETE") return void res.writeHead(files.delete(m[1]!) ? 204 : 404).end();
    return json(404, { error: "no route" });
  }
  const g = await listen(server);
  return { files, ...g };
}

async function hubSetup() {
  const root = mkdtempSync(join(tmpdir(), "cortex-backup2-"));
  const store = HubStore.init(join(root, "hub"), { org: "Acme", host: "127.0.0.1", port: 4747 });
  const admin = store.createUser({ email: "ada@example.com", name: "Ada", org_admin: true });
  store.setPassword(admin.id, await hashPassword("correct-horse-1"));
  mkdirSync(join(root, "app"));
  await registerProject(store, { path: join(root, "app"), init: true, language: "en" });
  const bunny = await fakeBunny();
  const cleanup = async () => {
    try {
      store.close();
    } catch {
      // closed by the test (a restore is applied with the hub stopped)
    }
    await bunny.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, store, admin, bunny, cleanup };
}

async function signIn(hub: Hub) {
  const app = buildHubServer(hub);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ada@example.com", password: "correct-horse-1" } });
  const cookie = login.cookies.find((c) => c.name === HUB_COOKIE)!.value;
  const call = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { cookie: `${HUB_COOKIE}=${cookie}`, "x-cortex-csrf": "1" } });
  return { app, call };
}

test("backup key: the person's own passphrase, kept across saves, changeable, never shown back", async () => {
  const t = await hubSetup();
  try {
    const target = hubTarget(t.store);
    assert.throws(
      () => configureBackup(target, { storage_zone: "zone", endpoint: t.bunny.url, access_key: "zone-password", passphrase: "short" }),
      /at least 12/,
    );
    const first = configureBackup(target, { storage_zone: "zone", endpoint: t.bunny.url, access_key: "zone-password", passphrase: "my own long key 1" });
    assert.equal(first.passphrase, undefined, "a typed key is not echoed back");
    assert.equal(configureBackup(target, { keep: 3 }).passphrase, undefined, "no new key on the next save");
    assert.match(readFileSync(target.secretsFile, "utf8"), /my own long key 1/);

    const backed = await runBackup(target);
    assert.equal(backed.status, "ok", backed.message);
    const [stored] = [...t.bunny.files.values()];
    assert.ok(untar(open(stored!.body, "my own long key 1")).some((e) => e.name === "hub/hub.db"));

    const changed = configureBackup(target, { passphrase: "a different key 2" });
    assert.equal(changed.passphrase_changed, true);
    assert.throws(() => open(stored!.body, "a different key 2"), /does not open/, "old archives keep the old key");

    // The first version's settings (no provider written) still read as Bunny.
    t.store.saveSettings({ backup: { storage_zone: "zone", region: "", path: "cortex-hub", endpoint: t.bunny.url } });
    assert.equal(backupStatus(target).provider, "bunny");
    assert.equal(backupStatus(target).ready, true);
  } finally {
    await t.cleanup();
  }
});

test("backup to Google Drive: device sign-in, a folder of its own, upload, list, prune, download", async () => {
  const t = await hubSetup();
  const g = await fakeGoogle();
  try {
    const target = hubTarget(t.store);
    configureBackup(target, {
      provider: "gdrive",
      endpoint: g.url,
      google_client_id: "client-id",
      google_client_secret: "client-secret",
      path: "Cortex backups",
      keep: 2,
      passphrase: "drive passphrase 123",
    });
    assert.equal(backupStatus(target).ready, false, "not signed in yet");
    assert.equal((await runBackup(target)).status, "failed");

    const start = await googleConnectStart(target);
    assert.equal(start.user_code, "ABCD-EFGH");
    assert.equal((await googleConnectPoll(target)).status, "pending");
    const done = await googleConnectPoll(target);
    assert.equal(done.status, "connected", done.message);
    assert.equal(backupStatus(target).google.connected, true);
    const folderId = t.store.settings.backup?.folder_id;
    assert.ok(folderId, "the folder is found or made when connecting");
    assert.equal(g.files.get(folderId!)?.name, "Cortex backups");
    assert.doesNotMatch(readFileSync(join(t.store.dir, "hub.yaml"), "utf8"), /rt-1|client-secret/, "Google keys stay in the secrets file");

    for (let i = 0; i < 3; i++) {
      const r = await runBackup(target);
      assert.equal(r.status, "ok", r.message);
      await new Promise((r) => setTimeout(r, 5));
    }
    const list = await listBackups(target);
    assert.equal(list.length, 2, "keep: 2");
    assert.ok(list.every((b) => b.name.startsWith("cortex-hub-")));
    const archive = [...g.files.values()].find((f) => f.name === list[0]!.name)!;
    assert.ok(untar(open(archive.body, "drive passphrase 123")).some((e) => e.name === "hub/hub.yaml"));

    // A new machine with the same Google sign-in finds the same folder by name.
    t.store.saveSettings({ backup: { ...t.store.settings.backup!, folder_id: undefined } });
    assert.equal((await listBackups(target)).length, 2);
    assert.equal(t.store.settings.backup?.folder_id, folderId);
  } finally {
    await g.close();
    await t.cleanup();
  }
});

test("restore from the board: staged, applied at the next start, the old hub kept aside, this machine's settings kept", async () => {
  const t = await hubSetup();
  const hub = new Hub(t.store);
  const { app, call } = await signIn(hub);
  const dir = t.store.dir;
  try {
    const put = await call("PUT", "/api/admin/backup", {
      storage_zone: "zone",
      endpoint: t.bunny.url,
      access_key: "zone-password",
      passphrase: "restore test key 1",
    });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal((await call("POST", "/api/admin/backup/run")).json().result.status, "ok");
    const [name] = (await call("GET", "/api/admin/backup/list")).json().backups.map((b: { name: string }) => b.name);

    // Download: the sealed file as stored; a made-up name is refused.
    const dl = await call("GET", `/api/admin/backup/download/${name}`);
    assert.equal(dl.statusCode, 200);
    assert.match(String(dl.headers["content-disposition"]), new RegExp(name));
    assert.equal(dl.rawPayload.subarray(0, 5).toString(), "CXBK1");
    assert.equal((await call("GET", "/api/admin/backup/download/..%2Fhub.yaml")).statusCode, 400);

    // Changes after the backup: a new person, another port on this machine.
    t.store.createUser({ email: "bob@example.com", name: "Bob" });
    t.store.saveSettings({ port: 5555 });

    assert.equal((await call("POST", "/api/admin/backup/restore", { name, passphrase: "wrong wrong wrong" })).statusCode, 400);
    const staged = await call("POST", "/api/admin/backup/restore", { name });
    assert.equal(staged.statusCode, 200, staged.body);
    assert.equal(staged.json().staged.name, name);
    assert.deepEqual(
      staged.json().staged.projects.map((p: { id: string }) => p.id),
      ["app"],
    );
    const status = (await call("GET", "/api/admin/backup")).json();
    assert.equal(status.pending_restore.name, name);
    assert.doesNotMatch(JSON.stringify(status), /restore test key/);
    assert.equal((await call("POST", "/api/admin/restart")).statusCode, 409, "no restarter outside `hub start`");

    // Cancel, then stage again.
    assert.equal((await call("DELETE", "/api/admin/backup/restore")).statusCode, 200);
    assert.equal(pendingRestore(dir), null);
    assert.equal((await call("POST", "/api/admin/backup/restore", { name })).statusCode, 200);

    await app.close();
    t.store.close();
    const r = applyPendingRestore(dir)!;
    assert.equal(r.name, name);
    assert.ok(existsSync(r.aside));
    const db = new DatabaseSync(join(dir, "hub.db"), { readOnly: true });
    const names = (db.prepare("SELECT name FROM users ORDER BY name").all() as { name: string }[]).map((u) => u.name);
    db.close();
    assert.deepEqual(names, ["Ada"], "the hub is as it was at the backup");
    const aside = new DatabaseSync(join(r.aside, "hub.db"), { readOnly: true });
    assert.equal((aside.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n, 2, "the hub before the restore is kept");
    aside.close();
    const yaml = YAML.parse(readFileSync(join(dir, "hub.yaml"), "utf8")) as { port: number; backup: { storage_zone: string } };
    assert.equal(yaml.port, 5555, "this machine's port stays");
    assert.equal(yaml.backup.storage_zone, "zone");
    assert.match(readFileSync(join(dir, "backup.secrets.yaml"), "utf8"), /restore test key 1/, "the keys stay");
    assert.ok(existsSync(join(dir, "projects", "app", "cortex.config.yaml")));
    assert.ok(!existsSync(join(dir, ".restore")));
    assert.equal(applyPendingRestore(dir), null, "applied once");
    rmSync(r.aside, { recursive: true, force: true });
  } finally {
    await t.cleanup();
  }
});

test("restore with an older key: adopt makes it this hub's key", async () => {
  const t = await hubSetup();
  try {
    const target = hubTarget(t.store);
    configureBackup(target, { storage_zone: "zone", endpoint: t.bunny.url, access_key: "zone-password", passphrase: "the old key 1234" });
    const backed = await runBackup(target);
    assert.equal(backed.status, "ok", backed.message);
    const [name] = (await listBackups(target)).map((b) => b.name);
    // A reinstall made a new key.
    configureBackup(target, { passphrase: "a new install key" });
    const { stageRestore } = await import("../src/hub/backup.js");
    await stageRestore(t.store, name!, t.admin.id, { passphrase: "the old key 1234", adopt: true });
    assert.doesNotMatch(JSON.stringify(pendingRestore(t.store.dir)), /old key/, "the key is not in what the board sees");
    t.store.close();
    const r = applyPendingRestore(t.store.dir)!;
    assert.match(readFileSync(join(t.store.dir, "backup.secrets.yaml"), "utf8"), /the old key 1234/);
    rmSync(r.aside, { recursive: true, force: true });
  } finally {
    await t.cleanup();
  }
});

test("a project's code folder can be pointed elsewhere; a missing folder is refused", async () => {
  const t = await hubSetup();
  const hub = new Hub(t.store);
  const { app, call } = await signIn(hub);
  try {
    mkdirSync(join(t.root, "app-moved"));
    const ok = await call("PUT", "/api/admin/projects/app/path", { path: join(t.root, "app-moved") });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().project.path, join(t.root, "app-moved"));
    assert.equal(ok.json().project.knowledge, "hub", "knowledge in the hub's folder is untouched");
    assert.equal((await call("PUT", "/api/admin/projects/app/path", { path: join(t.root, "nowhere") })).statusCode, 400);
    assert.equal((await call("PUT", "/api/admin/projects/nope/path", { path: join(t.root, "app-moved") })).statusCode, 404);
    const listed = (await call("GET", "/api/admin/projects")).json().projects[0];
    assert.equal(listed.path, join(t.root, "app-moved"));
    assert.equal((await call("GET", "/api/p/app/brief")).statusCode, 200, "the project opens from its new folder");
  } finally {
    await app.close();
    await t.cleanup();
  }
});

test("a project without a hub: backup to the same storage, restore in place, old files kept aside", async () => {
  const p = tempProject("Solo Shop");
  const bunny = await fakeBunny();
  try {
    p.cortex.putNode(p.human, { path: "backend/orders", title: "Orders", summary: "How orders flow" });
    const target = projectTarget(p.cortex.project);
    const r = configureBackup(target, { storage_zone: "zone", endpoint: bunny.url, access_key: "zone-password" });
    assert.ok(r.passphrase, "a key is made and shown once");
    const config = readFileSync(join(p.root, ".cortex", "cortex.config.yaml"), "utf8");
    assert.match(config, /backup:/);
    assert.doesNotMatch(config, /zone-password/);
    assert.match(readFileSync(join(p.root, ".cortex", ".gitignore"), "utf8"), /backup\.secrets\.yaml/);

    const runner = new BackupRunner(() => target);
    const done = await runner.now();
    assert.equal(done.status, "ok", done.message);
    assert.equal(runner.last?.status, "ok");
    const [file] = [...bunny.files.keys()];
    assert.match(file!, /^\/zone\/cortex\/solo-shop\/cortex-solo-shop-.*\.cxbk$/);
    const names = untar(open([...bunny.files.values()][0]!.body, r.passphrase!)).map((e) => e.name);
    assert.ok(names.includes("cortex/cortex.config.yaml"));
    assert.ok(!names.some((n) => /\.secrets\.yaml|\.index\/|\.backup-last/.test(n)), "no keys, tokens or index");

    // Lose the node, then bring it back.
    const orders = join(p.root, ".cortex", "tree", "backend", "orders.md");
    assert.ok(existsSync(orders));
    rmSync(orders);
    const [name] = (await listBackups(target)).map((b) => b.name);
    const back = await restoreProject(p.cortex.project, { name: name! });
    assert.ok(back.files > 5);
    assert.ok(existsSync(orders));
    assert.ok(readdirSync(back.aside).includes("tree"), "what was there is kept aside");
    assert.ok(existsSync(join(p.root, ".cortex", ".secrets.yaml")), "this machine's tokens stay");
    assert.match(readFileSync(join(p.root, ".cortex", "cortex.config.yaml"), "utf8"), /storage_zone: zone/, "this machine's backup settings stay");
    p.cortex.reindex();
  } finally {
    await bunny.close();
    p.cleanup();
  }
});

test("a project's board: /api/backup for people, not for AI tokens", async () => {
  const p = tempProject();
  const bunny = await fakeBunny();
  const app = buildServer(p.cortex);
  const H = (token: string) => ({ host: "localhost:4747", authorization: `Bearer ${token}` });
  try {
    assert.equal((await app.inject({ url: "/api/backup", headers: H(p.init.tokens["ai-agent"]!) })).statusCode, 403);
    const put = await app.inject({
      method: "PUT",
      url: "/api/backup",
      headers: H(p.init.tokens.owner!),
      payload: { storage_zone: "zone", endpoint: bunny.url, access_key: "zone-password", passphrase: "project key 12345" },
    });
    assert.equal(put.statusCode, 200, put.body);
    const got = (await app.inject({ url: "/api/backup", headers: H(p.init.tokens.owner!) })).json();
    assert.equal(got.ready, true);
    assert.doesNotMatch(JSON.stringify(got), /zone-password|project key/);
    assert.equal((await app.inject({ method: "POST", url: "/api/backup/run", headers: H(p.init.tokens.owner!) })).json().result.status, "ok");
    const [b] = (await app.inject({ url: "/api/backup/list", headers: H(p.init.tokens.owner!) })).json().backups;
    const restored = await app.inject({ method: "POST", url: "/api/backup/restore", headers: H(p.init.tokens.owner!), payload: { name: b.name } });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().restored, true);
  } finally {
    await app.close();
    await bunny.close();
    p.cleanup();
  }
});

test("a connection the other side dropped is tried once more, not reported as a failed backup", async () => {
  const { bunny } = await import("../src/backup/providers.js");
  let served = 0;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.method ?? "");
    if (served++ === 0) return void req.socket.destroy(); // dies before answering, as a stale reused socket does
    res.writeHead(201).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as { port: number }).port;
    const p = bunny({ zone: "zone", path: "p", accessKey: "k", endpoint: `http://127.0.0.1:${port}` });
    await p.put("a.cxbk", Buffer.from("sealed"));
    assert.deepEqual(seen, ["PUT", "PUT"], "one dropped try, one that went through");
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
