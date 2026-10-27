import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/api/server.js";
import { Cortex } from "../src/core/cortex.js";
import { initProject } from "../src/core/init.js";
import { loadProject } from "../src/core/project.js";
import type { CortexError } from "../src/core/types.js";
import { symbolBody } from "../src/git/symbol.js";
import { gitProject } from "./helpers.js";

const stale = (c: Cortex, path: string) => {
  c.staleness.refresh(true);
  return c.staleness.get(path);
};

test("writing a node with code links pins it to the current commit", () => {
  const p = gitProject();
  try {
    p.cortex.putNode(p.human, { path: "backend/auth", title: "Auth", summary: "Login and tokens.", links: { code: [{ file: "src/auth/login.ts" }] } });
    assert.equal(p.cortex.node("backend/auth").verified_at_commit, p.first);
    assert.equal(stale(p.cortex, "backend/auth"), undefined);

    const bad = (() => {
      try {
        p.cortex.putNode(p.human, { path: "backend/x", title: "x", summary: "x", links: { code: [{ file: "a.ts" }] }, verified_at_commit: "deadbeef" });
      } catch (e) {
        return e as CortexError;
      }
    })();
    assert.equal(bad?.code, "invalid_node");
  } finally {
    p.cleanup();
  }
});

test("a committed change to linked code makes the node stale, with the commit that did it", () => {
  const p = gitProject();
  try {
    p.cortex.putNode(p.human, { path: "backend/auth", title: "Auth", summary: "15 minute tokens.", links: { code: [{ file: "src/auth/token.ts" }] } });
    p.cortex.putNode(p.human, { path: "backend/pay", title: "Payments", summary: "iyzico.", links: { code: [{ file: "src/pay" }] } });

    p.write("README.md", "# demo\nmore\n");
    p.commit("docs only");
    assert.equal(stale(p.cortex, "backend/auth"), undefined, "unrelated commits do not matter");

    // Uncommitted edits do not count: the AI may be halfway through a change.
    p.write("src/auth/token.ts", "export const ttl = 60;\n");
    assert.equal(stale(p.cortex, "backend/auth"), undefined);
    p.commit("longer tokens");

    const s = stale(p.cortex, "backend/auth")!;
    assert.equal(s.reason, "changed");
    assert.equal(s.changes[0].file, "src/auth/token.ts");
    assert.equal(s.changes[0].commits, 1);
    assert.equal(s.changes[0].last?.subject, "longer tokens");
    assert.equal(stale(p.cortex, "backend/pay"), undefined);

    // A directory link sees changes to any file inside it.
    p.write("src/pay/iyzico.ts", "export const provider = 'iyzico-v2';\n");
    p.commit("iyzico v2");
    assert.equal(stale(p.cortex, "backend/pay")?.changes[0].file, "src/pay/iyzico.ts");

    // The tree, search and brief all surface it.
    assert.equal(p.cortex.treeView("backend").node.children?.find((c) => c.path === "backend/auth")?.status, "stale");
    const brief = p.cortex.brief(p.ai);
    assert.equal(brief.attention.stale_nodes?.count, 2);
    assert.ok(p.cortex.nodeView("backend/auth").staleness?.hint);
  } finally {
    p.cleanup();
  }
});

test("with a line range, only changes to those lines count", () => {
  const p = gitProject();
  try {
    p.cortex.putNode(p.human, {
      path: "backend/auth",
      title: "Auth",
      summary: "Login check.",
      links: { code: [{ file: "src/auth/login.ts", lines: "40-60" }] },
    });

    p.edit("src/auth/login.ts", "line 5\n", "line 5 changed\n");
    p.commit("touch line 5");
    assert.equal(stale(p.cortex, "backend/auth"), undefined, "outside the linked range");

    p.edit("src/auth/login.ts", "line 50\n", "line 50 changed\n");
    p.commit("touch line 50");
    const s = stale(p.cortex, "backend/auth")!;
    assert.equal(s.changes[0].lines, "40-60");
    assert.equal(s.changes[0].last?.subject, "touch line 50");
  } finally {
    p.cleanup();
  }
});

test("deleted and renamed files are reported", () => {
  const p = gitProject();
  try {
    p.cortex.putNode(p.human, {
      path: "backend/pay",
      title: "Refunds",
      summary: "v2 refunds.",
      links: { code: [{ file: "src/pay/refund_v2.ts" }, { file: "src/pay/iyzico.ts" }] },
    });
    unlinkSync(join(p.root, "src/pay/refund_v2.ts"));
    renameSync(join(p.root, "src/pay/iyzico.ts"), join(p.root, "src/pay/provider.ts"));
    p.commit("restructure payments");
    const s = stale(p.cortex, "backend/pay")!;
    const byFile = Object.fromEntries(s.changes.map((c) => [c.file, c]));
    assert.equal(byFile["src/pay/refund_v2.ts"].status, "deleted");
    assert.equal(byFile["src/pay/iyzico.ts"].status, "renamed");
    assert.equal(byFile["src/pay/iyzico.ts"].renamed_to, "src/pay/provider.ts");
  } finally {
    p.cleanup();
  }
});

test("verifying clears staleness; an AI's verification waits for a human", () => {
  const p = gitProject();
  try {
    p.cortex.putNode(p.human, { path: "backend/auth", title: "Auth", summary: "Tokens.", links: { code: [{ file: "src/auth/token.ts" }] } });
    p.write("src/auth/token.ts", "export const ttl = 30;\n");
    const head = p.commit("tweak ttl");
    assert.ok(stale(p.cortex, "backend/auth"));

    const byAi = p.cortex.verifyNode(p.ai, "backend/auth", "Checked: summary does not mention the ttl value");
    assert.equal(byAi.applied, false, "AI verification is a draft under the default policy");
    assert.ok(stale(p.cortex, "backend/auth"), "still stale until approved");
    p.cortex.approve(p.human, byAi.draft_id!);
    assert.equal(stale(p.cortex, "backend/auth"), undefined);
    assert.equal(p.cortex.node("backend/auth").verified_at_commit, head);

    // An unknown commit (rewritten history, shallow clone) is treated as stale, not silently trusted.
    p.cortex.close();
    const file = join(p.root, ".cortex/tree/backend/auth.md");
    writeFileSync(file, readFileSync(file, "utf8").replace(/verified_at_commit: \w+/, "verified_at_commit: 0123456789abcdef0123456789abcdef01234567"));
    const again = new Cortex(loadProject(p.root), { embedder: null });
    again.project.config.staleness = "all";
    try {
      assert.equal(stale(again, "backend/auth")?.reason, "unknown_commit");
    } finally {
      again.close();
    }
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("code context: what covers these files, and a nudge after logging changes", () => {
  const p = gitProject();
  try {
    p.cortex.putNode(p.human, { path: "backend/auth", title: "Auth", summary: "Login.", links: { code: [{ file: "src/auth/login.ts", lines: "1-20" }] } });
    p.cortex.putNode(p.human, { path: "backend/pay", title: "Payments", summary: "iyzico.", links: { code: [{ file: "src/pay" }] } });
    const decision = p.cortex.items.create(p.human, {
      type: "decision",
      title: "Use iyzico",
      category_path: "backend/pay",
      fields: { context: "TRY installments" },
    });
    const issue = p.cortex.items.create(p.human, {
      type: "issue",
      title: "Refund rounding",
      category_path: "backend",
      links: { code: [{ file: "src/pay/refund_v2.ts" }] },
      fields: { severity: "low" },
    });

    const ctx = p.cortex.codeContext(["src/pay/refund_v2.ts"]);
    assert.deepEqual(
      ctx.knowledge.map((k) => k.path),
      ["backend/pay"],
      "directory link covers the file",
    );
    const ids = ctx.items.map((i) => i.id);
    assert.ok(ids.includes(decision.id), "decisions under the matched knowledge");
    assert.ok(ids.includes(issue.id), "items linking the file directly");

    // "_" must not act as a wildcard.
    assert.equal(p.cortex.codeContext(["src/pay/refundXv2.ts"]).knowledge.length, 1, "still inside src/pay");
    assert.equal(
      p.cortex.codeContext(["src/pay/refundXv2.ts"]).items.some((i) => i.id === issue.id && i.via === "code link"),
      false,
    );

    // Asking about a directory finds links to files inside it.
    assert.deepEqual(
      p.cortex.codeContext(["src/auth"]).knowledge.map((k) => k.path),
      ["backend/auth"],
    );
    assert.ok(p.cortex.codeContext(["docs/none.md"]).hint);

    const logged = p.cortex.activity.log(p.ai, { action: "fix", summary: "Round refunds", why: "Off-by-one kuruş", files: ["./src/pay/refund_v2.ts"] });
    assert.deepEqual(
      logged.related_knowledge?.map((k) => k.path),
      ["backend/pay"],
    );
  } finally {
    p.cleanup();
  }
});

test("REST: stale list, verify and code context endpoints", async () => {
  const p = gitProject();
  const app = buildServer(p.cortex);
  const as = (who: "owner" | "ai-agent") => ({ host: "localhost", authorization: `Bearer ${p.init.tokens[who]}` });
  try {
    p.cortex.putNode(p.human, { path: "backend/auth", title: "Auth", summary: "Tokens.", links: { code: [{ file: "src/auth/token.ts" }] } });
    p.write("src/auth/token.ts", "export const ttl = 5;\n");
    p.commit("shorter tokens");
    p.cortex.staleness.refresh(true);

    const list = await app.inject({ url: "/api/stale", headers: as("owner") });
    assert.equal(list.json().enabled, true);
    assert.deepEqual(
      list.json().nodes.map((n: { path: string }) => n.path),
      ["backend/auth"],
    );
    assert.equal((await app.inject({ url: "/api/node/backend/auth", headers: as("ai-agent") })).json().staleness.reason, "changed");
    assert.equal((await app.inject({ url: "/api/code?files=src/auth/token.ts", headers: as("ai-agent") })).json().knowledge[0].stale, true);

    assert.equal((await app.inject({ method: "POST", url: "/api/verify/backend/auth", headers: as("ai-agent"), payload: {} })).statusCode, 202);
    const v = await app.inject({ method: "POST", url: "/api/verify/backend/auth", headers: as("owner"), payload: { note: "ttl not in text" } });
    assert.equal(v.statusCode, 200);
    p.cortex.staleness.refresh(true);
    assert.deepEqual((await app.inject({ url: "/api/stale", headers: as("owner") })).json().nodes, []);
  } finally {
    await app.close();
    p.cleanup();
  }
});

test("outside a git repository everything still works, staleness is just off", () => {
  const root = mkdtempSync(join(tmpdir(), "cortex-nogit-"));
  initProject(root, "demo");
  const c = new Cortex(loadProject(root), { embedder: null });
  try {
    const h = c.actor("owner");
    c.putNode(h, { path: "backend/auth", title: "Auth", summary: "x", links: { code: [{ file: "src/a.ts" }] } });
    assert.equal(c.node("backend/auth").verified_at_commit, undefined);
    assert.equal(c.staleness.enabled(), false);
    assert.deepEqual(c.staleness.list(), []);
    assert.equal(c.brief(h).attention.stale_nodes, undefined);
    assert.throws(
      () => c.verifyNode(h, "backend/auth"),
      (e: CortexError) => e.code === "no_git",
    );
  } finally {
    c.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("linking code that is not committed yet is allowed, but the writer is told", () => {
  const t = gitProject();
  try {
    writeFileSync(join(t.root, "src/fresh.ts"), "export const fresh = 1;\n");
    const r = t.cortex.putNode(t.human, {
      path: "backend/fresh",
      title: "Fresh",
      summary: "Brand new code, not committed yet.",
      links: { code: [{ file: "src/fresh.ts" }, { file: "src/auth/login.ts" }] },
    });
    assert.equal(r.applied, true, "the node is still written");
    assert.match(r.warning ?? "", /src\/fresh\.ts/);
    assert.doesNotMatch(r.warning ?? "", /login\.ts/, "committed files are not mentioned");

    t.commit("fresh file added");
    const again = t.cortex.putNode(t.human, {
      path: "backend/fresh",
      title: "Fresh",
      summary: "Brand new code, now committed.",
      links: { code: [{ file: "src/fresh.ts" }] },
    });
    assert.equal(again.warning, undefined);
  } finally {
    t.cleanup();
  }
});

test("severity: formatting is low, linked lines and moved files are high, the rest of the file is medium", () => {
  const p = gitProject();
  try {
    const put = (path: string, file: string, lines?: string) =>
      p.cortex.putNode(p.human, { path, title: path, summary: "x", links: { code: [{ file, ...(lines ? { lines } : {}) }] } });
    put("backend", "README.md");
    put("backend/auth", "src/auth/login.ts", "40-60");
    put("backend/token", "src/auth/token.ts");
    put("backend/pay", "src/pay/iyzico.ts");

    p.write("README.md", "#   demo\n\n\n"); // whitespace and blank lines only
    p.edit("src/auth/login.ts", "line 50\n", "line 50 changed\n");
    p.write("src/auth/token.ts", "export const ttl = 15;\nexport const refresh = 7;\n");
    renameSync(join(p.root, "src/pay/iyzico.ts"), join(p.root, "src/pay/provider.ts"));
    p.commit("mixed");

    assert.equal(stale(p.cortex, "backend")?.severity, "low");
    assert.equal(stale(p.cortex, "backend")?.changes[0].formatting_only, true);
    assert.equal(stale(p.cortex, "backend/auth")?.severity, "high", "the linked range was rewritten");
    assert.equal(stale(p.cortex, "backend/token")?.severity, "medium", "a whole-file link, a real change somewhere in it");
    assert.equal(stale(p.cortex, "backend/pay")?.severity, "high", "renamed");

    // Counting: the formatting-only one is information, not work.
    assert.deepEqual(
      p.cortex.staleness.actionable().map((s) => s.path),
      ["backend/auth", "backend/pay", "backend/token"],
    );
    const brief = p.cortex.brief(p.human);
    assert.equal(brief.attention.stale_nodes?.count, 3);
    assert.equal(p.cortex.treeView("", 1).node.children!.find((c) => c.path === "backend")!.status, "active", "low is not flagged in the tree");
  } finally {
    p.cleanup();
  }
});

test("a snooze silences a stale node until its files change again", async () => {
  const p = gitProject();
  try {
    p.cortex.putNode(p.human, { path: "backend/auth", title: "Auth", summary: "Tokens.", links: { code: [{ file: "src/auth/token.ts" }] } });
    p.write("src/auth/token.ts", "export const ttl = 30;\n");
    p.commit("ttl 30");
    assert.ok(stale(p.cortex, "backend/auth"));

    p.cortex.staleness.snooze("backend/auth", "owner");
    assert.equal(stale(p.cortex, "backend/auth")?.snoozed?.by, "owner");
    assert.equal(p.cortex.staleness.actionable().length, 0);
    assert.equal(p.cortex.brief(p.human).attention.stale_nodes, undefined);
    // Kept out of the tree: git never sees it.
    assert.ok(readFileSync(join(p.root, ".cortex/.index/snoozes.json"), "utf8").includes("backend/auth"));

    // Another process sees it too (the MCP server next to the board).
    const other = new Cortex(loadProject(p.root), { embedder: null });
    other.project.config.staleness = "all";
    try {
      assert.ok(stale(other, "backend/auth")?.snoozed);
    } finally {
      other.close();
    }

    p.write("src/auth/token.ts", "export const ttl = 60;\n");
    p.commit("ttl 60");
    assert.equal(stale(p.cortex, "backend/auth")?.snoozed, undefined, "a new commit on the file wakes it up");
    assert.equal(p.cortex.staleness.actionable().length, 1);

    // Over REST: people only.
    const app = (await import("../src/api/server.js")).buildServer(p.cortex);
    try {
      const auth = (t: string) => ({ host: "localhost", authorization: `Bearer ${t}` });
      const byAi = await app.inject({ method: "POST", url: "/api/snooze/backend/auth", headers: auth(p.init.tokens["ai-agent"]) });
      assert.equal(byAi.statusCode, 403);
      const byHuman = await app.inject({ method: "POST", url: "/api/snooze/backend/auth", headers: auth(p.init.tokens.owner) });
      assert.equal(byHuman.statusCode, 200);
      const list = (await app.inject({ method: "GET", url: "/api/stale", headers: auth(p.init.tokens.owner) })).json();
      assert.equal(list.actionable, 0);
      assert.equal(list.nodes.length, 1);
    } finally {
      await app.close();
    }
  } finally {
    p.cleanup();
  }
});

test("logging a change names the nodes it made stale, so the AI closes them in the same turn", () => {
  const p = gitProject();
  try {
    p.cortex.putNode(p.human, { path: "backend/auth", title: "Auth", summary: "Tokens.", links: { code: [{ file: "src/auth/token.ts" }] } });
    p.write("src/auth/token.ts", "export const ttl = 30;\n");
    p.commit("ttl 30");
    const r = p.cortex.activity.log(p.ai, { action: "code_change", summary: "ttl 30", why: "Sessions expired too soon", files: ["src/auth/token.ts"] });
    assert.equal(r.related_knowledge?.[0].stale?.severity, "medium");
    assert.match(r.hint!, /made 1 node\(s\) stale: backend\/auth/);
    assert.deepEqual(p.cortex.brief(p.ai).attention.stale_nodes?.from_your_changes, ["backend/auth"]);
    assert.equal(p.cortex.brief(p.human).attention.stale_nodes?.from_your_changes, undefined, "the owner logged nothing");
  } finally {
    p.cleanup();
  }
});

test("files with non-ASCII names are followed (git quotes them unless told not to)", () => {
  const p = gitProject();
  try {
    p.write("src/ödeme/iade.ts", "export const limit = 1;\n");
    p.commit("add ödeme");
    // Linked as a macOS editor would send it (decomposed); git and the index hold the composed form.
    p.cortex.putNode(p.human, { path: "backend/pay", title: "İade", summary: "Refund limit.", links: { code: [{ file: "src/ödeme/iade.ts" }] } });
    assert.deepEqual(
      p.cortex.codeContext(["src/ödeme/iade.ts"]).knowledge.map((k) => k.path),
      ["backend/pay"],
    );
    p.write("src/ödeme/iade.ts", "export const limit = 2;\n");
    p.commit("raise the limit");
    const s = stale(p.cortex, "backend/pay");
    assert.equal(s?.changes[0].file, "src/ödeme/iade.ts");
    assert.equal(s?.severity, "medium");
  } finally {
    p.cleanup();
  }
});

test("staleness level: high by default shows only high, off shows nothing, knowledge on a hub defaults to off", () => {
  const p = gitProject({ staleness: "all" });
  try {
    p.cortex.putNode(p.human, { path: "backend", title: "Backend", summary: "s" });
    p.cortex.putNode(p.human, {
      path: "backend/auth",
      title: "Auth",
      summary: "Login.",
      links: { code: [{ file: "src/auth/login.ts", lines: "1-10" }, { file: "src/auth/token.ts" }] },
    });
    p.cortex.putNode(p.human, { path: "backend/pay", title: "Pay", summary: "Payments.", links: { code: [{ file: "src/pay/iyzico.ts" }] } });
    p.edit("src/auth/login.ts", "line 5\n", "line five\n"); // inside the linked lines: high
    p.edit("src/pay/iyzico.ts", "iyzico'", "iyzico2'"); // somewhere in a linked file: medium
    p.commit("change");
    const paths = () => p.cortex.staleness.list().map((s) => `${s.path}:${s.severity}`);
    assert.deepEqual(paths(), ["backend/auth:high", "backend/pay:medium"]);

    delete p.cortex.project.config.staleness; // the default for knowledge kept in the repository
    assert.equal(p.cortex.staleness.level(), "high");
    assert.deepEqual(paths(), ["backend/auth:high"]);
    assert.equal(p.cortex.staleness.get("backend/pay"), undefined);
    assert.equal(p.cortex.node("backend/pay").staleness, undefined, "reading the node does not warn either");

    p.cortex.project.config.staleness = "off";
    assert.deepEqual(paths(), []);
    assert.equal(p.cortex.brief(p.human).attention.stale_nodes, undefined);

    delete p.cortex.project.config.staleness;
    (p.cortex.project as { dir: string }).dir = join(p.root, "..", "hub-held"); // knowledge outside the code
    assert.equal(p.cortex.staleness.level(), "off");
  } finally {
    p.cleanup();
  }
});

test("line links survive inserted lines and still detect edits at their shifted position", () => {
  const p = gitProject();
  try {
    p.cortex.putNode(p.human, { path: "backend/auth", title: "Auth", summary: "Login.", links: { code: [{ file: "src/auth/login.ts", lines: "40-60" }] } });
    const original = p.cortex.node("backend/auth");
    const file = join(p.root, "src/auth/login.ts");
    p.write("src/auth/login.ts", "// one\n// two\n// three\n" + readFileSync(file, "utf8"));
    p.commit("insert three lines before linked code");
    assert.equal(stale(p.cortex, "backend/auth"), undefined);
    assert.deepEqual(p.cortex.node("backend/auth").links, original.links, "derived offsets never rewrite knowledge");
    assert.equal(p.cortex.node("backend/auth").verified_at_commit, original.verified_at_commit);
    p.edit("src/auth/login.ts", "line 50\n", "line 50 changed\n");
    p.commit("edit inside shifted range");
    assert.equal(stale(p.cortex, "backend/auth")?.severity, "high");
  } finally {
    p.cleanup();
  }
});

test("inserting immediately after a linked range is not a change inside it", () => {
  const p = gitProject();
  try {
    p.cortex.putNode(p.human, { path: "backend/auth", title: "Auth", summary: "Login.", links: { code: [{ file: "src/auth/login.ts", lines: "40-60" }] } });
    p.edit("src/auth/login.ts", "line 60\n", "line 60\nnew outside line\n");
    p.commit("insert outside range");
    assert.equal(stale(p.cortex, "backend/auth"), undefined);
    p.edit("src/auth/login.ts", "line 50\n", "line 50\nnew inside line\n");
    p.commit("insert inside range");
    assert.equal(stale(p.cortex, "backend/auth")?.severity, "high");
  } finally {
    p.cleanup();
  }
});

for (const declaration of [
  'export function selected() {\n  return "}";\n}',
  'export class selected {\n  value() { return "}"; }\n}',
  'export const selected = () => {\n  return "}";\n};',
  'export const selected = "}";',
]) {
  test(`symbol links track only the selected declaration: ${declaration.split("\n")[0]}`, () => {
    const p = gitProject();
    try {
      p.write("src/auth/token.ts", declaration + "\nexport function other() { return 1; }\n");
      const base = p.commit("declare symbols");
      p.cortex.putNode(p.human, {
        path: "backend/auth",
        title: "Auth",
        summary: "Selected.",
        links: { code: [{ file: "src/auth/token.ts", symbol: "selected" }] },
      });
      assert.equal(p.cortex.node("backend/auth").links?.code?.[0].symbol, "selected");
      assert.equal(p.cortex.index.nodeCodeLinks().find((l) => l.path === "backend/auth")?.symbol, "selected");
      p.write("src/auth/token.ts", "// inserted\n// another\n// third\n" + declaration + "\nexport function other() { return 2; }\n");
      p.commit("change unrelated function and shift declaration");
      assert.equal(stale(p.cortex, "backend/auth"), undefined);
      assert.deepEqual(p.cortex.staleness.changesSince(base, [{ file: "src/auth/token.ts", symbol: "selected" }]), []);
      p.edit("src/auth/token.ts", '"}"', '"changed"');
      p.commit("change selected symbol");
      assert.equal(stale(p.cortex, "backend/auth")?.severity, "high");
      assert.equal(stale(p.cortex, "backend/auth")?.changes[0].symbol, "selected");
    } finally {
      p.cleanup();
    }
  });
}

test("missing symbols fall back to file-level changes even with a line range", () => {
  const p = gitProject();
  try {
    p.cortex.putNode(p.human, {
      path: "backend/auth",
      title: "Auth",
      summary: "Unknown symbol.",
      links: { code: [{ file: "src/auth/token.ts", symbol: "missing", lines: "100-110" }] },
    });
    p.write("src/auth/token.ts", "export const ttl = 30;\n");
    p.commit("change file with unresolved symbol");
    assert.equal(stale(p.cortex, "backend/auth")?.severity, "medium");
  } finally {
    p.cleanup();
  }
});

test("symbol scanner ignores comment and literal braces and falls back on ambiguous declarations", () => {
  for (const body of [
    'export function selected() { /* } */ return "}"; }',
    "export const selected = `first\nsecond }`",
    'export const selected = "value"',
    'export function selected(): { value: string } { return { value: "}" }; }',
  ]) {
    assert.equal(symbolBody(body + "\nexport const other = 1;\n", "selected"), body);
  }
  assert.equal(symbolBody("export function selected() { return /}/; }", "selected"), null);
  assert.equal(symbolBody("export function selected(): { a: string } | null { return null; }", "selected"), null);
  assert.equal(symbolBody("export function selected<T extends {}>() { return 1; }", "selected"), null);
  assert.equal(symbolBody("export function selected() {}\nexport function selected() {}", "selected"), null);
  assert.equal(symbolBody("export function selected() {", "selected"), null);
});

test("git hunk context settings do not turn outside edits into linked range changes", () => {
  const p = gitProject();
  try {
    p.cortex.putNode(p.human, { path: "backend/auth", title: "Auth", summary: "Login.", links: { code: [{ file: "src/auth/login.ts", lines: "40-60" }] } });
    p.git("config", "diff.interHunkContext", "100");
    p.edit("src/auth/login.ts", "line 5\n", "line 5 changed\n");
    p.edit("src/auth/login.ts", "line 90\n", "line 90 changed\n");
    p.commit("edit outside both ends of range");
    assert.equal(stale(p.cortex, "backend/auth"), undefined);
  } finally {
    p.cleanup();
  }
});
