import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hashPassword } from "../src/hub/crypto.js";
import { connectGit, gitInfo, maskSecrets, pullProject, remoteAddress } from "../src/hub/gitSync.js";
import { codeDir, knowledgeDir, registerProject } from "../src/hub/knowledge.js";
import { Hub, HUB_COOKIE, buildHubServer } from "../src/hub/server.js";
import { HubStore } from "../src/hub/store.js";

// A project is added from the board before its code is anywhere, and its repository is connected later
// (or right away). The hub only fetches and follows a branch: it never commits, pushes or overwrites a file.

const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
const text = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n"); // core.autocrlf on Windows
const run = (cwd: string, ...args: string[]) => execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A bare "remote" and a developer's clone that pushes to it. `seed` commits and pushes files.
function setup(opts: { empty?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cortex-hubgit-"));
  const bare = join(root, "remote.git");
  mkdirSync(bare);
  run(bare, "init", "--bare", "--quiet");
  const dev = join(root, "dev");
  mkdirSync(dev);
  run(dev, "init", "--quiet");
  run(dev, "remote", "add", "origin", bare);
  const seed = (files: Record<string, string>, branch = "main") => {
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dev, f), text);
    run(dev, "checkout", "--quiet", "-B", branch);
    run(dev, "add", "-A");
    run(dev, "commit", "--quiet", "-m", `add ${Object.keys(files).join(", ")}`);
    run(dev, "push", "--quiet", "origin", branch);
  };
  if (!opts.empty) {
    seed({ "README.md": "# Shop\n", "main.ts": "export const v = 1;\n" });
    run(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  }
  const url = pathToFileURL(bare).href;
  return { root, bare, dev, url, seed, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("hub git: connecting an empty folder checks the repository out and follows its default branch", async () => {
  const t = setup();
  try {
    const folder = join(t.root, "code", "shop");
    const r = await connectGit(folder, { url: t.url });
    assert.equal(r.status, "connected", r.message);
    assert.equal(r.branch, "main");
    assert.equal(text(join(folder, "main.ts")), "export const v = 1;\n");
    assert.equal((await pullProject(folder)).status, "up_to_date");

    t.seed({ "main.ts": "export const v = 2;\n" });
    const pulled = await pullProject(folder);
    assert.equal(pulled.status, "pulled", pulled.message);
    assert.equal(text(join(folder, "main.ts")), "export const v = 2;\n");
    assert.equal(run(folder, "log", "-1", "--format=%s"), "add main.ts", "the hub made no commit of its own");
    const info = await gitInfo(folder);
    assert.deepEqual(info, { remote: t.url, auth: false, branch: "main", waiting: false });
  } finally {
    t.cleanup();
  }
});

test("hub git: files already in the folder are kept, missing ones are written", async () => {
  const t = setup();
  try {
    const folder = join(t.root, "shop");
    mkdirSync(folder);
    writeFileSync(join(folder, "main.ts"), "export const v = 99; // edited on the server\n");
    writeFileSync(join(folder, "notes.txt"), "local only\n");
    const r = await connectGit(folder, { url: t.url, branch: "main" });
    assert.equal(r.status, "connected", r.message);
    assert.equal(r.kept, 1);
    assert.match(r.message, /1 file\(s\) in the folder differ/);
    assert.equal(text(join(folder, "main.ts")), "export const v = 99; // edited on the server\n", "never overwritten");
    assert.equal(text(join(folder, "README.md")), "# Shop\n", "the missing file is written");
    assert.ok(existsSync(join(folder, "notes.txt")));
    assert.equal(run(folder, "rev-parse", "--abbrev-ref", "@{u}"), "origin/main");
  } finally {
    t.cleanup();
  }
});

test("hub git: an empty repository is connected now and attached when its branch is pushed", async () => {
  const t = setup({ empty: true });
  try {
    const folder = join(t.root, "shop");
    const r = await connectGit(folder, { url: t.url, branch: "main" });
    assert.equal(r.status, "waiting", r.message);
    assert.deepEqual(await gitInfo(folder), { remote: t.url, auth: false, branch: "main", waiting: true });
    assert.equal((await pullProject(folder)).status, "skipped");

    t.seed({ "main.ts": "export const v = 1;\n" });
    const pulled = await pullProject(folder);
    assert.notEqual(pulled.status, "failed", pulled.message);
    assert.equal(text(join(folder, "main.ts")), "export const v = 1;\n");
    assert.equal((await gitInfo(folder))?.waiting, false);
  } finally {
    t.cleanup();
  }
});

test("hub git: an address that cannot be read changes nothing; credentials never show", async () => {
  const t = setup();
  try {
    const folder = join(t.root, "shop");
    await assert.rejects(connectGit(folder, { url: pathToFileURL(join(t.root, "nope.git")).href }), /Could not read/);
    assert.ok(!existsSync(join(folder, ".git")), "the repository it started is removed again");
    await assert.rejects(connectGit(folder, { url: "--upload-pack=touch /tmp/x" }), /address/);
    await assert.rejects(connectGit(folder, { url: t.url, branch: "-x" }), /not a branch name/);
    await assert.rejects(connectGit(folder, { url: "git@github.com:acme/shop.git", token: "t" }), /only with an https/);

    assert.equal(remoteAddress("https://github.com/acme/shop.git", "s3cret"), "https://oauth2:s3cret@github.com/acme/shop.git");
    assert.equal(
      maskSecrets("fatal: could not read https://oauth2:s3cret@github.com/acme/shop.git"),
      "fatal: could not read https://***@github.com/acme/shop.git",
    );

    // Reconnecting with the same address and no token keeps the saved credentials.
    await connectGit(folder, { url: t.url });
    run(folder, "remote", "set-url", "origin", t.url.replace("file:///", "file://user:pw@/"));
    assert.equal((await gitInfo(folder))?.auth, true);
  } finally {
    t.cleanup();
  }
});

test("hub projects: added with no folder and a repository, from the board's API", async () => {
  const t = setup();
  const store = HubStore.init(join(t.root, "hub"), { org: "Acme", host: "127.0.0.1", port: 4747 });
  const admin = store.createUser({ email: "ada@example.com", name: "Ada", org_admin: true });
  store.setPassword(admin.id, await hashPassword("correct-horse-1"));
  const hub = new Hub(store);
  const app = buildHubServer(hub);
  try {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ada@example.com", password: "correct-horse-1" } });
    const cookie = login.cookies.find((c) => c.name === HUB_COOKIE)!.value;
    const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
      app.inject({ method, url, payload, headers: { cookie: `${HUB_COOKIE}=${cookie}`, "x-cortex-csrf": "1" } });

    assert.equal((await call("POST", "/api/admin/projects", {})).statusCode, 400, "a name at least");
    assert.equal((await call("POST", "/api/admin/projects", { name: "Bad", git: { url: "not an address" } })).statusCode, 400);
    assert.ok(!store.project("bad"), "a malformed address is refused before anything is created");

    const r = await call("POST", "/api/admin/projects", { name: "Arsa Admin App", language: "tr" });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().project.path, codeDir(store.dir, "arsa-admin-app"), "the hub picks the folder");
    assert.ok(existsSync(join(knowledgeDir(store.dir, "arsa-admin-app"), "cortex.config.yaml")));
    let listed = (await call("GET", "/api/admin/projects")).json().projects[0];
    assert.equal(listed.hub_folder, true);
    assert.equal(listed.git, null);

    const bad = await call("PUT", "/api/admin/projects/arsa-admin-app/git", { url: pathToFileURL(join(t.root, "nope.git")).href });
    assert.equal(bad.statusCode, 400);
    const ok = await call("PUT", "/api/admin/projects/arsa-admin-app/git", { url: t.url });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().result.status, "connected");
    assert.equal(ok.json().pull.status, "up_to_date");
    listed = (await call("GET", "/api/admin/projects")).json().projects[0];
    assert.equal(listed.git.remote, t.url);
    assert.equal(listed.git.branch, "main");

    // Both at once: a project with its repository, in one step.
    const both = await call("POST", "/api/admin/projects", { name: "Shop", git: { url: t.url } });
    assert.equal(both.statusCode, 201, both.body);
    assert.equal(both.json().git.status, "connected");
    assert.ok(existsSync(join(codeDir(store.dir, "shop"), "main.ts")));
    // A repository that cannot be read still leaves the project added, with the reason.
    const later = await call("POST", "/api/admin/projects", { name: "Later", git: { url: pathToFileURL(join(t.root, "nope.git")).href } });
    assert.equal(later.statusCode, 201, later.body);
    assert.match(later.json().git_error, /Could not read/);

    // A folder given by hand still works, existing or not.
    const own = await registerProject(store, { path: join(t.root, "srv", "blog"), name: "Blog", init: true, language: "en" });
    assert.equal(own.folderCreated, true);
  } finally {
    await app.close();
    store.close();
    t.cleanup();
  }
});
