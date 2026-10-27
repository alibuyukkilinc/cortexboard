import { cpSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { basename, join, resolve } from "node:path";
import { initProject } from "../core/init.js";
import type { Project } from "../core/project.js";
import { CORTEX_DIR, loadProject, openProject } from "../core/project.js";
import { CortexError } from "../core/types.js";
import { git } from "./gitSync.js";
import type { HubStore } from "./store.js";

// Where a hub project's knowledge lives (decision 01M3MXCE60DW7T897TRC43C6AR). New projects keep it in the hub's
// own folder, <hub>/projects/<id>, not in the code repository: a developer's clone then has no copy of it to read
// stale or to edit around the hub, and nobody has to commit what the hub wrote. The folder is a git repository
// of its own that the hub commits to (history and undo) and never pushes. Projects registered with their
// .cortex in the repository keep it there until `hub move-knowledge`; the code folder is only read and pulled.

export type KnowledgeWhere = "hub" | "repo";

export const knowledgeDir = (hubDir: string, id: string) => join(hubDir, "projects", id);

const hasConfig = (dir: string) => existsSync(join(dir, "cortex.config.yaml"));

export function knowledgeWhere(hubDir: string, p: { id: string; path: string }): KnowledgeWhere | null {
  if (hasConfig(knowledgeDir(hubDir, p.id))) return "hub";
  if (hasConfig(join(p.path, CORTEX_DIR))) return "repo";
  return null;
}

// The projects a hub project links to, read from its config without opening it.
export function readLinked(hubDir: string, p: { id: string; path: string }): string[] {
  const where = knowledgeWhere(hubDir, p);
  if (!where) return [];
  const file = join(where === "hub" ? knowledgeDir(hubDir, p.id) : join(p.path, CORTEX_DIR), "cortex.config.yaml");
  try {
    const linked = (YAML.parse(readFileSync(file, "utf8")) as { linked?: unknown } | null)?.linked;
    return Array.isArray(linked) ? linked.map(String) : [];
  } catch {
    return [];
  }
}

export function openHubProject(hubDir: string, p: { id: string; path: string }): Project {
  const dir = knowledgeDir(hubDir, p.id);
  return hasConfig(dir) ? openProject(p.path, dir) : loadProject(p.path);
}

export const projectId = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 40);

// The same identity on every hub, so a missing git config never stops a commit; the activity log says who wrote what.
const COMMITTER = ["-c", "user.name=Cortex hub", "-c", "user.email=hub@cortex.invalid", "-c", "commit.gpgsign=false"];

// Never in history: tokens, board sessions, the search index, personal views. A moved .cortex may have lost its
// .gitignore (or never had one), so this is checked before every commit, not trusted from the files.
const PRIVATE = [".index/", ".secrets.yaml", ".sessions.json", "views/", "backup.secrets.yaml", ".backup-last.json", ".restore/", ".prompts/"];

function ensurePrivateIgnored(dir: string): void {
  const file = join(dir, ".gitignore");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const have = new Set(text.split(/\r?\n/));
  const missing = PRIVATE.filter((l) => !have.has(l));
  if (missing.length) writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`, "utf8");
}

// Commits whatever changed in a hub-held knowledge folder. Starts the repository on first use.
export async function commitKnowledge(dir: string, message = "Cortex: knowledge changes"): Promise<{ committed: number; error?: string }> {
  ensurePrivateIgnored(dir);
  if (!existsSync(join(dir, ".git"))) {
    const init = await git(dir, ["init", "-q"]);
    if (!init.ok) return { committed: 0, error: init.err };
  }
  const status = await git(dir, ["status", "--porcelain"]);
  if (!status.ok) return { committed: 0, error: status.err };
  const changed = status.out.split(/\r?\n/).filter(Boolean).length;
  if (!changed) return { committed: 0 };
  const add = await git(dir, ["add", "-A"]);
  if (!add.ok) return { committed: 0, error: add.err };
  const commit = await git(dir, [...COMMITTER, "commit", "-q", "-m", message]);
  return commit.ok ? { committed: changed } : { committed: 0, error: commit.err };
}

export interface RegisterInput {
  path: string;
  id?: string;
  name?: string;
  init?: boolean;
  language?: string;
  branches?: string[];
  knowledge?: KnowledgeWhere; // where a new project's knowledge goes; default hub
}

// Registers a code folder as a hub project, creating its knowledge when asked. Used by the board and the CLI.
export async function registerProject(
  store: HubStore,
  input: RegisterInput,
): Promise<{ id: string; name: string; path: string; where: KnowledgeWhere; created?: { dir: string; bootstrapTask: string | null } }> {
  const path = resolve(input.path.trim());
  if (!existsSync(path)) throw new CortexError("invalid_project", `Folder not found: ${path}`, 400);
  const name = input.name?.trim() || basename(path);
  const id = projectId(input.id?.trim() || name);
  if (store.project(id)) throw new CortexError("conflict", `A project with id "${id}" already exists.`, 409);

  let where = knowledgeWhere(store.dir, { id, path });
  let created: { dir: string; bootstrapTask: string | null } | undefined;
  if (!where) {
    if (!input.init) throw new CortexError("not_initialized", "That folder has no .cortex yet. Send init: true to create one.", 400, { path });
    where = input.knowledge ?? "hub";
    const dir = where === "hub" ? knowledgeDir(store.dir, id) : join(path, CORTEX_DIR);
    const r = initProject(path, name, { language: input.language, branches: input.branches, dir });
    if (where === "hub") await commitKnowledge(dir, "Cortex: project created");
    created = { dir: r.dir, bootstrapTask: r.bootstrapTask };
  }
  store.addProject({ id, name, path });
  return { id, name, path, where, created };
}

// Moves a project's knowledge from <repo>/.cortex into the hub's folder. The search index is left behind (it is
// rebuilt). The folder is renamed first: if a board, an MCP server or an editor holds it open (Windows refuses),
// nothing has been touched yet. If it was committed in the repository, deleting it is a commit for a person to
// make. A running hub must be restarted afterwards.
export async function moveKnowledge(store: HubStore, id: string): Promise<{ from: string; to: string; tracked: boolean; leftover?: string }> {
  const p = store.project(id);
  if (!p) throw new CortexError("not_found", `No project "${id}".`, 404);
  const from = join(p.path, CORTEX_DIR);
  const to = knowledgeDir(store.dir, id);
  if (hasConfig(to)) throw new CortexError("conflict", `The knowledge of "${id}" is already in the hub (${to}).`, 409);
  if (!hasConfig(from)) throw new CortexError("not_initialized", `${from} has no Cortex project to move.`, 400);
  const tracked = (await git(p.path, ["ls-files", "--", CORTEX_DIR])).out.length > 0;
  const staging = `${from}.moving`;
  if (existsSync(staging)) throw new CortexError("conflict", `${staging} is left from an earlier attempt; rename it back to ${CORTEX_DIR} first.`, 409);
  try {
    renameSync(from, staging);
  } catch (e) {
    throw new CortexError(
      "busy",
      `${from} is in use (a board, an MCP server or an editor has it open): close them and run this again. Nothing was changed. (${(e as Error).message})`,
      409,
    );
  }
  cpSync(staging, to, { recursive: true, filter: (src) => basename(src) !== ".index" });
  await commitKnowledge(to, `Cortex: moved from ${from}`);
  try {
    rmSync(staging, { recursive: true, force: true });
    return { from, to, tracked };
  } catch {
    return { from, to, tracked, leftover: staging }; // the hub already serves the copy; the old one only needs deleting
  }
}
