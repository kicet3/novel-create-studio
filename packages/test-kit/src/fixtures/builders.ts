/**
 * Plain-object fixture builders (no DB access) matching the drizzle insert shapes of @ncs/db.
 * Use with `db.insert(schema.novels).values(buildNovel(...))`. Override any field via `over`.
 */
import { DEFAULTS, newId, usdToMicros, type Id } from "@ncs/shared";

type Over<T> = Partial<T>;

export function buildUser(over: Over<{ id: string; displayName: string; role: "owner" }> = {}) {
  return { id: newId("usr") as string, displayName: "작가", role: "owner" as const, ...over };
}

export function buildNovel(
  refs: { lengthProfileId: string; activeSchemaVersionId: string },
  over: Record<string, unknown> = {},
) {
  return {
    id: newId("nov") as string,
    title: "회귀자의 흉터",
    ageRating: "age_15" as const,
    status: "concept" as const,
    timezone: "Asia/Seoul",
    defaultNarrationMode: DEFAULTS["novel.default_narration_mode"],
    ...refs,
    ...over,
  };
}

export function buildGoal(novelId: string, over: Record<string, unknown> = {}) {
  return {
    id: newId("gol") as string,
    novelId,
    totalEpisodesMin: 120,
    cadenceEpisodesPerWeek: 7,
    reserveTargetEpisodes: DEFAULTS["reserve.target_episodes"],
    endingDirection: "주인공이 흉터의 비밀을 밝히고 회귀를 끝낸다",
    ...over,
  };
}

export function buildBudgetPolicy(novelId: string, windowStartedAt: Date, over: Record<string, unknown> = {}) {
  return {
    id: newId("bgp") as string,
    novelId,
    category: "all" as const,
    budgetWindow: DEFAULTS["budget.window"],
    hardLimitMicros: usdToMicros(DEFAULTS["budget.novel_monthly_hard_limit_usd"]),
    softWarnRatio: DEFAULTS["budget.soft_warn_ratio"],
    windowStartedAt,
    ...over,
  };
}

export function buildTask(
  novelId: string,
  over: Record<string, unknown> & { goalId?: string | null } = {},
): Record<string, unknown> & { id: Id<"tsk"> } {
  return {
    id: newId("tsk"),
    novelId,
    displayNo: 1,
    kind: "plan_series_bible",
    agentRole: "planner",
    targetType: "novel",
    targetId: novelId,
    status: "pending",
    maxAttempts: DEFAULTS["task.max_attempts"],
    input: {},
    createdByActorType: "system",
    createdByActorId: "orchestrator",
    ...over,
  };
}
