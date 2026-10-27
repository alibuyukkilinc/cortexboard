import { useEffect, useId, useState } from "react";
import { api } from "./api";
import { useT } from "./i18n";
import type { ReviewInfo } from "./types";
import { Ago, useAsk, useToast } from "./ui";

// Handed-in work waiting on a person's check. The inbox row and the item's own page show the same parts:
// what the agent asked to try, how long it has waited, and approve / send back (the item page only).

// What the agent asked the person to try, from the reply that handed the work in. Ticks are the person's own
// notes while trying: kept in this browser only, per hand-in, so a new hand-in starts clean. The inbox row and
// the item page share the key, so a step ticked in one is ticked in the other.
const TESTED = "cortex-tested";

export function ToTest({ id, steps, since }: { id: string; steps: string[]; since?: string }) {
  const t = useT();
  const key = `cortex.tested.${id}.${since ?? ""}`;
  // The inbox row and the open card can show the same list at once: each box's id is unique to its place.
  const uid = useId();
  const [done, setDone] = useState<number[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "[]") as number[];
    } catch {
      return [];
    }
  });
  // A tick in one place shows at once in the other (the inbox row stays mounted behind the open card).
  useEffect(() => {
    const on = (e: Event) => {
      const { detail } = e as CustomEvent<{ key: string; done: number[] }>;
      if (detail.key === key) setDone(detail.done);
    };
    window.addEventListener(TESTED, on);
    return () => window.removeEventListener(TESTED, on);
  }, [key]);
  const toggle = (i: number) => {
    const next = done.includes(i) ? done.filter((x) => x !== i) : [...done, i];
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // storage blocked: the ticks last for this page only
    }
    window.dispatchEvent(new CustomEvent(TESTED, { detail: { key, done: next } }));
  };
  return (
    <div className="to-test">
      <span className="to-test-head">
        {t("notif.toTest")} <span className="faint">{`${done.filter((i) => i < steps.length).length}/${steps.length}`}</span>
      </span>
      <ul>
        {steps.map((s, i) => (
          <li key={i}>
            <label className="check" htmlFor={`${uid}-${i}`}>
              <input id={`${uid}-${i}`} type="checkbox" checked={done.includes(i)} onChange={() => toggle(i)} />
              <span className={done.includes(i) ? "done" : ""}>
                {/* `code` in a step stays code: file names and commands are what the person copies. */}
                {s.split("`").map((part, n) => (n % 2 ? <code key={n}>{part}</code> : part))}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Handed-in work waiting on the person for REMIND_DAYS or more says so (the agent's brief says it too).
const REMIND_DAYS = 3;
export function WaitingChip({ since }: { since?: string }) {
  const t = useT();
  if (!since) return null;
  const days = Math.floor((Date.now() - Date.parse(since)) / 86_400_000);
  if (days < REMIND_DAYS) return null;
  return <span className="chip warn">{t("notif.waitingDays").replace("{n}", String(days))}</span>;
}

// The item page's version of the inbox row: shown only when the server says this item waits on this
// person's check (GET /api/items/:id `review`). The moves are the same requests the inbox row sends.
export function ReviewPanel({ id, review, onDone }: { id: string; review: ReviewInfo; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const { dialog, ask } = useAsk();
  const [busy, setBusy] = useState(false);
  const { approve, send_back } = review.moves;
  const run = async (req: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await req();
      toast({ text: done });
      onDone();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  const sendBack = async (status: string) => {
    const note = await ask({ title: t("notif.sendBack"), input: { label: t("notif.sendBackPrompt") }, confirm: t("notif.sendBack") });
    if (note === null) return;
    void run(() => api(`/api/items/${id}/replies`, { method: "POST", body: { body: note || t("notif.sentBackDefault"), status } }), t("notif.sentBack"));
  };
  return (
    <section className="card review-panel" aria-labelledby={`review-panel-${id}`}>
      <div className="review-head">
        <h3 id={`review-panel-${id}`}>{t("notif.waitingOnYou")}</h3>
        {review.waiting_since && (
          <span className="muted text-xs">
            <Ago iso={review.waiting_since} />
          </span>
        )}
        <WaitingChip since={review.waiting_since} />
        <span className="review-actions">
          {approve && (
            <button
              type="button"
              className="btn sm primary"
              disabled={busy}
              onClick={() => void run(() => api(`/api/items/${id}`, { method: "PATCH", body: { status: approve } }), t("notif.approved"))}
            >
              {t("notif.approve")}
            </button>
          )}
          {send_back && (
            <button type="button" className="btn sm" disabled={busy} onClick={() => void sendBack(send_back)}>
              {t("notif.sendBack")}
            </button>
          )}
        </span>
      </div>
      <p className="muted review-hint">{t("notif.reviewsWhy")}</p>
      {review.to_test?.length ? <ToTest id={id} steps={review.to_test} since={review.waiting_since} /> : null}
      {dialog}
    </section>
  );
}
