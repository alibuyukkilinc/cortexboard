// Line and word diffs, and what a draft changes. Pure, no Node APIs: the server uses it to judge a draft
// (counts, risky), the board to draw it. Shared so both always agree on what changed.

export type Line = { kind: "same" | "add" | "del"; text: string };
export type Piece = { kind: "same" | "add" | "del"; text: string };

// Past this many cells the LCS table would cost more than it is worth; the middle is shown as replaced.
const MAX_CELLS = 4_000_000;

// Longest-common-subsequence diff of two token lists. Common head and tail are cut first, so a small edit
// in a long page only builds a table for the part that differs.
function diffTokens(a: string[], b: string[]): { kind: Line["kind"]; text: string }[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out: { kind: Line["kind"]; text: string }[] = a.slice(0, head).map((text) => ({ kind: "same" as const, text }));
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const n = x.length;
  const m = y.length;
  if (n * m > MAX_CELLS) {
    for (const text of x) out.push({ kind: "del", text });
    for (const text of y) out.push({ kind: "add", text });
  } else {
    // lcs[i*(m+1)+j] = length of the longest common subsequence of x[i..] and y[j..]
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        out.push({ kind: "same", text: x[i] });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) out.push({ kind: "del", text: x[i++] });
      else out.push({ kind: "add", text: y[j++] });
    }
    while (i < n) out.push({ kind: "del", text: x[i++] });
    while (j < m) out.push({ kind: "add", text: y[j++] });
  }
  for (const text of a.slice(a.length - tail)) out.push({ kind: "same", text });
  return out;
}

export function diffLines(before: string, after: string): Line[] {
  return diffTokens(before.split("\n"), after.split("\n"));
}

export const changedLines = (lines: Line[]) => lines.filter((l) => l.kind !== "same").length;

// Words, spaces and punctuation as separate tokens, so "5 min TTL" -> "10 min TTL" marks only "5".
const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

// A changed line against its replacement, in pieces; neighbouring pieces of one kind are merged.
export function diffWords(before: string, after: string): Piece[] {
  const out: Piece[] = [];
  for (const p of diffTokens(before.match(TOKEN) ?? [], after.match(TOKEN) ?? [])) {
    const last = out[out.length - 1];
    if (last?.kind === p.kind) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

// A diff as rows to draw: a removed line directly followed by an added one becomes a pair, so the
// changed words inside it can be marked. Runs of unchanged lines longer than 2*context+1 fold.
export type Row =
  | { kind: "same"; text: string; old: number; new: number }
  | { kind: "del"; text: string; old: number; pair?: string }
  | { kind: "add"; text: string; new: number; pair?: string }
  | { kind: "fold"; lines: string[]; old: number; new: number }; // unchanged lines hidden until opened

export function diffRows(before: string, after: string, context = 3): Row[] {
  const lines = diffLines(before, after);
  const rows: Row[] = [];
  let o = 1;
  let n = 1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.kind === "same") rows.push({ kind: "same", text: l.text, old: o++, new: n++ });
    else if (l.kind === "del") {
      // Pair the k-th removed line of a block with the k-th added line after it.
      let end = i;
      while (end < lines.length && lines[end].kind === "del") end++;
      let adds = end;
      while (adds < lines.length && lines[adds].kind === "add") adds++;
      const dels = lines.slice(i, end);
      const added = lines.slice(end, adds);
      dels.forEach((d, k) => rows.push({ kind: "del", text: d.text, old: o++, ...(added[k] ? { pair: added[k].text } : {}) }));
      added.forEach((a, k) => rows.push({ kind: "add", text: a.text, new: n++, ...(dels[k] ? { pair: dels[k].text } : {}) }));
      i = adds - 1;
    } else rows.push({ kind: "add", text: l.text, new: n++ });
  }
  return fold(rows, context);
}

function fold(rows: Row[], context: number): Row[] {
  const out: Row[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "same") {
      out.push(rows[i++]);
      continue;
    }
    let end = i;
    while (end < rows.length && rows[end].kind === "same") end++;
    const run = rows.slice(i, end) as Extract<Row, { kind: "same" }>[];
    const keepHead = i === 0 ? 0 : context;
    const keepTail = end === rows.length ? 0 : context;
    if (run.length > keepHead + keepTail + 1) {
      out.push(...run.slice(0, keepHead));
      const hidden = run.slice(keepHead, run.length - keepTail);
      out.push({ kind: "fold", lines: hidden.map((h) => h.text), old: hidden[0].old, new: hidden[0].new });
      out.push(...run.slice(run.length - keepTail));
    } else out.push(...run);
    i = end;
  }
  return out;
}

// ---- drafts ---------------------------------------------------------------------------------

// The parts of a node or an item a reviewer judges, as text. Body is diffed separately.
type Doc = {
  title?: string;
  summary?: string;
  body?: string;
  status?: string;
  assignee?: string;
  category_path?: string;
  tags?: string[];
  fields?: Record<string, unknown>;
  links?: { code?: { file: string; lines?: string }[]; items?: string[] };
  verified_at_commit?: string;
};

export interface FieldChange {
  name: string; // "title", "summary", "fields.severity", ...
  before: string;
  after: string;
}

export interface DraftChanges {
  new: boolean; // nothing exists at the target yet
  fields: FieldChange[];
  body: { added: number; removed: number };
  risky: boolean;
  risky_reason?: "large_removal";
}

const show = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

// A draft that throws away much of what is there is "risky": it is approved one by one, after reading,
// never in a batch. Counted as lines lost (removed minus added), so a rewrite that edits every line is not
// a removal. Small losses are exempt: dropping a few lines is ordinary editing.
const RISKY_MIN_LINES = 5;
const RISKY_SHARE = 0.4;

export function draftChanges(current: Doc | null, proposed: Doc): DraftChanges {
  const fields: FieldChange[] = [];
  const add = (name: string, a: unknown, b: unknown) => {
    const before = show(a);
    const after = show(b);
    if (before !== after) fields.push({ name, before, after });
  };
  const code = (d: Doc | null) => (d?.links?.code ?? []).map((c) => `${c.file}${c.lines ? `:${c.lines}` : ""}`).join(", ");
  add("title", current?.title, proposed.title);
  add("summary", current?.summary, proposed.summary);
  add("status", current?.status, proposed.status);
  add("assignee", current?.assignee, proposed.assignee);
  add("category_path", current?.category_path, proposed.category_path);
  add("tags", (current?.tags ?? []).join(", "), (proposed.tags ?? []).join(", "));
  add("code", code(current), code(proposed));
  add("links.items", (current?.links?.items ?? []).join(", "), (proposed.links?.items ?? []).join(", "));
  for (const k of [...new Set([...Object.keys(current?.fields ?? {}), ...Object.keys(proposed.fields ?? {})])].sort()) {
    add(`fields.${k}`, current?.fields?.[k], proposed.fields?.[k]);
  }
  add("verified_at_commit", current?.verified_at_commit, proposed.verified_at_commit);

  const lines = diffLines(current?.body ?? "", proposed.body ?? "");
  const added = lines.filter((l) => l.kind === "add" && l.text.trim()).length;
  const removed = lines.filter((l) => l.kind === "del" && l.text.trim()).length;
  const had = (current?.body ?? "").split("\n").filter((l) => l.trim()).length;
  const lost = removed - added;
  const risky = !!current && lost >= RISKY_MIN_LINES && lost > had * RISKY_SHARE;
  return { new: !current, fields, body: { added, removed }, risky, ...(risky ? { risky_reason: "large_removal" as const } : {}) };
}
