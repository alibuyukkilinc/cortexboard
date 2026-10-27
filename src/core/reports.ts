import type { Cortex } from "./cortex.js";
import type { Activity, ActorKind } from "./types.js";
import { CortexError } from "./types.js";
import { actionable } from "./staleness.js";
import { addDays, dayKey, startOfDay } from "../util/time.js";
import { isPlaceholder } from "./init.js";

// Reports answer "what happened, what is waiting, can we trust it" from the files and the activity log.
// No LLM involved: every number is counted, so it costs nothing and is the same every time.

const DAY = 86_400_000;
const AGING_BUCKETS: [string, number, number][] = [
  ["0-3d", 0, 3],
  ["3-7d", 3, 7],
  ["7-30d", 7, 30],
  ["30d+", 30, Infinity],
];
const LIST = 10;
const EPICS = 30;

export interface Period {
  since: string;
  until: string;
  days: number;
  timezone: string; // days are counted in this zone (cortex.config.yaml "timezone", default UTC)
}

// "7d", "2w", "2026-09-01" or a full ISO datetime; until defaults to now.
export function parsePeriod(since?: string, until?: string, now = Date.now(), tz = "UTC"): Period {
  // Open-ended means "up to and including now": the bound is exclusive, and an entry written in the same
  // millisecond as the report (fast machines do this) must not fall out of it.
  const end = until ? parseInstant(until, "until", tz) : now + 1;
  let start: number;
  const rel = /^(\d{1,3})\s*([dw])$/i.exec(since ?? "7d");
  // Calendar-aligned: "7d" is today plus the six days before it (in the project's zone), so the chart shows 7 columns.
  if (rel) start = startOfDay(addDays(dayKey(end, tz), -(Number(rel[1]) * (rel[2].toLowerCase() === "w" ? 7 : 1) - 1)), tz);
  else start = parseInstant(since!, "since", tz);
  if (!(start < end)) throw new CortexError("invalid_period", "since must be before until.", 400);
  if (end - start > 366 * DAY) throw new CortexError("invalid_period", "A report covers at most 366 days.", 400);
  return { since: new Date(start).toISOString(), until: new Date(end).toISOString(), days: Math.ceil((end - start) / DAY), timezone: tz };
}

// A bare date means the start of that day in the project's zone.
function parseInstant(v: string, name: string, tz: string): number {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(v) ? startOfDay(v, tz) : Date.parse(v);
  if (isNaN(t)) throw new CortexError("invalid_period", `${name} must be like 7d, 2w, 2026-09-01 or an ISO datetime.`, 400);
  return t;
}

// Older audit entries have no structured meta; their summaries end with "(from → to)".
function transition(a: Activity): { from?: string; to?: string } {
  if (a.meta?.to !== undefined || a.meta?.from !== undefined) return { from: a.meta.from, to: a.meta.to };
  const m = /\((\S+) → (\S+)\)/.exec(a.summary);
  return m ? { from: m[1], to: m[2] } : {};
}

function proposer(a: Activity): string | undefined {
  return a.meta?.proposed_by ?? /(?:Approved|Rejected) (\S+?)'s/.exec(a.summary)?.[1];
}

const hours = (from: string, to: string) => Math.round(((Date.parse(to) - Date.parse(from)) / 3_600_000) * 10) / 10;
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
};
const inPeriod = (iso: string, p: Period) => iso >= p.since && iso < p.until;
type Kind = ActorKind | "unknown";

export class ReportService {
  constructor(private c: Cortex) {}

  build(opts: { since?: string; until?: string } = {}) {
    const tz = this.c.project.config.timezone ?? "UTC";
    const p = parsePeriod(opts.since, opts.until, Date.now(), tz);
    const now = new Date().toISOString();
    const events = this.c.index.activityBetween(p.since, p.until);
    // What each actor is: as the entry recorded it, else as the config says now. An actor neither knows (an
    // old entry of a removed member, another client's AI) is "unknown", never silently a person.
    const recorded = new Map<string, ActorKind>();
    for (const e of events) if (e.actor_kind) recorded.set(e.actor, e.actor_kind);
    const kindOfId = (id: string): Kind => recorded.get(id) ?? this.c.project.config.actors.find((a) => a.id === id)?.kind ?? "unknown";
    const kindOf = (e: Activity): Kind => e.actor_kind ?? kindOfId(e.actor);
    // From the index, not the files: reading every item and its replies took seconds on a big project.
    const items = this.c.index.reportItems();
    const byId = new Map(items.map((i) => [i.id, i]));
    const terminals = new Map<string, boolean>();
    const terminal = (type: string, status: string) => {
      const key = `${type} ${status}`;
      if (!terminals.has(key)) terminals.set(key, this.c.itemFlags(type, status).terminal);
      return terminals.get(key)!;
    };

    // ---- daily volume, by who did it --------------------------------------------
    // ai/human count logged entries (what + why) only. Cortex's own audit trail is a separate series:
    // one AI turn can write a dozen audit entries, so mixing them in would measure writes, not work.
    // Day boundaries are worked out once; each entry then finds its day by binary search. Asking Intl for
    // every entry's day cost more than the rest of the report on a busy log.
    const daily: { date: string; ai: number; human: number; unknown: number; system: number }[] = [];
    const starts: number[] = [];
    for (let d = dayKey(Date.parse(p.since), tz), s = startOfDay(d, tz); s < Date.parse(p.until); d = addDays(d, 1), s = startOfDay(d, tz)) {
      daily.push({ date: d, ai: 0, human: 0, unknown: 0, system: 0 });
      starts.push(s);
    }
    for (const e of events) {
      const t = Date.parse(e.at);
      let lo = 0;
      let hi = starts.length - 1;
      if (hi < 0 || t < starts[0]) continue;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= t) lo = mid;
        else hi = mid - 1;
      }
      daily[lo][e.system ? "system" : kindOf(e)]++;
    }

    // ---- per actor ---------------------------------------------------------------------
    type ActorRow = {
      id: string;
      kind: Kind;
      logged: number; // entries the actor wrote itself (what + why)
      writes: number; // everything else it did: items, replies, node edits
      drafts: { proposed: number; approved: number; rejected: number };
    };
    const actors = new Map<string, ActorRow>();
    const row = (id: string) => {
      if (!actors.has(id)) actors.set(id, { id, kind: kindOfId(id), logged: 0, writes: 0, drafts: { proposed: 0, approved: 0, rejected: 0 } });
      return actors.get(id)!;
    };

    // ---- transitions -----------------------------------------------------------------
    const created: Record<string, number> = {};
    const closed: Record<string, number> = {};
    const decisions = { proposed: 0, accepted: 0, rejected: 0 };
    const decisionList: { id: string; title: string; status: string; at: string; by: string }[] = [];
    const closedIssues: { id: string; title: string; days_open: number; resolution?: string; by: string }[] = [];
    const approvals = { proposed: 0, approved: 0, rejected: 0 };
    let nodesUpdated = 0;
    const closedInPeriod = new Set<string>();

    for (const e of events) {
      if (!e.system) {
        row(e.actor).logged++;
        continue;
      }
      if (e.action !== "draft.approved" && e.action !== "draft.rejected") row(e.actor).writes++;
      const item = e.refs?.[0] ? byId.get(e.refs[0]) : undefined;
      const type = e.meta?.type ?? item?.type;
      const { to } = transition(e);
      switch (e.action) {
        case "item.created":
          if (type) created[type] = (created[type] ?? 0) + 1;
          if (type === "decision") decisions.proposed++;
          break;
        case "item.updated":
        case "item.replied":
          if (!type || !to) break;
          if (terminal(type, to)) {
            closed[type] = (closed[type] ?? 0) + 1;
            if (item) closedInPeriod.add(item.id);
            if (type === "issue" && item) {
              const resolution = item.resolution ?? undefined;
              closedIssues.push({
                id: item.id,
                title: item.title,
                days_open: Math.round(((Date.parse(e.at) - Date.parse(item.created_at)) / DAY) * 10) / 10,
                by: e.actor,
                ...(resolution ? { resolution } : {}),
              });
            }
          }
          if (type === "decision" && (to === "accepted" || to === "rejected") && item) {
            decisions[to]++;
            decisionList.push({ id: item.id, title: item.title, status: to, at: e.at, by: e.actor });
          }
          break;
        case "node.updated":
          nodesUpdated++;
          break;
        case "draft.proposed":
          approvals.proposed++;
          row(e.actor).drafts.proposed++;
          break;
        case "draft.approved":
        case "draft.rejected": {
          const verdict = e.action === "draft.approved" ? "approved" : "rejected";
          approvals[verdict]++;
          const who = proposer(e);
          if (who) row(who).drafts[verdict]++;
          if (verdict === "approved" && e.meta?.kind !== "item") nodesUpdated++;
          break;
        }
      }
    }

    // ---- questions: asked in period, answered in period, how fast ------------------
    const answerHours: number[] = [];
    const answered: { id: string; title: string; asked_by: string; answered_by: string; hours: number }[] = [];
    let asked = 0;
    for (const q of items.filter((i) => i.type === "question")) {
      if (inPeriod(q.created_at, p)) asked++;
      if (q.answered_at && q.answered_by && inPeriod(q.answered_at, p)) {
        const h = hours(q.created_at, q.answered_at);
        answerHours.push(h);
        answered.push({ id: q.id, title: q.title, asked_by: q.author, answered_by: q.answered_by, hours: h });
      }
    }

    // ---- what is waiting right now ----------------------------------------------------
    const openIssues = items.filter((i) => i.type === "issue" && i.open);
    const aging = AGING_BUCKETS.map(([bucket, lo, hi]) => {
      const inBucket = openIssues.filter((i) => {
        const age = (Date.now() - Date.parse(i.created_at)) / DAY;
        return age >= lo && age < hi;
      });
      const bySeverity: Record<string, number> = {};
      for (const i of inBucket) {
        const sev = i.severity ?? "unknown";
        bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
      }
      return { bucket, count: inBucket.length, by_severity: bySeverity };
    });
    const ageDays = (iso: string) => Math.round(((Date.now() - Date.parse(iso)) / DAY) * 10) / 10;
    const blocking = items
      .filter((i) => i.type === "question" && i.status === "open" && i.blocking)
      .map((i) => ({ id: i.id, title: i.title, asked_by: i.author, assignee: i.assignee ?? undefined, age_days: ageDays(i.created_at) }))
      .sort((a, b) => b.age_days - a.age_days);
    const pending = this.c.drafts
      .list()
      .map((d) => ({ draft_id: d.id, kind: d.kind, target: d.target, title: d.data.title, proposed_by: d.proposed_by, age_days: ageDays(d.proposed_at) }))
      .sort((a, b) => b.age_days - a.age_days);

    // ---- knowledge health ------------------------------------------------------------
    const nodes = this.c.index.nodeSummaries();
    const linked = new Set(this.c.index.nodeCodeLinks().map((l) => l.path));
    const allStale = this.c.staleness.list();
    const stale = allStale.filter(actionable); // formatting-only and snoozed ones are reported apart, as information
    const undocumented = nodes.filter((n) => isPlaceholder(n.summary)).map((n) => n.path || "(root)");

    // ---- highlights -------------------------------------------------------------------
    const aiChanges = events
      .filter((e) => !e.system && kindOf(e) === "ai")
      .reverse()
      .slice(0, LIST)
      .map((e) => ({
        id: e.id,
        at: e.at,
        actor: e.actor,
        action: e.action,
        summary: e.summary,
        ...(e.why ? { why: e.why } : {}),
        ...(e.files?.length ? { files: e.files } : {}),
      }));
    const aiWithoutWhy = events.filter((e) => !e.system && kindOf(e) === "ai" && !e.why).length;

    // ---- epics and milestones -----------------------------------------------------------
    // An epic is an item whose body carries task boxes (the board's progress bar). The report lists the open
    // ones and those that moved in the period, busiest first: "which epic is where" on the same screen as the week.
    const touched = new Map<string, number>();
    for (const e of events) for (const ref of e.refs ?? []) if (byId.has(ref)) touched.set(ref, (touched.get(ref) ?? 0) + 1);
    const live = items.filter((i) => !i.archived);
    const epics = live
      .filter((i) => i.checklist.total > 0 && (i.open || touched.has(i.id)))
      .map((i) => ({
        id: i.id,
        type: i.type,
        title: i.title,
        status: i.status,
        open: i.open,
        done: i.checklist.done,
        total: i.checklist.total,
        milestone: i.milestone,
        assignee: i.assignee,
        updated_at: i.updated_at,
        activity: touched.get(i.id) ?? 0, // entries about it in the period
      }))
      .sort((a, b) => Number(b.open) - Number(a.open) || b.activity - a.activity || b.updated_at.localeCompare(a.updated_at));

    // A milestone spans from its first item to the latest due date among them (its target); without due dates
    // it has no target and the timeline draws it up to its last change. Finished ones drop out once quiet.
    const today = dayKey(Date.now(), tz);
    const byMilestone = new Map<string, typeof live>();
    for (const i of live) if (i.milestone) byMilestone.set(i.milestone, [...(byMilestone.get(i.milestone) ?? []), i]);
    const milestones = [...byMilestone.entries()]
      .map(([name, list]) => {
        const done = list.filter((i) => !i.open).length;
        const dues = list.flatMap((i) => (i.due ? [i.due] : [])).sort();
        const target = dues.at(-1) ?? null;
        const lastActivity = list.reduce((m, i) => (i.updated_at > m ? i.updated_at : m), "");
        return {
          name,
          total: list.length,
          done,
          open: list.length - done,
          epics: list.filter((i) => i.checklist.total > 0).length,
          closed_in_period: list.filter((i) => closedInPeriod.has(i.id)).length,
          start: dayKey(Date.parse(list.reduce((m, i) => (i.created_at < m ? i.created_at : m), list[0].created_at)), tz),
          target,
          last_activity: lastActivity,
          overdue: !!target && target < today && done < list.length,
        };
      })
      .filter((m) => m.open > 0 || m.last_activity >= p.since)
      .sort((a, b) => (a.target ?? "9999").localeCompare(b.target ?? "9999") || a.name.localeCompare(b.name));

    const actorRows = [...actors.values()]
      .map((a) => {
        const decided = a.drafts.approved + a.drafts.rejected;
        return { ...a, approval_rate: decided ? Math.round((a.drafts.approved / decided) * 100) / 100 : null };
      })
      .sort((a, b) => b.logged + b.writes - (a.logged + a.writes));

    const sum = (xs: Record<string, number>) => Object.values(xs).reduce((s, x) => s + x, 0);
    const split = (es: Activity[]) => ({
      total: es.length,
      ai: es.filter((e) => kindOf(e) === "ai").length,
      human: es.filter((e) => kindOf(e) === "human").length,
      unknown: es.filter((e) => kindOf(e) === "unknown").length,
    });
    return {
      period: p,
      generated_at: now,
      totals: {
        // logged: entries someone wrote to say what they did and why. system: the audit trail of writes.
        activity: { logged: split(events.filter((e) => !e.system)), system: split(events.filter((e) => e.system)) },
        ai_logged_changes: events.filter((e) => !e.system && kindOf(e) === "ai").length,
        ai_changes_without_why: aiWithoutWhy,
        items_created: { total: sum(created), by_type: created },
        items_closed: { total: sum(closed), by_type: closed },
        questions: { asked, answered: answered.length, median_answer_hours: median(answerHours), open_blocking: blocking.length },
        decisions,
        approvals: { ...approvals, pending: pending.length, oldest_pending_days: pending[0]?.age_days ?? null },
      },
      daily,
      actors: actorRows,
      epics: epics.slice(0, EPICS),
      epics_total: epics.length,
      milestones,
      today,
      highlights: {
        ai_changes: aiChanges,
        decisions: decisionList.slice(-LIST).reverse(),
        closed_issues: closedIssues.slice(-LIST).reverse(),
        answered_questions: answered.sort((a, b) => b.hours - a.hours).slice(0, LIST),
      },
      attention: {
        open_issues: openIssues.length,
        issue_aging: aging,
        blocking_questions: blocking.slice(0, LIST),
        pending_approvals: pending.slice(0, LIST),
        stale_nodes: stale.slice(0, LIST).map((s) => ({ path: s.path, severity: s.severity, files: s.changes.map((c) => c.file) })),
        undocumented: undocumented.slice(0, LIST),
      },
      // Work checked against the accepted decisions governing its files: only the exceptions are listed.
      rule_checks: (() => {
        const rc = this.c.ruleChecks.report({ since: p.since, until: p.until });
        return { counts: rc.counts, broken: rc.broken.slice(0, LIST), unanswered: rc.unanswered.slice(0, LIST) };
      })(),
      knowledge: {
        nodes: nodes.length,
        with_code_links: linked.size,
        stale: stale.length,
        stale_info: allStale.length - stale.length,
        stale_ratio: linked.size ? Math.round((stale.length / linked.size) * 100) / 100 : 0,
        undocumented: undocumented.length,
        updated_in_period: nodesUpdated,
        git: this.c.staleness.enabled(),
      },
    };
  }
}

export type Report = ReturnType<ReportService["build"]>;
