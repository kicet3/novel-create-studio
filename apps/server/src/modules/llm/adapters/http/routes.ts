/** HTTP adapter of `llm` (CONVENTIONS §13). */
import type { z } from "zod";
import {
  llmAddModelRequestSchema,
  llmCallProviderParamsSchema,
  llmEditModelRequestSchema,
  llmProfileModelParamsSchema,
  llmTestRequestSchema,
  resetRoleModelDefaultsQuerySchema,
  updateRoleModelDefaultsRequestSchema,
  llmUpdateProviderProfileRequestSchema,
  providerCallParamsSchema,
  roleModelBindingParamsSchema,
  updateRoleModelBindingRequestSchema,
} from "@ncs/shared";
import { z as zod } from "zod";
import type { ApiRouters } from "../../../../platform/index.js";
import { actorOf, scopeOf, valid, validate } from "../../../../http/kit.js";
import type { LlmService } from "../../index.js";

type V<P = unknown, B = unknown> = { params: P; body: B };

export function mountLlmRoutes({ api, novel }: ApiRouters, svc: LlmService): void {
  // ── install level ──
  api.get("/llm/provider-profiles", async (_req, res) => {
    res.json({ items: await svc.listProviderProfiles() });
  });
  api.patch(
    "/llm/provider-profiles/:profileId",
    validate({ params: zod.object({ profileId: zod.string().regex(/^prv_/) }), body: llmUpdateProviderProfileRequestSchema }),
    async (_req, res) => {
      const { params, body } = valid<V<{ profileId: string }, z.output<typeof llmUpdateProviderProfileRequestSchema>>>(res);
      res.json(
        await svc.updateProviderProfile(
          params.profileId,
          { ...body, verifiedAt: body.verifiedAt ? new Date(body.verifiedAt) : undefined },
          actorOf(res),
        ),
      );
    },
  );
  // install settings → 모델: model-list edits (each a new profile version)
  const profileParams = zod.object({ profileId: zod.string().regex(/^prv_/) });
  api.post("/llm/provider-profiles/:profileId/models", validate({ params: profileParams, body: llmAddModelRequestSchema }), async (_req, res) => {
    const { params, body } = valid<V<{ profileId: string }, z.output<typeof llmAddModelRequestSchema>>>(res);
    res.status(201).json(await svc.addProfileModel(params.profileId, body, actorOf(res)));
  });
  api.patch("/llm/provider-profiles/:profileId/models/:modelId", validate({ params: llmProfileModelParamsSchema, body: llmEditModelRequestSchema }), async (_req, res) => {
    const { params, body } = valid<V<z.output<typeof llmProfileModelParamsSchema>, z.output<typeof llmEditModelRequestSchema>>>(res);
    res.json(await svc.editProfileModel(params.profileId, params.modelId, body, actorOf(res)));
  });
  api.delete("/llm/provider-profiles/:profileId/models/:modelId", validate({ params: llmProfileModelParamsSchema }), async (_req, res) => {
    const { params } = valid<V<z.output<typeof llmProfileModelParamsSchema>>>(res);
    res.json(await svc.removeProfileModel(params.profileId, params.modelId, actorOf(res)));
  });
  api.post("/llm/provider-profiles/:profileId/reset-models", validate({ params: profileParams }), async (_req, res) => {
    const { params } = valid<V<{ profileId: string }>>(res);
    res.json(await svc.resetProfileModels(params.profileId, actorOf(res)));
  });
  api.get("/llm/providers/:provider/available-models", validate({ params: llmCallProviderParamsSchema }), async (_req, res) => {
    const { params } = valid<V<z.output<typeof llmCallProviderParamsSchema>>>(res);
    // the client went away before the answer: stop asking the provider
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
    });
    res.json(await svc.listAvailableModels(params.provider, ac.signal));
  });
  // 새 작품 기본 모델 (install level)
  api.get("/llm/role-defaults", async (_req, res) => {
    res.json({ items: await svc.listRoleDefaults() });
  });
  api.put("/llm/role-defaults", validate({ body: updateRoleModelDefaultsRequestSchema }), async (_req, res) => {
    const { body } = valid<V<unknown, z.output<typeof updateRoleModelDefaultsRequestSchema>>>(res);
    res.json({ items: await svc.setRoleDefaults(body.items, actorOf(res)) });
  });
  api.delete("/llm/role-defaults", validate({ query: resetRoleModelDefaultsQuerySchema }), async (_req, res) => {
    const { query } = valid<{ query: z.output<typeof resetRoleModelDefaultsQuerySchema> }>(res);
    res.json({ items: await svc.resetRoleDefaults(query.role, actorOf(res)) });
  });

  api.post("/llm/test", validate({ body: llmTestRequestSchema }), async (_req, res) => {
    const { body } = valid<V<unknown, z.output<typeof llmTestRequestSchema>>>(res);
    res.json(await svc.testConnection(body));
  });

  // ── /api/novels/:novelId ──
  novel.get("/model-bindings", async (_req, res) => {
    res.json({ items: await svc.listBindings(scopeOf(res)) });
  });
  novel.patch("/model-bindings/:role", validate({ params: roleModelBindingParamsSchema, body: updateRoleModelBindingRequestSchema }), async (_req, res) => {
    const { params, body } = valid<V<z.output<typeof roleModelBindingParamsSchema>, z.output<typeof updateRoleModelBindingRequestSchema>>>(res);
    res.json(await svc.updateBinding(scopeOf(res), params.role, body, actorOf(res)));
  });
  novel.get("/runs/:runId/provider-calls", validate({ params: providerCallParamsSchema }), async (_req, res) => {
    const { params } = valid<V<{ runId: string }>>(res);
    res.json({ items: await svc.listProviderCalls(scopeOf(res), params.runId) });
  });
}
