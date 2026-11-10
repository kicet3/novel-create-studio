/**
 * DTOs of the read-only 읽기(reader) endpoints (manuscript module, `adapters/http/reader-routes.ts`). `…` = /api/novels/:novelId
 *
 *   GET …/reader/toc                                  → readerTocDtoSchema
 *   GET …/reader/episodes/:episodeNo?mode=approved|draft → readerEpisodeDtoSchema
 *
 * mode=approved (default): the approved / published text only (404 `not_readable` otherwise).
 * mode=draft: the current non-outline draft, falling back to the approved text.
 * Text: scenes joined with a line of `READER_SCENE_BREAK` between them; one non-empty line = one paragraph.
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime } from "./common.js";

/** scene break line inside `readerEpisodeDto.text` */
export const READER_SCENE_BREAK = "* * *";

export const READER_MODES = ["approved", "draft"] as const;
export type ReaderMode = (typeof READER_MODES)[number];

/** which version is being read: published / approved text, or a not-yet-approved draft */
export const readerSourceSchema = z.enum(["published", "approved", "draft"]);
export type ReaderSource = z.infer<typeof readerSourceSchema>;

export const readerTocEpisodeDtoSchema = z.object({
  episodeNo: z.number().int(),
  title: z.string().nullable(),
  status: z.enum(ENUMS.episode_status),
  arcId: z.string(),
  /** approved / published text (null = none yet) */
  approved: z.object({ source: z.enum(["published", "approved"]), charCount: z.number().int() }).nullable(),
  /** current draft that differs from the approved text (null = none, or it is the approved text) */
  draft: z.object({ charCount: z.number().int() }).nullable(),
  /** 설계 추가 0023: 에피소드 묶음(없으면 null) — title은 이미 "묶음 제목 (n)" 표시 제목 */
  unitId: z.string().nullable().optional(),
  unitTitle: z.string().nullable().optional(),
  unitPartNo: z.number().int().nullable().optional(),
  unitPartCount: z.number().int().nullable().optional(),
});
export type ReaderTocEpisodeDto = z.infer<typeof readerTocEpisodeDtoSchema>;

export const readerTocDtoSchema = z.object({
  novelId: z.string(),
  title: z.string(),
  /** 글자 수 기준(작품 분량 설정) */
  countBasis: z.enum(ENUMS.count_basis),
  /** 전체 구성의 부(구성 이전 작품은 빈 배열) */
  parts: z.array(z.object({ id: z.string(), ord: z.number().int(), title: z.string() })),
  /** 플롯(아크) */
  plots: z.array(z.object({ id: z.string(), ord: z.number().int(), title: z.string(), partId: z.string().nullable() })),
  episodes: z.array(readerTocEpisodeDtoSchema),
  /** 설계 추가 0023: 에피소드 묶음별 화 번호(목차 묶음 표시용 데이터, 플롯·순서 차례) */
  units: z
    .array(z.object({ id: z.string(), arcId: z.string(), title: z.string(), ord: z.number().int(), episodeNos: z.array(z.number().int()) }))
    .optional(),
});
export type ReaderTocDto = z.infer<typeof readerTocDtoSchema>;

const neighbor = z
  .object({
    episodeNo: z.number().int(),
    title: z.string().nullable(),
    /** episodes between this one and the neighbour that are not readable in this mode (e.g. 4화 not approved yet) */
    skipped: z.array(z.number().int()),
  })
  .nullable();

export const readerEpisodeDtoSchema = z.object({
  episodeNo: z.number().int(),
  title: z.string().nullable(),
  status: z.enum(ENUMS.episode_status),
  source: readerSourceSchema,
  versionId: z.string(),
  versionNo: z.number().int(),
  versionCreatedAt: isoDateTime,
  countBasis: z.enum(ENUMS.count_basis),
  charCount: z.number().int(),
  sceneCount: z.number().int(),
  text: z.string(),
  /** nearest readable episodes in the same mode (`skipped` lists the unreadable ones in between) */
  prev: neighbor,
  next: neighbor,
  /** 설계 추가 0023: 에피소드 묶음(없으면 null) — title은 이미 표시 제목 */
  unitTitle: z.string().nullable().optional(),
  unitPartNo: z.number().int().nullable().optional(),
  unitPartCount: z.number().int().nullable().optional(),
});
export type ReaderEpisodeDto = z.infer<typeof readerEpisodeDtoSchema>;

export const readerEpisodeQuerySchema = z.object({ mode: z.enum(READER_MODES).default("approved") });
export type ReaderEpisodeQuery = z.input<typeof readerEpisodeQuerySchema>;
