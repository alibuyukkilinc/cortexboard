import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cortex } from "../src/core/cortex.js";
import { initProject } from "../src/core/init.js";
import { loadProject } from "../src/core/project.js";

// Spec §18: two people work on .cortex/ in parallel, then `git merge`. The layout is built for it
// (one file per record, one activity file per actor per day), and this checks that it holds: the
// merge has no conflicts and the rebuilt index has everything from both sides.
//
// The hard case is deliberate: both machines run an AI under the same actor id on the same day, so
// both append to the very same activity/<day>/ai-agent.jsonl.
test("two clones write on the same day and merge without conflicts; the index has both sides", () => {
  const root = mkdtempSync(join(tmpdir(), "cortex-merge-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const setup = (cwd: string) => {
    git(cwd, "config", "user.email", "dev@example.com");
    git(cwd, "config", "user.name", "Dev");
    git(cwd, "config", "commit.gpgsign", "false");
  };
  const open: Cortex[] = [];
  const cortexAt = (dir: string) => {
    const c = new Cortex(loadProject(dir), { embedder: null });
    open.push(c);
    return c;
  };
  try {
    const a = join(root, "a");
    const b = join(root, "b");
    execFileSync("git", ["init", "-q", a]);
    setup(a);
    initProject(a, "shop", { language: "en", timezone: "UTC", bootstrapTask: false });
    git(a, "add", "-A");
    git(a, "commit", "-q", "-m", "cortex init");
    execFileSync("git", ["clone", "-q", a, b]);
    setup(b);

    // Machine A.
    const ca = cortexAt(a);
    const [ha, aa] = [ca.actor("owner"), ca.actor("ai-agent")];
    const issue = ca.items.create(ha, { type: "issue", title: "Double charge", category_path: "backend", fields: { severity: "critical" } });
    ca.items.reply(aa, issue.id, { body: "Looking at the callback." });
    ca.putNode(ha, { path: "backend/payments", title: "Payments", summary: "iyzico." });
    ca.activity.log(aa, { action: "investigation", summary: "Read the callback code" });
    ca.activity.log(aa, { action: "fix", summary: "Idempotent callback", why: "Late webhooks charged twice" });

    // Machine B, the same day, the same actors.
    const cb = cortexAt(b);
    const [hb, ab] = [cb.actor("owner"), cb.actor("ai-agent")];
    const task = cb.items.create(hb, { type: "task", title: "Cargo label" });
    cb.items.create(ab, { type: "question", title: "Which carrier?", assignee: "@humans" });
    cb.putNode(hb, { path: "backend/shipping", title: "Shipping", summary: "Carrier API." });
    cb.activity.log(ab, { action: "code_change", summary: "Label PDF", why: "Warehouse asked for it" });
    for (const c of [ca, cb]) c.close();
    open.length = 0;

    git(a, "add", "-A");
    git(a, "commit", "-q", "-m", "work on A");
    git(b, "add", "-A");
    git(b, "commit", "-q", "-m", "work on B");

    // The merge: B pulls A.
    let conflict = "";
    try {
      git(b, "pull", "-q", "--no-rebase", "--no-edit", a, "HEAD");
    } catch (e) {
      conflict = `${(e as { stdout?: string }).stdout ?? ""}${(e as { stderr?: string }).stderr ?? ""}${git(b, "diff", "--name-only", "--diff-filter=U")}`;
    }
    assert.equal(conflict, "", "the merge must not conflict");
    assert.equal(git(b, "status", "--porcelain"), "", "clean after the merge");

    // A fresh index built from the merged files has everything from both machines.
    const merged = cortexAt(b);
    merged.reindex();
    const titles = merged.items
      .list({ limit: 100 })
      .items.map((i) => i.title)
      .sort();
    assert.deepEqual(titles, ["Cargo label", "Double charge", "Which carrier?"]);
    assert.equal(merged.itemStore.replies(issue.id).length, 1);
    assert.ok(merged.tree.exists("backend/payments") && merged.tree.exists("backend/shipping"));
    const logged = merged.activity
      .list({ limit: 50 })
      .entries.map((e) => e.summary)
      .sort();
    assert.deepEqual(logged, ["Idempotent callback", "Label PDF", "Read the callback code"]);
    // Audit entries from both machines survive as well (item/node creation on each side).
    const audit = merged.activity.list({ limit: 200, include_system: true }).entries.filter((e) => e.system);
    assert.ok(audit.some((e) => e.refs?.includes(issue.id)) && audit.some((e) => e.refs?.includes(task.id)));
    // And the same numbers through the report, which reads the index.
    assert.equal(merged.reports.build({ since: "1d" }).totals.activity.logged.total, 3);
  } finally {
    for (const c of open) c.close();
    rmSync(root, { recursive: true, force: true });
  }
});
