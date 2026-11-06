/** HTTP adapter of `cast` (`…` = /api/novels/:novelId; DTOs in @ncs/shared dto/cast.ts). */
import type { z } from "zod";
import {
  castDraftRequestSchema,
  castOrderRequestSchema,
  castParamsSchema,
  characterCreateRequestSchema,
  characterPatchRequestSchema,
  designSheetImageRequestSchema,
  designSheetPatchRequestSchema,
  designSheetPrimaryRequestSchema,
  designSheetPromptQuerySchema,
  type CastView,
  type CharacterDto,
  type DesignSheetView,
} from "@ncs/shared";
import type { ApiRouters } from "../../../../platform/index.js";
import { actorOf, created, scopeOf, valid, validate } from "../../../../http/kit.js";
import { generationView } from "../../../imaging/index.js";
import type { CastService, CastState, Character, DesignSheetState } from "../../index.js";

type P = { params: z.output<typeof castParamsSchema> };

const assetUrl = (assetId: string) => `/api/images/assets/${assetId}/file`;

export function characterView(c: Character, sheet?: { hasSheet: boolean; frontAssetId: string | null }, arcTitle?: string | null): CharacterDto {
  return {
    id: c.id,
    novelId: c.novelId,
    role: c.role,
    ord: c.ord,
    status: c.status,
    name: c.name,
    aliases: c.aliases ?? [],
    age: c.age,
    gender: c.gender,
    personality: c.personality,
    background: c.background,
    desire: c.desire,
    weakness: c.weakness,
    relationships: c.relationships ?? [],
    notes: c.notes,
    appearance: c.appearance,
    motivation: c.motivation,
    speechSample: c.speechSample,
    arcStart: c.arcStart,
    arcEnd: c.arcEnd,
    storyRole: c.storyRole,
    firstAppearanceEpisodeNo: c.firstAppearanceEpisodeNo,
    introducedArcId: c.introducedArcId,
    firstAppearanceArcTitle: arcTitle ?? null,
    fieldOrigins: c.fieldOrigins ?? {},
    proposed: c.proposed,
    conceptCharacterKey: c.conceptCharacterKey,
    entityId: c.entityId,
    confirmedAt: c.confirmedAt?.toISOString() ?? null,
    hasDesignSheet: sheet?.hasSheet ?? false,
    thumbnailUrl: sheet?.frontAssetId ? assetUrl(sheet.frontAssetId) : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function castView(s: CastState): CastView {
  return {
    items: s.items.map((c) => characterView(c, s.sheets.get(c.id), c.introducedArcId ? (s.arcTitles.get(c.introducedArcId) ?? null) : null)),
    confirmed: s.confirmed,
    blockers: s.blockers,
    counts: s.counts,
    stepRequired: s.stepRequired,
    goalSet: s.goalSet,
    pendingChanges: s.pendingChanges,
    canImportBrief: s.canImportBrief,
    draftTask: s.draftTask,
    lastDraftError: s.lastDraftError,
    completeness: s.completeness,
    plotCompleteness: s.plotCompleteness,
  };
}

export function sheetView(s: DesignSheetState): DesignSheetView {
  return {
    characterId: s.characterId,
    spec: s.spec,
    fieldOrigins: s.fieldOrigins,
    primaryImages: s.primaryImages,
    images: s.images.map((i) => ({ id: i.link.id, view: i.link.view, generation: generationView(i.generation), createdAt: i.link.createdAt.toISOString() })),
    referenceText: s.referenceText,
    draftTask: s.draftTask,
    updatedAt: s.updatedAt?.toISOString() ?? null,
  };
}

export function mountCastRoutes({ novel }: ApiRouters, svc: CastService): void {
  const one = async (res: Parameters<typeof scopeOf>[0], id: string) => {
    const scope = scopeOf(res);
    const c = await svc.getCharacter(scope, id);
    const s = (await svc.getCast(scope)).sheets.get(id);
    return characterView(c, s);
  };

  novel.get("/cast", async (_req, res) => {
    res.json(castView(await svc.getCast(scopeOf(res))));
  });
  novel.post("/cast/characters", validate({ body: characterCreateRequestSchema }), async (_req, res) => {
    const { body } = valid<{ body: z.output<typeof characterCreateRequestSchema> }>(res);
    const c = await svc.createCharacter(scopeOf(res), body, actorOf(res));
    created(res, characterView(c));
  });
  novel.patch("/cast/characters/:characterId", validate({ params: castParamsSchema, body: characterPatchRequestSchema }), async (_req, res) => {
    const { params, body } = valid<P & { body: z.output<typeof characterPatchRequestSchema> }>(res);
    await svc.updateCharacter(scopeOf(res), params.characterId, body, actorOf(res));
    res.json(await one(res, params.characterId));
  });
  novel.delete("/cast/characters/:characterId", validate({ params: castParamsSchema }), async (_req, res) => {
    const { params } = valid<P>(res);
    await svc.deleteCharacter(scopeOf(res), params.characterId, actorOf(res));
    res.status(204).end();
  });
  novel.post("/cast/characters/:characterId/accept", validate({ params: castParamsSchema }), async (_req, res) => {
    const { params } = valid<P>(res);
    await svc.acceptCharacter(scopeOf(res), params.characterId, actorOf(res));
    res.json(await one(res, params.characterId));
  });
  novel.put("/cast/order", validate({ body: castOrderRequestSchema }), async (_req, res) => {
    const { body } = valid<{ body: z.output<typeof castOrderRequestSchema> }>(res);
    await svc.reorder(scopeOf(res), body.ids, actorOf(res));
    res.json(castView(await svc.getCast(scopeOf(res))));
  });
  novel.post("/cast/import-brief", async (_req, res) => {
    await svc.importFromBrief(scopeOf(res), actorOf(res));
    res.json(castView(await svc.getCast(scopeOf(res))));
  });
  novel.post("/cast/draft", validate({ body: castDraftRequestSchema }), async (_req, res) => {
    const { body } = valid<{ body: z.output<typeof castDraftRequestSchema> }>(res);
    res.status(202).json(await svc.requestDraft(scopeOf(res), body, actorOf(res)));
  });
  novel.post("/cast/confirm", async (_req, res) => {
    res.json(castView(await svc.confirmCast(scopeOf(res), actorOf(res))));
  });

  // ── design sheet ──
  novel.get("/cast/characters/:characterId/design-sheet", validate({ params: castParamsSchema }), async (_req, res) => {
    const { params } = valid<P>(res);
    res.json(sheetView(await svc.getDesignSheet(scopeOf(res), params.characterId)));
  });
  novel.patch("/cast/characters/:characterId/design-sheet", validate({ params: castParamsSchema, body: designSheetPatchRequestSchema }), async (_req, res) => {
    const { params, body } = valid<P & { body: z.output<typeof designSheetPatchRequestSchema> }>(res);
    res.json(sheetView(await svc.updateDesignSheet(scopeOf(res), params.characterId, body, actorOf(res))));
  });
  novel.post("/cast/characters/:characterId/design-sheet/draft", validate({ params: castParamsSchema }), async (_req, res) => {
    const { params } = valid<P>(res);
    res.status(202).json(await svc.requestDesignSheetDraft(scopeOf(res), params.characterId, actorOf(res)));
  });
  novel.get("/cast/characters/:characterId/design-sheet/prompt", validate({ params: castParamsSchema, query: designSheetPromptQuerySchema }), async (_req, res) => {
    const { params, query } = valid<P & { query: z.output<typeof designSheetPromptQuerySchema> }>(res);
    res.json(await svc.buildSheetPrompt(scopeOf(res), params.characterId, query.view, query.outfitIndex));
  });
  novel.post("/cast/characters/:characterId/design-sheet/images", validate({ params: castParamsSchema, body: designSheetImageRequestSchema }), async (_req, res) => {
    const { params, body } = valid<P & { body: z.output<typeof designSheetImageRequestSchema> }>(res);
    const r = await svc.generateSheetImage(scopeOf(res), params.characterId, body, actorOf(res));
    res.status(202).json({ id: r.link.id, view: r.link.view, generation: generationView(r.generation), createdAt: r.link.createdAt.toISOString() });
  });
  novel.put("/cast/characters/:characterId/design-sheet/primary", validate({ params: castParamsSchema, body: designSheetPrimaryRequestSchema }), async (_req, res) => {
    const { params, body } = valid<P & { body: z.output<typeof designSheetPrimaryRequestSchema> }>(res);
    res.json(sheetView(await svc.selectPrimaryImage(scopeOf(res), params.characterId, body.view, body.assetId, actorOf(res))));
  });
}
