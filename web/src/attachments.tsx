import type { ClipboardEvent, DragEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, apiPath } from "./api";
import { useT } from "./i18n";
import type { Attachment } from "./types";
import { Icon, Markdown, Modal, useToast } from "./ui";

// Files on an item, the way Trello does it: paste a screenshot, drop files anywhere on the card, or pick
// them; pictures show as thumbnails (the first one becomes the card's cover), Markdown and text open in a
// preview. In Markdown, "files/<name>" points at an attachment of the same item.

export const filesBase = (itemId: string) => apiPath(`/api/items/${encodeURIComponent(itemId)}/files`);
export const fileUrl = (itemId: string, name: string, download = false) => `${filesBase(itemId)}/${encodeURIComponent(name)}${download ? "?download=1" : ""}`;

// Pictures a browser shows safely. SVG is served as a download (it can carry script), so it is not one.
export const isPicture = (type: string) => /^image\//.test(type) && type !== "image/svg+xml";
const isTextual = (type: string) => /^text\/|^application\/json$/.test(type);
const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  json: "application/json",
  pdf: "application/pdf",
};
export const typeOf = (name: string) => TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

export const MAX_BYTES = 15 * 1024 * 1024; // same limit as the server

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// A pasted screenshot arrives as "image.png"; give it a name that says what and when.
export function screenshotName(prefix: string, ext = "png", now = new Date()): string {
  const p = (x: number) => String(x).padStart(2, "0");
  return `${prefix} ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}.${ext}`;
}

// Files out of a paste or a drop, with pasted pictures renamed.
export function filesFrom(data: DataTransfer | null, screenshot: string): File[] {
  if (!data) return [];
  const out = [...data.files];
  return out.map((f, i) => {
    if (!/^image\.(png|jpe?g|gif|webp)$/i.test(f.name) && f.name) return f;
    const ext = f.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
    const name = screenshotName(screenshot, ext, new Date(Date.now() + i * 1000));
    return new File([f], name, { type: f.type });
  });
}

// The Markdown that shows (pictures) or links (anything else) an attachment of the same item.
// Angle brackets keep names with spaces working: ![](<files/Ekran görüntüsü.png>)
export function markdownRef(name: string): string {
  const alt = name.replace(/\.[^.]+$/, "").replace(/[[\]]/g, "");
  return isPicture(typeOf(name)) ? `![${alt}](<files/${name}>)` : `[${name.replace(/[[\]]/g, "")}](<files/${name}>)`;
}

export async function uploadFile(itemId: string, file: Blob, name: string): Promise<Attachment> {
  const res = await fetch(`${filesBase(itemId)}?name=${encodeURIComponent(name)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-cortex-csrf": "1", "content-type": "application/octet-stream" },
    body: file,
  });
  const data = (await res.json().catch(() => ({}))) as { file?: Attachment; error?: { code?: string; message?: string } };
  if (!res.ok || !data.file) throw new ApiError(res.status, data.error?.code ?? "error", data.error?.message ?? res.statusText);
  return data.file;
}

// Drag files over an element: `dragging` while they hover, `onFiles` when dropped. Other drags
// (a board card, selected text) are ignored.
export function useDropZone(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");
  return {
    dragging,
    props: {
      onDragEnter: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setDragging(true);
      },
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragging(false);
      },
      onDrop: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        const files = [...e.dataTransfer.files];
        if (files.length) onFiles(files);
      },
    },
  };
}

// Paste a screenshot while the card is open, wherever the focus is (except in a text field that handles
// its own paste). Trello's most-used shortcut.
export function usePasteFiles(onFiles: (files: File[]) => void, screenshot: string) {
  const latest = useRef(onFiles);
  latest.current = onFiles;
  useEffect(() => {
    const on = (e: globalThis.ClipboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true]")) return;
      const files = filesFrom(e.clipboardData, screenshot);
      if (!files.length) return;
      e.preventDefault();
      latest.current(files);
    };
    window.addEventListener("paste", on);
    return () => window.removeEventListener("paste", on);
  }, [screenshot]);
}

// ---- a Markdown field that takes files ---------------------------------------------------

// A textarea with Write / Preview tabs. Pasting or dropping files hands them to `onFiles`, which
// stores them (or queues them) and returns their final names; a reference is then put at the cursor.
export function MarkdownField({
  id,
  value,
  onChange,
  onFiles,
  files,
  placeholder,
  minHeight = 120,
  autoFocus,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  onFiles: (files: File[]) => Promise<string[]>;
  files?: string | ((name: string) => string); // where "files/..." points in the preview
  placeholder?: string;
  minHeight?: number;
  autoFocus?: boolean;
}) {
  const t = useT();
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [busy, setBusy] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const insert = async (list: File[]) => {
    if (!list.length) return;
    const el = area.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    setBusy((n) => n + list.length);
    try {
      const names = await onFiles(list);
      if (!names.length) return;
      const refs = names.map(markdownRef).join("\n");
      const before = value.slice(0, start);
      const lead = before && !before.endsWith("\n") ? "\n" : "";
      const next = `${before}${lead}${refs}\n${value.slice(end)}`;
      onChange(next);
      requestAnimationFrame(() => {
        const pos = (before + lead + refs).length + 1;
        el?.focus();
        el?.setSelectionRange(pos, pos);
      });
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    } finally {
      setBusy((n) => n - list.length);
    }
  };
  const drop = useDropZone((list) => void insert(list));

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const list = filesFrom(e.clipboardData, t("att.screenshot"));
    if (!list.length) return; // plain text: the textarea handles it
    e.preventDefault();
    void insert(list);
  };

  return (
    <div className={`md-field${drop.dragging ? " dropping" : ""}`} {...drop.props}>
      <div className="md-tabs">
        <div className="md-tablist" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "write"} className={tab === "write" ? "on" : ""} onClick={() => setTab("write")}>
            {t("att.write")}
          </button>
          <button type="button" role="tab" aria-selected={tab === "preview"} className={tab === "preview" ? "on" : ""} onClick={() => setTab("preview")}>
            {t("att.preview")}
          </button>
        </div>
        <span className="spacer" />
        {busy > 0 && <span className="faint md-busy">{t("att.uploading")}</span>}
        <button type="button" className="icon-btn" title={t("att.attach")} aria-label={t("att.attach")} onClick={() => picker.current?.click()}>
          <Icon name="clip" size={15} />
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void insert([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>
      {tab === "write" ? (
        <textarea
          id={id}
          ref={area}
          className="textarea"
          style={{ minHeight }}
          value={value}
          placeholder={placeholder ?? t("att.mdHint")}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onPaste={onPaste}
        />
      ) : (
        <div className="md-preview" style={{ minHeight }}>
          {value.trim() ? <Markdown text={value} files={files} /> : <p className="faint">{t("att.nothing")}</p>}
        </div>
      )}
    </div>
  );
}

// ---- the attachments of an item --------------------------------------------------------------

export function AttachmentGrid({
  itemId,
  files,
  canWrite,
  uploading,
  onPick,
  onChanged,
  onInsert,
}: {
  itemId: string;
  files: Attachment[];
  canWrite: boolean;
  uploading: string[];
  onPick: (files: File[]) => void;
  onChanged: () => void;
  onInsert?: (name: string) => void; // "add to description"
}) {
  const t = useT();
  const toast = useToast();
  const [open, setOpen] = useState<number | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const remove = async (name: string) => {
    if (!confirm(t("att.confirmDelete").replace("{name}", name))) return;
    try {
      await api(`/api/items/${encodeURIComponent(itemId)}/files/${encodeURIComponent(name)}`, { method: "DELETE" });
      onChanged();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };

  return (
    <div className="section">
      <div className="row mb-2">
        <h3 className="m-0">
          <Icon name="clip" size={14} /> {t("att.title")} {files.length > 0 && <span className="faint">({files.length})</span>}
        </h3>
        <span className="spacer" />
        {canWrite && (
          <>
            <button type="button" className="btn sm" onClick={() => picker.current?.click()}>
              <Icon name="plus" size={14} /> {t("att.add")}
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                onPick([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </>
        )}
      </div>
      {files.length === 0 && uploading.length === 0 ? (
        canWrite && <p className="faint att-empty">{t("att.empty")}</p>
      ) : (
        <div className="att-grid">
          {files.map((f, i) => (
            <div className="att-tile" key={f.name}>
              <button type="button" className="att-thumb" onClick={() => setOpen(i)} aria-label={`${t("att.open")}: ${f.name}`}>
                {isPicture(f.type) ? (
                  <img src={fileUrl(itemId, f.name)} alt="" loading="lazy" />
                ) : (
                  <span className="att-ext">
                    <Icon name={isTextual(f.type) ? "text" : "file"} size={22} />
                    {f.name.split(".").pop()?.toUpperCase()}
                  </span>
                )}
              </button>
              <div className="att-meta">
                <span className="att-name" title={f.name}>
                  {f.name}
                </span>
                <span className="faint">{formatSize(f.size)}</span>
              </div>
              <div className="att-actions">
                <a className="icon-btn" href={fileUrl(itemId, f.name, true)} title={t("att.download")} aria-label={`${t("att.download")}: ${f.name}`}>
                  <Icon name="download" size={14} />
                </a>
                {canWrite && onInsert && (
                  <button
                    type="button"
                    className="icon-btn"
                    title={t("att.insert")}
                    aria-label={`${t("att.insert")}: ${f.name}`}
                    onClick={() => onInsert(f.name)}
                  >
                    <Icon name="text" size={14} />
                  </button>
                )}
                {canWrite && (
                  <button
                    type="button"
                    className="icon-btn danger"
                    title={t("att.delete")}
                    aria-label={`${t("att.delete")}: ${f.name}`}
                    onClick={() => void remove(f.name)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}
          {uploading.map((name) => (
            <div className="att-tile pending" key={`up-${name}`}>
              <div className="att-thumb">
                <span className="att-ext">{t("att.uploading")}</span>
              </div>
              <div className="att-meta">
                <span className="att-name">{name}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {open !== null && files[open] && <FilePreview itemId={itemId} files={files} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </div>
  );
}

// One attachment at a time: pictures large, Markdown rendered, text as is; arrows move between files.
export function FilePreview({
  itemId,
  files,
  index,
  onIndex,
  onClose,
}: {
  itemId: string;
  files: Attachment[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const f = files[index];
  const [text, setText] = useState<string | null>(null);
  const textual = isTextual(f.type);

  useEffect(() => {
    setText(null);
    if (!textual) return;
    let cancelled = false;
    fetch(fileUrl(itemId, f.name), { credentials: "same-origin" })
      .then((r) => r.text())
      .then((s) => !cancelled && setText(s))
      .catch(() => !cancelled && setText(""));
    return () => {
      cancelled = true;
    };
  }, [itemId, f.name, textual]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" && index < files.length - 1) onIndex(index + 1);
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [index, files.length, onIndex]);

  let body: ReactNode;
  if (isPicture(f.type)) body = <img className="att-big" src={fileUrl(itemId, f.name)} alt={f.name} />;
  else if (textual)
    body =
      text === null ? (
        <p className="faint">…</p>
      ) : f.type === "text/markdown" ? (
        <Markdown text={text} files={filesBase(itemId)} />
      ) : (
        <pre className="att-text">{text}</pre>
      );
  else body = <p className="muted">{t("att.noPreview")}</p>;

  return (
    <Modal onClose={onClose} title={f.name}>
      <div className="att-preview">{body}</div>
      <div className="modal-foot">
        <span className="faint mr-auto">
          {index + 1} / {files.length} · {formatSize(f.size)}
        </span>
        <button type="button" className="btn" disabled={index === 0} onClick={() => onIndex(index - 1)} aria-label={t("att.prev")}>
          ←
        </button>
        <button type="button" className="btn" disabled={index === files.length - 1} onClick={() => onIndex(index + 1)} aria-label={t("att.next")}>
          →
        </button>
        <a className="btn primary" href={fileUrl(itemId, f.name, true)}>
          <Icon name="download" size={14} /> {t("att.download")}
        </a>
      </div>
    </Modal>
  );
}

// Files chosen before the item exists (the new-item dialog): kept in the browser, uploaded after create.
export interface PendingFile {
  name: string;
  file: File;
  url: string; // object URL for thumbnails and the preview
}

// The server's file-name rule (src/store/attachments.ts safeFileName), so a name chosen here is the name it keeps.
export function safeName(raw: string): string {
  const base = raw
    .normalize("NFC")
    .split(/[/\\]/)
    .pop()!
    .replace(/[\u0000-\u001f<>:"|?*]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base);
  const name = !base || reserved ? `file${base ? `-${base}` : ""}` : base;
  if (name.length <= 120) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).slice(0, 16) : "";
  return name.slice(0, 120 - ext.length) + ext;
}

// Pending names follow the server's rule (same name twice -> "-2"), so references typed now stay right.
export function pendingName(name: string, taken: string[]): string {
  const lower = new Set(taken.map((n) => n.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) if (!lower.has(`${stem}-${n}${ext}`.toLowerCase())) return `${stem}-${n}${ext}`;
}

export function PendingList({ files, onRemove }: { files: PendingFile[]; onRemove: (name: string) => void }) {
  const t = useT();
  if (!files.length) return null;
  return (
    <div className="att-grid compact">
      {files.map((f) => (
        <div className="att-tile" key={f.name}>
          <div className="att-thumb">
            {isPicture(f.file.type || typeOf(f.name)) ? (
              <img src={f.url} alt="" />
            ) : (
              <span className="att-ext">
                <Icon name="file" size={20} />
                {f.name.split(".").pop()?.toUpperCase()}
              </span>
            )}
          </div>
          <div className="att-meta">
            <span className="att-name" title={f.name}>
              {f.name}
            </span>
            <span className="faint">{formatSize(f.file.size)}</span>
          </div>
          <div className="att-actions">
            <button
              type="button"
              className="icon-btn danger"
              title={t("att.delete")}
              aria-label={`${t("att.delete")}: ${f.name}`}
              onClick={() => onRemove(f.name)}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
