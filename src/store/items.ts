import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attachment } from "./attachments.js";
import { isSafeImage, mediaType, safeFileName, uniqueName } from "./attachments.js";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import type { Item, Reply } from "../core/types.js";
import { fold, ulid } from "../util/text.js";

// Layout: items/<ID>-<slug>/item.md, items/<ID>-<slug>/replies/<REPLY_ID>.md and items/<ID>-<slug>/files/<name>
// One file per reply means two people answering at once never conflict in git; attachments are plain files.

const ID = /^[0-9A-Z]{26}$/;

// Versions kept per item: enough to undo a bad day of edits, small enough never to matter on disk.
export const MAX_VERSIONS = 20;

// An item as it was before a change, and who replaced it when.
export interface ItemVersion {
  version: string;
  replaced_by: string;
  replaced_at: string;
  item: Item;
}

export function slugify(title: string): string {
  return (
    fold(title)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "item"
  );
}

export class ItemStore {
  private dirs = new Map<string, string>();
  private scannedAt = -1; // mtime of the items folder when `dirs` was last rebuilt from it
  scans = 0; // folder listings so far; tests use it to prove lookups do not scan per item

  constructor(private root: string) {}

  // id -> folder. A miss used to list the whole items folder, and a reindex looks up every item once:
  // n listings of n entries. Now the folder is listed again only when its own mtime changes (an item
  // folder was added, removed or renamed), so a full reindex lists it once.
  private dirFor(id: string): string | null {
    if (!ID.test(id)) return null;
    const cached = this.dirs.get(id);
    if (cached && existsSync(cached)) return cached;
    this.rescan();
    const dir = this.dirs.get(id);
    return dir && existsSync(dir) ? dir : null;
  }

  private mtime(): number | null {
    return statSync(this.root, { throwIfNoEntry: false })?.mtimeMs ?? null;
  }

  private rescan(): void {
    const m = this.mtime();
    if (m === null) {
      this.dirs.clear();
      this.scannedAt = -1;
      return;
    }
    if (m === this.scannedAt) return;
    this.scans++;
    this.dirs.clear();
    for (const name of readdirSync(this.root)) {
      const id = name.slice(0, 26);
      if (ID.test(id) && (name.length === 26 || name[26] === "-")) this.dirs.set(id, join(this.root, name));
    }
    this.scannedAt = m;
  }

  exists(id: string): boolean {
    return this.dirFor(id) !== null;
  }

  read(id: string): Item | null {
    const dir = this.dirFor(id);
    if (!dir || !existsSync(join(dir, "item.md"))) return null;
    const { meta, body } = parseFrontmatter<Item>(readFileSync(join(dir, "item.md"), "utf8"));
    return { ...meta, fields: meta.fields ?? {}, id, body };
  }

  write(item: Item): void {
    let dir = this.dirFor(item.id);
    if (!dir) {
      // A new item folder changes the items folder's mtime, and the next miss (the next new item) would list
      // the whole folder again: n listings for n creates. If nothing else changed it since our last listing,
      // the only change is ours, so the cache stays complete and we move its stamp forward instead.
      dir = join(this.root, `${item.id}-${slugify(item.title)}`);
      const before = this.mtime();
      mkdirSync(dir, { recursive: true });
      if (before !== null && before === this.scannedAt) this.scannedAt = this.mtime() ?? -1;
    }
    this.dirs.set(item.id, dir);
    const { body, ...meta } = item;
    writeFileSync(join(dir, "item.md"), stringifyFrontmatter(meta, body), "utf8");
  }

  addReply(reply: Reply): void {
    const dir = this.dirFor(reply.item_id);
    if (!dir) throw new Error(`item ${reply.item_id} not found`);
    mkdirSync(join(dir, "replies"), { recursive: true });
    const { body, item_id: _i, ...meta } = reply;
    writeFileSync(join(dir, "replies", `${reply.id}.md`), stringifyFrontmatter(meta, body), "utf8");
  }

  // ---- attachments ---------------------------------------------------------------------

  attachments(id: string): Attachment[] {
    const dir = this.dirFor(id);
    const fdir = dir && join(dir, "files");
    if (!fdir || !existsSync(fdir)) return [];
    const out: Attachment[] = [];
    for (const name of readdirSync(fdir)) {
      if (name.startsWith(".")) continue; // .gitkeep, .DS_Store
      const st = statSync(join(fdir, name));
      if (!st.isFile()) continue;
      out.push({ name: name.normalize("NFC"), size: st.size, type: mediaType(name), added_at: st.mtime.toISOString() });
    }
    return out.sort((a, b) => a.added_at.localeCompare(b.added_at) || a.name.localeCompare(b.name));
  }

  // What the board card needs: how many, and the first picture as its cover.
  fileSummary(id: string): { count: number; cover: string | null } {
    const files = this.attachments(id);
    return { count: files.length, cover: files.find((f) => isSafeImage(f.type))?.name ?? null };
  }

  readAttachment(id: string, name: string): Buffer | null {
    const file = this.attachmentPath(id, name);
    return file && existsSync(file) ? readFileSync(file) : null;
  }

  // Stores `data` under a safe, unused name and returns what was stored.
  addAttachment(id: string, rawName: string, data: Buffer): Attachment {
    const dir = this.dirFor(id);
    if (!dir) throw new Error(`item ${id} not found`);
    const fdir = join(dir, "files");
    mkdirSync(fdir, { recursive: true });
    const taken = new Set(readdirSync(fdir).map((n) => n.normalize("NFC").toLowerCase()));
    const name = uniqueName(safeFileName(rawName), taken);
    writeFileSync(join(fdir, name), data);
    return this.attachments(id).find((a) => a.name === name)!;
  }

  removeAttachment(id: string, name: string): boolean {
    const file = this.attachmentPath(id, name);
    if (!file || !existsSync(file)) return false;
    unlinkSync(file);
    return true;
  }

  // Only a name that is already safe resolves: "../item.md" or "a/b" never leave the files folder.
  private attachmentPath(id: string, name: string): string | null {
    const dir = this.dirFor(id);
    const clean = String(name ?? "").normalize("NFC");
    if (!dir || !clean || clean !== safeFileName(clean)) return null;
    return join(dir, "files", clean);
  }

  replies(id: string): Reply[] {
    const dir = this.dirFor(id);
    const rdir = dir && join(dir, "replies");
    if (!rdir || !existsSync(rdir)) return [];
    return readdirSync(rdir)
      .filter((f) => f.endsWith(".md"))
      .sort() // ULIDs sort by time
      .map((f) => {
        const { meta, body } = parseFrontmatter<Reply>(readFileSync(join(rdir, f), "utf8"));
        return { ...meta, id: f.slice(0, -3), item_id: id, body };
      });
  }

  // ---- versions ------------------------------------------------------------------------
  // items/<ID>-<slug>/history/<VERSION_ULID>.md: the item as it was before a change replaced it. Kept in the
  // project, so undoing a lost handoff note needs neither git nor a commit that captured it.

  addVersion(previous: Item, replacedBy: string, replacedAt: string): string {
    const dir = this.dirFor(previous.id);
    if (!dir) throw new Error(`item ${previous.id} not found`);
    const hdir = join(dir, "history");
    mkdirSync(hdir, { recursive: true });
    const vid = ulid(); // now, not replacedAt: ulid() is monotonic only for the current time, and versions must sort in write order
    const { body, ...meta } = previous;
    writeFileSync(join(hdir, `${vid}.md`), stringifyFrontmatter({ ...meta, replaced_by: replacedBy, replaced_at: replacedAt }, body), "utf8");
    // Oldest first by name (ULIDs sort by time); keep the newest MAX_VERSIONS.
    const all = readdirSync(hdir)
      .filter((n) => n.endsWith(".md"))
      .sort();
    for (const old of all.slice(0, Math.max(0, all.length - MAX_VERSIONS))) unlinkSync(join(hdir, old));
    return vid;
  }

  // Newest first.
  versions(id: string): ItemVersion[] {
    const dir = this.dirFor(id);
    const hdir = dir && join(dir, "history");
    if (!hdir || !existsSync(hdir)) return [];
    return readdirSync(hdir)
      .filter((n) => n.endsWith(".md"))
      .sort()
      .reverse()
      .map((n) => this.readVersion(join(hdir, n), id, n.slice(0, -3)));
  }

  version(id: string, vid: string): ItemVersion | null {
    if (!ID.test(vid)) return null;
    const dir = this.dirFor(id);
    const file = dir && join(dir, "history", `${vid}.md`);
    return file && existsSync(file) ? this.readVersion(file, id, vid) : null;
  }

  private readVersion(file: string, id: string, vid: string): ItemVersion {
    const { meta, body } = parseFrontmatter<Item & { replaced_by: string; replaced_at: string }>(readFileSync(file, "utf8"));
    const { replaced_by, replaced_at, ...item } = meta;
    return { version: vid, replaced_by, replaced_at, item: { ...item, fields: item.fields ?? {}, id, body } };
  }

  // The whole folder: item, replies, attachments. Git history keeps it.
  remove(id: string): void {
    const dir = this.dirFor(id);
    if (!dir) return;
    rmSync(dir, { recursive: true, force: true });
    this.dirs.delete(id);
  }

  allIds(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .map((n) => n.slice(0, 26))
      .filter((n) => ID.test(n))
      .sort();
  }
}
