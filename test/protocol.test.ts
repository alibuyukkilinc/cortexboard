import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { localApi } from "../src/mcp/client.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { gitProject } from "./helpers.js";

// Spec §14, end to end, the way an AI session runs it: only MCP tool calls on the AI side, the human
// side through the core as the board would. A real git repository, so staleness is real too.
test("protocol: brief -> inbox -> search -> code_context -> change -> log -> update/verify -> approved", async () => {
  const p = gitProject();
  const { cortex: c, human } = p;
  const server = buildMcpServer(await localApi(c, p.ai), { tools: "full" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "protocol-test", version: "1" });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const data = JSON.parse(r.content[0].text);
    assert.ok(!r.isError, `${name} failed: ${r.content[0].text}`);
    return data;
  };
  try {
    await Promise.all([server.connect(a), client.connect(b)]);

    // The project as the AI finds it: two documented areas and a question waiting for it.
    c.putNode(human, { path: "backend/auth", title: "Oturum", summary: "Erişim anahtarı 15 dakika yaşar.", links: { code: [{ file: "src/auth/token.ts" }] } });
    c.putNode(human, { path: "backend/pay", title: "Ödeme", summary: "iyzico ile tahsilat.", links: { code: [{ file: "src/pay/iyzico.ts" }] } });
    const q = c.items.create(human, { type: "question", title: "Token süresi neden 15 dakika?", assignee: "@ai", category_path: "backend/auth" });

    // 1. Session start: brief, then inbox; answer what waits first.
    const brief = await call("cortex_brief");
    assert.equal(brief.you.id, "ai-agent");
    assert.ok(brief.rules.version, "rules come with a version to re-fetch on change");
    const inbox = await call("cortex_inbox");
    assert.deepEqual(
      inbox.items.map((i: { id: string }) => i.id),
      [q.id],
    );
    await call("cortex_reply", { id: q.id, body: "Kısa ömür, çalınan token'ın zararını sınırlar.", status: "answered" });
    assert.equal((await call("cortex_inbox")).count, 0, "answered: nothing waits on the AI any more");

    // 2. Before a change: search, drill down, and ask what covers the files about to change.
    const found = await call("cortex_search", { q: "erişim anahtarı" });
    assert.equal(found.results[0].path, "backend/auth");
    assert.match((await call("cortex_node", { path: "backend/auth" })).node.summary, /15 dakika/);
    const ctx = await call("cortex_code_context", { files: ["src/auth/token.ts", "src/pay/iyzico.ts"] });
    assert.deepEqual(ctx.knowledge.map((k: { path: string }) => k.path).sort(), ["backend/auth", "backend/pay"]);
    assert.ok(
      ctx.items.some((i: { id: string }) => i.id === q.id),
      "the question filed under that knowledge comes along",
    );

    // 3. The change itself (outside Cortex, like any edit), committed.
    p.write("src/auth/token.ts", "export const ttl = 30;\n");
    p.write("src/pay/iyzico.ts", "export const provider = 'iyzico'; // 3DS on\n");
    const commit = p.commit("ttl 30, 3DS");

    // 4. Log it: what, why, files, commit. The answer names the knowledge that is now stale.
    const logged = await call("cortex_log_activity", {
      action: "code_change",
      summary: "Token süresi 30 dakika, 3DS açık",
      why: "Mobil kullanıcılar ödeme sırasında oturumu kaybediyordu",
      files: ["src/auth/token.ts", "src/pay/iyzico.ts"],
      commit,
      refs: [q.id],
    });
    const stale = logged.related_knowledge.filter((k: { stale?: unknown }) => k.stale).map((k: { path: string }) => k.path);
    assert.deepEqual(stale.sort(), ["backend/auth", "backend/pay"]);
    assert.match(logged.hint, /same turn/);
    assert.deepEqual(((await call("cortex_brief")).attention.stale_nodes.from_your_changes as string[]).sort(), ["backend/auth", "backend/pay"]);

    // 5. Close them in the same turn: one needs new words, the other is still true.
    const updated = await call("cortex_update_node", {
      path: "backend/auth",
      title: "Oturum",
      summary: "Erişim anahtarı 30 dakika yaşar.",
      code_files: [{ file: "src/auth/token.ts", symbol: "ttl" }],
      reason: "ttl 15 -> 30",
    });
    const verified = await call("cortex_verify_node", { path: "backend/pay", note: "Özet 3DS'ten söz etmiyor; hâlâ doğru" });
    assert.equal(updated.applied, false, "an AI's knowledge writes wait for a person");
    assert.equal(verified.applied, false);

    // The person approves both (the board's Approvals page); the knowledge is current again.
    for (const d of [updated.draft_id, verified.draft_id]) c.approve(human, d);
    assert.equal(c.node("backend/auth").links?.code?.[0].symbol, "ttl", "MCP and draft approval preserve the symbol");
    c.staleness.refresh(true);
    assert.deepEqual(
      c.staleness.list().map((s) => s.path),
      [],
    );
    assert.match((await call("cortex_node", { path: "backend/auth" })).node.summary, /30 dakika/);

    // 6. The trail a person reads: the logged change with its reason, and the answered question.
    const feed = await call("cortex_activity", { limit: 5 });
    assert.equal(feed.entries[0].why, "Mobil kullanıcılar ödeme sırasında oturumu kaybediyordu");
    assert.equal((await call("cortex_item", { id: q.id })).item.status, "answered");
  } finally {
    await client.close();
    p.cleanup();
  }
});
