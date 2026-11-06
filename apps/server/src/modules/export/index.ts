/**
 * export — public API (design/07 §3.8 FR-MAN-04a; 08 §2.3 export_jobs).
 * Owns: export_jobs. MVP-α formats: `txt`, `markdown` (docx/epub/json/novel_package are v1 — enum kept).
 * Files are written through platform StorageProvider under `novels/<novelId>/exports/<exportId>.<ext>`.
 */
import type { ExportFormat, ExportScopeKind, ExportVersionSelection } from "@ncs/shared";
import type { ExportJobsRow } from "@ncs/db/schema";
import type { ActorRef, NovelScope } from "../../platform/index.js";

export type ExportJob = ExportJobsRow;

export interface CreateExportInput {
  scopeKind: ExportScopeKind;
  /** episode id / arc id; omitted for scopeKind=novel */
  targetId?: string;
  format: Extract<ExportFormat, "txt" | "markdown">;
  versionSelection: ExportVersionSelection;
}

export interface ExportService {
  /** synchronous for MVP-α sizes; records export.created */
  createExport(scope: NovelScope, input: CreateExportInput, actor: ActorRef): Promise<ExportJob>;
  listExports(scope: NovelScope): Promise<ExportJob[]>;
  getExport(scope: NovelScope, exportId: string): Promise<ExportJob>;
  /** absolute file path + download name for streaming */
  openDownload(scope: NovelScope, exportId: string): Promise<{ path: string; fileName: string; contentType: string }>;
}

export type { ExportModuleDeps } from "./module.js";
export { createExportModule } from "./module.js";
