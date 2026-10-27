import { useState } from "react";
import type { ApiError } from "./api";
import { api, useApi } from "./api";
import { MarkdownField } from "./attachments";
import { useT } from "./i18n";
import { ActorChip, Ago, Markdown, useSession, useToast } from "./ui";

// The project status on top of Notifications: where the project stands and what is next, who wrote it
// when, and a mark when it has gone stale (the server decides: too many days, or too many changes since).
// Anyone who may write knowledge edits it in place; the previous text is kept (GET /api/status/history).

type Status = {
  body: string;
  updated_at: string;
  updated_by: string;
  stale: boolean;
  reason?: "days" | "changes";
  days_old: number;
  changes_since: number;
  limits: { days: number; changes: number };
};

const noFiles = async () => [] as string[];

// Fetched by the page that shows the card, so the page can wait for it: a card arriving after the list
// would push the list down.
export function useStatus() {
  // A logged entry can make it stale, so those refresh it too.
  return useApi<{ status: Status | null }>("/api/status", { on: ["status", "log"] });
}

export function StatusCard({ res }: { res: ReturnType<typeof useStatus> }) {
  const t = useT();
  const toast = useToast();
  const { actors, can } = useSession();
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Members who see only part of the project get a 403: no card for them.
  if (res.error && (res.error as ApiError).status === 403) return null;
  if (!res.data) return null;
  const status = res.data.status;
  const canWrite = can("write_knowledge");

  const save = async () => {
    if (!editing?.trim()) return;
    setBusy(true);
    try {
      await api("/api/status", { method: "PUT", body: { body: editing } });
      setEditing(null);
      res.reload();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  const staleText = status?.stale
    ? status.reason === "days"
      ? t("status.staleDays").replace("{n}", String(Math.floor(status.days_old)))
      : t("status.staleChanges").replace("{n}", String(status.changes_since))
    : null;

  return (
    <section className={`card status-card${status?.stale ? " stale" : ""}`} aria-labelledby="status-card-title">
      <div className="status-head">
        <h2 id="status-card-title">{t("status.title")}</h2>
        {staleText && <span className="chip warn">{staleText}</span>}
        <span className="spacer" />
        {status && (
          <span className="status-meta">
            <ActorChip id={status.updated_by} actors={actors} /> <Ago iso={status.updated_at} />
          </span>
        )}
        {canWrite && editing === null && (
          <button type="button" className="btn sm" onClick={() => setEditing(status?.body ?? "")}>
            {t(status ? "status.edit" : "status.write")}
          </button>
        )}
      </div>
      {editing !== null ? (
        <div className="status-edit">
          <MarkdownField value={editing} onChange={setEditing} onFiles={noFiles} placeholder={t("status.placeholder")} minHeight={140} autoFocus />
          <div className="row status-actions">
            <span className="spacer" />
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              {t("common.cancel")}
            </button>
            <button type="button" className="btn primary" disabled={busy || !editing.trim()} onClick={() => void save()}>
              {t("common.save")}
            </button>
          </div>
        </div>
      ) : status ? (
        <>
          {staleText && <p className="status-why">{t("status.staleWhy")}</p>}
          <Markdown text={status.body} />
        </>
      ) : (
        <p className="muted">{t("status.empty")}</p>
      )}
    </section>
  );
}
