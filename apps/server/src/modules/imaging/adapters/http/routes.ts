/** HTTP adapter of `imaging` (install level `/api/images/...`; novel scoping by `novelId`). */
import type { z } from "zod";
import {
  createImageGenerationRequestSchema,
  imageAssetFileQuerySchema,
  imageAssetParamsSchema,
  imageGenerationListQuerySchema,
  imageGenerationParamsSchema,
} from "@ncs/shared";
import type { ApiRouters } from "../../../../platform/index.js";
import { actorOf, sendStoredFile, valid, validate } from "../../../../http/kit.js";
import type { ImageGenerationWithAssets, ImagingService } from "../../index.js";

type GenId = { params: z.output<typeof imageGenerationParamsSchema> };

/** API view: row + asset URLs (storage keys stay internal) */
export function generationView(g: ImageGenerationWithAssets) {
  const { finalPrompt: _final, ...params } = (g.params ?? {}) as Record<string, unknown>;
  return {
    id: g.id,
    novelId: g.novelId,
    provider: g.provider,
    modelId: g.modelId,
    credentialMethod: g.credentialMethod,
    prompt: g.prompt,
    params,
    imageCount: g.imageCount,
    status: g.status,
    errorFamily: g.errorFamily,
    errorMessage: g.errorMessage,
    estimatedMicros: g.estimatedMicros,
    costMicros: g.costMicros,
    costBasis: g.costBasis,
    revisedPrompt: g.revisedPrompt,
    createdAt: g.createdAt.toISOString(),
    startedAt: g.startedAt?.toISOString() ?? null,
    completedAt: g.completedAt?.toISOString() ?? null,
    assets: g.assets.map((a) => ({
      id: a.id,
      ord: a.ord,
      mimeType: a.mimeType,
      byteSize: a.byteSize,
      width: a.width,
      height: a.height,
      revisedPrompt: a.revisedPrompt,
      url: `/api/images/assets/${a.id}/file`,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

export function mountImagingRoutes({ api }: ApiRouters, svc: ImagingService): void {
  api.get("/images/providers", async (_req, res) => {
    res.json({ items: await svc.listProviders() });
  });
  api.post("/images/generations", validate({ body: createImageGenerationRequestSchema }), async (_req, res) => {
    const { body } = valid<{ body: z.output<typeof createImageGenerationRequestSchema> }>(res);
    res.status(202).json(generationView(await svc.createGeneration(body, actorOf(res))));
  });
  api.get("/images/generations", validate({ query: imageGenerationListQuerySchema }), async (_req, res) => {
    const { query } = valid<{ query: z.output<typeof imageGenerationListQuerySchema> }>(res);
    const page = await svc.listGenerations(query);
    res.json({ items: page.items.map(generationView), nextCursor: page.nextCursor });
  });
  api.get("/images/generations/:generationId", validate({ params: imageGenerationParamsSchema }), async (_req, res) => {
    const { params } = valid<GenId>(res);
    res.json(generationView(await svc.getGeneration(params.generationId)));
  });
  api.post("/images/generations/:generationId/cancel", validate({ params: imageGenerationParamsSchema }), async (_req, res) => {
    const { params } = valid<GenId>(res);
    res.json(generationView(await svc.cancelGeneration(params.generationId, actorOf(res))));
  });
  api.delete("/images/generations/:generationId", validate({ params: imageGenerationParamsSchema }), async (_req, res) => {
    const { params } = valid<GenId>(res);
    await svc.deleteGeneration(params.generationId, actorOf(res));
    res.status(204).end();
  });
  api.get("/images/assets/:assetId/file", validate({ params: imageAssetParamsSchema, query: imageAssetFileQuerySchema }), async (_req, res) => {
    const { params, query } = valid<{ params: z.output<typeof imageAssetParamsSchema>; query: z.output<typeof imageAssetFileQuerySchema> }>(res);
    const file = await svc.openAsset(params.assetId);
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    if (query.download) res.setHeader("Content-Disposition", `attachment; filename="${file.fileName}"`);
    await sendStoredFile(res, file.path, file.mimeType, "이미지 파일");
  });
}
