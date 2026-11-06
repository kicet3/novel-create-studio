/**
 * cast application layer: use cases, the N2 seeding hook, the goal guard, task handlers (draft_cast,
 * draft_design_sheet), ontology sync on confirm and the `cast` context section text.
 */
import { z } from "zod";
import {
  DESIGN_SHEET_FIELDS,
  designSheetSpecSchema,
  labelKo,
  type CharacterRole,
  type CharacterSheetView,
  type DesignSheetSpec,
} from "@ncs/shared";
import type { CharacterRelationshipJson, CharactersInsert } from "@ncs/db/schema";
import {
  actors,
  ConflictError,
  DomainValidationError,
  NotFoundError,
  type ActorRef,
  type NovelScope,
  type Platform,
  type Tx,
} from "../../../platform/index.js";
import type { AuditService } from "../../audit/index.js";
import type { ConceptService } from "../../concept/index.js";
import type { ImagingService, ImageGenerationWithAssets } from "../../imaging/index.js";
import type { LlmService } from "../../llm/index.js";
import type { NovelService, NovelStatusChangedContext } from "../../novel/index.js";
import type { CandidateFactDraft, OntologyService } from "../../ontology/index.js";
import type { OrchestrationService, TaskKindHandler } from "../../orchestration/index.js";
import type { CastService, CastState, Character, DesignSheetState } from "../index.js";
import { castRepo as repo } from "../adapters/db/repository.js";
import {
  agentWritable,
  castBlockers,
  castCounts,
  cleanAliases,
  isCastConfirmed,
  isEmptyValue,
  mergeOrigins,
  normalizeName,
  originsFor,
  parseAge,
  relationPredicate,
  ROLE_ORDER,
  seedFromBrief,
  sortCast,
  type CharacterProfile,
  type FieldOrigins,
} from "../domain/cast.js";
import { buildViewPrompt, normalizeSpec, referenceText as sheetReferenceText, specIsEmpty, VIEW_ASPECT } from "../domain/design-sheet.js";
import {
  castDraftProposalSchema,
  DRAFT_CAST_TEMPLATE_ID,
  DRAFT_SHEET_TEMPLATE_ID,
  renderCastDraftPrompt,
  renderSheetDraftPrompt,
  sheetDraftProposalSchema,
  type CastDraftProposal,
  type SheetDraftProposal,
} from "./prompts.js";

export interface CastServiceDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  ontology: OntologyService;
  orchestration: OrchestrationService;
  llm: LlmService;
  concept: ConceptService;
  imaging: ImagingService;
}

const ACTIVE_TASK = ["pending", "ready", "running", "blocked"] as const;
const MAX_DRAFT_CHARACTERS = 16;
const PROFILE_TEXT_LIMIT: Record<string, number> = { name: 80, age: 40, gender: 40, personality: 2000, background: 4000, desire: 2000, weakness: 2000, notes: 4000 };

const draftInputSchema = z.object({
  requested_by_user_id: z.string(),
  sub_protagonist_count: z.number().int().min(0).max(10).nullable(),
  include_antagonist: z.boolean(),
  instructions: z.string(),
});
type DraftInput = z.infer<typeof draftInputSchema>;
const sheetInputSchema = z.object({ character_id: z.string(), requested_by_user_id: z.string() });
type SheetInput = z.infer<typeof sheetInputSchema>;

const target = (id: string) => ({ type: "character" as const, id });
const ROLE_ORDER_INDEX = (r: CharacterRole) => ROLE_ORDER.indexOf(r);
const clip = (s: string, n: number) => s.trim().slice(0, n);

function profileOf(c: Character): CharacterProfile {
  return {
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
  };
}

export function createCastService(deps: CastServiceDeps) {
  const { platform, audit, novel, ontology, orchestration, llm, concept, imaging } = deps;
  const { uow, ids, clock } = platform;
  const db = (tx?: Tx) => tx?.db ?? uow.db;

  const mustCharacter = async (tx: Tx | undefined, scope: NovelScope, id: string, forUpdate = false) => {
    const c = await repo.get(db(tx), scope, id, forUpdate && !!tx);
    if (!c) throw new NotFoundError("캐릭터", id);
    return c;
  };

  /** cast edits are allowed once the storyline (concept brief) is approved */
  const assertEditable = async (tx: Tx | undefined, scope: NovelScope) => {
    const n = await novel.getNovel(scope, tx);
    if (n.status === "concept") throw new DomainValidationError("concept_not_approved", "컨셉(스토리라인)을 승인한 뒤에 캐릭터를 설정할 수 있습니다.");
    if (n.status === "archived") throw new DomainValidationError("novel_archived", "보관된 작품은 바꿀 수 없습니다.");
    return n;
  };

  const nextOrd = (cast: Character[]) => cast.reduce((m, c) => Math.max(m, c.ord), -1) + 1;

  /** a new/changed protagonist demotes the current one (unique index: at most one protagonist) */
  const demoteProtagonist = async (tx: Tx, scope: NovelScope, exceptId: string | null, actor: ActorRef) => {
    const cur = (await repo.list(tx.db, scope)).find((c) => c.role === "protagonist" && c.id !== exceptId);
    if (!cur) return;
    await repo.update(tx.db, scope, cur.id, { role: "sub_protagonist", status: "draft", confirmedAt: null, updatedAt: clock.date() });
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "character.updated",
      target: target(cur.id),
      before: { role: "protagonist", status: cur.status },
      after: { role: "sub_protagonist", status: "draft" },
      reason: "새 주인공 지정",
    });
  };

  const sanitizeRelationships = (rels: readonly CharacterRelationshipJson[], selfId: string | null, cast: Character[]) => {
    const idsInCast = new Set(cast.map((c) => c.id));
    const seen = new Set<string>();
    const out: CharacterRelationshipJson[] = [];
    for (const r of rels) {
      if (r.targetCharacterId === selfId || !idsInCast.has(r.targetCharacterId)) continue;
      const key = `${r.targetCharacterId}|${r.kind.trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ targetCharacterId: r.targetCharacterId, kind: clip(r.kind, 40), description: clip(r.description ?? "", 500) });
    }
    return out.slice(0, 40);
  };

  const normalizeProfilePatch = (patch: Partial<CharacterProfile>, selfId: string | null, cast: Character[]): Partial<CharacterProfile> => {
    const out: Partial<CharacterProfile> = {};
    for (const [k, v] of Object.entries(patch) as Array<[keyof CharacterProfile, unknown]>) {
      if (v === undefined) continue;
      if (k === "aliases") continue;
      if (k === "relationships") out.relationships = sanitizeRelationships(v as CharacterRelationshipJson[], selfId, cast);
      else (out as Record<string, string>)[k] = clip(String(v), PROFILE_TEXT_LIMIT[k] ?? 2000);
    }
    if (patch.aliases !== undefined) out.aliases = cleanAliases(out.name ?? cast.find((c) => c.id === selfId)?.name ?? "", patch.aliases);
    return out;
  };

  const assertUniqueName = (cast: Character[], name: string, selfId: string | null) => {
    const k = normalizeName(name);
    const clash = cast.find((c) => c.id !== selfId && normalizeName(c.name) === k);
    if (clash) throw new ConflictError("character_name_taken", `같은 이름의 캐릭터가 이미 있습니다: ${clash.name}`, { characterId: clash.id });
  };

  // ── tasks (draft_cast / design sheet) state ──────────────────────────────
  const taskState = async (scope: NovelScope, kind: "draft_cast" | "draft_design_sheet", targetId?: string) => {
    const tasks = (await orchestration.listTasks(scope, { kinds: [kind], ...(targetId ? { targetId } : {}), includeCancelled: false })).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const active = tasks.find((t) => (ACTIVE_TASK as readonly string[]).includes(t.status));
    const last = tasks[0];
    return {
      active: active ? { id: active.id, status: active.status } : null,
      lastError: !active && last?.status === "failed" ? (last.latestRun?.errorMessage ? "AI 초안을 만들지 못했습니다. 다시 시도하세요." : "AI 초안을 만들지 못했습니다.") : null,
    };
  };

  const approvedBriefContent = async (scope: NovelScope, tx?: Tx): Promise<Record<string, unknown> | null> => {
    const n = await novel.getNovel(scope, tx);
    if (!n.approvedConceptBriefId) return null;
    try {
      const b = await concept.getBrief(scope, n.approvedConceptBriefId, tx);
      return (b.content ?? null) as Record<string, unknown> | null;
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  };

  // ── import from brief (also on N2) ────────────────────────────────────────
  const importInTx = async (tx: Tx, scope: NovelScope, actor: ActorRef): Promise<{ created: number }> => {
    const content = await approvedBriefContent(scope, tx);
    if (!content) return { created: 0 };
    const seeds = seedFromBrief(content as never);
    let cast = await repo.list(tx.db, scope);
    const createdIds: string[] = [];
    let ord = nextOrd(cast);
    for (const s of seeds) {
      const hasProtagonist = cast.some((c) => c.role === "protagonist");
      if (s.role === "protagonist" && hasProtagonist) continue;
      if (cast.some((c) => normalizeName(c.name) === normalizeName(s.profile.name) || (s.key && c.conceptCharacterKey === s.key))) continue;
      const origins: FieldOrigins = originsFor(s.profile, "user");
      if (s.namePlaceholder) origins.name = "agent";
      const now = clock.date();
      const row = await repo.insert(tx.db, {
        id: ids.next("chr"),
        novelId: scope.novelId,
        role: s.role,
        ord: ord++,
        status: "draft",
        ...s.profile,
        relationships: [],
        fieldOrigins: origins,
        proposed: false,
        conceptCharacterKey: s.key,
        createdAt: now,
        updatedAt: now,
      });
      cast.push(row);
      createdIds.push(row.id);
    }
    // relation_to_protagonist → relationship on the supporting character
    const protagonist = cast.find((c) => c.role === "protagonist");
    if (protagonist) {
      for (const s of seeds) {
        if (!s.relationToProtagonist) continue;
        const c = cast.find((x) => createdIds.includes(x.id) && normalizeName(x.name) === normalizeName(s.profile.name));
        if (!c || c.id === protagonist.id) continue;
        const rel = [{ targetCharacterId: protagonist.id, kind: clip(s.relationToProtagonist, 40), description: "" }];
        const updated = await repo.update(tx.db, scope, c.id, { relationships: rel, fieldOrigins: { ...c.fieldOrigins, relationships: "user" } });
        cast = cast.map((x) => (x.id === c.id ? updated : x));
      }
    }
    if (createdIds.length) {
      await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: "character.created",
        target: { type: "novel", id: scope.novelId },
        after: { count: createdIds.length },
        reason: "승인된 컨셉 브리프에서 가져옴",
        details: { ids: createdIds, count: createdIds.length, source: "concept_brief" },
      });
    }
    return { created: createdIds.length };
  };

  // ── ontology sync on confirm ──────────────────────────────────────────────
  /**
   * names of an existing character entity: add the new name / aliases, make the current name the preferred name and
   * retire the cast's own former true names that are neither the name nor an alias any more (renamed characters).
   */
  const syncNames = async (tx: Tx, scope: NovelScope, entityId: string, c: Character, aliases: string[], source: { kind: "user_input"; refType: "character"; refId: string }, actor: ActorRef) => {
    let names = (await ontology.listEntityNames(scope, entityId, tx)).filter((n) => n.status !== "retired");
    const has = (surface: string, kind?: string) => names.some((n) => normalizeName(n.surface) === normalizeName(surface) && (!kind || n.nameKind === kind));
    const wanted: Array<{ surface: string; nameKind: "true_name" | "alias" }> = [{ surface: c.name, nameKind: "true_name" }, ...aliases.map((a) => ({ surface: a, nameKind: "alias" as const }))];
    for (const w of wanted) {
      if (w.nameKind === "true_name" ? has(w.surface, "true_name") : has(w.surface)) continue;
      try {
        await ontology.addEntityName(tx, scope, entityId, { surface: w.surface, nameKind: w.nameKind, status: "active", source }, actor);
      } catch (err) {
        // app-level duplicate check (thrown before any SQL): keep going
        if (!(err instanceof ConflictError) && !(err instanceof DomainValidationError)) throw err;
      }
    }
    names = (await ontology.listEntityNames(scope, entityId, tx)).filter((n) => n.status !== "retired");
    const current = names.find((n) => n.status === "active" && n.nameKind === "true_name" && normalizeName(n.surface) === normalizeName(c.name));
    if (current && !current.isPreferred) await ontology.setPreferredName(tx, scope, entityId, current.id, actor);
    const keep = new Set([normalizeName(c.name), ...aliases.map(normalizeName)]);
    for (const n of names) {
      if (n.nameKind !== "true_name" || n.id === current?.id || keep.has(normalizeName(n.surface))) continue;
      if (n.sourceRefType !== "character" || n.sourceRefId !== c.id) continue; // names found in the manuscript stay
      if (!current) continue; // never leave the entity without a preferred name
      await ontology.setEntityNameStatus(tx, scope, n.id, "retired", actor);
    }
  };

  const syncOntology = async (tx: Tx, scope: NovelScope, cast: Character[], actor: ActorRef) => {
    const tl = await ontology.getDefaultTimeline(scope, tx);
    const entityOf = new Map<string, string>();
    let factCount = 0;
    const entityIds: string[] = [];
    // 1) entities (create or add new names)
    for (const c of cast) {
      const source = { kind: "user_input" as const, refType: "character" as const, refId: c.id };
      const aliases = cleanAliases(c.name, c.aliases ?? []);
      let entityId = c.entityId;
      if (entityId) {
        try {
          entityId = (await ontology.getEntity(scope, entityId, tx)).id;
        } catch (err) {
          if (!(err instanceof NotFoundError)) throw err;
          entityId = null;
        }
      }
      if (!entityId) {
        const r = await ontology.createEntity(
          tx,
          scope,
          {
            entityType: "character",
            preferredName: { surface: c.name },
            status: "active",
            summary: clip(`${labelKo("character_role", c.role)}. ${c.personality}`, 300),
            conceptCharacterKey: c.conceptCharacterKey ?? c.id,
            source,
            names: aliases.map((a) => ({ surface: a, nameKind: "alias" as const, status: "active" as const, source })),
          },
          actor,
        );
        entityId = r.entity.id;
      } else {
        await syncNames(tx, scope, entityId, c, aliases, source, actor);
      }
      entityOf.set(c.id, entityId);
      entityIds.push(entityId);
    }
    // 2) approved facts for values changed since the last sync; a changed / removed value withdraws its old fact
    for (const c of cast) {
      const entityId = entityOf.get(c.id)!;
      const prev = c.ontologySync?.values ?? {};
      const prevFacts: Record<string, string> = { ...(c.ontologySync?.fieldFacts ?? {}) };
      const values: Record<string, string> = {};
      const drafts: Array<{ field: string; draft: CandidateFactDraft }> = [];
      const base = { timelineId: tl.id, storyRange: { from: 0, to: null }, sourceKind: "user_input" as const, source: { refType: "character" as const, refId: c.id }, canonStatus: "approved" as const };
      const age = parseAge(c.age);
      if (age !== null) values.age = String(age);
      if (c.gender.trim()) values.gender = c.gender.trim();
      if (c.personality.trim()) values.personality = clip(c.personality, 500);
      for (const r of c.relationships ?? []) {
        const pred = relationPredicate(r.kind);
        const obj = entityOf.get(r.targetCharacterId);
        if (pred && obj) values[`rel:${pred}:${r.targetCharacterId}`] = obj;
      }
      // old facts of changed / removed fields (rows synced before fieldFacts existed: matched among our factIds)
      const stale = Object.keys(prev).filter((k) => prev[k] !== values[k]);
      if (stale.some((k) => !prevFacts[k]) && (c.ontologySync?.factIds ?? []).length) {
        const ours = new Set(c.ontologySync!.factIds);
        const canon = (await ontology.getCanonAt(scope, [entityId], 0, tl.id, undefined, tx)).filter((f) => ours.has(f.factId) && f.subjectEntityId === entityId);
        for (const k of stale) {
          if (prevFacts[k]) continue;
          const [, pred, target] = k.startsWith("rel:") ? k.split(":") : [null, k, null];
          const hit = canon.find((f) => f.predicate === pred && (target ? f.objectEntityId === prev[k] : true));
          if (hit) prevFacts[k] = hit.factId;
        }
      }
      const withdrawIds = stale.map((k) => prevFacts[k]).filter((x): x is string => !!x);
      if (withdrawIds.length) await ontology.withdrawFacts(tx, scope, withdrawIds, actor, "캐스트 재확정: 값이 바뀜");
      const fieldFacts: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) {
        if (prev[k] === v && prevFacts[k]) {
          fieldFacts[k] = prevFacts[k]!;
          continue;
        }
        if (prev[k] === v) continue; // legacy row: already synced, fact id unknown
        if (k === "age") drafts.push({ field: k, draft: { ...base, factKind: "attribute", subjectEntityId: entityId, predicate: "age", value: Number(v) } });
        else if (k === "gender" || k === "personality") drafts.push({ field: k, draft: { ...base, factKind: "attribute", subjectEntityId: entityId, predicate: k, value: v } });
        else drafts.push({ field: k, draft: { ...base, factKind: "relation", subjectEntityId: entityId, predicate: k.split(":")[1]!, objectEntityId: v } });
      }
      let factIds = (c.ontologySync?.factIds ?? []).filter((id) => !withdrawIds.includes(id));
      const rejected: Array<{ field: string; reason: string }> = [];
      const synced: Record<string, string> = Object.fromEntries(Object.entries(values).filter(([k, v]) => prev[k] === v));
      if (drafts.length) {
        const r = await ontology.writeCandidateFacts(tx, scope, drafts.map((d) => d.draft), actor);
        for (const x of r.rejected) rejected.push({ field: drafts[x.index]!.field, reason: x.reason });
        const written = r.written.map((w, i) => ({ ...w, i }));
        // only facts that came back approved count as synced (a held candidate is retried on the next confirm)
        const canonIds = new Set((await ontology.getCanonAt(scope, [entityId], 0, tl.id, undefined, tx)).map((f) => f.factId));
        const rejectedIdx = new Set(r.rejected.map((x) => x.index));
        const okIdx = drafts.map((_, i) => i).filter((i) => !rejectedIdx.has(i));
        for (const [j, w] of written.entries()) {
          const d = drafts[okIdx[j]!]!;
          if (canonIds.has(w.factId)) {
            synced[d.field] = values[d.field]!;
            fieldFacts[d.field] = w.factId;
            factIds.push(w.factId);
            factCount += 1;
          } else {
            rejected.push({ field: d.field, reason: "not_approved" });
            if (w.diffKind !== "duplicate") await ontology.withdrawFacts(tx, scope, [w.factId], actor, "캐스트 확정: 캐논으로 기록하지 못한 후보");
          }
        }
      }
      factIds = [...new Set(factIds)];
      await repo.update(tx.db, scope, c.id, {
        entityId,
        ontologySync: {
          at: clock.date().toISOString(),
          values: synced,
          factIds,
          fieldFacts,
          rejected,
          confirmed: { role: c.role, ...profileOf(c) },
        },
      });
    }
    return { entityIds, factCount };
  };

  // ── views ─────────────────────────────────────────────────────────────────
  const castState = async (scope: NovelScope): Promise<CastState> => {
    const n = await novel.getNovel(scope);
    const items = sortCast(await repo.list(uow.db, scope));
    const blockers = castBlockers(items);
    const confirmed = isCastConfirmed(items);
    const content = n.status === "concept" ? null : await approvedBriefContent(scope);
    const seeds = content ? seedFromBrief(content as never) : [];
    const canImportBrief = seeds.some(
      (s) => !(s.role === "protagonist" && items.some((c) => c.role === "protagonist")) && !items.some((c) => normalizeName(c.name) === normalizeName(s.profile.name)),
    );
    const task = await taskState(scope, "draft_cast");
    const sheets = new Map<string, { hasSheet: boolean; frontAssetId: string | null }>();
    const assetLive = async (assetId: string) => {
      try {
        await imaging.openAsset(assetId);
        return true;
      } catch (err) {
        if (err instanceof NotFoundError) return false;
        throw err;
      }
    };
    for (const s of await repo.listSheets(uow.db, scope)) {
      const spec = normalizeSpec(s.spec);
      // primary images whose generation was deleted no longer count (same rule as the design-sheet view)
      const live: string[] = [];
      for (const [view, assetId] of Object.entries(s.primaryImages ?? {})) if (assetId && (await assetLive(assetId))) live.push(view);
      const front = live.includes("front") ? (s.primaryImages?.front ?? null) : null;
      sheets.set(s.characterId, { hasSheet: !specIsEmpty(spec) || live.length > 0, frontAssetId: front });
    }
    const goalSet = n.status !== "concept" && n.status !== "onboarding" ? true : !!(await novel.getGoal(scope));
    return {
      items,
      confirmed,
      blockers,
      counts: castCounts(items),
      stepRequired: n.status === "onboarding" && !confirmed,
      goalSet,
      pendingChanges: items.filter((c) => c.status !== "confirmed").length,
      canImportBrief,
      draftTask: task.active,
      lastDraftError: task.lastError,
      sheets,
    };
  };

  const ensureSheet = async (tx: Tx, scope: NovelScope, characterId: string) => {
    const s = await repo.getSheet(tx.db, scope, characterId, true);
    if (s) return s;
    const now = clock.date();
    return repo.insertSheet(tx.db, { id: ids.next("cds"), novelId: scope.novelId, characterId, spec: designSheetSpecSchema.parse({}), fieldOrigins: {}, primaryImages: {}, createdAt: now, updatedAt: now });
  };

  const sheetState = async (scope: NovelScope, characterId: string): Promise<DesignSheetState> => {
    const c = await mustCharacter(undefined, scope, characterId);
    const s = await repo.getSheet(uow.db, scope, characterId);
    const spec = normalizeSpec(s?.spec);
    const links = await repo.listImages(uow.db, scope, characterId);
    const images: DesignSheetState["images"] = [];
    for (const link of links) {
      try {
        images.push({ link, generation: await imaging.getGeneration(link.generationId) });
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
      }
    }
    const liveAssets = new Set(images.flatMap((i) => i.generation.assets.map((a) => a.id)));
    const primaryImages = Object.fromEntries(Object.entries(s?.primaryImages ?? {}).filter(([, a]) => a && liveAssets.has(a))) as DesignSheetState["primaryImages"];
    const task = await taskState(scope, "draft_design_sheet", characterId);
    return {
      characterId,
      spec,
      fieldOrigins: (s?.fieldOrigins ?? {}) as Record<string, "user" | "agent">,
      primaryImages,
      images,
      referenceText: sheetReferenceText(c, spec),
      draftTask: task.active,
      updatedAt: s?.updatedAt ?? null,
    };
  };

  // ── task handlers ─────────────────────────────────────────────────────────
  const draftCastHandler: TaskKindHandler<DraftInput, { proposal: CastDraftProposal | null }> = {
    kind: "draft_cast",
    role: "concept_partner",
    promptTemplateVersion: DRAFT_CAST_TEMPLATE_ID,
    inputSchema: draftInputSchema,
    async execute(ctx) {
      const n = await novel.getNovel(ctx.scope);
      const brief = await approvedBriefContent(ctx.scope);
      const cast = sortCast(await repo.list(uow.db, ctx.scope));
      const prompt = renderCastDraftPrompt({
        novel: { title: n.title, genre: n.genre, ageRating: n.ageRating },
        brief,
        cast,
        request: {
          subProtagonistCount: ctx.input.sub_protagonist_count ?? undefined,
          includeAntagonist: ctx.input.include_antagonist,
          instructions: ctx.input.instructions || undefined,
        },
      });
      const out = await llm.modelCalls.call({
        run: ctx.run,
        purpose: "draft_cast",
        system: prompt.system,
        messages: prompt.messages,
        output: { kind: "object", schemaName: "CastDraft", schema: castDraftProposalSchema },
        maxOutputTokens: 6000,
      });
      const parsed = castDraftProposalSchema.safeParse(out.value);
      return { proposal: parsed.success ? parsed.data : null };
    },
    async commit(tx, ctx, p) {
      const scope = ctx.scope;
      const agent = actors.agent("concept_partner", ctx.run.runId);
      if (!p.proposal) return { kind: "failed", reason: "AI 초안 형식이 올바르지 않습니다." };
      let cast = await repo.list(tx.db, scope);
      const createdIds: string[] = [];
      const updatedIds: string[] = [];
      const skippedUserFields: Record<string, string[]> = {};
      const subLimit = ctx.input.sub_protagonist_count;
      let newSubsAllowed = subLimit === null ? Infinity : Math.max(0, subLimit - cast.filter((c) => c.role === "sub_protagonist").length);
      let ord = nextOrd(cast);
      const pendingRels: Array<{ characterId: string; rels: CastDraftProposal["characters"][number]["relationships"] }> = [];
      for (const pc of p.proposal.characters.slice(0, MAX_DRAFT_CHARACTERS)) {
        const name = clip(pc.name, 80);
        const byId = pc.existing_id ? cast.find((c) => c.id === pc.existing_id) : undefined;
        const existing =
          byId ??
          (pc.role === "protagonist" ? cast.find((c) => c.role === "protagonist") : undefined) ??
          (name ? cast.find((c) => normalizeName(c.name) === normalizeName(name)) : undefined);
        const profile: Partial<CharacterProfile> = {
          name,
          age: clip(pc.age, 40),
          gender: clip(pc.gender, 40),
          personality: clip(pc.personality, 2000),
          background: clip(pc.background, 4000),
          desire: clip(pc.desire, 2000),
          weakness: clip(pc.weakness, 2000),
          notes: clip(pc.notes, 4000),
        };
        if (existing) {
          if (existing.status === "confirmed") continue; // the agent never edits a confirmed character
          if (name && cast.some((c) => c.id !== existing.id && normalizeName(c.name) === normalizeName(name))) delete profile.name;
          const aliases = cleanAliases(profile.name ?? existing.name, pc.aliases);
          const { accepted, skipped } = agentWritable(profileOf(existing) as unknown as Record<string, unknown>, existing.fieldOrigins as FieldOrigins, {
            ...profile,
            ...(aliases.length ? { aliases } : {}),
          } as Record<string, unknown>);
          if (skipped.length) skippedUserFields[existing.id] = skipped;
          if (pc.relationships.length) pendingRels.push({ characterId: existing.id, rels: pc.relationships });
          if (!Object.keys(accepted).length) continue;
          const row = await repo.update(tx.db, scope, existing.id, {
            ...(accepted as Partial<CharactersInsert>),
            fieldOrigins: mergeOrigins(existing.fieldOrigins as FieldOrigins, accepted, "agent"),
            updatedAt: clock.date(),
          });
          cast = cast.map((c) => (c.id === row.id ? row : c));
          updatedIds.push(row.id);
          continue;
        }
        if (!name || cast.some((c) => normalizeName(c.name) === normalizeName(name))) continue;
        let role: CharacterRole = pc.role;
        if (role === "protagonist" && cast.some((c) => c.role === "protagonist")) role = "sub_protagonist";
        if (role === "antagonist" && !ctx.input.include_antagonist) continue;
        if (role === "sub_protagonist") {
          if (newSubsAllowed <= 0) continue;
          newSubsAllowed--;
        }
        const full: CharacterProfile = { ...(profile as CharacterProfile), name, aliases: cleanAliases(name, pc.aliases), relationships: [] };
        const now = clock.date();
        const row = await repo.insert(tx.db, {
          id: ids.next("chr"),
          novelId: scope.novelId,
          role,
          ord: ord++,
          status: "draft",
          ...full,
          fieldOrigins: originsFor(full, "agent"),
          proposed: true,
          createdAt: now,
          updatedAt: now,
        });
        cast.push(row);
        createdIds.push(row.id);
        if (pc.relationships.length) pendingRels.push({ characterId: row.id, rels: pc.relationships });
      }
      // relationships by name, after every proposed character exists
      for (const { characterId, rels } of pendingRels) {
        const c = cast.find((x) => x.id === characterId);
        if (!c || c.status === "confirmed") continue;
        if (c.fieldOrigins.relationships === "user" && (c.relationships ?? []).length) continue;
        const resolved: CharacterRelationshipJson[] = [];
        for (const r of rels) {
          const t = cast.find((x) => normalizeName(x.name) === normalizeName(r.target_name));
          if (t && t.id !== c.id && r.kind.trim()) resolved.push({ targetCharacterId: t.id, kind: clip(r.kind, 40), description: clip(r.description, 500) });
        }
        const rel = sanitizeRelationships(resolved, c.id, cast);
        if (!rel.length || JSON.stringify(rel) === JSON.stringify(c.relationships)) continue;
        const row = await repo.update(tx.db, scope, c.id, { relationships: rel, fieldOrigins: { ...c.fieldOrigins, relationships: "agent" }, updatedAt: clock.date() });
        cast = cast.map((x) => (x.id === row.id ? row : x));
        if (!createdIds.includes(c.id) && !updatedIds.includes(c.id)) updatedIds.push(c.id);
      }
      await audit.record(tx, {
        novelId: scope.novelId,
        actor: agent,
        action: "cast.draft_applied",
        target: { type: "novel", id: scope.novelId },
        after: { created: createdIds.length, updated: updatedIds.length },
        details: { createdIds, updatedIds, skippedUserFields },
      });
      return { kind: "done", outputRefs: [...createdIds, ...updatedIds].map((id) => ({ refType: "character" as const, refId: id })) };
    },
  };

  const draftSheetHandler: TaskKindHandler<SheetInput, { proposal: SheetDraftProposal | null }> = {
    kind: "draft_design_sheet",
    role: "world_keeper",
    promptTemplateVersion: DRAFT_SHEET_TEMPLATE_ID,
    inputSchema: sheetInputSchema,
    async execute(ctx) {
      const c = await repo.get(uow.db, ctx.scope, ctx.input.character_id);
      if (!c) return { proposal: null };
      const n = await novel.getNovel(ctx.scope);
      const s = await repo.getSheet(uow.db, ctx.scope, c.id);
      const userFields = Object.entries(s?.fieldOrigins ?? {}).filter(([, o]) => o === "user").map(([k]) => k);
      const prompt = renderSheetDraftPrompt({ novel: { title: n.title, genre: n.genre }, character: c, spec: normalizeSpec(s?.spec), userFields });
      const out = await llm.modelCalls.call({
        run: ctx.run,
        purpose: "draft_design_sheet",
        system: prompt.system,
        messages: prompt.messages,
        output: { kind: "object", schemaName: "CharacterDesignSheet", schema: sheetDraftProposalSchema },
        maxOutputTokens: 3000,
      });
      const parsed = sheetDraftProposalSchema.safeParse(out.value);
      return { proposal: parsed.success ? parsed.data : null };
    },
    async commit(tx, ctx, p) {
      const scope = ctx.scope;
      const c = await repo.get(tx.db, scope, ctx.input.character_id);
      if (!c) return { kind: "done", outputRefs: [] };
      if (!p.proposal) return { kind: "failed", reason: "AI 초안 형식이 올바르지 않습니다." };
      const raw = p.proposal;
      const candidate = designSheetSpecSchema.safeParse({
        face: clip(raw.face, 1000),
        hair: clip(raw.hair, 1000),
        eyes: clip(raw.eyes, 500),
        build: clip(raw.build, 500),
        height: clip(raw.height, 60),
        outfits: raw.outfits.filter((o) => o.name.trim()).map((o) => ({ name: clip(o.name, 60), description: clip(o.description, 1000) })),
        colorPalette: raw.color_palette.filter((x) => /^#[0-9a-fA-F]{6}$/.test(x.hex.trim()) && x.name.trim()).map((x) => ({ name: clip(x.name, 40), hex: x.hex.trim() })),
        distinguishingMarks: clip(raw.distinguishing_marks, 1000),
        artStyle: clip(raw.art_style, 1000),
        avoid: clip(raw.avoid, 1000),
      });
      if (!candidate.success) return { kind: "failed", reason: "AI 디자인 시트 형식이 올바르지 않습니다." };
      const sheet = await ensureSheet(tx, scope, c.id);
      const spec = normalizeSpec(sheet.spec);
      const { accepted, skipped } = agentWritable(spec as unknown as Record<string, unknown>, sheet.fieldOrigins as FieldOrigins, candidate.data as unknown as Record<string, unknown>);
      if (Object.keys(accepted).length) {
        await repo.updateSheet(tx.db, scope, sheet.id, {
          spec: { ...spec, ...accepted },
          fieldOrigins: mergeOrigins(sheet.fieldOrigins as FieldOrigins, accepted, "agent"),
          updatedAt: clock.date(),
        });
      }
      await audit.record(tx, {
        novelId: scope.novelId,
        actor: actors.agent("world_keeper", ctx.run.runId),
        action: "design_sheet.updated",
        target: target(c.id),
        after: { fields: Object.keys(accepted) },
        details: { source: "agent_draft", skippedUserFields: skipped },
      });
      return { kind: "done", outputRefs: [{ refType: "character", refId: c.id }] };
    },
  };

  // ── service ───────────────────────────────────────────────────────────────
  const service: CastService = {
    getCast: castState,
    listCharacters: async (scope, tx) => sortCast(await repo.list(db(tx), scope)),
    getCharacter: (scope, id, tx) => mustCharacter(tx, scope, id),

    async createCharacter(scope, input, actor) {
      return uow.run(async (tx) => {
        await assertEditable(tx, scope);
        const cast = await repo.list(tx.db, scope);
        const name = clip(input.name, 80);
        assertUniqueName(cast, name, null);
        if (input.role === "protagonist") await demoteProtagonist(tx, scope, null, actor);
        const p = normalizeProfilePatch({ ...input, name } as Partial<CharacterProfile>, null, cast);
        const profile: CharacterProfile = { name, aliases: cleanAliases(name, input.aliases ?? []), age: "", gender: "", personality: "", background: "", desire: "", weakness: "", relationships: [], notes: "", ...p };
        const now = clock.date();
        const row = await repo.insert(tx.db, {
          id: ids.next("chr"),
          novelId: scope.novelId,
          role: input.role,
          ord: nextOrd(cast),
          status: "draft",
          ...profile,
          fieldOrigins: originsFor(profile, "user"),
          proposed: false,
          createdAt: now,
          updatedAt: now,
        });
        await audit.record(tx, { novelId: scope.novelId, actor, action: "character.created", target: target(row.id), after: { role: row.role, name: row.name } });
        return row;
      });
    },

    async updateCharacter(scope, id, patch, actor) {
      return uow.run(async (tx) => {
        await assertEditable(tx, scope);
        const before = await mustCharacter(tx, scope, id, true);
        const cast = await repo.list(tx.db, scope);
        const { role, ...profilePatch } = patch;
        const p = normalizeProfilePatch(profilePatch as Partial<CharacterProfile>, id, cast);
        if (p.name !== undefined) {
          if (!p.name) throw new DomainValidationError("character_name_required", "이름을 입력하세요.");
          assertUniqueName(cast, p.name, id);
        }
        const changed: Record<string, unknown> = {};
        const beforeVals: Record<string, unknown> = {};
        const cur = profileOf(before) as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(p)) {
          if (JSON.stringify(cur[k]) === JSON.stringify(v)) continue;
          changed[k] = v;
          beforeVals[k] = cur[k];
        }
        const roleChanged = role !== undefined && role !== before.role;
        if (!roleChanged && !Object.keys(changed).length) return before;
        if (roleChanged && role === "protagonist") await demoteProtagonist(tx, scope, id, actor);
        const origins = mergeOrigins(before.fieldOrigins as FieldOrigins, changed, "user");
        const row = await repo.update(tx.db, scope, id, {
          ...(changed as Partial<CharactersInsert>),
          ...(roleChanged ? { role } : {}),
          fieldOrigins: origins,
          status: "draft",
          confirmedAt: null,
          updatedAt: clock.date(),
        });
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "character.updated",
          target: target(id),
          before: { ...beforeVals, ...(roleChanged ? { role: before.role } : {}), status: before.status },
          after: { ...changed, ...(roleChanged ? { role } : {}), status: "draft" },
        });
        return row;
      });
    },

    async deleteCharacter(scope, id, actor) {
      await uow.run(async (tx) => {
        await assertEditable(tx, scope);
        const before = await mustCharacter(tx, scope, id, true);
        // referential cleanup: relationships pointing at the removed character
        for (const c of await repo.list(tx.db, scope)) {
          if (c.id === id || !(c.relationships ?? []).some((r) => r.targetCharacterId === id)) continue;
          await repo.update(tx.db, scope, c.id, { relationships: c.relationships.filter((r) => r.targetCharacterId !== id), updatedAt: clock.date() });
        }
        await repo.remove(tx.db, scope, id);
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "character.deleted",
          target: target(id),
          before: { role: before.role, name: before.name, status: before.status, entityId: before.entityId },
          details: before.entityId ? { note: "온톨로지 엔티티는 그대로 둡니다." } : null,
        });
      });
    },

    async acceptCharacter(scope, id, actor) {
      return uow.run(async (tx) => {
        await assertEditable(tx, scope);
        const before = await mustCharacter(tx, scope, id, true);
        const origins: FieldOrigins = {};
        for (const k of Object.keys(before.fieldOrigins ?? {})) origins[k] = "user";
        if (!before.proposed && Object.values(before.fieldOrigins ?? {}).every((o) => o === "user")) return before;
        const row = await repo.update(tx.db, scope, id, { proposed: false, fieldOrigins: origins, updatedAt: clock.date() });
        await audit.record(tx, { novelId: scope.novelId, actor, action: "character.updated", target: target(id), before: { proposed: before.proposed }, after: { proposed: false }, reason: "AI 제안 수락" });
        return row;
      });
    },

    async reorder(scope, orderIds, actor) {
      return uow.run(async (tx) => {
        await assertEditable(tx, scope);
        const cast = await repo.list(tx.db, scope);
        const all = new Set(cast.map((c) => c.id));
        if (orderIds.length !== all.size || new Set(orderIds).size !== orderIds.length || orderIds.some((x) => !all.has(x))) {
          throw new DomainValidationError("cast_order_mismatch", "모든 캐릭터를 한 번씩 담아 순서를 보내야 합니다.");
        }
        for (const [i, cid] of orderIds.entries()) {
          const c = cast.find((x) => x.id === cid)!;
          if (c.ord !== i) await repo.update(tx.db, scope, cid, { ord: i });
        }
        await audit.record(tx, { novelId: scope.novelId, actor, action: "character.reordered", target: { type: "novel", id: scope.novelId }, details: { ids: orderIds, count: orderIds.length } });
        return sortCast(await repo.list(tx.db, scope));
      });
    },

    async importFromBrief(scope, actor, tx) {
      return uow.join(tx, async (t) => {
        await assertEditable(t, scope);
        return importInTx(t, scope, actor);
      });
    },

    async requestDraft(scope, input, actor) {
      return uow.run(async (tx) => {
        await assertEditable(tx, scope);
        const n = await novel.getNovel(scope, tx);
        if (!n.approvedConceptBriefId) throw new DomainValidationError("concept_not_approved", "컨셉(스토리라인)을 승인한 뒤에 AI 초안을 받을 수 있습니다.");
        const { taskId } = await orchestration.createTask(tx, scope, {
          kind: "draft_cast",
          targetType: "novel",
          targetId: scope.novelId,
          input: {
            requested_by_user_id: actor.id,
            sub_protagonist_count: input.subProtagonistCount ?? null,
            include_antagonist: input.includeAntagonist ?? true,
            instructions: input.instructions?.trim() ?? "",
          },
          createdBy: actor,
          cycleKey: `cast:${scope.novelId}`,
          priority: 300,
        });
        await audit.record(tx, { novelId: scope.novelId, actor, action: "cast.draft_requested", target: { type: "novel", id: scope.novelId }, details: { taskId, subProtagonistCount: input.subProtagonistCount ?? null } });
        return { taskId };
      });
    },

    async confirmCast(scope, actor) {
      await uow.run(async (tx) => {
        await assertEditable(tx, scope);
        const cast = sortCast(await repo.list(tx.db, scope));
        const blockers = castBlockers(cast);
        if (blockers.length) throw new DomainValidationError("cast_invalid", blockers[0]!, { blockers });
        const now = clock.date();
        const sync = await syncOntology(tx, scope, cast, actor);
        for (const c of cast) {
          if (c.status === "confirmed" && !c.proposed) continue;
          await repo.update(tx.db, scope, c.id, { status: "confirmed", confirmedAt: now, proposed: false, updatedAt: now });
        }
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "cast.confirmed",
          target: { type: "novel", id: scope.novelId },
          after: { count: cast.length, ...castCounts(cast) },
          details: { ids: cast.map((c) => c.id), count: cast.length, entityIds: sync.entityIds, factsWritten: sync.factCount },
        });
      });
      return castState(scope);
    },

    async isCastConfirmed(scope, tx) {
      return isCastConfirmed(await repo.list(db(tx), scope));
    },

    getDesignSheet: sheetState,

    async updateDesignSheet(scope, characterId, patch, actor) {
      await uow.run(async (tx) => {
        await assertEditable(tx, scope);
        await mustCharacter(tx, scope, characterId, true);
        const sheet = await ensureSheet(tx, scope, characterId);
        const spec = normalizeSpec(sheet.spec);
        const parsed = designSheetSpecSchema.partial().parse(patch);
        const changed: Record<string, unknown> = {};
        for (const k of DESIGN_SHEET_FIELDS) {
          const v = (parsed as Record<string, unknown>)[k];
          if (v === undefined || JSON.stringify(v) === JSON.stringify(spec[k])) continue;
          changed[k] = v;
        }
        if (!Object.keys(changed).length) return;
        await repo.updateSheet(tx.db, scope, sheet.id, {
          spec: { ...spec, ...changed },
          fieldOrigins: mergeOrigins(sheet.fieldOrigins as FieldOrigins, changed, "user"),
          updatedAt: clock.date(),
        });
        await audit.record(tx, { novelId: scope.novelId, actor, action: "design_sheet.updated", target: target(characterId), after: { fields: Object.keys(changed) }, details: { source: "user" } });
      });
      return sheetState(scope, characterId);
    },

    async requestDesignSheetDraft(scope, characterId, actor) {
      return uow.run(async (tx) => {
        await assertEditable(tx, scope);
        await mustCharacter(tx, scope, characterId);
        const { taskId } = await orchestration.createTask(tx, scope, {
          kind: "draft_design_sheet",
          targetType: "character",
          targetId: characterId,
          input: { character_id: characterId, requested_by_user_id: actor.id },
          createdBy: actor,
          cycleKey: `sheet:${characterId}`,
          priority: 300,
        });
        await audit.record(tx, { novelId: scope.novelId, actor, action: "design_sheet.draft_requested", target: target(characterId), details: { taskId } });
        return { taskId };
      });
    },

    async buildSheetPrompt(scope, characterId, view, outfitIndex = 0) {
      const c = await mustCharacter(undefined, scope, characterId);
      const s = await repo.getSheet(uow.db, scope, characterId);
      return buildViewPrompt(c, normalizeSpec(s?.spec), view, outfitIndex);
    },

    async generateSheetImage(scope, characterId, input, actor) {
      await assertEditable(undefined, scope);
      const c = await mustCharacter(undefined, scope, characterId);
      const s = await repo.getSheet(uow.db, scope, characterId);
      const spec = normalizeSpec(s?.spec);
      if (specIsEmpty(spec)) throw new DomainValidationError("design_sheet_empty", "디자인 시트를 먼저 채우세요. [AI 초안 받기]로 채울 수도 있습니다.");
      const view = input.view;
      const built = buildViewPrompt(c, spec, view, input.outfitIndex ?? 0);
      const generation: ImageGenerationWithAssets = await imaging.createGeneration(
        {
          novelId: scope.novelId,
          provider: input.provider,
          modelId: input.modelId,
          prompt: built.prompt.slice(0, 4000),
          styleNotes: built.styleNotes ? built.styleNotes.slice(0, 1000) : undefined,
          negativePrompt: built.negativePrompt ? built.negativePrompt.slice(0, 1000) : undefined,
          aspectRatio: input.aspectRatio ?? VIEW_ASPECT[view],
          resolution: input.resolution ?? "1k",
          quality: input.quality,
          count: input.count ?? 1,
        },
        actor,
      );
      const link = await uow.run(async (tx) => {
        const row = await repo.insertImage(tx.db, { id: ids.next("csi"), novelId: scope.novelId, characterId, view, generationId: generation.id, prompt: built.prompt.slice(0, 4000), createdAt: clock.date() });
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "design_sheet.image_requested",
          target: target(characterId),
          after: { view, generationId: generation.id, provider: input.provider, modelId: input.modelId },
        });
        return row;
      });
      return { link, generation };
    },

    async selectPrimaryImage(scope, characterId, view, assetId, actor) {
      await assertEditable(undefined, scope);
      await mustCharacter(undefined, scope, characterId);
      if (assetId) {
        const links = (await repo.listImages(uow.db, scope, characterId, 500)).filter((l) => l.view === view);
        let found = false;
        for (const l of links) {
          try {
            const g = await imaging.getGeneration(l.generationId);
            if (g.status === "succeeded" && g.assets.some((a) => a.id === assetId)) {
              found = true;
              break;
            }
          } catch (err) {
            if (!(err instanceof NotFoundError)) throw err;
          }
        }
        if (!found) throw new DomainValidationError("design_sheet_asset_invalid", `이 캐릭터의 '${labelKo("character_sheet_view", view)}' 이미지가 아닙니다.`);
      }
      await uow.run(async (tx) => {
        const sheet = await ensureSheet(tx, scope, characterId);
        const before = (sheet.primaryImages ?? {})[view] ?? null;
        if (before === assetId) return;
        const next = { ...(sheet.primaryImages ?? {}) };
        if (assetId) next[view] = assetId;
        else delete next[view];
        await repo.updateSheet(tx.db, scope, sheet.id, { primaryImages: next, updatedAt: clock.date() });
        await audit.record(tx, { novelId: scope.novelId, actor, action: "design_sheet.image_selected", target: target(characterId), before: { view, assetId: before }, after: { view, assetId } });
      });
      return sheetState(scope, characterId);
    },

    async referenceText(scope, characterId) {
      const c = await mustCharacter(undefined, scope, characterId);
      const s = await repo.getSheet(uow.db, scope, characterId);
      return sheetReferenceText(c, normalizeSpec(s?.spec));
    },

    async renderCastContext(scope) {
      // confirmed characters as they are; a character edited after confirmation keeps its last confirmed profile
      // (ontologySync.confirmed) until the cast is confirmed again; never-confirmed characters are left out
      const rows = sortCast(await repo.list(uow.db, scope));
      const cast = rows
        .map((c) => {
          if (c.status === "confirmed") return { c, profile: profileOf(c), role: c.role, pending: false };
          const snap = c.ontologySync?.confirmed;
          if (!snap) return null;
          const { role, ...profile } = snap;
          return { c, profile: profile as CharacterProfile, role: role as CharacterRole, pending: true };
        })
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, b) => ROLE_ORDER_INDEX(a.role) - ROLE_ORDER_INDEX(b.role) || a.c.ord - b.c.ord);
      if (!cast.length) return { text: "", entityIds: [] };
      const sheets = new Map((await repo.listSheets(uow.db, scope)).map((s) => [s.characterId, normalizeSpec(s.spec)]));
      const nameOf = new Map(cast.map((x) => [x.c.id, x.profile.name]));
      const blocks = cast.map(({ c, profile: p, role }) => {
        const head = `### [${labelKo("character_role", role)}] ${p.name}${c.entityId ? ` ({{E:${c.entityId}}})` : ""}`;
        const rels = (p.relationships ?? []).filter((r) => nameOf.has(r.targetCharacterId));
        const fields = [
          c.conceptCharacterKey ? `character_key: ${c.conceptCharacterKey}` : `character_key: ${c.id}`,
          (p.aliases ?? []).length ? `별칭: ${p.aliases.join(", ")}` : "",
          p.age ? `나이: ${p.age}` : "",
          p.gender ? `성별: ${p.gender}` : "",
          p.personality ? `성격: ${p.personality}` : "",
          p.background ? `배경: ${p.background}` : "",
          p.desire ? `욕망·목표: ${p.desire}` : "",
          p.weakness ? `약점: ${p.weakness}` : "",
          rels.length ? `관계: ${rels.map((r) => `${nameOf.get(r.targetCharacterId)}(${r.kind}${r.description ? ` — ${r.description}` : ""})`).join("; ")}` : "",
          p.notes ? `메모: ${p.notes}` : "",
        ];
        const spec = sheets.get(c.id);
        if (spec && !specIsEmpty(spec)) fields.push(`외형: ${sheetReferenceText({ ...c, ...p }, spec).split("\n").slice(1).join(" / ")}`);
        return [head, ...fields.filter(Boolean).map((f) => `- ${f}`)].join("\n");
      });
      const subs = cast.filter((x) => x.role === "sub_protagonist").length;
      const protagonists = cast.filter((x) => x.role === "protagonist").length;
      return {
        text: `주인공 ${protagonists}명, 서브 주인공 ${subs}명을 포함한 확정 캐스트(${cast.length}명)입니다. 이름·역할·관계를 바꾸지 마세요.\n\n${blocks.join("\n\n")}`,
        entityIds: cast.map((x) => x.c.entityId).filter((x): x is string => !!x),
      };
    },
  };

  /** N2 (concept → onboarding): seed the cast from the approved brief when it is still empty */
  const onNovelStatusChanged = async (ctx: NovelStatusChangedContext) => {
    if (ctx.from !== "concept" || ctx.to !== "onboarding") return;
    if ((await repo.list(ctx.tx.db, ctx.scope)).length) return;
    await importInTx(ctx.tx, ctx.scope, ctx.actor);
  };

  const goalGuard = async ({ tx, scope }: { tx: Tx; scope: NovelScope }) => {
    const cast = await repo.list(tx.db, scope);
    if (isCastConfirmed(cast)) return;
    const blockers = castBlockers(cast);
    throw new DomainValidationError(
      "cast_not_confirmed",
      "캐릭터 설정을 확정한 뒤에 연재 목표를 저장할 수 있습니다. 캐릭터 화면에서 주인공을 정하고 [캐스트 확정]을 누르세요.",
      { blockers, unconfirmed: cast.filter((c) => c.status !== "confirmed").map((c) => c.id) },
    );
  };

  return { service, handlers: { draftCast: draftCastHandler, draftSheet: draftSheetHandler }, onNovelStatusChanged, goalGuard, isEmptyValue };
}

export type CastApp = ReturnType<typeof createCastService>;
export type { CharacterSheetView, DesignSheetSpec };
