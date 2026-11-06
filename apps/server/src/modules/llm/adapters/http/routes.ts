/** HTTP adapter of `llm` (CONVENTIONS §13). */
import type { z } from "zod";
import {
  llmTestRequestSchema,
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
