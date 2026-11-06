/**
 * 설계 추가 0014 — 완전 자율(full_auto) 진행 설정·상태 DTO (module autopilot; settings/state live on `novels`).
 *
 *   GET   /api/novels/:novelId/autopilot                   → autopilotViewSchema
 *   PATCH /api/novels/:novelId/autopilot/settings          autopilotSettingsPatchSchema → autopilotViewSchema
 *   POST  /api/novels/:novelId/autopilot/halt              autopilotHaltRequestSchema → autopilotViewSchema
 *   POST  /api/novels/:novelId/autopilot/resume            → autopilotViewSchema
 *
 * full_auto is switched on with PUT /autonomy (changeAutonomyRequestSchema: acknowledgedAutoItems + optional
 * `autopilot` settings; acknowledgedStructureAutoWarning when concept/structure auto-approval is on).
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime } from "./common.js";
import { activityDtoSchema } from "./audit.js";

/** fields without defaults (patch requests) */
const autopilotSettingsFields = {
  /** 화 승인(분량 하한·열린 high 이슈·안전 이력·리트콘 대기가 없을 때만) */
  autoApproveEpisodes: z.boolean(),
  /** 플롯 계획 승인(arc_plan, 재계획 포함) — 새 인물의 AI 제안 수락 포함(사용자가 쓴 항목은 바꾸지 않음) */
  autoApprovePlots: z.boolean(),
  /** 세계관 후보 일괄 승인(충돌 항목은 '미확정'으로 남음) */
  autoAcceptWorld: z.boolean(),
  /** 캐스트 빈 항목 AI 채움 + 확정 */
  autoCompleteCast: z.boolean(),
  /** 컨셉의 화수·주기·결말 방향으로 연재 목표 저장 */
  autoSaveGoal: z.boolean(),
  /** 기획서 승인 */
  autoApproveBible: z.boolean(),
  /** opt-in: 최초 컨셉 확정(유사성·안전 신호 0건일 때만) */
  autoConfirmConcept: z.boolean(),
  /** opt-in: 최초 전체 구성·부 변경 승인(결말이 바뀐 재승인은 항상 사람) */
  autoApproveStructure: z.boolean(),
  /** 질문 자동 응답(민감도 보통, 추천안이 있는 선택형만) */
  autoAnswerQuestions: z.boolean(),
  autoAnswerAfterMinutes: z.number().int().min(5).max(1440),
  /** 차단형 중 아크 목표·중요 떡밥 기한 질문도 자동 응답 */
  autoAnswerImportant: z.boolean(),
  /** 자동 승인 전 개입 유예(분) */
  approveDelayMinutes: z.number().int().min(0).max(1440),
  /** medium 연속성 이슈가 열려 있어도 사람에게 넘김 */
  holdOnMediumIssues: z.boolean(),
  /** 하루에 새로 착수(아웃라인 시작)하는 화 수 상한 */
  maxEpisodesPerDay: z.number().int().min(1).max(20),
  /** 하루 비용 상한(USD, null = 없음) — 넘으면 다음 날 자정까지 자동 진행을 멈춤 */
  dailyBudgetUsd: z.number().positive().max(10_000).nullable(),
  /** 월 예산이 경고 비율에 닿으면 자율 진행 멈춤 */
  haltOnBudgetWarning: z.boolean(),
  /** 예약 공개 시각(작품 시간대, publish_policy=scheduled) */
  publishTimeLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM 형식이어야 합니다."),
};

export const AUTOPILOT_DEFAULTS = {
  autoApproveEpisodes: true,
  autoApprovePlots: true,
  autoAcceptWorld: true,
  autoCompleteCast: true,
  autoSaveGoal: true,
  autoApproveBible: true,
  autoConfirmConcept: false,
  autoApproveStructure: false,
  autoAnswerQuestions: true,
  autoAnswerAfterMinutes: 30,
  autoAnswerImportant: false,
  approveDelayMinutes: 0,
  holdOnMediumIssues: false,
  maxEpisodesPerDay: 3,
  dailyBudgetUsd: null,
  haltOnBudgetWarning: true,
  publishTimeLocal: "18:00",
} as const;

export const autopilotSettingsSchema = z.object(
  Object.fromEntries(Object.entries(autopilotSettingsFields).map(([k, f]) => [k, (f as z.ZodType).default((AUTOPILOT_DEFAULTS as Record<string, unknown>)[k] as never)])) as {
    [K in keyof typeof autopilotSettingsFields]: z.ZodDefault<(typeof autopilotSettingsFields)[K]>;
  },
);
export type AutopilotSettings = z.infer<typeof autopilotSettingsSchema>;

/** stored JSON → settings with defaults (unknown / invalid keys dropped) */
export function parseAutopilotSettings(raw: unknown): AutopilotSettings {
  const base = autopilotSettingsSchema.parse({});
  if (!raw || typeof raw !== "object") return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const field = (autopilotSettingsFields as Record<string, z.ZodType>)[k];
    if (!field) continue;
    const r = field.safeParse(v);
    if (r.success) out[k] = r.data;
  }
  return out as AutopilotSettings;
}

export const autopilotSettingsPatchSchema = z
  .object(autopilotSettingsFields)
  .partial()
  .extend({
    /** required when autoConfirmConcept / autoApproveStructure turn on */
    acknowledgedStructureAutoWarning: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "acknowledgedStructureAutoWarning"), "변경할 항목이 없습니다.");
export type AutopilotSettingsPatch = z.input<typeof autopilotSettingsPatchSchema>;

export const autopilotHaltRequestSchema = z.object({
  /** 진행 중인 작업도 즉시 멈춤(작품 일시정지 pause_reason=user) */
  alsoPauseTasks: z.boolean().default(false),
  reason: z.string().max(500).optional(),
});
export type AutopilotHaltRequest = z.input<typeof autopilotHaltRequestSchema>;

export const AUTOPILOT_PHASES = [
  "off",
  "halted",
  "paused",
  "throttled",
  "concept",
  "world_cast",
  "goal",
  "bible",
  "structure",
  "plots",
  "writing",
  "completed",
] as const;
export type AutopilotPhase = (typeof AUTOPILOT_PHASES)[number];

export const autopilotWaitingSchema = z.object({
  kind: z.string(),
  /** Korean one-liner shown in the banner / list */
  title: z.string(),
  approvalId: z.string().nullable(),
  questionId: z.string().nullable(),
  ref: z.object({ type: z.string(), id: z.string() }).nullable(),
  since: isoDateTime.nullable(),
});
export type AutopilotWaiting = z.infer<typeof autopilotWaitingSchema>;

export const autopilotViewSchema = z.object({
  /** full_auto and not halted */
  active: z.boolean(),
  level: z.enum(ENUMS.autonomy_level),
  publishPolicy: z.enum(ENUMS.publish_policy),
  halted: z.object({ at: isoDateTime, reason: z.enum(ENUMS.autopilot_halt_reason) }).nullable(),
  settings: autopilotSettingsSchema,
  enabledByUserId: z.string().nullable(),
  phase: z.enum(AUTOPILOT_PHASES),
  /** "다음: 3화 초안 작성" */
  next: z.string().nullable(),
  /** human gates the autopilot stopped at (only that branch waits) */
  waitingHuman: z.array(autopilotWaitingSchema),
  /** approvals the autopilot will decide (with the time, after the intervention delay) */
  scheduled: z.array(z.object({ approvalId: z.string(), questionId: z.string(), title: z.string(), at: isoDateTime })),
  throttle: z.object({ until: isoDateTime, reason: z.enum(["daily_budget", "daily_episodes"]) }).nullable(),
  today: z.object({ startedEpisodes: z.number().int(), maxEpisodes: z.number().int(), approvedEpisodes: z.number().int(), spentMicros: z.number().int(), dailyBudgetMicros: z.number().int().nullable() }),
  lastTickAt: isoDateTime.nullable(),
  recent: z.array(activityDtoSchema),
});
export type AutopilotView = z.infer<typeof autopilotViewSchema>;

// ── wall-clock helpers (novel timezone; pure, browser-safe) ──
export interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export function wallParts(at: Date, timeZone: string): WallParts {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: WEEKDAYS[p.weekday ?? "Sun"] ?? 0 };
}
/** the instant whose wall clock in `timeZone` is y-m-d h:mi (day overflow allowed, e.g. day 32) */
export function zonedTime(y: number, m: number, d: number, h: number, mi: number, timeZone: string): Date {
  const target = Date.UTC(y, m - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = wallParts(new Date(guess), timeZone);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = target - seen;
    if (!diff) break;
    guess += diff;
  }
  return new Date(guess);
}
/** local midnight of the day `at` falls on */
export function startOfLocalDay(at: Date, timeZone: string): Date {
  const p = wallParts(at, timeZone);
  return zonedTime(p.year, p.month, p.day, 0, 0, timeZone);
}
/** next local midnight after `at` */
export function nextLocalMidnight(at: Date, timeZone: string): Date {
  const p = wallParts(at, timeZone);
  return zonedTime(p.year, p.month, p.day + 1, 0, 0, timeZone);
}
