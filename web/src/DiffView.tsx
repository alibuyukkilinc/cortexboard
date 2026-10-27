import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { Piece, Row } from "../../src/core/diff";
import { diffRows, diffWords } from "../../src/core/diff";
import { useT } from "./i18n";

// A body diff a reviewer can read: unified (one column, the phone default) or side by side, changed words
// marked inside changed lines, long unchanged stretches folded. <del>/<ins> carry the meaning for screen
// readers; colour only repeats it.

export type DiffMode = "unified" | "split";

const MODE_KEY = "cortex.diffMode";

export function useDiffMode(): [DiffMode, (m: DiffMode) => void] {
  const [mode, setMode] = useState<DiffMode>(() => {
    try {
      const saved = localStorage.getItem(MODE_KEY);
      if (saved === "unified" || saved === "split") return saved;
    } catch {
      // storage blocked: fall through to the screen-size default
    }
    return typeof matchMedia === "function" && matchMedia("(max-width: 600px)").matches ? "unified" : "split";
  });
  const set = (m: DiffMode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // not remembered, still switched
    }
  };
  return [mode, set];
}

export function DiffModeSwitch({ mode, onChange }: { mode: DiffMode; onChange: (m: DiffMode) => void }) {
  const t = useT();
  return (
    <div className="segmented" role="group" aria-label={t("diff.view")}>
      {(["unified", "split"] as const).map((m) => (
        <button key={m} type="button" className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => onChange(m)}>
          {t(m === "unified" ? "diff.unified" : "diff.split")}
        </button>
      ))}
    </div>
  );
}

// Word diffs of replaced lines, computed once per pair (both sides of a pair draw from the same result).
type WordCache = Map<string, Piece[]>;

// The words of one side of a changed line: the other side's words left out, this side's changes marked.
// Unchanged words are plain text nodes: a 500-line diff is thousands of pieces.
function words(cache: WordCache, text: string, pair: string | undefined, side: "del" | "add"): ReactNode {
  if (pair === undefined) return text || " ";
  const [before, after] = side === "del" ? [text, pair] : [pair, text];
  const key = `${before}\u0001${after}`;
  let pieces = cache.get(key);
  if (!pieces) cache.set(key, (pieces = diffWords(before, after)));
  return pieces
    .filter((p) => p.kind === "same" || p.kind === side)
    .map((p, i) => (p.kind === "same" ? p.text : side === "del" ? <del key={i}>{p.text}</del> : <ins key={i}>{p.text}</ins>));
}

// Rows drawn in the first frame; the rest follow in the next, so a very long diff shows at once.
const FIRST_ROWS = 200;

export function DiffView({ before, after, mode }: { before: string; after: string; mode: DiffMode }) {
  const t = useT();
  const { rows, cache } = useMemo(() => ({ rows: diffRows(before, after), cache: new Map() as WordCache }), [before, after]);
  const [opened, setOpened] = useState<Set<number>>(new Set());
  const [all, setAll] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setAll(true));
    return () => cancelAnimationFrame(frame);
  }, [rows]);
  const open = (i: number) => setOpened((s) => new Set(s).add(i));

  // Folds the reviewer opened become plain unchanged lines again.
  const shown: (Row | { kind: "fold"; lines: string[]; old: number; new: number; at: number })[] = [];
  rows.forEach((r, i) => {
    if (r.kind === "fold" && opened.has(i)) r.lines.forEach((text, k) => shown.push({ kind: "same", text, old: r.old + k, new: r.new + k }));
    else shown.push(r.kind === "fold" ? { ...r, at: i } : r);
  });
  if (!all) shown.length = Math.min(shown.length, FIRST_ROWS);

  const fold = (r: { lines: string[]; at: number }, key: string | number) => (
    <button key={key} type="button" className="diff-fold" onClick={() => open(r.at)}>
      {t("diff.unchanged").replace("{n}", String(r.lines.length))}
    </button>
  );

  if (mode === "unified") {
    return (
      <div className="diffv diffv-unified">
        {shown.map((r, i) =>
          r.kind === "fold" ? (
            fold(r as { lines: string[]; at: number }, i)
          ) : (
            <div key={i} className={`dl ${r.kind}`}>
              <span className="dn" aria-hidden>
                {r.kind === "add" ? "" : r.old}
              </span>
              <span className="dn" aria-hidden>
                {r.kind === "del" ? "" : r.new}
              </span>
              <span className="dt">
                {r.kind === "same" ? (
                  r.text || " "
                ) : r.kind === "del" ? (
                  <del className="whole">{words(cache, r.text, r.pair, "del")}</del>
                ) : (
                  <ins className="whole">{words(cache, r.text, r.pair, "add")}</ins>
                )}
              </span>
            </div>
          ),
        )}
      </div>
    );
  }

  // Side by side: a removed line and the added line that replaced it share a row.
  const pairs: ReactNode[] = [];
  for (let i = 0; i < shown.length; i++) {
    const r = shown[i];
    if (r.kind === "fold") {
      pairs.push(fold(r as { lines: string[]; at: number }, i));
      continue;
    }
    if (r.kind === "same") {
      pairs.push(
        <div key={i} className="dpair">
          <Cell n={r.old} kind="same" body={r.text || " "} />
          <Cell n={r.new} kind="same" body={r.text || " "} />
        </div>,
      );
      continue;
    }
    const dels: Extract<Row, { kind: "del" }>[] = [];
    const adds: Extract<Row, { kind: "add" }>[] = [];
    while (i < shown.length && shown[i].kind === "del") dels.push(shown[i++] as Extract<Row, { kind: "del" }>);
    while (i < shown.length && shown[i].kind === "add") adds.push(shown[i++] as Extract<Row, { kind: "add" }>);
    i--;
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const d = dels[k];
      const a = adds[k];
      pairs.push(
        <div key={`${i}-${k}`} className="dpair">
          {d ? <Cell n={d.old} kind="del" body={<del className="whole">{words(cache, d.text, d.pair, "del")}</del>} /> : <Cell kind="empty" />}
          {a ? <Cell n={a.new} kind="add" body={<ins className="whole">{words(cache, a.text, a.pair, "add")}</ins>} /> : <Cell kind="empty" />}
        </div>,
      );
    }
  }
  return <div className="diffv diffv-split">{pairs}</div>;
}

// A git patch (unified diff) as the same rows: line numbers from the hunk headers, "+" and "-" lines marked,
// the header lines (diff --git, index, ---/+++) left out. Hunk headers become a thin separator.
export function PatchView({ patch }: { patch: string }) {
  const rows: ReactNode[] = [];
  let o = 0;
  let n = 0;
  patch.split("\n").forEach((line, i) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      o = Number(hunk[1]);
      n = Number(hunk[2]);
      rows.push(
        <div key={i} className="dhunk">
          {line}
        </div>,
      );
      return;
    }
    if (!o && !n) return; // still in the header
    if (line.startsWith("\\")) return; // "\ No newline at end of file"
    const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "same";
    const text = line.slice(1) || " ";
    rows.push(
      <div key={i} className={`dl ${kind}`}>
        <span className="dn" aria-hidden>
          {kind === "add" ? "" : o++}
        </span>
        <span className="dn" aria-hidden>
          {kind === "del" ? "" : n++}
        </span>
        <span className="dt">{kind === "del" ? <del className="whole">{text}</del> : kind === "add" ? <ins className="whole">{text}</ins> : text}</span>
      </div>,
    );
  });
  return <div className="diffv diffv-unified">{rows}</div>;
}

function Cell({ n, kind, body }: { n?: number; kind: "same" | "del" | "add" | "empty"; body?: ReactNode }) {
  return (
    <div className={`dl ${kind}`}>
      <span className="dn" aria-hidden>
        {n ?? ""}
      </span>
      <span className="dt">{body}</span>
    </div>
  );
}
