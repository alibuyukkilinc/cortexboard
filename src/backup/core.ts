import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { CortexError } from "../core/types.js";
import { nowIso } from "../util/text.js";
import type { Entry } from "./archive.js";
import { open, seal, tar, untar } from "./archive.js";
import type { Provider, RemoteFile } from "./providers.js";
import { BUNNY_REGIONS, bunny, googleDevicePoll, googleDeviceStart, googleDrive } from "./providers.js";

// Backups of a hub or of a single project (task 01M3NQYNRX7X7Z3660KFA2WHZQ), to BunnyCDN Storage or Google
// Drive. What differs between the two is a BackupTarget: where the settings and keys live, the file names, and
// what goes into the archive. The archive always leaves encrypted: it carries knowledge (and, for a hub,
// password hashes) and goes to someone else's servers. The keys live in backup.secrets.yaml, owner-only,
// never in an archive and never sent back out by the API.

export type ProviderName = "bunny" | "gdrive";

export interface BackupSettings {
  provider?: ProviderName; // unset = bunny (the first version wrote no provider)
  storage_zone?: string; // bunny
  region?: string; // bunny: "" or "de" = Falkenstein; uk, ny, la, sg, se, br, jh, syd
  folder_id?: string; // gdrive: the Drive folder, found or made on first use
  path?: string; // bunny: folder inside the zone; gdrive: the Drive folder's name
  interval_hours?: number; // 0 or unset = only on request
  keep?: number; // archives kept, oldest deleted first; default 14
  endpoint?: string; // override the storage host (tests, a proxy)
}

export interface BackupSecrets {
  access_key?: string; // bunny: the storage zone's password
  passphrase?: string; // the archive key
  google_client_id?: string;
  google_client_secret?: string;
  google_refresh_token?: string;
}

export interface BackupTarget {
  kind: "hub" | "project";
  secretsFile: string;
  lastFile: string; // the last result, so a restart still knows when the last one ran
  prefix: string; // archive names start with this: cortex-hub-, cortex-<project>-
  pattern: RegExp; // which files in the folder are this target's archives
  defaultPath: string;
  settings(): BackupSettings | undefined;
  save(settings: BackupSettings): void;
  snapshot(): Entry[];
}

export interface BackupResult {
  at: string;
  status: "ok" | "failed";
  message: string;
  file?: string;
  bytes?: number;
  deleted?: string[];
  last_ok?: string;
}

export type RemoteBackup = RemoteFile;

export const PASSPHRASE_MIN = 12;

// ---- settings and keys -----------------------------------------------------------------------

export function readSecrets(t: BackupTarget): BackupSecrets {
  return existsSync(t.secretsFile) ? ((YAML.parse(readFileSync(t.secretsFile, "utf8")) as BackupSecrets | null) ?? {}) : {};
}

export function writeSecrets(file: string, s: BackupSecrets): void {
  const clean = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== ""));
  writeFileSync(file, "# Backup storage keys and archive passphrase. Never commit, never share.\n" + YAML.stringify(clean), { encoding: "utf8", mode: 0o600 });
}

const providerOf = (b: BackupSettings | undefined): ProviderName => (b?.provider === "gdrive" ? "gdrive" : "bunny");

export function backupStatus(t: BackupTarget) {
  const b = t.settings();
  const s = readSecrets(t);
  const provider = providerOf(b);
  const google = { has_client: !!(s.google_client_id && s.google_client_secret), connected: !!s.google_refresh_token };
  return {
    settings: b ? { ...b, provider } : null,
    provider,
    has_access_key: !!s.access_key,
    has_passphrase: !!s.passphrase,
    google,
    // Ready to back up: what the chosen provider needs, plus the archive key.
    ready: !!b && !!s.passphrase && (provider === "bunny" ? !!b.storage_zone && !!s.access_key : google.has_client && google.connected),
  };
}

export interface BackupInput extends Partial<BackupSettings> {
  access_key?: string;
  passphrase?: string;
  google_client_id?: string;
  google_client_secret?: string;
}

// Saves the settings and whatever keys are given. The archive key is the person's own when they type one
// (changing it later is allowed: older archives still need the old one); otherwise the first save makes one
// and returns it, the only time it is shown.
export function configureBackup(t: BackupTarget, input: BackupInput): { settings: BackupSettings; passphrase?: string; passphrase_changed?: boolean } {
  const cur = t.settings();
  const provider: ProviderName = input.provider === "gdrive" || input.provider === "bunny" ? input.provider : providerOf(cur);
  const pick = <K extends keyof BackupSettings>(k: K) => (input[k] !== undefined ? input[k] : cur?.[k]);
  const num = (v: unknown, fallback: number, max: number) => {
    const n = v === undefined || v === null || v === "" ? fallback : Number(v);
    if (!Number.isFinite(n) || n < 0 || n > max) throw new CortexError("invalid_backup", `A number between 0 and ${max} was expected.`, 400);
    return Math.floor(n);
  };
  const path = String(pick("path") ?? t.defaultPath)
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!/^[\w ./-]{1,200}$/.test(path) || path.includes(".."))
    throw new CortexError("invalid_backup", "path: a folder name (letters, digits, space, - _ . /).", 400);

  const settings: BackupSettings = { provider, path, interval_hours: num(pick("interval_hours"), 0, 24 * 30), keep: Math.max(1, num(pick("keep"), 14, 1000)) };
  // The other provider's settings stay, so switching back and forth loses nothing.
  const zone = String(pick("storage_zone") ?? "").trim();
  if (zone) {
    if (!/^[a-z0-9-]{1,64}$/i.test(zone)) throw new CortexError("invalid_backup", "storage_zone: the Bunny storage zone's name (letters, digits, -).", 400);
    settings.storage_zone = zone;
  } else if (provider === "bunny") throw new CortexError("invalid_backup", "storage_zone: the Bunny storage zone's name.", 400);
  const region = String(pick("region") ?? "")
    .trim()
    .toLowerCase();
  if (!BUNNY_REGIONS.has(region))
    throw new CortexError("invalid_backup", `region: one of ${[...BUNNY_REGIONS].filter(Boolean).join(", ")}, or empty for Falkenstein.`, 400);
  if (region || settings.storage_zone) settings.region = region;
  // A new Drive folder name means a new folder: found or made again on next use.
  if (cur?.folder_id && path === (cur.path ?? t.defaultPath)) settings.folder_id = cur.folder_id;
  const endpoint = pick("endpoint");
  if (endpoint) settings.endpoint = String(endpoint);

  const secrets = readSecrets(t);
  if (input.access_key?.trim()) secrets.access_key = input.access_key.trim();
  const clientId = input.google_client_id?.trim();
  if (clientId && clientId !== secrets.google_client_id) {
    secrets.google_client_id = clientId;
    delete secrets.google_refresh_token; // a sign-in belongs to the client that made it
    delete settings.folder_id;
  }
  if (input.google_client_secret?.trim()) secrets.google_client_secret = input.google_client_secret.trim();
  if (provider === "bunny" && !secrets.access_key) throw new CortexError("invalid_backup", "access_key: the storage zone's password.", 400);

  let shown: string | undefined;
  let changed = false;
  const typed = input.passphrase?.trim();
  if (typed) {
    if (typed.length < PASSPHRASE_MIN) throw new CortexError("invalid_backup", `passphrase: at least ${PASSPHRASE_MIN} characters.`, 400);
    changed = !!secrets.passphrase && secrets.passphrase !== typed;
    secrets.passphrase = typed;
  } else if (!secrets.passphrase) shown = secrets.passphrase = randomBytes(24).toString("base64url");

  t.save(settings);
  writeSecrets(t.secretsFile, secrets);
  return { settings, ...(shown ? { passphrase: shown } : {}), ...(changed ? { passphrase_changed: true } : {}) };
}

// ---- the storage ------------------------------------------------------------------------------

function provider(t: BackupTarget): { provider: Provider; passphrase: string; keep: number } {
  const b = t.settings();
  const s = readSecrets(t);
  if (!b) throw new CortexError("backup_not_configured", "Set up backups first.", 400);
  if (!s.passphrase) throw new CortexError("backup_not_configured", "The archive passphrase is missing: save the backup settings once.", 400);
  const path = b.path ?? t.defaultPath;
  if (providerOf(b) === "gdrive") {
    if (!s.google_client_id || !s.google_client_secret)
      throw new CortexError("backup_not_configured", "The Google OAuth client id and secret are missing.", 400);
    if (!s.google_refresh_token) throw new CortexError("backup_not_configured", "Google Drive is not connected yet.", 400);
    const p = googleDrive({
      clientId: s.google_client_id,
      clientSecret: s.google_client_secret,
      refreshToken: s.google_refresh_token,
      endpoint: b.endpoint,
      folder: path,
      folderId: b.folder_id,
      onFolder: (id) => t.save({ ...(t.settings() ?? b), folder_id: id }),
    });
    return { provider: p, passphrase: s.passphrase, keep: b.keep ?? 14 };
  }
  if (!b.storage_zone) throw new CortexError("backup_not_configured", "The Bunny storage zone is missing.", 400);
  if (!s.access_key) throw new CortexError("backup_not_configured", "The storage zone's password (AccessKey) is missing.", 400);
  return {
    provider: bunny({ zone: b.storage_zone, region: b.region, path, accessKey: s.access_key, endpoint: b.endpoint }),
    passphrase: s.passphrase,
    keep: b.keep ?? 14,
  };
}

export async function listBackups(t: BackupTarget): Promise<RemoteBackup[]> {
  return (await provider(t).provider.list()).filter((x) => t.pattern.test(x.name)).sort((a, b) => b.name.localeCompare(a.name));
}

export function checkName(t: BackupTarget, name: string): string {
  if (!t.pattern.test(name) || /[\\/]/.test(name)) throw new CortexError("invalid_request", `"${name}" is not a backup name.`, 400);
  return name;
}

// The sealed archive, as stored.
export async function fetchBackup(t: BackupTarget, name: string): Promise<Buffer> {
  return provider(t).provider.get(checkName(t, name));
}

// Downloads and opens an archive: with the passphrase given, else with the stored one.
export async function openBackup(t: BackupTarget, name: string, passphrase?: string): Promise<{ entries: Entry[]; passphrase: string }> {
  const sealed = await fetchBackup(t, name);
  const pass = passphrase?.trim() || readSecrets(t).passphrase;
  if (!pass) throw new CortexError("invalid_request", "Give the archive passphrase.", 400);
  return { entries: untar(open(sealed, pass)), passphrase: pass };
}

export async function runBackup(t: BackupTarget): Promise<BackupResult> {
  const at = nowIso();
  try {
    const r = provider(t);
    const sealed = seal(tar(t.snapshot()), r.passphrase);
    const file = `${t.prefix}${at.replace(/[:.]/g, "-")}.cxbk`;
    await r.provider.put(file, sealed);
    // Keep the newest `keep`, oldest out. A failed delete leaves an extra archive, never a missing one.
    const deleted: string[] = [];
    for (const old of (await listBackups(t)).slice(r.keep)) {
      try {
        await r.provider.remove(old.name);
        deleted.push(old.name);
      } catch {
        // tried again on the next run
      }
    }
    return { at, status: "ok", message: `Uploaded ${file}.`, file, bytes: sealed.length, ...(deleted.length ? { deleted } : {}) };
  } catch (e) {
    return { at, status: "failed", message: (e as Error).message };
  }
}

// ---- connecting Google Drive -------------------------------------------------------------------

// The device code waits here between the start and the person's approval; never sent to the browser.
const pendingDevice = new Map<string, { device_code: string; until: number }>();

function googleAuth(t: BackupTarget) {
  const s = readSecrets(t);
  if (!s.google_client_id || !s.google_client_secret) throw new CortexError("backup_not_configured", "Save the Google OAuth client id and secret first.", 400);
  return { clientId: s.google_client_id, clientSecret: s.google_client_secret, endpoint: t.settings()?.endpoint };
}

export async function googleConnectStart(t: BackupTarget) {
  const r = await googleDeviceStart(googleAuth(t));
  pendingDevice.set(t.secretsFile, { device_code: r.device_code, until: Date.now() + r.expires_in * 1000 });
  return { user_code: r.user_code, verification_url: r.verification_url, expires_in: r.expires_in, interval: r.interval };
}

// One look; the board asks again every `interval` seconds until it is not pending.
export async function googleConnectPoll(t: BackupTarget): Promise<{ status: "pending" | "connected" | "denied" | "expired"; message?: string }> {
  const p = pendingDevice.get(t.secretsFile);
  if (!p || p.until < Date.now()) {
    pendingDevice.delete(t.secretsFile);
    return { status: "expired" };
  }
  const r = await googleDevicePoll(googleAuth(t), p.device_code);
  if (r.status === "pending" || r.status === "slow_down") return { status: "pending" };
  pendingDevice.delete(t.secretsFile);
  if (r.status !== "connected") return { status: r.status };
  const s = readSecrets(t);
  s.google_refresh_token = r.refresh_token;
  writeSecrets(t.secretsFile, s);
  const b = t.settings();
  if (b?.folder_id) {
    const { folder_id: _old, ...rest } = b;
    t.save(rest);
  }
  // Find or make the folder now, so a Drive API that is not enabled shows up here and not at the first backup.
  try {
    const p2 = provider(t).provider as ReturnType<typeof googleDrive>;
    await p2.folderId();
    return { status: "connected" };
  } catch (e) {
    return { status: "connected", message: (e as Error).message };
  }
}

export function disconnectGoogle(t: BackupTarget): void {
  const s = readSecrets(t);
  delete s.google_refresh_token;
  writeSecrets(t.secretsFile, s);
}

// ---- one at a time, and on a timer ---------------------------------------------------------------

export class BackupRunner {
  private running: Promise<BackupResult> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(readonly target: () => BackupTarget) {}

  get last(): BackupResult | null {
    const f = this.target().lastFile;
    try {
      return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as BackupResult) : null;
    } catch {
      return null;
    }
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  now(): Promise<BackupResult> {
    const t = this.target();
    this.running ??= runBackup(t)
      .then((r) => {
        const prev = this.last;
        const keep = r.status === "ok" ? r : { ...r, last_ok: prev?.status === "ok" ? prev.at : prev?.last_ok };
        writeFileSync(t.lastFile, JSON.stringify(keep, null, 2), "utf8");
        if (r.status === "failed") console.error(`⚠ backup: ${r.message}`);
        return r;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  // Every 10 minutes: due when interval_hours is set and the last good backup is older than that. Read each
  // time, so a change on the board applies without a restart.
  start(): void {
    const tick = () => {
      const hours = this.target().settings()?.interval_hours ?? 0;
      if (!(hours > 0) || this.running) return;
      const last = this.last;
      const lastOk = last?.status === "ok" ? last.at : last?.last_ok;
      if (!lastOk || Date.now() - Date.parse(lastOk) >= hours * 3_600_000) void this.now();
    };
    tick();
    this.timer = setInterval(tick, 10 * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
