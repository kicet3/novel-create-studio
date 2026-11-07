import { useQuery } from "@tanstack/react-query";
import type { ArcDto, BudgetStatusViewDto, GoalDto, HealthCheckResultDto, NovelDto } from "@ncs/shared";
import { api } from "../../api/client.js";
import { AMBIENT_POLL_INTERVAL_MS } from "../../api/query-client.js";
import { queryKeys } from "../../api/query-keys.js";

/** GET …/home (composition/home-route.ts). Sections of placeholder modules are `null`. */
export interface HomeData {
  novel: NovelDto;
  goal: GoalDto | null;
  arcs: ArcDto[];
  episodes: { total: number; approved: number; published: number; inProgress: number } | null;
  reserve: { includingAwaiting: number; approvedOnly: number; target: number } | null;
  questions: {
    blocking: number;
    nonBlocking: number;
    informational: number;
    approvals: number;
    earliestDeadlineAt: string | null;
  } | null;
  continuityIssues: Record<string, number> | null;
  setupsDueSoon: Array<Record<string, unknown>> | null;
  budget: BudgetStatusViewDto[] | null;
  health: HealthCheckResultDto[];
  modules: Record<string, boolean>;
  /** 설계 추가 0018: 한 화씩 진행 (null = off / not episode_approval) */
  sequential?: { enabled: boolean; waitingEpisodeNo: number | null; nextEpisodeNo: number | null } | null;
}

export function useHome(novelId: string) {
  return useQuery({
    queryKey: queryKeys.novel(novelId).home(),
    queryFn: ({ signal }) => api.get<HomeData>(`/novels/${novelId}/home`, { signal }),
    refetchInterval: AMBIENT_POLL_INTERVAL_MS,
  });
}

/** 11 M-06~M-08, M-22 — goal form initial values derived from the approved concept brief. */
export interface GoalFormDefaults {
  conceptBriefId: string;
  endingDirection: string | null;
  totalEpisodesMin: number | null;
  totalEpisodesMax: number | null;
  cadenceEpisodesPerWeek: number | null;
  lengthHint: string | null;
  suggestMultiTimeline: boolean;
  suggestPossessionMode: boolean;
}

/**
 * Tries `GET …/concept/goal-defaults` (concept module, A7). Resolves `null` on any failure so the form
 * always renders (defaults are a convenience, not a requirement).
 */
export function useGoalFormDefaults(novelId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...queryKeys.novel(novelId).concept(), "goal-defaults"],
    enabled,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        const d = await api.get<GoalFormDefaults | { defaults: GoalFormDefaults } | null>(`/novels/${novelId}/concept/goal-defaults`, { signal });
        if (d && typeof d === "object" && "defaults" in d) return d.defaults;
        return d ?? null;
      } catch {
        return null;
      }
    },
  });
}
