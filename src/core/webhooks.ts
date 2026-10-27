import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import type { Cortex } from "./cortex.js";
import { paths } from "./project.js";
import type { Activity } from "./types.js";

// Outgoing webhooks: every entry in the activity log (an AI's change and why, an item created or
// moved, a draft proposed or approved, a discussion decided...) can be POSTed to other tools, a chat
// channel or a CI job. Configured in cortex.config.yaml, secrets in the git-ignored .secrets.yaml:
//
//   webhooks:                              # .cortex/cortex.config.yaml
//     - name: slack-bridge
//       url: https://hooks.example.com/cortex
//       events: ["item.*", "draft.proposed", "code_change"]   # optional; default: everything
//
//   webhooks:                              # .cortex/.secrets.yaml (optional)
//     slack-bridge: <shared secret>        # adds X-Cortex-Signature: sha256=<hmac of the body>
//
// The process that writes the entry delivers it (a board, an MCP server, the CLI), so nothing is sent
// twice: the file watcher's "something changed" pings carry no entry. Delivery is fire-and-forget with
// one retry; a slow or failing endpoint never holds up a write. Failures go to stderr (stdout is the
// MCP protocol's).

export interface WebhookConfig {
  name: string;
  url: string;
  events?: string[]; // action names; "item.*" matches a prefix
}

export interface WebhookPayload {
  event: string;
  project: string;
  delivered_at: string;
  entry: Activity;
}

const TIMEOUT_MS = 5000;
const RETRY_MS = 2000;

export function matches(events: string[] | undefined, action: string): boolean {
  if (!events?.length) return true;
  return events.some((e) => (e.endsWith(".*") ? action.startsWith(e.slice(0, -1)) : e === action));
}

export function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export class Webhooks {
  private inflight = new Set<Promise<void>>();

  constructor(private c: Cortex) {
    c.events.on("change", (e: { type: string; entry?: Activity }) => {
      if (e.type === "activity" && e.entry) this.dispatch(e.entry);
    });
  }

  private hooks(): WebhookConfig[] {
    const list = this.c.project.config.webhooks;
    if (!Array.isArray(list)) return [];
    return list.filter((h) => h && typeof h.name === "string" && typeof h.url === "string" && /^https?:\/\//.test(h.url));
  }

  private secrets(): Record<string, string> {
    const file = paths(this.c.project.dir).secrets;
    if (!existsSync(file)) return {};
    try {
      return (YAML.parse(readFileSync(file, "utf8"))?.webhooks ?? {}) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private dispatch(entry: Activity): void {
    const hooks = this.hooks().filter((h) => matches(h.events, entry.action));
    if (!hooks.length) return;
    const secrets = this.secrets();
    const payload: WebhookPayload = { event: entry.action, project: this.c.project.config.project.name, delivered_at: new Date().toISOString(), entry };
    const body = JSON.stringify(payload);
    for (const h of hooks) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "user-agent": "cortexboard-webhook",
        "x-cortex-event": entry.action,
        "x-cortex-delivery": entry.id,
      };
      const secret = secrets[h.name];
      if (typeof secret === "string" && secret) headers["x-cortex-signature"] = sign(secret, body);
      const p = this.deliver(h, headers, body).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }
  }

  private async deliver(h: WebhookConfig, headers: Record<string, string>, body: string): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(h.url, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (res.ok) return;
        if (attempt === 2 || res.status < 500) {
          console.error(`⚠ webhook ${h.name}: ${res.status} ${res.statusText}`);
          return;
        }
      } catch (e) {
        if (attempt === 2) {
          console.error(`⚠ webhook ${h.name}: ${(e as Error).message}`);
          return;
        }
      }
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }

  // Resolves when every delivery started so far has finished (tests, and a clean shutdown).
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }
}
