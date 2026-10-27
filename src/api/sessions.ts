import { appendFileSync, chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newToken, tokenHash } from "../hub/crypto.js";

// Board sessions for single-project mode. The cookie used to be the actor's API token itself, so a stolen
// cookie was a stolen API key and logging out ended nothing. Now the cookie is a random session key; only
// its SHA-256 hash is kept, in .cortex/.sessions.json (git-ignored, owner-only). Revoking is deleting a line.

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FILE = ".sessions.json";

interface Session {
  actor: string;
  created: string;
  expires: string;
}

export class SessionStore {
  private file: string;
  private data: Record<string, Session> = {};
  private mtime = -1;

  constructor(private cortexDir: string) {
    this.file = join(cortexDir, FILE);
  }

  create(actorId: string, now = Date.now()): string {
    this.load();
    const key = newToken("cs");
    this.data[tokenHash(key)] = { actor: actorId, created: new Date(now).toISOString(), expires: new Date(now + SESSION_TTL_MS).toISOString() };
    this.prune(now);
    this.save();
    return key;
  }

  // The actor behind a session key, or null when it is unknown, revoked or expired.
  resolve(key: string | undefined, now = Date.now()): string | null {
    if (!key) return null;
    this.load();
    const s = this.data[tokenHash(key)];
    return s && Date.parse(s.expires) > now ? s.actor : null;
  }

  revoke(key: string | undefined): void {
    if (!key) return;
    this.load();
    const h = tokenHash(key);
    if (!(h in this.data)) return;
    delete this.data[h];
    this.save();
  }

  // Ends every session of one actor, or of everyone. Returns how many were ended.
  revokeAll(actorId?: string): number {
    this.load();
    const before = Object.keys(this.data).length;
    for (const [h, s] of Object.entries(this.data)) if (!actorId || s.actor === actorId) delete this.data[h];
    const ended = before - Object.keys(this.data).length;
    if (ended) this.save();
    return ended;
  }

  count(actorId?: string): number {
    this.load();
    return Object.values(this.data).filter((s) => !actorId || s.actor === actorId).length;
  }

  private prune(now: number): void {
    for (const [h, s] of Object.entries(this.data)) if (Date.parse(s.expires) <= now) delete this.data[h];
  }

  // Re-read when the file changes, so `cortexboard logout` in a terminal takes effect on a running server.
  private load(): void {
    let m: number;
    try {
      m = statSync(this.file).mtimeMs;
    } catch {
      this.data = {};
      this.mtime = 0;
      return;
    }
    if (m === this.mtime) return;
    try {
      this.data = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Session>;
    } catch {
      this.data = {}; // a damaged file only costs everyone a fresh login
    }
    this.mtime = m;
  }

  private save(): void {
    const fresh = !existsSync(this.file);
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), { encoding: "utf8", mode: 0o600 });
    if (fresh) ignoreInGit(this.cortexDir, FILE);
    this.mtime = statSync(this.file).mtimeMs;
  }
}

// Projects created before sessions existed have a .gitignore without this file; add it the first time it is written.
function ignoreInGit(cortexDir: string, name: string): void {
  const gi = join(cortexDir, ".gitignore");
  try {
    const text = existsSync(gi) ? readFileSync(gi, "utf8") : "";
    if (!text.split(/\r?\n/).includes(name)) appendFileSync(gi, `${text && !text.endsWith("\n") ? "\n" : ""}${name}\n`, "utf8");
  } catch {
    // read-only checkout: nothing to protect against
  }
  try {
    chmodSync(join(cortexDir, name), 0o600);
  } catch {
    // Windows ignores POSIX modes
  }
}
