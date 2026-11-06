import { describe, expect, it } from "vitest";
import { autopilotActionLabel, autopilotEventText, bannerTitle, todayLine } from "./labels.js";

describe("autopilot labels", () => {
  it("banner: next step, halt reason, throttle, completion", () => {
    const base = { level: "full_auto" as const, active: true, phase: "writing" as const, next: "3화 초안 작성", halted: null, throttle: null };
    expect(bannerTitle(base)).toBe("완전 자율 진행 중 · 다음: 3화 초안 작성");
    expect(bannerTitle({ ...base, halted: { at: "2026-11-05T00:00:00.000Z", reason: "budget_warning" } })).toBe("완전 자율 멈춤 (월 예산 경고)");
    expect(bannerTitle({ ...base, halted: { at: "2026-11-05T00:00:00.000Z", reason: "user" } })).toBe("완전 자율 멈춤 (작가 요청)");
    // stuck branches and a missing AI connection are not "진행 중"
    expect(bannerTitle({ ...base, waitingHuman: [{ kind: "task_failed", title: "T-18 실패", approvalId: null, questionId: null, ref: null, since: null }] })).toBe("완전 자율 · 사람 확인 대기 1건 · 다음: 3화 초안 작성");
    expect(bannerTitle(base, { llmDown: true })).toContain("AI 연결 없음");
    expect(bannerTitle({ ...base, throttle: { until: "2026-11-06T15:00:00.000Z", reason: "daily_budget" } })).toContain("하루 비용 상한");
    expect(bannerTitle({ ...base, phase: "completed" })).toContain("목표 화수");
    expect(bannerTitle({ ...base, level: "episode_approval" })).toBe("");
  });
  it("today line and activity rows", () => {
    expect(todayLine({ today: { startedEpisodes: 2, maxEpisodes: 3, approvedEpisodes: 1, spentMicros: 1_230_000, dailyBudgetMicros: 5_000_000 } })).toBe("오늘 착수 2/3화 · 오늘 승인 1화 · 오늘 비용 $1.23 / $5.00");
    expect(autopilotActionLabel("autopilot.approval_decided")).toBe("자동 승인");
    expect(autopilotEventText({ action: "autopilot.approval_decided", after: { approvalType: "episode" }, reason: null, details: { title: "3화 승인 요청" } })).toBe("3화 승인");
    expect(autopilotEventText({ action: "autopilot.approval_decided", after: { approvalType: "series_bible" }, reason: null, details: { title: "기획서 1판 승인 요청" } })).toBe("기획서 1판 승인");
    expect(autopilotEventText({ action: "autopilot.approval_decided", after: { approvalType: "arc_plan" }, reason: null, details: {} })).toBe("플롯 계획 승인");
    expect(autopilotEventText({ action: "autopilot.step", after: { step: "cast_confirm" }, reason: "캐스트 자동 확정", details: null })).toBe("캐스트 확정 · 캐스트 자동 확정");
  });
});
