import { useEffect, useState } from "react";
import { api, useApi } from "./api";
import { useT } from "./i18n";
import { Ago, ErrorBox, Icon, Loading, Modal, useToast } from "./ui";

// Backups (task 01M3NQYNRX7X7Z3660KFA2WHZQ), for a hub (Organization → Backups, /api/admin/backup) and for a
// single project on its own board (/api/backup). Same settings, same list; a hub restore is staged and applied
// by a restart, a project restore happens at once.

// Bunny storage regions: the code picks the host (<code>.storage.bunnycdn.com; empty is Falkenstein).
const BUNNY_REGIONS: [string, string][] = [
  ["", "Falkenstein"],
  ["uk", "London"],
  ["se", "Stockholm"],
  ["ny", "New York"],
  ["la", "Los Angeles"],
  ["br", "São Paulo"],
  ["jh", "Johannesburg"],
  ["sg", "Singapore"],
  ["syd", "Sydney"],
];

type Provider = "bunny" | "gdrive";
type Settings = { provider: Provider; storage_zone?: string; region?: string; path?: string; interval_hours?: number; keep?: number };
type Result = { at: string; status: "ok" | "failed"; message: string };
type Staged = { name: string; staged_at: string; org?: string; made_at?: string; projects: { id: string; path: string }[] };
type Status = {
  settings: Settings | null;
  provider: Provider;
  has_access_key: boolean;
  has_passphrase: boolean;
  google: { has_client: boolean; connected: boolean };
  ready: boolean;
  last: Result | null;
  running: boolean;
  pending_restore?: Staged | null;
  can_restart?: boolean;
};
type Remote = { name: string; bytes: number; at: string };

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// Password managers see a text box above a password box as a sign-in form and fill the person's account in.
const noFill = { autoComplete: "off", "data-1p-ignore": true, "data-lpignore": "true" } as const;

export function BackupsPanel({ base, kind }: { base: string; kind: "hub" | "project" }) {
  const t = useT();
  const toast = useToast();
  const status = useApi<Status>(base);
  const d = status.data;
  const list = useApi<{ backups: Remote[] }>(d?.ready ? `${base}/list` : null);
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [restoring, setRestoring] = useState<Remote | null>(null);
  const [restarting, setRestarting] = useState(false);

  const s = d?.settings;
  const f: Record<string, string> = form ?? {
    provider: d?.provider ?? "bunny",
    zone: s?.storage_zone ?? "",
    region: s?.region ?? "",
    path: s?.path ?? "",
    key: "",
    every: String(s?.interval_hours ?? 0),
    keep: String(s?.keep ?? 14),
    passphrase: "",
    gid: "",
    gsecret: "",
  };
  const set = (k: string) => (e: { target: { value: string } }) => setForm({ ...f, [k]: e.target.value });
  const gdrive = f.provider === "gdrive";
  const reload = () => {
    status.reload();
    list.reload();
  };

  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ passphrase?: string; passphrase_changed?: boolean }>(base, {
        method: "PUT",
        body: {
          provider: f.provider,
          storage_zone: f.zone,
          region: f.region,
          ...(f.path.trim() ? { path: f.path } : {}),
          interval_hours: Number(f.every),
          keep: Number(f.keep),
          ...(f.key ? { access_key: f.key } : {}),
          ...(f.passphrase ? { passphrase: f.passphrase } : {}),
          ...(f.gid ? { google_client_id: f.gid } : {}),
          ...(f.gsecret ? { google_client_secret: f.gsecret } : {}),
        },
      });
      setForm(null);
      reload();
      if (r.passphrase) setShown(r.passphrase);
      else toast({ text: t(r.passphrase_changed ? "backup.passphraseChanged" : "backup.saved") });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    setBusy(true);
    try {
      const r = await api<{ result: Result }>(`${base}/run`, { method: "POST" });
      toast({ text: r.result.message, error: r.result.status !== "ok" });
      reload();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  const cancelRestore = async () => {
    await api(`${base}/restore`, { method: "DELETE" }).catch((e: Error) => toast({ text: e.message, error: true }));
    status.reload();
  };
  const disconnect = async () => {
    if (!confirm(t("backup.gdriveDisconnectConfirm"))) return;
    await api(`${base}/google`, { method: "DELETE" }).catch((e: Error) => toast({ text: e.message, error: true }));
    status.reload();
  };

  if (!d) return <Loading />;
  const last = d.last;
  const canSave =
    !busy &&
    (gdrive ? d.google.has_client || (!!f.gid.trim() && !!f.gsecret.trim()) : !!f.zone.trim() && (d.has_access_key || !!f.key.trim())) &&
    (!f.passphrase || f.passphrase.trim().length >= 12);
  const savedProvider = d.settings ? d.provider : null;

  return (
    <>
      {d.pending_restore && (
        <div className="card backup-panel backup-staged" role="status">
          <h3>
            <Icon name="undo" /> {t("backup.stagedTitle")}
          </h3>
          <p className="mt-0">
            <span className="mono">{d.pending_restore.name}</span>
            {d.pending_restore.made_at && (
              <>
                {" "}
                · <Ago iso={d.pending_restore.made_at} />
              </>
            )}
          </p>
          <p className="muted">{t("backup.stagedBody")}</p>
          <div className="backup-actions">
            <button className="btn" onClick={() => void cancelRestore()}>
              {t("backup.stagedCancel")}
            </button>
            {d.can_restart ? (
              <button className="btn primary" onClick={() => setRestarting(true)}>
                {t("backup.restartNow")}
              </button>
            ) : (
              <span className="faint">{t("backup.restartYourself")}</span>
            )}
          </div>
        </div>
      )}
      <div className="toolbar">
        <span className="faint">
          {last ? (
            <>
              <span className={`chip ${last.status === "ok" ? "ok" : "danger"}`}>{t(last.status === "ok" ? "backup.lastOk" : "backup.lastFailed")}</span>{" "}
              <Ago iso={last.at} /> · {last.message}
            </>
          ) : (
            t("backup.never")
          )}
        </span>
        <span className="spacer" />
        <button className="btn primary" disabled={!d.ready || busy || d.running} onClick={() => void run()}>
          <Icon name="download" /> {t("backup.runNow")}
        </button>
      </div>
      <div className="backup-grid">
        <section className="card backup-panel" aria-labelledby="backup-settings">
          <h3 id="backup-settings">{t("backup.settings")}</h3>
          <p className="muted mt-0">{t(kind === "hub" ? "backup.intro" : "backup.introProject")}</p>
          <ErrorBox error={err} />
          <div className="field">
            <span className="label" id="backup-provider-label">
              {t("backup.provider")}
            </span>
            <div className="segmented" role="group" aria-labelledby="backup-provider-label">
              {(["bunny", "gdrive"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={f.provider === p ? "on" : ""}
                  aria-pressed={f.provider === p}
                  onClick={() => setForm({ ...f, provider: p })}
                >
                  {p === "bunny" ? "BunnyCDN" : "Google Drive"}
                </button>
              ))}
            </div>
          </div>
          {gdrive ? (
            <>
              <div className="grid2">
                <div className="field">
                  <label htmlFor="backup-gid">{t("backup.gdriveClientId")}</label>
                  <input
                    id="backup-gid"
                    name="backup-google-client"
                    className="input mono"
                    {...noFill}
                    value={f.gid}
                    onChange={set("gid")}
                    placeholder={d.google.has_client ? t("backup.keySaved") : "…apps.googleusercontent.com"}
                  />
                </div>
                <div className="field">
                  <label htmlFor="backup-gsecret">{t("backup.gdriveClientSecret")}</label>
                  <input
                    id="backup-gsecret"
                    name="backup-google-secret"
                    type="password"
                    className="input mono"
                    {...noFill}
                    autoComplete="new-password"
                    value={f.gsecret}
                    onChange={set("gsecret")}
                    placeholder={d.google.has_client ? t("backup.keySaved") : ""}
                  />
                </div>
              </div>
              <span className="hint">{t("backup.gdriveHint")}</span>
              <div className="backup-connect">
                {d.google.connected ? (
                  <>
                    <span className="chip ok">{t("backup.gdriveConnected")}</span>
                    <button className="btn sm ghost" onClick={() => void disconnect()}>
                      {t("backup.gdriveDisconnect")}
                    </button>
                  </>
                ) : (
                  <span className="chip warn">{t("backup.gdriveNotConnected")}</span>
                )}
                <button
                  className="btn sm"
                  disabled={!d.google.has_client || savedProvider !== "gdrive" || !!form}
                  title={!d.google.has_client || savedProvider !== "gdrive" || form ? t("backup.gdriveSaveFirst") : undefined}
                  onClick={() => setConnecting(true)}
                >
                  {t(d.google.connected ? "backup.gdriveReconnect" : "backup.gdriveConnect")}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="grid2">
                <div className="field">
                  <label htmlFor="backup-zone">{t("backup.zone")}</label>
                  <input
                    id="backup-zone"
                    name="backup-storage-zone"
                    className="input mono"
                    {...noFill}
                    value={f.zone}
                    onChange={set("zone")}
                    placeholder="my-backups"
                  />
                </div>
                <div className="field">
                  <label htmlFor="backup-region">{t("backup.region")}</label>
                  <select id="backup-region" className="select" value={f.region} onChange={set("region")}>
                    {BUNNY_REGIONS.map(([code, city]) => (
                      <option key={code} value={code}>
                        {code ? `${city} (${code})` : city}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="field">
                <label htmlFor="backup-key">{t("backup.key")}</label>
                <input
                  id="backup-key"
                  className="input mono"
                  type="password"
                  name="backup-zone-password"
                  {...noFill}
                  autoComplete="new-password"
                  value={f.key}
                  onChange={set("key")}
                  placeholder={d.has_access_key ? t("backup.keySaved") : ""}
                />
                <span className="hint">{t("backup.keyHint")}</span>
              </div>
            </>
          )}
          <div className="grid2">
            <div className="field">
              <label htmlFor="backup-path">{t(gdrive ? "backup.pathDrive" : "backup.path")}</label>
              <input
                id="backup-path"
                className="input mono"
                {...noFill}
                value={f.path}
                onChange={set("path")}
                placeholder={kind === "hub" ? "cortex-hub" : "cortex/<project>"}
              />
            </div>
            <div className="field">
              <label htmlFor="backup-keep">{t("backup.keep")}</label>
              <input id="backup-keep" className="input" type="number" min={1} value={f.keep} onChange={set("keep")} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="backup-every">{t("backup.every")}</label>
            <input id="backup-every" className="input" type="number" min={0} value={f.every} onChange={set("every")} />
            <span className="hint">{t(kind === "hub" ? "backup.everyHint" : "backup.everyHintProject")}</span>
          </div>
          <div className="field">
            <label htmlFor="backup-passphrase">{t("backup.passphraseField")}</label>
            <input
              id="backup-passphrase"
              className="input mono"
              type="password"
              name="backup-archive-passphrase"
              {...noFill}
              autoComplete="new-password"
              value={f.passphrase}
              onChange={set("passphrase")}
              placeholder={d.has_passphrase ? t("backup.passphraseSaved") : t("backup.passphraseEmpty")}
            />
            <span className={`hint ${f.passphrase && f.passphrase.trim().length < 12 ? "danger" : ""}`}>
              {t(d.has_passphrase ? "backup.passphraseChangeHint" : "backup.passphraseFieldHint")}
            </span>
          </div>
          <div className="backup-actions">
            {form && (
              <button className="btn ghost" onClick={() => (setForm(null), setErr(null))}>
                {t("common.cancel")}
              </button>
            )}
            <button className="btn primary" disabled={!canSave} onClick={() => void save()}>
              {t("common.save")}
            </button>
          </div>
        </section>
        <section className="card backup-panel" aria-labelledby="backup-list">
          <h3 id="backup-list">{t("backup.list")}</h3>
          {!d.ready ? (
            <p className="faint">{t(gdrive && d.google.has_client && !d.google.connected ? "backup.gdriveConnectFirst" : "backup.notConfigured")}</p>
          ) : list.error ? (
            <ErrorBox error={list.error} />
          ) : !list.data ? (
            <Loading />
          ) : list.data.backups.length ? (
            <table className="table backup-table">
              <tbody>
                {list.data.backups.map((b) => (
                  <tr key={b.name}>
                    <td>
                      <div className="mono text-xs">{b.name}</div>
                      <div className="faint text-xs">
                        <Ago iso={b.at} /> · {kb(b.bytes)}
                      </div>
                    </td>
                    <td className="actions">
                      <a className="btn sm ghost" href={`${base}/download/${encodeURIComponent(b.name)}`} download={b.name} title={t("backup.download")}>
                        <Icon name="download" /> <span className="sr-only-sm">{t("backup.download")}</span>
                      </a>
                      <button className="btn sm" onClick={() => setRestoring(b)}>
                        <Icon name="undo" /> {t("backup.restore")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="faint">{t("backup.empty")}</p>
          )}
          <p className="faint fine-print">{t(kind === "hub" ? "backup.restoreHint" : "backup.restoreHintProject")}</p>
          <code className="block mono text-xs">
            {kind === "hub" ? (
              <>
                cortexboard hub restore &lt;{t("backup.fileOrName")}&gt; --to &lt;{t("backup.emptyFolder")}&gt;
              </>
            ) : (
              <>cortexboard backup restore &lt;{t("backup.fileOrName")}&gt; --passphrase &lt;…&gt;</>
            )}
          </code>
        </section>
      </div>
      {shown && <PassphraseShown value={shown} onClose={() => setShown(null)} />}
      {connecting && <GoogleConnect base={base} onClose={() => (setConnecting(false), reload())} />}
      {restoring && (
        <RestoreDialog
          base={base}
          kind={kind}
          backup={restoring}
          onClose={() => setRestoring(null)}
          onDone={() => {
            setRestoring(null);
            status.reload();
          }}
        />
      )}
      {restarting && <Restarting />}
    </>
  );
}

// The page on a single project's board (no hub): same panel, with the page heading.
export function ProjectBackupsPage() {
  const t = useT();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t("backup.title")}</h1>
          <p>{t("backup.pageIntro")}</p>
        </div>
      </div>
      <BackupsPanel base="/api/backup" kind="project" />
    </>
  );
}

function PassphraseShown({ value, onClose }: { value: string; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  return (
    <Modal onClose={onClose} title={t("backup.passphrase")}>
      <p className="muted mt-0">{t("backup.passphraseHint")}</p>
      <div className="secret">
        <code>{value}</code>
        <button className="btn sm" onClick={() => void navigator.clipboard.writeText(value).then(() => toast({ text: t("hub.copied") }))}>
          {t("hub.copy")}
        </button>
      </div>
      <div className="modal-foot">
        <button className="btn primary" onClick={onClose}>
          {t("hub.done")}
        </button>
      </div>
    </Modal>
  );
}

// Google's device sign-in: a code the person types at google.com/device, while this asks every few seconds.
function GoogleConnect({ base, onClose }: { base: string; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const [code, setCode] = useState<{ user_code: string; verification_url: string; interval: number } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [state, setState] = useState<"pending" | "denied" | "expired">("pending");

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (interval: number) => {
      if (stop) return;
      try {
        const r = await api<{ status: "pending" | "connected" | "denied" | "expired"; message?: string }>(`${base}/google/poll`, { method: "POST" });
        if (stop) return;
        if (r.status === "connected") {
          toast({ text: r.message ? `${t("backup.gdriveDone")} ${r.message}` : t("backup.gdriveDone"), error: !!r.message });
          onClose();
          return;
        }
        if (r.status !== "pending") return setState(r.status);
        timer = setTimeout(() => void poll(interval), interval * 1000);
      } catch (e) {
        if (!stop) setErr(e);
      }
    };
    api<{ user_code: string; verification_url: string; interval: number }>(`${base}/google/start`, { method: "POST" })
      .then((r) => {
        if (stop) return;
        setCode(r);
        timer = setTimeout(() => void poll(r.interval), r.interval * 1000);
      })
      .catch((e: unknown) => !stop && setErr(e));
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per dialog
  }, []);

  return (
    <Modal onClose={onClose} title={t("backup.gdriveConnect")}>
      <ErrorBox error={err} />
      {!code && !err ? (
        <Loading rows={2} />
      ) : code ? (
        <>
          <p className="mt-0">{t("backup.gdriveStep1")}</p>
          <p>
            <a href={code.verification_url} target="_blank" rel="noreferrer noopener" className="mono">
              {code.verification_url}
            </a>
          </p>
          <p>{t("backup.gdriveStep2")}</p>
          <div className="secret">
            <code className="backup-code">{code.user_code}</code>
            <button className="btn sm" onClick={() => void navigator.clipboard.writeText(code.user_code).then(() => toast({ text: t("hub.copied") }))}>
              {t("hub.copy")}
            </button>
          </div>
          <p className="faint" role="status">
            {state === "pending" ? t("backup.gdriveWaiting") : t(state === "denied" ? "backup.gdriveDenied" : "backup.gdriveExpired")}
          </p>
        </>
      ) : null}
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          {t("common.cancel")}
        </button>
      </div>
    </Modal>
  );
}

function RestoreDialog({
  base,
  kind,
  backup,
  onClose,
  onDone,
}: {
  base: string;
  kind: "hub" | "project";
  backup: Remote;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [passphrase, setPassphrase] = useState("");
  const [adopt, setAdopt] = useState(true);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api(`${base}/restore`, { method: "POST", body: { name: backup.name, ...(passphrase.trim() ? { passphrase, adopt } : {}) } });
      toast({ text: t(kind === "hub" ? "backup.stagedToast" : "backup.restoredToast") });
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={t("backup.restoreTitle")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <ErrorBox error={err} />
        <p className="mt-0">
          <span className="mono">{backup.name}</span> · <Ago iso={backup.at} />
        </p>
        <p className="muted">{t(kind === "hub" ? "backup.restoreHubBody" : "backup.restoreProjectBody")}</p>
        <div className="field">
          <label htmlFor="restore-passphrase">{t("backup.restorePassphrase")}</label>
          <input
            id="restore-passphrase"
            className="input mono"
            type="password"
            name="restore-archive-passphrase"
            {...noFill}
            autoComplete="new-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder={t("backup.restorePassphraseEmpty")}
          />
        </div>
        {passphrase.trim() && (
          <label htmlFor="restore-adopt" className="check">
            <input id="restore-adopt" type="checkbox" checked={adopt} onChange={(e) => setAdopt(e.target.checked)} /> {t("backup.restoreAdopt")}
          </label>
        )}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {t(kind === "hub" ? "backup.restorePrepare" : "backup.restore")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Asks the hub to restart, then waits for it to answer again and reloads the page (the restore is applied
// on the way; sessions live in hub.db, so a restored hub may ask to sign in again).
function Restarting() {
  const t = useT();
  const [state, setState] = useState<"asking" | "waiting" | "slow" | "failed">("asking");
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    let stop = false;
    const started = Date.now();
    const wait = async () => {
      let down = false;
      while (!stop) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const res = await fetch("/api/health", { cache: "no-store" });
          if (res.ok && (down || Date.now() - started > 8000)) return location.reload();
          if (!res.ok) down = true;
        } catch {
          down = true;
        }
        if (Date.now() - started > 60_000) setState("slow");
      }
    };
    api("/api/admin/restart", { method: "POST" })
      .then(() => {
        if (stop) return;
        setState("waiting");
        void wait();
      })
      .catch((e: unknown) => {
        setErr(e);
        setState("failed");
      });
    return () => {
      stop = true;
    };
  }, []);
  return (
    <Modal onClose={() => state === "failed" && location.reload()} title={t("backup.restartNow")}>
      <ErrorBox error={err} />
      {state !== "failed" && (
        <p className="mt-0" role="status">
          {t(state === "slow" ? "backup.restartSlow" : "backup.restartWaiting")}
        </p>
      )}
    </Modal>
  );
}
