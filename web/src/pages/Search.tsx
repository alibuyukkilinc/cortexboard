import { qs, useApi } from "../api";
import type { Key } from "../i18n";
import { useLabels, useT } from "../i18n";
import type { SearchHit } from "../types";
import { Ago, EmptyState, ErrorBox, go, ListRow, Loading, StatusChip, useSession } from "../ui";
import { BranchPicker, PersonSelect, SavedViews, UpdatedSelect, sinceOf, useRouteQuery } from "../filters";

const KINDS = ["node", "item", "activity"] as const;

interface SearchResponse {
  mode: "hybrid" | "keyword";
  semantic: { state: string; indexed: number; total: number };
  results: SearchHit[];
}

// Filters sit in the URL next to q (#/search?q=jwt&kind=item&type=decision&updated=30d), so a filtered search
// can be saved as a view and a new query from the top bar keeps them.
export function Search({ q }: { q: string }) {
  const t = useT();
  const label = useLabels();
  const { openItem, itemTypes } = useSession();
  const [params, setParams] = useRouteQuery();
  const kind = params.get("kind") ?? "";
  const type = params.get("type") ?? "";
  const actor = params.get("actor") ?? "";
  const assignee = params.get("assignee") ?? "";
  const updated = params.get("updated") ?? "";
  const path = params.get("path") ?? "";
  const { data, error, loading } = useApi<SearchResponse>(
    q ? `/api/search${qs({ q, kind, type, actor, assignee, path, since: sinceOf(updated), limit: 30 })}` : null,
  );

  const open = (h: SearchHit) => {
    if (h.draft_id) go("approvals");
    else if (h.kind === "node") go(`knowledge/${h.path}`);
    else if (h.kind === "item") openItem(h.id!);
    else go(`activity?focus=${h.id}`);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {t("search.title")} “{q}”
          </h1>
          {data && <SearchMode data={data} />}
        </div>
      </div>
      <div className="toolbar" role="group" aria-label={t("board.filters")}>
        <select
          className="select w-auto"
          value={kind}
          onChange={(e) => setParams({ kind: e.target.value, ...(e.target.value !== "item" ? { type: undefined, assignee: undefined } : {}) })}
          aria-label={t("filters.kind")}
        >
          <option value="">
            {t("filters.kind")}: {t("board.all")}
          </option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`filters.kind.${k}` as Key)}
            </option>
          ))}
        </select>
        {(kind === "" || kind === "item") && (
          <select
            className="select w-auto"
            value={type}
            onChange={(e) => setParams({ type: e.target.value, ...(e.target.value ? { kind: "item" } : {}) })}
            aria-label={t("board.type")}
          >
            <option value="">
              {t("board.type")}: {t("board.all")}
            </option>
            {itemTypes.map((x) => (
              <option key={x} value={x}>
                {label.type(x)}
              </option>
            ))}
          </select>
        )}
        <PersonSelect value={actor} onChange={(v) => setParams({ actor: v })} label={t("filters.author")} />
        {(kind === "" || kind === "item") && (
          <PersonSelect value={assignee} onChange={(v) => setParams({ assignee: v, ...(v ? { kind: "item" } : {}) })} label={t("item.assignee")} groups />
        )}
        <UpdatedSelect value={updated} onChange={(v) => setParams({ updated: v })} />
        <BranchPicker value={path} onChange={(v) => setParams({ path: v })} label={t("board.branch")} />
      </div>
      <SavedViews page="search" />
      {error && <ErrorBox error={error} />}
      {loading && q ? (
        <Loading />
      ) : (
        <div className="card list">
          {data?.results.length === 0 && <EmptyState icon="search" title={t("search.none")} card={false} />}
          {data?.results.map((h) => (
            <ListRow key={`${h.kind}-${h.draft_id ?? h.id ?? h.path}`} onPress={() => open(h)}>
              <span className={`chip ${h.kind === "activity" ? "ai" : h.kind === "item" ? "accent" : ""} kind-chip`}>
                {label.type(h.kind === "item" ? (h.type ?? "item") : h.kind)}
              </span>
              <div className="grow">
                <div className="title">{h.title ?? h.summary}</div>
                <div className="meta">
                  {h.path !== undefined && <span className="mono">{h.path || "(root)"}</span>}
                  {h.draft_id ? <span className="chip warn">{t("search.draft")}</span> : h.status && <StatusChip status={h.status} />}
                  {h.proposed_by && <span>{h.proposed_by}</span>}
                  {h.actor && <span>{h.actor}</span>}
                  {h.at && <Ago iso={h.at} />}
                  {h.title && h.summary && <span className="faint">{h.summary}</span>}
                </div>
              </div>
              {h.match && data?.mode === "hybrid" && (
                <span className={`chip ${h.match === "keyword" ? "" : "ok"}`} title="match">
                  {t(`match.${h.match}` as Key)}
                </span>
              )}
            </ListRow>
          ))}
        </div>
      )}
    </>
  );
}

function SearchMode({ data }: { data: SearchResponse }) {
  const t = useT();
  if (data.mode === "hybrid") {
    const s = data.semantic;
    return <p>{s.indexed < s.total ? `${t("search.indexing")} ${s.indexed}/${s.total}` : t("search.hybrid")}</p>;
  }
  return (
    <p>
      {t("search.keywordOnly")} <code>npx cortexboard semantic on</code>
    </p>
  );
}
