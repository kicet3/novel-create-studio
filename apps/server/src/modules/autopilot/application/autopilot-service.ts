/**
 * Autopilot application service (설계 추가 0014). See ../index.ts for the loop order and ../README.md for the rules.
 * Reads go through other modules' public services OUTSIDE transactions (PGlite has one connection); every write is a
 * public call that opens its own transaction (hitl auto decisions re-check eligibility under the novel row lock).
 */
import {
  labelKo,
  nextLocalMidnight,
  parseAutopilotSettings,
  startOfLocalDay,
  wallParts,
  type AutopilotSettings,
  type AutopilotView,
  type AutopilotWaiting,
  type ActivityDto,
} from "@ncs/shared";
import { actors, objectParticle, type ActorRef, type NovelScope, type Platform } from "../../../platform/index.js";
import type { AuditService } from "../../audit/index.js";
import type { BudgetService } from "../../budget/index.js";
import type { CastService } from "../../cast/index.js";
import type { ConceptService } from "../../concept/index.js";
import type { ContinuityService } from "../../continuity/index.js";
import type { Approval, HitlService, Question } from "../../hitl/index.js";
import type { ManuscriptService } from "../../manuscript/index.js";
import type { MessagingService } from "../../messaging/index.js";
import { structureCompleteness, type Novel, type NovelService } from "../../novel/index.js";
import type { OrchestrationService } from "../../orchestration/index.js";
import type { WorldService } from "../../world/index.js";
import type { AutopilotService, AutopilotTickResult } from "../index.js";
import { evaluateApproval, holdsForAuto, isAutoApprovalType, MAX_FILL_ATTEMPTS, questionAutoAnswerable, settingFor, type ApprovalFacts } from "../domain/policy.js";
import { planSteps, type StepFacts, type StepKind } from "../domain/steps.js";
import { nextPublishSlots } from "../domain/publish-slots.js";

export interface AutopilotDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  budget: BudgetService;
  orchestration: OrchestrationService;
  messaging: MessagingService;
  hitl: HitlService;
  manuscript: ManuscriptService;
  continuity: ContinuityService;
  concept: ConceptService;
  world: WorldService;
  cast: CastService;
}

/** autopilot_state (jsonb on novels) */
interface AutopilotState {
  phase?: AutopilotView["phase"];
  next?: string | null;
  waiting?: AutopilotWaiting[];
  scheduled?: AutopilotView["scheduled"];
  throttle?: { until: string; reason: "daily_budget" | "daily_episodes" } | null;
  lastTickAt?: string;
  /** step → { attempts, lastAt } */
  steps?: Partial<Record<StepKind, { attempts: number; lastAt: string }>>;
  /** world generation task whose candidates were accepted */
  worldApprovedTask?: string | null;
  /** arcId → fill attempts for plot characters */
  plotFills?: Record<string, { attempts: number; lastAt: string }>;
  /** gate keys already notified (inbox + messenger) */
  notified?: string[];
  completedAt?: string | null;
  throttledDay?: string | null;
  /** approvalId → transient auto-decision failures (held after MAX_TRANSIENT_FAILS) */
  autoFails?: Record<string, number>;
  /** month (YYYY-MM, novel timezone) whose budget warning the author already resumed past */
  budgetWarningAck?: string | null;
}

const SYS = actors.system("autopilot");
/** cast placeholder name (module cast domain PLACEHOLDER_NAME) */
const PLACEHOLDER_CHARACTER_NAME = "이름 미정";
/** plotFills key of the main-cast fill before an auto structure approval */
const STRUCTURE_FILL_KEY = "__structure__";
const ACTIVE_TASK = ["pending", "ready", "running", "blocked"] as const;
const MAX_NOTIFIED = 1000;
const MAX_TRANSIENT_FAILS = 3;
/** a `wait` verdict older than this is shown to the author (banner + one inbox / messenger notice) */
const WAIT_NOTICE_MINUTES = 60;
const monthKey = (at: Date, tz: string) => {
  const p = wallParts(at, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
};

export function createAutopilotService(deps: AutopilotDeps): { service: AutopilotService; decider: Parameters<HitlService["registerAutoDecider"]>[0] } {
  const { platform, audit, novel, budget, orchestration, messaging, hitl, manuscript, continuity, concept, world, cast } = deps;
  const { uow, clock, log } = platform;
  const now = () => clock.date();

  const stateOf = (n: Novel): AutopilotState => ((n.autopilotState ?? {}) as AutopilotState) ?? {};
  const isActive = (n: Novel) => n.autonomyLevel === "full_auto" && !n.autopilotHaltedAt;
  const delegatedBy = async (n: Novel) => n.autopilotEnabledByUserId ?? (await novel.getOwnerUser())?.id ?? null;
  const throttled = (st: AutopilotState, at: Date) => (st.throttle && new Date(st.throttle.until).getTime() > at.getTime() ? st.throttle : null);
  /** re-read the row before a write the tick decided on earlier (kill switch / level change / pause in the meantime) */
  const stillOn = async (scope: NovelScope, opts: { publishing?: boolean } = {}) => {
    const x = await novel.getNovel(scope).catch(() => null);
    if (!x || x.autonomyLevel !== "full_auto" || x.autopilotHaltedAt || x.pausedAt) return false;
    return opts.publishing ? true : !throttled(stateOf(x), now());
  };

  const record = (scope: NovelScope, input: Omit<Parameters<AuditService["record"]>[1], "novelId" | "actor"> & { actor?: ActorRef }) =>
    uow.run((tx) => audit.record(tx, { novelId: scope.novelId, actor: input.actor ?? SYS, ...input })).catch((err) => log.warn({ err }, "autopilot audit failed"));

  /** one notice per gate key: web inbox (informational question) + messenger alert */
  const notifyGate = async (scope: NovelScope, st: AutopilotState, key: string, text: string, link: { type: string; id: string }, details: Record<string, unknown> = {}) => {
    if ((st.notified ?? []).includes(key)) return;
    const body = `완전 자율: ${text} 이 갈래만 멈췄고 다른 작업은 계속합니다.`;
    await uow
      .run(async (tx) => {
        await hitl.createQuestion(
          tx,
          scope,
          { topic: "approval_gate", questionType: "single_choice", title: `완전 자율 — 사람 확인 필요`, body, options: [], links: [link as never], notice: true },
          { createdBy: SYS },
        );
        for (const c of (await messaging.preferredChannels(scope, tx)).filter((c) => c.kind !== "web" && c.status === "active")) {
          await messaging.sendNotice(tx, scope, { kind: "alert", channelId: c.id, text: body, idempotencyKey: `autopilot_gate:${key}:${c.id}` }).catch(() => null);
        }
        await audit.record(tx, { novelId: scope.novelId, actor: SYS, action: "autopilot.gate_hit", target: link as never, reason: text, details: { key, ...details } });
        // remembered in the same transaction: a later failure of the tick neither repeats nor loses the notice
        st.notified = [...(st.notified ?? []).filter((k) => k !== key), key].slice(-MAX_NOTIFIED);
        await novel.setAutopilotState(scope, { notified: st.notified }, tx);
      })
      .catch((err) => {
        st.notified = (st.notified ?? []).filter((k) => k !== key);
        log.warn({ err, key }, "autopilot gate notice failed");
      });
  };

  /** initial-cast characters the AI fill should handle: empty required fields, or still named "이름 미정" (cast blocker) */
  const castFillIds = (cs: Awaited<ReturnType<CastService["getCast"]>>) => {
    const ids = new Set(cs.completeness.items.filter((i) => i.missing.length).map((i) => i.characterId));
    for (const c of cs.items) if (!c.introducedArcId && c.name.trim() === PLACEHOLDER_CHARACTER_NAME) ids.add(c.id);
    return [...ids];
  };

  /** a live (not blocked) fill task for any of these characters — a blocked one does not count: the autopilot retries / hands over */
  const castFillRunning = async (scope: NovelScope, ids: Set<string>) => {
    if (!ids.size) return false;
    const tasks = await orchestration.listTasks(scope, { kinds: ["draft_cast"], statuses: ["pending", "ready", "running"], limit: 50 });
    return tasks.some((t) => {
      const ci = (t.input as { character_ids?: unknown } | null)?.character_ids;
      return !Array.isArray(ci) || ci.some((id) => ids.has(String(id)));
    });
  };

  // ── facts of a pending approval ──
  const approvalFacts = async (scope: NovelScope, a: Approval, st: AutopilotState, pendingAll: Approval[]): Promise<ApprovalFacts> => {
    switch (a.approvalType) {
      case "episode": {
        const ep = await manuscript.getEpisode(scope, a.subjectId);
        const [flag] = await manuscript.withLengthFlags(scope, [ep]);
        const open = await continuity.listIssues(scope, { episodeId: ep.id, statuses: ["open", "fixing"], limit: 500 });
        const safety = await continuity.listIssues(scope, { episodeId: ep.id, kinds: ["safety_age_rating", "safety_minor_sexual", "safety_real_person"], limit: 50 });
        const pendingCanon = pendingAll.filter(
          (p) => ["retcon", "canon_change", "identity_change"].includes(p.approvalType) && (p.subjectId === ep.id || (p.payload as { episodeId?: string } | null)?.episodeId === ep.id),
        ).length;
        return {
          type: "episode",
          episodeStatus: ep.status,
          episodeNo: ep.episodeNo,
          belowFloor: !!flag?.lengthBelowFloor || !!(a.payload as { lengthBelowFloor?: boolean } | null)?.lengthBelowFloor,
          openHigh: open.filter((i) => i.severity === "high").length,
          openMedium: open.filter((i) => i.severity === "medium").length,
          safetyEver: safety.length,
          rewriteLimit: ep.blockReasons.includes("rewrite_limit"),
          pendingCanon,
        };
      }
      case "arc_plan": {
        const arc = await novel.getArc(scope, a.subjectId);
        const st2 = await novel.getStructure(scope);
        const cs = await cast.getCast(scope);
        const mine = cs.items.filter((c) => c.introducedArcId === arc.id);
        const items = cs.plotCompleteness.items.filter((i) => i.introducedArcId === arc.id);
        const missingIds = new Set(items.filter((i) => i.missing.length).map((i) => i.characterId));
        return {
          type: "arc_plan",
          arcStatus: arc.status,
          arcTitle: arc.title,
          replan: !!(a.payload as { replan?: unknown } | null)?.replan,
          structureApproved: !st2 || st2.status === "approved",
          castMissing: items.filter((i) => i.missing.length).length,
          castUnaccepted: mine.filter((c) => c.proposed).length,
          fillAttempts: st.plotFills?.[arc.id]?.attempts ?? 0,
          fillRunning: await castFillRunning(scope, missingIds),
        };
      }
      case "series_bible": {
        const bibles = await novel.listBibles(scope);
        const b = bibles.find((x) => x.id === a.subjectId);
        const maxNo = bibles.reduce((m, x) => Math.max(m, x.versionNo), 0);
        return { type: "series_bible", bibleStatus: b?.status ?? "missing", latest: !!b && b.versionNo === maxNo };
      }
      case "story_structure": {
        const s = await novel.getStructure(scope);
        if (!s) return { type: "story_structure", status: "none", reasons: [], endingChanged: false, castComplete: false, revisionMatches: false, fillAttempts: 0, fillRunning: false };
        const goal = await novel.getGoal(scope);
        const cs = await cast.getCast(scope);
        const main = cs.items.filter((c) => (c.role === "protagonist" || c.role === "sub_protagonist") && !c.introducedArcId).map((c) => ({ id: c.id, name: c.name }));
        const reasons = structureCompleteness(s, { mainCharacters: main, totalMin: goal?.totalEpisodesMin ?? 1, totalMax: goal?.totalEpisodesMax ?? null });
        const shown = (a.payload as { revision?: unknown } | null)?.revision;
        return {
          type: "story_structure",
          status: s.status,
          reasons,
          endingChanged: !!(s.pendingChanges?.ending || s.pendingChanges?.goalEndingChanged),
          castComplete: cs.completeness.complete,
          revisionMatches: typeof shown !== "number" || shown === s.revision,
          fillAttempts: st.plotFills?.[STRUCTURE_FILL_KEY]?.attempts ?? 0,
          fillRunning: await castFillRunning(scope, new Set(cs.completeness.items.filter((i) => i.missing.length).map((i) => i.characterId))),
        };
      }
      case "concept_brief": {
        const brief = await concept.getBrief(scope, a.subjectId);
        const approved = await concept.getApprovedBrief(scope);
        const n = await novel.getNovel(scope);
        const checks = ((brief.content ?? {}) as { checks?: { safety?: Record<string, unknown[]>; similarity?: Record<string, unknown[]> } }).checks ?? {};
        const len = (o: Record<string, unknown[]> | undefined, keys: string[]) => keys.reduce((m, k) => m + (Array.isArray(o?.[k]) ? o![k]!.length : 0), 0);
        return {
          type: "concept_brief",
          briefStatus: brief.status,
          initial: !approved && n.status === "concept",
          safetyHits: len(checks.safety, ["real_person_hits", "age_rating_flags", "minor_flags"]),
          similarityHits: len(checks.similarity, ["blocklist_hits", "copy_requests", "llm_overlap_signals"]),
          // the LLM similarity / safety check really ran (an unparsable answer or no provider is "not checked", not "clean")
          llmChecked: (checks as { llm_checked?: unknown }).llm_checked === true,
        };
      }
      default:
        return { type: "other", approvalType: a.approvalType };
    }
  };

  // ── HITL auto decider (registered with hitl) ──
  const decider: Parameters<HitlService["registerAutoDecider"]>[0] = {
    async holds(tx, scope, approval) {
      const n = await novel.getNovel(scope, tx);
      if (!isActive(n)) return false;
      return holdsForAuto(approval.approvalType, approval.payload, parseAutopilotSettings(n.autopilotSettings));
    },
    async confirm(tx, scope, approval) {
      const n = await novel.lockNovel(tx, scope);
      if (n.autonomyLevel !== "full_auto") return { ok: false, reason: "완전 자율이 꺼져 있습니다." };
      if (n.autopilotHaltedAt) return { ok: false, reason: "자율 진행이 멈춰 있습니다." };
      const s = parseAutopilotSettings(n.autopilotSettings);
      if (!isAutoApprovalType(approval.approvalType) || !settingFor(approval.approvalType, s)) return { ok: false, reason: "자동 승인 대상이 아닙니다." };
      if (throttled(stateOf(n), now())) return { ok: false, reason: "하루 비용 상한으로 자동 진행을 멈췄습니다." };
      // inside the decision transaction: no read through uow.db (one PGlite connection) — the row carries the delegate
      const who = n.autopilotEnabledByUserId;
      return who ? { ok: true, delegatedByUserId: who } : { ok: false, reason: "위임한 사용자가 없습니다." };
    },
    async confirmAnswer(tx, scope) {
      const n = await novel.lockNovel(tx, scope);
      if (n.autonomyLevel !== "full_auto" || n.autopilotHaltedAt) return { ok: false, reason: "완전 자율이 꺼져 있거나 멈춰 있습니다." };
      if (!parseAutopilotSettings(n.autopilotSettings).autoAnswerQuestions) return { ok: false, reason: "질문 자동 응답이 꺼져 있습니다." };
      // inside the decision transaction: no read through uow.db (one PGlite connection) — the row carries the delegate
      const who = n.autopilotEnabledByUserId;
      return who ? { ok: true, delegatedByUserId: who } : { ok: false, reason: "위임한 사용자가 없습니다." };
    },
  };

  // ── front steps ──
  const stepFacts = async (scope: NovelScope, n: Novel, st: AutopilotState, at: Date): Promise<StepFacts> => {
    const since = (k: StepKind) => {
      const x = st.steps?.[k];
      return x ? (at.getTime() - new Date(x.lastAt).getTime()) / 60_000 : null;
    };
    const attempts = (k: StepKind) => st.steps?.[k]?.attempts ?? 0;
    const base: StepFacts = {
      novelStatus: n.status,
      concept: { approved: !!n.approvedConceptBriefId, awaiting: false, sessionActive: false, autoRunning: false, attempts: attempts("concept_submit") },
      world: { state: "none", taskId: null, pending: 0, approvedTaskId: st.worldApprovedTask ?? null },
      cast: { confirmed: false, pendingChanges: 0, blockers: [], missing: 0, draftRunning: false, fillAttempts: attempts("cast_fill") },
      goal: { saved: false, endingDirection: null },
      bible: "none",
      structure: { status: "none", taskActive: false, canGenerate: false, gateReasons: [], attempts: attempts("structure_request"), lastError: null },
      plots: { total: 0, active: 0, planned: 0, completed: 0 },
      episodes: { approvedOrPublished: 0, awaiting: 0, inFlight: 0, targetMin: null, nextTitle: null },
      sinceLastAttempt: { concept_submit: since("concept_submit"), world_approve: since("world_approve"), cast_fill: since("cast_fill"), cast_confirm: since("cast_confirm"), goal_save: since("goal_save"), structure_request: since("structure_request") },
    };
    if (n.status === "concept") {
      const v = await concept.getSessionView(scope).catch(() => null);
      const briefs = await concept.listBriefs(scope);
      base.concept.awaiting = briefs.some((b) => b.status === "awaiting_approval");
      base.concept.sessionActive = !!v && v.session.status === "active" && v.session.purpose === "initial";
      base.concept.autoRunning = !!v && v.autoApprove.enabled && v.autoApprove.status === "running";
      return base;
    }
    if (n.status === "onboarding") {
      const wv = await world.getView(scope);
      base.world = { state: wv.generation.state, taskId: wv.generation.taskId, pending: wv.counts.pending, approvedTaskId: st.worldApprovedTask ?? null };
      const cs = await cast.getCast(scope);
      base.cast = {
        confirmed: cs.confirmed,
        pendingChanges: cs.pendingChanges,
        blockers: cs.blockers,
        missing: castFillIds(cs).length,
        draftRunning: !!cs.draftTask && (ACTIVE_TASK as readonly string[]).includes(cs.draftTask.status),
        fillAttempts: attempts("cast_fill"),
      };
      const d = await concept.getGoalFormDefaults(scope);
      base.goal = { saved: false, endingDirection: d?.endingDirection ?? null };
      return base;
    }
    if (n.status !== "planning" && n.status !== "serializing") return base;
    const goal = await novel.getGoal(scope);
    base.goal = { saved: !!goal, endingDirection: goal?.endingDirection ?? null };
    const bibles = await novel.listBibles(scope);
    base.bible = bibles.some((b) => b.status === "approved") ? "approved" : bibles.some((b) => b.status === "awaiting_approval") ? "awaiting" : "none";
    if (base.bible !== "approved") return base;
    const sv = await manuscript.getStructureView(scope);
    base.structure = {
      status: sv.structure?.status ?? "none",
      taskActive: !!sv.task,
      canGenerate: sv.gate.canGenerate,
      gateReasons: sv.gate.reasons,
      attempts: attempts("structure_request"),
      lastError: sv.lastError,
    };
    const arcs = (await novel.listArcs(scope)).filter((a) => a.status !== "cancelled");
    base.plots = {
      total: arcs.length,
      active: arcs.filter((a) => a.status === "active" || a.status === "awaiting_approval").length,
      planned: arcs.filter((a) => a.status === "planned" || a.status === "plan_awaiting_approval").length,
      completed: arcs.filter((a) => a.status === "completed").length,
    };
    const eps = await manuscript.listEpisodes(scope);
    const next = eps.filter((e) => ["outlining", "drafting", "checking", "polishing", "revising", "planned"].includes(e.status)).sort((a, b) => a.episodeNo - b.episodeNo)[0];
    const stageKo: Record<string, string> = { planned: "아웃라인 대기", outlining: "아웃라인 작성", drafting: "초안 작성", checking: "검사", polishing: "다듬기", revising: "고쳐 쓰기" };
    base.episodes = {
      approvedOrPublished: eps.filter((e) => e.status === "approved" || e.status === "published").length,
      awaiting: eps.filter((e) => e.status === "awaiting_approval").length,
      inFlight: eps.filter((e) => ["outlining", "drafting", "checking", "polishing", "revising"].includes(e.status)).length,
      targetMin: goal?.totalEpisodesMin ?? null,
      nextTitle: next ? `${next.episodeNo}화 ${stageKo[next.status] ?? labelKo("episode_status", next.status)}` : null,
    };
    return base;
  };

  const runStep = async (scope: NovelScope, n: Novel, st: AutopilotState, k: StepKind, s: AutopilotSettings): Promise<string | null> => {
    const at = now();
    const prev = st.steps?.[k];
    st.steps = { ...(st.steps ?? {}), [k]: { attempts: (prev?.attempts ?? 0) + 1, lastAt: at.toISOString() } };
    const who = await delegatedBy(n);
    try {
      switch (k) {
        case "concept_submit": {
          if (!who) return null;
          const r = await concept.autoSubmitForApproval(scope, { actor: SYS, delegatedByUserId: who });
          await record(scope, { action: "autopilot.step", target: { type: "novel", id: scope.novelId }, after: { step: k, submitted: r.submitted }, reason: r.submitted ? "컨셉 확정·점검 시작" : r.reason });
          return r.submitted ? "concept_submit" : null;
        }
        case "world_approve": {
          const wv = await world.getView(scope);
          const r = await world.approveAll(scope, SYS);
          st.worldApprovedTask = wv.generation.taskId;
          await record(scope, { action: "autopilot.step", target: { type: "novel", id: scope.novelId }, after: { step: k, approved: r.approved, held: r.held.length }, reason: "세계관 후보 자동 승인(충돌 항목은 미확정 유지)", details: { provenance: "자동 승인", held: r.held.slice(0, 20) } });
          return "world_approve";
        }
        case "cast_fill": {
          const ids = castFillIds(await cast.getCast(scope));
          if (!ids.length) return null;
          const r = await cast.requestDraft(scope, { fillMissing: true, characterIds: ids }, SYS);
          await record(scope, { action: "autopilot.step", target: { type: "novel", id: scope.novelId }, after: { step: k, taskId: r.taskId, count: ids.length }, reason: "캐릭터 빈 항목 AI 채움(사용자가 쓴 항목은 그대로)" });
          return "cast_fill";
        }
        case "cast_confirm": {
          await cast.confirmCast(scope, SYS);
          await record(scope, { action: "autopilot.step", target: { type: "novel", id: scope.novelId }, after: { step: k }, reason: "캐스트 자동 확정", details: { provenance: "자동 승인" } });
          return "cast_confirm";
        }
        case "goal_save": {
          const d = await concept.getGoalFormDefaults(scope);
          if (!d?.endingDirection?.trim()) return null;
          const min = d.totalEpisodesMin ?? d.totalEpisodesMax ?? 100;
          const cadence = d.cadenceEpisodesPerWeek ?? 5;
          await novel.saveGoal(
            scope,
            { totalEpisodesMin: min, totalEpisodesMax: d.totalEpisodesMax && d.totalEpisodesMax >= min ? d.totalEpisodesMax : null, cadenceEpisodesPerWeek: Math.max(1, Math.min(14, cadence)), reserveTargetEpisodes: 5, endingDirection: d.endingDirection.trim(), notes: null },
            SYS,
          );
          await record(scope, { action: "autopilot.step", target: { type: "novel", id: scope.novelId }, after: { step: k, totalEpisodesMin: min, cadence }, reason: "컨셉 값으로 연재 목표 자동 저장", details: { provenance: "자동 승인" } });
          return "goal_save";
        }
        case "structure_request": {
          const r = await manuscript.requestStructure(scope, { scope: "all" }, SYS);
          await record(scope, { action: "autopilot.step", target: { type: "novel", id: scope.novelId }, after: { step: k, taskId: r.taskId }, reason: "전체 구성 작성 요청" });
          return "structure_request";
        }
      }
    } catch (err) {
      log.warn({ err, step: k, novelId: scope.novelId }, "autopilot step failed");
      await record(scope, { action: "autopilot.step", target: { type: "novel", id: scope.novelId }, after: { step: k, failed: true }, reason: (err as Error).message?.slice(0, 300) ?? "실패" });
      return null;
    }
    return null;
  };

  // ── budget ──
  const budgetGate = async (scope: NovelScope, n: Novel, s: AutopilotSettings, st: AutopilotState, at: Date): Promise<{ spentMicros: number; stop: string | null }> => {
    const statuses = await budget.status(scope).catch(() => []);
    if (statuses.some((b) => b.status === "hard_stopped")) return { spentMicros: 0, stop: "budget_hard" };
    // once per month: after the author resumed past this month's warning, the same warning does not halt again
    const month = monthKey(at, n.timezone);
    if (s.haltOnBudgetWarning && st.budgetWarningAck !== month && statuses.some((b) => b.status === "warning")) {
      await novel.haltAutopilot(scope, "budget_warning", SYS, { note: "월 예산이 경고 비율에 닿았습니다." });
      await notifyGate(scope, st, `budget_warning:${month}`, "월 예산이 경고 비율에 닿아 자율 진행을 멈췄습니다. 설정에서 예산을 확인한 뒤 [재개]를 누르세요(이번 달에는 이 경고로 다시 멈추지 않습니다).", { type: "novel", id: scope.novelId });
      return { spentMicros: 0, stop: "halted" };
    }
    const since = startOfLocalDay(at, n.timezone);
    const events = await budget.listCostEvents(scope, { since, limit: 10_000 }).catch(() => []);
    const spent = events.reduce((m, e) => m + Number(e.amountMicros ?? 0), 0);
    if (s.dailyBudgetUsd !== null && spent >= Math.round(s.dailyBudgetUsd * 1_000_000)) {
      const until = nextLocalMidnight(at, n.timezone).toISOString();
      if (!throttled(st, at)) {
        st.throttle = { until, reason: "daily_budget" };
        await novel.setAutopilotState(scope, { throttle: st.throttle });
        await record(scope, { action: "autopilot.throttled", target: { type: "novel", id: scope.novelId }, after: { until, reason: "daily_budget", spentMicros: spent }, reason: "하루 비용 상한 도달 — 다음 날 자정까지 자동 진행을 멈춥니다." });
      }
      return { spentMicros: spent, stop: "throttled" };
    }
    // under the cap (raised / removed) or past midnight: the throttle is lifted
    if (st.throttle && (!throttled(st, at) || st.throttle.reason === "daily_budget")) {
      st.throttle = null;
      await novel.setAutopilotState(scope, { throttle: null }); // the decision transaction re-reads it
    }
    return { spentMicros: spent, stop: throttled(st, at) ? "throttled" : null };
  };

  const startedToday = async (scope: NovelScope, n: Novel, at: Date) => {
    const since = startOfLocalDay(at, n.timezone);
    const outlines = await orchestration.listTasks(scope, { kinds: ["outline_episode"], includeCancelled: true, limit: 1000 });
    return new Set(outlines.filter((t) => t.createdAt.getTime() >= since.getTime() && (t.input as { cycle_key?: string } | null)?.cycle_key === t.targetId).map((t) => t.targetId)).size;
  };

  // ── approvals ──
  const decideApprovals = async (scope: NovelScope, n: Novel, s: AutopilotSettings, st: AutopilotState, out: AutopilotTickResult, waiting: AutopilotWaiting[], scheduled: AutopilotView["scheduled"]) => {
    const at = now();
    const pending = (await hitl.listApprovals(scope, { statuses: ["pending"] })).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const a of pending) {
      let facts: ApprovalFacts;
      try {
        facts = await approvalFacts(scope, a, st, pending);
      } catch (err) {
        log.warn({ err, approvalId: a.id }, "autopilot facts failed");
        continue;
      }
      const q = await hitl.getQuestionView(scope, a.questionId).catch(() => null);
      const title = q?.title ?? labelKo("approval_type", a.approvalType);
      const v = evaluateApproval(a, facts, s);
      if (v.kind === "human") {
        waiting.push({ kind: a.approvalType, title: `${title} — ${v.reasonKo}`, approvalId: a.id, questionId: a.questionId, ref: { type: a.subjectType, id: a.subjectId }, since: a.createdAt.toISOString() });
        if (isAutoApprovalType(a.approvalType) && settingFor(a.approvalType, s)) {
          const held = (a.payload as { autopilot?: { heldReason?: string } } | null)?.autopilot?.heldReason;
          if (!held) await hitl.markAutoHeld(scope, a.id, v.reasonKo);
        }
        await notifyGate(scope, st, `approval:${a.id}`, `${title}: 사람이 결정해야 합니다. ${v.reasonKo}`, { type: "approval", id: a.id }, { gate: v.gate, approvalType: a.approvalType });
        out.gates.push(`${a.approvalType}:${v.gate}`);
        continue;
      }
      if (v.kind === "wait") {
        if ((v.action === "fill_plot_cast" && facts.type === "arc_plan") || (v.action === "fill_cast" && facts.type === "story_structure")) {
          const key = facts.type === "arc_plan" ? a.subjectId : STRUCTURE_FILL_KEY;
          const cs = await cast.getCast(scope);
          const ids =
            facts.type === "arc_plan"
              ? cs.plotCompleteness.items.filter((i) => i.introducedArcId === a.subjectId && i.missing.length).map((i) => i.characterId)
              : cs.completeness.items.filter((i) => i.missing.length).map((i) => i.characterId);
          const prev = st.plotFills?.[key];
          const recent = prev && at.getTime() - new Date(prev.lastAt).getTime() < 20 * 60_000;
          if (ids.length && !recent && (prev?.attempts ?? 0) < MAX_FILL_ATTEMPTS && (await stillOn(scope))) {
            st.plotFills = { ...(st.plotFills ?? {}), [key]: { attempts: (prev?.attempts ?? 0) + 1, lastAt: at.toISOString() } };
            await cast.requestDraft(scope, { fillMissing: true, characterIds: ids }, SYS).catch((err) => log.warn({ err }, "cast fill failed"));
            out.steps.push(`${facts.type === "arc_plan" ? "plot" : "main"}_cast_fill:${key}`);
          }
        }
        // a wait that lasts: visible in the banner, one notice (it is not held — it is decided as soon as the condition clears)
        if (at.getTime() - a.createdAt.getTime() >= WAIT_NOTICE_MINUTES * 60_000) {
          waiting.push({ kind: a.approvalType, title: `${title} — 자동 승인 대기: ${v.reasonKo}`, approvalId: a.id, questionId: a.questionId, ref: { type: a.subjectType, id: a.subjectId }, since: a.createdAt.toISOString() });
          await notifyGate(scope, st, `wait:${a.id}`, `${title} 자동 승인이 ${WAIT_NOTICE_MINUTES}분 넘게 기다리는 중입니다: ${v.reasonKo} 직접 결정해도 됩니다.`, { type: "approval", id: a.id }, { wait: true });
        }
        continue;
      }
      if (v.at.getTime() > at.getTime()) {
        scheduled.push({ approvalId: a.id, questionId: a.questionId, title, at: v.at.toISOString() });
        continue;
      }
      if (!(await stillOn(scope))) return; // halted / switched off / paused since the tick started
      if (v.prepare === "accept_plot_cast") {
        const r = await cast.acceptAgentProposals(scope, { arcId: a.subjectId }, SYS).catch((err) => {
          log.warn({ err }, "plot cast accept failed");
          return { accepted: [] as string[] };
        });
        if (r.accepted.length) out.steps.push(`plot_cast_accept:${r.accepted.length}`);
      }
      const r = await hitl.autoDecideApproval(scope, a.id, { actor: SYS, note: `완전 자율 자동 승인(${labelKo("approval_type", a.approvalType)})` });
      if (r.decided) {
        if (st.autoFails?.[a.id]) delete st.autoFails[a.id];
        out.decided.push(`${a.approvalType}:${a.id}`);
        await record(scope, {
          action: "autopilot.approval_decided",
          target: { type: "approval", id: a.id },
          after: { approvalType: a.approvalType, subject: { type: a.subjectType, id: a.subjectId }, decision: "approved" },
          approvalId: a.id,
          questionId: a.questionId,
          answerId: r.answerId,
          details: { provenance: "자동 승인", title, checks: facts },
        });
      } else if (r.code === "transient") {
        // timeout / lock conflict: retried next tick; repeated failures go to the author
        const fails = (st.autoFails?.[a.id] ?? 0) + 1;
        st.autoFails = { ...(st.autoFails ?? {}), [a.id]: fails };
        if (fails >= MAX_TRANSIENT_FAILS) {
          const reason = `자동 승인이 ${fails}번 연속 실패했습니다(${r.reason}).`;
          await hitl.markAutoHeld(scope, a.id, reason).catch(() => undefined);
          waiting.push({ kind: a.approvalType, title: `${title} — ${reason}`, approvalId: a.id, questionId: a.questionId, ref: { type: a.subjectType, id: a.subjectId }, since: a.createdAt.toISOString() });
          await notifyGate(scope, st, `approval:${a.id}`, `${title}${objectParticle(title)} 자동 승인하지 못해 사람에게 넘깁니다(${reason})`, { type: "approval", id: a.id }, { code: r.code });
          out.gates.push(`${a.approvalType}:transient`);
        }
      } else if (r.code !== "not_pending" && r.code !== "not_eligible") {
        waiting.push({ kind: a.approvalType, title: `${title} — ${r.reason}`, approvalId: a.id, questionId: a.questionId, ref: { type: a.subjectType, id: a.subjectId }, since: a.createdAt.toISOString() });
        await notifyGate(scope, st, `approval:${a.id}`, `${title}${objectParticle(title)} 자동 승인하지 못해 사람에게 넘깁니다. ${r.reason}`, { type: "approval", id: a.id }, { code: r.code });
        out.gates.push(`${a.approvalType}:${r.code}`);
      }
    }
  };

  // ── questions ──
  const answerQuestions = async (scope: NovelScope, s: AutopilotSettings, out: AutopilotTickResult) => {
    if (!s.autoAnswerQuestions) return;
    const at = now();
    const qs = await hitl.listQuestions(scope, { statuses: ["open", "pending"], limit: 200 });
    for (const q of qs as Question[]) {
      const e = questionAutoAnswerable(q, s, at);
      if (!e.ok) continue;
      const r = await hitl.autoAnswerQuestion(scope, q.id, { actor: SYS });
      if (!r.decided) continue;
      out.answered.push(q.id);
      await record(scope, {
        action: "autopilot.question_answered",
        target: { type: "question", id: q.id },
        after: { questionNo: q.displayNo, topic: q.topic, grade: q.grade },
        questionId: q.id,
        answerId: r.answerId,
        reason: `Q-${q.displayNo} 추천안으로 자동 응답(${s.autoAnswerAfterMinutes}분 경과)`,
        details: { provenance: "자동 응답" },
      });
    }
  };

  // ── failed tasks (the board's "사람 조치 필요"): the branch is stuck until the author retries ──
  const failedTasks = async (scope: NovelScope, st: AutopilotState, waiting: AutopilotWaiting[]) => {
    const failed = await orchestration.listTasks(scope, { statuses: ["failed"], limit: 50 }).catch(() => []);
    if (!failed.length) return;
    const later = await orchestration.listTasks(scope, { kinds: [...new Set(failed.map((t) => t.kind))], limit: 500 }).catch(() => []);
    for (const t of failed) {
      // superseded by a later task of the same kind and target (a retry / a new cycle): not stuck
      if (later.some((x) => x.id !== t.id && x.kind === t.kind && x.targetId === t.targetId && x.createdAt.getTime() > t.createdAt.getTime())) continue;
      const title = `T-${t.displayNo} ${labelKo("task_kind", t.kind)} 실패 — 작업 보드에서 다시 시도해 주세요`;
      waiting.push({ kind: "task_failed", title, approvalId: null, questionId: null, ref: { type: "task", id: t.id }, since: t.updatedAt.toISOString() });
      await notifyGate(scope, st, `task_failed:${t.id}`, `${title}.`, { type: "task", id: t.id }, { kind: t.kind });
    }
  };

  // ── scheduled publishing ──
  const publishDue = async (scope: NovelScope, n: Novel, s: AutopilotSettings, st: AutopilotState, out: AutopilotTickResult) => {
    if (n.publishPolicy !== "scheduled") return;
    const at = now();
    const goal = await novel.getGoal(scope);
    const eps = (await manuscript.listEpisodes(scope)).sort((a, b) => a.episodeNo - b.episodeNo);
    const approved = eps.filter((e) => e.status === "approved");
    const unscheduled = approved.filter((e) => !e.scheduledPublishAt);
    if (unscheduled.length) {
      const taken = approved.filter((e) => e.scheduledPublishAt).map((e) => e.scheduledPublishAt!);
      const last = taken.reduce((m, d) => Math.max(m, d.getTime()), at.getTime());
      const slots = nextPublishSlots({ after: new Date(Math.max(last, at.getTime())), count: unscheduled.length, perWeek: goal?.cadenceEpisodesPerWeek ?? 5, timeLocal: s.publishTimeLocal, timeZone: n.timezone, taken });
      for (const [i, e] of unscheduled.entries()) {
        const slot = slots[i];
        if (!slot) break;
        await manuscript.setScheduledPublish(scope, e.id, slot, SYS).catch((err) => log.warn({ err }, "schedule publish failed"));
      }
    }
    const fresh = (await manuscript.listEpisodes(scope)).sort((a, b) => a.episodeNo - b.episodeNo);
    const done = new Set(fresh.filter((e) => e.status === "published").map((e) => e.episodeNo));
    for (const e of fresh) {
      if (e.status !== "approved" || !e.scheduledPublishAt || e.scheduledPublishAt.getTime() > at.getTime()) continue;
      if (e.episodeNo > 1 && fresh.some((x) => x.episodeNo === e.episodeNo - 1) && !done.has(e.episodeNo - 1)) break; // in order
      if (!(await stillOn(scope, { publishing: true }))) break; // publishing is hard to undo: re-check right before
      try {
        await manuscript.publishEpisode(scope, e.id, SYS);
        done.add(e.episodeNo);
        out.published.push(e.id);
      } catch (err) {
        const msg = (err as Error).message;
        await notifyGate(scope, st, `publish:${e.id}`, `${e.episodeNo}화를 예약 공개하지 못했습니다(${msg}).`, { type: "episode", id: e.id });
        break;
      }
    }
  };

  // ── one novel ──
  const tick = async (scope: NovelScope): Promise<AutopilotTickResult> => {
    const out: AutopilotTickResult = { skipped: null, steps: [], decided: [], answered: [], published: [], gates: [] };
    let n = await novel.getNovel(scope);
    if (n.autonomyLevel !== "full_auto") return { ...out, skipped: "not_full_auto" };
    if (n.status === "archived") return { ...out, skipped: "archived" };
    const s = parseAutopilotSettings(n.autopilotSettings);
    const st: AutopilotState = { ...stateOf(n) };
    const at = now();
    const waiting: AutopilotWaiting[] = [];
    const scheduled: AutopilotView["scheduled"] = [];
    let phase: AutopilotView["phase"] = "off";
    let next: string | null = null;

    if (n.autopilotHaltedAt) {
      phase = "halted";
      out.skipped = "halted";
    } else if (n.pausedAt) {
      phase = "paused";
      out.skipped = `paused:${n.pauseReason}`;
    } else {
      const b = await budgetGate(scope, n, s, st, at);
      if (b.stop === "halted" || b.stop === "budget_hard") {
        phase = b.stop === "halted" ? "halted" : "paused";
        out.skipped = b.stop;
      } else if (b.stop === "throttled") {
        phase = "throttled";
        out.skipped = "throttled";
      }
    }

    if (!out.skipped) {
      // 2. front steps
      const facts = await stepFacts(scope, n, st, at);
      const plan = planSteps(facts, s);
      phase = plan.phase;
      next = plan.next;
      for (const g of plan.gates) {
        waiting.push({ kind: g.code, title: g.title, approvalId: null, questionId: null, ref: { type: "novel", id: scope.novelId }, since: null });
        await notifyGate(scope, st, `step:${g.code}`, g.title, { type: "novel", id: scope.novelId }, { gate: g.code });
      }
      for (const k of plan.run) {
        if (!(await stillOn(scope))) break; // kill switch / level change / pause during the tick
        const done = await runStep(scope, n, st, k, s);
        if (done) out.steps.push(done);
      }
      if (plan.completed && !st.completedAt) {
        st.completedAt = at.toISOString();
        await record(scope, { action: "autopilot.completed", target: { type: "novel", id: scope.novelId }, after: { approvedOrPublished: facts.episodes.approvedOrPublished }, reason: "목표 화수에 도달해 자동 진행을 마쳤습니다." });
        await notifyGate(scope, st, "completed", "목표 화수에 도달해 새 화 자동 진행을 마쳤습니다. 예약 공개는 계속합니다.", { type: "novel", id: scope.novelId });
      }
      // 3. approvals, 4. questions
      if (!plan.completed) {
        await decideApprovals(scope, n, s, st, out, waiting, scheduled);
        await answerQuestions(scope, s, out);
      }
      await failedTasks(scope, st, waiting);
    }
    // 5. scheduled publishing continues after completion / throttle (not while halted or paused)
    if (!n.autopilotHaltedAt && !n.pausedAt && out.skipped !== "halted" && out.skipped !== "budget_hard") await publishDue(scope, n, s, st, out);

    // 6. summary (bookkeeping only)
    n = await novel.getNovel(scope);
    if (n.autonomyLevel === "full_auto") {
      await novel.setAutopilotState(scope, {
        phase,
        next,
        waiting: waiting.slice(0, 50),
        scheduled: scheduled.slice(0, 50),
        throttle: st.throttle ?? null,
        lastTickAt: at.toISOString(),
        steps: st.steps ?? null,
        worldApprovedTask: st.worldApprovedTask ?? null,
        plotFills: st.plotFills ?? null,
        notified: st.notified ?? null,
        completedAt: st.completedAt ?? null,
        autoFails: st.autoFails && Object.keys(st.autoFails).length ? st.autoFails : null,
      });
    }
    return out;
  };

  const viewOf = async (scope: NovelScope): Promise<AutopilotView> => {
    const n = await novel.getNovel(scope);
    const st = stateOf(n);
    const s = parseAutopilotSettings(n.autopilotSettings);
    const at = now();
    const since = startOfLocalDay(at, n.timezone);
    const events = await budget.listCostEvents(scope, { since, limit: 10_000 }).catch(() => []);
    const eps = await manuscript.listEpisodes(scope).catch(() => []);
    const recent = await audit.list(scope, { actionPrefix: "autopilot.", limit: 30 });
    const active = isActive(n);
    const phase: AutopilotView["phase"] = n.autonomyLevel !== "full_auto" ? "off" : n.autopilotHaltedAt ? "halted" : n.pausedAt ? "paused" : (st.phase ?? "off");
    return {
      active,
      level: n.autonomyLevel,
      publishPolicy: n.publishPolicy,
      halted: n.autopilotHaltedAt && n.autopilotHaltReason ? { at: n.autopilotHaltedAt.toISOString(), reason: n.autopilotHaltReason } : null,
      settings: s,
      enabledByUserId: n.autopilotEnabledByUserId,
      phase,
      next: n.autonomyLevel === "full_auto" ? (st.next ?? null) : null,
      waitingHuman: n.autonomyLevel === "full_auto" ? (st.waiting ?? []) : [],
      scheduled: n.autonomyLevel === "full_auto" ? (st.scheduled ?? []) : [],
      throttle: throttled(st, at) ?? null,
      today: {
        startedEpisodes: await startedToday(scope, n, at),
        maxEpisodes: s.maxEpisodesPerDay,
        approvedEpisodes: eps.filter((e) => e.approvedAt && e.approvedAt.getTime() >= since.getTime()).length,
        spentMicros: events.reduce((m, e) => m + Number(e.amountMicros ?? 0), 0),
        dailyBudgetMicros: s.dailyBudgetUsd === null ? null : Math.round(s.dailyBudgetUsd * 1_000_000),
      },
      lastTickAt: st.lastTickAt ?? null,
      recent: recent.items.map((e) => ({ ...e, occurredAt: e.occurredAt.toISOString() }) as unknown as ActivityDto),
    };
  };

  const service: AutopilotService = {
    getView: viewOf,
    tick,
    async runOnce() {
      let count = 0;
      for (const n of await novel.listNovels()) {
        if (n.autonomyLevel !== "full_auto") continue;
        try {
          await tick({ novelId: n.id });
          count++;
        } catch (err) {
          log.error({ err, novelId: n.id }, "autopilot tick failed");
        }
      }
      return count;
    },
    async halt(scope, input, actor) {
      await novel.haltAutopilot(scope, "user", actor, { note: input.reason });
      if (input.alsoPauseTasks) await novel.pause(scope, "user", actor, { note: input.reason ?? "자율 진행 멈춤과 함께 진행 중 작업도 멈춤" });
      return viewOf(scope);
    },
    async resume(scope, actor) {
      const before = await novel.getNovel(scope);
      // resuming past a budget warning acknowledges it for this month (otherwise the next tick halts again)
      if (before.autopilotHaltReason === "budget_warning") await novel.setAutopilotState(scope, { budgetWarningAck: monthKey(now(), before.timezone) });
      await novel.resumeAutopilot(scope, actor);
      return viewOf(scope);
    },
  };
  return { service, decider };
}
