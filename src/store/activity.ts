import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Activity } from "../core/types.js";

// Append-only log, one file per actor per day: activity/2026-09-22/claude-code.jsonl
// Different actors never touch the same file. The same actor on two machines does (one AI id on two
// laptops), so .cortex/.gitattributes merges these files by union: every line is an independent entry
// with a unique id, and readers sort by id, so keeping both sides' lines is the correct merge.
export class ActivityStore {
  constructor(private root: string) {}

  append(entry: Activity): void {
    const day = entry.at.slice(0, 10);
    const dir = join(this.root, day);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${entry.actor}.jsonl`), JSON.stringify(entry) + "\n", "utf8");
  }

  // One day's log for one actor, e.g. "2026-09-22/owner.jsonl". null means the file is gone:
  // the caller cannot tell which entries to drop, so it has to fall back to a full rebuild.
  readFile(rel: string): Activity[] | null {
    const file = join(this.root, rel);
    if (!existsSync(file)) return null;
    const out: Activity[] = [];
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Activity);
      } catch {
        // A merge-mangled line must not take the whole log down.
      }
    }
    return out;
  }

  all(): Activity[] {
    if (!existsSync(this.root)) return [];
    const out: Activity[] = [];
    for (const day of readdirSync(this.root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
      for (const f of readdirSync(join(this.root, day)).filter((x) => x.endsWith(".jsonl"))) {
        out.push(...(this.readFile(`${day}/${f}`) ?? []));
      }
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  }
}
