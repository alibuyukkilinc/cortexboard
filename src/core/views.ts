import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowIso, ulid } from "../util/text.js";
import type { Cortex } from "./cortex.js";
import type { Actor } from "./types.js";
import { CortexError } from "./types.js";

// Saved views: a person's named filters for the board, search or the activity feed ("my open issues in
// backend", "what the agents did this week"). Kept per person on the server, so the same view is there on the
// phone and at the desk: .cortex/views/<actor>.json (a hub keeps one per member in the project too). Not
// indexed and not shown to anyone else.

export interface SavedView {
  id: string;
  name: string;
  page: "board" | "search" | "activity";
  query: string; // the page's hash route with its filters, e.g. "board/issue?assignee=@ai&path=backend"
  created_at: string;
}

const PAGES = ["board", "search", "activity"] as const;
const MAX_VIEWS = 50;

export class ViewService {
  constructor(private c: Cortex) {}

  private file(actor: Actor): string {
    // Actor ids are letters, digits, - and _ (checked at config load); hub principals are the same shape.
    const safe = actor.id.replace(/[^A-Za-z0-9_-]/g, "_");
    return join(this.c.project.dir, "views", `${safe}.json`);
  }

  list(actor: Actor): SavedView[] {
    const file = this.file(actor);
    if (!existsSync(file)) return [];
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as { views?: SavedView[] };
      return Array.isArray(data.views) ? data.views : [];
    } catch {
      return []; // a hand-broken file must not take the page down
    }
  }

  // Same name on the same page replaces the view (saving again after changing the filters).
  save(actor: Actor, input: { name?: unknown; page?: unknown; query?: unknown }): SavedView {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const page = input.page as SavedView["page"];
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!name || name.length > 80) throw new CortexError("invalid_view", "Give the view a name (at most 80 characters).", 400);
    if (!PAGES.includes(page)) throw new CortexError("invalid_view", `page must be one of ${PAGES.join(", ")}.`, 400);
    if (!query.startsWith(page) || query.length > 500) throw new CortexError("invalid_view", `query must be this page's route, e.g. "${page}?...".`, 400);
    const views = this.list(actor);
    const existing = views.find((v) => v.page === page && v.name.toLowerCase() === name.toLowerCase());
    const view: SavedView = { id: existing?.id ?? ulid(), name, page, query, created_at: existing?.created_at ?? nowIso() };
    const next = existing ? views.map((v) => (v.id === view.id ? view : v)) : [...views, view];
    if (next.length > MAX_VIEWS) throw new CortexError("too_many_views", `At most ${MAX_VIEWS} saved views; delete one first.`, 400);
    this.write(actor, next);
    return view;
  }

  remove(actor: Actor, id: string): void {
    const views = this.list(actor);
    if (!views.some((v) => v.id === id)) throw new CortexError("not_found", "No such saved view.", 404);
    this.write(
      actor,
      views.filter((v) => v.id !== id),
    );
  }

  private write(actor: Actor, views: SavedView[]): void {
    const file = this.file(actor);
    mkdirSync(join(this.c.project.dir, "views"), { recursive: true });
    writeFileSync(file, JSON.stringify({ views }, null, 2) + "\n", "utf8");
  }
}
