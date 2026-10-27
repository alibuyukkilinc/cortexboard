import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { DiffView } from "../src/DiffView";
import { useAsk } from "../src/ui";

const before = Array.from({ length: 500 }, (_, i) => `Line ${i} says something about the cache.`).join("\n");
const after = before
  .split("\n")
  .map((l, i) => (i % 25 === 0 ? l.replace("cache", "queue") : l))
  .join("\n");

describe("DiffView", () => {
  // Drawing time is measured in a real browser (see the UI-2 card); here: folding keeps a long page's DOM
  // to the changed lines and their context, in both views.
  test("a 500-line page with 20 changed lines draws only those and their context", () => {
    for (const mode of ["unified", "split"] as const) {
      const { container, unmount } = render(<DiffView before={before} after={after} mode={mode} />);
      expect(container.querySelectorAll(".dl.del, .dl.add").length).toBe(40);
      expect(container.querySelectorAll(".dl.same").length, mode).toBeLessThanOrEqual(mode === "unified" ? 20 * 6 : 20 * 6 * 2);
      unmount();
    }
  });

  test("changed words are marked inside the changed line; unchanged runs fold and open", async () => {
    const { container } = render(
      <DiffView before={"a\nb\nc\nd\ne\nf\ng\nh\ni\nRedis, 5 min TTL."} after={"a\nb\nc\nd\ne\nf\ng\nh\ni\nRedis, 10 min TTL."} mode="unified" />,
    );
    expect([...container.querySelectorAll("del:not(.whole)")].map((e) => e.textContent)).toEqual(["5"]);
    expect([...container.querySelectorAll("ins:not(.whole)")].map((e) => e.textContent)).toEqual(["10"]);
    const fold = screen.getByRole("button", { name: /6/ });
    await userEvent.click(fold);
    expect(screen.queryByRole("button", { name: /6/ })).toBeNull();
    expect(container.querySelectorAll(".dl.same").length).toBe(9);
  });

  test("side by side puts a line and its replacement on one row", () => {
    const { container } = render(<DiffView before={"x\nold line"} after={"x\nnew line"} mode="split" />);
    const pair = [...container.querySelectorAll(".dpair")].find((p) => p.querySelector(".dl.del"));
    expect(pair?.querySelector(".dl.add")?.textContent).toContain("new");
  });
});

function Asker({ onAnswer }: { onAnswer: (v: string | null) => void }) {
  const { dialog, ask } = useAsk();
  return (
    <>
      <button onClick={() => void ask({ title: "Reject", input: { label: "Why?" }, confirm: "Reject" }).then(onAnswer)}>go</button>
      {dialog}
    </>
  );
}

describe("useAsk", () => {
  test("asks in a labelled dialog and resolves with the text, or null on cancel", async () => {
    const answers: (string | null)[] = [];
    render(<Asker onAnswer={(v) => answers.push(v)} />);
    await userEvent.click(screen.getByText("go"));
    await userEvent.type(screen.getByLabelText("Why?"), "  wrong page  ");
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await userEvent.click(screen.getByText("go"));
    expect(screen.getByRole("dialog", { name: "Reject" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(answers).toEqual(["wrong page", null]);
  });
});
