import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionStore } from "../src/api/sessions.js";

// The CLI as a user runs it: a child process in an empty folder, from source through tsx (CI tests
// before it builds). Only the exit code, stdout and stderr are looked at.
const CLI = resolve("src/cli.ts");
const TSX = import.meta.resolve("tsx");
const env = { ...process.env, NODE_NO_WARNINGS: "1" };

function cli(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", TSX, CLI, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "cortex-cli-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("cli: init, login, report, reindex and logout in an empty folder", () => {
  const f = folder();
  try {
    const init = cli(f.dir, "init", "--name", "shop", "--lang", "tr", "--branches", "backend,odeme");
    assert.equal(init.code, 0, init.err);
    assert.match(init.out, /Cortex initialized/);
    assert.match(init.out, /owner\s+ctx_/, "the tokens are shown once");
    assert.ok(existsSync(join(f.dir, ".cortex/tree/odeme.md")), "a branch outside the template is accepted");
    assert.match(readFileSync(join(f.dir, ".cortex/.gitignore"), "utf8"), /\.secrets\.yaml/);

    const login = cli(f.dir, "login");
    assert.equal(login.code, 0, login.err);
    assert.match(login.out, /^http:\/\/localhost:\d+\/login\?code=owner\.\d+\./);

    const report = cli(f.dir, "report", "--json", "--since", "7d");
    assert.equal(report.code, 0, report.err);
    assert.equal(JSON.parse(report.out).period.days, 7);
    assert.match(cli(f.dir, "report", "--lang", "tr").out, /^# Cortex raporu/m);

    const reindex = cli(f.dir, "reindex");
    assert.equal(reindex.code, 0, reindex.err);
    assert.match(reindex.out, /\d+ node/);

    new SessionStore(join(f.dir, ".cortex")).create("owner");
    const out = cli(f.dir, "logout");
    assert.equal(out.code, 0, out.err);
    assert.match(out.out, /Ended 1 board session\(s\) for owner/);
  } finally {
    f.cleanup();
  }
});

test("cli: wrong input fails with a message and a non-zero exit code", () => {
  const f = folder();
  try {
    const outside = cli(f.dir, "report");
    assert.notEqual(outside.code, 0, "no .cortex here");
    assert.match(outside.err, /✖/);

    const unknown = cli(f.dir, "frobnicate");
    assert.equal(unknown.code, 1);
    assert.match(unknown.out, /Usage: cortex <command>/);

    const badFlag = cli(f.dir, "init", "--no-such-flag");
    assert.equal(badFlag.code, 1);
    assert.match(badFlag.err, /Unknown option/);

    cli(f.dir, "init", "--name", "x", "--lang", "en", "--branches", "backend");
    const notHuman = cli(f.dir, "login", "--actor", "ai-agent");
    assert.equal(notHuman.code, 1);
    assert.match(notHuman.err, /not a human actor/);
    assert.match(cli(f.dir, "logout", "--actor", "nobody").err, /not a human actor/);

    assert.equal(cli(f.dir, "help").code, 0);

    // --dir points any command at a project elsewhere (MCP clients that do not start in the project folder).
    const other = folder();
    try {
      const made = cli(other.dir, "init", "--dir", join(f.dir, "sub"), "--name", "sub", "--lang", "en", "--branches", "backend");
      assert.equal(made.code, 0, made.err);
      assert.ok(existsSync(join(f.dir, "sub", ".cortex", "cortex.config.yaml")), "created where --dir says, not in the current folder");
      assert.ok(!existsSync(join(other.dir, ".cortex")));
      const away = cli(other.dir, "login", "--dir", join(f.dir, "sub"));
      assert.equal(away.code, 0, away.err);
      assert.match(away.out, /login\?code=owner\./);
    } finally {
      other.cleanup();
    }
    const version = cli(f.dir, "--version");
    assert.equal(version.code, 0);
    assert.equal(version.out.trim(), JSON.parse(readFileSync("package.json", "utf8")).version);
  } finally {
    f.cleanup();
  }
});

test("cli: `mcp` speaks MCP over stdio and lists the tools", async () => {
  const f = folder();
  const init = cli(f.dir, "init", "--name", "x", "--lang", "en", "--branches", "backend");
  assert.equal(init.code, 0, init.err);
  const child = spawn(process.execPath, ["--import", TSX, CLI, "mcp", "--actor", "ai-agent"], { cwd: f.dir, env, stdio: ["pipe", "pipe", "pipe"] });
  try {
    let buf = "";
    const replies: { id?: number; result?: { tools?: { name: string }[]; serverInfo?: unknown } }[] = [];
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) replies.push(JSON.parse(line));
      }
    });
    const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const reply = async (id: number) => {
      for (let i = 0; i < 300; i++) {
        const r = replies.find((x) => x.id === id);
        if (r) return r;
        await new Promise((ok) => setTimeout(ok, 50));
      }
      throw new Error(`no reply to ${id}`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cli-test", version: "1" } },
    });
    const info = (await reply(1)).result?.serverInfo as { name?: string; version?: string } | undefined;
    assert.ok(info, "handshake answered");
    // The server announces the version it ships as, not a number left behind in the code.
    assert.equal(info?.version, JSON.parse(readFileSync("package.json", "utf8")).version);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (await reply(2)).result?.tools?.map((t) => t.name) ?? [];
    assert.ok(tools.includes("cortex_brief") && tools.includes("cortex_log_activity"), tools.join(","));
    // stdout belongs to the protocol: every line on it must be JSON-RPC (the parser above would have thrown).
  } finally {
    child.kill();
    await new Promise((ok) => child.on("exit", ok));
    await new Promise((ok) => setTimeout(ok, 300)); // Windows releases the SQLite files a moment later
    f.cleanup();
  }
});
