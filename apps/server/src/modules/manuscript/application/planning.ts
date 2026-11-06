/**
 * Planning pipeline (07 §1.3 B1/B3, 04 §3.4): plan_series_bible, schedule_episodes, plan_arc, the
 * approval handlers series_bible / arc_plan / arc / episode (05 §10) and the deterministic scheduler.
 */
import { actors, type ActorRef, type NovelScope, type Tx } from "../../../platform/index.js";
import type { ApprovalDecisionContext } from "../../hitl/index.js";
import type { Arc } from "../../novel/index.js";
import type { LlmCitation } from "../../llm/index.js";
import { manuscriptRepo as repo } from "../adapters/db/manuscript-repository.js";
import {
  arcPlanProposalSchema,
  bibleProposalSchema,
  planArcInputSchema,
  planSeriesBibleInputSchema,
  scheduleEpisodesInputSchema,
  type ArcPlanProposal,
  type BibleProposal,
} from "../domain/schemas.js";
import { bibleMarkdown, synthArcPlan, synthBible } from "../domain/synth.js";
import { IN_FLIGHT_STATUSES } from "../domain/transitions.js";
import { belowFloorByCounts } from "../domain/text.js";
import { EPISODE_HARD_MIN_CHARS, parseAutopilotSettings, startOfLocalDay } from "@ncs/shared";
import type { ScheduleResult } from "../index.js";
import { promptOf, type PipelineHandler } from "./agent-task.js";
import type { ManuscriptInternals } from "./manuscript-service.js";
import { castPortOf, settings, soft } from "./support.js";
import { structureGateRef, type StructureApi } from "./structure.js";
import { DomainValidationError } from "../../../platform/index.js";
import type { PlotCharacterDraft } from "../index.js";

const BIBLE_INSTRUCTION = `당신은 웹소설 기획자(planner)입니다. 승인된 컨셉과 목표를 바탕으로 연재 기획서를 JSON으로 작성합니다.
- logline은 컨셉의 로그라인을 그대로 씁니다.
- 인물·세계 규칙마다 source_field_path(컨셉 필드 경로, 새 항목은 null)를 붙입니다.
- 인물·장소는 이름 문자열로 사실을 만들지 않습니다(초기 온톨로지 단계 입력).
- arc_outline은 아크별 제목·화수·요약입니다. 연령 등급을 넘는 내용은 넣지 않습니다.
- 컨텍스트에 확정된 캐릭터 설정이 있으면 characters는 그 이름·역할을 그대로 쓰고 바꾸지 않습니다.`;

const ARC_INSTRUCTION = `당신은 웹소설 기획자(planner)입니다. 기획서·전체 구성(결말·현재 부)과 이전 플롯 결과를 바탕으로 이번 플롯(큰 사건)의 목표·갈등·종료 조건과 화별 계획을 JSON으로 씁니다.
- 화 번호는 주어진 범위 안에서만 씁니다. 화마다 summary(이번 화에서 일어날 일), scene_count(씬 수), target_chars(목표 분량, 주어진 최소~최대 안)를 적습니다.
- core_event(핵심 사건), change_text(이 플롯이 만들어 내는 변화), involved_character_ids(roster id만), setup_plan(심을 떡밥 plant·회수할 떡밥 payoff)을 채웁니다.
- 플롯이 전체 구성의 현재 부 목표와 결말 방향을 벗어나지 않게 합니다.
- 새 인물이 필요하면 new_characters에 필수 항목을 모두 채워 제안합니다(주인공급: 나이·외형·성격(장점·결점)·목표·동기·두려움·과거사 2~3줄·말투 예시 1~2줄·주인공과의 관계·변화 아크 시작과 끝 / 조연·적대자: 이야기 속 역할·목표·주인공과의 관계). 첫 등장 화(first_appearance_episode_no)도 적습니다.`;

export interface PlanningApi {
  handlers: Array<PipelineHandler<any, any>>;
  requestArcPlanApproval(tx: Tx, scope: NovelScope, arcId: string, actor: ActorRef): Promise<{ approvalId: string | null }>;
  approvalHandlers: Record<"series_bible" | "arc_plan" | "arc" | "episode", (ctx: ApprovalDecisionContext) => Promise<void>>;
  schedule(scope: NovelScope): Promise<ScheduleResult>;
  onGoalSaved(ctx: { tx: Tx; scope: NovelScope; enteredPlanning: boolean; actor: ActorRef; novel: { approvedConceptBriefId: string | null } }): Promise<void>;
}

export function createPlanning(m: ManuscriptInternals, getService: () => import("../index.js").ManuscriptService, structure: StructureApi): PlanningApi {
  const { ports } = m;
  const cast = () => castPortOf(ports.reg);
  const { novel, orchestration, ontology, platform } = ports.deps;
  const scheduler = actors.system("scheduler");
  const cfg = settings();

  // ── B1 plan_series_bible ──
  const planSeriesBible: PipelineHandler<import("../domain/schemas.js").PlanSeriesBibleInput, { bible: BibleProposal; supersede: string[]; modelId: string; sources?: LlmCitation[] }> = {
    kind: "plan_series_bible",
    role: "planner",
    promptTemplateVersion: "planner.plan_series_bible@0.1.0",
    inputSchema: planSeriesBibleInputSchema,
    allowedWrites: ["novel.createBibleVersion", "hitl.requestApproval"],
    // 설계 추가: the confirmed cast (module cast, context section "cast") is an input of the series bible
    // 설계 추가(world): the world ontology (approved + flagged candidates) too
    context: async () => ({ anchor: { storyPoint: 0, timelineId: "" }, sections: ["cast", "world"] }),
    async execute(run, input, context, llm) {
      const scope = { novelId: run.novelId };
      const n = await novel.getNovel(scope);
      const goal = await novel.getGoal(scope);
      const bibles = await novel.listBibles(scope);
      const facts = { title: n.title, genre: n.genre, endingDirection: goal?.endingDirection ?? "", totalEpisodesMin: goal?.totalEpisodesMin ?? 30 };
      const data = JSON.stringify({ novel: { title: n.title, genre: n.genre, ageRating: n.ageRating, category: n.category }, goal, conceptBriefId: input.concept_brief_id, sourceMessageIds: input.source_message_ids, rejectionNote: input.rejection_note ?? null });
      const p = promptOf(context, BIBLE_INSTRUCTION, data);
      const out = await llm.call({
        run,
        purpose: "plan_series_bible",
        ...p,
        output: { kind: "object", schemaName: "SeriesBibleProposal", schema: bibleProposalSchema },
        // 설계 추가 0011: facts / genre conventions / terminology (novel setting 인터넷 검색)
        webSearch: true,
      });
      const sources = out.webSearch?.status === "used" ? out.webSearch.citations : [];
      const synth = synthBible(facts, input.rejection_note);
      const v = out.value as BibleProposal;
      const bible: BibleProposal = {
        ...v,
        logline: v.logline || synth.logline,
        synopsis: v.synopsis || synth.synopsis,
        ending_direction: v.ending_direction || synth.ending_direction,
        arc_outline: v.arc_outline.length ? v.arc_outline : synth.arc_outline,
        characters: v.characters.length ? v.characters : synth.characters,
      };
      return { bible, supersede: bibles.filter((b) => b.status === "draft" || b.status === "awaiting_approval").map((b) => b.id), modelId: out.modelId, ...(sources.length ? { sources } : {}) };
    },
    async commit(tx, run, input, p) {
      const scope = { novelId: run.novelId };
      const agent = actors.agent("planner", run.runId);
      for (const id of p.supersede) {
        const b = await novel.getBible(scope, id, tx);
        if (b.status === "draft" || b.status === "awaiting_approval") {
          await novel.transitionBible(tx, scope, id, "superseded", agent, { reason: "새 기획서 버전" });
          if (b.approvalId && b.status === "awaiting_approval") await soft(() => ports.deps.hitl.cancelApproval(tx, scope, b.approvalId!, "새 기획서 버전", agent), undefined);
        }
      }
      const bible = await novel.createBibleVersion(
        tx,
        scope,
        { logline: p.bible.logline, synopsis: p.bible.synopsis, content: { ...p.bible, model_id: p.modelId, ...(p.sources?.length ? { sources: p.sources } : {}) }, contentMd: bibleMarkdown(p.bible) + (p.sources?.length ? `\n\n## 출처 (인터넷 검색)\n${p.sources.map((x, i) => `${i + 1}. ${x.title ? `${x.title} — ` : ""}${x.url}`).join("\n")}\n` : ""), conceptBriefId: input.concept_brief_id },
        agent,
      );
      const req = await ports.requestApproval(tx, scope, {
        approvalType: "series_bible",
        target: { type: "series_bible", id: bible.id },
        question: {
          title: `기획서 ${bible.versionNo}판 승인 요청`,
          body: `${p.bible.logline}\n\n${p.bible.synopsis.slice(0, 600)}\n\n승인하면 아크 계획을 시작합니다. 반려하면 사유를 적어 주세요.`,
          links: [{ type: "series_bible", id: bible.id }],
        },
        requestedBy: agent,
        taskId: run.taskId,
      });
      await novel.transitionBible(tx, scope, bible.id, "awaiting_approval", agent, req.approvalId ? { approvalId: req.approvalId } : {});
      return { kind: "done", outputRefs: [{ refType: "series_bible", refId: bible.id }] };
    },
  };

  // ── P0 schedule_episodes (showrunner; deterministic) ──
  const scheduleEpisodes: PipelineHandler<
    import("../domain/schemas.js").ScheduleEpisodesInput,
    { arc: { ord: number; title: string; from: number; to: number; summary: string } | null; planArcId?: string | null; note?: string }
  > = {
    kind: "schedule_episodes",
    role: "showrunner",
    promptTemplateVersion: "code.schedule_episodes@0.1.0",
    inputSchema: scheduleEpisodesInputSchema,
    allowedWrites: ["novel.createArc", "orchestration.createTask"],
    context: async () => null,
    async execute(run) {
      const scope = { novelId: run.novelId };
      const bible = await novel.getApprovedBible(scope);
      const goal = await novel.getGoal(scope);
      if (!bible || !goal) return { arc: null };
      const arcs = (await novel.listArcs(scope)).filter((a) => a.status !== "cancelled");
      // 설계 추가: with a story structure the plots already exist (created on approval) — plan the next one
      const st = await novel.getStructure(scope);
      if (st || !arcs.length) {
        if (!st || st.status !== "approved") return { arc: null, note: "no_approved_structure" };
        const eps = await repo.listEpisodes(platform.uow.db, scope);
        const count = (id: string) => eps.filter((e) => e.arcId === id).length;
        const active = await orchestration.listTasks(scope, { kinds: ["plan_arc"], statuses: ["pending", "ready", "running", "blocked"], limit: 50 });
        const inPlanning = arcs.some((a) => a.status === "plan_awaiting_approval" || (a.status === "planned" && (count(a.id) > 0 || active.some((t) => t.targetId === a.id))));
        if (inPlanning || arcs.some((a) => (a.planFlags ?? []).length)) return { arc: null, note: "plot_in_planning" };
        const next = arcs.filter((a) => a.status === "planned" && count(a.id) === 0).sort((a, b) => a.plannedEpisodeFrom - b.plannedEpisodeFrom)[0];
        return { arc: null, planArcId: next?.id ?? null, note: next ? undefined : "all_plots_planned" };
      }
      if (arcs.some((a) => a.status === "planned" || a.status === "plan_awaiting_approval")) return { arc: null }; // next arc already being planned
      const ord = arcs.reduce((n, a) => Math.max(n, a.ord), 0) + 1;
      const from = arcs.reduce((n, a) => Math.max(n, a.plannedEpisodeTo), 0) + 1;
      const outline = ((bible.content as { arc_outline?: Array<{ title: string; episode_count?: number; summary?: string }> })?.arc_outline ?? [])[ord - 1];
      let to = from + Math.max(1, outline?.episode_count ?? 10) - 1;
      if (goal.totalEpisodesMax) to = Math.min(to, goal.totalEpisodesMax);
      if (to < from) return { arc: null }; // goal reached
      return { arc: { ord, title: outline?.title ?? `${ord}부`, from, to, summary: outline?.summary ?? "" } };
    },
    async commit(tx, run, _input, p) {
      if (p.planArcId) {
        const scope = { novelId: run.novelId };
        const agent = actors.agent("showrunner", run.runId);
        const arc = await novel.getArc(scope, p.planArcId, tx);
        if (arc.status !== "planned") return { kind: "done", outputRefs: [] };
        await ports.createTask(tx, scope, { kind: "plan_arc", targetType: "arc", targetId: arc.id, arcId: arc.id, input: { arc_id: arc.id }, createdBy: agent, priority: 400 });
        return { kind: "done", outputRefs: [{ refType: "arc", refId: arc.id }] };
      }
      if (!p.arc) return { kind: "done", outputRefs: [] };
      const scope = { novelId: run.novelId };
      const agent = actors.agent("showrunner", run.runId);
      const arc = await novel.createArc(
        tx,
        scope,
        { ord: p.arc.ord, title: p.arc.title, goalText: p.arc.summary, conflictText: "", endCondition: "", plannedEpisodeFrom: p.arc.from, plannedEpisodeTo: p.arc.to },
        agent,
      );
      await ports.createTask(tx, scope, { kind: "plan_arc", targetType: "arc", targetId: arc.id, arcId: arc.id, input: { arc_id: arc.id }, createdBy: agent, priority: 400 });
      return { kind: "done", outputRefs: [{ refType: "arc", refId: arc.id }] };
    },
  };

  // ── B3 plan_arc ──
  const planArc: PipelineHandler<import("../domain/schemas.js").PlanArcInput, { plan: ArcPlanProposal; modelId: string; newCharacters: PlotCharacterDraft[] }> = {
    kind: "plan_arc",
    role: "planner",
    promptTemplateVersion: "planner.plan_arc@0.1.0",
    inputSchema: planArcInputSchema,
    allowedWrites: ["novel.updateArc", "manuscript.createPlannedEpisodes", "orchestration.createTask", "hitl.requestApproval"],
    // 설계 추가: an unapproved story structure blocks plot planning (ST2 unblocks it)
    async gate(scope) {
      const st = await novel.getStructure(scope);
      if (!st || st.status === "approved") return { ok: true as const };
      return { ok: false as const, blockReason: "approval" as const, blockedRef: structureGateRef(scope) };
    },
    async context(input, task) {
      const scope = { novelId: task.novelId };
      const arc = await soft(() => novel.getArc(scope, input.arc_id), null);
      const roster = await cast().roster(scope);
      const entityIds = (arc?.involvedCharacterIds ?? []).map((id) => roster.find((r) => r.id === id)?.entityId).filter((x): x is string => !!x);
      return { anchor: { storyPoint: (arc?.plannedEpisodeFrom ?? 0) * 1000, timelineId: "" }, sections: ["cast", "story_plan"], arcId: input.arc_id, seeds: { entityIds, setupIds: [], answerIds: input.answer_ids ?? [], mentionIds: [] } };
    },
    async execute(run, input, context, llm) {
      const scope = { novelId: run.novelId };
      const arc = await novel.getArc(scope, input.arc_id);
      const bible = await novel.getApprovedBible(scope);
      const st = await novel.getStructure(scope);
      const part = st && arc.partId ? st.parts.find((x) => x.id === arc.partId) : undefined;
      const roster = await cast().roster(scope);
      const profile = await m.lengthProfile(scope);
      const outline = part ? undefined : ((bible?.content as { arc_outline?: Array<{ title: string; summary?: string }> })?.arc_outline ?? [])[arc.ord - 1];
      const previous = (await novel.listArcs(scope)).filter((a) => a.ord < arc.ord && a.status !== "cancelled").map((a) => ({ title: a.title, goal: a.goalText, end: a.endCondition, change: a.changeText }));
      const data = JSON.stringify({
        arc: { ord: arc.ord, title: arc.title, from: arc.plannedEpisodeFrom, to: arc.plannedEpisodeTo, coreEvent: arc.coreEvent },
        part: part ? { ord: part.ord, title: part.title, goal: part.goalText, turningPoints: part.turningPoints, from: part.plannedEpisodeFrom, to: part.plannedEpisodeTo } : null,
        bible: bible ? { logline: bible.logline, synopsis: bible.synopsis, arcOutline: outline } : null,
        roster: roster.map((r) => ({ id: r.id, name: r.name, role: r.role, firstAppearanceEpisodeNo: r.firstAppearanceEpisodeNo })),
        episodeLength: { minChars: profile.minChars, maxChars: profile.maxChars, basis: profile.countBasis },
        maxScenesPerEpisode: cfg.maxScenes,
        previous,
        rejectionNote: input.rejection_note ?? null,
      });
      const out = await llm.call({
        run,
        purpose: "plan_arc",
        ...promptOf(context, ARC_INSTRUCTION, data),
        output: { kind: "object", schemaName: "ArcPlanProposal", schema: arcPlanProposalSchema },
      });
      const v = out.value as ArcPlanProposal;
      const synth = synthArcPlan(arc, outline ? { title: outline.title, summary: outline.summary ?? "" } : undefined);
      const byNo = new Map(v.episodes.filter((e) => e.episode_no >= arc.plannedEpisodeFrom && e.episode_no <= arc.plannedEpisodeTo).map((e) => [e.episode_no, e]));
      const known = new Set(roster.map((r) => r.id));
      const clampScenes = (n: number | null) => (n === null || !Number.isFinite(n) ? Math.min(cfg.maxScenes, 3) : Math.min(cfg.maxScenes, Math.max(1, Math.round(n))));
      const clampTarget = (n: number | null) => Math.min(profile.maxChars, Math.max(profile.minChars, n ?? Math.round((profile.minChars + profile.maxChars) / 2)));
      const plan: ArcPlanProposal = {
        title: v.title || synth.title,
        goal_text: v.goal_text || synth.goal_text,
        conflict_text: v.conflict_text || synth.conflict_text,
        end_condition: v.end_condition || synth.end_condition,
        core_event: v.core_event || arc.coreEvent,
        involved_character_ids: [...new Set(v.involved_character_ids.filter((id) => known.has(id)))],
        change_text: v.change_text,
        setup_plan: { plant: v.setup_plan.plant.filter((x) => x.trim()).slice(0, 20), payoff: v.setup_plan.payoff.filter((x) => x.trim()).slice(0, 20) },
        new_characters: [],
        // INV-ARC-01: only the arc range
        episodes: synth.episodes.map((e) => {
          const got = byNo.get(e.episode_no);
          const merged = { ...e, ...(got ?? {}) };
          return { ...merged, scene_count: clampScenes(merged.scene_count), target_chars: clampTarget(merged.target_chars) };
        }),
      };
      const names = new Set(roster.map((r) => r.name.replace(/\s+/g, "")));
      const newCharacters: PlotCharacterDraft[] = v.new_characters
        .filter((c) => c.name.trim() && !names.has(c.name.replace(/\s+/g, "")))
        .slice(0, 8)
        .map((c) => ({
          name: c.name.trim(),
          role: c.role,
          age: c.age,
          appearance: c.appearance,
          personality: c.personality,
          desire: c.desire,
          motivation: c.motivation,
          weakness: c.weakness,
          background: c.background,
          speechSample: c.speech_sample,
          arcStart: c.arc_start,
          arcEnd: c.arc_end,
          storyRole: c.story_role,
          relationToProtagonist: c.relation_to_protagonist,
          firstAppearanceEpisodeNo:
            c.first_appearance_episode_no && c.first_appearance_episode_no >= arc.plannedEpisodeFrom && c.first_appearance_episode_no <= arc.plannedEpisodeTo ? c.first_appearance_episode_no : arc.plannedEpisodeFrom,
        }));
      return { plan, modelId: out.modelId, newCharacters };
    },
    async commit(tx, run, input, p) {
      const scope = { novelId: run.novelId };
      const agent = actors.agent("planner", run.runId);
      const arc = await novel.getArc(scope, input.arc_id, tx);
      const replanActive = input.replan === true && arc.status === "active";
      if (arc.status !== "planned" && !replanActive) return { kind: "done", outputRefs: [] }; // already decided elsewhere
      if (replanActive) {
        // a running plot's new plan is applied only after its approval (full_auto: decided by the autopilot, 설계 추가 0014)
        await requestReplanApproval(tx, scope, arc, p, agent, run.taskId);
        return { kind: "done", outputRefs: [{ refType: "arc", refId: arc.id }] };
      }
      const eps = await applyArcPlan(tx, scope, arc, p, agent);
      if (ports.isRegistered("plan_setups")) {
        await ports.createTask(tx, scope, { kind: "plan_setups", targetType: "arc", targetId: arc.id, arcId: arc.id, input: { arc_id: arc.id }, createdBy: agent, priority: 400 });
      } else {
        await requestArcPlanApproval(tx, scope, arc.id, agent);
      }
      return { kind: "done", outputRefs: [{ refType: "arc", refId: arc.id }, ...eps.map((e) => ({ refType: "episode" as const, refId: e.id }))] };
    },
  };

  type ArcPlanResult = { plan: ArcPlanProposal; modelId: string; newCharacters: PlotCharacterDraft[] };

  /** writes a plan_arc proposal: plot fields, planned episodes, the characters it introduces (also listed as involved) */
  const applyArcPlan = async (tx: Tx, scope: NovelScope, arc: Arc, p: ArcPlanResult, actor: ActorRef) => {
    const introduced = p.newCharacters.length ? (await cast().proposePlotCharacters(tx, scope, arc.id, p.newCharacters, actor)).characterIds : [];
    await novel.updateArc(
      scope,
      arc.id,
      {
        title: p.plan.title,
        goalText: p.plan.goal_text,
        conflictText: p.plan.conflict_text,
        endCondition: p.plan.end_condition,
        coreEvent: p.plan.core_event,
        involvedCharacterIds: [...new Set([...p.plan.involved_character_ids, ...introduced])],
        changeText: p.plan.change_text,
        setupPlan: p.plan.setup_plan,
      },
      actor,
      tx,
    );
    const eps = await getService().createPlannedEpisodes(
      tx,
      scope,
      arc.id,
      p.plan.episodes.map((e) => ({ episodeNo: e.episode_no, title: e.title, hookNote: e.hook_note, planSummary: e.summary, plannedSceneCount: e.scene_count, targetChars: e.target_chars })),
      actor,
    );
    // first appearances of the involved cast (new characters carry their own)
    const roster = await cast().roster(scope, tx);
    const firsts = p.plan.involved_character_ids
      .filter((id) => roster.find((r) => r.id === id && r.firstAppearanceEpisodeNo === null))
      .map((characterId) => ({ characterId, episodeNo: arc.plannedEpisodeFrom }));
    if (firsts.length) await cast().applyFirstAppearances(tx, scope, firsts, actor);
    if ((arc.planFlags ?? []).length) await novel.setArcPlanFlags(tx, scope, arc.id, [], actor);
    return eps;
  };

  /** a re-plan of a running plot waits for the author: the proposal travels in the arc_plan approval payload */
  const requestReplanApproval = async (tx: Tx, scope: NovelScope, arc: Arc, p: ArcPlanResult, actor: ActorRef, taskId: string | null) => {
    const eps = (await repo.listEpisodes(tx.db, scope, { arcId: arc.id })).filter((e) => e.status === "planned");
    const planned = new Set(eps.map((e) => e.episodeNo));
    const lines = p.plan.episodes
      .filter((e) => planned.has(e.episode_no))
      .slice(0, 20)
      .map((e) => `- ${e.episode_no}화${e.title ? ` ${e.title}` : ""}${e.summary ? `: ${e.summary}` : ""} (씬 ${e.scene_count ?? "?"}개, 목표 ${e.target_chars ?? "?"}자)`);
    return ports.requestApproval(tx, scope, {
      approvalType: "arc_plan",
      target: { type: "arc", id: arc.id },
      question: {
        title: `「${p.plan.title || arc.title}」 플롯 재계획 승인 요청`,
        body: [
          `진행 중인 플롯 「${arc.title}」(${arc.plannedEpisodeFrom}~${arc.plannedEpisodeTo}화)의 새 계획입니다. 승인하면 아직 아웃라인을 쓰지 않은 화의 계획만 바뀌고, 반려하면 지금 계획을 유지합니다.`,
          "",
          `핵심 사건: ${p.plan.core_event || "-"}`,
          `만들어 낼 변화: ${p.plan.change_text || "-"}`,
          ...(p.newCharacters.length ? [`새 인물 제안: ${p.newCharacters.map((c) => c.name).join(", ")}`] : []),
          "",
          ...(lines.length ? lines : ["(바뀌는 화 계획이 없습니다)"]),
        ].join("\n"),
        links: [{ type: "arc", id: arc.id }],
      },
      requestedBy: actor,
      taskId,
      payload: { replan: p },
    });
  };

  // ── AR1 (설계 추가 0014: full_auto too — the autopilot decides the arc_plan approval; AR4 stays in the table for old rows) ──
  const requestArcPlanApproval = async (tx: Tx, scope: NovelScope, arcId: string, actor: ActorRef) => {
    const arc = await novel.getArc(scope, arcId, tx);
    if (arc.status !== "planned") return { approvalId: arc.planApprovalId ?? null };
    // 설계 추가: plots wait for the approved structure; the plot's new characters must be complete first
    const st = await novel.getStructure(scope, tx);
    if (st && st.status !== "approved") return { approvalId: null };
    const gaps = await cast().completeness(scope, { scope: "arc", arcId }, tx);
    if (!gaps.complete) await cast().requestFill(tx, scope, gaps.items.filter((i) => i.missing.length).map((i) => i.characterId), actor);
    const eps = await repo.listEpisodes(tx.db, scope, { arcId });
    const req = await ports.requestApproval(tx, scope, {
      approvalType: "arc_plan",
      target: { type: "arc", id: arcId },
      question: {
        title: `「${arc.title}」 플롯 계획 승인 요청`,
        body: `${arc.title} (${arc.plannedEpisodeFrom}~${arc.plannedEpisodeTo}화)\n${arc.coreEvent ? `핵심 사건: ${arc.coreEvent}\n` : ""}목표: ${arc.goalText}\n갈등: ${arc.conflictText}\n종료 조건: ${arc.endCondition}${arc.changeText ? `\n만들어 낼 변화: ${arc.changeText}` : ""}\n\n${eps
          .slice(0, 20)
          .map((e) => `- ${e.episodeNo}화${e.title ? ` ${e.title}` : ""}${e.planSummary ? `: ${e.planSummary}` : e.hookNote ? `: ${e.hookNote}` : ""}${e.plannedSceneCount ? ` (씬 ${e.plannedSceneCount}개, 목표 ${e.targetChars ?? "?"}자)` : ""}`)
          .join("\n")}${gaps.complete ? "" : `\n\n⚠ 이 플롯에 새로 등장하는 인물을 캐릭터 화면에서 확인해야 승인할 수 있습니다.\n${gaps.message}`}`,
        links: [{ type: "arc", id: arcId }, ...gaps.items.map((i) => ({ type: "character" as const, id: i.characterId }))],
      },
      requestedBy: actor,
      ...(gaps.complete ? {} : { payload: { castIncomplete: true, characterIds: gaps.items.map((i) => i.characterId) } }),
    });
    await novel.transitionArc(tx, scope, arcId, "plan_awaiting_approval", actor, req.approvalId ? { planApprovalId: req.approvalId } : {});
    return { approvalId: req.approvalId };
  };

  // ── approval handlers (05 §10) ──
  const unblock = (tx: Tx, scope: NovelScope, approvalId: string) =>
    soft(() => orchestration.unblockByRef(tx, scope, { refType: "approval", refId: approvalId }, { reason: "approval_decided", keyPrefix: `apr:${approvalId}` }), []);

  const approvalHandlers: PlanningApi["approvalHandlers"] = {
    async series_bible(ctx) {
      const { tx, scope, approval, actor } = ctx;
      const bible = await novel.getBible(scope, approval.subjectId, tx);
      if (ctx.decision === "approved") {
        await novel.transitionBible(tx, scope, bible.id, "approved", actor, { approvalId: approval.id });
        await soft(() => ontology.approveBibleFacts(tx, scope, bible.id, actor), null); // INV-BIB-03
        if (ports.isRegistered("build_initial_ontology")) {
          await ports.createTask(tx, scope, { kind: "build_initial_ontology", targetType: "novel", targetId: scope.novelId, input: { series_bible_id: bible.id }, createdBy: actor, priority: 400 });
        }
        const goal = await novel.getGoal(scope, tx);
        // 설계 추가: 기획서 → 전체 구성(plan_structure, cast completeness gate) → 승인 → 플롯. 0008 이전 작품(구성 없이 아크가 있음)은 기존 경로
        const st = await novel.getStructure(scope, tx);
        const legacy = !st && (await novel.listArcs(scope, tx)).some((a) => a.status !== "cancelled");
        if (goal && (legacy || st?.status === "approved")) {
          await ports.createTask(tx, scope, { kind: "schedule_episodes", targetType: "goal", targetId: goal.id, input: { goal_id: goal.id, reason: "bible_approved" }, createdBy: actor, priority: 400 });
        } else if (goal && !st) {
          const g = await structure.gate(scope, tx);
          if (!g.reasons.some((r) => r.code !== "bible_not_approved")) await structure.createPlanStructureTask(tx, scope, { scope: "all" }, actor);
        }
      } else {
        await novel.transitionBible(tx, scope, bible.id, "draft", actor, { approvalId: approval.id, reason: ctx.decisionNote ?? undefined }); // B3
        await ports.createTask(tx, scope, {
          kind: "plan_series_bible",
          targetType: "novel",
          targetId: scope.novelId,
          input: { concept_brief_id: bible.conceptBriefId, source_message_ids: [], rejection_note: ctx.decisionNote ?? null, previous_bible_id: bible.id },
          createdBy: actor,
          priority: 400,
        });
      }
      await unblock(tx, scope, approval.id);
    },
    async arc_plan(ctx) {
      const { tx, scope, approval, actor } = ctx;
      const arc = await novel.getArc(scope, approval.subjectId, tx);
      const replan = (approval.payload as { replan?: ArcPlanResult } | null)?.replan;
      if (replan) {
        // re-plan of a running plot: approve = apply the stored proposal, reject = keep the current plan
        if (arc.status === "active" && ctx.decision === "approved") await applyArcPlan(tx, scope, arc, replan, actor);
        await unblock(tx, scope, approval.id);
        tx.afterCommit(() => platform.workSignal.notify("wake", scope.novelId));
        return;
      }
      if (arc.status !== "plan_awaiting_approval") return;
      if (ctx.decision === "approved") {
        const gaps = await cast().completeness(scope, { scope: "arc", arcId: arc.id }, tx);
        if (!gaps.complete) throw new DomainValidationError("plot_cast_incomplete", gaps.message, { items: gaps.items });
        await novel.transitionArc(tx, scope, arc.id, "active", actor, { planApprovalId: approval.id }); // AR2
        await cast().confirmPlotCharacters(tx, scope, arc.id, actor);
      } else {
        await novel.transitionArc(tx, scope, arc.id, "planned", actor, { reason: ctx.decisionNote ?? undefined }); // AR3
        await ports.createTask(tx, scope, { kind: "plan_arc", targetType: "arc", targetId: arc.id, arcId: arc.id, input: { arc_id: arc.id, rejection_note: ctx.decisionNote ?? null }, createdBy: actor, priority: 400 });
      }
      // SC2/SC3: the arc's planned setups follow the plan decision (foreshadow hook)
      for (const hook of ports.reg.arcPlanHooks) await hook({ tx, scope, arcId: arc.id, decision: ctx.decision, actor, approvalId: approval.id });
      await unblock(tx, scope, approval.id);
      tx.afterCommit(() => platform.workSignal.notify("wake", scope.novelId));
    },
    async episode(ctx) {
      const { tx, scope, approval, actor } = ctx;
      const ep = await m.mustEpisode(tx, scope, approval.subjectId, true);
      if (ep.status !== "awaiting_approval") return;
      if (ctx.decision === "approved") await m.approveInTx(tx, scope, ep.id, actor, approval.id); // E9(a)
      else await getService().rejectEpisode(tx, scope, ep.id, { decisionNote: ctx.decisionNote ?? "", reworkFrom: ctx.reworkFrom ?? "draft", approvalId: approval.id }, actor); // E10
      await unblock(tx, scope, approval.id);
      tx.afterCommit(() => platform.workSignal.notify("wake", scope.novelId));
    },
    async arc(ctx) {
      // arc_approval (MVP-β): E9(b) for every waiting episode; rejection applies to all (per-episode choice is web-only, 05 §10.3)
      const { tx, scope, approval, actor } = ctx;
      const arc = await novel.getArc(scope, approval.subjectId, tx);
      // 설계 추가 0014: a batch names its episodes (partial batch of a running plot); older rows: every waiting episode
      const named = (approval.payload as { episodeIds?: unknown } | null)?.episodeIds;
      const only = Array.isArray(named) ? new Set(named.filter((x): x is string => typeof x === "string")) : null;
      const eps = (await repo.listEpisodes(tx.db, scope, { arcId: arc.id })).filter((e) => e.status === "awaiting_approval" && (!only || only.has(e.id)));
      if (ctx.decision === "approved") {
        // 설계 추가: an under-floor episode is never approved in bulk — it keeps its own "분량 미달" approval request
        const basis = (await m.lengthProfile(scope, tx)).countBasis;
        const short = new Set<string>();
        for (const e of eps) {
          const v = e.currentVersionId ? await repo.getVersion(tx.db, scope, e.currentVersionId) : null;
          if (v && belowFloorByCounts(v, basis)) short.add(e.id);
        }
        for (const e of eps) if (!short.has(e.id)) await m.approveInTx(tx, scope, e.id, actor, approval.id);
        const fresh = await novel.getArc(scope, arc.id, tx);
        if (fresh.status === "awaiting_approval") {
          // AR7 only when every episode of the plot is approved/published: an under-floor episode left out of the batch
          // (not named in episodeIds) still waits for its own approval → AR6
          const after = await repo.listEpisodes(tx.db, scope, { arcId: arc.id });
          const open = after.filter((e) => e.status !== "approved" && e.status !== "published");
          if (short.size || open.length) await novel.transitionArc(tx, scope, arc.id, "active", actor, { reason: "분량 미달 화는 따로 승인합니다" }); // AR6
          else await novel.transitionArc(tx, scope, arc.id, "completed", actor, { arcApprovalId: approval.id }); // AR7
        }
      } else {
        if (arc.status === "awaiting_approval") await novel.transitionArc(tx, scope, arc.id, "active", actor, { reason: ctx.decisionNote ?? undefined }); // AR6
        for (const e of eps) {
          await getService().rejectEpisode(tx, scope, e.id, { decisionNote: ctx.decisionNote ?? "", reworkFrom: ctx.reworkFrom ?? "draft", approvalId: approval.id }, actor);
        }
      }
      await unblock(tx, scope, approval.id);
    },
  };

  /** 설계 추가 0014: full_auto limits read from the novel row (settings / state written by the autopilot) */
  const autopilotLimits = async (scope: NovelScope, n: Awaited<ReturnType<typeof novel.getNovel>>) => {
    const s = parseAutopilotSettings(n.autopilotSettings);
    const state = (n.autopilotState ?? {}) as { throttle?: { until?: string; reason?: string } | null };
    const at = platform.clock.date();
    const throttled = state.throttle?.until && new Date(state.throttle.until).getTime() > at.getTime() ? (state.throttle.reason ?? "throttled") : null;
    const stop = n.autopilotHaltedAt ? "halted" : throttled;
    const since = startOfLocalDay(at, n.timezone);
    const outlines = await orchestration.listTasks(scope, { kinds: ["outline_episode"], includeCancelled: true, limit: 1000 });
    // first outlines the scheduler started today (cycle key = episode id; reworks have their own keys)
    const startedToday = new Set(
      outlines.filter((t) => t.createdAt.getTime() >= since.getTime() && (t.input as { cycle_key?: string } | null)?.cycle_key === t.targetId).map((t) => t.targetId),
    ).size;
    return { stop, startedToday, maxPerDay: s.maxEpisodesPerDay };
  };

  /**
   * arc_approval: one `arc` approval per plot batch. (a) every episode of the plot is done or waiting → final batch
   * (AR5, the plot waits); (b) the reserve is full and nothing of the plot is in flight → partial batch of the waiting
   * episodes (the plot stays active) — without (b) a plot longer than the reserve target never got a request.
   * Under-floor episodes never join a batch (they keep their own approval).
   */
  const requestArcBatches = async (scope: NovelScope, arcs: Arc[], result: ScheduleResult) => {
    const reserve = await getService().reserveSummary(scope);
    const pendingAll = await soft(() => ports.deps.hitl.listApprovals(scope, { statuses: ["pending"], types: ["arc", "episode"] }), []);
    const pending = pendingAll.filter((p) => p.approvalType === "arc");
    // episodes that already have their own request (under-floor, or requested before the level became arc_approval)
    const ownRequest = new Set(pendingAll.filter((p) => p.approvalType === "episode").map((p) => p.subjectId));
    for (const arc of arcs.filter((a) => a.status === "active")) {
      if (pending.some((p) => p.subjectId === arc.id)) continue;
      const eps = await repo.listEpisodes(platform.uow.db, scope, { arcId: arc.id });
      const waiting = eps.filter((e) => e.status === "awaiting_approval");
      if (!waiting.length) continue;
      const flagged = await getService().withLengthFlags(scope, waiting);
      const short = flagged.filter((e) => e.lengthBelowFloor);
      const batch = flagged.filter((e) => !e.lengthBelowFloor && !ownRequest.has(e.id));
      if (!batch.length) continue; // only under-floor episodes: each keeps its own approval request
      const final = eps.every((e) => ["awaiting_approval", "approved", "published"].includes(e.status));
      const partial = !final && reserve.includingAwaiting >= reserve.target && !eps.some((e) => IN_FLIGHT_STATUSES.includes(e.status));
      if (!final && !partial) continue;
      await platform.uow.run(async (tx) => {
        const fresh = await novel.getArc(scope, arc.id, tx);
        if (fresh.status !== "active") return;
        const nos = batch.map((e) => `${e.episodeNo}화`).join(", ");
        const req = await ports.requestApproval(tx, scope, {
          approvalType: "arc",
          target: { type: "arc", id: arc.id },
          question: {
            title: `「${arc.title}」 플롯 승인 요청${final ? "" : ` (${nos})`}`,
            body: [
              final ? `${arc.title}의 남은 화(${nos})가 모두 승인 대기입니다.` : `비축분이 찼습니다. ${arc.title}에서 승인 대기 중인 ${nos}을(를) 묶어 승인합니다. 플롯의 나머지 화는 이어서 씁니다.`,
              short.length ? `\n⚠ 분량 미달(${EPISODE_HARD_MIN_CHARS.toLocaleString("ko-KR")}자 미만): ${short.map((e) => `${e.episodeNo}화`).join(", ")} — 묶음에서 빠지며 화마다 따로 승인해야 합니다.` : "",
            ].join(""),
            links: [{ type: "arc", id: arc.id }, ...batch.map((e) => ({ type: "episode" as const, id: e.id }))],
          },
          requestedBy: scheduler,
          payload: { episodeIds: batch.map((e) => e.id), episodeNos: batch.map((e) => e.episodeNo), partial: !final },
        });
        if (final) await novel.transitionArc(tx, scope, arc.id, "awaiting_approval", scheduler, req.approvalId ? { arcApprovalId: req.approvalId } : {}); // AR5
      });
      result.notes.push(`arc_batch:${arc.ord}:${final ? "final" : "partial"}:${batch.length}`);
    }
  };

  /**
   * 설계 추가 0014: leaving arc_approval. Episodes that waited for a plot batch (no approval row of their own) get their
   * per-episode request; a pending batch is cancelled first (its plot goes back to `active`, AR6) — otherwise they
   * would wait forever (no batch at this level, nothing for the autopilot to decide) and fill the reserve.
   */
  const requestMissingEpisodeApprovals = async (scope: NovelScope, arcs: Arc[], result: ScheduleResult) => {
    const waiting = await repo.listEpisodes(platform.uow.db, scope, { statuses: ["awaiting_approval"] });
    if (!waiting.length) return;
    const pending = await soft(() => ports.deps.hitl.listApprovals(scope, { statuses: ["pending"], types: ["episode", "arc"] }), null);
    if (!pending) return;
    const own = new Set(pending.filter((p) => p.approvalType === "episode").map((p) => p.subjectId));
    const orphans = waiting.filter((e) => !own.has(e.id));
    if (!orphans.length) return;
    const flagged = await getService().withLengthFlags(scope, orphans);
    await platform.uow.run(async (tx) => {
      const n = await novel.getNovel(scope, tx);
      if (n.autonomyLevel === "arc_approval") return;
      for (const b of pending.filter((p) => p.approvalType === "arc" && orphans.some((e) => e.arcId === p.subjectId))) {
        await ports.deps.hitl.cancelApproval(tx, scope, b.id, "자율성 수준이 바뀌어 화별 승인으로 다시 요청합니다.", scheduler);
        const arc = await novel.getArc(scope, b.subjectId, tx);
        if (arc.status === "awaiting_approval") await novel.transitionArc(tx, scope, arc.id, "active", scheduler, { reason: "자율성 수준 변경: 화별 승인으로 전환" }); // AR6
      }
      for (const e of flagged) {
        const fresh = await m.mustEpisode(tx, scope, e.id, true);
        if (fresh.status !== "awaiting_approval") continue;
        await m.requestEpisodeApproval(tx, scope, fresh, scheduler, { lengthWarning: e.lengthBelowFloor ? "분량 미달(최소 3,000자)" : null, belowFloor: !!e.lengthBelowFloor });
      }
    });
    result.notes.push(`episode_approvals_requested:${orphans.length}`);
    void arcs;
  };

  // ── deterministic scheduler (04 §3.4, system:scheduler) ──
  const schedule = async (scope: NovelScope): Promise<ScheduleResult> => {
    const result: ScheduleResult = { createdTasks: [], reserve: { includingAwaiting: 0, approvedOnly: 0, target: cfg.reserveTarget }, inFlight: 0, notes: [] };
    const n = await novel.getNovel(scope);
    if (!["planning", "serializing"].includes(n.status)) {
      result.notes.push(`novel_status:${n.status}`);
      return result;
    }
    // P3f sweep: re-evaluate every episode waiting in `checking`
    for (const e of await repo.listEpisodes(platform.uow.db, scope, { statuses: ["checking"] })) {
      const r = await m.runGate(scope, e.id).catch((err) => {
        platform.log.warn({ err, episodeId: e.id }, "gate sweep failed");
        return null;
      });
      if (r && r.kind !== "wait" && r.kind !== "not_checking") result.notes.push(`gate:${e.episodeNo}:${r.kind}`);
    }
    if (n.pausedAt) {
      result.notes.push("novel_paused");
      return result;
    }
    const goal = await novel.getGoal(scope);
    const bible = await novel.getApprovedBible(scope);
    if (!goal || !bible) {
      result.notes.push(!goal ? "no_goal" : "no_approved_bible");
      return result;
    }
    const arcs = (await novel.listArcs(scope)).filter((a) => a.status !== "cancelled");
    const active = await orchestration.listTasks(scope, { statuses: ["pending", "ready", "running", "blocked"], limit: 1000 });
    const hasActive = (kind: string, targetId: string) => active.some((t) => t.kind === kind && t.targetId === targetId);

    // arc plans whose planning finished → AR1
    for (const arc of arcs.filter((a) => a.status === "planned")) {
      const eps = await repo.listEpisodes(platform.uow.db, scope, { arcId: arc.id });
      if (!eps.length || hasActive("plan_arc", arc.id) || hasActive("plan_setups", arc.id)) continue;
      if (ports.isRegistered("plan_setups")) {
        const setups = await orchestration.listTasks(scope, { kinds: ["plan_setups"], targetId: arc.id, limit: 10 });
        if (!setups.some((t) => t.status === "done")) continue;
      }
      const r = await platform.uow.run((tx) => requestArcPlanApproval(tx, scope, arc.id, scheduler));
      result.notes.push(`arc_plan_approval:${arc.ord}:${r.approvalId ?? "none"}`);
    }
    // outline_episode for the next planned episodes (reserve + in-flight < target, in-flight < cap)
    const all = await repo.listEpisodes(platform.uow.db, scope);
    const reserve = await getService().reserveSummary(scope);
    result.reserve = reserve;
    let inFlight = all.filter((e) => IN_FLIGHT_STATUSES.includes(e.status)).length;
    const st = await novel.getStructure(scope);
    // plots with a structure change flag get no new outline (the user re-plans or keeps the plot first); an edited
    // structure waiting for re-approval stops new outlines too (the writing context would carry the unapproved ending)
    const structureOk = !st || st.status === "approved";
    const startable = (arc: Arc | undefined) =>
      structureOk &&
      !!arc &&
      !arc.pausedAt &&
      !(arc.planFlags ?? []).length &&
      arc.status === "active";
    const arcById = new Map(arcs.map((a) => [a.id, a]));
    // 설계 추가 0014 (full_auto): kill switch / daily budget throttle stop new episodes; at most N new episodes a day
    const auto = n.autonomyLevel === "full_auto" ? await autopilotLimits(scope, n) : null;
    if (auto?.stop) result.notes.push(`autopilot:${auto.stop}`);
    let startedToday = auto?.startedToday ?? 0;
    for (const ep of all.filter((e) => e.status === "planned")) {
      if (inFlight >= cfg.maxEpisodesInFlight || reserve.includingAwaiting + inFlight >= reserve.target) break;
      if (auto?.stop) break;
      if (auto && startedToday >= auto.maxPerDay) {
        result.notes.push("autopilot:daily_episode_cap");
        break;
      }
      if (!startable(arcById.get(ep.arcId)) || ep.pausedAt || hasActive("outline_episode", ep.id)) continue;
      const prev = all.find((e) => e.episodeNo === ep.episodeNo - 1);
      if (prev && ["planned", "outlining", "drafting"].includes(prev.status)) break; // ED-1 (N-1 must have reached checking)
      if (prev && prev.status === "checking" && ports.isRegistered("link_mentions")) {
        const links = await orchestration.listTasks(scope, { kinds: ["link_mentions"], episodeId: prev.id, limit: 20 });
        if (!links.some((t) => t.status === "done" && (t.input as { manuscript_version_id?: string })?.manuscript_version_id === prev.currentVersionId)) break;
      }
      const taskId = await platform.uow.run((tx) =>
        ports.createTask(tx, scope, {
          kind: "outline_episode",
          targetType: "episode",
          targetId: ep.id,
          episodeId: ep.id,
          arcId: ep.arcId,
          input: { episode_id: ep.id, cycle_key: ep.id },
          createdBy: scheduler,
          cycleKey: ep.id,
          priority: 500 + 50 * Math.max(0, reserve.target - reserve.includingAwaiting),
        }),
      );
      if (taskId) result.createdTasks.push({ kind: "outline_episode", taskId, targetId: ep.id });
      inFlight++;
      startedToday++;
    }
    result.inFlight = inFlight;

    // arc_approval (설계 추가 0014): plot batch approvals, evaluated after the reserve count above
    if (n.autonomyLevel === "arc_approval") await requestArcBatches(scope, arcs, result);
    else await requestMissingEpisodeApprovals(scope, arcs, result);

    // next arc via schedule_episodes when the planned queue runs short (04 §3.4 step 4)
    const epsOf = (arcId: string) => all.filter((e) => e.arcId === arcId).length;
    const planning = st
      ? st.status !== "approved" || arcs.some((a) => a.status === "plan_awaiting_approval" || (a.status === "planned" && (epsOf(a.id) > 0 || hasActive("plan_arc", a.id))))
      : !arcs.length || arcs.some((a) => a.status === "planned" || a.status === "plan_awaiting_approval"); // no structure and no arcs: waits for plan_structure
    const remaining = all.filter((e) => e.status === "planned" && startable(arcById.get(e.arcId))).length;
    const maxPlanned = arcs.reduce((x, a) => Math.max(x, a.plannedEpisodeTo), 0);
    const goalOpen = st ? arcs.some((a) => a.status === "planned" && epsOf(a.id) === 0) : !goal.totalEpisodesMax || maxPlanned < goal.totalEpisodesMax;
    if (!planning && goalOpen && remaining < reserve.target && !hasActive("schedule_episodes", goal.id) && !auto?.stop) {
      const taskId = await platform.uow.run((tx) =>
        ports.createTask(tx, scope, { kind: "schedule_episodes", targetType: "goal", targetId: goal.id, input: { goal_id: goal.id, reason: "reserve_low" }, createdBy: scheduler, priority: 400 }),
      );
      if (taskId) result.createdTasks.push({ kind: "schedule_episodes", taskId, targetId: goal.id });
    }
    return result;
  };

  // ── N3 hook (11 M-09) ──
  const onGoalSaved: PlanningApi["onGoalSaved"] = async ({ tx, scope, enteredPlanning, actor, novel: n }) => {
    if (!enteredPlanning) return;
    if (!n.approvedConceptBriefId) {
      platform.log.warn({ novelId: scope.novelId }, "N3 without approved concept brief: plan_series_bible not created");
      return;
    }
    await ports.createTask(tx, scope, {
      kind: "plan_series_bible",
      targetType: "novel",
      targetId: scope.novelId,
      input: { concept_brief_id: n.approvedConceptBriefId, source_message_ids: [] },
      createdBy: actor,
      priority: 400,
    });
  };

  return {
    handlers: [planSeriesBible, scheduleEpisodes, planArc],
    requestArcPlanApproval,
    approvalHandlers,
    schedule,
    onGoalSaved,
  };
}
