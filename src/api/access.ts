import type { FastifyRequest } from "fastify";
import type { Activity } from "../core/types.js";
import { CortexError } from "../core/types.js";
import type { SqlFilter } from "../index/db.js";

// What a principal may do in one project. The hub fills this from the member's role; single-project mode
// (`cortexboard start`, localhost only) has no access object and relies on the core's own human/AI rules.
export type Perm =
  | "read"
  | "ask" // open questions, reply to them
  | "write_items"
  | "write_knowledge"
  | "delete_knowledge"
  | "approve"
  | "edit_rules"
  | "manage_members"
  | "reports"
  | "log_activity";

export interface ItemRef {
  author: string;
  assignee?: string | null;
  category_path?: string | null;
}

export interface Access {
  role: string;
  can(p: Perm): boolean;
  // False when the member sees only their own items or only some branches: reports then stay off.
  restricted: boolean;
  seesNode(path: string): boolean;
  seesItem(item: ItemRef): boolean;
  // seesItem as SQL over the items table, or null when every item is visible.
  itemSql(): SqlFilter | null;
  seesActivity(a: Activity, itemOf: (id: string) => ItemRef | null): boolean;
}

export function need(req: FastifyRequest, p: Perm): void {
  if (req.access && !req.access.can(p)) {
    throw new CortexError("forbidden", `Your role (${req.access.role}) does not allow this.`, 403, { needs: p, role: req.access.role });
  }
}

export function hidden(what: string): CortexError {
  return new CortexError("not_found", `${what} not found or not visible to you.`, 404);
}
