import YAML from "yaml";

export interface Parsed<T> {
  meta: T;
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter<T = Record<string, unknown>>(text: string): Parsed<T> {
  const m = FENCE.exec(text);
  if (!m) return { meta: {} as T, body: text.trim() };
  return { meta: (YAML.parse(m[1]) ?? {}) as T, body: m[2].trim() };
}

export function stringifyFrontmatter(meta: object, body: string): string {
  const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined));
  return `---\n${YAML.stringify(clean).trimEnd()}\n---\n\n${body.trim()}\n`;
}
