import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, useApi } from "./api";
import { chime } from "./chime";
import { useT } from "./i18n";
import type { BoardPrompt } from "./types";
import { Markdown, Modal, useSession, useToast } from "./ui";

// Questions an AI asked this person on the board, because its client cannot show them in the chat
// (decision 01M3PCTFYV4WPM0APNNJJ9YJQG). One at a time, as a dialog over whatever page is open. Choosing
// and sending are two steps; closing the dialog means "later", never "no". The server applies the answer
// as the person's; the AI reads the outcome by the question's id.

interface Prompts {
  waiting: BoardPrompt[];
  show: (id: string) => void;
}
const PromptsContext = createContext<Prompts>({ waiting: [], show: () => {} });
export const useBoardPrompts = () => useContext(PromptsContext);

export function BoardPrompts({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const person = me.kind === "human";
  const { data, reload } = useApi<{ prompts: BoardPrompt[] }>(person ? "/api/chat/prompts" : null, { on: ["chat"] });
  const waiting = useMemo(() => data?.prompts ?? [], [data]);
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());
  const current = waiting.find((p) => !later.has(p.id));
  useNotify(waiting);

  const value = useMemo<Prompts>(
    () => ({
      waiting,
      show: (id) =>
        setLater((s) => {
          const next = new Set(s);
          next.delete(id);
          // Everything else goes behind it, so the one asked for is the one shown.
          for (const p of waiting) if (p.id !== id) next.add(p.id);
          return next;
        }),
    }),
    [waiting],
  );

  return (
    <PromptsContext.Provider value={value}>
      {children}
      {current && (
        <PromptDialog
          key={current.id}
          prompt={current}
          more={waiting.filter((p) => p.id !== current.id && !later.has(p.id)).length}
          onLater={() => setLater((s) => new Set(s).add(current.id))}
          onDone={reload}
        />
      )}
      {!current && waiting.length > 0 && <WaitingPill count={waiting.length} onOpen={() => setLater(new Set())} />}
    </PromptsContext.Provider>
  );
}

// A question put off with "later" stays one click away on every page.
function WaitingPill({ count, onOpen }: { count: number; onOpen: () => void }) {
  const t = useT();
  return (
    <button type="button" className="prompt-pill" onClick={onOpen}>
      {t("prompt.waiting").replace("{n}", String(count))}
    </button>
  );
}

// The same question the chat would have shown: the record as Cortex put it, then the form.
function PromptDialog({ prompt, more, onLater, onDone }: { prompt: BoardPrompt; more: number; onLater: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = Object.entries(prompt.schema.properties);
  const required = prompt.schema.required ?? [];
  const missing = required.some((k) => !values[k]?.trim());
  const set = (k: string, v: string) => setValues((x) => ({ ...x, [k]: v }));

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/chat/prompts/${prompt.id}/answer`, { method: "POST", body: { answer: values } });
      toast({ text: t("prompt.sent") });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title={t("prompt.title").replace("{ai}", prompt.ai_actor)} onClose={onLater}>
      <form
        className="prompt"
        onSubmit={(e) => {
          e.preventDefault();
          if (!missing && !busy) void send();
        }}
      >
        <p className="muted text-sm">{t("prompt.why")}</p>
        <div className="prompt-message">
          <Markdown text={prompt.message} />
        </div>
        {fields.map(([name, spec]) => {
          const id = `prompt-${prompt.id}-${name}`;
          const label = `${spec.title ?? name}${required.includes(name) ? " *" : ""}`;
          if (spec.enum) {
            // A question's own options can be sentences: one per line then, not squeezed into a button row.
            const stacked = spec.enum.length > 3 || spec.enum.some((v) => optionLabel(t, v).length > 16);
            return (
              <div className="field" key={name} role="radiogroup" aria-labelledby={`${id}-label`}>
                <span id={`${id}-label`} className="label">
                  {label}
                </span>
                <div className={stacked ? "prompt-choices" : "segmented"}>
                  {spec.enum.map((v) => (
                    <button
                      key={v}
                      type="button"
                      role="radio"
                      aria-checked={values[name] === v}
                      className={values[name] === v ? "on" : ""}
                      onClick={() => set(name, v)}
                    >
                      {optionLabel(t, v)}
                    </button>
                  ))}
                </div>
              </div>
            );
          }
          return (
            <div className="field" key={name}>
              <label htmlFor={id}>{label}</label>
              <textarea id={id} className="textarea" rows={2} value={values[name] ?? ""} onChange={(e) => set(name, e.target.value)} />
            </div>
          );
        })}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="modal-foot">
          <NotifyToggle />
          {more > 0 && <span className="muted text-xs grow">{t("prompt.more").replace("{n}", String(more))}</span>}
          <button type="button" className="btn" onClick={onLater}>
            {t("prompt.later")}
          </button>
          <button type="submit" className="btn primary" disabled={missing || busy}>
            {t("prompt.send")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const OPTIONS = ["approve", "reject", "skip", "accept", "yes", "no", "save", "discard"] as const;
function optionLabel(t: ReturnType<typeof useT>, v: string): string {
  return (OPTIONS as readonly string[]).includes(v) ? t(`prompt.opt.${v}` as Parameters<typeof t>[0]) : v;
}

// A new question: a chime, and while the tab is in the background a notification too, if they allowed it.
function useNotify(waiting: BoardPrompt[]) {
  const t = useT();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(waiting.map((p) => p.id));
    // The first list is what was already waiting when the page opened: shown, not announced.
    if (seen.current === null) {
      seen.current = ids;
      return;
    }
    const fresh = waiting.filter((p) => !seen.current!.has(p.id));
    seen.current = ids;
    if (!fresh.length) return;
    chime(); // heard from another window too; the owner asked for it (2026-09-29)
    if (!document.hidden || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      new Notification(t("prompt.title").replace("{ai}", fresh[0].ai_actor), { body: fresh[0].title, tag: fresh[0].id });
    } catch {
      // some browsers only notify from a service worker: the dialog is still there when they come back
    }
  }, [waiting, t]);
}

// Asks the browser once, from a click, so questions can reach the person while the tab is in the background.
export function NotifyToggle() {
  const t = useT();
  const [state, setState] = useState(() => (typeof Notification === "undefined" ? "unsupported" : Notification.permission));
  if (state !== "default") return null;
  return (
    <button type="button" className="btn sm" onClick={() => void Notification.requestPermission().then(setState)}>
      {t("prompt.notify")}
    </button>
  );
}
