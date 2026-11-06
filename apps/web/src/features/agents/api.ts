import { useQuery } from "@tanstack/react-query";
import { agentsOverviewSchema, agentsTimelineSchema, runListSchema } from "@ncs/shared";
import { api } from "../../api/client.js";
import { queryKeys } from "../../api/query-keys.js";

/** Live roster / flow: polls faster than the default board interval (small payload). */
export const AGENTS_POLL_MS = 3_000;
/** Run swimlanes: larger payload, slower poll (running bars still grow every second from the local clock). */
export const AGENTS_TIMELINE_POLL_MS = 12_000;

export function useAgentsOverview(novelId: string) {
  return useQuery({
    queryKey: [...queryKeys.novel(novelId).all, "agents-overview"] as const,
    queryFn: async ({ signal }) => {
      const sentAt = Date.now();
      const data = await api.get(`/novels/${novelId}/agents/overview`, { signal, schema: agentsOverviewSchema });
      // server clock offset (midpoint of the request) so live elapsed times match server timestamps
      const receivedAt = Date.now();
      return { ...data, clockOffsetMs: new Date(data.now).getTime() - (sentAt + receivedAt) / 2 };
    },
    refetchInterval: AGENTS_POLL_MS,
    placeholderData: (prev) => prev,
  });
}

export function useAgentsTimeline(novelId: string, hours: number) {
  return useQuery({
    queryKey: [...queryKeys.novel(novelId).all, "agents-timeline", hours] as const,
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/agents/timeline`, { signal, schema: agentsTimelineSchema, query: { hours } }),
    refetchInterval: AGENTS_TIMELINE_POLL_MS,
    placeholderData: (prev) => prev,
  });
}

/** Runs of one task (run detail: error message, stop reason). Only fetched while a run is selected. */
export function useTaskRuns(novelId: string, taskId: string | null) {
  return useQuery({
    queryKey: [...queryKeys.novel(novelId).all, "agents-task-runs", taskId ?? "-"] as const,
    enabled: !!taskId,
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/tasks/${taskId}/runs`, { signal, schema: runListSchema }),
  });
}
