import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { Cortex } from "../src/core/cortex.js";
import { initProject } from "../src/core/init.js";
import { loadProject } from "../src/core/project.js";
import { buildServer } from "../src/api/server.js";
import { Hub, buildHubServer } from "../src/hub/server.js";
import { HubStore } from "../src/hub/store.js";

// Linked projects (decision 01M3AM8C6VZ0WB1MA2SMANEQJH): a mobile app reads its backend's knowledge through
// its own MCP connection, read-only, and only where its agent is a member of the backend too.
function setup() {
  const root = mkdtempSync(join(tmpdir(), "cortex-linked-"));
  const store = HubStore.init(join(root, "hub"), { org: "Acme", host: "127.0.0.1", port: 4747 });
  const dirs: Record<string, string> = {};
  for (const id of ["mobile", "backend", "secret"]) {
    dirs[id] = join(root, id);
    initProject(dirs[id]!, id, { language: "en", timezone: "UTC", bootstrapTask: false });
    store.addProject({ id, name: id, path: dirs[id]! });
  }
  // Knowledge in the backend: a public API branch and an internal one.
  const backend = new Cortex(loadProject(dirs.backend!), { embedder: null });
  const owner = backend.actor("owner");
  backend.putNode(owner, { path: "api", title: "API", summary: "Public endpoints", body: "", reason: "t" } as never);
  backend.putNode(owner, {
    path: "api/auth",
    title: "Auth",
    summary: "POST /login returns a zebratoken",
    body: "Refresh with /refresh.",
    reason: "t",
  } as never);
  backend.putNode(owner, { path: "internal", title: "Internal", summary: "zebratoken signing keys live in vault", body: "", reason: "t" } as never);
  backend.close();

  const cfg = join(dirs.mobile!, ".cortex", "cortex.config.yaml");
  writeFileSync(cfg, YAML.stringify({ ...YAML.parse(readFileSync(cfg, "utf8")), linked: ["backend", "secret"] }));

  const { token } = store.createAgent({ id: "flutter-ai" }, "setup");
  store.setMember("mobile", "flutter-ai", { role: "contributor" });
  store.setMember("backend", "flutter-ai", { role: "reader", branches: ["api"] });
  // "secret" is linked but the agent is not a member there.

  const hub = new Hub(store);
  const app = buildHubServer(hub);
  const get = (url: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  const cleanup = async () => {
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, store, app, token, get, cleanup };
}

test("linked: search and read the linked project, tagged with its id", async () => {
  const t = setup();
  try {
    const s = await t.get("/api/p/mobile/search?q=zebratoken&project=backend");
    assert.equal(s.statusCode, 200, s.body);
    const body = s.json() as { project: string; results: { path?: string }[] };
    assert.equal(body.project, "backend");
    assert.deepEqual(
      body.results.map((r) => r.path),
      ["api/auth"],
      "the internal branch stays hidden: the agent's backend membership is limited to api",
    );

    const n = await t.get("/api/p/mobile/node/api/auth?project=backend");
    assert.equal(n.statusCode, 200, n.body);
    assert.match(n.body, /Refresh with \/refresh/);
    assert.equal((await t.get("/api/p/mobile/node/internal?project=backend")).statusCode, 404);

    // Without the parameter the agent is in its own project, where the backend's knowledge does not exist.
    assert.equal(((await t.get("/api/p/mobile/search?q=zebratoken")).json() as { results: unknown[] }).results.length, 0);
  } finally {
    await t.cleanup();
  }
});

test("linked: brief lists the links and whether the caller may read them", async () => {
  const t = setup();
  try {
    const b = (await t.get("/api/p/mobile/brief")).json() as { linked: { id: string; readable: boolean; summary: string }[] };
    assert.deepEqual(
      b.linked.map((l) => [l.id, l.readable]),
      [
        ["backend", true],
        ["secret", false],
      ],
    );
    assert.equal(b.linked[1]!.summary, "", "nothing about a project the caller cannot read");
  } finally {
    await t.cleanup();
  }
});

test("linked: a link is not access, reads only, and only to linked projects", async () => {
  const t = setup();
  try {
    const notMember = await t.get("/api/p/mobile/search?q=x&project=secret");
    assert.equal(notMember.statusCode, 403);
    assert.match(notMember.body, /flutter-ai is not a member of \\"secret\\"/);

    // Member of the backend, but mobile does not link it the other way round.
    t.store.setMember("backend", "flutter-ai", { role: "contributor" });
    const reverse = await t.get("/api/p/backend/search?q=x&project=mobile");
    assert.equal(reverse.statusCode, 400);
    assert.equal((reverse.json() as { error: { code: string } }).error.code, "not_linked");

    // Writes and people's queues cannot be aimed at a linked project, whatever the role there.
    const write = await t.app.inject({
      method: "POST",
      url: "/api/p/mobile/items?project=backend",
      headers: { authorization: `Bearer ${t.token}` },
      payload: { type: "note", title: "x" },
    });
    assert.equal(write.statusCode, 400);
    assert.equal((write.json() as { error: { code: string } }).error.code, "cross_project_read_only");
    assert.equal((await t.get("/api/p/mobile/inbox?project=backend")).statusCode, 400);

    // Taking the membership away cuts the link on the next request.
    t.store.removeMember("backend", "flutter-ai");
    assert.equal((await t.get("/api/p/mobile/search?q=x&project=backend")).statusCode, 403);
  } finally {
    await t.cleanup();
  }
});

test("linked: a single project without a hub refuses ?project= instead of answering from itself", async () => {
  const root = mkdtempSync(join(tmpdir(), "cortex-linked-solo-"));
  const init = initProject(root, "solo", { language: "en", timezone: "UTC", bootstrapTask: false });
  const cortex = new Cortex(loadProject(root), { embedder: null });
  const app = buildServer(cortex);
  try {
    const r = await app.inject({
      method: "GET",
      url: "/api/search?q=x&project=backend",
      headers: { host: "localhost:4747", authorization: `Bearer ${init.tokens["ai-agent"]}` },
    });
    assert.equal(r.statusCode, 400);
    assert.equal((r.json() as { error: { code: string } }).error.code, "not_linked");
  } finally {
    await app.close();
    cortex.close();
    rmSync(root, { recursive: true, force: true });
  }
});
