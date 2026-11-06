/**
 * DTOs of the `budget` module (03 §7, 04 §8). Money is integer micro-USD (`*Micros`), times are ISO strings.
 *
 *   GET   …/budget                                  → budgetOverviewSchema
 *   PATCH …/budget/policies/:category  budgetPolicyPatchSchema → budgetPolicyDtoSchema
 *   POST  …/budget/policies/:category/resume        → budgetPolicyDtoSchema
 *   GET   …/budget/cost-events?runId&since&limit    → { items: costEventDto[] }
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime } from "./common.js";

const micros = z.number().int();

export const budgetPolicyDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  category: z.enum(ENUMS.budget_category),
  budgetWindow: z.enum(ENUMS.budget_window),
  hardLimitMicros: micros,
  softWarnRatio: z.number(),
  hardStopEnabled: z.boolean(),
  unpricedUsagePolicy: z.enum(ENUMS.unpriced_usage_policy),
  status: z.enum(ENUMS.budget_status),
  windowStartedAt: isoDateTime,
  resumeApprovalId: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type BudgetPolicyDto = z.infer<typeof budgetPolicyDtoSchema>;

export const budgetStatusViewSchema = z.object({
  policyId: z.string(),
  category: z.enum(ENUMS.budget_category),
  window: z.enum(ENUMS.budget_window),
  windowStartedAt: isoDateTime,
  status: z.enum(ENUMS.budget_status),
  hardLimitMicros: micros,
  softWarnRatio: z.number(),
  spentMicros: micros,
  reservedMicros: micros,
  remainingMicros: micros,
  hardStopEnabled: z.boolean(),
  unpricedUsagePolicy: z.enum(ENUMS.unpriced_usage_policy),
  resumeApprovalId: z.string().nullable(),
});
export type BudgetStatusViewDto = z.infer<typeof budgetStatusViewSchema>;

/** GET …/budget */
export const budgetOverviewSchema = z.object({
  items: z.array(budgetStatusViewSchema),
  /** any policy hard_stopped (novel paused with pause_reason=budget_hard_limit) */
  hardStopped: z.boolean(),
  activeReservations: z.number().int(),
});
export type BudgetOverviewDto = z.infer<typeof budgetOverviewSchema>;

export const budgetCategoryParamsSchema = z.object({ category: z.enum(ENUMS.budget_category) });

export const budgetPolicyPatchSchema = z
  .object({
    hardLimitMicros: micros.min(0).optional(),
    softWarnRatio: z.number().min(0).max(1).optional(),
    hardStopEnabled: z.boolean().optional(),
    unpricedUsagePolicy: z.enum(ENUMS.unpriced_usage_policy).optional(),
    budgetWindow: z.enum(ENUMS.budget_window).optional(),
  })
  .strict();
export type BudgetPolicyPatchDto = z.infer<typeof budgetPolicyPatchSchema>;

export const costEventsQuerySchema = z.object({
  runId: z.string().regex(/^run_/).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
export type CostEventsQuery = z.infer<typeof costEventsQuerySchema>;

export const costEventDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  idempotencyKey: z.string(),
  providerCallId: z.string().nullable(),
  adjustsCostEventId: z.string().nullable(),
  runId: z.string().nullable(),
  taskId: z.string().nullable(),
  agentRole: z.enum(ENUMS.agent_role).nullable(),
  arcId: z.string().nullable(),
  episodeId: z.string().nullable(),
  sceneId: z.string().nullable(),
  shotId: z.string().nullable(),
  category: z.enum(ENUMS.cost_category),
  provider: z.string(),
  modelId: z.string(),
  providerProfileId: z.string(),
  providerProfileVersion: z.number().int(),
  costBasis: z.enum(ENUMS.cost_basis),
  amountMicros: micros,
  reservedMicros: micros,
  overrunMicros: micros,
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  cachedTokens: z.number().int().nullable(),
  units: z.unknown().nullable(),
  isRerun: z.boolean(),
  occurredAt: isoDateTime,
  createdAt: isoDateTime,
});
export type CostEventDto = z.infer<typeof costEventDtoSchema>;
export const costEventListSchema = z.object({ items: z.array(costEventDtoSchema) });
