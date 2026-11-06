/** HTTP adapter of `continuity` (CONVENTIONS §13). */
import { z } from "zod";
import {
  listContinuityIssuesQuerySchema,
  transitionContinuityIssueRequestSchema,
  type ListContinuityIssuesQuery,
  type TransitionContinuityIssueRequest,
} from "@ncs/shared";
import { DomainValidationError, type ApiRouters, type UnitOfWork } from "../../../../platform/index.js";
import { actorOf, scopeOf, valid, validate } from "../../../../http/kit.js";
import { formatIssueNo, userTransitionsFrom } from "../../domain/transitions.js";
import type { ContinuityIssue, ContinuityService } from "../../index.js";

const issueParams = z.object({ issueId: z.string().regex(/^cis_/) });
const dto = (i: ContinuityIssue) => ({ ...i, displayLabel: formatIssueNo(i.displayNo) });

export function mountContinuityRoutes({ novel }: ApiRouters, svc: ContinuityService, uow: UnitOfWork): void {
  novel.get("/continuity-issues", validate({ query: listContinuityIssuesQuerySchema }), async (_req, res) => {
    const { query } = valid<{ query: ListContinuityIssuesQuery }>(res);
    const items = await svc.listIssues(scopeOf(res), {
      episodeId: query.episodeId,
      manuscriptVersionId: query.manuscriptVersionId,
      statuses: query.status,
      severities: query.severity,
      kinds: query.kind,
      limit: query.limit,
    });
    res.json({ items: items.map(dto) });
  });

  novel.get("/continuity-issues/:issueId", validate({ params: issueParams }), async (_req, res) => {
    const { params } = valid<{ params: { issueId: string } }>(res);
    const i = await svc.getIssue(scopeOf(res), params.issueId);
    res.json({
      ...dto(i),
      evidence: i.evidence.map((e) => ({ refType: e.refType, refId: e.refId, factVersionId: e.factVersionId, schemaRuleKey: e.schemaRuleKey, note: e.note })),
      allowedTransitions: userTransitionsFrom(i),
    });
  });

  novel.post("/continuity-issues/:issueId/transition", validate({ params: issueParams, body: transitionContinuityIssueRequestSchema }), async (_req, res) => {
    const { params, body } = valid<{ params: { issueId: string }; body: TransitionContinuityIssueRequest }>(res);
    if ((body.to === "waived" || body.to === "false_positive") && !body.note?.trim()) {
      throw new DomainValidationError("issue_note_required", "허용하거나 오탐으로 닫는 사유를 입력하세요.");
    }
    const scope = scopeOf(res);
    const actor = actorOf(res);
    const after = await uow.run((tx) =>
      svc.transitionIssue(tx, scope, params.issueId, body.to, actor, {
        resolutionKind: body.to === "resolved" ? (body.resolutionKind ?? "human_edited") : undefined,
        note: body.note,
        approvalId: body.approvalId ?? null,
      }),
    );
    res.json(dto(after));
  });
}
