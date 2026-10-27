// What Cortex calls itself when it announces a version: the CLI's `--version` and the MCP server's
// serverInfo. Read once from package.json, so a release cannot leave a number behind in the code.
// src/util/ and dist/util/ both sit two levels below package.json.

import { readFileSync } from "node:fs";

let cached: string | null = null;

export function packageVersion(): string {
  cached ??= (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
  return cached;
}
