import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/api/server.js";
import { estimateTokens } from "../src/util/text.js";
import { tempProject } from "./helpers.js";

test("the project status: written directly by an agent, in the brief, stale after too many changes", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const H = (who: string) => ({ host: "localhost:4747", authorization: `Bearer ${t.init.tokens[who]}` });
  try {
    t.cortex.putNode(t.human, { path: "", title: "Shop", summary: "An online shop: catalogue, cart, invoices." }); // past the setup step
    assert.equal((await app.inject({ url: "/api/status", headers: H("owner") })).json().status, null);
    const empty = t.cortex.brief(t.ai);
    assert.equal(empty.status, null);
    assert.match(empty.next[0], /cortex_update_status/);

    // Knowledge from this agent goes through review; the status does not wait.
    const put = await app.inject({
      method: "PUT",
      url: "/api/status",
      headers: H("ai-agent"),
      payload: { body: "Export shipped. Next: invoices PDF.", reason: "end of session" },
    });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().applied, true);
    const brief = t.cortex.brief(t.ai);
    assert.equal(brief.status?.body, "Export shipped. Next: invoices PDF.");
    assert.equal(brief.status?.updated_by, "ai-agent");
    assert.equal(brief.status?.stale, undefined);
    assert.ok(!brief.next.some((n) => n.includes("cortex_update_status")));

    // Too much happened since: stale, and the brief says so first.
    t.cortex.project.config.status = { stale_changes: 3 };
    for (let i = 0; i < 3; i++) t.cortex.activity.log(t.ai, { action: "fix", summary: `Fix ${i}`, why: "Because." });
    const later = t.cortex.brief(t.ai);
    assert.deepEqual(later.status?.stale, { reason: "changes", days_old: 0, changes_since: 3 });
    assert.match(later.next[0], /stale \(3 changes since\)/);
    const rest = (await app.inject({ url: "/api/status", headers: H("owner") })).json().status;
    assert.equal(rest.stale, true);
    assert.deepEqual(rest.limits, { days: 3, changes: 3 });

    // Or too long ago.
    const s = t.cortex.status.staleness(rest.updated_at, Date.now() + 4 * 86_400_000);
    assert.equal(s.reason, "days");

    // Each rewrite keeps the one before.
    await app.inject({ method: "PUT", url: "/api/status", headers: H("owner"), payload: { body: "Invoices PDF done." } });
    const history = (await app.inject({ url: "/api/status/history", headers: H("owner") })).json().versions;
    assert.equal(history.length, 1);
    assert.equal(history[0].body, "Export shipped. Next: invoices PDF.");
    assert.equal((await app.inject({ method: "PUT", url: "/api/status", headers: H("owner"), payload: { body: "  " } })).statusCode, 400);
  } finally {
    await app.close();
    t.cleanup();
  }
});

test("a long status is shortened in the brief so it stays under its budget", () => {
  const t = tempProject();
  try {
    t.cortex.status.put(t.human, { body: "Where we are. ".repeat(500) });
    const brief = t.cortex.brief(t.ai);
    assert.ok(estimateTokens(brief) < 800, `brief is ${estimateTokens(brief)} tokens`);
    assert.ok(brief.status!.body.endsWith("…"));
  } finally {
    t.cleanup();
  }
});
