import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { SchemaForm } from "../src/SchemaForm";

describe("SchemaForm", () => {
  test("shows the server's message beside the field it is about, tied to the input", () => {
    render(
      <SchemaForm
        fields={{ severity: { type: "enum", values: ["low", "high"], required: true }, steps: { type: "text" } }}
        value={{}}
        onChange={() => {}}
        actors={[]}
        errors={{ severity: "required" }}
      />,
    );
    const select = screen.getByRole("combobox");
    expect(select.getAttribute("aria-invalid")).toBe("true");
    const msg = document.getElementById(select.getAttribute("aria-describedby")!);
    expect(msg?.textContent).toBe("required");
    expect(screen.getAllByRole("textbox")[0].getAttribute("aria-invalid")).toBeNull();
  });
});
