/** HTTP adapter of `concept` (CONVENTIONS §13 컨셉; `…` = /api/novels/:novelId). */
import { z } from "zod";
import {
  conceptAbandonRequestSchema,
  conceptAutoApproveRequestSchema,
  conceptChangeProposalDecisionSchema,
  conceptChooseTitleRequestSchema,
  conceptConfirmRequestSchema,
  conceptEditBriefRequestSchema,
  conceptEntryModeRequestSchema,
  conceptExtendRequestSchema,
  conceptMessagesQuerySchema,
  conceptPauseRequestSchema,
  conceptPostMessageRequestSchema,
} from "@ncs/shared";
import { NotFoundError, type ApiRouters } from "../../../../platform/index.js";
import { actorOf, created, scopeOf, valid, validate } from "../../../../http/kit.js";
import type { ConceptService } from "../../index.js";
import { parseWorkingBrief } from "../../domain/brief.js";
import type { TurnStreamHub } from "../../application/turn-stream.js";
import { mountTurnStreamRoute, type TurnStreamRouteOptions } from "./stream-route.js";

const sessionParams = z.object({ sessionId: z.string().regex(/^cns_/) });
const briefParams = z.object({ briefId: z.string().regex(/^cbf_/) });
type P = { sessionId: string };

export function mountConceptRoutes({ novel }: ApiRouters, svc: ConceptService, streams?: TurnStreamHub, streamOpts?: TurnStreamRouteOptions): void {
  if (streams) mountTurnStreamRoute(novel, svc, streams, streamOpts);
  novel.get("/concept/session", async (_req, res) => {
    res.json(await svc.getSessionView(scopeOf(res)));
  });
  novel.get("/concept/goal-defaults", async (_req, res) => {
    res.json(await svc.getGoalFormDefaults(scopeOf(res)));
  });
  novel.get("/concept/sessions/:sessionId", validate({ params: sessionParams }), async (_req, res) => {
    const { params } = valid<{ params: P }>(res);
    res.json(await svc.getSessionView(scopeOf(res), params.sessionId));
  });
  novel.get("/concept/sessions/:sessionId/messages", validate({ params: sessionParams, query: conceptMessagesQuerySchema }), async (_req, res) => {
    const { params, query } = valid<{ params: P; query: { afterSeq?: number; limit?: number } }>(res);
    const items = await svc.listMessages(scopeOf(res), params.sessionId, query);
    res.json({ items, nextCursor: null, latestSeq: items.length ? items[items.length - 1]!.seq : (query.afterSeq ?? 0) });
  });
  novel.post("/concept/sessions/:sessionId/messages", validate({ params: sessionParams, body: conceptPostMessageRequestSchema }), async (_req, res) => {
    const { params, body } = valid<{ params: P; body: z.output<typeof conceptPostMessageRequestSchema> }>(res);
    const scope = scopeOf(res);
    const s = await svc.getSession(scope, params.sessionId);
    const webChannelId = parseWorkingBrief(s.workingBrief).meta.web_channel_id ?? s.activeChannelId;
    const out = await svc.postUserMessage(
      scope,
      params.sessionId,
      { body: body.body, kind: body.kind, optionValue: body.optionValue, pickedIdx: body.pickedIdx, channelId: webChannelId, rejectWhileTurnInFlight: true },
      actorOf(res),
    );
    created(res, out);
  });
  novel.patch("/concept/sessions/:sessionId/brief", validate({ params: sessionParams, body: conceptEditBriefRequestSchema }), async (_req, res) => {
    const { params, body } = valid<{ params: P; body: { path: string; value: unknown } }>(res);
    await svc.editWorkingBrief(scopeOf(res), params.sessionId, body.path, body.value ?? null, actorOf(res));
    res.json(await svc.getSessionView(scopeOf(res), params.sessionId));
  });
  novel.post("/concept/sessions/:sessionId/pause", validate({ params: sessionParams, body: conceptPauseRequestSchema }), async (_req, res) => {
    const { params } = valid<{ params: P }>(res);
    res.json(await svc.pauseSession(scopeOf(res), params.sessionId, "user", actorOf(res)));
  });
  novel.post("/concept/sessions/:sessionId/stop-turn", validate({ params: sessionParams }), async (_req, res) => {
    const { params } = valid<{ params: P }>(res);
    res.json(await svc.stopTurn(scopeOf(res), params.sessionId, actorOf(res)));
  });
  novel.post("/concept/sessions/:sessionId/auto-approve", validate({ params: sessionParams, body: conceptAutoApproveRequestSchema }), async (_req, res) => {
    const { params, body } = valid<{ params: P; body: z.output<typeof conceptAutoApproveRequestSchema> }>(res);
    await svc.setAutoApprove(scopeOf(res), params.sessionId, body, actorOf(res));
    res.json(await svc.getSessionView(scopeOf(res), params.sessionId));
  });
  novel.post("/concept/sessions/:sessionId/resume", validate({ params: sessionParams }), async (_req, res) => {
    const { params } = valid<{ params: P }>(res);
    res.json(await svc.resumeSession(scopeOf(res), params.sessionId, actorOf(res)));
  });
  novel.post("/concept/sessions/:sessionId/abandon", validate({ params: sessionParams, body: conceptAbandonRequestSchema }), async (_req, res) => {
    const { params, body } = valid<{ params: P; body: { restart: boolean } }>(res);
    if (body.restart) res.json(await svc.restartSession(scopeOf(res), params.sessionId, actorOf(res)));
    else res.json({ abandoned: await svc.abandonSession(scopeOf(res), params.sessionId, actorOf(res)), session: null });
  });
  novel.post("/concept/sessions/:sessionId/submit", validate({ params: sessionParams }), async (_req, res) => {
    const { params } = valid<{ params: P }>(res);
    res.status(202).json(await svc.submitForApproval(scopeOf(res), params.sessionId, actorOf(res)));
  });
  novel.post("/concept/sessions/:sessionId/extend", validate({ params: sessionParams, body: conceptExtendRequestSchema }), async (_req, res) => {
    const { params, body } = valid<{ params: P; body: { turns?: boolean; budgetMicros?: number } }>(res);
    res.json(await svc.extendLimit(scopeOf(res), params.sessionId, { turns: body.turns ? 1 : undefined, budgetMicros: body.budgetMicros }, actorOf(res)));
  });
  novel.post("/concept/sessions/:sessionId/entry-mode", validate({ params: sessionParams, body: conceptEntryModeRequestSchema }), async (_req, res) => {
    const { params, body } = valid<{ params: P; body: z.output<typeof conceptEntryModeRequestSchema> }>(res);
    res.json(await svc.switchEntryMode(scopeOf(res), params.sessionId, body.mode, actorOf(res)));
  });
  novel.post("/concept/sessions/:sessionId/confirm", validate({ params: sessionParams, body: conceptConfirmRequestSchema }), async (_req, res) => {
    const { params, body } = valid<{ params: P; body: z.output<typeof conceptConfirmRequestSchema> }>(res);
    await svc.confirmFields(scopeOf(res), params.sessionId, "which" in body ? body.which : { paths: body.paths }, actorOf(res));
    res.json(await svc.getSessionView(scopeOf(res), params.sessionId));
  });
  novel.post(
    "/concept/sessions/:sessionId/change-proposals/:proposalId",
    validate({ params: sessionParams.extend({ proposalId: z.string().min(1) }), body: conceptChangeProposalDecisionSchema }),
    async (_req, res) => {
      const { params, body } = valid<{ params: P & { proposalId: string }; body: { decision: "accepted" | "rejected" } }>(res);
      await svc.decideChangeProposal(scopeOf(res), params.sessionId, params.proposalId, body.decision, actorOf(res));
      res.json(await svc.getSessionView(scopeOf(res), params.sessionId));
    },
  );
  novel.post("/concept/sessions/:sessionId/title-suggestions", validate({ params: sessionParams }), async (_req, res) => {
    const { params } = valid<{ params: P }>(res);
    res.status(202).json(await svc.requestTitleSuggestions(scopeOf(res), params.sessionId, actorOf(res)));
  });
  novel.post("/concept/sessions/:sessionId/title", validate({ params: sessionParams, body: conceptChooseTitleRequestSchema }), async (_req, res) => {
    const { params, body } = valid<{ params: P; body: { title: string } }>(res);
    await svc.chooseTitle(scopeOf(res), params.sessionId, body.title, actorOf(res));
    res.json(await svc.getSessionView(scopeOf(res), params.sessionId));
  });
  novel.post("/concept/revisions", async (_req, res) => {
    created(res, await svc.startRevision(scopeOf(res), actorOf(res)));
  });
  novel.get("/concept/briefs", async (_req, res) => {
    res.json({ items: await svc.listBriefs(scopeOf(res)), nextCursor: null });
  });
  novel.get("/concept/briefs/approved", async (_req, res) => {
    res.json(await svc.getApprovedBrief(scopeOf(res)));
  });
  novel.get("/concept/briefs/:briefId", validate({ params: briefParams }), async (_req, res) => {
    const { params } = valid<{ params: { briefId: string } }>(res);
    const b = await svc.getBrief(scopeOf(res), params.briefId);
    if (!b) throw new NotFoundError("컨셉 브리프", params.briefId);
    res.json(b);
  });
}
