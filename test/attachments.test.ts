import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildServer } from "../src/api/server.js";
import { initProject } from "../src/core/init.js";
import { Hub, buildHubServer } from "../src/hub/server.js";
import { HubStore } from "../src/hub/store.js";
import { localApi } from "../src/mcp/client.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { MAX_ATTACHMENT_BYTES, safeFileName, uniqueName } from "../src/store/attachments.js";
import { tempProject } from "./helpers.js";

// The smallest valid PNG: 1x1, transparent.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("attachment names: readable, one safe path segment, never a device name", () => {
  assert.equal(safeFileName("Ekran görüntüsü 2026-09-24 10.15.png"), "Ekran görüntüsü 2026-09-24 10.15.png");
  assert.equal(safeFileName("../../item.md"), "item.md");
  assert.equal(safeFileName("C:\\Users\\me\\a:b?.txt"), "a-b-.txt");
  assert.equal(safeFileName("  .hidden  "), "hidden");
  assert.equal(safeFileName("CON.txt"), "file-CON.txt");
  assert.equal(safeFileName(""), "file");
  assert.equal(safeFileName(`${"a".repeat(300)}.png`).length, 120);
  assert.ok(safeFileName(`${"a".repeat(300)}.png`).endsWith(".png"));
  assert.equal(uniqueName("shot.png", new Set(["shot.png", "shot-2.png"])), "shot-3.png");
  assert.equal(uniqueName("Shot.PNG", new Set(["shot.png"])), "Shot-2.PNG", "case-insensitive, like Windows and macOS disks");
});

test("attachments over REST: upload, list, serve safely, delete; the board card gets count and cover", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const H = (token = t.init.tokens.owner) => ({ host: "localhost:4747", authorization: `Bearer ${token}` });
  try {
    const item = t.cortex.items.create(t.human, { type: "task", title: "Checkout button overlaps" });
    const upload = (name: string, body: Buffer | string, token?: string) =>
      app.inject({
        method: "POST",
        url: `/api/items/${item.id}/files?name=${encodeURIComponent(name)}`,
        headers: { ...H(token), "content-type": "application/octet-stream" },
        payload: body,
      });

    const shot = await upload("Ekran görüntüsü.png", PNG);
    assert.equal(shot.statusCode, 201, shot.body);
    assert.equal(shot.json().file.name, "Ekran görüntüsü.png");
    assert.equal((await upload("Ekran görüntüsü.png", PNG)).json().file.name, "Ekran görüntüsü-2.png", "same name twice: both kept");
    assert.equal((await upload("spec.md", "# Spec\n\n- step one\n")).statusCode, 201);
    assert.equal((await upload("logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')).statusCode, 201);
    // A .json file is still just bytes: the JSON body parser must not get in the way.
    const json = await app.inject({
      method: "POST",
      url: `/api/items/${item.id}/files?name=data.json`,
      headers: { ...H(), "content-type": "application/json" },
      payload: '{"a":1}',
    });
    assert.equal(json.statusCode, 201, json.body);

    // Stored next to the item, in git's reach.
    const folder = readdirSync(join(t.root, ".cortex/items")).find((n) => n.startsWith(item.id))!;
    assert.ok(existsSync(join(t.root, ".cortex/items", folder, "files", "Ekran görüntüsü.png")));
    const listed = (await app.inject({ url: `/api/items/${item.id}/files`, headers: H() })).json().files;
    assert.deepEqual(
      listed.map((f: { name: string }) => f.name).sort(),
      ["Ekran görüntüsü-2.png", "Ekran görüntüsü.png", "data.json", "logo.svg", "spec.md"].sort(),
    );
    assert.equal((await app.inject({ url: `/api/items/${item.id}`, headers: H() })).json().attachments.length, 5, "the item read lists them");
    // Each with its full address, so an agent can fetch it without knowing the routes (issue 01M41K3EBHD7Q3AFD31MSTJX27).
    const shotUrl = `http://localhost:4747/api/items/${item.id}/files/${encodeURIComponent("Ekran görüntüsü.png")}`;
    assert.equal(shot.json().file.url, shotUrl);
    assert.ok(listed.some((f: { url: string }) => f.url === shotUrl));
    assert.ok((await app.inject({ url: `/api/items/${item.id.slice(-6)}`, headers: H() })).json().attachments.some((f: { url: string }) => f.url === shotUrl), "a short id still gives the full one");

    // Served: pictures and text inline, SVG only as a download, never sniffed, never scripted.
    const img = await app.inject({ url: `/api/items/${item.id}/files/${encodeURIComponent("Ekran görüntüsü.png")}`, headers: H() });
    assert.equal(img.headers["content-type"], "image/png");
    assert.match(String(img.headers["content-disposition"]), /^inline/);
    assert.deepEqual(img.rawPayload, PNG);
    const svg = await app.inject({ url: `/api/items/${item.id}/files/logo.svg`, headers: H() });
    assert.match(String(svg.headers["content-disposition"]), /^attachment/);
    assert.equal(svg.headers["x-content-type-options"], "nosniff");
    assert.match(String(svg.headers["content-security-policy"]), /sandbox/);
    assert.match(
      String((await app.inject({ url: `/api/items/${item.id}/files/spec.md`, headers: H() })).headers["content-type"]),
      /^text\/markdown; charset=utf-8/,
    );

    // Names cannot walk out of the files folder.
    for (const bad of ["..%2Fitem.md", "%2E%2E%5Citem.md", "item.md"]) {
      assert.equal((await app.inject({ url: `/api/items/${item.id}/files/${bad}`, headers: H() })).statusCode, 404, bad);
    }

    // The board card: how many, and the first picture as cover.
    const card = (await app.inject({ url: "/api/items?type=task", headers: H() })).json().items[0];
    assert.equal(card.files, 5);
    assert.equal(card.cover, "Ekran görüntüsü.png");

    // Delete, and the count follows; an audit entry for each change.
    assert.equal((await app.inject({ method: "DELETE", url: `/api/items/${item.id}/files/logo.svg`, headers: H() })).statusCode, 200);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/items/${item.id}/files/logo.svg`, headers: H() })).statusCode, 404);
    assert.equal((await app.inject({ url: "/api/items?type=task", headers: H() })).json().items[0].files, 4);
    const audit = t.cortex.activity.list({ include_system: true, limit: 50 }).entries.map((e) => e.action);
    assert.ok(audit.includes("item.attached") && audit.includes("item.detached"));

    // Limits and bad input.
    assert.equal((await upload("big.bin", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))).statusCode, 413);
    assert.equal((await upload("empty.txt", Buffer.alloc(0))).statusCode, 400);
    assert.equal(
      (await app.inject({ method: "POST", url: `/api/items/${item.id}/files`, headers: { ...H(), "content-type": "image/png" }, payload: PNG })).statusCode,
      400,
      "no name",
    );

    // An AI may attach under the default (auto) policy; where its writes would be drafts, it may not.
    assert.equal((await upload("ai-log.txt", "trace", t.init.tokens["ai-agent"])).statusCode, 201);
    t.cortex.project.config.approval.task = "review";
    const refused = await upload("ai-log-2.txt", "trace", t.init.tokens["ai-agent"]);
    assert.equal(refused.statusCode, 403);
    assert.match(refused.json().error.message, /files cannot wait in a draft/);

    // A reindex from files alone gives the same card.
    t.cortex.reindex();
    assert.equal(t.cortex.items.list({ type: "task" }).items[0].files, 5);
  } finally {
    await app.close();
    t.cleanup();
  }
});

test("a file dropped into the item's folder by hand is attached (the folder is the truth)", () => {
  const t = tempProject();
  try {
    const item = t.cortex.items.create(t.human, { type: "note", title: "Hand-made" });
    t.cortex.items.attach(t.human, item.id, "first.txt", Buffer.from("x"));
    const file = t.cortex.itemStore.attachments(item.id)[0];
    assert.equal(file.name, "first.txt");
    const folder = t.cortex.itemStore.readAttachment(item.id, "first.txt");
    assert.ok(folder);
    // Put a second file next to it directly on disk, then rebuild the index.
    const dir = join(t.root, ".cortex/items", `${item.id}-hand-made`, "files");
    writeFileSync(join(dir, "diagram.png"), PNG);
    t.cortex.reindex();
    const card = t.cortex.items.list({ type: "note" }).items[0];
    assert.equal(card.files, 2);
    assert.equal(card.cover, "diagram.png");
  } finally {
    t.cleanup();
  }
});

test("MCP: an AI reads an attached spec as text and a screenshot as an image", async () => {
  const t = tempProject();
  const server = buildMcpServer(await localApi(t.cortex, t.ai), { tools: "full" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const item = t.cortex.items.create(t.human, { type: "task", title: "Fix layout" });
    t.cortex.items.attach(t.human, item.id, "spec.md", Buffer.from("# Spec\nThe button sits right."));
    t.cortex.items.attach(t.human, item.id, "shot.png", PNG);
    t.cortex.items.attach(t.human, item.id, "dump.bin", Buffer.from([0, 1, 2]));

    type Content = { type: string; text?: string; data?: string; mimeType?: string };
    const call = async (name: string) =>
      (await client.callTool({ name: "cortex_item_file", arguments: { id: item.id, name } })) as { content: Content[]; isError?: boolean };

    const listed = (await client.callTool({ name: "cortex_item", arguments: { id: item.id } })) as { content: Content[] };
    assert.deepEqual(
      JSON.parse(listed.content[0].text!)
        .attachments.map((f: { name: string }) => f.name)
        .sort(),
      ["dump.bin", "shot.png", "spec.md"],
    );
    assert.match(JSON.parse((await call("spec.md")).content[0].text!).text, /button sits right/);
    const img = (await call("shot.png")).content[0];
    assert.equal(img.type, "image");
    assert.equal(img.mimeType, "image/png");
    assert.deepEqual(Buffer.from(img.data!, "base64"), PNG);
    assert.match(JSON.parse((await call("dump.bin")).content[0].text!).note, /Not a text file/);
    assert.equal((await call("nope.txt")).isError, true);
  } finally {
    await client.close();
    t.cleanup();
  }
});

test("attachments on a hub: the item read gives each file's address on the hub, public_url first", async () => {
  const root = mkdtempSync(join(tmpdir(), "cortex-files-hub-"));
  const store = HubStore.init(join(root, "hub"), { org: "Acme", host: "0.0.0.0", port: 4747 });
  store.settings.allowed_hosts = ["10.0.0.5"];
  delete store.settings.public_url; // CORTEX_PUBLIC_URL on the machine running the tests
  initProject(join(root, "shop"), "shop", { language: "en", timezone: "UTC", bootstrapTask: false });
  store.addProject({ id: "shop", name: "shop", path: join(root, "shop") });
  const { token } = store.createAgent({ id: "remote-ai" }, "setup");
  store.setMember("shop", "remote-ai", { role: "contributor" });
  const app = buildHubServer(new Hub(store));
  const headers = { authorization: `Bearer ${token}`, host: "10.0.0.5:4747" };
  try {
    const created = await app.inject({ method: "POST", url: "/api/p/shop/items", headers, payload: { type: "note", title: "Screen" } });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().id as string;
    const up = await app.inject({
      method: "POST",
      url: `/api/p/shop/items/${id}/files?name=shot.png`,
      headers: { ...headers, "content-type": "application/octet-stream" },
      payload: PNG,
    });
    assert.equal(up.statusCode, 201, up.body);
    const read = async () => (await app.inject({ url: `/api/p/shop/items/${id}`, headers })).json().attachments[0].url as string;

    assert.equal(await read(), `http://10.0.0.5:4747/api/p/shop/items/${id}/files/shot.png`, "no public_url: the address the agent came in on");
    store.settings.public_url = "https://cortex.example.com";
    const url = await read();
    assert.equal(url, `https://cortex.example.com/api/p/shop/items/${id}/files/shot.png`);
    const img = await app.inject({ url: new URL(url).pathname, headers });
    assert.equal(img.statusCode, 200);
    assert.deepEqual(img.rawPayload, PNG);
  } finally {
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
