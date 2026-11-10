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
 *   POST  …/arcs/:arcId/retitle             → 202 { taskId } — [제목 정리] 제안 만들기(설계 추가 0023)
 *   GET   …/arcs/:arcId/retitle             → retitleProposalViewSchema (진행 중 작업·대기 중 제안·전→후)
 *   POST  …/arcs/:arcId/retitle/apply       → retitleApplyResultSchema (공개된 화는 고른 것만, 확인 필요)
 *
 * 구성 생성 작업이 도는 동안에는 빠르게 polling합니다. 변경은 작품 전체를 invalidate합니다(홈 단계 카드·인박스·원고 목록).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  arcDtoSchema,
  retitleApplyResultSchema,
  retitleProposalViewSchema,
  storyStructureDtoSchema,
  structureTaskAcceptedSchema,
  structureViewSchema,
  type ArcReplanRequest,
  type HitlApprovalDecision,
  type RetitleApplyRequest,
  type RetitleProposalView,
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

// ── 설계 추가 0023: [제목 정리] (에피소드 묶음 "제목 (1)(2)") ──
export function retitleKey(novelId: string, arcId: string) {
  return [...queryKeys.novel(novelId).all, "retitle", arcId] as const;
}

/** the proposal task is running (poll fast) */
export function retitleRunning(v: RetitleProposalView | undefined): boolean {
  return !!v?.task;
}

export function useRetitle(novelId: string, arcId: string) {
  return useQuery({
    queryKey: retitleKey(novelId, arcId),
    queryFn: ({ signal }) => api.get(`${base(novelId)}/arcs/${arcId}/retitle`, { signal, schema: retitleProposalViewSchema }),
    refetchInterval: (q) => (retitleRunning(q.state.data) ? STRUCTURE_FAST_POLL_MS : POLL_INTERVAL_MS),
  });
}

export function useProposeRetitle(novelId: string) {
  return useNovelMutation(novelId, ({ arcId, note }: { arcId: string; note?: string }) =>
    api.post(`${base(novelId)}/arcs/${arcId}/retitle`, note?.trim() ? { note: note.trim() } : {}, { schema: structureTaskAcceptedSchema }),
  );
}

export function useApplyRetitle(novelId: string) {
  return useNovelMutation(novelId, ({ arcId, body }: { arcId: string; body: RetitleApplyRequest }) =>
    api.post(`${base(novelId)}/arcs/${arcId}/retitle/apply`, body, { schema: retitleApplyResultSchema }),
  );
}
