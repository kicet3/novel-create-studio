/**
 * Episode writing pipeline task handlers (07 §2–§3, §5.6, §6, §8): outline_episode, draft_episode,
 * revise_episode, split_scenes, polish_episode, plan_rework, check_text_safety.
 * execute = proposals only (reads allowed, no writes — P-2); commit = one transaction.
 */
import type { TaskKind } from "@ncs/shared";
import { actors, DomainValidationError, type NovelScope, type Tx } from "../../../platform/index.js";
import { ModelCallError } from "../../llm/index.js";
import type { ContextSectionKind } from "../../agents/index.js";
import type { CommitOutcome, RunHandle } from "../../orchestration/index.js";
import { manuscriptRepo as repo } from "../adapters/db/manuscript-repository.js";
import { userRanges } from "../domain/attribution.js";
import { diffText } from "../domain/diff.js";
import { deterministicRanges, mapRanges, rangesFromSceneBreaks, rangesFromStarts, type Range } from "../domain/scenes.js";
import {
  episodeTaskInputSchema,
  outlineDataSchema,
  outlineProposalSchema,
  reworkPlanSchema,
  safetyVerdictSchema,
  sceneSegmentationSchema,
  type EpisodeTaskInput,
  type OutlineData,
  type OutlineProposal,
  type ReworkPlan,
  type SafetyVerdict,
  type WriterAnnotations,
} from "../domain/schemas.js";
import { synthOutline } from "../domain/synth.js";
import {
  checkLength,
  continuationNeeded,
  countBasisLabel,
  countChars,
  dedupeRewrite,
  factSignature,
  firstSentence,
  guardSceneGrowth,
  guardSceneLength,
  lengthAdjustmentOf,
  lengthDistance,
  lengthGoal,
  normalizeText,
  SCENE_SEPARATOR,
  SCENE_TAIL,
  sceneTargets,
  separatorSceneStarts,
  signaturesEqual,
  TRAILING_SEPARATOR,
  type LengthCheck,
} from "../domain/text.js";
import { EPISODE_HARD_MIN_CHARS, type CountBasis } from "@ncs/shared";
import { REWORK_TARGET } from "../domain/transitions.js";
import type { Episode, ManuscriptService, SceneDraft } from "../index.js";
import { promptOf, type PipelineHandler, type PipelineLlm } from "./agent-task.js";
import { lengthWarningOf, type ManuscriptInternals } from "./manuscript-service.js";
import { settings, soft } from "./support.js";
import { structureGateRef } from "./structure.js";

type In = EpisodeTaskInput;
const WRITING_SECTIONS: ContextSectionKind[] = [
  "instruction",
  "constraints",
  "story_plan",
  "assigned_beats",
  "outline",
  "prev_handoff",
  "cast",
  "entity_cards",
  "pov_names",
  "knowledge",
  "canon_1hop",
  "story_so_far",
  "glossary",
  "recent_text",
];
/** 설계 추가 0019: the outline / draft of episode N must see how N-1 ended — never dropped by the token budget */
export const CONTINUITY_KEEP_SECTIONS: readonly ContextSectionKind[] = ["recent_text", "prev_handoff"];
const KEEP_FOR: readonly TaskKind[] = ["outline_episode", "draft_episode"];

const OUTLINE_INSTRUCTION = `당신은 웹소설 기획자(planner)입니다. 이번 화 아웃라인을 JSON으로 씁니다.
- scenes[]마다 key(s1, s2 …)·summary·pov_entity_id·location_entity_id·participant_entity_ids·setup_beat_ids를 채웁니다. 엔티티는 ID로만 참조합니다.
- 배정된 떡밥 비트는 모두 한 씬 이상에 배정합니다. 새 인물은 new_entity_proposals에 이름만 제안합니다.
- 씬 수는 [작품 구성]의 이번 화 계획 씬 수를 따르고, 계획한 플롯 사건과 현재 부 목표를 벗어나지 않습니다.
- target_chars는 이번 화 목표 분량(최소~최대 분량 사이)입니다. 아직 등장 전인 인물은 등장시키지 않습니다.
- 2화부터 첫 씬(s1)은 '직전 화 끝 상태'와 '직전 내용'의 마지막 장면에서 바로 이어집니다(시간·장소·등장 인물·몸과 마음 상태·열린 행동). 앞 화를 다시 요약하는 씬을 만들지 않고, 직전 화 끝 상태와 어긋나게 시작하지 않습니다.
- 이번 화 계획상 시간·장소를 건너뛰어야 하면 s1 summary 첫머리에 그 전환(얼마 뒤·어디로·무엇이 정리됐는지)을 밝힙니다.`;
const DRAFT_INSTRUCTION = `당신은 웹소설 작가(writer)입니다. 아웃라인의 씬을 순서대로 본문으로 씁니다.
- 씬과 씬 사이에는 "${SCENE_SEPARATOR}" 한 줄만 둡니다. 다른 표기·주석은 넣지 않습니다.
- 작품 연령 등급을 넘는 묘사를 쓰지 않습니다. 시점 인물이 모르는 이름은 쓰지 않습니다.
- 분량은 허용 범위(최소~최대) 안에서 목표 분량에 맞춥니다. 최소 분량에 못 미치거나 최대 분량을 넘기지 않습니다.
- [작품 구성]의 결말·현재 부 목표·플롯 핵심 사건·이번 화 계획을 벗어나지 않습니다.
- 2화부터 첫 씬 첫 문단은 직전 화 마지막 장면에서 자연스럽게 이어집니다('직전 화 끝 상태'·'직전 내용'의 시간·장소·등장 인물·몸과 마음 상태·열린 행동).
- 앞 화 줄거리를 되풀이하는 요약·회상 문단으로 시작하지 않습니다. 직전 화 끝 상태와 모순되게 쓰지 않습니다(다친 인물이 멀쩡하거나, 함께 있던 인물이 설명 없이 사라지는 등).
- 아웃라인이 시간·장소를 건너뛰면 첫 문단에서 그 전환(얼마 뒤·어디로)을 분명히 밝힙니다.`;
const CONTINUE_INSTRUCTION = `당신은 웹소설 작가(writer)입니다. 이 화의 초고가 최소 분량보다 짧습니다. 지금까지 쓴 본문 바로 뒤에 이어질 본문만 씁니다.
- 앞 내용을 반복하거나 요약하지 않고, 이미 쓴 씬을 처음부터 다시 쓰지 않습니다. 아웃라인의 남은 씬을 이어서 쓰고, 씬이 바뀌면 "${SCENE_SEPARATOR}" 한 줄을 둡니다.
- 부족한 분량만큼만 씁니다. 화 전체가 최대 분량을 넘지 않게 합니다.
- 제목·메모·설명 없이 이어지는 본문만 출력합니다.`;
const REVISE_INSTRUCTION = `당신은 웹소설 작가(writer)입니다. 주어진 씬 하나만 다시 씁니다. 지적된 문제를 고치고 앞뒤 씬과 이어지게 씁니다.
- 원문을 그대로 다시 붙이거나 다음 씬 내용을 이어 쓰지 않습니다. 고친 씬 하나만 씁니다.
- 씬 분량은 주어진 목표 분량에 맞춥니다. 씬 본문만 출력합니다.`;
const POLISH_INSTRUCTION = `당신은 문장 교정자(line_editor)입니다. 주어진 씬의 문장만 다듬습니다. 사건·인물·숫자·고유명사는 바꾸지 않습니다. 분량은 주어진 목표를 넘기지 않습니다. 다듬은 씬 본문만 출력합니다.`;
/** 설계 추가 0017: length adjustment passes (one call per scene; the episode total lands in the profile range) */
const TRIM_INSTRUCTION = `당신은 분량 편집자(trim)입니다. 주어진 씬을 목표 분량으로 줄입니다.
- 겹치는 묘사·설명, 늘어지는 대사, 반복되는 내면 독백을 덜어 냅니다.
- 플롯 비트·떡밥·복선·인물의 행동·회차 말 훅은 남깁니다. 요약문으로 바꾸지 않고 장면으로 씁니다.
- 사건·인물·숫자·고유명사는 바꾸지 않습니다. 줄인 씬 본문만 출력합니다.`;
const EXPAND_INSTRUCTION = `당신은 분량 편집자(expand)입니다. 주어진 씬을 목표 분량으로 늘립니다.
- 장면 묘사·감각·인물의 내면·대사 주고받기를 보탭니다.
- 새 사건·새 인물·새 설정을 만들지 않고, 다음 씬 내용을 앞당겨 쓰지 않습니다.
- 사건·인물·숫자·고유명사는 바꾸지 않습니다. 늘린 씬 본문만 출력합니다.`;
const REWORK_INSTRUCTION = `당신은 쇼러너(showrunner)입니다. 사람이 반려한 사유를 읽고 다시 쓸 씬 번호와 작업 지시를 JSON으로 정합니다. 원고는 쓰지 않습니다.`;
const SAFETY_INSTRUCTION = `당신은 원고 안전 검수자입니다. 씬마다 (1) 작품 연령 등급을 넘는 성적·폭력·언어 수위 (2) 미성년 인물의 성적 묘사 (3) 실존 인물 사칭·명예훼손이 있는지 판정해 violations JSON으로만 답합니다. 문제가 없으면 빈 배열입니다.`;

export function createWriting(m: ManuscriptInternals, getService: () => ManuscriptService) {
  const { ports } = m;
  const { novel, ontology, platform } = ports.deps;
  const db = () => platform.uow.db;
  const cfg = settings();
  const scopeOf = (run: RunHandle): NovelScope => ({ novelId: run.novelId });
  const skip = (): CommitOutcome => ({ kind: "done", outputRefs: [] });

  /**
   * entity seeds of the writing contexts (04 §9.5 entity_cards / canon_1hop): the cast referenced by the episode's
   * outline (pov, location, participants), else the novel's active cast. Without seeds the planner/writer never see
   * the canonical names or ids ("엔티티는 ID로만 참조합니다" would be unanswerable).
   */
  const castSeeds = async (scope: NovelScope, outlineVersionId: string | null | undefined): Promise<string[]> => {
    const ids = new Set<string>();
    const v = outlineVersionId ? await soft(() => repo.getVersion(db(), scope, outlineVersionId), null) : null;
    const scenes = ((v?.outlineData as { scenes?: Array<{ pov_entity_id?: unknown; location_entity_id?: unknown; participant_entity_ids?: unknown }> } | null)?.scenes ?? []);
    for (const s of scenes) {
      for (const x of [s.pov_entity_id, s.location_entity_id, ...(Array.isArray(s.participant_entity_ids) ? s.participant_entity_ids : [])]) if (typeof x === "string" && x.startsWith("ent_")) ids.add(x);
    }
    if (ids.size === 0) {
      const cast = await soft(() => ontology.listEntities(scope, { statuses: ["active"], entityTypes: ["character", "place", "organization", "item", "ability"], limit: 200 }), []);
      const rank = (t: string) => ["character", "place", "organization", "item", "ability"].indexOf(t);
      for (const e of [...cast].sort((a, b) => rank(a.entity.entityType) - rank(b.entity.entityType) || b.appearanceEpisodeCount - a.appearanceEpisodeCount).slice(0, 12)) ids.add(e.entity.id);
    }
    return [...ids];
  };

  const episodeContext = async (input: In, task: { novelId: string; kind?: TaskKind }) => {
    const scope = { novelId: task.novelId };
    const ep = await repo.getEpisode(db(), scope, input.episode_id);
    if (!ep) return null;
    const versionId = input.manuscript_version_id ?? ep.currentVersionId ?? undefined;
    const entityIds = await castSeeds(scope, ep.outlineVersionId);
    return {
      anchor: { storyPoint: ep.episodeNo * 1000, timelineId: ep.primaryTimelineId },
      sections: WRITING_SECTIONS,
      episodeId: ep.id,
      manuscriptVersionId: versionId,
      seeds: { entityIds, setupIds: [], answerIds: input.answer_ids ?? [], mentionIds: [] },
      ...(task.kind && KEEP_FOR.includes(task.kind) ? { keepSections: [...CONTINUITY_KEEP_SECTIONS] } : {}),
    };
  };

  /** E1 guard (INV-BIB-02, INV-ARC-02) as a pre-lease gate */
  /**
   * 설계 추가 0019: N's outline waits (defer, not block) while a summarize_episode of N-1 is queued / running, so the
   * outline context carries N-1's handoff + summary. A failed / cancelled / blocked recap does not hold the outline —
   * the outline then continues from recent_text (N-1's raw ending) alone.
   */
  const recapPending = async (scope: NovelScope, ep: { episodeNo: number }) => {
    if (ep.episodeNo <= 1 || !ports.isRegistered("summarize_episode")) return false;
    const prev = await repo.getEpisodeByNo(db(), scope, ep.episodeNo - 1);
    if (!prev) return false;
    const active = await ports.deps.orchestration.listTasks(scope, { kinds: ["summarize_episode"], episodeId: prev.id, statuses: ["pending", "ready", "running"], limit: 5 });
    return active.length > 0;
  };

  const planningGate = async (scope: NovelScope, task: { input: unknown; kind?: TaskKind }) => {
    const input = episodeTaskInputSchema.safeParse(task.input);
    if (!input.success) return { ok: true as const };
    const ep = await repo.getEpisode(db(), scope, input.data.episode_id);
    if (!ep) return { ok: true as const };
    const bible = await novel.getApprovedBible(scope);
    if (!bible) return { ok: false as const, blockReason: "approval" as const };
    // 설계 추가: an edited (unapproved) story structure stops new outlines / drafts until the author re-approves it
    const st = await novel.getStructure(scope);
    if (st && st.status !== "approved") return { ok: false as const, blockReason: "approval" as const, blockedRef: structureGateRef(scope) };
    const arc = await novel.getArc(scope, ep.arcId);
    // 설계 추가 0014: no full_auto exception — the autopilot decides the arc_plan approval (INV-ARC-02 at every level)
    if (!["active", "awaiting_approval", "completed"].includes(arc.status)) {
      return arc.planApprovalId
        ? { ok: false as const, blockReason: "approval" as const, blockedRef: { refType: "approval" as const, refId: arc.planApprovalId } }
        : { ok: false as const, blockReason: "approval" as const };
    }
    if (task.kind === "outline_episode" && (await recapPending(scope, ep))) return { ok: false as const, defer: true as const };
    return { ok: true as const };
  };

  const loadVersion = async (scope: NovelScope, id: string | null | undefined) => (id ? await repo.getVersion(db(), scope, id) : null);
  type Profile = { minChars: number; maxChars: number; countBasis: CountBasis };
  /** a target inside the profile range (mid when none was planned) */
  const targetIn = (profile: Profile, planned: number | null | undefined) => Math.min(profile.maxChars, Math.max(profile.minChars, planned || lengthGoal(profile)));
  const rangeOf = (profile: Profile) => `${profile.minChars}~${profile.maxChars}자(${countBasisLabel(profile.countBasis)})`;
  /** what a pass should leave in this episode: the current total when it is accepted, else the profile midpoint */
  const goalFor = (profile: Profile, total: number) => (lengthAdjustmentOf(total, profile, cfg.lengthTolerance) ? lengthGoal(profile) : total);
  /** per-scene length line of a rewrite payload (scene target scaled so the episode lands on `goal`) */
  const sceneLengthLine = (profile: Profile, total: number, sceneCount: number, sceneTarget: number) =>
    `이 씬 현재 ${sceneCount}자 → 목표 ${sceneTarget}자 안팎(${countBasisLabel(profile.countBasis)}). 화 전체 현재 ${total}자, 결과는 ${rangeOf(profile)} 사이여야 합니다.`;
  const followUp = (tx: Tx, scope: NovelScope, ep: Episode, kind: TaskKind, input: Record<string, unknown>, createdBy: import("../../../platform/index.js").ActorRef, priority = 500) =>
    ports.createTask(tx, scope, {
      kind,
      targetType: "episode",
      targetId: ep.id,
      episodeId: ep.id,
      arcId: ep.arcId,
      input: { episode_id: ep.id, ...input },
      createdBy,
      cycleKey: (input.cycle_key as string | undefined) ?? (input.manuscript_version_id as string | undefined),
      priority,
    });

  // ── P1 outline_episode ──
  const outlineEpisode: PipelineHandler<In, { outline: OutlineProposal; modelId: string }> = {
    kind: "outline_episode",
    role: "planner",
    promptTemplateVersion: "planner.outline_episode@0.1.0",
    inputSchema: episodeTaskInputSchema,
    allowedWrites: ["manuscript.createVersion(kind=outline)"],
    gate: planningGate,
    context: episodeContext,
    async execute(run, input, context, llm) {
      const scope = scopeOf(run);
      const ep = await getService().getEpisode(scope, input.episode_id);
      const arc = await novel.getArc(scope, ep.arcId);
      const profile = await m.lengthProfile(scope);
      const beatIds = (await Promise.all(ports.reg.beatSources.map((s) => soft(() => s(scope, ep.episodeNo), [])))).flat();
      // 설계 추가 L5: the episode plan's target, inside the profile range (0017: never over the maximum either)
      const target = targetIn(profile, ep.targetChars);
      const data = JSON.stringify({
        episode: { no: ep.episodeNo, title: ep.title, hookNote: ep.hookNote },
        arc: { title: arc.title, goal: arc.goalText, conflict: arc.conflictText, end: arc.endCondition, range: [arc.plannedEpisodeFrom, arc.plannedEpisodeTo] },
        plot: { coreEvent: arc.coreEvent, changeText: arc.changeText, involvedCharacterIds: arc.involvedCharacterIds },
        episodePlan: { summary: ep.planSummary, plannedSceneCount: ep.plannedSceneCount, targetChars: target },
        assignedSetupBeatIds: beatIds,
        targetChars: target,
        minChars: profile.minChars,
        maxChars: profile.maxChars,
        countBasis: countBasisLabel(profile.countBasis),
        rework: input.rework_cause ? { cause: input.rework_cause, issues: input.issue_refs ?? [], instructions: input.instructions ?? null } : null,
      });
      const synth = synthOutline(ep, target, beatIds);
      const out = await llm.call({ run, purpose: "outline", ...promptOf(context, OUTLINE_INSTRUCTION, data), output: { kind: "object", schemaName: "OutlineProposal", schema: outlineProposalSchema } });
      const v = out.value as OutlineProposal;
      const scenes = (v.outline.scenes.length ? v.outline.scenes : synth.outline.scenes).slice(0, cfg.maxScenes);
      // keys unique & non-empty
      const seen = new Set<string>();
      for (const [i, s] of scenes.entries()) {
        if (!s.key || seen.has(s.key)) s.key = `s${i + 1}`;
        seen.add(s.key);
        if (!s.summary) s.summary = synth.outline.scenes[Math.min(i, synth.outline.scenes.length - 1)]!.summary;
      }
      // check (2): entity / beat / answer references are ids from this run's inputs only (FR-ONT-12)
      const isEntityId = (x: unknown): x is string => typeof x === "string" && /^ent_[0-9A-HJKMNP-TV-Z]{26}$/.test(x);
      const answerIds = new Set(input.answer_ids ?? []);
      for (const s of scenes) {
        s.pov_entity_id = isEntityId(s.pov_entity_id) ? s.pov_entity_id : null;
        s.location_entity_id = isEntityId(s.location_entity_id) ? s.location_entity_id : null;
        s.participant_entity_ids = s.participant_entity_ids.filter(isEntityId);
        s.timeline_id = s.timeline_id === ep.primaryTimelineId ? s.timeline_id : null;
        s.setup_beat_ids = s.setup_beat_ids.filter((b) => beatIds.includes(b));
        s.answer_ids = s.answer_ids.filter((a) => answerIds.has(a));
      }
      // E2 guard / check (3): every planned beat assigned to a scene (deterministic correction instead of failing)
      const assigned = new Set(scenes.flatMap((s) => s.setup_beat_ids));
      const missing = beatIds.filter((b) => !assigned.has(b));
      if (missing.length) scenes[Math.floor(scenes.length / 2)]!.setup_beat_ids.push(...missing);
      const outline: OutlineData = outlineDataSchema.parse({ ...v.outline, scenes, hook: v.outline.hook || synth.outline.hook, target_chars: targetIn(profile, v.outline.target_chars || target) });
      return { outline: { summary: v.summary || synth.summary, title: v.title ?? ep.title, outline }, modelId: out.modelId };
    },
    async commit(tx, run, input, p) {
      const scope = scopeOf(run);
      const agent = actors.agent("planner", run.runId);
      let ep = await m.mustEpisode(tx, scope, input.episode_id, true);
      if (ep.status === "planned") ep = await m.transition(tx, scope, ep.id, "outlining", actors.system("orchestrator"), { ruleId: "E1" });
      if (ep.status !== "outlining") return skip();
      const version = await m.saveVersion(tx, scope, ep.id, { kind: "outline", content: p.outline.summary, outlineData: p.outline.outline, author: agent, modelId: p.modelId });
      if (!ep.title && p.outline.title) await repo.updateEpisode(tx.db, scope, ep.id, { title: p.outline.title });
      ep = await m.transition(tx, scope, ep.id, "drafting", agent, { ruleId: "E2", details: { outlineVersionId: version.id } });
      // a new outline (first pass, E5 or E12 outline) is always followed by a fresh draft of the whole episode
      await followUp(tx, scope, ep, "draft_episode", {
        manuscript_version_id: version.id,
        cycle_key: version.id,
        ...(input.rework_cause ? { rework_cause: input.rework_cause, instructions: input.instructions, issue_refs: input.issue_refs } : {}),
      }, agent, input.rework_cause ? 800 : 500);
      return { kind: "done", outputRefs: [{ refType: "manuscript_version", refId: version.id }] };
    },
  };

  // ── P2 draft_episode ──
  const draftEpisode: PipelineHandler<In, { content: string; annotations: WriterAnnotations; modelId: string; lengthCheck: LengthCheck; continueAttempts: number }> = {
    kind: "draft_episode",
    role: "writer",
    promptTemplateVersion: "writer.draft_episode@0.1.0",
    inputSchema: episodeTaskInputSchema,
    allowedWrites: ["manuscript.createVersion(kind=draft)"],
    gate: planningGate,
    context: episodeContext,
    async execute(run, input, context, llm) {
      const scope = scopeOf(run);
      const ep = await getService().getEpisode(scope, input.episode_id);
      const outlineV = await loadVersion(scope, ep.outlineVersionId);
      const outline = outlineDataSchema.parse(outlineV?.outlineData ?? {});
      const profile = await m.lengthProfile(scope);
      const n = await novel.getNovel(scope);
      // 설계 추가 L6: never below the profile minimum (≥ 3,000-char floor); 0017: never above the maximum
      const target = targetIn(profile, outline.target_chars);
      const basis = countBasisLabel(profile.countBasis);
      const data = JSON.stringify({
        episode: { no: ep.episodeNo, title: ep.title },
        ageRating: n.ageRating,
        targetChars: target,
        minChars: profile.minChars,
        maxChars: profile.maxChars,
        countBasis: basis,
        scenes: outline.scenes.map((s) => ({ key: s.key, summary: s.summary })),
        hook: outline.hook,
        rework: input.rework_cause ? { cause: input.rework_cause, issues: (input.issue_refs ?? []).map((i) => i.message), instructions: input.instructions ?? null } : null,
      });
      const out = await llm.call({
        run,
        purpose: "draft",
        ...promptOf(
          context,
          DRAFT_INSTRUCTION,
          `목표 분량: ${target}자 안팎 — 허용 범위 ${rangeOf(profile)}. 최소 ${profile.minChars}자 미만으로 끝내지 않고 최대 ${profile.maxChars}자를 넘기지 않습니다.\n${data}`,
        ),
        output: { kind: "text" },
        maxOutputTokens: 16_000,
      });
      let content = normalizeText(String(out.value)).trim();
      if (!content) throw new ModelCallError("invalid_output", null, undefined, "모델이 빈 초고를 반환했습니다.");
      // continuation while short (max attempts, stop when a continuation barely grows the text)
      let attempt = 0;
      let lastGrowth: number | null = null;
      let modelId = out.modelId;
      while (continuationNeeded(countChars(content, profile.countBasis), profile.minChars, attempt, cfg.draftContinueMaxAttempts, lastGrowth, cfg.draftContinueMinGrowth)) {
        await run.checkpoint();
        attempt++;
        const before = countChars(content, profile.countBasis);
        const payload = JSON.stringify({
          episode: { no: ep.episodeNo, title: ep.title },
          scenes: outline.scenes.map((s) => ({ key: s.key, summary: s.summary })),
          hook: outline.hook,
          writtenTail: content.slice(-1500),
          writtenChars: before,
          shortfall: profile.minChars - before,
          maxChars: profile.maxChars,
          attempt,
        });
        const more = await llm.call({
          run,
          purpose: "draft_continue",
          ...promptOf(
            context,
            CONTINUE_INSTRUCTION,
            `부족한 분량: ${profile.minChars - before}자 이상(${basis}) — 현재 ${before}자, 이어 쓴 뒤 화 전체는 ${rangeOf(profile)} 사이여야 합니다(추가는 최대 ${Math.max(0, profile.maxChars - before)}자).\n${payload}`,
          ),
          output: { kind: "text" },
          maxOutputTokens: 12_000,
        });
        modelId = more.modelId;
        const extra = normalizeText(String(more.value)).trim();
        // 설계 추가 0017: a "continuation" that starts the episode over again is a rewrite, never appended to the text
        // (draft + a second copy doubled episodes); a fuller rewrite replaces the short draft
        const head = content.split(/\n\s*\n/)[0]!.trim();
        if (extra && head.length >= 30 && extra.includes(head)) {
          if (countChars(extra, profile.countBasis) > before) content = extra;
        } else if (extra) content = `${content}\n\n${extra}`;
        lastGrowth = countChars(content, profile.countBasis) - before;
      }
      const lengthCheck = checkLength(content, profile);
      return { content, annotations: annotate(content, outline), modelId, lengthCheck, continueAttempts: attempt };
    },
    commit: (tx, run, input, p) => commitBody(tx, run, input, p, "draft"),
  };

  /** WriterAnnotations.scene_breaks from separator lines when they match the outline scene count */
  const annotate = (content: string, outline: OutlineData): WriterAnnotations => {
    const starts = separatorSceneStarts(content);
    const keys = outline.scenes.map((s) => s.key);
    const breaks = starts.length === keys.length ? keys.map((k, i) => ({ outline_scene_key: k, char_start: starts[i]! })) : [];
    return { scene_breaks: breaks, entity_hints: [], new_entity_refs: [], answer_spans: [], setup_beat_spans: [] };
  };

  const commitBody = async (
    tx: Tx,
    run: RunHandle,
    input: In,
    p: { content: string; annotations: WriterAnnotations; modelId: string; baseVersionId?: string | null; lengthCheck?: LengthCheck; continueAttempts?: number; rejected?: "length_floor" | null; lengthKept?: string[] },
    kind: "draft" | "revision",
  ) => {
    const scope = scopeOf(run);
    const agent = actors.agent("writer", run.runId);
    const ep = await m.mustEpisode(tx, scope, input.episode_id, true);
    if (ep.status !== "drafting") return skip();
    if (p.baseVersionId !== undefined && p.baseVersionId !== ep.currentVersionId) return skip(); // superseded by a newer version
    if (p.rejected === "length_floor" && ep.currentVersionId) {
      // 설계 추가 L8: a revision that shrinks the episode under the floor is not saved — the base version goes back to checking
      await m.transition(tx, scope, ep.id, "checking", agent, { ruleId: "E3", details: { versionId: ep.currentVersionId, lengthRejected: true } });
      await followUp(tx, scope, ep, "split_scenes", { manuscript_version_id: ep.currentVersionId, cycle_key: `${ep.currentVersionId}:length_kept:${run.runId}` }, agent, 700);
      return { kind: "done" as const, outputRefs: [{ refType: "manuscript_version" as const, refId: ep.currentVersionId }] };
    }
    const version = await m.saveVersion(tx, scope, ep.id, { kind: ep.currentVersionId ? "revision" : kind, content: p.content, author: agent, modelId: p.modelId, writerAnnotations: p.annotations });
    const carried = { continueAttempts: p.continueAttempts ?? 0, ...(p.lengthKept?.length ? { lengthKept: p.lengthKept } : {}) };
    const profile = await m.lengthProfile(scope, tx);
    if (cfg.lengthAdjustMaxRounds > 0 && lengthAdjustmentOf(countChars(version.content, profile.countBasis), profile, cfg.lengthTolerance)) {
      // 설계 추가 0017: out of the profile range → trim / expand pass first (episode stays in drafting)
      await followUp(tx, scope, ep, "adjust_length", { manuscript_version_id: version.id, cycle_key: `${version.id}:adjust`, adjust_phase: "draft", adjust_round: 1, carried }, agent, 700);
      return { kind: "done" as const, outputRefs: [{ refType: "manuscript_version" as const, refId: version.id }] };
    }
    await toChecking(tx, scope, ep, agent, version.id, checkLength(version.content, profile), carried);
    return { kind: "done" as const, outputRefs: [{ refType: "manuscript_version" as const, refId: version.id }] };
  };

  /** E3: drafting → checking with the length details of the version, then scene segmentation */
  const toChecking = async (tx: Tx, scope: NovelScope, ep: Episode, agent: import("../../../platform/index.js").ActorRef, versionId: string, length: LengthCheck, extra: Record<string, unknown>) => {
    const details = { versionId, lengthShortfall: Math.max(0, length.minChars - length.count), belowFloor: length.belowFloor, ...extra };
    await m.transition(tx, scope, ep.id, "checking", agent, { ruleId: "E3", details });
    await followUp(tx, scope, ep, "split_scenes", { manuscript_version_id: versionId, cycle_key: versionId }, agent, 700);
  };

  /**
   * rewrite scene by scene; scenes containing user-written text are never touched (PR-08, INV-MV-03).
   * `limits` (count basis): `min` floor guard (L7), `ceiling` (a grown scene may not take the episode above it) and
   * `maxGrowthRatio` (runaway scene = spill into the next scenes / a second copy). A rewritten body that still holds the
   * original verbatim is an append, not a rewrite (dedupeRewrite). A closing separator line stays where it was.
   */
  const rewriteScenes = async (
    run: RunHandle,
    llm: PipelineLlm,
    context: import("../../agents/index.js").ContextPack,
    base: { id: string; content: string; attributionSpans: unknown },
    scenes: Array<Range & { id: string; ord: number; summary: string }>,
    pick: (s: { id: string; ord: number }) => boolean,
    instruction: string,
    payload: (s: { ord: number; summary: string; text: string }) => string,
    purpose: string,
    limits?: { basis: CountBasis; min: number; ceiling?: number; maxGrowthRatio?: number },
    opts: { dedupe?: boolean } = {},
  ) => {
    const human = userRanges((base.attributionSpans as never) ?? []);
    let out = "";
    let pos = 0;
    const changed: string[] = [];
    const skipped: string[] = [];
    const lengthKept: string[] = [];
    const count = (t: string) => (limits ? countChars(t, limits.basis) : t.length);
    let projected = limits ? count(base.content) : 0;
    for (const s of scenes) {
      const text = base.content.slice(s.start, s.end);
      out += base.content.slice(pos, s.start);
      pos = s.end;
      if (!pick(s)) {
        out += text;
        continue;
      }
      if (human.some((h) => h.start < s.end && s.start < h.end)) {
        out += text;
        skipped.push(s.id);
        continue;
      }
      const lead = /^\s*/.exec(text)![0];
      const trail = lead.length < text.length ? SCENE_TAIL.exec(text)![0] : "";
      const core = text.slice(lead.length, text.length - trail.length);
      const r = await llm.call({ run, purpose, ...promptOf(context, instruction, payload({ ord: s.ord, summary: s.summary, text })), output: { kind: "text" } });
      let body = normalizeText(String(r.value)).trim();
      if (body && /\S/.test(trail)) body = body.replace(TRAILING_SEPARATOR, "").trim();
      if (body && opts.dedupe !== false) body = dedupeRewrite(core, body);
      let next = body ? `${lead}${body}${trail}` : text;
      if (limits && body) {
        const delta = count(next) - count(text);
        const g = { originalSceneCount: count(text), newSceneCount: count(next), projectedTotal: projected + delta };
        // 설계 추가 L7: a shorter scene that would take the episode under the floor keeps the original text;
        // 0017: so does a longer one past the ceiling or a runaway one
        if (guardSceneLength({ ...g, floor: limits.min }) === "keep_original" || guardSceneGrowth({ ...g, ceiling: limits.ceiling, maxGrowthRatio: limits.maxGrowthRatio }) === "keep_original") {
          next = text;
          lengthKept.push(s.id);
        } else projected += delta;
      }
      out += next;
      if (next !== text && body !== core.trim()) changed.push(s.id);
      await run.checkpoint();
    }
    out += base.content.slice(pos);
    const rejected = limits && count(out) < limits.min && count(out) < count(base.content) ? ("length_floor" as const) : null;
    return { content: out, changed, skipped, lengthKept, rejected };
  };

  const activeRanges = async (scope: NovelScope, ep: Episode, versionId: string) => {
    const v = await loadVersion(scope, versionId);
    if (!v) return [];
    const scenes = await repo.listScenes(db(), scope, ep.id);
    const valid = scenes.length && scenes.every((s) => s.manuscriptVersionId === versionId);
    if (valid) return scenes.map((s) => ({ id: s.id, ord: s.ord, start: s.charStart, end: s.charEnd, summary: s.summary }));
    return deterministicRanges(v.content, 1).map((r, i) => ({ id: `tmp${i}`, ord: i + 1, ...r, summary: "" }));
  };

  /** scene targets (by ord) that bring the episode to `goal`; scenes with user text keep their count */
  const targetsByOrd = (base: { content: string; attributionSpans: unknown }, scenes: Array<Range & { ord: number }>, basis: CountBasis, goal: number) => {
    const human = userRanges((base.attributionSpans as never) ?? []);
    const counts = scenes.map((s) => countChars(base.content.slice(s.start, s.end).trim(), basis));
    const editable = scenes.map((s) => !human.some((h) => h.start < s.end && s.start < h.end));
    const targets = sceneTargets(counts, editable, goal);
    return new Map(scenes.map((s, i) => [s.ord, { count: counts[i]!, target: targets[i]! }]));
  };

  // ── P6 revise_episode ──
  const reviseEpisode: PipelineHandler<
    In,
    { content: string; annotations: WriterAnnotations; modelId: string; baseVersionId: string | null; changed: string[]; skipped: string[]; rejected: "length_floor" | null; lengthKept: string[] }
  > = {
    kind: "revise_episode",
    role: "writer",
    promptTemplateVersion: "writer.revise_episode@0.1.0",
    inputSchema: episodeTaskInputSchema,
    allowedWrites: ["manuscript.createVersion(kind=revision)"],
    context: episodeContext,
    async execute(run, input, context, llm) {
      const scope = scopeOf(run);
      const ep = await getService().getEpisode(scope, input.episode_id);
      const outline = outlineDataSchema.parse((await loadVersion(scope, ep.outlineVersionId))?.outlineData ?? {});
      const base = await loadVersion(scope, ep.currentVersionId);
      const profile = await m.lengthProfile(scope);
      if (!base) throw new DomainValidationError("no_manuscript", "수정할 원고 버전이 없습니다.");
      const scenes = await activeRanges(scope, ep, base.id);
      const targets = new Set(input.target_scene_ids ?? []);
      const whole = (input as { full_rewrite?: boolean }).full_rewrite === true || !targets.size;
      const issues = (input.issue_refs ?? []).map((i) => i.message).filter(Boolean);
      // 설계 추가 0017: each scene gets a target (same length when the episode is in range, scaled toward the midpoint
      // when not) and the range of the whole episode — never "at least N / don't shorten" without a ceiling
      const total = countChars(base.content, profile.countBasis);
      const byOrd = targetsByOrd(base, scenes, profile.countBasis, goalFor(profile, total));
      let modelId = "none";
      const r = await rewriteScenes(
        run,
        { call: async (c) => { const o = await llm.call(c); modelId = o.modelId; return o; } },
        context,
        base,
        scenes,
        (s) => whole || targets.has(s.id),
        REVISE_INSTRUCTION,
        (s) => {
          const t = byOrd.get(s.ord) ?? { count: countChars(s.text.trim(), profile.countBasis), target: countChars(s.text.trim(), profile.countBasis) };
          return `${sceneLengthLine(profile, total, t.count, t.target)} 이 씬(${s.ord}/${scenes.length})만 고쳐 씁니다.\n${JSON.stringify({ sceneOrd: s.ord, summary: s.summary, issues, instructions: input.instructions ?? null, text: s.text })}`;
        },
        "revise",
        { basis: profile.countBasis, min: EPISODE_HARD_MIN_CHARS, maxGrowthRatio: 1.6 },
      );
      const content = normalizeText(r.content);
      return { content, annotations: annotate(content, outline), modelId, baseVersionId: base.id, changed: r.changed, skipped: r.skipped, rejected: r.rejected, lengthKept: r.lengthKept };
    },
    commit: (tx, run, input, p) => commitBody(tx, run, input, p, "revision"),
  };

  // ── 설계 추가 0017 adjust_length (writer): trim / expand pass toward the profile range ──
  type AdjustProposal = {
    phase: "draft" | "polish";
    action: "trim" | "expand" | null;
    baseVersionId: string;
    before: number;
    after: number;
    improved: boolean;
    content: string;
    modelId: string;
    changed: string[];
    skipped: string[];
    lengthKept: string[];
    factDiff: boolean;
    sceneDrafts: SceneDraft[];
  };
  const adjustLength: PipelineHandler<In, AdjustProposal> = {
    kind: "adjust_length",
    role: "writer",
    promptTemplateVersion: "writer.adjust_length@0.1.0",
    inputSchema: episodeTaskInputSchema,
    allowedWrites: ["manuscript.createVersion(kind=revision)"],
    context: episodeContext,
    async execute(run, input, context, llm) {
      const scope = scopeOf(run);
      const ep = await getService().getEpisode(scope, input.episode_id);
      const phase = (input as { adjust_phase?: string }).adjust_phase === "polish" ? "polish" : "draft";
      const base = await loadVersion(scope, ep.currentVersionId);
      if (!base) throw new DomainValidationError("no_manuscript", "분량을 맞출 원고 버전이 없습니다.");
      const profile = await m.lengthProfile(scope);
      const before = countChars(base.content, profile.countBasis);
      const action = lengthAdjustmentOf(before, profile, cfg.lengthTolerance);
      let content = base.content;
      let modelId = "none";
      let r: { changed: string[]; skipped: string[]; lengthKept: string[] } = { changed: [], skipped: [], lengthKept: [] };
      if (action && (!input.manuscript_version_id || input.manuscript_version_id === base.id)) {
        const scenes = await activeRanges(scope, ep, base.id);
        const byOrd = targetsByOrd(base, scenes, profile.countBasis, lengthGoal(profile));
        const out = await rewriteScenes(
          run,
          { call: async (c) => { const o = await llm.call(c); modelId = o.modelId; return o; } },
          context,
          base,
          scenes,
          () => true,
          action === "trim" ? TRIM_INSTRUCTION : EXPAND_INSTRUCTION,
          (s) => {
            const t = byOrd.get(s.ord)!;
            return `분량 ${action === "trim" ? "줄이기" : "늘리기"}: ${sceneLengthLine(profile, before, t.count, t.target)}\n${JSON.stringify({ sceneOrd: s.ord, summary: s.summary, text: s.text })}`;
          },
          action === "trim" ? "length_trim" : "length_expand",
          // a trim never takes the episode under the 3,000-char floor
          action === "trim" ? { basis: profile.countBasis, min: EPISODE_HARD_MIN_CHARS } : undefined,
          // an expanded scene may keep the original and add to it
          { dedupe: action === "trim" },
        );
        content = normalizeText(out.content);
        r = out;
      }
      const after = countChars(content, profile.countBasis);
      // a pass counts only when it brings the episode closer to the range (else the base is kept as it is)
      const improved = !!action && content !== base.content && lengthDistance(after, profile, cfg.lengthTolerance) < lengthDistance(before, profile, cfg.lengthTolerance);
      const final = improved ? content : base.content;
      let factDiff = false;
      let sceneDrafts: SceneDraft[] = [];
      if (phase === "polish") {
        // after polishing: the checked version (polish base) is what the scenes and facts were checked against
        const checked = (await loadVersion(scope, (input as { checked_version_id?: string }).checked_version_id ?? base.parentVersionId)) ?? base;
        const names = (await soft(() => ontology.listEntities(scope, { limit: 500 }), [])).map((e) => e.preferredName);
        factDiff = !signaturesEqual(factSignature(checked.content, names), factSignature(final, names));
        sceneDrafts = final === checked.content ? [] : await scenesThrough(scope, ep, checked.content, final);
      }
      return { phase, action, baseVersionId: base.id, before, after: improved ? after : before, improved, content: final, modelId, changed: r.changed, skipped: r.skipped, lengthKept: r.lengthKept, factDiff, sceneDrafts };
    },
    async commit(tx, run, input, p) {
      const scope = scopeOf(run);
      const agent = actors.agent("writer", run.runId);
      const ep = await m.mustEpisode(tx, scope, input.episode_id, true);
      if (ep.status !== (p.phase === "polish" ? "polishing" : "drafting") || ep.currentVersionId !== p.baseVersionId) return skip();
      const version = p.improved ? await m.saveVersion(tx, scope, ep.id, { kind: "revision", content: p.content, author: agent, modelId: p.modelId }) : null;
      const versionId = version?.id ?? p.baseVersionId;
      const profile = await m.lengthProfile(scope, tx);
      const round = Number((input as { adjust_round?: number }).adjust_round ?? 1);
      const adjust = { round, action: p.action, before: p.before, after: p.after, improved: p.improved };
      if (p.phase === "draft") {
        if (p.improved && round < cfg.lengthAdjustMaxRounds && lengthAdjustmentOf(p.after, profile, cfg.lengthTolerance)) {
          await followUp(
            tx,
            scope,
            ep,
            "adjust_length",
            { manuscript_version_id: versionId, cycle_key: `${versionId}:adjust`, adjust_phase: "draft", adjust_round: round + 1, carried: (input as { carried?: unknown }).carried },
            agent,
            700,
          );
          return { kind: "done", outputRefs: [{ refType: "manuscript_version", refId: versionId }] };
        }
        const carried = ((input as { carried?: Record<string, unknown> }).carried ?? {}) as Record<string, unknown>;
        await toChecking(tx, scope, ep, agent, versionId, checkLength(p.content, profile), { ...carried, lengthAdjust: adjust });
        return { kind: "done", outputRefs: [{ refType: "manuscript_version", refId: versionId }] };
      }
      await finishPolished(tx, scope, ep, agent, { id: versionId, content: p.content }, p.factDiff, p.sceneDrafts, { lengthAdjust: adjust });
      return { kind: "done", outputRefs: [{ refType: "manuscript_version", refId: versionId }] };
    },
  };

  // ── P3a split_scenes ──
  const splitScenes: PipelineHandler<In, { versionId: string; drafts: SceneDraft[]; method: string }> = {
    kind: "split_scenes",
    role: "world_keeper",
    promptTemplateVersion: "world_keeper.split_scenes@0.1.0",
    inputSchema: episodeTaskInputSchema,
    allowedWrites: ["manuscript.replaceScenes"],
    context: async () => null,
    async execute(run, input, context, llm) {
      const scope = scopeOf(run);
      const ep = await getService().getEpisode(scope, input.episode_id);
      const versionId = input.manuscript_version_id ?? ep.currentVersionId!;
      const v = (await loadVersion(scope, versionId))!;
      const outline = outlineDataSchema.parse((await loadVersion(scope, ep.outlineVersionId))?.outlineData ?? {});
      const ann = (v.writerAnnotations ?? null) as WriterAnnotations | null;
      let ranges: Range[] | null = null;
      let method = "writer_breaks";
      let summaries: string[] = [];
      if (ann?.scene_breaks?.length) {
        ranges = rangesFromSceneBreaks(ann.scene_breaks, outline.scenes.map((s) => s.key), v.content.length);
        summaries = outline.scenes.map((s) => s.summary);
      }
      if (!ranges) {
        const old = await repo.listScenes(db(), scope, ep.id);
        const oldVid = old[0]?.manuscriptVersionId;
        if (old.length && oldVid && oldVid !== v.id && old.every((s) => s.manuscriptVersionId === oldVid)) {
          const oldV = await loadVersion(scope, oldVid);
          if (oldV) {
            ranges = mapRanges(old.map((s) => ({ start: s.charStart, end: s.charEnd })), diffText(oldV.content, v.content), v.content.length);
            method = "diff_mapped";
            summaries = [];
          }
        }
      }
      if (!ranges) {
        method = "llm_estimate";
        const expected = Math.max(1, outline.scenes.length);
        const det = deterministicRanges(v.content, expected);
        const out = await llm.call({
          run,
          purpose: "scene_segmentation",
          ...promptOf(context, "본문을 장소·시간·시점 인물이 바뀌는 곳에서 씬으로 나눕니다. 씬마다 시작 위치(char_start)와 한 줄 요약을 JSON으로 답합니다.", JSON.stringify({ expectedScenes: expected, text: v.content })),
          output: { kind: "object", schemaName: "SceneSegmentationResult", schema: sceneSegmentationSchema },
        });
        const seg = out.value as import("../domain/schemas.js").SceneSegmentation;
        const starts = seg.scenes.map((s) => s.char_start);
        const okStarts = starts.length && starts[0] === 0 && starts.every((s, i) => i === 0 || s > starts[i - 1]!) && starts[starts.length - 1]! < Math.max(1, v.content.length);
        ranges = okStarts ? rangesFromStarts(starts, v.content.length) : det;
        summaries = okStarts ? seg.scenes.map((s) => s.summary) : [];
        if (!okStarts) method = "deterministic";
      }
      const drafts: SceneDraft[] = ranges.slice(0, cfg.maxScenes).map((r, i) => ({
        ord: i + 1,
        charStart: r.start,
        charEnd: r.end,
        summary: summaries[i] || firstSentence(v.content.slice(r.start, r.end)),
        povEntityId: outline.scenes[i]?.pov_entity_id ?? undefined,
        locationEntityId: outline.scenes[i]?.location_entity_id ?? undefined,
      }));
      if (drafts.length) drafts[drafts.length - 1]!.charEnd = v.content.length;
      return { versionId: v.id, drafts, method };
    },
    async commit(tx, run, input, p) {
      const scope = scopeOf(run);
      const agent = actors.agent("world_keeper", run.runId);
      let ep = await m.mustEpisode(tx, scope, input.episode_id, true);
      if (ep.status !== "checking" || ep.currentVersionId !== p.versionId) return skip();
      const scenes = await getService().replaceScenes(tx, scope, p.versionId, p.drafts, agent);
      if (ep.blockReasons.includes("extraction_failure")) ep = await getService().setBlockReason(tx, scope, ep.id, "extraction_failure", false, agent);
      const next = { manuscript_version_id: p.versionId, cycle_key: p.versionId };
      if (ports.isRegistered("extract_facts")) await followUp(tx, scope, ep, "extract_facts", next, agent, 700);
      else for (const k of ["check_continuity", "check_setups"] as const) if (ports.isRegistered(k)) await followUp(tx, scope, ep, k, next, agent, 700);
      await followUp(tx, scope, ep, "check_text_safety", next, agent, 700);
      return { kind: "done", outputRefs: scenes.map((s) => ({ refType: "scene" as const, refId: s.id })) };
    },
  };

  // ── P3g check_text_safety ──
  const localSafety = new Map<string, Array<{ sceneId: string | null; message: string }>>();
  const checkTextSafety: PipelineHandler<In, { versionId: string; findings: Array<SafetyVerdict["violations"][number] & { sceneId: string | null }> }> = {
    kind: "check_text_safety",
    role: "continuity_editor",
    promptTemplateVersion: "continuity_editor.check_text_safety@0.1.0",
    inputSchema: episodeTaskInputSchema,
    allowedWrites: ["continuity.openIssue(kind=safety_*)"],
    context: async () => null,
    async execute(run, input, context, llm) {
      const scope = scopeOf(run);
      const ep = await getService().getEpisode(scope, input.episode_id);
      const versionId = input.manuscript_version_id ?? ep.currentVersionId!;
      const v = (await loadVersion(scope, versionId))!;
      const n = await novel.getNovel(scope);
      const scenes = (await repo.listScenes(db(), scope, ep.id)).filter((s) => s.manuscriptVersionId === v.id);
      const blocks = scenes.length ? scenes.map((s) => ({ ord: s.ord, text: v.content.slice(s.charStart, s.charEnd) })) : [{ ord: 1, text: v.content }];
      // NFR-SAFE-02 real-person list is install data shipped with releases (none bundled in MVP-α)
      const out = await llm.call({
        run,
        purpose: "text_safety",
        ...promptOf(context, SAFETY_INSTRUCTION, JSON.stringify({ ageRating: n.ageRating, scenes: blocks })),
        output: { kind: "object", schemaName: "TextSafetyVerdict", schema: safetyVerdictSchema },
      });
      const verdict = out.value as SafetyVerdict;
      return { versionId: v.id, findings: verdict.violations.map((f) => ({ ...f, sceneId: scenes.find((s) => s.ord === f.scene_ord)?.id ?? null })) };
    },
    async commit(tx, run, input, p) {
      const scope = scopeOf(run);
      const agent = actors.agent("continuity_editor", run.runId);
      const ep = await m.mustEpisode(tx, scope, input.episode_id, true);
      if (ep.currentVersionId !== p.versionId) return skip();
      const kept: Array<{ sceneId: string | null; message: string }> = [];
      for (const f of p.findings) {
        const message = `${f.kind === "safety_age_rating" ? "연령 등급 수위 초과" : f.kind === "safety_minor_sexual" ? "미성년 인물 성적 묘사" : "실존 인물 사칭·명예훼손"} 의심: ${f.rationale}`.slice(0, 1000);
        const issueId = await ports.openIssue(
          tx,
          scope,
          { kind: f.kind, severity: "high", episodeId: ep.id, manuscriptVersionId: p.versionId, sceneId: f.sceneId, charStart: f.char_start, charEnd: f.char_end, message, fixScope: "scene" },
          agent,
        );
        if (!issueId) kept.push({ sceneId: f.sceneId, message });
      }
      if (kept.length) localSafety.set(p.versionId, kept);
      else localSafety.delete(p.versionId);
      await getService().advanceCheckGate(tx, scope, ep.id, { completedTaskId: run.taskId });
      return { kind: "done", outputRefs: [{ refType: "manuscript_version", refId: p.versionId }] };
    },
  };
  /** used only when no issue sink is registered (continuity placeholder): keeps P3g blocking (SF-5) */
  ports.reg.contributors.push({
    name: "text_safety_local",
    async evaluate(_scope, _ep, versionId) {
      const f = localSafety.get(versionId) ?? [];
      return { source: "text_safety_local", pass: !f.length, fixScope: f.length ? "scene" : undefined, blockers: f.map((x) => ({ refType: "safety", refId: versionId, message: x.message, sceneId: x.sceneId })) };
    },
  });

  // ── P4 polish_episode ──
  /** INV-SC-02 without a re-check: move the current scene boundaries through the diff (07 §6.1 다듬기) */
  const scenesThrough = async (scope: NovelScope, ep: Episode, from: string, content: string): Promise<SceneDraft[]> => {
    const current = await repo.listScenes(db(), scope, ep.id);
    const oldRanges = current.map((x) => ({ start: x.charStart, end: x.charEnd }));
    const mapped = (current.length ? mapRanges(oldRanges, diffText(from, content), content.length) : null) ?? deterministicRanges(content, Math.max(1, current.length));
    const drafts: SceneDraft[] = mapped.map((rg, i) => ({ ord: i + 1, charStart: rg.start, charEnd: rg.end, summary: current[i]?.summary || firstSentence(content.slice(rg.start, rg.end)) }));
    if (drafts.length) drafts[drafts.length - 1]!.charEnd = content.length;
    return drafts;
  };

  /**
   * end of the polish phase for the polished (or length-adjusted) version: a fact diff re-checks (E7), otherwise the
   * scenes move through the diff and the episode waits for approval (E8)
   */
  const finishPolished = async (
    tx: Tx,
    scope: NovelScope,
    ep: Episode,
    agent: import("../../../platform/index.js").ActorRef,
    version: { id: string; content: string },
    factDiff: boolean,
    sceneDrafts: SceneDraft[],
    opts: { countRewrite?: boolean; lengthAdjust?: unknown } = {},
  ) => {
    if (factDiff && cfg.polishRecheckOnFactDiff) {
      // E7: the polished text changed fact-bearing tokens → full re-check (a polish counts toward the auto-rewrite cap)
      await m.transition(tx, scope, ep.id, "checking", actors.system("orchestrator"), {
        ruleId: "E7",
        ...(opts.countRewrite ? { patch: { autoRewriteCount: ep.autoRewriteCount + 1 } } : {}),
        details: { versionId: version.id, ...(opts.lengthAdjust ? { lengthAdjust: opts.lengthAdjust } : {}) },
      });
      await followUp(tx, scope, ep, "split_scenes", { manuscript_version_id: version.id, cycle_key: version.id }, agent, 700);
      return;
    }
    if (sceneDrafts.length) await getService().replaceScenes(tx, scope, version.id, sceneDrafts, agent);
    const length = checkLength(version.content, await m.lengthProfile(scope, tx));
    await m.enterAwaitingApproval(tx, scope, ep.id, agent, { lengthWarning: lengthWarningOf(length), length });
  };

  /** 설계 추가 0017: one more trim / expand round after polishing when the episode is out of range */
  const adjustAfterPolish = async (tx: Tx, scope: NovelScope, ep: Episode, agent: import("../../../platform/index.js").ActorRef, versionId: string, content: string, checkedVersionId: string) => {
    const profile = await m.lengthProfile(scope, tx);
    if (cfg.lengthAdjustMaxRounds <= 0 || !lengthAdjustmentOf(countChars(content, profile.countBasis), profile, cfg.lengthTolerance)) return false;
    await followUp(tx, scope, ep, "adjust_length", { manuscript_version_id: versionId, checked_version_id: checkedVersionId, cycle_key: `${versionId}:adjust`, adjust_phase: "polish", adjust_round: 1 }, agent, 600);
    return true;
  };

  const polishEpisode: PipelineHandler<
    In,
    { content: string; modelId: string; baseVersionId: string; factDiff: boolean; changed: string[]; skipped: string[]; sceneDrafts: SceneDraft[]; rejected: "length_floor" | null; lengthKept: string[] }
  > = {
    kind: "polish_episode",
    role: "line_editor",
    promptTemplateVersion: "line_editor.polish_episode@0.1.0",
    inputSchema: episodeTaskInputSchema,
    allowedWrites: ["manuscript.createVersion(kind=revision)"],
    context: episodeContext,
    async execute(run, input, context, llm) {
      const scope = scopeOf(run);
      const ep = await getService().getEpisode(scope, input.episode_id);
      const base = (await loadVersion(scope, ep.currentVersionId))!;
      const scenes = await activeRanges(scope, ep, base.id);
      const profile = await m.lengthProfile(scope);
      const total = countChars(base.content, profile.countBasis);
      const byOrd = targetsByOrd(base, scenes, profile.countBasis, goalFor(profile, total));
      let modelId = "none";
      const r = await rewriteScenes(
        run,
        { call: async (c) => { const o = await llm.call(c); modelId = o.modelId; return o; } },
        context,
        base,
        scenes,
        () => true,
        POLISH_INSTRUCTION,
        (s) => {
          const t = byOrd.get(s.ord) ?? { count: countChars(s.text.trim(), profile.countBasis), target: countChars(s.text.trim(), profile.countBasis) };
          return `${sceneLengthLine(profile, total, t.count, t.target)} 문장만 다듬고 분량을 늘리지 않습니다.\n${JSON.stringify({ sceneOrd: s.ord, instructions: input.instructions ?? null, text: s.text })}`;
        },
        "polish",
        // polishing never takes an episode under the profile minimum (it only edits sentences); revise keeps the 3,000 floor.
        // 0017: nor above the profile maximum (a grown scene past it keeps the original; an episode already above it never grows)
        { basis: profile.countBasis, min: Math.max(EPISODE_HARD_MIN_CHARS, profile.minChars), ceiling: Math.max(profile.maxChars, total) },
      );
      const content = normalizeText(r.content);
      const names = (await soft(() => ontology.listEntities(scope, { limit: 500 }), [])).map((e) => e.preferredName);
      const factDiff = !signaturesEqual(factSignature(base.content, names), factSignature(content, names));
      const sceneDrafts = await scenesThrough(scope, ep, base.content, content);
      return { content, modelId, baseVersionId: base.id, factDiff, changed: r.changed, skipped: r.skipped, sceneDrafts, rejected: r.rejected, lengthKept: r.lengthKept };
    },
    async commit(tx, run, input, p) {
      const scope = scopeOf(run);
      const agent = actors.agent("line_editor", run.runId);
      const ep = await m.mustEpisode(tx, scope, input.episode_id, true);
      if (ep.status !== "polishing" || ep.currentVersionId !== p.baseVersionId) return skip();
      if (p.rejected === "length_floor") {
        // 설계 추가 L9: the polished text would fall under the floor → keep the checked base version
        const base = await getService().getVersion(scope, p.baseVersionId, tx);
        if (await adjustAfterPolish(tx, scope, ep, agent, base.id, base.content, base.id)) return { kind: "done", outputRefs: [{ refType: "manuscript_version", refId: base.id }] };
        const length = checkLength(base.content, await m.lengthProfile(scope, tx));
        await m.enterAwaitingApproval(tx, scope, ep.id, agent, { lengthWarning: lengthWarningOf(length), length });
        return { kind: "done", outputRefs: [{ refType: "manuscript_version", refId: base.id }] };
      }
      const version = await m.saveVersion(tx, scope, ep.id, { kind: "revision", content: p.content, author: agent, modelId: p.modelId });
      if (!(await adjustAfterPolish(tx, scope, ep, agent, version.id, version.content, p.baseVersionId))) {
        await finishPolished(tx, scope, ep, agent, version, p.factDiff, p.sceneDrafts, { countRewrite: true });
      }
      return { kind: "done", outputRefs: [{ refType: "manuscript_version", refId: version.id }] };
    },
  };

  // ── P6 plan_rework ──
  const planRework: PipelineHandler<In, { plan: ReworkPlan; sceneIds: string[]; reason: string }> = {
    kind: "plan_rework",
    role: "showrunner",
    promptTemplateVersion: "showrunner.plan_rework@0.1.0",
    inputSchema: episodeTaskInputSchema,
    allowedWrites: ["orchestration.createTask", "hitl.createQuestion"],
    context: async () => null,
    async execute(run, input, context, llm) {
      const scope = scopeOf(run);
      const ep = await getService().getEpisode(scope, input.episode_id);
      const rejection = input.rejection_id ? await repo.getRejection(db(), scope, input.rejection_id) : null;
      const reason = rejection?.reason ?? input.instructions ?? "";
      const scenes = await repo.listScenes(db(), scope, ep.id);
      const out = await llm.call({
        run,
        purpose: "plan_rework",
        ...promptOf(context, REWORK_INSTRUCTION, JSON.stringify({ reworkFrom: rejection?.reworkFrom ?? input.rework_from, reason, scenes: scenes.map((s) => ({ ord: s.ord, summary: s.summary })) })),
        output: { kind: "object", schemaName: "ReworkPlan", schema: reworkPlanSchema },
      });
      const plan = out.value as ReworkPlan;
      const sceneIds = scenes.filter((s) => plan.target_scene_ords.includes(s.ord)).map((s) => s.id);
      return { plan: { ...plan, instructions: plan.instructions || reason }, sceneIds, reason };
    },
    async commit(tx, run, input, p) {
      const scope = scopeOf(run);
      const agent = actors.agent("showrunner", run.runId);
      const ep = await m.mustEpisode(tx, scope, input.episode_id, true);
      if (ep.status !== "revising") return skip();
      if (ep.rejectionCount >= cfg.maxRejections) {
        // INV-EP-05: no E12; direction question (replan / human_edit / hold) without continuity_issue links
        await getService().setBlockReason(tx, scope, ep.id, "rewrite_limit", true, agent);
        const questionId = await ports.createQuestion(
          tx,
          scope,
          {
            topic: "rewrite_limit",
            questionType: "single_choice",
            title: `${ep.episodeNo}화 반려 상한에 도달했습니다`,
            body: `이 화는 ${ep.rejectionCount}번 반려되었습니다. 다음 방향을 골라 주세요.\n마지막 반려 사유: ${p.reason}`,
            options: [
              { label: "처음부터 다시 기획", value: "replan", isRecommended: true },
              { label: "직접 고치기", value: "human_edit" },
              { label: "보류", value: "hold" },
            ],
            links: [{ type: "episode", id: ep.id }],
            proposedBlockingBasis: "rewrite_limit",
          },
          { createdBy: agent, taskId: run.taskId, runId: run.runId },
        );
        return { kind: "done", outputRefs: questionId ? [{ refType: "question", refId: questionId }] : [] };
      }
      const from = input.rework_from ?? ep.lastReworkFrom ?? "draft";
      const to = REWORK_TARGET[from];
      await m.transition(tx, scope, ep.id, to, actors.system("orchestrator"), { ruleId: "E12", details: { reworkFrom: from, targetSceneIds: p.sceneIds } });
      const common = { rework_cause: "rejection", instructions: p.plan.instructions, rejection_id: input.rejection_id, cycle_key: `${input.rejection_id ?? ep.id}:${from}` };
      const kind: TaskKind = from === "outline" ? "outline_episode" : from === "draft" ? "revise_episode" : "polish_episode";
      await followUp(tx, scope, ep, kind, { ...common, manuscript_version_id: ep.currentVersionId ?? undefined, target_scene_ids: from === "draft" ? p.sceneIds : undefined, full_rewrite: from === "draft" && !p.sceneIds.length }, agent, 800);
      return { kind: "done", outputRefs: [{ refType: "episode", refId: ep.id }] };
    },
  };

  return { handlers: [outlineEpisode, draftEpisode, reviseEpisode, adjustLength, splitScenes, checkTextSafety, polishEpisode, planRework] as Array<PipelineHandler<any, any>> };
}
