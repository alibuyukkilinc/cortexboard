import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { CortexError } from "../core/types.js";
import type { HubStore } from "./store.js";

// Email from the hub: password reset links (POST /api/auth/forgot) and a test message. Sent through the
// Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email) with plain fetch: one endpoint,
// no dependency. Organization admins set it up on the board (Organization → Email): the provider and sender
// go in hub.yaml (`mail`), the API key in mail.secrets.yaml next to it (0600), never back out of the API.
// The sender must be on a domain verified in Resend.

export interface MailSettings {
  provider: "resend";
  from: string; // "Cortex <no-reply@example.com>"
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type Fetch = typeof fetch;

const SECRETS = "mail.secrets.yaml";
const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 15_000;
// A bare address or "Name <address>".
const FROM = /^(?:[^<>@\n]+<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/;

const secretsFile = (store: HubStore) => join(store.dir, SECRETS);

function readKey(store: HubStore): string | undefined {
  if (process.env.CORTEX_RESEND_API_KEY?.trim()) return process.env.CORTEX_RESEND_API_KEY.trim();
  if (!existsSync(secretsFile(store))) return undefined;
  const s = (YAML.parse(readFileSync(secretsFile(store), "utf8")) as { resend_api_key?: string } | null) ?? {};
  return s.resend_api_key?.trim() || undefined;
}

function writeKey(store: HubStore, key: string | undefined): void {
  const body = key ? YAML.stringify({ resend_api_key: key }) : "";
  writeFileSync(secretsFile(store), "# Email provider key. Never commit, never share.\n" + body, { encoding: "utf8", mode: 0o600 });
}

// Ready to send: a provider, a sender and a key.
export function mailReady(store: HubStore): boolean {
  const m = store.settings.mail;
  return m?.provider === "resend" && !!m.from && !!readKey(store);
}

export function mailStatus(store: HubStore) {
  const m = store.settings.mail;
  const key = readKey(store);
  return {
    provider: m?.provider ?? null,
    from: m?.from ?? "",
    key_last4: key ? key.slice(-4) : null,
    key_from_env: !!process.env.CORTEX_RESEND_API_KEY?.trim(),
    ready: mailReady(store),
  };
}

// provider "off" turns email off and forgets the key. An empty api_key keeps the one already saved.
export function configureMail(store: HubStore, input: { provider?: string; from?: string; api_key?: string }) {
  if (input.provider === "off") {
    store.saveSettings({ mail: undefined });
    writeKey(store, undefined);
    return mailStatus(store);
  }
  if (input.provider !== "resend") throw new CortexError("invalid_mail", 'provider is "resend" or "off".', 400);
  const from = (input.from ?? "").trim();
  if (!FROM.test(from)) throw new CortexError("invalid_mail", 'Sender: an address on a domain verified in Resend, e.g. "Cortex <no-reply@example.com>".', 400);
  const key = input.api_key?.trim();
  if (key && !/^re_[\w-]{8,}$/.test(key)) throw new CortexError("invalid_mail", "A Resend API key starts with re_.", 400);
  if (!key && !readKey(store)) throw new CortexError("invalid_mail", "Enter the Resend API key.", 400);
  if (key) writeKey(store, key);
  store.saveSettings({ mail: { provider: "resend", from } });
  return mailStatus(store);
}

// Throws when the provider refuses. The key and the message never go into the error text.
export async function sendMail(store: HubStore, message: MailMessage, fetchFn: Fetch = fetch): Promise<void> {
  const m = store.settings.mail;
  const key = readKey(store);
  if (m?.provider !== "resend" || !m.from || !key) throw new CortexError("mail_off", "Email is not set up on this hub.", 409);
  const res = await fetchFn(RESEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: m.from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // Resend's error body: { name, message, statusCode }.
    const body = (await res.json().catch(() => null)) as { name?: string; message?: string } | null;
    throw new CortexError("mail_failed", `Resend did not accept the email (${res.status} ${body?.name ?? ""}): ${body?.message ?? res.statusText}`, 502);
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// The reset email, in Turkish and English: the hub has no per-person language.
export function resetMail(input: { to: string; name: string; org: string; url: string; minutes: number }): MailMessage {
  const { name, org, url, minutes } = input;
  const text = [
    `Merhaba ${name},`,
    "",
    `${org} Cortex hesabın için şifre sıfırlama istendi. Yeni şifreni bu bağlantıdan belirle (${minutes} dakika geçerli, tek kullanımlık):`,
    url,
    "",
    "Bu isteği sen yapmadıysan bu e-postayı yok say; şifren değişmez.",
    "",
    "---",
    `Hi ${name}, a password reset was requested for your ${org} Cortex account. Set a new password here (valid ${minutes} minutes, once):`,
    url,
    "If you did not ask for this, ignore this email; your password stays the same.",
  ].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;max-width:520px">
<p>Merhaba ${esc(name)},</p>
<p><b>${esc(org)}</b> Cortex hesabın için şifre sıfırlama istendi. Yeni şifreni aşağıdaki bağlantıdan belirle (${minutes} dakika geçerli, tek kullanımlık).</p>
<p><a href="${esc(url)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Şifremi belirle</a></p>
<p style="color:#6b7280;font-size:13px">Bu isteği sen yapmadıysan bu e-postayı yok say; şifren değişmez.<br>${esc(url)}</p>
<hr style="border:none;border-top:1px solid #e5e7eb">
<p style="color:#6b7280;font-size:13px">A password reset was requested for your ${esc(org)} Cortex account. The button above sets a new one (valid ${minutes} minutes, once). If you did not ask for this, ignore this email.</p>
</div>`;
  return { to: input.to, subject: `${org} Cortex: şifre sıfırlama / password reset`, text, html };
}
