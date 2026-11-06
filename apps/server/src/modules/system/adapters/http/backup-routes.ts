import { z } from "zod";
import { backupIdSchema, createBackupRequestSchema } from "@ncs/shared";
import type { ApiRouters } from "../../../../platform/index.js";
import { actorOf, valid, validate } from "../../../../http/kit.js";
import type { BackupServiceImpl } from "../../application/backup-service.js";

const idParams = z.object({ backupId: backupIdSchema });

/**
 * MA-6 HTTP: `GET /api/system/backups` → `{ items, schedule }`, `POST /api/system/backups` → 201 row
 * (synchronous manual backup; a failed run is returned with status `failed`),
 * `GET /api/system/backups/:backupId`, `POST /api/system/backups/:backupId/verify` → `{ ok, message }`.
 * Restore is CLI-only (`ncs restore`, server stopped).
 */
export function mountBackupRoutes({ api }: ApiRouters, svc: BackupServiceImpl, intervalHours: number): void {
  api.get("/system/backups", async (_req, res) => {
    const d = await svc.scheduleDecision();
    res.json({
      items: await svc.listBackups(),
      schedule: { due: d.due, reason: d.reason, nextAt: d.due ? null : d.nextAt, intervalHours, backupsDir: svc.backupsDir },
    });
  });
  api.post("/system/backups", validate({ body: createBackupRequestSchema }), async (_req, res) => {
    const { body } = valid<{ body: z.output<typeof createBackupRequestSchema> }>(res);
    const row = await svc.runBackup("manual", { actor: actorOf(res), engine: body.engine });
    res.status(201).json(row);
  });
  api.get("/system/backups/:backupId", validate({ params: idParams }), async (_req, res) => {
    const { params } = valid<{ params: z.output<typeof idParams> }>(res);
    res.json(await svc.getBackup(params.backupId));
  });
  api.post("/system/backups/:backupId/verify", validate({ params: idParams }), async (_req, res) => {
    const { params } = valid<{ params: z.output<typeof idParams> }>(res);
    res.json(await svc.verifyBackup(params.backupId));
  });
}
