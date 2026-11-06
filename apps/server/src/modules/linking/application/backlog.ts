/**
 * 설계 추가 0015: `resolve_entities` (world_keeper) — the entity resolver over the inbox backlog. Open questions the
 * world_keeper asked (entity_disambiguation, duplicate_entity and their interpretation_confirm children) are decided by
 * the same rules as an extraction (salience filter → alias memory → exact names → one model call per batch) and closed
 * through the existing paths: an agent answer (resolution_source=agent_resolved, the decision applied by our applier or
 * the registered duplicate applier) or a cancel with the agent reason. Low-confidence items stay open. Idempotent: every
 * question's status is re-checked in the commit, and a second run finds nothing to do (no model call).
 */
import { z } from "zod";
import type { MentionKind, QuestionTopic } from "@ncs/shared";
import { actors, DomainValidationError, InvalidTransitionError, savepoint, type ActorRef, type NovelScope, type Tx } from "../../../platform/index.js";
import type { AgentTaskHandler } from "../../agents/index.js";
import type { AnswerApplier, Question } from "../../hitl/index.js";
import { normalizedKey, type Mention } from "../../ontology/index.js";
import type { CommitOutcome } from "../../orchestration/index.js";
import { classifySurface, isCoreferenceOnly, PERSON_TYPES, type SurfaceClass } from "../domain/salience.js";
import { agentSettings, MAX_CARD_OPTIONS, type AgentSettings } from "./commit.js";
import { applyDuplicateDecision, confirmMention, rememberAlias, rememberNotEntity } from "./decisions.js";
import { contested, resolverEntities, type ResolutionDeps } from "./agent-resolution.js";
import { resolveMentions, type ResolverItem } from "./resolver.js";

/** cancelled_reason prefix of questions the agent closed (hitl counts them as agent-resolved) */
export const AGENT_CANCEL_REASON = "에이전트가 정리";
export type BacklogDeps = ResolutionDeps;

export const resolveEntitiesInputSchema = z.object({ reason: z.string().optional() });
type BacklogInput = z.infer<typeof resolveEntitiesInputSchema>;

export const BACKLOG_TOPICS: QuestionTopic[] = ["entity_disambiguation", "duplicate_entity", "interpretation_confirm"];

type DecisionKind = "entity" | "new_entity" | "not_entity" | "same" | "distinct" | "close" | "stale";

export interface BacklogAction {
  questionId: string;
  topic: QuestionTopic;
  /** the entity question the decision applies to (= questionId, or the root of an interpretation_confirm) */
  rootQuestionId: string;
  kind: DecisionKind;
  entityId?: string | null;
  entityType?: string | null;
  canonicalName?: string | null;
  /** option idx recorded as the agent's answer (entity / new / not / same / distinct); null = close by cancel */
  optionIdx?: number | null;
  surface?: string | null;
  confidence: number;
  rationale: string;
  source: "rule" | "memory" | "agent";
  /** duplicate_entity stale: the proposed merge decision to reject with the question */
  decisionId?: string;
}

export interface BacklogProposal {
  actions: BacklogAction[];
  open: number;
  /** left open (low confidence / no decision) */
  kept: number;
  calls: number;
}

interface Target {
  q: Question;
  root: Question;
  /** entity_disambiguation root: pending mentions */
  mentions: Mention[];
  /** duplicate_entity root: proposed decision */
  decision?: { id: string; a: string; b: string } | null;
  options: Array<{ idx: number; value: { kind?: string; entity_id?: string; entityId?: string } | null }>;
}

const pendingMention = (m: Mention) => m.linkStatus === "ambiguous" || m.linkStatus === "new_entity_candidate";

function optionIdxFor(t: Target, kind: DecisionKind, entityId?: string | null): number | null {
  const find = (pred: (v: NonNullable<Target["options"][number]["value"]>) => boolean) => t.options.find((o) => o.value && pred(o.value))?.idx ?? null;
  if (kind === "entity") return find((v) => v.kind === "entity" && (v.entity_id ?? v.entityId) === entityId);
  if (kind === "new_entity" || kind === "not_entity") return find((v) => v.kind === kind);
  if (kind === "same") return 0;
  if (kind === "distinct") return 1;
  return null;
}

/**
 * open world_keeper entity questions + the interpretation_confirm children of entity questions (an interpretation of a
 * plot / world question is not ours), each with its root question
 */
export async function openBacklogQuestions(hitl: BacklogDeps["hitl"], scope: NovelScope): Promise<Array<{ q: Question; root: Question }>> {
  const open = (await hitl.listQuestions(scope, { topics: BACKLOG_TOPICS, statuses: ["pending", "open"], limit: 500 })).filter((q) => q.askedByRole === "world_keeper");
  if (open.length === 0) return [];
  const needRoots = open.some((q) => q.topic === "interpretation_confirm");
  const roots = needRoots ? new Map((await hitl.listQuestions(scope, { topics: ["entity_disambiguation", "duplicate_entity"], limit: 500 })).map((q) => [q.id, q])) : new Map<string, Question>();
  const out: Array<{ q: Question; root: Question }> = [];
  for (const q of open) {
    const root = q.topic === "interpretation_confirm" ? (q.parentQuestionId ? roots.get(q.parentQuestionId) : undefined) : q;
    if (root) out.push({ q, root });
  }
  return out;
}

async function gather(deps: BacklogDeps, scope: NovelScope): Promise<Target[]> {
  const open = await openBacklogQuestions(deps.hitl, scope);
  if (open.length === 0) return [];
  const decisions = await deps.ontology.listIdentityDecisions(scope, { statuses: ["proposed"] });
  const out: Target[] = [];
  for (const { q, root } of open) {
    const view = await deps.hitl.getQuestionView(scope, root.id).catch(() => null);
    const options = (view?.options ?? []).map((o) => ({ idx: Number(o.optionId), value: (o.value ?? null) as Target["options"][number]["value"] }));
    if (root.topic === "entity_disambiguation") {
      const mentions = (await deps.ontology.listMentions(scope, { questionId: root.id })).filter(pendingMention);
      out.push({ q, root, mentions, options });
    } else {
      const dec = decisions.find((d) => d.questionId === root.id && d.kind === "merge");
      const survivor = dec?.survivorEntityId ?? dec?.sourceEntityIds[0];
      const other = dec?.sourceEntityIds.find((id) => id !== survivor);
      out.push({ q, root, mentions: [], decision: dec && survivor && other ? { id: dec.id, a: survivor, b: other } : null, options });
    }
  }
  return out;
}

export async function planBacklog(deps: BacklogDeps, run: Parameters<AgentTaskHandler<BacklogInput, BacklogProposal>["execute"]>[0], llm: Parameters<AgentTaskHandler<BacklogInput, BacklogProposal>["execute"]>[3] | null, settings: AgentSettings, context?: { system?: string; messages?: Array<{ role: "user" | "assistant"; content: string }> }): Promise<BacklogProposal> {
  const scope = { novelId: run.novelId };
  const targets = await gather(deps, scope);
  const proposal: BacklogProposal = { actions: [], open: targets.length, kept: 0, calls: 0 };
  if (targets.length === 0) return proposal;
  const nonEntity = new Set(await deps.ontology.listNonEntitySurfaces(scope));
  const entityTypes = new Set((await deps.ontology.getSchema(scope)).schema.entityTypes.filter((t) => t.enabled).map((t) => t.key as string));
  const typeOf = new Map<string, { type: string; status: string }>();
  const entityInfo = async (id: string) => {
    if (!typeOf.has(id)) {
      const e = await deps.ontology.getEntity(scope, id).catch(() => null);
      typeOf.set(id, e ? { type: e.entityType, status: e.status } : { type: "", status: "missing" });
    }
    return typeOf.get(id)!;
  };
  const act = (t: Target, a: Omit<BacklogAction, "questionId" | "topic" | "rootQuestionId">) => proposal.actions.push({ questionId: t.q.id, topic: t.q.topic, rootQuestionId: t.root.id, ...a });

  // ── entity_disambiguation (incl. interpretation children): one decision per normalized surface ──
  const bySurface = new Map<string, Target[]>();
  const dupTargets: Target[] = [];
  for (const t of targets) {
    if (t.root.topic === "duplicate_entity") {
      if (!t.decision) act(t, { kind: "stale", confidence: 1, rationale: "병합 제안이 이미 처리되었습니다", source: "rule" });
      else dupTargets.push(t);
      continue;
    }
    if (t.mentions.length === 0) {
      act(t, { kind: "stale", confidence: 1, rationale: "이미 처리된 언급입니다", source: "rule" });
      continue;
    }
    const k = normalizedKey(t.mentions[0]!.surface);
    bySurface.set(k, [...(bySurface.get(k) ?? []), t]);
  }
  const items: ResolverItem[] = [];
  const itemTargets = new Map<string, Target[]>();
  for (const [k, ts] of bySurface) {
    const head = ts[0]!.mentions[0]!;
    const all = ts.flatMap((t) => t.mentions);
    const candIds = [...new Set(all.flatMap((m) => ((m.candidates ?? []) as Array<{ entityId: string }>).map((c) => c.entityId)))];
    let salience: SurfaceClass = classifySurface(head.surface, head.mentionKind, nonEntity);
    const exact = await deps.ontology.findExactNamedEntities(scope, head.surface);
    if ((salience === "generic" || salience === "generic_hint") && exact.length) salience = "candidate";
    const each = (a: Omit<BacklogAction, "questionId" | "topic" | "rootQuestionId" | "optionIdx">) => {
      for (const t of ts) act(t, { ...a, optionIdx: optionIdxFor(t, a.kind, a.entityId) });
    };
    if (salience === "generic") {
      each({ kind: "not_entity", surface: head.surface, confidence: 1, rationale: nonEntity.has(k) ? "엔티티가 아닌 표현으로 기억된 표기" : "일반 명사(배경 표현)", source: nonEntity.has(k) ? "memory" : "rule" });
      continue;
    }
    if (isCoreferenceOnly(salience)) {
      const persons: string[] = [];
      for (const id of candIds) if (PERSON_TYPES.has((await entityInfo(id)).type)) persons.push(id);
      if (persons.length === 1) {
        each({ kind: "entity", entityId: persons[0]!, surface: head.surface, confidence: 0.9, rationale: "장면에 있는 유일한 인물(공지시)", source: "rule" });
        continue;
      }
    } else if (exact.length === 1 && exact[0]!.status === "active") {
      // alias memory: the surface is (now) exactly a name of one live entity
      each({ kind: "entity", entityId: exact[0]!.entityId, surface: head.surface, confidence: 0.95, rationale: "같은 표기가 이미 이 엔티티의 이름(별칭)입니다", source: "memory" });
      continue;
    }
    const key = `s|${k}`;
    itemTargets.set(key, ts);
    items.push({
      key,
      surface: head.surface,
      mentionKind: head.mentionKind,
      episodeNo: Math.floor(head.storyPoint / 1000) || null,
      contexts: [...new Set(ts.map((t) => t.root.body.split("\n").filter((l) => l.startsWith("· ")).map((l) => l.slice(2))).flat())].slice(0, 3),
      candidateIds: candIds.slice(0, MAX_CARD_OPTIONS * 2),
      salience,
      note: `질문 ${ts.length}건`,
    });
  }
  // ── duplicate_entity: identical names → same (deterministic), else the resolver ──
  for (const t of dupTargets) {
    const { a: a0, b: b0 } = t.decision!;
    // a source merged / retired since the proposal: nothing (or something else) to merge → close the question
    const resolved = await deps.ontology.resolveEntityIds(scope, [a0, b0]);
    const a = resolved.get(a0) ?? a0;
    const b = resolved.get(b0) ?? b0;
    const live = a === b ? [] : (await deps.ontology.getEntities(scope, [a, b])).filter((e) => e.status === "active" || e.status === "candidate");
    if (live.length < 2) {
      act(t, { kind: "stale", decisionId: t.decision!.id, confidence: 1, rationale: "병합 대상이 이미 하나로 정리되었습니다", source: "rule" });
      continue;
    }
    const [ea, eb] = live;
    // the representative (preferred) names themselves are identical — a shared alias is not enough
    const pa = ea ? (await deps.ontology.listEntityNames(scope, ea.id)).find((n) => n.isPreferred)?.normalizedKey : undefined;
    const pb = eb ? (await deps.ontology.listEntityNames(scope, eb.id)).find((n) => n.isPreferred)?.normalizedKey : undefined;
    if (ea && eb && ea.entityType === eb.entityType && pb && pa === pb && (ea.disambiguator ?? null) === (eb.disambiguator ?? null) && (ea.status === "candidate" || eb.status === "candidate")) {
      act(t, { kind: "same", optionIdx: 0, confidence: 1, rationale: "정규화한 이름이 같고 유형이 같습니다", source: "rule" });
      continue;
    }
    const key = `d|${t.q.id}`;
    itemTargets.set(key, [t]);
    items.push({ key, surface: "", mentionKind: "named", contexts: [], candidateIds: [a, b], salience: "candidate", pair: { a, b } });
  }
  if (items.length && llm) {
    const entities = await resolverEntities(deps.ontology, scope);
    for (const e of entities) typeOf.set(e.entityId, { type: e.entityType, status: e.status });
    const out = await resolveMentions({ llm, run, items, entities, entityTypes, system: context?.system, messages: context?.messages, log: deps.log });
    proposal.calls = out.calls;
    for (const it of items) {
      const ts = itemTargets.get(it.key)!;
      const d = out.decisions.get(it.key);
      const coref = isCoreferenceOnly(it.salience);
      if (!d || d.confidence < settings.minConfidence) {
        // pronouns / generic address forms are never asked: close the question, the mention stays held
        if (coref) {
          for (const t of ts) act(t, { kind: "close", optionIdx: null, surface: it.surface, confidence: d?.confidence ?? 0, rationale: "대명사·일반 호칭은 문맥으로만 판단하고 묻지 않습니다", source: "rule" });
          continue;
        }
        // same rule as an extraction (planAction): a low-confidence judgement is asked only when two or more established
        // named entities compete; otherwise the question is closed and the mentions stay held (never re-asked). A pair
        // (duplicate_entity) or a failed model call stays open.
        const cands = ts.flatMap((t) => t.mentions.flatMap((m) => (m.candidates ?? []) as Array<{ entityId: string; via?: string }>));
        for (const c of cands) await entityInfo(c.entityId);
        if (d && !it.pair && !contested(cands, (id) => typeOf.get(id)?.status)) {
          for (const t of ts) act(t, { kind: "close", optionIdx: null, surface: it.surface, confidence: d.confidence, rationale: `확신이 낮지만(${d.confidence.toFixed(2)}) 다투는 기존 인물·대상이 없어 묻지 않고 보류합니다: ${d.rationale}`.slice(0, 500), source: "agent" });
          continue;
        }
        proposal.kept += ts.length;
        continue;
      }
      if (it.pair) {
        act(ts[0]!, { kind: d.action === "merge" ? "same" : "distinct", optionIdx: d.action === "merge" ? 0 : 1, confidence: d.confidence, rationale: d.rationale, source: "agent" });
        continue;
      }
      const kind: DecisionKind | null =
        d.action === "link_existing" || d.action === "add_alias" || d.action === "merge" ? "entity" : d.action === "create_entity" ? (coref ? "close" : "new_entity") : d.action === "ignore" ? "not_entity" : null;
      if (!kind) {
        proposal.kept += ts.length;
        continue;
      }
      for (const t of ts) {
        act(t, {
          kind,
          entityId: d.entityId,
          entityType: d.entityType,
          canonicalName: d.canonicalName,
          optionIdx: optionIdxFor(t, kind, d.entityId),
          surface: it.surface,
          confidence: d.confidence,
          rationale: `${d.action === "add_alias" && !coref ? "별칭으로 기억: " : ""}${d.rationale}`,
          source: "agent",
        });
      }
    }
  } else if (items.length) proposal.kept += [...itemTargets.values()].reduce((n, ts) => n + ts.length, 0);
  return proposal;
}

/** applies an entity_disambiguation decision to the root question's pending mentions (+ alias / non-entity memory) */
/** entities created by one backlog commit, by `${type}|${normalizedKey(name)}` (N questions of one surface → one entity) */
type CreatedMap = Map<string, string>;

async function applyMentionDecision(deps: BacklogDeps, tx: Tx, scope: NovelScope, rootQuestionId: string, a: BacklogAction, actor: ActorRef, answerId: string | undefined, createdMap: CreatedMap): ReturnType<AnswerApplier> {
  const ms = (await deps.ontology.listMentions(scope, { questionId: rootQuestionId }, tx)).filter(pendingMention);
  if (ms.length === 0) return { status: "not_applied", reason: "이미 처리된 언급입니다", items: [] };
  const items: Awaited<ReturnType<AnswerApplier>>["items"] = [];
  const newType = a.entityType || "character";
  for (const m of ms) {
    if (a.kind === "not_entity" && m.linkStatus === "new_entity_candidate") continue; // MN6 only from ambiguous
    let decision: Parameters<typeof confirmMention>[4];
    const name = a.canonicalName || m.surface;
    const createdKey = `${newType}|${normalizedKey(name)}`;
    if (a.kind === "entity") decision = { kind: "entity", entityId: a.entityId! };
    else if (a.kind === "new_entity") {
      // an entity of this exact name (and type) already exists, or this commit created it → link, never a duplicate
      let existing = createdMap.get(createdKey) ?? null;
      if (!existing) {
        const same = (await deps.ontology.findExactNamedEntities(scope, name, { entityType: newType }, tx)).find((e) => e.status === "active" || e.status === "candidate");
        if (same) existing = same.entityId;
      }
      decision = existing ? { kind: "entity", entityId: existing } : { kind: "new_entity", entityType: newType, preferredName: name };
    } else decision = { kind: "not_entity" };
    const r = await confirmMention(deps, tx, scope, m.id, decision, actor, { questionId: rootQuestionId, ...(answerId ? { answerId } : {}) });
    if (a.kind === "new_entity" && r.entityId) createdMap.set(createdKey, r.entityId);
    if (r.entityId && (a.kind === "entity" || (a.kind === "new_entity" && normalizedKey(a.canonicalName ?? m.surface) !== normalizedKey(m.surface)))) await rememberAlias(deps, tx, scope, r.entityId, { surface: m.surface, mentionKind: m.mentionKind as MentionKind }, actor);
    if (a.kind === "not_entity" && a.source === "agent") await rememberNotEntity(deps, tx, scope, m, actor, a.rationale);
    items.push({ changeKind: "fact_changed", ref: { type: "mention", id: m.id }, summary: r.entityId ? `"${m.surface}" 연결을 확정했습니다(에이전트)` : `"${m.surface}"은(는) 엔티티가 아닌 것으로 기록했습니다(에이전트)` });
  }
  return { status: "applied", items };
}

export interface BacklogFailure {
  questionId: string;
  topic: QuestionTopic;
  kind: DecisionKind;
  error: string;
}

/**
 * Applies the plan. Every action runs in its own SAVEPOINT: an action that throws (e.g. an identity decision the
 * ontology refuses) rolls back alone, its question stays open, and the rest of the backlog is still committed — one bad
 * item never fails the task (which would re-run the whole plan).
 */
export async function commitBacklog(deps: BacklogDeps, tx: Tx, scope: NovelScope, p: BacklogProposal, actor: ActorRef): Promise<{ handled: string[]; skipped: number; failed: BacklogFailure[] }> {
  const handled: string[] = [];
  let skipped = 0;
  const failed: BacklogFailure[] = [];
  let createdMap: CreatedMap = new Map();
  for (const a of p.actions) {
    const before = new Map(createdMap);
    try {
      if (await savepoint(tx, (sp) => commitAction(deps, sp, scope, a, actor, createdMap))) handled.push(a.questionId);
      else skipped++;
    } catch (err) {
      createdMap = before; // entities created in the rolled-back savepoint are gone
      const error = err instanceof Error ? `${(err as { code?: string }).code ? `${(err as { code?: string }).code}: ` : ""}${err.message}` : String(err);
      failed.push({ questionId: a.questionId, topic: a.topic, kind: a.kind, error: error.slice(0, 300) });
      deps.log?.warn({ err, questionId: a.questionId, topic: a.topic, decision: a.kind }, "resolve_entities: action failed — question left open, continuing");
    }
  }
  return { handled, skipped, failed };
}

/** one backlog action in the given (savepoint) transaction; true = the question was handled */
async function commitAction(deps: BacklogDeps, tx: Tx, scope: NovelScope, a: BacklogAction, actor: ActorRef, createdMap: CreatedMap): Promise<boolean> {
  const audit = async (outcome: string) => {
    await deps.audit?.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "question.agent_resolved",
      target: { type: "question", id: a.questionId },
      after: { decision: a.kind, outcome, entityId: a.entityId ?? null, entityType: a.entityType ?? null },
      reason: a.rationale.slice(0, 500),
      details: { topic: a.topic, rootQuestionId: a.rootQuestionId, surface: a.surface ?? null, confidence: a.confidence, source: a.source },
      questionId: a.questionId,
    });
  };
  const cancel = async (why: string) => {
    try {
      await deps.hitl.cancelQuestion(tx, scope, a.questionId, `${AGENT_CANCEL_REASON}: ${why}`.slice(0, 500), actor);
      return true;
    } catch (err) {
      if (err instanceof InvalidTransitionError) return false;
      throw err;
    }
  };
  if (a.topic === "interpretation_confirm") {
    // the root was answered with free text; its interpretation waits for confirmation → decide it here, never ask again
    const r = await deps.hitl.agentCloseInterpretation(tx, scope, a.questionId, actor, `${AGENT_CANCEL_REASON}: ${a.rationale}`.slice(0, 500));
    if (!r) return false;
    let refl: Awaited<ReturnType<AnswerApplier>>;
    if (a.kind === "stale" || a.kind === "close") refl = { status: "not_applied", reason: a.kind === "close" ? `묻지 않고 보류합니다(에이전트): ${a.rationale}`.slice(0, 500) : "이미 처리된 항목입니다", items: [] };
    else if (a.kind === "same" || a.kind === "distinct") {
      const dec = (await deps.ontology.listIdentityDecisions(scope, { statuses: ["proposed"] }, tx)).find((d) => d.questionId === a.rootQuestionId);
      refl = dec ? await applyDuplicateDecision(deps, tx, scope, dec.id, a.kind === "same", actor, a.rootQuestionId) : { status: "not_applied", reason: "병합 제안이 이미 처리되었습니다", items: [] };
    } else refl = await applyMentionDecision(deps, tx, scope, a.rootQuestionId, a, actor, r.rootAnswerId ?? undefined, createdMap);
    if (r.rootAnswerId && r.rootStatus === "answered") await deps.hitl.recordReflection(tx, scope, r.rootAnswerId, refl, actor);
    await audit("interpretation_closed");
    return true;
  }
  if (a.kind === "stale" || a.kind === "close") {
    if (a.decisionId) {
      const dec = await deps.ontology.getIdentityDecision(scope, a.decisionId, tx).catch(() => null);
      if (dec?.status === "proposed") await deps.ontology.rejectIdentityDecision(tx, scope, dec.id, actor, a.rationale.slice(0, 200));
    }
    if (!(await cancel(a.rationale))) return false;
    await audit("cancelled");
    return true;
  }
  if (a.topic === "duplicate_entity") {
    const r = await deps.hitl.agentResolveQuestion(tx, scope, a.questionId, { optionIdx: a.optionIdx ?? (a.kind === "same" ? 0 : 1), actor, note: a.rationale });
    if (!r.decided) return false;
    await audit("answered");
    return true;
  }
  // entity_disambiguation
  if (a.optionIdx === null || a.optionIdx === undefined) {
    // the decision is not one of the question's options (e.g. an entity that was not a candidate card): apply it
    // directly and close the question
    const r = await applyMentionDecision(deps, tx, scope, a.questionId, a, actor, undefined, createdMap);
    if (r.status !== "applied") return false;
    if (!(await cancel(`"${a.surface ?? ""}" ${a.kind === "entity" ? "연결" : a.kind === "new_entity" ? "새 엔티티" : "엔티티 아님"}(${a.rationale})`))) return false;
    await audit("applied_and_cancelled");
    return true;
  }
  try {
    const r = await deps.hitl.agentResolveQuestion(tx, scope, a.questionId, {
      optionIdx: a.optionIdx,
      actor,
      note: a.rationale,
      applier: ({ tx: t, scope: s, question, answer, actor: who }) => applyMentionDecision(deps, t, s, question.id, a, who, answer.id, createdMap),
    });
    if (!r.decided) return false;
    await audit("answered");
    return true;
  } catch (err) {
    if (err instanceof DomainValidationError && err.code === "auto_answer_lost") return false;
    throw err;
  }
}

export function resolveEntitiesHandler(deps: BacklogDeps): AgentTaskHandler<BacklogInput, BacklogProposal> {
  return {
    kind: "resolve_entities",
    role: "world_keeper",
    promptTemplateVersion: "world_keeper.resolve_entities@0.1.0",
    inputSchema: resolveEntitiesInputSchema,
    allowedWrites: ["hitl.agentResolveQuestion", "hitl.cancelQuestion", "ontology.decideMention", "ontology.addEntityName", "ontology.applyIdentityDecision", "ontology.setEntityStatus"],
    async buildContext() {
      return { snapshotId: "", system: "", messages: [], handles: { entities: [], names: [] }, tokenEstimate: 0, droppedSections: [] };
    },
    async execute(run, _input, context, llm) {
      const scope = { novelId: run.novelId };
      const settings = await agentSettings(deps.novel, scope);
      const p = await planBacklog(deps, run, llm, settings, context);
      run.noteOutputSummary?.("entityBacklog", { open: p.open, decided: p.actions.length, kept: p.kept, calls: p.calls });
      return p;
    },
    async commit(tx, run, _input, p): Promise<CommitOutcome> {
      const scope = { novelId: run.novelId };
      const r = await commitBacklog(deps, tx, scope, p, actors.agent("world_keeper", run.runId));
      run.noteOutputSummary?.("entityBacklogCommit", { handled: r.handled.length, skipped: r.skipped, failed: r.failed.length, failures: r.failed.slice(0, 20) });
      return { kind: "done", outputRefs: r.handled.slice(0, 200).map((id) => ({ refType: "question" as const, refId: id })) };
    },
  };
}

export type { ResolutionDeps };
