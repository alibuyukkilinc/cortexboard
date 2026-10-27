// Install smoke test: the spec's "a clean machine with only Node runs init + start in under 2 minutes".
// Packs this repo (run `npm run build` first), installs the tarball into an empty folder, then runs
// `cortexboard init` through the npm bin shim and `cortexboard start`, and checks the API, the brief and the board.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Two budgets. The acceptance criterion is about a clean machine: install, init and start inside two
// minutes. `npm install` on a shared CI runner is network and disk, not Cortex, so that total is
// adjustable there (SMOKE_LIMIT_MS); what Cortex itself does after the install is not.
const LIMIT_MS = Number(process.env.SMOKE_LIMIT_MS ?? 120_000);
const CORTEX_LIMIT_MS = 45_000;
const repo = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "cortexboard-smoke-"));
const app = join(work, "app");
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
// npm with an argument list, never a command string: no shell, so the temp folder's path (spaces, quotes)
// cannot be misread. Under `npm run`, npm_execpath is npm's own JS entry, run with this Node on every OS.
// Without it, POSIX runs the npm binary directly; only Windows needs a shell, because npm is a .cmd there.
const npm = (args, cwd) => {
  const opts = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] };
  const cli = process.env.npm_execpath;
  if (cli && /\.c?js$/.test(cli)) return execFileSync(process.execPath, [cli, ...args], opts);
  if (process.platform !== "win32") return execFileSync("npm", args, opts);
  return execFileSync(
    "npm",
    args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)),
    { ...opts, shell: true },
  );
};

let server;
try {
  const [packed] = JSON.parse(npm(["pack", "--json", "--pack-destination", work], repo));
  const tarball = join(work, packed.filename);
  step(`packed ${packed.filename} (${(packed.size / 1024).toFixed(0)} KB, ${packed.entryCount} files)`);
  if (!packed.files.some((f) => f.path === "dist/web/index.html")) throw new Error("The package does not contain the built board (dist/web/index.html).");
  // Source maps are two thirds of the unpacked size and nothing reads them at runtime.
  const maps = packed.files.filter((f) => f.path.endsWith(".map"));
  if (maps.length) throw new Error(`The package ships ${maps.length} source map(s), e.g. ${maps[0].path}.`);

  execFileSync(process.execPath, ["-e", "require('fs').mkdirSync(process.argv[1])", app]);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "smoke-app", private: true }));
  npm(["install", "--no-audit", "--no-fund", tarball], app);
  const installed = Date.now();
  step("installed into an empty folder");

  const init = npm(["exec", "--no", "--", "cortexboard", "init", "--name", "smoke", "--lang", "en", "--branches", "backend,frontend"], app);
  if (!init.includes("Cortex initialized")) throw new Error(`init did not report success:\n${init}`);
  step("cortexboard init");

  const port = 4800 + Math.floor(Math.random() * 500);
  const bin = JSON.parse(readFileSync(join(app, "node_modules/cortexboard/package.json"), "utf8")).bin.cortexboard;
  server = spawn(process.execPath, [join(app, "node_modules/cortexboard", bin), "start", "--port", String(port)], {
    cwd: app,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  server.stdout.on("data", (d) => (out += d));
  server.stderr.on("data", (d) => (out += d));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (server.exitCode !== null || i > 300) throw new Error(`The server did not come up:\n${out}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  step("cortexboard start: API is up");

  const token = /owner:\s*(\S+)/.exec(readFileSync(join(app, ".cortex/.secrets.yaml"), "utf8"))[1];
  const brief = await (await fetch(`${base}/api/brief`, { headers: { authorization: `Bearer ${token}` } })).json();
  const branches = brief.branches?.map((b) => b.path).join(",");
  if (brief.project?.name !== "smoke" || branches !== "backend,frontend") throw new Error(`Unexpected brief: ${JSON.stringify(brief).slice(0, 300)}`);
  if (!/English \(en\)/.test(brief.rules?.global?.[0] ?? "")) throw new Error("The language rule is missing from the brief.");
  const board = await (await fetch(`${base}/`)).text();
  if (!board.includes('<div id="root">')) throw new Error("The board is not served.");
  step("brief, language rule and board OK");

  const elapsed = Date.now() - t0;
  const cortexMs = Date.now() - installed;
  console.log(
    `
✔ pack + install + init + start in ${(elapsed / 1000).toFixed(1)} s (limit ${LIMIT_MS / 1000} s), ` +
      `of which Cortex's own init + start ${(cortexMs / 1000).toFixed(1)} s (limit ${CORTEX_LIMIT_MS / 1000} s)`,
  );
  if (cortexMs > CORTEX_LIMIT_MS) {
    console.error(`✖ init + start took ${(cortexMs / 1000).toFixed(1)} s, over the ${CORTEX_LIMIT_MS / 1000} s budget.`);
    process.exitCode = 1;
  } else if (elapsed > LIMIT_MS) {
    console.error(`✖ The whole run took ${(elapsed / 1000).toFixed(1)} s, over the ${LIMIT_MS / 1000} s limit (install included).`);
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`✖ ${e.message}`);
  process.exitCode = 1;
} finally {
  server?.kill();
  // Windows keeps the SQLite files locked for a moment after the server exits.
  await new Promise((r) => setTimeout(r, 500));
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    console.warn(`(left ${work} behind)`);
  }
}
