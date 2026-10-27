import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import type { Cortex } from "../core/cortex.js";
import { loadTokens } from "../core/project.js";
import type { Actor } from "../core/types.js";
import { CortexError } from "../core/types.js";
import { CSRF_HEADER, SESSION_COOKIE, verifyLoginCode } from "./auth.js";
import { projectRoutes } from "./routes.js";
import { SESSION_TTL_MS, SessionStore } from "./sessions.js";
import { BackupRunner } from "../backup/core.js";
import { projectTarget, restoreProject } from "../backup/project.js";
import { registerBackupRoutes } from "../backup/routes.js";

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type Q = Record<string, string | undefined>;

// dist/api/server.js -> dist/web; when running from src/ with tsx, fall back to the last build.
function findWebDir(): string | null {
  for (const rel of ["../web", "../../dist/web"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(`${dir}/index.html`)) return dir;
  }
  return null;
}

export const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>Cortex</title><body style="font-family:system-ui;padding:2rem;max-width:40rem">
<h1>${title}</h1><p>${body}</p>`;

// Rule violations keep their code, message and hint, so an AI can fix itself; anything else is a plain error.
export function setErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof CortexError) {
      return reply
        .code(err.status)
        .send({ error: { code: err.code, message: err.message, hint: err.hint }, ...(req.cortex ? { _meta: req.cortex.meta() } : {}) });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: { code: status === 500 ? "internal" : "bad_request", message: (err as Error).message } });
  });
}

// Errors, the built board and client-side routes: shared by single-project mode and the hub.
// trustProxy: believe X-Forwarded-For/-Proto (only behind a reverse proxy you run; otherwise clients could lie).
// Sent with every response (security scan, task 01M3NR0PMHXV0X2PRCHNJAQWV8). The board is never framed (no
// clickjacking of approve or delete), scripts come from this origin only (the theme script is a file for
// that reason), styles may be inline (React style props), images may come from https (knowledge markdown).
// A route that sets its own policy keeps it: attachments are served with `sandbox`.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function baseServer(opts: { trustProxy?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: opts.trustProxy ?? false });
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("permissions-policy", "camera=(), geolocation=(), payment=(), usb=(), microphone=(self)"); // microphone: voice typing
    if (!reply.hasHeader("content-security-policy")) reply.header("content-security-policy", CONTENT_SECURITY_POLICY);
    if (req.protocol === "https") reply.header("strict-transport-security", "max-age=15552000");
    return payload;
  });
  app.decorateRequest("actor", null as unknown as Actor);
  app.decorateRequest("cortex", null as unknown as Cortex);
  app.register(cookie);

  setErrorHandler(app);

  const webDir = findWebDir();
  // wildcard: files are looked up per request, so a rebuilt board is served without restarting the server.
  if (webDir) app.register(fastifyStatic, { root: webDir, wildcard: true, index: ["index.html"] });

  app.setNotFoundHandler((req, reply) => {
    // Client routes (no file extension) get the board page; a missing file like /assets/x.js stays a 404,
    // otherwise the browser would try to run the HTML as a script and report a confusing MIME error.
    const isFile = /\.[a-z0-9]+$/i.test(req.url.split("?")[0]);
    if (req.method === "GET" && !req.url.startsWith("/api/") && !isFile) {
      return webDir
        ? reply.sendFile("index.html")
        : reply.type("text/html").send(page("Cortex API is running", "The board UI is not built. Run <code>npm run build</code> in the Cortex repository."));
    }
    return reply.code(404).send({ error: { code: "not_found", message: `No route ${req.method} ${req.url}` } });
  });
  return app;
}

// Single project, localhost only (`cortexboard start`): actor tokens from .cortex/.secrets.yaml, board login by signed link.
// backups: the runner `cortexboard start` puts on a timer; one is made when none is given.
export function buildServer(cortex: Cortex, opts: { backups?: BackupRunner } = {}): FastifyInstance {
  const app = baseServer();
  const sessions = new SessionStore(cortex.project.dir);
  const legacySwaps = new Map<string, string>(); // old token cookie -> the session it was swapped for
  const cookieOpts = { httpOnly: true, sameSite: "strict" as const, path: "/", maxAge: SESSION_TTL_MS / 1000 };

  app.addHook("onRequest", async (req, reply) => {
    // Block DNS-rebinding: a malicious page must not reach the local API through a foreign hostname.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!LOCAL_HOSTS.has(host)) {
      return reply.code(403).send({ error: { code: "forbidden_host", message: "Cortex only answers on localhost." } });
    }
    req.cortex = cortex;
    req.apiBase = `http://${req.headers.host}/api`; // the host was checked above: localhost only
    const path = req.url.split("?")[0];
    if (!path.startsWith("/api/") || path === "/api/health") return; // the board's static files and /login are public

    const auth = req.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const fromCookie = bearer ? undefined : req.cookies[SESSION_COOKIE];
    // Cookies ride along with cross-site requests; a custom header cannot be sent cross-site without CORS, which we never allow.
    if (fromCookie && !SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== "1") {
      return reply.code(403).send({ error: { code: "csrf", message: `Missing ${CSRF_HEADER} header.` } });
    }
    let actor = bearer ? cortex.actorByToken(bearer) : null;
    if (fromCookie) {
      const id = sessions.resolve(fromCookie);
      actor = id ? (cortex.project.config.actors.find((a) => a.id === id && a.kind === "human") ?? null) : null;
      if (!actor) {
        // Boards logged in before sessions existed carry the raw API token as their cookie. Accept it this
        // once and swap it for a session, so nobody is logged out by the upgrade. (Remove after 0.2.x.)
        const legacy = cortex.actorByToken(fromCookie);
        if (legacy?.kind === "human") {
          actor = legacy;
          // A board fires several requests at once with the same old cookie: hand them all the same session.
          const swapped = legacySwaps.get(fromCookie);
          const key = swapped && sessions.resolve(swapped) ? swapped : sessions.create(legacy.id);
          legacySwaps.set(fromCookie, key);
          reply.setCookie(SESSION_COOKIE, key, cookieOpts);
        }
      }
    }
    if (!actor) {
      return reply.code(401).send({
        error: {
          code: "unauthorized",
          message: "Send 'Authorization: Bearer <token>' (tokens are in .cortex/.secrets.yaml), or open the board with a link from `cortexboard login`.",
        },
      });
    }
    req.actor = actor;
    req.boardSession = !!fromCookie;
  });

  app.get("/login", async (req, reply) => {
    const tokens = loadTokens(cortex.project.dir);
    const actorId = verifyLoginCode((req.query as Q).code ?? "", tokens);
    const actor = actorId ? cortex.project.config.actors.find((a) => a.id === actorId) : undefined;
    if (!actor || actor.kind !== "human") {
      return reply
        .code(401)
        .type("text/html")
        .send(page("Login link expired or invalid", "Run <code>npx cortexboard login</code> in your project for a fresh link."));
    }
    // The cookie is a session key, never the API token: logging out (or `cortexboard logout`) really ends it.
    reply.setCookie(SESSION_COOKIE, sessions.create(actor.id), cookieOpts);
    return reply.redirect("/");
  });
  app.post("/api/logout", async (req, reply) => {
    sessions.revoke(req.cookies[SESSION_COOKIE]);
    return reply.clearCookie(SESSION_COOKIE, { path: "/" }).send({ ok: true });
  });
  app.get("/api/health", async () => ({ ok: true, mode: "project", project: cortex.project.config.project.name, ...cortex.meta() }));

  // Backups of this project's knowledge (src/backup/project.ts). Here, not in projectRoutes: hub projects are
  // backed up with the hub. A restore is done in place; the old files are kept in .cortex/.restore.
  const backups = opts.backups ?? new BackupRunner(() => projectTarget(cortex.project));
  registerBackupRoutes(app, "/api/backup", {
    guard: (req) => {
      if (req.actor.kind !== "human") throw new CortexError("forbidden", "Backups are for people on the board.", 403);
      return req.actor.id;
    },
    target: () => projectTarget(cortex.project),
    runner: backups,
    restore: async (_req, _by, name, o) => {
      const r = await restoreProject(cortex.project, { name }, o);
      cortex.reindex();
      return { restored: true, ...r };
    },
  });

  app.register(projectRoutes, { prefix: "/api" });
  return app;
}
