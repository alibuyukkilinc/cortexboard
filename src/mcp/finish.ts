import { CortexError } from "../core/types.js";
import type { McpApi } from "./client.js";

// cortex_finish: the end of a piece of work in one call. Each step is an ordinary REST call, in the order
// an agent would make them, so the rules, roles and drafts apply exactly as they do step by step.

export interface FinishInput {
  item?: string;
  action: string;
  summary: string;
  why?: string;
  files?: string[];
  commits?: string[];
  refs?: string[];
  decisions?: { id: string; verdict: string; note?: string }[];
  reply?: string;
  reply_fields?: Record<string, unknown>;
  status?: string;
  project_status?: string;
}

interface Rules {
  statuses: string[];
  transitions: "any" | Record<string, string[]>;
  reply?: { fields?: Record<string, unknown> };
}

type Step = { step: string; ok: true; result?: unknown } | { step: string; ok: false; error: { code: string; message: string; hint?: unknown } };

// The shortest way from one status to another the rules allow; [] when already there, null when none.
export function statusPath(rules: Pick<Rules, "statuses" | "transitions">, from: string, to: string): string[] | null {
  if (from === to) return [];
  const next = (s: string) => (rules.transitions === "any" ? rules.statuses.filter((x) => x !== s) : (rules.transitions[s] ?? []));
  const back = new Map<string, string>([[from, ""]]);
  const queue = [from];
  while (queue.length) {
    const s = queue.shift()!;
    for (const n of next(s)) {
      if (back.has(n)) continue;
      back.set(n, s);
      if (n === to) {
        const path = [n];
        for (let p = s; p !== from; p = back.get(p)!) path.unshift(p);
        return path;
      }
      queue.push(n);
    }
  }
  return null;
}

// Commits and files already given for the log fill the reply fields the card's type asks for, so the same
// list is not written twice: a task's evidence, an issue's commits and files.
function replyFields(rules: Rules, a: FinishInput): Record<string, unknown> {
  const wanted = rules.reply?.fields ?? {};
  const out: Record<string, unknown> = { ...(a.reply_fields ?? {}) };
  if (a.commits?.length && "commits" in wanted && out.commits === undefined) out.commits = a.commits;
  if (a.files?.length && "files" in wanted && out.files === undefined) out.files = a.files;
  if (a.commits?.length && "evidence" in wanted && out.evidence === undefined) out.evidence = a.commits;
  return out;
}

export async function finish(api: McpApi, a: FinishInput) {
  const steps: Step[] = [];
  const planned: string[] = [];
  const run = async (step: string, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      steps.push({ step, ok: true, result: await fn() });
      return true;
    } catch (e) {
      const err =
        e instanceof CortexError ? { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) } : { code: "internal", message: String(e) };
      steps.push({ step, ok: false, error: err });
      return false;
    }
  };
  const report = () => {
    const done = new Set(steps.filter((s) => s.ok).map((s) => s.step));
    const failed = steps.find((s) => !s.ok);
    const left = planned.filter((p) => !done.has(p) && p !== failed?.step);
    return { finished: !failed, steps, ...(failed ? { failed: failed.step, left, hint: "Fix the failed step, then do what is left one by one." } : {}) };
  };

  if (a.reply !== undefined && !a.item) throw new CortexError("validation", "reply needs item: the card to reply on.", 400);
  if (a.status && !a.item) throw new CortexError("validation", "status needs item: the card to move.", 400);

  planned.push("log");
  if (a.item && (a.reply || a.status)) planned.push("reply");
  if (a.item) planned.push("release");
  if (a.project_status) planned.push("project_status");

  // 1. The log: what and why, checked against the decisions that govern the files.
  const refs = [...new Set([...(a.refs ?? []), ...(a.item ? [a.item] : [])])];
  const ok = await run("log", () =>
    api.call("POST", "/activity", {
      body: {
        action: a.action,
        summary: a.summary,
        ...(a.why ? { why: a.why } : {}),
        ...(a.files?.length ? { files: a.files } : {}),
        ...(a.commits?.length ? { commits: a.commits } : {}),
        ...(refs.length ? { refs } : {}),
        ...(a.decisions?.length ? { decisions: a.decisions } : {}),
      },
    }),
  );
  if (!ok) return report();

  if (a.item) {
    const id = encodeURIComponent(a.item);
    // 2. The card: steps in between first (plain moves), then the reply that lands it where it goes.
    if (a.reply || a.status) {
      const moved = await run("reply", async () => {
        const { item } = (await api.call("GET", `/items/${id}`, { query: { replies: 0 } })) as { item: { type: string; status: string } };
        const rules = ((await api.call("GET", `/rules/${encodeURIComponent(item.type)}`)) as { rules: Record<string, Rules> }).rules[item.type];
        const path = a.status ? statusPath(rules, item.status, a.status) : [];
        if (path === null) throw new CortexError("invalid_transition", `The rules give no way from "${item.status}" to "${a.status}".`, 400);
        for (const s of path.slice(0, -1)) await api.call("PATCH", `/items/${id}`, { body: { status: s } });
        const last = path.at(-1);
        if (!a.reply) return last ? api.call("PATCH", `/items/${id}`, { body: { status: last } }) : { changed: false };
        return api.call("POST", `/items/${id}/replies`, {
          body: { body: a.reply, fields: replyFields(rules, a), ...(last ? { status: last } : {}) },
        });
      });
      if (!moved) return report();
    }
    // 3. The claim: let go, so the card does not look worked on. Not claimed by this agent: nothing to do.
    const released = await run("release", async () => {
      const { item } = (await api.call("GET", `/items/${id}`, { query: { replies: 0 } })) as { item: { claimed_by?: string } };
      const me = ((await api.call("GET", "/me")) as { actor: { id: string } }).actor.id;
      if (item.claimed_by !== me) return { released: false, reason: "not claimed by you" };
      return api.call("POST", `/items/${id}/claim`, { body: { action: "release" } });
    });
    if (!released) return report();
  }

  // 4. Where the project stands, for the next session.
  if (a.project_status) {
    const saved = await run("project_status", () => api.call("PUT", "/status", { body: { body: a.project_status, reason: a.summary.slice(0, 200) } }));
    if (!saved) return report();
  }
  return report();
}
