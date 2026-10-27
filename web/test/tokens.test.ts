import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// The design system's two promises, checked on every run:
//   1. Colors live only in the theme tokens. Everything else says var(--...), so a theme is one place to change.
//   2. Every text/background pair the board uses meets WCAG AA (4.5:1) in the light, system dark and forced dark themes.

const SRC = join(import.meta.dirname, "..", "src");
const css = readFileSync(join(SRC, "styles.css"), "utf8");

// The body of the block that opens at `selector {`, braces balanced.
function block(selector: string): { start: number; end: number; body: string } {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no "${selector}" block in styles.css`);
  let i = css.indexOf("{", at) + 1;
  const open = i;
  for (let depth = 1; depth; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
  }
  return { start: at, end: i, body: css.slice(open, i - 1) };
}

const tokens = (body: string) => Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

const LIGHT = block(":root");
const SYSTEM_DARK = block("@media (prefers-color-scheme: dark)"); // holds :root:not([data-theme="light"])
const FORCED_DARK = block(':root[data-theme="dark"]');
const light = tokens(LIGHT.body);
const THEMES: Record<string, Record<string, string>> = {
  light,
  "system dark": { ...light, ...tokens(SYSTEM_DARK.body) },
  "forced dark": { ...light, ...tokens(FORCED_DARK.body) },
};

const RAW_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|(?<![\w-])(?:white|black)(?![\w-])/i; // not white-space

describe("colors come from tokens only", () => {
  test("styles.css has no raw color outside the three token blocks", () => {
    const outside = [
      css.slice(0, LIGHT.start),
      css.slice(LIGHT.end, SYSTEM_DARK.start),
      css.slice(SYSTEM_DARK.end, FORCED_DARK.start),
      css.slice(FORCED_DARK.end),
    ]
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, ""); // comments may name colors
    const offenders = outside.split("\n").filter((line) => RAW_COLOR.test(line));
    expect(offenders, "use a var(--token) from the :root blocks instead").toEqual([]);
  });

  test("components carry no raw colors (inline styles, SVG attributes)", () => {
    const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) => /\.tsx?$/.test(f) && !f.endsWith("i18n.ts"));
    const offenders: string[] = [];
    for (const f of files) {
      readFileSync(join(SRC, f), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/#[0-9a-f]{3,8}\b(?![\w-])|\brgba?\(/i.test(line) && !/^\s*\/\//.test(line) && !/["'`]#\//.test(line))
            offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  test("the system dark and forced dark blocks define the same tokens", () => {
    const keys = (body: string) => Object.keys(tokens(body)).sort();
    expect(keys(SYSTEM_DARK.body)).toEqual(keys(FORCED_DARK.body));
  });
});

// ---- contrast -------------------------------------------------------------------------

type RGBA = [number, number, number, number];

function parse(value: string): RGBA {
  const v = value.trim();
  if (v.startsWith("#")) {
    let h = v.slice(1);
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const m = /rgba?\(([^)]+)\)/.exec(v);
  if (!m) throw new Error(`cannot read color "${value}"`);
  const [r, g, b, a = 1] = m[1].split(",").map(Number);
  return [r, g, b, a];
}

const over = (fg: RGBA, bg: RGBA): RGBA => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as RGBA;

function luminance([r, g, b]: RGBA): number {
  const lin = (x: number) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: RGBA, b: RGBA): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [text, background, what it is]. Translucent backgrounds are composited over the surface they sit on.
const PAIRS: [string, string, string][] = [
  ["text", "bg", "body text on the page"],
  ["text", "surface", "body text on a card"],
  ["text", "raised", "kanban card title"],
  ["muted", "bg", "secondary text on the page"],
  ["muted", "surface", "secondary text on a card"],
  ["muted", "surface-2", "secondary text on a filled panel"],
  ["muted", "fill", "secondary text on a fill (board columns)"],
  ["muted", "danger-soft", "secondary text on the old side of a diff"],
  ["muted", "ok-soft", "secondary text on the new side of a diff"],
  ["faint", "bg", "meta text on the page"],
  ["faint", "surface", "meta text on a card"],
  ["faint", "surface-2", "meta text on a filled panel"],
  // --faint is not for tinted fills (columns, diff sides): it drops under 4.5 there. Those use --muted.
  ["accent-text", "bg", "links on the page"],
  ["accent-text", "surface", "links on a card"],
  ["accent-text", "accent-soft", "accent chip"],
  ["on-accent", "accent", "primary button"],
  ["on-accent", "accent-hover", "primary button, hovered"],
  ["ok", "surface", "success text"],
  ["ok", "ok-soft", "success chip"],
  ["warn", "surface", "warning text"],
  ["warn", "warn-soft", "warning chip"],
  ["danger", "surface", "error text"],
  ["danger", "danger-soft", "error chip"],
  ["ai", "ai-soft", "AI chip"],
  ["human", "human-soft", "human chip"],
  ["on-label", "label-low", "kanban label, low"],
  ["on-label", "label-medium", "kanban label, medium"],
  ["on-label", "label-high", "kanban label, high"],
  ["on-color", "label-critical", "kanban label, critical"],
  ["on-avatar", "human", "a person's avatar"],
  ["on-avatar", "ai", "an AI's avatar"],
  ["toast-text", "toast-bg", "toast"],
  ["toast-text", "toast-danger", "error toast"],
];

describe("text meets WCAG AA contrast in every theme", () => {
  for (const [theme, t] of Object.entries(THEMES)) {
    const base = parse(t.surface);
    const solid = (name: string): RGBA => {
      if (!(name in t)) throw new Error(`token --${name} is missing in ${theme}`);
      const c = parse(t[name]);
      return c[3] < 1 ? over(c, name.startsWith("toast") ? parse(t.bg) : base) : c;
    };
    for (const [fg, bg, what] of PAIRS) {
      test(`${theme}: ${what} (--${fg} on --${bg})`, () => {
        const ratio = contrast(solid(fg), solid(bg));
        expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      });
    }
    // Chips sit on cards too: a translucent chip fill over --raised must pass as well.
    const raised = parse(t.raised);
    for (const [fg, bg] of PAIRS.filter(([f, b]) => b.endsWith("-soft") && f !== "muted")) {
      test(`${theme}: --${fg} on --${bg} over a kanban card`, () => {
        const ratio = contrast(solid(fg), over(parse(t[bg]), raised));
        expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
