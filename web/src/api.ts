import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public hint?: unknown,
  ) {
    super(message);
  }
}

// On a hub the board lives at /p/<project>/ and talks to /api/p/<project>/...; a single project uses /api/...
export const currentProject = (): string | null => /^\/p\/([^/]+)/.exec(location.pathname)?.[1] ?? null;
const HUB_LEVEL = /^\/api\/(auth|admin|hub|health|p)(\/|$)/; // /api/p/<id>/... already names its project

export function apiPath(path: string): string {
  const p = currentProject();
  if (!p || !path.startsWith("/api/") || HUB_LEVEL.test(path)) return path;
  return `/api/p/${encodeURIComponent(p)}${path.slice(4)}`;
}

// Cookie auth + the CSRF header the server requires on writes.
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(apiPath(path), {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: {
      "x-cortex-csrf": "1",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; hint?: unknown } }).error ?? {};
    throw new ApiError(res.status, e.code ?? "error", e.message ?? res.statusText, e.hint);
  }
  return data as T;
}

export const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
};

// What changed, as the server's live stream names it: the prefix of an audit entry's action ("item", "node",
// "draft", "archive", "rules", "discussion"), "log" for an entry someone wrote, or "stale", "git", "reindex".
export type LiveKind = "item" | "node" | "draft" | "archive" | "rules" | "log" | "stale" | "git" | "reindex" | "status" | "chat";

// Bumped whenever the server reports a change, with the kinds seen since the last bump.
export interface Live {
  version: number;
  kinds: ReadonlySet<string>;
}
export const LiveContext = createContext<Live>({ version: 0, kinds: new Set() });

// These change what every list shows, whatever the list asked for.
const EVERYTHING = new Set(["reindex", "archive", "rules"]);

// `on`: refetch only when one of these kinds changed (default: on every change). A list of items has no
// reason to reload, and a page of knowledge no reason to download the tree again, when an item moves.
// A page's first loads, counted so the page can appear once, finished, instead of section by section
// (task 01M3NWY4D3T8TWF4N7GH41J6RV). begin() returns the matching end(); after the page is shown it is a no-op.
export interface LoadGate {
  begin(): () => void;
}
export const LoadGateContext = createContext<LoadGate | null>(null);

export function useApi<T>(path: string | null, opts: { on?: LiveKind[] } = {}) {
  const live = useLiveVersion(opts.on);
  const gate = useContext(LoadGateContext);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const first = useRef(true);

  // Declared before the fetch effect so a new path shows the spinner again.
  useEffect(() => {
    first.current = true;
  }, [path]);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    // Only show a spinner on the first load; live refreshes swap data in place.
    if (first.current) setLoading(true);
    const end = first.current && gate ? gate.begin() : null;
    api<T>(path)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => !cancelled && setError(e))
      .finally(() => {
        end?.();
        if (!cancelled) {
          setLoading(false);
          first.current = false;
        }
      });
    return () => {
      cancelled = true;
      end?.();
    };
  }, [path, live, nonce, gate]);

  return { data, error, loading, reload };
}

// The live version this caller cares about: it moves only when a change of a kind in `on` arrives.
function useLiveVersion(on: LiveKind[] | undefined): number {
  const live = useContext(LiveContext);
  const mine = useRef({ seen: live.version, version: 0 });
  if (live.version !== mine.current.seen) {
    const wanted = !on || [...live.kinds].some((k) => EVERYTHING.has(k) || (on as string[]).includes(k));
    mine.current = { seen: live.version, version: mine.current.version + (wanted ? 1 : 0) };
  }
  return mine.current.version;
}
