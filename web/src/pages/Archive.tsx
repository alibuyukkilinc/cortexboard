import { useState } from "react";
import { api, useApi } from "../api";
import { useT } from "../i18n";
import { Ago, EmptyState, ErrorBox, Loading, StatusChip, TypeChip, useSession, useToast } from "../ui";

// Keeping memory lean: records that no longer apply (a one-off problem solved for good, a superseded
// decision, a branch for code that is gone) leave search, the brief and the tree. Here a person sees what
// Cortex suggests, archives it, brings things back, or deletes archived ones for good.
// AI agents propose archiving through cortex_archive; their proposals wait on the Approvals page.

interface Candidate {
  kind: "item" | "node";
  ref: string;
  title: string;
  type?: string;
  status: string;
  updated_at: string;
  age_days: number;
  why: string;
}
interface ArchivedRow {
  kind: "item" | "node";
  ref: string;
  title: string;
  type?: string;
  status: string;
  archived?: { at: string; by: string; reason?: string };
}
interface Outcome {
  ref: string;
  applied: boolean;
  draft_id?: string;
  error?: { message: string };
}

export function Archive() {
  const t = useT();
  const [tab, setTab] = useState<"candidates" | "archived">("candidates");
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t("arch.title")}</h1>
          <p>{t("arch.intro")}</p>
        </div>
        <div className="page-actions">
          <div className="segmented" role="group" aria-label={t("arch.title")}>
            <button className={tab === "candidates" ? "on" : ""} aria-pressed={tab === "candidates"} onClick={() => setTab("candidates")}>
              {t("arch.candidates")}
            </button>
            <button className={tab === "archived" ? "on" : ""} aria-pressed={tab === "archived"} onClick={() => setTab("archived")}>
              {t("arch.archived")}
            </button>
          </div>
        </div>
      </div>
      {tab === "candidates" ? <Candidates /> : <Archived />}
    </>
  );
}

// The record itself: an item opens in the drawer, a node in Knowledge.
function Title({ kind, refId, title }: { kind: "item" | "node"; refId: string; title: string }) {
  const { openItem } = useSession();
  return kind === "item" ? (
    <button className="link-button cell-title" onClick={() => openItem(refId)}>
      {title}
    </button>
  ) : (
    <a className="cell-title" href={`#/knowledge/${refId}`}>
      {title} <span className="faint mono">{refId}</span>
    </a>
  );
}

function Candidates() {
  const t = useT();
  const toast = useToast();
  const { can } = useSession();
  const { data, error, loading, reload } = useApi<{ after_days: number; candidates: Candidate[] }>("/api/archive/candidates");
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const rows = data?.candidates ?? [];
  const toggle = (ref: string) => setPicked((p) => (p.includes(ref) ? p.filter((x) => x !== ref) : [...p, ref]));

  const archive = async () => {
    setBusy(true);
    try {
      const r = await api<{ results: Outcome[]; message: string }>("/api/archive", { method: "POST", body: { refs: picked, reason } });
      const failed = r.results.filter((x) => x.error);
      toast({ text: failed.length ? `${r.message} ${failed.map((f) => f.error!.message).join(" ")}` : r.message, error: failed.length > 0 });
      setPicked([]);
      setReason("");
      reload();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!rows.length)
    return <EmptyState icon="check" title={t("arch.noCandidates")} hint={t("arch.noCandidatesHint").replace("{n}", String(data?.after_days ?? 30))} />;
  return (
    <div className="card list">
      {can("write_items") && (
        <div className="bulk-bar">
          <label className="check" htmlFor="arch-all">
            <input
              id="arch-all"
              type="checkbox"
              className="row-check"
              checked={picked.length === rows.length}
              onChange={(e) => setPicked(e.target.checked ? rows.map((r) => r.ref) : [])}
            />
            {picked.length ? t("arch.picked").replace("{n}", String(picked.length)) : t("arch.pickAll")}
          </label>
          <input
            className="input grow"
            placeholder={t("arch.reason")}
            aria-label={t("arch.reason")}
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
          <button className="btn primary sm" disabled={busy || !picked.length} onClick={() => void archive()}>
            {t("arch.archive")}
          </button>
        </div>
      )}
      {rows.map((r) => (
        <div className="list-row" key={r.ref}>
          {can("write_items") && (
            <label className="row-check-hit" htmlFor={`pick-${r.ref}`}>
              <input
                id={`pick-${r.ref}`}
                type="checkbox"
                className="row-check"
                aria-label={r.title}
                checked={picked.includes(r.ref)}
                onChange={() => toggle(r.ref)}
              />
            </label>
          )}
          <div className="grow">
            <Title kind={r.kind} refId={r.ref} title={r.title} />
            <div className="meta">
              <TypeChip type={r.kind === "node" ? "node" : (r.type ?? "item")} />
              <StatusChip status={r.status} />
              <span className="faint">{t("arch.age").replace("{n}", String(r.age_days))}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Archived() {
  const t = useT();
  const toast = useToast();
  const { can, me } = useSession();
  const { data, error, loading, reload } = useApi<{ archived: ArchivedRow[] }>("/api/archive");
  const rows = data?.archived ?? [];
  const human = me.kind === "human" && can("approve");

  const run = async (path: string, body: object, ok: string) => {
    try {
      await api(path, { method: "POST", body });
      toast({ text: ok });
      reload();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };
  const purge = (r: ArchivedRow) => {
    if (!confirm(t("arch.purgeConfirm").replace("{title}", r.title))) return;
    void run("/api/archive/purge", { ref: r.ref }, t("arch.purged"));
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!rows.length) return <EmptyState icon="archive" title={t("arch.empty")} hint={t("arch.emptyHint")} />;
  return (
    <div className="card list">
      {rows.map((r) => (
        <div className="list-row" key={r.ref}>
          <div className="grow">
            <Title kind={r.kind} refId={r.ref} title={r.title} />
            <div className="meta">
              <TypeChip type={r.kind === "node" ? "node" : (r.type ?? "item")} />
              {r.archived && (
                <>
                  <span className="faint">{r.archived.by}</span>
                  <Ago iso={r.archived.at} />
                </>
              )}
            </div>
            {r.archived?.reason && <p className="arch-reason">{r.archived.reason}</p>}
          </div>
          {human && (
            <div className="row-actions">
              <button className="btn sm" onClick={() => void run("/api/archive/restore", { refs: [r.ref] }, t("arch.restored"))}>
                {t("arch.restore")}
              </button>
              <button className="btn sm ghost danger" onClick={() => purge(r)}>
                {t("arch.purge")}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
