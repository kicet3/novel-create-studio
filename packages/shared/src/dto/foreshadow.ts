/**
 * DTOs of the `foreshadow` module — owned by the foreshadow module agent (see CONVENTIONS.md).
 * Request/response zod schemas + inferred types; never import server code.
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime, queryBool, queryInt } from "./common.js";

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)));

// ── responses ───────────────────────────────────────────────────────────
export const setupBeatDtoSchema = z.object({
  id: z.string(),
  setupId: z.string(),
  kind: z.enum(ENUMS.setup_beat_kind),
  status: z.enum(ENUMS.setup_beat_status),
  canonStatus: z.enum(ENUMS.canon_status),
  plannedEpisodeNo: z.number().int().nullable(),
  plannedNote: z.string().nullable(),
  episodeId: z.string().nullable(),
  sceneId: z.string().nullable(),
  manuscriptVersionId: z.string().nullable(),
  charStart: z.number().int().nullable(),
  charEnd: z.number().int().nullable(),
  detectedByRunId: z.string().nullable(),
  confirmedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type SetupBeatDto = z.infer<typeof setupBeatDtoSchema>;

export const setupDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  displayNo: z.number().int(),
  /** "S-01" */
  displayLabel: z.string(),
  title: z.string(),
  description: z.string(),
  importance: z.enum(ENUMS.setup_importance),
  narrativeStatus: z.enum(ENUMS.setup_narrative_status),
  canonStatus: z.enum(ENUMS.canon_status),
  plannedArcId: z.string().nullable(),
  dueKind: z.enum(ENUMS.setup_due_kind),
  dueEpisodeNo: z.number().int().nullable(),
  dueArcId: z.string().nullable(),
  /** resolved due episode (arc due → last planned episode of the arc) */
  effectiveDueEpisodeNo: z.number().int().nullable(),
  abandonedReason: z.string().nullable(),
  abandonApprovalId: z.string().nullable(),
  paidOffBeatId: z.string().nullable(),
  createdByActorType: z.enum(ENUMS.actor_type),
  createdByActorId: z.string(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  beats: z.array(setupBeatDtoSchema),
  /** due − current approved episode (negative = overdue); null when no episode approved yet */
  remainingEpisodes: z.number().int().nullable(),
});
export type SetupDto = z.infer<typeof setupDtoSchema>;

export const setupDueChangeDtoSchema = z.object({
  id: z.string(),
  fromDueKind: z.enum(ENUMS.setup_due_kind).nullable(),
  fromDueEpisodeNo: z.number().int().nullable(),
  fromDueArcId: z.string().nullable(),
  toDueKind: z.enum(ENUMS.setup_due_kind),
  toDueEpisodeNo: z.number().int().nullable(),
  toDueArcId: z.string().nullable(),
  reason: z.string(),
  questionId: z.string().nullable(),
  approvalId: z.string().nullable(),
  changedByActorType: z.enum(ENUMS.actor_type),
  changedByActorId: z.string(),
  createdAt: isoDateTime,
});
export type SetupDueChangeDto = z.infer<typeof setupDueChangeDtoSchema>;

export const setupDetailDtoSchema = setupDtoSchema.extend({
  dueChanges: z.array(setupDueChangeDtoSchema),
  links: z.array(z.object({ type: z.enum(ENUMS.ref_type), id: z.string(), pinnedFactVersionId: z.string().nullable().optional() })),
});
export type SetupDetailDto = z.infer<typeof setupDetailDtoSchema>;

export const setupListDtoSchema = z.object({ items: z.array(setupDtoSchema) });
export type SetupListDto = z.infer<typeof setupListDtoSchema>;

/** evidence scene link of a report row (FR-FOR-08) */
export const setupEvidenceDtoSchema = z.object({
  beatId: z.string(),
  kind: z.enum(ENUMS.setup_beat_kind),
  episodeId: z.string().nullable(),
  sceneId: z.string().nullable(),
  charStart: z.number().int().nullable(),
  charEnd: z.number().int().nullable(),
});
export type SetupEvidenceDto = z.infer<typeof setupEvidenceDtoSchema>;

const reportRowBase = z.object({
  setupId: z.string(),
  displayNo: z.number().int(),
  displayLabel: z.string(),
  title: z.string(),
  importance: z.enum(ENUMS.setup_importance),
  narrativeStatus: z.enum(ENUMS.setup_narrative_status),
  dueEpisodeNo: z.number().int().nullable(),
  evidence: z.array(setupEvidenceDtoSchema),
});

const metricSchema = z.object({ value: z.number().nullable(), numerator: z.number().int(), denominator: z.number().int() });

/** 06 §8.1 SetupReport (R1–R5) */
export const setupReportDtoSchema = z.object({
  asOfEpisodeNo: z.number().int().nullable(),
  r1Unresolved: z.array(reportRowBase.extend({ remainingEpisodes: z.number().int().nullable(), reinforceCount: z.number().int() })),
  r2Overdue: z.array(
    reportRowBase.extend({
      overdueEpisodes: z.number().int(),
      openQuestionId: z.string().nullable(),
      questionStatus: z.string().nullable(),
    }),
  ),
  r3PaidOffWithoutReinforce: z.array(reportRowBase),
  r4ContradictionCandidates: z.array(
    z.object({
      setupId: z.string().nullable(),
      issueId: z.string(),
      issueDisplayNo: z.number().int().nullable(),
      severity: z.enum(ENUMS.issue_severity),
      message: z.string(),
    }),
  ),
  r5Metrics: z.object({ payoffRate: metricSchema, abandonRate: metricSchema, overdueHandledRate: metricSchema }),
});
export type SetupReportDto = z.infer<typeof setupReportDtoSchema>;

// ── requests ────────────────────────────────────────────────────────────
/** GET …/setups?narrative=planted,reinforced&canon=approved&importance=high&overdue=true&dueWithin=5 */
export const listSetupsQuerySchema = z.object({
  narrative: csv(ENUMS.setup_narrative_status).optional(),
  canon: csv(ENUMS.canon_status).optional(),
  importance: csv(ENUMS.setup_importance).optional(),
  overdue: queryBool.optional(),
  dueWithin: queryInt.min(0).max(1000).optional(),
});
export type ListSetupsQuery = z.infer<typeof listSetupsQuerySchema>;

/** GET …/setups/:setupNo — display number (1, "01", "S-01") or stp_ id */
export const setupParamsSchema = z.object({ setupNo: z.string().min(1) });

/** GET …/setups/report?asOf=<episodeNo> */
export const setupReportQuerySchema = z.object({ asOf: queryInt.min(0).optional() });
export type SetupReportQuery = z.infer<typeof setupReportQuerySchema>;
