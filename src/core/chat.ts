import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Cortex } from "./cortex.js";
import type { ChatKind } from "./chatApprovals.js";
import type { Via } from "./provenance.js";
import { provenance } from "./provenance.js";
import type { Activity, Actor, Draft, Item, KnowledgeNode } from "./types.js";
import { CortexError } from "./types.js";
import { nowIso, ulid } from "../util/text.js";

// What a person decided in the AI chat, after the fact: applying an answer (the same code for an answer
// given through elicitation, a relayed one, and one confirmed on the board), the queue of relayed answers
// waiting for the person to confirm them, and undoing a chat answer from the board.
//
// Files, next to the drafts and versioned the same way:
//   chat/relayed/<id>.json  a relayed answer waiting for confirmation (chat.relayed: pending)
//   chat/undo/<entry>.json  what a chat-approved write replaced, so the board can put it back
//   chat/undone/<entry>.json  who undid that answer, and when

export interface ChatAnswer {
  kind: ChatKind;
  ids?: string[]; // drafts
  target_id?: string; // the item
  to?: string; // transition: the status to move to
  answer: string; // draft: approve | reject; decision: accept | reject; transition: yes | no; question: the answer itself
  note?: string; // reject reason, or a note kept on the card
}

export interface RelayedAnswer extends ChatAnswer {
  id: string;
  at: string;
  ai_actor: string;
  human: string; // who the AI says answered
  verbatim: string;
}

type Snapshot =
  { type: "node"; path: string; before: KnowledgeNode | null } | { type: "item"; id: string; before: Item | null } | { type: "draft"; draft: Draft };

const TEXT = {
  en: { accepted: "Accepted in the chat.", rejected: "Rejected in the chat.", undone: "Undone on the board: the answer given in the chat was taken back." },
  tr: {
    accepted: "Sohbette kabul edildi.",
    rejected: "Sohbette reddedildi.",
    undone: "Panoda geri alındı: sohbette verilen cevap geri çekildi.",
  },
};

const ID = /^[0-9A-Z]{26}$/;

export class ChatService {
  constructor(
    private c: Cortex,
    private dir: string,
  ) {}

  private text() {
    return this.c.language() === "tr" ? TEXT.tr : TEXT.en;
  }

  private file(sub: string, id: string): string {
    if (!ID.test(id)) throw new CortexError("not_found", `No record "${id}".`, 404);
    return join(this.dir, sub, `${id}.json`);
  }

  private write(sub: string, id: string, data: unknown): void {
    mkdirSync(join(this.dir, sub), { recursive: true });
    writeFileSync(this.file(sub, id), JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  private read<T>(sub: string, id: string): T | null {
    const f = this.file(sub, id);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : null;
  }

  // ---- applying an answer --------------------------------------------------------------------

  // Only the routes call this, after checking the person's role for `kind`. Runs as `human`, inside whatever
  // provenance the caller set, so every audit entry it writes says where the answer came from.
  apply(human: Actor, a: ChatAnswer): object {
    if (human.kind !== "human") throw new CortexError("forbidden", "Only a person's answer can be applied.", 403);
    const t = this.text();
    const note = a.note?.trim() || undefined;
    if (a.kind === "draft") {
      const ids = [...new Set(a.ids ?? (a.target_id ? [a.target_id] : []))];
      if (!ids.length) throw new CortexError("validation", "Give the draft ids.", 400);
      if (a.answer === "approve") return { approved: this.c.approveMany(human, ids) };
      if (a.answer === "reject") return { rejected: this.c.rejectMany(human, ids, note) };
      throw new CortexError("validation", 'A draft answer is "approve" or "reject".', 400);
    }
    const id = a.target_id ?? a.ids?.[0];
    if (!id) throw new CortexError("validation", "Give target_id: the item.", 400);
    const item = this.c.items.get(id).item;
    if (a.kind === "decision") {
      if (item.type !== "decision" || item.status !== "proposed") {
        throw new CortexError("not_pending", `${id} is not a proposed decision (it is a ${item.type} in "${item.status}").`, 409);
      }
      if (a.answer !== "accept" && a.answer !== "reject") throw new CortexError("validation", 'A decision answer is "accept" or "reject".', 400);
      const status = a.answer === "accept" ? "accepted" : "rejected";
      return this.c.items.reply(human, id, { body: note ?? (status === "accepted" ? t.accepted : t.rejected), status });
    }
    if (a.kind === "question") {
      if (item.type !== "question") throw new CortexError("not_pending", `${id} is not a question.`, 409);
      if (!a.answer.trim()) throw new CortexError("validation", "The answer is empty.", 400);
      return this.c.items.reply(human, id, { body: a.answer.trim() });
    }
    // transition
    if (!a.to) throw new CortexError("validation", 'Give `to`: the status to move it to (e.g. "done").', 400);
    if (a.answer !== "yes") return { changed: false };
    return this.c.items.reply(human, id, { body: note ?? `${item.status} → ${a.to}`, status: a.to });
  }

  // ---- relayed answers waiting for the person --------------------------------------------------

  queue(ai: Actor, input: Omit<RelayedAnswer, "id" | "at" | "ai_actor">): RelayedAnswer {
    if (!input.verbatim?.trim()) throw new CortexError("validation", "verbatim: the person's own words are required.", 400);
    const r: RelayedAnswer = { ...input, id: ulid(), at: nowIso(), ai_actor: ai.id };
    this.write("relayed", r.id, r);
    const ref = r.target_id && this.c.itemStore.exists(r.target_id) ? [r.target_id] : [];
    this.c.activity.system(ai.id, "chat.relayed", `Relayed ${r.human}'s answer from the chat, waiting for them to confirm: ${r.kind} = ${r.answer}`, ref);
    return r;
  }

  relayed(): RelayedAnswer[] {
    const d = join(this.dir, "relayed");
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => this.read<RelayedAnswer>("relayed", f.slice(0, -5)))
      .filter((r): r is RelayedAnswer => r !== null);
  }

  getRelayed(id: string): RelayedAnswer {
    const r = this.read<RelayedAnswer>("relayed", id);
    if (!r) throw new CortexError("not_found", `No relayed answer "${id}". It may have been confirmed or discarded already.`, 404);
    return r;
  }

  // The person confirms on the board what the AI said they said: applied as theirs, marked confirmed.
  confirm(human: Actor, id: string): object {
    const r = this.getRelayed(id);
    const via: Via = { channel: "chat-relayed", ai_actor: r.ai_actor, verbatim: r.verbatim, confirmed_by: human.id };
    const out = provenance.run(via, () => this.apply(human, r));
    unlinkSync(this.file("relayed", id));
    return { applied: true, result: out };
  }

  discard(actor: Actor, id: string, reason?: string): { discarded: true } {
    const r = this.getRelayed(id);
    if (actor.kind !== "human" && actor.id !== r.ai_actor) throw new CortexError("forbidden", "Only a person or the AI that relayed it can discard it.", 403);
    unlinkSync(this.file("relayed", id));
    const ref = r.target_id && this.c.itemStore.exists(r.target_id) ? [r.target_id] : [];
    this.c.activity.system(actor.id, "chat.discarded", `Discarded a relayed answer (${r.kind} = ${r.answer})${reason ? `: ${reason}` : ""}`, ref);
    return { discarded: true };
  }

  // ---- undo -------------------------------------------------------------------------------------

  // Called by the core right after a write made with a person's chat answer, keyed by its audit entry.
  remember(entry: Activity, s: Snapshot): void {
    if (entry.via) this.write("undo", entry.id, s);
  }

  // What the board shows on a chat entry: can it be taken back, and was it already.
  undoState(entry: Activity): { undoable: boolean; undone?: { by: string; at: string } } | null {
    if (!entry.via) return null;
    const undone = this.read<{ by: string; at: string }>("undone", entry.id);
    if (undone) return { undoable: false, undone };
    const statusChange = entry.action === "item.replied" && !!entry.meta?.from && !!entry.meta?.to && entry.meta.from !== entry.meta.to;
    return { undoable: statusChange || !!this.read<Snapshot>("undo", entry.id) };
  }

  undo(human: Actor, entryId: string): object {
    if (human.kind !== "human") throw new CortexError("forbidden", "Only people can undo an answer.", 403);
    const entry = this.c.index.getActivity(entryId);
    if (!entry?.via) throw new CortexError("not_found", `No answer from the chat with id "${entryId}".`, 404);
    const state = this.undoState(entry)!;
    if (state.undone) throw new CortexError("already_undone", `Already undone by ${state.undone.by}.`, 409, state.undone);
    const t = this.text();
    let result: object;
    const snap = this.read<Snapshot>("undo", entryId);
    if (entry.action === "item.replied" && entry.meta?.from && entry.meta.to && entry.meta.from !== entry.meta.to) {
      const id = entry.refs?.[0];
      if (!id) throw new CortexError("not_undoable", "This entry does not name its item.", 409);
      const item = this.c.items.get(id).item;
      if (item.status !== entry.meta.to) {
        throw new CortexError("changed_since", `The item moved on since (now "${item.status}"): change it on its card instead.`, 409);
      }
      result = this.c.items.reply(human, id, { body: t.undone, status: entry.meta.from, force: true });
    } else if (snap?.type === "node") {
      if (snap.before) {
        this.c.writeNode({ ...snap.before, updated_at: nowIso() });
        this.c.activity.system(human.id, "node.updated", `Restored node "${snap.path || "(root)"}" to before the chat answer`, [snap.path]);
        result = { restored: snap.path };
      } else {
        result = this.c.deleteNode(human, snap.path, "undone: approved in the chat");
      }
    } else if (snap?.type === "item" && snap.before) {
      this.c.items.applyDraft({ ...snap.before, updated_at: nowIso() });
      this.c.activity.system(human.id, "item.restored", `Restored ${snap.before.type} "${snap.before.title}" to before the chat answer`, [snap.id]);
      result = { restored: snap.id };
    } else if (snap?.type === "draft") {
      // A rejected draft comes back as it was, waiting for review again.
      this.c.drafts.save(snap.draft);
      this.c.index.upsertDraft(snap.draft);
      this.c.activity.system(
        human.id,
        "draft.restored",
        `Brought back ${snap.draft.proposed_by}'s draft for ${snap.draft.kind} "${snap.draft.target || "(root)"}"`,
        [],
      );
      result = { draft_restored: snap.draft.id };
    } else {
      throw new CortexError("not_undoable", "This answer cannot be undone from here: change the record on its card.", 409);
    }
    this.write("undone", entryId, { by: human.id, at: nowIso() });
    return { undone: true, entry: entryId, ...result };
  }
}
