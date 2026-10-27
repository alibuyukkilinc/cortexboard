import { createHash } from "node:crypto";
import { CortexError } from "../core/types.js";

// Where backups go: BunnyCDN Storage or Google Drive. Both only ever see the sealed archive.

export interface RemoteFile {
  name: string;
  bytes: number;
  at: string;
}

export interface Provider {
  put(name: string, body: Buffer): Promise<void>;
  list(): Promise<RemoteFile[]>;
  get(name: string): Promise<Buffer>;
  remove(name: string): Promise<void>;
}

// A connection the other side had already closed (fetch keeps them for reuse, and a reused address can hand back a
// dead one) fails before any answer, so trying again cannot double anything; the file name is the same.
const DROPPED = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);
const dropped = (e: unknown) => e instanceof TypeError && DROPPED.has(String((e.cause as { code?: string } | undefined)?.code));

async function call(url: string, init: { method: string; body?: Buffer | string; headers?: Record<string, string> }, what = "Storage") {
  const send = () =>
    fetch(url, {
      method: init.method,
      headers: init.headers ?? {},
      ...(init.body !== undefined ? { body: typeof init.body === "string" ? init.body : new Uint8Array(init.body) } : {}),
      signal: AbortSignal.timeout(10 * 60_000),
    });
  const res = await send().catch((e: unknown) => (dropped(e) ? send() : Promise.reject(e)));
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new CortexError("backup_failed", `${what} answered ${res.status}${text ? `: ${text}` : ""}`, 502);
  }
  return res;
}

// ---- BunnyCDN Storage ------------------------------------------------------------------------

export const BUNNY_REGIONS = new Set(["", "de", "uk", "ny", "la", "sg", "se", "br", "jh", "syd"]);

export function bunny(o: { zone: string; region?: string; path: string; accessKey: string; endpoint?: string }): Provider {
  const host = (o.endpoint ?? `https://${o.region && o.region !== "de" ? `${o.region}.` : ""}storage.bunnycdn.com`).replace(/\/+$/, "");
  const folder = `${host}/${encodeURIComponent(o.zone)}/${o.path.split("/").map(encodeURIComponent).join("/")}/`;
  const h = (extra: Record<string, string> = {}) => ({ AccessKey: o.accessKey, ...extra });
  return {
    async put(name, body) {
      const checksum = createHash("sha256").update(body).digest("hex").toUpperCase();
      await call(folder + encodeURIComponent(name), { method: "PUT", body, headers: h({ "Content-Type": "application/octet-stream", Checksum: checksum }) });
    },
    async list() {
      const res = await call(folder, { method: "GET", headers: h({ Accept: "application/json" }) });
      const rows = (await res.json()) as { ObjectName: string; Length: number; LastChanged: string; IsDirectory: boolean }[];
      return rows.filter((x) => !x.IsDirectory).map((x) => ({ name: x.ObjectName, bytes: x.Length, at: x.LastChanged }));
    },
    async get(name) {
      return Buffer.from(await (await call(folder + encodeURIComponent(name), { method: "GET", headers: h() })).arrayBuffer());
    },
    async remove(name) {
      await call(folder + encodeURIComponent(name), { method: "DELETE", headers: h() });
    },
  };
}

// ---- Google Drive ----------------------------------------------------------------------------
//
// OAuth device flow (no redirect address needed, works on a server without a browser) with the drive.file
// scope: the app sees only the files it made itself, never the rest of the person's Drive. The person makes
// an OAuth client of type "TVs and Limited Input devices" in Google Cloud and enables the Drive API.

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface GoogleAuth {
  clientId: string;
  clientSecret: string;
  endpoint?: string; // one base for both OAuth and the Drive API (tests)
}

const oauthBase = (a: GoogleAuth) => (a.endpoint ?? "https://oauth2.googleapis.com").replace(/\/+$/, "");
const apiBase = (a: GoogleAuth) => (a.endpoint ?? "https://www.googleapis.com").replace(/\/+$/, "");
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

export async function googleDeviceStart(a: GoogleAuth) {
  const res = await call(
    `${oauthBase(a)}/device/code`,
    { method: "POST", headers: FORM, body: form({ client_id: a.clientId, scope: GOOGLE_SCOPE }) },
    "Google",
  );
  const r = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_url?: string;
    verification_uri?: string;
    expires_in: number;
    interval?: number;
  };
  return {
    device_code: r.device_code,
    user_code: r.user_code,
    verification_url: r.verification_url ?? r.verification_uri ?? "https://www.google.com/device",
    expires_in: r.expires_in,
    interval: r.interval ?? 5,
  };
}

// One look at whether the person has approved. Google answers 400/428 with an error while it waits.
export async function googleDevicePoll(
  a: GoogleAuth,
  deviceCode: string,
): Promise<{ status: "connected"; refresh_token: string } | { status: "pending" | "slow_down" | "denied" | "expired"; message?: string }> {
  const res = await fetch(`${oauthBase(a)}/token`, {
    method: "POST",
    headers: FORM,
    body: form({ client_id: a.clientId, client_secret: a.clientSecret, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    signal: AbortSignal.timeout(30_000),
  });
  const r = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string; error_description?: string };
  if (res.ok && r.refresh_token) return { status: "connected", refresh_token: r.refresh_token };
  if (r.error === "authorization_pending") return { status: "pending" };
  if (r.error === "slow_down") return { status: "slow_down" };
  if (r.error === "access_denied") return { status: "denied" };
  if (r.error === "expired_token") return { status: "expired" };
  throw new CortexError("backup_failed", `Google answered ${res.status}: ${r.error_description ?? r.error ?? "no refresh token"}`, 502);
}

// Access tokens live an hour; one per refresh token, reused until shortly before it runs out.
const accessTokens = new Map<string, { token: string; until: number }>();

async function accessToken(a: GoogleAuth, refreshToken: string): Promise<string> {
  const cached = accessTokens.get(refreshToken);
  if (cached && cached.until > Date.now()) return cached.token;
  const res = await fetch(`${oauthBase(a)}/token`, {
    method: "POST",
    headers: FORM,
    body: form({ client_id: a.clientId, client_secret: a.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(30_000),
  });
  const r = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !r.access_token) {
    // invalid_grant: revoked, or dropped after 7 days while the consent screen is still "Testing".
    const hint = r.error === "invalid_grant" ? " Connect Google Drive again (Backups → Connect)." : "";
    throw new CortexError("backup_failed", `Google refused the stored sign-in: ${r.error_description ?? r.error ?? res.status}.${hint}`, 502);
  }
  accessTokens.set(refreshToken, { token: r.access_token, until: Date.now() + ((r.expires_in ?? 3600) - 120) * 1000 });
  return r.access_token;
}

export function googleDrive(o: GoogleAuth & { refreshToken: string; folder: string; folderId?: string; onFolder: (id: string) => void }): Provider & {
  folderId(): Promise<string>;
} {
  const api = apiBase(o);
  const auth = async (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${await accessToken(o, o.refreshToken)}`, ...extra });
  let folderId = o.folderId;

  // The folder the backups go in: the one saved, else one this app made before with that name (a new machine
  // connecting to the same Drive finds the old backups), else a new one.
  const folder = async (): Promise<string> => {
    if (folderId) return folderId;
    const q = `name = '${o.folder.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const found = (await (
      await call(`${api}/drive/v3/files?${form({ q, fields: "files(id)", spaces: "drive" })}`, { method: "GET", headers: await auth() }, "Google Drive")
    ).json()) as {
      files: { id: string }[];
    };
    folderId =
      found.files[0]?.id ??
      (
        (await (
          await call(
            `${api}/drive/v3/files?fields=id`,
            { method: "POST", headers: await auth({ "Content-Type": "application/json" }), body: JSON.stringify({ name: o.folder, mimeType: FOLDER_MIME }) },
            "Google Drive",
          )
        ).json()) as { id: string }
      ).id;
    o.onFolder(folderId);
    return folderId;
  };

  const files = async () => {
    const q = `'${await folder()}' in parents and trashed = false`;
    const out: { id: string; name: string; size?: string; createdTime: string }[] = [];
    let pageToken = "";
    do {
      const url = `${api}/drive/v3/files?${form({ q, fields: "nextPageToken,files(id,name,size,createdTime)", pageSize: "1000", ...(pageToken ? { pageToken } : {}) })}`;
      const r = (await (await call(url, { method: "GET", headers: await auth() }, "Google Drive")).json()) as { files: typeof out; nextPageToken?: string };
      out.push(...r.files);
      pageToken = r.nextPageToken ?? "";
    } while (pageToken);
    return out;
  };
  const idOf = async (name: string) => {
    const f = (await files()).find((x) => x.name === name);
    if (!f) throw new CortexError("not_found", `No backup "${name}" in Google Drive.`, 404);
    return f.id;
  };

  return {
    folderId: folder,
    async put(name, body) {
      // Resumable upload: one request for the metadata, one for the bytes; fine for archives of any size.
      const start = await call(
        `${api}/upload/drive/v3/files?uploadType=resumable`,
        {
          method: "POST",
          headers: await auth({
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": "application/octet-stream",
            "X-Upload-Content-Length": String(body.length),
          }),
          body: JSON.stringify({ name, parents: [await folder()] }),
        },
        "Google Drive",
      );
      const location = start.headers.get("location");
      if (!location) throw new CortexError("backup_failed", "Google Drive gave no upload address.", 502);
      await call(location, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body }, "Google Drive");
    },
    async list() {
      return (await files()).map((f) => ({ name: f.name, bytes: Number(f.size ?? 0), at: f.createdTime }));
    },
    async get(name) {
      const res = await call(
        `${api}/drive/v3/files/${encodeURIComponent(await idOf(name))}?alt=media`,
        { method: "GET", headers: await auth() },
        "Google Drive",
      );
      return Buffer.from(await res.arrayBuffer());
    },
    async remove(name) {
      await call(`${api}/drive/v3/files/${encodeURIComponent(await idOf(name))}`, { method: "DELETE", headers: await auth() }, "Google Drive");
    },
  };
}
