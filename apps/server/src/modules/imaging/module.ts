/** Factory of `imaging` (이미지 생성 탭): OpenAI / xAI / Gemini image adapters, background runner, routes. */
import type { Platform, ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { BudgetService } from "../budget/index.js";
import type { LlmService } from "../llm/index.js";
import type { NovelService } from "../novel/index.js";
import type { ImageAdapter, ImagingService } from "./index.js";
import { createImagingService } from "./application/imaging-service.js";
import { mountImagingRoutes } from "./adapters/http/routes.js";
import { OpenAiImageAdapter } from "./adapters/openai/openai-image-adapter.js";
import { XaiImageAdapter } from "./adapters/xai/xai-image-adapter.js";
import { GeminiImageAdapter } from "./adapters/google/gemini-image-adapter.js";

export interface ImagingModuleDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  budget: BudgetService;
  llm: LlmService;
  /** replaces the production adapters of the same provider (tests) */
  adapters?: ImageAdapter[];
  /** test seams */
  concurrency?: number;
  timeoutMs?: number;
}

export function createImagingModule(deps: ImagingModuleDeps): ServerModule<ImagingService> {
  const ep = deps.platform.config.llm.endpoints;
  const service = createImagingService({
    ...deps,
    adapters: [
      new OpenAiImageAdapter({ apiBaseUrl: ep.openai_api_base_url, codexBaseUrl: ep.openai_codex_base_url }),
      new XaiImageAdapter({ apiBaseUrl: ep.xai_api_base_url }),
      new GeminiImageAdapter({ apiBaseUrl: ep.google_api_base_url }),
      ...(deps.adapters ?? []),
    ],
  });
  return {
    name: "imaging",
    implemented: true,
    service,
    routes: (r) => mountImagingRoutes(r, service),
    async start() {
      const r = await service.recover();
      if (r.failed || r.requeued) deps.platform.log.info(r, "image generations recovered on boot");
    },
    stop: () => service.stop(),
  };
}
