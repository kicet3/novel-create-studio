/** Manuscript data hooks (CONVENTIONS §13 원고 · 내보내기). */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  arcDtoSchema,
  continuityIssueDtoSchema,
  episodeDetailDtoSchema,
  episodeDtoSchema,
  episodeRejectionDtoSchema,
  exportJobDtoSchema,
  manuscriptVersionDetailDtoSchema,
  manuscriptVersionDtoSchema,
  manuscriptVersionSummaryDtoSchema,
  setupBeatDtoSchema,
  type ArcDto,
  type ContinuityIssueDto,
  type CreateExportRequest,
  type EpisodeDto,
  type ExportJobDto,
  type HumanEditRequest,
  type ManuscriptVersionDetailDto,
  type ManuscriptVersionSummaryDto,
  type RevisionRequest,
  type SetupBeatDto,
  type UnpublishRequest,
} from "@ncs/shared";
import { api, apiUrl } from "../../api/client.js";
import { queryKeys } from "../../api/query-keys.js";
import { listOf, normalizeList, type SafeParser } from "../novels/api.js";

const episodeList = listOf<EpisodeDto>(episodeDtoSchema);
const arcList = listOf<ArcDto>(arcDtoSchema);
const versionList = listOf<ManuscriptVersionSummaryDto>(manuscriptVersionSummaryDtoSchema);

/** Continuity issue as returned by the version annotator (row + displayLabel). */
export type IssueAnnotation = ContinuityIssueDto;
export type BeatAnnotation = SetupBeatDto;

export interface VersionDetail extends Omit<ManuscriptVersionDetailDto, "issues" | "beats"> {
  /** null = continuity module has no annotator yet (준비 중) */
  issues: IssueAnnotation[] | null;
  beats: BeatAnnotation[] | null;
}

const issueParser = continuityIssueDtoSchema.passthrough() as unknown as SafeParser<IssueAnnotation>;
const beatParser = setupBeatDtoSchema.passthrough() as unknown as SafeParser<BeatAnnotation>;

const versionDetailParser = {
  parse(data: unknown): VersionDetail {
    const base = manuscriptVersionDetailDtoSchema.parse(data);
    return {
      ...base,
      issues: base.issues == null ? null : normalizeList(base.issues, issueParser),
      beats: base.beats == null ? null : normalizeList(base.beats, beatParser),
    };
  },
};

const mk = (novelId: string) => queryKeys.novel(novelId);

export function useArcs(novelId: string) {
  return useQuery({
    queryKey: [...mk(novelId).all, "arcs"],
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/arcs`, { schema: arcList, signal }).then((d) => d.items),
  });
}

export function useEpisodes(novelId: string) {
  return useQuery({
    queryKey: [...mk(novelId).episodes(), "list"],
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/episodes`, { schema: episodeList, signal }).then((d) => d.items),
  });
}

export function useEpisode(novelId: string, episodeNo: number) {
  return useQuery({
    queryKey: [...mk(novelId).episode(episodeNo), "detail"],
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/episodes/${episodeNo}`, { schema: episodeDetailDtoSchema, signal }),
  });
}

export function useVersions(novelId: string, episodeNo: number) {
  return useQuery({
    queryKey: [...mk(novelId).episode(episodeNo), "versions"],
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/episodes/${episodeNo}/versions`, { schema: versionList, signal }).then((d) => d.items),
  });
}

export function useRejections(novelId: string, episodeNo: number) {
  return useQuery({
    queryKey: [...mk(novelId).episode(episodeNo), "rejections"],
    queryFn: ({ signal }) =>
      api
        .get(`/novels/${novelId}/episodes/${episodeNo}/rejections`, { signal })
        .then((d) => normalizeList(d, episodeRejectionDtoSchema)),
    retry: false,
  });
}

export const FULL_VERSION_WITH = "spans,scenes,issues,beats";

export function useVersionDetail(novelId: string, versionId: string | null | undefined, withParts: string = FULL_VERSION_WITH) {
  return useQuery({
    queryKey: [...mk(novelId).all, "versions", versionId ?? "-", withParts],
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/versions/${versionId}`, { schema: versionDetailParser, signal, query: { with: withParts } }),
    enabled: !!versionId,
    staleTime: 60_000,
  });
}

function useEpisodeMutation<TBody, TRes>(novelId: string, fn: (body: TBody) => Promise<TRes>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: mk(novelId).episodes() });
      void qc.invalidateQueries({ queryKey: mk(novelId).home() });
      void qc.invalidateQueries({ queryKey: mk(novelId).activity() });
      void qc.invalidateQueries({ queryKey: [...mk(novelId).all, "versions"] });
    },
  });
}

export function useSaveHumanEdit(novelId: string, episodeNo: number) {
  return useEpisodeMutation(novelId, (body: HumanEditRequest) =>
    api.post(`/novels/${novelId}/episodes/${episodeNo}/versions`, body, { schema: manuscriptVersionDtoSchema }),
  );
}

export function useRevisionRequest(novelId: string, episodeNo: number) {
  return useEpisodeMutation(novelId, (body: RevisionRequest) => api.post(`/novels/${novelId}/episodes/${episodeNo}/revision-request`, body));
}

export function usePublish(novelId: string, episodeNo: number) {
  return useEpisodeMutation(novelId, (_: void) => api.post(`/novels/${novelId}/episodes/${episodeNo}/publish`, {}, { schema: episodeDtoSchema }));
}

export function useUnpublish(novelId: string, episodeNo: number) {
  return useEpisodeMutation(novelId, (body: UnpublishRequest) =>
    api.post(`/novels/${novelId}/episodes/${episodeNo}/unpublish`, body, { schema: episodeDtoSchema }),
  );
}

export function usePauseEpisode(novelId: string, episodeNo: number) {
  return useEpisodeMutation(novelId, (pause: boolean) =>
    api.post(`/novels/${novelId}/episodes/${episodeNo}/${pause ? "pause" : "resume"}`, {}, { schema: episodeDtoSchema }),
  );
}

export function useCreateExport(novelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateExportRequest) => api.post(`/novels/${novelId}/exports`, body, { schema: exportJobDtoSchema }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...mk(novelId).all, "exports"] }),
  });
}

export function exportDownloadUrl(novelId: string, exportId: string): string {
  return apiUrl(`/novels/${novelId}/exports/${exportId}/download`);
}

export type { ArcDto, EpisodeDto, ExportJobDto, ManuscriptVersionSummaryDto };
