/**
 * Writes a LinkerResult inside the caller's transaction (06 §3.8–3.10):
 * L5 NIL → candidate entity (EN1) + EN3(b) equivalence check (deterministic: similar same-type entity → duplicate_entity
 * question + proposed merge), mentions (`mention.batch_linked`), entity_disambiguation questions grouped per 06 §3.10.
 *
 * 설계 추가 0015 (entity resolver agent on — novels.entity_agent_resolution): a NIL surface whose exact name already
 * exists (e.g. a parallel extraction created it a moment ago) links to that entity instead of creating a second one;
 * question wording follows the entity type (누구 only for persons, else 무엇); the "새 엔티티" option carries the type;
 * the recommendation is the resolver's judgement; a surface that already has an open question attaches to it.
 */
import { defaultValue, labelKo, type MentionKind } from "@ncs/shared";
import { NotImplementedError, type ActorRef, type NovelScope, type Tx } from "../../../platform/index.js";
import type { HitlService, QuestionDraft } from "../../hitl/index.js";
import type { NovelService } from "../../novel/index.js";
import { normalizedKey, type MentionDraft, type OntologyService } from "../../ontology/index.js";
import type { AgentQuestionHint, LinkerCommitResult, LinkerResult } from "../index.js";
import { questionGroupKey } from "../domain/linker.js";
import { classifySurface, isCoreferenceOnly, PERSON_TYPES } from "../domain/salience.js";

export interface CommitDeps {
  ontology: OntologyService;
  hitl: HitlService;
  /** reads the novel's entity resolver setting (absent → old behaviour) */
  novel?: NovelService;
}

export const NEW_ENTITY = { kind: "new_entity" } as const;
export const NOT_ENTITY = { kind: "not_entity" } as const;
export const HOLD = { kind: "hold" } as const;
export const MAX_CARD_OPTIONS = 4;

/** 설계 추가 0015: novel setting (entity_agent_resolution, entity_agent_min_confidence) */
export interface AgentSettings {
  enabled: boolean;
  minConfidence: number;
}
export async function agentSettings(novel: NovelService | undefined, scope: NovelScope, tx?: Tx): Promise<AgentSettings> {
  if (!novel) return { enabled: false, minConfidence: defaultValue("linking.agent_resolution_min_confidence") };
  try {
    const n = (await novel.getNovel(scope, tx)) as { entityAgentResolution?: boolean | null; entityAgentMinConfidence?: number | null };
    return {
      enabled: n.entityAgentResolution ?? defaultValue("linking.agent_resolution"),
      minConfidence: typeof n.entityAgentMinConfidence === "number" ? n.entityAgentMinConfidence : defaultValue("linking.agent_resolution_min_confidence"),
    };
  } catch (err) {
    if (err instanceof NotImplementedError) return { enabled: false, minConfidence: defaultValue("linking.agent_resolution_min_confidence") };
    throw err;
  }
}

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

export const typeLabel = (t: string): string => {
  try {
    return labelKo("entity_type", t);
  } catch {
    return t;
  }
};

/** 설계 추가 0015: 누구 (persons, pronouns / address / titles, a person candidate) vs 무엇 */
export function asksWho(i: { entityType?: string | null; mentionKind?: string | null; topCandidateType?: string | null }): boolean {
  if (i.entityType) return PERSON_TYPES.has(i.entityType);
  if (i.mentionKind === "pronoun" || i.mentionKind === "address" || i.mentionKind === "title") return true;
  return !!i.topCandidateType && PERSON_TYPES.has(i.topCandidateType);
}

export interface DraftOptions {
  /** 설계 추가 0015 wording / typed new-entity option / resolver recommendation */
  agent?: boolean;
  entityType?: string | null;
  hint?: AgentQuestionHint | null;
}

/** 05 §3.6.2 / 06 §3.10: options = candidate cards (≤4, order of mention.candidates) + 새 인물 + 엔티티 아님 + 보류 */
export async function disambiguationDraft(
  deps: CommitDeps,
  tx: Tx,
  scope: NovelScope,
  mentions: Array<Pick<MentionDraft, "surface" | "candidates" | "mentionKind" | "storyPoint"> & { id: string; excerpt?: string }>,
  opts: DraftOptions = {},
): Promise<QuestionDraft> {
  const head = mentions[0]!;
  const cands = head.candidates.slice(0, MAX_CARD_OPTIONS);
  const options: QuestionDraft["options"] = [];
  for (let i = 0; i < cands.length; i++) {
    // value shapes follow hitl OPTION_VALUE_SCHEMAS.entity_disambiguation
    options.push({ label: await label(deps, tx, scope, cands[i]!.entityId), value: { kind: "entity", entity_id: cands[i]!.entityId }, isRecommended: i === 0 });
  }
  const where = `${Math.floor(head.storyPoint / 1000)}화`;
  const surface = head.mentionKind === "zero" ? "(생략된 주어)" : `"${head.surface}"`;
  if (!opts.agent) {
    options.push({ label: "새 인물(새 엔티티)", value: NEW_ENTITY }, { label: "엔티티 아님", value: NOT_ENTITY }, { label: "보류", value: HOLD });
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
      // 설계 추가 0015: without the resolver's judgement the recommendation is only the linker's guess → the autopilot never answers
      sensitivity: "high",
      links: [...mentions.map((m) => ({ type: "mention" as const, id: m.id })), ...cands.map((c) => ({ type: "entity" as const, id: c.entityId }))],
    };
  }
  // 설계 추가 0015
  const top = cands[0] ? await deps.ontology.getEntity(scope, cands[0].entityId, tx).catch(() => null) : null;
  const type = opts.entityType ?? (opts.hint?.recommend?.kind === "new_entity" ? (opts.hint.recommend.entityType ?? null) : null);
  const who = asksWho({ entityType: type, mentionKind: head.mentionKind, topCandidateType: top?.entityType ?? null });
  const newValue = type ? { kind: "new_entity", entity_type: type } : NEW_ENTITY;
  options.push({ label: type ? `새 ${typeLabel(type)}(새 엔티티)` : "새 엔티티", value: newValue }, { label: "엔티티 아님", value: NOT_ENTITY }, { label: "보류", value: HOLD });
  let recIdx: number | null = cands[0] ? 0 : null;
  const rec = opts.hint?.recommend;
  if (rec) {
    if (rec.kind === "entity") {
      const i = cands.findIndex((c) => c.entityId === rec.entityId);
      if (i >= 0) recIdx = i;
    } else recIdx = options.findIndex((o) => (o.value as { kind: string }).kind === rec.kind);
  }
  options.forEach((o, i) => (o.isRecommended = i === recIdx));
  const conf = opts.hint ? ` (신뢰도 ${opts.hint.confidence.toFixed(2)})` : "";
  return {
    topic: "entity_disambiguation",
    questionType: "single_choice",
    title: who ? `${where}의 ${surface}은(는) 누구인가요?` : `${where}의 ${surface}은(는) 무엇을 가리키나요?`,
    body: [
      `${where}에 나온 표기 ${surface}이(가) ${who ? "어느 인물" : "어느 대상"}을 가리키는지 판정 에이전트도 확신하지 못했습니다${conf}.`,
      opts.hint?.rationale ? `에이전트 판단: ${opts.hint.rationale}` : "",
      mentions.length > 1 ? `같은 표기의 언급 ${mentions.length}건을 함께 묻습니다.` : "",
      ...mentions.slice(0, 3).map((m) => (m.excerpt ? `· ${m.excerpt}` : "")),
      "답하면 같은 표기의 다른 언급에도 함께 반영합니다. 답이 없으면 연결을 보류합니다.",
    ]
      .filter(Boolean)
      .join("\n"),
    options,
    recommendation: recIdx !== null && recIdx >= 0 ? { optionValue: options[recIdx]!.value, defaultAction: "hold", rationale: opts.hint ? `에이전트 판단${conf}: ${opts.hint.rationale || "가장 그럴듯한 선택"}`.slice(0, 900) : "후보 1위" } : null,
    rationale: opts.hint ? "판정 에이전트의 신뢰도가 자동 적용 기준에 미달했고, 그럴듯한 후보가 여럿입니다." : "링커 신뢰도가 자동 확정 기준에 미달했습니다.",
    // normal (the autopilot may answer) only when the recommendation is the resolver's judgement
    ...(opts.hint?.recommend ? {} : { sensitivity: "high" as const }),
    links: [...mentions.map((m) => ({ type: "mention" as const, id: m.id })), ...cands.map((c) => ({ type: "entity" as const, id: c.entityId }))],
  };
}

export async function duplicateDraft(
  deps: CommitDeps,
  tx: Tx,
  scope: NovelScope,
  input: { newEntityId: string; existingId: string; decisionId: string; score?: number; agent?: { same: boolean; confidence: number; rationale: string } | null },
): Promise<QuestionDraft> {
  const a = await label(deps, tx, scope, input.newEntityId);
  const b = await label(deps, tx, scope, input.existingId);
  const options: QuestionDraft["options"] = [
    { label: "같은 대상(병합)", value: { kind: "same", identity_decision_id: input.decisionId, survivor_entity_id: input.existingId } },
    { label: "다른 대상", value: { kind: "distinct", identity_decision_id: input.decisionId } },
    { label: "보류", value: HOLD },
  ];
  const ag = input.agent;
  return {
    topic: "duplicate_entity",
    questionType: "single_choice",
    title: `'${a}'은(는) 기존 '${b}'와(과) 같은 대상인가요?`,
    body: `새로 나온 '${a}'이(가) 이미 있는 '${b}'와(과) 비슷합니다${input.score ? `(유사도 ${input.score})` : ""}. 같은 대상이면 병합하고, 다르면 따로 둡니다. 답이 없으면 보류합니다.${ag ? `\n에이전트 판단(신뢰도 ${ag.confidence.toFixed(2)}): ${ag.rationale}` : ""}`,
    options,
    recommendation: ag
      ? { optionValue: options[ag.same ? 0 : 1]!.value, defaultAction: "hold", rationale: `에이전트 판단(신뢰도 ${ag.confidence.toFixed(2)}): ${ag.rationale}`.slice(0, 900) }
      : { optionValue: HOLD, defaultAction: "hold", rationale: "같은 대상인지 확인이 필요합니다" },
    rationale: ag ? "판정 에이전트의 신뢰도가 자동 병합 기준에 미달했습니다." : "자동 병합은 하지 않습니다(06 P-4).",
    // 설계 추가 0015: without the resolver's judgement (recommendation 보류) the autopilot never answers it
    ...(ag ? {} : { sensitivity: "high" as const }),
    links: [
      { type: "entity", id: input.newEntityId },
      { type: "entity", id: input.existingId },
      { type: "identity_decision", id: input.decisionId },
    ],
  };
}

/** EN3(b) deterministic part: same-type entities with any name similarity → duplicate question */
export async function equivalenceCheck(deps: CommitDeps, tx: Tx, scope: NovelScope, entityId: string, actor: ActorRef, ctx: { taskId?: string | null; runId?: string | null; createQuestions?: boolean; agentDecided?: boolean }) {
  // 설계 추가 0015: the resolver decided this is a new entity (it saw the similar candidates) → no duplicate question
  if (ctx.agentDecided) {
    await deps.ontology.setEquivalenceCheck(tx, scope, entityId, { status: "passed", duplicateOf: null, source: "agent_resolution" });
    return { questionId: null as string | null, decisionId: null as string | null };
  }
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

/**
 * 설계 추가 0015: open entity_disambiguation questions by normalized surface (read in the caller's tx) — a surface that is
 * already asked attaches its new mentions to that question instead of opening another one.
 */
export async function openQuestionsBySurface(deps: CommitDeps, tx: Tx, scope: NovelScope): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let open: Awaited<ReturnType<HitlService["listQuestions"]>>;
  try {
    open = await deps.hitl.listQuestions(scope, { topics: ["entity_disambiguation"], statuses: ["pending", "open"], limit: 500 }, tx);
  } catch (err) {
    if (err instanceof NotImplementedError) return out;
    throw err;
  }
  if (open.length === 0) return out;
  const ids = new Set(open.map((q) => q.id));
  const ms = await deps.ontology.listMentions(scope, { linkStatus: ["ambiguous", "new_entity_candidate"], limit: 2000 }, tx);
  // newest question first (listQuestions is display_no desc)
  const order = new Map(open.map((q, i) => [q.id, i]));
  for (const m of ms) {
    if (!m.questionId || !ids.has(m.questionId) || m.mentionKind === "zero") continue;
    const k = normalizedKey(m.surface);
    const prev = out.get(k);
    if (!prev || order.get(m.questionId)! < order.get(prev)!) out.set(k, m.questionId);
  }
  return out;
}

export async function commitLinkerResult(
  deps: CommitDeps,
  tx: Tx,
  scope: NovelScope,
  result: LinkerResult,
  actor: ActorRef,
  ctx: { taskId?: string | null; runId?: string | null; createQuestions?: boolean; excerpts?: Record<number, string>; seriesBibleId?: string | null; agentResolution?: boolean } = {},
): Promise<LinkerCommitResult> {
  const out: LinkerCommitResult = { mentionIds: [], byLocalKey: {}, createdEntityIds: [], questionIds: [], identityDecisionIds: [] };
  if (result.mentions.length === 0) return out;
  const agent = ctx.agentResolution ?? (await agentSettings(deps.novel, scope, tx)).enabled;
  const agentCreated = new Set(result.agentCreatedKeys ?? []);
  const agentCreatedIds = new Set<string>();
  const drafts = result.mentions.map((m) => ({ ...m }));
  // L5 NIL → candidate entities, one per distinct (type, surface) within this batch
  const created = new Map<string, string>();
  for (const ne of result.newEntities ?? []) {
    const key = `${ne.entityType}|${normalizedKey(ne.surface)}`;
    const d = drafts[ne.mentionIndex]!;
    let id = created.get(key);
    if (!id && agent) {
      // 설계 추가 0015: the same name may have been created since the linker ran (parallel episodes), or the resolver chose a
      // canonical name that already exists (it only sees part of the entity list) — link, never duplicate. Only the
      // similarity-based duplicate question is skipped for the resolver's own new entities (equivalenceCheck agentDecided).
      const same = (await deps.ontology.findExactNamedEntities(scope, ne.surface, { entityType: ne.entityType }, tx))[0];
      if (same) {
        d.linkedEntityId = same.entityId;
        d.linkStatus = same.status === "active" ? "auto_linked" : "new_entity_candidate";
        d.viaNameId = same.nameId;
        d.confidence = Math.max(d.confidence ?? 0, 0.9);
        d.rationale = `${d.rationale ? `${d.rationale}; ` : ""}같은 이름의 엔티티가 이미 있어 연결`;
        d.candidates = [{ entityId: same.entityId, score: 1, via: "exact" }, ...d.candidates.filter((c) => c.entityId !== same.entityId)];
        continue;
      }
    }
    if (!id) {
      const r = await deps.ontology.createEntity(
        tx,
        scope,
        {
          entityType: ne.entityType as never,
          preferredName: { surface: ne.surface },
          status: "candidate",
          source: { kind: d.sourceKind === "manuscript" ? "manuscript" : d.sourceKind === "series_bible" ? "series_bible" : "user_input", refType: ctx.seriesBibleId ? "series_bible" : d.manuscriptVersionId ? "manuscript_version" : "novel", refId: ctx.seriesBibleId ?? d.manuscriptVersionId ?? scope.novelId },
        },
        actor,
      );
      id = r.entity.id;
      created.set(key, id);
      out.createdEntityIds.push(id);
      if (agentCreated.has(key)) agentCreatedIds.add(id);
    }
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
    const r = await equivalenceCheck(deps, tx, scope, id, actor, { ...ctx, agentDecided: agentCreatedIds.has(id) });
    if (r.questionId) out.questionIds.push(r.questionId);
    if (r.decisionId) out.identityDecisionIds.push(r.decisionId);
  }
  // disambiguation questions (grouped)
  if (ctx.createQuestions !== false && result.questionsNeeded.length > 0) {
    const groups = new Map<string, number[]>();
    for (const q of result.questionsNeeded) {
      const d = drafts[q.mentionIndex]!;
      if (d.mentionKind === "zero") continue; // 06 §3.7 3a
      if (agent && isCoreferenceOnly(classifySurface(d.surface, d.mentionKind))) continue; // 설계 추가 0015: pronouns / generic address are never asked
      const k = agent
        ? `${normalizedKey(d.surface)}|${[...d.candidates.map((c) => c.entityId)].sort().join(",")}` // 설계 추가 0015: one question per surface
        : questionGroupKey({ sceneId: d.sceneId, chainKey: d.chainKey, normalizedKey: normalizedKey(d.surface), mentionKind: d.mentionKind as MentionKind, candidateIds: d.candidates.map((c) => c.entityId), index: q.mentionIndex });
      groups.set(k, [...(groups.get(k) ?? []), q.mentionIndex]);
    }
    const openBySurface = agent ? await openQuestionsBySurface(deps, tx, scope) : new Map<string, string>();
    const cap = defaultValue("question.daily_cap_non_blocking");
    let made = 0;
    for (const idxs of groups.values()) {
      const ms = idxs.map((i) => ({ ...drafts[i]!, id: mentionIds[i]!, excerpt: ctx.excerpts?.[i] }));
      const sk = normalizedKey(ms[0]!.surface);
      const existing = openBySurface.get(sk);
      if (existing) {
        // 설계 추가 0015: already asked — answering that question resolves these mentions too
        await deps.ontology.setMentionQuestion(tx, scope, ms.map((m) => m.id), existing);
        continue;
      }
      if (made >= cap) break; // rest stays report-hold (06 §3.10 상한 초과)
      const head = idxs[0]!;
      const qid = await tryCreateQuestion(deps, tx, scope, await disambiguationDraft(deps, tx, scope, ms, agent ? { agent: true, entityType: result.entityTypeHints?.[head] ?? null, hint: result.agentHints?.[head] ?? null } : {}), actor, ctx);
      if (!qid) continue;
      made++;
      out.questionIds.push(qid);
      await deps.ontology.setMentionQuestion(tx, scope, ms.map((m) => m.id), qid);
      if (agent) openBySurface.set(sk, qid);
    }
  }
  return out;
}
