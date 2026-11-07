/** HTTP adapter of `publication` (공개 사이트 설정; DTOs: @ncs/shared dto/publication.ts). */
import type { z } from "zod";
import { updatePublicSiteNovelRequestSchema } from "@ncs/shared";
import type { ApiRouters } from "../../../../platform/index.js";
import { actorOf, scopeOf, valid, validate } from "../../../../http/kit.js";
import type { PublicationService } from "../../index.js";

export function mountPublicationRoutes({ api, novel }: ApiRouters, svc: PublicationService): void {
  api.get("/public-site", (_req, res) => {
    res.json(svc.status());
  });
  api.post("/public-site/build", async (_req, res) => {
    res.json(await svc.rebuild({ force: true }));
  });
  novel.get("/public-site", async (_req, res) => {
    res.json(await svc.getNovelSettings(scopeOf(res)));
  });
  novel.patch("/public-site", validate({ body: updatePublicSiteNovelRequestSchema }), async (_req, res) => {
    const { body } = valid<{ body: z.output<typeof updatePublicSiteNovelRequestSchema> }>(res);
    res.json(await svc.updateNovelSettings(scopeOf(res), body, actorOf(res)));
  });
}
