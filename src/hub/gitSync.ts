import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CortexError } from "../core/types.js";

// Keeps a hub project's checkout up to date with its upstream branch, pull only (decision 01M3AM8C7QZG19TBK055EJYWXA):
// fresh code makes staleness look at the right HEAD, and knowledge pushed by developers reaches the hub.
// The hub never commits or pushes. What it wrote under .cortex stays for a person to commit; the count of
// those files is reported so they do not pile up unseen.
//
// Only fast-forwards. Local commits, a diverged branch or local edits that the incoming commits touch stop
// the pull with a message; git itself refuses to overwrite uncommitted work, and nothing here resets or merges.

export interface PullResult {
  at: string;
  status: "pulled" | "up_to_date" | "skipped" | "failed";
  message: string;
  upstream?: string;
  head?: string;
  behind?: number; // upstream commits not in the checkout (after the attempt)
  ahead?: number; // local commits not on the upstream
  pending?: number; // changed or new files under .cortex waiting for a person to commit
}

const TIMEOUT_MS = 60_000;

export function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((done) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      // No prompt can be answered on a server: a remote that wants a password fails at once instead of hanging.
      { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout, stderr) => done({ ok: !error, out: String(stdout).trim(), err: String(stderr || error?.message || "").trim() }),
    );
  });
}

const firstLine = (s: string) =>
  s
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim() ?? "";

export async function pullProject(root: string): Promise<PullResult> {
  const at = new Date().toISOString();
  const done = (status: PullResult["status"], message: string, extra: Partial<PullResult> = {}): PullResult => ({ at, status, message, ...extra });

  if ((await git(root, ["rev-parse", "--is-inside-work-tree"])).out !== "true") return done("skipped", "Not a git repository.");
  let upstream = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream.ok || !upstream.out) {
    // A repository connected from the board while it was still empty: its branch is attached once it exists.
    const wanted = (await git(root, ["config", "--get", WANTED_BRANCH])).out;
    if (!wanted) return done("skipped", "The current branch has no upstream to pull from (git branch --set-upstream-to).");
    const fetched = await git(root, ["fetch", "--quiet", "--prune", "origin"]);
    if (!fetched.ok) return done("failed", `Fetch failed: ${maskSecrets(firstLine(fetched.err))}`);
    if (!(await hasRef(root, `refs/remotes/origin/${wanted}`))) return done("skipped", `Waiting for the branch "${wanted}" to appear on the repository.`);
    await attach(root, wanted);
    upstream = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (!upstream.ok || !upstream.out) return done("failed", `Could not follow origin/${wanted}.`);
  }

  const pendingOf = async () => {
    const s = await git(root, ["status", "--porcelain", "--", ".cortex"]);
    return s.ok ? s.out.split(/\r?\n/).filter(Boolean).length : undefined;
  };
  const counts = async () => {
    const r = await git(root, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
    const [ahead, behind] = r.out.split(/\s+/).map(Number);
    return { ahead: ahead ?? 0, behind: behind ?? 0 };
  };
  const state = async () => ({
    upstream: upstream.out,
    head: (await git(root, ["rev-parse", "--short", "HEAD"])).out,
    ...(await counts()),
    pending: await pendingOf(),
  });

  const remote = upstream.out.split("/")[0]!;
  const fetched = await git(root, ["fetch", "--quiet", remote]);
  if (!fetched.ok) return done("failed", `Fetch failed: ${maskSecrets(firstLine(fetched.err))}`, await state());

  const before = await counts();
  if (before.behind === 0) return done("up_to_date", "Up to date.", await state());
  if (before.ahead > 0) {
    return done("skipped", `The checkout has ${before.ahead} local commit(s) the upstream does not; a person must merge or push.`, await state());
  }
  const merged = await git(root, ["merge", "--ff-only", "--quiet", "@{u}"]);
  if (!merged.ok) return done("failed", `Could not fast-forward: ${firstLine(merged.err)}`, await state());
  return done("pulled", `Pulled ${before.behind} commit(s).`, await state());
}

// ---- connecting a repository from the board ------------------------------------------------------------
//
// A project can be added before its code exists anywhere, its folder filled by hand first, or its repository
// created later. Connecting sets `origin` and follows one branch; it never commits, pushes, merges or
// overwrites a file on disk (decision 01M3AM8C7QZG19TBK055EJYWXA): files the folder already has are kept
// as they are, and git shows where they differ from the repository.

const WANTED_BRANCH = "cortex.branch"; // the branch to follow once it exists, kept in the checkout's own config

// Credentials inside a remote address (https://user:token@host/...) never reach a screen or a log.
export const maskSecrets = (s: string) => s.replace(/([a-z][\w+.-]*:\/\/)[^@\s/]+@/gi, "$1***@");
export const stripAuth = (url: string) => url.replace(/^([a-z][\w+.-]*:\/\/)[^@\s/]+@/i, "$1");

const ADDRESS = /^(https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|[\w.-]+@[\w.-]+:)/i;

// The address git is given. A token goes into an https address as its password ("oauth2" as the user works for
// GitHub and GitLab); an ssh address uses the server's own SSH key.
export function remoteAddress(url: string, token?: string): string {
  const u = url.trim();
  if (!u || /\s/.test(u) || !ADDRESS.test(u)) {
    throw new CortexError("invalid_request", "Give the repository's address: https://host/owner/repo.git or git@host:owner/repo.git.", 400);
  }
  const tok = token?.trim();
  if (!tok) return u;
  if (!/^https?:\/\//i.test(u))
    throw new CortexError("invalid_request", "A token works only with an https:// address; an ssh address uses the server's SSH key.", 400);
  const parsed = new URL(u);
  parsed.username = "oauth2";
  parsed.password = tok;
  return parsed.toString();
}

async function hasRef(root: string, ref: string): Promise<boolean> {
  return (await git(root, ["rev-parse", "--verify", "--quiet", ref])).ok;
}

// The branch the repository itself starts people on, or a usual name when it does not say.
async function defaultBranch(root: string): Promise<string | null> {
  await git(root, ["remote", "set-head", "origin", "--auto"]);
  const head = await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.out.startsWith("origin/")) return head.out.slice("origin/".length);
  for (const b of ["main", "master"]) if (await hasRef(root, `refs/remotes/origin/${b}`)) return b;
  return null;
}

// Makes origin/<branch> the folder's history without touching its files: a folder with no commits gets the
// branch, files it lacks are written, files it has stay (and show as changed if they differ). A checkout that
// already has commits only gets its upstream set when it is on that branch.
async function attach(root: string, branch: string): Promise<{ kept: number; note?: string }> {
  const ref = `refs/remotes/origin/${branch}`;
  if (!(await hasRef(root, "HEAD"))) {
    await git(root, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    await git(root, ["update-ref", `refs/heads/${branch}`, ref]);
    await git(root, ["reset", "--quiet"]); // the index follows the branch; the files on disk are left alone
    await git(root, ["checkout-index", "--all", "--quiet"]); // writes what is missing, never overwrites
  } else {
    const current = (await git(root, ["symbolic-ref", "--short", "HEAD"])).out;
    if (current !== branch) {
      return { kept: 0, note: `The checkout is on "${current || "a detached HEAD"}", not "${branch}": switch it by hand, then pulls follow it.` };
    }
  }
  await git(root, ["branch", `--set-upstream-to=origin/${branch}`, branch]);
  await git(root, ["config", "--unset", WANTED_BRANCH]);
  const diff = await git(root, ["status", "--porcelain", "--untracked-files=no"]);
  return { kept: diff.out.split(/\r?\n/).filter(Boolean).length };
}

export interface GitInfo {
  remote: string | null; // without credentials
  auth: boolean; // the address carries credentials
  branch: string | null; // followed, or waited for
  waiting: boolean; // connected, but the branch is not on the repository yet
}

// What the board shows: the folder's own repository only, not one it happens to sit inside.
export async function gitInfo(root: string): Promise<GitInfo | null> {
  if (!existsSync(join(root, ".git"))) return null;
  const remote = await git(root, ["remote", "get-url", "origin"]);
  const upstream = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const wanted = (await git(root, ["config", "--get", WANTED_BRANCH])).out;
  const branch =
    upstream.ok && upstream.out ? upstream.out.replace(/^origin\//, "") : wanted || (await git(root, ["symbolic-ref", "--short", "HEAD"])).out || null;
  return { remote: remote.ok ? stripAuth(remote.out) : null, auth: remote.ok && remote.out !== stripAuth(remote.out), branch, waiting: !!wanted };
}

export interface ConnectResult {
  remote: string; // without credentials
  branch: string | null;
  status: "connected" | "waiting";
  kept: number; // files in the folder that differ from the repository, left as they were
  message: string;
}

// Connects a project's folder to a repository: creates the folder, starts a repository in it if it has none,
// points origin at the address and follows the branch (the repository's default when none is given). An
// address that cannot be fetched changes nothing. Leaving the token out while the address stays the same keeps
// the credentials already saved.
export async function connectGit(root: string, input: { url: string; branch?: string; token?: string }): Promise<ConnectResult> {
  let url = remoteAddress(input.url, input.token);
  const branch = input.branch?.trim() || "";
  if (branch && (branch.startsWith("-") || !(await git(process.cwd(), ["check-ref-format", "--branch", branch])).ok)) {
    throw new CortexError("invalid_request", `"${branch}" is not a branch name.`, 400);
  }
  try {
    mkdirSync(root, { recursive: true });
  } catch (e) {
    throw new CortexError("invalid_project", `Could not create ${root}: ${(e as Error).message}`, 400);
  }
  const fresh = !existsSync(join(root, ".git"));
  if (fresh) {
    const init = await git(root, ["init", "--quiet"]);
    if (!init.ok) throw new CortexError("git_failed", `git init failed: ${firstLine(init.err)}`, 500);
  }
  const before = await git(root, ["remote", "get-url", "origin"]);
  if (before.ok && !input.token?.trim() && stripAuth(before.out) === url) url = before.out;
  const set = await git(root, ["remote", before.ok ? "set-url" : "add", "origin", url]);
  const undo = async () => {
    if (fresh) rmSync(join(root, ".git"), { recursive: true, force: true });
    else if (before.ok) await git(root, ["remote", "set-url", "origin", before.out]);
    else await git(root, ["remote", "remove", "origin"]);
  };
  if (!set.ok) {
    await undo();
    throw new CortexError("git_failed", `Could not set the address: ${maskSecrets(firstLine(set.err))}`, 400);
  }
  const fetched = await git(root, ["fetch", "--quiet", "--prune", "origin"]);
  if (!fetched.ok) {
    await undo();
    throw new CortexError(
      "git_failed",
      `Could not read ${stripAuth(url)}: ${maskSecrets(firstLine(fetched.err))}. A private repository needs a token (https) or the server's SSH key added to it.`,
      400,
    );
  }

  const remote = stripAuth(url);
  const follow = branch || (await defaultBranch(root));
  if (!follow || !(await hasRef(root, `refs/remotes/origin/${follow}`))) {
    if (follow) await git(root, ["config", WANTED_BRANCH, follow]);
    else await git(root, ["config", "--unset", WANTED_BRANCH]);
    const what = follow ? `the branch "${follow}" is not on it yet` : "it has no branches yet";
    return { remote, branch: follow, status: "waiting", kept: 0, message: `Connected to ${remote}; ${what}. Pulls attach it once it is pushed.` };
  }
  await git(root, ["config", WANTED_BRANCH, follow]);
  const r = await attach(root, follow);
  if (r.note) return { remote, branch: follow, status: "waiting", kept: 0, message: `Connected to ${remote}. ${r.note}` };
  const kept = r.kept ? ` ${r.kept} file(s) in the folder differ from the repository and were left as they were.` : "";
  return { remote, branch: follow, status: "connected", kept: r.kept, message: `Connected to ${remote}, following ${follow}.${kept}` };
}
