import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import YAML from "yaml";
import type { BackupInput, BackupResult, BackupSettings, BackupTarget, RemoteBackup } from "../backup/core.js";
import * as core from "../backup/core.js";
import type { Entry } from "../backup/archive.js";
import { collect, open, untar, writeEntries } from "../backup/archive.js";
import { CORTEX_DIR } from "../core/project.js";
import { CortexError } from "../core/types.js";
import { nowIso } from "../util/text.js";
import { knowledgeWhere } from "./knowledge.js";
import type { HubStore } from "./store.js";

// Hub backups (task 01M3NQYNRX7X7Z3660KFA2WHZQ). One archive holds everything needed to bring the hub back:
// a consistent copy of hub.db (people, password hashes, agents, memberships), hub.yaml, and every project's
// knowledge (the hub-held folders with their git history, and .cortex of projects that keep it in their
// repository). Storage, encryption and keys: src/backup/core.ts.
//
// A restore from the board cannot swap hub.db under the running hub, so it is staged in <hub>/.restore and
// applied by the next `hub start`, before the database is opened. The hub as it was is kept beside it.

export type { BackupResult, BackupSettings, RemoteBackup };
export { open, tar, untar } from "../backup/archive.js";

const SECRETS = "backup.secrets.yaml";
const STAGE = ".restore";
const HUB_PATTERN = /^cortex-hub-.*\.cxbk$/;

export function hubTarget(store: HubStore): BackupTarget {
  return {
    kind: "hub",
    secretsFile: join(store.dir, SECRETS),
    lastFile: join(store.dir, "backup-last.json"),
    prefix: "cortex-hub-",
    pattern: HUB_PATTERN,
    defaultPath: "cortex-hub",
    settings: () => store.settings.backup,
    save: (backup) => store.saveSettings({ backup }),
    snapshot: () => snapshot(store),
  };
}

export const backupStatus = (store: HubStore) => core.backupStatus(hubTarget(store));
export const configureBackup = (store: HubStore, input: BackupInput) => core.configureBackup(hubTarget(store), input);
export const listBackups = (store: HubStore) => core.listBackups(hubTarget(store));
export const runBackup = (store: HubStore) => core.runBackup(hubTarget(store));

// Everything the hub needs, as tar entries. hub.db is copied with VACUUM INTO, a consistent snapshot even
// while the hub is writing to it.
export function snapshot(store: HubStore): Entry[] {
  const entries: Entry[] = [];
  const tmp = join(tmpdir(), `cortex-hub-db-${randomBytes(6).toString("hex")}.db`);
  try {
    const db = new DatabaseSync(join(store.dir, "hub.db"), { readOnly: true });
    try {
      db.prepare("VACUUM INTO ?").run(tmp);
    } finally {
      db.close();
    }
    entries.push({ name: "hub/hub.db", data: readFileSync(tmp), mtime: Date.now() });
  } finally {
    rmSync(tmp, { force: true });
  }
  entries.push({ name: "hub/hub.yaml", data: readFileSync(join(store.dir, "hub.yaml")), mtime: Date.now() });
  collect(join(store.dir, "projects"), "hub/projects/", entries);
  // Projects that keep their knowledge in their repository: their .cortex, under repo-projects/<id>/.
  for (const p of store.projects()) {
    if (knowledgeWhere(store.dir, p) === "repo") collect(join(p.path, CORTEX_DIR), `repo-projects/${p.id}/`, entries);
  }
  entries.push({
    name: "MANIFEST.json",
    data: Buffer.from(
      JSON.stringify(
        {
          kind: "hub",
          made_at: nowIso(),
          org: store.settings.org,
          projects: store.projects().map((p) => ({ id: p.id, path: p.path, knowledge: knowledgeWhere(store.dir, p) })),
        },
        null,
        2,
      ),
    ),
    mtime: Date.now(),
  });
  return entries;
}

// Brings an archive back into an empty folder (never over a running hub): a local file, or a name in the
// storage. The restored hub gets the passphrase that opened it, so backing it up again keeps the same key;
// restored from the storage, it gets this hub's storage keys too.
export async function restoreBackup(store: HubStore | null, source: string, to: string, passphrase?: string): Promise<{ files: number; to: string }> {
  if (existsSync(to) && readdirSync(to).length) throw new CortexError("invalid_request", `${to} is not empty: restore into a new folder.`, 400);
  let entries: Entry[];
  let pass: string;
  let secrets: core.BackupSecrets = {};
  if (existsSync(source)) {
    if (!passphrase) throw new CortexError("invalid_request", "Give the passphrase that was shown when backups were set up.", 400);
    entries = untar(open(readFileSync(source), passphrase));
    pass = passphrase;
  } else {
    if (!store) throw new CortexError("not_found", `No file ${source}.`, 404);
    const t = hubTarget(store);
    ({ entries, passphrase: pass } = await core.openBackup(t, source, passphrase));
    secrets = core.readSecrets(t);
  }
  writeEntries(entries, to);
  if (existsSync(join(to, "hub", "hub.yaml"))) core.writeSecrets(join(to, "hub", SECRETS), { ...secrets, passphrase: pass });
  return { files: entries.length, to };
}

// ---- restoring over this hub, from the board ---------------------------------------------------

export interface StagedRestore {
  name: string;
  staged_at: string;
  staged_by: string;
  org?: string;
  made_at?: string;
  projects: { id: string; path: string }[];
}

const stageDir = (hubDir: string) => join(hubDir, STAGE);
const stageInfo = (hubDir: string) => join(stageDir(hubDir), "restore.json");

export function pendingRestore(hubDir: string): StagedRestore | null {
  try {
    const { passphrase: _secret, ...info } = JSON.parse(readFileSync(stageInfo(hubDir), "utf8")) as StagedRestore & { passphrase?: string };
    return info;
  } catch {
    return null;
  }
}

export function cancelRestore(hubDir: string): void {
  rmSync(stageDir(hubDir), { recursive: true, force: true });
}

// Downloads, opens and checks the archive, and lays it out in <hub>/.restore for the next start. adopt: the
// passphrase given becomes this hub's key (a reinstalled hub made a new one; the old backups need the old).
export async function stageRestore(store: HubStore, name: string, by: string, opts: { passphrase?: string; adopt?: boolean } = {}): Promise<StagedRestore> {
  const t = hubTarget(store);
  const { entries, passphrase } = await core.openBackup(t, name, opts.passphrase);
  const names = new Set(entries.map((e) => e.name));
  if (!names.has("hub/hub.db") || !names.has("hub/hub.yaml")) throw new CortexError("invalid_backup", `${name} is not a hub backup.`, 400);
  const manifest = (() => {
    try {
      return JSON.parse(entries.find((e) => e.name === "MANIFEST.json")?.data.toString("utf8") ?? "{}") as {
        org?: string;
        made_at?: string;
        projects?: { id: string; path: string }[];
      };
    } catch {
      return {};
    }
  })();
  cancelRestore(store.dir);
  writeEntries(entries, stageDir(store.dir));
  const info: StagedRestore = {
    name,
    staged_at: nowIso(),
    staged_by: by,
    ...(manifest.org ? { org: manifest.org } : {}),
    ...(manifest.made_at ? { made_at: manifest.made_at } : {}),
    projects: (manifest.projects ?? []).map((p) => ({ id: p.id, path: p.path })),
  };
  const adopt = opts.adopt && opts.passphrase?.trim() && passphrase !== core.readSecrets(t).passphrase;
  writeFileSync(stageInfo(store.dir), JSON.stringify({ ...info, ...(adopt ? { passphrase } : {}) }, null, 2), { encoding: "utf8", mode: 0o600 });
  return info;
}

// Settings that belong to this machine, not to the hub that was backed up: where it listens, how it is
// reached, where its backups go and how it sends email (its key is not in the archive). The restored hub.yaml
// gets these from the hub it replaces.
const MACHINE_KEYS = ["host", "port", "public_url", "allowed_hosts", "trust_proxy", "cookie_secure", "backup", "mail"] as const;

// Renames, retrying for a while: on Windows the hub that asked for the restart may still be letting go of its files.
function renameRetry(from: string, to: string): void {
  const until = Date.now() + 20_000;
  for (;;) {
    try {
      return renameSync(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!(code === "EPERM" || code === "EBUSY" || code === "EACCES") || Date.now() > until) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

// Called by `hub start` before the database is opened. The hub folder as it was moves aside to
// <hub>-before-restore-<time> (going back = renaming it back), the staged one takes its place.
export function applyPendingRestore(hubDir: string): { name: string; aside: string; repoProjects: string[] } | null {
  const staged = stageDir(hubDir);
  if (!existsSync(join(staged, "restore.json"))) return null;
  const raw = JSON.parse(readFileSync(join(staged, "restore.json"), "utf8")) as StagedRestore & { passphrase?: string };
  const aside = join(dirname(hubDir), `${basename(hubDir)}-before-restore-${nowIso().replace(/[:.]/g, "-")}`);
  const incoming = `${hubDir}.restoring`;
  rmSync(incoming, { recursive: true, force: true });

  renameRetry(staged, incoming);
  try {
    renameRetry(hubDir, aside);
  } catch (e) {
    renameSync(incoming, staged);
    throw new CortexError("busy", `Could not move ${hubDir} aside (${(e as Error).message}). Nothing was changed; the restore waits for the next start.`, 409);
  }
  try {
    renameRetry(join(incoming, "hub"), hubDir);
  } catch (e) {
    renameSync(aside, hubDir);
    renameSync(incoming, staged);
    throw new CortexError("busy", `Could not put the restored hub in place (${(e as Error).message}). The hub is as it was.`, 409);
  }

  // This machine's settings and keys, over the restored ones.
  const before = (YAML.parse(readFileSync(join(aside, "hub.yaml"), "utf8")) ?? {}) as Record<string, unknown>;
  const file = join(hubDir, "hub.yaml");
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  for (const k of MACHINE_KEYS) {
    if (before[k] === undefined) doc.delete(k);
    else doc.set(k, before[k]);
  }
  writeFileSync(file, doc.toString(), "utf8");
  const secrets: core.BackupSecrets = existsSync(join(aside, SECRETS))
    ? ((YAML.parse(readFileSync(join(aside, SECRETS), "utf8")) as core.BackupSecrets) ?? {})
    : {};
  if (raw.passphrase) secrets.passphrase = raw.passphrase;
  if (Object.keys(secrets).length) core.writeSecrets(join(hubDir, SECRETS), secrets);
  if (existsSync(join(aside, "backup-last.json"))) copyFileSync(join(aside, "backup-last.json"), join(hubDir, "backup-last.json"));

  // .cortex folders of projects that keep knowledge in their repository: left for a person to put back,
  // never written into a code folder behind anyone's back.
  const repoProjects = existsSync(join(incoming, "repo-projects")) ? readdirSync(join(incoming, "repo-projects")) : [];
  if (repoProjects.length) {
    mkdirSync(join(hubDir, "restored-repo-projects"), { recursive: true });
    renameSync(join(incoming, "repo-projects"), join(hubDir, "restored-repo-projects", raw.staged_at.replace(/[:.]/g, "-")));
  }
  rmSync(incoming, { recursive: true, force: true });
  return { name: raw.name, aside, repoProjects };
}
