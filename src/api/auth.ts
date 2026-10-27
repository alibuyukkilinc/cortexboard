import { createHmac, timingSafeEqual } from "node:crypto";

// Login links for the web board: "<actor>.<expiry>.<hmac>" signed with the actor's own token.
// Stateless, so `cortexboard login` can mint a link while the server runs in another process.
// The token itself never appears in the URL or browser history.

const TTL_MS = 10 * 60 * 1000;

function sign(actorId: string, expires: number, token: string): string {
  return createHmac("sha256", token).update(`${actorId}.${expires}`).digest("base64url");
}

export function createLoginCode(actorId: string, token: string, now = Date.now()): string {
  const expires = now + TTL_MS;
  return `${actorId}.${expires}.${sign(actorId, expires, token)}`;
}

export function verifyLoginCode(code: string, tokens: Record<string, string>, now = Date.now()): string | null {
  const [actorId, exp, mac] = code.split(".");
  const expires = Number(exp);
  const token = actorId ? tokens[actorId] : undefined;
  if (!token || !mac || !Number.isFinite(expires) || expires < now) return null;
  const want = Buffer.from(sign(actorId, expires, token));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got) ? actorId : null;
}

export const SESSION_COOKIE = "cortex_session";
export const CSRF_HEADER = "x-cortex-csrf";
