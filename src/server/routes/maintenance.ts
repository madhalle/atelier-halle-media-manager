// Recovery controls: how the server is running, and backups. Restoring is
// deliberately not offered here: it needs the server stopped (see README).
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DomainError } from "../../domain/errors.ts";
import { backupOwnBytes, BackupError, createBackup, listBackups, verifyBackupById } from "../../storage/backup.ts";
import type { DataPaths } from "../../storage/data-dir.ts";
import type { Db } from "../../storage/db.ts";

const IdParams = z.object({ id: z.string().max(64) });

export interface MaintenanceDeps {
  db: Db;
  paths: DataPaths;
  appVersion: string;
  env: string;
  runMode: "background" | "terminal";
  livePublishing: boolean;
  keychainStatus: () => { ok: boolean; reason: string | null };
}

export function registerMaintenanceRoutes(api: FastifyInstance, d: MaintenanceDeps): void {
  const views = async () =>
    Promise.all(
      (await listBackups(d.paths)).map(async (b) => ({
        id: b.id,
        reason: b.reason,
        createdAt: b.createdAt,
        photoFiles: b.mediaFiles.length,
        extraBytes: await backupOwnBytes(join(d.paths.backups, b.id)),
      })),
    );

  api.get("/maintenance", async () => ({
    service: { mode: d.runMode, env: d.env },
    livePublishing: d.livePublishing,
    keychain: d.keychainStatus(),
    backups: await views(),
  }));

  api.post("/backups", async (_req, reply) => {
    const m = await createBackup(d.db, d.paths, { reason: "manual", appVersion: d.appVersion });
    return reply.code(201).send({ backup: { id: m.id, createdAt: m.createdAt, photoFiles: m.mediaFiles.length } });
  });

  api.post("/backups/:id/verify", async (req) => {
    const { id } = IdParams.parse(req.params);
    try {
      const m = await verifyBackupById(d.paths, id);
      return { ok: true, photoFiles: m.mediaFiles.length };
    } catch (err) {
      if (err instanceof BackupError) throw new DomainError("invalid_state", err.message);
      throw err;
    }
  });
}
