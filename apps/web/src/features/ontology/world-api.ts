/**
 * 세계관 온톨로지 후보 data hooks (`/api/novels/:novelId/world-ontology`, module world).
 * Polls fast while the generation task is queued / running; review mutations refresh the world view and entities.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { worldItemDtoSchema, worldOntologyViewSchema, worldReviewResultSchema, type WorldItemPatchRequest } from "@ncs/shared";
import { api } from "../../api/client.js";
import { POLL_INTERVAL_MS } from "../../api/query-client.js";
import { queryKeys } from "../../api/query-keys.js";

export const WORLD_FAST_POLL_MS = 2_000;
const base = (novelId: string) => `/novels/${novelId}/world-ontology`;

export function useWorldOntology(novelId: string) {
  return useQuery({
    queryKey: queryKeys.novel(novelId).world(),
    queryFn: ({ signal }) => api.get(base(novelId), { signal, schema: worldOntologyViewSchema }),
    refetchInterval: (q) => {
      const s = q.state.data?.generation.state;
      return s === "queued" || s === "running" ? WORLD_FAST_POLL_MS : POLL_INTERVAL_MS;
    },
  });
}

function useWorldMutation<TBody, TRes>(novelId: string, fn: (b: TBody) => Promise<TRes>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      const k = queryKeys.novel(novelId);
      void qc.invalidateQueries({ queryKey: k.world() });
      void qc.invalidateQueries({ queryKey: [...k.all, "entities"] });
      void qc.invalidateQueries({ queryKey: k.activity() });
    },
  });
}

export function useGenerateWorld(novelId: string) {
  return useWorldMutation(novelId, (b: { instructions?: string }) => api.post<{ taskId: string; created: boolean }>(`${base(novelId)}/generate`, b));
}

export function useApproveAllWorld(novelId: string) {
  return useWorldMutation(novelId, () => api.post(`${base(novelId)}/approve-all`, {}, { schema: worldReviewResultSchema }));
}

export function useApproveWorldItem(novelId: string) {
  return useWorldMutation(novelId, (itemId: string) => api.post(`${base(novelId)}/items/${itemId}/approve`, {}, { schema: worldReviewResultSchema }));
}

export function useRejectWorldItem(novelId: string) {
  return useWorldMutation(novelId, (b: { itemId: string; reason?: string }) => api.post(`${base(novelId)}/items/${b.itemId}/reject`, { reason: b.reason }, { schema: worldReviewResultSchema }));
}

export function useEditWorldItem(novelId: string) {
  return useWorldMutation(novelId, (b: { itemId: string; patch: WorldItemPatchRequest }) => api.patch(`${base(novelId)}/items/${b.itemId}`, b.patch, { schema: worldItemDtoSchema }));
}
