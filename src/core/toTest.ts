// What the person has to try before closing handed-in work, read from the reply that handed it in
// (tasks 01M3P48F6YD5BPV6HGAJGB7SFC, 01M3P48AXZTQT6QGJY8TW8V1G6). The board lists these next to the card
// waiting for review, so the person does not dig through a long reply for them.
//
// The reply's own words are the source: a "to test" heading (Turkish or English) and the list under it,
// else the unchecked boxes anywhere in the reply. Nothing new to fill in for the AI; the convention is in
// the tool descriptions.

const HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(denemen gerekenler|denenecekler|nasıl denenir|to test|how to test|try it)\b/i;
const ITEM = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)(.+)$/;
const OPEN_BOX = /^\s*[-*+]\s+\[ \]\s+(.+)$/;
const MAX_ITEMS = 8;
const MAX_CHARS = 200;

const clean = (s: string) => {
  const t = s.replace(/\*\*/g, "").trim();
  return t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS - 1)}…` : t;
};

export function toTest(body: string): string[] {
  const lines = body.split("\n");
  const at = lines.findIndex((l) => HEADING.test(l));
  if (at >= 0) {
    const out: string[] = [];
    // Text on the heading's own line after a colon counts as one step ("Nasıl denenir: npm test").
    const inline = lines[at].split(/:\s*/).slice(1).join(": ").replace(/\*\*/g, "").trim();
    if (inline) out.push(clean(inline));
    for (const line of lines.slice(at + 1)) {
      const m = ITEM.exec(line);
      if (m) out.push(clean(m[1]));
      else if (line.trim() === "" && out.length === 0) continue;
      else if (line.trim() === "" || /^\s*#/.test(line) || /^\s*\*\*[^*]+\*\*/.test(line)) break;
      else if (out.length && /^\s{2,}\S/.test(line)) out[out.length - 1] = clean(`${out[out.length - 1]} ${line.trim()}`);
      else break;
    }
    if (out.length) return out.slice(0, MAX_ITEMS);
  }
  return lines
    .map((l) => OPEN_BOX.exec(l)?.[1])
    .filter((s): s is string => !!s)
    .map(clean)
    .slice(0, MAX_ITEMS);
}
