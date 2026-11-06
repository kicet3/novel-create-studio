/**
 * DTOs of the `cast` module (설계 추가: 캐릭터 설정 단계 — 컨셉 승인 뒤, 목표·기획서 전).
 * Paths: `…` = `/api/novels/:novelId`.
 *
 *   GET    …/cast                                        → castViewSchema
 *   POST   …/cast/characters               characterCreateRequestSchema → 201 characterDtoSchema
 *   PATCH  …/cast/characters/:characterId  characterPatchRequestSchema  → characterDtoSchema
 *   DELETE …/cast/characters/:characterId                → 204
 *   POST   …/cast/characters/:characterId/accept         → characterDtoSchema (AI 제안 수락: 필드 출처 → user)
 *   PUT    …/cast/order                    castOrderRequestSchema       → castViewSchema
 *   POST   …/cast/import-brief                           → castViewSchema (승인된 브리프의 주인공·주요 인물 가져오기)
 *   POST   …/cast/draft                    castDraftRequestSchema       → 202 { taskId }
 *   POST   …/cast/confirm                                → castViewSchema
 *   GET    …/cast/characters/:characterId/design-sheet   → designSheetViewSchema
 *   PATCH  …/cast/characters/:characterId/design-sheet   designSheetPatchRequestSchema → designSheetViewSchema
 *   POST   …/cast/characters/:characterId/design-sheet/draft   → 202 { taskId }
 *   GET    …/cast/characters/:characterId/design-sheet/prompt?view   → { prompt, styleNotes, negativePrompt, referenceText }
 *   POST   …/cast/characters/:characterId/design-sheet/images  designSheetImageRequestSchema → 202 designSheetImageDtoSchema
 *   PUT    …/cast/characters/:characterId/design-sheet/primary designSheetPrimaryRequestSchema → designSheetViewSchema
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime } from "./common.js";
import { imageGenerationDtoSchema, imageAspectRatioSchema, imageQualitySchema, imageResolutionSchema } from "./imaging.js";
import { llmProviderIdSchema } from "./llm.js";

export const characterRoleDtoSchema = z.enum(ENUMS.character_role);
export const characterFieldOriginDtoSchema = z.enum(ENUMS.character_field_origin);
export const characterSheetViewDtoSchema = z.enum(ENUMS.character_sheet_view);

/** profile fields guarded by provenance (agent never overwrites a `user` field) */
export const CHARACTER_PROFILE_FIELDS = ["name", "aliases", "age", "gender", "personality", "background", "desire", "weakness", "relationships", "notes"] as const;
export type CharacterProfileField = (typeof CHARACTER_PROFILE_FIELDS)[number];

const shortText = (max: number) => z.string().trim().max(max);

export const characterRelationshipSchema = z.object({
  targetCharacterId: z.string().regex(/^chr_[0-9A-HJKMNP-TV-Z]{26}$/),
  /** 관계 이름(자유 입력, 예: "소꿉친구", "사부") */
  kind: shortText(40).min(1, "관계 이름을 입력하세요."),
  description: shortText(500).default(""),
});
export type CharacterRelationship = z.infer<typeof characterRelationshipSchema>;

export const characterDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  role: characterRoleDtoSchema,
  ord: z.number().int(),
  status: z.enum(ENUMS.character_status),
  name: z.string(),
  aliases: z.array(z.string()),
  age: z.string(),
  gender: z.string(),
  personality: z.string(),
  background: z.string(),
  desire: z.string(),
  weakness: z.string(),
  relationships: z.array(characterRelationshipSchema),
  notes: z.string(),
  /** per-field provenance; a missing key = empty field */
  fieldOrigins: z.record(z.string(), characterFieldOriginDtoSchema),
  /** created by the AI draft and not yet accepted by the user */
  proposed: z.boolean(),
  conceptCharacterKey: z.string().nullable(),
  /** ontology character entity (set on cast confirm) */
  entityId: z.string().nullable(),
  confirmedAt: isoDateTime.nullable(),
  /** the design sheet has a spec or an image */
  hasDesignSheet: z.boolean(),
  /** primary front image (`/api/images/assets/:id/file`) when selected */
  thumbnailUrl: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type CharacterDto = z.infer<typeof characterDtoSchema>;

export const castViewSchema = z.object({
  items: z.array(characterDtoSchema),
  /** exactly one protagonist, every character confirmed — the goal (N3) can be saved */
  confirmed: z.boolean(),
  /** Korean reasons why the cast cannot be confirmed yet (empty = can confirm) */
  blockers: z.array(z.string()),
  counts: z.object({ protagonist: z.number().int(), subProtagonist: z.number().int(), other: z.number().int() }),
  /** step state for the novel home: the cast step is required while the novel is onboarding */
  stepRequired: z.boolean(),
  /** the serial goal is saved (the "set the goal" hint is shown only while it is not) */
  goalSet: z.boolean(),
  /** characters added or edited since the last confirm (the writing context keeps the last confirmed profiles) */
  pendingChanges: z.number().int(),
  /** the approved concept brief has characters that can be imported */
  canImportBrief: z.boolean(),
  /** running/pending draft_cast task, null when none */
  draftTask: z.object({ id: z.string(), status: z.string() }).nullable(),
  lastDraftError: z.string().nullable(),
});
export type CastView = z.infer<typeof castViewSchema>;

const profileInput = {
  name: shortText(80).min(1, "이름을 입력하세요."),
  aliases: z.array(shortText(80).min(1)).max(20),
  age: shortText(40),
  gender: shortText(40),
  personality: shortText(2000),
  background: shortText(4000),
  desire: shortText(2000),
  weakness: shortText(2000),
  relationships: z.array(characterRelationshipSchema).max(40),
  notes: shortText(4000),
};

export const characterCreateRequestSchema = z.object({
  role: characterRoleDtoSchema,
  name: profileInput.name,
  aliases: profileInput.aliases.optional(),
  age: profileInput.age.optional(),
  gender: profileInput.gender.optional(),
  personality: profileInput.personality.optional(),
  background: profileInput.background.optional(),
  desire: profileInput.desire.optional(),
  weakness: profileInput.weakness.optional(),
  relationships: profileInput.relationships.optional(),
  notes: profileInput.notes.optional(),
});
export type CharacterCreateRequest = z.input<typeof characterCreateRequestSchema>;

export const characterPatchRequestSchema = z
  .object({
    role: characterRoleDtoSchema.optional(),
    name: profileInput.name.optional(),
    aliases: profileInput.aliases.optional(),
    age: profileInput.age.optional(),
    gender: profileInput.gender.optional(),
    personality: profileInput.personality.optional(),
    background: profileInput.background.optional(),
    desire: profileInput.desire.optional(),
    weakness: profileInput.weakness.optional(),
    relationships: profileInput.relationships.optional(),
    notes: profileInput.notes.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "바꿀 항목이 없습니다.");
export type CharacterPatchRequest = z.input<typeof characterPatchRequestSchema>;

export const castOrderRequestSchema = z.object({
  /** character ids in the new display order (all characters of the novel) */
  ids: z.array(z.string().regex(/^chr_[0-9A-HJKMNP-TV-Z]{26}$/)).min(1).max(200),
});

export const castDraftRequestSchema = z.object({
  /** 원하는 서브 주인공 수 (없으면 AI가 정함) */
  subProtagonistCount: z.number().int().min(0).max(10).optional(),
  includeAntagonist: z.boolean().default(true),
  /** 추가 요청(자유 입력) */
  instructions: shortText(1000).optional(),
});
export type CastDraftRequest = z.input<typeof castDraftRequestSchema>;

export const castParamsSchema = z.object({ characterId: z.string().regex(/^chr_[0-9A-HJKMNP-TV-Z]{26}$/) });

// ── design sheet ─────────────────────────────────────────────────────────
export const DESIGN_SHEET_FIELDS = ["face", "hair", "eyes", "build", "height", "outfits", "colorPalette", "distinguishingMarks", "artStyle", "avoid"] as const;
export type DesignSheetField = (typeof DESIGN_SHEET_FIELDS)[number];

export const designSheetOutfitSchema = z.object({ name: shortText(60).min(1), description: shortText(1000) });
export const designSheetColorSchema = z.object({
  name: shortText(40).min(1),
  /** #RRGGBB */
  hex: z.string().regex(/^#[0-9a-fA-F]{6}$/, "색상은 #RRGGBB 형식으로 입력하세요."),
});

export const designSheetSpecSchema = z.object({
  face: shortText(1000).default(""),
  hair: shortText(1000).default(""),
  eyes: shortText(500).default(""),
  build: shortText(500).default(""),
  height: shortText(60).default(""),
  outfits: z.array(designSheetOutfitSchema).max(8).default([]),
  colorPalette: z.array(designSheetColorSchema).max(12).default([]),
  distinguishingMarks: shortText(1000).default(""),
  artStyle: shortText(1000).default(""),
  /** 이미지에 넣지 말 것 */
  avoid: shortText(1000).default(""),
});
export type DesignSheetSpec = z.output<typeof designSheetSpecSchema>;

export const designSheetImageDtoSchema = z.object({
  id: z.string(),
  view: characterSheetViewDtoSchema,
  generation: imageGenerationDtoSchema,
  createdAt: isoDateTime,
});
export type DesignSheetImageDto = z.infer<typeof designSheetImageDtoSchema>;

export const designSheetViewSchema = z.object({
  characterId: z.string(),
  spec: designSheetSpecSchema,
  fieldOrigins: z.record(z.string(), characterFieldOriginDtoSchema),
  /** view → selected asset id */
  primaryImages: z.partialRecord(characterSheetViewDtoSchema, z.string()),
  /** newest first */
  images: z.array(designSheetImageDtoSchema),
  /** text reused by later image prompts for this character */
  referenceText: z.string(),
  draftTask: z.object({ id: z.string(), status: z.string() }).nullable(),
  updatedAt: isoDateTime.nullable(),
});
export type DesignSheetView = z.infer<typeof designSheetViewSchema>;

export const designSheetPatchRequestSchema = designSheetSpecSchema.partial().refine((v) => Object.keys(v).length > 0, "바꿀 항목이 없습니다.");
export type DesignSheetPatchRequest = z.input<typeof designSheetPatchRequestSchema>;

export const designSheetImageRequestSchema = z.object({
  view: characterSheetViewDtoSchema,
  provider: llmProviderIdSchema,
  modelId: z.string().min(1).max(100),
  aspectRatio: imageAspectRatioSchema.optional(),
  resolution: imageResolutionSchema.default("1k"),
  quality: imageQualitySchema.optional(),
  count: z.number().int().min(1).max(4).default(1),
  /** outfits[i] to draw (default 0) */
  outfitIndex: z.number().int().min(0).max(7).default(0),
});
export type DesignSheetImageRequest = z.input<typeof designSheetImageRequestSchema>;

export const designSheetPrimaryRequestSchema = z.object({
  view: characterSheetViewDtoSchema,
  /** null = clear */
  assetId: z.string().regex(/^ast_[0-9A-HJKMNP-TV-Z]{26}$/).nullable(),
});

export const designSheetPromptQuerySchema = z.object({ view: characterSheetViewDtoSchema.default("front"), outfitIndex: z.coerce.number().int().min(0).max(7).default(0) });
export const designSheetPromptSchema = z.object({ prompt: z.string(), styleNotes: z.string(), negativePrompt: z.string(), referenceText: z.string() });

export const castTaskAcceptedSchema = z.object({ taskId: z.string() });
