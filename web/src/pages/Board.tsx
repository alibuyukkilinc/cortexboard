import { useState } from "react";
import type { ApiError } from "../api";
import { api, qs, useApi } from "../api";
import { useLabels, useT } from "../i18n";
import { NewItemDialog, nextStatuses, useSchema } from "../items";
import type { ItemSummary } from "../types";
import { ActorChip, ErrorBox, Progress, Icon, Loading, PressCard, PressTitle, ShortId, typeIcon, useSession, useToast } from "../ui";
import { useCounts } from "../counts";
import { fileUrl } from "../attachments";
import type { Schema } from "../types";
import { BranchPicker, PersonSelect, SavedViews, UpdatedSelect, sinceOf, useRouteQuery } from "../filters";

// A column shows a page of cards and grows a page at a time up to MAX_SHOWN; past that the filters narrow it.
// The whole type is never downloaded: at 500 cards the old board silently dropped the rest.
const PAGE = 25;
const MAX_SHOWN = 100;

type Column = { status: string; total: number; items: ItemSummary[] };

export function Board({ type }: { type: string }) {
  const t = useT();
  const label = useLabels();
  const toast = useToast();
  const { actors, itemTypes, openItem, me, can } = useSession();
  const waiting = useCounts()?.waiting;
  const schema = useSchema(type);
  const [params, setParams] = useRouteQuery();
  const branch = params.get("path") ?? "";
  const assignee = params.get("assignee") ?? "";
  const author = params.get("author") ?? "";
  const updated = params.get("updated") ?? "";
  // Set by a link (the report's milestone timeline), so a chip rather than a picker.
  const milestone = params.get("milestone") ?? "";
  const [shown, setShown] = useState<Record<string, number>>({});
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState<ItemSummary | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // Read out by screen readers after a move: dragging gives sighted users that feedback for free.
  const [announce, setAnnounce] = useState("");
  // One request for every column, as deep as the deepest opened column, so a live refresh keeps what was loaded.
  const perStatus = Math.max(PAGE, ...Object.values(shown));
  const { data, error, loading, reload } = useApi<{ columns: Column[] }>(
    `/api/board${qs({ type, path: branch, assignee, author, milestone, since: sinceOf(updated), per_status: perStatus })}`,
    { on: ["item"] },
  );
  // The other types open with the same filters: switching issue → question is one click, not a new search.
  const filters = params.toString();
  const typeHref = (x: string) => `#/board/${x}${filters ? `?${filters}` : ""}`;

  const move = async (item: ItemSummary, status: string, force = false) => {
    if (item.status === status) return;
    try {
      await api(`/api/items/${item.id}`, { method: "PATCH", body: { status, ...(force ? { force } : {}) } });
      const said = `${item.title}: ${t("board.moved")} ${label.status(status)}`;
      toast({ text: said });
      setAnnounce(said);
      reload();
    } catch (e) {
      const ae = e as ApiError;
      const allowed = (ae.hint as { allowed_from_here?: string[] } | undefined)?.allowed_from_here;
      toast({
        text: `${ae.message}${allowed ? ` (→ ${allowed.join(", ")})` : ""}`,
        error: true,
        ...(ae.code === "invalid_transition" && me.kind === "human" ? { action: { label: t("board.force"), run: () => void move(item, status, true) } } : {}),
      });
    }
  };

  const column = (s: string) => data?.columns.find((c) => c.status === s);

  // The type's description sits above the filters: drawn late, it would push the whole board down.
  if (!schema) return error ? <ErrorBox error={error} /> : <Loading />;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t("nav.board")}</h1>
          {schema?.description && (
            <p>
              {label.description(type, schema.description)} <span className="faint">· {t("board.dropHint")}</span>
            </p>
          )}
        </div>
        {(type === "question" ? can("ask") : can("write_items")) && (
          <div className="page-actions">
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Icon name="plus" /> {t("board.new")}
            </button>
          </div>
        )}
      </div>
      <div className="toolbar board-filters" role="group" aria-label={t("board.filters")}>
        <nav className="type-tabs" aria-label={t("board.type")}>
          {itemTypes.map((x) => {
            const n = waiting?.[x] ?? 0;
            return (
              <a key={x} href={typeHref(x)} className={x === type ? "on" : ""} aria-current={x === type ? "page" : undefined}>
                <Icon name={typeIcon(x)} size={15} />
                {label.type(x)}
                {n > 0 && (
                  <span className="tab-badge" title={t("board.waitingHint")}>
                    {n > 99 ? "99+" : n}
                    <span className="sr-only">, {t("board.waiting").replace("{n}", String(n))}</span>
                  </span>
                )}
              </a>
            );
          })}
        </nav>
        <BranchPicker value={branch} onChange={(v) => setParams({ path: v })} label={t("board.branch")} />
        <PersonSelect value={assignee} onChange={(v) => setParams({ assignee: v })} label={t("item.assignee")} groups />
        <PersonSelect value={author} onChange={(v) => setParams({ author: v })} label={t("filters.author")} />
        <UpdatedSelect value={updated} onChange={(v) => setParams({ updated: v })} />
        {milestone && (
          <span className="view-chip on">
            <span className="view-open">
              {t("rep.milestone")}: {milestone}
            </span>
            <button
              type="button"
              className="view-remove"
              aria-label={`${t("filters.clear")}: ${milestone}`}
              onClick={() => setParams({ milestone: undefined })}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        )}
      </div>
      <SavedViews page="board" />
      {error && <ErrorBox error={error} />}
      {loading ? (
        <Loading />
      ) : (
        <div className="board">
          {schema.statuses.map((status) => {
            const col = column(status);
            const limit = Math.min(shown[status] ?? PAGE, MAX_SHOWN);
            const items = (col?.items ?? []).slice(0, limit);
            const total = col?.total ?? 0;
            const allowed = !dragging || dragging.status === status || nextStatuses(schema, dragging.status).includes(status);
            const humanOnly = schema.human_only_statuses.includes(status);
            return (
              <section
                key={status}
                className={`column${over === status ? " over" : ""}${allowed ? "" : " dimmed"}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(status);
                }}
                onDragLeave={() => setOver((o) => (o === status ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  if (dragging) void move(dragging, status);
                  setDragging(null);
                }}
              >
                <div className="column-head">
                  <span>{label.status(status)}</span>
                  <span className="count">{total}</span>
                  {humanOnly && (
                    <span className="lock" title={t("board.humanOnly")}>
                      <Icon name="lock" size={13} />
                    </span>
                  )}
                </div>
                <div className="column-body">
                  {items.length === 0 && <div className="muted column-empty">{t("board.empty")}</div>}
                  {items.map((i) => (
                    <PressCard
                      as="article"
                      key={i.id}
                      className={`kcard ${dragging?.id === i.id ? "dragging" : ""}`}
                      draggable
                      onDragStart={() => setDragging(i)}
                      onDragEnd={() => setDragging(null)}
                      onPress={() => openItem(i.id)}
                    >
                      {i.cover && <img className="kcard-cover" src={fileUrl(i.id, i.cover)} alt="" loading="lazy" draggable={false} />}
                      {(i.level || i.blocking) && (
                        <div className="kcard-labels">
                          {i.level && <span className={`klabel lv-${i.level}`}>{label.value(i.level)}</span>}
                          {i.blocking && <span className="klabel lv-critical">{t("item.blocking")}</span>}
                        </div>
                      )}
                      <PressTitle>{i.title}</PressTitle>
                      {i.checklist && <Progress done={i.checklist.done} total={i.checklist.total} />}
                      <div className="meta">
                        {i.due && <DueChip due={i.due} done={!!i.done} />}
                        {i.has_body && (
                          <span className="kbadge" title={t("board.hasBody")}>
                            <Icon name="text" size={13} />
                            <span className="sr-only">{t("board.hasBody")}</span>
                          </span>
                        )}
                        {i.replies ? (
                          <span className="kbadge" title={t("board.replies")}>
                            <Icon name="chat" size={13} /> {i.replies}
                          </span>
                        ) : null}
                        {i.files ? (
                          <span className="kbadge" title={t("board.files")}>
                            <Icon name="clip" size={13} /> {i.files}
                          </span>
                        ) : null}
                        {i.category_path && <span className="chip">{i.category_path}</span>}
                        <ShortId id={i.id} />
                        <span className="spacer" />
                        {i.assignee && <ActorChip id={i.assignee} actors={actors} />}
                        {/* The same moves as dragging, for keyboards and touch screens. */}
                        {can("write_items") && nextStatuses(schema, i.status).length > 0 && (
                          <select
                            className="kcard-move"
                            value=""
                            aria-label={`${t("board.moveTo")}: ${i.title}`}
                            title={t("board.moveTo")}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => e.target.value && void move(i, e.target.value)}
                          >
                            <option value="">{t("board.moveTo")}…</option>
                            {nextStatuses(schema, i.status).map((s) => (
                              <option key={s} value={s}>
                                {label.status(s)}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </PressCard>
                  ))}
                  {items.length < total &&
                    (limit < MAX_SHOWN ? (
                      <button type="button" className="btn sm ghost column-more" onClick={() => setShown((s) => ({ ...s, [status]: limit + PAGE }))}>
                        {t("board.more")} ({total - items.length})
                      </button>
                    ) : (
                      <p className="column-cap" role="note">
                        {t("board.capped").replace("{shown}", String(items.length)).replace("{total}", String(total))}
                      </p>
                    ))}
                </div>
                {(type === "question" ? can("ask") : can("write_items")) && (
                  <QuickAdd type={type} status={status} schema={schema} branch={branch} assignee={assignee} onAdded={reload} />
                )}
              </section>
            );
          })}
        </div>
      )}
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
      {creating && <NewItemDialog type={type} defaultPath={branch || undefined} onClose={() => setCreating(false)} />}
    </>
  );
}

// Trello's due-date badge: red when late, amber when due today, quiet when done.
function DueChip({ due, done }: { due: string; done: boolean }) {
  const t = useT();
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const state = done ? "done" : due < key ? "late" : due === key ? "today" : "";
  const shown = new Date(`${due}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return (
    <span className={`kbadge due ${state}`} title={state === "late" ? t("board.overdue") : due}>
      <Icon name="clock" size={13} /> {shown}
    </span>
  );
}

// "Add a card" at the bottom of a column: type a title, Enter, and it lands in this column; the input
// stays open for the next one, as in Trello. The board's branch and assignee filters are applied.
function QuickAdd({
  type,
  status,
  schema,
  branch,
  assignee,
  onAdded,
}: {
  type: string;
  status: string;
  schema: Schema;
  branch: string;
  assignee: string;
  onAdded: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const text = title.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const r = await api<{ id: string }>("/api/items", {
        method: "POST",
        body: { type, title: text, ...(branch ? { category_path: branch } : {}), ...(assignee ? { assignee } : {}) },
      });
      // New items start in the type's first status; move it to the column it was typed into.
      if (status !== schema.initial) await api(`/api/items/${r.id}`, { method: "PATCH", body: { status } });
      setTitle("");
      onAdded();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  if (!open)
    return (
      <button type="button" className="quick-add-btn" onClick={() => setOpen(true)}>
        <Icon name="plus" size={14} /> {t("board.addCard")}
      </button>
    );
  return (
    <div className="quick-add">
      <textarea
        className="textarea"
        autoFocus
        rows={2}
        value={title}
        placeholder={t("board.addCardHint")}
        aria-label={t("board.addCard")}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void add();
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
            setTitle("");
          }
        }}
      />
      <div className="row gap-2">
        <button type="button" className="btn primary sm" disabled={busy || !title.trim()} onClick={() => void add()}>
          {t("board.addCard")}
        </button>
        <button type="button" className="icon-btn" aria-label={t("common.cancel")} onClick={() => (setOpen(false), setTitle(""))}>
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>
  );
}
