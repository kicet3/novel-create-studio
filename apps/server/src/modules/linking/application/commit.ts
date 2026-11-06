/**
 * Writes a LinkerResult inside the caller's transaction (06 §3.8–3.10):
 * L5 NIL → candidate entity (EN1) + EN3(b) equivalence check (deterministic: similar same-type entity → duplicate_entity
 * question + proposed merge), mentions (`mention.batch_linked`), entity_disambiguation questions grouped per 06 §3.10.
 */
import { defaultValue, type MentionKind } from "@ncs/shared";
import { NotImplementedError, type ActorRef, type NovelScope, type Tx } from "../../../platform/index.js";
import type { HitlService, QuestionDraft } from "../../hitl/index.js";
import { normalizedKey, type MentionDraft, type OntologyService } from "../../ontology/index.js";
import type { LinkerCommitResult, LinkerResult } from "../index.js";
import { questionGroupKey } from "../domain/linker.js";

export interface CommitDeps {
  ontology: OntologyService;
  hitl: HitlService;
}

export const NEW_ENTITY = { kind: "new_entity" } as const;
export const NOT_ENTITY = { kind: "not_entity" } as const;
export const HOLD = { kind: "hold" } as const;
export const MAX_CARD_OPTIONS = 4;

/** hitl placeholder / not-yet-wired: keep the mention ambiguous without a question */
export async function tryCreateQuestion(deps: CommitDeps, tx: Tx, scope: NovelScope, draft: QuestionDraft, actor: ActorRef, ctx: { taskId?: string | null; runId?: string | null }): Promise<string | null> {
  try {
    const q = await deps.hitl.createQuestion(tx, scope, draft, { createdBy: actor, taskId: ctx.taskId ?? null, runId: ctx.runId ?? null });
    return q.questionId;
  } catch (err) {
    if (err instanceof NotImplementedError) return null;
    throw err;
  }
}

async function label(deps: CommitDeps, tx: Tx, scope: NovelScope, entityId: string): Promise<string> {
  const e = await deps.ontology.getEntity(scope, entityId, tx).catch(() => null);
  if (!e) return entityId;
  const names = await deps.ontology.listEntityNames(scope, e.id, tx);
  const pref = names.find((n) => n.isPreferred)?.surface ?? e.id;
  return `${pref}${e.disambiguator ? `(${e.disambiguator})` : ""}`;
}

/** 05 §3.6.2 / 06 §3.10: options = candidate cards (≤4, order of mention.candidates) + 새 인물 + 엔티티 아님 + 보류 */
export async function disambiguationDraft(deps: CommitDeps, tx: Tx, scope: NovelScope, mentions: Array<Pick<MentionDraft, "surface" | "candidates" | "mentionKind" | "storyPoint"> & { id: string; excerpt?: string }>): Promise<QuestionDraft> {
  const head = mentions[0]!;
  const cands = head.candidates.slice(0, MAX_CARD_OPTIONS);
  const options: QuestionDraft["options"] = [];
  for (let i = 0; i < cands.length; i++) {
    // value shapes follow hitl OPTION_VALUE_SCHEMAS.entity_disambiguation
    options.push({ label: await label(deps, tx, scope, cands[i]!.entityId), value: { kind: "entity", entity_id: cands[i]!.entityId }, isRecommended: i === 0 });
  }
  options.push({ label: "새 인물(새 엔티티)", value: NEW_ENTITY }, { label: "엔티티 아님", value: NOT_ENTITY }, { label: "보류", value: HOLD });
  const where = `${Math.floor(head.storyPoint / 1000)}화`;
  const surface = head.mentionKind === "zero" ? "(생략된 주어)" : `"${head.surface}"`;
  return {
    topic: "entity_disambiguation",
    questionType: "single_choice",
    title: `${where}의 ${surface}은(는) 누구인가요?`,
    body: [
      `${where}에 나온 표기 ${surface}이(가) 어느 대상을 가리키는지 확실하지 않습니다.`,
      mentions.length > 1 ? `같은 대상으로 보이는 언급 ${mentions.length}건을 함께 묻습니다.` : "",
      ...mentions.slice(0, 3).map((m) => (m.excerpt ? `· ${m.excerpt}` : "")),
      "답이 없으면 연결을 보류하고, 이 언급에서 나온 사실은 확정하지 않습니다.",
    ]
      .filter(Boolean)
      .join("\n"),
    options,
    // 06 §3.10: deadline default is "보류" — the recommendation is never auto-applied
    recommendation: cands[0] ? { optionValue: options[0]!.value, defaultAction: "hold", rationale: "후보 1위" } : null,
    rationale: "링커 신뢰도가 자동 확정 기준에 미달했습니다.",
    links: [...mentions.map((m) => ({ type: "mention" as const, id: m.id })), ...cands.map((c) => ({ type: "entity" as const, id: c.entityId }))],
  };
}

export async function duplicateDraft(deps: CommitDeps, tx: Tx, scope: NovelScope, input: { newEntityId: string; existingId: string; decisionId: string; score?: number }): Promise<QuestionDraft> {
  const a = await label(deps, tx, scope, input.newEntityId);
  const b = await label(deps, tx, scope, input.existingId);
  return {
    topic: "duplicate_entity",
    questionType: "single_choice",
    title: `'${a}'은(는) 기존 '${b}'와(과) 같은 대상인가요?`,
    body: `새로 나온 '${a}'이(가) 이미 있는 '${b}'와(과) 비슷합니다${input.score ? `(유사도 ${input.score})` : ""}. 같은 대상이면 병합하고, 다르면 따로 둡니다. 답이 없으면 보류합니다.`,
    options: [
      { label: "같은 대상(병합)", value: { kind: "same", identity_decision_id: input.decisionId, survivor_entity_id: input.existingId } },
      { label: "다른 대상", value: { kind: "distinct", identity_decision_id: input.decisionId } },
      { label: "보류", value: HOLD },
    ],
    recommendation: { optionValue: HOLD, defaultAction: "hold", rationale: "같은 대상인지 확인이 필요합니다" },
    rationale: "자동 병합은 하지 않습니다(06 P-4).",
    links: [
      { type: "entity", id: input.newEntityId },
      { type: "entity", id: input.existingId },
      { type: "identity_decision", id: input.decisionId },
    ],
  };
}

/** EN3(b) deterministic part: same-type entities with any name similarity → duplicate question */
export async function equivalenceCheck(deps: CommitDeps, tx: Tx, scope: NovelScope, entityId: string, actor: ActorRef, ctx: { taskId?: string | null; runId?: string | null; createQuestions?: boolean }) {
  const dups = (await deps.ontology.findDuplicateCandidates(scope, entityId, tx)).filter((d) => d.entityIds.includes(entityId));
  if (dups.length === 0) {
    await deps.ontology.setEquivalenceCheck(tx, scope, entityId, { status: "passed", duplicateOf: null });
    return { questionId: null as string | null, decisionId: null as string | null };
  }
  const top = dups[0]!;
  const other = top.entityIds[0] === entityId ? top.entityIds[1] : top.entityIds[0];
  const otherEntity = await deps.ontology.getEntity(scope, other, tx);
  if (otherEntity.status !== "active") {
    await deps.ontology.setEquivalenceCheck(tx, scope, entityId, { status: "failed", duplicateOf: other });
    return { questionId: null, decisionId: null };
  }
  const dec = await deps.ontology.proposeIdentityDecision(tx, scope, { kind: "merge", entityIds: [other, entityId], survivorEntityId: other, rationale: `유사 엔티티(${top.reason})`, evidence: { score: top.score } }, actor);
  let questionId: string | null = null;
  if (ctx.createQuestions !== false) {
    questionId = await tryCreateQuestion(deps, tx, scope, await duplicateDraft(deps, tx, scope, { newEntityId: entityId, existingId: other, decisionId: dec.id, score: top.score }), actor, ctx);
    if (questionId) await deps.ontology.setIdentityDecisionRefs(tx, scope, dec.id, { questionId });
  }
  await deps.ontology.setEquivalenceCheck(tx, scope, entityId, { status: "question", duplicateOf: other, questionId });
  return { questionId, decisionId: dec.id };
}

export async function commitLinkerResult(
  deps: CommitDeps,
  tx: Tx,
  scope: NovelScope,
  result: LinkerResult,
  actor: ActorRef,
  ctx: { taskId?: string | null; runId?: string | null; createQuestions?: boolean; excerpts?: Record<number, string>; seriesBibleId?: string | null } = {},
): Promise<LinkerCommitResult> {
  const out: LinkerCommitResult = { mentionIds: [], byLocalKey: {}, createdEntityIds: [], questionIds: [], identityDecisionIds: [] };
  if (result.mentions.length === 0) return out;
  const drafts = result.mentions.map((m) => ({ ...m }));
  // L5 NIL → candidate entities, one per distinct (type, surface) within this batch
  const created = new Map<string, string>();
  for (const ne of result.newEntities ?? []) {
    const key = `${ne.entityType}|${normalizedKey(ne.surface)}`;
    let id = created.get(key);
    if (!id) {
      const r = await deps.ontology.createEntity(
        tx,
        scope,
        {
          entityType: ne.entityType as never,
          preferredName: { surface: ne.surface },
          status: "candidate",
          source: { kind: drafts[ne.mentionIndex]!.sourceKind === "manuscript" ? "manuscript" : drafts[ne.mentionIndex]!.sourceKind === "series_bible" ? "series_bible" : "user_input", refType: ctx.seriesBibleId ? "series_bible" : drafts[ne.mentionIndex]!.manuscriptVersionId ? "manuscript_version" : "novel", refId: ctx.seriesBibleId ?? drafts[ne.mentionIndex]!.manuscriptVersionId ?? scope.novelId },
        },
        actor,
      );
      id = r.entity.id;
      created.set(key, id);
      out.createdEntityIds.push(id);
    }
    const d = drafts[ne.mentionIndex]!;
    d.linkedEntityId = id;
    d.linkStatus = "new_entity_candidate";
    d.candidates = [{ entityId: id, score: 1, via: "nil" }, ...d.candidates];
  }
  const { mentionIds } = await deps.ontology.writeMentions(tx, scope, drafts, actor);
  out.mentionIds = mentionIds;
  const byIndex = (i: number) => ({ mentionId: mentionIds[i]!, entityId: drafts[i]!.linkStatus === "ambiguous" || drafts[i]!.linkStatus === "rejected" ? null : (drafts[i]!.linkedEntityId ?? null), status: drafts[i]!.linkStatus, viaNameId: drafts[i]!.viaNameId ?? null });
  for (const [k, i] of Object.entries(result.localKeys ?? {})) out.byLocalKey[k] = byIndex(i);
  // EN3(b) for the new candidates (bible path: the duplicate check runs too; activation waits for approval)
  for (const id of out.createdEntityIds) {
    const r = await equivalenceCheck(deps, tx, scope, id, actor, ctx);
    if (r.questionId) out.questionIds.push(r.questionId);
    if (r.decisionId) out.identityDecisionIds.push(r.decisionId);
  }
  // disambiguation questions (grouped)
  if (ctx.createQuestions !== false && result.questionsNeeded.length > 0) {
    const groups = new Map<string, number[]>();
    for (const q of result.questionsNeeded) {
      const d = drafts[q.mentionIndex]!;
      if (d.mentionKind === "zero") continue; // 06 §3.7 3a
      const k = questionGroupKey({ sceneId: d.sceneId, chainKey: d.chainKey, normalizedKey: normalizedKey(d.surface), mentionKind: d.mentionKind as MentionKind, candidateIds: d.candidates.map((c) => c.entityId), index: q.mentionIndex });
      groups.set(k, [...(groups.get(k) ?? []), q.mentionIndex]);
    }
    const cap = defaultValue("question.daily_cap_non_blocking");
    let made = 0;
    for (const idxs of groups.values()) {
      if (made >= cap) break; // rest stays report-hold (06 §3.10 상한 초과)
      const ms = idxs.map((i) => ({ ...drafts[i]!, id: mentionIds[i]!, excerpt: ctx.excerpts?.[i] }));
      const qid = await tryCreateQuestion(deps, tx, scope, await disambiguationDraft(deps, tx, scope, ms), actor, ctx);
      if (!qid) continue;
      made++;
      out.questionIds.push(qid);
      await deps.ontology.setMentionQuestion(tx, scope, ms.map((m) => m.id), qid);
    }
  }
  return out;
}
