import type { Cortex } from "./cortex.js";
import type { SqlFilter } from "../index/db.js";
import type { ChatSettings } from "./provenance.js";
import { GROUP_ASSIGNEES } from "./types.js";
import { DISCUSSION } from "./discussions.js";
import { shorten } from "../util/text.js";

// Everything a person could settle with one answer in the AI chat instead of on the board: drafts to
// approve, proposed decisions, questions waiting on humans, and items one human-only step from done.
// The AI lists these (cortex_pending_approvals) and asks with cortex_ask_human; the person's answer does the rest.

export type ChatKind = "draft" | "decision" | "question" | "transition";

export interface ChatApproval {
  kind: ChatKind;
  id: string; // draft id or item id
  title: string;
  summary?: string;
  ask: string; // what the AI should ask, in one line
  options: string[];
  to?: string[]; // transition: the human-only statuses it can move to
  proposed_by?: string;
  age_days: number;
}

const DAY = 86_400_000;
const ageDays = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / DAY));

export const DEFAULT_MAX_BATCH = 10;

// A single-person project trusts a relayed answer (applied, marked unverified); a team server queues it for the board.
export function chatSettings(c: Cortex, team: boolean): ChatSettings {
  const cfg = c.project.config.chat ?? {};
  const relayed = cfg.relayed === "accept" || cfg.relayed === "pending" || cfg.relayed === "off" ? cfg.relayed : team ? "pending" : "accept";
  const max = Number(cfg.max_batch);
  return {
    relayed,
    max_batch: Number.isInteger(max) && max > 0 ? Math.min(max, 50) : DEFAULT_MAX_BATCH,
    relayed_human_only: cfg.relayed_human_only === true,
  };
}

export function chatApprovals(
  c: Cortex,
  opts: {
    visible?: SqlFilter | null;
    drafts?: { id: string; kind: string; target: string; title: string; summary?: string; proposed_by: string; proposed_at: string }[];
  } = {},
): ChatApproval[] {
  const out: ChatApproval[] = [];
  for (const d of opts.drafts ?? c.listDrafts({ changes: false })) {
    out.push({
      kind: "draft",
      id: d.id,
      title: d.title,
      ...(d.summary ? { summary: shorten(d.summary, 160) } : {}),
      ask: `Approve ${d.proposed_by}'s change to ${d.kind} "${d.target || "(root)"}"?`,
      options: ["approve", "reject"],
      proposed_by: d.proposed_by,
      age_days: ageDays(d.proposed_at),
    });
  }
  const humans = new Set(c.project.config.actors.filter((a) => a.kind === "human").map((a) => a.id));
  const open = c.index.queryItems({ open: true, visible: opts.visible ?? null, limit: 1000, offset: 0 }).items;
  for (const i of open) {
    if (i.type === DISCUSSION) continue;
    const schema = c.schema(i.type);
    if (!schema) continue;
    const humanOnly = schema.human_only_statuses ?? [];
    if (i.type === "decision" && i.status === "proposed") {
      out.push({
        kind: "decision",
        id: i.id,
        title: i.title,
        ask: `Accept the decision "${i.title}"?`,
        options: ["accept", "reject"],
        age_days: ageDays(i.created_at),
      });
      continue;
    }
    const forHumans = i.assignee !== null && (GROUP_ASSIGNEES[i.assignee as keyof typeof GROUP_ASSIGNEES] === "human" || humans.has(i.assignee));
    if (i.type === "question" && i.status === "open" && forHumans) {
      out.push({ kind: "question", id: i.id, title: i.title, ask: i.title, options: ["answer"], age_days: ageDays(i.created_at) });
      continue;
    }
    if (!humanOnly.length) continue;
    // One step from a human-only status: waiting for review, or every way forward is human-only.
    const next = schema.transitions === "any" ? schema.statuses.filter((s) => s !== i.status) : (schema.transitions[i.status] ?? []);
    const to = next.filter((s) => humanOnly.includes(s));
    if (!to.length) continue;
    if (i.status === "review" || next.every((s) => humanOnly.includes(s))) {
      out.push({
        kind: "transition",
        id: i.id,
        title: i.title,
        ask: `${i.type} "${i.title}" is in ${i.status}: move it to ${to.join(" / ")}?`,
        options: ["yes", "no"],
        to,
        age_days: ageDays(i.updated_at),
      });
    }
  }
  return out;
}
