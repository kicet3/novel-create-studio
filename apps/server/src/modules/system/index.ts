/**
 * system — public API (design/02 §3.2, §7.4, §8; 08 §5, §5.6).
 * Owns: secrets, backup_records, health_check_results, app_migrations (read-only here; written by @ncs/db runner).
 *
 * - `secrets`: SecretProvider (`local_encrypted`, AES-256-GCM, key file `<home>/secrets/master.key`).
 * - Health-check registry: modules register checks for their `health_check_kind` (llm → `llm_key`,
 *   messaging → `bot_token`/`channel_reach`, ontology → `ontology_integrity`, system → `database`/`storage`,
 *   backup → `backup_location`). Results are stored in `health_check_results`; a fail after a non-fail
 *   writes `system.health_check_failed`.
 * - Backups/restore (MA-6): `BackupService` (application/backup-service.ts, wired by backup-wiring.ts); restore is `ncs restore`.
 */
import type { HealthCheckKind, HealthStatus, BackupTrigger, DatabaseMode } from "@ncs/shared";
import type { HealthCheckResultsRow, BackupRecordsRow } from "@ncs/db/schema";
import type { ActorRef, Ref, SecretProvider } from "../../platform/index.js";
import type { RecordRestoredInput, RunBackupOptions } from "./application/backup-service.js";
import type { ScheduleDecision } from "./application/backup-policy.js";

export interface HealthCheckOutcome {
  status: HealthStatus;
  /** user-facing Korean message, no secrets */
  message: string;
  details?: Record<string, unknown>;
}

export interface HealthCheckDefinition {
  /** unique name, e.g. "database", "storage", "llm.anthropic", "telegram.bot.<botId>" */
  name: string;
  kind: HealthCheckKind;
  /** install: run once; novel: run per non-archived novel (ctx.novelId set) */
  scope: "install" | "novel";
  /** optional target recorded with the result (e.g. a channel) */
  target?: (ctx: { novelId?: string }) => Ref | undefined;
  run(ctx: { novelId?: string; signal: AbortSignal }): Promise<HealthCheckOutcome>;
  /** optional: false = not applicable right now (e.g. an LLM provider that is not connected) — skipped, no result row */
  isActive?(): Promise<boolean>;
}

export type HealthCheckResult = HealthCheckResultsRow & { name: string };

export interface RunHealthChecksOptions {
  kinds?: HealthCheckKind[];
  names?: string[];
  novelId?: string;
  /** persist results (default true) */
  record?: boolean;
  /** per-check timeout ms (default 15000) */
  timeoutMs?: number;
}

export interface SystemInfo {
  version: string;
  deploymentMode: "local_trusted" | "self_hosted";
  /** InstallConfig dev_mode */
  devMode: boolean;
  exposure: "private" | "public";
  databaseMode: DatabaseMode;
  llmProvider: "anthropic" | "claude_code" | "openai" | "xai" | "google";
  server: { host: string; port: number };
  home: string;
  startedAt: Date;
}

/** MA-6 contract (02 §8, 08 §8.3). Not implemented in the contracts phase. */
export interface BackupService {
  runBackup(trigger: BackupTrigger, opts?: RunBackupOptions): Promise<BackupRecordsRow>;
  listBackups(): Promise<BackupRecordsRow[]>;
  getBackup(backupId: string): Promise<BackupRecordsRow>;
  /** restore is CLI-only (server stopped) — see apps/cli `ncs restore` */
  verifyBackup(backupId: string): Promise<{ ok: boolean; message: string }>;
  /** when the next scheduled backup is due (missed-backup catch-up included) */
  scheduleDecision(): Promise<ScheduleDecision>;
  /** called by `ncs restore` against the restored DB (`backup.restored`) */
  recordRestored(input: RecordRestoredInput, actor?: ActorRef): Promise<void>;
}
export type { RunBackupOptions, RecordRestoredInput } from "./application/backup-service.js";
export type { ScheduleDecision } from "./application/backup-policy.js";

export interface SystemService {
  readonly secrets: SecretProvider;
  readonly backups: BackupService;
  registerHealthCheck(def: HealthCheckDefinition): void;
  listHealthChecks(): Array<Pick<HealthCheckDefinition, "name" | "kind" | "scope">>;
  runHealthChecks(opts?: RunHealthChecksOptions): Promise<HealthCheckResult[]>;
  /** latest result per check name (install-level when novelId omitted, plus that novel's when given) */
  latestHealthResults(opts?: { novelId?: string }): Promise<HealthCheckResult[]>;
  info(): SystemInfo;
}

export type { SystemModuleDeps } from "./module.js";
export { createSystemModule } from "./module.js";
