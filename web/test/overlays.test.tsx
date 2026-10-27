import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, test } from "vitest";
import { Drawer, Modal } from "../src/ui";

function Opener({ kind }: { kind: "modal" | "drawer" }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const content = (
    <>
      <input aria-label="first field" />
      <button type="button">last button</button>
    </>
  );
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      {open &&
        (kind === "modal" ? (
          <Modal title="Dialog" onClose={close}>
            {content}
          </Modal>
        ) : (
          <Drawer head={<h2>Dialog</h2>} onClose={close}>
            {content}
          </Drawer>
        ))}
    </>
  );
}

describe.each(["modal", "drawer"] as const)("%s keeps keyboard focus", (kind) => {
  test("focus moves into the dialog when it opens", async () => {
    const user = userEvent.setup();
    render(<Opener kind={kind} />);
    await user.click(screen.getByText("open"));
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  test("Tab wraps from the last control to the first, Shift+Tab the other way", async () => {
    const user = userEvent.setup();
    render(<Opener kind={kind} />);
    await user.click(screen.getByText("open"));
    const dialog = screen.getByRole("dialog");
    const close = screen.getByRole("button", { name: "Close" }); // the header's close button comes first
    const last = screen.getByText("last button");

    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  test("closing gives focus back to the control that opened it", async () => {
    const user = userEvent.setup();
    render(<Opener kind={kind} />);
    const opener = screen.getByText("open");
    await user.click(opener);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
