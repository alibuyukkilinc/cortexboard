import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { Project } from "../core/project.js";
import { paths } from "../core/project.js";
import { CortexError } from "../core/types.js";
import { nowIso } from "../util/text.js";
import type { Entry } from "./archive.js";
import { collect, writeEntries } from "./archive.js";
import type { BackupSettings, BackupTarget } from "./core.js";
import * as core from "./core.js";

// Backups of a single project that is not on a hub (task 01M3NQYNRX7X7Z3660KFA2WHZQ): its .cortex, to the same
// storages. Settings in cortex.config.yaml (backup:), keys in .cortex/backup.secrets.yaml (kept out of git).

const SECRETS = "backup.secrets.yaml";
const LAST = ".backup-last.json";
const PRIVATE = [SECRETS, LAST, ".restore/"];

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 40) || "project";

// Files that stay on this machine, and personal views: not part of a project's shared knowledge.
const skip = (name: string) => name === "views";

export function projectTarget(project: Project): BackupTarget {
  const name = slug(project.config.project.name);
  return {
    kind: "project",
    secretsFile: join(project.dir, SECRETS),
    lastFile: join(project.dir, LAST),
    prefix: `cortex-${name}-`,
    // A project's folder in the storage is its own: any Cortex archive there is one of its backups.
    pattern: /^cortex-(?!hub-).*\.cxbk$/,
    defaultPath: `cortex/${name}`,
    settings: () => project.config.backup,
    save: (settings) => saveProjectBackup(project, settings),
    snapshot: () => {
      const entries: Entry[] = [];
      collect(project.dir, "cortex/", entries, skip);
      entries.push({
        name: "MANIFEST.json",
        data: Buffer.from(JSON.stringify({ kind: "project", made_at: nowIso(), project: project.config.project.name }, null, 2)),
        mtime: Date.now(),
      });
      return entries;
    },
  };
}

// Writes backup: in cortex.config.yaml keeping its comments, and makes sure the keys never reach git.
function saveProjectBackup(project: Project, settings: BackupSettings): void {
  const file = paths(project.dir).config;
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  doc.set("backup", settings);
  writeFileSync(file, doc.toString(), "utf8");
  project.config.backup = settings;
  const ignore = join(project.dir, ".gitignore");
  const text = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  const have = new Set(text.split(/\r?\n/));
  const missing = PRIVATE.filter((l) => !have.has(l));
  if (missing.length) writeFileSync(ignore, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`, "utf8");
}

// What a restore replaces: everything in .cortex except what is this machine's own (keys, tokens, sessions,
// the index, personal views) and folders left from earlier restores.
const KEEP = new Set([".index", ".secrets.yaml", ".sessions.json", SECRETS, LAST, "views", ".gitignore", ".restore"]);

// Restores in place. What is there now moves to .cortex/.restore/before-<time> first, entry by entry (the
// folder itself may be held open by a board or an MCP server), then the archive is written. Going back =
// moving those entries back. The search index is rebuilt by the caller.
export async function restoreProject(
  project: Project,
  source: { name: string } | { file: string },
  opts: { passphrase?: string; adopt?: boolean } = {},
): Promise<{ files: number; aside: string }> {
  const t = projectTarget(project);
  let entries: Entry[];
  let pass: string;
  if ("file" in source) {
    const { open, untar } = await import("./archive.js");
    pass = opts.passphrase?.trim() || core.readSecrets(t).passphrase || "";
    if (!pass) throw new CortexError("invalid_request", "Give the archive passphrase.", 400);
    entries = untar(open(readFileSync(source.file), pass));
  } else ({ entries, passphrase: pass } = await core.openBackup(t, source.name, opts.passphrase));

  const files = entries.filter((e) => e.name.startsWith("cortex/")).map((e) => ({ ...e, name: e.name.slice("cortex/".length) }));
  if (!files.some((e) => e.name === "cortex.config.yaml")) throw new CortexError("invalid_backup", "Not a project backup (no cortex.config.yaml).", 400);

  const aside = join(project.dir, ".restore", `before-${nowIso().replace(/[:.]/g, "-")}`);
  mkdirSync(aside, { recursive: true });
  for (const name of readdirSync(project.dir)) {
    if (KEEP.has(name)) continue;
    try {
      renameSync(join(project.dir, name), join(aside, name));
    } catch (e) {
      throw new CortexError(
        "busy",
        `Could not move ${name} aside (${(e as Error).message}). What was moved is in ${aside}: move it back, close what holds the files, and try again.`,
        409,
      );
    }
  }
  // The restored settings, except where this machine's backups go: that stays as it is.
  const mine = project.config.backup;
  writeEntries(
    files.filter((e) => !KEEP.has(e.name.split("/")[0]!)),
    project.dir,
  );
  if (mine) saveProjectBackup(project, mine);
  if (opts.adopt && opts.passphrase?.trim() && pass !== core.readSecrets(t).passphrase) {
    core.writeSecrets(t.secretsFile, { ...core.readSecrets(t), passphrase: pass });
  }
  return { files: files.length, aside };
}
