import { act, render } from "@testing-library/react";
import { useContext, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LoadGateContext } from "../src/api";
import { PageGate } from "../src/ui";

// A page appears once its first loads are done, not section by section (task 01M3NWY4D3T8TWF4N7GH41J6RV).
function Section({ ms, then }: { ms: number; then?: number }) {
  const gate = useContext(LoadGateContext);
  useEffect(() => {
    const end = gate!.begin();
    const t = setTimeout(() => {
      end();
      // A load that starts right after another ends (a list after its settings) is part of the same wait.
      if (then !== undefined) {
        const next = gate!.begin();
        setTimeout(next, then);
      }
    }, ms);
    return () => clearTimeout(t);
  }, [gate, ms, then]);
  return <p>section</p>;
}

const waiting = (c: HTMLElement) => c.querySelector(".page-gate")!.classList.contains("waiting");

describe("PageGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("hides the page until every first load is done, then shows it at once", () => {
    const { container } = render(
      <PageGate>
        <Section ms={100} />
        <Section ms={400} then={50} />
      </PageGate>,
    );
    expect(waiting(container)).toBe(true);
    act(() => void vi.advanceTimersByTime(150));
    expect(waiting(container)).toBe(true);
    expect(container.querySelector(".page-loader"), "no loader before 180 ms").toBeNull();
    act(() => void vi.advanceTimersByTime(50));
    expect(container.querySelector(".page-loader"), "a slow page gets the loader").not.toBeNull();
    act(() => void vi.advanceTimersByTime(210)); // the second section ended and began another
    expect(waiting(container)).toBe(true);
    act(() => void vi.advanceTimersByTime(120));
    expect(waiting(container)).toBe(false);
    expect(container.querySelector(".page-loader")).toBeNull();
  });

  test("a fast page never flashes the loader, and a page with nothing to load shows at once", () => {
    const fast = render(
      <PageGate>
        <Section ms={40} />
      </PageGate>,
    );
    act(() => void vi.advanceTimersByTime(110));
    expect(waiting(fast.container)).toBe(false);
    expect(fast.container.querySelector(".page-loader")).toBeNull();

    const empty = render(
      <PageGate>
        <p>static</p>
      </PageGate>,
    );
    act(() => void vi.advanceTimersByTime(70));
    expect(waiting(empty.container)).toBe(false);
  });

  test("a load that never ends does not hide the page forever", () => {
    function Stuck() {
      const gate = useContext(LoadGateContext);
      useEffect(() => void gate!.begin(), [gate]);
      return null;
    }
    const { container } = render(
      <PageGate>
        <Stuck />
      </PageGate>,
    );
    act(() => void vi.advanceTimersByTime(7900));
    expect(waiting(container)).toBe(true);
    act(() => void vi.advanceTimersByTime(200));
    expect(waiting(container)).toBe(false);
  });
});
