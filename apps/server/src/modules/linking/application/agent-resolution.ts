/**
 * 설계 추가 0015: entity resolver agent applied to an extraction (extract_facts) — at every autonomy level, when the novel's
 * `entity_agent_resolution` is on.
 *
 *  execute (no transaction): every mention the linker would ask about or turn into a new candidate entity is
 *    1. filtered deterministically (salience.ts): generic common nouns / remembered non-entities → ignore; pronouns and
 *       generic address forms → coreference only (the unique scene person, else the resolver; never asked);
 *    2. the rest is judged by the resolver (one model call per batch, resolver.ts) → link / alias / create / ignore;
 *    3. a judgement below `entity_agent_min_confidence` goes to the inbox ONLY when it matters (two plausible active named
 *       entities); otherwise the mention is held without a question (tag AGENT_HOLD_TAG, never re-asked).
 *  commit (the extraction's transaction): the plan rewrites the LinkerResult before commitLinkerResult writes it, then
 *    aliases / non-entity memory are stored and every decision is audited (`mention.agent_resolved`, actor = the run's
 *    world_keeper). Everything stays reversible: relinkMentions, setEntityNameStatus(retired), identity revert.
 * A model failure keeps the old path for ordinary names (question / candidate entity) and holds pronoun-like surfaces.
 */
import type { MentionKind } from "@ncs/shared";
import type { ActorRef, Logger, NovelScope, Tx } from "../../../platform/index.js";
import type { AuditService } from "../../audit/index.js";
import { carriesHandle, isHandleShaped, type ContextPack } from "../../agents/index.js";
import type { ModelCallPort } from "../../llm/index.js";
import type { NovelService } from "../../novel/index.js";
import { normalizedKey, type OntologyService } from "../../ontology/index.js";
import type { RunHandle } from "../../orchestration/index.js";
import type { HitlService } from "../../hitl/index.js";
import type { AgentQuestionHint, LinkerCommitResult, LinkerResult } from "../index.js";
import { classifySurface, isCoreferenceOnly, PERSON_TYPES, type SurfaceClass } from "../domain/salience.js";
import { resolveMentions, type ResolverDecision, type ResolverEntity, type ResolverItem } from "./resolver.js";
import type { AgentSettings } from "./commit.js";
import { rememberAlias, rememberNotEntity } from "./decisions.js";

/** rationale prefix of mentions the resolver held without a question (link_mentions does not re-ask them) */
export const AGENT_HOLD_TAG = "[에이전트 보류]";

export interface ResolutionDeps {
  ontology: OntologyService;
  hitl: HitlService;
  novel?: NovelService;
  audit?: AuditService;
  log?: Logger;
}

export type PlanAction = "link" | "alias" | "create" | "ignore" | "hold" | "ask" | "keep";

export interface PlanEntry {
  /** linker mention indexes sharing this decision */
  indexes: number[];
  surface: string;
  mentionKind: string;
  salience: SurfaceClass;
  action: PlanAction;
  entityId?: string | null;
  entityType?: string | null;
  canonicalName?: string | null;
  confidence: number;
  rationale: string;
  /** rule = fixed lists / unique scene person, memory = remembered non-entity, agent = resolver, fallback = model failed */
  source: "rule" | "memory" | "agent" | "fallback";
  hint?: AgentQuestionHint | null;
}

export interface ExtractionPlan {
  entries: PlanEntry[];
  calls: number;
  failed: boolean;
  minConfidence: number;
}

/** candidate entities of the resolver prompt (live entities + names) */
export async function resolverEntities(ontology: OntologyService, scope: NovelScope, tx?: Tx): Promise<ResolverEntity[]> {
  const list = await ontology.listEntities(scope, { statuses: ["candidate", "active"], limit: 500 }, tx);
  const out: ResolverEntity[] = [];
  for (const { entity: e, preferredName } of list) {
    const live = (await ontology.listEntityNames(scope, e.id, tx)).filter((n) => n.status !== "retired" && n.nameKind !== "hidden_variant").map((n) => n.surface);
    // 설계 추가 0026 (P5): a handle-shaped name ("E11") is not a name — an entity that has nothing else (a ghost made
    // from a leaked handle) is never offered as a link target
    const names = [preferredName, ...live.filter((n) => n !== preferredName)].filter((n) => !isHandleShaped(n));
    if (!names.length) continue;
    out.push({ entityId: e.id, entityType: e.entityType, status: e.status, names, summary: e.summary, disambiguator: e.disambiguator });
  }
  return out;
}

/** low confidence matters (→ inbox) only when two or more established, name-matched entities compete */
export function contested(candidates: Array<{ entityId: string; via?: string }>, statusOf: (id: string) => string | undefined): boolean {
  const named = candidates.filter((c) => c.via !== "scene" && c.via !== "nil" && statusOf(c.entityId) === "active");
  return new Set(named.map((c) => c.entityId)).size >= 2;
}

function hintOf(d: ResolverDecision, candidateIds: string[]): AgentQuestionHint {
  const rec: AgentQuestionHint["recommend"] =
    (d.action === "link_existing" || d.action === "add_alias") && d.entityId && candidateIds.includes(d.entityId)
      ? { kind: "entity", entityId: d.entityId }
      : d.action === "create_entity"
        ? { kind: "new_entity", entityType: d.entityType }
        : d.action === "ignore"
          ? { kind: "not_entity" }
          : null;
  return { recommend: rec, confidence: d.confidence, rationale: d.rationale };
}

/** decision → plan action (threshold, coreference-only rules) */
export function planAction(d: ResolverDecision | undefined, o: { salience: SurfaceClass; minConfidence: number; asked: boolean; contested: boolean }): PlanAction {
  const coref = isCoreferenceOnly(o.salience);
  if (!d) return coref || o.salience === "generic_hint" ? "hold" : "keep";
  if (d.confidence >= o.minConfidence) {
    if (d.action === "link_existing" && d.entityId) return "link";
    if ((d.action === "add_alias" || d.action === "merge") && d.entityId) return coref ? "link" : "alias";
    if (d.action === "create_entity") return coref ? "hold" : "create";
    if (d.action === "ignore") return "ignore";
    return coref ? "hold" : "keep";
  }
  if (coref) return "hold";
  if (o.asked && o.contested) return "ask";
  // a new name the resolver is unsure about stays a candidate entity (old path) unless it looks like a backdrop noun
  return o.asked || o.salience === "generic_hint" ? "hold" : "keep";
}

export async function planExtraction(
  deps: ResolutionDeps,
  run: RunHandle,
  llm: ModelCallPort | null,
  scope: NovelScope,
  input: { linker: LinkerResult; excerpts: Record<number, string>; settings: AgentSettings; context?: ContextPack; entityTypes: ReadonlySet<string> },
): Promise<ExtractionPlan> {
  const { linker, settings } = input;
  const plan: ExtractionPlan = { entries: [], calls: 0, failed: false, minConfidence: settings.minConfidence };
  const asked = new Set(linker.questionsNeeded.map((q) => q.mentionIndex));
  const fresh = new Set((linker.newEntities ?? []).map((n) => n.mentionIndex));
  if (asked.size === 0 && fresh.size === 0) return plan;
  const nonEntity = new Set(await deps.ontology.listNonEntitySurfaces(scope));
  const groups = new Map<string, { indexes: number[]; asked: boolean; salience: SurfaceClass }>();
  for (const i of [...new Set([...asked, ...fresh])].sort((a, b) => a - b)) {
    const m = linker.mentions[i]!;
    if (m.mentionKind === "zero") continue;
    let salience = classifySurface(m.surface, m.mentionKind, nonEntity);
    // a surface some entity is named exactly is never a "generic" word
    if ((salience === "generic" || salience === "generic_hint") && m.candidates.some((c) => c.via === "exact" || c.via === "normalized")) salience = "candidate";
    const nk = normalizedKey(m.surface);
    const key = isCoreferenceOnly(salience) ? `c|${m.sceneId ?? ""}|${nk}` : `${asked.has(i) ? "q" : "n"}|${nk}`;
    const g = groups.get(key) ?? { indexes: [], asked: asked.has(i), salience };
    g.indexes.push(i);
    groups.set(key, g);
  }
  const idsInPlay = [...new Set([...groups.values()].flatMap((g) => g.indexes.flatMap((i) => linker.mentions[i]!.candidates.map((c) => c.entityId))))];
  const ents = new Map((await deps.ontology.getEntities(scope, idsInPlay)).map((e) => [e.id, e]));
  const items: ResolverItem[] = [];
  const pending: Array<{ key: string; g: { indexes: number[]; asked: boolean; salience: SurfaceClass } }> = [];
  for (const [key, g] of groups) {
    const head = linker.mentions[g.indexes[0]!]!;
    const base = { indexes: g.indexes, surface: head.surface, mentionKind: head.mentionKind, salience: g.salience };
    if (g.salience === "generic") {
      const memo = nonEntity.has(normalizedKey(head.surface));
      plan.entries.push({ ...base, action: "ignore", confidence: 1, rationale: memo ? "엔티티가 아닌 표현으로 기억된 표기" : "일반 명사(배경 표현)", source: memo ? "memory" : "rule" });
      continue;
    }
    const candIds = [...new Set(head.candidates.map((c) => c.entityId))];
    if (isCoreferenceOnly(g.salience)) {
      const persons = candIds.filter((id) => PERSON_TYPES.has(ents.get(id)?.entityType ?? ""));
      if (persons.length === 1 && ents.get(persons[0]!)?.status !== "merged") {
        plan.entries.push({ ...base, action: "link", entityId: persons[0]!, confidence: 0.9, rationale: "장면에 있는 유일한 인물(공지시)", source: "rule" });
        continue;
      }
    }
    items.push({
      key,
      surface: head.surface,
      mentionKind: head.mentionKind,
      typeHint: linker.entityTypeHints?.[g.indexes[0]!] ?? null,
      episodeNo: Math.floor(head.storyPoint / 1000) || null,
      contexts: g.indexes.map((i) => input.excerpts[i]).filter((x): x is string => !!x),
      candidateIds: candIds,
      salience: g.salience,
    });
    pending.push({ key, g });
  }
  if (items.length) {
    const entities = await resolverEntities(deps.ontology, scope);
    for (const e of entities) if (!ents.has(e.entityId)) ents.set(e.entityId, { id: e.entityId, entityType: e.entityType, status: e.status } as never);
    const out = await resolveMentions({ llm, run, items, entities, entityTypes: input.entityTypes, system: input.context?.system, messages: input.context?.messages, story: await deps.ontology.storyHandleTokens(scope), log: deps.log });
    plan.calls = out.calls;
    plan.failed = out.failed;
    for (const { key, g } of pending) {
      const head = linker.mentions[g.indexes[0]!]!;
      const d = out.decisions.get(key);
      const candIds = [...new Set(head.candidates.map((c) => c.entityId))];
      const isContested = contested(head.candidates, (id) => ents.get(id)?.status);
      const action = planAction(d, { salience: g.salience, minConfidence: settings.minConfidence, asked: g.asked, contested: isContested });
      plan.entries.push({
        indexes: g.indexes,
        surface: head.surface,
        mentionKind: head.mentionKind,
        salience: g.salience,
        action,
        entityId: d?.entityId ?? null,
        entityType: d?.entityType ?? null,
        canonicalName: d?.canonicalName ?? null,
        confidence: d?.confidence ?? 0,
        rationale: d?.rationale ?? (out.failed ? "판정 에이전트 호출 실패" : "판정 없음"),
        source: d ? "agent" : "fallback",
        hint: action === "ask" && d ? hintOf(d, candIds) : null,
      });
    }
  }
  return plan;
}

/** commit side, before commitLinkerResult: the LinkerResult the plan describes (entity ids re-checked in the tx) */
export async function applyPlanToLinker(deps: ResolutionDeps, tx: Tx, scope: NovelScope, linker: LinkerResult, plan: ExtractionPlan): Promise<{ result: LinkerResult; entries: PlanEntry[] }> {
  const r: LinkerResult = {
    ...linker,
    mentions: linker.mentions.map((m) => ({ ...m, candidates: [...m.candidates] })),
    questionsNeeded: [...linker.questionsNeeded],
    newEntities: [...(linker.newEntities ?? [])],
    reportHold: [...(linker.reportHold ?? [])],
    agentHints: { ...(linker.agentHints ?? {}) },
    agentCreatedKeys: [...(linker.agentCreatedKeys ?? [])],
  };
  const drop = (i: number) => {
    r.questionsNeeded = r.questionsNeeded.filter((q) => q.mentionIndex !== i);
    r.newEntities = r.newEntities!.filter((n) => n.mentionIndex !== i);
    r.reportHold = r.reportHold!.filter((x) => x !== i);
  };
  const story = await deps.ontology.storyHandleTokens(scope, tx);
  const note = (e: PlanEntry) => `에이전트 판정(${e.source}, ${e.confidence.toFixed(2)}): ${e.rationale}`.slice(0, 500);
  const applied: PlanEntry[] = [];
  for (const e0 of plan.entries) {
    let e = e0;
    if (e.action === "link" || e.action === "alias") {
      const ent = e.entityId ? await deps.ontology.getEntity(scope, e.entityId, tx).catch(() => null) : null;
      if (!ent || (ent.status !== "active" && ent.status !== "candidate")) e = { ...e, action: isCoreferenceOnly(e.salience) || e.salience === "generic_hint" ? "hold" : "keep", rationale: `${e.rationale} (대상 엔티티가 없어짐)` };
      else e = { ...e, entityId: ent.id };
    }
    for (const i of e.indexes) {
      const m = r.mentions[i]!;
      switch (e.action) {
        case "link":
        case "alias": {
          const ent = await deps.ontology.getEntity(scope, e.entityId!, tx);
          drop(i);
          m.linkedEntityId = ent.id;
          m.linkStatus = ent.status === "active" ? "auto_linked" : "new_entity_candidate";
          m.viaNameId = null;
          m.viaEntityId = null;
          m.confidence = e.confidence;
          m.rationale = note(e);
          if (!m.candidates.some((c) => c.entityId === ent.id)) m.candidates = [{ entityId: ent.id, score: e.confidence, via: "agent" }, ...m.candidates];
          break;
        }
        case "create": {
          const type = e.entityType ?? r.newEntities!.find((n) => n.mentionIndex === i)?.entityType ?? "character";
          // 설계 추가 0026 (P5 / P1): a canonical name that is a handle or carries one (a plan made before the resolver
          // check) is not used
          const canonical = e.canonicalName?.trim();
          const name = canonical && !carriesHandle(canonical, story) ? canonical : m.surface;
          drop(i);
          r.newEntities!.push({ mentionIndex: i, entityType: type, surface: name });
          r.agentCreatedKeys!.push(`${type}|${normalizedKey(name)}`);
          m.linkStatus = "ambiguous";
          m.linkedEntityId = null;
          m.rationale = note(e);
          e = { ...e, entityType: type, canonicalName: name };
          break;
        }
        case "ignore":
          drop(i);
          m.linkStatus = "rejected";
          m.linkedEntityId = null;
          m.viaNameId = null;
          m.viaEntityId = null;
          m.confidence = e.confidence;
          m.rationale = note(e);
          break;
        case "hold":
          drop(i);
          r.reportHold!.push(i);
          m.linkStatus = "ambiguous";
          m.linkedEntityId = null;
          m.viaNameId = null;
          m.rationale = `${AGENT_HOLD_TAG} ${note(e)}`.slice(0, 500);
          break;
        case "ask":
          if (!r.questionsNeeded.some((q) => q.mentionIndex === i)) {
            drop(i);
            r.questionsNeeded.push({ mentionIndex: i, reason: "ambiguous" });
          }
          if (e.hint) r.agentHints![i] = e.hint;
          break;
        case "keep":
          break;
      }
    }
    applied.push(e);
  }
  return { result: r, entries: applied };
}

/** commit side, after commitLinkerResult: alias / non-entity memory + audit */
export async function finishPlan(deps: ResolutionDeps, tx: Tx, scope: NovelScope, entries: PlanEntry[], written: LinkerCommitResult, actor: ActorRef): Promise<Record<PlanAction, number>> {
  const counts: Record<PlanAction, number> = { link: 0, alias: 0, create: 0, ignore: 0, hold: 0, ask: 0, keep: 0 };
  for (const e of entries) {
    counts[e.action] += e.indexes.length;
    if (e.action === "keep") continue;
    const head = { surface: e.surface, mentionKind: e.mentionKind as MentionKind };
    let aliasNameId: string | null = null;
    if (e.action === "alias" && e.entityId) aliasNameId = await rememberAlias(deps, tx, scope, e.entityId, head, actor);
    if (e.action === "create" && e.canonicalName && normalizedKey(e.canonicalName) !== normalizedKey(e.surface)) {
      const [m] = await deps.ontology.listMentions(scope, { ids: [written.mentionIds[e.indexes[0]!]!] }, tx);
      if (m?.linkedEntityId) aliasNameId = await rememberAlias(deps, tx, scope, m.linkedEntityId, head, actor);
    }
    if (e.action === "ignore" && e.source === "agent") await rememberNotEntity(deps, tx, scope, head, actor, e.rationale);
    if (!deps.audit) continue;
    const mentionIds = e.indexes.map((i) => written.mentionIds[i]!).filter(Boolean);
    await deps.audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "mention.agent_resolved",
      target: { type: "mention", id: mentionIds[0]! },
      after: { action: e.action, entityId: e.entityId ?? null, entityType: e.entityType ?? null },
      reason: e.rationale.slice(0, 500),
      details: { surface: e.surface, confidence: e.confidence, source: e.source, salience: e.salience, mentionIds: mentionIds.slice(0, 50), mentions: mentionIds.length, aliasNameId },
    });
  }
  return counts;
}
