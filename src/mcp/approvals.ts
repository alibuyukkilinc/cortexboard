import { createHash, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { diffLines } from "../core/diff.js";
import type { ChatAnswer } from "../core/chat.js";
import type { BoardPrompt, FormSchema, PromptPlan } from "../core/chatPrompts.js";
import { answersFor } from "../core/chatPrompts.js";
import type { ChatApproval, ChatKind } from "../core/chatApprovals.js";
import type { ChatSettings, Via } from "../core/provenance.js";
import type { Item, KnowledgeNode } from "../core/types.js";
import { CortexError } from "../core/types.js";
import type { McpApi } from "./client.js";

// Approvals asked in the AI chat. The rule that does not bend: an AI cannot produce a person's approval.
// So the question is built here from the real records (not from the AI's words), the answer comes back
// from the client's own UI through MCP elicitation, and only then is it written, as the person, with
// where it came from (`via`). A client that cannot show the question (no elicitation, or one that refuses
// it on its own) gets the same question on the board instead: the person answers there, from their own
// board session, and the server applies it (decision 01M3PCTFYV4WPM0APNNJJ9YJQG). The AI may also relay
// the person's words, if the project allows it: applied marked unverified, or queued for confirmation.
// Nothing else in the MCP server writes as a person.

type Json = Record<string, unknown>;
type Settings = ChatSettings & { language: string | null };
type Human = NonNullable<McpApi["human"]>;

const MAX_SECTION = 1400; // characters per record in the question: enough to judge, small enough to read
const MAX_DIFF_LINES = 24;
// How long a person may take to answer. The SDK's default (60 s) is too short for reading a diff, and a
// client that advertises elicitation but never shows the question (seen in opencode) must not hang forever.
export const ELICIT_TIMEOUT_MS = 10 * 60_000;
// No one reads a question and says no this fast. A refusal quicker than this was most likely the client's
// own (seen in Claude desktop, Codex): the question was never shown. Two of them in one session and the
// session stops asking through the client, as with --no-elicitation.
export const AUTO_DECLINE_MS = 1500;
const AUTO_DECLINES_TO_STOP = 2;
// How long the tool waits for an answer on the board before saying it is pending (owner's choice,
// 2026-09-29). The answer still counts when it comes later.
export const BOARD_WAIT_MS = 90_000;
const BOARD_POLL_MS = 1000;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

// What the person's role must allow for each kind of answer (team server); the same as on the board.
const PERM: Record<ChatKind | "capture_item" | "capture_node", string> = {
  draft: "approve",
  decision: "write_items",
  question: "ask",
  transition: "write_items",
  capture_item: "write_items",
  capture_node: "write_knowledge",
};

const T = {
  en: {
    header: "Cortex approval",
    aiNote: "AI's note (context only, check the record above)",
    by: "by",
    reason: "reason",
    lines: "lines",
    newRecord: "new",
    choose: "Your answer",
    note: "Note (optional)",
    reasonField: "Reason (optional; kept on the card)",
    answer: "Your answer",
    captureQ: "Save this to Cortex as your own record?",
    decided: "Decided in the chat.",
    planCheck: "Plan check: does the card above still match what was built? If limits, names or files changed, have the AI update it first.",
  },
  tr: {
    header: "Cortex onayı",
    aiNote: "AI'ın notu (yalnızca bağlam; asıl kayıt yukarıda)",
    by: "öneren",
    reason: "gerekçe",
    lines: "satır",
    newRecord: "yeni",
    choose: "Cevabınız",
    note: "Not (isteğe bağlı)",
    reasonField: "Gerekçe (isteğe bağlı; kartta kalır)",
    answer: "Cevabınız",
    captureQ: "Bu, sizin adınıza Cortex'e kaydedilsin mi?",
    decided: "Sohbette karar verildi.",
    planCheck: "Plan kontrolü: yukarıdaki kart yapılan işle hâlâ uyuşuyor mu? Sınırlar, adlar ya da dosyalar değiştiyse önce AI'a güncelletin.",
  },
};
type Texts = (typeof T)["en"];

function renderDiff(before: string, after: string): string {
  const changed = diffLines(before, after).filter((l) => l.kind !== "same");
  const shown = changed.slice(0, MAX_DIFF_LINES).map((l) => `${l.kind === "add" ? "+" : "-"} ${cut(l.text, 160)}`);
  if (changed.length > shown.length) shown.push(`… (+${changed.length - shown.length})`);
  return shown.join("\n");
}

// A question ready to show, and what the person's form answer becomes. Most answers are applied through
// POST /chat/apply (the same endpoint the board's confirmation uses); capture writes records itself (`apply`).
interface Prepared {
  title: string; // one line, for the board's list and notification
  message: string;
  schema: FormSchema;
  perm: string; // checked against the person's role before they are asked
  plan: PromptPlan; // what the answer does; the board applies the same plan on the server
  apply?(content: Json, as: Pick<McpApi, "call">): Promise<unknown>; // capture in the chat writes records itself
}

// opts.elicitation false: never ask through the client (for clients that advertise elicitation but do not
// show it); questions then go to the board (`cortexboard mcp --no-elicitation`).
export function registerApprovalTools(
  server: McpServer,
  api: McpApi,
  opts: { elicitation?: boolean; timeoutMs?: number; autoDeclineMs?: number; boardWaitMs?: number; boardPollMs?: number } = {},
): void {
  const session = randomUUID();
  let autoDeclines = 0; // refusals too fast to be the person's (AUTO_DECLINE_MS)
  const get = (p: string, q?: Json) => api.call("GET", p, { query: q }) as Promise<Json>;
  const pending = () => get("/approvals/chat") as Promise<{ count: number; items: ChatApproval[]; settings: Settings }>;
  const aiId = async () => ((await get("/me")) as { actor: { id: string } }).actor.id;
  const texts = (s: Settings): Texts => (s.language === "tr" ? T.tr : T.en);

  const humanApi = (): Human => {
    if (!api.human) {
      throw new CortexError(
        "no_human",
        "This session has no person to ask: approvals in the chat are not available here.",
        400,
        "Local projects: add a human actor to cortex.config.yaml or start the MCP server with --human <id>. On a team server: --human-token.",
      );
    }
    return api.human;
  };
  const clientStopsAsking = () => autoDeclines >= AUTO_DECLINES_TO_STOP;
  const canElicit = () => opts.elicitation !== false && !clientStopsAsking() && !!server.server.getClientCapabilities()?.elicitation?.form;

  // ---- building the question from the records themselves --------------------------------------

  async function draftSection(id: string, n: number, t: Texts): Promise<string> {
    const r = (await get(`/approvals/${encodeURIComponent(id)}`)) as {
      draft: { kind: string; target: string; proposed_by: string; reason?: string; data: KnowledgeNode | Item };
      current: (KnowledgeNode | Item) | null;
      changes: { new: boolean; fields: { name: string; before: string; after: string }[]; body: { added: number; removed: number } };
    };
    const d = r.draft;
    const head = `[${n}] ${d.kind} "${d.target || "(root)"}" (${d.data.title}) · ${t.by} ${d.proposed_by}${r.changes.new ? ` · ${t.newRecord}` : ""}`;
    const lines = [head];
    if (d.reason) lines.push(`${t.reason}: ${cut(d.reason, 300)}`);
    for (const f of r.changes.fields) lines.push(`${f.name}: ${cut(f.before || "∅", 140)} → ${cut(f.after || "∅", 140)}`);
    if (r.changes.body.added || r.changes.body.removed) {
      lines.push(`body: +${r.changes.body.added} / -${r.changes.body.removed} ${t.lines}`);
      // Fenced: the board renders the question as Markdown, where "+ x" and "- x" would turn into a list.
      lines.push("```diff", renderDiff(r.current?.body ?? "", d.data.body ?? ""), "```");
    }
    return cut(lines.join("\n"), MAX_SECTION);
  }

  async function itemSection(id: string): Promise<{ item: Item; text: string }> {
    const r = (await get(`/items/${encodeURIComponent(id)}`, { replies: 1 })) as { item: Item; replies?: { author: string; body: string }[] };
    const i = r.item;
    const lines = [`${i.type} ${i.id} · ${i.status}`, i.title];
    if (typeof i.fields?.context === "string") lines.push(`context: ${cut(i.fields.context, 400)}`);
    if (i.body) lines.push(cut(i.body, 700));
    const last = r.replies?.at(-1);
    if (last) lines.push(`— ${last.author}: ${cut(last.body, 400)}`);
    return { item: i, text: cut(lines.join("\n"), MAX_SECTION) };
  }

  async function prepare(kind: ChatKind, a: { target_id?: string; ids?: string[]; to?: string }, s: Settings): Promise<Prepared> {
    const t = texts(s);
    if (kind === "draft") {
      const ids = [...new Set([...(a.ids ?? []), ...(a.target_id ? [a.target_id] : [])])];
      if (!ids.length) throw new CortexError("validation", "Give the draft ids (ids) to ask about.", 400);
      if (ids.length > s.max_batch) {
        throw new CortexError("too_many", `At most ${s.max_batch} drafts in one question.`, 400, { max_batch: s.max_batch });
      }
      const sections = await Promise.all(ids.map((id, n) => draftSection(id, n + 1, t)));
      const properties: Record<string, Json> = {};
      ids.forEach((id, n) => {
        properties[`d${n + 1}`] = { type: "string", title: `[${n + 1}] ${id}`, enum: ["approve", "reject", "skip"] };
      });
      properties.note = { type: "string", title: t.note };
      return {
        title: `draft ${ids.length === 1 ? ids[0] : `×${ids.length}`}`,
        message: `${t.header}: draft ${ids.length === 1 ? ids[0] : `×${ids.length}`}\n\n${sections.join("\n\n")}`,
        schema: { type: "object", properties },
        perm: PERM.draft,
        plan: { kind: "draft", ids },
      };
    }

    const id = a.target_id ?? a.ids?.[0];
    if (!id) throw new CortexError("validation", "Give target_id: the item to ask about.", 400);
    const { item, text } = await itemSection(id);

    if (kind === "decision") {
      if (item.type !== "decision" || item.status !== "proposed") {
        throw new CortexError("not_pending", `${id} is not a proposed decision (it is a ${item.type} in "${item.status}").`, 409);
      }
      return {
        title: `decision: ${item.title}`,
        message: `${t.header}: decision ${id}\n\n${text}`,
        schema: {
          type: "object",
          properties: { answer: { type: "string", title: t.choose, enum: ["accept", "reject"] }, reason: { type: "string", title: t.reasonField } },
          required: ["answer"],
        },
        perm: PERM.decision,
        plan: { kind: "decision", target_id: id },
      };
    }

    if (kind === "question") {
      if (item.type !== "question") throw new CortexError("not_pending", `${id} is not a question.`, 409);
      // With options the person picks one (a note may add to it); without, they write the answer.
      const options = Array.isArray(item.fields?.options) ? (item.fields.options as unknown[]).filter((o): o is string => typeof o === "string") : [];
      return {
        title: `question: ${item.title}`,
        message: `${t.header}: question ${id}\n\n${text}`,
        schema:
          options.length >= 2
            ? {
                type: "object",
                properties: { answer: { type: "string", title: t.answer, enum: options }, note: { type: "string", title: t.note } },
                required: ["answer"],
              }
            : { type: "object", properties: { answer: { type: "string", title: t.answer } }, required: ["answer"] },
        perm: PERM.question,
        plan: { kind: "question", target_id: id },
      };
    }

    // transition: one human-only step, e.g. a task to done. The card's plan is shown with a reminder,
    // because values that changed while building must not stay on it (benchmark round 7).
    const to = a.to;
    if (!to) throw new CortexError("validation", 'Give `to`: the status to move it to (e.g. "done").', 400);
    // Nothing to ask: the person may have moved it on the board already.
    if (item.status === to) throw new CortexError("already", `${id} is already "${to}": nothing to ask.`, 409);
    return {
      title: `${item.status} → ${to}: ${item.title}`,
      message: `${t.header}: ${item.type} ${id} → ${to}\n\n${text}${item.body ? `\n\n${t.planCheck}` : ""}`,
      schema: {
        type: "object",
        properties: { answer: { type: "string", title: `${t.choose}: ${item.status} → ${to}?`, enum: ["yes", "no"] }, note: { type: "string", title: t.note } },
        required: ["answer"],
      },
      perm: PERM.transition,
      plan: { kind: "transition", target_id: id, to },
    };
  }

  // Every answer goes through the endpoint the board's confirmation uses, as the person, so their role
  // decides here exactly as it does on the board.
  async function applyAll(answers: ChatAnswer[], as: Pick<McpApi, "call">) {
    if (!answers.length) return { changed: false };
    const out: unknown[] = [];
    for (const a of answers) out.push(((await as.call("POST", "/chat/apply", { body: a })) as { result: unknown }).result);
    return out.length === 1 ? out[0] : out;
  }

  // On a team server the person's role must allow the answer; if it does not, they are not even asked.
  async function mayAnswer(human: Human, perm: string, ai: string) {
    const me = (await human.as({ channel: "chat-elicitation", ai_actor: ai, session }).call("GET", "/me")) as { perms?: string[]; role?: string };
    if (me.perms && !me.perms.includes(perm)) {
      throw new CortexError("not_permitted", `${human.id}'s role (${me.role}) does not allow this, so they were not asked.`, 403, { needs: perm });
    }
  }

  // What a question on the board came to. Waits up to BOARD_WAIT_MS for the person; after that the
  // question stays open on the board and the AI can look again by its id.
  async function boardOutcome(id: string, waitMs = opts.boardWaitMs ?? BOARD_WAIT_MS) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const p = ((await get(`/chat/prompts/${encodeURIComponent(id)}`)) as { prompt: BoardPrompt }).prompt;
      if (p.status === "answered") {
        return {
          answered: true,
          answer: p.answer,
          recorded_as: { actor: p.human, via: "board-prompt", shown_hash: p.shown_hash },
          result: p.result,
          prompt_id: p.id,
        };
      }
      if (p.status === "expired") {
        return {
          answered: false,
          expired: true,
          prompt_id: p.id,
          message: "The question expired on the board unanswered. Nothing changed; ask again if it still matters.",
        };
      }
      if (Date.now() >= deadline) {
        return {
          answered: false,
          pending: true,
          prompt_id: p.id,
          expires_at: p.expires_at,
          message: `Asked ${p.human} on the board; no answer yet. Their answer counts whenever they give it, until ${p.expires_at}.`,
          hint: "Tell the person a question is waiting for them on the Cortex board. Look again later with cortex_ask_human({ prompt_id }); do not take the silence as a yes or a no.",
        };
      }
      await new Promise((r) => setTimeout(r, Math.min(opts.boardPollMs ?? BOARD_POLL_MS, Math.max(0, deadline - Date.now()))));
    }
  }

  // The same question, on the board: for clients that cannot show it in the chat.
  async function askOnBoard(p: Prepared, message: string, human: Human, why: string) {
    const r = (await api.call("POST", "/chat/prompts", {
      body: { human: human.id, session, title: p.title, message, schema: p.schema, plan: p.plan },
    })) as { prompt: BoardPrompt };
    return { asked_on_board: true, why, ...(await boardOutcome(r.prompt.id)) };
  }

  // Asks the person; writes nothing unless they accept. A decline or a closed dialog is logged as such.
  async function ask(p: Prepared, context: string | undefined, s: Settings, what: { kind: string; ref?: string }) {
    const human = humanApi();
    const t = texts(s);
    const ai = await aiId();
    await mayAnswer(human, p.perm, ai);
    const message = context?.trim() ? `${p.message}\n\n— ${t.aiNote}:\n${cut(context.trim(), 600)}` : p.message;
    if (!canElicit()) {
      return askOnBoard(
        p,
        message,
        human,
        clientStopsAsking() ? "this client refused the last questions without showing them" : "this client cannot show questions in the chat",
      );
    }
    const shown_hash = hash(message + JSON.stringify(p.schema));
    const started = Date.now();
    let failed: string | null = null;
    const res = await server.server
      .elicitInput({ mode: "form", message, requestedSchema: p.schema as never }, { timeout: opts.timeoutMs ?? ELICIT_TIMEOUT_MS })
      .catch((e: Error) => {
        failed = e.message;
        return null;
      });
    // A client that claims to ask but never answers (seen in opencode): the board still can.
    if (!res) return askOnBoard(p, message, human, `the question could not be shown in the chat (${failed})`);
    if (res.action !== "accept" || !res.content) {
      const auto = Date.now() - started < (opts.autoDeclineMs ?? AUTO_DECLINE_MS);
      if (auto) autoDeclines++;
      await api.call("POST", "/activity", {
        body: {
          action: "other",
          summary: cut(
            `Asked ${human.id} in the chat (${what.kind}${what.ref ? ` ${what.ref}` : ""}): no answer (${res.action}${auto ? ", likely the client's own" : ""})`,
            200,
          ),
          ...(what.ref && what.kind !== "draft" && !what.kind.startsWith("capture") ? { refs: [what.ref] } : {}), // draft ids are not refs
        },
      });
      if (!auto) {
        return {
          answered: false,
          action: res.action,
          message: "Nothing changed.",
          hint: "If the person says they never saw a question, their client declines on its own: restart the MCP server with --no-elicitation.",
        };
      }
      // Too fast to be the person's: their client refused without showing it. Not their no; ask on the board.
      return { suspected_auto_decline: true, ...(await askOnBoard(p, message, human, "this client refused the question without showing it")) };
    }
    const via: Via = { channel: "chat-elicitation", ai_actor: ai, session, shown_hash };
    const content = res.content as Json;
    const as = human.as(via);
    const out = p.apply ? await p.apply(content, as) : await applyAll(answersFor(p.plan, content), as);
    return { answered: true, answer: content, recorded_as: { actor: human.id, via: via.channel, shown_hash }, result: out };
  }

  // ---- tools ---------------------------------------------------------------------------------

  server.registerTool(
    "cortex_pending_approvals",
    {
      description:
        "What the person could settle with one answer in this chat: drafts, proposed decisions, questions for humans, items one " +
        "human-only step from done. Then ask with cortex_ask_human (drafts: cortex_review_drafts).",
      inputSchema: {},
    },
    wrap(async () => {
      const r = await pending();
      // Questions this AI asked on the board: still open, or answered in the last day. A client that cut the
      // tool call short (many stop at 60 s) never got the prompt_id; it is here.
      const since = Date.now() - 24 * 3_600_000;
      const mine = ((await get("/chat/prompts", { status: "all" })) as { prompts: BoardPrompt[] }).prompts
        .filter((p) => p.status === "open" || (p.status === "answered" && Date.parse(p.answered_at!) >= since))
        .map((p) => ({ prompt_id: p.id, title: p.title, status: p.status, asked: p.at, ...(p.answered_at ? { answered_at: p.answered_at } : {}) }));
      return {
        ...r,
        elicitation: canElicit(),
        human: api.human?.id ?? null,
        ...(mine.length ? { on_board: mine, on_board_next: "cortex_ask_human({ prompt_id }) reads the answer" } : {}),
      };
    }),
  );

  server.registerTool(
    "cortex_ask_human",
    {
      description:
        "Ask the person in this chat (or on the board, if this client cannot show it); Cortex builds the question from the record " +
        "and their answer never passes through you. kind: draft (ids), decision (a proposed one), question (for @humans), transition " +
        "(a human-only status, with `to`; update the card first if the plan changed). A pending answer: pass prompt_id to look again. " +
        "Ask when a piece of work is finished, not for every step.",
      inputSchema: {
        kind: z.enum(["draft", "decision", "question", "transition"]).optional(),
        prompt_id: z.string().optional().describe("A question already waiting on the board"),
        target_id: z.string().optional(),
        ids: z.array(z.string()).max(50).optional(),
        to: z.string().optional(),
        context: z.string().max(2000).optional().describe("Your note shown under the record"),
      },
    },
    wrap(async (a: { kind?: ChatKind; prompt_id?: string; target_id?: string; ids?: string[]; to?: string; context?: string }) => {
      if (a.prompt_id) return boardOutcome(a.prompt_id);
      if (!a.kind) throw new CortexError("validation", "Give kind (or prompt_id to look at a question waiting on the board).", 400);
      const s = (await pending()).settings;
      const p = await prepare(a.kind, a, s);
      return ask(p, a.context, s, { kind: a.kind, ref: a.target_id ?? a.ids?.join(",") });
    }),
  );

  server.registerTool(
    "cortex_review_drafts",
    {
      description:
        "Have the person review pending drafts (real diffs) in one question. Without ids, the oldest up to the project's limit. " +
        "Use it when finished work left drafts.",
      inputSchema: {
        ids: z.array(z.string()).max(50).optional(),
        max: z.number().int().min(1).max(50).optional(),
        context: z.string().max(2000).optional(),
      },
    },
    wrap(async (a: { ids?: string[]; max?: number; context?: string }) => {
      const r = await pending();
      const ids = a.ids?.length
        ? a.ids
        : r.items
            .filter((i) => i.kind === "draft")
            .sort((x, y) => y.age_days - x.age_days)
            .slice(0, Math.min(a.max ?? r.settings.max_batch, r.settings.max_batch))
            .map((i) => i.id);
      if (!ids.length) return { answered: false, message: "No drafts waiting." };
      const p = await prepare("draft", { ids }, r.settings);
      return ask(p, a.context, r.settings, { kind: "draft", ref: ids.join(",") });
    }),
  );

  server.registerTool(
    "cortex_capture",
    {
      description:
        "The person stated something lasting (a decision, rule, project fact): offer to save it. They see exactly what would be " +
        "written and confirm; it is then theirs, active at once. Not for personal preferences. node needs path and summary.",
      inputSchema: {
        type: z.enum(["note", "decision", "node"]),
        title: z.string().min(1).max(160),
        body: z.string().default(""),
        summary: z.string().max(300).optional(),
        path: z.string().optional(),
        category_path: z.string().optional(),
        fields: z.record(z.string(), z.unknown()).optional().describe("decision: context (required)"),
        context: z.string().max(1000).optional(),
      },
    },
    wrap(
      async (a: {
        type: "note" | "decision" | "node";
        title: string;
        body: string;
        summary?: string;
        path?: string;
        category_path?: string;
        fields?: Json;
        context?: string;
      }) => {
        const s = (await pending()).settings;
        const t = texts(s);
        if (a.type === "node" && (!a.path || !a.summary)) throw new CortexError("validation", "A node needs path and summary.", 400);
        const shown = [
          `${a.type}${a.type === "node" ? ` ${a.path}` : a.category_path ? ` · ${a.category_path}` : ""}`,
          a.title,
          ...(a.summary ? [a.summary] : []),
          ...(a.fields && Object.keys(a.fields).length ? Object.entries(a.fields).map(([k, v]) => `${k}: ${cut(String(v), 300)}`) : []),
          ...(a.body ? [cut(a.body, 900)] : []),
        ].join("\n");
        const p: Prepared = {
          title: `capture ${a.type}: ${a.title}`,
          message: `${t.header}: capture\n\n${cut(shown, 1600)}\n\n${t.captureQ}`,
          schema: { type: "object", properties: { answer: { type: "string", title: t.choose, enum: ["save", "discard"] } }, required: ["answer"] },
          perm: a.type === "node" ? PERM.capture_node : PERM.capture_item,
          plan: {
            kind: "capture",
            capture: { type: a.type, title: a.title, body: a.body, summary: a.summary, path: a.path, category_path: a.category_path, fields: a.fields },
          },
          async apply(c, as) {
            if (c.answer !== "save") return { saved: false };
            if (a.type === "node") {
              const route = `/node/${a.path!.split("/").map(encodeURIComponent).join("/")}`;
              return as.call("PUT", route, { body: { title: a.title, summary: a.summary, body: a.body, reason: "Captured from the chat" } });
            }
            const created = (await as.call("POST", "/items", {
              body: { type: a.type, title: a.title, body: a.body, category_path: a.category_path, fields: a.fields ?? {} },
            })) as { id: string };
            // The person stated it as decided: it stands now, not as a proposal waiting for them.
            if (a.type === "decision") {
              await as.call("POST", `/items/${encodeURIComponent(created.id)}/replies`, { body: { body: t.decided, status: "accepted" } });
            }
            return { saved: true, ...created };
          },
        };
        return ask(p, a.context, s, { kind: `capture ${a.type}` });
      },
    ),
  );

  server.registerTool(
    "cortex_record_human_answer",
    {
      description:
        "Only when the person answered in the chat in their own words instead of the question: record them in `verbatim`. " +
        "Applied unverified or queued for them on the board, per project. Never for anything they did not say.",
      inputSchema: {
        kind: z.enum(["draft", "decision", "question", "transition"]),
        target_id: z.string().optional(),
        ids: z.array(z.string()).max(50).optional(),
        to: z.string().optional(),
        answer: z.string().min(1).describe("approve|reject, accept|reject, yes|no, or the answer"),
        verbatim: z.string().min(1).max(2000).describe("Their exact words"),
        note: z.string().max(1000).optional(),
      },
    },
    wrap(async (a: { kind: ChatKind; target_id?: string; ids?: string[]; to?: string; answer: string; verbatim: string; note?: string }) => {
      const s = (await pending()).settings;
      if (s.relayed === "off") throw new CortexError("relayed_off", "This project does not take relayed answers: ask on the board.", 403);
      if ((a.kind === "decision" || a.kind === "transition") && !s.relayed_human_only) {
        throw new CortexError(
          "needs_elicitation",
          "Decisions and human-only statuses change only through the person's own answer (elicitation or the board).",
          403,
          "Ask the person to do it on the board.",
        );
      }
      const human = humanApi();
      const answer: ChatAnswer = { kind: a.kind, ids: a.ids, target_id: a.target_id, to: a.to, answer: a.answer, note: a.note };
      if (s.relayed === "pending") {
        // Queued as the AI: nothing changes until the person confirms it on the board.
        const r = (await api.call("POST", "/chat/relayed", { body: { ...answer, human: human.id, verbatim: a.verbatim } })) as { queued: { id: string } };
        return { applied: false, pending: true, id: r.queued.id, message: "Queued; the person confirms it on the board (Approvals)." };
      }
      const ai = await aiId();
      await mayAnswer(human, PERM[a.kind], ai);
      const via: Via = { channel: "chat-relayed", ai_actor: ai, session, verbatim: a.verbatim, unverified: true };
      const out = await applyAll([answer], human.as(via));
      return { applied: true, recorded_as: { actor: human.id, via: via.channel, unverified: true }, result: out };
    }),
  );
}

function wrap<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(await fn(args)) }] };
    } catch (e) {
      const err = e instanceof CortexError ? { code: e.code, message: e.message, hint: e.hint } : { code: "internal", message: String(e) };
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: err }) }] };
    }
  };
}
