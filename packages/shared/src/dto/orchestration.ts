/**
 * DTOs of the `orchestration` module (04 §3–§8, 03 §3.3).
 *
 *   GET  …/tasks?status&kind&agentRole&arcId&episodeId&includeCancelled  → taskListSchema
 *   GET  …/tasks/:taskId                                                 → taskDtoSchema
 *   GET  …/tasks/:taskId/runs                                            → runListSchema
 *   POST …/tasks/:taskId/retry|cancel|pause|resume                       → taskDtoSchema
 *   POST …/tasks/:taskId/reassign  taskReassignRequestSchema             → taskReassignResponseSchema
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime } from "./common.js";

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((s) => s.split(",").filter(Boolean))
    .pipe(z.array(z.enum(values)));

export const taskListQuerySchema = z.object({
  status: csv(ENUMS.task_status).optional(),
  kind: csv(ENUMS.task_kind).optional(),
  agentRole: z.enum(ENUMS.agent_role).optional(),
  arcId: z.string().optional(),
  episodeId: z.string().optional(),
  includeCancelled: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

export const taskParamsSchema = z.object({ taskId: z.string().regex(/^tsk_/) });

export const runSummaryDtoSchema = z.object({
  id: z.string(),
  status: z.enum(ENUMS.run_status),
  stopReason: z.enum(ENUMS.run_stop_reason).nullable(),
  errorFamily: z.enum(ENUMS.error_family).nullable(),
  errorMessage: z.string().nullable(),
  startedAt: isoDateTime.nullable(),
  heartbeatAt: isoDateTime.nullable(),
  finishedAt: isoDateTime.nullable(),
  costMicros: z.number().int(),
});
export type RunSummaryDto = z.infer<typeof runSummaryDtoSchema>;

export const taskDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  displayNo: z.number().int(),
  kind: z.enum(ENUMS.task_kind),
  agentRole: z.enum(ENUMS.agent_role),
  targetType: z.enum(ENUMS.target_type),
  targetId: z.string(),
  goalId: z.string().nullable(),
  arcId: z.string().nullable(),
  episodeId: z.string().nullable(),
  parentTaskId: z.string().nullable(),
  status: z.enum(ENUMS.task_status),
  priority: z.number().int(),
  blockReason: z.enum(ENUMS.task_block_reason).nullable(),
  blockedRefType: z.enum(ENUMS.ref_type).nullable(),
  blockedRefId: z.string().nullable(),
  pausedAt: isoDateTime.nullable(),
  leaseRunId: z.string().nullable(),
  leaseExpiresAt: isoDateTime.nullable(),
  attemptCount: z.number().int(),
  maxAttempts: z.number().int(),
  notBeforeAt: isoDateTime.nullable(),
  input: z.unknown(),
  outputRefs: z.unknown().nullable(),
  supersededByTaskId: z.string().nullable(),
  createdByActorType: z.enum(ENUMS.actor_type),
  createdByActorId: z.string(),
  startedAt: isoDateTime.nullable(),
  completedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  latestRun: runSummaryDtoSchema.nullable(),
});
export type TaskDto = z.infer<typeof taskDtoSchema>;
export const taskListSchema = z.object({ items: z.array(taskDtoSchema) });

export const runDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  taskId: z.string(),
  wakeRequestId: z.string(),
  agentRole: z.enum(ENUMS.agent_role),
  status: z.enum(ENUMS.run_status),
  stopReason: z.enum(ENUMS.run_stop_reason).nullable(),
  errorFamily: z.enum(ENUMS.error_family).nullable(),
  errorMessage: z.string().nullable(),
  promptTemplateVersion: z.string(),
  modelsUsed: z.unknown(),
  contextSnapshotId: z.string().nullable(),
  startedAt: isoDateTime.nullable(),
  heartbeatAt: isoDateTime.nullable(),
  finishedAt: isoDateTime.nullable(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costMicros: z.number().int(),
  rerunOfRunId: z.string().nullable(),
  safePointSeq: z.number().int(),
  logStorageKey: z.string().nullable(),
  outputSummary: z.unknown().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type RunDto = z.infer<typeof runDtoSchema>;
export const runListSchema = z.object({ items: z.array(runDtoSchema) });

export const taskReassignRequestSchema = z.object({ toRole: z.enum(ENUMS.agent_role) }).strict();
export type TaskReassignRequest = z.infer<typeof taskReassignRequestSchema>;

/** `result` mirrors OrchestrationService.reassignTask; 409 `reassign_rejected` when rejected */
export const taskReassignResponseSchema = z.object({
  result: z.union([z.object({ applied: z.enum(["now", "after_safe_point"]) }), z.object({ rejected: z.enum(["role_not_allowed", "terminal"]) })]),
  task: taskDtoSchema,
});
export type TaskReassignResponse = z.infer<typeof taskReassignResponseSchema>;
