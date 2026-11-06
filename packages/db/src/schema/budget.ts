// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: budget (design/08 §2.3).
import { bigint, boolean, integer, jsonb, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { ENUMS } from "@ncs/shared/enums";

/** budget_policies */
export const budgetPolicies = pgTable(
  "budget_policies",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    category: text("category", { enum: ENUMS.budget_category }).notNull(),
    budgetWindow: text("budget_window", { enum: ENUMS.budget_window }).notNull().default("calendar_month"),
    hardLimitMicros: bigint("hard_limit_micros", { mode: "number" }).notNull(),
    softWarnRatio: numeric("soft_warn_ratio", { precision: 3, scale: 2, mode: "number" }).notNull().default(0.8),
    hardStopEnabled: boolean("hard_stop_enabled").notNull().default(true),
    unpricedUsagePolicy: text("unpriced_usage_policy", { enum: ENUMS.unpriced_usage_policy }).notNull().default("block"),
    status: text("status", { enum: ENUMS.budget_status }).notNull().default("ok"),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true, mode: "date" }).notNull(),
    resumeApprovalId: text("resume_approval_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type BudgetPoliciesRow = typeof budgetPolicies.$inferSelect;
export type BudgetPoliciesInsert = typeof budgetPolicies.$inferInsert;

/** budget_reservations */
export const budgetReservations = pgTable(
  "budget_reservations",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    runId: text("run_id").notNull(),
    providerCallId: text("provider_call_id"),
    category: text("category", { enum: ENUMS.cost_category }).notNull(),
    amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
    status: text("status", { enum: ENUMS.reservation_status }).notNull().default("active"),
    settledCostEventId: text("settled_cost_event_id"),
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "date" }),
    /** 0002: provider identity of the attached call (budget.CostCallMeta) */
    callMeta: jsonb("call_meta").$type<{ provider: string; modelId: string; providerProfileId: string; providerProfileVersion: number; isRerun?: boolean } | null>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type BudgetReservationsRow = typeof budgetReservations.$inferSelect;
export type BudgetReservationsInsert = typeof budgetReservations.$inferInsert;

/** cost_events */
export const costEvents = pgTable(
  "cost_events",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    providerCallId: text("provider_call_id"),
    adjustsCostEventId: text("adjusts_cost_event_id"),
    runId: text("run_id"),
    taskId: text("task_id"),
    agentRole: text("agent_role", { enum: ENUMS.agent_role }),
    arcId: text("arc_id"),
    episodeId: text("episode_id"),
    sceneId: text("scene_id"),
    shotId: text("shot_id"),
    category: text("category", { enum: ENUMS.cost_category }).notNull(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    providerProfileId: text("provider_profile_id").notNull(),
    providerProfileVersion: integer("provider_profile_version").notNull(),
    costBasis: text("cost_basis", { enum: ENUMS.cost_basis }).notNull(),
    amountMicros: bigint("amount_micros", { mode: "number" }).notNull(),
    reservedMicros: bigint("reserved_micros", { mode: "number" }).notNull().default(0),
    overrunMicros: bigint("overrun_micros", { mode: "number" }).notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    cachedTokens: bigint("cached_tokens", { mode: "number" }),
    units: jsonb("units").$type<unknown>(),
    isRerun: boolean("is_rerun").notNull().default(false),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type CostEventsRow = typeof costEvents.$inferSelect;
export type CostEventsInsert = typeof costEvents.$inferInsert;
