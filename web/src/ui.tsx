import DOMPurify from "dompurify";
import { marked } from "marked";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ApiError, LoadGate } from "./api";
import { LoadGateContext, api } from "./api";
import { GLOSSARY, LangContext, timeAgo, useLabels, useT } from "./i18n";
import type { Actor, Reply } from "./types";

// ---- routing (hash based: works from any static file server) --------------------

export function useRoute(): string[] {
  const read = () => decodeURIComponent(location.hash.replace(/^#\/?/, "")).split("?")[0].split("/").filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parts;
}

export function routeQuery(): URLSearchParams {
  return new URLSearchParams(location.hash.split("?")[1] ?? "");
}

// The icon of an item type; a project's own types get a plain document.
export const typeIcon = (type: string) => (["task", "issue", "question", "note", "decision"].includes(type) ? `type-${type}` : "file");

export const go = (path: string) => {
  location.hash = `#/${path.replace(/^\/+/, "")}`;
};

// ---- icons (inline, stroke-based) ------------------------------------------------

const paths: Record<string, string> = {
  // Item types (typeIcon): a ticked box, a bug, a question in a circle, a folded note, balance scales.
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
  "type-task": "M5 5h14v14H5zM9 12l2 2 4-4",
  "type-issue": "M8 10h8v5a4 4 0 0 1-8 0zM9.5 10V8.5a2.5 2.5 0 0 1 5 0V10M4 13h4M16 13h4M5 8.5l3 2M19 8.5l-3 2M5 19l3-2M19 19l-3-2",
  "type-question": "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17v.5",
  "type-note": "M5 4h14v10l-6 6H5zM13 20v-6h6",
  "type-decision": "M12 4v16M8 20h8M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0z",
  inbox: "M4 13h4l2 3h4l2-3h4M4 13l2-8h12l2 8v6H4z",
  board: "M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v11h-4z",
  report: "M4 20h16M7 16v-4M12 16V6M17 16v-7",
  tree: "M6 4v16M6 8h8M6 16h8M14 6h6v4h-6zM14 14h6v4h-6z",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  check: "M5 12l5 5L20 7",
  rules: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  sun: "M12 4V2M12 22v-2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z",
  moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z",
  x: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
  chevron: "M9 6l6 6-6 6",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z",
  ask: "M9 9a3 3 0 1 1 4 2.8c-.6.3-1 .9-1 1.6V14M12 17.5v.5M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  file: "M14 3H6v18h12V7zM14 3v4h4",
  logout: "M15 4h4v16h-4M10 17l-5-5 5-5M5 12h11",
  alert: "M12 9v4M12 17v.5M10.3 4.3L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z",
  edit: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  chat: "M5 5h14v10H9l-4 4z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c0-3.3 3.6-6 8-6s8 2.7 8 6",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z",
  zap: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  target: "M12 12m-9 0a9 9 0 1 0 18 0 9 9 0 1 0-18 0M12 12m-5 0a5 5 0 1 0 10 0 5 5 0 1 0-10 0M12 12m-1 0a1 1 0 1 0 2 0 1 1 0 1 0-2 0",
  percent: "M19 5L5 19M6.5 6.5m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0M17.5 17.5m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0",
  star: "M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z",
  sidebar: "M4 5h16v14H4zM10 5v14",
  clip: "M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5m-1.5 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  text: "M4 6h16M4 11h16M4 16h10",
  clock: "M12 12m-9 0a9 9 0 1 0 18 0 9 9 0 1 0-18 0M12 7v5l3 2",
  debate: "M3 5h11v8H7l-4 3zM10 16h7l4 3v-9h-4",
  archive: "M3 5h18v4H3zM5 9v10h14V9M10 13h4",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 12m-3 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0",
};

export function Icon({ name, size = 16 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={paths[name] ?? ""} />
    </svg>
  );
}

// ---- small pieces -----------------------------------------------------------------

const WITH_BLOB = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

// `files`: where "files/<name>" links point: the attachments' URL base of the item this text belongs to,
// or a function for files that exist only in the browser so far (a new item's pasted screenshots).
// `checklist`: makes the task boxes clickable. `lines` are the boxes' lines in the source (parseChecklist),
// in order; a box is ticked through onToggle(line, checked). If the rendered boxes do not match those lines
// one to one, the boxes stay read-only rather than tick the wrong step.
export function Markdown({
  text,
  files,
  checklist,
}: {
  text: string;
  files?: string | ((name: string) => string);
  checklist?: { lines: number[]; onToggle: (line: number, checked: boolean) => void; disabled?: boolean };
}) {
  const t = useT();
  const done = t("md.taskDone");
  const open = t("md.taskOpen");
  const words = useMemo(() => ({ copy: t("md.copy"), copyCode: t("md.copyCode"), table: t("md.table") }), [t]);
  const html = useMemo(() => {
    let src = text ?? "";
    if (typeof files === "string") src = src.replace(/\]\((<?)files\//g, (_m, lt: string) => `](${lt}${files}/`);
    else if (files) src = src.replace(/\]\(<files\/([^>]+)>\)|\]\(files\/([^)\s]+)\)/g, (_m, a?: string, b?: string) => `](<${files(a ?? b ?? "")}>)`);
    // A task list's boxes are read-only here and have no label of their own: say what each one means.
    let n = 0;
    const checkbox = ({ checked }: { checked: boolean }) =>
      `<input type="checkbox" disabled data-box="${n++}"${checked ? " checked" : ""} aria-label="${checked ? done : open}"> `;
    const html = marked.parse(src, { async: false, gfm: true, breaks: true, renderer: Object.assign(new marked.Renderer(), { checkbox }) }) as string;
    // Files not uploaded yet are shown from blob: URLs this page made itself; DOMPurify drops those by
    // default, so they are allowed only in that case, next to its usual list.
    const clean = typeof files === "function" ? DOMPurify.sanitize(html, { ALLOWED_URI_REGEXP: WITH_BLOB }) : DOMPurify.sanitize(html);
    return enhance(linkRefs(clean), words);
  }, [text, files, done, open, words]);
  // Copy buttons on code blocks: the text is the block's, the button says it worked for a moment.
  const copied = t("md.copied");
  useEffect(() => {
    const el = box.current;
    if (!el || !html.includes("copy-btn")) return;
    const onClick = (e: Event) => {
      const btn = e.target instanceof HTMLElement ? e.target.closest<HTMLButtonElement>("button.copy-btn") : null;
      const code = btn?.parentElement?.querySelector("pre");
      if (!btn || !code) return;
      void navigator.clipboard?.writeText(code.textContent ?? "").then(() => {
        const was = btn.textContent;
        btn.textContent = copied;
        window.setTimeout(() => (btn.textContent = was), 1500);
      });
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [html, copied]);
  const box = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [, loaded] = useState(0);
  // Boxes become clickable only when there are exactly as many as the source has.
  const toggle = useRef(checklist?.onToggle);
  toggle.current = checklist?.onToggle;
  const lines = checklist?.lines.join(",");
  useEffect(() => {
    const el = box.current;
    if (!el || lines === undefined) return;
    const boxes = [...el.querySelectorAll<HTMLInputElement>("input[type=checkbox][data-box]")];
    const at = lines ? lines.split(",").map(Number) : [];
    if (boxes.length !== at.length) return;
    for (const b of boxes) b.disabled = !!checklist?.disabled;
    const onChange = (e: Event) => {
      const input = e.target as HTMLInputElement;
      if (input.dataset.box === undefined) return;
      toggle.current?.(at[Number(input.dataset.box)], input.checked);
    };
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, [html, lines, checklist?.disabled]);
  // Delegated listeners on the rendered text: the links are HTML from Markdown, not React elements.
  useEffect(() => {
    const el = box.current;
    if (!el || !html.includes("data-ref=")) return;
    let current: HTMLElement | null = null;
    const linkOf = (e: Event) => (e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("a.ref") : null);
    const show = (e: Event) => {
      const link = linkOf(e);
      if (!link) return;
      // Every id in this text in one request, the first time any of them is pointed at.
      void loadRefs(el).then(() => loaded((n) => n + 1));
      current?.removeAttribute("aria-describedby");
      current = link;
      link.setAttribute("aria-describedby", REF_POP_ID);
      setPop({ id: link.dataset.ref!, rect: link.getBoundingClientRect() });
    };
    const hide = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (!(e instanceof KeyboardEvent) && !linkOf(e)) return;
      current?.removeAttribute("aria-describedby");
      current = null;
      setPop(null);
    };
    el.addEventListener("mouseover", show);
    el.addEventListener("focusin", show);
    el.addEventListener("mouseout", hide);
    el.addEventListener("focusout", hide);
    el.addEventListener("keydown", hide);
    return () => {
      el.removeEventListener("mouseover", show);
      el.removeEventListener("focusin", show);
      el.removeEventListener("mouseout", hide);
      el.removeEventListener("focusout", hide);
      el.removeEventListener("keydown", hide);
    };
  }, [html]);
  if (!text?.trim()) return null;
  return (
    <>
      <div ref={box} className="md" dangerouslySetInnerHTML={{ __html: html }} />
      {pop && <RefPreview id={pop.id} rect={pop.rect} />}
    </>
  );
}

// ---- references ------------------------------------------------------------------------
// Item and activity ids (ULIDs) in Markdown become links to what they name, with a preview card on hover or
// focus. Ids inside code blocks stay text; an inline code span holding just an id is linked as a whole.

const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
const REF_POP_ID = "ref-preview";

function refLink(doc: Document, id: string, child: Node): HTMLAnchorElement {
  const a = doc.createElement("a");
  a.className = "ref";
  a.href = `#/item/${id}`;
  a.dataset.ref = id;
  a.appendChild(child);
  return a;
}

// Reading aids on rendered Markdown: a copy button on each code block, tables in a region that scrolls
// sideways on a phone (focusable, so a keyboard can scroll it), and an "Acceptance criteria" section set
// apart in its own box.
// Not \b: it does not see a word end after "ü".
const ACCEPTANCE = /^(acceptance criteria|kabul kriterleri|kabul ölçütleri|kabul ölçütü)(?=[\s:(]|$)/i;

export function enhance(html: string, words: { copy: string; copyCode: string; table: string }): string {
  if (typeof document === "undefined" || !/<(pre|table|h[1-6])[\s>]/.test(html)) return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const doc = tpl.content.ownerDocument;
  for (const pre of [...tpl.content.querySelectorAll("pre")]) {
    const wrap = doc.createElement("div");
    wrap.className = "code-block";
    pre.replaceWith(wrap);
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.setAttribute("aria-label", words.copyCode);
    btn.textContent = words.copy;
    wrap.append(pre, btn);
  }
  for (const table of [...tpl.content.querySelectorAll("table")]) {
    const wrap = doc.createElement("div");
    wrap.className = "table-wrap";
    wrap.setAttribute("role", "region");
    wrap.setAttribute("tabindex", "0");
    wrap.setAttribute("aria-label", words.table);
    table.replaceWith(wrap);
    wrap.append(table);
  }
  for (const h of [...tpl.content.querySelectorAll("h1, h2, h3, h4, h5, h6")]) {
    if (!ACCEPTANCE.test(h.textContent?.trim() ?? "") || h.parentNode !== tpl.content) continue;
    const level = Number(h.tagName[1]);
    const section = doc.createElement("section");
    section.className = "acceptance";
    h.before(section);
    let next: Element | null = h;
    while (next && !(next !== h && /^H[1-6]$/.test(next.tagName) && Number(next.tagName[1]) <= level)) {
      const after: Element | null = next.nextElementSibling;
      section.append(next);
      next = after;
    }
  }
  return tpl.innerHTML;
}

export function linkRefs(html: string): string {
  if (typeof document === "undefined" || !/[0-9A-HJKMNP-TV-Z]{26}/.test(html)) return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const doc = tpl.content.ownerDocument;
  for (const code of [...tpl.content.querySelectorAll("code")]) {
    const id = code.textContent?.trim() ?? "";
    if (!code.closest("pre, a") && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) code.replaceWith(refLink(doc, id, code.cloneNode(true)));
  }
  const walker = doc.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const node of texts) {
    const value = node.nodeValue ?? "";
    if (!ULID.test(value) || node.parentElement?.closest("pre, code, a")) continue;
    ULID.lastIndex = 0;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of value.matchAll(ULID)) {
      frag.append(value.slice(last, m.index), refLink(doc, m[0], doc.createTextNode(m[0])));
      last = m.index + m[0].length;
    }
    frag.append(value.slice(last));
    node.replaceWith(frag);
  }
  return tpl.innerHTML;
}

type Ref =
  { kind: "item"; type: string; title: string; status: string; assignee?: string } | { kind: "activity"; actor: string; at: string; summary: string } | null;
// Previews already fetched (null = unknown or not visible to this person), shared by every text on the page.
const refCache = new Map<string, Ref>();
const refPending = new Map<string, Promise<void>>();

async function loadRefs(box: HTMLElement): Promise<void> {
  const links = [...box.querySelectorAll<HTMLAnchorElement>("a.ref")];
  const ids = [...new Set(links.map((a) => a.dataset.ref!))];
  const missing = ids.filter((id) => !refCache.has(id) && !refPending.has(id));
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const p = api<{ refs: Record<string, Ref> }>(`/api/refs?ids=${chunk.join(",")}`)
      .then((r) => chunk.forEach((id) => refCache.set(id, r.refs[id] ?? null)))
      .catch(() => chunk.forEach((id) => refCache.set(id, null)))
      .finally(() => chunk.forEach((id) => refPending.delete(id)));
    chunk.forEach((id) => refPending.set(id, p));
  }
  await Promise.all(ids.flatMap((id) => refPending.get(id) ?? []));
  // Point each link where its record lives: an activity entry is not an item, a discussion has its own screen.
  for (const a of links) {
    const r = refCache.get(a.dataset.ref!);
    if (r?.kind === "activity") a.href = "#/activity";
    else if (r?.kind === "item" && r.type === "discussion") a.href = `#/discussions/${a.dataset.ref}`;
  }
}

function RefPreview({ id, rect }: { id: string; rect: DOMRect }) {
  const t = useT();
  const r = refCache.get(id);
  const width = 300;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const below = rect.bottom + 140 < window.innerHeight;
  const style = { left, width, ...(below ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }) };
  return (
    <div className="ref-preview" id={REF_POP_ID} role="tooltip" style={style}>
      {r === undefined ? (
        <span className="muted">{t("common.loading")}</span>
      ) : r === null ? (
        <span className="muted">{t("ref.unknown")}</span>
      ) : r.kind === "item" ? (
        <>
          <div className="ref-preview-meta">
            <TypeChip type={r.type} />
            <StatusChip status={r.status} />
          </div>
          <strong>{r.title}</strong>
        </>
      ) : (
        <>
          <div className="ref-preview-meta muted">
            {r.actor} · <Ago iso={r.at} />
          </div>
          <span>{r.summary}</span>
        </>
      )}
    </div>
  );
}

export function ActorChip({ id, actors }: { id?: string; actors: Actor[] }) {
  const t = useT();
  if (!id) return <span className="chip">{t("common.unassigned")}</span>;
  if (id === "@ai") return <span className="chip ai">@ai</span>;
  if (id === "@humans") return <span className="chip human">@humans</span>;
  const kind = actors.find((a) => a.id === id)?.kind ?? "human";
  return <span className={`chip ${kind}`}>{id}</span>;
}

// A person's answer given in the AI chat instead of on the board; relayed ones (the AI quoted them) say unverified.
export function ViaChip({ via }: { via?: Reply["via"] }) {
  const t = useT();
  if (!via) return null;
  if (via.channel === "board-prompt") {
    return (
      <span className="chip ai" title={t("via.boardTitle").replace("{ai}", via.ai_actor)}>
        {t("via.board")}
      </span>
    );
  }
  const relayed = via.channel === "chat-relayed";
  // Relayed and applied on the AI's word: unverified. Relayed, then confirmed by the person on the board: not.
  const unverified = relayed && !via.confirmed_by;
  const title = (relayed ? t("via.relayedTitle") : t("via.chatTitle")).replace("{ai}", via.ai_actor).replace("{quote}", via.verbatim ?? "");
  return (
    <span
      className={`chip ${unverified ? "warn" : "ai"}`}
      title={via.confirmed_by ? `${title} · ${t("via.confirmedBy").replace("{who}", via.confirmed_by)}` : title}
    >
      {t("via.chat")}
      {unverified ? ` · ${t("via.unverified")}` : via.confirmed_by ? ` · ${t("via.confirmedShort")}` : ""}
    </span>
  );
}

export function Avatar({ id, actors }: { id: string; actors: Actor[] }) {
  const kind = actors.find((a) => a.id === id)?.kind ?? "human";
  return (
    <span className={`avatar ${kind}`} title={id}>
      {kind === "ai" ? "AI" : id.slice(0, 2).toUpperCase()}
    </span>
  );
}

export function Ago({ iso }: { iso: string }) {
  const t = useT();
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(i);
  }, []);
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {timeAgo(iso, t)}
    </time>
  );
}

const STATUS_TONE: Record<string, string> = {
  open: "warn",
  todo: "",
  backlog: "",
  doing: "accent",
  in_progress: "accent",
  review: "accent",
  answered: "ok",
  accepted: "ok",
  done: "ok",
  closed: "",
  resolved: "ok",
  proposed: "warn",
  rejected: "danger",
  superseded: "",
  archived: "",
  active: "ok",
  draft: "warn",
  stale: "danger",
  deprecated: "",
  deliberating: "accent",
  voted: "warn",
  decided: "ok",
  cancelled: "",
};
export function StatusChip({ status }: { status: string }) {
  const label = useLabels();
  return (
    <span className={`chip status ${STATUS_TONE[status] ?? ""}`} title={status}>
      {label.status(status)}
    </span>
  );
}

export function TypeChip({ type }: { type: string }) {
  const label = useLabels();
  return (
    <span className="chip type" title={type}>
      {label.type(type)}
    </span>
  );
}

// An English term we keep as-is because that is its name in the tools; hovering (or focusing) explains it.
export function Term({ w, children }: { w: keyof typeof GLOSSARY | string; children?: ReactNode }) {
  const { lang } = useContext(LangContext);
  const entry = GLOSSARY[w];
  if (!entry) return <>{children ?? w}</>;
  return (
    <abbr className="term" title={entry[lang]} tabIndex={0}>
      {children ?? w}
    </abbr>
  );
}

// A placeholder in the shape of what is coming (rows of text), so the page does not jump when it arrives.
// Screen readers hear "Loading…"; the bars are decoration.
// Holds a page back until its first loads are done, then shows it at once, finished: no skeletons turning into
// content one section at a time, nothing sliding down as the parts above it arrive. A load that takes longer
// than a blink gets one calm loader; a fast one shows nothing at all. Never hidden for more than 8 seconds.
const GATE_SETTLE_MS = 60; // a load that ends and starts the next (a list after its settings) is one wait
const GATE_LOADER_MS = 180; // below this, a loader would only flash
const GATE_MAX_MS = 8000;

export function PageGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  const pending = useRef(0);
  const shown = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reveal = useCallback(() => {
    if (shown.current) return;
    shown.current = true;
    setReady(true);
  }, []);
  const gate = useMemo<LoadGate>(
    () => ({
      begin() {
        if (shown.current) return () => {};
        pending.current++;
        clearTimeout(settle.current);
        let ended = false;
        return () => {
          if (ended) return;
          ended = true;
          pending.current--;
          if (pending.current === 0) settle.current = setTimeout(reveal, GATE_SETTLE_MS);
        };
      },
    }),
    [reveal],
  );
  useEffect(() => {
    const idle = setTimeout(() => pending.current === 0 && reveal(), GATE_SETTLE_MS); // a page that loads nothing
    const loader = setTimeout(() => setSlow(true), GATE_LOADER_MS);
    const cap = setTimeout(reveal, GATE_MAX_MS);
    return () => [idle, loader, cap, settle.current].forEach((t) => clearTimeout(t));
  }, [reveal]);
  return (
    <LoadGateContext.Provider value={gate}>
      {!ready && slow && <PageLoader />}
      <div className={ready ? "page-gate" : "page-gate waiting"} aria-busy={!ready}>
        {children}
      </div>
    </LoadGateContext.Provider>
  );
}

function PageLoader() {
  const t = useT();
  return (
    <div className="page-loader" role="status" aria-live="polite">
      <span className="page-loader-bar" aria-hidden />
      <span className="page-loader-spin" aria-hidden />
      <span className="sr-only">{t("common.loading")}</span>
    </div>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  const t = useT();
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="sr-only">{t("common.loading")}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i} aria-hidden>
          <span className="skeleton-bar" />
          <span className="skeleton-bar short" />
        </div>
      ))}
    </div>
  );
}

// "Nothing here" that says what it means and, when there is one, what to do next.
export function EmptyState({
  icon = "inbox",
  title,
  hint,
  action,
  card = true,
}: {
  icon?: string;
  title: string;
  hint?: string;
  action?: { label: string; run: () => void };
  card?: boolean;
}) {
  return (
    <div className={`empty-state${card ? " card" : ""}`}>
      <span className="empty-icon" aria-hidden>
        <Icon name={icon} size={20} />
      </span>
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
      {action && (
        <button className="btn primary sm" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const t = useT();
  if (!error) return null;
  const e = error as ApiError;
  const hint = e.hint as { issues?: string[]; allowed_from_here?: string[] } | undefined;
  return (
    <div className="error-box" role="alert">
      <strong>{e.message || t("common.error")}</strong>
      {hint?.issues && (
        <ul>
          {hint.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      {hint?.allowed_from_here && <div>→ {hint.allowed_from_here.join(", ") || "—"}</div>}
    </div>
  );
}

// ---- pressable rows ----------------------------------------------------------------

// Something clicked that cannot be a <button>, because it holds block content (a list row, a board
// card, a tree row). It gets what a button gives for free: a role screen readers announce, a place in
// the tab order, and Enter/Space to activate. Keys pressed inside it (a checkbox, a menu) stay theirs.
export function Pressable({
  as = "div",
  onPress,
  className,
  label,
  current,
  children,
  ...rest
}: {
  as?: "div" | "article" | "li";
  onPress: () => void;
  className?: string;
  label?: string;
  current?: boolean;
  children: ReactNode;
} & Partial<Record<`data-${string}` | "draggable" | "onDragStart" | "onDragEnd" | "title", unknown>>) {
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPress();
    }
  };
  return createElement(
    as,
    { ...rest, className, role: "button", tabIndex: 0, onClick: onPress, onKeyDown, "aria-label": label, "aria-current": current ? "page" : undefined },
    children,
  );
}

// A card or row that holds controls of its own (a checkbox, a "move to" menu). A role="button" around other
// controls is invalid: screen readers cannot reach the inner ones. So here the title is the real button, and
// its ::after stretches over the whole card for the pointer; the inner controls sit above it (styles.css).
const PressContext = createContext<(() => void) | null>(null);

export function PressCard({
  as = "div",
  onPress,
  className,
  children,
  ...rest
}: {
  as?: "div" | "article" | "li";
  onPress: () => void;
  className?: string;
  children: ReactNode;
} & Partial<Record<`data-${string}` | "draggable" | "onDragStart" | "onDragEnd" | "title", unknown>>) {
  return createElement(
    as,
    { ...rest, className: `press-card${className ? ` ${className}` : ""}` },
    <PressContext.Provider value={onPress}>{children}</PressContext.Provider>,
  );
}

// The short id people give an AI ("do ZKFBA9"): the item id's last 6 characters, as the API and MCP tools
// accept them (SHORT_ID_LENGTH in src/util/text.ts). A click copies it.
export function ShortId({ id }: { id: string }) {
  const t = useT();
  const toast = useToast();
  const short = id.slice(-6);
  return (
    <button
      type="button"
      className="kid"
      title={t("item.copyShortId")}
      aria-label={`${t("item.copyShortId")}: ${short}`}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(short).then(() => toast({ text: t("hub.copied") }));
      }}
    >
      #{short}
    </button>
  );
}

export function PressTitle({ children }: { children: ReactNode }) {
  const onPress = useContext(PressContext);
  return (
    <button type="button" className="title press-title" onClick={() => onPress?.()}>
      {children}
    </button>
  );
}

// The `list-row` pattern every list page uses, as one keyboard-reachable component.
export function ListRow({ onPress, className, label, children }: { onPress: () => void; className?: string; label?: string; children: ReactNode }) {
  return (
    <Pressable onPress={onPress} className={`list-row${className ? ` ${className}` : ""}`} label={label}>
      {children}
    </Pressable>
  );
}

// ---- overlays --------------------------------------------------------------------

// Open overlays, newest last. Escape closes only the top one: a preview opened from a drawer must not
// take the drawer with it.
const overlays: { current: () => void }[] = [];
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !overlays.length) return;
    e.preventDefault();
    overlays[overlays.length - 1].current();
  });
}

function useEscape(onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    overlays.push(ref);
    return () => {
      overlays.splice(overlays.indexOf(ref), 1);
    };
  }, []);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// A modal dialog keeps the keyboard inside it: Tab from the last control wraps to the first, and closing
// it puts focus back on whatever opened it, so a keyboard user does not land at the top of the page.
export function useFocusTrap(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A field with autoFocus has already taken focus; otherwise the dialog itself does.
    if (!box.contains(document.activeElement)) box.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const all = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden], [inert]"));
      if (!all.length) {
        e.preventDefault();
        return;
      }
      const first = all[0];
      const last = all[all.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === box)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    box.addEventListener("keydown", onKey);
    return () => {
      box.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [ref]);
}

export function Drawer({ onClose, head, children }: { onClose: () => void; head: ReactNode; children: ReactNode }) {
  const t = useT();
  const box = useRef<HTMLElement>(null);
  useEscape(onClose);
  useFocusTrap(box);
  return (
    <>
      <div className="overlay" onClick={onClose} aria-hidden="true" />
      <aside ref={box} className="drawer" role="dialog" aria-modal tabIndex={-1}>
        <div className="drawer-head">
          <div className="grow">{head}</div>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            <Icon name="x" />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

export function Modal({ onClose, title, children }: { onClose: () => void; title: string; children: ReactNode }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  useEscape(onClose);
  useFocusTrap(box);
  return (
    <>
      <div className="overlay" onClick={onClose} aria-hidden="true" />
      <div ref={box} className="modal" role="dialog" aria-modal aria-label={title} tabIndex={-1}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </>
  );
}

// ---- toasts ------------------------------------------------------------------------

interface Toast {
  id: number;
  text: string;
  error?: boolean;
  action?: { label: string; run: () => void };
}
const ToastContext = createContext<(t: Omit<Toast, "id">) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all, { ...t, id }]);
    setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), t.action ? 9000 : 4500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? "error" : ""}`}>
            <Icon name={t.error ? "alert" : "check"} size={16} />
            <span className="grow">{t.text}</span>
            {t.action && (
              <button
                className="btn sm"
                onClick={() => {
                  t.action!.run();
                  setToasts((all) => all.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---- app-wide session ------------------------------------------------------------

export interface Session {
  me: Actor;
  actors: Actor[];
  itemTypes: string[]; // the board's types: discussions live on their own screen
  allItemTypes: string[];
  projectName: string;
  openItem: (id: string) => void;
  ask: (about: string, label: string) => void;
  can: (perm: string) => boolean;
  repoUrl?: string;
}
export const SessionContext = createContext<Session>(null as unknown as Session);
export const useSession = () => useContext(SessionContext);

// ---- asking ---------------------------------------------------------------------------

// confirm() and prompt() in a real dialog: labelled, focus-trapped, themed, and usable with a screen reader.
// `ask` resolves to the typed text ("" without an input) or null when cancelled. Render `dialog` once.
export interface AskOptions {
  title: string;
  message?: string;
  // `line`: a name, not a note: one line, so Enter submits the dialog.
  input?: { label: string; required?: boolean; placeholder?: string; line?: boolean; maxLength?: number };
  confirm: string;
  tone?: "primary" | "danger";
}

export function useAsk(): { dialog: ReactNode; ask: (o: AskOptions) => Promise<string | null> } {
  const [open, setOpen] = useState<(AskOptions & { resolve: (v: string | null) => void }) | null>(null);
  const ask = useCallback((o: AskOptions) => new Promise<string | null>((resolve) => setOpen({ ...o, resolve })), []);
  const done = (v: string | null) => {
    open?.resolve(v);
    setOpen(null);
  };
  return { dialog: open ? <AskDialog {...open} onDone={done} /> : null, ask };
}

function AskDialog({ title, message, input, confirm, tone = "primary", onDone }: AskOptions & { onDone: (v: string | null) => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const id = useMemo(() => `ask-${Math.random().toString(36).slice(2)}`, []);
  const blocked = !!input?.required && !text.trim();
  return (
    <Modal title={title} onClose={() => onDone(null)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked) onDone(text.trim());
        }}
      >
        {message && <p>{message}</p>}
        {input && (
          <div className="field">
            <label htmlFor={id}>{input.label}</label>
            {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog exists to ask for this text */}
            {input.line ? (
              <input
                id={id}
                className="input"
                autoFocus
                value={text}
                maxLength={input.maxLength}
                placeholder={input.placeholder}
                onChange={(e) => setText(e.target.value)}
              />
            ) : (
              <textarea
                id={id}
                className="textarea"
                rows={3}
                autoFocus
                value={text}
                placeholder={input.placeholder}
                onChange={(e) => setText(e.target.value)}
              />
            )}
          </div>
        )}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={() => onDone(null)}>
            {t("common.cancel")}
          </button>
          <button type="submit" className={`btn ${tone}`} disabled={blocked}>
            {confirm}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- commits ---------------------------------------------------------------------------

// A commit hash: a link to its page when the project's repository is on GitHub (Session.repoUrl), plain
// text otherwise. Shown short; the full hash is in the link and the title.
export function CommitLink({ hash, chip }: { hash: string; chip?: boolean }) {
  const { repoUrl } = useSession();
  const short = hash.slice(0, 7);
  const cls = `mono${chip ? " chip" : ""}`;
  if (!repoUrl)
    return (
      <span className={cls} title={hash}>
        #{short}
      </span>
    );
  return (
    <a className={`${cls} commit-link`} href={`${repoUrl}/commit/${encodeURIComponent(hash)}`} target="_blank" rel="noopener noreferrer" title={hash}>
      #{short}
    </a>
  );
}

// ---- progress --------------------------------------------------------------------------

// How many of an item's task boxes are ticked: a thin bar and "5/13".
export function Progress({ done, total }: { done: number; total: number }) {
  const t = useT();
  const label = t("progress.label").replace("{done}", String(done)).replace("{total}", String(total));
  return (
    <span className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={label} title={label}>
      <span className="progress-bar">
        <span className="progress-fill" style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
      </span>
      <span className="progress-text">
        {done}/{total}
      </span>
    </span>
  );
}

// ---- folding ---------------------------------------------------------------------------

// A long reply shows its start and a button for the rest, so the next reply is not ten screens away.
export function Fold({ long, children }: { long: boolean; children: ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const id = useMemo(() => `fold-${Math.random().toString(36).slice(2)}`, []);
  if (!long) return <>{children}</>;
  return (
    <div className={`fold${open ? " open" : ""}`}>
      <div id={id} className="fold-body">
        {children}
      </div>
      <button type="button" className="btn sm ghost fold-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {t(open ? "fold.less" : "fold.more")}
      </button>
    </div>
  );
}
