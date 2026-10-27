import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatAnswer } from "./chat.js";
import type { ChatKind } from "./chatApprovals.js";
import type { Cortex } from "./cortex.js";
import type { Via } from "./provenance.js";
import { provenance } from "./provenance.js";
import type { Actor } from "./types.js";
import { CortexError } from "./types.js";
import { nowIso, ulid } from "../util/text.js";

// Questions an AI asks the person on the board, for clients that cannot show them in the chat (decision
// 01M3PCTFYV4WPM0APNNJJ9YJQG). The same question the chat would have shown (built from the records by the
// MCP server), a second way to answer it: the board shows it to that one person, their answer comes from
// their own board session and is applied here, as theirs, with `via.channel: "board-prompt"`. It counts
// whenever it comes, also after the AI stopped waiting; the AI reads the outcome by the prompt's id.
//
// Files live in .cortex/.prompts/ (git-ignored): a question is a message in flight, not project memory.

export type FormSchema = { type: "object"; properties: Record<string, Record<string, unknown>>; required?: string[] };

export interface CaptureInput {
  type: "note" | "decision" | "node";
  title: string;
  body?: string;
  summary?: string;
  path?: string;
  category_path?: string;
  fields?: Record<string, unknown>;
}

// What the answer does, kept with the question so it can be applied long after the AI's call returned.
export type PromptPlan =
  | { kind: "draft"; ids: string[] }
  | { kind: "decision" | "question"; target_id: string }
  | { kind: "transition"; target_id: string; to: string }
  | { kind: "capture"; capture: CaptureInput };

export type PromptStatus = "open" | "answered" | "expired";

export interface BoardPrompt {
  id: string;
  at: string;
  expires_at: string;
  ai_actor: string;
  human: string;
  session?: string;
  title: string; // one line for lists and the browser notification
  message: string; // exactly what the person is shown
  schema: FormSchema;
  plan: PromptPlan;
  perm: string; // what the person's role must allow (checked again when they answer)
  shown_hash: string;
  status: PromptStatus;
  answered_at?: string;
  answer?: Record<string, unknown>;
  result?: unknown;
}

export const PROMPT_TTL_MS = 24 * 3_600_000; // owner's choice, 2026-09-29
const MAX_OPEN_PER_AI = 5; // an AI cannot bury the person in questions
const KEEP_CLOSED_MS = 7 * 24 * 3_600_000;
const MAX_MESSAGE = 12_000;
const MAX_TEXT_ANSWER = 4000;
const ID = /^[0-9A-Z]{26}$/;

export const promptHash = (message: string, schema: FormSchema) =>
  createHash("sha256")
    .update(message + JSON.stringify(schema))
    .digest("hex");

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

// A form answer turned into what it does. The chat question (elicitation) and the board question both go
// through here, so the same form means the same thing wherever it was answered. Capture writes records
// itself and is not an answer to an existing one.
export function answersFor(plan: PromptPlan, c: Record<string, unknown>): ChatAnswer[] {
  switch (plan.kind) {
    case "draft": {
      const pick = (v: string) => plan.ids.filter((_, n) => c[`d${n + 1}`] === v);
      const approve = pick("approve");
      const reject = pick("reject");
      return [
        ...(approve.length ? [{ kind: "draft" as const, ids: approve, answer: "approve" }] : []),
        ...(reject.length ? [{ kind: "draft" as const, ids: reject, answer: "reject", note: str(c.note) }] : []),
      ];
    }
    case "decision":
      return [{ kind: "decision", target_id: plan.target_id, answer: String(c.answer), note: str(c.reason) }];
    case "question": {
      // A picked option, with the person's note under it when they wrote one.
      const note = str(c.note);
      return [{ kind: "question", target_id: plan.target_id, answer: `${String(c.answer ?? "")}${note ? `\n\n${note}` : ""}` }];
    }
    case "transition":
      return c.answer === "yes" ? [{ kind: "transition", target_id: plan.target_id, to: plan.to, answer: "yes", note: str(c.note) }] : [];
    case "capture":
      return [];
  }
}

// The kind of answer a plan gives, for role checks; capture needs the right to write what it writes.
export const planKind = (plan: PromptPlan): ChatKind | "capture_item" | "capture_node" =>
  plan.kind === "capture" ? (plan.capture.type === "node" ? "capture_node" : "capture_item") : plan.kind;

// The form answer must be one the form allows: enum values from their list, required fields present,
// text within reason. The board is a browser; nothing it sends is trusted as is.
function checkAnswer(schema: FormSchema, content: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(schema.properties)) {
    const v = content[k];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string") throw new CortexError("validation", `${k}: expected text.`, 400);
    const allowed = spec.enum as string[] | undefined;
    if (allowed && !allowed.includes(v)) throw new CortexError("validation", `${k}: one of ${allowed.join(", ")}.`, 400);
    if (v.length > MAX_TEXT_ANSWER) throw new CortexError("validation", `${k}: at most ${MAX_TEXT_ANSWER} characters.`, 400);
    out[k] = v;
  }
  for (const k of schema.required ?? []) {
    if (out[k] === undefined) throw new CortexError("validation", `${k} is required.`, 400);
  }
  return out;
}

export class PromptService {
  constructor(
    private c: Cortex,
    private dir: string,
  ) {}

  private file(id: string): string {
    if (!ID.test(id)) throw new CortexError("not_found", `No question "${id}".`, 404);
    return join(this.dir, `${id}.json`);
  }

  private save(p: BoardPrompt): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      this.ignoreInGit();
    }
    writeFileSync(this.file(p.id), JSON.stringify(p, null, 2) + "\n", "utf8");
  }

  // Projects made before prompts existed have a .gitignore without this line.
  private ignoreInGit(): void {
    const file = join(this.c.project.dir, ".gitignore");
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!text.split(/\r?\n/).includes(".prompts/")) {
      writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}.prompts/\n`, "utf8");
    }
  }

  // Reading also settles time: an open question past its time is expired, and closed ones older than a
  // week are dropped.
  private load(id: string, now = Date.now()): BoardPrompt | null {
    const f = this.file(id);
    if (!existsSync(f)) return null;
    const p = JSON.parse(readFileSync(f, "utf8")) as BoardPrompt;
    if (p.status === "open" && Date.parse(p.expires_at) <= now) {
      p.status = "expired";
      this.save(p);
    }
    return p;
  }

  list(filter: { human?: string; ai?: string; status?: PromptStatus } = {}): BoardPrompt[] {
    if (!existsSync(this.dir)) return [];
    const now = Date.now();
    const out: BoardPrompt[] = [];
    for (const f of readdirSync(this.dir)
      .filter((n) => n.endsWith(".json"))
      .sort()) {
      const p = this.load(f.slice(0, -5), now);
      if (!p) continue;
      const closedAt = Date.parse(p.answered_at ?? p.expires_at);
      if (p.status !== "open" && now - closedAt > KEEP_CLOSED_MS) {
        unlinkSync(this.file(p.id));
        continue;
      }
      if (filter.human && p.human !== filter.human) continue;
      if (filter.ai && p.ai_actor !== filter.ai) continue;
      if (filter.status && p.status !== filter.status) continue;
      out.push(p);
    }
    return out;
  }

  get(id: string): BoardPrompt {
    const p = this.load(id);
    if (!p) throw new CortexError("not_found", `No question "${id}". It may be older than a week.`, 404);
    return p;
  }

  open(ai: Actor, input: { human: string; session?: string; title: string; message: string; schema: FormSchema; plan: PromptPlan; perm: string }): BoardPrompt {
    if (ai.kind !== "ai") throw new CortexError("forbidden", "Only an AI asks on the board; a person answers.", 403);
    if (!input.message?.trim() || input.message.length > MAX_MESSAGE) {
      throw new CortexError("validation", `message: the question, at most ${MAX_MESSAGE} characters.`, 400);
    }
    if (!input.schema || input.schema.type !== "object" || typeof input.schema.properties !== "object") {
      throw new CortexError("validation", "schema: an object form.", 400);
    }
    const waiting = this.list({ ai: ai.id, status: "open" });
    if (waiting.length >= MAX_OPEN_PER_AI) {
      throw new CortexError("too_many_questions", `${waiting.length} of your questions already wait on the board. Wait for answers before asking more.`, 429, {
        waiting: waiting.map((p) => p.id),
      });
    }
    const at = nowIso();
    const p: BoardPrompt = {
      id: ulid(),
      at,
      expires_at: new Date(Date.parse(at) + PROMPT_TTL_MS).toISOString(),
      ai_actor: ai.id,
      human: input.human,
      ...(input.session ? { session: input.session } : {}),
      title: input.title.slice(0, 200),
      message: input.message,
      schema: input.schema,
      plan: input.plan,
      perm: input.perm,
      shown_hash: promptHash(input.message, input.schema),
      status: "open",
    };
    this.save(p);
    this.c.activity.system(ai.id, "chat.prompt", `Asked ${p.human} on the board: ${p.title}`.slice(0, 200), this.refs(p));
    return p;
  }

  // The person's answer from their own board session. The route has checked their role; this checks it is
  // their question, still open, and a valid answer, then applies it as theirs.
  answer(human: Actor, id: string, content: Record<string, unknown>): BoardPrompt {
    const p = this.get(id);
    if (human.kind !== "human" || human.id !== p.human) throw new CortexError("forbidden", `This question was asked of ${p.human}.`, 403);
    if (p.status === "expired") throw new CortexError("expired", "This question expired; the AI has to ask again.", 409);
    if (p.status !== "open") throw new CortexError("already_answered", "This question was already answered.", 409);
    const answer = checkAnswer(p.schema, content);
    const via: Via = { channel: "board-prompt", ai_actor: p.ai_actor, ...(p.session ? { session: p.session } : {}), shown_hash: p.shown_hash };
    const result = provenance.run(via, () => {
      if (p.plan.kind === "capture") return this.capture(human, p.plan.capture, answer);
      const out = answersFor(p.plan, answer).map((a) => this.c.chat.apply(human, a));
      return out.length === 0 ? { changed: false } : out.length === 1 ? out[0] : out;
    });
    const done: BoardPrompt = { ...p, status: "answered", answered_at: nowIso(), answer, result };
    this.save(done);
    this.c.activity.system(human.id, "chat.prompt_answered", `Answered ${p.ai_actor}'s question on the board: ${p.title}`.slice(0, 200), this.refs(p));
    return done;
  }

  // A capture the person confirmed: written as theirs and active at once (the same as cortex_capture in the chat).
  private capture(human: Actor, cap: CaptureInput, answer: Record<string, unknown>): object {
    if (answer.answer !== "save") return { saved: false };
    if (cap.type === "node") {
      if (!cap.path || !cap.summary) throw new CortexError("validation", "A node needs path and summary.", 400);
      return {
        saved: true,
        ...this.c.putNode(human, { path: cap.path, title: cap.title, summary: cap.summary, body: cap.body ?? "", reason: "Captured from the chat" }),
      };
    }
    const created = this.c.items.create(human, {
      type: cap.type,
      title: cap.title,
      body: cap.body ?? "",
      ...(cap.category_path ? { category_path: cap.category_path } : {}),
      fields: cap.fields ?? {},
    });
    if (cap.type === "decision")
      this.c.items.reply(human, created.id, { body: this.c.language() === "tr" ? "Sohbette karar verildi." : "Decided in the chat.", status: "accepted" });
    return { saved: true, ...created };
  }

  private refs(p: BoardPrompt): string[] {
    const id = p.plan.kind === "decision" || p.plan.kind === "question" || p.plan.kind === "transition" ? p.plan.target_id : undefined;
    return id && this.c.itemStore.exists(id) ? [id] : [];
  }
}
