/** HTTP adapter of `ontology` (CONVENTIONS §13 온톨로지, 08 §9.5). */
import { z } from "zod";
import {
  addEntityNameRequestSchema,
  createEntityRequestSchema,
  entityFactsQuerySchema,
  listEntitiesQuerySchema,
  listEntityMentionsQuerySchema,
  listIdentityDecisionsQuerySchema,
  revertIdentityDecisionRequestSchema,
} from "@ncs/shared";
import type { ApiRouters, UnitOfWork } from "../../../../platform/index.js";
import { actorOf, created, scopeOf, valid, validate } from "../../../../http/kit.js";
import type { OntologyService } from "../../index.js";

const entityParams = z.object({ entityId: z.string().regex(/^ent_/) });
const decisionParams = z.object({ id: z.string().regex(/^idd_/) });
type V<T> = T;

export function mountOntologyRoutes({ novel }: ApiRouters, svc: OntologyService, uow: UnitOfWork): void {
  novel.get("/entities", validate({ query: listEntitiesQuerySchema }), async (_req, res) => {
    const { query } = valid<{ query: z.output<typeof listEntitiesQuerySchema> }>(res);
    res.json({ items: await svc.listEntities(scopeOf(res), { entityTypes: query.type, statuses: query.status, q: query.q, limit: query.limit }), nextCursor: null });
  });

  novel.post("/entities", validate({ body: createEntityRequestSchema }), async (_req, res) => {
    const { body } = valid<{ body: z.output<typeof createEntityRequestSchema> }>(res);
    const scope = scopeOf(res);
    const r = await uow.run((tx) =>
      svc.createEntity(tx, scope, { entityType: body.entityType, preferredName: { surface: body.preferredName, nameKind: body.nameKind }, disambiguator: body.disambiguator, summary: body.summary, status: "active" }, actorOf(res)),
    );
    // EN2 guard (06 §3.10): show same-key entities so the UI can offer a duplicate check
    const similar = (await svc.findDuplicateCandidates(scope, r.entity.id)).filter((c) => c.score >= 0.5);
    created(res, { ...r, similar });
  });

  novel.get("/entities/:entityId", validate({ params: entityParams }), async (_req, res) => {
    const { params } = valid<V<{ params: { entityId: string } }>>(res);
    const scope = scopeOf(res);
    const resolved = await svc.resolveEntityId(scope, params.entityId);
    if (resolved !== params.entityId) {
      res.json({ redirectTo: resolved, redirectedFrom: params.entityId });
      return;
    }
    res.json({ ...(await svc.getEntityDetail(scope, resolved)), redirectedFrom: null });
  });

  novel.get("/entities/:entityId/mentions", validate({ params: entityParams, query: listEntityMentionsQuerySchema }), async (_req, res) => {
    const { params, query } = valid<{ params: { entityId: string }; query: z.output<typeof listEntityMentionsQuerySchema> }>(res);
    res.json({ items: await svc.listMentions(scopeOf(res), { entityId: params.entityId, linkStatus: query.linkStatus, limit: query.limit }), nextCursor: null });
  });

  novel.get("/entities/:entityId/facts", validate({ params: entityParams, query: entityFactsQuerySchema }), async (_req, res) => {
    const { params, query } = valid<{ params: { entityId: string }; query: z.output<typeof entityFactsQuerySchema> }>(res);
    const scope = scopeOf(res);
    const id = await svc.resolveEntityId(scope, params.entityId);
    if (query.storyPoint === undefined) {
      res.json({ items: (await svc.getEntityDetail(scope, id)).factsSummary, redirectedFrom: id !== params.entityId ? params.entityId : null });
      return;
    }
    const timelineId = query.timelineId ?? (await svc.getDefaultTimeline(scope)).id;
    res.json({
      items: await svc.getCanonAt(scope, [id], query.storyPoint, timelineId, { include: query.include ?? "canon" }),
      redirectedFrom: id !== params.entityId ? params.entityId : null,
    });
  });

  novel.post("/entities/:entityId/names", validate({ params: entityParams, body: addEntityNameRequestSchema }), async (_req, res) => {
    const { params, body } = valid<{ params: { entityId: string }; body: z.output<typeof addEntityNameRequestSchema> }>(res);
    const scope = scopeOf(res);
    created(res, await uow.run((tx) => svc.addEntityName(tx, scope, params.entityId, { ...body, status: "active" }, actorOf(res))));
  });

  novel.get("/timelines", async (_req, res) => {
    res.json({ items: await svc.listTimelines(scopeOf(res)) });
  });

  novel.get("/schema", async (_req, res) => {
    const { version, schema } = await svc.getSchema(scopeOf(res));
    res.json({ versionId: version.id, versionNo: version.versionNo, baseSchemaKey: version.baseSchemaKey, entityTypes: schema.entityTypes, relationTypes: schema.relationTypes, attributes: schema.attributes });
  });

  novel.get("/identity-decisions", validate({ query: listIdentityDecisionsQuerySchema }), async (_req, res) => {
    const { query } = valid<{ query: z.output<typeof listIdentityDecisionsQuerySchema> }>(res);
    const scope = scopeOf(res);
    const entityId = query.entityId ? await svc.resolveEntityId(scope, query.entityId).catch(() => query.entityId) : undefined;
    res.json({ items: await svc.listIdentityDecisions(scope, { entityId, statuses: query.status }), nextCursor: null });
  });

  novel.get("/identity-decisions/:id/impact", validate({ params: decisionParams }), async (_req, res) => {
    const { params } = valid<{ params: { id: string } }>(res);
    const scope = scopeOf(res);
    const dec = await svc.getIdentityDecision(scope, params.id);
    const impact =
      dec.kind === "relink" && dec.relinkToEntityId
        ? await svc.computeRelinkImpact(scope, dec.relinkMentionIds, dec.relinkToEntityId)
        : await svc.computeIdentityImpact(scope, dec.survivorEntityId ? [dec.survivorEntityId, ...dec.sourceEntityIds.filter((x) => x !== dec.survivorEntityId)] : dec.sourceEntityIds);
    res.json({ ...impact, requiresApproval: (impact.factsByStatus?.published_locked ?? 0) > 0 });
  });

  novel.post("/identity-decisions/:id/revert", validate({ params: decisionParams, body: revertIdentityDecisionRequestSchema }), async (_req, res) => {
    const { params } = valid<{ params: { id: string } }>(res);
    const scope = scopeOf(res);
    res.json(await uow.run((tx) => svc.revertIdentityDecision(tx, scope, params.id, actorOf(res))));
  });
}
