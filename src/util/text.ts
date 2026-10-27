import { randomBytes, createHash } from "node:crypto";

// Turkish-aware folding so "kullanici" matches "Kullanıcı" in keyword search.
// FTS5's remove_diacritics handles most accents, but not ı/İ, so we fold before indexing and querying.
const FOLD: Record<string, string> = {
  ı: "i",
  İ: "i",
  I: "i",
  ş: "s",
  Ş: "s",
  ğ: "g",
  Ğ: "g",
  ç: "c",
  Ç: "c",
  ö: "o",
  Ö: "o",
  ü: "u",
  Ü: "u",
};

export function fold(text: string): string {
  return text
    .replace(/[ıİIşŞğĞçÇöÖüÜ]/g, (c) => FOLD[c] ?? c)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Rough token estimate (~4 chars per token). Good enough for budgeting responses.
export function estimateTokens(value: unknown): number {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(s.length / 4);
}

// Cut to a whole word, with an ellipsis, so a trimmed summary still reads like a sentence.
export function shorten(text: string, max: number): string {
  if (max === 0) return "";
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// ULID: time-sortable, collision-safe ids so parallel writers never clash in git.
// Monotonic inside a millisecond: the random part is incremented instead of redrawn, so ids sort in the
// order they were made. Without it, two entries written in the same millisecond (a fast machine logging
// twice) sorted at random, and a report's "newest first" came out in a different order on each machine.
let lastMs = -1;
let lastRand: number[] = [];

export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  if (now === lastMs) {
    for (let i = lastRand.length - 1; i >= 0; i--) {
      if (lastRand[i] < 31) {
        lastRand[i]++;
        break;
      }
      lastRand[i] = 0; // carry; 32^16 ids in one millisecond is not a real case
    }
  } else {
    lastMs = now;
    lastRand = [...randomBytes(16)].map((b) => b % 32);
  }
  return time + lastRand.map((i) => CROCKFORD[i]).join("");
}

// The short id the board shows for an item: the last characters of its ULID. They come from the random
// part, so two items sharing them is rare; a short id that does match several is refused, never guessed.
export const SHORT_ID_LENGTH = 6;

export function shortId(id: string): string {
  return id.slice(-SHORT_ID_LENGTH);
}

// A typed short id as the ULID ending to look up: "#zkfba9" -> "ZKFBA9". Crockford base32 reads I and L as 1
// and O as 0, so a misread character still finds the item. null when the text cannot be one.
export function shortIdSuffix(text: string): string | null {
  const s = text.trim().replace(/^#/, "").toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");
  return /^[0-9A-HJKMNP-TV-Z]{4,25}$/.test(s) ? s : null;
}

export function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

export function nowIso(): string {
  return new Date().toISOString();
}
