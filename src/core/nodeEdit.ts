// Editing part of a knowledge node's body instead of sending all of it (task 01M3P47RTK07P9WGAER3SWCJBA).
// A big node cost ~10k tokens to change one line: the whole body went back and forth. A section is a
// Markdown heading and everything under it up to the next heading of the same or a higher level.

export interface BodyEdit {
  body: string;
  body_mode?: "replace" | "append";
  section?: string; // the heading's text, without the #s; matched ignoring case and surrounding spaces
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

// Headings inside fenced code blocks are code, not structure.
function headings(lines: string[]): { at: number; level: number; text: string }[] {
  const out: { at: number; level: number; text: string }[] = [];
  let fenced = false;
  lines.forEach((line, at) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return;
    const m = HEADING.exec(line);
    if (m) out.push({ at, level: m[1].length, text: m[2] });
  });
  return out;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function editBody(current: string, edit: BodyEdit): string {
  const mode = edit.body_mode ?? "replace";
  const incoming = edit.body.replace(/\s+$/, "");
  if (!edit.section) return mode === "append" ? [current.replace(/\s+$/, ""), incoming].filter(Boolean).join("\n\n") : edit.body;

  const lines = current.split("\n");
  const all = headings(lines);
  const i = all.findIndex((h) => same(h.text, edit.section!));
  if (i < 0) {
    // A section that is not there yet is added at the end, as a second-level heading.
    const added = HEADING.test(incoming.split("\n")[0]) ? incoming : `## ${edit.section.trim()}\n\n${incoming}`;
    return [current.replace(/\s+$/, ""), added].filter(Boolean).join("\n\n") + "\n";
  }
  const head = all[i];
  const next = all.slice(i + 1).find((h) => h.level <= head.level);
  const end = next ? next.at : lines.length;
  const before = lines.slice(0, head.at);
  const after = lines.slice(end);
  const own = lines
    .slice(head.at + 1, end)
    .join("\n")
    .replace(/\s+$/, "");
  // New text that brings its own heading replaces the heading too; plain text keeps the old heading.
  const bringsHeading = HEADING.test(incoming.split("\n")[0]);
  const content = mode === "append" ? [lines[head.at], [own, incoming].filter(Boolean).join("\n\n")] : bringsHeading ? [incoming] : [lines[head.at], incoming];
  const section = content.join("\n").replace(/\s+$/, "");
  return [...before, section, ...(after.length ? ["", ...after] : [""])].join("\n");
}

// The headings of a body, for a hint when a section is not found.
export const sectionTitles = (body: string) => headings(body.split("\n")).map((h) => `${"#".repeat(h.level)} ${h.text}`);

// Past this, a node costs more to read and to change than it is worth in one piece.
export const BIG_NODE_CHARS = 8000;
