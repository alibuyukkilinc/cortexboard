import { execFile } from "node:child_process";

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
  const upstream = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream.ok || !upstream.out) return done("skipped", "The current branch has no upstream to pull from (git branch --set-upstream-to).");

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
  if (!fetched.ok) return done("failed", `Fetch failed: ${firstLine(fetched.err)}`, await state());

  const before = await counts();
  if (before.behind === 0) return done("up_to_date", "Up to date.", await state());
  if (before.ahead > 0) {
    return done("skipped", `The checkout has ${before.ahead} local commit(s) the upstream does not; a person must merge or push.`, await state());
  }
  const merged = await git(root, ["merge", "--ff-only", "--quiet", "@{u}"]);
  if (!merged.ok) return done("failed", `Could not fast-forward: ${firstLine(merged.err)}`, await state());
  return done("pulled", `Pulled ${before.behind} commit(s).`, await state());
}
