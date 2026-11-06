/**
 * DTOs of the `continuity` module — owned by the continuity module agent (see CONVENTIONS.md).
 * Request/response zod schemas + inferred types; never import server code.
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime, queryInt } from "./common.js";

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)));

// ── responses ───────────────────────────────────────────────────────────
export const continuityIssueEvidenceDtoSchema = z.object({
  refType: z.enum(ENUMS.ref_type),
  refId: z.string(),
  factVersionId: z.string().nullable(),
  schemaRuleKey: z.string().nullable(),
  note: z.string().nullable(),
});
export type ContinuityIssueEvidenceDto = z.infer<typeof continuityIssueEvidenceDtoSchema>;

export const continuityIssueDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  displayNo: z.number().int(),
  /** "CI-<n>" */
  displayLabel: z.string(),
  episodeId: z.string(),
  manuscriptVersionId: z.string(),
  sceneId: z.string().nullable(),
  charStart: z.number().int().nullable(),
  charEnd: z.number().int().nullable(),
  kind: z.enum(ENUMS.continuity_issue_kind),
  severity: z.enum(ENUMS.issue_severity),
  status: z.enum(ENUMS.continuity_issue_status),
  detector: z.enum(ENUMS.issue_detector),
  detectedByRunId: z.string().nullable(),
  message: z.string(),
  proposedFix: z.string().nullable(),
  fixScope: z.enum(ENUMS.issue_fix_scope).nullable(),
  autoFixDiff: z.unknown().nullable(),
  resolutionKind: z.enum(ENUMS.issue_resolution_kind).nullable(),
  resolvedByActorType: z.enum(ENUMS.actor_type).nullable(),
  resolvedByActorId: z.string().nullable(),
  resolvedAt: isoDateTime.nullable(),
  questionId: z.string().nullable(),
  approvalId: z.string().nullable(),
  dedupeKey: z.string(),
  previousIssueId: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type ContinuityIssueDto = z.infer<typeof continuityIssueDtoSchema>;

export const continuityIssueDetailDtoSchema = continuityIssueDtoSchema.extend({
  evidence: z.array(continuityIssueEvidenceDtoSchema),
  /** transitions the current user may request from this state (UI buttons) */
  allowedTransitions: z.array(z.enum(ENUMS.continuity_issue_status)),
});
export type ContinuityIssueDetailDto = z.infer<typeof continuityIssueDetailDtoSchema>;

export const continuityIssueListDtoSchema = z.object({ items: z.array(continuityIssueDtoSchema) });
export type ContinuityIssueListDto = z.infer<typeof continuityIssueListDtoSchema>;

// ── requests ────────────────────────────────────────────────────────────
/** GET …/continuity-issues?episodeId&status=open,fixing&severity=high&manuscriptVersionId&limit */
export const listContinuityIssuesQuerySchema = z.object({
  episodeId: z.string().optional(),
  manuscriptVersionId: z.string().optional(),
  status: csv(ENUMS.continuity_issue_status).optional(),
  severity: csv(ENUMS.issue_severity).optional(),
  kind: csv(ENUMS.continuity_issue_kind).optional(),
  limit: queryInt.min(1).max(500).optional(),
});
export type ListContinuityIssuesQuery = z.infer<typeof listContinuityIssuesQuerySchema>;

/** POST …/continuity-issues/:issueId/transition — user-driven transitions (C5 human_edited/canon_updated/retconned, C6 waive, C7 false positive). */
export const transitionContinuityIssueRequestSchema = z.object({
  to: z.enum(["resolved", "waived", "false_positive"]),
  resolutionKind: z.enum(["human_edited", "canon_updated", "retconned"]).optional(),
  /** required for C6/C7 (사유) */
  note: z.string().max(2000).optional(),
  /** INV-CI-04: waiving a published_canon_conflict requires an approved retcon approval */
  approvalId: z.string().optional(),
});
export type TransitionContinuityIssueRequest = z.infer<typeof transitionContinuityIssueRequestSchema>;

export const continuityOpenCountsDtoSchema = z.object({ high: z.number().int(), medium: z.number().int(), low: z.number().int() });
export type ContinuityOpenCountsDto = z.infer<typeof continuityOpenCountsDtoSchema>;
