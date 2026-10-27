import { useEffect, useId, useState } from "react";
import { api, qs, useApi } from "./api";
import type { Key } from "./i18n";
import { useT } from "./i18n";
import { go, Icon, useAsk, useSession, useToast } from "./ui";

// Filters live in the page's URL (#/board/issue?assignee=@ai&path=backend): a filtered page can be bookmarked,
// shared, reloaded, and saved as a view that opens the same on a phone and at a desk.

export function useRouteQuery(): [URLSearchParams, (patch: Record<string, string | undefined>) => void] {
  const read = () => new URLSearchParams(location.hash.split("?")[1] ?? "");
  const [params, setParams] = useState(read);
  useEffect(() => {
    const on = () => setParams(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  // Filters replace the history entry instead of adding one: Back leaves the page, not the last filter.
  const set = (patch: Record<string, string | undefined>) => {
    const [route] = location.hash.replace(/^#\/?/, "").split("?");
    const next = read();
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const q = next.toString();
    history.replaceState(null, "", `#/${route}${q ? `?${q}` : ""}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };
  return [params, set];
}

const TRANSIENT = ["before", "focus"];

type View = { id: string; name: string; page: "board" | "search" | "activity"; query: string };

// A person's saved views for this page, as chips that open them, and "Save view" for the filters now shown.
export function SavedViews({ page }: { page: View["page"] }) {
  const t = useT();
  const toast = useToast();
  const { dialog, ask } = useAsk();
  const { data, reload } = useApi<{ views: View[] }>("/api/views", { on: [] });
  const views = (data?.views ?? []).filter((v) => v.page === page);
  // A view keeps the filters, not where the reader was: the feed's page cursor and a focused entry stay out.
  useRouteQuery(); // re-render when the filters change
  const [route, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const kept = new URLSearchParams(query);
  for (const k of TRANSIENT) kept.delete(k);
  const current = kept.toString() ? `${route}?${kept}` : route;

  const save = async () => {
    const name = await ask({ title: t("views.save"), input: { label: t("views.name"), required: true, line: true, maxLength: 80 }, confirm: t("common.save") });
    if (!name) return;
    try {
      await api("/api/views", { method: "PUT", body: { name, page, query: current } });
      toast({ text: t("views.saved") });
      reload();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };
  const remove = async (v: View) => {
    try {
      await api(`/api/views/${v.id}`, { method: "DELETE" });
      reload();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };

  return (
    <div className="saved-views" role="group" aria-label={t("views.title")}>
      {views.map((v) => (
        <span key={v.id} className={`view-chip${v.query === current ? " on" : ""}`}>
          <button type="button" className="view-open" aria-current={v.query === current ? "true" : undefined} onClick={() => go(v.query)}>
            {v.name}
          </button>
          <button type="button" className="view-remove" aria-label={`${t("views.remove")}: ${v.name}`} onClick={() => void remove(v)}>
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
      <button type="button" className="btn sm ghost" onClick={() => void save()}>
        <Icon name="plus" size={14} /> {t("views.save")}
      </button>
      {dialog}
    </div>
  );
}

// A branch filter that asks the server (GET /api/branches?q=) instead of loading the whole tree: a text field
// with suggestions. An empty value means every branch.
export function BranchPicker({ value, onChange, label }: { value: string; onChange: (path: string) => void; label: string }) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const [q, setQ] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(text.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [text]);
  const { data } = useApi<{ branches: { path: string; title: string }[] }>(`/api/branches${qs({ q, limit: 20 })}`, { on: ["node"] });
  const commit = () => {
    const v = text.trim();
    if (v !== value) onChange(v);
  };
  return (
    <span className="branch-picker">
      <input
        className="input w-auto"
        list={`${id}-list`}
        value={text}
        placeholder={`${label}: ${t("board.all")}`}
        aria-label={label}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      <datalist id={`${id}-list`}>
        {data?.branches.map((b) => (
          <option key={b.path} value={b.path}>
            {b.title}
          </option>
        ))}
      </datalist>
    </span>
  );
}

// "Changed in the last 7 days", kept relative in the URL (updated=7d) so a saved view means the same next week.
// The server gets a date, not a moment, so the request stays the same all day and does not refetch.
export const UPDATED = ["1d", "7d", "30d", "90d"] as const;
export function sinceOf(updated: string | null): string | undefined {
  const days = /^(\d+)d$/.exec(updated ?? "")?.[1];
  if (!days) return undefined;
  return new Date(Date.now() - Number(days) * 864e5).toISOString().slice(0, 10);
}

export function UpdatedSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  return (
    <select className="select w-auto" value={value} onChange={(e) => onChange(e.target.value)} aria-label={t("filters.updated")}>
      <option value="">
        {t("filters.updated")}: {t("filters.anytime")}
      </option>
      {UPDATED.map((u) => (
        <option key={u} value={u}>
          {t(`filters.last.${u}` as Key)}
        </option>
      ))}
    </select>
  );
}

// A person filter; `groups` adds @humans and @ai, which only assignees use.
export function PersonSelect({ value, onChange, label, groups }: { value: string; onChange: (v: string) => void; label: string; groups?: boolean }) {
  const t = useT();
  const { actors } = useSession();
  return (
    <select className="select w-auto" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">
        {label}: {t("board.all")}
      </option>
      {groups && <option value="@humans">@humans</option>}
      {groups && <option value="@ai">@ai</option>}
      {actors.map((a) => (
        <option key={a.id}>{a.id}</option>
      ))}
    </select>
  );
}
