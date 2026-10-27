import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Markdown, linkRefs } from "../src/ui";

const id = (n: number) => `01M3FN2DTCVSN42RX5BWRRR${String(n).padStart(3, "0")}`.replace(/[ILOU]/g, "0");

describe("ids in Markdown", () => {
  test("become links in text and in a code span holding just the id, never inside a code block", () => {
    const html = linkRefs(
      `<p>See ${id(1)} and <code>${id(2)}</code>.</p><pre><code>${id(3)}</code></pre><p>X${id(4)}Y ${id(5)}</p><p><a href="#x">${id(6)}</a></p>`,
    );
    const box = document.createElement("div");
    box.innerHTML = html;
    expect([...box.querySelectorAll("a.ref")].map((a) => (a as HTMLElement).dataset.ref)).toEqual([id(1), id(2), id(5)]);
    expect(box.querySelector("pre a")).toBeNull();
    expect(box.querySelector("a.ref code")?.textContent).toBe(id(2));
  });

  afterEach(() => vi.unstubAllGlobals());

  test("30 ids in one text are previewed with one request", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        const ids = new URL(url, "http://x").searchParams.get("ids")!.split(",");
        const refs = Object.fromEntries(ids.map((i, k) => [i, { kind: "item", type: "task", title: `Task ${k}`, status: "todo" }]));
        return new Response(JSON.stringify({ refs }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const ids = Array.from({ length: 30 }, (_, i) => id(100 + i));
    const { container } = render(<Markdown text={ids.map((i) => `- ${i}`).join("\n")} />);
    const links = container.querySelectorAll<HTMLAnchorElement>("a.ref");
    expect(links.length).toBe(30);
    fireEvent.mouseOver(links[0]);
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    expect(await screen.findByText("Task 0")).toBeTruthy();
    fireEvent.mouseOut(links[0]);
    fireEvent.focusIn(links[7]);
    expect(await screen.findByText("Task 7")).toBeTruthy();
    expect(links[7].getAttribute("aria-describedby")).toBe("ref-preview");
    expect(calls.length).toBe(1);
  });
});
