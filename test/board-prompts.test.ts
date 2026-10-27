import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CSRF_HEADER, SESSION_COOKIE, createLoginCode } from "../src/api/auth.js";
import { buildServer } from "../src/api/server.js";
import type { FormSchema, PromptPlan } from "../src/core/chatPrompts.js";
import { tempProject } from "./helpers.js";

const YES_NO: FormSchema = { type: "object", properties: { answer: { type: "string", enum: ["yes", "no"] }, note: { type: "string" } }, required: ["answer"] };

function reviewTask(t: ReturnType<typeof tempProject>) {
  const task = t.cortex.items.create(t.ai, { type: "task", title: "Ship it", reply_required: false });
  t.cortex.items.update(t.ai, task.id, { status: "review" });
  return task.id;
}

const ask = (t: ReturnType<typeof tempProject>, plan: PromptPlan, schema = YES_NO) =>
  t.cortex.prompts.open(t.ai, { human: "owner", title: "close it?", message: "Close the card?", schema, plan, perm: "write_items" });

test("board prompts: only the person's own board session answers, never a token or the chat path", async () => {
  const t = tempProject();
  const app = buildServer(t.cortex);
  const host = { host: "localhost:4747" };
  try {
    const id = reviewTask(t);
    const ai = { ...host, authorization: `Bearer ${t.init.tokens["ai-agent"]}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/chat/prompts",
      headers: ai,
      payload: {
        human: "owner",
        session: "s1",
        title: "close it?",
        message: "Close the card?",
        schema: YES_NO,
        plan: { kind: "transition", target_id: id, to: "done" },
      },
    });
    assert.equal(created.statusCode, 201);
    const prompt = created.json().prompt;
    assert.equal(prompt.status, "open");
    assert.equal(prompt.perm, "write_items", "the server decides what the answer needs, not the AI");

    // The AI cannot answer its own question, nor can the person's API token (a process holds it).
    const byAi = await app.inject({ method: "POST", url: `/api/chat/prompts/${prompt.id}/answer`, headers: ai, payload: { answer: { answer: "yes" } } });
    assert.equal(byAi.statusCode, 403);
    const byToken = await app.inject({
      method: "POST",
      url: `/api/chat/prompts/${prompt.id}/answer`,
      headers: { ...host, authorization: `Bearer ${t.init.tokens.owner}` },
      payload: { answer: { answer: "yes" } },
    });
    assert.equal(byToken.statusCode, 403);
    assert.equal(byToken.json().error.code, "board_only");

    const login = await app.inject({ url: `/login?code=${createLoginCode("owner", t.init.tokens.owner)}`, headers: host });
    const key = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(String(login.headers["set-cookie"]))![1];
    const board = { ...host, cookie: `${SESSION_COOKIE}=${key}`, [CSRF_HEADER]: "1" };

    const waiting = await app.inject({ url: "/api/chat/prompts", headers: board });
    assert.deepEqual(
      waiting.json().prompts.map((p: { id: string }) => p.id),
      [prompt.id],
      "the person sees what waits for them",
    );
    const bad = await app.inject({ method: "POST", url: `/api/chat/prompts/${prompt.id}/answer`, headers: board, payload: { answer: { answer: "maybe" } } });
    assert.equal(bad.statusCode, 400, "only an answer the form allows");

    const done = await app.inject({ method: "POST", url: `/api/chat/prompts/${prompt.id}/answer`, headers: board, payload: { answer: { answer: "yes" } } });
    assert.equal(done.statusCode, 200);
    assert.equal(done.json().prompt.status, "answered");
    assert.equal(t.cortex.items.get(id).item.status, "done");
    const e = t.cortex.index.queryActivity({ includeSystem: true, limit: 20 }).find((x) => x.action === "item.replied")!;
    assert.equal(e.via?.channel, "board-prompt");
    assert.equal(e.via?.session, "s1");

    const again = await app.inject({ method: "POST", url: `/api/chat/prompts/${prompt.id}/answer`, headers: board, payload: { answer: { answer: "yes" } } });
    assert.equal(again.statusCode, 409);
    assert.equal((await app.inject({ url: "/api/chat/prompts", headers: board })).json().prompts.length, 0, "answered ones leave the list");
    const read = await app.inject({ url: `/api/chat/prompts/${prompt.id}`, headers: ai });
    assert.deepEqual(read.json().prompt.answer, { answer: "yes" }, "the AI reads the outcome");
  } finally {
    await app.close();
    t.cleanup();
  }
});

test("board prompts: expire after a day, at most five open per AI, kept out of git", () => {
  const t = tempProject();
  try {
    const id = reviewTask(t);
    const p = ask(t, { kind: "transition", target_id: id, to: "done" });
    const file = join(t.cortex.project.dir, ".prompts", `${p.id}.json`);
    writeFileSync(file, JSON.stringify({ ...p, expires_at: new Date(Date.now() - 1000).toISOString() }));
    assert.equal(t.cortex.prompts.get(p.id).status, "expired");
    assert.throws(() => t.cortex.prompts.answer(t.human, p.id, { answer: "yes" }), /expired/);
    assert.equal(t.cortex.items.get(id).item.status, "review");

    for (let i = 0; i < 5; i++) ask(t, { kind: "transition", target_id: id, to: "done" });
    assert.throws(() => ask(t, { kind: "transition", target_id: id, to: "done" }), /already wait on the board/);
    assert.throws(
      () => t.cortex.prompts.open(t.human, { human: "owner", title: "x", message: "x", schema: YES_NO, plan: { kind: "draft", ids: [] }, perm: "approve" }),
      /Only an AI/,
    );

    assert.match(readFileSync(join(t.cortex.project.dir, ".gitignore"), "utf8"), /^\.prompts\/$/m);
    assert.ok(
      t.cortex.index.queryActivity({ includeSystem: true, limit: 20 }).some((e) => e.action === "chat.prompt" && e.refs?.includes(id)),
      "asking is on the record, on the card's feed",
    );
  } finally {
    t.cleanup();
  }
});

test("board prompts: a capture confirmed on the board is written as the person's, active at once", () => {
  const t = tempProject();
  try {
    const p = ask(
      t,
      { kind: "capture", capture: { type: "decision", title: "Postgres only", body: "No MySQL.", fields: { context: "One database to run." } } },
      { type: "object", properties: { answer: { type: "string", enum: ["save", "discard"] } }, required: ["answer"] },
    );
    const done = t.cortex.prompts.answer(t.human, p.id, { answer: "save" });
    const saved = done.result as { saved: boolean; id: string };
    assert.equal(saved.saved, true);
    const d = t.cortex.items.get(saved.id).item;
    assert.equal(d.author, "owner");
    assert.equal(d.status, "accepted");
  } finally {
    t.cleanup();
  }
});

test("questions with options: real choices only, also in a project whose schema file predates them", () => {
  const t = tempProject();
  try {
    const q = (options: unknown) => t.cortex.items.create(t.ai, { type: "question", title: "Which DB?", assignee: "@humans", fields: { options } });
    const says = (re: RegExp) => (e: unknown) => re.test(JSON.stringify((e as { hint?: unknown }).hint));
    assert.throws(() => q(["Postgres"]), says(/at least two/));
    assert.throws(() => q(["Postgres", "postgres"]), says(/must be different/));
    assert.equal(q([]).applied, true, "empty: a free answer, as before");
    // A schema file written before options existed: the field is given on load, the file is left alone.
    const file = join(t.cortex.project.dir, "rules", "question.schema.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace(/\n  options:[\s\S]*?(?=\nreply:)/, ""));
    assert.doesNotMatch(readFileSync(file, "utf8"), /options/);
    assert.equal(q(["Postgres", "MySQL"]).applied, true);
  } finally {
    t.cleanup();
  }
});
