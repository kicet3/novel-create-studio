/** Factory of `export` (07 §3.8, 08 §2.3). */
import type { Platform, ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { ManuscriptService } from "../manuscript/index.js";
import type { NovelService } from "../novel/index.js";
import type { ExportService } from "./index.js";
import { createExportService } from "./application/export-service.js";
import { mountExportRoutes } from "./adapters/http/routes.js";

export interface ExportModuleDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  manuscript: ManuscriptService;
}

export function createExportModule(deps: ExportModuleDeps): ServerModule<ExportService> {
  const service = createExportService(deps);
  return { name: "export", implemented: true, service, routes: (r) => mountExportRoutes(r, service) };
}
