import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import YAML from "yaml";
import { CORTEX_DIR, GITATTRIBUTES, paths, secureSecretsFile } from "./project.js";
import type { CortexConfig, KnowledgeNode } from "./types.js";
import { CortexError } from "./types.js";
import { TreeStore, normalizePath } from "../store/tree.js";
import { ItemStore } from "../store/items.js";
import { nowIso, ulid } from "../util/text.js";
import { ACTIVITY_SCHEMA, DEFAULT_SCHEMAS } from "./schema.js";
import { languageRule } from "./language.js";
import { systemTimeZone } from "../util/time.js";

export type Branch = [path: string, title: string, summary: string];

// The text init writes into a brand new tree. A project that writes in Turkish should not open on an
// English board, so the seed follows the project's language; a language we have no seed for gets the
// English one, and the bootstrap task rewrites all of it anyway.
interface SeedText {
  branches: Record<string, [title: string, summary: string]>;
  custom: (name: string) => string; // a branch the template does not know
  pending: string; // appended to every seeded branch summary
  root: (project: string) => string;
  rootMark: string; // the part of `root` that says the summary is still unwritten
  bootstrapTitle: string; // the task init opens for the first AI that connects
}

export const BRANCH_PATHS = ["backend", "frontend", "server", "mobile", "security", "seo", "code-structure"];

const SEED: Record<string, SeedText> = {
  en: {
    branches: {
      backend: ["Backend", "APIs, business logic, data access and background jobs."],
      frontend: ["Frontend", "Web UI: pages, components, state and styling."],
      server: ["Server & Infrastructure", "Hosting, deployment, environments, CI/CD and monitoring."],
      mobile: ["Mobile", "Mobile apps: platforms, builds and store releases."],
      security: ["Security", "Auth, permissions, secrets handling and threat notes."],
      seo: ["SEO", "Metadata, sitemaps, performance and indexing rules."],
      "code-structure": ["Code Structure", "Folder layout, conventions, patterns and shared libraries."],
    },
    custom: (name) => `Knowledge about ${name}.`,
    pending: "(not documented yet)",
    root: (project) => `${project}: project summary not written yet. Run the bootstrap task to fill this in.`,
    rootMark: "summary not written yet",
    bootstrapTitle: "Fill the knowledge tree from the code (first setup)",
  },
  tr: {
    branches: {
      backend: ["Arka uç", "API'ler, iş mantığı, veri erişimi ve arka plan işleri."],
      frontend: ["Ön yüz", "Web arayüzü: sayfalar, bileşenler, durum yönetimi ve stiller."],
      server: ["Sunucu ve altyapı", "Barındırma, dağıtım, ortamlar, CI/CD ve izleme."],
      mobile: ["Mobil", "Mobil uygulamalar: platformlar, derlemeler ve mağaza yayınları."],
      security: ["Güvenlik", "Kimlik doğrulama, yetkiler, gizli bilgiler ve tehdit notları."],
      seo: ["SEO", "Meta veriler, site haritaları, performans ve dizine ekleme kuralları."],
      "code-structure": ["Kod yapısı", "Klasör düzeni, adlandırma kuralları, kalıplar ve ortak kütüphaneler."],
    },
    custom: (name) => `${name} hakkında bilgi.`,
    pending: "(henüz belgelenmedi)",
    root: (project) => `${project}: proje özeti henüz yazılmadı. Doldurmak için bootstrap görevini çalıştır.`,
    rootMark: "özeti henüz yazılmadı",
    bootstrapTitle: "Bilgi ağacını koddan doldur (ilk kurulum)",
  },
};

// No language given means English: callers that have one (init, the CLI prompt) pass it explicitly,
// so nothing silently depends on the machine's locale.
export function seedText(language?: string | null): SeedText {
  return SEED[(language ?? "en").split("-")[0].toLowerCase()] ?? SEED.en;
}

// Reports count a branch as undocumented while it still carries the seeded summary, in any language.
const PLACEHOLDERS = Object.values(SEED).flatMap((s) => [s.pending, s.rootMark]);

export function isPlaceholder(summary: string): boolean {
  return PLACEHOLDERS.some((t) => summary.includes(t));
}

export function defaultBranches(language?: string | null): Branch[] {
  const seed = seedText(language);
  return BRANCH_PATHS.map((path) => [path, ...seed.branches[path]] as Branch);
}

const GLOBAL_RULES = {
  rules: [
    "Start every session with cortex_brief. Do not read the whole tree.",
    "Search Cortex before changing code you do not fully understand.",
    "Before editing files, call cortex_code_context to see which knowledge and decisions cover them.",
    "Knowledge marked stale may be wrong: check the code, then update the node or verify it.",
    "If search does not answer your question, ask a human instead of assuming.",
    "Keep summaries under 300 characters: they are what other AIs read first.",
    "Explain WHY in every change, not only WHAT. Log each meaningful change with cortex_log_activity.",
    "Check cortex_inbox: answer questions assigned to you before starting new work.",
    "Never edit files under .cortex/rules. Rules belong to humans.",
  ],
};

const NODE_SCHEMA = {
  type: "node",
  fields: {
    path: { type: "tree_path", required: true, format: "lowercase-dashed segments, e.g. backend/auth/jwt-refresh" },
    title: { type: "string", required: true, max: 120 },
    summary: { type: "string", required: true, max: 300 },
    body: { type: "markdown" },
    tags: { type: "string[]", max_items: 20 },
    links: { code: "[{file, lines?}]", items: "[item id]" },
    verified_at_commit: { type: "git commit hash the knowledge was checked against" },
  },
  ai_instructions:
    "Write summaries a teammate can act on in one read. Link the code files you describe. " +
    "Parents must exist before children. Your writes become drafts until a human approves them.",
};

export interface InitResult {
  dir: string;
  tokens: Record<string, string>;
  markdownCandidates: string[];
  bootstrapTask: string | null; // id of the task that asks the first AI to fill the tree
}

// The machine's language ("tr" on a Turkish system) unless the user passes --lang.
export function systemLanguage(): string {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || "en";
  return locale.split("-")[0].toLowerCase() || "en";
}

// Branch names from --branches: template names keep their description, anything else gets a generic one.
export function resolveBranches(names?: string[], language?: string | null): Branch[] {
  const template = defaultBranches(language);
  if (!names) return template;
  const seed = seedText(language);
  const out: Branch[] = [];
  for (const raw of names) {
    const path = normalizePath(raw.trim().toLowerCase());
    if (!path || path.includes("/") || out.some(([p]) => p === path)) continue;
    const known = template.find(([p]) => p === path);
    const words = path.replace(/-/g, " ");
    out.push(known ?? [path, words.replace(/^./, (c) => c.toUpperCase()), seed.custom(words)]);
  }
  return out;
}

export function initProject(
  root: string,
  name = basename(root),
  // dir: where the knowledge goes when it is not <root>/.cortex (a hub's own folder).
  opts: { language?: string; branches?: string[]; timezone?: string; bootstrapTask?: boolean; dir?: string } = {},
): InitResult {
  const dir = opts.dir ?? join(root, CORTEX_DIR);
  if (existsSync(join(dir, "cortex.config.yaml"))) {
    throw new CortexError("already_initialized", `Cortex is already initialized in ${dir}.`, 409);
  }
  const p = paths(dir);
  const language = opts.language ?? systemLanguage();
  const seed = seedText(language);
  for (const d of [p.rules, p.tree, p.items, p.activity, p.drafts]) mkdirSync(d, { recursive: true });

  const config: CortexConfig = {
    project: { name },
    port: 4747,
    timezone: opts.timezone ?? systemTimeZone(),
    actors: [
      { id: "owner", kind: "human" },
      { id: "ai-agent", kind: "ai" },
    ],
    // Decisions are auto because their schema already reserves accepted/rejected for humans.
    approval: { node: "review", task: "auto", issue: "auto", question: "auto", note: "auto", decision: "auto" },
  };
  writeFileSync(
    p.config,
    "# Cortex project settings. Safe to commit.\n" +
      "# approval (for AI actors): auto = writes directly, review = writes become drafts a human approves, human_only = AI cannot write.\n" +
      "# timezone: the zone reports count days in (e.g. Europe/Istanbul).\n" +
      YAML.stringify(config),
    "utf8",
  );

  const tokens = { owner: token(), "ai-agent": token() };
  // Owner-only from the first byte: these are API keys. (mode is ignored on Windows, where the profile's ACLs apply.)
  writeFileSync(p.secrets, "# Actor tokens. NEVER commit this file.\n" + YAML.stringify({ tokens }), { encoding: "utf8", mode: 0o600 });
  secureSecretsFile(p.secrets); // `mode` only applies when the file is created
  writeFileSync(
    join(dir, ".gitignore"),
    ".index/\n.secrets.yaml\n.sessions.json\nviews/\nbackup.secrets.yaml\n.backup-last.json\n.restore/\n.prompts/\n",
    "utf8",
  );
  // Same bytes on every OS, so diffs do not flip with core.autocrlf.
  writeFileSync(join(dir, ".gitattributes"), GITATTRIBUTES, "utf8");

  writeFileSync(
    join(p.rules, "_global.yaml"),
    "# Rules every AI receives in cortex_brief. Edited by humans only.\n" +
      "# language: the language AIs must write in (knowledge, items, replies, activity), e.g. tr or en.\n" +
      YAML.stringify({ language, ...GLOBAL_RULES }),
    "utf8",
  );
  writeFileSync(join(p.rules, "node.schema.yaml"), YAML.stringify(NODE_SCHEMA), "utf8");
  const header = "# Edited by humans only. Cortex enforces these rules and explains violations to AIs.\n";
  for (const [type, schema] of Object.entries(DEFAULT_SCHEMAS)) {
    writeFileSync(join(p.rules, `${type}.schema.yaml`), header + YAML.stringify(schema), "utf8");
  }
  writeFileSync(join(p.rules, "activity.schema.yaml"), header + YAML.stringify(ACTIVITY_SCHEMA), "utf8");
  for (const d of [p.items, p.activity, p.drafts]) writeFileSync(join(d, ".gitkeep"), "", "utf8");

  const tree = new TreeStore(p.tree);
  const make = (path: string, title: string, summary: string, body = ""): KnowledgeNode => ({
    id: ulid(),
    path,
    title,
    summary,
    body,
    status: "active",
    updated_by: "owner",
    updated_at: nowIso(),
  });
  tree.write(make("", name, seed.root(name)));
  for (const [path, title, summary] of resolveBranches(opts.branches, language)) tree.write(make(path, title, `${summary} ${seed.pending}`));

  // The bootstrap task as a real item for @ai, not only text printed by `cortexboard bootstrap`: an agent
  // that connects later, on this computer or through a hub, finds it in its inbox and the board shows progress.
  const markdownCandidates = findMarkdown(root);
  const now = nowIso();
  // Tests that count items turn it off (bootstrapTask: false); every real init opens it.
  const bootstrapTask = opts.bootstrapTask === false ? null : ulid();
  if (bootstrapTask)
    new ItemStore(p.items).write({
      id: bootstrapTask,
      type: "task",
      title: seed.bootstrapTitle,
      status: "todo",
      author: "owner",
      assignee: "@ai",
      tags: [BOOTSTRAP_TAG],
      fields: { priority: "high" },
      created_at: now,
      updated_at: now,
      updated_by: "owner",
      body: bootstrapPrompt(name, markdownCandidates, language, true),
    });

  return { dir, tokens, markdownCandidates, bootstrapTask };
}

export const BOOTSTRAP_TAG = "bootstrap";

function token(): string {
  return "ctx_" + randomBytes(24).toString("base64url");
}

const SKIP = new Set(["node_modules", ".git", CORTEX_DIR, "vendor", "dist", "build", ".next", "coverage"]);

// Markdown worth importing into the tree. In a git repository the list comes from git itself, so files the
// project ignores never appear: an ignored `infra.local.md` with real server keys was once listed, and what
// the bootstrap task imports ends up in the committed .cortex/. Outside git, a bounded walk.
export function findMarkdown(root: string, limit = 200): string[] {
  const listed = gitMarkdown(root);
  if (listed) return listed.slice(0, limit);
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || out.length >= limit) return;
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name) || name.startsWith(".")) continue;
      const full = join(dir, name);
      const st = statSync(full, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(full, depth + 1);
      else if (name.toLowerCase().endsWith(".md") && !LOCAL_MD.test(name)) out.push(relative(root, full).replace(/\\/g, "/"));
      if (out.length >= limit) return;
    }
  };
  walk(root, 0);
  return out;
}

// Outside git there is no ignore list to ask; "*.local.md" is the common name for private notes.
const LOCAL_MD = /\.local\.md$/i;

// Tracked, and untracked but not ignored, .md files under root (relative to it); null outside a git work tree.
function gitMarkdown(root: string): string[] | null {
  try {
    const out = execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md", "*.MD"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
    const files = out
      .split("\0")
      .filter(Boolean)
      .map((f) => f.normalize("NFC"))
      .filter((f) => !f.split("/").some((part) => SKIP.has(part)));
    return [...new Set(files)].sort();
  } catch {
    return null;
  }
}

// A ready-made task the user hands to their own AI, so filling the tree costs Cortex zero tokens.
// `asTask`: the text is the body of the bootstrap task, so it also says how to close that task.
export function bootstrapPrompt(projectName: string, markdown: string[], language?: string | null, asTask = false): string {
  return `# Cortex bootstrap task

You are setting up the Cortex knowledge tree for "${projectName}".
Cortex is this project's single source of truth. Humans review everything you write.
${language ? `\n${languageRule(language)}\n` : ""}
1. Call cortex_brief to see the current branches.
2. Explore the codebase (folders, package files, entry points). Do not guess.
3. For the root node ("") write a clear project summary (<= 300 chars) and a body describing
   purpose, main components and how they talk to each other.
4. For each top-level branch in the brief:
   - update its summary to describe THIS project
   - if a branch does not apply, say so in its summary ("Does not apply: ...") and suggest in a question that a human deletes it
   - add child nodes for important subsystems (e.g. backend/auth, backend/payments)
   - link the code files each node describes (links.code)
5. Existing markdown worth importing:
${markdown.length ? markdown.map((m) => `   - ${m}`).join("\n") : "   (none found)"}
   Move the durable knowledge into nodes. Note contradictions instead of silently picking one.
   Everything in .cortex/ is committed: never copy secrets (passwords, keys, tokens, addresses with
   credentials) into Cortex, and do not read files git ignores (e.g. *.local.md) for this task.
6. Past decisions you find in docs or commit history: record them with cortex_create_item (type "decision").
   Open questions and contradictions: cortex_create_item (type "question", assignee "@humans").
7. Always include a short "reason" with each write.
${
  asTask
    ? `8. Claim this task (cortex_claim) when you start and move it to "review" when you finish, with a reply listing what you wrote.
   Work in passes if the project is large: a handoff note on release tells the next session where you stopped.
`
    : ""
}
Knowledge nodes you write become drafts until a human approves them in Cortex.
`;
}

export const AGENT_HINT = `<!-- cortex:start -->
## Project knowledge: Cortex
This project's knowledge lives in Cortex, not in markdown files.
- Session start: call \`cortex_brief\`, then \`cortex_inbox\` for questions and issues waiting on you.
- Before changing code you don't fully understand: \`cortex_search\`, then \`cortex_tree\` / \`cortex_node\`.
- Before editing files: \`cortex_code_context(files)\` shows the knowledge, decisions and open items that cover them.
- Unsure? Open a question (\`cortex_ask\` or \`cortex_create_item\` type "question") instead of assuming.
- After a meaningful change: \`cortex_log_activity\` (what, why, files, commit), and update the relevant node.
- Before you finish: \`cortex_update_status\` (where the project stands, what is next); the brief marks it when stale.
- When a piece of work is done, have the person approve in this chat: \`cortex_review_drafts\` for your drafts, \`cortex_pending_approvals\` / \`cortex_ask_human\` for decisions, questions and done. Only their own answer counts: never answer for them.
- When the person states a lasting decision or rule, offer \`cortex_capture\`: it belongs in Cortex, not in your private memory.
Do not update docs in .md files; update Cortex.
<!-- cortex:end -->`;
