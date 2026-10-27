import { useState } from "react";
import type { ApiError } from "../api";
import { api, useApi } from "../api";
import { useBoardPrompts } from "../BoardPrompts";
import { DiffModeSwitch, DiffView, useDiffMode } from "../DiffView";
import type { Key } from "../i18n";
import { useT } from "../i18n";
import type { Draft, DraftChanges, DraftSize } from "../types";
import { ActorChip, Ago, Drawer, EmptyState, ErrorBox, go, Loading, Markdown, PressCard, PressTitle, TypeChip, useAsk, useSession, useToast } from "../ui";

type BulkResult = { done: string[]; failed: { id: string; code: string; message: string }[]; stale_after_approval?: string[] };

const PAGE = 100;

// "−40 +2": how much of the text a draft changes, read at a glance in the list.
export function DraftSizeBadge({ size }: { size?: DraftSize }) {
  const t = useT();
  if (!size) return null;
  if (size.new) return <span className="chip accent">{t("approvals.newBadge")}</span>;
  return (
    <>
      {(size.added > 0 || size.removed > 0) && (
        <span className="diff-size" aria-label={t("approvals.sizeLabel").replace("{removed}", String(size.removed)).replace("{added}", String(size.added))}>
          <del>−{size.removed}</del> <ins>+{size.added}</ins>
        </span>
      )}
      {size.risky && <span className="chip warn">{t("approvals.risky")}</span>}
    </>
  );
}

export function Approvals() {
  const t = useT();
  const toast = useToast();
  const { dialog, ask } = useAsk();
  const { actors, can } = useSession();
  const [limit, setLimit] = useState(PAGE);
  const { data, error, loading } = useApi<{ drafts: Draft[]; total: number }>(`/api/approvals?limit=${limit}`, { on: ["draft"] });
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<BulkResult["failed"]>([]);

  const drafts = data?.drafts ?? [];
  // Risky drafts are approved one by one, after reading: they never join a batch.
  const selectable = drafts.filter((d) => !d.changes?.risky);
  // Drafts approved elsewhere (or by another tab) drop out of the selection by themselves.
  const selected = selectable.filter((d) => picked.has(d.id)).map((d) => d.id);
  const all = selectable.length > 0 && selected.length === selectable.length;
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const bulk = async (what: "approve" | "reject") => {
    const n = String(selected.length);
    const reason =
      what === "approve"
        ? await ask({ title: t("approvals.approveSelected"), message: t("approvals.confirmBulk").replace("{n}", n), confirm: t("approvals.approve") })
        : await ask({ title: t("approvals.rejectSelected"), input: { label: t("approvals.rejectReason") }, confirm: t("approvals.reject"), tone: "danger" });
    if (reason === null) return;
    setBusy(true);
    try {
      const r = await api<BulkResult>(`/api/approvals/${what}`, { method: "POST", body: { ids: selected, ...(reason ? { reason } : {}) } });
      // Keep only the failures selected, so the reviewer can open them one by one.
      setPicked(new Set(r.failed.map((f) => f.id)));
      setFailed(r.failed);
      const still = r.stale_after_approval?.length ?? 0;
      toast({
        text:
          t(what === "approve" ? "approvals.bulkDone" : "approvals.bulkRejected").replace("{done}", String(r.done.length)) +
          (still ? ` ${t("approvals.staleAfterBulk").replace("{n}", String(still))}` : ""),
        error: r.failed.length > 0,
        ...(still ? { action: { label: t("approvals.reviewStale"), run: () => go("stale") } } : {}),
      });
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>{t("approvals.title")}</h1>
      </div>
      <WaitingPrompts />
      <RelayedAnswers />
      {error && <ErrorBox error={error} />}
      {failed.length > 0 && (
        <div className="card notice danger">
          <strong>{t("approvals.bulkFailed").replace("{n}", String(failed.length))}</strong>
          {failed.map((f) => (
            <div key={f.id} className="muted notice-line">
              {drafts.find((d) => d.id === f.id)?.title ?? f.id}: {f.message}
            </div>
          ))}
        </div>
      )}
      {loading ? (
        <Loading />
      ) : (
        <div className="card list">
          {drafts.length === 0 && <EmptyState icon="check" title={t("approvals.empty")} card={false} />}
          {drafts.length > 0 && can("approve") && (
            <div className="bulk-bar">
              <label htmlFor="approvals-approvals-selectall" className="check">
                <input
                  id="approvals-approvals-selectall"
                  type="checkbox"
                  checked={all}
                  disabled={!selectable.length}
                  onChange={() => setPicked(all ? new Set() : new Set(selectable.map((d) => d.id)))}
                />
                {t("approvals.selectAll")}
              </label>
              {selected.length > 0 && (
                <span className="faint">
                  {selected.length} {t("approvals.selected")}
                </span>
              )}
              <span className="spacer" />
              <button className="btn danger" disabled={!selected.length || busy} onClick={() => void bulk("reject")}>
                {t("approvals.rejectSelected")}
              </button>
              <button className="btn primary" disabled={!selected.length || busy} onClick={() => void bulk("approve")}>
                {t("approvals.approveSelected")} {selected.length > 0 && `(${selected.length})`}
              </button>
            </div>
          )}
          {drafts.map((d) => (
            <PressCard key={d.id} className={`list-row${picked.has(d.id) ? " picked" : ""}`} onPress={() => setOpen(d.id)}>
              <label className="row-check-hit" htmlFor={`pick-${d.id}`}>
                <input
                  id={`pick-${d.id}`}
                  type="checkbox"
                  className="row-check"
                  aria-label={d.changes?.risky ? `${d.title}: ${t("approvals.riskyOneByOne")}` : d.title}
                  title={d.changes?.risky ? t("approvals.riskyOneByOne") : undefined}
                  disabled={!!d.changes?.risky}
                  checked={picked.has(d.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggle(d.id)}
                />
              </label>
              <div className="grow">
                <PressTitle>{d.title}</PressTitle>
                <div className="meta">
                  <TypeChip type={d.kind} />
                  <span className="mono faint">{d.kind === "node" ? d.target || "(root)" : d.target.slice(-8)}</span>
                  <DraftSizeBadge size={d.changes} />
                  <ActorChip id={d.proposed_by} actors={actors} />
                  {d.reason && <span>“{d.reason}”</span>}
                </div>
              </div>
              <span className="faint text-xs row-time">
                <Ago iso={d.proposed_at} />
              </span>
            </PressCard>
          ))}
          {drafts.length < (data?.total ?? 0) && (
            <button className="btn list-more" onClick={() => setLimit((l) => l + PAGE)}>
              {t("notif.more").replace("{n}", String((data?.total ?? 0) - drafts.length))}
            </button>
          )}
        </div>
      )}
      {open && <DraftDrawer id={open} onClose={() => setOpen(null)} />}
      {dialog}
    </>
  );
}

type Doc = {
  title: string;
  summary?: string;
  body: string;
  status?: string;
  fields?: Record<string, unknown>;
  tags?: string[];
  links?: { code?: { file: string; lines?: string }[] };
  verified_at_commit?: string;
};

// Names the reviewer reads for the fields the server compares; item fields keep their own name.
const FIELD_LABEL: Record<string, Key> = {
  title: "approvals.cTitle",
  summary: "approvals.cSummary",
  tags: "approvals.cTags",
  code: "approvals.cCode",
  verified_at_commit: "approvals.cVerify",
  status: "approvals.cStatus",
  assignee: "approvals.cAssignee",
  category_path: "approvals.cCategory",
  "links.items": "approvals.cLinks",
};

type Relayed = {
  id: string;
  at: string;
  ai_actor: string;
  human: string;
  kind: string;
  ids?: string[];
  target_id?: string;
  to?: string;
  answer: string;
  note?: string;
  verbatim: string;
};

// Answers an AI relayed from the chat because its client could not ask the person directly (chat.relayed:
// pending). Nothing changed yet: the person confirms what they really said, or discards it.
function RelayedAnswers() {
  const t = useT();
  const toast = useToast();
  const { actors, me, openItem } = useSession();
  const { data, reload } = useApi<{ answers: Relayed[] }>("/api/chat/relayed", { on: ["log", "draft", "item"] });
  const answers = data?.answers ?? [];
  if (!answers.length) return null;
  const act = async (r: Relayed, what: "confirm" | "discard") => {
    try {
      await api(`/api/chat/relayed/${r.id}${what === "confirm" ? "/confirm" : ""}`, { method: what === "confirm" ? "POST" : "DELETE", body: {} });
      toast({ text: what === "confirm" ? t("via.confirmed") : t("via.discard") });
      reload();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };
  return (
    <section className="card relayed" aria-labelledby="relayed-title">
      <h2 id="relayed-title">{t("via.relayedQueue")}</h2>
      <p className="muted mt-0">{t("via.relayedIntro")}</p>
      {answers.map((r) => (
        <div key={r.id} className="relayed-row">
          <div className="row">
            <ActorChip id={r.ai_actor} actors={actors} />
            <span className="chip">
              {r.kind}: {r.answer}
              {r.to ? ` → ${r.to}` : ""}
            </span>
            {r.target_id ? (
              <button type="button" className="chip mono" onClick={() => openItem(r.target_id!)}>
                {r.target_id.slice(-8)}
              </button>
            ) : (
              r.ids?.map((id) => (
                <span key={id} className="chip mono">
                  {id.slice(-8)}
                </span>
              ))
            )}
            <Ago iso={r.at} />
          </div>
          <blockquote className="relayed-quote">
            <span className="muted">
              {t("via.quote")} ({r.human}):
            </span>{" "}
            “{r.verbatim}”
          </blockquote>
          {me.kind === "human" && (
            <div className="row">
              <button className="btn sm primary" onClick={() => void act(r, "confirm")}>
                {t("via.confirm")}
              </button>
              <button className="btn sm" onClick={() => void act(r, "discard")}>
                {t("via.discard")}
              </button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

function DraftDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const { dialog, ask } = useAsk();
  const { actors, can } = useSession();
  const { data, error } = useApi<{ draft: Draft & { data: Doc }; current: Doc | null; changes: DraftChanges }>(`/api/approvals/${id}`, {
    on: ["draft", "node", "item"],
  });
  const [err, setErr] = useState<unknown>(null);
  const [mode, setMode] = useDiffMode();

  const act = async (what: "approve" | "reject", force = false) => {
    setErr(null);
    let reason: string | undefined;
    if (what === "reject") {
      const r = await ask({ title: t("approvals.reject"), input: { label: t("approvals.rejectReason") }, confirm: t("approvals.reject"), tone: "danger" });
      if (r === null) return;
      reason = r || undefined;
    }
    try {
      const r = await api<{ message: string; warning?: string; path?: string }>(`/api/approvals/${id}/${what}${force ? "?force=true" : ""}`, {
        method: "POST",
        body: reason ? { reason } : {},
      });
      if (r.warning === "stale_after_approval" && r.path !== undefined) {
        // The code moved after the proposal, so the node keeps its old pin. Only the approver can say HEAD is fine too.
        const path = r.path;
        toast({
          text: t("approvals.staleAfter"),
          action: {
            label: t("approvals.verifyAtHead"),
            run: () => void api(`/api/verify/${path}`, { method: "POST", body: {} }).then(() => toast({ text: t("stale.verified") })),
          },
        });
      } else toast({ text: r.message });
      onClose();
    } catch (e) {
      if ((e as ApiError).code === "conflict") {
        const again = await ask({ title: t("approvals.conflictTitle"), message: t("approvals.conflict"), confirm: t("approvals.approve") });
        if (again !== null) return act(what, true);
        return;
      }
      setErr(e);
    }
  };

  if (!data)
    return (
      <Drawer onClose={onClose} head={<span />}>
        {error ? <ErrorBox error={error} /> : <Loading />}
      </Drawer>
    );
  const { draft, current, changes } = data;
  const proposed = draft.data;
  const onlyVerify = changes.fields.length === 1 && changes.fields[0].name === "verified_at_commit" && !changes.body.added && !changes.body.removed;
  const nothing = !changes.new && !changes.fields.length && !changes.body.added && !changes.body.removed;
  const bodyChanged = !!current && (current.body ?? "") !== (proposed.body ?? "");
  const shownFields = changes.fields.filter((f) => f.name !== "verified_at_commit" || !onlyVerify);

  return (
    <Drawer
      onClose={onClose}
      head={
        <>
          <div className="row draft-meta">
            <TypeChip type={draft.kind} />
            <ActorChip id={draft.proposed_by} actors={actors} />
            <Ago iso={draft.proposed_at} />
          </div>
          <h2>{proposed.title}</h2>
        </>
      }
    >
      {changes.risky && (
        <div className="notice warn" role="note">
          <strong>{t("approvals.riskyTitle")}</strong> {t("approvals.riskyWhy").replace("{n}", String(changes.body.removed))}
        </div>
      )}
      {can("approve") && (
        <div className="row draft-actions">
          <button className="btn primary" onClick={() => void act("approve")}>
            {t("approvals.approve")}
          </button>
          <button className="btn danger" onClick={() => void act("reject")}>
            {t("approvals.reject")}
          </button>
        </div>
      )}
      <ErrorBox error={err} />
      {draft.reason && (
        <div className="draft-reason">
          <h3>{t("approvals.reason")}</h3>
          <p>{draft.reason}</p>
        </div>
      )}
      {(changes.new || onlyVerify || nothing || shownFields.length > 0) && (
        <div className="changes">
          <h3>{t("approvals.whatChanges")}</h3>
          {changes.new ? (
            <p>{t(draft.kind === "node" ? "approvals.newNode" : "approvals.newItem")}</p>
          ) : onlyVerify ? (
            <p>
              {t("approvals.onlyVerify")}{" "}
              <span className="mono">
                {(current?.verified_at_commit ?? "—").slice(0, 7)} → {(proposed.verified_at_commit ?? "—").slice(0, 7)}
              </span>
            </p>
          ) : nothing ? (
            <p>{t("approvals.noChange")}</p>
          ) : (
            shownFields.length > 0 && (
              <table className="field-diff">
                <thead>
                  <tr>
                    <th scope="col">{t("approvals.field")}</th>
                    <th scope="col">{t("approvals.current")}</th>
                    <th scope="col">{t("approvals.proposed")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shownFields.map((f) => (
                    <tr key={f.name}>
                      <th scope="row">{FIELD_LABEL[f.name] ? t(FIELD_LABEL[f.name]) : f.name.replace(/^fields\./, "")}</th>
                      <td data-label={t("approvals.current")}>{f.before ? <del>{f.before}</del> : <span className="faint">—</span>}</td>
                      <td data-label={t("approvals.proposed")}>{f.after ? <ins>{f.after}</ins> : <span className="faint">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </div>
      )}
      {changes.new ? (
        <div className="doc-preview">
          {proposed.summary && <p className="muted">{proposed.summary}</p>}
          <Markdown text={proposed.body} />
        </div>
      ) : (
        bodyChanged && (
          <section className="body-changes">
            <div className="row body-changes-head">
              <h3>
                {t("approvals.cBody")} <DraftSizeBadge size={{ ...changes.body, fields: 0, new: false, risky: false }} />
              </h3>
              <span className="spacer" />
              <DiffModeSwitch mode={mode} onChange={setMode} />
            </div>
            <DiffView before={current?.body ?? ""} after={proposed.body ?? ""} mode={mode} />
          </section>
        )
      )}
      {dialog}
    </Drawer>
  );
}

// Questions AI agents asked this person on the board, still open: answered in the same dialog that pops up.
function WaitingPrompts() {
  const t = useT();
  const { actors } = useSession();
  const { waiting, show } = useBoardPrompts();
  if (!waiting.length) return null;
  return (
    <section className="card prompt-list" aria-labelledby="prompts-title">
      <h2 id="prompts-title">{t("prompt.listTitle")}</h2>
      <p className="muted mt-0">{t("prompt.listIntro")}</p>
      {waiting.map((p) => (
        <div key={p.id} className="prompt-row">
          <ActorChip id={p.ai_actor} actors={actors} />
          <span className="prompt-row-title">{p.title}</span>
          <Ago iso={p.at} />
          <button type="button" className="btn sm primary" onClick={() => show(p.id)}>
            {t("prompt.answer")}
          </button>
        </div>
      ))}
    </section>
  );
}
