// Task boxes in an item's body ("- [ ] step", "- [x] done"): an epic's steps. Counted for the board's
// progress bars and ticked from the board. Pure, shared by the server and the board.
//
// A box is a list item (-, *, + or "1." / "1)") whose text starts with [ ], [x] or [X], at any depth of
// nesting, also inside a blockquote. Fenced code blocks (``` or ~~~) are skipped: an example of a task list
// in a spec is not a step.

export interface Box {
  line: number; // 0-based line in the body
  checked: boolean;
  text: string;
  depth: number; // leading indentation in spaces (tab = 4), 0 for a top-level item
}

const BOX = /^((?:\s*>\s?)*)(\s*)(?:[-*+]|\d{1,9}[.)])\s+\[([ xX])\](?=\s|$)\s*(.*)$/;
const FENCE = /^(?:\s*>\s?)*\s{0,3}(`{3,}|~{3,})/;

export function parseChecklist(body: string): Box[] {
  const out: Box[] = [];
  let fence: string | null = null; // the opening fence while inside a code block
  const lines = (body ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    const f = FENCE.exec(line);
    if (fence) {
      // A block closes with a fence of the same character, at least as long.
      if (
        f &&
        f[1][0] === fence[0] &&
        f[1].length >= fence.length &&
        line
          .trim()
          .replace(/^(?:>\s?)*/, "")
          .trim() === f[1]
      )
        fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    const m = BOX.exec(line);
    if (m) out.push({ line: i, checked: m[3] !== " ", text: m[4].trim(), depth: m[2].replace(/\t/g, "    ").length });
  }
  return out;
}

export function countChecklist(body: string): { done: number; total: number } {
  const boxes = parseChecklist(body);
  return { done: boxes.filter((b) => b.checked).length, total: boxes.length };
}

// The body with the box on `line` set; null when that line holds no box (the body changed underneath).
export function setBox(body: string, line: number, checked: boolean): string | null {
  const box = parseChecklist(body).find((b) => b.line === line);
  if (!box) return null;
  const lines = body.split("\n");
  lines[line] = lines[line].replace(/\[([ xX])\]/, checked ? "[x]" : "[ ]");
  return lines.join("\n");
}
