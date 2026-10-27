import { useState } from "react";
import { api, useApi } from "./api";
import { DiffModeSwitch, DiffView, useDiffMode } from "./DiffView";
import type { Key } from "./i18n";
import { useT } from "./i18n";
import type { Item } from "./types";
import { ActorChip, Ago, ErrorBox, Loading, useAsk, useSession, useToast } from "./ui";

// An item's earlier versions (GET /items/:id/history): who changed what and when, the difference between
// a version and the item now, and "restore this version". Loaded only when the section is opened.

type VersionRow = {
  version: string;
  saved_by: string;
  saved_at: string;
  replaced_by: string;
  replaced_at: string;
  title: string;
  body_chars: number;
  changed: string[];
};

const PART: Record<string, Key> = {
  title: "approvals.cTitle",
  body: "approvals.cBody",
  assignee: "approvals.cAssignee",
  category_path: "approvals.cCategory",
  fields: "history.fields",
  links: "approvals.cLinks",
  tags: "approvals.cTags",
  handoff_note: "history.handoff",
};

export function ItemHistory({ item, onRestored }: { item: Item; onRestored: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <details className="section history" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{t("history.title")}</summary>
      {open && <Versions item={item} onRestored={onRestored} />}
    </details>
  );
}

function Versions({ item, onRestored }: { item: Item; onRestored: () => void }) {
  const t = useT();
  const { actors } = useSession();
  const list = useApi<{ versions: VersionRow[]; max: number }>(`/api/items/${item.id}/history`, { on: ["item"] });
  const [picked, setPicked] = useState<string | null>(null);
  if (list.error) return <ErrorBox error={list.error} />;
  if (!list.data) return <Loading />;
  const versions = list.data.versions;
  if (!versions.length) return <p className="muted">{t("history.none")}</p>;
  return (
    <>
      <p className="muted history-hint">{t("history.hint").replace("{n}", String(list.data.max))}</p>
      <ol className="history-list">
        {versions.map((v) => (
          <li key={v.version} className={picked === v.version ? "on" : undefined}>
            <button
              type="button"
              className="history-row"
              aria-expanded={picked === v.version}
              onClick={() => setPicked(picked === v.version ? null : v.version)}
            >
              <span className="history-when">
                <Ago iso={v.saved_at} />
              </span>
              <ActorChip id={v.saved_by} actors={actors} />
              <span className="history-parts">
                {v.changed.map((p) => (
                  <span key={p} className="chip">
                    {PART[p] ? t(PART[p]) : p}
                  </span>
                ))}
              </span>
            </button>
            {picked === v.version && <VersionDetail item={item} version={v.version} onRestored={onRestored} />}
          </li>
        ))}
      </ol>
    </>
  );
}

// What restoring this version would change: the item now on the left, the version on the right.
function VersionDetail({ item, version, onRestored }: { item: Item; version: string; onRestored: () => void }) {
  const t = useT();
  const toast = useToast();
  const { dialog, ask } = useAsk();
  const { can } = useSession();
  const [mode, setMode] = useDiffMode();
  const v = useApi<{ version: string; item: Item }>(`/api/items/${item.id}/history/${version}`, { on: [] });
  const [busy, setBusy] = useState(false);
  if (v.error) return <ErrorBox error={v.error} />;
  if (!v.data) return <Loading />;
  const old = v.data.item;

  const restore = async () => {
    const ok = await ask({ title: t("history.restore"), message: t("history.restoreWhy"), confirm: t("history.restore") });
    if (ok === null) return;
    setBusy(true);
    try {
      const r = await api<{ applied: boolean; message: string }>(`/api/items/${item.id}/restore`, { method: "POST", body: { version } });
      toast({ text: r.applied ? t("history.restored") : r.message });
      onRestored();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="version-detail">
      {old.title !== item.title && (
        <p>
          {t("approvals.cTitle")}: <del>{item.title}</del> → <ins>{old.title}</ins>
        </p>
      )}
      {old.handoff_note !== item.handoff_note && old.handoff_note && (
        <p>
          {t("history.handoff")}: <ins>{old.handoff_note}</ins>
        </p>
      )}
      {old.body !== item.body ? (
        <>
          <div className="row body-changes-head">
            <span className="muted">{t("history.diffHint")}</span>
            <span className="spacer" />
            <DiffModeSwitch mode={mode} onChange={setMode} />
          </div>
          <DiffView before={item.body} after={old.body} mode={mode} />
        </>
      ) : (
        <p className="muted">{t("history.sameBody")}</p>
      )}
      {can("write_items") && (
        <div className="row version-actions">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void restore()}>
            {t("history.restore")}
          </button>
        </div>
      )}
      {dialog}
    </div>
  );
}
