/** HTTP adapter of `autopilot` (`…` = /api/novels/:novelId; DTOs in @ncs/shared dto/autopilot.ts). */
import type { z } from "zod";
import { autopilotHaltRequestSchema, autopilotSettingsPatchSchema } from "@ncs/shared";
import type { ApiRouters } from "../../../../platform/index.js";
import { actorOf, scopeOf, valid, validate } from "../../../../http/kit.js";
import type { NovelService } from "../../../novel/index.js";
import type { AutopilotService } from "../../index.js";

export function mountAutopilotRoutes({ novel }: ApiRouters, svc: AutopilotService, novels: NovelService): void {
  novel.get("/autopilot", async (_req, res) => {
    res.json(await svc.getView(scopeOf(res)));
  });
  novel.patch("/autopilot/settings", validate({ body: autopilotSettingsPatchSchema }), async (_req, res) => {
    const { body } = valid<{ body: z.output<typeof autopilotSettingsPatchSchema> }>(res);
    const { acknowledgedStructureAutoWarning, ...settings } = body;
    await novels.updateAutopilotSettings(scopeOf(res), { settings, acknowledgedStructureAutoWarning }, actorOf(res));
    res.json(await svc.getView(scopeOf(res)));
  });
  novel.post("/autopilot/halt", validate({ body: autopilotHaltRequestSchema }), async (_req, res) => {
    const { body } = valid<{ body: z.output<typeof autopilotHaltRequestSchema> }>(res);
    res.json(await svc.halt(scopeOf(res), body, actorOf(res)));
  });
  novel.post("/autopilot/resume", async (_req, res) => {
    res.json(await svc.resume(scopeOf(res), actorOf(res)));
  });
}
