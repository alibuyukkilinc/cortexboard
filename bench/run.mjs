// One run = one agent + model + arm through all tasks, each task in its own fresh session (no chat memory
// between them: whatever the next session knows, the project had to keep). Scores each task right after it.
//   node bench/run.mjs --agent claude --model claude-sonnet-5-5 --arm cortex
//   node bench/run.mjs --agent codex  [--model gpt-6-astra] [--effort medium] --arm baseline
//   options: --tasks T1,T2  --label note  --timeout-min 20  --resume <run id>
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { escapes, scoreTask, selfReport, snapshot, voids } from "./checks.mjs";
import { args, CORTEX_CLI, ensureDir, FIXTURES, git, readJson, RESULTS, RUNS, stamp, tasks, writeJson } from "./lib.mjs";

const opts = args();
// --resume <run id>: carry on a run that stopped (usage limit, crash) in the same copy of the repo, keeping the
// tasks that completed; later tasks depend on what earlier ones left, so a stopped run is not started over.
const prev = typeof opts.resume === "string" ? readJson(join(RESULTS, `${opts.resume}.json`)) : null;
if (opts.resume && !prev) throw new Error(`no result for run ${opts.resume}`);
const agent = prev?.agent ?? opts.agent ?? "claude";
const arm = prev?.arm ?? opts.arm ?? "cortex";
if (!["claude", "codex", "opencode"].includes(agent)) throw new Error("--agent claude|codex|opencode");
if (!["cortex", "baseline"].includes(arm)) throw new Error("--arm cortex|baseline");
const model = prev ? (prev.model === "default" ? undefined : prev.model) : opts.model === true ? undefined : opts.model;
const effort = prev ? (prev.effort ?? undefined) : opts.effort === true ? undefined : opts.effort;
const timeoutMs = Number(opts["timeout-min"] ?? 20) * 60_000;
const suite = tasks();
const only = typeof opts.tasks === "string" ? new Set(opts.tasks.split(",")) : null;
const firstFailed = prev ? prev.tasks.findIndex((t) => t.is_error || t.timed_out) : -1;
const kept = prev ? prev.tasks.slice(0, firstFailed < 0 ? prev.tasks.length : firstFailed) : [];
const list = suite.tasks.filter((t) => (!only || only.has(t.id)) && !kept.some((k) => k.id === t.id));

const fixture = join(FIXTURES, arm);
if (!existsSync(fixture)) throw new Error(`no fixture at ${fixture}: run node bench/prepare.mjs first`);
const fixtureMeta = readJson(join(FIXTURES, "fixture.json"), {});
const short = (model ?? "default").replace(/^claude-/, "").replace(/[^a-z0-9.-]/gi, "-");
const runId = prev?.run_id ?? `${agent}-${short}${effort ? `-${effort}` : ""}-${arm}-${stamp()}`;
const dir = ensureDir(join(RUNS, runId));
const repo = join(dir, "repo");

if (!prev) {
  cpSync(fixture, repo, { recursive: true, filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src) });
  symlinkSync(join(FIXTURES, "base", "node_modules"), join(repo, "node_modules"), "junction");
}
// The fixture's tip (the planted-bug commit): what every check compares against, even if the agent committed.
const baseSha = git(repo, "log", "--format=%H", "-1", "--grep=Reports: simplify period setup");
const logs = ensureDir(join(dir, "logs"));
const answers = ensureDir(join(dir, "answers"));

// The cortex arm's MCP server: the published package against this run's copy, as the project's AI agent.
const mcpArgs = [CORTEX_CLI, "mcp", "--dir", repo, "--actor", "ai-agent", "--no-elicitation"];
const claudeMcp = join(dir, "mcp.json");
writeFileSync(claudeMcp, JSON.stringify({ mcpServers: arm === "cortex" ? { cortex: { command: process.execPath, args: mcpArgs } } : {} }));
const claudeSettings = join(dir, "settings.json");
writeFileSync(claudeSettings, JSON.stringify({ autoMemoryEnabled: false }));

// The CLIs. New models need new builds (an old one gets "requires a newer version"), and the desktop apps keep
// theirs more current than a global npm install, so the newest desktop build wins; BENCH_CLAUDE / BENCH_CODEX
// override. A .js path runs under this Node.
const npmRoot = join(process.env.APPDATA ?? "", "npm", "node_modules");
const local = process.env.LOCALAPPDATA ?? "";
function newest(paths, by) {
  return paths.filter((p) => existsSync(p)).sort(by)[0];
}
const semverDesc = (a, b) => b.localeCompare(a, undefined, { numeric: true });
const mtimeDesc = (a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs;
const children = (dir, f) => (existsSync(dir) ? readdirSync(dir).map((d) => f(join(dir, d))) : []);
const CLAUDE_BIN =
  process.env.BENCH_CLAUDE ??
  newest(
    children(join(local, "Packages"), (p) => p)
      .filter((p) => /[\\/]Claude_/.test(p))
      .flatMap((p) => children(join(p, "LocalCache", "Roaming", "Claude", "claude-code"), (v) => join(v, "claude.exe"))),
    semverDesc,
  ) ??
  join(npmRoot, "@anthropic-ai", "claude-code", "bin", process.platform === "win32" ? "claude.exe" : "claude");
const CODEX_BIN =
  process.env.BENCH_CODEX ??
  newest(
    children(join(local, "OpenAI", "Codex", "bin"), (d) => join(d, "codex.exe")),
    mtimeDesc,
  ) ??
  join(npmRoot, "@openai", "codex", "bin", "codex.js");
const OPENCODE_BIN = process.env.BENCH_OPENCODE ?? join(npmRoot, "@opencode", "cli", "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
const viaNode = (bin, a) => (bin.endsWith(".js") ? { cmd: process.execPath, args: [bin, ...a] } : { cmd: bin, args: a });

const toml = (v) => JSON.stringify(v); // TOML basic strings and arrays of them read like JSON

function command(prompt) {
  if (agent === "claude") {
    const a = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"];
    a.push("--strict-mcp-config", "--mcp-config", claudeMcp, "--settings", claudeSettings, "--no-session-persistence");
    a.push("--disallowedTools", "Agent,Task,WebFetch,WebSearch");
    if (model) a.push("--model", model);
    if (effort) a.push("--effort", effort);
    return { cmd: CLAUDE_BIN, args: a, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } };
  }
  if (agent === "opencode") {
    // OpenCode 2.x: its own server per session (--standalone), JSON events, permissions auto-approved. The MCP
    // server comes in through OPENCODE_CONFIG_CONTENT (mcp.servers.<name>), so nothing is written into the repo.
    const a = ["run", "--standalone", "--format", "json", "--auto"];
    if (model) a.push("-m", effort ? `${model}#${effort}` : model);
    a.push(prompt);
    const config = {
      $schema: "https://opencode.ai/config.json",
      mcp: { servers: arm === "cortex" ? { cortex: { type: "local", command: [process.execPath, ...mcpArgs] } } : {} },
    };
    return { cmd: OPENCODE_BIN, args: a, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } };
  }
  const a = ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--cd", repo];
  // The owner's own Codex config connects to the real hub; switch that off so both arms see only this copy.
  a.push("-c", "mcp_servers.cortex.enabled=false", "-c", "mcp_servers.node_repl.enabled=false", "-c", "notify=[]");
  if (arm === "cortex") {
    a.push("-c", `mcp_servers.cortex_bench.command=${toml(process.execPath)}`);
    a.push("-c", `mcp_servers.cortex_bench.args=[${mcpArgs.map(toml).join(",")}]`);
    a.push("-c", "mcp_servers.cortex_bench.startup_timeout_sec=60");
  }
  if (model) a.push("-m", model);
  if (effort) a.push("-c", `model_reasoning_effort=${toml(effort)}`);
  a.push("-");
  return { ...viaNode(CODEX_BIN, a), env: {} };
}

function runSession(prompt, logFile) {
  const { cmd, args: a, env } = command(prompt);
  return new Promise((resolveP) => {
    const started = Date.now();
    const child = spawn(cmd, a, { cwd: repo, env: { ...childEnv(), PWD: repo, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(logFile, out);
      if (err) writeFileSync(logFile.replace(/\.jsonl$/, ".stderr.txt"), err);
      resolveP({ code, wall_ms: Date.now() - started, timedOut: Date.now() - started >= timeoutMs, out, err });
    });
    child.stdin.end(prompt);
  });
}

const lines = (s) =>
  s
    .split(/\r?\n/)
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

function parseClaude(out) {
  const m = { tool_calls: 0, tool_errors: 0, cortex_calls: 0, tools: {}, answer: "", turns: 0, mcp_status: null };
  let result = null;
  for (const e of lines(out)) {
    if (e.type === "system" && e.subtype === "init") m.mcp_status = (e.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`).join(",") || null;
    if (e.type === "assistant")
      for (const c of e.message?.content ?? [])
        if (c.type === "tool_use") {
          m.tool_calls++;
          m.tools[c.name] = (m.tools[c.name] ?? 0) + 1;
          if (/cortex/i.test(c.name)) m.cortex_calls++;
        }
    if (e.type === "user") for (const c of e.message?.content ?? []) if (c.type === "tool_result" && c.is_error) m.tool_errors++;
    if (e.type === "result") result = e;
  }
  if (result) {
    const u = result.usage ?? {};
    m.answer = result.result ?? "";
    m.turns = result.num_turns ?? 0;
    m.api_ms = result.duration_api_ms ?? null;
    m.cost_usd = result.total_cost_usd ?? null;
    m.is_error = Boolean(result.is_error);
    m.input_tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    m.cached_input_tokens = u.cache_read_input_tokens ?? 0;
    m.output_tokens = u.output_tokens ?? 0;
    m.models = Object.keys(result.modelUsage ?? {});
  } else m.is_error = true;
  return m;
}

// OpenCode: tool_use parts (part.tool, part.state.status), step_finish parts with tokens and cost per step, and
// text parts; the answer is the text of the last message.
function parseOpencode(out) {
  const m = {
    tool_calls: 0,
    tool_errors: 0,
    cortex_calls: 0,
    tools: {},
    answer: "",
    turns: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    is_error: false,
  };
  const texts = new Map();
  let last = null;
  for (const e of lines(out)) {
    const p = e.part ?? {};
    if (e.type === "tool_use") {
      m.tool_calls++;
      m.tools[p.tool] = (m.tools[p.tool] ?? 0) + 1;
      if (/cortex/i.test(p.tool ?? "")) m.cortex_calls++;
      // OpenCode 2 also reaches MCP tools from code: execute({ code: 'tools["cortex"].cortex_brief(...)' }).
      else if (p.tool === "execute")
        m.cortex_calls += (String(p.state?.input?.code ?? "").match(/tools\[["']cortex["']\]\.cortex_\w+|tools\.cortex\.cortex_\w+/g) ?? []).length;
      if (p.state?.status === "error") m.tool_errors++;
    }
    if (e.type === "step_finish") {
      m.turns++;
      const t = p.tokens ?? {};
      m.input_tokens += (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
      m.cached_input_tokens += t.cache?.read ?? 0;
      m.output_tokens += (t.output ?? 0) + (t.reasoning ?? 0);
      m.cost_usd += p.cost ?? 0;
    }
    if (e.type === "text" && p.text) {
      texts.set(p.messageID, (texts.get(p.messageID) ?? "") + p.text);
      last = p.messageID;
    }
    if (e.type === "error") m.is_error = true;
  }
  m.answer = last ? texts.get(last) : "";
  if (!m.turns) m.is_error = true;
  return m;
}

function parseCodex(out) {
  const m = {
    tool_calls: 0,
    tool_errors: 0,
    cortex_calls: 0,
    tools: {},
    answer: "",
    turns: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    cost_usd: null,
    is_error: false,
  };
  for (const e of lines(out)) {
    if (e.type === "turn.completed") {
      m.turns++;
      m.input_tokens += e.usage?.input_tokens ?? 0;
      m.cached_input_tokens += e.usage?.cached_input_tokens ?? 0;
      m.output_tokens += (e.usage?.output_tokens ?? 0) + (e.usage?.reasoning_output_tokens ?? 0);
    }
    if (e.type === "turn.failed" || e.type === "error") m.is_error = true;
    if (e.type === "item.completed" && e.item) {
      const it = e.item;
      if (it.type === "agent_message") m.answer = it.text ?? m.answer;
      const tool =
        it.type === "command_execution" ? "shell" : it.type === "mcp_tool_call" ? `${it.server}.${it.tool}` : it.type === "file_change" ? "file_change" : null;
      if (tool) {
        m.tool_calls++;
        m.tools[tool] = (m.tools[tool] ?? 0) + 1;
        if (/cortex/i.test(tool)) m.cortex_calls++;
        if (it.status === "failed" || (it.type === "command_execution" && it.exit_code && it.exit_code !== 0)) m.tool_errors++;
      }
    }
  }
  return m;
}

const results = [...kept];
const meta = {
  ...(prev ? { resumed_at: [...(prev.resumed_at ?? []), new Date().toISOString()] } : {}),
  run_id: runId,
  round: suite.round,
  agent,
  model: model ?? "default",
  // "default" is whatever the CLI is configured with; name it, so the report does not say "default".
  model_resolved: model ?? (agent === "codex" ? codexConfiguredModel() : null),
  effort: effort ?? null,
  arm,
  label: opts.label ?? null,
  // What the agent actually ran on: the CLI build, and an effort inherited from the environment (Claude Code
  // passes CLAUDE_EFFORT to child processes) when --effort is not given.
  cli: (() => {
    const v = viaNode(agent === "claude" ? CLAUDE_BIN : agent === "opencode" ? OPENCODE_BIN : CODEX_BIN, ["--version"]);
    return spawnSync(v.cmd, v.args, { encoding: "utf8" }).stdout?.trim();
  })(),
  env_effort: agent === "claude" && !effort ? (process.env.CLAUDE_EFFORT ?? null) : null,
  fixture: fixtureMeta,
  started_at: prev?.started_at ?? new Date().toISOString(),
};
const save = () => writeJson(join(RESULTS, `${runId}.json`), { ...meta, finished_at: new Date().toISOString(), tasks: results });

console.log(`[run] ${runId}: ${list.length} tasks in ${repo}`);
for (const task of list) {
  const before = snapshot(repo, baseSha);
  const prompt = task.prompt + suite.suffix;
  const s = await runSession(prompt, join(logs, `${task.id}.jsonl`));
  const m = agent === "claude" ? parseClaude(s.out) : agent === "opencode" ? parseOpencode(s.out) : parseCodex(s.out);
  writeFileSync(join(answers, `${task.id}.md`), m.answer);
  const score = scoreTask(task, { repo, baseSha, before, answer: m.answer });
  // A session that never started (API error, not logged in) earns nothing, not even "left the tests alone".
  if (m.is_error && m.tool_calls === 0) for (const c of score.checks) c.got = score.got = 0;
  // Reading the real project's knowledge from outside this copy voids the task (see escapes() in checks.mjs).
  const outside = escapes(s.out, agent);
  if (voids(outside)) for (const c of score.checks) c.got = score.got = 0;
  const entry = {
    id: task.id,
    title: task.title,
    kind: task.kind,
    wall_ms: s.wall_ms,
    exit_code: s.code,
    timed_out: s.timedOut,
    ...m,
    ...selfReport(m.answer),
    score,
    outside,
    voided: voids(outside),
  };
  delete entry.answer;
  entry.answer_excerpt = m.answer.slice(0, 4000);
  results.push(entry);
  save();
  const tok = ((m.input_tokens + m.output_tokens) / 1000).toFixed(1);
  console.log(
    `[run] ${task.id} ${score.got}/${score.max}  ${(s.wall_ms / 1000).toFixed(0)} s  ${tok}K tok  ${m.tool_calls} calls (${m.tool_errors} err)${m.cost_usd != null ? `  $${m.cost_usd.toFixed(3)}` : ""}`,
  );
}
save();
const total = results.reduce((a, r) => a + r.score.got, 0);
const max = results.reduce((a, r) => a + r.score.max, 0);
console.log(`[run] done ${runId}: ${total}/${max} -> ${join(RESULTS, `${runId}.json`)}`);

function codexConfiguredModel() {
  try {
    const home = process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex");
    return /^model\s*=\s*"([^"]+)"/m.exec(readFileSync(join(home, "config.toml"), "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}

// Secrets of the owner's own setup (a live hub token, a chat key) never reach the agents under test.
function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^CORTEX_.*(TOKEN|KEY|SECRET)/i.test(k)) delete env[k];
  return env;
}
