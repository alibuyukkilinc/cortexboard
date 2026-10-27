export type ActorKind = "human" | "ai";
export interface Actor {
  id: string;
  kind: ActorKind;
}

export interface Me {
  actor: Actor;
  project: { name: string };
  actors: Actor[];
  item_types: string[];
  repo_url?: string; // where commit hashes link to (GitHub), when known
  // Hub only: the member's role in this project and what it allows.
  role?: string;
  perms?: string[];
  restricted?: boolean;
}

export interface HubMe {
  org: string;
  hub_url?: string;
  principal: { id: string; kind: "human" | "ai"; email?: string; name: string; org_admin?: boolean };
  projects: { id: string; name: string; role: string }[];
}

export interface FieldSpec {
  type: string;
  required?: boolean;
  values?: string[];
  of?: string;
  max?: number;
  description?: string;
}

export interface Schema {
  type: string;
  description?: string;
  statuses: string[];
  initial: string;
  transitions: Record<string, string[]> | "any";
  human_only_statuses: string[];
  category_required: boolean;
  fields: Record<string, FieldSpec>;
  reply: { fields?: Record<string, FieldSpec> };
  reply_required?: { statuses: string[]; default: boolean };
  ai_instructions?: string;
}

export interface ItemSummary {
  id: string;
  type: string;
  title: string;
  status: string;
  category_path?: string;
  author: string;
  assignee?: string;
  claimed_by?: string;
  claimed_at?: string;
  blocking?: boolean;
  replies?: number;
  files?: number; // attachments
  cover?: string; // first picture, shown on the board card
  level?: string; // priority, or severity for issues
  due?: string; // YYYY-MM-DD
  has_body?: boolean;
  checklist?: { done: number; total: number }; // task boxes in the body
  done?: boolean; // finished by the type's rules (terminal or resolved): the server decides
  updated_at: string;
  reason?: string;
}

// One row of a person's inbox (GET /api/inbox). Items carry the ItemSummary fields; a draft row carries
// draft_kind/target/proposed_by (id = draft id); a stale row carries path/severity/files (id = path).
export type InboxReason =
  | "review_waiting_on_you"
  | "draft_to_approve"
  | "decision_needs_review"
  | "discussion_needs_your_view"
  | "assigned_to_you"
  | "assigned_to_group"
  | "your_question_answered"
  | "new_reply"
  | "stale_knowledge";

// Handed-in work waiting on a person's check: an inbox review row carries these, and so does GET /api/items/:id
// when the item waits on the viewer.
export interface ReviewInfo {
  moves: { approve?: string; send_back?: string }; // where approving or sending back moves it
  to_test?: string[]; // what the agent asked to try, from the reply that handed it in
  waiting_since?: string; // when it was handed in
}

export interface InboxEntry extends Partial<Omit<ItemSummary, "id" | "title" | "reason">> {
  id: string;
  title: string;
  reason: InboxReason;
  kind?: "draft" | "stale";
  moves?: ReviewInfo["moves"]; // review rows (ReviewInfo)
  to_test?: string[];
  waiting_since?: string;
  draft_kind?: "node" | "item";
  changes?: DraftSize;
  target?: string;
  summary?: string;
  proposed_by?: string;
  path?: string;
  severity?: string;
  changed_files?: string[];
}

export interface InboxResponse {
  count: number;
  by_reason?: Partial<Record<InboxReason, number>>;
  items: InboxEntry[];
}

export interface Attachment {
  name: string;
  size: number;
  type: string;
  added_at: string;
}

export interface CodeLink {
  file: string;
  lines?: string;
}

export interface Item {
  id: string;
  type: string;
  title: string;
  status: string;
  category_path?: string;
  author: string;
  assignee?: string;
  claimed_by?: string;
  claimed_at?: string;
  handoff_note?: string;
  reply_required?: boolean;
  tags?: string[];
  links?: { nodes?: string[]; items?: string[]; activity?: string[]; code?: CodeLink[] };
  fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  updated_by: string;
  body: string;
}

export interface Reply {
  id: string;
  author: string;
  created_at: string;
  status_change?: { from: string; to: string };
  fields?: Record<string, unknown>;
  sealed?: boolean; // a discussion view hidden from this reader until they post theirs
  via?: Via; // said in the AI chat, or asked by an AI on the board
  body: string;
}

export interface NodeSummary {
  path: string;
  title: string;
  summary: string;
  status: string;
  open_items?: number;
  children?: NodeSummary[];
  child_count?: number;
}

export interface KnowledgeNode {
  id: string;
  path: string;
  title: string;
  summary: string;
  body: string;
  tags?: string[];
  links?: { code?: CodeLink[]; items?: string[] };
  verified_at_commit?: string;
  status: string;
  updated_by: string;
  updated_at: string;
}

export interface Activity {
  id: string;
  at: string;
  actor: string;
  action: string;
  summary: string;
  why?: string;
  files?: string[];
  commit?: string;
  commits?: string[];
  refs?: string[];
  system?: boolean;
  undo?: { undoable: boolean; undone?: { by: string; at: string } }; // an answer from the AI chat the board can take back
  via?: Via; // said in the AI chat, or asked by an AI on the board
}

export interface Draft {
  id: string;
  kind: "node" | "item";
  target: string;
  proposed_by: string;
  proposed_at: string;
  reason?: string;
  title: string;
  summary: string;
  // How big the change is; risky = removes much of what is there, so it is never approved in a batch.
  changes?: DraftSize;
}

export interface DraftSize {
  added: number;
  removed: number;
  fields: number;
  new: boolean;
  risky: boolean;
}

// GET /api/approvals/:id: the server's judgement of a draft (src/core/diff.ts draftChanges).
export interface DraftChanges {
  new: boolean;
  fields: { name: string; before: string; after: string }[];
  body: { added: number; removed: number };
  risky: boolean;
  risky_reason?: string;
}

export interface SearchHit {
  kind: "node" | "item" | "activity";
  path?: string;
  id?: string;
  type?: string;
  title?: string;
  summary: string;
  status?: string;
  actor?: string;
  at?: string;
  score: number;
  match?: "keyword" | "semantic" | "both";
  draft_id?: string; // a knowledge draft waiting for approval (status "draft")
  proposed_by?: string;
}

export type Severity = "high" | "medium" | "low";

export interface StaleInfo {
  path: string;
  title?: string; // only on the /api/stale list
  verified_at_commit: string;
  reason: "changed" | "unknown_commit";
  severity: Severity;
  snoozed?: { at: string; by: string };
  changes: {
    file: string;
    status: "modified" | "deleted" | "renamed";
    severity: Severity;
    formatting_only?: boolean;
    renamed_to?: string;
    lines?: string;
    commits: number;
    last?: { hash: string; author: string; date: string; subject: string };
  }[];
}

// Where a person's answer came from when it was not their own click on a card.
export interface Via {
  channel: "chat-elicitation" | "chat-relayed" | "board-prompt";
  ai_actor: string;
  verbatim?: string;
  unverified?: boolean;
  confirmed_by?: string;
}

// A question an AI asked this person on the board (its client could not show it in the chat).
export interface BoardPrompt {
  id: string;
  at: string;
  expires_at: string;
  ai_actor: string;
  human: string;
  title: string;
  message: string;
  schema: { type: "object"; properties: Record<string, { type: string; title?: string; enum?: string[] }>; required?: string[] };
  status: "open" | "answered" | "expired";
}
