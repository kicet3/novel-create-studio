/**
 * 공개 사이트(설계 추가 0021, module publication). `…` = /api/novels/:novelId
 *
 *   GET   …/public-site          → publicSiteNovelDtoSchema      (작품별 노출 설정 + 공개된 화 수)
 *   PATCH …/public-site          ← updatePublicSiteNovelRequestSchema → publicSiteNovelDtoSchema
 *   GET   /api/public-site            → publicSiteStatusDtoSchema     (대상·연결 상태·마지막 동기화)
 *   PUT   /api/public-site/config     ← updatePublicSiteConfigRequestSchema → publicSiteStatusDtoSchema
 *   POST  /api/public-site/build      → publicSiteStatusDtoSchema     ([지금 동기화]: 강제로 다시 맞추기)
 *   POST  /api/public-site/check      → publicSiteCheckDtoSchema      ([연결 확인]: SELECT 1 + 스키마 버전, 읽기만)
 *   GET   /api/public-site/role-sql   → publicSiteRoleSqlDtoSchema    (독자 사이트용 제한 역할 SQL — 사용자가 직접 실행)
 *
 * Targets: "supabase" (default once a writer URL is saved) upserts the published content into the public schema of the
 * user's Supabase database; "files" writes the static JSON snapshot (offline / dev fallback). Either way only published
 * episodes (status published, published_version_id) of opted-in novels leave the studio. The writer connection string
 * is a studio secret (`public_site.database_url`, encrypted): it is never returned — only `configured`.
 */
import { z } from "zod";
import { isoDateTime } from "./common.js";

/** same rule as `PUBLIC_SLUG_RE` in @ncs/reader-core/snapshot (DB check: 0021_public_site.sql) */
export const PUBLIC_SITE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const publicSiteSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(PUBLIC_SITE_SLUG_RE, "공개 주소는 영문 소문자·숫자·하이픈(-)으로 1~64자, 하이픈으로 시작하거나 끝날 수 없습니다.")
  .refine((s) => !s.includes("--"), "하이픈(-)을 연달아 쓸 수 없습니다.");

export const publicSiteNovelDtoSchema = z.object({
  novelId: z.string(),
  enabled: z.boolean(),
  slug: z.string().nullable(),
  intro: z.string(),
  authorName: z.string(),
  /** episodes that would be on the public site (status published with a published version) */
  publishedEpisodeCount: z.number().int(),
  updatedAt: isoDateTime.nullable(),
});
export type PublicSiteNovelDto = z.infer<typeof publicSiteNovelDtoSchema>;

export const updatePublicSiteNovelRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    slug: publicSiteSlugSchema.nullable().optional(),
    intro: z.string().max(2000).optional(),
    authorName: z.string().trim().max(40).optional(),
  })
  .strict();
export type UpdatePublicSiteNovelRequest = z.input<typeof updatePublicSiteNovelRequestSchema>;

export const PUBLIC_SITE_TARGETS = ["supabase", "files"] as const;
export type PublicSiteTarget = (typeof PUBLIC_SITE_TARGETS)[number];

/** same rule as `isSafeSchemaName` in @ncs/public-schema (reserved Supabase / PostgreSQL schemas are refused there) */
export const PUBLIC_SITE_SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export const publicSiteSyncRunSchema = z.object({
  upsertedNovels: z.number().int(),
  upsertedEpisodes: z.number().int(),
  deletedNovels: z.number().int(),
  deletedEpisodes: z.number().int(),
  unchangedNovels: z.number().int(),
});
export type PublicSiteSyncRun = z.infer<typeof publicSiteSyncRunSchema>;

export const publicSiteStatusDtoSchema = z.object({
  /** where publishing goes now */
  target: z.enum(PUBLIC_SITE_TARGETS),
  /** explicit: chosen in settings; default: supabase when a writer URL is saved, else files */
  targetSource: z.enum(["explicit", "default"]),
  /** files target: snapshot folder */
  outputDir: z.string(),
  /** last successful build / sync of the current target */
  lastBuiltAt: isoDateTime.nullable(),
  /** sanitized (never contains the connection string or password) */
  lastError: z.string().nullable(),
  novelCount: z.number().int(),
  episodeCount: z.number().int(),
  lastRun: publicSiteSyncRunSchema.nullable(),
  supabase: z.object({
    /** a writer connection string is saved (the value itself is never returned) */
    configured: z.boolean(),
    schema: z.string(),
    /** host only (no user / password), e.g. aws-0-ap-northeast-2.pooler.supabase.com */
    host: z.string().nullable(),
    schemaVersion: z.number().int().nullable(),
    latestSchemaVersion: z.number().int(),
  }),
});
export type PublicSiteStatusDto = z.infer<typeof publicSiteStatusDtoSchema>;

export const updatePublicSiteConfigRequestSchema = z
  .object({
    /** null: back to the default (supabase when a writer URL is saved, else files) */
    target: z.enum(PUBLIC_SITE_TARGETS).nullable().optional(),
    /** writer connection string (postgresql://…); null clears it. Write-only. */
    databaseUrl: z
      .string()
      .trim()
      .max(2000)
      .regex(/^postgres(ql)?:\/\/\S+$/, "postgresql:// 로 시작하는 연결 문자열을 넣어 주세요.")
      .nullable()
      .optional(),
    schema: z.string().trim().regex(PUBLIC_SITE_SCHEMA_RE, "스키마 이름은 영문 소문자·숫자·밑줄(_)로, 63자 이내입니다.").optional(),
  })
  .strict();
export type UpdatePublicSiteConfigRequest = z.input<typeof updatePublicSiteConfigRequestSchema>;

export const publicSiteCheckDtoSchema = z.object({
  ok: z.boolean(),
  /** user-facing Korean message (sanitized) */
  message: z.string(),
  schemaVersion: z.number().int().nullable(),
  latestSchemaVersion: z.number().int(),
});
export type PublicSiteCheckDto = z.infer<typeof publicSiteCheckDtoSchema>;

export const publicSiteRoleSqlDtoSchema = z.object({
  role: z.string(),
  schema: z.string(),
  sql: z.string(),
});
export type PublicSiteRoleSqlDto = z.infer<typeof publicSiteRoleSqlDtoSchema>;
