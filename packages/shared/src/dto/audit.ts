/** DTOs of the `audit` module (activity timeline, 08 §9.7). */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime, queryInt } from "./common.js";

export const activityDtoSchema = z.object({
  seq: z.number().int(),
  id: z.string(),
  novelId: z.string().nullable(),
  occurredAt: isoDateTime,
  actorType: z.enum(ENUMS.actor_type),
  actorId: z.string(),
  runId: z.string().nullable(),
  questionId: z.string().nullable(),
  approvalId: z.string().nullable(),
  answerId: z.string().nullable(),
  action: z.string(),
  targetType: z.enum(ENUMS.ref_type),
  targetId: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  reason: z.string().nullable(),
  details: z.unknown().nullable(),
});
export type ActivityDto = z.infer<typeof activityDtoSchema>;

/** GET /api/novels/:novelId/activity (and /api/activity for install-level events). Sorted by seq DESC. */
export const activityQuerySchema = z.object({
  actorType: z.enum(ENUMS.actor_type).optional(),
  actorId: z.string().optional(),
  targetType: z.enum(ENUMS.ref_type).optional(),
  /** one id or comma-separated ids ("특정 화의 전체 이력") */
  targetId: z.string().optional(),
  /** e.g. "episode." or "fact." */
  actionPrefix: z.string().regex(/^[a-z_]+\.?[a-z_]*$/).optional(),
  /** only events newer than this seq (polling for updates) */
  afterSeq: queryInt.min(0).optional(),
  /** paging cursor: events older than this seq (= previous page's nextCursor) */
  beforeSeq: queryInt.min(1).optional(),
  limit: queryInt.min(1).max(200).default(50),
});
export type ActivityQuery = z.input<typeof activityQuerySchema>;

export const activityPageSchema = z.object({ items: z.array(activityDtoSchema), nextCursor: z.string().nullable(), latestSeq: z.number().int() });
export type ActivityPageDto = z.infer<typeof activityPageSchema>;
