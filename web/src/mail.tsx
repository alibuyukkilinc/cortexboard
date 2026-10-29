import { useState } from "react";
import { api, useApi } from "./api";
import { useT } from "./i18n";
import { ErrorBox, Icon, Loading, useToast } from "./ui";

// Email for the hub (Organization → Email, /api/admin/mail): Resend sends the "forgot password" links.
// The key goes in and never comes back out; only its last four characters are shown.

type Status = { provider: "resend" | null; from: string; key_last4: string | null; key_from_env: boolean; ready: boolean };

// Password managers see a text box above a password box as a sign-in form and fill the person's account in.
const noFill = { autoComplete: "off", "data-1p-ignore": true, "data-lpignore": "true" } as const;

export function MailPanel() {
  const t = useT();
  const toast = useToast();
  const status = useApi<Status>("/api/admin/mail");
  const d = status.data;
  const [form, setForm] = useState<{ from: string; key: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (!d) return <Loading />;
  const f = form ?? { from: d.from, key: "" };
  const hasKey = !!d.key_last4;
  const canSave = !busy && !!f.from.trim() && (hasKey || !!f.key.trim());

  const act = async (fn: () => Promise<void>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      await api("/api/admin/mail", { method: "PUT", body: { provider: "resend", from: f.from, ...(f.key.trim() ? { api_key: f.key } : {}) } });
      setForm(null);
      status.reload();
      toast({ text: t("mail.saved") });
    });
  const test = () =>
    act(async () => {
      const r = await api<{ to: string }>("/api/admin/mail/test", { method: "POST" });
      toast({ text: t("mail.testSent").replace("{to}", r.to) });
    });
  const off = () =>
    act(async () => {
      if (!confirm(t("mail.offConfirm"))) return;
      await api("/api/admin/mail", { method: "PUT", body: { provider: "off" } });
      setForm(null);
      status.reload();
    });

  return (
    <>
      <div className="toolbar">
        <span className="faint">
          <span className={`chip ${d.ready ? "ok" : "warn"}`}>{t(d.ready ? "mail.on" : "mail.offState")}</span>{" "}
          {d.ready && <span className="mono">{d.from}</span>}
        </span>
        <span className="spacer" />
        <button className="btn" disabled={!d.ready || busy || !!form} onClick={() => void test()}>
          <Icon name="zap" /> {t("mail.test")}
        </button>
      </div>
      <section className="card backup-panel" aria-labelledby="mail-settings">
        <h3 id="mail-settings">{t("mail.settings")}</h3>
        <p className="muted mt-0">{t("mail.intro")}</p>
        <ErrorBox error={err} />
        <div className="field">
          <label htmlFor="mail-from">{t("mail.from")}</label>
          <input
            id="mail-from"
            name="mail-from"
            className="input mono"
            {...noFill}
            value={f.from}
            onChange={(e) => setForm({ ...f, from: e.target.value })}
            placeholder="Cortex <no-reply@example.com>"
          />
          <span className="hint">{t("mail.fromHint")}</span>
        </div>
        <div className="field">
          <label htmlFor="mail-key">{t("mail.key")}</label>
          <input
            id="mail-key"
            name="mail-resend-key"
            type="password"
            className="input mono"
            {...noFill}
            autoComplete="new-password"
            value={f.key}
            onChange={(e) => setForm({ ...f, key: e.target.value })}
            placeholder={hasKey ? t("mail.keySaved").replace("{last4}", d.key_last4!) : "re_…"}
          />
          <span className="hint">{t(d.key_from_env ? "mail.keyEnv" : "mail.keyHint")}</span>
        </div>
        <div className="backup-actions">
          <button className="btn primary" disabled={!canSave} onClick={() => void save()}>
            {t("mail.save")}
          </button>
          {form && (
            <button className="btn ghost" onClick={() => setForm(null)}>
              {t("common.cancel")}
            </button>
          )}
          <span className="spacer" />
          {d.provider && (
            <button className="btn ghost" disabled={busy} onClick={() => void off()}>
              {t("mail.turnOff")}
            </button>
          )}
        </div>
      </section>
    </>
  );
}
