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
  factSignature,
  firstSentence,
  guardSceneLength,
  normalizeText,
  SCENE_SEPARATOR,
  separatorSceneStarts,
  signaturesEqual,
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
const WRITING_SECTIONS: ContextSectionKind[] = ["instruction", "constraints", "story_plan", "assigned_beats", "outline", "cast", "entity_cards", "pov_names", "knowledge", "canon_1hop", "glossary", "recent_text"];

const OUTLINE_INSTRUCTION = `당신은 웹소설 기획자(planner)입니다. 이번 화 아웃라인을 JSON으로 씁니다.
- scenes[]마다 key(s1, s2 …)·summary·pov_entity_id·location_entity_id·participant_entity_ids·setup_beat_ids를 채웁니다. 엔티티는 ID로만 참조합니다.
- 배정된 떡밥 비트는 모두 한 씬 이상에 배정합니다. 새 인물은 new_entity_proposals에 이름만 제안합니다.
- 씬 수는 [작품 구성]의 이번 화 계획 씬 수를 따르고, 계획한 플롯 사건과 현재 부 목표를 벗어나지 않습니다.
- target_chars는 이번 화 목표 분량(최소 분량 이상)입니다. 아직 등장 전인 인물은 등장시키지 않습니다.`;
const DRAFT_INSTRUCTION = `당신은 웹소설 작가(writer)입니다. 아웃라인의 씬을 순서대로 본문으로 씁니다.
- 씬과 씬 사이에는 "${SCENE_SEPARATOR}" 한 줄만 둡니다. 다른 표기·주석은 넣지 않습니다.
- 작품 연령 등급을 넘는 묘사를 쓰지 않습니다. 시점 인물이 모르는 이름은 쓰지 않습니다.
- 목표 분량 이상으로 씁니다. 최소 분량에 못 미친 채로 끝내지 않습니다.
- [작품 구성]의 결말·현재 부 목표·플롯 핵심 사건·이번 화 계획을 벗어나지 않습니다.`;
const CONTINUE_INSTRUCTION = `당신은 웹소설 작가(writer)입니다. 이 화의 초고가 최소 분량보다 짧습니다. 지금까지 쓴 본문 바로 뒤에 이어질 본문만 씁니다.
- 앞 내용을 반복하거나 요약하지 않습니다. 아웃라인의 남은 씬을 이어서 쓰고, 씬이 바뀌면 "${SCENE_SEPARATOR}" 한 줄을 둡니다.
- 제목·메모·설명 없이 이어지는 본문만 출력합니다.`;
const REVISE_INSTRUCTION = `당신은 웹소설 작가(writer)입니다. 주어진 씬 하나만 다시 씁니다. 지적된 문제를 고치고 앞뒤 씬과 이어지게 씁니다. 씬 본문만 출력합니다.`;
const POLISH_INSTRUCTION = `당신은 문장 교정자(line_editor)입니다. 주어진 씬의 문장만 다듬습니다. 사건·인물·숫자·고유명사는 바꾸지 않습니다. 다듬은 씬 본문만 출력합니다.`;
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

  const episodeContext = async (input: In, task: { novelId: string }) => {
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
    };
  };

  /** E1 guard (INV-BIB-02, INV-ARC-02) as a pre-lease gate */
  const planningGate = async (scope: NovelScope, task: { input: unknown }) => {
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
    const n = await novel.getNovel(scope);
    if (n.autonomyLevel !== "full_auto" && !["active", "awaiting_approval", "completed"].includes(arc.status)) {
      return arc.planApprovalId
        ? { ok: false as const, blockReason: "approval" as const, blockedRef: { refType: "approval" as const, refId: arc.planApprovalId } }
        : { ok: false as const, blockReason: "approval" as const };
    }
    return { ok: true as const };
  };

  const loadVersion = async (scope: NovelScope, id: string | null | undefined) => (id ? await repo.getVersion(db(), scope, id) : null);
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
      // 설계 추가 L5: the episode plan's target, never under the profile minimum
      const target = Math.max(ep.targetChars ?? Math.round((profile.minChars + profile.maxChars) / 2), profile.minChars);
      const data = JSON.stringify({
        episode: { no: ep.episodeNo, title: ep.title, hookNote: ep.hookNote },
        arc: { title: arc.title, goal: arc.goalText, conflict: arc.conflictText, end: arc.endCondition, range: [arc.plannedEpisodeFrom, arc.plannedEpisodeTo] },
        plot: { coreEvent: arc.coreEvent, changeText: arc.changeText, involvedCharacterIds: arc.involvedCharacterIds },
        episodePlan: { summary: ep.planSummary, plannedSceneCount: ep.plannedSceneCount, targetChars: target },
        assignedSetupBeatIds: beatIds,
        targetChars: target,
        minChars: profile.minChars,
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
      const outline: OutlineData = outlineDataSchema.parse({ ...v.outline, scenes, hook: v.outline.hook || synth.outline.hook, target_chars: Math.max(v.outline.target_chars || target, profile.minChars) });
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
      // 설계 추가 L6: never below the profile minimum (≥ 3,000-char floor)
      const target = Math.max(outline.target_chars || Math.round((profile.minChars + profile.maxChars) / 2), profile.minChars);
      const basis = countBasisLabel(profile.countBasis);
      const data = JSON.stringify({
        episode: { no: ep.episodeNo, title: ep.title },
        ageRating: n.ageRating,
        targetChars: target,
        minChars: profile.minChars,
        countBasis: basis,
        scenes: outline.scenes.map((s) => ({ key: s.key, summary: s.summary })),
        hook: outline.hook,
        rework: input.rework_cause ? { cause: input.rework_cause, issues: (input.issue_refs ?? []).map((i) => i.message), instructions: input.instructions ?? null } : null,
      });
      const out = await llm.call({
        run,
        purpose: "draft",
        ...promptOf(context, DRAFT_INSTRUCTION, `목표 분량: ${target}자 이상(${basis}), 최소 ${profile.minChars}자 미만으로 끝내지 않습니다.\n${data}`),
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
          attempt,
        });
        const more = await llm.call({
          run,
          purpose: "draft_continue",
          ...promptOf(context, CONTINUE_INSTRUCTION, `부족한 분량: ${profile.minChars - before}자 이상(${basis})\n${payload}`),
          output: { kind: "text" },
          maxOutputTokens: 12_000,
        });
        modelId = more.modelId;
        const extra = normalizeText(String(more.value)).trim();
        if (extra) content = `${content}\n\n${extra}`;
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
    const lengthDetails = p.lengthCheck
      ? { lengthShortfall: Math.max(0, p.lengthCheck.minChars - p.lengthCheck.count), belowFloor: p.lengthCheck.belowFloor, continueAttempts: p.continueAttempts ?? 0 }
      : {};
    await m.transition(tx, scope, ep.id, "checking", agent, { ruleId: "E3", details: { versionId: version.id, ...lengthDetails, ...(p.lengthKept?.length ? { lengthKept: p.lengthKept } : {}) } });
    await followUp(tx, scope, ep, "split_scenes", { manuscript_version_id: version.id, cycle_key: version.id }, agent, 700);
    return { kind: "done" as const, outputRefs: [{ refType: "manuscript_version" as const, refId: version.id }] };
  };

  /** rewrite scene by scene; scenes containing user-written text are never touched (PR-08, INV-MV-03) */
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
    floor?: { basis: CountBasis; min: number },
  ) => {
    const human = userRanges((base.attributionSpans as never) ?? []);
    let out = "";
    let pos = 0;
    const changed: string[] = [];
    const skipped: string[] = [];
    const lengthKept: string[] = [];
    const count = (t: string) => (floor ? countChars(t, floor.basis) : t.length);
    let projected = floor ? count(base.content) : 0;
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
      const trail = /\s*$/.exec(text)![0];
      const r = await llm.call({ run, purpose, ...promptOf(context, instruction, payload({ ord: s.ord, summary: s.summary, text })), output: { kind: "text" } });
      const body = normalizeText(String(r.value)).trim();
      let next = body ? `${lead}${body}${trail}` : text;
      if (floor && body) {
        // 설계 추가 L7: a shorter scene that would take the episode under the floor keeps the original text
        const delta = count(next) - count(text);
        if (guardSceneLength({ originalSceneCount: count(text), newSceneCount: count(next), projectedTotal: projected + delta, floor: floor.min }) === "keep_original") {
          next = text;
          lengthKept.push(s.id);
        } else projected += delta;
      }
      out += next;
      if (next !== text && body !== text.trim()) changed.push(s.id);
      await run.checkpoint();
    }
    out += base.content.slice(pos);
    const rejected = floor && count(out) < floor.min && count(out) < count(base.content) ? ("length_floor" as const) : null;
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
      const target = Math.max(outline.target_chars || Math.round((profile.minChars + profile.maxChars) / 2), profile.minChars);
      if (!base) throw new DomainValidationError("no_manuscript", "수정할 원고 버전이 없습니다.");
      const scenes = await activeRanges(scope, ep, base.id);
      const targets = new Set(input.target_scene_ids ?? []);
      const whole = (input as { full_rewrite?: boolean }).full_rewrite === true || !targets.size;
      const issues = (input.issue_refs ?? []).map((i) => i.message).filter(Boolean);
      let modelId = "none";
      const r = await rewriteScenes(
        run,
        { call: async (c) => { const o = await llm.call(c); modelId = o.modelId; return o; } },
        context,
        base,
        scenes,
        (s) => whole || targets.has(s.id),
        REVISE_INSTRUCTION,
        (s) =>
          `목표 분량: ${countChars(s.text.trim(), profile.countBasis)}자 이상 — 이 씬 분량을 줄이지 마세요(현재 ${countChars(s.text.trim(), profile.countBasis)}자, 화 전체 목표 ${target}자)\n${JSON.stringify({ sceneOrd: s.ord, summary: s.summary, issues, instructions: input.instructions ?? null, text: s.text })}`,
        "revise",
        { basis: profile.countBasis, min: EPISODE_HARD_MIN_CHARS },
      );
      const content = normalizeText(r.content);
      return { content, annotations: annotate(content, outline), modelId, baseVersionId: base.id, changed: r.changed, skipped: r.skipped, rejected: r.rejected, lengthKept: r.lengthKept };
    },
    commit: (tx, run, input, p) => commitBody(tx, run, input, p, "revision"),
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
      let modelId = "none";
      const r = await rewriteScenes(
        run,
        { call: async (c) => { const o = await llm.call(c); modelId = o.modelId; return o; } },
        context,
        base,
        scenes,
        () => true,
        POLISH_INSTRUCTION,
        (s) =>
          `목표 분량: ${countChars(s.text.trim(), profile.countBasis)}자 이상 — 이 씬 분량을 줄이지 마세요(현재 ${countChars(s.text.trim(), profile.countBasis)}자)\n${JSON.stringify({ sceneOrd: s.ord, instructions: input.instructions ?? null, text: s.text })}`,
        "polish",
        // polishing never takes an episode under the profile minimum (it only edits sentences); revise keeps the 3,000 floor
        { basis: profile.countBasis, min: Math.max(EPISODE_HARD_MIN_CHARS, profile.minChars) },
      );
      const content = normalizeText(r.content);
      const names = (await soft(() => ontology.listEntities(scope, { limit: 500 }), [])).map((e) => e.preferredName);
      const factDiff = !signaturesEqual(factSignature(base.content, names), factSignature(content, names));
      // INV-SC-02 without a re-check: move the scene boundaries through the diff (07 §6.1 다듬기)
      const current = await repo.listScenes(db(), scope, ep.id);
      const oldRanges = current.map((x) => ({ start: x.charStart, end: x.charEnd }));
      const mapped = (current.length ? mapRanges(oldRanges, diffText(base.content, content), content.length) : null) ?? deterministicRanges(content, Math.max(1, current.length));
      const sceneDrafts: SceneDraft[] = mapped.map((rg, i) => ({ ord: i + 1, charStart: rg.start, charEnd: rg.end, summary: current[i]?.summary || firstSentence(content.slice(rg.start, rg.end)) }));
      if (sceneDrafts.length) sceneDrafts[sceneDrafts.length - 1]!.charEnd = content.length;
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
        const length = checkLength(base.content, await m.lengthProfile(scope, tx));
        await m.enterAwaitingApproval(tx, scope, ep.id, agent, { lengthWarning: lengthWarningOf(length), length });
        return { kind: "done", outputRefs: [{ refType: "manuscript_version", refId: base.id }] };
      }
      const version = await m.saveVersion(tx, scope, ep.id, { kind: "revision", content: p.content, author: agent, modelId: p.modelId });
      if (p.factDiff && cfg.polishRecheckOnFactDiff) {
        // E7: the polished text changed fact-bearing tokens → full re-check (counts toward the auto-rewrite cap)
        await m.transition(tx, scope, ep.id, "checking", actors.system("orchestrator"), { ruleId: "E7", patch: { autoRewriteCount: ep.autoRewriteCount + 1 }, details: { versionId: version.id } });
        await followUp(tx, scope, ep, "split_scenes", { manuscript_version_id: version.id, cycle_key: version.id }, agent, 700);
      } else {
        if (p.sceneDrafts.length) await getService().replaceScenes(tx, scope, version.id, p.sceneDrafts, agent);
        const length = checkLength(p.content, await m.lengthProfile(scope, tx));
        await m.enterAwaitingApproval(tx, scope, ep.id, agent, { lengthWarning: lengthWarningOf(length), length });
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

  return { handlers: [outlineEpisode, draftEpisode, reviseEpisode, splitScenes, checkTextSafety, polishEpisode, planRework] as Array<PipelineHandler<any, any>> };
}
