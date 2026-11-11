/**
 * OntologyService = PgOntologyRepository (06 §11.4) + ontology use cases. Reads take an optional trailing
 * `tx` so callers inside a transaction never touch `uow.db` (PGlite has one connection).
 */
import { and, eq } from "@ncs/db/orm";
import { identityDecisions } from "@ncs/db/schema";
import { DomainValidationError, type NovelScope, type Tx } from "../../../platform/index.js";
import type { OntologyModuleDeps } from "../module.js";
import type { OntologyService } from "../index.js";
import { initializeNovelOntology } from "../adapters/db/bootstrap.js";
import { activeSchema, getEntityRow, resolveId, resolveIds, type OntoDeps } from "../adapters/db/common.js";
import * as R from "../adapters/db/reads.js";
import * as E from "../adapters/db/entities.js";
import * as F from "../adapters/db/fact-writes.js";
import * as I from "../adapters/db/identity.js";
import { checkIntegrity, proposeSchemaChange } from "../adapters/db/integrity.js";
import * as N from "../adapters/db/non-entity.js";
import * as P from "../adapters/db/episode-purge.js";

export function createOntologyService(deps: OntologyModuleDeps): OntologyService {
  const d: OntoDeps = { platform: deps.platform, audit: deps.audit };
  const db = (tx?: Tx) => tx?.db ?? deps.platform.uow.db;

  const service: OntologyService = {
    // ── N1 / timelines / schema ──
    initializeNovel: (tx, scope, schemaVersionId) => initializeNovelOntology(deps.platform, tx, scope, schemaVersionId),
    getDefaultTimeline: (scope, tx) => R.getDefaultTimeline(db(tx), scope),
    listTimelines: (scope) => R.listTimelines(db(), scope),
    getActiveSchemaVersion: async (scope) => (await activeSchema(db(), scope)).version,
    getSchema: (scope, tx) => activeSchema(db(tx), scope),

    // ── ids / names ──
    resolveEntityId: (scope, id, tx) => resolveId(db(tx), scope, id),
    resolveEntityIds: (scope, ids, tx) => resolveIds(db(tx), scope, ids),
    findNameCandidates: (scope, key, p, tl, opts) => R.findNameCandidates(db(), scope, key, p, tl, opts),
    getTitleHolders: (scope, titleId, tl, p) => R.getTitleHolders(db(), scope, titleId, tl, p),
    nameValidAt: (scope, nameId, p, tl) => R.nameValidAt(db(), scope, nameId, p, tl),
    surfaceKnownBy: (scope, nameId, viewer, p) => R.surfaceKnownBy(db(), scope, nameId, viewer, p),
    identityKnownBy: (scope, nameId, viewer, p) => R.identityKnownBy(db(), scope, nameId, viewer, p),
    nameUsableBy: (scope, nameId, viewer, anchor) => R.nameUsableBy(db(), scope, nameId, viewer, anchor),
    listEntityNames: (scope, entityId, tx) => R.listEntityNames(db(tx), scope, entityId),

    // ── canon / knowledge ──
    getCanonAt: (scope, ids, p, tl, opts, tx) => R.getCanonAt(db(tx), scope, ids, p, tl, opts?.include),
    getCanonAsRecorded: (scope, ids, p, tl, at) => R.getCanonAsRecorded(db(), scope, ids, p, tl, at),
    knowledgeOf: (scope, viewer, p, tl) => R.knowledgeOf(db(), scope, viewer, p, tl),
    getEntityCards: (scope, ids, anchor, layer) => R.getEntityCards(db(), scope, ids, anchor, layer),
    getConstraints: (scope, q) => R.getConstraints(db(), scope, q),
    getSetupLinkedFacts: (scope, ids) => R.getFactsByIds(db(), scope, ids),

    // ── entities ──
    listEntities: (scope, filter, tx) => R.listEntities(db(tx), scope, filter),
    getEntityDetail: (scope, id) => R.getEntityDetail(db(), scope, id),
    async getEntity(scope, entityId, tx) {
      const id = await resolveId(db(tx), scope, entityId);
      const e = await getEntityRow(db(tx), scope, id);
      return { ...e, redirectedFrom: id !== entityId ? entityId : null };
    },
    async getEntities(scope, ids, tx) {
      if (ids.length === 0) return [];
      const rows = await Promise.all([...new Set(ids)].map((id) => getEntityRow(db(tx), scope, id).catch(() => null)));
      return rows.filter((r): r is NonNullable<typeof r> => !!r);
    },
    createEntity: (tx, scope, input, actor) => E.createEntity(d, tx, scope, input, actor),
    updateEntity: (tx, scope, entityId, patch, actor) => E.updateEntity(d, tx, scope, entityId, patch, actor),
    addEntityName: (tx, scope, entityId, name, actor) => E.addEntityName(d, tx, scope, entityId, name, actor),
    setPreferredName: (tx, scope, entityId, nameId, actor) => E.setPreferredName(d, tx, scope, entityId, nameId, actor),
    setEntityNameStatus: (tx, scope, nameId, to, actor) => E.setNameStatus(d, tx, scope, nameId, to, actor),
    setEntityStatus: (tx, scope, entityId, to, actor, reason) => E.setEntityStatus(d, tx, scope, entityId, to, actor, reason),
    setEquivalenceCheck: (tx, scope, entityId, check) => E.setEquivalenceCheck(d, tx, scope, entityId, check),
    listDistinctPairs: (scope, ids, tx) => R.listDistinctPairs(db(tx), scope, ids),

    // ── mentions ──
    listMentions: (scope, q, tx) => R.listMentions(db(tx), scope, q),
    recordNonEntitySurface: (tx, scope, surface, actor, note) => N.recordNonEntitySurface(d, tx, scope, surface, actor, note),
    listNonEntitySurfaces: (scope, tx) => N.listNonEntitySurfaces(db(tx), scope),
    findExactNamedEntities: (scope, surface, opts, tx) => N.findExactNamedEntities(db(tx), scope, surface, opts?.entityType),
    writeMentions: (tx, scope, mentions, actor) => E.writeMentions(d, tx, scope, mentions, actor),
    decideMention: (tx, scope, mentionId, decision, actor, ctx) => E.decideMention(d, tx, scope, mentionId, decision, actor, ctx),
    setMentionQuestion: (tx, scope, ids, questionId) => E.setMentionQuestion(d, tx, scope, ids, questionId),
    findIdentityLeaks: (scope, mvId) => R.findIdentityLeaks(db(), scope, mvId),

    // ── facts ──
    writeCandidateFacts: (tx, scope, drafts, actor) => F.writeCandidateFacts(d, tx, scope, drafts, actor),
    withdrawFacts: (tx, scope, ids, actor, reason) => F.withdrawFacts(d, tx, scope, ids, actor, reason),
    reviseCandidateFact: (tx, scope, factId, patch, actor) => F.reviseCandidateFact(d, tx, scope, factId, patch, actor),
    async approveCandidateFacts(tx, scope, factIds, actor) {
      const r = await F.promoteCandidates(d, tx, scope, { factIds: [...new Set(factIds)] }, actor);
      return { promoted: r.promoted, held: r.held, heldReasons: r.heldReasons };
    },
    getFactsByIds: (scope, ids, tx) => R.getFactsByIds(db(tx), scope, ids),
    async promoteEpisodeFacts(tx, scope, episodeId, to, actor) {
      if (to === "approved") {
        const r = await F.promoteCandidates(d, tx, scope, { episodeId }, actor);
        return { promoted: r.promoted, held: r.held };
      }
      if (to === "published_locked") return { promoted: await F.relockEpisodeFacts(d, tx, scope, episodeId, "approved", "published_locked", actor), held: [] };
      throw new DomainValidationError("invalid_promotion", "지원하지 않는 승격 상태입니다.");
    },
    async demoteEpisodeFacts(tx, scope, episodeId, actor) {
      return { demoted: await F.relockEpisodeFacts(d, tx, scope, episodeId, "published_locked", "approved", actor) };
    },
    listEpisodeFacts: (scope, episodeId, tx) => F.listEpisodeFacts(db(tx), scope, episodeId),
    factVersionUsage: (scope, versionIds, tx) => F.factVersionUsage(db(tx), scope, versionIds),
    retireFacts: (tx, scope, changes, actor, opts) => F.retireFacts(d, tx, scope, changes, actor, opts),
    pruneFactMentions: (tx, scope, ids, versions) => F.pruneFactMentions(d, tx, scope, ids, versions),
    // 설계 추가(화 삭제)
    previewManuscriptPurge: (scope, input, tx) => P.previewManuscriptPurge(db(tx), scope, input),
    purgeManuscriptVersions: (tx, scope, input, actor, opts) => P.purgeManuscriptVersions(d, tx, scope, input, actor, opts),
    setFactReconcileHold: (tx, scope, ids, pending, actor) => F.setFactReconcileHold(d, tx, scope, ids, pending, actor),
    markFactsKeptByDecision: (tx, scope, marks, approvalId, actor) => F.markFactsKeptByDecision(d, tx, scope, marks, approvalId, actor),
    async approveBibleFacts(tx, scope, bibleId, actor) {
      const r = await F.approveBible(d, tx, scope, bibleId, actor);
      return { approved: r.approved };
    },
    async findSchemaViolations(scope, factIds) {
      const { schema } = await activeSchema(db(), scope);
      const found = await F.schemaFindings(db(), scope, schema, factIds);
      return found.map((v) => ({ factId: v.factId, rule: v.rule, message: v.message, crRule: v.crRule, schemaRuleKey: v.schemaRuleKey, severity: v.severity, relatedFactIds: v.relatedFactIds }));
    },
    proposeSchemaChange: (tx, scope, input, actor) => proposeSchemaChange(d, tx, scope, input, actor),

    // ── identity ──
    computeIdentityImpact: async (scope, ids, tx) => I.computeIdentityImpact(db(tx), scope, [...(await resolveIds(db(tx), scope, ids)).values()]),
    computeRelinkImpact: (scope, mentionIds, to, tx) => I.computeRelinkImpact(db(tx), scope, mentionIds, to),
    proposeIdentityDecision: (tx, scope, input, actor) => I.proposeDecision(d, tx, scope, input, actor),
    applyIdentityDecision: (tx, scope, id, actor) => I.applyDecision(d, tx, scope, id, actor),
    revertIdentityDecision: (tx, scope, id, actor) => I.revertDecision(d, tx, scope, id, actor),
    rejectIdentityDecision: (tx, scope, id, actor, reason) => I.rejectDecision(d, tx, scope, id, actor, reason),
    getIdentityDecision: (scope, id, tx) => I.getDecision(db(tx), scope, id),
    listIdentityDecisions: (scope, q, tx) => I.listDecisions(db(tx), scope, q),
    async setIdentityDecisionRefs(tx, scope, id, refs) {
      await tx.db
        .update(identityDecisions)
        .set({ ...(refs.questionId !== undefined ? { questionId: refs.questionId } : {}), ...(refs.approvalId !== undefined ? { approvalId: refs.approvalId } : {}), updatedAt: deps.platform.clock.date() })
        .where(and(eq(identityDecisions.novelId, scope.novelId), eq(identityDecisions.id, id)));
    },
    findDuplicateCandidates: (scope, entityId, tx) => I.findDuplicateCandidates(db(tx), scope, entityId),

    // ── health ──
    checkIntegrity: (scope: NovelScope) => checkIntegrity(db(), scope),
  };
  return service;
}
