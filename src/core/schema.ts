import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

// A tiny, human-editable schema language. Humans own these files (rules/<type>.schema.yaml);
// the server enforces them and explains violations so an AI can correct itself.

export type FieldType =
  | "string"
  | "text"
  | "enum"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "tree_path"
  | "actor"
  | "item_ref"
  | "commit"
  | "url"
  | "evidence" // a commit hash or an http(s) link: what shows the work was done
  | "list";

export interface FieldSpec {
  type: FieldType;
  required?: boolean;
  values?: string[]; // enum
  of?: Exclude<FieldType, "list">; // list element type
  max?: number; // string length or list size
  description?: string;
}

export interface ConditionalRule {
  when: Record<string, unknown>; // field -> value or list of values
  require: string[];
  message?: string;
}

export interface OnReplyRule {
  from: string; // current status
  by: "assignee" | "not_author" | "author" | "anyone";
  to: string;
}

export interface ReplyRequiredRule {
  statuses: string[];
  default: boolean;
}

export interface ItemSchema {
  type: string;
  description?: string;
  statuses: string[];
  initial: string;
  // "terminal" means no transition leads out of it. "resolved" means the work is finished even though
  // the item can still move: an accepted decision stands until something supersedes it, and it must not
  // be counted as work waiting for someone.
  terminal: string[];
  resolved?: string[];
  transitions: Record<string, string[]> | "any";
  human_only_statuses?: string[];
  category_required?: boolean;
  fields: Record<string, FieldSpec>;
  require_when?: ConditionalRule[];
  reply?: { fields?: Record<string, FieldSpec>; require_when?: ConditionalRule[]; on_reply?: OnReplyRule[] };
  // Moving an item into one of these statuses needs a reply saying what was done, when the item's own
  // `reply_required` flag is on (it starts as `default`). A status change alone, its `reason`, a handoff
  // note or an activity entry never show on the card, so a person opening it would not see the outcome.
  reply_required?: ReplyRequiredRule;
  ai_instructions?: string;
  example?: Record<string, unknown>;
}

export interface ValidationContext {
  actorExists(id: string): boolean;
  nodeExists(path: string): boolean;
  itemExists(id: string): boolean;
}

export const ITEM_TYPES = ["task", "issue", "question", "note", "decision", "discussion"] as const;

// A milestone is a name shared by the tasks and issues that ship together ("v0.5", "Beta"). Reports group
// by it and draw its timeline. Projects whose schema files predate it get the field on load (parseSchema).
export const MILESTONE_TYPES = ["task", "issue"];
const MILESTONE_FIELD: FieldSpec = { type: "string", max: 60, description: 'What this ships with, e.g. "v0.5" or "Beta"' };
// A question can offer its answers: the person then picks one (in the chat or on the board) instead of
// typing. Empty or left out: a free answer, as before.
const QUESTION_OPTIONS: FieldSpec = {
  type: "list",
  of: "string",
  max: 8,
  description: "Answers to choose from, 2 to 8 (the person may add a note); leave out for a free answer",
};
// Fields added after projects already had their schema files: given on load (parseSchema), the files untouched.
const ADDED_FIELDS: Record<string, Record<string, FieldSpec>> = {
  ...Object.fromEntries(MILESTONE_TYPES.map((t) => [t, { milestone: MILESTONE_FIELD }])),
  question: { options: QUESTION_OPTIONS },
};

export const DEFAULT_SCHEMAS: Record<string, ItemSchema> = {
  task: {
    type: "task",
    description: "A unit of work on the board.",
    statuses: ["backlog", "todo", "doing", "review", "done"],
    initial: "backlog",
    terminal: ["done"],
    transitions: "any",
    fields: {
      priority: { type: "enum", values: ["low", "medium", "high"] },
      due: { type: "date", description: "YYYY-MM-DD" },
      estimate: { type: "string", max: 40, description: 'Free text, e.g. "2h" or "3 points"' },
      milestone: MILESTONE_FIELD,
    },
    // What shows the work is done, and how each acceptance criterion was met: the reviewer reads these first.
    reply: {
      fields: {
        evidence: { type: "list", of: "evidence", max: 20, description: "Commit hashes or links that show the work" },
        acceptance: { type: "text", description: "Each acceptance criterion of the task and how it was met" },
      },
    },
    reply_required: { statuses: ["review", "done"], default: true },
    ai_instructions:
      "Move a task to 'doing' when you start. When you finish, move it to 'review' with a reply (cortex_reply with status) that says " +
      "what you did, the commits, the files, what is left out and how to test it; humans move it to 'done'. " +
      "Put the commits or links in the reply's evidence field, and if the task lists acceptance criteria, say in acceptance how each " +
      "one was met. A status change's reason, a handoff note or an activity entry do not show on the card.",
    human_only_statuses: ["done"],
    example: { type: "task", title: "Add rate limiting to login", category_path: "backend", fields: { priority: "high" } },
  },
  issue: {
    type: "issue",
    description: "A bug or problem that needs fixing.",
    statuses: ["open", "in_progress", "review", "closed"],
    initial: "open",
    terminal: ["closed"],
    transitions: {
      open: ["in_progress", "closed"],
      in_progress: ["review", "open", "closed"],
      review: ["closed", "in_progress"],
      closed: ["open"],
    },
    category_required: true,
    fields: {
      severity: { type: "enum", values: ["low", "medium", "high", "critical"], required: true },
      steps: { type: "text", description: "How to reproduce" },
      expected: { type: "text" },
      actual: { type: "text" },
      environment: { type: "string", max: 200 },
      milestone: MILESTONE_FIELD,
    },
    reply: {
      fields: {
        resolution: { type: "enum", values: ["fixed", "wontfix", "needs_info", "duplicate", "cannot_reproduce"] },
        commits: { type: "list", of: "commit", max: 20 },
        files: { type: "list", of: "string", max: 50 },
      },
      require_when: [
        { when: { resolution: "fixed" }, require: ["commits", "files"], message: "A 'fixed' resolution must list the commits and changed files." },
      ],
    },
    reply_required: { statuses: ["review", "closed"], default: true },
    ai_instructions:
      "When you fix an issue, reply with resolution 'fixed', the commit hashes and changed files, and move it to 'review' in the same " +
      "reply (cortex_reply with status). Say what you did, what is left out and how to test it. " +
      "If you are not sure about the cause, reply with 'needs_info' or open a question instead of guessing.",
    example: {
      type: "issue",
      title: "Login returns 500 on wrong password",
      category_path: "backend",
      body: "Seen in production logs since 2026-09-20.",
      fields: { severity: "high", steps: "POST /login with a wrong password" },
    },
  },
  question: {
    type: "question",
    description: "A question between humans and AIs. Assign it to an actor, '@humans' or '@ai'.",
    statuses: ["open", "answered", "closed"],
    initial: "open",
    terminal: ["closed"],
    transitions: { open: ["answered", "closed"], answered: ["closed", "open"], closed: ["open"] },
    fields: {
      blocking: { type: "boolean", description: "true if the asker cannot continue until this is answered" },
      options: QUESTION_OPTIONS,
    },
    reply: { on_reply: [{ from: "open", by: "not_author", to: "answered" }] },
    ai_instructions:
      "Ask when search does not answer you; do not assume. While a blocking question you asked is open, do not work around it. " +
      "When your question is answered, close it.",
    example: { type: "question", title: "Should guest checkout create an account?", assignee: "@humans", fields: { blocking: true } },
  },
  note: {
    type: "note",
    description: "A free-form note attached to a part of the project.",
    statuses: ["active", "archived"],
    initial: "active",
    terminal: ["archived"],
    transitions: "any",
    fields: {},
    example: { type: "note", title: "Staging DB is reset every Monday", category_path: "server" },
  },
  decision: {
    type: "decision",
    description: "What we decided, why, and what we rejected (ADR).",
    statuses: ["proposed", "accepted", "rejected", "superseded"],
    initial: "proposed",
    terminal: ["rejected", "superseded"],
    resolved: ["accepted"],
    transitions: { proposed: ["accepted", "rejected"], accepted: ["superseded"], rejected: ["proposed"], superseded: [] },
    human_only_statuses: ["accepted", "rejected"],
    fields: {
      context: { type: "text", required: true, description: "The problem and constraints" },
      alternatives: { type: "text", description: "Options considered and why they lost" },
      consequences: { type: "text", description: "What becomes easier or harder" },
      supersedes: { type: "item_ref" },
    },
    ai_instructions: "Put the decision itself in body. You may propose; only humans accept or reject.",
    example: {
      type: "decision",
      title: "Use iyzico for card payments",
      category_path: "backend",
      body: "We use iyzico for all card payments.",
      fields: { context: "Need TRY payments with installments.", alternatives: "Stripe: no installments in TR." },
    },
  },
  // A question put to people and AI agents together. Each participant reads the project and states a view
  // (the option it backs is its vote); a count turns the majority into a proposed decision a human accepts.
  // Voting and deciding go through /discussions/:id/close-vote and /decide, never a plain status change.
  discussion: {
    type: "discussion",
    description: "A question for people and AI agents to argue out; the majority view becomes a proposed decision a human accepts.",
    statuses: ["open", "deliberating", "voted", "decided", "cancelled"],
    initial: "open",
    terminal: ["decided", "cancelled"],
    transitions: {
      open: ["deliberating", "voted", "cancelled"],
      deliberating: ["open", "voted", "cancelled"],
      voted: ["deliberating", "decided", "cancelled"],
      decided: [],
      cancelled: ["open"],
    },
    human_only_statuses: ["decided"],
    fields: {
      options: { type: "list", of: "string", required: true, max: 8, description: "The answers on the table, 2 to 8; a view backs one of them" },
      participants: { type: "list", of: "actor", max: 30, description: "Who is asked for a view; empty = anyone" },
      blind: { type: "boolean", description: "Default true: while open, a participant sees the others' views only after posting their own" },
      deadline: { type: "datetime" },
      outcome: { type: "item_ref", description: "The decision this discussion produced (set by Cortex)" },
    },
    reply: {
      fields: {
        kind: { type: "enum", values: ["opinion", "rebuttal", "comment", "synthesis"], required: true },
        stance: { type: "string", max: 200, description: "One of the discussion's options, exactly as written; your latest stance is your vote" },
        confidence: { type: "enum", values: ["low", "medium", "high"] },
        evidence: { type: "list", of: "string", max: 30, description: 'What backs the view: "src/db.ts:40-60", a knowledge node path or an item id' },
      },
      require_when: [
        {
          when: { kind: "opinion" },
          require: ["stance", "confidence", "evidence"],
          message: "An opinion names an option, how sure you are, and what in the project backs it.",
        },
      ],
    },
    ai_instructions:
      "Read the project before you post (cortex_search, cortex_code_context, the code itself). Post one 'opinion' that backs one option, " +
      "with evidence for every claim; say confidence 'low' when unsure. While the discussion is open and blind you will not see the " +
      "others' views until you post yours. Once it is 'deliberating', answer the strongest opposing view with a 'rebuttal'; a new " +
      "stance there changes your vote. Only humans decide.",
    example: {
      type: "discussion",
      title: "Should this project use MySQL instead of PostgreSQL?",
      category_path: "backend",
      body: "Hosting offers managed MySQL at half the price. What would we lose?",
      fields: { options: ["Stay on PostgreSQL", "Move to MySQL"], participants: ["ai-agent", "owner"] },
    },
  },
};

export const ACTIVITY_SCHEMA = {
  actions: ["code_change", "fix", "refactor", "investigation", "config", "deploy", "docs", "other"],
  why_required_for: ["code_change", "fix", "refactor", "config", "deploy"],
  ai_instructions: "Log every meaningful change: what (summary), why, files and commit. One entry per logical change, not per file.",
};

// Parsed schemas, keyed by file. Every item write and every flag check asks for its type's schema, and
// parsing YAML each time cost more than the write itself on a big project. A person editing the rules
// changes the file's mtime or size, so the next call reads it again. Callers must not mutate the result.
const schemaCache = new Map<string, { stamp: string; schema: ItemSchema }>();

export function loadSchema(rulesDir: string, type: string): ItemSchema | null {
  const file = join(rulesDir, `${type}.schema.yaml`);
  const st = statSync(file, { throwIfNoEntry: false });
  if (st?.isFile()) {
    const stamp = `${st.mtimeMs}:${st.size}`;
    const hit = schemaCache.get(file);
    if (hit?.stamp === stamp) return hit.schema;
    const schema = parseSchema(type, readFileSync(file, "utf8"));
    schemaCache.set(file, { stamp, schema });
    return schema;
  }
  return DEFAULT_SCHEMAS[type] ?? null;
}

function parseSchema(type: string, text: string): ItemSchema {
  const s = YAML.parse(text) as ItemSchema;
  return {
    ...s,
    fields: { ...ADDED_FIELDS[type], ...s.fields },
    terminal: s.terminal ?? [],
    // Schema files are written to disk at init, so projects created before "resolved" existed have no
    // such key. Falling back to the built-in default fixes them on upgrade without touching their files.
    resolved: s.resolved ?? DEFAULT_SCHEMAS[type]?.resolved ?? [],
    transitions: s.transitions ?? "any",
    // Same upgrade path: a project whose files predate the rule gets the built-in one.
    reply_required: s.reply_required ?? DEFAULT_SCHEMAS[type]?.reply_required,
    // Same upgrade path: reply fields a project's file does not define come from the built-in type.
    reply: s.reply ?? DEFAULT_SCHEMAS[type]?.reply,
  };
}

// Whether moving this item to `to` needs a reply: the item's own flag, else the type's default.
export function needsReply(schema: ItemSchema, flag: boolean | undefined, to: string): boolean {
  const rule = schema.reply_required;
  if (!rule?.statuses.includes(to)) return false;
  return flag ?? rule.default;
}

// Work that still waits for someone: not finished by transition (terminal) and not settled (resolved).
export function isOpenWork(schema: ItemSchema, status: string): boolean {
  return !schema.terminal.includes(status) && !(schema.resolved ?? []).includes(status);
}

export function loadActivitySchema(rulesDir: string): typeof ACTIVITY_SCHEMA {
  const file = join(rulesDir, "activity.schema.yaml");
  if (!existsSync(file)) return ACTIVITY_SCHEMA;
  return { ...ACTIVITY_SCHEMA, ...(YAML.parse(readFileSync(file, "utf8")) ?? {}) };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COMMIT = /^[0-9a-f]{7,40}$/i;

function checkValue(name: string, spec: FieldSpec | { type: FieldType; values?: string[]; max?: number }, v: unknown, ctx: ValidationContext): string | null {
  switch (spec.type) {
    case "string":
    case "text":
      if (typeof v !== "string") return `${name}: must be a string`;
      if (spec.max && v.length > spec.max) return `${name}: at most ${spec.max} characters`;
      return null;
    case "enum":
      return spec.values?.includes(v as string) ? null : `${name}: must be one of ${spec.values?.join(", ")}`;
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? null : `${name}: must be a number`;
    case "boolean":
      return typeof v === "boolean" ? null : `${name}: must be true or false`;
    case "date":
      return typeof v === "string" && DATE.test(v) && !isNaN(Date.parse(v)) ? null : `${name}: must be a date like 2026-09-22`;
    case "datetime":
      return typeof v === "string" && !isNaN(Date.parse(v)) && v.includes("T") ? null : `${name}: must be ISO-8601 UTC like 2026-09-22T10:15:00Z`;
    case "url":
      return typeof v === "string" && /^https?:\/\//.test(v) ? null : `${name}: must be an http(s) URL`;
    case "commit":
      return typeof v === "string" && COMMIT.test(v) ? null : `${name}: must be a git commit hash`;
    case "evidence":
      return typeof v === "string" && (COMMIT.test(v) || /^https?:\/\/\S+$/.test(v)) ? null : `${name}: must be a commit hash or an http(s) link`;
    case "actor":
      return typeof v === "string" && ctx.actorExists(v) ? null : `${name}: unknown actor "${String(v)}"`;
    case "tree_path":
      return typeof v === "string" && ctx.nodeExists(v) ? null : `${name}: no knowledge node at "${String(v)}"`;
    case "item_ref":
      return typeof v === "string" && ctx.itemExists(v) ? null : `${name}: no item with id "${String(v)}"`;
    case "list": {
      if (!Array.isArray(v)) return `${name}: must be a list`;
      if (spec.max && v.length > spec.max) return `${name}: at most ${spec.max} entries`;
      const of = (spec as FieldSpec).of ?? "string";
      for (const [i, el] of v.entries()) {
        const err = checkValue(`${name}[${i}]`, { type: of }, el, ctx);
        if (err) return err;
      }
      return null;
    }
  }
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

function matches(record: Record<string, unknown>, when: Record<string, unknown>): boolean {
  return Object.entries(when).every(([k, want]) => (Array.isArray(want) ? want.includes(record[k]) : record[k] === want));
}

// Returns human-readable problems; empty list means valid.
export function validateFields(
  specs: Record<string, FieldSpec>,
  record: Record<string, unknown>,
  ctx: ValidationContext,
  conditional: ConditionalRule[] = [],
): string[] {
  const issues: string[] = [];
  for (const key of Object.keys(record)) {
    if (!(key in specs)) {
      const allowed = Object.keys(specs);
      issues.push(`${key}: unknown field (allowed: ${allowed.length ? allowed.join(", ") : "none"})`);
    }
  }
  for (const [name, spec] of Object.entries(specs)) {
    const v = record[name];
    if (isEmpty(v)) {
      if (spec.required) issues.push(`${name}: required`);
      continue;
    }
    const err = checkValue(name, spec, v, ctx);
    if (err) issues.push(err);
  }
  for (const rule of conditional) {
    if (!matches(record, rule.when)) continue;
    const missing = rule.require.filter((f) => isEmpty(record[f]));
    if (missing.length)
      issues.push(rule.message ? `${rule.message} (missing: ${missing.join(", ")})` : `required when ${JSON.stringify(rule.when)}: ${missing.join(", ")}`);
  }
  return issues;
}

export function canTransition(schema: ItemSchema, from: string, to: string): boolean {
  if (from === to) return true;
  if (!schema.statuses.includes(to)) return false;
  if (schema.transitions === "any") return true;
  return schema.transitions[from]?.includes(to) ?? false;
}

// Compact description of a schema: what an AI needs to write a valid item, nothing more.
export function describeSchema(schema: ItemSchema) {
  return {
    type: schema.type,
    description: schema.description,
    statuses: schema.statuses,
    initial: schema.initial,
    resolved: schema.resolved ?? [],
    transitions: schema.transitions,
    human_only_statuses: schema.human_only_statuses ?? [],
    category_required: !!schema.category_required,
    fields: schema.fields,
    require_when: schema.require_when ?? [],
    reply: schema.reply ?? {},
    ...(schema.reply_required ? { reply_required: schema.reply_required } : {}),
    ai_instructions: schema.ai_instructions,
    example: schema.example,
  };
}
