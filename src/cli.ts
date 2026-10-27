#!/usr/bin/env node
// node:sqlite prints an ExperimentalWarning on load; hide only that one so the CLI output stays clean.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes("SQLite")) return;
  return (emit as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

import { parseArgs } from "node:util";
// Safe as static imports: neither module loads node:sqlite (which must come after the warning filter above).
import { createLoginCode } from "./api/auth.js";
import { loadTokens } from "./core/project.js";
import { NODE_TOO_OLD_MESSAGE, nodeTooOld } from "./util/runtime-check.js";
import type { BackupTarget } from "./backup/core.js";

const HELP = `Cortex: shared project brain for humans and AIs

Usage: cortex <command> [options]

  init [--name <n>] [--lang tr|en] [--branches a,b,c] [--agent-files]
                                     Create .cortex/ here; --lang = language AIs write in (default: this computer's),
                                     --branches = top-level knowledge branches (asked when run in a terminal)
  start [--port <n>]                 Start the API and the web board on localhost
  login [--actor <id>]               Print a 10-minute login link for the board (default: first human)
  logout [--actor <id>] [--all]      End that person's board sessions on every browser (--all: everyone's)
  mcp [--actor <id>] [--human <id>]  Run as an MCP server over stdio for the project in this folder
                                     (--human: who approvals asked in the chat are recorded as;
                                      --no-elicitation: for clients that claim to ask but do not, relay answers instead;
                                      --tools full: also the rarely used tools (listings, report, archive, discussion
                                      admin, attachments); default core; env CORTEX_TOOLS)
                                     (any command: --dir <project folder> or CORTEX_DIR to point elsewhere)
  mcp --hub <url> --project <id> --token <t> [--human-token <k>]
                                     Same tools against a project on a team server (env: CORTEX_HUB_URL, CORTEX_PROJECT, CORTEX_TOKEN)
                                     (--human-token: your chat key from the board, to approve from the AI chat; env CORTEX_HUMAN_TOKEN)
  bootstrap                          Print the task that lets your AI fill the tree (init also opens it as a task for @ai)
  reindex                            Rebuild the search index from files
  semantic [on|off|status]           Meaning-based search (one-time ~420 MB download, shared by all projects)
  hub init --org <name> --admin-email <e> --admin-name <n> [--public-url <https://...>]
  hub start [--host 0.0.0.0] [--port 4747]    Team server: many projects, people with passwords, AI agents with tokens
  hub add-project <folder> [--id] [--name] [--init [--lang tr] [--branches a,b] [--in-repo]]
                                     Knowledge of a new project lives in the hub's folder (--in-repo: <folder>/.cortex)
  hub move-knowledge <project>       Move a project's <folder>/.cortex into the hub's folder (stop the hub first)
  hub backup [list]                  Back the hub up now (BunnyCDN or Google Drive), or list the backups there
  hub backup setup [--provider bunny|gdrive] [--zone z --region ny --key k] [--google-client-id i --google-client-secret s]
                   [--path p] [--every hours] [--keep n] [--passphrase p]
  hub backup connect-google          Sign in to Google Drive for backups (prints a code to enter on google.com/device)
  hub restore <file|name> --to <dir> Unpack a backup into an empty folder (--passphrase, or CORTEX_BACKUP_PASSPHRASE)
  hub set-path <project> <folder>    Point a project at its code folder on this machine (after a restore or a move)
  hub member <project> <who> [--role contributor] [--scope own] [--branches a,b] [--remove]
                                     Give a person or an AI agent access to a project
  hub pull [project]                 Fast-forward project checkouts from their upstream (hub.yaml pull_minutes: do it on a timer)
  hub invite <email>                 New invite / password-reset link for a user
  backup [list]                      Back this project's knowledge up now (no hub), or list the backups there
  backup setup | connect-google      Same options as hub backup
  backup restore <name|file> [--passphrase p] [--adopt]
                                     Restore .cortex in place; what was there goes to .cortex/.restore/
  report [--since 7d] [--until <date>] [--lang en|tr] [--json] [--out <file>]
                                     What happened, what is waiting, knowledge health (markdown by default)
  version                            Print the installed version (also --version)
`;

async function main() {
  // Before anything touches node:sqlite: a clear message instead of "no such module: fts5".
  if (nodeTooOld()) throw new Error(NODE_TOO_OLD_MESSAGE());
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    const { packageVersion } = await import("./util/version.js");
    console.log(packageVersion());
    return;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      name: { type: "string" },
      port: { type: "string" },
      human: { type: "string" },
      "human-token": { type: "string" },
      "no-elicitation": { type: "boolean" },
      tools: { type: "string" },
      actor: { type: "string" },
      "agent-files": { type: "boolean" },
      branches: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      lang: { type: "string" },
      json: { type: "boolean" },
      out: { type: "string" },
      org: { type: "string" },
      "admin-email": { type: "string" },
      "admin-name": { type: "string" },
      "public-url": { type: "string" },
      host: { type: "string" },
      dir: { type: "string" },
      id: { type: "string" },
      init: { type: "boolean" },
      "in-repo": { type: "boolean" },
      zone: { type: "string" },
      region: { type: "string" },
      key: { type: "string" },
      path: { type: "string" },
      every: { type: "string" },
      keep: { type: "string" },
      to: { type: "string" },
      passphrase: { type: "string" },
      provider: { type: "string" },
      "google-client-id": { type: "string" },
      "google-client-secret": { type: "string" },
      adopt: { type: "boolean" },
      all: { type: "boolean" },
      hub: { type: "string" },
      project: { type: "string" },
      token: { type: "string" },
      role: { type: "string" },
      scope: { type: "string" },
      remove: { type: "boolean" },
    },
    allowPositionals: true,
  });

  const { loadProject } = await import("./core/project.js");
  // Which project: --dir, CORTEX_DIR, or the folder this runs in (searched upwards, like git). MCP clients
  // that do not start servers in the project folder (Claude Desktop) need --dir.
  const projectDir = cmd === "hub" ? undefined : (values.dir ?? process.env.CORTEX_DIR);

  switch (cmd) {
    case "init": {
      const { initProject, AGENT_HINT, defaultBranches, systemLanguage } = await import("./core/init.js");
      const { resolve } = await import("node:path");
      const root = projectDir ? resolve(projectDir) : process.cwd();
      let branches = values.branches
        ?.split(",")
        .map((b) => b.trim())
        .filter(Boolean);
      if (!branches && process.stdin.isTTY && process.stdout.isTTY) branches = await askBranches(defaultBranches(values.lang ?? systemLanguage()));
      const r = initProject(root, values.name, { language: values.lang, branches });
      console.log(`✔ Cortex initialized in ${r.dir}\n`);
      console.log("Actor tokens (stored in .cortex/.secrets.yaml, git-ignored):");
      for (const [id, t] of Object.entries(r.tokens)) console.log(`  ${id.padEnd(10)} ${t}`);
      if (values["agent-files"]) {
        const { appendAgentHint } = await import("./core/agentFiles.js");
        for (const f of appendAgentHint(root, AGENT_HINT)) console.log(`✔ Added Cortex hint to ${f}`);
      }
      console.log(`
Next steps:
  1. npx cortexboard start                start the local API on http://localhost:4747
  2. Add the MCP server to your AI tool, e.g. Claude Code:
       claude mcp add cortex -- npx cortexboard mcp --actor ai-agent
  3. Ask your AI to start: the task that fills the knowledge tree is waiting in its inbox
     (task ${r.bootstrapTask}; \`npx cortexboard bootstrap\` prints the same text to paste anywhere)
`);
      if (r.markdownCandidates.length) {
        console.log(`Found ${r.markdownCandidates.length} markdown file(s) the bootstrap task will import.`);
      }
      break;
    }

    case "start": {
      const { Cortex } = await import("./core/cortex.js");
      const { buildServer } = await import("./api/server.js");
      const project = loadProject(projectDir);
      const cortex = new Cortex(project);
      cortex.watch((e) => console.error(`⚠ reindex failed: ${(e as Error).message}`));
      const port = values.port ? Number(values.port) : project.config.port;
      const { BackupRunner } = await import("./backup/core.js");
      const { projectTarget } = await import("./backup/project.js");
      const backups = new BackupRunner(() => projectTarget(cortex.project));
      const app = buildServer(cortex, { backups });
      await app.listen({ port, host: "127.0.0.1" });
      backups.start();
      console.log(`Cortex "${project.config.project.name}" running at http://localhost:${port}`);
      const human = project.config.actors.find((a) => a.kind === "human");
      if (human) console.log(`Open the board as ${human.id}: ${loginLink(project, human.id, port)}`);
      break;
    }

    case "login": {
      const project = loadProject(projectDir);
      const actor = values.actor ?? project.config.actors.find((a) => a.kind === "human")?.id;
      const found = project.config.actors.find((a) => a.id === actor);
      if (!found || found.kind !== "human") throw new Error(`"${actor ?? ""}" is not a human actor in cortex.config.yaml.`);
      const port = values.port ? Number(values.port) : project.config.port;
      console.log(loginLink(project, found.id, port));
      break;
    }

    case "logout": {
      const { SessionStore } = await import("./api/sessions.js");
      const project = loadProject(projectDir);
      const actor = values.all ? undefined : (values.actor ?? project.config.actors.find((a) => a.kind === "human")?.id);
      if (!values.all && !project.config.actors.some((a) => a.id === actor && a.kind === "human")) {
        throw new Error(`"${actor ?? ""}" is not a human actor in cortex.config.yaml.`);
      }
      // A running server re-reads the session file, so this takes effect without a restart.
      const ended = new SessionStore(project.dir).revokeAll(actor);
      console.log(`✔ Ended ${ended} board session(s)${actor ? ` for ${actor}` : ""}. Open the board again with \`cortexboard login\`.`);
      break;
    }

    case "mcp": {
      const { runMcpStdio } = await import("./mcp/server.js");
      const { localApi, remoteApi, withRemoteHuman } = await import("./mcp/client.js");
      // stdout belongs to the MCP protocol here: never console.log in this branch.
      const hub = values.hub ?? process.env.CORTEX_HUB_URL;
      const tools = values.tools ?? process.env.CORTEX_TOOLS ?? "core";
      if (tools !== "core" && tools !== "full") throw new Error(`--tools is core or full, not "${tools}".`);
      const mcpOpts = { elicitation: !values["no-elicitation"], tools } as const;
      if (hub) {
        // A project on a team server: the agent's token decides its role and what it sees.
        const token = values.token ?? process.env.CORTEX_TOKEN;
        const project = values.project ?? process.env.CORTEX_PROJECT;
        if (!project || !token) throw new Error("With --hub, pass --project <id> and --token <agent token> (or CORTEX_PROJECT / CORTEX_TOKEN).");
        // The person's chat key (made on the board): lets them approve from this AI chat, as themselves.
        const chatKey = values["human-token"] ?? process.env.CORTEX_HUMAN_TOKEN;
        const api = remoteApi(hub, project, token);
        await runMcpStdio(chatKey ? await withRemoteHuman(api, hub, project, chatKey) : api, mcpOpts);
      } else {
        const { Cortex } = await import("./core/cortex.js");
        const cortex = new Cortex(loadProject(projectDir));
        cortex.watch((e) => console.error(`cortex: reindex failed: ${(e as Error).message}`)); // stderr is safe for MCP
        // The person approvals asked in the chat are recorded as: --human, else the first human in the config.
        const humanId = values.human ?? cortex.project.config.actors.find((a) => a.kind === "human")?.id;
        const human = humanId ? cortex.actor(humanId) : undefined;
        if (human && human.kind !== "human") throw new Error(`--human "${human.id}" is not a human actor in cortex.config.yaml.`);
        await runMcpStdio(await localApi(cortex, cortex.actor(values.actor ?? "ai-agent"), { human }), mcpOpts);
      }
      break;
    }

    case "bootstrap": {
      const { bootstrapPrompt, findMarkdown } = await import("./core/init.js");
      const project = loadProject(projectDir);
      const { readGlobalLanguage } = await import("./core/language.js");
      console.log(bootstrapPrompt(project.config.project.name, findMarkdown(project.root), readGlobalLanguage(project.dir)));
      break;
    }

    case "report": {
      const { Cortex } = await import("./core/cortex.js");
      const { reportToMarkdown } = await import("./core/reportMarkdown.js");
      const cortex = new Cortex(loadProject(projectDir), { embedder: null }); // a report never needs the search model
      try {
        const report = cortex.reports.build({ since: values.since, until: values.until });
        const text = values.json ? JSON.stringify(report, null, 2) : reportToMarkdown(report, values.lang === "tr" ? "tr" : "en");
        if (values.out) {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(values.out, text, "utf8");
          console.error(`✔ Report written to ${values.out}`);
        } else console.log(text);
      } finally {
        cortex.close();
      }
      break;
    }

    case "semantic": {
      const rt = await import("./search/runtime.js");
      const sub = process.argv[3] ?? "status";
      if (sub === "status") {
        console.log(`enabled:          ${rt.readSettings().semantic === true ? "yes" : "no"}`);
        console.log(`runtime:          ${rt.runtimeInstalled() ? "installed" : "not installed"}`);
        console.log(`model:            ${rt.MODEL} (${rt.modelDownloaded() ? "downloaded" : "not downloaded"})`);
        console.log(`location:         ${rt.cortexHome()}`);
        if (!rt.semanticEnabled()) console.log("\nSearch is keyword-only. Turn on meaning-based search with: npx cortexboard semantic on");
        break;
      }
      if (sub === "off") {
        rt.writeSettings({ semantic: false });
        console.log("✔ Semantic search off. Files stay in place; `semantic on` re-enables it instantly.");
        break;
      }
      if (sub !== "on") throw new Error(`Unknown option "${sub}". Use on, off or status.`);

      if (!rt.runtimeInstalled()) {
        console.log(`Installing the search runtime into ${rt.cortexHome()} (one time, ~290 MB)…`);
        await rt.installRuntime((line) => console.log(`  ${line}`));
      }
      console.log(`Loading ${rt.MODEL} (one-time download, ~120 MB)…`);
      const { TransformersEmbedder } = await import("./search/embedder.js");
      let lastPct = -10;
      const embedder = new TransformersEmbedder((p) => {
        if (p.status === "progress" && p.file?.endsWith(".onnx") && p.progress !== undefined && p.progress - lastPct >= 10) {
          lastPct = Math.floor(p.progress / 10) * 10;
          console.log(`  ${lastPct}%`);
        }
      });
      // Prove it works end to end before turning it on.
      const [a, b, c] = await embedder.embed(["Ödeme sistemi iyzico", "payment provider", "karpuz fiyatları"]);
      const sim = (x: Float32Array, y: Float32Array) => x.reduce((s, v, i) => s + v * y[i], 0);
      if (!(sim(a, b) > sim(a, c))) throw new Error("The model loaded but produced unexpected results.");
      rt.writeSettings({ semantic: true });
      console.log("✔ Semantic search on. Restart `cortexboard start` / your MCP server; existing content is indexed in the background.");
      break;
    }

    case "hub": {
      await hubCommand(positionals[0], positionals[1], values, positionals[2]);
      break;
    }

    case "reindex": {
      const { Cortex } = await import("./core/cortex.js");
      const cortex = new Cortex(loadProject(projectDir));
      const r = cortex.reindex();
      console.log(`✔ Indexed ${r.nodes} node(s), ${r.items} item(s), ${r.activity} activity entr(ies).`);
      cortex.close();
      break;
    }

    case "backup": {
      const { projectTarget, restoreProject } = await import("./backup/project.js");
      const project = loadProject(projectDir);
      if (positionals[0] === "restore") {
        const src = positionals[1];
        if (!src) throw new Error("Usage: cortexboard backup restore <backup name or file> [--passphrase p] [--adopt]");
        const { existsSync } = await import("node:fs");
        const r = await restoreProject(project, existsSync(src) ? { file: src } : { name: src }, {
          passphrase: values.passphrase ?? process.env.CORTEX_BACKUP_PASSPHRASE,
          adopt: !!values.adopt,
        });
        const { Cortex } = await import("./core/cortex.js");
        const cortex = new Cortex(loadProject(projectDir));
        cortex.reindex();
        cortex.close();
        console.log(`✔ Restored ${r.files} files. What was there is in ${r.aside}. Restart the board and your AI sessions.`);
        break;
      }
      await backupCommand(projectTarget(project), positionals[0], values);
      break;
    }

    default:
      console.log(HELP);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

// The team server: people sign in with email + password, AI agents with tokens, one board for many projects.
async function hubCommand(sub: string | undefined, arg: string | undefined, v: Record<string, string | boolean | undefined>, arg2?: string) {
  const { join, resolve, basename } = await import("node:path");
  const { homedir } = await import("node:os");
  const { existsSync } = await import("node:fs");
  const { HubStore } = await import("./hub/store.js");
  const dir = resolve((v.dir as string | undefined) ?? process.env.CORTEX_HUB ?? join(homedir(), ".cortex", "hub"));
  const str = (k: string) => v[k] as string | undefined;

  if (sub === "init") {
    const email = str("admin-email");
    const name = str("admin-name");
    if (!email || !name)
      throw new Error('Usage: cortexboard hub init --org "Acme" --admin-email you@acme.com --admin-name "Your Name" [--public-url https://cortex.acme.com]');
    const port = Number(str("port") ?? 4747);
    const store = HubStore.init(dir, {
      org: str("org") ?? "My organization",
      host: str("host") ?? "127.0.0.1",
      port,
      ...(str("public-url") ? { public_url: str("public-url")!.replace(/\/+$/, "") } : {}),
    });
    const admin = store.createUser({ email, name, org_admin: true });
    const url = `${store.settings.public_url ?? `http://localhost:${port}`}/invite/${store.createInvite(admin.id)}`;
    store.close();
    console.log(`✔ Hub created in ${dir} (keep this folder private: it holds password hashes)\n`);
    console.log(`Start it:            cortexboard hub start`);
    console.log(`Then set your password (link valid 48 hours):\n  ${url}\n`);
    console.log(`Add a project:       cortexboard hub add-project <folder>   (or from the board: Organization → Projects)`);
    return;
  }

  if (sub === "restore") {
    const to = str("to");
    if (!arg || !to) throw new Error("Usage: cortexboard hub restore <file or backup name> --to <empty folder> [--passphrase p]");
    const b = await import("./hub/backup.js");
    const r = await b.restoreBackup(
      existsSync(join(dir, "hub.yaml")) ? new HubStore(dir) : null,
      arg,
      resolve(to),
      str("passphrase") ?? process.env.CORTEX_BACKUP_PASSPHRASE,
    );
    console.log(`✔ Restored ${r.files} files into ${r.to}. hub/ is a hub folder (start it with --dir); repo-projects/<id>/ are .cortex folders.`);
    return;
  }

  if (sub === "start") {
    // A restore staged from the board is applied before the database is opened.
    const { applyPendingRestore } = await import("./hub/backup.js");
    const r = applyPendingRestore(dir);
    if (r) {
      console.log(`✔ Restored ${r.name}. The hub as it was is in ${r.aside} (to go back: stop the hub and rename it back).`);
      if (r.repoProjects.length)
        console.log(
          `  .cortex of ${r.repoProjects.join(", ")} (knowledge kept in their repositories) is in ${join(dir, "restored-repo-projects")}: copy it back by hand if needed.`,
        );
      console.log("  Check each project's code folder under Organization → Projects.");
    }
  }

  const store = new HubStore(dir);
  try {
    if (sub === "start") {
      const { Hub, buildHubServer } = await import("./hub/server.js");
      const host = str("host") ?? store.settings.host ?? "127.0.0.1";
      const port = Number(str("port") ?? store.settings.port ?? 4747);
      if (str("public-url")) store.settings.public_url = str("public-url")!.replace(/\/+$/, "");
      store.settings.port = port;
      store.settings.host = host; // the cookie's Secure default depends on where it really listens
      const hub = new Hub(store);
      const app = buildHubServer(hub);
      // After a restart from the board the old process may still hold the port for a moment.
      for (let i = 0; ; i++) {
        try {
          await app.listen({ host, port });
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || i >= 20) throw e;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      hub.restarter = async () => {
        await app.close();
        store.close();
        await restartSelf();
      };
      hub.startPulling(Number(store.settings.pull_minutes ?? 0));
      hub.startCommitting(Number(store.settings.commit_seconds ?? 60));
      hub.startBackups();
      if (store.settings.pull_minutes) console.log(`Pulling every project from its upstream every ${store.settings.pull_minutes} min (fast-forward only).`);
      console.log(`Cortex hub "${store.settings.org}" running at http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
      if (host !== "127.0.0.1" && host !== "localhost" && !(store.settings.public_url ?? "").startsWith("https://")) {
        console.log("⚠ Listening on the network without HTTPS. Put it behind a reverse proxy with TLS and set public_url to the https address.");
        console.log("  Session cookies are Secure here, so plain-http sign-in will not stick (cookie_secure: false in hub.yaml turns that off, knowingly).");
      }
      return; // keep running
    }
    if (sub === "add-project") {
      if (!arg)
        throw new Error("Usage: cortexboard hub add-project <folder> [--id shop] [--name Shop] [--init [--lang tr] [--branches backend,frontend] [--in-repo]]");
      const { registerProject } = await import("./hub/knowledge.js");
      const r = await registerProject(store, {
        path: arg,
        id: str("id"),
        name: str("name"),
        init: !!v.init,
        language: str("lang"),
        branches: str("branches")
          ?.split(",")
          .map((b) => b.trim())
          .filter(Boolean),
        knowledge: v["in-repo"] ? "repo" : "hub",
      });
      if (r.created)
        console.log(
          `✔ Created ${r.created.dir}. The first AI agent you connect finds the task that fills the knowledge tree in its inbox (${r.created.bootstrapTask}).`,
        );
      console.log(
        `✔ Project "${r.name}" registered as ${r.id}; its knowledge is ${r.where === "hub" ? "in the hub's folder" : `in ${r.path}/.cortex`}. Organization admins can open it; add members on the board.`,
      );
      return;
    }
    if (sub === "backup") {
      const { hubTarget } = await import("./hub/backup.js");
      await backupCommand(hubTarget(store), arg, v);
      return;
    }
    if (sub === "set-path") {
      const folder = arg2;
      if (!arg || !folder) throw new Error("Usage: cortexboard hub set-path <project> <folder>   (or Organization → Projects on the board)");
      if (!existsSync(resolve(folder))) throw new Error(`Folder not found: ${resolve(folder)}`);
      const p = store.setProjectPath(arg, resolve(folder));
      console.log(`✔ ${p.id} now points at ${p.path}. A running hub picks it up after a restart.`);
      return;
    }
    if (sub === "move-knowledge") {
      if (!arg) throw new Error("Usage: cortexboard hub move-knowledge <project>   (stop the hub first)");
      const { moveKnowledge } = await import("./hub/knowledge.js");
      const r = await moveKnowledge(store, arg);
      console.log(`✔ Moved ${r.from} → ${r.to}. The hub commits it there and never pushes.`);
      if (r.leftover) console.log(`  Could not delete ${r.leftover}; the hub no longer reads it. Delete it by hand.`);
      if (r.tracked)
        console.log(`  .cortex was committed in the code repository: commit its removal there (git rm -r --cached .cortex, or just commit the deletion).`);
      console.log("  Start the hub again to serve it from its new place.");
      return;
    }
    // Granting access from the machine that runs the hub: the same thing the board's Members page does,
    // for a terminal. Whoever can run this already owns the hub's files.
    if (sub === "member") {
      const projectId = arg;
      const who = arg2 ?? str("id");
      if (!projectId || !who) {
        throw new Error("Usage: cortexboard hub member <project> <user or agent> [--role contributor] [--scope all|own] [--branches a,b] [--remove]");
      }
      if (v.remove) {
        if (!store.member(projectId, who)) throw new Error(`"${who}" is not a member of "${projectId}".`);
        store.removeMember(projectId, who);
        console.log(`✔ ${who} removed from ${projectId}.`);
        store.close();
        return;
      }
      const branches = str("branches")
        ?.split(",")
        .map((b) => b.trim())
        .filter(Boolean);
      const m = store.setMember(projectId, who, {
        ...(str("role") ? { role: str("role") } : {}),
        ...(str("scope") ? { scope: str("scope") } : {}),
        ...(branches ? { branches } : {}),
      });
      console.log(
        `✔ ${m.principal} (${m.kind}) is ${m.role} on ${projectId}, sees ${m.scope === "all" ? "everything" : "only its own records"}${m.branches.length ? `, branches: ${m.branches.join(", ")}` : ""}.`,
      );
      console.log("A running hub applies this on the next request; no restart needed.");
      store.close();
      return;
    }
    // Fast-forward project checkouts from their upstream, now. The hub never commits or pushes.
    if (sub === "pull") {
      const { pullProject } = await import("./hub/gitSync.js");
      const projects = arg ? [store.project(arg)].filter((p) => !!p) : store.projects();
      if (arg && !projects.length) throw new Error(`No project "${arg}".`);
      for (const p of projects) {
        const r = await pullProject(p.path);
        const mark = r.status === "failed" ? "✖" : r.status === "skipped" ? "–" : "✔";
        console.log(`${mark} ${p.id}: ${r.message}${r.pending ? ` ${r.pending} .cortex change(s) wait for a commit.` : ""}`);
      }
      store.close();
      return;
    }
    if (sub === "invite") {
      const u = arg ? store.userByEmail(arg) : null;
      if (!u) throw new Error("Usage: cortexboard hub invite <email of an existing user>");
      console.log(`${store.settings.public_url ?? `http://localhost:${store.settings.port}`}/invite/${store.createInvite(u.id)}`);
      console.log("Valid 48 hours, once. Setting a password ends that user's other sessions.");
      store.close();
      return;
    }
    throw new Error("Usage: cortexboard hub init | start | add-project <folder> | member <project> <who> | pull [project] | invite <email>");
  } catch (e) {
    store.close();
    throw e;
  }
}

// "1,2,5 api-gateway" -> template branches 1, 2, 5 plus a custom one. Enter keeps them all.
async function askBranches(template: [string, string, string][]): Promise<string[] | undefined> {
  const { createInterface } = await import("node:readline/promises");
  console.log("Which top-level knowledge branches does this project need?");
  template.forEach(([path, title], i) => console.log(`  ${i + 1}. ${path.padEnd(16)} ${title}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Numbers and/or new names, separated by commas or spaces [Enter = all]: ")).trim();
    if (!answer) return undefined;
    return answer
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((a) => (/^\d+$/.test(a) ? template[Number(a) - 1]?.[0] : a))
      .filter((a): a is string => !!a);
  } finally {
    rl.close();
  }
}

function loginLink(project: { dir: string }, actorId: string, port: number): string {
  const token = loadTokens(project.dir)[actorId];
  if (!token) throw new Error(`No token for "${actorId}" in .cortex/.secrets.yaml.`);
  return `http://localhost:${port}/login?code=${encodeURIComponent(createLoginCode(actorId, token))}`;
}

// Starts this same command again and exits. Under systemd (or with CORTEX_RESTART=exit) it only exits, with a
// code the service manager restarts on. On Windows the new hub gets its own console window.
async function restartSelf(): Promise<never> {
  if (process.env.INVOCATION_ID || process.env.CORTEX_RESTART === "exit") process.exit(75);
  const { spawn } = await import("node:child_process");
  const args = [...process.execArgv, ...process.argv.slice(1)];
  if (process.platform === "win32") {
    const q = (a: string) => `"${a.replace(/"/g, '""')}"`;
    spawn("cmd.exe", ["/d", "/c", `start "Cortex Hub" cmd /k "${[process.execPath, ...args].map(q).join(" ")}"`], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: true,
    }).unref();
  } else spawn(process.execPath, args, { cwd: process.cwd(), detached: true, stdio: "inherit" }).unref();
  process.exit(0);
}

// `backup` and `hub backup`: setup, list, connect-google, or a backup now.
async function backupCommand(t: BackupTarget, sub: string | undefined, v: Record<string, string | boolean | undefined>): Promise<void> {
  const b = await import("./backup/core.js");
  const str = (k: string) => v[k] as string | undefined;
  if (sub === "setup") {
    const provider = str("provider");
    if (provider && provider !== "bunny" && provider !== "gdrive") throw new Error("--provider bunny or gdrive");
    const r = b.configureBackup(t, {
      ...(provider ? { provider: provider as "bunny" | "gdrive" } : {}),
      storage_zone: str("zone"),
      region: str("region"),
      path: str("path"),
      interval_hours: str("every") === undefined ? undefined : Number(str("every")),
      keep: str("keep") === undefined ? undefined : Number(str("keep")),
      access_key: str("key") ?? process.env.CORTEX_BACKUP_KEY,
      passphrase: str("passphrase") ?? process.env.CORTEX_BACKUP_PASSPHRASE,
      google_client_id: str("google-client-id"),
      google_client_secret: str("google-client-secret") ?? process.env.CORTEX_GOOGLE_CLIENT_SECRET,
    });
    const where = r.settings.provider === "gdrive" ? `Google Drive folder "${r.settings.path}"` : `${r.settings.storage_zone}/${r.settings.path}`;
    console.log(
      `✔ Backups go to ${where}${r.settings.interval_hours ? `, every ${r.settings.interval_hours} h` : ", on request"}, newest ${r.settings.keep} kept.`,
    );
    if (r.passphrase) console.log(`\n  Archive passphrase (shown once, store it somewhere other than this machine):\n  ${r.passphrase}\n`);
    if (r.passphrase_changed) console.log("  The passphrase changed: older backups still open only with the old one.");
    if (r.settings.provider === "gdrive" && !b.backupStatus(t).google.connected) console.log("  Next: connect-google to sign in to Google Drive.");
    return;
  }
  if (sub === "connect-google") {
    const s = await b.googleConnectStart(t);
    console.log(`Open ${s.verification_url} and enter the code  ${s.user_code}  (valid ${Math.round(s.expires_in / 60)} min).`);
    for (;;) {
      await new Promise((r) => setTimeout(r, s.interval * 1000));
      const r = await b.googleConnectPoll(t);
      if (r.status === "pending") continue;
      if (r.status !== "connected") throw new Error(r.status === "denied" ? "Access was denied." : "The code expired; run this again.");
      console.log(`✔ Google Drive connected.${r.message ? ` But: ${r.message}` : ""}`);
      return;
    }
  }
  if (sub === "list") {
    for (const x of await b.listBackups(t)) console.log(`${x.name}  ${(x.bytes / 1024).toFixed(0)} KB  ${x.at}`);
    return;
  }
  if (sub) throw new Error(`Unknown: backup ${sub}. Use setup, list, connect-google, or nothing to back up now.`);
  const r = await new b.BackupRunner(() => t).now();
  console.log(`${r.status === "ok" ? "✔" : "✖"} ${r.message}${r.deleted?.length ? ` Deleted ${r.deleted.length} old.` : ""}`);
  if (r.status !== "ok") process.exitCode = 1;
}

main().catch((e) => {
  console.error(`✖ ${e?.message ?? e}`);
  process.exit(1);
});
