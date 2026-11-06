/** HTTP adapter of `manuscript` (CONVENTIONS §13 원고). */
import { z } from "zod";
import {
  episodeListQuerySchema,
  episodeNoParamsSchema,
  humanEditRequestSchema,
  revisionRequestSchema,
  sceneListQuerySchema,
  unpublishRequestSchema,
  versionDetailQuerySchema,
  versionIdParamsSchema,
} from "@ncs/shared";
import type { ApiRouters } from "../../../../platform/index.js";
import { actorOf, created, scopeOf, valid, validate } from "../../../../http/kit.js";
import { checkLength } from "../../domain/text.js";
import type { ManuscriptService, ManuscriptVersion } from "../../index.js";
import type { NovelService } from "../../../novel/index.js";

type P = { params: z.output<typeof episodeNoParamsSchema> };

export function summarizeVersion(v: ManuscriptVersion) {
  const { content, outlineData: _o, writerAnnotations: _w, attributionSpans: _a, ...rest } = v;
  return { ...rest, contentPreview: content.slice(0, 160) };
}

export function mountManuscriptRoutes({ novel }: ApiRouters, svc: ManuscriptService, novels: NovelService): void {
  novel.get("/episodes", validate({ query: episodeListQuerySchema }), async (_req, res) => {
    const { query } = valid<{ query: z.output<typeof episodeListQuerySchema> }>(res);
    res.json({ items: await svc.listEpisodes(scopeOf(res), { arcId: query.arcId, statuses: query.status }) });
  });
  novel.get("/reserve", async (_req, res) => {
    res.json(await svc.reserveSummary(scopeOf(res)));
  });
  novel.get("/episodes/:episodeNo", validate({ params: episodeNoParamsSchema }), async (_req, res) => {
    const { params } = valid<P>(res);
    const scope = scopeOf(res);
    const ep = await svc.getEpisodeByNo(scope, params.episodeNo);
    const current = ep.currentVersionId ? await svc.getVersion(scope, ep.currentVersionId) : null;
    const profile = current ? await novels.getLengthProfile(scope) : null;
    res.json({
      ...ep,
      currentVersion: current ? summarizeVersion(current) : null,
      length: current && profile ? checkLength(current.content, profile) : null,
    });
  });
  novel.get("/episodes/:episodeNo/versions", validate({ params: episodeNoParamsSchema }), async (_req, res) => {
    const { params } = valid<P>(res);
    const scope = scopeOf(res);
    const ep = await svc.getEpisodeByNo(scope, params.episodeNo);
    res.json({ items: (await svc.listVersions(scope, ep.id)).map(summarizeVersion) });
  });
  novel.get("/episodes/:episodeNo/rejections", validate({ params: episodeNoParamsSchema }), async (_req, res) => {
    const { params } = valid<P>(res);
    const scope = scopeOf(res);
    const ep = await svc.getEpisodeByNo(scope, params.episodeNo);
    res.json({ items: await svc.listRejections(scope, ep.id) });
  });
  novel.get("/episodes/:episodeNo/scenes", validate({ params: episodeNoParamsSchema, query: sceneListQuerySchema }), async (_req, res) => {
    const { params, query } = valid<P & { query: z.output<typeof sceneListQuerySchema> }>(res);
    const scope = scopeOf(res);
    const ep = await svc.getEpisodeByNo(scope, params.episodeNo);
    res.json({ items: await svc.listScenes(scope, ep.id, { includeRetired: query.includeRetired, versionId: query.versionId }) });
  });
  novel.get("/versions/:versionId", validate({ params: versionIdParamsSchema, query: versionDetailQuerySchema }), async (_req, res) => {
    const { params, query } = valid<{ params: z.output<typeof versionIdParamsSchema>; query: z.output<typeof versionDetailQuerySchema> }>(res);
    res.json(await svc.getVersionDetail(scopeOf(res), params.versionId, query.with ?? ["spans"]));
  });
  novel.post("/episodes/:episodeNo/versions", validate({ params: episodeNoParamsSchema, body: humanEditRequestSchema }), async (_req, res) => {
    const { params, body } = valid<P & { body: z.output<typeof humanEditRequestSchema> }>(res);
    created(res, await svc.saveHumanEdit(scopeOf(res), params.episodeNo, body, actorOf(res)));
  });
  novel.post("/episodes/:episodeNo/revision-request", validate({ params: episodeNoParamsSchema, body: revisionRequestSchema }), async (_req, res) => {
    const { params, body } = valid<P & { body: z.output<typeof revisionRequestSchema> }>(res);
    created(res, await svc.requestRevision(scopeOf(res), params.episodeNo, body, actorOf(res)));
  });
  novel.post("/episodes/:episodeNo/publish", validate({ params: episodeNoParamsSchema }), async (_req, res) => {
    const { params } = valid<P>(res);
    const scope = scopeOf(res);
    const ep = await svc.getEpisodeByNo(scope, params.episodeNo);
    res.json(await svc.publishEpisode(scope, ep.id, actorOf(res)));
  });
  novel.post("/episodes/:episodeNo/unpublish", validate({ params: episodeNoParamsSchema, body: unpublishRequestSchema }), async (_req, res) => {
    const { params, body } = valid<P & { body: z.output<typeof unpublishRequestSchema> }>(res);
    const scope = scopeOf(res);
    const ep = await svc.getEpisodeByNo(scope, params.episodeNo);
    res.json(await svc.unpublishEpisode(scope, ep.id, body, actorOf(res)));
  });
  for (const action of ["pause", "resume"] as const) {
    novel.post(`/episodes/:episodeNo/${action}`, validate({ params: episodeNoParamsSchema }), async (_req, res) => {
      const { params } = valid<P>(res);
      const scope = scopeOf(res);
      const ep = await svc.getEpisodeByNo(scope, params.episodeNo);
      res.json(await svc.setEpisodePaused(scope, ep.id, action === "pause", actorOf(res)));
    });
  }
  novel.post("/planning/schedule", async (_req, res) => {
    res.json(await svc.schedule(scopeOf(res)));
  });
}
