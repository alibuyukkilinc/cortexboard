import { useContext, useEffect, useRef, useState } from "react";
import type { Lang } from "./i18n";
import { LangContext, useT } from "./i18n";
import { Icon, useToast } from "./ui";

// Voice typing for every text field: one small mic button at the right edge of the field that has focus,
// instead of a wrapper around each input. It uses the browser's own speech recognition (Web Speech API), in
// the board's language. Browsers without it (Firefox) show no button. In Chrome and Edge the audio goes to
// the browser vendor's speech service; the tooltip says so. Ctrl+Shift+Space toggles it from the keyboard,
// Escape stops it.

type Field = HTMLInputElement | HTMLTextAreaElement;

interface Alternative {
  transcript: string;
}
interface Result {
  isFinal: boolean;
  0: Alternative;
}
interface ResultEvent {
  resultIndex: number;
  results: ArrayLike<Result>;
}
interface Recognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: ResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognizerClass = new () => Recognizer;

export function recognizer(): RecognizerClass | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognizerClass; webkitSpeechRecognition?: RecognizerClass };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

const PROSE = new Set(["text", "search"]);

// A field that takes prose: textareas and plain text inputs, not passwords, emails, numbers or dates.
export function dictatable(el: EventTarget | null): el is Field {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled && !el.hasAttribute("data-no-dictation");
  if (el instanceof HTMLInputElement) return PROSE.has(el.type) && !el.readOnly && !el.disabled && !el.hasAttribute("data-no-dictation");
  return false;
}

// Punctuation said out loud. Whole words only (\b does not see Turkish letters, hence the lookarounds).
const word = (w: string) => new RegExp(`\\s*(?<!\\p{L})${w}(?!\\p{L})`, "giu");
const SPOKEN: Record<Lang, [RegExp, string][]> = {
  tr: [
    [word("(?:yeni|alt) satır"), "\n"],
    [word("soru işareti"), "?"],
    [word("ünlem(?: işareti)?"), "!"],
    [word("iki nokta"), ":"],
    [word("noktalı virgül"), ";"],
    [word("virgül"), ","],
    [word("nokta"), "."],
  ],
  en: [
    [word("new (?:line|paragraph)"), "\n"],
    [word("question mark"), "?"],
    [word("exclamation (?:mark|point)"), "!"],
    [word("colon"), ":"],
    [word("semicolon"), ";"],
    [word("comma"), ","],
    [word("(?:period|full stop)"), "."],
  ],
};

export function spoken(text: string, lang: Lang): string {
  let out = text;
  for (const [re, mark] of SPOKEN[lang]) out = out.replace(re, mark);
  return out.replace(/\n +/g, "\n").replace(/^ +| +$/g, ""); // spaces only: a spoken new line stays
}

// Puts what was said at the caret: a space before it when needed, a capital at the start of a sentence,
// then an input event so React's onChange sees it like typing.
export function insertSpoken(el: Field, said: string, lang: Lang) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const before = el.value.slice(0, start);
  let piece = said;
  if (!piece) return;
  if (!before.trim() || /[.?!\n]\s*$/.test(before)) piece = piece.charAt(0).toLocaleUpperCase(lang) + piece.slice(1);
  if (before && !/\s$/.test(before) && !/^[,.?!:;\n]/.test(piece)) piece = ` ${piece}`;
  // The prototype's setter, not el.value: React watches the element's own value property and would take the
  // new text for its own write, skip onChange, and put the old value back.
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, before + piece + el.value.slice(end));
  const caret = start + piece.length;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const SIZE = 28;

export function Dictation() {
  const t = useT();
  const toast = useToast();
  const { lang } = useContext(LangContext);
  const Rec = typeof window === "undefined" ? undefined : recognizer();
  const [field, setField] = useState<Field | null>(null);
  const [box, setBox] = useState<DOMRect | null>(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const rec = useRef<Recognizer | null>(null);
  const live = useRef({ field, listening, lang });
  live.current = { field, listening, lang };

  useEffect(() => {
    document.documentElement.classList.toggle("can-dictate", !!Rec);
  }, [Rec]);

  const stop = () => rec.current?.stop();

  const start = () => {
    const el = live.current.field;
    if (!Rec || !el) return;
    const r = new Rec();
    r.lang = live.current.lang === "tr" ? "tr-TR" : "en-US";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let pending = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) insertSpoken(el, spoken(res[0].transcript, live.current.lang), live.current.lang);
        else pending += res[0].transcript;
      }
      setInterim(pending);
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      const key = e.error === "not-allowed" || e.error === "service-not-allowed" ? "dict.denied" : e.error === "network" ? "dict.network" : "dict.failed";
      toast({ text: t(key), error: true });
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
      setInterim("");
    };
    rec.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      rec.current = null;
    }
  };
  const toggle = () => (live.current.listening ? stop() : start());
  // The keyboard shortcut is bound once; it reaches the current `start` through this ref.
  const startRef = useRef(start);
  startRef.current = start;

  // Follow focus: the button belongs to the field being edited. Leaving the field stops listening.
  useEffect(() => {
    if (!Rec) return;
    const onIn = (e: FocusEvent) => {
      if (dictatable(e.target)) setField(e.target);
    };
    const onOut = (e: FocusEvent) => {
      if (e.target !== live.current.field) return;
      if (live.current.listening) rec.current?.stop();
      setField(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!live.current.field) return;
      if (e.key === "Escape" && live.current.listening) {
        e.stopPropagation();
        rec.current?.stop();
      } else if (e.code === "Space" && e.shiftKey && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (live.current.listening) rec.current?.stop();
        else startRef.current();
      }
    };
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [Rec]);

  // Where the field is: on focus, and when the page scrolls or the field is resized (a growing textarea).
  // A field in a dialog is focused while the dialog still slides in (a transform, which no observer reports),
  // and the dialog can move again after that: it is centred, so content that arrives late (or a slow machine
  // finishing the slide late) shifts it with nothing to announce it. So the field is measured every frame for
  // as long as it has focus; nothing is redrawn while it stands still. It is one field, and only while focused.
  useEffect(() => {
    if (!field) return setBox(null);
    const place = () => {
      const r = field.isConnected ? field.getBoundingClientRect() : null;
      setBox((b) => (b && r && b.top === r.top && b.right === r.right && b.height === r.height ? b : r));
    };
    place();
    let frame = 0;
    const follow = () => {
      place();
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    const ro = new ResizeObserver(place);
    ro.observe(field);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    document.addEventListener("animationend", place, true);
    document.addEventListener("transitionend", place, true);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("animationend", place, true);
      document.removeEventListener("transitionend", place, true);
    };
  }, [field]);

  if (!Rec || !field || !box) return null;
  const multiline = field instanceof HTMLTextAreaElement;
  const top = multiline ? box.top + 6 : box.top + (box.height - SIZE) / 2;
  const label = listening ? t("dict.stop") : t("dict.start");
  return (
    <div className="dictation" style={{ top, left: box.right - SIZE - 6 }}>
      <button
        type="button"
        className={`dictation-btn${listening ? " on" : ""}`}
        aria-label={label}
        aria-pressed={listening}
        title={`${label} (Ctrl+Shift+Space). ${t("dict.privacy")}`}
        // Keeps the focus (and the caret) in the field.
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
      >
        <Icon name="mic" size={15} />
      </button>
      <div className="sr-only" aria-live="polite">
        {listening ? t("dict.listening") : ""}
      </div>
      {listening && (
        <div className="dictation-bubble" aria-hidden>
          {interim || t("dict.listening")}
        </div>
      )}
    </div>
  );
}
