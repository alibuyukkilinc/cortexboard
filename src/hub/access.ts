import type { Access, ItemRef, Perm } from "../api/access.js";
import type { Activity } from "../core/types.js";
import type { SqlFilter } from "../index/db.js";
import type { Role } from "./roles.js";
import { ROLE_PERMS } from "./roles.js";

// A member's view of one project: what their role allows, and which part of the project they see.
// scope "own": items they wrote or are assigned to (personally or through @humans / @ai), and activity about those.
// branches: only knowledge (and items filed) under these branches; ancestors stay visible so the tree can be walked.
export function buildAccess(m: { principal: string; kind: "human" | "ai"; role: Role; scope: "all" | "own"; branches: string[] }): Access {
  const perms = new Set<Perm>(ROLE_PERMS[m.role] ?? []);
  const group = m.kind === "human" ? "@humans" : "@ai";
  const inBranches = (p: string | null | undefined) => m.branches.length === 0 || (!!p && m.branches.some((b) => p === b || p.startsWith(`${b}/`)));
  const mine = (i: ItemRef) => i.author === m.principal || i.assignee === m.principal || i.assignee === group;

  const seesItem = (i: ItemRef) => mine(i) || (m.scope === "all" && inBranches(i.category_path));
  const seesNode = (path: string) => path === "" || inBranches(path) || m.branches.some((b) => b.startsWith(`${path}/`)); // ancestors of an allowed branch

  // The same rule as seesItem, for the database. Kept next to it so the two cannot drift apart
  // (test/scoped-pagination.test.ts checks them against each other).
  const itemSql = (): SqlFilter | null => {
    if (m.scope === "all" && m.branches.length === 0) return null;
    const own = { sql: "author = ? OR assignee = ? OR assignee = ?", args: [m.principal, m.principal, group] };
    if (m.scope !== "all") return own;
    const like = (b: string) => `${b.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`; // "_" is a LIKE wildcard; branch names use it
    const branch = m.branches.map(() => "category_path = ? OR category_path LIKE ? ESCAPE '\\'").join(" OR ");
    return { sql: `${own.sql} OR ${branch}`, args: [...own.args, ...m.branches.flatMap((b) => [b, like(b)])] };
  };

  return {
    role: m.role,
    restricted: m.scope !== "all" || m.branches.length > 0,
    can: (p) => perms.has(p),
    seesNode,
    seesItem,
    itemSql,
    seesActivity(a: Activity, itemOf) {
      if (a.actor === m.principal) return true;
      const refs = a.refs ?? [];
      if (m.scope === "all" && m.branches.length === 0) return true;
      return refs.some((r) => {
        const item = itemOf(r);
        if (item) return seesItem(item);
        return m.scope === "all" && inBranches(r); // a node path
      });
    },
  };
}
