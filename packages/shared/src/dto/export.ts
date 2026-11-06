/**
 * DTOs of the `export` module (07 §3.8 FR-MAN-04a). `…` = /api/novels/:novelId
 *
 *   POST …/exports  createExportRequestSchema   → 201 exportJobDtoSchema
 *   GET  …/exports                              → { items: exportJobDtoSchema[] }
 *   GET  …/exports/:exportId                    → exportJobDtoSchema
 *   GET  …/exports/:exportId/download           → file (text/plain | text/markdown, Content-Disposition attachment)
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime } from "./common.js";

export const createExportRequestSchema = z
  .object({
    scopeKind: z.enum(ENUMS.export_scope_kind),
    /** episode id (epi_) or arc id (arc_); omitted for scopeKind=novel */
    targetId: z.string().optional(),
    format: z.enum(["txt", "markdown"]),
    versionSelection: z.enum(ENUMS.export_version_selection).default("default"),
  })
  .refine((v) => (v.scopeKind === "novel" ? !v.targetId : !!v.targetId), { message: "범위에 맞는 대상을 지정하세요.", path: ["targetId"] })
  .refine((v) => !v.targetId || (v.scopeKind === "episode" ? /^epi_/.test(v.targetId) : /^arc_/.test(v.targetId)), { message: "대상 ID 형식이 범위와 맞지 않습니다.", path: ["targetId"] });
export type CreateExportRequest = z.input<typeof createExportRequestSchema>;

export const exportItemDtoSchema = z.object({
  episode_id: z.string(),
  episode_no: z.number().int(),
  manuscript_version_id: z.string(),
  char_count_with_spaces: z.number().int(),
  char_count_without_spaces: z.number().int(),
});

export const exportJobDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  scopeKind: z.enum(ENUMS.export_scope_kind),
  scopeTargetId: z.string().nullable(),
  exportFormat: z.enum(ENUMS.export_format),
  versionSelection: z.enum(ENUMS.export_version_selection),
  items: z.array(exportItemDtoSchema),
  excluded: z.array(z.object({ episode_id: z.string(), episode_no: z.number().int(), reason: z.string() })),
  storageKey: z.string().nullable(),
  contentHash: z.string().nullable(),
  requestedByActorType: z.enum(ENUMS.actor_type),
  requestedByActorId: z.string(),
  completedAt: isoDateTime.nullable(),
  failureReason: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type ExportJobDto = z.infer<typeof exportJobDtoSchema>;

export const exportIdParamsSchema = z.object({ exportId: z.string().regex(/^exp_/) });
