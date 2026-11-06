/**
 * 전체 구성(1~4부 + 결말) → 플롯 → 화 data hooks.
 *
 *   GET   …/structure                       → structureViewSchema (manuscript)
 *   POST  …/structure/generate              → 202 { taskId }
 *   POST  …/structure/decision              → structureViewSchema
 *   PATCH …/structure/ending                → storyStructureDtoSchema (novel)
 *   PATCH …/structure/parts/:partId         → storyStructureDtoSchema (novel)
 *   POST  …/arcs/:arcId/replan              → 202 { taskId }
 *   POST  …/arcs/:arcId/acknowledge-flags   → arcDtoSchema
 *   POST  …/approvals/:approvalId/decision  → 플롯 계획·재계획 승인/반려(인박스와 같은 hitl 경로)
 *
 * 구성 생성 작업이 도는 동안에는 빠르게 polling합니다. 변경은 작품 전체를 invalidate합니다(홈 단계 카드·인박스·원고 목록).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  arcDtoSchema,
  storyStructureDtoSchema,
  structureTaskAcceptedSchema,
  structureViewSchema,
  type ArcReplanRequest,
  type HitlApprovalDecision,
  type StructureDecisionRequest,
  type StructureGenerateRequest,
  type StructureView,
  type UpdateStoryPartRequest,
  type UpdateStructureEndingRequest,
} from "@ncs/shared";
import { api } from "../../api/client.js";
import { POLL_INTERVAL_MS } from "../../api/query-client.js";
import { queryKeys } from "../../api/query-keys.js";

export const STRUCTURE_FAST_POLL_MS = 1_500;

const base = (novelId: string) => `/novels/${novelId}`;

/** the plan_structure task is still running (poll fast) */
export function hasRunningWork(v: StructureView | undefined): boolean {
  return !!v?.task;
}

export function useStructure(novelId: string) {
  return useQuery({
    queryKey: queryKeys.novel(novelId).structure(),
    queryFn: ({ signal }) => api.get(`${base(novelId)}/structure`, { signal, schema: structureViewSchema }),
    refetchInterval: (q) => (hasRunningWork(q.state.data) ? STRUCTURE_FAST_POLL_MS : POLL_INTERVAL_MS),
  });
}

function useNovelMutation<A, R>(novelId: string, fn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => void qc.invalidateQueries({ queryKey: queryKeys.novel(novelId).all }),
  });
}

export function useGenerateStructure(novelId: string) {
  return useNovelMutation(novelId, (body: StructureGenerateRequest) =>
    api.post(`${base(novelId)}/structure/generate`, body, { schema: structureTaskAcceptedSchema }),
  );
}

export function useStructureDecision(novelId: string) {
  return useNovelMutation(novelId, (body: StructureDecisionRequest) =>
    api.post(`${base(novelId)}/structure/decision`, body, { schema: structureViewSchema }),
  );
}

export function useUpdateEnding(novelId: string) {
  return useNovelMutation(novelId, (body: UpdateStructureEndingRequest) =>
    api.patch(`${base(novelId)}/structure/ending`, body, { schema: storyStructureDtoSchema }),
  );
}

export function useUpdatePart(novelId: string) {
  return useNovelMutation(novelId, ({ partId, body }: { partId: string; body: UpdateStoryPartRequest }) =>
    api.patch(`${base(novelId)}/structure/parts/${partId}`, body, { schema: storyStructureDtoSchema }),
  );
}

export function useReplanArc(novelId: string) {
  return useNovelMutation(novelId, ({ arcId, body }: { arcId: string; body: ArcReplanRequest }) =>
    api.post(`${base(novelId)}/arcs/${arcId}/replan`, body, { schema: structureTaskAcceptedSchema }),
  );
}

export function useAcknowledgeArcFlags(novelId: string) {
  return useNovelMutation(novelId, (arcId: string) => api.post(`${base(novelId)}/arcs/${arcId}/acknowledge-flags`, {}, { schema: arcDtoSchema }));
}

/** 플롯 계획(arc_plan) 승인·반려 — 인박스와 같은 hitl 결정 경로 */
export function usePlotDecision(novelId: string) {
  return useNovelMutation(novelId, ({ approvalId, body }: { approvalId: string; body: HitlApprovalDecision }) => api.post(`${base(novelId)}/approvals/${approvalId}/decision`, body));
}
