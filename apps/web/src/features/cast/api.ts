/**
 * 캐릭터 설정 단계 data hooks (`/api/novels/:novelId/cast/...`, module cast).
 * The cast view polls fast while an AI draft task runs; a design sheet polls while its draft task or an image
 * generation is open.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  castTaskAcceptedSchema,
  castViewSchema,
  characterDtoSchema,
  designSheetImageDtoSchema,
  designSheetPromptSchema,
  designSheetViewSchema,
  type CastDraftRequest,
  type CharacterCreateRequest,
  type CharacterPatchRequest,
  type CharacterSheetView,
  type DesignSheetImageRequest,
  type DesignSheetPatchRequest,
  type DesignSheetView,
} from "@ncs/shared";
import { api } from "../../api/client.js";
import { POLL_INTERVAL_MS } from "../../api/query-client.js";
import { queryKeys } from "../../api/query-keys.js";

export const CAST_FAST_POLL_MS = 1_500;

const castKey = (novelId: string) => queryKeys.novel(novelId).cast();
const sheetKey = (novelId: string, characterId: string) => [...castKey(novelId), "sheet", characterId] as const;
const base = (novelId: string) => `/novels/${novelId}/cast`;

export function useCast(novelId: string) {
  return useQuery({
    queryKey: castKey(novelId),
    queryFn: ({ signal }) => api.get(base(novelId), { signal, schema: castViewSchema }),
    refetchInterval: (q) => (q.state.data?.draftTask ? CAST_FAST_POLL_MS : POLL_INTERVAL_MS),
  });
}

/** cast mutations refresh the whole novel (home step card, goal guard) */
function useCastMutation<A, R>(novelId: string, fn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => void qc.invalidateQueries({ queryKey: queryKeys.novel(novelId).all }),
  });
}

export function useCreateCharacter(novelId: string) {
  return useCastMutation(novelId, (body: CharacterCreateRequest) => api.post(`${base(novelId)}/characters`, body, { schema: characterDtoSchema }));
}

export function useUpdateCharacter(novelId: string, characterId: string) {
  return useCastMutation(novelId, (body: CharacterPatchRequest) => api.patch(`${base(novelId)}/characters/${characterId}`, body, { schema: characterDtoSchema }));
}

export function useDeleteCharacter(novelId: string) {
  return useCastMutation(novelId, (characterId: string) => api.delete(`${base(novelId)}/characters/${characterId}`));
}

export function useAcceptCharacter(novelId: string) {
  return useCastMutation(novelId, (characterId: string) => api.post(`${base(novelId)}/characters/${characterId}/accept`, {}, { schema: characterDtoSchema }));
}

export function useReorderCast(novelId: string) {
  return useCastMutation(novelId, (ids: string[]) => api.put(`${base(novelId)}/order`, { ids }, { schema: castViewSchema }));
}

export function useImportBrief(novelId: string) {
  return useCastMutation(novelId, () => api.post(`${base(novelId)}/import-brief`, {}, { schema: castViewSchema }));
}

export function useRequestCastDraft(novelId: string) {
  return useCastMutation(novelId, (body: CastDraftRequest) => api.post(`${base(novelId)}/draft`, body, { schema: castTaskAcceptedSchema }));
}

export function useConfirmCast(novelId: string) {
  return useCastMutation(novelId, () => api.post(`${base(novelId)}/confirm`, {}, { schema: castViewSchema }));
}

// ── design sheet ──
const hasOpenWork = (s: DesignSheetView | undefined) => !!s && (!!s.draftTask || s.images.some((i) => i.generation.status === "queued" || i.generation.status === "running"));

export function useDesignSheet(novelId: string, characterId: string) {
  return useQuery({
    queryKey: sheetKey(novelId, characterId),
    queryFn: ({ signal }) => api.get(`${base(novelId)}/characters/${characterId}/design-sheet`, { signal, schema: designSheetViewSchema }),
    refetchInterval: (q) => (hasOpenWork(q.state.data) ? 2_000 : false),
  });
}

function useSheetMutation<A, R>(novelId: string, characterId: string, fn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      const parsed = designSheetViewSchema.safeParse(data);
      if (parsed.success) qc.setQueryData(sheetKey(novelId, characterId), parsed.data);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: sheetKey(novelId, characterId) });
      void qc.invalidateQueries({ queryKey: castKey(novelId), exact: true });
    },
  });
}

export function useUpdateDesignSheet(novelId: string, characterId: string) {
  return useSheetMutation(novelId, characterId, (body: DesignSheetPatchRequest) =>
    api.patch(`${base(novelId)}/characters/${characterId}/design-sheet`, body, { schema: designSheetViewSchema }),
  );
}

export function useDesignSheetDraft(novelId: string, characterId: string) {
  return useSheetMutation(novelId, characterId, () => api.post(`${base(novelId)}/characters/${characterId}/design-sheet/draft`, {}, { schema: castTaskAcceptedSchema }));
}

export function useGenerateSheetImage(novelId: string, characterId: string) {
  return useSheetMutation(novelId, characterId, (body: DesignSheetImageRequest) =>
    api.post(`${base(novelId)}/characters/${characterId}/design-sheet/images`, body, { schema: designSheetImageDtoSchema }),
  );
}

export function useSelectPrimaryImage(novelId: string, characterId: string) {
  return useSheetMutation(novelId, characterId, (body: { view: CharacterSheetView; assetId: string | null }) =>
    api.put(`${base(novelId)}/characters/${characterId}/design-sheet/primary`, body, { schema: designSheetViewSchema }),
  );
}

export function useSheetPrompt(novelId: string, characterId: string, view: CharacterSheetView, outfitIndex: number, enabled: boolean) {
  return useQuery({
    queryKey: [...sheetKey(novelId, characterId), "prompt", view, outfitIndex],
    enabled,
    queryFn: ({ signal }) =>
      api.get(`${base(novelId)}/characters/${characterId}/design-sheet/prompt`, { signal, query: { view, outfitIndex }, schema: designSheetPromptSchema }),
  });
}
