/** Image tab data hooks (`/api/images/...`, module imaging). Generations are polled every 2 s while one is open. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  imageGenerationDtoSchema,
  imageGenerationListSchema,
  imageProviderListSchema,
  type CreateImageGenerationRequest,
  type ImageGenerationDto,
} from "@ncs/shared";
import { api } from "../../api/client.js";
import { queryKeys } from "../../api/query-keys.js";

/** under the install "providers" key so provider-connection changes refresh it too */
const PROVIDERS_KEY = [...queryKeys.installSettings, "providers", "images"] as const;
const GENERATIONS_KEY = ["images", "generations"] as const;

export const isOpenGeneration = (g: Pick<ImageGenerationDto, "status">) => g.status === "queued" || g.status === "running";

export function useImageProviders() {
  return useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: ({ signal }) => api.get("/images/providers", { signal, schema: imageProviderListSchema }).then((r) => r.items),
  });
}

/** `novelId` → that novel's generations; none → install-level ones */
export function useImageGenerations(novelId: string | undefined, limit: number) {
  return useQuery({
    queryKey: [...GENERATIONS_KEY, novelId ?? "install", limit],
    queryFn: ({ signal }) => api.get("/images/generations", { signal, query: { novelId, limit }, schema: imageGenerationListSchema }),
    refetchInterval: (q) => (q.state.data?.items.some(isOpenGeneration) ? 2_000 : false),
  });
}

function useGenerationsMutation<A, R>(fn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => void qc.invalidateQueries({ queryKey: GENERATIONS_KEY }),
  });
}

export function useCreateImageGeneration() {
  return useGenerationsMutation((body: CreateImageGenerationRequest) => api.post("/images/generations", body, { schema: imageGenerationDtoSchema }));
}

export function useCancelImageGeneration() {
  return useGenerationsMutation((id: string) => api.post(`/images/generations/${id}/cancel`, {}, { schema: imageGenerationDtoSchema }));
}

export function useDeleteImageGeneration() {
  return useGenerationsMutation((id: string) => api.delete(`/images/generations/${id}`));
}

/** 2 → "$0.04"; null → null */
export function estimateText(microsPerImage: number | null | undefined, count: number): number | null {
  if (microsPerImage === null || microsPerImage === undefined) return null;
  return microsPerImage * count;
}
