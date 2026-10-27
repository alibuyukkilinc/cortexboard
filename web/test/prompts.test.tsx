import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BoardPrompts } from "../src/BoardPrompts";
import type { BoardPrompt } from "../src/types";
import { SessionContext, ToastProvider } from "../src/ui";

// A question an AI asked on the board (decision 01M3PCTFYV4WPM0APNNJJ9YJQG): it pops up over any page,
// choosing an option sends nothing, closing it means "later", and the answer goes out only on Send.

const prompt: BoardPrompt = {
  id: "01M3PD84BTC7MD1AQZFQ9AMCNK",
  at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  ai_actor: "claude-code",
  human: "owner",
  title: "review → done: Ship it",
  message: "Cortex approval: task 01M3 → done\n\nPlan: ship on Friday.",
  schema: {
    type: "object",
    properties: { answer: { type: "string", title: "Your answer", enum: ["yes", "no"] }, note: { type: "string", title: "Note (optional)" } },
    required: ["answer"],
  },
  status: "open",
};

function setup(asked: BoardPrompt = prompt) {
  const posts: { url: string; body: unknown }[] = [];
  let open = [asked];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        open = [];
        return Response.json({ prompt: { ...asked, status: "answered" } });
      }
      return Response.json({ prompts: open });
    }),
  );
  const session = { me: { id: "owner", kind: "human" }, actors: [], can: () => true } as never;
  render(
    <ToastProvider>
      <SessionContext.Provider value={session}>
        <BoardPrompts>
          <p>page</p>
        </BoardPrompts>
      </SessionContext.Provider>
    </ToastProvider>,
  );
  return posts;
}

describe("questions asked on the board", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("shows the record, sends only on Send, with the chosen answer", async () => {
    const user = userEvent.setup();
    const posts = setup();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Plan: ship on Friday.");
    const send = screen.getByRole("button", { name: "Send answer" });
    expect(send).toHaveProperty("disabled", true);

    await user.click(screen.getByRole("radio", { name: "Yes" }));
    expect(posts).toHaveLength(0);
    await user.click(send);
    expect(posts).toEqual([{ url: `/api/chat/prompts/${prompt.id}/answer`, body: { answer: { answer: "yes" } } }]);
  });

  test("closing is 'later', never 'no': the question stays one click away", async () => {
    const user = userEvent.setup();
    const posts = setup();
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "AI questions waiting: 1" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  test("a question's own options, when long, are a list: one per line, picked then sent", async () => {
    const user = userEvent.setup();
    const posts = setup({
      ...prompt,
      schema: {
        type: "object",
        properties: {
          answer: { type: "string", title: "Your answer", enum: ["Keep Postgres and add a read replica", "Move to MySQL"] },
          note: { type: "string", title: "Note (optional)" },
        },
        required: ["answer"],
      },
    });
    const choice = await screen.findByRole("radio", { name: "Keep Postgres and add a read replica" });
    expect(choice.closest(".prompt-choices")).not.toBeNull();
    await user.click(choice);
    expect(posts).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    expect(posts[0].body).toEqual({ answer: { answer: "Keep Postgres and add a read replica" } });
  });
});
