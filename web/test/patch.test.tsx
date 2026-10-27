import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { PatchView } from "../src/DiffView";

const patch = [
  "diff --git a/src/auth/token.ts b/src/auth/token.ts",
  "index 1111111..2222222 100644",
  "--- a/src/auth/token.ts",
  "+++ b/src/auth/token.ts",
  "@@ -1,3 +1,3 @@ export",
  " import x from 'y';",
  "-export const ttl = 15;",
  "+export const ttl = 60;",
  " export const b = 1;",
  "\\ No newline at end of file",
].join("\n");

describe("PatchView", () => {
  test("draws a git patch without its header, with line numbers from the hunk", () => {
    const { container } = render(<PatchView patch={patch} />);
    expect(container.textContent).not.toContain("index 1111111");
    expect(container.querySelector(".dhunk")?.textContent).toContain("@@ -1,3 +1,3 @@");
    const del = container.querySelector(".dl.del");
    const add = container.querySelector(".dl.add");
    expect(del?.textContent).toContain("export const ttl = 15;");
    expect(del?.querySelector(".dn")?.textContent).toBe("2");
    expect(add?.querySelectorAll(".dn")[1]?.textContent).toBe("2");
    expect(container.textContent).not.toContain("No newline");
  });
});
