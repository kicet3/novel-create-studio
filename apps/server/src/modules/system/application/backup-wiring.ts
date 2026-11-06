/**
 * Attaches MA-6 backups to the system module without touching the rest of it:
 * replaces the `backups` placeholder service, registers the `backup_location` health check, mounts
 * `/api/system/backups` routes, adds the `system.backups` loop (scheduled backup + missed-backup
 * catch-up on start / wake-up) and a start hook that fails rows left `running` by a crash.
 */
import type { BackgroundLoop, ServerModule } from "../../../platform/index.js";
import type { SystemService } from "../index.js";
import type { SystemModuleDeps } from "../module.js";
import { mountBackupRoutes } from "../adapters/http/backup-routes.js";
import { BACKUP_LOOP_INTERVAL_MS, createBackupService, type BackupServiceImpl } from "./backup-service.js";

export function attachBackups<M extends ServerModule<SystemService>>(mod: M, deps: SystemModuleDeps): M {
  const backups: BackupServiceImpl = createBackupService({ platform: deps.platform, audit: deps.audit });
  (mod.service as { backups: SystemService["backups"] }).backups = backups;
  mod.service.registerHealthCheck(backups.healthCheck);
  const loop: BackgroundLoop = {
    name: "system.backups",
    intervalMs: BACKUP_LOOP_INTERVAL_MS,
    runOnStart: true,
    async tick() {
      await backups.runScheduledIfDue();
    },
  };
  const routes = mod.routes;
  const start = mod.start;
  return {
    ...mod,
    routes(r) {
      routes?.call(mod, r);
      mountBackupRoutes(r, backups, deps.platform.config.backup.interval_hours);
    },
    loops: [...(mod.loops ?? []), loop],
    async start() {
      await start?.call(mod);
      const stale = await backups.recoverStale();
      if (stale.length) deps.platform.log.warn({ ids: stale }, "marked interrupted backups as failed");
    },
  };
}
