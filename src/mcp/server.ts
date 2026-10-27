import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERDICTS } from "../core/ruleCheck.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CortexError } from "../core/types.js";
import type { ActivityInput } from "../core/activity.js";
import type { ClaimInput, CreateItemInput, ReplyInput, UpdateItemInput } from "../core/items.js";
import type { DocKind } from "../index/db.js";
import type { McpApi } from "./client.js";
import { packageVersion } from "../util/version.js";
import { isSafeImage, isText, mediaType } from "../store/attachments.js";
import { registerApprovalTools } from "./approvals.js";
import type { FinishInput } from "./finish.js";
import { finish } from "./finish.js";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // what an AI client comfortably takes as one image
const MAX_TEXT_CHARS = 100_000;
const MAX_BATCH_ITEMS = 10;

// Compact JSON: every byte here is a token the AI pays for.
function result(data: object) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function wrap<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return result((await fn(args)) as object);
    } catch (e) {
      const err = e instanceof CortexError ? { code: e.code, message: e.message, hint: e.hint } : { code: "internal", message: String(e) };
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: err }) }] };
    }
  };
}

// Every tool definition goes to the model at the start of each session (~7 KB for all of them). The core set
// covers the working loop and everything a hint or the instructions point at; the rest (listings, reports,
// archive, discussion admin, attachments) come with `--tools full`.
export type ToolSet = "core" | "full";
export const FULL_ONLY = new Set([
  "cortex_items",
  "cortex_item_file",
  "cortex_report",
  "cortex_archive",
  "cortex_discussions",
  "cortex_close_vote",
  "cortex_activity",
]);

const path = (p: string) => (p ? `/${p.split("/").map(encodeURIComponent).join("/")}` : "");

// Reads (search, tree, node, items) can be aimed at a project this one links to, e.g. the backend from a
// mobile app. Read-only; the caller must be a member there too.
const LINKED = z.string().optional().describe('A linked project\'s id (cortex_brief "linked"), read-only');

export interface McpOptions {
  elicitation?: boolean;
  timeoutMs?: number;
  autoDeclineMs?: number;
  boardWaitMs?: number;
  boardPollMs?: number;
  tools?: ToolSet; // default core
}

export function buildMcpServer(api: McpApi, opts: McpOptions = {}): McpServer {
  const get = (p: string, q?: Record<string, unknown>) => api.call("GET", p, { query: q });
  const server = new McpServer(
    { name: "cortex", version: packageVersion() },
    {
      instructions:
        `Cortex is the shared brain of ${api.where}. Call cortex_brief first, then cortex_inbox. Navigate with cortex_tree (summaries only), ` +
        "search with cortex_search, and read full detail with cortex_node only when needed. Never try to load everything. " +
        "Before editing files call cortex_code_context; knowledge marked stale may be wrong. " +
        "After each meaningful change call cortex_log_activity with the files you changed, and say for each accepted decision that governs them whether you followed it (decisions; unanswered ones are shown to people); before you finish, bring the project status up to date with cortex_update_status. " +
        "When a piece of work is done, cortex_finish does the log, the card's reply and status, the claim and the project status in one call. " +
        "When unsure, cortex_ask instead of guessing. " +
        "Discussions waiting on your view show up in cortex_inbox; answer them with cortex_discuss. " +
        'Projects this one links to (cortex_brief "linked", e.g. the backend of a mobile app) can be searched and read with the project parameter. ' +
        "On a team server your role decides what you may write and what you can see; a refusal explains which permission is missing. " +
        "Keep Cortex current through the chat: when a piece of work is done, have the person review your drafts (cortex_review_drafts) " +
        "and settle what waits on them (cortex_pending_approvals, cortex_ask_human); when they state a lasting decision or rule, offer " +
        "cortex_capture instead of keeping it in your own memory. Only the person's own answer approves: never answer for them.",
    },
  );
  const tool: McpServer["registerTool"] = (name, config, cb) =>
    opts.tools !== "full" && FULL_ONLY.has(name) ? (undefined as never) : server.registerTool(name, config, cb);

  tool(
    "cortex_brief",
    {
      description: "Session opener (under 800 tokens): summary, branches, your inbox, recent activity, rules. Call first.",
      inputSchema: { budget: z.number().int().positive().optional().describe("Max tokens, roughly") },
    },
    wrap(async (a: { budget?: number }) => {
      const b = (await get("/brief", { budget: a.budget })) as { attention?: Record<string, unknown> };
      if (!api.human) delete b.attention?.ask_humans; // nobody to ask from this session: do not point at tools it lacks
      return b;
    }),
  );

  tool(
    "cortex_tree",
    {
      description: "Open a knowledge branch: titles and summaries only. Keep depth 1 unless you need more.",
      inputSchema: {
        path: z.string().default("").describe('e.g. "backend/auth"; "" = root'),
        depth: z.number().int().min(0).max(5).default(1),
        budget: z.number().int().positive().optional().describe("Max tokens, roughly"),
        project: LINKED,
      },
    },
    wrap((a: { path: string; depth: number; budget?: number; project?: string }) =>
      get(`/tree${path(a.path)}`, { depth: a.depth, budget: a.budget, project: a.project }),
    ),
  );

  tool(
    "cortex_node",
    {
      description: "Read one knowledge node in full. `staleness` in the answer means its code changed since: check before trusting it.",
      inputSchema: { path: z.string().describe('e.g. "backend/auth"'), project: LINKED },
    },
    wrap((a: { path: string; project?: string }) => get(`/node${path(a.path)}`, { project: a.project })),
  );

  tool(
    "cortex_code_context",
    {
      description:
        "Before editing files or directories: the knowledge, decisions and open items covering them. decisions_to_check: " +
        "accepted decisions your logged work will be checked against; decisions_also: broader ones, no answer needed.",
      inputSchema: { files: z.array(z.string()).min(1).max(50), include_closed: z.boolean().optional().describe("Also finished and superseded items") },
    },
    wrap((a: { files: string[]; include_closed?: boolean }) => get("/code", { files: a.files, include_closed: a.include_closed })),
  );

  tool(
    "cortex_verify_node",
    {
      description: "Mark a node still accurate at the current commit (clears staleness) without editing it. Only after checking the code.",
      inputSchema: { path: z.string(), note: z.string().optional().describe("What you checked") },
    },
    wrap((a: { path: string; note?: string }) => api.call("POST", `/verify${path(a.path)}`, { body: { note: a.note } })),
  );

  tool(
    "cortex_search",
    {
      description:
        "Search knowledge, items and activity (Turkish or English); summaries only. Use before changing what you don't fully " +
        "understand, and to find out why something was done.",
      inputSchema: {
        q: z.string().min(1),
        kind: z
          .array(z.enum(["node", "item", "activity"]))
          .optional()
          .describe("Default all"),
        type: z.string().optional().describe('e.g. "decision" for "why X?"'),
        path: z.string().optional().describe("Only this branch"),
        limit: z.number().int().min(1).max(50).default(10),
        budget: z.number().int().positive().optional(),
        project: LINKED,
        archived: z.boolean().optional().describe("Include archived records (a problem solved before?)"),
        actor: z.string().optional().describe("Written by"),
        assignee: z.string().optional(),
        since: z.string().optional().describe("ISO date"),
        until: z.string().optional().describe("ISO date"),
      },
    },
    wrap(
      (
        a: { q: string; kind?: DocKind[]; type?: string; path?: string; limit: number; budget?: number; project?: string; archived?: boolean } & Record<
          string,
          unknown
        >,
      ) =>
        get("/search", {
          q: a.q,
          kind: a.kind,
          type: a.type,
          path: a.path,
          limit: a.limit,
          budget: a.budget,
          project: a.project,
          archived: a.archived,
          actor: a.actor,
          assignee: a.assignee,
          since: a.since,
          until: a.until,
        }),
    ),
  );

  tool(
    "cortex_update_node",
    {
      description:
        "Create or update a knowledge node (parents first). To change part of a big node, send only that part: section " +
        '"<heading>" replaces (or adds) that part, body_mode "append" adds to the end; title, summary and links you ' +
        "leave out stay. May become a draft a person approves. Unsure of a write that would apply directly? Pass review: true.",
      inputSchema: {
        path: z.string(),
        title: z.string().max(120).optional().describe("Required for a new node"),
        summary: z.string().max(300).optional().describe("What another AI reads first; required for a new node"),
        body: z.string().default(""),
        section: z.string().max(200).optional().describe("Heading whose part `body` replaces"),
        body_mode: z.enum(["replace", "append"]).optional(),
        confirm_shrink: z.boolean().optional().describe("Cutting the body to less than half is meant"),
        tags: z.array(z.string()).optional(),
        code_files: z.array(z.object({ file: z.string(), lines: z.string().optional(), symbol: z.string().min(1).optional() })).optional(),
        verified_at_commit: z.string().optional(),
        reason: z.string().describe("Why"),
        review: z.boolean().optional(),
      },
    },
    wrap((a: { path: string; code_files?: { file: string; lines?: string; symbol?: string }[] } & Record<string, unknown>) => {
      const { code_files, path: p, ...rest } = a;
      return api.call("PUT", `/node${path(p)}`, { body: { ...rest, ...(code_files ? { links: { code: code_files } } : {}) } });
    }),
  );

  tool(
    "cortex_rules",
    {
      description: "Read the project rules and schemas set by humans. Only needed when _meta.rules_version changed or a write was rejected.",
      inputSchema: { name: z.string().optional().describe('e.g. "node" or "_global". Omit for all.') },
    },
    wrap((a: { name?: string }) => get(a.name ? `/rules/${encodeURIComponent(a.name)}` : "/rules")),
  );

  // ---- items ----------------------------------------------------------------

  tool(
    "cortex_inbox",
    {
      description: "What waits on you: items assigned to you or @ai, answers to your questions, new replies on your items.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
    },
    wrap(async (a: { limit: number }) => {
      const r = (await get("/inbox", { limit: a.limit })) as Record<string, unknown>;
      if (!api.human) delete r.ask_humans;
      return r;
    }),
  );

  tool(
    "cortex_items",
    {
      description:
        "List items (task, issue, question, note, decision or custom types). Filter to keep it small. " +
        "With preview=true each row also carries a short gist of the body and the last reply (who, when, status change), " +
        'which usually answers "what is open and who moves next" without opening items one by one.',
      inputSchema: {
        type: z.string().optional(),
        status: z.string().optional(),
        assignee: z.string().optional().describe('Actor id, "@humans" or "@ai"'),
        author: z.string().optional(),
        path: z.string().optional().describe("Items filed under this knowledge branch"),
        open: z.boolean().optional().describe("true = not in a terminal status"),
        since: z.string().optional().describe("Changed on or after (ISO date)"),
        until: z.string().optional().describe("Changed before (ISO date)"),
        milestone: z.string().optional().describe('Tasks and issues of this milestone, e.g. "v0.5"'),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().optional(),
        preview: z.boolean().optional().describe("Add a short body gist and the last reply to each row"),
        project: LINKED,
      },
    },
    wrap((a: Record<string, unknown>) => get("/items", a)),
  );

  tool(
    "cortex_item",
    {
      description:
        "Read an item with its replies (newest kept when trimmed). `ids` reads several at once. " +
        "Any item id may be the short id the board shows (its last 6 characters, e.g. ZKFBA9).",
      inputSchema: {
        id: z.string().optional(),
        ids: z.array(z.string()).min(1).max(MAX_BATCH_ITEMS).optional().describe(`Up to ${MAX_BATCH_ITEMS}`),
        replies: z.number().int().min(0).max(200).optional().describe("Last N only"),
        budget: z.number().int().positive().optional().describe("Max tokens per item"),
        project: LINKED,
      },
    },
    wrap(async (a: { id?: string; ids?: string[]; replies?: number; budget?: number; project?: string }) => {
      const one = (id: string) => get(`/items/${encodeURIComponent(id)}`, { replies: a.replies, budget: a.budget, project: a.project });
      if (!a.ids) {
        if (!a.id) throw new CortexError("validation", "Give `id` or `ids`.");
        return one(a.id);
      }
      // One missing or hidden item must not cost the others: its row carries the error instead.
      const ids = [...new Set([...(a.id ? [a.id] : []), ...a.ids])];
      let meta: unknown;
      const rows = await Promise.all(
        ids.map((id) =>
          one(id).then(
            // _meta once for the whole answer, not once per item.
            (r) => {
              const { _meta, ...rest } = r as { _meta?: unknown };
              meta = _meta;
              return rest;
            },
            (e: unknown) => ({ id, error: e instanceof CortexError ? { code: e.code, message: e.message } : { code: "internal", message: String(e) } }),
          ),
        ),
      );
      return { items: rows, ...(meta ? { _meta: meta } : {}) };
    }),
  );

  tool(
    "cortex_item_file",
    {
      description:
        "Read a file attached to an item (cortex_item lists them under `attachments`): Markdown and text come back as text, " +
        "screenshots and other pictures as an image you can look at. Other files are described, not returned.",
      inputSchema: { id: z.string(), name: z.string().describe("The file name exactly as listed in attachments") },
    },
    async (a: { id: string; name: string }) => {
      try {
        const type = mediaType(a.name);
        const data = (await api.call("GET", `/items/${encodeURIComponent(a.id)}/files/${encodeURIComponent(a.name)}`, { binary: true })) as Buffer;
        if (isSafeImage(type) && data.length <= MAX_IMAGE_BYTES) {
          return { content: [{ type: "image" as const, data: data.toString("base64"), mimeType: type }] };
        }
        if (isText(type)) {
          const text = data.toString("utf8");
          const cut = text.length > MAX_TEXT_CHARS;
          return result({
            name: a.name,
            type,
            ...(cut ? { truncated: true, total_chars: text.length } : {}),
            text: cut ? text.slice(0, MAX_TEXT_CHARS) : text,
          });
        }
        return result({ name: a.name, type, size: data.length, note: "Not a text file or a picture this tool can show." });
      } catch (e) {
        const err = e instanceof CortexError ? { code: e.code, message: e.message, hint: e.hint } : { code: "internal", message: String(e) };
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: err }) }] };
      }
    },
  );

  tool(
    "cortex_create_item",
    {
      description:
        "Create a task, issue, question, note or decision. Type fields go in `fields`; cortex_brief rules.item_types says what " +
        'each needs ("decision(context)": fields.context required). A rejected write returns the rules, an example and errors per field.',
      inputSchema: {
        type: z.string().describe("task | issue | question | note | decision | custom"),
        title: z.string().max(160),
        body: z.string().default(""),
        category_path: z.string().optional().describe("Knowledge branch"),
        assignee: z.string().optional().describe('Actor id, "@humans" or "@ai"'),
        tags: z.array(z.string()).optional(),
        links: z
          .object({
            nodes: z.array(z.string()).optional(),
            items: z.array(z.string()).optional(),
            activity: z.array(z.string()).optional(),
            code: z.array(z.object({ file: z.string(), lines: z.string().optional() })).optional(),
          })
          .optional(),
        fields: z.record(z.string(), z.unknown()).default({}),
        reply_required: z.boolean().optional().describe("Finishing needs a reply saying what was done (default on for tasks and issues)"),
        reason: z.string().optional(),
      },
    },
    wrap((a: CreateItemInput) => api.call("POST", "/items", { body: a })),
  );

  tool(
    "cortex_update_item",
    {
      description:
        "Change status (allowed transitions), assignee, title, body or fields (merged; null removes). To finish work use " +
        'cortex_reply with `status` instead. body_mode "append" adds only the new text; a replace dropping over half the body ' +
        "fails (body_shrink). Versions are kept.",
      inputSchema: {
        id: z.string(),
        status: z.string().optional(),
        title: z.string().max(160).optional(),
        body: z.string().optional(),
        body_mode: z.enum(["replace", "append"]).optional(),
        confirm_shrink: z.boolean().optional().describe("Dropping over half the body is intended"),
        assignee: z.string().nullable().optional(),
        category_path: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
        fields: z.record(z.string(), z.unknown()).optional(),
        reason: z.string().optional(),
        if_rev: z.string().optional().describe("_rev from cortex_item: fails (409) if it changed since"),
      },
    },
    wrap(({ id, ...rest }: { id: string } & UpdateItemInput) => api.call("PATCH", `/items/${encodeURIComponent(id)}`, { body: rest })),
  );

  tool(
    "cortex_claim",
    {
      description:
        "Claim an item you are working on now, or release it. Unlike `assignee`, it keeps other agents from colliding with you. " +
        "A claim someone else holds fails (409) unless it is stale (2h).",
      inputSchema: {
        id: z.string(),
        action: z.enum(["claim", "release"]),
        note: z.string().max(500).optional().describe("Handoff: where you left off"),
        force: z.boolean().optional().describe("Humans only"),
      },
    },
    wrap(({ id, ...rest }: { id: string } & ClaimInput) => api.call("POST", `/items/${encodeURIComponent(id)}/claim`, { body: rest })),
  );

  tool(
    "cortex_reply",
    {
      description:
        "Reply on an item. This is how you finish work: `status` (e.g. review) moves it in the same step. Handing work in, " +
        'write a 1-3 line summary first, then "To test:" (in the project language) with a - [ ] list the board shows the ' +
        "person, then details. Reply fields follow the type's rules (a fixed issue needs commits and files).",
      inputSchema: {
        id: z.string(),
        body: z.string().min(1),
        fields: z.record(z.string(), z.unknown()).default({}),
        status: z.string().optional().describe("Move it in the same step"),
      },
    },
    wrap(({ id, ...rest }: { id: string } & ReplyInput) => api.call("POST", `/items/${encodeURIComponent(id)}/replies`, { body: rest })),
  );

  tool(
    "cortex_ask",
    {
      description: "Ask about an activity entry, item or node; it goes to whoever made it. Ask instead of guessing; blocking=true if you cannot go on.",
      inputSchema: {
        about: z.string().describe("Activity id, item id or node path"),
        title: z.string().max(160).describe("The question"),
        body: z.string().optional(),
        assignee: z.string().optional().describe("Who answers instead"),
        blocking: z.boolean().optional(),
      },
    },
    wrap((a: { about: string; title: string; body?: string; assignee?: string; blocking?: boolean }) => api.call("POST", "/ask", { body: a })),
  );

  tool(
    "cortex_report",
    {
      description:
        "Project report for a period: what changed and why, decisions, closed issues, what is waiting on people, knowledge health, " +
        'per-actor approval rates. Counted from the files, not generated. Use it to brief a human, e.g. "what happened this week?".',
      inputSchema: {
        since: z.string().default("7d").describe("7d, 2w, 30d, a date (2026-09-01) or ISO datetime"),
        until: z.string().optional(),
        format: z.enum(["json", "markdown"]).default("json"),
        lang: z.enum(["en", "tr"]).default("en").describe("Language of the markdown output"),
      },
    },
    wrap(async (a: { since: string; until?: string; format: "json" | "markdown"; lang: "en" | "tr" }) => {
      if (a.format !== "markdown") return get("/report", { since: a.since, until: a.until });
      const markdown = await api.call("GET", "/report", { query: { since: a.since, until: a.until, format: "md", lang: a.lang }, text: true });
      return { markdown };
    }),
  );

  // ---- archive ---------------------------------------------------------------

  tool(
    "cortex_archive",
    {
      description:
        "Keep memory lean: take knowledge and records that no longer apply out of search, the brief and the tree " +
        "(a solved one-off server problem, a superseded decision, a branch for code that is gone). " +
        "action 'candidates' lists finished items untouched for a while and deprecated knowledge. " +
        "action 'propose' archives refs (item ids or knowledge paths) with a reason; from an AI it becomes drafts a person approves. " +
        "Only finished items can be archived (an accepted decision still applies). Archived records stay in the files and in " +
        "cortex_search with archived: true. Never propose archiving something only because it is old: say why it no longer applies.",
      inputSchema: {
        action: z.enum(["candidates", "propose"]),
        refs: z.array(z.string()).max(50).optional().describe("For propose: item ids or knowledge paths"),
        reason: z.string().max(500).optional().describe("For propose: why these no longer apply (required from an AI)"),
      },
    },
    wrap((a: { action: "candidates" | "propose"; refs?: string[]; reason?: string }) =>
      a.action === "candidates" ? get("/archive/candidates") : api.call("POST", "/archive", { body: { refs: a.refs ?? [], reason: a.reason } }),
    ),
  );

  // ---- discussions -----------------------------------------------------------

  tool(
    "cortex_discussions",
    {
      description:
        'Discussions: questions people and AI agents argue out before a person decides (e.g. "MySQL instead of PostgreSQL?"). ' +
        "Lists them with their options, who posted, who is still waited on and, once views are visible, the vote count. " +
        '`asks_you` marks the ones waiting on your view. Read one with cortex_item; open one with cortex_create_item type "discussion".',
      inputSchema: { open: z.boolean().optional().describe("true = only discussions still running or waiting for a decision") },
    },
    wrap((a: { open?: boolean }) => get("/discussions", { open: a.open })),
  );

  tool(
    "cortex_discuss",
    {
      description:
        "Post your view in a discussion; back every claim with evidence from the code or Cortex. opinion: back one option (once; a " +
        "blind round shows others after you post); rebuttal: answer a view while deliberating (a new stance changes your vote); " +
        "synthesis: weigh all, no vote; comment. Only people decide.",
      inputSchema: {
        id: z.string().describe("Discussion id"),
        kind: z.enum(["opinion", "rebuttal", "synthesis", "comment"]).default("opinion"),
        stance: z.string().optional().describe("The option, exactly as written (opinion)"),
        confidence: z.enum(["low", "medium", "high"]).optional().describe("opinion"),
        evidence: z.array(z.string()).max(30).optional().describe('"src/db/pool.ts:12-40", node path or item id (opinion)'),
        body: z.string().min(1).describe("Your reasoning"),
      },
    },
    wrap(({ id, body, ...f }: { id: string; body: string; kind: string; stance?: string; confidence?: string; evidence?: string[] }) => {
      const fields = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
      return api.call("POST", `/items/${encodeURIComponent(id)}/replies`, { body: { body, fields } });
    }),
  );

  tool(
    "cortex_close_vote",
    {
      description:
        "Count a discussion's votes (each participant's latest stance). A clear majority becomes a proposed decision a person accepts; " +
        "a tie leaves the call to a person. Do this only when asked, or when every invited participant has posted and it is deliberating.",
      inputSchema: { id: z.string() },
    },
    wrap((a: { id: string }) => api.call("POST", `/discussions/${encodeURIComponent(a.id)}/close-vote`, {})),
  );

  // ---- activity -------------------------------------------------------------

  tool(
    "cortex_update_status",
    {
      description:
        "Rewrite the project status (where it stands, just finished, next, blocked): the handoff between sessions, shown in " +
        "cortex_brief. Update it before ending a session with meaningful changes.",
      inputSchema: {
        body: z.string().min(1).max(8000).describe("The whole status (Markdown); keep what still holds"),
        reason: z.string().max(200).optional(),
      },
    },
    wrap((a: { body: string; reason?: string }) => api.call("PUT", "/status", { body: a })),
  );

  tool(
    "cortex_log_activity",
    {
      description:
        "Log what you did and WHY after each meaningful change; people read this feed. With files, say for each accepted " +
        "decision governing them (decisions_to_check) whether you followed it; unanswered ones are shown to people.",
      inputSchema: {
        action: z.string().describe("code_change | fix | refactor | investigation | config | deploy | docs | other"),
        summary: z.string().max(200).describe("One line"),
        why: z.string().optional().describe("Required for code_change, fix, refactor, config, deploy"),
        files: z.array(z.string()).optional(),
        commit: z.string().optional(),
        commits: z.array(z.string()).optional(),
        refs: z.array(z.string()).optional().describe("Item ids or node paths"),
        decisions: z
          .array(z.object({ id: z.string(), verdict: z.enum(VERDICTS), note: z.string().max(500).optional() }))
          .max(50)
          .optional()
          .describe("followed, broken (note why) or n/a each. A reported break is fine, a hidden one is not."),
      },
    },
    wrap((a: ActivityInput) => api.call("POST", "/activity", { body: a })),
  );

  // Finishing a piece of work took five or six calls (log, reply with status, an extra status step on
  // issues, release the claim, project status). One call does them in order and stops at the first
  // failure, saying what was done and what is left (task 01M3P486P1DGPGGS3Y48SCR39J).
  tool(
    "cortex_finish",
    {
      description:
        "Finish a piece of work in one call: logs it (like cortex_log_activity), replies on the card with `reply` and moves it " +
        "to `status` (through the steps between if the rules need them), releases your claim, and rewrites the project status " +
        "if given. Stops at the first failure and says which steps are done and which are left.",
      inputSchema: {
        item: z.string().optional().describe("The card this work finishes"),
        action: z.string().default("code_change").describe("code_change | fix | refactor | investigation | config | deploy | docs | other"),
        summary: z.string().max(200).describe("One line"),
        why: z.string().optional(),
        files: z.array(z.string()).optional(),
        commits: z.array(z.string()).optional(),
        refs: z.array(z.string()).optional(),
        decisions: z
          .array(z.object({ id: z.string(), verdict: z.enum(VERDICTS), note: z.string().max(500).optional() }))
          .max(50)
          .optional()
          .describe("As in cortex_log_activity"),
        reply: z.string().optional().describe('Shown on the card: 1-3 line summary, "To test:" with a - [ ] list, then details'),
        reply_fields: z.record(z.string(), z.unknown()).optional().describe("The type's reply fields; commits and files fill them when left out"),
        status: z.string().optional().describe('Where the card goes, e.g. "review"'),
        project_status: z.string().max(8000).optional().describe("The whole new project status (cortex_update_status)"),
      },
    },
    wrap(async (a: FinishInput) => finish(api, a)),
  );

  tool(
    "cortex_answer_rules",
    {
      description: "Answer the decision check left open on work you logged: followed, broken (note why) or n/a each.",
      inputSchema: {
        activity_id: z.string(),
        decisions: z
          .array(z.object({ id: z.string(), verdict: z.enum(VERDICTS), note: z.string().max(500).optional() }))
          .min(1)
          .max(50),
      },
    },
    wrap((a: { activity_id: string; decisions: unknown[] }) =>
      api.call("POST", `/activity/${encodeURIComponent(a.activity_id)}/rules`, { body: { decisions: a.decisions } }),
    ),
  );

  tool(
    "cortex_activity",
    {
      description: "Read the activity feed (newest first). Filter by actor, related item/node, or time.",
      inputSchema: {
        since: z.string().optional().describe("ISO date or datetime"),
        until: z.string().optional().describe("Before this ISO date or datetime"),
        before: z.string().optional().describe("next_cursor of the previous page: older entries"),
        actor: z.string().optional(),
        ref: z.string().optional().describe("Item id or node path"),
        include_system: z.boolean().optional().describe("Include Cortex's own audit entries"),
        limit: z.number().int().min(1).max(200).default(20),
      },
    },
    wrap((a: Record<string, unknown>) => get("/activity", a)),
  );

  // ---- approvals in the chat ----------------------------------------------------

  // Only where there is a person to ask (a local project with a human actor); a team server has none yet.
  if (api.human) registerApprovalTools(server, api, opts);

  return server;
}

export async function runMcpStdio(api: McpApi, opts: McpOptions = {}): Promise<void> {
  const server = buildMcpServer(api, opts);
  await server.connect(new StdioServerTransport());
}
