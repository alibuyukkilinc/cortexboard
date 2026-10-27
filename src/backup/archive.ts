import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { CortexError } from "../core/types.js";

// The backup archive (task 01M3NQYNRX7X7Z3660KFA2WHZQ): a plain tar of the files, gzipped and sealed with
// AES-256-GCM under a key made from the passphrase. Shared by hub backups and single-project backups.

export interface Entry {
  name: string; // forward slashes, relative to the archive root
  data: Buffer;
  mtime: number;
}

// Never in an archive: search indexes (rebuilt), and what only makes sense on this machine: the backup keys
// and last result, a project's local-mode tokens, board sessions and personal views.
export const SKIP = new Set([".index", "backup.secrets.yaml", ".backup-last.json", ".secrets.yaml", ".sessions.json", ".restore", ".prompts"]);

export function collect(root: string, prefix: string, out: Entry[], skip: (name: string) => boolean = () => false): void {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    if (SKIP.has(name) || skip(name)) continue;
    const full = join(root, name);
    const st = statSync(full);
    if (st.isDirectory()) collect(full, `${prefix}${name}/`, out, skip);
    else if (st.isFile()) out.push({ name: `${prefix}${name}`, data: readFileSync(full), mtime: st.mtimeMs });
  }
}

// A plain ustar writer: no dependency for the one format every system can open.
export function tar(entries: Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    let name = e.name;
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
      // ustar splits a long path at a slash: up to 155 bytes of folders, then up to 100 of the rest.
      let i = name.indexOf("/");
      while (i >= 0 && Buffer.byteLength(name.slice(i + 1)) > 100) i = name.indexOf("/", i + 1);
      if (i < 0 || Buffer.byteLength(name.slice(0, i)) > 155) throw new CortexError("backup_failed", `Path too long for the archive: ${name}`, 500);
      prefix = name.slice(0, i);
      name = name.slice(i + 1);
    }
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100, 8, "ascii");
    h.write("0000000\0", 108, 8, "ascii");
    h.write("0000000\0", 116, 8, "ascii");
    h.write(e.data.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    h.write(
      Math.floor(e.mtime / 1000)
        .toString(8)
        .padStart(11, "0") + "\0",
      136,
      12,
      "ascii",
    );
    h.write("        ", 148, 8, "ascii");
    h.write("0", 156, 1, "ascii");
    h.write("ustar\0", 257, 6, "ascii");
    h.write("00", 263, 2, "ascii");
    h.write(prefix, 345, 155, "utf8");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    blocks.push(h, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export function untar(buf: Buffer): Entry[] {
  const out: Entry[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, n: number) => h.toString("utf8", a, a + n).replace(/\0.*$/s, "");
    const size = parseInt(str(124, 12).trim() || "0", 8);
    const prefix = str(345, 155);
    const name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
    const mtime = parseInt(str(136, 12).trim() || "0", 8) * 1000;
    off += 512;
    if (str(156, 1) === "0" || str(156, 1) === "") out.push({ name, data: Buffer.from(buf.subarray(off, off + size)), mtime });
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

// Writes entries under `to`, refusing any path that would land outside it.
export function writeEntries(entries: Entry[], to: string): void {
  for (const e of entries) {
    const target = join(to, ...e.name.split("/"));
    const rel = relative(to, target);
    if (!rel || rel.startsWith("..") || rel.split(sep).includes(".."))
      throw new CortexError("invalid_backup", `Refusing a path outside the target: ${e.name}`, 400);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, e.data);
  }
}

const MAGIC = Buffer.from("CXBK1");

function key(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

// CXBK1 | salt(16) | iv(12) | tag(16) | AES-256-GCM(gzip(tar))
export function seal(plain: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(passphrase, salt), iv);
  const body = Buffer.concat([c.update(gzipSync(plain)), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}

export function open(sealed: Buffer, passphrase: string): Buffer {
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new CortexError("invalid_backup", "Not a Cortex backup.", 400);
  let o = MAGIC.length;
  const salt = sealed.subarray(o, (o += 16));
  const iv = sealed.subarray(o, (o += 12));
  const tag = sealed.subarray(o, (o += 16));
  const d = createDecipheriv("aes-256-gcm", key(passphrase, salt), iv);
  d.setAuthTag(tag);
  try {
    return gunzipSync(Buffer.concat([d.update(sealed.subarray(o)), d.final()]));
  } catch {
    throw new CortexError("invalid_backup", "The passphrase does not open this backup, or the file is damaged.", 400);
  }
}
