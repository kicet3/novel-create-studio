import type { Platform, ServerModule } from "../../platform/index.js";
import type { AuditService } from "./index.js";
import { createAuditService } from "./application/audit-service.js";
import { mountAuditRoutes } from "./adapters/http/routes.js";

export interface AuditModuleDeps {
  platform: Platform;
}

export function createAuditModule(deps: AuditModuleDeps): ServerModule<AuditService> {
  const service = createAuditService(deps.platform);
  return {
    name: "audit",
    implemented: true,
    service,
    routes: (r) => mountAuditRoutes(r, service),
  };
}
