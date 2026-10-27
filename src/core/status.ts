import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, stringifyFrontmatter } from "../store/frontmatter.js";
import { nowIso, ulid } from "../util/text.js";
import type { Cortex } from "./cortex.js";
import type { Actor } from "./types.js";
import { CortexError } from "./types.js";

// The project status: one short record of where the project stands and what comes next, the handoff between
// sessions and people. It lives in .cortex/status.md, is written directly (an agent keeping it current must not
// wait on a review), keeps its last versions in .cortex/status-history/, and says when it has gone stale.

export interface ProjectStatus {
  body: string;
  updated_at: string;
  updated_by: string;
}

export interface StatusStaleness {
  stale: boolean;
  reason?: "days" | "changes";
  days_old: number;
  changes_since: number; // logged entries (what + why) written after the status
  limits: { days: number; changes: number };
}

export const STATUS_DEFAULTS = { stale_days: 3, stale_changes: 20 };
const MAX_VERSIONS = 20;
const MAX_CHARS = 8000;
const DAY = 86_400_000;

export class StatusService {
  constructor(private c: Cortex) {}

  private get file() {
    return join(this.c.project.dir, "status.md");
  }
  private get historyDir() {
    return join(this.c.project.dir, "status-history");
  }

  get(): (ProjectStatus & StatusStaleness) | null {
    if (!existsSync(this.file)) return null;
    const { meta, body } = parseFrontmatter<Omit<ProjectStatus, "body">>(readFileSync(this.file, "utf8"));
    const status = { body, updated_at: String(meta.updated_at ?? ""), updated_by: String(meta.updated_by ?? "") };
    return { ...status, ...this.staleness(status.updated_at) };
  }

  // Stale after too long or after too much happened: either says the next reader may be misled.
  staleness(updatedAt: string, now = Date.now()): StatusStaleness {
    const cfg = { ...STATUS_DEFAULTS, ...this.c.project.config.status };
    const days_old = Math.floor(((now - Date.parse(updatedAt)) / DAY) * 10) / 10;
    const changes_since = this.c.index.countLoggedSince(updatedAt);
    const reason = days_old >= cfg.stale_days ? "days" : changes_since >= cfg.stale_changes ? "changes" : undefined;
    return { stale: !!reason, ...(reason ? { reason } : {}), days_old, changes_since, limits: { days: cfg.stale_days, changes: cfg.stale_changes } };
  }

  put(actor: Actor, input: { body?: unknown; reason?: unknown }) {
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!body) throw new CortexError("invalid_status", "Pass the status text as body: where the project stands, what is next.", 400);
    if (body.length > MAX_CHARS)
      throw new CortexError("invalid_status", `Keep the status under ${MAX_CHARS} characters: it is read at every session start.`, 400);
    const previous = existsSync(this.file) ? readFileSync(this.file, "utf8") : null;
    if (previous !== null) this.keepVersion(previous);
    const status: ProjectStatus = { body, updated_at: nowIso(), updated_by: actor.id };
    writeFileSync(this.file, stringifyFrontmatter({ updated_at: status.updated_at, updated_by: status.updated_by }, body), "utf8");
    const reason = typeof input.reason === "string" && input.reason.trim() ? `: ${input.reason.trim()}` : "";
    this.c.activity.system(actor.id, "status.updated", `Updated the project status${reason}`, []);
    return { applied: true, message: "Project status updated.", status: { ...status, ...this.staleness(status.updated_at) } };
  }

  // Newest first, bodies included: there are at most MAX_VERSIONS and each is short.
  history(): (ProjectStatus & { version: string })[] {
    if (!existsSync(this.historyDir)) return [];
    return readdirSync(this.historyDir)
      .filter((n) => n.endsWith(".md"))
      .sort()
      .reverse()
      .map((n) => {
        const { meta, body } = parseFrontmatter<Omit<ProjectStatus, "body">>(readFileSync(join(this.historyDir, n), "utf8"));
        return { version: n.slice(0, -3), body, updated_at: String(meta.updated_at ?? ""), updated_by: String(meta.updated_by ?? "") };
      });
  }

  private keepVersion(text: string): void {
    mkdirSync(this.historyDir, { recursive: true });
    writeFileSync(join(this.historyDir, `${ulid()}.md`), text, "utf8");
    const all = readdirSync(this.historyDir)
      .filter((n) => n.endsWith(".md"))
      .sort();
    for (const old of all.slice(0, Math.max(0, all.length - MAX_VERSIONS))) unlinkSync(join(this.historyDir, old));
  }
}
