import { z } from "zod";
import type { Cortex } from "./cortex.js";
import { nowIso, ulid } from "../util/text.js";
import type { Actor, Activity } from "./types.js";
import { CortexError } from "./types.js";
import { currentVia } from "./provenance.js";
import type { RuleCheck } from "./ruleCheck.js";
import { RuleAnswers } from "./ruleCheck.js";

export const ActivityInput = z
  .object({
    action: z.string(),
    summary: z.string().min(1).max(200),
    why: z.string().max(2000).optional(),
    files: z.array(z.string().max(300)).max(100).optional(),
    commit: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/i, "must be a git commit hash")
      .optional(),
    // Several commits for one change (a fix and its follow-up). `commit` still works for one.
    commits: z
      .array(z.string().regex(/^[0-9a-f]{7,40}$/i, "must be a git commit hash"))
      .max(20)
      .optional(),
    refs: z.array(z.string()).max(20).optional(),
    // For each accepted decision governing the files: followed, broken (with a note) or n/a.
    decisions: RuleAnswers.optional(),
  })
  .strict();
export type ActivityInput = z.input<typeof ActivityInput>;

const EXAMPLE = {
  action: "fix",
  summary: "Rate-limit login to 5 attempts per minute per IP",
  why: "Brute-force attempts seen in logs (issue 01J9Y...)",
  files: ["src/auth/login.ts", "src/middleware/rateLimit.ts"],
  commits: ["d4e5f6a"],
  refs: ["01J9YQ8K2M3N4P5Q6R7S8T9V0W", "backend/auth"],
};

export class ActivityService {
  constructor(private c: Cortex) {}

  // What an actor did and why. Humans read this feed to stay in control of what the AI changed.
  // visible: what the caller may see on a hub; decisions outside it are not asked about.
  log(actor: Actor, input: ActivityInput, visible: { sql: string; args: (string | number)[] } | null = null) {
    const schema = this.c.activitySchema();
    const parsed = ActivityInput.safeParse(input);
    const issues = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    const d = parsed.success ? parsed.data : null;
    if (d) {
      if (!schema.actions.includes(d.action)) issues.push(`action: must be one of ${schema.actions.join(", ")}`);
      if (schema.why_required_for.includes(d.action) && !d.why?.trim()) issues.push(`why: required for "${d.action}" (explain the reason, not the change)`);
      for (const r of d.refs ?? []) {
        if (!this.c.itemStore.exists(r) && !this.c.tree.exists(r)) issues.push(`refs: "${r}" is neither an item id nor a knowledge node path`);
      }
      issues.push(...this.c.ruleChecks.validate(d.decisions ?? []));
    }
    if (issues.length || !d) {
      throw new CortexError("invalid_activity", "Activity does not match the rules.", 400, {
        issues,
        rules: schema,
        example: EXAMPLE,
      });
    }
    const via = currentVia();
    const { decisions, ...fields } = d;
    // Decision 01M3MXD9VVDQJSDEFX60PQTAWH: which accepted decisions govern these files, and what the actor said.
    const selected = fields.files?.length ? this.c.ruleChecks.select(fields.files, visible) : { asked: [], also: [] };
    const applies = selected.asked.map((x) => x.id);
    const rule_check: RuleCheck | undefined = applies.length || decisions?.length ? { applies, answers: decisions ?? [] } : undefined;
    const entry: Activity = {
      id: ulid(),
      at: nowIso(),
      actor: actor.id,
      actor_kind: actor.kind,
      ...fields,
      ...(rule_check ? { rule_check } : {}),
      ...(via ? { via } : {}),
    };
    this.c.activityStore.append(entry);
    this.c.index.addActivity(entry);
    this.c.events.emit("change", { type: "activity", entry });
    // Close the loop: knowledge describing the files you just changed may now be wrong.
    // Usually logged seconds after the commit: look at HEAD now, not at what the throttle last saw.
    if (entry.files?.length) this.c.staleness.refresh(false, true);
    const related = entry.files?.length ? this.c.codeContext(entry.files).knowledge : [];
    const rows = related.map((n) => {
      const s = this.c.staleness.get(n.path as string);
      return { path: n.path as string, title: n.title as string, ...(s ? { stale: { severity: s.severity, files: s.changes.map((c) => c.file) } } : {}) };
    });
    const stale = rows.filter((r) => r.stale);
    const check = this.c.ruleChecks.state(entry);
    return {
      id: entry.id,
      message: "Activity logged.",
      ...(check && check.applies.length
        ? {
            rule_check: {
              unanswered: check.unanswered,
              broken: check.broken,
              followed: check.followed.length,
              not_applicable: check.not_applicable.length,
              ...(selected.also.length ? { also: selected.also } : {}), // broader ones, to glance at: no answer needed
            },
            ...(check.unanswered.length
              ? {
                  rule_check_hint: `${check.unanswered.length} accepted decision(s) govern these files and you have not said whether you followed them. Answer now with cortex_answer_rules (activity_id "${entry.id}"): followed, broken (with the reason) or n/a for each. Unanswered ones are shown to people.`,
                }
              : {}),
          }
        : {}),
      ...(rows.length
        ? {
            related_knowledge: rows,
            // You made them stale, you know best what changed: close them now rather than leaving them for someone else.
            hint: stale.length
              ? `Your change made ${stale.length} node(s) stale: ${stale.map((r) => r.path || "(root)").join(", ")}. In this same turn, update each one (cortex_update_node) or, if it is still true, verify it (cortex_verify_node). Where your knowledge writes need review, either becomes a draft a human approves.`
              : "These nodes describe files you changed. Update them if your change affects what they say, or verify them if they are still true.",
          }
        : {}),
    };
  }

  // Audit trail written by Cortex itself on every write.
  system(actorId: string, action: string, summary: string, refs: string[] = [], meta?: Activity["meta"]): Activity {
    const via = currentVia();
    const kind = this.c.project.config.actors.find((a) => a.id === actorId)?.kind;
    const entry: Activity = {
      id: ulid(),
      at: nowIso(),
      actor: actorId,
      ...(kind ? { actor_kind: kind } : {}),
      action,
      summary,
      refs,
      system: true,
      ...(meta ? { meta } : {}),
      ...(via ? { via } : {}),
    };
    this.c.activityStore.append(entry);
    this.c.index.addActivity(entry);
    this.c.events.emit("change", { type: "activity", entry });
    return entry;
  }

  // Newest first. `before` (an entry id, the last one of the previous page) pages back through the feed;
  // next_cursor is set while there may be more.
  list(q: { since?: string; until?: string; before?: string; actor?: string; ref?: string; include_system?: boolean; chat?: boolean; limit?: number }) {
    for (const [name, v] of [
      ["since", q.since],
      ["until", q.until],
    ] as const) {
      if (v && isNaN(Date.parse(v)))
        throw new CortexError("invalid_query", `${name} must be an ISO date or datetime, e.g. 2026-09-22 or 2026-09-22T10:00:00Z`, 400);
    }
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 200);
    const entries = this.c.index.queryActivity({
      since: q.since,
      until: q.until,
      before: q.before,
      actor: q.actor,
      ref: q.ref,
      includeSystem: q.include_system ?? false,
      chat: q.chat,
      limit,
    });
    return { entries, next_cursor: entries.length === limit ? entries[entries.length - 1].id : null };
  }

  get(id: string): Activity {
    const a = this.c.index.getActivity(id);
    if (!a) throw new CortexError("not_found", `No activity with id "${id}".`, 404);
    return a;
  }
}
