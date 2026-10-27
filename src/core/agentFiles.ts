import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const AGENT_FILES = ["CLAUDE.md", "AGENTS.md"];

// Adds the short Cortex hint to agent instruction files. Only touches files that already exist,
// and only once (guarded by the cortex:start marker). Opt-in via `init --agent-files`.
export function appendAgentHint(root: string, hint: string): string[] {
  const changed: string[] = [];
  for (const name of AGENT_FILES) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (text.includes("<!-- cortex:start -->")) continue;
    // A CLAUDE.md that imports AGENTS.md ("@AGENTS.md") already gets the hint from there; twice is noise.
    if (name === "CLAUDE.md" && /^@AGENTS\.md\s*$/m.test(text) && existsSync(join(root, "AGENTS.md"))) continue;
    writeFileSync(file, `${text.trimEnd()}\n\n${hint}\n`, "utf8");
    changed.push(name);
  }
  return changed;
}
