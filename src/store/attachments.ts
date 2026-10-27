import { extname } from "node:path";

// Files attached to an item live next to it: items/<ID>-<slug>/files/<name>. The folder is the truth
// (drop a file in by hand and it is attached), versioned in git like everything else in .cortex/.

export interface Attachment {
  name: string;
  size: number;
  type: string; // media type, from the extension
  added_at: string; // file mtime
}

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MAX_ATTACHMENTS = 100;

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export function mediaType(name: string): string {
  return TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

// Images a browser can show without running anything. SVG is left out on purpose: it can carry script.
export const isSafeImage = (type: string) => /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon)$/.test(type);
export const isText = (type: string) => /^text\/|^application\/json$/.test(type);

// A name that is safe as one path segment on every OS and still readable ("Ekran görüntüsü 2026-09-24.png").
export function safeFileName(raw: string): string {
  const base = String(raw ?? "")
    .normalize("NFC")
    .split(/[/\\]/)
    .pop()!
    .replace(/[\u0000-\u001f<>:"|?*]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base); // Windows device names
  const name = !base || reserved ? `file${base ? `-${base}` : ""}` : base;
  if (name.length <= 120) return name;
  const ext = extname(name).slice(0, 16);
  return name.slice(0, 120 - ext.length) + ext;
}

// "shot.png" taken: "shot-2.png", "shot-3.png"...
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) {
    const next = `${stem}-${n}${ext}`;
    if (!taken.has(next.toLowerCase())) return next;
  }
}
