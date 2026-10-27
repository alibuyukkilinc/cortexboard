import { z } from "zod";
import type { Cortex } from "./cortex.js";
import { nowIso, ulid } from "../util/text.js";
import type { Activity, Actor } from "./types.js";
import { CortexError } from "./types.js";
import { currentVia } from "./provenance.js";
import { parsePeriod } from "./reports.js";

// "Was a rule skipped?" (decision 01M3MXD9VVDQJSDEFX60PQTAWH). When an AI logs work with the files it changed,
// Cortex works out which accepted decisions govern those files and the AI says, for each, whether it followed
// it. People look only at the exceptions: decisions it broke and decisions it never answered. Nothing is
// refused for a missing answer (a refused log is a lost log); it is flagged instead.
//
// Which decisions govern a file: those linked to it in code, and those filed under a knowledge node that links
// it, under that node's branch or above it (a "frontend" decision covers a file of "frontend/pages"). Decisions
// filed at the project root cover everything and would be asked about on every change, so they are left out.
// Only the most specific few are asked about (maxAsked); the rest are listed as "also" for the AI to glance at.

export const VERDICTS = ["followed", "broken", "n/a"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const RuleAnswer = z.object({
  id: z.string().min(1),
  verdict: z.enum(VERDICTS),
  note: z.string().max(500).optional(),
});
export type RuleAnswer = z.infer<typeof RuleAnswer>;
export const RuleAnswers = z.array(RuleAnswer).max(50);

// Stored on the activity entry that logged the work, and on each later answer (action rules.checked).
export interface RuleCheck {
  applies: string[]; // decision ids that govern the files, as worked out when the work was logged
  answers: RuleAnswer[];
}

export const ANSWER_ACTION = "rules.checked";

type Visible = { sql: string; args: (string | number)[] } | null;
interface DecisionRef {
  id: string;
  title: string;
  category_path?: string | null;
  via: string;
}

export interface CheckState {
  applies: DecisionRef[];
  followed: DecisionRef[];
  not_applicable: DecisionRef[];
  broken: (DecisionRef & { note?: string })[];
  unanswered: DecisionRef[];
}

export class RuleCheckService {
  constructor(private c: Cortex) {}

  // The accepted decisions that govern these files, most specific first: linked to the file in code, then filed
  // on the knowledge node that links it, then under that node, then on the branches above it (nearest first).
  applicable(files: string[], visible: Visible = null): DecisionRef[] {
    if (!files.length) return [];
    const ctx = this.c.codeContext(files);
    const linked = ctx.knowledge.map((k) => k.path as string);
    const ranked = new Map<string, DecisionRef & { rank: number }>();
    const put = (d: { id: string; title: string; category_path: string | null }, via: string, rank: number) => {
      const cur = ranked.get(d.id);
      if (!cur || rank < cur.rank) ranked.set(d.id, { id: d.id, title: d.title, category_path: d.category_path, via, rank });
    };
    for (const i of ctx.items) {
      if (i.type === "decision" && i.status === "accepted" && i.via === "code link") {
        const d = this.c.index.getItem(i.id as string);
        if (d) put(d, "code link", 0);
      }
    }
    // Every accepted decision this caller may see (a hub member with a narrow view is not asked about the rest).
    const all = this.c.index.queryItems({ type: "decision", status: "accepted", limit: 1000, offset: 0, ...(visible ? { visible } : {}) }).items;
    for (const d of all) {
      const cp = d.category_path ?? "";
      if (!cp) continue;
      for (const p of linked) {
        if (cp === p) put(d, p, 1);
        else if (p !== "" && cp.startsWith(`${p}/`)) put(d, p, 2);
        else if (p.startsWith(`${cp}/`)) put(d, p, 3 + (p.split("/").length - cp.split("/").length)); // nearer ancestors first
      }
    }
    const seen = new Set(all.map((d) => d.id));
    return [...ranked.values()]
      .filter((d) => seen.has(d.id))
      .sort((a, b) => a.rank - b.rank || (b.category_path ?? "").split("/").length - (a.category_path ?? "").split("/").length)
      .map(({ rank: _rank, ...d }) => d);
  }

  // How many of them an AI is asked about for one change (config decision_checks.max_asked, default 5). Broad
  // branches can carry many decisions: asking about all of them on every change is the noise staleness alerts
  // turned into (15 a change on this project before the cap). The rest are listed to look at, not to answer.
  maxAsked(): number {
    const v = this.c.project.config.decision_checks?.max_asked;
    return typeof v === "number" && v >= 1 ? Math.floor(v) : 5;
  }

  select(files: string[], visible: Visible = null): { asked: DecisionRef[]; also: DecisionRef[] } {
    const all = this.applicable(files, visible);
    const n = this.maxAsked();
    return { asked: all.slice(0, n), also: all.slice(n) };
  }

  // Checks the answers an actor gives: known decisions, a reason for every broken one.
  validate(answers: RuleAnswer[]): string[] {
    const issues: string[] = [];
    answers.forEach((a, n) => {
      const d = this.c.index.getItem(a.id);
      if (!d || d.type !== "decision") issues.push(`decisions[${n}].id: "${a.id}" is not a decision`);
      if (a.verdict === "broken" && !a.note?.trim()) issues.push(`decisions[${n}].note: say why "${a.id}" was not followed`);
    });
    return issues;
  }

  // Everything answered for one logged entry, later answers winning.
  state(entry: Activity): CheckState | null {
    const rc = entry.rule_check;
    if (!rc) return null;
    const answers = new Map<string, RuleAnswer>();
    for (const a of rc.answers) answers.set(a.id, a);
    const later = this.c.index
      .queryActivity({ ref: entry.id, includeSystem: true, limit: 200 })
      .filter((e) => e.action === ANSWER_ACTION && e.rule_check)
      .reverse(); // oldest first, so the newest answer is applied last
    for (const e of later) for (const a of e.rule_check!.answers) answers.set(a.id, a);
    const ids = [...new Set([...rc.applies, ...answers.keys()])];
    const ref = (id: string): DecisionRef => {
      const d = this.c.index.getItem(id);
      return { id, title: d?.title ?? id, category_path: d?.category_path ?? null, via: rc.applies.includes(id) ? "files" : "named by the AI" };
    };
    const s: CheckState = { applies: ids.map(ref), followed: [], not_applicable: [], broken: [], unanswered: [] };
    for (const id of ids) {
      const a = answers.get(id);
      if (!a) s.unanswered.push(ref(id));
      else if (a.verdict === "followed") s.followed.push(ref(id));
      else if (a.verdict === "n/a") s.not_applicable.push(ref(id));
      else s.broken.push({ ...ref(id), ...(a.note ? { note: a.note } : {}) });
    }
    return s;
  }

  // Answers given after the work was logged (the log response listed what was left).
  answer(actor: Actor, activityId: string, answers: RuleAnswer[]) {
    const entry = this.c.activity.get(activityId);
    if (!entry || entry.action === ANSWER_ACTION) throw new CortexError("not_found", `No logged work ${activityId}.`, 404);
    if (!entry.rule_check) {
      throw new CortexError("no_rule_check", "No decisions were checked for this entry: it was logged without files, or none govern them.", 400);
    }
    if (actor.kind === "ai" && entry.actor !== actor.id) {
      throw new CortexError("forbidden", "Only the actor who logged this work (or a person) answers for it.", 403);
    }
    const parsed = RuleAnswers.safeParse(answers);
    const issues = parsed.success ? this.validate(parsed.data) : parsed.error.issues.map((i) => `decisions.${i.path.join(".")}: ${i.message}`);
    if (!parsed.success || issues.length) throw new CortexError("invalid_rule_check", "The answers do not match the rules.", 400, { issues, example: EXAMPLE });
    const via = currentVia();
    const e: Activity = {
      id: ulid(),
      at: nowIso(),
      actor: actor.id,
      actor_kind: actor.kind,
      action: ANSWER_ACTION,
      summary: `Answered ${parsed.data.length} decision check(s) for "${entry.summary}"`.slice(0, 200),
      refs: [entry.id],
      system: true,
      rule_check: { applies: [], answers: parsed.data },
      ...(via ? { via } : {}),
    };
    this.c.activityStore.append(e);
    this.c.index.addActivity(e);
    this.c.events.emit("change", { type: "activity", entry: e });
    return { id: entry.id, rule_check: this.state(entry) };
  }

  // The exceptions over a period, for the board and the report: what was broken and what was never answered.
  report(opts: { since?: string; until?: string } = {}, sees: (a: Activity) => boolean = () => true) {
    const { since, until } = parsePeriod(opts.since ?? "30d", opts.until, Date.now(), this.c.project.config.timezone ?? "UTC");
    const entries = this.c.index.activityBetween(since, until).filter((e) => e.rule_check && e.action !== ANSWER_ACTION && sees(e));
    const counts = { entries: 0, decisions: 0, followed: 0, broken: 0, not_applicable: 0, unanswered: 0 };
    const broken: { activity: Row; decision: DecisionRef & { note?: string } }[] = [];
    const unanswered: { activity: Row; decisions: DecisionRef[] }[] = [];
    for (const e of entries) {
      const s = this.state(e)!;
      if (!s.applies.length) continue;
      counts.entries++;
      counts.decisions += s.applies.length;
      counts.followed += s.followed.length;
      counts.broken += s.broken.length;
      counts.not_applicable += s.not_applicable.length;
      counts.unanswered += s.unanswered.length;
      const row: Row = { id: e.id, at: e.at, actor: e.actor, summary: e.summary };
      for (const d of s.broken) broken.push({ activity: row, decision: d });
      if (s.unanswered.length) unanswered.push({ activity: row, decisions: s.unanswered });
    }
    return { since, until, counts, broken: broken.reverse(), unanswered: unanswered.reverse() };
  }

  // An actor's own entries that still wait for answers: the brief reminds it.
  unansweredBy(actorId: string, since: string): { id: string; summary: string; decisions: number }[] {
    return this.c.index
      .queryActivity({ actor: actorId, since, includeSystem: false, limit: 200 })
      .filter((e) => e.rule_check)
      .map((e) => ({ e, s: this.state(e)! }))
      .filter(({ s }) => s.unanswered.length > 0)
      .map(({ e, s }) => ({ id: e.id, summary: e.summary, decisions: s.unanswered.length }));
  }
}

interface Row {
  id: string;
  at: string;
  actor: string;
  summary: string;
}

export const EXAMPLE = [
  { id: "01J9Y...", verdict: "followed" },
  { id: "01J9Z...", verdict: "broken", note: "The payment page needed a loader; asked @humans in 01KA..." },
  { id: "01JA0...", verdict: "n/a" },
];
