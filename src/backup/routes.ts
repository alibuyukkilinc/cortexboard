import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BackupInput, BackupRunner, BackupTarget } from "./core.js";
import { backupStatus, checkName, configureBackup, disconnectGoogle, fetchBackup, googleConnectPoll, googleConnectStart, listBackups } from "./core.js";

// The backup API, the same for a hub (/api/admin/backup, organization admins) and a single project
// (/api/backup, people on the local board). Keys go in and never come back out; the archive passphrase is
// returned once, when the first save makes it.

export interface BackupRouteOptions {
  guard(req: FastifyRequest): string; // who is asking; throws when they may not
  target(): BackupTarget;
  runner: BackupRunner;
  restore(req: FastifyRequest, by: string, name: string, opts: { passphrase?: string; adopt?: boolean }): Promise<object>;
  extra?(): object;
  cancelRestore?(): void;
}

type Q = Record<string, string | undefined>;

export function registerBackupRoutes(app: FastifyInstance, base: string, o: BackupRouteOptions): void {
  app.get(base, async (req) => {
    o.guard(req);
    return { ...backupStatus(o.target()), last: o.runner.last, running: o.runner.isRunning, ...(o.extra?.() ?? {}) };
  });
  app.put(base, async (req) => {
    o.guard(req);
    return configureBackup(o.target(), (req.body ?? {}) as BackupInput);
  });
  app.post(`${base}/run`, async (req) => {
    o.guard(req);
    return { result: await o.runner.now() };
  });
  app.get(`${base}/list`, async (req) => {
    o.guard(req);
    return { backups: await listBackups(o.target()) };
  });
  // The sealed archive as stored: opening it still needs the passphrase.
  app.get(`${base}/download/:name`, async (req, reply) => {
    o.guard(req);
    const name = checkName(o.target(), (req.params as Q).name ?? "");
    const body = await fetchBackup(o.target(), name);
    return reply.header("content-type", "application/octet-stream").header("content-disposition", `attachment; filename="${name}"`).send(body);
  });
  app.post(`${base}/restore`, async (req) => {
    const by = o.guard(req);
    const b = (req.body ?? {}) as { name?: string; passphrase?: string; adopt?: boolean };
    return o.restore(req, by, checkName(o.target(), b.name ?? ""), { passphrase: b.passphrase, adopt: !!b.adopt });
  });
  if (o.cancelRestore) {
    app.delete(`${base}/restore`, async (req) => {
      o.guard(req);
      o.cancelRestore!();
      return { ok: true };
    });
  }
  app.post(`${base}/google/start`, async (req) => {
    o.guard(req);
    return googleConnectStart(o.target());
  });
  app.post(`${base}/google/poll`, async (req) => {
    o.guard(req);
    return googleConnectPoll(o.target());
  });
  app.delete(`${base}/google`, async (req) => {
    o.guard(req);
    disconnectGoogle(o.target());
    return { ok: true };
  });
}
