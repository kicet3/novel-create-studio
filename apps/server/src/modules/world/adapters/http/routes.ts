/** HTTP adapter of `world` (`…` = /api/novels/:novelId; DTOs in @ncs/shared dto/world.ts). */
import { z } from "zod";
import { worldGenerateRequestSchema, worldItemPatchRequestSchema, worldRejectRequestSchema } from "@ncs/shared";
import type { ApiRouters } from "../../../../platform/index.js";
import { actorOf, scopeOf, valid, validate } from "../../../../http/kit.js";
import type { WorldService } from "../../index.js";

const itemParams = z.object({ itemId: z.string().regex(/^woi_/) });
type P = { params: z.output<typeof itemParams> };

export function mountWorldRoutes({ novel }: ApiRouters, svc: WorldService): void {
  novel.get("/world-ontology", async (_req, res) => {
    res.json(await svc.getView(scopeOf(res)));
  });

  novel.post("/world-ontology/generate", validate({ body: worldGenerateRequestSchema }), async (_req, res) => {
    const { body } = valid<{ body: z.output<typeof worldGenerateRequestSchema> }>(res);
    res.status(202).json(await svc.requestGeneration(scopeOf(res), actorOf(res), body.instructions));
  });

  novel.post("/world-ontology/approve-all", async (_req, res) => {
    res.json(await svc.approveAll(scopeOf(res), actorOf(res)));
  });

  novel.post("/world-ontology/items/:itemId/approve", validate({ params: itemParams }), async (_req, res) => {
    const { params } = valid<P>(res);
    res.json(await svc.approveItem(scopeOf(res), params.itemId, actorOf(res)));
  });

  novel.post("/world-ontology/items/:itemId/reject", validate({ params: itemParams, body: worldRejectRequestSchema }), async (_req, res) => {
    const { params, body } = valid<P & { body: z.output<typeof worldRejectRequestSchema> }>(res);
    res.json(await svc.rejectItem(scopeOf(res), params.itemId, actorOf(res), body.reason));
  });

  novel.patch("/world-ontology/items/:itemId", validate({ params: itemParams, body: worldItemPatchRequestSchema }), async (_req, res) => {
    const { params, body } = valid<P & { body: z.output<typeof worldItemPatchRequestSchema> }>(res);
    res.json(await svc.editItem(scopeOf(res), params.itemId, body, actorOf(res)));
  });
}
