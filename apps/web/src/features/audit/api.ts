/** Audit timeline data hooks (CONVENTIONS §13 activity, 08 §9.7). */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { activityDtoSchema, type ActivityDto, type ActivityPageDto } from "@ncs/shared";
import { api } from "../../api/client.js";
import { POLL_INTERVAL_MS } from "../../api/query-client.js";
import { queryKeys } from "../../api/query-keys.js";
import { normalizeList } from "../novels/api.js";

/** Tolerant page parser: one malformed row must not hide the whole timeline. */
const activityPageSchema = {
  parse(data: unknown): ActivityPageDto {
    const d = (data ?? {}) as { nextCursor?: unknown; latestSeq?: unknown };
    return {
      items: normalizeList(data, activityDtoSchema),
      nextCursor: typeof d.nextCursor === "string" ? d.nextCursor : typeof d.nextCursor === "number" ? String(d.nextCursor) : null,
      latestSeq: typeof d.latestSeq === "number" ? d.latestSeq : 0,
    };
  },
};

export interface ActivityFilter {
  actorType?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  actionPrefix?: string;
}

export const PAGE_SIZE = 50;

function clean(f: ActivityFilter): ActivityFilter {
  const out: ActivityFilter = {};
  for (const [k, v] of Object.entries(f) as Array<[keyof ActivityFilter, string | undefined]>) if (v && v.trim()) out[k] = v.trim();
  return out;
}

/** Older pages via `beforeSeq = nextCursor` (seq DESC). */
export function useActivityPages(novelId: string, filter: ActivityFilter) {
  const f = clean(filter);
  return useInfiniteQuery({
    queryKey: queryKeys.novel(novelId).activity({ ...f, kind: "pages" }),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get(`/novels/${novelId}/activity`, { schema: activityPageSchema, signal, query: { ...f, beforeSeq: pageParam, limit: PAGE_SIZE } }),
    getNextPageParam: (last: ActivityPageDto) => last.nextCursor ?? undefined,
    refetchOnWindowFocus: false,
  });
}

/** Poll for events newer than `afterSeq` (`afterSeq = latestSeq`). */
export function useActivitySince(novelId: string, filter: ActivityFilter, afterSeq: number | undefined, enabled: boolean) {
  const f = clean(filter);
  return useQuery({
    queryKey: queryKeys.novel(novelId).activity({ ...f, kind: "since", afterSeq }),
    enabled: enabled && afterSeq !== undefined,
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/activity`, { schema: activityPageSchema, signal, query: { ...f, afterSeq, limit: 200 } }),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

/** Merge new head events + paged events, newest first, no duplicates. */
export function mergeActivity(head: readonly ActivityDto[], pages: readonly ActivityDto[]): ActivityDto[] {
  const seen = new Set<number>();
  const out: ActivityDto[] = [];
  for (const a of [...head, ...pages]) {
    if (seen.has(a.seq)) continue;
    seen.add(a.seq);
    out.push(a);
  }
  return out.sort((a, b) => b.seq - a.seq);
}

/**
 * Short "before → after" summary of changed top-level keys (values are already masked server-side).
 */
export function summarizeChange(before: unknown, after: unknown, max = 4): Array<{ key: string; from: string; to: string }> {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const fmt = (v: unknown): string => {
    if (v === undefined) return "—";
    if (v === null) return "없음";
    if (typeof v === "string") return v.length > 60 ? `${v.slice(0, 60)}…` : v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) return v.length <= 3 ? v.map(fmt).join(", ") : `${v.length}개`;
    const s = JSON.stringify(v);
    return s.length > 60 ? `${s.slice(0, 60)}…` : s;
  };
  if (!isObj(before) && !isObj(after)) {
    if (before === null && after === null) return [];
    if (before === undefined && after === undefined) return [];
    return [{ key: "", from: fmt(before), to: fmt(after) }];
  }
  const b = isObj(before) ? before : {};
  const a = isObj(after) ? after : {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const out: Array<{ key: string; from: string; to: string }> = [];
  for (const k of keys) {
    if (JSON.stringify(b[k]) === JSON.stringify(a[k])) continue;
    out.push({ key: k, from: fmt(b[k]), to: fmt(a[k]) });
    if (out.length >= max) break;
  }
  return out;
}

/** Bulk events (`mention.batch_linked`): `details: { ids, count }`. */
export function bulkInfo(details: unknown): { count: number; ids: string[] } | null {
  if (!details || typeof details !== "object") return null;
  const d = details as { ids?: unknown; count?: unknown };
  const ids = Array.isArray(d.ids) ? d.ids.filter((x): x is string => typeof x === "string") : [];
  const count = typeof d.count === "number" ? d.count : ids.length;
  if (!count && ids.length === 0) return null;
  return { count, ids };
}

export type { ActivityDto };
