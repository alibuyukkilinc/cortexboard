import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConnectGuide } from "../src/hub";

// The setup guide shown with an agent token and with a chat key: one dialog gives the whole command. The other
// secret is made right there with one button, or pasted.
const code = () => document.querySelector(".connect-cmd code")!.textContent!;
const calls: { url: string; method: string; body?: unknown }[] = [];

describe("ConnectGuide", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
        if (url === "/api/hub/me")
          return Response.json({
            hub_url: "https://hub.example.com",
            projects: [
              { id: "cortex", name: "Cortex" },
              { id: "shop", name: "Shop" },
            ],
          });
        if (url === "/api/hub/chat-tokens" && method === "POST") return Response.json({ secret: "chat_made" });
        if (url === "/api/p/cortex/members")
          return Response.json({
            members: [
              { principal: "ada", kind: "human", name: "Ada" },
              { principal: "ai-agent", kind: "ai", name: "AI agent" },
            ],
          });
        if (url === "/api/p/cortex/agents/ai-agent/token" && method === "POST") return Response.json({ token: "ctx_new" });
        return Response.json({ error: { code: "not_found", message: url } }, { status: 404 });
      }),
    );
    vi.stubGlobal("confirm", () => true);
  });
  afterEach(() => vi.unstubAllGlobals());

  test("with an agent token: the token is in the command, my chat key is made with one button", async () => {
    render(<ConnectGuide token="ctx_agent" project="shop" />);
    await waitFor(() => expect(code()).toContain("--hub https://hub.example.com"));
    expect(code()).toContain("--project shop --token ctx_agent");
    expect(code()).not.toContain("--human-token");
    fireEvent.click(screen.getByRole("button", { name: /chat key|sohbet anahtarımı/i }));
    await waitFor(() => expect(code()).toContain("--token ctx_agent --human-token chat_made"));
    expect(calls.find((c) => c.url === "/api/hub/chat-tokens")?.body).toEqual({ project: "shop", label: "Claude Code" });
    // A key already at hand can be pasted instead.
    fireEvent.change(document.getElementById("connect-chat-key")!, { target: { value: " chat_mine " } });
    expect(code()).toContain("--human-token chat_mine");
  });

  test("with a chat key: its project is fixed, and a lost agent token is replaced with one button", async () => {
    render(<ConnectGuide chatKey="chat_key" project="cortex" />);
    await waitFor(() => expect(code()).toContain("--hub https://hub.example.com"));
    expect(code()).toMatch(/--project cortex --token <\S+> --human-token chat_key$/);
    expect((document.getElementById("connect-project") as HTMLSelectElement).disabled).toBe(true);
    expect(document.querySelector(".hint.danger")).not.toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /ai-agent/ }));
    await waitFor(() => expect(code()).toContain("--token ctx_new --human-token chat_key"));
    expect(document.querySelector(".hint.danger")).toBeNull();
    expect(screen.getByText(/claude mcp remove cortex/)).toBeTruthy();
  });

  test("with several projects and none given: no command until one is picked", async () => {
    render(<ConnectGuide token="ctx_agent" />);
    const select = (await screen.findByRole("option", { name: /Cortex \(cortex\)/ })).closest("select")!;
    expect(select.value).toBe("");
    expect(document.querySelector(".connect-cmd")).toBeNull();
    expect(document.querySelector(".hint.danger")).not.toBeNull();
    expect((screen.getByRole("button", { name: /chat key|sohbet anahtarımı/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: "cortex" } });
    expect(code()).toContain("--project cortex --token ctx_agent");
  });

  test("the Claude and ChatGPT apps come first: only the project's address, steps per app, no token", async () => {
    render(<ConnectGuide token="ctx_agent" project="shop" />);
    const url = () => document.querySelector(".connect-url code")!.textContent!;
    await waitFor(() => expect(url()).toBe("https://hub.example.com/mcp/p/shop"));
    const steps = () => document.querySelector(".connect-app-steps")!.textContent!;
    expect(steps()).toMatch(/Add custom connector/);
    fireEvent.click(screen.getByRole("tab", { name: "ChatGPT" }));
    expect(steps()).toMatch(/Developer mode/);
    expect(document.querySelector(".connect-app")!.textContent).not.toContain("ctx_agent");
  });

  test("each AI tool gets its own ready setup, with steps behind a small button", async () => {
    render(<ConnectGuide token="ctx_agent" project="shop" />);
    await waitFor(() => expect(code()).toContain("--hub https://hub.example.com"));
    const tool = screen.getByRole("combobox", { name: /AI tool|AI aracı/ });
    const pick = (v: string) => fireEvent.change(tool, { target: { value: v } });

    pick("codex");
    expect(code()).toMatch(/^\[mcp_servers\.cortex\]\ncommand = "(npx|cmd)"\nargs = \[/);
    expect(code()).toContain('"--token", "ctx_agent"');
    fireEvent.click(screen.getByRole("tab", { name: /Windows/ }));
    expect(code()).toContain('command = "cmd"\nargs = ["/c", "npx", "-y", "cortexboard"');
    expect(screen.queryByText(/claude mcp remove cortex/)).toBeNull();

    pick("cursor");
    expect(JSON.parse(code()).mcpServers.cortex.command).toBe("cmd");
    pick("opencode");
    expect(JSON.parse(code()).mcp.cortex).toMatchObject({ type: "local", enabled: true });
    pick("http");
    expect(code()).toBe("URL: https://hub.example.com/mcp/p/shop\nAuthorization: Bearer ctx_agent");
    expect(screen.queryByRole("tab", { name: /Windows/ })).toBeNull();
    // With my chat key, a second header: approvals then come as questions on the board.
    fireEvent.click(screen.getByRole("button", { name: /chat key|sohbet anahtarımı/i }));
    await waitFor(() => expect(code()).toBe("URL: https://hub.example.com/mcp/p/shop\nAuthorization: Bearer ctx_agent\nX-Cortex-Human-Token: chat_made"));

    // The steps: a small button that opens them for the chosen tool.
    const help = screen.getByText(/How to add it|Nasıl eklenir/).closest("details")!;
    expect(help.querySelectorAll("li").length).toBeGreaterThan(2);
    expect(help.textContent).toMatch(/Authorization/);
  });
});
