import type { Cortex } from "./cortex.js";
import type { SqlFilter } from "../index/db.js";
import type { Actor, Item, Reply } from "./types.js";
import { CortexError } from "./types.js";
import { shorten } from "../util/text.js";

// Discussions are items of type "discussion"; each view is a reply. What makes them more than a thread
// lives here: the blind first round, the vote count, and turning the count into a decision.
//
// Phases (item status): open = blind round, views are sealed from each other; deliberating = views are
// visible and participants answer each other; voted = the count produced a proposed decision (or a tie a
// person breaks); decided = a person accepted the decision. A participant's latest stance is their vote.

export const DISCUSSION = "discussion";
const VOTING_KINDS = new Set(["opinion", "rebuttal"]);
const TALKING = new Set(["open", "deliberating"]);

type Fields = Record<string, unknown>;
const options = (i: Item) => (Array.isArray(i.fields.options) ? (i.fields.options as string[]) : []);
const participants = (i: Item) => (Array.isArray(i.fields.participants) ? (i.fields.participants as string[]) : []);
const kindOf = (r: Reply) => (typeof r.fields?.kind === "string" ? r.fields.kind : "comment");

// While the blind round runs, views stay out of search and list previews for everyone.
export function isSealed(i: Pick<Item, "type" | "status" | "fields">): boolean {
  return i.type === DISCUSSION && i.status === "open" && i.fields?.blind !== false;
}

function hasPosted(actorId: string, replies: Reply[]): boolean {
  return replies.some((r) => r.author === actorId && kindOf(r) === "opinion");
}

// Who may read every view during the blind round: the one who opened the discussion, anyone who already
// posted a view, and a person watching from outside an explicit participant list.
export function seesAllViews(actor: Actor, item: Item, replies: Reply[]): boolean {
  if (!isSealed(item)) return true;
  if (actor.id === item.author || hasPosted(actor.id, replies)) return true;
  const list = participants(item);
  return actor.kind === "human" && list.length > 0 && !list.includes(actor.id);
}

// The replies a reader gets: their own in full, the others' as "someone posted" markers until they post.
export function viewReplies(actor: Actor, item: Item, replies: Reply[]): Reply[] {
  if (seesAllViews(actor, item, replies)) return replies;
  return replies.map((r) => (r.author === actor.id ? r : { id: r.id, item_id: r.item_id, author: r.author, created_at: r.created_at, sealed: true, body: "" }));
}

export interface Tally {
  votes: { option: string; voters: string[] }[];
  leader: string | null; // null on no votes or a tie
  tie: boolean;
}

export function tally(item: Item, replies: Reply[]): Tally {
  const latest = new Map<string, string>();
  for (const r of replies) {
    const stance = r.fields?.stance;
    if (VOTING_KINDS.has(kindOf(r)) && typeof stance === "string" && options(item).includes(stance)) latest.set(r.author, stance);
  }
  const votes = options(item).map((option) => ({ option, voters: [...latest].filter(([, s]) => s === option).map(([a]) => a) }));
  const top = Math.max(0, ...votes.map((v) => v.voters.length));
  const leaders = votes.filter((v) => v.voters.length === top && top > 0);
  return { votes, leader: leaders.length === 1 ? leaders[0]!.option : null, tie: leaders.length > 1 };
}

// Invited participants who have not posted a view yet. With no list, nobody in particular is waited on.
export function waitingOn(item: Item, replies: Reply[]): string[] {
  if (!TALKING.has(item.status)) return [];
  return participants(item).filter((p) => !hasPosted(p, replies));
}

// Whether this actor is asked for a view here: invited (or anyone, with no list) and not posted yet.
function asks(actor: Actor, item: Item, replies: Reply[]): boolean {
  if (!TALKING.has(item.status) || hasPosted(actor.id, replies)) return false;
  const list = participants(item);
  return list.length ? list.includes(actor.id) : actor.id !== item.author;
}

export function checkFields(fields: Fields): string[] {
  const opts = Array.isArray(fields.options) ? fields.options : [];
  const issues: string[] = [];
  if (opts.length < 2) issues.push("options: give at least two answers to choose between");
  if (opts.some((o) => typeof o !== "string" || !o.trim())) issues.push("options: every option needs text");
  if (new Set(opts.map((o) => String(o).trim().toLowerCase())).size !== opts.length) issues.push("options: each option must be different");
  return issues;
}

// Phase rules for a new reply, on top of the schema's field rules.
export function checkReply(actor: Actor, item: Item, fields: Fields): void {
  const kind = fields.kind;
  const stance = fields.stance;
  const fail = (message: string, hint?: unknown) => {
    throw new CortexError("invalid_reply", message, 400, hint);
  };
  if (stance !== undefined && !options(item).includes(stance as string)) {
    fail(`stance must be one of this discussion's options, exactly as written.`, { options: options(item) });
  }
  if (kind === "comment") return;
  if (!TALKING.has(item.status)) fail(`Voting is over here (status "${item.status}"). Only comments are accepted now.`);
  const list = participants(item);
  if ((kind === "opinion" || kind === "rebuttal") && list.length && !list.includes(actor.id) && actor.id !== item.author) {
    fail("Only invited participants post views here. Leave a comment instead.", { participants: list });
  }
  if ((kind === "rebuttal" || kind === "synthesis") && item.status === "open") {
    fail(`A ${String(kind)} answers the others' views, which open up in the deliberating phase. Post an opinion now.`);
  }
}

export interface DiscussionRow {
  id: string;
  title: string;
  status: string;
  author: string;
  category_path?: string;
  options: string[];
  participants: string[];
  blind: boolean;
  deadline?: string;
  outcome?: string;
  posted: string[]; // who has posted a view (never what it says)
  waiting_on: string[];
  asks_you: boolean;
  replies: number;
  tally?: Tally; // left out while the reader may not see the views
  created_at: string;
  updated_at: string;
}

export class DiscussionService {
  constructor(private c: Cortex) {}

  private load(id: string): { item: Item; replies: Reply[] } {
    const item = this.c.itemStore.read(id);
    if (!item || item.type !== DISCUSSION) throw new CortexError("not_found", `No discussion with id "${id}".`, 404);
    return { item, replies: this.c.itemStore.replies(id) };
  }

  // What the reader may know about the discussion as a whole; attached to GET /items/:id.
  summary(actor: Actor, item: Item, replies: Reply[]) {
    const all = seesAllViews(actor, item, replies);
    return {
      blind_round: isSealed(item),
      sees_all: all,
      posted: [...new Set(replies.filter((r) => kindOf(r) === "opinion").map((r) => r.author))],
      waiting_on: waitingOn(item, replies),
      asks_you: asks(actor, item, replies),
      ...(all ? { tally: tally(item, replies) } : {}),
    };
  }

  private row(actor: Actor, item: Item, replies: Reply[]): DiscussionRow {
    const s = this.summary(actor, item, replies);
    return {
      id: item.id,
      title: item.title,
      status: item.status,
      author: item.author,
      ...(item.category_path ? { category_path: item.category_path } : {}),
      options: options(item),
      participants: participants(item),
      blind: item.fields.blind !== false,
      ...(typeof item.fields.deadline === "string" ? { deadline: item.fields.deadline } : {}),
      ...(typeof item.fields.outcome === "string" ? { outcome: item.fields.outcome } : {}),
      posted: s.posted,
      waiting_on: s.waiting_on,
      asks_you: s.asks_you,
      replies: replies.length,
      ...(s.tally ? { tally: s.tally } : {}),
      created_at: item.created_at,
      updated_at: item.updated_at,
    };
  }

  list(actor: Actor, q: { open?: boolean; visible?: SqlFilter | null } = {}) {
    const { items } = this.c.index.queryItems({ type: DISCUSSION, open: q.open, visible: q.visible ?? null, limit: 500, offset: 0 });
    const rows = items.flatMap((i) => {
      const item = this.c.itemStore.read(i.id);
      return item ? [this.row(actor, item, this.c.itemStore.replies(i.id))] : [];
    });
    return { discussions: rows, asks_you: rows.filter((r) => r.asks_you).length };
  }

  // Open discussions that wait on this actor's view: for the inbox and the sidebar badge.
  askingFor(actor: Actor, visible: SqlFilter | null = null): string[] {
    const { items } = this.c.index.queryItems({ type: DISCUSSION, open: true, visible, limit: 500, offset: 0 });
    return items
      .filter((i) => {
        const item = this.c.itemStore.read(i.id);
        return item ? asks(actor, item, this.c.itemStore.replies(i.id)) : false;
      })
      .map((i) => i.id);
  }

  // Counts the votes. A clear majority becomes a proposed decision a person accepts; a tie waits for a person.
  closeVote(actor: Actor, id: string) {
    const { item, replies } = this.load(id);
    if (!TALKING.has(item.status))
      throw new CortexError("invalid_status", `This discussion is "${item.status}"; only an open or deliberating one can be counted.`, 400);
    const t = tally(item, replies);
    if (!t.leader) {
      this.c.items.update(actor, id, { status: "voted" }, { internal: true });
      return { applied: true, id, status: "voted", tally: t, message: t.tie ? "Tied: a person picks the outcome." : "No votes: a person picks the outcome." };
    }
    const d = this.createDecision(actor, item, replies, t.leader, t);
    this.c.items.update(actor, id, { status: "voted", ...(d.applied ? { fields: { outcome: d.id } } : {}) }, { internal: true });
    return {
      applied: true,
      id,
      status: "voted",
      tally: t,
      decision: d,
      message: `Majority: "${t.leader}". A person accepts or overrides the proposed decision.`,
    };
  }

  // A person settles it: the chosen option becomes an accepted decision. A proposed one it replaces is rejected.
  decide(actor: Actor, id: string, option: string) {
    if (actor.kind !== "human") throw new CortexError("forbidden", "Only people decide a discussion. Post your view or a synthesis instead.", 403);
    const { item, replies } = this.load(id);
    if (item.status === "decided" || item.status === "cancelled") throw new CortexError("invalid_status", `This discussion is already ${item.status}.`, 400);
    if (!options(item).includes(option)) throw new CortexError("invalid_request", "Pick one of the discussion's options.", 400, { options: options(item) });

    const previous = typeof item.fields.outcome === "string" ? this.c.itemStore.read(item.fields.outcome) : null;
    if (previous?.status === "proposed") {
      // Picking the option the majority already proposed accepts that proposal; a second, identical decision
      // next to a rejected first one only clutters the record. The option is the first line of its body.
      if (previous.body.split("\n")[0]?.trim() === option) {
        this.c.items.update(actor, previous.id, { status: "accepted" });
        return {
          applied: true,
          id,
          status: "decided",
          decision: { applied: true, id: previous.id, status: "accepted", message: "decision accepted." },
          message: `Decided: "${option}".`,
        };
      }
      this.c.items.update(actor, previous.id, { status: "rejected", reason: `Overridden in discussion ${id}` });
    }

    const d = this.createDecision(actor, item, replies, option, tally(item, replies));
    this.c.items.update(actor, id, { status: "voted", fields: { outcome: d.id } }, { internal: true });
    // Accepting it moves the discussion to "decided" (see onDecisionAccepted), the same path as accepting from the decision itself.
    this.c.items.update(actor, d.id, { status: "accepted" });
    return { applied: true, id, status: "decided", decision: d, message: `Decided: "${option}".` };
  }

  // Called by the item service when a decision is accepted: the discussion it came from is settled too.
  onDecisionAccepted(actor: Actor, decision: Item): void {
    for (const ref of decision.links?.items ?? []) {
      const d = this.c.itemStore.read(ref);
      if (d?.type === DISCUSSION && d.fields.outcome === decision.id && d.status !== "decided") {
        this.c.items.update(actor, d.id, { status: "decided" }, { internal: true });
      }
    }
  }

  private createDecision(actor: Actor, item: Item, replies: Reply[], option: string, t: Tally) {
    const latestView = new Map<string, Reply>();
    for (const r of replies) if (VOTING_KINDS.has(kindOf(r))) latestView.set(r.author, r);
    const count = (o: string) => t.votes.find((v) => v.option === o)?.voters ?? [];
    const others = options(item).filter((o) => o !== option);
    const views = [...latestView.values()].map((r) => {
      const ev = Array.isArray(r.fields?.evidence) ? (r.fields.evidence as string[]).slice(0, 5).join(", ") : "";
      const conf = typeof r.fields?.confidence === "string" ? `, ${r.fields.confidence}` : "";
      return `- ${r.author} (${String(r.fields?.stance ?? "?")}${conf}): ${shorten(r.body.replace(/\s+/g, " ").trim(), 300)}${ev ? ` [${ev}]` : ""}`;
    });
    const alternatives = [
      ...others.map((o) => `- ${o}: ${count(o).length} vote(s)${count(o).length ? ` (${count(o).join(", ")})` : ""}`),
      ...(views.length ? ["", "Views:", ...views] : []),
    ].join("\n");
    return this.c.items.create(actor, {
      type: "decision",
      title: shorten(`${item.title} → ${option}`, 160),
      body: `${option}\n\nVotes: ${count(option).length} of ${latestView.size}${count(option).length ? ` (${count(option).join(", ")})` : ""}.`,
      ...(item.category_path ? { category_path: item.category_path } : {}),
      links: { items: [item.id] },
      fields: { context: `${item.title}${item.body.trim() ? `\n\n${item.body.trim()}` : ""}`, ...(alternatives ? { alternatives } : {}) },
      reason: `Outcome of discussion ${item.id}`,
    });
  }
}
