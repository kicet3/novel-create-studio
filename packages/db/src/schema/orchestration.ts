// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: orchestration (design/08 §2.3).
import { bigint, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { ENUMS } from "@ncs/shared/enums";

/** tasks */
export const tasks = pgTable(
  "tasks",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    displayNo: integer("display_no").notNull(),
    kind: text("kind", { enum: ENUMS.task_kind }).notNull(),
    agentRole: text("agent_role", { enum: ENUMS.agent_role }).notNull(),
    targetType: text("target_type", { enum: ENUMS.target_type }).notNull(),
    targetId: text("target_id").notNull(),
    goalId: text("goal_id"),
    arcId: text("arc_id"),
    episodeId: text("episode_id"),
    parentTaskId: text("parent_task_id"),
    status: text("status", { enum: ENUMS.task_status }).notNull().default("pending"),
    priority: integer("priority").notNull().default(0),
    blockReason: text("block_reason", { enum: ENUMS.task_block_reason }),
    blockedRefType: text("blocked_ref_type", { enum: ENUMS.ref_type }),
    blockedRefId: text("blocked_ref_id"),
    pausedAt: timestamp("paused_at", { withTimezone: true, mode: "date" }),
    leaseRunId: text("lease_run_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    notBeforeAt: timestamp("not_before_at", { withTimezone: true, mode: "date" }),
    input: jsonb("input").$type<unknown>().notNull().default({}),
    outputRefs: jsonb("output_refs").$type<unknown>(),
    supersededByTaskId: text("superseded_by_task_id"),
    createdByActorType: text("created_by_actor_type", { enum: ENUMS.actor_type }).notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type TasksRow = typeof tasks.$inferSelect;
export type TasksInsert = typeof tasks.$inferInsert;

/** task_dependencies */
export const taskDependencies = pgTable(
  "task_dependencies",
  {
    novelId: text("novel_id").notNull(),
    taskId: text("task_id").notNull(),
    dependsOnTaskId: text("depends_on_task_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.novelId, t.taskId, t.dependsOnTaskId] })],
);
export type TaskDependenciesRow = typeof taskDependencies.$inferSelect;
export type TaskDependenciesInsert = typeof taskDependencies.$inferInsert;

/** wake_requests */
export const wakeRequests = pgTable(
  "wake_requests",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    taskId: text("task_id"),
    reason: text("reason", { enum: ENUMS.wake_reason }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status", { enum: ENUMS.wake_status }).notNull().default("pending"),
    notBeforeAt: timestamp("not_before_at", { withTimezone: true, mode: "date" }),
    coalescedIntoId: text("coalesced_into_id"),
    claimedRunId: text("claimed_run_id"),
    sourceRefType: text("source_ref_type", { enum: ENUMS.ref_type }),
    sourceRefId: text("source_ref_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type WakeRequestsRow = typeof wakeRequests.$inferSelect;
export type WakeRequestsInsert = typeof wakeRequests.$inferInsert;

/** runs */
export const runs = pgTable(
  "runs",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    taskId: text("task_id").notNull(),
    wakeRequestId: text("wake_request_id").notNull(),
    agentRole: text("agent_role", { enum: ENUMS.agent_role }).notNull(),
    status: text("status", { enum: ENUMS.run_status }).notNull().default("queued"),
    stopReason: text("stop_reason", { enum: ENUMS.run_stop_reason }),
    errorFamily: text("error_family", { enum: ENUMS.error_family }),
    errorMessage: text("error_message"),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    modelsUsed: jsonb("models_used").$type<unknown>().notNull().default([]),
    contextSnapshotId: text("context_snapshot_id"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    rerunOfRunId: text("rerun_of_run_id"),
    safePointSeq: integer("safe_point_seq").notNull().default(0),
    logStorageKey: text("log_storage_key"),
    outputSummary: jsonb("output_summary").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type RunsRow = typeof runs.$inferSelect;
export type RunsInsert = typeof runs.$inferInsert;
