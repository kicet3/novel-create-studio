/**
 * Linker pipeline (06 §3.8): L1 speaker/pov carry-over, L2 candidate generation via OntologyRepository,
 * L3 rule features, L4 closed-choice judgement (LLM through ModelCallPort when a run is given, otherwise the
 * deterministic rule judge), L5–L7 decision, L8 chain consistency. No writes (commit is separate).
 */
import { defaultValue, type MentionKind, type MentionSourceKind } from "@ncs/shared";
import { NotImplementedError, type NovelScope } from "../../../platform/index.js";
import type { LlmService } from "../../llm/index.js";
import { normalizedKey, type OntologyService, type StoryAnchor } from "../../ontology/index.js";
import type { RunHandle } from "../../orchestration/index.js";
import type { LinkerInputMention, LinkerResult } from "../index.js";
import { decide, LINKER_VERSION, ruleJudge, ruleScore, sceneConsistency, truncateCandidates, type CandidateFeatures, type LinkCandidate, type LinkDecision, type Thresholds, type Vote } from "../domain/linker.js";
import { l4ChoiceSchema } from "../domain/schemas.js";

export function thresholds(): Thresholds {
  return {
    tauAuto: {
      named: defaultValue("linking.tau_auto.named"),
      title: defaultValue("linking.tau_auto.title"),
      address: defaultValue("linking.tau_auto.address"),
      pronoun: defaultValue("linking.tau_auto.pronoun"),
      descriptive: defaultValue("linking.tau_auto.descriptive"),
      zero: defaultValue("linking.tau_auto.zero"),
    },
    tauAsk: defaultValue("linking.tau_ask"),
    marginDelta: defaultValue("linking.margin_delta"),
    requireUnanimous: defaultValue("linking.require_unanimous_samples"),
    hiddenVariantCap: defaultValue("linking.hidden_variant_rule_score_cap"),
    candidateTopK: defaultValue("linking.candidate_top_k"),
  };
}

export interface LinkerDeps {
  ontology: OntologyService;
  llm: LlmService;
}

interface Built {
  index: number;
  m: LinkerInputMention;
  kind: MentionKind;
  candidates: LinkCandidate[];
  truncated: boolean;
  decision?: LinkDecision;
  chainKey: string | null;
  sceneId: string | null;
}

export function judgeFromChoice(choice: string, cands: LinkCandidate[]): Vote {
  const c = choice.trim().toUpperCase();
  if (c === "NIL") return { kind: "NIL" };
  if (c === "NON_ENTITY") return { kind: "NON_ENTITY" };
  const m = /^C(\d+)$/.exec(c);
  const idx = m ? Number(m[1]) - 1 : -1;
  return idx >= 0 && idx < cands.length ? { kind: "entity", entityId: cands[idx]!.entityId } : { kind: "UNSURE" }; // out-of-list → UNSURE (P-3)
}

function cardLine(c: LinkCandidate, i: number): string {
  const tags = [
    c.features.currentHolder ? "현재 보유자" : "",
    c.features.prevHolder ? "직전 보유자" : "",
    c.features.matchKind === "title_self" ? "칭호 자체" : "",
    c.features.deadAtPoint ? "이 시점에 사망" : "",
  ].filter(Boolean);
  return `C${i + 1}: ${c.label}${tags.length ? ` [${tags.join(", ")}]` : ""}`;
}

/**
 * 설계 추가 0015 alias memory: one candidate reached through an active name with exactly this key (incl. aliases the
 * resolver or the author confirmed), live (active or candidate) entity, no confusable / distinct / hidden / death / usability flag → the link
 * is deterministic (no L4 model call).
 */
export function safeExactCandidate(cands: LinkCandidate[]): string | null {
  if (cands.length !== 1) return null;
  const c = cands[0]!;
  const f = c.features;
  if (f.matchKind !== "exact" && f.matchKind !== "normalized") return null;
  if (f.baseScore < 1 || f.hiddenVariant || f.nameKind === "hidden_variant" || f.confusable || f.distinctPair || f.deadAtPoint || f.nameNotUsable || f.nameOutOfRange || f.noNameMatch) return null;
  // a still-candidate entity is fine too: rememberAlias stores names on candidates, and decide() keeps such a link pending
  // (new_entity_candidate) until EN3
  if (f.candidateEntityStatus !== "active" && f.candidateEntityStatus !== "candidate") return null;
  return c.entityId;
}

export async function runLinker(
  deps: LinkerDeps,
  scope: NovelScope,
  input: { manuscriptVersionId: string | null; anchor: StoryAnchor; mentions: LinkerInputMention[]; sourceKind?: MentionSourceKind; answerId?: string | null },
  run?: RunHandle,
  opts: { exactShortcut?: boolean } = {},
): Promise<LinkerResult> {
  const { ontology } = deps;
  const th = thresholds();
  const sourceKind = input.sourceKind ?? (input.manuscriptVersionId ? "manuscript" : "user_input");
  const timelineId = input.anchor.timelineId;
  const nameCache = new Map<string, Awaited<ReturnType<OntologyService["findNameCandidates"]>>>();
  const built: Built[] = [];

  // L2/L3 per mention
  for (let index = 0; index < input.mentions.length; index++) {
    const m = input.mentions[index]!;
    const kind: MentionKind = m.mentionKind ?? "named";
    const p = m.storyPoint;
    const cands = new Map<string, CandidateFeatures & { label?: string }>();
    if (kind === "named" || kind === "title" || kind === "address") {
      const ck = `${normalizedKey(m.surface)}|${p}`;
      let hits = nameCache.get(ck);
      if (!hits) {
        hits = await ontology.findNameCandidates(scope, m.surface, p, timelineId);
        if (hits.length === 0) hits = await ontology.findNameCandidates(scope, m.surface, p, timelineId, { relaxed: true });
        nameCache.set(ck, hits);
      }
      const ents = await ontology.getEntities(scope, hits.map((h) => h.entityId));
      for (const h of hits) {
        const e = ents.find((x) => x.id === h.entityId);
        if (!e) continue;
        if (e.entityType === "title") {
          // 06 §3.5: title → holders at p (current), previous holder, and the title itself
          const all = await ontology.getTitleHolders(scope, e.id, timelineId);
          const cur = all.filter((x) => x.storyRange.from <= p && (x.storyRange.to === null || p < x.storyRange.to));
          const prev = all.filter((x) => x.storyRange.to !== null && x.storyRange.to <= p).sort((a, b) => (b.storyRange.to ?? 0) - (a.storyRange.to ?? 0))[0];
          for (const hd of cur) cands.set(hd.entityId, { matchKind: "title_holder", nameId: h.nameId, nameKind: h.nameKind, viaEntityId: e.id, currentHolder: true, baseScore: 1 });
          if (prev && !cands.has(prev.entityId)) cands.set(prev.entityId, { matchKind: "title_prev_holder", nameId: h.nameId, nameKind: h.nameKind, viaEntityId: e.id, prevHolder: true, baseScore: 0.8 });
          if (!cands.has(e.id)) cands.set(e.id, { matchKind: "title_self", nameId: h.nameId, nameKind: h.nameKind, viaEntityId: null, baseScore: 0.9 });
          continue;
        }
        const prev = cands.get(e.id);
        if (prev && prev.baseScore >= h.score) continue;
        cands.set(e.id, {
          matchKind: h.matchKind,
          nameId: h.nameId,
          nameKind: h.nameKind,
          hiddenVariant: h.nameKind === "hidden_variant",
          nameOutOfRange: h.score === 0.6 && (h.matchKind === "normalized" || h.matchKind === "exact"),
          candidateEntityStatus: e.status === "candidate" ? "candidate" : "active",
          confusable: e.confusableWithIds.length > 0,
          baseScore: h.score,
        });
      }
    }
    // 3rd pass (no name match): chain anchor / scene participants / pov (06 §3.8 L2)
    if (cands.size === 0 && kind !== "named") {
      for (const id of m.sceneParticipantEntityIds ?? []) cands.set(id, { matchKind: "scene", noNameMatch: true, baseScore: 0.5 });
      const pov = m.povEntityId ?? input.anchor.povEntityId;
      if (pov && (kind === "zero" || kind === "pronoun")) cands.set(pov, { matchKind: "scene", noNameMatch: true, baseScore: 0.6 });
    }
    // writer hint (07 §4.2 H-1): only a candidate feature
    if (m.hintEntityId) {
      const hint = await ontology.resolveEntityId(scope, m.hintEntityId).catch(() => null);
      if (hint) {
        const f = cands.get(hint);
        if (f) f.writerHintMatch = true;
      }
    }
    // L3 features needing canon: death at p, distinct pairs, name usability for the speaker
    const ids = [...cands.keys()];
    if (ids.length > 0) {
      const canon = await ontology.getCanonAt(scope, ids, p, timelineId);
      for (const f of canon) if (f.predicate === "life_status" && f.value === "dead" && cands.has(f.subjectEntityId)) cands.get(f.subjectEntityId)!.deadAtPoint = true;
      const pairs = await ontology.listDistinctPairs(scope, ids);
      for (const [a, b] of pairs) if (cands.has(a) && cands.has(b)) cands.get(a)!.distinctPair = cands.get(b)!.distinctPair = true;
      if (m.speakerEntityId) {
        for (const f of cands.values()) {
          if (f.nameId && !(await ontology.nameUsableBy(scope, f.nameId, m.speakerEntityId, { storyPoint: p, timelineId }))) f.nameNotUsable = true;
        }
      }
    }
    const ents = await ontology.getEntities(scope, ids);
    const names = new Map(ents.map((e) => [e.id, e]));
    const list: LinkCandidate[] = ids.map((id) => {
      const f = cands.get(id)!;
      const e = names.get(id);
      return { entityId: id, label: `${id}${e?.disambiguator ? ` (${e.disambiguator})` : ""} · ${e?.entityType ?? "?"}${e?.summary ? ` · ${e.summary.slice(0, 60)}` : ""}`, features: f, ruleScore: ruleScore(f, th.hiddenVariantCap) };
    });
    // human-readable labels: preferred names
    for (const c of list) {
      const card = await ontology.getEntity(scope, c.entityId).catch(() => null);
      if (card) {
        const ns = await ontology.listEntityNames(scope, c.entityId);
        const pref = ns.find((n) => n.isPreferred)?.surface ?? c.entityId;
        c.label = `${pref}${card.disambiguator ? `(${card.disambiguator})` : ""} · ${card.entityType}${card.summary ? ` · ${card.summary.slice(0, 60)}` : ""}`;
      }
    }
    const { kept, truncated } = truncateCandidates(list, th.candidateTopK);
    built.push({ index, m, kind, candidates: kept, truncated, chainKey: m.chainKey ?? null, sceneId: m.sceneId || null });
  }

  // L4 per group (chain / scene+surface+speaker): one judgement per group (06 §3.8 "체인 단위로 한 번에 판정")
  const groups = new Map<string, Built[]>();
  for (const b of built) {
    const k = b.chainKey ? `c:${b.sceneId}|${b.chainKey}` : `s:${b.sceneId}|${b.m.storyPoint}|${normalizedKey(b.m.surface)}|${b.m.speakerEntityId ?? ""}|${b.kind}`;
    groups.set(k, [...(groups.get(k) ?? []), b]);
  }
  for (const list of groups.values()) {
    const head = list[0]!;
    let vote: Vote;
    const exact = opts.exactShortcut ? safeExactCandidate(head.candidates) : null;
    if (head.candidates.length === 0) vote = { kind: "NIL" };
    else if (exact) vote = { kind: "entity", entityId: exact };
    else if (run && (head.kind === "named" || head.kind === "title" || head.kind === "address")) {
      vote = await llmJudge(deps, run, head, input.anchor);
    } else vote = ruleJudge(head.candidates);
    for (const b of list) b.decision = decide({ mentionKind: b.kind, sourceKind: sourceKind as never, candidates: b.candidates, truncated: b.truncated, votes: [vote] }, th);
  }
  sceneConsistency(built.map((b) => Object.assign(b, { decision: b.decision! })));

  const result: LinkerResult = { mentions: [], questionsNeeded: [], linkerVersion: LINKER_VERSION, newEntities: [], localKeys: {}, reportHold: [], entityTypeHints: {} };
  for (const b of built) {
    const d = b.decision!;
    const m = b.m;
    if (m.localKey) result.localKeys![m.localKey] = b.index;
    if (m.entityTypeHint) result.entityTypeHints![b.index] = m.entityTypeHint;
    result.mentions.push({
      sourceKind,
      manuscriptVersionId: input.manuscriptVersionId,
      sceneId: m.sceneId || null,
      charStart: sourceKind === "manuscript" ? m.charStart : null,
      charEnd: sourceKind === "manuscript" ? m.charEnd : null,
      answerId: input.answerId ?? null,
      storyPoint: m.storyPoint,
      timelineId: input.anchor.timelineId,
      surface: b.kind === "zero" ? "" : m.surface,
      mentionKind: b.kind,
      speakerEntityId: m.speakerEntityId ?? null,
      povEntityId: m.povEntityId ?? input.anchor.povEntityId ?? null,
      candidates: d.scores.length ? d.scores.map((s) => ({ entityId: s.entityId, score: s.score, via: b.candidates.find((c) => c.entityId === s.entityId)?.features.matchKind })) : b.candidates.map((c) => ({ entityId: c.entityId, score: c.ruleScore, via: c.features.matchKind })),
      linkedEntityId: d.linkedEntityId,
      viaNameId: d.linkedEntityId ? d.viaNameId : null,
      viaEntityId: d.linkedEntityId ? d.viaEntityId : null,
      confidence: d.confidence,
      rationale: d.rationale,
      linkStatus: d.linkStatus,
      linkerVersion: LINKER_VERSION,
      runId: run?.runId ?? null,
      chainKey: b.chainKey,
    });
    if (d.followUp === "new_entity") result.newEntities!.push({ mentionIndex: b.index, entityType: m.entityTypeHint && /^[a-z][a-z0-9_.]*$/.test(m.entityTypeHint) ? m.entityTypeHint : "character", surface: m.surface });
    if (d.followUp === "question") result.questionsNeeded.push({ mentionIndex: b.index, reason: "ambiguous" });
    if (d.followUp === "report") result.reportHold!.push(b.index);
  }
  return result;
}

async function llmJudge(deps: LinkerDeps, run: RunHandle, b: Built, anchor: StoryAnchor): Promise<Vote> {
  const cards = b.candidates.map(cardLine).join("\n");
  const system =
    "당신은 웹소설 세계관 관리자(world_keeper)입니다. 원문 속 표기가 아래 후보 카드 중 어느 엔티티를 가리키는지 고릅니다. " +
    "반드시 후보 핸들(C1, C2 …) 하나 또는 NIL(새 엔티티), NON_ENTITY(엔티티 아님), UNSURE(판단 불가) 중 하나만 답합니다.";
  const user = [
    `표기: "${b.m.surface}" (유형: ${b.kind}, 지점: ${b.m.storyPoint}${anchor.povEntityId ? `, 시점 인물: ${anchor.povEntityId}` : ""})`,
    b.m.excerpt ? `문맥: ${b.m.excerpt}` : "",
    "후보 카드:",
    cards,
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const out = await deps.llm.modelCalls.call({
      run,
      purpose: "l4_sample",
      sampleIndex: 0,
      system,
      messages: [{ role: "user", content: user }],
      output: { kind: "object", schemaName: "linking_l4_choice", schema: l4ChoiceSchema },
      maxOutputTokens: 300,
    });
    const v = l4ChoiceSchema.safeParse(out.value);
    return v.success ? judgeFromChoice(v.data.choice, b.candidates) : { kind: "UNSURE" };
  } catch (err) {
    if (err instanceof NotImplementedError) return ruleJudge(b.candidates);
    throw err;
  }
}
