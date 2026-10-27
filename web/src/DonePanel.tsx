import { useState } from "react";
import { parseChecklist } from "../../src/core/checklist";
import { api } from "./api";
import { useT } from "./i18n";
import type { Item } from "./types";
import { Progress, useAsk, useToast } from "./ui";

// A task a person has to do (assigned to them or to @humans): its steps are ticked in the text above, and
// this closes it with evidence, from a phone as easily as from a desk. Evidence is one commit hash or link
// per line; the reply carries it in the task's `evidence` field, where the reviewer looks.

export function DonePanel({ item, doneStatus, onDone }: { item: Item; doneStatus: string; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const { dialog, ask } = useAsk();
  const [evidence, setEvidence] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const boxes = parseChecklist(item.body);
  const open = boxes.filter((b) => !b.checked).length;
  const lines = evidence
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const bad = lines.filter((l) => !/^[0-9a-f]{7,40}$/i.test(l) && !/^https?:\/\/\S+$/.test(l));

  const finish = async () => {
    if (open > 0) {
      const sure = await ask({ title: t("done.title"), message: t("done.openSteps").replace("{n}", String(open)), confirm: t("done.button") });
      if (sure === null) return;
    }
    setBusy(true);
    try {
      await api(`/api/items/${item.id}/replies`, {
        method: "POST",
        body: { body: note.trim() || t("done.defaultNote"), status: doneStatus, fields: lines.length ? { evidence: lines } : {} },
      });
      toast({ text: t("done.closed") });
      onDone();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card done-panel" aria-labelledby="done-panel-title">
      <div className="done-head">
        <h3 id="done-panel-title">{t("done.title")}</h3>
        {boxes.length > 0 && <Progress done={boxes.length - open} total={boxes.length} />}
      </div>
      <p className="muted done-hint">{t(boxes.length ? "done.hintSteps" : "done.hint")}</p>
      <div className="field">
        <label htmlFor={`done-evidence-${item.id}`}>{t("done.evidence")}</label>
        <textarea
          id={`done-evidence-${item.id}`}
          className="textarea"
          rows={2}
          placeholder={t("done.evidencePlaceholder")}
          value={evidence}
          aria-invalid={bad.length > 0}
          aria-describedby={bad.length ? `done-evidence-err-${item.id}` : undefined}
          onChange={(e) => setEvidence(e.target.value)}
        />
        {bad.length > 0 && (
          <p id={`done-evidence-err-${item.id}`} className="field-error">
            {t("done.evidenceBad").replace("{line}", bad[0])}
          </p>
        )}
      </div>
      <div className="field">
        <label htmlFor={`done-note-${item.id}`}>{t("done.note")}</label>
        <textarea id={`done-note-${item.id}`} className="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="row done-actions">
        <span className="spacer" />
        <button type="button" className="btn primary" disabled={busy || bad.length > 0} onClick={() => void finish()}>
          {t("done.button")}
        </button>
      </div>
      {dialog}
    </section>
  );
}
