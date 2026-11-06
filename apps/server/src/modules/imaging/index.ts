/**
 * imaging — public API (이미지 생성 탭). Owns: image_generations, image_assets (0005_imaging.sql).
 *
 * Install-level image generation with optional novel scoping. Providers with an image API: OpenAI (GPT Image —
 * Images API with an API key, or `gpt-image-2` on the ChatGPT Codex backend with ChatGPT sign-in), xAI (Grok
 * Imagine — API key or xAI sign-in), Google (Gemini "Nano Banana" — API key). Claude has no image generation and is
 * listed as unavailable. Credentials come from `llm.resolveCredential()` (the provider-connections work); this module
 * never stores credentials.
 *
 * Requests run in the background inside this process (create → queued → running → succeeded | failed | cancelled);
 * the web polls the generation. Files are written through the platform StorageProvider under
 * `images/<novelId|install>/<generationId>/<ord>.<ext>`.
 * Cost: always on the row (`cost_micros`, basis measured | estimated | plan); novel-scoped requests are admitted by
 * `budget.checkDirectSpend` (category `image`) and settled with `budget.recordDirectCost` (ChatGPT plan lane: no
 * ledger row — billed by the user's ChatGPT plan).
 */
import type { CreateImageGenerationRequest, ErrorFamily, ImageGenerationListQuery, ImageProviderDto, ImageQuality, ImageResolution } from "@ncs/shared";
import type { ImageAssetsRow, ImageGenerationsRow } from "@ncs/db/schema";
import type { ActorRef } from "../../platform/index.js";
import type { LlmCredential } from "../llm/index.js";

export type ImageGeneration = ImageGenerationsRow;
export type ImageAsset = ImageAssetsRow;
export type ImageGenerationWithAssets = ImageGeneration & { assets: ImageAsset[] };

// ── adapter port ──
export interface ImageRequest {
  modelId: string;
  /** final prompt (style / avoid notes already appended) */
  prompt: string;
  n: number;
  aspectRatio: string;
  resolution: ImageResolution;
  quality?: ImageQuality;
}

export interface GeneratedImage {
  data: Uint8Array;
  mimeType: string;
  revisedPrompt?: string;
}

export interface ImageUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export type ImageResult =
  | {
      ok: true;
      images: GeneratedImage[];
      usage?: ImageUsage;
      /** cost reported by the provider (xAI `cost_in_usd_ticks`) */
      reportedCostMicros?: number;
      /** text returned next to the image (Gemini) */
      text?: string;
      /** fewer images than requested (e.g. a Gemini loop step failed) */
      partialFailure?: string;
      providerRequestId?: string;
    }
  | {
      ok: false;
      errorFamily: ErrorFamily;
      message: string;
      httpStatus?: number;
      billed: "yes" | "no" | "unknown";
      providerRequestId?: string;
    };

export interface ImageAdapter {
  /** "openai" | "xai" | "google" */
  readonly provider: string;
  /** one generation request; never throws (errors are results). 401 on an OAuth credential refreshes once. */
  generate(req: ImageRequest, opts: { credential: LlmCredential; signal: AbortSignal; timeoutMs: number }): Promise<ImageResult>;
}

export interface ImagingService {
  /** provider capabilities for the tab: models (for the active connection method), sizes, n limits, connected */
  listProviders(): Promise<ImageProviderDto[]>;
  /** validates, admits (budget, novel-scoped), inserts a queued row (`image.requested`) and schedules it */
  createGeneration(input: CreateImageGenerationRequest, actor: ActorRef): Promise<ImageGenerationWithAssets>;
  listGenerations(query: ImageGenerationListQuery): Promise<{ items: ImageGenerationWithAssets[]; nextCursor: string | null }>;
  getGeneration(id: string): Promise<ImageGenerationWithAssets>;
  /** queued → cancelled; running → aborts the provider call (→ cancelled) */
  cancelGeneration(id: string, actor: ActorRef): Promise<ImageGenerationWithAssets>;
  /** removes the rows and files (aborts a running call first); `image.deleted` */
  deleteGeneration(id: string, actor: ActorRef): Promise<void>;
  openAsset(assetId: string): Promise<{ path: string; mimeType: string; fileName: string }>;
  registerAdapter(adapter: ImageAdapter): void;
  /** resolves when no generation is queued or running in this process (tests) */
  whenIdle(): Promise<void>;
  /** boot recovery: interrupted `running` rows → failed, `queued` rows → scheduled again */
  recover(): Promise<{ failed: number; requeued: number }>;
  stop(): Promise<void>;
}

export type { ImagingModuleDeps } from "./module.js";
export { createImagingModule } from "./module.js";
export { IMAGE_CATALOG } from "./domain/catalog.js";
export { generationView } from "./adapters/http/routes.js";
