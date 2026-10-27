import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/api/server.js";
import { gitProject } from "./helpers.js";

test("a stale node shows the code diff since it was verified, and asks an agent to update it once", async () => {
  const p = gitProject();
  const app = buildServer(p.cortex);
  const H = (who: string) => ({ host: "localhost:4747", authorization: `Bearer ${p.init.tokens[who]}` });
  try {
    p.cortex.putNode(p.human, { path: "backend/auth", title: "Auth", summary: "15 minute tokens.", links: { code: [{ file: "src/auth/token.ts" }] } });
    p.write("src/auth/token.ts", "export const ttl = 60;\n");
    p.commit("longer tokens");
    p.cortex.staleness.refresh(true);

    const diff = await app.inject({ url: "/api/stale/diff/backend/auth", headers: H("owner") });
    assert.equal(diff.statusCode, 200);
    const d = diff.json();
    assert.equal(d.files.length, 1);
    assert.equal(d.files[0].file, "src/auth/token.ts");
    assert.match(d.files[0].patch, /^-export const ttl = 15;$/m);
    assert.match(d.files[0].patch, /^\+export const ttl = 60;$/m);
    assert.equal(d.truncated, false);
    assert.equal((await app.inject({ url: "/api/stale/diff/backend", headers: H("owner") })).statusCode, 400, "not stale: nothing to diff");

    const ask = await app.inject({ method: "POST", url: "/api/stale/request-update/backend/auth", headers: H("owner") });
    assert.equal(ask.statusCode, 201);
    const id = ask.json().id;
    const task = p.cortex.items.get(id).item;
    assert.equal(task.assignee, "@ai");
    assert.equal(task.category_path, "backend/auth");
    assert.deepEqual(task.links?.nodes, ["backend/auth"]);
    assert.deepEqual(task.links?.code, [{ file: "src/auth/token.ts" }]);
    assert.match(task.body, /cortex_verify_node/);
    // It is in the agent's inbox.
    assert.ok(p.cortex.items.inbox(p.cortex.actor("ai-agent")).items.some((i) => i.id === id));

    const again = await app.inject({ method: "POST", url: "/api/stale/request-update/backend/auth", headers: H("owner") });
    assert.equal(again.statusCode, 200);
    assert.deepEqual([again.json().id, again.json().existing], [id, true], "asking twice returns the open request");
  } finally {
    await app.close();
    p.cleanup();
  }
});
