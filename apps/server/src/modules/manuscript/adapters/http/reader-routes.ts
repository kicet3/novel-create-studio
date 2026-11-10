/**
 * HTTP adapter of 읽기(reader): read-only, no editing. `…` = /api/novels/:novelId (DTOs: @ncs/shared dto/reader.ts)
 *
 *   GET …/reader/toc                                       → ReaderTocDto
 *   GET …/reader/episodes/:episodeNo?mode=approved|draft   → ReaderEpisodeDto (404 not_readable)
 *
 * Counts come from the stored version counts in the novel's count basis (no body loaded for the TOC).
 */
import type { z } from "zod";
import { READER_SCENE_BREAK, episodeNoParamsSchema, readerEpisodeQuerySchema, type CountBasis, type ReaderEpisodeDto, type ReaderMode, type ReaderTocDto } from "@ncs/shared";
import { AppError, type ApiRouters, type Db, type NovelScope } from "../../../../platform/index.js";
import { scopeOf, valid, validate } from "../../../../http/kit.js";
import { approvedRef, buildReadingText, draftRef, readRef } from "../../domain/reader.js";
import { readerQueries, type VersionMeta } from "../db/reader-queries.js";
import type { Episode, EpisodeUnitInfo, ManuscriptService } from "../../index.js";
import type { NovelService } from "../../../novel/index.js";

export interface ReaderRouteDeps {
  service: ManuscriptService;
  novel: NovelService;
  db: Db;
}

const countOf = (m: VersionMeta, basis: CountBasis) => (basis === "without_spaces" ? m.charCountWithoutSpaces : m.charCountWithSpaces);

async function loadEpisodes(deps: ReaderRouteDeps, scope: NovelScope) {
  // 설계 추가 0023: unit fields (에피소드 묶음) for the TOC grouping data
  const episodes = await deps.service.withUnitInfo(scope, await deps.service.listEpisodes(scope));
  const ids = episodes.flatMap((e) => [e.currentVersionId, e.approvedVersionId, e.publishedVersionId]).filter((x): x is string => !!x);
  const meta = await readerQueries.versionMeta(deps.db, scope, ids);
  const kindOf = (id: string) => meta.get(id)?.kind;
  return { episodes, meta, kindOf };
}

export function mountReaderRoutes({ novel }: ApiRouters, deps: ReaderRouteDeps): void {
  novel.get("/reader/toc", async (_req, res) => {
    const scope = scopeOf(res);
    const [n, profile, structure, arcs, loaded, units] = await Promise.all([
      deps.novel.getNovel(scope),
      deps.novel.getLengthProfile(scope),
      deps.novel.getStructure(scope),
      deps.novel.listArcs(scope),
      loadEpisodes(deps, scope),
      deps.service.listEpisodeUnits(scope),
    ]);
    const basis = profile.countBasis;
    const body: ReaderTocDto = {
      novelId: scope.novelId,
      title: n.title,
      countBasis: basis,
      parts: (structure?.parts ?? []).map((p) => ({ id: p.id, ord: p.ord, title: p.title })).sort((a, b) => a.ord - b.ord),
      plots: arcs.map((a) => ({ id: a.id, ord: a.ord, title: a.title, partId: a.partId ?? null })).sort((a, b) => a.ord - b.ord),
      episodes: loaded.episodes.map((e) => {
        const ap = approvedRef(e);
        const apMeta = ap ? loaded.meta.get(ap.versionId) : undefined;
        const dr = draftRef(e, loaded.kindOf);
        const drMeta = dr ? loaded.meta.get(dr.versionId) : undefined;
        return {
          episodeNo: e.episodeNo,
          title: e.title,
          status: e.status,
          arcId: e.arcId,
          approved: ap && apMeta ? { source: ap.source, charCount: countOf(apMeta, basis) } : null,
          draft: drMeta ? { charCount: countOf(drMeta, basis) } : null,
          unitId: e.unitId,
          unitTitle: e.unitTitle,
          unitPartNo: e.unitPartNo,
          unitPartCount: e.unitPartCount,
        };
      }),
      units: units.map((u) => ({ id: u.id, arcId: u.arcId, title: u.title, ord: u.ord, episodeNos: u.episodeNos })),
    };
    res.json(body);
  });

  novel.get("/reader/episodes/:episodeNo", validate({ params: episodeNoParamsSchema, query: readerEpisodeQuerySchema }), async (_req, res) => {
    const { params, query } = valid<{ params: z.output<typeof episodeNoParamsSchema>; query: z.output<typeof readerEpisodeQuerySchema> }>(res);
    const scope = scopeOf(res);
    const mode: ReaderMode = query.mode;
    const [profile, loaded] = await Promise.all([deps.novel.getLengthProfile(scope), loadEpisodes(deps, scope)]);
    const readable = loaded.episodes
      .map((e) => ({ e, ref: readRef(e, mode, loaded.kindOf) }))
      .filter((x): x is { e: Episode & EpisodeUnitInfo; ref: NonNullable<typeof x.ref> } => !!x.ref && loaded.meta.has(x.ref.versionId));
    const i = readable.findIndex((x) => x.e.episodeNo === params.episodeNo);
    if (i < 0) {
      if (!loaded.episodes.some((e) => e.episodeNo === params.episodeNo)) throw new AppError(404, "not_found", "화를 찾을 수 없습니다.");
      throw new AppError(404, "not_readable", mode === "approved" ? "아직 승인된 원고가 없는 화입니다." : "읽을 수 있는 원고가 없는 화입니다.");
    }
    const { e, ref } = readable[i]!;
    const version = await deps.service.getVersion(scope, ref.versionId);
    const scenes = (await deps.service.listScenes(scope, e.id, { versionId: version.id, includeRetired: true })).filter((s) => s.manuscriptVersionId === version.id);
    const text = buildReadingText(version.content, scenes.map((s) => s.charStart));
    // never skip silently: list the existing-but-unreadable episodes between this one and the neighbour
    const between = (a: number, b: number) =>
      loaded.episodes
        .map((x) => x.episodeNo)
        .filter((no) => no > Math.min(a, b) && no < Math.max(a, b))
        .sort((x, y) => x - y);
    const neighbor = (x: (typeof readable)[number] | undefined) =>
      x ? { episodeNo: x.e.episodeNo, title: x.e.title, skipped: between(e.episodeNo, x.e.episodeNo) } : null;
    const body: ReaderEpisodeDto = {
      episodeNo: e.episodeNo,
      title: e.title,
      status: e.status,
      source: ref.source,
      versionId: version.id,
      versionNo: version.versionNo,
      versionCreatedAt: version.createdAt.toISOString(),
      countBasis: profile.countBasis,
      charCount: countOf(loaded.meta.get(version.id)!, profile.countBasis),
      sceneCount: text ? text.split("\n").filter((l) => l === READER_SCENE_BREAK).length + 1 : 0,
      text,
      prev: neighbor(readable[i - 1]),
      next: neighbor(readable[i + 1]),
      unitTitle: e.unitTitle,
      unitPartNo: e.unitPartNo,
      unitPartCount: e.unitPartCount,
    };
    res.json(body);
  });
}
