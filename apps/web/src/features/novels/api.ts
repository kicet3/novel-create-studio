/**
 * Novel-level data hooks shared by the novel screens (home, concept, board, inbox, settings).
 * Other feature folders may import these (read-only consumers).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  goalDtoSchema,
  lengthProfileDtoSchema,
  novelDtoSchema,
  userDtoSchema,
  type ChangeAutonomyRequest,
  type CreateNovelRequest,
  type GoalDto,
  type NovelDto,
  type SaveGoalRequest,
  type UpdateNovelSettingsRequest,
} from "@ncs/shared";
import { api } from "../../api/client.js";
import { queryKeys } from "../../api/query-keys.js";

/** Structural validator (zod schemas satisfy it); web has no direct zod dependency. */
export interface SafeParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

/** `{ items: T[] }` parser built from an item schema; invalid items are dropped (tolerant of server drift). */
export function listOf<T>(item: SafeParser<T>) {
  return { parse: (data: unknown): { items: T[] } => ({ items: normalizeList(data, item) }) };
}

const novelListSchema = listOf<NovelDto>(novelDtoSchema);

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: ({ signal }) => api.get("/me", { schema: userDtoSchema, signal }), staleTime: 60_000 });
}

export function useNovels(includeArchived = false) {
  return useQuery({
    queryKey: [...queryKeys.novels.list(), { includeArchived }],
    queryFn: ({ signal }) => api.get("/novels", { schema: novelListSchema, signal, query: { includeArchived: includeArchived || undefined } }),
  });
}

export function useNovel(novelId: string) {
  return useQuery({
    queryKey: queryKeys.novel(novelId).detail(),
    queryFn: ({ signal }) => api.get(`/novels/${novelId}`, { schema: novelDtoSchema, signal }),
  });
}

export function useCreateNovel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateNovelRequest) => api.post("/novels", body, { schema: novelDtoSchema }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.novels.all }),
  });
}

/** Invalidate everything under one novel (after any mutation on it). */
export function useInvalidateNovel(novelId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: queryKeys.novel(novelId).all });
}

export function useUpdateNovel(novelId: string) {
  const invalidate = useInvalidateNovel(novelId);
  return useMutation({
    mutationFn: (body: UpdateNovelSettingsRequest) => api.patch(`/novels/${novelId}`, body, { schema: novelDtoSchema }),
    onSuccess: () => void invalidate(),
  });
}

export function useChangeAutonomy(novelId: string) {
  const invalidate = useInvalidateNovel(novelId);
  return useMutation({
    mutationFn: (body: ChangeAutonomyRequest) => api.put(`/novels/${novelId}/autonomy`, body),
    onSuccess: () => void invalidate(),
  });
}

export function usePauseNovel(novelId: string) {
  const invalidate = useInvalidateNovel(novelId);
  return useMutation({
    mutationFn: (args: { pause: boolean; reason?: string }) =>
      args.pause ? api.post(`/novels/${novelId}/pause`, { reason: args.reason }) : api.post(`/novels/${novelId}/resume`, {}),
    onSuccess: () => void invalidate(),
  });
}

export function useGoal(novelId: string) {
  return useQuery({
    queryKey: [...queryKeys.novel(novelId).all, "goal"],
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/goal`, { schema: goalDtoSchema.nullable(), signal }),
  });
}

export function useSaveGoal(novelId: string) {
  const invalidate = useInvalidateNovel(novelId);
  return useMutation({
    mutationFn: (body: SaveGoalRequest) => api.put<GoalDto>(`/novels/${novelId}/goal`, body),
    onSuccess: () => void invalidate(),
  });
}

export function useLengthProfiles() {
  return useQuery({
    queryKey: ["length-profiles"],
    queryFn: ({ signal }) => api.get("/length-profiles", { signal }).then((d) => normalizeList(d, lengthProfileDtoSchema)),
    staleTime: 300_000,
  });
}

/** Accept `{items}` or a bare array. */
export function normalizeList<T>(data: unknown, schema: SafeParser<T>): T[] {
  const arr = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items : [];
  const out: T[] = [];
  for (const it of arr) {
    const r = schema.safeParse(it);
    if (r.success) out.push(r.data);
    else if (import.meta.env.DEV) console.warn("[ncs] dropped list item that failed validation", it);
  }
  return out;
}

export type { NovelDto };
