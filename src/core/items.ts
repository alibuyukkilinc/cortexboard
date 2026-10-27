import { z } from "zod";
import type { Cortex } from "./cortex.js";
import type { IndexedItem, ItemQuery, SqlFilter } from "../index/db.js";
import { normalizePath } from "../store/tree.js";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../store/attachments.js";
import { MAX_VERSIONS } from "../store/items.js";
import { countChecklist, parseChecklist, setBox } from "./checklist.js";
import { estimateTokens, nowIso, shortHash, shorten, ulid } from "../util/text.js";
import type { ItemSchema, ValidationContext } from "./schema.js";
import { canTransition, describeSchema, needsReply, validateFields } from "./schema.js";
import type { Actor, Item, ItemLinks, Reply } from "./types.js";
import { CortexError, GROUP_ASSIGNEES } from "./types.js";
import { currentVia } from "./provenance.js";
import { toTest } from "./toTest.js";
import { DISCUSSION, checkFields as checkDiscussion, checkReply as checkDiscussionReply, isSealed, viewReplies } from "./discussions.js";

const Links = z
  .object({
    nodes: z.array(z.string()).max(20).optional(),
    items: z.array(z.string()).max(20).optional(),
    activity: z.array(z.string()).max(20).optional(),
    code: z
      .array(z.object({ file: z.string().transform((f) => f.normalize("NFC")), lines: z.string().optional() }))
      .max(50)
      .optional(),
  })
  .strict();

export const CreateItemInput = z
  .object({
    type: z.string(),
    title: z.string().min(1).max(160),
    body: z.string().max(20000).default(""),
    category_path: z.string().optional(),
    assignee: z.string().optional(),
    tags: z.array(z.string().max(40)).max(20).optional(),
    links: Links.optional(),
    fields: z.record(z.string(), z.unknown()).default({}),
    reply_required: z.boolean().optional(), // omitted = the type's default
    reason: z.string().max(500).optional(),
  })
  .strict();
export type CreateItemInput = z.input<typeof CreateItemInput>;

export const UpdateItemInput = z
  .object({
    title: z.string().min(1).max(160).optional(),
    body: z.string().max(20000).optional(),
    status: z.string().optional(),
    category_path: z.string().nullable().optional(),
    assignee: z.string().nullable().optional(),
    tags: z.array(z.string().max(40)).max(20).optional(),
    links: Links.optional(),
    fields: z.record(z.string(), z.unknown()).optional(), // merged; null removes a field
    reply_required: z.boolean().optional(), // humans only once the item exists
    // "append" adds `body` after the current body instead of replacing it: adding a section can never lose one.
    body_mode: z.enum(["replace", "append"]).optional(),
    // An AI replacing a body with less than half of it gets 409 body_shrink unless it says it means it.
    confirm_shrink: z.boolean().optional(),
    reason: z.string().max(500).optional(),
    force: z.boolean().optional(),
    if_rev: z.string().optional(), // the _rev you last read; mismatch throws a 409 conflict
  })
  .strict();
export type UpdateItemInput = z.input<typeof UpdateItemInput>;

export const ClaimInput = z
  .object({
    action: z.enum(["claim", "release"]),
    note: z.string().max(500).optional(),
    force: z.boolean().optional(), // humans only: take over an actively held claim
  })
  .strict();
export type ClaimInput = z.input<typeof ClaimInput>;

// No background job: staleness-style, computed lazily whenever a claim is checked.
const CLAIM_TTL_MS = 2 * 60 * 60 * 1000; // 2h

export const ReplyInput = z
  .object({
    body: z.string().min(1).max(20000),
    fields: z.record(z.string(), z.unknown()).default({}),
    status: z.string().optional(),
    force: z.boolean().optional(),
  })
  .strict();
export type ReplyInput = z.input<typeof ReplyInput>;

export interface ItemWriteResult {
  applied: boolean;
  id: string;
  status?: string;
  draft_id?: string;
  message: string;
  plan_check?: string; // an AI handing work in for review: the card must describe what was built, not the old plan
}

// Benchmark round 7: a task card kept a plan value the implementation had changed, and an agent later quoted
// it with confidence. So when an AI hands work in, it is told to bring the card up to date first.
function planCheck(actor: Actor, schema: ItemSchema, item: Item, to: string | undefined): { plan_check?: string } {
  if (actor.kind !== "ai" || to === undefined || to === item.status || !item.body.trim()) return {};
  const closing = to === "review" || (schema.human_only_statuses ?? []).includes(to) || schema.terminal.includes(to);
  if (!closing) return {};
  return {
    plan_check:
      "The card body still holds the plan it was written with. If what you built differs (values, limits, names, files, steps left out), " +
      "update the body now with cortex_update_item (body_mode replace) so nobody reads the old plan as fact. Then ask the person " +
      `to close it: cortex_ask_human kind "transition".`,
  };
}

export type InboxReason =
  | "assigned_to_you"
  | "assigned_to_group"
  | "your_question_answered"
  | "new_reply"
  | "decision_needs_review"
  | "discussion_needs_your_view"
  | "review_waiting_on_you"
  | "draft_to_approve"
  | "stale_knowledge";

// A person's queue lists what needs them first: finished work to check, then decisions and views asked of
// them, then their own work. Paging follows this order so a page never skips a group halfway.
export const INBOX_ORDER: InboxReason[] = [
  "review_waiting_on_you",
  "draft_to_approve",
  "decision_needs_review",
  "discussion_needs_your_view",
  "assigned_to_you",
  "assigned_to_group",
  "your_question_answered",
  "new_reply",
  "stale_knowledge",
];

// Work an agent finished and handed over sits in this status until a person checks it.
const REVIEW = "review";

// Statuses a discussion reaches only through the discussion service, which counts the votes and writes the decision.
const DISCUSSION_MANAGED = ["voted", "decided"];

// A question with options: they must be real choices (two or more, distinct), the same rule as a discussion's.
const offersOptions = (type: string, fields: Record<string, unknown> | undefined) =>
  type === "question" && Array.isArray(fields?.options) && fields.options.length > 0;

export function itemRevision(i: Item): string {
  return shortHash(JSON.stringify([i.title, i.body, i.status, i.assignee ?? null, i.category_path ?? null, i.fields, i.links ?? {}, i.updated_at]));
}

function zodIssues(e: z.ZodError): string[] {
  return e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

export class ItemService {
  constructor(private c: Cortex) {}

  // ---- schema helpers -----------------------------------------------------

  schema(type: string): ItemSchema {
    const s = this.c.schema(type);
    if (!s) {
      throw new CortexError("unknown_type", `Unknown item type "${type}".`, 400, { types: this.c.itemTypes() });
    }
    return s;
  }

  private ctx(): ValidationContext {
    return {
      actorExists: (id) => this.c.project.config.actors.some((a) => a.id === id),
      nodeExists: (p) => this.c.tree.exists(p),
      itemExists: (id) => this.c.itemStore.exists(id),
    };
  }

  // `issues` stays as it was (one line each, read by agents); `errors` says the same per field, so a form
  // can show each message beside the field it is about.
  private invalid(schema: ItemSchema, issues: string[], what = "Item"): CortexError {
    return new CortexError("invalid_item", `${what} does not match the "${schema.type}" rules.`, 400, {
      issues,
      // Field checks name the field alone ("severity: required"); as a path it is fields.severity.
      errors: issues.map(fieldError).map((e) => {
        const head = e.path.split(/[.[]/)[0];
        const field = head in schema.fields || head in (schema.reply?.fields ?? {});
        return field && !TOP_LEVEL.has(head) ? { ...e, path: `fields.${e.path}` } : e;
      }),
      rules: describeSchema(schema),
    });
  }

  private checkAssignee(assignee: string | undefined | null): string[] {
    if (assignee === undefined || assignee === null) return [];
    if (assignee in GROUP_ASSIGNEES) return [];
    return this.ctx().actorExists(assignee) ? [] : [`assignee: unknown actor "${assignee}" (use an actor id, "@humans" or "@ai")`];
  }

  private checkCategory(path: string | undefined | null, schema: ItemSchema): string[] {
    if (path === undefined || path === null || path === "") {
      return schema.category_required ? ['category_path: required for this type (a knowledge tree path, e.g. "backend/auth")'] : [];
    }
    return this.c.tree.exists(path) ? [] : [`category_path: no knowledge node at "${path}"`];
  }

  private checkLinks(links: ItemLinks | undefined): string[] {
    const issues: string[] = [];
    for (const p of links?.nodes ?? []) if (!this.c.tree.exists(p)) issues.push(`links.nodes: no knowledge node at "${p}"`);
    for (const id of links?.items ?? []) if (!this.c.itemStore.exists(id)) issues.push(`links.items: no item "${id}"`);
    for (const id of links?.activity ?? []) if (!this.c.index.getActivity(id)) issues.push(`links.activity: no activity "${id}"`);
    return issues;
  }

  private checkStatusChange(actor: Actor, schema: ItemSchema, from: string, to: string, force?: boolean): void {
    if (from === to) return;
    if (!schema.statuses.includes(to)) {
      throw new CortexError("invalid_status", `"${to}" is not a ${schema.type} status.`, 400, { statuses: schema.statuses });
    }
    if (actor.kind === "ai" && schema.human_only_statuses?.includes(to)) {
      throw new CortexError("forbidden", `Only humans can move a ${schema.type} to "${to}".`, 403, {
        human_only_statuses: schema.human_only_statuses,
        hint: "Ask a human: reply on the item or open a question assigned to @humans.",
      });
    }
    if (!canTransition(schema, from, to) && !(actor.kind === "human" && force)) {
      const allowed = schema.transitions === "any" ? schema.statuses : (schema.transitions[from] ?? []);
      throw new CortexError("invalid_transition", `Cannot move this ${schema.type} from "${from}" to "${to}".`, 400, {
        allowed_from_here: allowed,
        ...(actor.kind === "human" ? { note: "Humans may override with force: true." } : {}),
      });
    }
  }

  private policyGate(actor: Actor, type: string): "direct" | "draft" {
    const policy = actor.policy?.[type] ?? this.c.project.config.approval[type] ?? "auto";
    if (actor.kind !== "ai" || policy === "auto") return "direct";
    if (policy === "human_only") throw new CortexError("forbidden", `Only humans may write ${type} items in this project.`, 403);
    return "draft";
  }

  // ---- writes -------------------------------------------------------------

  create(actor: Actor, input: CreateItemInput): ItemWriteResult {
    const parsed = CreateItemInput.safeParse(input);
    const type = (input as { type?: string })?.type;
    if (!parsed.success) {
      const schema = type ? this.c.schema(type) : null;
      throw new CortexError("invalid_item", "Item does not match the common shape.", 400, {
        issues: zodIssues(parsed.error),
        ...(schema ? { rules: describeSchema(schema) } : { types: this.c.itemTypes() }),
      });
    }
    const d = parsed.data;
    const schema = this.schema(d.type);
    const category = d.category_path ? normalizePath(d.category_path) : undefined;
    const issues = [
      ...this.checkCategory(category, schema),
      ...this.checkAssignee(d.assignee),
      ...this.checkLinks(d.links),
      ...validateFields(schema.fields, d.fields, this.ctx(), schema.require_when),
      ...(d.type === DISCUSSION || offersOptions(d.type, d.fields) ? checkDiscussion(d.fields) : []),
    ];
    if (issues.length) throw this.invalid(schema, issues);

    const now = nowIso();
    const item: Item = {
      id: ulid(),
      type: d.type,
      title: d.title,
      status: schema.initial,
      category_path: category,
      author: actor.id,
      assignee: d.assignee,
      tags: d.tags,
      links: d.links,
      fields: d.fields,
      ...(schema.reply_required?.statuses.length ? { reply_required: d.reply_required ?? schema.reply_required.default } : {}),
      created_at: now,
      updated_at: now,
      updated_by: actor.id,
      body: d.body,
    };

    if (this.policyGate(actor, d.type) === "draft") {
      const draftId = this.c.saveDraft({ kind: "item", target: item.id, proposed_by: actor.id, reason: d.reason, data: item });
      return { applied: false, id: item.id, draft_id: draftId, message: "Saved as draft. A human must approve it before it becomes visible." };
    }
    this.save(item);
    this.c.activity.system(actor.id, "item.created", `Created ${item.type} "${item.title}"`, [item.id], { type: item.type, to: item.status });
    return { applied: true, id: item.id, status: item.status, message: `${item.type} created.` };
  }

  // `internal`: a write by another core service (the discussion count), allowed statuses a caller may not set directly.
  update(actor: Actor, id: string, input: UpdateItemInput, opts: { internal?: boolean } = {}): ItemWriteResult {
    const current = this.get(id).item;
    const schema = this.schema(current.type);
    const parsed = UpdateItemInput.safeParse(input);
    if (!parsed.success) throw this.invalid(schema, zodIssues(parsed.error), "Update");
    const d = parsed.data;
    if (d.if_rev !== undefined && d.if_rev !== itemRevision(current)) {
      throw this.c.conflict(current.updated_by, current.updated_at);
    }

    const next: Item = { ...current, fields: { ...current.fields } };
    if (d.title !== undefined) next.title = d.title;
    if (d.body !== undefined) {
      next.body = d.body_mode === "append" ? [current.body.trimEnd(), d.body.trim()].filter(Boolean).join("\n\n") : d.body;
      // Replacing a body with a fraction of itself is how a handoff note or a spec section gets lost: an agent
      // rewrites "the relevant part" from memory. Its versions keep it, but it should not happen by accident.
      if (actor.kind === "ai" && d.body_mode !== "append" && !d.confirm_shrink && shrinks(current.body, next.body)) {
        throw new CortexError("body_shrink", "This would remove more than half of the item's body.", 409, {
          current_chars: current.body.trim().length,
          new_chars: next.body.trim().length,
          hint: 'To add to the body, pass body_mode "append" with only the new text. If removing it is intended, pass confirm_shrink: true.',
        });
      }
    }
    if (d.tags !== undefined) next.tags = d.tags;
    if (d.links !== undefined) next.links = d.links;
    if (d.assignee !== undefined) next.assignee = d.assignee ?? undefined;
    if (d.category_path !== undefined) next.category_path = d.category_path ? normalizePath(d.category_path) : undefined;
    for (const [k, v] of Object.entries(d.fields ?? {})) {
      if (v === null) delete next.fields[k];
      else next.fields[k] = v;
    }
    const issues = [
      ...(d.category_path !== undefined ? this.checkCategory(next.category_path, schema) : []),
      ...(d.assignee !== undefined ? this.checkAssignee(next.assignee) : []),
      ...(d.links !== undefined ? this.checkLinks(next.links) : []),
      ...validateFields(schema.fields, next.fields, this.ctx(), schema.require_when),
      ...((current.type === DISCUSSION || offersOptions(current.type, next.fields)) && d.fields?.options !== undefined ? checkDiscussion(next.fields) : []),
    ];
    if (issues.length) throw this.invalid(schema, issues, "Update");
    if (current.type === DISCUSSION && !opts.internal && d.status && d.status !== current.status && DISCUSSION_MANAGED.includes(d.status)) {
      throw new CortexError("invalid_transition", `A discussion becomes "${d.status}" by counting or deciding, not by a status change.`, 400, {
        hint: "POST /discussions/:id/close-vote counts the votes; a person decides with POST /discussions/:id/decide or by accepting the decision.",
      });
    }
    if (d.reply_required !== undefined && d.reply_required !== current.reply_required) {
      // Whoever has to write the reply must not be able to waive it; the person who decides can.
      if (actor.kind !== "human") {
        throw new CortexError("forbidden", "Only humans can change whether an item needs a reply when it is closed.", 403);
      }
      next.reply_required = d.reply_required;
    }
    if (d.status !== undefined) {
      this.checkStatusChange(actor, schema, current.status, d.status, d.force);
      // An AI finishing work must say what it did where the card's reader looks: in a reply. A person
      // moving the card is the one deciding, so the rule does not stop them.
      if (actor.kind === "ai" && d.status !== current.status && needsReply(schema, next.reply_required, d.status)) {
        throw new CortexError("reply_required", `Moving this ${schema.type} to "${d.status}" needs a reply saying what was done.`, 400, {
          hint:
            `Use cortex_reply (POST /items/${id}/replies) with status "${d.status}" and a body covering what you did, commits, files, ` +
            "what is left out and how to test it. A status change's reason, a handoff note or an activity entry do not show on the card.",
          reply_required_statuses: schema.reply_required?.statuses ?? [],
        });
      }
      next.status = d.status;
    }
    next.updated_at = nowIso();
    next.updated_by = actor.id;

    if (this.policyGate(actor, current.type) === "draft") {
      const draftId = this.c.saveDraft({
        kind: "item",
        target: id,
        proposed_by: actor.id,
        reason: d.reason,
        base_rev: itemRevision(current),
        data: next,
      });
      return { applied: false, id, draft_id: draftId, message: "Saved as draft. A human must approve it." };
    }
    this.save(next);
    const what = current.status !== next.status ? `${current.status} → ${next.status}` : "edited";
    this.c.activity.system(actor.id, "item.updated", `Updated ${next.type} "${next.title}" (${what})`, [id], {
      type: next.type,
      from: current.status,
      to: next.status,
    });
    if (next.type === "decision" && next.status === "accepted" && current.status !== "accepted") this.c.discussions.onDecisionAccepted(actor, next);
    return { applied: true, id, status: next.status, message: `${next.type} updated.`, ...planCheck(actor, schema, current, d.status) };
  }

  reply(actor: Actor, id: string, input: ReplyInput): ItemWriteResult & { reply_id: string } {
    const item = this.get(id).item;
    const schema = this.schema(item.type);
    const parsed = ReplyInput.safeParse(input);
    if (!parsed.success) throw this.invalid(schema, zodIssues(parsed.error), "Reply");
    const d = parsed.data;
    const issues = validateFields(schema.reply?.fields ?? {}, d.fields, this.ctx(), schema.reply?.require_when);
    if (issues.length) throw this.invalid(schema, issues, "Reply");
    if (item.type === DISCUSSION) {
      checkDiscussionReply(actor, item, d.fields);
      if (d.status !== undefined && d.status !== item.status)
        throw new CortexError("invalid_request", "Change a discussion's phase separately from posting a view.", 400);
    }

    let to = d.status;
    if (to === undefined) {
      // Automatic transitions, e.g. a question becomes "answered" when someone other than the asker replies.
      const rule = schema.reply?.on_reply?.find((r) => r.from === item.status && this.replyRuleMatches(r.by, actor, item));
      to = rule?.to;
    }
    if (to !== undefined) this.checkStatusChange(actor, schema, item.status, to, d.force);

    const via = currentVia();
    const reply: Reply = {
      id: ulid(),
      item_id: id,
      author: actor.id,
      created_at: nowIso(),
      ...(to !== undefined && to !== item.status ? { status_change: { from: item.status, to } } : {}),
      ...(Object.keys(d.fields).length ? { fields: d.fields } : {}),
      ...(via ? { via } : {}),
      body: d.body,
    };
    this.c.itemStore.addReply(reply);
    const next: Item = { ...item, status: to ?? item.status, updated_at: reply.created_at, updated_by: actor.id };
    this.save(next);
    this.c.activity.system(
      actor.id,
      "item.replied",
      `Replied on ${item.type} "${item.title}"${reply.status_change ? ` (${reply.status_change.from} → ${reply.status_change.to})` : ""}`,
      [id],
      { type: item.type, ...(reply.status_change ?? {}) },
    );
    return { applied: true, id, reply_id: reply.id, status: next.status, message: "Reply added.", ...planCheck(actor, schema, item, to) };
  }

  // Claim/release: who is actively working an item right now, separate from `assignee` (who it belongs to).
  // Always writes directly (never a draft, whatever the type's approval policy) — it is coordination metadata,
  // not content to review, and queuing "I'm taking this now" as a pending draft would defeat its purpose.
  // Deliberately does not touch updated_at/updated_by/itemRevision: claim churn must never invalidate an
  // unrelated pending content draft's base_rev, or a caller's if_rev.
  claim(actor: Actor, id: string, input: ClaimInput): ItemWriteResult {
    const current = this.get(id).item;
    const parsed = ClaimInput.safeParse(input);
    if (!parsed.success) throw this.invalid(this.schema(current.type), zodIssues(parsed.error), "Claim");
    const d = parsed.data;

    if (d.action === "release") {
      if (current.claimed_by !== actor.id && !(actor.kind === "human" && d.force)) {
        throw new CortexError("forbidden", `This item is not claimed by ${actor.id}.`, 403, { claimed_by: current.claimed_by ?? null });
      }
      const next: Item = { ...current, claimed_by: undefined, claimed_at: undefined, handoff_note: d.note ?? current.handoff_note };
      this.save(next);
      this.c.activity.system(actor.id, "item.released", `Released ${next.type} "${next.title}"`, [id], { type: next.type });
      return { applied: true, id, status: next.status, message: "Claim released." };
    }

    const heldMs = current.claimed_by && current.claimed_at ? Date.now() - Date.parse(current.claimed_at) : Infinity;
    const held = current.claimed_by !== undefined && heldMs < CLAIM_TTL_MS;
    if (held && current.claimed_by !== actor.id && !(actor.kind === "human" && d.force)) {
      throw new CortexError("conflict", `Already claimed by ${current.claimed_by}.`, 409, { held_by: current.claimed_by, since: current.claimed_at });
    }
    const next: Item = { ...current, claimed_by: actor.id, claimed_at: nowIso(), handoff_note: d.note ?? current.handoff_note };
    this.save(next);
    this.c.activity.system(actor.id, "item.claimed", `Claimed ${next.type} "${next.title}"`, [id], { type: next.type });
    return { applied: true, id, status: next.status, message: "Claimed." };
  }

  private replyRuleMatches(by: string, actor: Actor, item: Item): boolean {
    switch (by) {
      case "anyone":
        return true;
      case "author":
        return actor.id === item.author;
      case "not_author":
        return actor.id !== item.author;
      case "assignee":
        return this.isAssignedTo(item.assignee ?? null, actor);
      default:
        return false;
    }
  }

  private isAssignedTo(assignee: string | null, actor: Actor): boolean {
    if (!assignee) return false;
    if (assignee === actor.id) return true;
    return GROUP_ASSIGNEES[assignee as keyof typeof GROUP_ASSIGNEES] === actor.kind;
  }

  // Ask about anything (an activity, an item or a knowledge node). The question goes to whoever made it.
  ask(actor: Actor, input: { about: string; title: string; body?: string; assignee?: string; blocking?: boolean }): ItemWriteResult {
    const about = input.about.trim();
    const links: ItemLinks = {};
    let owner: string | undefined;
    let category: string | undefined;

    const activity = /^[0-9A-Z]{26}$/.test(about) ? this.c.index.getActivity(about) : null;
    const item = !activity && /^[0-9A-Z]{26}$/.test(about) ? this.c.itemStore.read(about) : null;
    if (activity) {
      links.activity = [about];
      owner = activity.actor;
      category = activity.refs?.find((r) => this.c.tree.exists(r));
    } else if (item) {
      links.items = [about];
      owner = item.author;
      category = item.category_path;
    } else {
      const path = normalizePath(about);
      const node = this.c.tree.read(path);
      if (!node) {
        throw new CortexError("not_found", `Nothing to ask about at "${about}". Use an activity id, item id or node path.`, 404);
      }
      links.nodes = [path];
      owner = node.updated_by;
      category = path === "" ? undefined : path;
    }
    let assignee = input.assignee ?? owner;
    // Asking yourself is pointless: route it to the other side instead.
    if (assignee === actor.id) assignee = actor.kind === "ai" ? "@humans" : "@ai";

    return this.create(actor, {
      type: "question",
      title: input.title,
      body: input.body ?? "",
      category_path: category,
      assignee,
      links,
      fields: input.blocking !== undefined ? { blocking: input.blocking } : {},
    });
  }

  // Archiving writes the item as it is, apart from `archived`: no status rules, no approval policy (the
  // archive service decides who may), and updated_at stays so the record keeps its real last change.
  saveArchived(item: Item): void {
    this.save(item);
  }

  // Before a change to what the item says replaces it, the previous state is kept as a version (see
  // ItemStore.addVersion). A status move alone is not a version: the replies already record those.
  private save(item: Item): void {
    const previous = this.c.itemStore.read(item.id);
    if (previous && contentKey(previous) !== contentKey(item)) this.c.itemStore.addVersion(previous, item.updated_by, item.updated_at);
    this.c.itemStore.write(item);
    this.reindexItem(item);
  }

  // ---- checklist -----------------------------------------------------------------------

  // Ticks one task box in the body. Goes through update(), so the item's rules, drafts, if_rev and versions
  // all apply: two people ticking at once from the same revision, the second gets a 409.
  setChecklistBox(actor: Actor, id: string, input: { line?: unknown; checked?: unknown; if_rev?: unknown }) {
    const current = this.get(id).item;
    if (!Number.isInteger(input.line) || typeof input.checked !== "boolean") {
      throw new CortexError("invalid_request", "Pass line (the box's 0-based line in the body) and checked (true or false).", 400, {
        boxes: parseChecklist(current.body).map(({ line, checked, text }) => ({ line, checked, text })),
      });
    }
    if (input.if_rev !== undefined && input.if_rev !== itemRevision(current)) throw this.c.conflict(current.updated_by, current.updated_at);
    const body = setBox(current.body, input.line as number, input.checked);
    if (body === null) {
      throw new CortexError("invalid_request", `Line ${String(input.line)} holds no task box.`, 400, {
        boxes: parseChecklist(current.body).map(({ line, checked, text }) => ({ line, checked, text })),
      });
    }
    const r = this.update(actor, id, { body, confirm_shrink: true, reason: `${input.checked ? "Ticked" : "Unticked"} a task box` });
    const next = this.c.itemStore.read(id);
    return { ...r, ...(r.applied && next ? { rev: itemRevision(next), checklist: countChecklist(next.body) } : {}) };
  }

  // ---- versions ------------------------------------------------------------------------

  history(id: string) {
    const { item } = this.get(id);
    // Each version with what it differs in from the one after it (the current item for the newest).
    const versions = this.c.itemStore.versions(id);
    return {
      versions: versions.map((v, i) => {
        const after = i === 0 ? item : versions[i - 1].item;
        return {
          version: v.version,
          saved_by: v.item.updated_by,
          saved_at: v.item.updated_at,
          replaced_by: v.replaced_by,
          replaced_at: v.replaced_at,
          title: v.item.title,
          body_chars: v.item.body.trim().length,
          changed: changedParts(v.item, after),
        };
      }),
      max: MAX_VERSIONS,
    };
  }

  version(id: string, vid: string) {
    this.get(id);
    const v = this.c.itemStore.version(id, vid);
    if (!v) throw new CortexError("not_found", `No version "${vid}" of this item. Versions: GET /items/${id}/history.`, 404);
    return v;
  }

  // Brings back what a version said (title, body, fields, tags, links, assignee, branch, handoff note). The
  // status stays: moving work is a separate decision. The state it replaces becomes a version itself, so a
  // restore can be undone the same way.
  restore(actor: Actor, id: string, vid: string, reason?: string): ItemWriteResult {
    const current = this.get(id).item;
    const old = this.version(id, vid).item;
    const next: Item = {
      ...current,
      title: old.title,
      body: old.body,
      fields: { ...old.fields },
      tags: old.tags,
      links: old.links,
      assignee: old.assignee,
      category_path: old.category_path,
      handoff_note: old.handoff_note,
      updated_at: nowIso(),
      updated_by: actor.id,
    };
    if (this.policyGate(actor, current.type) === "draft") {
      const draftId = this.c.saveDraft({
        kind: "item",
        target: id,
        proposed_by: actor.id,
        reason: reason ?? `Restore version ${vid}`,
        base_rev: itemRevision(current),
        data: next,
      });
      return { applied: false, id, draft_id: draftId, message: "Saved as draft. A human must approve it." };
    }
    this.save(next);
    this.c.activity.system(actor.id, "item.restored", `Restored ${next.type} "${next.title}" to its version of ${old.updated_at}`, [id], {
      type: next.type,
      version: vid,
    });
    return { applied: true, id, status: next.status, message: `${next.type} restored to version ${vid}.` };
  }

  private reindexItem(item: Item): void {
    this.c.index.upsertItem(item, this.c.itemStore.replies(item.id), this.c.itemFlags(item.type, item.status), this.c.itemStore.fileSummary(item.id));
  }

  // ---- attachments ---------------------------------------------------------------------
  // Files next to the item (screenshots, logs, a spec in Markdown). They are not item fields, so they
  // skip drafts: a draft cannot carry bytes. An AI whose writes to this type would be drafts or refused
  // may therefore not attach either; a person can.

  attachments(id: string) {
    this.get(id);
    return this.c.itemStore.attachments(id);
  }

  attach(actor: Actor, id: string, name: string, data: Buffer) {
    const { item } = this.get(id);
    this.attachGate(actor, item.type);
    if (!data.length) throw new CortexError("invalid_file", "The file is empty.", 400);
    if (data.length > MAX_ATTACHMENT_BYTES) throw new CortexError("file_too_large", `Files may be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`, 413);
    if (this.c.itemStore.attachments(id).length >= MAX_ATTACHMENTS) {
      throw new CortexError("too_many_files", `An item holds at most ${MAX_ATTACHMENTS} files. Remove some first.`, 400);
    }
    const file = this.c.itemStore.addAttachment(id, name, data);
    this.reindexItem(item);
    this.c.activity.system(actor.id, "item.attached", `Attached "${file.name}" to ${item.type} "${item.title}"`, [id], { type: item.type });
    return { applied: true, id, file, message: `Attached ${file.name}.` };
  }

  detach(actor: Actor, id: string, name: string) {
    const { item } = this.get(id);
    this.attachGate(actor, item.type);
    if (!this.c.itemStore.removeAttachment(id, name)) throw new CortexError("not_found", `No file "${name}" on this item.`, 404);
    this.reindexItem(item);
    this.c.activity.system(actor.id, "item.detached", `Removed "${name}" from ${item.type} "${item.title}"`, [id], { type: item.type });
    return { applied: true, id, message: `Removed ${name}. It stays in git history.` };
  }

  private attachGate(actor: Actor, type: string): void {
    if (this.policyGate(actor, type) === "draft") {
      throw new CortexError(
        "forbidden",
        `AI changes to ${type} items wait for approval here, and files cannot wait in a draft. Ask a person to attach it.`,
        403,
      );
    }
  }

  applyDraft(item: Item): void {
    const existed = this.c.itemStore.exists(item.id);
    this.save(item);
    this.c.activity.system(
      item.updated_by,
      existed ? "item.updated" : "item.created",
      `${existed ? "Updated" : "Created"} ${item.type} "${item.title}" (approved draft)`,
      [item.id],
      { type: item.type, to: item.status },
    );
  }

  // ---- reads --------------------------------------------------------------

  // `viewer`: who reads it. A discussion's blind round hides the others' views from them; internal reads pass none.
  get(id: string, opts: { replies?: number; budget?: number; viewer?: Actor } = {}) {
    const item = this.c.itemStore.read(id);
    if (!item) throw new CortexError("not_found", `No item with id "${id}".`, 404);
    const stored = this.c.itemStore.replies(id);
    const discussion = item.type === DISCUSSION && opts.viewer ? this.c.discussions.summary(opts.viewer, item, stored) : undefined;
    let replies = item.type === DISCUSSION && opts.viewer ? viewReplies(opts.viewer, item, stored) : stored;
    const total = replies.length;
    // Newest replies matter most; trim older ones to respect the limit and the token budget.
    if (opts.replies !== undefined) replies = replies.slice(Math.max(0, replies.length - opts.replies));
    if (opts.budget) {
      let used = estimateTokens(item);
      const kept: Reply[] = [];
      for (const r of [...replies].reverse()) {
        used += estimateTokens(r);
        if (used > opts.budget && kept.length > 0) break;
        kept.unshift(r);
      }
      replies = kept;
    }
    const attachments = this.c.itemStore.attachments(id);
    return {
      item,
      rev: itemRevision(item),
      replies,
      replies_omitted: total - replies.length,
      ...(attachments.length ? { attachments } : {}),
      ...(discussion ? { discussion } : {}),
      rules_url: `/api/rules/${item.type}`,
    };
  }

  list(q: {
    type?: string;
    status?: string;
    assignee?: string;
    author?: string;
    path?: string;
    open?: boolean;
    since?: string;
    until?: string;
    milestone?: string;
    limit?: number;
    cursor?: string;
    visible?: SqlFilter | null;
    preview?: boolean;
  }) {
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 500);
    const offset = q.cursor ? Math.max(0, Number(q.cursor) || 0) : 0;
    const { items, total } = this.c.index.queryItems({
      type: q.type,
      status: q.status,
      author: q.author,
      assignee: q.assignee ? [q.assignee] : undefined,
      under: q.path ? normalizePath(q.path) : undefined,
      open: q.open,
      visible: q.visible,
      since: q.since,
      until: q.until,
      milestone: q.milestone,
      limit,
      offset,
    });
    const next = offset + items.length < total ? String(offset + items.length) : null;
    const rows = items.map((i) => (q.preview ? { ...compact(i), ...this.preview(i.id) } : compact(i)));
    return { items: rows, total, next_cursor: next };
  }

  // A board: for each status of the type, its first page and its total. Asking one column at a time keeps a
  // big project's board to a few dozen cards in the page; each column pages on with list({ status, cursor }).
  board(q: {
    type: string;
    path?: string;
    assignee?: string;
    author?: string;
    since?: string;
    until?: string;
    milestone?: string;
    per_status?: number;
    visible?: SqlFilter | null;
  }) {
    const schema = this.schema(q.type);
    const limit = Math.min(Math.max(q.per_status ?? 20, 1), 100);
    return {
      type: q.type,
      columns: schema.statuses.map((status) => {
        const r = this.list({ ...q, status, limit });
        return { status, total: r.total, items: r.items, next_cursor: r.next_cursor };
      }),
    };
  }

  // The gist of an item and where its conversation stands, so a list answers "what is this and who moves next"
  // without opening every item: agents measured 3-5 extra cortex_item calls per question without it.
  private preview(id: string) {
    const item = this.c.itemStore.read(id);
    if (!item) return {};
    const flat = (t: string) => t.replace(/\s+/g, " ").trim();
    const gist = flat(item.body);
    // A blind round's views stay out of previews: they would tell the next participant what the others said.
    const last = isSealed(item) ? undefined : this.c.itemStore.replies(id).at(-1);
    return {
      ...(gist ? { gist: shorten(gist, PREVIEW_CHARS) } : {}),
      ...(last
        ? {
            last_reply: {
              by: last.author,
              at: last.created_at,
              ...(last.status_change ? { to: last.status_change.to } : {}),
              text: shorten(flat(last.body), PREVIEW_CHARS),
            },
          }
        : {}),
    };
  }

  // Where a person's check sends a reviewed item: approve = its finished status, send back = the working
  // status it came from. Worked out from the rules so a custom type with a "review" status works too.
  reviewMoves(type: string, status: string): { approve?: string; send_back?: string } {
    const schema = this.c.schema(type);
    if (!schema) return {};
    const next = schema.transitions === "any" ? schema.statuses.filter((s) => s !== status) : (schema.transitions[status] ?? []);
    const approve = next.find((s) => schema.terminal.includes(s));
    const before = schema.statuses[schema.statuses.indexOf(status) - 1];
    const send_back = schema.transitions === "any" ? before : next.find((s) => !schema.terminal.includes(s));
    return { ...(approve ? { approve } : {}), ...(send_back && !schema.terminal.includes(send_back) ? { send_back } : {}) };
  }

  // The reply that handed the work in (the last one that moved it to where it waits): what to try, and since
  // when it has been waiting. Read from the files, for the few rows waiting for review only.
  private handedIn(id: string, status: string): { to_test?: string[]; waiting_since?: string } {
    const replies = this.c.itemStore.replies(id);
    const last = [...replies].reverse().find((r) => r.status_change?.to === status);
    if (!last) return {};
    const steps = toTest(last.body);
    return { waiting_since: last.created_at, ...(steps.length ? { to_test: steps } : {}) };
  }

  // The same check the inbox's review row offers, for the item's own page: undefined unless this item waits
  // for review on this person (by the inbox's rules), so the page shows the panel exactly where the row is.
  reviewFor(actor: Actor, id: string, opts: { reviewer?: boolean } = {}) {
    const item = this.c.index.getItem(id);
    if (!item || actor.kind !== "human" || !(opts.reviewer ?? true)) return undefined;
    if (item.status !== REVIEW || item.last_reply_by === actor.id) return undefined;
    return { moves: this.reviewMoves(item.type, item.status), ...this.handedIn(item.id, item.status) };
  }

  // `reviewer`: this person may finish reviewed work (on a hub, the approve permission). Only people get
  // review rows; an agent's inbox is unchanged.
  inbox(actor: Actor, limit = 20, visible: SqlFilter | null = null, opts: { reviewer?: boolean } = {}) {
    const groups = Object.entries(GROUP_ASSIGNEES)
      .filter(([, kind]) => kind === actor.kind)
      .map(([g]) => g);
    const seen = new Map<string, { item: IndexedItem; reason: InboxReason }>();
    const add = (item: IndexedItem, reason: InboxReason) => {
      if (!seen.has(item.id)) seen.set(item.id, { item, reason });
    };
    const q = (query: ItemQuery) => this.c.index.queryItems({ ...query, visible }).items;

    // First, so a reviewed task assigned to this person shows as "check this", not "your work".
    // Left out: what this person moved to review themselves (their reply is the last one).
    if (actor.kind === "human" && (opts.reviewer ?? true)) {
      for (const i of q({ open: true, status: REVIEW, limit: 500, offset: 0 })) if (i.last_reply_by !== actor.id) add(i, "review_waiting_on_you");
    }
    for (const i of q({ open: true, assignee: [actor.id], limit: 200, offset: 0 })) {
      // An answered question waits on its asker, not on the person who answered it.
      if (!(i.type === "question" && i.status === "answered")) add(i, "assigned_to_you");
    }
    for (const i of q({ open: true, type: "question", status: "answered", author: actor.id, limit: 200, offset: 0 })) add(i, "your_question_answered");
    for (const i of q({ open: true, assignee: groups, limit: 200, offset: 0 })) {
      if (!(i.type === "question" && i.status === "answered") && i.author !== actor.id) add(i, "assigned_to_group");
    }
    if (actor.kind === "human") {
      for (const i of q({ open: true, type: "decision", status: "proposed", limit: 200, offset: 0 })) add(i, "decision_needs_review");
    }
    const asked = new Set(this.c.discussions.askingFor(actor, visible));
    for (const i of q({ open: true, type: DISCUSSION, limit: 500, offset: 0 })) if (asked.has(i.id)) add(i, "discussion_needs_your_view");
    for (const i of q({ open: true, author: actor.id, limit: 200, offset: 0 })) {
      if (i.last_reply_by && i.last_reply_by !== actor.id) add(i, "new_reply");
    }

    const all = [...seen.values()].sort((a, b) => Number(b.item.blocking) - Number(a.item.blocking) || (a.item.updated_at < b.item.updated_at ? 1 : -1));
    // The same queue split by type: the board's type tabs carry it as a badge.
    const by_type: Record<string, number> = {};
    for (const { item } of all) by_type[item.type] = (by_type[item.type] ?? 0) + 1;
    return {
      count: all.length,
      by_type,
      items: all.slice(0, limit).map(({ item, reason }) => ({
        ...compact(item),
        reason,
        ...(reason === "review_waiting_on_you" ? { moves: this.reviewMoves(item.type, item.status), ...this.handedIn(item.id, item.status) } : {}),
      })),
    };
  }
}

const PREVIEW_CHARS = 200;

// An item's own keys; anything else a check names is one of its fields.
const TOP_LEVEL = new Set(["type", "title", "body", "status", "category_path", "assignee", "tags", "links", "fields", "reply_required", "reason"]);

// "fields.severity: required" -> { path: "fields.severity", message: "required" }. A line without a path
// ("(root): ..." or plain prose) is about the whole record.
export function fieldError(issue: string): { path: string; message: string } {
  const at = issue.indexOf(": ");
  const path = at > 0 ? issue.slice(0, at) : "";
  return /^[A-Za-z_][\w.[\]-]*$/.test(path) && path !== "(root)" ? { path, message: issue.slice(at + 2) } : { path: "", message: issue };
}

// What an item says, as opposed to where it stands (status) or who holds it now (claims).
const CONTENT = ["title", "body", "assignee", "category_path", "fields", "links", "tags", "handoff_note"] as const;
const contentKey = (i: Item) => JSON.stringify(CONTENT.map((k) => i[k] ?? null));
const changedParts = (a: Item, b: Item) => CONTENT.filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));

// More than half of a body of some size gone. Short bodies are exempt: rewriting two lines is editing.
const SHRINK_MIN_CHARS = 200;
export function shrinks(before: string, after: string): boolean {
  const was = before.trim().length;
  return was >= SHRINK_MIN_CHARS && after.trim().length < was / 2;
}

function compact(i: IndexedItem) {
  return {
    id: i.id,
    type: i.type,
    title: i.title,
    status: i.status,
    ...(i.category_path ? { category_path: i.category_path } : {}),
    author: i.author,
    ...(i.assignee ? { assignee: i.assignee } : {}),
    ...(i.claimed_by ? { claimed_by: i.claimed_by, claimed_at: i.claimed_at } : {}),
    ...(i.blocking ? { blocking: true } : {}),
    ...(i.reply_count ? { replies: i.reply_count } : {}),
    ...(i.attachment_count ? { files: i.attachment_count } : {}),
    ...(i.cover ? { cover: i.cover } : {}),
    ...(i.level ? { level: i.level } : {}),
    ...(i.due ? { due: i.due } : {}),
    ...(i.has_body ? { has_body: true } : {}),
    // Finished by the rules (terminal or resolved): the board stops counting a due date against it.
    ...(!i.open ? { done: true } : {}),
    ...(i.checklist.total ? { checklist: i.checklist } : {}),
    updated_at: i.updated_at,
  };
}
