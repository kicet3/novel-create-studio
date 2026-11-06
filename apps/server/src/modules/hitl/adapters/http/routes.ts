/** HTTP adapter of `hitl` (CONVENTIONS §13 "인박스 (hitl)"). */
import { z } from "zod";
import {
  hitlAnswerRequestSchema,
  hitlApprovalDecisionRequestSchema,
  hitlApprovalListQuerySchema,
  hitlLateAnswerResolutionRequestSchema,
  hitlQuestionListQuerySchema,
} from "@ncs/shared";
import { AppError, type ApiRouters, type NovelScope, type Platform } from "../../../../platform/index.js";
import { actorOf, created, scopeOf, valid, validate } from "../../../../http/kit.js";
import type { MessagingService } from "../../../messaging/index.js";
import type { HitlService } from "../../index.js";
import { hitlRepo as repo } from "../db/hitl-repository.js";

const qParams = z.object({ questionId: z.string().regex(/^qst_/) });
const aParams = z.object({ approvalId: z.string().regex(/^apr_/) });
const ansParams = z.object({ answerId: z.string().regex(/^ans_/) });
type Body<S extends z.ZodType> = { body: z.output<S> };

export function mountHitlRoutes({ novel }: ApiRouters, svc: HitlService, messaging: MessagingService, platform: Platform): void {
  const webChannelId = async (scope: NovelScope) => {
    const web = (await messaging.preferredChannels(scope)).find((c) => c.kind === "web");
    if (!web) throw new AppError(500, "web_channel_missing", "웹 인박스 채널이 없습니다.");
    return web.id;
  };

  novel.get("/inbox/summary", async (_req, res) => {
    res.json(await svc.inboxSummary(scopeOf(res)));
  });

  novel.get("/questions", validate({ query: hitlQuestionListQuerySchema }), async (_req, res) => {
    const { query } = valid<{ query: z.output<typeof hitlQuestionListQuerySchema> }>(res);
    const items = await svc.listQuestions(scopeOf(res), { statuses: query.status, grades: query.grade, topics: query.topic, limit: query.limit });
    res.json({ items, nextCursor: null });
  });

  novel.get("/questions/:questionId", validate({ params: qParams }), async (_req, res) => {
    const { params } = valid<{ params: { questionId: string } }>(res);
    const scope = scopeOf(res);
    const view = await svc.getQuestionView(scope, params.questionId);
    const db = platform.uow.db;
    const approval = await repo.approvalByQuestion(db, scope, params.questionId);
    const refl = await repo.reflectionByQuestion(db, scope, params.questionId);
    const items = refl ? await repo.listReflectionItems(db, scope, refl.id) : [];
    res.json({
      ...view,
      approval,
      reflection: refl ? { status: refl.status, notAppliedReason: refl.notAppliedReason, items: items.map((i) => ({ changeKind: i.changeKind, refType: i.refType, refId: i.refId, summary: i.summary })) } : null,
    });
  });

  novel.post("/questions/:questionId/open", validate({ params: qParams }), async (_req, res) => {
    const { params } = valid<{ params: { questionId: string } }>(res);
    res.json(await svc.openFromWeb(scopeOf(res), params.questionId, actorOf(res)));
  });

  novel.post("/questions/:questionId/answers", validate({ params: qParams, body: hitlAnswerRequestSchema }), async (req, res) => {
    const { params, body } = valid<{ params: { questionId: string } } & Body<typeof hitlAnswerRequestSchema>>(res);
    const scope = scopeOf(res);
    const actor = actorOf(res);
    const result = await svc.acceptAnswer(scope, {
      questionId: params.questionId,
      channelId: await webChannelId(scope),
      responderUserId: actor.id,
      optionIds: body.optionIds,
      text: body.text ?? null,
      approval: body.approval,
      sourceKey: `web:${body.requestId ?? `${req.headers["x-request-id"] ?? platform.ids.next("ans")}`}`,
    });
    created(res, result);
  });

  novel.post("/answers/:answerId/late-resolution", validate({ params: ansParams, body: hitlLateAnswerResolutionRequestSchema }), async (_req, res) => {
    const { params, body } = valid<{ params: { answerId: string } } & Body<typeof hitlLateAnswerResolutionRequestSchema>>(res);
    res.json(await svc.resolveLateAnswer(scopeOf(res), params.answerId, body.resolution, actorOf(res)));
  });

  novel.get("/approvals", validate({ query: hitlApprovalListQuerySchema }), async (_req, res) => {
    const { query } = valid<{ query: z.output<typeof hitlApprovalListQuerySchema> }>(res);
    res.json({ items: await svc.listApprovals(scopeOf(res), { statuses: query.status, types: query.type }), nextCursor: null });
  });

  novel.get("/approvals/:approvalId", validate({ params: aParams }), async (_req, res) => {
    const { params } = valid<{ params: { approvalId: string } }>(res);
    const scope = scopeOf(res);
    const approval = await svc.getApproval(scope, params.approvalId);
    res.json({ ...approval, question: await svc.getQuestionView(scope, approval.questionId) });
  });

  novel.post("/approvals/:approvalId/decision", validate({ params: aParams, body: hitlApprovalDecisionRequestSchema }), async (req, res) => {
    const { params, body } = valid<{ params: { approvalId: string } } & Body<typeof hitlApprovalDecisionRequestSchema>>(res);
    const scope = scopeOf(res);
    const actor = actorOf(res);
    const approval = await svc.getApproval(scope, params.approvalId);
    const result = await svc.acceptAnswer(scope, {
      questionId: approval.questionId,
      channelId: await webChannelId(scope),
      responderUserId: actor.id,
      approval: body,
      sourceKey: `web:${req.headers["x-request-id"] ?? platform.ids.next("ans")}`,
    });
    res.json({ ...result, approval: await svc.getApproval(scope, params.approvalId) });
  });
}
