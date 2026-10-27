// Prints one version's section of CHANGELOG.md, for the GitHub release body: `node scripts/release-notes.mjs 0.2.0`.
// Fails (exit 1) when the version has no section, so a release cannot go out without its notes.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const version = process.argv[2]?.replace(/^v/, "");
if (!version) {
  console.error("Usage: node scripts/release-notes.mjs <version>");
  process.exit(1);
}
const lines = readFileSync(resolve(import.meta.dirname, "../CHANGELOG.md"), "utf8")
  .replace(/\r\n/g, "\n")
  .split("\n");
// "## [0.2.0] - date" or "## 0.1.0 - date": the section runs to the next "## " heading or the link definitions.
const heading = (l) => /^## /.test(l);
const isThis = (l) => {
  if (!heading(l)) return false;
  const rest = l.replace(/^## \[?/, "");
  return rest.startsWith(`${version}]`) || rest.startsWith(`${version} `);
};
const start = lines.findIndex(isThis);
let body = "";
if (start >= 0) {
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (heading(l) || /^\[[^\]]+\]: /.test(l)) break;
    out.push(l);
  }
  body = out.join("\n").trim();
}
if (!body) {
  console.error(`CHANGELOG.md has no section for ${version}.`);
  process.exit(1);
}
console.log(body);
