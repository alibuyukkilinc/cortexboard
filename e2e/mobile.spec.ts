import { expect, open, SCREENS, test } from "./fixtures";

// UI-12: every screen at 375px, the width the plan sets as the floor. Pixel baselines are OS-bound (CI renders on
// Linux), so the regressions checked here are the layout ones that break a phone whatever the fonts:
// nothing scrolls sideways, and every control is a touch target of at least 44px.
const TOUCH = 44;

for (const route of SCREENS) {
  test(`${route} fits a phone`, async ({ board }, info) => {
    test.skip(!info.project.name.startsWith("phone"), "phone widths only");
    await open(board, route);
    const r = await board.evaluate((touch) => {
      const main = document.querySelector("main.main") as HTMLElement;
      const wide = [...main.querySelectorAll<HTMLElement>("*")]
        .filter((e) => !e.closest(".sr-only") && !e.closest("[data-scroll-x]") && e.getBoundingClientRect().right > main.getBoundingClientRect().right + 1)
        .slice(0, 5)
        .map((e) => `${e.tagName.toLowerCase()}.${e.className}`);
      const controls = [...document.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [role=button], [tabindex='0']")];
      const small = controls
        .filter((e) => {
          const b = e.getBoundingClientRect();
          if (!b.width || !b.height || e.closest(".sr-only") || e.closest("[data-scroll-x]")) return false;
          // Links and glossary terms inside running text are exempt (WCAG 2.5.8): the sentence is the target.
          if ((e.tagName === "A" && e.closest("p, li, td, .md")) || e.tagName === "ABBR") return false;
          // A card title's ::after covers the card; a chip's stretches to a fingertip.
          const after = getComputedStyle(e, "::after");
          if (after.content !== "none" && after.position === "absolute" && parseFloat(after.height) >= touch - 0.5) return false;
          if (e instanceof HTMLInputElement && (e.type === "checkbox" || e.type === "radio")) {
            const label = e.closest("label")?.getBoundingClientRect();
            return !label || label.height < touch - 0.5;
          }
          return b.height < touch - 0.5;
        })
        .slice(0, 40)
        .map(
          (e) =>
            `${e.tagName.toLowerCase()}.${e.className} "${(e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 24)}" ${Math.round(e.getBoundingClientRect().height)}px`,
        );
      return { page: document.documentElement.scrollWidth - innerWidth, main: main.scrollWidth - main.clientWidth, wide, small };
    }, TOUCH);
    expect(r.page, "the page scrolls sideways").toBeLessThanOrEqual(0);
    expect(r.main, `main scrolls sideways: ${r.wide.join(", ")}`).toBeLessThanOrEqual(1);
    expect(r.small, "controls smaller than a fingertip").toEqual([]);
  });
}
