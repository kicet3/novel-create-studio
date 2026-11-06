/** HTTP adapter of `novel` (see CONVENTIONS.md §API). */
import { z } from "zod";
import {
  changeAutonomyRequestSchema,
  changeNovelStatusRequestSchema,
  createArcRequestSchema,
  createNovelRequestSchema,
  pauseNovelRequestSchema,
  queryBool,
  saveGoalRequestSchema,
  updateArcRequestSchema,
  updateLengthProfileRequestSchema,
  updateNotificationPolicyRequestSchema,
  updateNovelSettingsRequestSchema,
} from "@ncs/shared";
import type { ApiRouters, UnitOfWork } from "../../../../platform/index.js";
import { ConflictError, NotFoundError } from "../../../../platform/index.js";
import { actorOf, created, scopeOf, valid, validate } from "../../../../http/kit.js";
import type { NovelService } from "../../index.js";

type Body<S extends z.ZodType> = { body: z.output<S> };
const arcParams = z.object({ arcId: z.string().regex(/^arc_/) });
const bibleParams = z.object({ bibleId: z.string().regex(/^bib_/) });

export function mountNovelRoutes({ api, novel }: ApiRouters, svc: NovelService, uow: UnitOfWork): void {
  // ── install level ──
  api.get("/me", async (_req, res) => {
    const user = await svc.getOwnerUser();
    if (!user) throw new NotFoundError("사용자");
    res.json({ id: user.id, displayName: user.displayName, role: user.role });
  });
  api.get("/length-profiles", async (_req, res) => {
    res.json({ items: await svc.listLengthPresets() });
  });
  api.get("/novels", validate({ query: z.object({ includeArchived: queryBool.optional() }) }), async (_req, res) => {
    const { query } = valid<{ query: { includeArchived?: boolean } }>(res);
    res.json({ items: await svc.listNovels({ includeArchived: query.includeArchived ?? false }) });
  });
  api.post("/novels", validate({ body: createNovelRequestSchema }), async (_req, res) => {
    const { body } = valid<Body<typeof createNovelRequestSchema>>(res);
    created(res, await svc.createNovel(body, actorOf(res)));
  });

  // ── /api/novels/:novelId ──
  novel.get("/", async (_req, res) => {
    res.json(await svc.getNovel(scopeOf(res)));
  });
  novel.patch("/", validate({ body: updateNovelSettingsRequestSchema }), async (_req, res) => {
    const { body } = valid<Body<typeof updateNovelSettingsRequestSchema>>(res);
    res.json(await svc.updateSettings(scopeOf(res), body, actorOf(res)));
  });
  novel.put("/autonomy", validate({ body: changeAutonomyRequestSchema }), async (_req, res) => {
    const { body } = valid<Body<typeof changeAutonomyRequestSchema>>(res);
    res.json(await svc.changeAutonomy(scopeOf(res), body, actorOf(res)));
  });
  novel.post("/pause", validate({ body: pauseNovelRequestSchema }), async (_req, res) => {
    const { body } = valid<Body<typeof pauseNovelRequestSchema>>(res);
    res.json(await svc.pause(scopeOf(res), "user", actorOf(res), { note: body.reason }));
  });
  novel.post("/resume", validate({ body: pauseNovelRequestSchema }), async (_req, res) => {
    const { body } = valid<Body<typeof pauseNovelRequestSchema>>(res);
    // system pauses are lifted only by their own flow (budget resume approval / integrity check)
    const current = await svc.getNovel(scopeOf(res));
    if (current.pausedAt && current.pauseReason === "budget_hard_limit") {
      throw new ConflictError("budget_resume_required", "예산 한도로 멈춘 작품은 예산 재개 승인 후에 다시 시작합니다.");
    }
    if (current.pausedAt && current.pauseReason === "ontology_integrity") {
      throw new ConflictError("integrity_check_required", "온톨로지 무결성 점검을 통과해야 다시 시작할 수 있습니다.");
    }
    res.json(await svc.resume(scopeOf(res), actorOf(res), { note: body.reason }));
  });
  novel.post("/status", validate({ body: changeNovelStatusRequestSchema }), async (_req, res) => {
    const { body } = valid<Body<typeof changeNovelStatusRequestSchema>>(res);
    res.json(await uow.run((tx) => svc.transitionStatus(tx, scopeOf(res), body.to, actorOf(res), body.reason)));
  });

  // goal
  novel.get("/goal", async (_req, res) => {
    res.json(await svc.getGoal(scopeOf(res)));
  });
  novel.put("/goal", validate({ body: saveGoalRequestSchema }), async (_req, res) => {
    const { body } = valid<Body<typeof saveGoalRequestSchema>>(res);
    res.json(await svc.saveGoal(scopeOf(res), body, actorOf(res)));
  });

  // series bibles (read-only over HTTP; writes come from planning tasks and approvals)
  novel.get("/bibles", async (_req, res) => {
    res.json({ items: await svc.listBibles(scopeOf(res)) });
  });
  novel.get("/bibles/approved", async (_req, res) => {
    res.json(await svc.getApprovedBible(scopeOf(res)));
  });
  novel.get("/bibles/:bibleId", validate({ params: bibleParams }), async (_req, res) => {
    const { params } = valid<{ params: z.output<typeof bibleParams> }>(res);
    res.json(await svc.getBible(scopeOf(res), params.bibleId));
  });

  // arcs
  novel.get("/arcs", async (_req, res) => {
    res.json({ items: await svc.listArcs(scopeOf(res)) });
  });
  novel.post("/arcs", validate({ body: createArcRequestSchema }), async (_req, res) => {
    const { body } = valid<Body<typeof createArcRequestSchema>>(res);
    created(res, await svc.createArc(undefined, scopeOf(res), body, actorOf(res)));
  });
  novel.get("/arcs/:arcId", validate({ params: arcParams }), async (_req, res) => {
    const { params } = valid<{ params: z.output<typeof arcParams> }>(res);
    res.json(await svc.getArc(scopeOf(res), params.arcId));
  });
  novel.patch("/arcs/:arcId", validate({ params: arcParams, body: updateArcRequestSchema }), async (_req, res) => {
    const { params, body } = valid<{ params: z.output<typeof arcParams> } & Body<typeof updateArcRequestSchema>>(res);
    res.json(await svc.updateArc(scopeOf(res), params.arcId, body, actorOf(res)));
  });
  novel.post("/arcs/:arcId/pause", validate({ params: arcParams }), async (_req, res) => {
    const { params } = valid<{ params: z.output<typeof arcParams> }>(res);
    res.json(await svc.setArcPaused(scopeOf(res), params.arcId, true, actorOf(res)));
  });
  novel.post("/arcs/:arcId/resume", validate({ params: arcParams }), async (_req, res) => {
    const { params } = valid<{ params: z.output<typeof arcParams> }>(res);
    res.json(await svc.setArcPaused(scopeOf(res), params.arcId, false, actorOf(res)));
  });

  // length profile & notification policy
  novel.get("/length-profile", async (_req, res) => {
    res.json(await svc.getLengthProfile(scopeOf(res)));
  });
  novel.patch("/length-profile", validate({ body: updateLengthProfileRequestSchema }), async (_req, res) => {
    const { body } = valid<Body<typeof updateLengthProfileRequestSchema>>(res);
    res.json(await svc.updateLengthProfile(scopeOf(res), body, actorOf(res)));
  });
  novel.get("/notification-policy", async (_req, res) => {
    res.json(await svc.getNotificationPolicy(scopeOf(res)));
  });
  novel.patch("/notification-policy", validate({ body: updateNotificationPolicyRequestSchema }), async (_req, res) => {
    const { body } = valid<Body<typeof updateNotificationPolicyRequestSchema>>(res);
    res.json(await svc.updateNotificationPolicy(scopeOf(res), body, actorOf(res)));
  });
}
