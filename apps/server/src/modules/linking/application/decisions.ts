/**
 * Human decisions on links (06 §3.10, 05 §3.6): confirmMention / relinkMentions / disambiguation options,
 * hitl answer appliers (`entity_disambiguation`, `duplicate_entity`) and the `identity_change` approval handler.
 */
import { ConflictError, DomainValidationError, NotFoundError, type ActorRef, type NovelScope, type Tx } from "../../../platform/index.js";
import type { AnswerApplier, ApprovalHandler, HitlService } from "../../hitl/index.js";
import type { NovelService } from "../../novel/index.js";
import { normalizedKey, type Mention, type OntologyService } from "../../ontology/index.js";
import type { DisambiguationOptions, LinkingService } from "../index.js";
import { classifySurface, isCoreferenceOnly } from "../domain/salience.js";
import { agentSettings, HOLD, MAX_CARD_OPTIONS, NEW_ENTITY, NOT_ENTITY } from "./commit.js";

export interface DecisionDeps {
  ontology: OntologyService;
  hitl: HitlService;
  /** 설계 추가 0015: entity resolver setting (alias / non-entity memory of answers) */
  novel?: NovelService;
}

/**
 * 설계 추가 0015 alias memory: a surface that was resolved to an entity (by the author or the resolver) becomes an active
 * alias of it, so the next episode links it deterministically (no question, no model call). Pronouns / generic address
 * forms are never stored (the same word points at different people). Returns the new name id, or null.
 */
export async function rememberAlias(d: DecisionDeps, tx: Tx, scope: NovelScope, entityId: string, m: Pick<Mention, "surface" | "mentionKind">, actor: ActorRef): Promise<string | null> {
  const surface = m.surface.trim();
  if (!surface || m.mentionKind === "zero" || m.mentionKind === "pronoun" || isCoreferenceOnly(classifySurface(surface, m.mentionKind))) return null;
  const e = await d.ontology.getEntity(scope, entityId, tx).catch(() => null);
  if (!e || (e.status !== "active" && e.status !== "candidate")) return null;
  const key = normalizedKey(surface);
  const names = await d.ontology.listEntityNames(scope, e.id, tx);
  const same = names.find((n) => n.normalizedKey === key);
  if (same) {
    if (same.status === "proposed") await d.ontology.setEntityNameStatus(tx, scope, same.id, "active", actor).catch(() => undefined);
    return null;
  }
  // another live entity already owns this exact name: an alias would make the next link ambiguous
  const owners = await d.ontology.findExactNamedEntities(scope, surface, {}, tx);
  if (owners.some((o) => o.entityId !== e.id)) return null;
  const n = await d.ontology.addEntityName(tx, scope, e.id, { surface, nameKind: "alias", status: "active" }, actor);
  return n.id;
}

/** 설계 추가 0015 non-entity memory (glossary_terms category non_entity); pronouns are covered by the fixed list */
export async function rememberNotEntity(d: DecisionDeps, tx: Tx, scope: NovelScope, m: Pick<Mention, "surface" | "mentionKind">, actor: ActorRef, note?: string): Promise<void> {
  if (!m.surface.trim() || m.mentionKind === "zero" || isCoreferenceOnly(classifySurface(m.surface, m.mentionKind))) return;
  // a name some entity carries is not a generic word
  if ((await d.ontology.findExactNamedEntities(scope, m.surface, {}, tx)).length) return;
  await d.ontology.recordNonEntitySurface(tx, scope, m.surface, actor, note);
}

type Decision = Parameters<LinkingService["confirmMention"]>[3];

export async function confirmMention(d: DecisionDeps, tx: Tx, scope: NovelScope, mentionId: string, decision: Decision, actor: ActorRef, ctx: { questionId?: string; answerId?: string } = {}): Promise<{ entityId: string | null }> {
  const [m] = await d.ontology.listMentions(scope, { ids: [mentionId] }, tx);
  if (!m) throw new NotFoundError("언급", mentionId);
  if (decision.kind === "not_entity") {
    await d.ontology.decideMention(tx, scope, mentionId, { kind: "not_entity" }, actor, ctx);
    return { entityId: null };
  }
  let entityId: string;
  if (decision.kind === "entity") entityId = decision.entityId;
  else {
    // "새 인물": reuse the L5 candidate entity when the mention already points at one (EN3(c)), else create (EN2)
    const linked = m.linkedEntityId ? await d.ontology.getEntity(scope, m.linkedEntityId, tx) : null;
    if (linked && linked.status === "candidate" && m.linkStatus === "new_entity_candidate") {
      await d.ontology.setEquivalenceCheck(tx, scope, linked.id, { status: "passed", duplicateOf: null });
      await d.ontology.setEntityStatus(tx, scope, linked.id, "active", actor, "새 인물 답변");
      entityId = linked.id;
    } else {
      const surface = decision.preferredName || m.surface;
      if (!surface) throw new DomainValidationError("name_required", "새 엔티티의 이름이 필요합니다.");
      const r = await d.ontology.createEntity(tx, scope, { entityType: (decision.entityType || "character") as never, preferredName: { surface }, status: "active", createdFromMentionId: mentionId }, actor);
      entityId = r.entity.id;
    }
  }
  const r = await d.ontology.decideMention(tx, scope, mentionId, { kind: "entity", entityId }, actor, ctx);
  return { entityId: r.mention.linkedEntityId };
}

export async function relinkMentions(d: DecisionDeps, tx: Tx, scope: NovelScope, mentionIds: string[], toEntityId: string, actor: ActorRef): Promise<number> {
  const ms = await d.ontology.listMentions(scope, { ids: mentionIds }, tx);
  const to = await d.ontology.resolveEntityId(scope, toEntityId, tx);
  let moved = 0;
  // single pending mentions: plain confirmation (MN5); linked sets → IdentityDecision(relink) (MN8, 06 §3.11)
  const byFrom = new Map<string, string[]>();
  for (const m of ms) {
    if (m.linkStatus === "ambiguous" || m.linkStatus === "new_entity_candidate" || !m.linkedEntityId) {
      await d.ontology.decideMention(tx, scope, m.id, { kind: "entity", entityId: to }, actor);
      moved++;
    } else if (m.linkedEntityId !== to) byFrom.set(m.linkedEntityId, [...(byFrom.get(m.linkedEntityId) ?? []), m.id]);
  }
  for (const [from, ids] of byFrom) {
    const dec = await d.ontology.proposeIdentityDecision(tx, scope, { kind: "relink", entityIds: [from], relinkToEntityId: to, mentionIds: ids, rationale: "사용자 재연결" }, actor);
    await d.ontology.applyIdentityDecision(tx, scope, dec.id, actor);
    moved += ids.length;
  }
  return moved;
}

export async function buildDisambiguationOptions(d: DecisionDeps, scope: NovelScope, mentionId: string, tx?: Tx): Promise<DisambiguationOptions> {
  const [m] = await d.ontology.listMentions(scope, { ids: [mentionId] }, tx);
  if (!m) throw new NotFoundError("언급", mentionId);
  const cands = ((m.candidates ?? []) as Array<{ entityId: string }>).slice(0, MAX_CARD_OPTIONS);
  const options: DisambiguationOptions["options"] = [];
  for (const c of cands) {
    const e = await d.ontology.getEntity(scope, c.entityId, tx).catch(() => null);
    const names = e ? await d.ontology.listEntityNames(scope, e.id, tx) : [];
    const pref = names.find((n) => n.isPreferred)?.surface ?? c.entityId;
    options.push({ label: `${pref}${e?.disambiguator ? `(${e.disambiguator})` : ""}`, value: { kind: "entity", entityId: c.entityId } });
  }
  options.push({ label: "새 엔티티", value: { kind: "new_entity" } }, { label: "엔티티 아님", value: { kind: "not_entity" } });
  return { mentionId, surface: m.surface, excerpt: m.rationale ?? "", options };
}

/** the chosen option values of an answer: hitl stores `payload.selected_idx`; values are rebuilt in the order we created them */
export function selectedIndexes(payload: unknown): number[] {
  const p = (payload ?? {}) as { selected_idx?: unknown; selectedIdx?: unknown };
  const v = p.selected_idx ?? p.selectedIdx;
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
}

export function disambiguationApplier(d: DecisionDeps): AnswerApplier {
  return async ({ tx, scope, question, answer, actor, selectedOptions }) => {
    const ms = (await d.ontology.listMentions(scope, { questionId: question.id }, tx)).filter((m) => m.linkStatus === "ambiguous" || m.linkStatus === "new_entity_candidate");
    if (ms.length === 0) return { status: "not_applied", reason: "이미 처리된 언급입니다", items: [] };
    const cands = ((ms[0]!.candidates ?? []) as Array<{ entityId: string }>).slice(0, MAX_CARD_OPTIONS);
    const values: unknown[] = [...cands.map((c) => ({ kind: "entity", entityId: c.entityId })), NEW_ENTITY, NOT_ENTITY, HOLD];
    // prefer the stored option value (hitl selectedOptions); fall back to rebuilding the values in creation order
    const stored = selectedOptions?.[0]?.value as { kind?: unknown; entity_id?: unknown; entityId?: unknown; entity_type?: unknown } | undefined;
    const storedEntityId = stored ? (stored.entity_id ?? stored.entityId) : undefined;
    const fromStored =
      stored && typeof stored.kind === "string" && (stored.kind !== "entity" || typeof storedEntityId === "string")
        ? { kind: stored.kind, entityId: typeof storedEntityId === "string" ? storedEntityId : undefined, entityType: typeof stored.entity_type === "string" ? stored.entity_type : undefined }
        : undefined;
    const idx = selectedIndexes(answer.payload)[0];
    const v = (fromStored ?? (idx !== undefined ? values[idx] : undefined)) as { kind: string; entityId?: string; entityType?: string } | undefined;
    const memory = (await agentSettings(d.novel, scope, tx)).enabled;
    if (!v || v.kind === "hold") return { status: "not_applied", reason: "보류를 선택했습니다", items: [{ changeKind: "no_change", ref: { type: "mention", id: ms[0]!.id }, summary: "연결을 보류합니다" }] };
    const items: Awaited<ReturnType<AnswerApplier>>["items"] = [];
    let newEntityId: string | null = null;
    for (const m of ms) {
      if (m.linkStatus === "new_entity_candidate" && v.kind === "not_entity") continue; // MN6 only from ambiguous
      const decision: Decision =
        v.kind === "entity"
          ? { kind: "entity", entityId: v.entityId! }
          : v.kind === "new_entity"
            ? newEntityId
              ? { kind: "entity", entityId: newEntityId }
              : { kind: "new_entity", entityType: v.entityType || "character", preferredName: m.surface }
            : { kind: "not_entity" };
      const r = await confirmMention(d, tx, scope, m.id, decision, actor, { questionId: question.id, answerId: answer.id });
      if (v.kind === "new_entity") newEntityId = r.entityId;
      // 설계 추가 0015: remember the answer for the next episodes (alias / not an entity)
      if (memory && v.kind === "entity" && r.entityId) await rememberAlias(d, tx, scope, r.entityId, m, actor);
      if (memory && v.kind === "not_entity") await rememberNotEntity(d, tx, scope, m, actor, `Q-${question.displayNo} 답변`);
      items.push({ changeKind: "fact_changed", ref: { type: "mention", id: m.id }, summary: r.entityId ? `"${m.surface}" 연결을 확정했습니다` : `"${m.surface}"은(는) 엔티티가 아닌 것으로 기록했습니다` });
    }
    return { status: "applied", items };
  };
}

export function duplicateApplier(d: DecisionDeps): AnswerApplier {
  return async ({ tx, scope, question, answer, actor }) => {
    const decs = (await d.ontology.listIdentityDecisions(scope, { statuses: ["proposed"] }, tx)).filter((x) => x.questionId === question.id);
    const dec = decs[0];
    if (!dec) return { status: "not_applied", reason: "대상 결정이 이미 처리되었습니다", items: [] };
    const idx = selectedIndexes(answer.payload)[0];
    if (idx === undefined || idx >= 2) return { status: "not_applied", reason: "보류를 선택했습니다", items: [{ changeKind: "no_change", ref: { type: "identity_decision", id: dec.id }, summary: "중복 판단을 보류합니다" }] };
    return applyDuplicateDecision(d, tx, scope, dec.id, idx === 0, actor, question.id);
  };
}

/** a proposed merge decision: same → apply (identity_change approval when it touches published canon), distinct → confirm_distinct */
export async function applyDuplicateDecision(d: DecisionDeps, tx: Tx, scope: NovelScope, decisionId: string, same: boolean, actor: ActorRef, questionId: string | null): ReturnType<AnswerApplier> {
  {
    const dec = await d.ontology.getIdentityDecision(scope, decisionId, tx);
    if (dec.status !== "proposed") return { status: "not_applied", reason: "대상 결정이 이미 처리되었습니다", items: [] };
    const question = { id: questionId };
    if (!same) {
      await d.ontology.rejectIdentityDecision(tx, scope, dec.id, actor, "다른 대상");
      const distinct = await d.ontology.proposeIdentityDecision(tx, scope, { kind: "confirm_distinct", entityIds: dec.sourceEntityIds, rationale: "중복 확인: 다름", questionId: question.id ?? undefined }, actor);
      for (const id of dec.sourceEntityIds) {
        const e = await d.ontology.getEntity(scope, id, tx);
        if (e.status === "candidate") await d.ontology.setEquivalenceCheck(tx, scope, id, { status: "passed", duplicateOf: null });
      }
      return { status: "applied", items: [{ changeKind: "entity_name_rule", ref: { type: "identity_decision", id: distinct.id }, summary: "서로 다른 대상으로 기록했습니다" }] };
    }
    try {
      if (question.id) await d.ontology.setIdentityDecisionRefs(tx, scope, dec.id, { questionId: question.id });
      await d.ontology.applyIdentityDecision(tx, scope, dec.id, actor);
      return { status: "applied", items: [{ changeKind: "fact_changed", ref: { type: "identity_decision", id: dec.id }, summary: "같은 대상으로 병합했습니다" }] };
    } catch (err) {
      if (err instanceof ConflictError && err.code === "identity_change_approval_required") {
        const r = await d.hitl.requestApproval(tx, scope, {
          approvalType: "identity_change",
          target: { type: "identity_decision", id: dec.id },
          question: { title: "공개된 사실에 닿는 병합 승인", body: "이 병합은 이미 공개된 화의 사실을 옮깁니다. 승인하면 병합을 적용합니다.", links: dec.sourceEntityIds.map((id) => ({ type: "entity" as const, id })) },
          requestedBy: actor,
        });
        await d.ontology.setIdentityDecisionRefs(tx, scope, dec.id, { approvalId: r.approvalId });
        return { status: "not_applied", reason: "공개 사실에 닿아 identity_change 승인을 기다립니다", items: [{ changeKind: "no_change", ref: { type: "approval", id: r.approvalId }, summary: "승인 요청을 만들었습니다" }] };
      }
      throw err;
    }
  }
}

/** approval_type=identity_change (06 §3.11 승인 규칙) */
export function identityChangeApprovalHandler(d: DecisionDeps): ApprovalHandler {
  return async ({ tx, scope, approval, decision, actor }) => {
    const decisionId = approval.subjectId;
    if (!decisionId) return;
    const dec = await d.ontology.getIdentityDecision(scope, decisionId, tx);
    if (decision === "approved") {
      await d.ontology.setIdentityDecisionRefs(tx, scope, dec.id, { approvalId: approval.id });
      if (dec.status === "proposed") await d.ontology.applyIdentityDecision(tx, scope, dec.id, actor);
      else if (dec.status === "applied") await d.ontology.revertIdentityDecision(tx, scope, dec.id, actor);
    } else if (dec.status === "proposed") {
      await d.ontology.rejectIdentityDecision(tx, scope, dec.id, actor, "identity_change 반려");
    }
  };
}
