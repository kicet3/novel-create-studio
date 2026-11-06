// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: llm (design/08 §2.3; role_model_defaults: 0007_role_model_defaults.sql).
import { bigint, boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { ENUMS } from "@ncs/shared/enums";

/** provider_profiles */
export const providerProfiles = pgTable(
  "provider_profiles",
  {
    id: text("id").notNull().primaryKey(),
    providerKind: text("provider_kind", { enum: ENUMS.provider_kind }).notNull(),
    provider: text("provider").notNull(),
    versionNo: integer("version_no").notNull(),
    models: jsonb("models").$type<unknown>().notNull().default([]),
    priceSourceUrl: text("price_source_url").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }).notNull(),
    retentionPolicyUrl: text("retention_policy_url"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type ProviderProfilesRow = typeof providerProfiles.$inferSelect;
export type ProviderProfilesInsert = typeof providerProfiles.$inferInsert;

/** role_model_bindings */
export const roleModelBindings = pgTable(
  "role_model_bindings",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    agentRole: text("agent_role", { enum: ENUMS.agent_role }).notNull(),
    providerProfileId: text("provider_profile_id").notNull(),
    modelId: text("model_id").notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    fallbackModelId: text("fallback_model_id"),
    fallbackEnabled: boolean("fallback_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type RoleModelBindingsRow = typeof roleModelBindings.$inferSelect;
export type RoleModelBindingsInsert = typeof roleModelBindings.$inferInsert;

/** provider_calls */
export const providerCalls = pgTable(
  "provider_calls",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    runId: text("run_id").notNull(),
    seq: integer("seq").notNull(),
    providerKind: text("provider_kind", { enum: ENUMS.provider_kind }).notNull(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    modelVersion: text("model_version"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    maxOutputTokens: integer("max_output_tokens"),
    maxCostMicros: bigint("max_cost_micros", { mode: "number" }).notNull(),
    reservationId: text("reservation_id").notNull(),
    status: text("status", { enum: ENUMS.provider_call_status }).notNull().default("prepared"),
    responseStorageKey: text("response_storage_key"),
    response: jsonb("response").$type<unknown>(),
    usage: jsonb("usage").$type<unknown>(),
    errorFamily: text("error_family", { enum: ENUMS.error_family }),
    retryOfCallId: text("retry_of_call_id"),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    respondedAt: timestamp("responded_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type ProviderCallsRow = typeof providerCalls.$inferSelect;
export type ProviderCallsInsert = typeof providerCalls.$inferInsert;

/** role_model_defaults (0007): install-level default provider + model per agent role for NEW novels */
export const roleModelDefaults = pgTable(
  "role_model_defaults",
  {
    agentRole: text("agent_role", { enum: ENUMS.agent_role }).notNull().primaryKey(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type RoleModelDefaultsRow = typeof roleModelDefaults.$inferSelect;
export type RoleModelDefaultsInsert = typeof roleModelDefaults.$inferInsert;
