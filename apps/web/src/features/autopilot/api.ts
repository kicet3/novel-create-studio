/** 설계 추가 0014 — 완전 자율 진행 data hooks (`…/autopilot`). */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { autopilotViewSchema, type AutopilotHaltRequest, type AutopilotSettingsPatch, type AutopilotView } from "@ncs/shared";
import { api } from "../../api/client.js";
import { queryKeys } from "../../api/query-keys.js";

const POLL_MS = 10_000;

/** tolerant of server drift: an invalid body is used as is (dev warns) */
const lenientView = {
  parse(input: unknown): AutopilotView {
    const r = autopilotViewSchema.safeParse(input);
    if (r.success) return r.data;
    if (import.meta.env.DEV) console.warn("[ncs] autopilot view failed validation; using raw data", input);
    return input as AutopilotView;
  },
};

export function useAutopilot(novelId: string, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.novel(novelId).autopilot(),
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/autopilot`, { signal, schema: lenientView }),
    enabled: opts.enabled ?? true,
    refetchInterval: POLL_MS,
  });
}

function useAutopilotMutation<B>(novelId: string, fn: (body: B) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.novel(novelId).all }),
  });
}

export const useUpdateAutopilotSettings = (novelId: string) =>
  useAutopilotMutation(novelId, (body: AutopilotSettingsPatch) => api.patch(`/novels/${novelId}/autopilot/settings`, body));
export const useHaltAutopilot = (novelId: string) => useAutopilotMutation(novelId, (body: AutopilotHaltRequest) => api.post(`/novels/${novelId}/autopilot/halt`, body));
export const useResumeAutopilot = (novelId: string) => useAutopilotMutation(novelId, (_: void) => api.post(`/novels/${novelId}/autopilot/resume`));
