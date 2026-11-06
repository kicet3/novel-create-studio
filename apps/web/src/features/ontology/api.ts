/** Ontology data hooks (CONVENTIONS §13 온톨로지, 08 §9.5). */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  entityDetailDtoSchema,
  entityListItemDtoSchema,
  entityRedirectDtoSchema,
  factAtAnchorDtoSchema,
  identityDecisionDtoSchema,
  identityImpactDtoSchema,
  mentionDtoSchema,
  ontologySchemaDtoSchema,
  timelineDtoSchema,
  type AddEntityNameRequest,
  type CreateEntityRequest,
  type EntityDetailDto,
  type EntityListItemDto,
  type FactAtAnchorDto,
  type IdentityDecisionDto,
  type MentionDto,
  type TimelineDto,
} from "@ncs/shared";
import { api } from "../../api/client.js";
import { queryKeys } from "../../api/query-keys.js";
import { listOf, normalizeList } from "../novels/api.js";

const k = (novelId: string) => queryKeys.novel(novelId);

export interface EntityFilter {
  type?: string[];
  status?: string[];
  q?: string;
  limit?: number;
}

const entityList = listOf<EntityListItemDto>(entityListItemDtoSchema);

export function useEntities(novelId: string, filter: EntityFilter) {
  return useQuery({
    queryKey: k(novelId).entities({ ...filter }),
    queryFn: ({ signal }) =>
      api
        .get(`/novels/${novelId}/entities`, {
          schema: entityList,
          signal,
          query: {
            type: filter.type?.length ? filter.type.join(",") : undefined,
            status: filter.status?.length ? filter.status.join(",") : undefined,
            q: filter.q?.trim() || undefined,
            limit: filter.limit,
          },
        })
        .then((d) => d.items),
    placeholderData: (prev) => prev,
  });
}

/** All entities (any status) → id → display name, for resolving ids shown in detail views. */
export function useEntityNames(novelId: string) {
  const q = useEntities(novelId, { status: ["candidate", "active", "merged", "retired"], limit: 500 });
  const map = new Map<string, string>();
  for (const it of q.data ?? []) map.set(it.entity.id, it.entity.disambiguator ? `${it.preferredName}(${it.entity.disambiguator})` : it.preferredName);
  return map;
}

export type EntityDetailResult = { kind: "detail"; detail: EntityDetailDto } | { kind: "redirect"; redirectTo: string; redirectedFrom: string };

export function useEntityDetail(novelId: string, entityId: string | undefined) {
  return useQuery({
    queryKey: k(novelId).entity(entityId ?? "-"),
    enabled: !!entityId,
    queryFn: async ({ signal }): Promise<EntityDetailResult> => {
      const data = await api.get<unknown>(`/novels/${novelId}/entities/${entityId}`, { signal });
      const redirect = entityRedirectDtoSchema.safeParse(data);
      if (redirect.success && !(data as { entity?: unknown }).entity) return { kind: "redirect", ...redirect.data };
      return { kind: "detail", detail: entityDetailDtoSchema.parse(data) };
    },
  });
}

export function useEntityFacts(
  novelId: string,
  entityId: string,
  opts: { storyPoint?: number; timelineId?: string; include?: "canon" | "canon_and_safe_candidates" },
  enabled: boolean,
) {
  return useQuery({
    queryKey: [...k(novelId).entity(entityId), "facts", opts],
    enabled,
    queryFn: ({ signal }) =>
      api
        .get(`/novels/${novelId}/entities/${entityId}/facts`, {
          signal,
          query: { storyPoint: opts.storyPoint, timelineId: opts.timelineId, include: opts.include },
        })
        .then((d) => normalizeList<FactAtAnchorDto>(d, factAtAnchorDtoSchema)),
    placeholderData: (prev) => prev,
  });
}

export function useEntityMentions(novelId: string, entityId: string, linkStatus: string[]) {
  return useQuery({
    queryKey: [...k(novelId).entity(entityId), "mentions", linkStatus],
    queryFn: ({ signal }) =>
      api
        .get(`/novels/${novelId}/entities/${entityId}/mentions`, {
          signal,
          query: { linkStatus: linkStatus.length ? linkStatus.join(",") : undefined, limit: 500 },
        })
        .then((d) => normalizeList<MentionDto>(d, mentionDtoSchema)),
  });
}

export function useTimelines(novelId: string) {
  return useQuery({
    queryKey: [...k(novelId).all, "timelines"],
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/timelines`, { signal }).then((d) => normalizeList<TimelineDto>(d, timelineDtoSchema)),
    staleTime: 60_000,
  });
}

export function useOntologySchema(novelId: string) {
  return useQuery({
    queryKey: [...k(novelId).all, "ontology-schema"],
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/schema`, { schema: ontologySchemaDtoSchema, signal }),
    staleTime: 300_000,
    retry: false,
  });
}

export function useIdentityDecisions(novelId: string, entityId: string) {
  return useQuery({
    queryKey: [...k(novelId).entity(entityId), "identity-decisions"],
    queryFn: ({ signal }) =>
      api
        .get(`/novels/${novelId}/identity-decisions`, { signal, query: { entityId } })
        .then((d) => normalizeList<IdentityDecisionDto>(d, identityDecisionDtoSchema)),
  });
}

export function useIdentityImpact(novelId: string, decisionId: string | null) {
  return useQuery({
    queryKey: [...k(novelId).all, "identity-impact", decisionId ?? "-"],
    enabled: !!decisionId,
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/identity-decisions/${decisionId}/impact`, { schema: identityImpactDtoSchema, signal }),
  });
}

function useOntologyMutation<TBody, TRes>(novelId: string, fn: (b: TBody) => Promise<TRes>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...k(novelId).all, "entities"] });
      void qc.invalidateQueries({ queryKey: k(novelId).activity() });
    },
  });
}

export function useRevertIdentityDecision(novelId: string) {
  return useOntologyMutation(novelId, (b: { id: string; reason?: string }) =>
    api.post(`/novels/${novelId}/identity-decisions/${b.id}/revert`, { reason: b.reason }),
  );
}

export function useCreateEntity(novelId: string) {
  return useOntologyMutation(novelId, (b: CreateEntityRequest) =>
    api.post<{ entity: { id: string }; similar?: Array<{ entityId?: string; score?: number }> }>(`/novels/${novelId}/entities`, b),
  );
}

export function useAddEntityName(novelId: string, entityId: string) {
  return useOntologyMutation(novelId, (b: AddEntityNameRequest) => api.post(`/novels/${novelId}/entities/${entityId}/names`, b));
}

/** int4range literal "[0,)" / "[3,10)" → "0화~" style label (story points). */
export function formatRangeLiteral(lit: string): string {
  const m = /^([[(])\s*(-?\d*)\s*,\s*(-?\d*)\s*([)\]])$/.exec(lit.trim());
  if (!m) return lit === "empty" ? "없음" : lit;
  const from = m[2] ? Number(m[2]) + (m[1] === "(" ? 1 : 0) : null;
  const to = m[3] ? Number(m[3]) - (m[4] === ")" ? 1 : 0) : null;
  return formatRange({ from: from ?? 0, to });
}

/** `{from, to}` (to exclusive-or-null as returned by the API) → "시점 3~10" / "시점 3~". */
export function formatRange(r: { from: number; to: number | null }): string {
  if (r.to === null) return `시점 ${r.from}~`;
  if (r.to === r.from) return `시점 ${r.from}`;
  return `시점 ${r.from}~${r.to}`;
}

export type { EntityDetailDto, EntityListItemDto, FactAtAnchorDto, IdentityDecisionDto, MentionDto, TimelineDto };
