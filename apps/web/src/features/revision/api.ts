/** 화별 수정 대화 data hooks (설계 추가 0018, `…/episodes/:episodeNo/revision-chat`). */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  revisionChatViewSchema,
  type RevisionChatView,
  type RevisionCloseRequest,
  type RevisionPostMessageRequest,
  type RevisionProposalDecisionRequest,
  type RevisionRewriteRequest,
} from "@ncs/shared";
import { api } from "../../api/client.js";
import { queryKeys } from "../../api/query-keys.js";

/** polling while a turn is queued / running (the SSE stream shows the live text) */
export const TURN_POLL_MS = 2500;

export const revisionChatKey = (novelId: string, episodeNo: number) => [...queryKeys.novel(novelId).episode(episodeNo), "revision-chat"] as const;
const base = (novelId: string, episodeNo: number) => `/novels/${novelId}/episodes/${episodeNo}/revision-chat`;

export function useRevisionChat(novelId: string, episodeNo: number) {
  return useQuery({
    queryKey: revisionChatKey(novelId, episodeNo),
    queryFn: ({ signal }) => api.get(base(novelId, episodeNo), { schema: revisionChatViewSchema, signal }),
    refetchInterval: (q) => (q.state.data?.turn ? TURN_POLL_MS : false),
  });
}

function useChatMutation<TBody>(novelId: string, episodeNo: number, fn: (body: TBody) => Promise<unknown>, opts: { episode?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      const parsed = revisionChatViewSchema.safeParse(data);
      if (parsed.success) qc.setQueryData<RevisionChatView>(revisionChatKey(novelId, episodeNo), parsed.data);
      void qc.invalidateQueries({ queryKey: revisionChatKey(novelId, episodeNo) });
      if (opts.episode) {
        void qc.invalidateQueries({ queryKey: queryKeys.novel(novelId).episodes() });
        void qc.invalidateQueries({ queryKey: queryKeys.novel(novelId).home() });
        void qc.invalidateQueries({ queryKey: [...queryKeys.novel(novelId).all, "versions"] });
      }
    },
  });
}

export const usePostRevisionMessage = (novelId: string, episodeNo: number) =>
  useChatMutation(novelId, episodeNo, (body: RevisionPostMessageRequest) => api.post(`${base(novelId, episodeNo)}/messages`, body));

export const useDecideRevisionProposal = (novelId: string, episodeNo: number) =>
  useChatMutation(novelId, episodeNo, ({ id, ...body }: RevisionProposalDecisionRequest & { id: string }) => api.post(`${base(novelId, episodeNo)}/proposals/${id}/decision`, body), { episode: true });

export const useCloseRevisionChat = (novelId: string, episodeNo: number) =>
  useChatMutation(novelId, episodeNo, (body: RevisionCloseRequest) => api.post(`${base(novelId, episodeNo)}/close`, body));

export const useRewriteFromChat = (novelId: string, episodeNo: number) =>
  useChatMutation(novelId, episodeNo, (body: RevisionRewriteRequest) => api.post(`${base(novelId, episodeNo)}/rewrite`, body), { episode: true });

export const useStopRevisionTurn = (novelId: string, episodeNo: number) =>
  useChatMutation(novelId, episodeNo, (_: void) => api.post(`${base(novelId, episodeNo)}/stop-turn`, {}));

export const revisionStreamPath = (novelId: string, episodeNo: number) => `${base(novelId, episodeNo)}/stream`;
