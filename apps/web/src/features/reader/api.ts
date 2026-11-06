/** 읽기(reader) data hooks — read-only (GET …/reader/toc, …/reader/episodes/:no). */
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { readerEpisodeDtoSchema, readerTocDtoSchema, type ReaderMode } from "@ncs/shared";
import { api } from "../../api/client.js";
import { queryKeys } from "../../api/query-keys.js";

const readerKey = (novelId: string) => [...queryKeys.novel(novelId).all, "reader"] as const;

export function useReaderToc(novelId: string) {
  return useQuery({
    queryKey: [...readerKey(novelId), "toc"],
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/reader/toc`, { schema: readerTocDtoSchema, signal }),
    staleTime: 30_000,
  });
}

const episodeQuery = (novelId: string, episodeNo: number, mode: ReaderMode) => ({
  queryKey: [...readerKey(novelId), "episode", episodeNo, mode],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api.get(`/novels/${novelId}/reader/episodes/${episodeNo}`, { schema: readerEpisodeDtoSchema, signal, query: { mode } }),
  staleTime: 60_000,
  retry: false,
});

export function useReaderEpisode(novelId: string, episodeNo: number, mode: ReaderMode) {
  return useQuery({ ...episodeQuery(novelId, episodeNo, mode), placeholderData: keepPreviousData });
}

/** one episode without placeholder data (sections of 다음 화 이어 보기) */
export function useReaderEpisodeExact(novelId: string, episodeNo: number, mode: ReaderMode) {
  return useQuery(episodeQuery(novelId, episodeNo, mode));
}

/** warm the next episode so 다음화 opens instantly */
export function usePrefetchReaderEpisode(novelId: string) {
  const qc = useQueryClient();
  return (episodeNo: number, mode: ReaderMode) => void qc.prefetchQuery(episodeQuery(novelId, episodeNo, mode));
}
