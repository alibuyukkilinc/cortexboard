import { act, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Live, LiveKind } from "../src/api";
import { LiveContext, useApi } from "../src/api";

// A live change names what changed; a list refetches only when it shows that kind of record. One write
// should cost the open screen at most the requests that can actually differ (UI-1: at most two).

function List({ path, on }: { path: string; on?: LiveKind[] }) {
  useApi(path, on ? { on } : {});
  return null;
}

let bump: (kinds: string[]) => void = () => {};
function Board() {
  const [live, setLive] = useState<Live>({ version: 0, kinds: new Set() });
  bump = (kinds) => setLive((l) => ({ version: l.version + 1, kinds: new Set(kinds) }));
  return (
    <LiveContext.Provider value={live}>
      <List path="/api/items?type=task" on={["item"]} />
      <List path="/api/tree" on={["node"]} />
      <List path="/api/activity" />
    </LiveContext.Provider>
  );
}

describe("live refresh by kind", () => {
  const fetches: string[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    fetches.length = 0;
  });

  test("each list refetches only for the kinds it shows; rebuilds refresh everything", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetches.push(url);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    render(<Board />);
    await act(async () => {});
    expect(fetches.sort()).toEqual(["/api/activity", "/api/items?type=task", "/api/tree"]);

    const after = async (kinds: string[]) => {
      fetches.length = 0;
      await act(async () => bump(kinds));
      return [...fetches].sort();
    };
    expect(await after(["log"]), "a logged entry: only the list without a filter").toEqual(["/api/activity"]);
    expect(await after(["item"])).toEqual(["/api/activity", "/api/items?type=task"]);
    expect(await after(["node", "stale"])).toEqual(["/api/activity", "/api/tree"]);
    expect(await after(["reindex"])).toEqual(["/api/activity", "/api/items?type=task", "/api/tree"]);
  });
});
