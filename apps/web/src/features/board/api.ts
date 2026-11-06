import { useMutation, useQuery } from "@tanstack/react-query";
import { taskDtoSchema, type TaskDto, type TaskStatus } from "@ncs/shared";
import { api } from "../../api/client.js";
import { POLL_INTERVAL_MS } from "../../api/query-client.js";
import { queryKeys } from "../../api/query-keys.js";
import { listOf, useInvalidateNovel } from "../novels/api.js";

export interface TaskFilter {
  status?: TaskStatus[];
  includeCancelled?: boolean;
  agentRole?: string;
}

export function useTasks(novelId: string, filter: TaskFilter = {}, opts: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.novel(novelId).tasks({ ...filter }),
    queryFn: ({ signal }) =>
      api.get(`/novels/${novelId}/tasks`, {
        signal,
        schema: listOf(taskDtoSchema),
        query: {
          status: filter.status?.length ? filter.status.join(",") : undefined,
          includeCancelled: filter.includeCancelled ? "true" : undefined,
          agentRole: filter.agentRole,
        },
      }),
    refetchInterval: opts.poll === false ? false : POLL_INTERVAL_MS,
  });
}

export type TaskAction = "retry" | "cancel" | "pause" | "resume";

export function useTaskAction(novelId: string) {
  const invalidate = useInvalidateNovel(novelId);
  return useMutation({
    mutationFn: (args: { taskId: string; action: TaskAction }) => api.post<TaskDto>(`/novels/${novelId}/tasks/${args.taskId}/${args.action}`, {}),
    onSuccess: () => void invalidate(),
  });
}

/** Which actions make sense for a status (server re-checks; 409 on invalid transition). */
export function allowedActions(t: TaskDto): TaskAction[] {
  if (t.status === "done" || t.status === "cancelled") return [];
  if (t.status === "failed") return ["retry", "cancel"];
  return [t.pausedAt !== null ? "resume" : "pause", "cancel"];
}

export const TASK_ACTION_LABEL: Record<TaskAction, string> = { retry: "재시도", cancel: "취소", pause: "일시정지", resume: "재개" };
