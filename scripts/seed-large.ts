// A project the size of a busy year, for measuring the board: thousands of items and knowledge nodes and a
// long activity feed, written through the same services the API uses so the files and index are real.
//
//   npx tsx scripts/seed-large.ts <dir> [--items 5000] [--nodes 2000] [--activity 50000] [--drafts 60]
//
// <dir> must not exist yet. Deterministic: the same counts give the same titles, statuses and structure.
// Prints the owner's API token and login command at the end.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Cortex } from "../src/core/cortex.js";
import { initProject } from "../src/core/init.js";
import { loadProject } from "../src/core/project.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    items: { type: "string", default: "5000" },
    nodes: { type: "string", default: "2000" },
    activity: { type: "string", default: "50000" },
    drafts: { type: "string", default: "60" },
  },
});
const dir = positionals[0];
if (!dir) {
  console.error("usage: npx tsx scripts/seed-large.ts <dir> [--items n] [--nodes n] [--activity n] [--drafts n]");
  process.exit(2);
}
const root = resolve(dir);
if (existsSync(root)) {
  console.error(`${root} already exists; pick a new folder so nothing real is overwritten.`);
  process.exit(2);
}
const N = { items: Number(values.items), nodes: Number(values.nodes), activity: Number(values.activity), drafts: Number(values.drafts) };

// Small linear congruential generator: reproducible without a dependency.
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

const started = Date.now();
const lap = (what: string, n: number) => console.log(`  ${what.padEnd(10)} ${String(n).padStart(6)}  ${((Date.now() - started) / 1000).toFixed(1)}s`);

const init = initProject(root, "seed-large", { language: "en", timezone: "UTC", bootstrapTask: false });
const cortex = new Cortex(loadProject(root), { embedder: null });
const human = cortex.actor("owner");
const ai = cortex.actor("ai-agent");
console.log(`Seeding ${root}`);

// ---- knowledge: areas / modules / topics, wide rather than deep, like a real codebase ----
const AREAS = ["backend", "frontend", "mobile", "infra", "data", "billing", "auth", "search", "reports", "admin"];
const paths: string[] = [];
const node = (path: string, title: string) => {
  cortex.putNode(human, {
    path,
    title,
    summary: `${title}: what it does, the rules it follows and where the code lives.`,
    body: `## ${title}\n\nHow this part works, in a few paragraphs.\n\n- It owns one concern.\n- Decisions about it are linked below.\n\n\`\`\`ts\nexport const example = "${path}";\n\`\`\`\n`,
  });
  paths.push(path);
};
for (const a of AREAS) {
  if (paths.length >= N.nodes) break;
  node(a, a[0].toUpperCase() + a.slice(1));
}
for (let m = 0; paths.length < N.nodes; m++) {
  const area = AREAS[m % AREAS.length];
  const mod = `${area}/module-${Math.floor(m / AREAS.length)}`;
  node(mod, `Module ${Math.floor(m / AREAS.length)} of ${area}`);
  for (let t = 0; t < 9 && paths.length < N.nodes; t++) node(`${mod}/topic-${t}`, `Topic ${t} in ${mod}`);
}
lap("nodes", paths.length);

// ---- items: the mix a team produces, with statuses spread across each board ----
const ids: string[] = [];
const words = ["login", "invoice", "export", "sync", "cache", "search", "upload", "report", "webhook", "session", "refund", "import"];
for (let i = 0; i < N.items; i++) {
  const kind = i % 20;
  const who = rand() < 0.6 ? ai : human;
  const category = pick(paths);
  const w = pick(words);
  let r;
  if (kind < 9) {
    // Some epics carry a checklist, the way agents write them today.
    const checklist = i % 7 === 0 ? `\n\n## Steps\n${Array.from({ length: 8 }, (_, k) => `- [${k < i % 9 ? "x" : " "}] Step ${k + 1}`).join("\n")}\n` : "";
    r = cortex.items.create(who, {
      type: "task",
      title: `Task ${i}: ${w} ${pick(["endpoint", "screen", "job", "migration"])}`,
      body: `Why this matters and what done looks like.${checklist}`,
      category_path: category,
      assignee: pick(["@ai", "@humans", "owner", "ai-agent"]),
      fields: { priority: pick(["low", "medium", "high"]) },
    });
  } else if (kind < 14) {
    r = cortex.items.create(who, {
      type: "issue",
      title: `Issue ${i}: ${w} fails when ${pick(["offline", "empty", "slow", "retried"])}`,
      body: "Steps to reproduce, expected and actual.",
      category_path: category,
      assignee: pick(["@ai", "@humans", undefined]),
      fields: { severity: pick(["low", "medium", "high", "critical"]) },
    });
  } else if (kind < 16) {
    r = cortex.items.create(who, { type: "question", title: `Question ${i}: how should ${w} behave?`, body: "", category_path: category, assignee: "@humans" });
  } else if (kind < 18) {
    r = cortex.items.create(who, { type: "note", title: `Note ${i}: ${w} findings`, body: "What we learned.", category_path: category });
  } else {
    r = cortex.items.create(ai, {
      type: "decision",
      title: `Decision ${i}: ${w} strategy`,
      body: "The choice and its consequences.",
      category_path: category,
      fields: { context: `Why ${w} needed a decision.` },
    });
  }
  ids.push(r.id);
}
lap("items", ids.length);

// Move a share of the work along its board, with the reply finishing work needs, so every column has cards.
const flows: Record<string, string[]> = { task: ["todo", "doing", "review", "done"], issue: ["in_progress", "review", "closed"] };
let moved = 0;
for (const id of ids) {
  const { item } = cortex.items.get(id);
  const flow = flows[item.type];
  if (!flow || rand() < 0.3) continue;
  const steps = flow.slice(0, 1 + Math.floor(rand() * flow.length));
  for (const to of steps)
    cortex.items.reply(human, id, {
      body: `Moved to ${to}: what was done and how to test it.`,
      status: to,
      fields: to === "closed" ? { resolution: "wontfix" } : {},
    });
  moved++;
}
lap("moved", moved);

// ---- drafts: AI edits to knowledge wait for a person ----
for (let d = 0; d < N.drafts; d++) {
  const path = paths[(d * 37) % paths.length];
  const current = cortex.tree.read(path)!;
  cortex.putNode(ai, {
    path,
    title: current.title,
    summary: current.summary,
    body: d % 5 === 0 ? "Shortened." : `${current.body}\n## Update ${d}\n\nA new paragraph from the AI.\n`,
    reason: `Keep ${path} current`,
    confirm_shrink: true, // the "Shortened." drafts are the risky-draft case on purpose
  });
}
lap("drafts", N.drafts);

// ---- activity: what agents and people said they did ----
const actions = ["code_change", "fix", "refactor", "investigation", "docs"];
for (let a = 0; a < N.activity; a++) {
  cortex.activity.log(rand() < 0.8 ? ai : human, {
    action: pick(actions),
    summary: `${pick(["Fix", "Add", "Rework", "Document"])} ${pick(words)} in ${pick(AREAS)} (#${a})`,
    why: "Because the old behavior broke a real workflow.",
    files: [`src/${pick(AREAS)}/${pick(words)}.ts`],
    refs: [pick(ids)],
  });
  if (a % 10000 === 9999) lap("activity", a + 1);
}
lap("activity", N.activity);

cortex.close();
console.log(`\nDone. Start it:  npx tsx src/cli.ts start --dir ${root}`);
console.log(`Owner token:     ${init.tokens.owner}`);
