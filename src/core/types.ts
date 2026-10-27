import type { BackupSettings } from "../backup/core.js";
import type { Via } from "./provenance.js";
import type { RuleCheck } from "./ruleCheck.js";

export type NodeStatus = "active" | "draft" | "stale" | "deprecated";
export type ActorKind = "human" | "ai";
export type ApprovalPolicy = "auto" | "review" | "human_only";

// Group assignees: anyone of that kind may pick the item up.
export const GROUP_ASSIGNEES = { "@humans": "human", "@ai": "ai" } as const;

// Taken out of everyday view: search, the brief, the tree, code context, lists and staleness skip it.
// The file stays (and git keeps it), readable by id or path, and a person can bring it back.
export interface Archived {
  at: string;
  by: string; // who archived it (an AI's archiving is a draft until a person approves it)
  reason?: string;
}

export interface CodeLink {
  file: string;
  lines?: string;
  symbol?: string;
}

export interface NodeMeta {
  id: string;
  title: string;
  summary: string;
  tags?: string[];
  links?: { code?: CodeLink[]; items?: string[] };
  verified_at_commit?: string;
  status: NodeStatus;
  archived?: Archived;
  updated_by: string;
  updated_at: string;
}

export interface KnowledgeNode extends NodeMeta {
  path: string; // "" is the project root
  body: string;
}

export interface NodeSummary {
  path: string;
  title: string;
  summary: string;
  status: NodeStatus;
  open_items?: number;
  children?: NodeSummary[];
  child_count?: number;
}

export interface ItemLinks {
  nodes?: string[];
  items?: string[];
  activity?: string[];
  code?: CodeLink[];
}

export interface Item {
  id: string;
  type: string;
  title: string;
  status: string;
  category_path?: string;
  author: string;
  assignee?: string; // actor id, "@humans" or "@ai"
  claimed_by?: string; // actor id actively working this right now; separate from assignee
  claimed_at?: string;
  handoff_note?: string; // where the claim holder left off; set on claim/release only
  reply_required?: boolean; // moving it to a status in its schema's reply_required list needs a reply
  archived?: Archived;
  tags?: string[];
  links?: ItemLinks;
  fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  updated_by: string;
  body: string;
}

export interface Reply {
  id: string;
  item_id: string;
  author: string;
  created_at: string;
  status_change?: { from: string; to: string };
  fields?: Record<string, unknown>;
  sealed?: boolean; // a view in a discussion's blind round, hidden from this reader until they post theirs
  via?: Via; // written on a person's behalf from the AI chat, not on the board
  body: string;
}

export interface Activity {
  id: string;
  at: string;
  actor: string;
  // What the actor was when it wrote this. Reports read it, so an actor later removed from the config (or one
  // the config never knew, e.g. another client's AI) is not counted as a person. Older entries lack it.
  actor_kind?: ActorKind;
  action: string;
  summary: string;
  why?: string;
  files?: string[];
  commit?: string; // older entries; new ones may carry several in commits
  commits?: string[];
  refs?: string[]; // item ids or node paths
  system?: boolean; // written by Cortex itself (audit trail), not by the actor
  // Structured facts for reports (system entries only): item type, status transition, draft kind and proposer.
  meta?: { type?: string; from?: string; to?: string; kind?: string; proposed_by?: string; version?: string };
  via?: Via; // the person said it in the AI chat (elicitation or relayed), not on the board
  // Which accepted decisions govern the files of this work and what the actor said about each (see ruleCheck.ts).
  rule_check?: RuleCheck;
}

export interface Actor {
  id: string;
  kind: ActorKind;
  // Per-actor approval overrides (a hub role such as "trusted" AI writes knowledge directly); falls back to the project's policy.
  policy?: Record<string, ApprovalPolicy>;
}

export interface CortexConfig {
  // repo_url: the project's web address for commit links (e.g. https://github.com/acme/shop). Unset: taken
  // from git's "origin" when that is GitHub.
  project: { name: string; summary?: string; repo_url?: string };
  port: number;
  actors: Actor[];
  approval: Record<string, ApprovalPolicy>;
  search?: { semantic?: boolean }; // false turns semantic search off for this project
  timezone?: string; // IANA zone reports count days in, e.g. "Europe/Istanbul"; default UTC
  // Hub project ids this project reads from, e.g. a mobile app linking its backend. Read-only, and only for
  // callers who are members of the linked project too: a link says where to look, membership says who may.
  linked?: string[];
  // Archiving: finished items older than after_days are suggested (default 30); activity older than
  // activity_days leaves default search (default 90). Files and reports keep everything.
  archive?: { after_days?: number; activity_days?: number };
  // Outgoing webhooks for activity entries; secrets live in .secrets.yaml under webhooks: <name>.
  webhooks?: { name: string; url: string; events?: string[] }[];
  // The project status (.cortex/status.md) counts as stale after stale_days (default 3) or after
  // stale_changes logged entries written since it (default 20).
  status?: { stale_days?: number; stale_changes?: number };
  // Approvals asked in the AI chat. relayed: what an answer the AI quotes (the client cannot ask the person
  // itself) does: accept applies it marked unverified, pending only records it for the board, off refuses it.
  // Default accept on a single-person project, pending on a team server. max_batch: drafts in one question
  // (default 10). relayed_human_only: let a relayed answer accept decisions and human-only statuses (default no).
  chat?: { relayed?: "accept" | "pending" | "off"; max_batch?: number; relayed_human_only?: boolean };
  // Which stale knowledge is shown (brief, board, reports, search, the hint after logged work): all, only high
  // (linked lines rewritten, file deleted or moved), or off. Code links and the commit a node was verified at
  // are kept either way, so turning it back on loses nothing. Default: high; off for knowledge kept on a hub
  // (decision 01M3MXCREN98XN2E1VABABQTSR).
  staleness?: "all" | "high" | "off";
  // Decision checks on logged work: at most max_asked decisions (default 5), most specific first, are asked
  // about for one change; the rest are listed without needing an answer (decision 01M3MXD9VVDQJSDEFX60PQTAWH).
  decision_checks?: { max_asked?: number };
  // Backups of this project's knowledge when it is not on a hub (src/backup/project.ts); keys in .cortex/backup.secrets.yaml.
  backup?: BackupSettings;
}

export type Draft = (DraftBase & { kind: "node"; data: KnowledgeNode }) | (DraftBase & { kind: "item"; data: Item });

interface DraftBase {
  id: string;
  target: string; // node path or item id
  proposed_by: string;
  proposed_at: string;
  reason?: string;
  base_rev?: string; // content hash of the target when the draft was made; used to detect conflicts
}

export class CortexError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public hint?: unknown,
  ) {
    super(message);
  }
}
