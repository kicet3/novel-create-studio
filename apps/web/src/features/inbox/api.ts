import { useMutation, useQuery } from "@tanstack/react-query";
import {
  hitlApprovalDtoSchema,
  hitlInboxSummarySchema,
  hitlQuestionDtoSchema,
  hitlQuestionViewSchema,
  type HitlAnswerRequest,
  type HitlAnswerResult,
  type HitlQuestionView,
  type QuestionStatus,
} from "@ncs/shared";
import { api } from "../../api/client.js";
import { AMBIENT_POLL_INTERVAL_MS, POLL_INTERVAL_MS } from "../../api/query-client.js";
import { queryKeys } from "../../api/query-keys.js";
import { listOf, useInvalidateNovel, type SafeParser } from "../novels/api.js";

/** Validate when possible, but never hide data because of schema drift (logs in dev). */
function lenient<T>(schema: SafeParser<T>) {
  return {
    parse(input: unknown): T {
      const r = schema.safeParse(input);
      if (r.success) return r.data;
      if (import.meta.env.DEV) console.warn("[ncs] response failed validation; using raw data", input);
      return input as T;
    },
  };
}

export const OPEN_STATUSES: QuestionStatus[] = ["pending", "open"];
export const CLOSED_STATUSES: QuestionStatus[] = ["answered", "resolved", "defaulted", "cancelled"];

export function useInboxSummary(novelId: string, poll = true) {
  return useQuery({
    queryKey: queryKeys.novel(novelId).inbox({ summary: true }),
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/inbox/summary`, { signal, schema: lenient(hitlInboxSummarySchema) }),
    refetchInterval: poll ? POLL_INTERVAL_MS : AMBIENT_POLL_INTERVAL_MS,
  });
}

export function useQuestions(novelId: string, statuses: QuestionStatus[]) {
  return useQuery({
    queryKey: queryKeys.novel(novelId).inbox({ statuses }),
    enabled: statuses.length > 0,
    queryFn: ({ signal }) =>
      api.get(`/novels/${novelId}/questions`, { signal, schema: listOf(hitlQuestionDtoSchema), query: { status: statuses.join(","), limit: 200 } }),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function usePendingApprovals(novelId: string) {
  return useQuery({
    queryKey: queryKeys.novel(novelId).inbox({ approvals: "pending" }),
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/approvals`, { signal, schema: listOf(hitlApprovalDtoSchema), query: { status: "pending" } }),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useQuestionView(novelId: string, questionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.novel(novelId).question(questionId ?? "-"),
    enabled: !!questionId,
    queryFn: ({ signal }) => api.get<HitlQuestionView>(`/novels/${novelId}/questions/${questionId}`, { signal, schema: lenient(hitlQuestionViewSchema) }),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

function requestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/** Answer (Q3). Pending questions are opened first (Q2(b) "지금 답하기"). */
export function useAnswerQuestion(novelId: string) {
  const invalidate = useInvalidateNovel(novelId);
  return useMutation({
    mutationFn: async (args: { questionId: string; status: QuestionStatus; body: Omit<HitlAnswerRequest, "requestId"> }) => {
      if (args.status === "pending") await api.post(`/novels/${novelId}/questions/${args.questionId}/open`, {});
      return api.post<HitlAnswerResult>(`/novels/${novelId}/questions/${args.questionId}/answers`, { ...args.body, requestId: requestId() });
    },
    onSettled: () => void invalidate(),
  });
}

export function useResolveLateAnswer(novelId: string) {
  const invalidate = useInvalidateNovel(novelId);
  return useMutation({
    mutationFn: (answerId: string) => api.post(`/novels/${novelId}/answers/${answerId}/late-resolution`, { resolution: "dismissed" }),
    onSettled: () => void invalidate(),
  });
}

/** approval row embedded in the question view (`approval` is unknown in the DTO) */
export function approvalOf(view: HitlQuestionView): { id: string; approvalType: string; status: string; payload: unknown } | null {
  const a = view.approval;
  if (a && typeof a === "object" && "approvalType" in a && "id" in a) return a as { id: string; approvalType: string; status: string; payload: unknown };
  return null;
}
