import { useState } from "react";
import { api, useApi } from "../api";
import type { Key } from "../i18n";
import { useT } from "../i18n";
import type { Severity, StaleInfo } from "../types";
import { EmptyState, ErrorBox, go, Loading, useAsk, useSession, useToast } from "../ui";
import { SeverityChip, StaleBanner } from "./Knowledge";

// Knowledge whose code moved on, as a work list: the node on the left, what changed on the right, and
// Verify / Fix / Snooze on each row. Grouped by how likely the knowledge is to be wrong now.
const GROUPS: { severity: Severity; title: Key; why: Key }[] = [
  { severity: "high", title: "stale.groupHigh", why: "stale.groupHighWhy" },
  { severity: "medium", title: "stale.groupMedium", why: "stale.groupMediumWhy" },
  { severity: "low", title: "stale.groupLow", why: "stale.groupLowWhy" },
];

export function Stale() {
  const t = useT();
  const toast = useToast();
  const { can } = useSession();
  const { data, error, reload } = useApi<{ enabled: boolean; actionable: number; nodes: StaleInfo[] }>("/api/stale", { on: ["stale", "git", "node"] });
  const [busy, setBusy] = useState(false);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const { dialog, ask } = useAsk();
  // Nodes picked for "verify selected": after checking several against the code, clear them in one go.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const canVerify = can("write_knowledge");

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const awake = data.nodes.filter((n) => !n.snoozed);
  const snoozed = data.nodes.filter((n) => n.snoozed);
  const low = awake.filter((n) => n.severity === "low");
  const selected = awake.filter((n) => picked.has(n.path)).map((n) => n.path);
  const toggle = (path: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const verifyAll = async (paths: string[], message: string) => {
    if ((await ask({ title: t("stale.verify"), message, confirm: t("stale.verify") })) === null) return;
    setBusy(true);
    try {
      const r = await api<{ done: string[]; drafts: number; failed: unknown[] }>("/api/verify", { method: "POST", body: { paths } });
      toast({ text: t("stale.verifyLowDone").replace("{n}", String(r.done.length)), error: r.failed.length > 0 });
      setPicked(new Set());
      reload();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  // Formatting changes cannot make knowledge wrong, so they can be cleared in one go.
  const verifyLow = () =>
    verifyAll(
      low.map((n) => n.path),
      t("stale.verifyLowConfirm").replace("{n}", String(low.length)),
    );
  const verifySelected = () => verifyAll(selected, t("stale.verifySelectedConfirm").replace("{n}", String(selected.length)));

  const row = (n: StaleInfo) => (
    <div className={`stale-row${picked.has(n.path) ? " picked" : ""}`} key={n.path}>
      <div className="stale-node">
        {canVerify && !n.snoozed && (
          <input
            type="checkbox"
            className="stale-pick"
            checked={picked.has(n.path)}
            onChange={() => toggle(n.path)}
            aria-label={`${t("stale.pick")}: ${n.title ?? n.path}`}
          />
        )}
        <a href={`#/knowledge/${n.path}`} className="title">
          {n.title ?? n.path}
        </a>
        <div className="faint mono text-xs">{n.path || "(root)"}</div>
        <SeverityChip severity={n.severity} />
      </div>
      <StaleBanner info={n} path={n.path} compact onEdit={() => go(`knowledge/${n.path}`)} onChanged={reload} />
    </div>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t("stale.pageTitle")}</h1>
          <p className="muted p-sub">{data.enabled ? t("stale.pageIntro").replace("{n}", String(data.actionable)) : t("stale.noGit")}</p>
        </div>
      </div>
      {data.enabled && awake.length === 0 && <EmptyState icon="check" title={t("stale.empty")} />}
      {selected.length > 0 && (
        <div className="bulk-bar stale-bulk" role="region" aria-label={t("stale.selection")}>
          <span>{t("stale.selected").replace("{n}", String(selected.length))}</span>
          <span className="spacer" />
          <button className="btn sm ghost" onClick={() => setPicked(new Set())}>
            {t("common.cancel")}
          </button>
          <button className="btn sm primary" disabled={busy} onClick={() => void verifySelected()}>
            {t("stale.verifySelected")}
          </button>
        </div>
      )}
      {GROUPS.map((g) => {
        const nodes = awake.filter((n) => n.severity === g.severity);
        if (!nodes.length) return null;
        return (
          <section key={g.severity} className="stale-group">
            <div className="stale-group-head">
              <h2>
                {t(g.title)} <span className="faint">{nodes.length}</span>
              </h2>
              {g.severity === "low" && can("write_knowledge") && (
                <button className="btn sm" disabled={busy} onClick={() => void verifyLow()}>
                  {t("stale.verifyLow")}
                </button>
              )}
            </div>
            <p className="muted m-0 mb-3 text-sm">{t(g.why)}</p>
            {nodes.map(row)}
          </section>
        );
      })}
      {snoozed.length > 0 && (
        <section className="stale-group">
          <button className="btn ghost sm" aria-expanded={showSnoozed} onClick={() => setShowSnoozed(!showSnoozed)}>
            {t("stale.groupSnoozed")} ({snoozed.length})
          </button>
          {showSnoozed && snoozed.map(row)}
        </section>
      )}
      {dialog}
    </>
  );
}
