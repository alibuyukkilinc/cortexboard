import { fireEvent, render } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { parseChecklist } from "../../src/core/checklist";
import { Markdown } from "../src/ui";

const body = "## Steps\n- [x] Design\n- [ ] Build\n  - [ ] API\n\n```\n- [ ] not a step\n```\n\n> - [ ] quoted";

describe("task boxes in Markdown", () => {
  test("are read-only without a handler", () => {
    const { container } = render(<Markdown text={body} />);
    const boxes = [...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    expect(boxes.length).toBe(4);
    expect(boxes.every((b) => b.disabled)).toBe(true);
  });

  test("tick the source line they stand for, nested and quoted ones included", () => {
    const onToggle = vi.fn();
    const lines = parseChecklist(body).map((b) => b.line);
    expect(lines).toEqual([1, 2, 3, 9]);
    const { container } = render(<Markdown text={body} checklist={{ lines, onToggle }} />);
    const boxes = container.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect([...boxes].every((b) => !b.disabled)).toBe(true);
    fireEvent.click(boxes[2]);
    expect(onToggle).toHaveBeenCalledWith(3, true);
    fireEvent.click(boxes[3]);
    expect(onToggle).toHaveBeenLastCalledWith(9, true);
  });

  test("stay read-only when the rendered boxes do not match the source", () => {
    const { container } = render(<Markdown text={body} checklist={{ lines: [1, 2], onToggle: () => {} }} />);
    expect([...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].every((b) => b.disabled)).toBe(true);
  });
});
