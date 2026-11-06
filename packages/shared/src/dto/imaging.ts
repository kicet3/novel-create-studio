/**
 * DTOs of the `imaging` module (이미지 생성 탭). Install level, optional novel scoping (`novelId`).
 *
 *   GET    /api/images/providers                         → { items: imageProviderDtoSchema[] }
 *   POST   /api/images/generations   createImageGenerationRequestSchema → 202 imageGenerationDtoSchema (status queued)
 *   GET    /api/images/generations?novelId&scope&status&limit&before    → { items, nextCursor }
 *   GET    /api/images/generations/:generationId          → imageGenerationDtoSchema (poll until status is final)
 *   POST   /api/images/generations/:generationId/cancel   → imageGenerationDtoSchema
 *   DELETE /api/images/generations/:generationId          → 204 (files removed)
 *   GET    /api/images/assets/:assetId/file?download=1    → image bytes
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime, queryBool } from "./common.js";
import { llmProviderIdSchema, providerConnectionMethodSchema } from "./llm.js";

export const IMAGE_RESOLUTIONS = ["1k", "2k", "4k"] as const;
export const imageResolutionSchema = z.enum(IMAGE_RESOLUTIONS);
export type ImageResolution = z.infer<typeof imageResolutionSchema>;

export const IMAGE_QUALITIES = ["low", "medium", "high"] as const;
export const imageQualitySchema = z.enum(IMAGE_QUALITIES);
export type ImageQuality = z.infer<typeof imageQualitySchema>;

/** "W:H" (e.g. 16:9, 19.5:9) */
export const imageAspectRatioSchema = z.string().regex(/^\d+(\.\d+)?:\d+(\.\d+)?$/, "화면비 형식이 올바르지 않습니다.");

export const imageCostBasisSchema = z.enum(["measured", "estimated", "plan"]);
export type ImageCostBasis = z.infer<typeof imageCostBasisSchema>;

export const imageModelDtoSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** default = 기본, quality = 고품질, budget = 저가, legacy = 이전 세대 */
  tier: z.enum(["default", "quality", "budget", "legacy"]),
  note: z.string(),
  aspectRatios: z.array(z.string()).min(1),
  resolutions: z.array(imageResolutionSchema).min(1),
  /** empty = the model has no quality option */
  qualities: z.array(imageQualitySchema),
  maxImages: z.number().int().min(1),
  /** estimated micro-USD per image by resolution (quality `medium` where it applies); null = no public price */
  estimatedMicrosPerImage: z.record(z.string(), z.number().int().nullable()),
});
export type ImageModelDto = z.infer<typeof imageModelDtoSchema>;

export const imageProviderDtoSchema = z.object({
  provider: llmProviderIdSchema,
  label: z.string(),
  /** the provider has an image-generation API at all (Claude: false) */
  available: z.boolean(),
  connected: z.boolean(),
  /** connection method image calls would use (null = not connected) */
  activeMethod: providerConnectionMethodSchema.nullable(),
  /** Korean reason when the provider cannot be used right now (not connected / no image API / method unsupported) */
  unavailableReason: z.string().nullable(),
  /** models usable with the active method (or with an API key when not connected) */
  models: z.array(imageModelDtoSchema),
  defaultModelId: z.string().nullable(),
  /** Korean notes (watermark, unofficial lane, prompt handling) */
  notes: z.array(z.string()),
  termsNote: z.string(),
});
export type ImageProviderDto = z.infer<typeof imageProviderDtoSchema>;
export const imageProviderListSchema = z.object({ items: z.array(imageProviderDtoSchema) });

export const createImageGenerationRequestSchema = z.object({
  novelId: z.string().regex(/^nov_[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  provider: llmProviderIdSchema,
  modelId: z.string().min(1).max(100),
  prompt: z.string().trim().min(1, "프롬프트를 입력하세요.").max(4_000, "프롬프트는 4,000자 이하로 입력하세요."),
  /** no provider has a native negative prompt: appended to the prompt as "피할 것" */
  negativePrompt: z.string().trim().max(1_000).optional(),
  /** appended to the prompt as style direction */
  styleNotes: z.string().trim().max(1_000).optional(),
  aspectRatio: imageAspectRatioSchema,
  resolution: imageResolutionSchema.default("1k"),
  quality: imageQualitySchema.optional(),
  count: z.number().int().min(1).max(10).default(1),
});
export type CreateImageGenerationRequest = z.input<typeof createImageGenerationRequestSchema>;

export const imageAssetDtoSchema = z.object({
  id: z.string(),
  ord: z.number().int(),
  mimeType: z.string(),
  byteSize: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  revisedPrompt: z.string().nullable(),
  /** `/api/images/assets/:id/file` */
  url: z.string(),
  createdAt: isoDateTime,
});
export type ImageAssetDto = z.infer<typeof imageAssetDtoSchema>;

export const imageGenerationDtoSchema = z.object({
  id: z.string(),
  novelId: z.string().nullable(),
  provider: z.string(),
  modelId: z.string(),
  credentialMethod: z.string().nullable(),
  prompt: z.string(),
  params: z.record(z.string(), z.unknown()),
  imageCount: z.number().int(),
  status: z.enum(ENUMS.image_generation_status),
  errorFamily: z.string().nullable(),
  errorMessage: z.string().nullable(),
  estimatedMicros: z.number().int().nullable(),
  costMicros: z.number().int().nullable(),
  costBasis: imageCostBasisSchema.nullable(),
  revisedPrompt: z.string().nullable(),
  createdAt: isoDateTime,
  startedAt: isoDateTime.nullable(),
  completedAt: isoDateTime.nullable(),
  assets: z.array(imageAssetDtoSchema),
});
export type ImageGenerationDto = z.infer<typeof imageGenerationDtoSchema>;
export const imageGenerationListSchema = z.object({ items: z.array(imageGenerationDtoSchema), nextCursor: z.string().nullable() });

export const imageGenerationListQuerySchema = z.object({
  novelId: z.string().regex(/^nov_[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  /** install = only install-level (default without novelId), novel = the given novel (default with novelId), all = everything */
  scope: z.enum(["install", "novel", "all"]).optional(),
  status: z.enum(ENUMS.image_generation_status).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** cursor = id of the last item of the previous page */
  before: z.string().regex(/^img_[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
});
export type ImageGenerationListQuery = z.input<typeof imageGenerationListQuerySchema>;

export const imageGenerationParamsSchema = z.object({ generationId: z.string().regex(/^img_[0-9A-HJKMNP-TV-Z]{26}$/) });
export const imageAssetParamsSchema = z.object({ assetId: z.string().regex(/^ast_[0-9A-HJKMNP-TV-Z]{26}$/) });
export const imageAssetFileQuerySchema = z.object({ download: queryBool.optional() });
