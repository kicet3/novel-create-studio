import type { DbConnection } from "@ncs/db";
import type { Platform, ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { SystemService } from "./index.js";
import { createSystemService, HEALTH_LOOP_INTERVAL_MS } from "./application/system-service.js";
import { mountSystemRoutes } from "./adapters/http/routes.js";
import { attachBackups } from "./application/backup-wiring.js"; // MA-6 (ops/CLI agent)

export interface SystemModuleDeps {
  platform: Platform;
  audit: AuditService;
  databaseMode: "embedded" | "external";
  /** resolved DB connection (provider / schema / TLS); absent in PGlite tests */
  database?: DbConnection;
  /** wired by the composition root after `novel` exists (novel-scoped checks) */
  listNovelIds?: () => Promise<string[]>;
}

export function createSystemModule(deps: SystemModuleDeps): ServerModule<SystemService> & {
  service: SystemService & { setNovelLister(fn: () => Promise<string[]>): void };
} {
  const service = createSystemService(deps);
  return attachBackups({
    name: "system",
    implemented: true,
    service,
    routes: (r) => mountSystemRoutes(r, service, deps.audit, deps.platform.uow),
    loops: [
      {
        name: "system.health_checks",
        intervalMs: HEALTH_LOOP_INTERVAL_MS,
        async tick() {
          await service.runHealthChecks();
        },
      },
    ],
  }, deps);
}
