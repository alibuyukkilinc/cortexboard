// The writing language humans set in rules/_global.yaml (language: tr). No heavy imports: init uses it too.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export const LANG_CODE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const LANG_NAMES: Record<string, string> = { tr: "Turkish", en: "English", de: "German", fr: "French", es: "Spanish", ar: "Arabic", ru: "Russian" };

export function languageRule(code: string): string {
  const name = LANG_NAMES[code.split("-")[0]] ?? code;
  return `Write all Cortex content in ${name} (${code}), in plain words. Keep code, paths and identifiers as they are.`;
}

export function readGlobalLanguage(cortexDir: string): string | null {
  const file = join(cortexDir, "rules", "_global.yaml");
  if (!existsSync(file)) return null;
  return (YAML.parse(readFileSync(file, "utf8"))?.language as string | undefined) ?? null;
}
