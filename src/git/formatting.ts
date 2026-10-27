import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// "Did this file change only in formatting?" asked of the project's own formatter. A regex cannot know
// every rewrite a formatter makes (re-wrapping, redundant parentheses, quote style, trailing commas...),
// and guessing wide would hide real changes. If the project has Prettier, both versions are run through
// it with the project's config: same output means formatting only. Everything is sent to one Node process,
// because starting one per file would make the first brief after a formatting sweep take half a minute.

export interface Pair {
  file: string; // relative to the project root, used for Prettier's parser and config lookup
  before: string;
  after: string;
}

// Runs in a child process: this package does not depend on Prettier, the project does (or not).
const WORKER = `
const [prettierUrl, root] = process.argv.slice(1);
const prettier = await import(prettierUrl);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const out = [];
for (const p of JSON.parse(input)) {
  const filepath = root + "/" + p.file;
  try {
    const info = await prettier.getFileInfo(filepath, { ignorePath: root + "/.prettierignore" });
    if (info.ignored || !info.inferredParser) { out.push(false); continue; }
    const options = { ...(await prettier.resolveConfig(filepath)), filepath };
    out.push((await prettier.format(p.before, options)) === (await prettier.format(p.after, options)));
  } catch {
    out.push(false); // unparseable either side: treat as a real change
  }
}
process.stdout.write(JSON.stringify(out));
`;

// null when the project has no Prettier: the caller keeps its own verdict.
export function prettierVerdicts(root: string, pairs: Pair[]): boolean[] | null {
  if (!pairs.length) return [];
  let entry: string;
  try {
    entry = createRequire(join(root, "package.json")).resolve("prettier");
  } catch {
    return null;
  }
  // Prettier 3's package entry is the CommonJS shim; its ESM index sits next to it.
  const esm = join(dirname(entry), "index.mjs");
  try {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", WORKER, pathToFileURL(esm).href, root.replace(/\\/g, "/")], {
      input: JSON.stringify(pairs),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    });
    const verdicts = JSON.parse(out) as boolean[];
    return Array.isArray(verdicts) && verdicts.length === pairs.length ? verdicts : null;
  } catch {
    return null;
  }
}
