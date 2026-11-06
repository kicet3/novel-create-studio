/** DTOs of the `system` module (health checks, secrets metadata, install info). */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime } from "./common.js";

export const healthCheckResultDtoSchema = z.object({
  id: z.string(),
  novelId: z.string().nullable(),
  kind: z.enum(ENUMS.health_check_kind),
  name: z.string(),
  status: z.enum(ENUMS.health_status),
  message: z.string(),
  details: z.unknown().nullable(),
  checkedAt: isoDateTime,
});
export type HealthCheckResultDto = z.infer<typeof healthCheckResultDtoSchema>;

export const runHealthChecksRequestSchema = z.object({
  kinds: z.array(z.enum(ENUMS.health_check_kind)).optional(),
  novelId: z.string().optional(),
});

export const secretMetaDtoSchema = z.object({ id: z.string(), label: z.string().nullable(), updatedAt: isoDateTime });
export type SecretMetaDto = z.infer<typeof secretMetaDtoSchema>;

/** Secret ids: dotted lowercase keys, e.g. "llm.anthropic.api_key", "telegram.bot.bot_01J…". */
export const secretIdSchema = z.string().regex(/^[a-z0-9_]+(\.[A-Za-z0-9_]+)+$/, "비밀 키 형식이 올바르지 않습니다.");
export const setSecretRequestSchema = z.object({ value: z.string().min(1).max(10_000), label: z.string().max(200).optional() });

export const systemInfoDtoSchema = z.object({
  version: z.string(),
  deploymentMode: z.enum(ENUMS.deployment_mode),
  /** InstallConfig dev_mode (`pnpm dev` / NCS_DEV_MODE=1): subscription / OAuth AI connections are usable only then */
  devMode: z.boolean(),
  exposure: z.enum(ENUMS.exposure),
  databaseMode: z.enum(ENUMS.database_mode),
  /** password-free: provider, masked host, app schema, Supavisor mode, TLS mode */
  database: z
    .object({
      provider: z.enum(ENUMS.database_provider),
      host: z.string().nullable(),
      port: z.number().int().nullable(),
      schema: z.string().nullable(),
      pooler: z.enum(["direct", "session", "transaction"]).nullable(),
      sslMode: z.string().nullable(),
      poolMax: z.number().int(),
    })
    .optional(),
  llmProvider: z.enum(["anthropic", "claude_code", "openai", "xai", "google"]),
  server: z.object({ host: z.string(), port: z.number().int() }),
  home: z.string(),
  startedAt: isoDateTime,
});
export type SystemInfoDto = z.infer<typeof systemInfoDtoSchema>;

// ── backups (MA-6, owner: ops/CLI agent) ─────────────────────────────────────
export const backupRecordDtoSchema = z.object({
  id: z.string(),
  status: z.enum(ENUMS.backup_status),
  trigger: z.enum(ENUMS.backup_trigger),
  mode: z.enum(ENUMS.backup_mode),
  startedAt: isoDateTime,
  finishedAt: isoDateTime.nullable(),
  storageKey: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  contentHash: z.string().nullable(),
  appVersion: z.string(),
  lastMigrationId: z.string().nullable(),
  errorMessage: z.string().nullable(),
  details: z.unknown().nullable(),
});
export type BackupRecordDto = z.infer<typeof backupRecordDtoSchema>;

/** POST /api/system/backups — manual backup (synchronous; 409 `backup_running` while one runs). */
export const createBackupRequestSchema = z
  .object({ engine: z.enum(["auto", "pg_dump", "json"]).optional() })
  .prefault({});
export type CreateBackupRequest = z.infer<typeof createBackupRequestSchema>;

/** GET /api/system/backups → { items, schedule } */
export const backupScheduleDtoSchema = z.object({
  due: z.boolean(),
  reason: z.string(),
  nextAt: isoDateTime.nullable(),
  intervalHours: z.number().int(),
  backupsDir: z.string(),
});
export type BackupScheduleDto = z.infer<typeof backupScheduleDtoSchema>;

export const backupVerifyResultDtoSchema = z.object({ ok: z.boolean(), message: z.string() });
export type BackupVerifyResultDto = z.infer<typeof backupVerifyResultDtoSchema>;

export const backupIdSchema = z.string().regex(/^bkp_[0-9A-HJKMNP-TV-Z]{26}$/, "백업 ID 형식이 올바르지 않습니다.");
