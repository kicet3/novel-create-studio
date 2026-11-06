/**
 * Planning pipeline (07 §1.3 B1/B3, 04 §3.4): plan_series_bible, schedule_episodes, plan_arc, the
 * approval handlers series_bible / arc_plan / arc / episode (05 §10) and the deterministic scheduler.
 */
import { actors, type ActorRef, type NovelScope, type Tx } from "../../../platform/index.js";
import type { ApprovalDecisionContext } from "../../hitl/index.js";
import type { Arc } from "../../novel/index.js";
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
import type { ScheduleResult } from "../index.js";
import { promptOf, type PipelineHandler } from "./agent-task.js";
import type { ManuscriptInternals } from "./manuscript-service.js";
import { settings, soft } from "./support.js";

const BIBLE_INSTRUCTION = `당신은 웹소설 기획자(planner)입니다. 승인된 컨셉과 목표를 바탕으로 연재 기획서를 JSON으로 작성합니다.
- logline은 컨셉의 로그라인을 그대로 씁니다.
- 인물·세계 규칙마다 source_field_path(컨셉 필드 경로, 새 항목은 null)를 붙입니다.
- 인물·장소는 이름 문자열로 사실을 만들지 않습니다(초기 온톨로지 단계 입력).
- arc_outline은 아크별 제목·화수·요약입니다. 연령 등급을 넘는 내용은 넣지 않습니다.
- 컨텍스트에 확정된 캐릭터 설정이 있으면 characters는 그 이름·역할을 그대로 쓰고 바꾸지 않습니다.`;

const ARC_INSTRUCTION = `당신은 웹소설 기획자(planner)입니다. 기획서와 이전 아크 결과를 바탕으로 이번 아크의 목표·갈등·종료 조건과 화별 개요를 JSON으로 씁니다.
화 번호는 주어진 범위 안에서만 씁니다.`;

export interface PlanningApi {
  handlers: Array<PipelineHandler<any, any>>;
  requestArcPlanApproval(tx: Tx, scope: NovelScope, arcId: string, actor: ActorRef): Promise<{ approvalId: string | null }>;
  approvalHandlers: Record<"series_bible" | "arc_plan" | "arc" | "episode", (ctx: ApprovalDecisionContext) => Promise<void>>;
  schedule(scope: NovelScope): Promise<ScheduleResult>;
  onGoalSaved(ctx: { tx: Tx; scope: NovelScope; enteredPlanning: boolean; actor: ActorRef; novel: { approvedConceptBriefId: string | null } }): Promise<void>;
}

export function createPlanning(m: ManuscriptInternals, getService: () => import("../index.js").ManuscriptService): PlanningApi {
  const { ports } = m;
  const { novel, orchestration, ontology, platform } = ports.deps;
  const scheduler = actors.system("scheduler");
  const cfg = settings();

  // ── B1 plan_series_bible ──
  const planSeriesBible: PipelineHandler<import("../domain/schemas.js").PlanSeriesBibleInput, { bible: BibleProposal; supersede: string[]; modelId: string }> = {
    kind: "plan_series_bible",
    role: "planner",
    promptTemplateVersion: "planner.plan_series_bible@0.1.0",
    inputSchema: planSeriesBibleInputSchema,
    allowedWrites: ["novel.createBibleVersion", "hitl.requestApproval"],
    // 설계 추가: the confirmed cast (module cast, context section "cast") is an input of the series bible
    context: async () => ({ anchor: { storyPoint: 0, timelineId: "" }, sections: ["cast"] }),
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
      });
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
      return { bible, supersede: bibles.filter((b) => b.status === "draft" || b.status === "awaiting_approval").map((b) => b.id), modelId: out.modelId };
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
        { logline: p.bible.logline, synopsis: p.bible.synopsis, content: { ...p.bible, model_id: p.modelId }, contentMd: bibleMarkdown(p.bible), conceptBriefId: input.concept_brief_id },
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
  const scheduleEpisodes: PipelineHandler<import("../domain/schemas.js").ScheduleEpisodesInput, { arc: { ord: number; title: string; from: number; to: number; summary: string } | null }> = {
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
  const planArc: PipelineHandler<import("../domain/schemas.js").PlanArcInput, { plan: ArcPlanProposal; modelId: string }> = {
    kind: "plan_arc",
    role: "planner",
    promptTemplateVersion: "planner.plan_arc@0.1.0",
    inputSchema: planArcInputSchema,
    allowedWrites: ["novel.updateArc", "manuscript.createPlannedEpisodes", "orchestration.createTask", "hitl.requestApproval"],
    context: async () => null,
    async execute(run, input, context, llm) {
      const scope = { novelId: run.novelId };
      const arc = await novel.getArc(scope, input.arc_id);
      const bible = await novel.getApprovedBible(scope);
      const outline = ((bible?.content as { arc_outline?: Array<{ title: string; summary?: string }> })?.arc_outline ?? [])[arc.ord - 1];
      const previous = (await novel.listArcs(scope)).filter((a) => a.ord < arc.ord && a.status !== "cancelled").map((a) => ({ title: a.title, goal: a.goalText, end: a.endCondition }));
      const data = JSON.stringify({ arc: { ord: arc.ord, title: arc.title, from: arc.plannedEpisodeFrom, to: arc.plannedEpisodeTo }, bible: bible ? { logline: bible.logline, synopsis: bible.synopsis, arcOutline: outline } : null, previous, rejectionNote: input.rejection_note ?? null });
      const out = await llm.call({
        run,
        purpose: "plan_arc",
        ...promptOf(context, ARC_INSTRUCTION, data),
        output: { kind: "object", schemaName: "ArcPlanProposal", schema: arcPlanProposalSchema },
      });
      const v = out.value as ArcPlanProposal;
      const synth = synthArcPlan(arc, outline ? { title: outline.title, summary: outline.summary ?? "" } : undefined);
      const byNo = new Map(v.episodes.filter((e) => e.episode_no >= arc.plannedEpisodeFrom && e.episode_no <= arc.plannedEpisodeTo).map((e) => [e.episode_no, e]));
      const plan: ArcPlanProposal = {
        title: v.title || synth.title,
        goal_text: v.goal_text || synth.goal_text,
        conflict_text: v.conflict_text || synth.conflict_text,
        end_condition: v.end_condition || synth.end_condition,
        episodes: synth.episodes.map((e) => ({ ...e, ...(byNo.get(e.episode_no) ?? {}) })), // INV-ARC-01: only the arc range
      };
      return { plan, modelId: out.modelId };
    },
    async commit(tx, run, input, p) {
      const scope = { novelId: run.novelId };
      const agent = actors.agent("planner", run.runId);
      const arc = await novel.getArc(scope, input.arc_id, tx);
      if (arc.status !== "planned") return { kind: "done", outputRefs: [] }; // already decided elsewhere
      await novel.updateArc(scope, arc.id, { title: p.plan.title, goalText: p.plan.goal_text, conflictText: p.plan.conflict_text, endCondition: p.plan.end_condition }, agent, tx);
      const eps = await getService().createPlannedEpisodes(
        tx,
        scope,
        arc.id,
        p.plan.episodes.map((e) => ({ episodeNo: e.episode_no, title: e.title, hookNote: e.hook_note })),
        agent,
      );
      if (ports.isRegistered("plan_setups")) {
        await ports.createTask(tx, scope, { kind: "plan_setups", targetType: "arc", targetId: arc.id, arcId: arc.id, input: { arc_id: arc.id }, createdBy: agent, priority: 400 });
      } else {
        await requestArcPlanApproval(tx, scope, arc.id, agent);
      }
      return { kind: "done", outputRefs: [{ refType: "arc", refId: arc.id }, ...eps.map((e) => ({ refType: "episode" as const, refId: e.id }))] };
    },
  };

  // ── AR1 / AR4 ──
  const requestArcPlanApproval = async (tx: Tx, scope: NovelScope, arcId: string, actor: ActorRef) => {
    const arc = await novel.getArc(scope, arcId, tx);
    if (arc.status !== "planned") return { approvalId: arc.planApprovalId ?? null };
    const n = await novel.getNovel(scope, tx);
    if (n.autonomyLevel === "full_auto") {
      await novel.transitionArc(tx, scope, arcId, "active", actor, { reason: "full_auto: 계획 승인 없이 시작" }); // AR4
      return { approvalId: null };
    }
    const eps = await repo.listEpisodes(tx.db, scope, { arcId });
    const req = await ports.requestApproval(tx, scope, {
      approvalType: "arc_plan",
      target: { type: "arc", id: arcId },
      question: {
        title: `${arc.ord}번째 아크 계획 승인 요청`,
        body: `${arc.title} (${arc.plannedEpisodeFrom}~${arc.plannedEpisodeTo}화)\n목표: ${arc.goalText}\n갈등: ${arc.conflictText}\n종료 조건: ${arc.endCondition}\n\n${eps
          .slice(0, 20)
          .map((e) => `- ${e.episodeNo}화${e.title ? ` ${e.title}` : ""}${e.hookNote ? `: ${e.hookNote}` : ""}`)
          .join("\n")}`,
        links: [{ type: "arc", id: arcId }],
      },
      requestedBy: actor,
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
        if (goal) await ports.createTask(tx, scope, { kind: "schedule_episodes", targetType: "goal", targetId: goal.id, input: { goal_id: goal.id, reason: "bible_approved" }, createdBy: actor, priority: 400 });
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
      if (arc.status !== "plan_awaiting_approval") return;
      if (ctx.decision === "approved") {
        await novel.transitionArc(tx, scope, arc.id, "active", actor, { planApprovalId: approval.id }); // AR2
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
      const eps = (await repo.listEpisodes(tx.db, scope, { arcId: arc.id })).filter((e) => e.status === "awaiting_approval");
      if (ctx.decision === "approved") {
        for (const e of eps) await m.approveInTx(tx, scope, e.id, actor, approval.id);
        const fresh = await novel.getArc(scope, arc.id, tx);
        if (fresh.status === "awaiting_approval") await novel.transitionArc(tx, scope, arc.id, "completed", actor, { arcApprovalId: approval.id }); // AR7
      } else {
        if (arc.status === "awaiting_approval") await novel.transitionArc(tx, scope, arc.id, "active", actor, { reason: ctx.decisionNote ?? undefined }); // AR6
        for (const e of eps) {
          await getService().rejectEpisode(tx, scope, e.id, { decisionNote: ctx.decisionNote ?? "", reworkFrom: ctx.reworkFrom ?? "draft", approvalId: approval.id }, actor);
        }
      }
      await unblock(tx, scope, approval.id);
    },
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
    // arc_approval autonomy: AR5 when every episode of the arc waits
    if (n.autonomyLevel === "arc_approval") {
      for (const arc of arcs.filter((a) => a.status === "active")) {
        const eps = await repo.listEpisodes(platform.uow.db, scope, { arcId: arc.id });
        if (!eps.length || !eps.every((e) => e.status === "awaiting_approval")) continue;
        await platform.uow.run(async (tx) => {
          const req = await ports.requestApproval(tx, scope, {
            approvalType: "arc",
            target: { type: "arc", id: arc.id },
            question: { title: `${arc.ord}번째 아크 승인 요청`, body: `${arc.title}의 ${eps.length}개 화가 모두 승인 대기입니다.`, links: [{ type: "arc", id: arc.id }] },
            requestedBy: scheduler,
          });
          await novel.transitionArc(tx, scope, arc.id, "awaiting_approval", scheduler, req.approvalId ? { arcApprovalId: req.approvalId } : {});
        });
      }
    }

    // outline_episode for the next planned episodes (reserve + in-flight < target, in-flight < cap)
    const all = await repo.listEpisodes(platform.uow.db, scope);
    const reserve = await getService().reserveSummary(scope);
    result.reserve = reserve;
    let inFlight = all.filter((e) => IN_FLIGHT_STATUSES.includes(e.status)).length;
    const startable = (arc: Arc | undefined) => !!arc && !arc.pausedAt && (arc.status === "active" || (n.autonomyLevel === "full_auto" && arc.status === "planned"));
    const arcById = new Map(arcs.map((a) => [a.id, a]));
    for (const ep of all.filter((e) => e.status === "planned")) {
      if (inFlight >= cfg.maxEpisodesInFlight || reserve.includingAwaiting + inFlight >= reserve.target) break;
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
    }
    result.inFlight = inFlight;

    // next arc via schedule_episodes when the planned queue runs short (04 §3.4 step 4)
    const planning = arcs.some((a) => a.status === "planned" || a.status === "plan_awaiting_approval");
    const remaining = all.filter((e) => e.status === "planned" && startable(arcById.get(e.arcId))).length;
    const maxPlanned = arcs.reduce((x, a) => Math.max(x, a.plannedEpisodeTo), 0);
    const goalOpen = !goal.totalEpisodesMax || maxPlanned < goal.totalEpisodesMax;
    if (!planning && goalOpen && remaining < reserve.target && !hasActive("schedule_episodes", goal.id)) {
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
