import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Fold, Markdown } from "../src/ui";

describe("reading aids in Markdown", () => {
  test("code blocks get a copy button, tables a scrollable region, acceptance criteria a box", () => {
    const text = [
      "## Goal",
      "Ship it.",
      "",
      "```bash",
      "npm test",
      "```",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "## Kabul ölçütü",
      "- Opens in Excel",
      "### Detail",
      "still part of it",
      "## Notes",
      "after it",
    ].join("\n");
    const { container } = render(<Markdown text={text} />);
    expect(container.querySelector(".code-block pre")?.textContent).toContain("npm test");
    expect(screen.getByRole("button", { name: /copy code/i })).toBeTruthy();
    const region = container.querySelector(".table-wrap");
    expect(region?.getAttribute("role")).toBe("region");
    expect(region?.getAttribute("tabindex")).toBe("0");
    const box = container.querySelector("section.acceptance");
    expect(box?.textContent).toContain("Opens in Excel");
    expect(box?.textContent).toContain("still part of it");
    expect(box?.textContent).not.toContain("after it");
  });

  test("a long reply folds and opens", () => {
    render(
      <Fold long>
        <p>Long text</p>
      </Fold>,
    );
    const toggle = screen.getByRole("button", { name: /show all/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: /show less/i }).getAttribute("aria-expanded")).toBe("true");
  });
});
