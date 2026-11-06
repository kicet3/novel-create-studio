import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  conceptMessageDtoSchema,
  conceptSessionViewDtoSchema,
  type ConceptEntryMode,
  type ConceptMessageDto,
  type ConceptPostMessageRequest,
  type ConceptSessionViewDto,
} from "@ncs/shared";
import { api } from "../../api/client.js";
import { POLL_INTERVAL_MS } from "../../api/query-client.js";
import { queryKeys } from "../../api/query-keys.js";
import { normalizeList, useInvalidateNovel, type SafeParser } from "../novels/api.js";

/** fast poll while an agent turn is in flight (11 §4.1 web chat) */
export const TURN_POLL_MS = 1_500;

function lenient<T>(schema: SafeParser<T>) {
  return {
    parse(input: unknown): T {
      const r = schema.safeParse(input);
      if (r.success) return r.data;
      if (import.meta.env.DEV) console.warn("[ncs] concept response failed validation; using raw data", input);
      return input as T;
    },
  };
}

const viewParser = lenient(conceptSessionViewDtoSchema);

export function useConceptSession(novelId: string) {
  return useQuery({
    queryKey: [...queryKeys.novel(novelId).concept(), "session"],
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/concept/session`, { signal }).then((d) => (d ? viewParser.parse(d) : null)),
    refetchInterval: (q) => (q.state.data?.session.inFlightTaskId || q.state.data?.titleSuggestions?.refreshing ? TURN_POLL_MS : POLL_INTERVAL_MS),
  });
}

export function useConceptMessages(novelId: string, sessionId: string | undefined, fast: boolean) {
  return useQuery({
    queryKey: [...queryKeys.novel(novelId).concept(), "messages", sessionId ?? "-"],
    enabled: !!sessionId,
    queryFn: ({ signal }) =>
      api
        .get(`/novels/${novelId}/concept/sessions/${sessionId}/messages`, { signal, query: { limit: 500 } })
        .then((d) => normalizeList<ConceptMessageDto>(d, conceptMessageDtoSchema).sort((a, b) => a.seq - b.seq)),
    refetchInterval: fast ? TURN_POLL_MS : POLL_INTERVAL_MS,
  });
}

/** Every concept mutation refreshes the session view + messages (and the novel: N2 may have happened). */
function useConceptMutation<A, R>(novelId: string, fn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  const invalidateNovel = useInvalidateNovel(novelId);
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      if (data && typeof data === "object" && "session" in data && "workingBrief" in data) {
        qc.setQueryData([...queryKeys.novel(novelId).concept(), "session"], viewParser.parse(data));
      }
    },
    onSettled: () => void invalidateNovel(),
  });
}

const base = (novelId: string, sessionId: string) => `/novels/${novelId}/concept/sessions/${sessionId}`;

export function usePostConceptMessage(novelId: string, sessionId: string) {
  return useConceptMutation(novelId, (body: ConceptPostMessageRequest) => api.post(`${base(novelId, sessionId)}/messages`, body));
}

export function useEditBrief(novelId: string, sessionId: string) {
  return useConceptMutation(novelId, (body: { path: string; value: unknown }) => api.patch<ConceptSessionViewDto>(`${base(novelId, sessionId)}/brief`, body));
}

/** 추천 제목을 고르거나 고쳐서/직접 입력해 확정 (title_source=user) → SessionView */
export function useChooseTitle(novelId: string, sessionId: string) {
  return useConceptMutation(novelId, (title: string) => api.post<ConceptSessionViewDto>(`${base(novelId, sessionId)}/title`, { title }));
}

/** "다른 추천 받기" → 202 `{taskId}`; the session view polls fast while `titleSuggestions.refreshing` */
export function useRefreshTitleSuggestions(novelId: string, sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ taskId: string }>(`${base(novelId, sessionId)}/title-suggestions`, {}),
    onSettled: () => void qc.invalidateQueries({ queryKey: [...queryKeys.novel(novelId).concept(), "session"] }),
  });
}

export function useConfirmFields(novelId: string, sessionId: string) {
  return useConceptMutation(novelId, (body: { which: "imported" | "delegated" } | { paths: string[] }) =>
    api.post<ConceptSessionViewDto>(`${base(novelId, sessionId)}/confirm`, body),
  );
}

export function useDecideProposal(novelId: string, sessionId: string) {
  return useConceptMutation(novelId, (a: { proposalId: string; decision: "accepted" | "rejected" }) =>
    api.post<ConceptSessionViewDto>(`${base(novelId, sessionId)}/change-proposals/${encodeURIComponent(a.proposalId)}`, { decision: a.decision }),
  );
}

export type SessionCommand = "pause" | "resume" | "submit";

export function useSessionCommand(novelId: string, sessionId: string) {
  return useConceptMutation(novelId, (cmd: SessionCommand) => api.post(`${base(novelId, sessionId)}/${cmd}`, cmd === "pause" ? { reason: "user" } : {}));
}

export function useExtendSession(novelId: string, sessionId: string) {
  return useConceptMutation(novelId, (body: { turns?: boolean; budgetMicros?: number }) => api.post(`${base(novelId, sessionId)}/extend`, body));
}

export function useSwitchEntryMode(novelId: string, sessionId: string) {
  return useConceptMutation(novelId, (mode: ConceptEntryMode) => api.post(`${base(novelId, sessionId)}/entry-mode`, { mode }));
}

export function useAbandonSession(novelId: string, sessionId: string) {
  return useConceptMutation(novelId, (restart: boolean) => api.post(`${base(novelId, sessionId)}/abandon`, { restart }));
}

export function useStartRevision(novelId: string) {
  return useConceptMutation(novelId, () => api.post(`/novels/${novelId}/concept/revisions`, {}));
}
