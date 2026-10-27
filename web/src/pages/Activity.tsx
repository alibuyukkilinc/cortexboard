import { useEffect } from "react";
import { api, qs, useApi } from "../api";
import { useLabels, useT } from "../i18n";
import type { Activity as Entry } from "../types";
import { Ago, Avatar, CommitLink, EmptyState, ErrorBox, Icon, Loading, ViaChip, useAsk, useSession, useToast } from "../ui";
import { PersonSelect, SavedViews, UpdatedSelect, sinceOf, useRouteQuery } from "../filters";

// Pages of 50, newest first, walked with the server's cursor: the feed never holds more than one page.
const PAGE = 50;

export function Activity() {
  const t = useT();
  const label = useLabels();
  const { actors, ask, openItem, me, can } = useSession();
  const [params, setParams] = useRouteQuery();
  const actor = params.get("actor") ?? "";
  const system = params.get("system") === "1";
  const chat = params.get("chat") === "1";
  const updated = params.get("updated") ?? "";
  const focus = params.get("focus");
  // An entry opened from elsewhere starts the page at it: ids sort by time, and "~" sorts after every id
  // character, so "before <id>~" is that entry and everything older.
  const before = params.get("before") ?? (focus ? `${focus}~` : "");
  const { data, error, loading, reload } = useApi<{ entries: Entry[]; next_cursor: string | null }>(
    `/api/activity${qs({ actor, include_system: system, chat: chat || undefined, since: sinceOf(updated), before, limit: PAGE })}`,
  );
  const { dialog, ask: confirm } = useAsk();
  const toast = useToast();
  const canUndo = me.kind === "human" && can("approve");
  // Take back an answer given in the AI chat: the card goes back to how it was, and the undo is logged.
  const undo = async (a: Entry) => {
    const ok = await confirm({ title: t("via.undoTitle"), message: a.summary, confirm: t("via.undo"), tone: "danger" });
    if (ok === null) return;
    try {
      await api(`/api/chat/undo/${a.id}`, { method: "POST" });
      toast({ text: t("via.undone") });
      reload();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };
  // A new filter starts from the newest entry again.
  const filter = (patch: Record<string, string | undefined>) => setParams({ ...patch, before: undefined, focus: undefined });
  const older = () => {
    setParams({ before: data?.next_cursor ?? undefined, focus: undefined });
    window.scrollTo({ top: 0 });
  };

  useEffect(() => {
    if (focus && data) document.getElementById(`a-${focus}`)?.scrollIntoView({ block: "center" });
  }, [focus, data]);

  const refLink = (r: string) =>
    /^[0-9A-Z]{26}$/.test(r) ? (
      <button type="button" key={r} className="chip mono" onClick={() => openItem(r)} title={r}>
        {r.slice(-8)}
      </button>
    ) : (
      <a key={r} className="chip" href={`#/knowledge/${r}`}>
        {r || "(root)"}
      </a>
    );

  return (
    <>
      <div className="page-head">
        <h1>{t("activity.title")}</h1>
      </div>
      <div className="toolbar" role="group" aria-label={t("board.filters")}>
        <PersonSelect value={actor} onChange={(v) => filter({ actor: v })} label={t("activity.filterActor")} />
        <UpdatedSelect value={updated} onChange={(v) => filter({ updated: v })} />
        <label htmlFor="activity-activity-showsystem" className="check">
          <input id="activity-activity-showsystem" type="checkbox" checked={system} onChange={(e) => filter({ system: e.target.checked ? "1" : undefined })} />{" "}
          {t("activity.showSystem")}
        </label>
        <label htmlFor="activity-activity-chat" className="check">
          <input id="activity-activity-chat" type="checkbox" checked={chat} onChange={(e) => filter({ chat: e.target.checked ? "1" : undefined })} />{" "}
          {t("via.filter")}
        </label>
      </div>
      {dialog}
      <SavedViews page="activity" />
      {before && (
        <div className="toolbar">
          <button type="button" className="btn sm ghost" onClick={() => filter({})}>
            <Icon name="clock" size={14} /> {t("activity.newest")}
          </button>
        </div>
      )}
      {error && <ErrorBox error={error} />}
      {loading ? (
        <Loading />
      ) : (
        <div className="card timeline">
          {data?.entries.length === 0 && <EmptyState icon="activity" title={t("activity.empty")} card={false} />}
          {data?.entries.map((a) => (
            <div
              key={a.id}
              id={`a-${a.id}`}
              className={`tl-row ${a.system ? "system" : ""}`}
              style={focus === a.id ? { background: "var(--accent-soft)" } : undefined}
            >
              <Avatar id={a.actor} actors={actors} />
              <div className="minw-0">
                <div>
                  <strong>{a.actor}</strong>{" "}
                  <span className="chip" title={a.action}>
                    {label.action(a.action)}
                  </span>{" "}
                  {a.via && (
                    <>
                      <ViaChip via={a.via} />{" "}
                    </>
                  )}
                  {a.summary}
                </div>
                {a.why && (
                  <div className="tl-why">
                    <span className="muted">{t("activity.why")}:</span> {a.why}
                  </div>
                )}
                {(a.files?.length || a.commit || a.commits?.length || a.refs?.length) && (
                  <div className="tl-files">
                    {[...new Set([...(a.commit ? [a.commit] : []), ...(a.commits ?? [])])].map((h) => (
                      <CommitLink key={h} hash={h} chip />
                    ))}
                    {a.files?.map((f) => (
                      <span key={f} className="chip mono">
                        {f}
                      </span>
                    ))}
                    {a.refs?.map(refLink)}
                  </div>
                )}
              </div>
              <div className="faint tl-side">
                <Ago iso={a.at} />
                {!a.system && (
                  <div className="mt-1">
                    <button className="btn sm" onClick={() => ask(a.id, a.summary)}>
                      <Icon name="ask" size={13} /> {t("activity.ask")}
                    </button>
                  </div>
                )}
                {a.undo?.undone ? (
                  <div className="mt-1 chip" title={a.undo.undone.at}>
                    {t("via.undoneBy").replace("{who}", a.undo.undone.by)}
                  </div>
                ) : (
                  a.undo?.undoable &&
                  canUndo && (
                    <div className="mt-1">
                      <button className="btn sm" onClick={() => void undo(a)}>
                        <Icon name="undo" size={13} /> {t("via.undo")}
                      </button>
                    </div>
                  )
                )}
              </div>
            </div>
          ))}
          {data?.next_cursor && (
            <div className="timeline-more">
              <button type="button" className="btn sm" onClick={older}>
                {t("activity.older")}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
