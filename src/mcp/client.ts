import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { projectRoutes } from "../api/routes.js";
import { setErrorHandler } from "../api/server.js";
import type { Cortex } from "../core/cortex.js";
import type { Actor } from "../core/types.js";
import { CortexError } from "../core/types.js";
import type { Via } from "../core/provenance.js";
import { provenance } from "../core/provenance.js";

// MCP tools speak the project REST API, so a local project and a hub project behave exactly the same:
// the same routes, the same rules, and on a hub the same role and visibility checks.

export interface McpApi {
  where: string; // shown in the MCP instructions: "this folder" or the hub project
  // text: the body as a string; binary: the body as bytes (attachments). Otherwise parsed JSON.
  call(method: string, path: string, opts?: { query?: Record<string, unknown>; body?: unknown; text?: boolean; binary?: boolean }): Promise<unknown>;
  close(): Promise<void>;
  // The person this MCP session answers to, for approvals asked in the chat. Only the approval tools use
  // `as`, and only with the person's own answer in hand (elicitation, or a relayed quote the config allows).
  // Missing: approvals cannot be recorded from this session (no human actor, or a team server for now).
  human?: { id: string; as(via: Via): Pick<McpApi, "call"> };
}

function query(q: Record<string, unknown> | undefined): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(q ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    s.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const out = s.toString();
  return out ? `?${out}` : "";
}

function fail(status: number, payload: unknown): never {
  const e = (payload as { error?: { code?: string; message?: string; hint?: unknown } })?.error;
  throw new CortexError(e?.code ?? "error", e?.message ?? `Request failed (${status}).`, status, e?.hint);
}

// Same process: no network, no token. Used by `cortexboard mcp` inside a project.
// human: the person approvals asked in the chat are recorded as (see McpApi.human).
export async function localApi(cortex: Cortex, actor: Actor, opts: { human?: Actor } = {}): Promise<McpApi> {
  const app = Fastify({ logger: false });
  // One-time grants for requests made on the person's behalf: a random key that lives for one call, so
  // nothing the AI can send (it never builds these requests) switches the actor.
  const grants = new Map<string, Actor>();
  app.decorateRequest("cortex", null as unknown as Cortex);
  app.decorateRequest("actor", null as unknown as Actor);
  app.addHook("onRequest", async (req) => {
    req.cortex = cortex;
    const grant = req.headers["x-cortex-grant"];
    req.actor = (typeof grant === "string" && grants.get(grant)) || actor;
  });
  setErrorHandler(app);
  await app.register(projectRoutes, { prefix: "/api" });
  await app.ready();
  const call = async (method: string, path: string, o: Parameters<McpApi["call"]>[2] = {}, grant?: string) => {
    const res = await app.inject({
      method: method as "GET",
      url: `/api${path}${query(o.query)}`,
      ...(grant ? { headers: { "x-cortex-grant": grant } } : {}),
      ...(o.body !== undefined ? { payload: o.body as object } : {}),
    });
    if (res.statusCode >= 400) fail(res.statusCode, res.json());
    return o.binary ? res.rawPayload : o.text ? res.body : res.json();
  };
  const human = opts.human;
  if (human && human.kind !== "human") throw new CortexError("invalid_actor", `"${human.id}" is not a human actor.`, 400);
  return {
    where: `${cortex.project.config.project.name} (${cortex.project.root})`,
    call: (method, path, o) => call(method, path, o),
    close: () => app.close(),
    ...(human
      ? {
          human: {
            id: human.id,
            as: (via: Via) => ({
              async call(method, path, o) {
                const grant = randomUUID();
                grants.set(grant, human);
                try {
                  // Every audit entry and reply written by this request carries where the answer came from.
                  return await provenance.run(via, () => call(method, path, o, grant));
                } finally {
                  grants.delete(grant);
                }
              },
            }),
          },
        }
      : {}),
  };
}

// A project on a team server: the agent's token decides its role and what it can see.
export function remoteApi(hub: string, project: string, token: string): McpApi {
  const base = `${hub.replace(/\/+$/, "")}/api/p/${encodeURIComponent(project)}`;
  return {
    where: `${project} @ ${hub.replace(/\/+$/, "")}`,
    call: (method, path, opts) => remoteCall(hub, base, token, method, path, opts),
    close: async () => {},
  };
}

// The person's chat key (made on the board, one project): answers they give in this AI chat are recorded
// as theirs, with their role. Checked once here so a wrong key fails at start, not at the first question.
export async function withRemoteHuman(api: McpApi, hub: string, project: string, chatKey: string): Promise<McpApi> {
  const base = `${hub.replace(/\/+$/, "")}/api/p/${encodeURIComponent(project)}`;
  const ai = ((await api.call("GET", "/me")) as { actor: { id: string } }).actor.id;
  const as = (via: Via): Pick<McpApi, "call"> => ({
    call: (method, path, opts) => remoteCall(hub, base, chatKey, method, path, opts, Buffer.from(JSON.stringify(via)).toString("base64url")),
  });
  const me = (await as({ channel: "chat-elicitation", ai_actor: ai }).call("GET", "/me")) as { actor: { id: string; kind: string } };
  if (me.actor.kind !== "human") throw new CortexError("invalid_actor", "The chat key does not belong to a person.", 400);
  return { ...api, human: { id: me.actor.id, as } };
}

async function remoteCall(
  hub: string,
  base: string,
  token: string,
  method: string,
  path: string,
  opts: Parameters<McpApi["call"]>[2] = {},
  via?: string,
): Promise<unknown> {
  const res = await fetch(`${base}${path}${query(opts.query)}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(via ? { "x-cortex-via": via } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  }).catch((e: Error) => {
    throw new CortexError("hub_unreachable", `Cannot reach the hub at ${hub}: ${e.message}`, 503);
  });
  if (opts.binary && res.ok) return Buffer.from(await res.arrayBuffer());
  const text = await res.text();
  if (!res.ok) fail(res.status, text.startsWith("{") ? JSON.parse(text) : { error: { message: text.slice(0, 300) } });
  return opts.text ? text : JSON.parse(text);
}
