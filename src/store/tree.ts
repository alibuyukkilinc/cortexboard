import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import type { KnowledgeNode, NodeMeta } from "../core/types.js";
import { CortexError } from "../core/types.js";

// Layout on disk:
//   tree/_node.md                  -> root ("")
//   tree/backend/_node.md          -> "backend"  (a branch: has children)
//   tree/backend/auth/jwt.md       -> "backend/auth/jwt" (a leaf)
// A leaf becomes a branch automatically when a child is added under it.

const SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BRANCH_FILE = "_node.md";

export function normalizePath(path: string): string {
  const p = (path ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (p === "") return "";
  const segs = p.split("/");
  for (const s of segs) {
    if (!SEGMENT.test(s)) {
      throw new CortexError("invalid_path", `Invalid path segment "${s}". Use lowercase letters, digits and dashes, e.g. "backend/auth/jwt-refresh".`);
    }
  }
  return segs.join("/");
}

export function parentPath(path: string): string | null {
  if (path === "") return null;
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export class TreeStore {
  constructor(private treeDir: string) {}

  private fileFor(path: string): string | null {
    if (path === "") return join(this.treeDir, BRANCH_FILE);
    const asDir = join(this.treeDir, path);
    if (existsSync(asDir) && statSync(asDir).isDirectory()) return join(asDir, BRANCH_FILE);
    const asLeaf = join(this.treeDir, `${path}.md`);
    return existsSync(asLeaf) ? asLeaf : null;
  }

  exists(path: string): boolean {
    const f = this.fileFor(path);
    return f !== null && existsSync(f);
  }

  read(path: string): KnowledgeNode | null {
    const f = this.fileFor(path);
    if (!f || !existsSync(f)) return null;
    const { meta, body } = parseFrontmatter<NodeMeta>(readFileSync(f, "utf8"));
    return { ...meta, status: meta.status ?? "active", path, body };
  }

  write(node: KnowledgeNode): void {
    const parent = parentPath(node.path);
    if (parent !== null && !this.exists(parent)) {
      throw new CortexError("parent_missing", `Parent "${parent}" does not exist. Create the parent branch first so every level has a summary.`, 400, {
        create_first: parent,
      });
    }
    if (parent !== null && parent !== "") this.promoteToBranch(parent);

    const existing = this.fileFor(node.path);
    const file = existing ?? (node.path === "" ? join(this.treeDir, BRANCH_FILE) : join(this.treeDir, `${node.path}.md`));
    mkdirSync(dirname(file), { recursive: true });
    const { path: _p, body, ...meta } = node;
    writeFileSync(file, stringifyFrontmatter(meta, body), "utf8");
  }

  // Removes a node that has no children (the caller checks). A parent left with nothing but its _node.md
  // goes back to a leaf file, the mirror of promoteToBranch.
  remove(path: string): void {
    const f = this.fileFor(path);
    if (!f || !existsSync(f)) return;
    unlinkSync(f);
    if (f.endsWith(BRANCH_FILE) && readdirSync(dirname(f)).length === 0) rmdirSync(dirname(f));
    const parent = parentPath(path);
    if (!parent) return; // "" (root) is always the tree folder itself
    const parentDir = join(this.treeDir, parent);
    if (existsSync(parentDir) && readdirSync(parentDir).join() === BRANCH_FILE) {
      renameSync(join(parentDir, BRANCH_FILE), `${parentDir}.md`);
      rmdirSync(parentDir);
    }
  }

  // Turn "a/b.md" into "a/b/_node.md" so it can hold children.
  private promoteToBranch(path: string): void {
    const leaf = join(this.treeDir, `${path}.md`);
    if (!existsSync(leaf)) return;
    const dir = join(this.treeDir, path);
    mkdirSync(dir, { recursive: true });
    renameSync(leaf, join(dir, BRANCH_FILE));
  }

  all(): KnowledgeNode[] {
    const out: KnowledgeNode[] = [];
    if (!existsSync(this.treeDir)) return out;
    const walk = (dir: string, prefix: string) => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full, prefix ? `${prefix}/${name}` : name);
        } else if (name.endsWith(".md")) {
          const path = name === BRANCH_FILE ? prefix : prefix ? `${prefix}/${name.slice(0, -3)}` : name.slice(0, -3);
          const node = this.read(path);
          if (node) out.push(node);
        }
      }
    };
    walk(this.treeDir, "");
    return out;
  }
}
