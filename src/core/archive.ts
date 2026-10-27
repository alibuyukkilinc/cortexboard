import type { Cortex } from "./cortex.js";
import { nodeRevision } from "./cortex.js";
import type { SqlFilter } from "../index/db.js";
import { itemRevision } from "./items.js";
import type { Actor, Archived, Item, KnowledgeNode } from "./types.js";
import { CortexError } from "./types.js";
import { normalizePath } from "../store/tree.js";
import { nowIso } from "../util/text.js";

// Keeping memory lean: knowledge and records that no longer apply (a solved one-off server problem, a
// superseded decision, a branch for a part that is gone) leave everyday view instead of costing tokens in
// every search. Two steps, both human-controlled:
//   archive: the file stays, readable by id or path and restorable; search, the brief, the tree, code
//            context, item lists and staleness skip it. An AI's archiving is a draft a person approves.
//   purge:   a person deletes an archived record for good. Git history still has it.
// Old activity leaves default search after a while but is never archived or deleted: it is the audit trail.

export const ARCHIVE_AFTER_DAYS = 30;
export const ACTIVITY_SEARCH_DAYS = 90;
const ULID = /^[0-9A-Z]{26}$/;
const DAY = 86_400_000;

export interface ArchiveCandidate {
  kind: "item" | "node";
  ref: string; // item id or node path
  title: string;
  type?: string;
  status: string;
  updated_at: string;
  age_days: number;
  why: string;
}

export interface ArchiveOutcome {
  ref: string;
  applied: boolean;
  draft_id?: string;
  error?: { code: string; message: string };
}

type Target = { kind: "item"; item: Item } | { kind: "node"; node: KnowledgeNode };

export class ArchiveService {
  constructor(private c: Cortex) {}

  afterDays(): number {
    return Math.max(1, Number(this.c.project.config.archive?.after_days) || ARCHIVE_AFTER_DAYS);
  }

  // Activity older than this is not offered by default search (see Cortex.search).
  activityCutoff(): string {
    const days = Math.max(1, Number(this.c.project.config.archive?.activity_days) || ACTIVITY_SEARCH_DAYS);
    return new Date(Date.now() - days * DAY).toISOString();
  }

  // What could go: finished items untouched for a while that no open item still points to, and knowledge
  // someone already marked deprecated. A suggestion list; nothing moves until someone archives it.
  candidates(visible: SqlFilter | null = null): { after_days: number; candidates: ArchiveCandidate[] } {
    const days = this.afterDays();
    const cutoff = new Date(Date.now() - days * DAY).toISOString();
    const age = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / DAY);
    const openItems = this.c.index.queryItems({ open: true, visible: null, limit: 5000, offset: 0 }).items;
    const stillCited = new Set(openItems.flatMap((i) => this.c.itemStore.read(i.id)?.links?.items ?? []));

    const items = this.c.index
      .queryItems({ visible, limit: 5000, offset: 0 })
      .items.filter((i) => i.terminal && i.updated_at < cutoff && !stillCited.has(i.id))
      .map((i): ArchiveCandidate => ({
        kind: "item",
        ref: i.id,
        title: i.title,
        type: i.type,
        status: i.status,
        updated_at: i.updated_at,
        age_days: age(i.updated_at),
        why: `${i.type} is ${i.status}, untouched for ${age(i.updated_at)} days`,
      }));
    const nodes = this.c.tree
      .all()
      .filter((n) => n.status === "deprecated" && !n.archived && n.path !== "")
      .map((n): ArchiveCandidate => ({
        kind: "node",
        ref: n.path,
        title: n.title,
        status: n.status,
        updated_at: n.updated_at,
        age_days: age(n.updated_at),
        why: "knowledge marked deprecated",
      }));
    return { after_days: days, candidates: [...nodes, ...items].sort((a, b) => b.age_days - a.age_days) };
  }

  list(visible: SqlFilter | null = null) {
    const items = this.c.index.queryItems({ archived: "only", visible, limit: 5000, offset: 0 }).items.map((i) => {
      const full = this.c.itemStore.read(i.id);
      return { kind: "item" as const, ref: i.id, title: i.title, type: i.type, status: i.status, archived: full?.archived };
    });
    const nodes = this.c.index
      .archivedNodes()
      .map((n) => ({ kind: "node" as const, ref: n.path, title: n.title, status: n.status, archived: this.c.tree.read(n.path)?.archived }));
    return { archived: [...nodes, ...items] };
  }

  // Resolves and checks one reference: an item id or a knowledge path.
  target(ref: string): Target {
    if (ULID.test(ref)) {
      const item = this.c.itemStore.read(ref);
      if (!item) throw new CortexError("not_found", `No item with id "${ref}".`, 404);
      return { kind: "item", item };
    }
    const path = normalizePath(ref);
    const node = this.c.tree.read(path);
    if (!node) throw new CortexError("not_found", `No knowledge node at "${path}".`, 404);
    return { kind: "node", node };
  }

  private checkArchivable(t: Target): void {
    if (t.kind === "item") {
      if (t.item.archived) throw new CortexError("already_archived", `"${t.item.title}" is already archived.`, 409);
      const flags = this.c.itemFlags(t.item.type, t.item.status);
      if (!flags.terminal) {
        throw new CortexError(
          "not_finished",
          `Only finished items can be archived; this ${t.item.type} is "${t.item.status}".`,
          409,
          t.item.type === "decision" ? { hint: "An accepted decision still applies. Supersede it with a new decision first." } : undefined,
        );
      }
      return;
    }
    const p = t.node.path;
    if (p === "") throw new CortexError("invalid_request", "The project root cannot be archived.", 400);
    if (t.node.archived) throw new CortexError("already_archived", `"${p}" is already archived.`, 409);
    const kids = this.c.index.children(p);
    if (kids.length) {
      throw new CortexError("has_children", `"${p}" still has ${kids.length} child node(s). Archive or move them first.`, 409, {
        children: kids.map((k) => k.path),
      });
    }
    const open = this.c.index.queryItems({ under: p, open: true, limit: 20, offset: 0 }).items;
    if (open.length) {
      throw new CortexError("has_open_items", `${open.length} open item(s) are filed under "${p}".`, 409, {
        items: open.map((i) => ({ id: i.id, title: i.title })),
      });
    }
  }

  // People archive at once; an AI's archiving becomes a draft per record, with its reason, for a person to approve.
  archive(actor: Actor, refs: string[], reason?: string): { results: ArchiveOutcome[]; message: string } {
    if (!Array.isArray(refs) || !refs.length) throw new CortexError("invalid_request", "Pass refs: item ids or knowledge paths.", 400);
    const why = reason?.trim();
    if (actor.kind === "ai" && (!why || why.length < 10)) {
      throw new CortexError("reason_required", "Say why this no longer applies (at least 10 characters): the person approving reads it.", 400);
    }
    const archived: Archived = { at: nowIso(), by: actor.id, ...(why ? { reason: why } : {}) };
    const results = [...new Set(refs)].map((ref): ArchiveOutcome => {
      try {
        const t = this.target(ref);
        this.checkArchivable(t);
        if (actor.kind === "ai") {
          const draft_id =
            t.kind === "item"
              ? this.c.saveDraft({
                  kind: "item",
                  target: t.item.id,
                  proposed_by: actor.id,
                  reason: `Archive: ${why}`,
                  base_rev: itemRevision(t.item),
                  data: { ...t.item, archived, updated_by: actor.id },
                })
              : this.c.saveDraft({
                  kind: "node",
                  target: t.node.path,
                  proposed_by: actor.id,
                  reason: `Archive: ${why}`,
                  base_rev: nodeRevision(t.node),
                  data: { ...t.node, archived, updated_by: actor.id },
                });
          return { ref, applied: false, draft_id };
        }
        this.write(t, archived, actor, "archive.archived", `Archived`);
        return { ref, applied: true };
      } catch (e) {
        return { ref, applied: false, error: errorOf(e) };
      }
    });
    const applied = results.filter((r) => r.applied).length;
    const drafts = results.filter((r) => r.draft_id).length;
    const failed = results.filter((r) => r.error).length;
    const parts = [applied && `${applied} archived`, drafts && `${drafts} waiting for approval`, failed && `${failed} refused`].filter(Boolean);
    return { results, message: `${parts.join(", ")}.` };
  }

  restore(actor: Actor, refs: string[]): { results: ArchiveOutcome[] } {
    this.requireHuman(actor, "bring archived records back");
    return {
      results: [...new Set(refs)].map((ref): ArchiveOutcome => {
        try {
          const t = this.target(ref);
          if (!(t.kind === "item" ? t.item.archived : t.node.archived)) throw new CortexError("not_archived", `"${ref}" is not archived.`, 409);
          this.write(t, undefined, actor, "archive.restored", "Restored");
          return { ref, applied: true };
        } catch (e) {
          return { ref, applied: false, error: errorOf(e) };
        }
      }),
    };
  }

  // For good. Only what is already archived, so nothing in view vanishes in one click.
  purge(actor: Actor, ref: string) {
    this.requireHuman(actor, "delete records for good");
    const t = this.target(ref);
    if (!(t.kind === "item" ? t.item.archived : t.node.archived)) {
      throw new CortexError("not_archived", "Archive it first; only archived records can be deleted for good.", 409);
    }
    if (t.kind === "item") {
      this.c.itemStore.remove(t.item.id);
      this.c.index.deleteItem(t.item.id);
      this.c.activity.system(actor.id, "archive.purged", `Deleted archived ${t.item.type} "${t.item.title}" for good`, [t.item.id], { type: t.item.type });
    } else {
      this.c.tree.remove(t.node.path);
      this.c.index.deleteNode(t.node.path);
      this.c.activity.system(actor.id, "archive.purged", `Deleted archived node "${t.node.path}" for good`, [t.node.path]);
    }
    return { applied: true, ref, message: "Deleted. It stays in git history." };
  }

  private write(t: Target, archived: Archived | undefined, actor: Actor, action: string, verb: string): void {
    if (t.kind === "item") {
      const { archived: _old, ...rest } = t.item;
      this.c.items.saveArchived({ ...rest, ...(archived ? { archived } : {}) });
      this.c.activity.system(actor.id, action, `${verb} ${t.item.type} "${t.item.title}"${archived?.reason ? `: ${archived.reason}` : ""}`, [t.item.id], {
        type: t.item.type,
      });
    } else {
      const { archived: _old, ...rest } = t.node;
      const node: KnowledgeNode = { ...rest, ...(archived ? { archived } : {}) };
      this.c.tree.write(node);
      this.c.index.upsertNode(node);
      this.c.activity.system(actor.id, action, `${verb} node "${t.node.path}"${archived?.reason ? `: ${archived.reason}` : ""}`, [t.node.path]);
    }
  }

  private requireHuman(actor: Actor, what: string): void {
    if (actor.kind !== "human") throw new CortexError("forbidden", `Only people can ${what}. Propose archiving instead.`, 403);
  }
}

function errorOf(e: unknown) {
  return e instanceof CortexError ? { code: e.code, message: e.message } : { code: "internal", message: String(e) };
}
