import { createContext, useContext, type ReactNode } from "react";
import { useApi } from "./api";

// What waits on this person, from one small request (GET /api/counts) that every screen shares: the sidebar
// badges and the board's type tabs. Refreshed when an item, draft, node or staleness changes.
export interface Counts {
  inbox: number;
  approvals: number;
  stale: number;
  discussions?: number;
  waiting?: Record<string, number>; // items waiting on you, per type
}

const CountsContext = createContext<Counts | null>(null);

export function CountsProvider({ children }: { children: ReactNode }) {
  const { data } = useApi<Counts>("/api/counts", { on: ["item", "draft", "node", "stale", "git"] });
  return <CountsContext.Provider value={data}>{children}</CountsContext.Provider>;
}

export const useCounts = () => useContext(CountsContext);
