/**
 * 공개 사이트(설계 추가 0021, module publication). `…` = /api/novels/:novelId
 *
 *   GET   …/public-site          → publicSiteNovelDtoSchema      (작품별 노출 설정 + 공개된 화 수)
 *   PATCH …/public-site          ← updatePublicSiteNovelRequestSchema → publicSiteNovelDtoSchema
 *   GET   /api/public-site       → publicSiteStatusDtoSchema     (출력 폴더·마지막 생성 시각)
 *   POST  /api/public-site/build → publicSiteStatusDtoSchema     (공개 사이트 다시 만들기)
 *
 * The snapshot holds only published episodes (status published, published_version_id) of opted-in novels.
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

export const publicSiteStatusDtoSchema = z.object({
  outputDir: z.string(),
  lastBuiltAt: isoDateTime.nullable(),
  lastError: z.string().nullable(),
  novelCount: z.number().int(),
  episodeCount: z.number().int(),
});
export type PublicSiteStatusDto = z.infer<typeof publicSiteStatusDtoSchema>;
