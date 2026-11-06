// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: system (design/08 §2.3).
import { bigint, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { ENUMS } from "@ncs/shared/enums";

/** secrets — id = secret reference key (free-form, e.g. 'llm.anthropic') */
export const secrets = pgTable(
  "secrets",
  {
    id: text("id").notNull().primaryKey(),
    provider: text("provider", { enum: ENUMS.secret_provider }).notNull().default("local_encrypted"),
    label: text("label"),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    authTag: text("auth_tag").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type SecretsRow = typeof secrets.$inferSelect;
export type SecretsInsert = typeof secrets.$inferInsert;

/** backup_records */
export const backupRecords = pgTable(
  "backup_records",
  {
    id: text("id").notNull().primaryKey(),
    status: text("status", { enum: ENUMS.backup_status }).notNull().default("running"),
    trigger: text("trigger", { enum: ENUMS.backup_trigger }).notNull(),
    mode: text("mode", { enum: ENUMS.backup_mode }).notNull().default("full"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    storageKey: text("storage_key"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    contentHash: text("content_hash"),
    appVersion: text("app_version").notNull(),
    lastMigrationId: text("last_migration_id"),
    errorMessage: text("error_message"),
    details: jsonb("details").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type BackupRecordsRow = typeof backupRecords.$inferSelect;
export type BackupRecordsInsert = typeof backupRecords.$inferInsert;

/** health_check_results */
export const healthCheckResults = pgTable(
  "health_check_results",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id"),
    kind: text("kind", { enum: ENUMS.health_check_kind }).notNull(),
    status: text("status", { enum: ENUMS.health_status }).notNull(),
    targetRefType: text("target_ref_type", { enum: ENUMS.ref_type }),
    targetRefId: text("target_ref_id"),
    message: text("message").notNull(),
    details: jsonb("details").$type<unknown>(),
    checkedAt: timestamp("checked_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type HealthCheckResultsRow = typeof healthCheckResults.$inferSelect;
export type HealthCheckResultsInsert = typeof healthCheckResults.$inferInsert;

/** app_migrations — created and owned by the migration runner (design/03 §3.10) */
export const appMigrations = pgTable("app_migrations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  checksum: text("checksum").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  appVersion: text("app_version").notNull(),
  durationMs: integer("duration_ms").notNull(),
});
export type AppMigrationsRow = typeof appMigrations.$inferSelect;
