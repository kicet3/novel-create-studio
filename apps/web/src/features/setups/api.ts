/** Foreshadow (setups) data hooks (CONVENTIONS §13 떡밥). */
import { useQuery } from "@tanstack/react-query";
import {
  DEFAULTS,
  setupDetailDtoSchema,
  setupDtoSchema,
  setupReportDtoSchema,
  type SetupDetailDto,
  type SetupDto,
  type SetupNarrativeStatus,
  type SetupReportDto,
} from "@ncs/shared";
import { api } from "../../api/client.js";
import { queryKeys } from "../../api/query-keys.js";
import { listOf } from "../novels/api.js";

const setupList = listOf<SetupDto>(setupDtoSchema);

export interface SetupFilter {
  narrative?: string[];
  canon?: string[];
  importance?: string[];
  overdue?: boolean;
  dueWithin?: number;
}

export function useSetups(novelId: string, filter: SetupFilter = {}) {
  return useQuery({
    queryKey: queryKeys.novel(novelId).setups({ ...filter }),
    queryFn: ({ signal }) =>
      api
        .get(`/novels/${novelId}/setups`, {
          schema: setupList,
          signal,
          query: {
            narrative: filter.narrative?.length ? filter.narrative.join(",") : undefined,
            canon: filter.canon?.length ? filter.canon.join(",") : undefined,
            importance: filter.importance?.length ? filter.importance.join(",") : undefined,
            overdue: filter.overdue || undefined,
            dueWithin: filter.dueWithin,
          },
        })
        .then((d) => d.items),
  });
}

export function useSetup(novelId: string, setupNo: string | undefined) {
  return useQuery({
    queryKey: [...queryKeys.novel(novelId).setups(), "detail", setupNo ?? "-"],
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/setups/${encodeURIComponent(setupNo ?? "")}`, { schema: setupDetailDtoSchema, signal }),
    enabled: !!setupNo,
  });
}

export function useSetupReport(novelId: string, asOf: number | undefined) {
  return useQuery({
    queryKey: [...queryKeys.novel(novelId).setups(), "report", asOf ?? null],
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/setups/report`, { schema: setupReportDtoSchema, signal, query: { asOf } }),
  });
}

// ── pure helpers ────────────────────────────────────────────────────────

export const SETUP_FLOW: readonly SetupNarrativeStatus[] = ["planned", "planted", "reinforced", "paid_off"];
export const DUE_WARNING_EPISODES = DEFAULTS["setup.due_warning_episodes"] as number;

export type DueState = "overdue" | "due_soon" | "ok" | "none";

/** 08 §9.6: ≤ due_warning_episodes → 임박, past due and unresolved → 초과. Closed setups have no due state. */
export function dueState(setup: Pick<SetupDto, "narrativeStatus" | "remainingEpisodes">, warn: number = DUE_WARNING_EPISODES): DueState {
  if (setup.narrativeStatus === "paid_off" || setup.narrativeStatus === "abandoned") return "none";
  if (setup.remainingEpisodes === null) return "none";
  if (setup.remainingEpisodes < 0) return "overdue";
  if (setup.remainingEpisodes <= warn) return "due_soon";
  return "ok";
}

export function beatCounts(setup: Pick<SetupDto, "beats">): Record<"plant" | "reinforce" | "payoff", { planned: number; done: number; missing: number }> {
  const out = {
    plant: { planned: 0, done: 0, missing: 0 },
    reinforce: { planned: 0, done: 0, missing: 0 },
    payoff: { planned: 0, done: 0, missing: 0 },
  };
  for (const b of setup.beats) {
    if (b.status === "cancelled") continue;
    const c = out[b.kind];
    c.planned++;
    if (b.status === "confirmed" || b.status === "detected") c.done++;
    if (b.status === "missing") c.missing++;
  }
  return out;
}

export type { SetupDetailDto, SetupDto, SetupReportDto };
