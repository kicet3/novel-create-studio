import type { Platform, ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { NovelService } from "./index.js";
import { createNovelService } from "./application/novel-service.js";
import { mountNovelRoutes } from "./adapters/http/routes.js";

export interface NovelModuleDeps {
  platform: Platform;
  audit: AuditService;
}

export function createNovelModule(deps: NovelModuleDeps): ServerModule<NovelService> {
  const service = createNovelService(deps);
  return {
    name: "novel",
    implemented: true,
    service,
    routes: (r) => mountNovelRoutes(r, service, deps.platform.uow),
    async start() {
      await service.ensureOwnerUser(); // INV-USR-01 (local_trusted single owner)
    },
  };
}
