/**
 * Image model catalog (pure). Sources (fetched 2026-11-06, see the research notes in the README):
 * - OpenAI GPT Image: developers.openai.com/api/docs/guides/image-generation, /api/docs/pricing
 *   (token-billed: image output $30/1M for 2 / 2.5 / 2.6, text input $5/1M; gpt-image-1-mini output $8/1M).
 *   ChatGPT sign-in lane = ima2-gen's Codex backend `images/generations` with `gpt-image-2` (not documented by OpenAI
 *   for third-party apps → 비공식).
 * - xAI Grok Imagine: docs.x.ai/developers/model-capabilities/images/generation, /developers/models
 *   (`grok-imagine-image-2.0` $0.04 at 1k, $0.06 at 2k; `grok-imagine-image` $0.02).
 * - Google Gemini image ("Nano Banana"): aistudio.google.com/docs/image-generation, /docs/pricing
 *   (Imagen is shut down — no Imagen model). SynthID watermark on every output.
 * - Anthropic: no image-generation API (platform.claude.com models overview: text output only).
 * Estimates are micro-USD per image. Prices change: the stored image provider profile may override them.
 */
import type { ImageQuality, ImageResolution, LlmProviderId, ProviderConnectionMethod } from "@ncs/shared";

export type ImageLane = ProviderConnectionMethod;

export interface ImageModelSpec {
  id: string;
  label: string;
  tier: "default" | "quality" | "budget" | "legacy";
  note: string;
  /** connection methods this model can be called with */
  lanes: ImageLane[];
  aspectRatios: string[];
  resolutions: ImageResolution[];
  qualities: ImageQuality[];
  maxImages: number;
  /** micro-USD per image at 1:1 by resolution (quality medium where it applies); null = no public price */
  pricePerImageMicros: Partial<Record<ImageResolution, number | null>>;
}

export interface ImageProviderSpec {
  provider: LlmProviderId;
  available: boolean;
  /** Korean reason when the provider has no image API */
  unavailableReason: string | null;
  notes: string[];
  /** per-lane notes */
  laneNotes: Partial<Record<ImageLane, string>>;
  priceSourceUrl: string;
  models: ImageModelSpec[];
}

const OPENAI_ASPECTS = ["1:1", "3:2", "2:3", "16:9", "9:16"];
const XAI_ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "21:9"];
const GEMINI_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

/** historical gpt-image-2 table at 1024² ($0.006 / $0.053 / $0.211), scaled by pixels and output price */
const OPENAI_1MP_MICROS: Record<ImageQuality, number> = { low: 6_000, medium: 53_000, high: 211_000 };

export const IMAGE_CATALOG: Readonly<Record<LlmProviderId, ImageProviderSpec>> = {
  anthropic: {
    provider: "anthropic",
    available: false,
    unavailableReason: "Claude는 이미지를 만들 수 없습니다(이미지는 입력으로만 받습니다). GPT·Grok·Gemini 중에서 고르세요.",
    notes: [],
    laneNotes: {},
    priceSourceUrl: "https://platform.claude.com/docs/en/about-claude/models/overview",
    models: [],
  },
  openai: {
    provider: "openai",
    available: true,
    unavailableReason: null,
    notes: ["부정 프롬프트·스타일 메모는 공식 파라미터가 없어 프롬프트 뒤에 덧붙여 전달합니다."],
    laneNotes: {
      api_key: "OpenAI API 키로 Images API를 호출합니다. 사용량은 API 요금(토큰 단위)으로 청구됩니다.",
      chatgpt_oauth:
        "ChatGPT 로그인으로는 Codex 백엔드의 gpt-image-2만 쓸 수 있습니다. OpenAI가 외부 앱용으로 문서화한 경로가 아니라 비공식이며 언제든 막힐 수 있습니다. 사용량은 ChatGPT 요금제 한도에서 차감되고, 이 앱의 예산 원장에는 기록하지 않습니다.",
    },
    priceSourceUrl: "https://developers.openai.com/api/docs/pricing",
    models: [
      {
        id: "gpt-image-2.6-flare",
        label: "GPT Image 2.6 Flare",
        tier: "default",
        note: "빠른 반복 작업용 기본 모델",
        lanes: ["api_key"],
        aspectRatios: OPENAI_ASPECTS,
        resolutions: ["1k", "2k"],
        qualities: ["low", "medium", "high"],
        maxImages: 4,
        pricePerImageMicros: { "1k": 53_000, "2k": 212_000 },
      },
      {
        id: "gpt-image-2.6-sunburst",
        label: "GPT Image 2.6 Sunburst",
        tier: "quality",
        note: "세밀한 표현이 필요한 작업용 고품질 모델",
        lanes: ["api_key"],
        aspectRatios: OPENAI_ASPECTS,
        resolutions: ["1k", "2k"],
        qualities: ["low", "medium", "high"],
        maxImages: 4,
        pricePerImageMicros: { "1k": 53_000, "2k": 212_000 },
      },
      {
        id: "gpt-image-1-mini",
        label: "GPT Image 1 mini",
        tier: "budget",
        note: "저가 모델(정사각·가로·세로 1024px)",
        lanes: ["api_key"],
        aspectRatios: ["1:1", "3:2", "2:3"],
        resolutions: ["1k"],
        qualities: ["low", "medium", "high"],
        maxImages: 4,
        pricePerImageMicros: { "1k": 14_134 },
      },
      {
        id: "gpt-image-2",
        label: "GPT Image 2 (ChatGPT)",
        tier: "default",
        note: "ChatGPT 로그인 전용(Codex 백엔드, 비공식)",
        lanes: ["chatgpt_oauth"],
        aspectRatios: ["1:1", "3:2", "2:3"],
        resolutions: ["1k"],
        qualities: ["low", "medium", "high"],
        maxImages: 4,
        pricePerImageMicros: { "1k": 53_000 },
      },
    ],
  },
  xai: {
    provider: "xai",
    available: true,
    unavailableReason: null,
    notes: ["부정 프롬프트·스타일 메모는 공식 파라미터가 없어 프롬프트 뒤에 덧붙여 전달합니다.", "xAI는 결과를 내기 전에 프롬프트를 고쳐 쓸 수 있습니다(고친 프롬프트를 함께 보여 줍니다)."],
    laneNotes: {
      api_key: "xAI API 키로 Grok Imagine을 호출합니다. 사용량은 API 요금으로 청구됩니다.",
      xai_oauth: "xAI 로그인(실험적)으로 호출합니다. xAI가 문서화한 방식은 API 키뿐이라 403으로 거부될 수 있습니다. 그럴 때는 API 키로 연결하세요.",
    },
    priceSourceUrl: "https://docs.x.ai/developers/models",
    models: [
      {
        id: "grok-imagine-image-2.0",
        label: "Grok Imagine Image 2.0",
        tier: "default",
        note: "기본 모델, 2k 해상도 지원",
        lanes: ["api_key", "xai_oauth"],
        aspectRatios: XAI_ASPECTS,
        resolutions: ["1k", "2k"],
        qualities: ["low", "medium"],
        maxImages: 4,
        pricePerImageMicros: { "1k": 40_000, "2k": 60_000 },
      },
      {
        id: "grok-imagine-image",
        label: "Grok Imagine Image",
        tier: "budget",
        note: "저가 모델",
        lanes: ["api_key", "xai_oauth"],
        aspectRatios: XAI_ASPECTS,
        resolutions: ["1k"],
        qualities: [],
        maxImages: 4,
        pricePerImageMicros: { "1k": 20_000 },
      },
    ],
  },
  google: {
    provider: "google",
    available: true,
    unavailableReason: null,
    notes: [
      "Gemini가 만든 모든 이미지에는 눈에 보이지 않는 SynthID 워터마크가 들어갑니다.",
      "Gemini는 한 번에 한 장씩 만들어서 여러 장을 요청하면 차례로 호출합니다.",
      "부정 프롬프트·스타일 메모는 공식 파라미터가 없어 프롬프트 뒤에 덧붙여 전달합니다.",
    ],
    laneNotes: { api_key: "Google AI Studio API 키로 Gemini 이미지 모델을 호출합니다. 무료 등급은 입력 데이터가 제품 개선에 쓰일 수 있습니다." },
    priceSourceUrl: "https://aistudio.google.com/docs/pricing",
    models: [
      {
        id: "gemini-nano-banana-2.1",
        label: "Nano Banana 2.1",
        tier: "default",
        note: "새 프로젝트 권장 모델",
        lanes: ["api_key"],
        aspectRatios: [...GEMINI_ASPECTS, "1:4", "4:1"],
        resolutions: ["1k", "2k", "4k"],
        qualities: [],
        maxImages: 4,
        pricePerImageMicros: { "1k": 33_600, "2k": 50_400, "4k": 113_000 },
      },
      {
        id: "gemini-3-pro-image",
        label: "Nano Banana Pro",
        tier: "quality",
        note: "고품질 모델",
        lanes: ["api_key"],
        aspectRatios: GEMINI_ASPECTS,
        resolutions: ["1k", "2k", "4k"],
        qualities: [],
        maxImages: 4,
        pricePerImageMicros: { "1k": 134_000, "2k": 134_000, "4k": 240_000 },
      },
      {
        id: "gemini-3.1-flash-lite-image",
        label: "Nano Banana 2 Lite",
        tier: "budget",
        note: "가장 싸고 빠른 모델(1K만)",
        lanes: ["api_key"],
        aspectRatios: GEMINI_ASPECTS,
        resolutions: ["1k"],
        qualities: [],
        maxImages: 4,
        pricePerImageMicros: { "1k": 33_600 },
      },
    ],
  },
};

export function modelsForLane(provider: LlmProviderId, lane: ImageLane | null): ImageModelSpec[] {
  const all = IMAGE_CATALOG[provider].models;
  return all.filter((m) => m.lanes.includes(lane ?? "api_key"));
}

export function findModel(provider: LlmProviderId, modelId: string): ImageModelSpec | undefined {
  return IMAGE_CATALOG[provider].models.find((m) => m.id === modelId);
}

// ── sizes ──
const OPENAI_SIZES: Record<string, Partial<Record<ImageResolution, [number, number]>>> = {
  "1:1": { "1k": [1024, 1024], "2k": [2048, 2048] },
  "3:2": { "1k": [1536, 1024], "2k": [2048, 1360] },
  "2:3": { "1k": [1024, 1536], "2k": [1360, 2048] },
  "16:9": { "1k": [1536, 864], "2k": [2048, 1152] },
  "9:16": { "1k": [864, 1536], "2k": [1152, 2048] },
};

/** OpenAI `size` ("WxH") for an aspect + resolution (multiples of 16, ratio within 1:3..3:1) */
export function openAiSize(aspectRatio: string, resolution: ImageResolution): string | null {
  const s = OPENAI_SIZES[aspectRatio]?.[resolution];
  return s ? `${s[0]}x${s[1]}` : null;
}

export const geminiImageSize = (r: ImageResolution): string => r.toUpperCase();

// ── cost ──
function ratioPixelsFactor(aspectRatio: string, resolution: ImageResolution): number {
  const s = OPENAI_SIZES[aspectRatio]?.[resolution];
  if (!s) return 1;
  const base = OPENAI_SIZES["1:1"]![resolution]!;
  return (s[0] * s[1]) / (base[0] * base[1]);
}

/**
 * Estimated micro-USD for the whole request; null = unpriced. `override` = per-image prices stored in the image
 * provider profile (by resolution).
 */
export function estimateMicros(
  provider: LlmProviderId,
  model: ImageModelSpec,
  p: { aspectRatio: string; resolution: ImageResolution; quality?: ImageQuality; n: number },
  override?: Partial<Record<ImageResolution, number | null>>,
): number | null {
  const per = override?.[p.resolution] !== undefined ? override[p.resolution]! : model.pricePerImageMicros[p.resolution];
  if (per === null || per === undefined) return null;
  let unit = per;
  if (provider === "openai") {
    const q = p.quality ?? "medium";
    unit = Math.round(per * (OPENAI_1MP_MICROS[q] / OPENAI_1MP_MICROS.medium) * ratioPixelsFactor(p.aspectRatio, p.resolution));
  }
  return unit * p.n;
}

/** measured cost of an OpenAI image call from token usage (micro-USD per token = $ per 1M tokens) */
export function openAiMeasuredMicros(modelId: string, usage: { inputTokens?: number; outputTokens?: number }): number | null {
  if (usage.outputTokens === undefined && usage.inputTokens === undefined) return null;
  const mini = modelId.startsWith("gpt-image-1-mini");
  const inRate = mini ? 2 : 5;
  const outRate = mini ? 8 : 30;
  return Math.round((usage.inputTokens ?? 0) * inRate + (usage.outputTokens ?? 0) * outRate);
}

/** xAI `usage.cost_in_usd_ticks` (1 USD = 1e10 ticks) → micro-USD */
export const xaiTicksToMicros = (ticks: number): number => Math.round(ticks / 10_000);

// ── prompt ──
/** No provider has a native negative prompt / style field: both are appended as plain-language directions. */
export function composePrompt(prompt: string, styleNotes?: string, negativePrompt?: string): string {
  let out = prompt.trim();
  if (styleNotes?.trim()) out += `\n\n스타일 지시: ${styleNotes.trim()}`;
  if (negativePrompt?.trim()) out += `\n\n이미지에 넣지 말 것: ${negativePrompt.trim()}`;
  return out;
}

// ── validation ──
export function validateParams(
  model: ImageModelSpec,
  p: { aspectRatio: string; resolution: ImageResolution; quality?: ImageQuality; count: number },
): string | null {
  if (!model.aspectRatios.includes(p.aspectRatio)) return `${model.label}은(는) 화면비 ${p.aspectRatio}를 지원하지 않습니다.`;
  if (!model.resolutions.includes(p.resolution)) return `${model.label}은(는) 해상도 ${p.resolution.toUpperCase()}를 지원하지 않습니다.`;
  if (p.quality && model.qualities.length && !model.qualities.includes(p.quality)) return `${model.label}은(는) 품질 ${p.quality}를 지원하지 않습니다.`;
  if (p.count > model.maxImages) return `${model.label}은(는) 한 번에 ${model.maxImages}장까지 만들 수 있습니다.`;
  return null;
}

export const extOf = (mime: string): string => (mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "png");
