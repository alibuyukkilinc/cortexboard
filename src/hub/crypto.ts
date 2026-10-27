import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Passwords: scrypt with a random salt, stored as "scrypt$N$r$p$salt$hash". Verification is constant-time.
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

function derive(password: string, salt: Buffer, n = N, r = R, p = P): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parts = stored?.split("$") ?? [];
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    // Spend the same time as a real check so a missing account does not answer faster.
    await derive(password, randomBytes(16));
    return false;
  }
  const [, n, r, p, salt, hash] = parts;
  const key = await derive(password, Buffer.from(salt, "base64url"), Number(n), Number(r), Number(p));
  const want = Buffer.from(hash, "base64url");
  return want.length === key.length && timingSafeEqual(want, key);
}

// Session, invite and agent tokens: random, shown once, stored only as a SHA-256 hash.
export function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const PASSWORD_MIN = 10;
