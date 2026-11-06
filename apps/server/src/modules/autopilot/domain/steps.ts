/**
 * Front steps of the autopilot (설계 추가 0014): concept → world ontology → cast → goal → (bible → structure → plots →
 * episodes run through approvals and the scheduler). Pure: decides the phase, the "다음:" line, the step to run now and
 * the human gates of the front steps. The application layer executes the step.
 */
import type { AutopilotPhase, AutopilotSettings } from "@ncs/shared";

export const MAX_STEP_ATTEMPTS = 2;
/** minutes between two attempts of the same step (a failed task / a refused call) */
export const STEP_RETRY_MINUTES = 20;

export interface StepFacts {
  novelStatus: string;
  concept: { approved: boolean; awaiting: boolean; sessionActive: boolean; autoRunning: boolean; attempts: number };
  world: { state: "none" | "waiting_brief" | "queued" | "running" | "done" | "failed"; taskId: string | null; pending: number; approvedTaskId: string | null };
  cast: {
    confirmed: boolean;
    pendingChanges: number;
    blockers: string[];
    /** initial cast characters with empty required fields */
    missing: number;
    draftRunning: boolean;
    fillAttempts: number;
  };
  goal: { saved: boolean; endingDirection: string | null };
  bible: "none" | "awaiting" | "approved";
  structure: { status: "none" | "draft" | "awaiting_approval" | "approved"; taskActive: boolean; canGenerate: boolean; gateReasons: string[]; attempts: number; lastError: string | null };
  plots: { total: number; active: number; planned: number; completed: number };
  episodes: { approvedOrPublished: number; awaiting: number; inFlight: number; targetMin: number | null; nextTitle: string | null };
  /** minutes since the last attempt of each step (null = never) */
  sinceLastAttempt: Partial<Record<StepKind, number | null>>;
}

export type StepKind = "concept_submit" | "world_approve" | "cast_fill" | "cast_confirm" | "goal_save" | "structure_request";

export interface StepGate {
  code: string;
  title: string;
}

export interface StepPlan {
  phase: AutopilotPhase;
  next: string | null;
  /** steps to run now (in order) */
  run: StepKind[];
  gates: StepGate[];
  completed: boolean;
}

const due = (f: StepFacts, k: StepKind) => {
  const m = f.sinceLastAttempt[k];
  return m === null || m === undefined || m >= STEP_RETRY_MINUTES;
};

export function planSteps(f: StepFacts, s: AutopilotSettings): StepPlan {
  const run: StepKind[] = [];
  const gates: StepGate[] = [];
  if (f.novelStatus === "concept") {
    if (f.concept.awaiting) return { phase: "concept", next: "컨셉 승인 판정", run, gates, completed: false };
    if (!s.autoConfirmConcept) {
      gates.push({ code: "concept_confirm", title: "컨셉 확정은 작가가 직접 합니다(컨셉 확정 자동 승인 꺼짐)." });
      return { phase: "concept", next: "컨셉 확정(사람)", run, gates, completed: false };
    }
    if (!f.concept.sessionActive) {
      gates.push({ code: "concept_session", title: "진행 중인 컨셉 대화가 없습니다." });
      return { phase: "concept", next: "컨셉 대화(사람)", run, gates, completed: false };
    }
    if (f.concept.autoRunning) return { phase: "concept", next: "컨셉 대화 자동 승인 진행 중", run, gates, completed: false };
    if (f.concept.attempts >= MAX_STEP_ATTEMPTS + 1) {
      gates.push({ code: "concept_blocked", title: "컨셉 필수 항목이 비어 있어 자동 확정하지 못했습니다. 컨셉 대화를 이어 가 주세요." });
      return { phase: "concept", next: "컨셉 보완(사람)", run, gates, completed: false };
    }
    if (due(f, "concept_submit")) run.push("concept_submit");
    return { phase: "concept", next: "컨셉 확정·승인 요청", run, gates, completed: false };
  }

  if (f.novelStatus === "onboarding") {
    // world ontology: accept the generated candidates once per generation (conflicts stay 미확정)
    const worldBusy = f.world.state === "queued" || f.world.state === "running" || f.world.state === "waiting_brief";
    if (s.autoAcceptWorld && f.world.state === "done" && f.world.pending > 0 && f.world.approvedTaskId !== f.world.taskId) run.push("world_approve");
    // cast: fill empty required fields (agent fields only), then confirm
    if (f.cast.blockers.length && !f.cast.missing) gates.push({ code: "cast_blocked", title: `캐스트를 확정할 수 없습니다: ${f.cast.blockers[0]}` });
    let castReady = false;
    if (!s.autoCompleteCast) {
      if (!f.cast.confirmed) gates.push({ code: "cast_confirm", title: "캐스트 확정은 작가가 합니다(캐스트 자동 보완 꺼짐)." });
      castReady = f.cast.confirmed;
    } else if (f.cast.draftRunning) {
      castReady = false;
    } else if (f.cast.missing > 0) {
      if (f.cast.fillAttempts >= MAX_STEP_ATTEMPTS) gates.push({ code: "cast_incomplete", title: "캐릭터 필수 항목을 AI가 채우지 못했습니다. 캐릭터 화면에서 채워 주세요." });
      else if (due(f, "cast_fill")) run.push("cast_fill");
    } else if ((!f.cast.confirmed || f.cast.pendingChanges > 0) && !f.cast.blockers.length) {
      if (due(f, "cast_confirm")) run.push("cast_confirm");
    } else {
      castReady = f.cast.confirmed;
    }
    // goal: after the cast is confirmed and the world generation settled (the bible reads both)
    if (castReady && !worldBusy && !run.includes("world_approve")) {
      if (!s.autoSaveGoal) gates.push({ code: "goal", title: "연재 목표 저장은 작가가 합니다(목표 자동 저장 꺼짐)." });
      else if (!f.goal.endingDirection?.trim()) gates.push({ code: "goal_ending", title: "컨셉에 결말 방향이 없어 연재 목표를 자동으로 저장할 수 없습니다." });
      else if (due(f, "goal_save")) run.push("goal_save");
    }
    const next = run.includes("world_approve")
      ? "세계관 후보 승인"
      : run.includes("cast_fill") || f.cast.draftRunning
        ? "캐릭터 빈 항목 채우기"
        : run.includes("cast_confirm")
          ? "캐스트 확정"
          : worldBusy
            ? "세계관 생성"
            : run.includes("goal_save")
              ? "연재 목표 저장"
              : gates.length
                ? "사람 확인 대기"
                : "설정 단계";
    return { phase: f.cast.confirmed ? "goal" : "world_cast", next, run, gates, completed: false };
  }

  if (f.novelStatus !== "planning" && f.novelStatus !== "serializing") return { phase: "off", next: null, run, gates, completed: false };

  if (f.bible !== "approved") return { phase: "bible", next: f.bible === "awaiting" ? "기획서 승인 판정" : "기획서 작성", run, gates, completed: false };

  if (f.structure.status !== "approved") {
    if (f.structure.status === "none") {
      if (f.structure.taskActive) return { phase: "structure", next: "전체 구성 작성", run, gates, completed: false };
      if (!f.structure.canGenerate) {
        gates.push({ code: "structure_gate", title: `전체 구성을 만들 수 없습니다: ${f.structure.gateReasons[0] ?? "조건 미충족"}` });
      } else if (f.structure.attempts >= MAX_STEP_ATTEMPTS + 1) {
        gates.push({ code: "structure_failed", title: `전체 구성을 만들지 못했습니다${f.structure.lastError ? `: ${f.structure.lastError}` : ""}` });
      } else if (due(f, "structure_request")) run.push("structure_request");
      return { phase: "structure", next: "전체 구성 작성", run, gates, completed: false };
    }
    if (f.structure.status === "draft") {
      if (!f.structure.taskActive) gates.push({ code: "structure_review", title: "바뀐 전체 구성을 작가가 검토하고 다시 승인해야 합니다." });
      return { phase: "structure", next: f.structure.taskActive ? "전체 구성 다시 작성" : "전체 구성 재승인(사람)", run, gates, completed: false };
    }
    return { phase: "structure", next: "전체 구성 승인 판정", run, gates, completed: false };
  }

  const target = f.episodes.targetMin;
  const completed = f.plots.total > 0 && f.plots.completed === f.plots.total && target !== null && f.episodes.approvedOrPublished >= target;
  if (completed) return { phase: "completed", next: null, run, gates, completed: true };
  if (f.plots.active === 0 && f.plots.planned > 0 && f.episodes.inFlight === 0 && f.episodes.awaiting === 0) {
    return { phase: "plots", next: "다음 플롯 계획", run, gates, completed: false };
  }
  return { phase: "writing", next: f.episodes.nextTitle, run, gates, completed: false };
}
