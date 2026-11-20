/**
 * world — 세계관 온톨로지 생성·검토 (설계 추가).
 *
 *  - N2 (concept → onboarding) enqueues `build_world_ontology` (world_keeper, coalesced per novel, cycle key `world`).
 *  - The task reads the approved brief (+ the confirmed cast section and existing world items) and asks the model —
 *    with web search when the novel allows it — for factions, places, systems & power rules, key objects, history,
 *    relations and constraint rules. Commit writes them into the ontology as CANDIDATES (entities status candidate,
 *    facts canon_status candidate, source system_derived / task) and one `world_ontology_items` row per candidate
 *    (kind, task, run, web sources).
 *  - Review: approve (EN3 + F3 through ontology), approve all, edit (name / summary / statement / predicate), reject
 *    (F4 + EN5). "다시 생성" never touches approved, user-made, user-edited or partly canon items (entity already active
 *    / a fact already approved); untouched AI candidates of the previous run that the new run does not propose again
 *    are superseded; names the author rejected are never proposed again; a same-name candidate of another step (bible /
 *    extraction) is neither duplicated nor used as a relation end. Reject withdraws candidates only (a partly canon
 *    item is refused) and marks a still-referenced entity `rejected` so no promotion path activates it.
 *  - Context: section `world` (approved facts + candidates flagged 미확정) for plan_series_bible / plan_structure,
 *    `renderWorldContext` for the cast draft.
 */
import { ENUMS, labelKo, type WorldItemDto, type WorldItemKind, type WorldOntologyView, type WorldReviewResult } from "@ncs/shared";
import type { WorldOntologyItemsRow } from "@ncs/db/schema";
import { ConflictError, DomainValidationError, NotImplementedError, actors, type ActorRef, type NovelScope, type Platform, type Tx } from "../../../platform/index.js";
import type { AuditService } from "../../audit/index.js";
import { handleLeakIssue, isHandleShaped, leakedHandleTokens, type AgentTaskHandler, type AgentsService, type ContextPack } from "../../agents/index.js";
import type { ConceptService } from "../../concept/index.js";
import type { LlmCitation, LlmService } from "../../llm/index.js";
import type { NovelService, NovelStatusChangedContext } from "../../novel/index.js";
import { lookupPredicate, normalizedKey, type CandidateFactDraft, type Entity, type FactAtAnchor, type OntologyService } from "../../ontology/index.js";
import { TaskFailure, type CommitOutcome, type OrchestrationService, type Task } from "../../orchestration/index.js";
import { itemsRepo } from "../adapters/db/items-repo.js";
import {
  WORLD_PREDICATES,
  clip,
  cleanName,
  isWorldPredicate,
  normalizeProposal,
  pickSources,
  worldProposalSchema,
  type ProposedEntity,
  type WorldProposal,
} from "../domain/proposal.js";
import { z } from "zod";

export const WORLD_TEMPLATE_ID = "world_keeper.build_world_ontology@0.1.0";
export const WORLD_CYCLE_KEY = "world";

export interface WorldServiceDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  ontology: OntologyService;
  orchestration: OrchestrationService;
  agents: AgentsService;
  llm: LlmService;
  concept: ConceptService;
}

export const buildWorldInputSchema = z.object({
  instructions: z.string().max(2000).optional(),
  /** "auto" = enqueued by the concept approval (N2), "user" = [세계관 생성] / [다시 생성] */
  trigger: z.enum(["auto", "user"]).default("auto"),
});
export type BuildWorldInput = z.infer<typeof buildWorldInputSchema>;

interface WorldProposalEnvelope {
  raw: WorldProposal;
  /** X1… → existing entity id (listed to the model so it can relate to them without re-creating them) */
  existing: Record<string, string>;
  citations: LlmCitation[];
  webSearch: { status: string; requests: number; note: string | null } | null;
  modelId: string;
}

const ACTIVE_TASK = ["pending", "ready", "running", "blocked"] as const;
const WORLD_ENTITY_TYPES = ["organization", "place", "ability", "rule", "item", "event"] as const;
const MAIN_PREDICATES = new Set(["rule_statement", "ability_cost"]);
const MAX_CONTEXT_CHARS = 6000;

const RULES = `## 세계관 온톨로지 작성 규칙
- 출력 JSON 필드: factions(세력·조직·가문), places(장소·지리, parent_key = 상위 장소 key), systems(체계·능력 규칙: system_kind "ability" = 능력·힘·등급 체계(예: 성좌, 헌터 등급, 마법 위계), "rule" = 사회·자연 법칙; cost_or_rule = 능력의 대가 또는 규칙 문장; limits = 한계), objects(핵심 물건·개념), history(역사·과거 사건: when = 시기, place_key = 장소 key, participant_keys = 참여 세력/인물 key), relations(subject_key, predicate, object_key), constraints(작품 내내 반드시 지켜야 할 규칙: title, statement, from_brief = 브리프에 적힌 규칙이면 true).
- key는 이 응답 안에서만 쓰는 짧은 영문 식별자(예: f_guild, p_capital)입니다. 이미 있는 항목은 목록의 X 키(X1, X2 …)로만 가리키고 다시 만들지 않습니다.
- relations.predicate는 다음 중 하나만 씁니다: ${WORLD_PREDICATES.join(", ")}. (located_in: 장소→상위 장소, headquartered_in: 조직→장소, part_of: 하위 조직→상위 조직, member_of / leader_of / subordinate_of: 인물→조직, ally_of / enemy_of: 조직·인물 사이, owns: 조직·인물→물건, has_ability: 인물→능력 체계, participated_in: 조직·인물→사건, occurred_at: 사건→장소)
- 인물(등장인물)은 새로 만들지 않습니다. 인물은 목록에 X 키가 있을 때만 관계에 씁니다.
- 브리프와 모순되는 설정을 만들지 않습니다. 브리프에 없는 설정은 브리프의 장르·분위기에 맞는 제안으로 냅니다. 실존 인물·실존 단체를 작품 속 세력으로 쓰지 않습니다.
- 분량: 분류마다 2~8개, 관계는 꼭 필요한 것만 20개 이내, 요약은 1~2문장. 한국어로 씁니다.
- 'E7'처럼 E와 숫자로 된 기호는 이름이 아닙니다. 이름·별칭·요약·규칙 문장에는 쓰지 않고 인물·장소의 이름으로 씁니다.
- 바깥 사실(역사·제도·지리·장르 관습)을 웹 검색으로 확인해 반영한 항목은 source_urls에 실제로 참고한 URL을 적습니다. 검색하지 않았으면 빈 배열입니다. 검색 결과를 반영했다면 sources_note 끝에 '출처:' 목록을 붙입니다.`;

/** proposal fields that carry keys / URLs (resolved or cited, never read as sentences) — 설계 추가 0026 */
const WORLD_REFERENCE_KEYS = ["key", "parent_key", "place_key", "participant_keys", "subject_key", "object_key", "predicate", "source_urls", "sources_note"];

export function createWorldService(deps: WorldServiceDeps) {
  const { platform, ontology, orchestration, concept, novel } = deps;
  const { uow, clock, ids } = platform;
  const log = platform.log.child({ module: "world" });

  /** the brief the novel was approved with (novels.approved_concept_brief_id), else the session's approved brief */
  async function approvedBrief(scope: NovelScope, tx?: Tx) {
    const n = await novel.getNovel(scope, tx);
    if (n.approvedConceptBriefId) return concept.getBrief(scope, n.approvedConceptBriefId, tx);
    return concept.getApprovedBrief(scope, tx);
  }

  // ── generation ───────────────────────────────────────────────────────────
  async function enqueue(tx: Tx, scope: NovelScope, actor: ActorRef, input: BuildWorldInput): Promise<{ taskId: string; created: boolean }> {
    if (!orchestration.getTaskKind("build_world_ontology")) throw new NotImplementedError("세계관 온톨로지 생성");
    return orchestration.createTask(tx, scope, {
      kind: "build_world_ontology",
      targetType: "novel",
      targetId: scope.novelId,
      input,
      createdBy: actor,
      cycleKey: WORLD_CYCLE_KEY,
      priority: 150,
    });
  }

  async function requestGeneration(scope: NovelScope, actor: ActorRef, instructions?: string): Promise<{ taskId: string; created: boolean }> {
    return uow.run(async (tx) => {
      // one requester at a time: two clicks (two tabs) must not both miss the active task and queue two runs
      await itemsRepo.lock(tx.db, scope);
      const n = await novel.getNovel(scope, tx);
      if (n.status === "concept" || !(await approvedBrief(scope, tx))) {
        throw new DomainValidationError("concept_not_approved", "컨셉 브리프가 승인된 뒤에 세계관 온톨로지를 만들 수 있습니다.");
      }
      const text = instructions?.trim();
      const r = await enqueue(tx, scope, actor, { trigger: "user", ...(text ? { instructions: text } : {}) });
      // a queued / running task is reused (TC-2) and keeps its own input — never drop the author's request silently
      if (!r.created && text) {
        throw new ConflictError("world_generation_busy", "세계관을 이미 만들고 있어 추가 요청을 반영할 수 없습니다. 지금 작업이 끝난 뒤 다시 생성해 주세요.");
      }
      return r;
    });
  }

  /** N2: the concept brief was approved — start the world ontology (once; a running/queued task is reused) */
  const onNovelStatusChanged = async (ctx: NovelStatusChangedContext) => {
    if (ctx.from !== "concept" || ctx.to !== "onboarding") return;
    if (!orchestration.getTaskKind("build_world_ontology")) return;
    await enqueue(ctx.tx, ctx.scope, ctx.actor, { trigger: "auto" });
  };

  // ── existing entities / items helpers ─────────────────────────────────────
  type NameIndex = Map<string, string[]>;
  async function entityIndex(scope: NovelScope, tx?: Tx): Promise<{ list: Entity[]; names: Map<string, string>; index: NameIndex }> {
    const items = await ontology.listEntities(scope, { statuses: ["candidate", "active"], limit: 500 }, tx);
    const index: NameIndex = new Map();
    const names = new Map<string, string>();
    for (const it of items) {
      names.set(it.entity.id, it.preferredName);
      for (const n of await ontology.listEntityNames(scope, it.entity.id, tx)) {
        if (n.status === "retired") continue;
        const k = `${it.entity.entityType}|${n.normalizedKey}`;
        index.set(k, [...(index.get(k) ?? []), it.entity.id]);
      }
    }
    return { list: items.map((x) => x.entity), names, index };
  }

  const preserved = (it: WorldOntologyItemsRow) => it.status === "approved" || it.userEdited || it.origin === "user";
  const isCanonStatus = (s: string | undefined) => s === "approved" || s === "published_locked";

  /**
   * Items "다시 생성" / supersede must never touch: approved / user-made / user-edited rows, and pending rows whose
   * ontology side is already (partly) canon — an entity activated by a partial approval or a bible approval, or a
   * fact approved while a sibling fact was held. Rewriting those would retract approved canon.
   */
  async function keptOf(scope: NovelScope, items: WorldOntologyItemsRow[], tx?: Tx): Promise<(it: WorldOntologyItemsRow) => boolean> {
    const entIds = [...new Set(items.map((i) => i.entityId).filter((x): x is string => !!x))];
    const ents = entIds.length ? await ontology.getEntities(scope, entIds, tx) : [];
    const entStatus = new Map(ents.map((e) => [e.id, e.status as string]));
    const fs = await ontology.getFactsByIds(scope, [...new Set(items.flatMap((i) => i.factIds))], tx);
    const factStatus = new Map(fs.map((f) => [f.factId, f.canonStatus as string]));
    return (it) => preserved(it) || (!!it.entityId && (entStatus.get(it.entityId) ?? "candidate") !== "candidate") || it.factIds.some((f) => isCanonStatus(factStatus.get(f)));
  }

  /** `${entityType}|${normalizedKey}` of every name of entities whose world item the author rejected (never proposed again) */
  async function rejectedNames(scope: NovelScope, tx?: Tx): Promise<{ keys: Set<string>; labels: string[] }> {
    const rows = (await itemsRepo.list(tx?.db ?? uow.db, scope, { statuses: ["rejected"] })).filter((r) => r.entityId);
    const keys = new Set<string>();
    const labels: string[] = [];
    if (!rows.length) return { keys, labels };
    const ents = await ontology.getEntities(scope, [...new Set(rows.map((r) => r.entityId!))], tx);
    for (const e of ents) {
      for (const n of await ontology.listEntityNames(scope, e.id, tx)) {
        keys.add(`${e.entityType}|${n.normalizedKey}`);
        if (n.isPreferred) labels.push(`${labelKo("entity_type", e.entityType)} ${n.surface}`);
      }
    }
    return { keys, labels };
  }

  // ── task handler ──────────────────────────────────────────────────────────
  const handler: AgentTaskHandler<BuildWorldInput, WorldProposalEnvelope> = {
    kind: "build_world_ontology",
    role: "world_keeper",
    promptTemplateVersion: WORLD_TEMPLATE_ID,
    inputSchema: buildWorldInputSchema,
    allowedWrites: ["ontology.createEntity", "ontology.writeCandidateFacts", "ontology.withdrawFacts", "ontology.updateEntity"],
    async buildContext(run, _input, builder) {
      const scope = { novelId: run.novelId };
      const tl = await ontology.getDefaultTimeline(scope);
      try {
        return await builder.build(run, {
          anchor: { storyPoint: 0, timelineId: tl.id },
          seeds: { entityIds: [], setupIds: [], answerIds: [], mentionIds: [] },
          sections: ["instruction", "cast"],
          maxInputTokens: 30_000,
          hopPredicates: { hop2: [] },
        });
      } catch (err) {
        if (err instanceof NotImplementedError) return { snapshotId: "", system: "", messages: [], handles: { entities: [], names: [] }, tokenEstimate: 0, droppedSections: [] } satisfies ContextPack;
        throw err;
      }
    },
    async execute(run, input, context, llm) {
      const scope = { novelId: run.novelId };
      const brief = await approvedBrief(scope);
      if (!brief) throw new TaskFailure("internal", "승인된 컨셉 브리프가 없습니다. 컨셉을 승인한 뒤 다시 생성하세요.", false);
      const n = await novel.getNovel(scope);
      const { list, names } = await entityIndex(scope);
      const items = await itemsRepo.list(uow.db, scope, { statuses: ["pending", "approved"] });
      const itemByEntity = new Map(items.filter((i) => i.entityId).map((i) => [i.entityId!, i]));
      const kept = await keptOf(scope, items);
      // existing entities the model may relate to: cast characters, approved / user world items, user-made entities
      const listed = list.filter((e) => {
        const it = itemByEntity.get(e.id);
        if (e.entityType === "character") return e.status === "active";
        if (!(WORLD_ENTITY_TYPES as readonly string[]).includes(e.entityType)) return false;
        return it ? kept(it) : e.status === "active";
      });
      const rejected = await rejectedNames(scope);
      const existing: Record<string, string> = {};
      const lines = listed.slice(0, 120).map((e, i) => {
        const key = `X${i + 1}`;
        existing[key] = e.id;
        const it = itemByEntity.get(e.id);
        const tag = it ? labelKo("world_item_kind", it.kind) : labelKo("entity_type", e.entityType);
        return `- ${key} | ${tag} | ${names.get(e.id) ?? e.id}${e.summary ? ` — ${clip(e.summary, 160)}` : ""}`;
      });
      const vars: Record<string, unknown> = {
        작품: `제목: ${n.title}\n장르: ${n.genre ?? "미정"}\n연령 등급: ${labelKo("age_rating", n.ageRating)}`,
        승인된_컨셉_브리프: brief.contentMd,
        이미_있는_항목: lines.length ? `${lines.join("\n")}\n(위 항목은 다시 만들지 말고 key로만 가리킵니다.)` : "(없음)",
        ...(input.instructions ? { 작가의_추가_요청: input.instructions } : {}),
      };
      const prompt = deps.agents.renderPrompt(WORLD_TEMPLATE_ID, vars, context);
      const out = await llm.call({
        run,
        purpose: "build_world_ontology",
        system: `${prompt.system}\n\n${RULES}${rejected.labels.length ? `\n- 작가가 기각한 항목입니다. 같은 이름·같은 설정으로 다시 제안하지 않습니다: ${rejected.labels.slice(0, 60).join(", ")}` : ""}`,
        messages: prompt.messages,
        output: { kind: "object", schemaName: "WorldOntologyProposal", schema: worldProposalSchema },
        maxOutputTokens: 12_000,
        webSearch: true,
      });
      const v = worldProposalSchema.safeParse(out.value);
      if (!v.success) throw new TaskFailure("invalid_output", "세계관 온톨로지 응답 형식이 올바르지 않습니다.", true);
      // 설계 추가 0026 (P3): this task is shown no entity handles, so a handle token in a name / summary / statement cannot
      // be mapped to anyone — the answer is not stored and the next attempt is told why. Keys and URLs are references.
      const leaks = leakedHandleTokens(v.data, await ontology.storyHandleTokens(scope), { skipKeys: WORLD_REFERENCE_KEYS });
      if (leaks.length) throw new TaskFailure("invalid_output", `세계관 온톨로지 응답의 ${[...new Set(leaks.map((l) => l.path))].slice(0, 3).join(", ")}: ${handleLeakIssue(leaks)}`, true);
      return {
        raw: v.data,
        existing,
        citations: out.webSearch?.citations ?? [],
        webSearch: out.webSearch ? { status: out.webSearch.status, requests: out.webSearch.requests, note: out.webSearch.note ?? null } : null,
        modelId: out.modelId,
      };
    },
    async commit(tx, run, _input, p, task) {
      return commitProposal(tx, { novelId: run.novelId }, p, task, actors.agent("world_keeper", run.runId), run.runId);
    },
  };

  async function commitProposal(tx: Tx, scope: NovelScope, p: WorldProposalEnvelope, task: Task, actor: ActorRef, runId: string): Promise<CommitOutcome> {
    await itemsRepo.lock(tx.db, scope);
    const { schema } = await ontology.getSchema(scope, tx);
    const tl = await ontology.getDefaultTimeline(scope, tx);
    const norm = normalizeProposal(p.raw);
    const { list, index } = await entityIndex(scope, tx);
    const typeOf = new Map(list.map((e) => [e.id, e.entityType as string]));
    const items = await itemsRepo.list(tx.db, scope, { statuses: ["pending", "approved"] });
    const itemByEntity = new Map(items.filter((i) => i.entityId).map((i) => [i.entityId!, i]));
    const itemByFact = new Map(items.flatMap((i) => i.factIds.map((f) => [f, i] as const)));
    const kept = await keptOf(scope, items, tx);
    const rejected = await rejectedNames(scope, tx);
    const statusOf = new Map(list.map((e) => [e.id, e.status as string]));
    let skippedRejected = 0;
    const touched = new Set<string>();
    const keyToEntity = new Map<string, string>(Object.entries(p.existing).filter(([, id]) => typeOf.has(id)));
    const now = clock.date();
    const src = { refType: "task" as const, refId: task.id };
    const created: string[] = [];
    const sourcesOf = (urls: string[]) => pickSources(urls, p.citations).map((c) => ({ url: c.url, title: c.title, retrievedAt: c.retrievedAt }));

    const writeAttrs = async (entityId: string, e: ProposedEntity): Promise<string[]> => {
      const drafts: CandidateFactDraft[] = [];
      for (const a of e.attributes) {
        const def = lookupPredicate(schema, a.predicate);
        if (!def || def.kind !== "attribute" || !def.def.domain.includes(e.entityType)) continue;
        drafts.push({ factKind: def.def.factKind, subjectEntityId: entityId, predicate: a.predicate, value: a.value, timelineId: tl.id, storyRange: { from: 0, to: null }, sourceKind: "system_derived", source: src, runId });
      }
      if (!drafts.length) return [];
      const r = await ontology.writeCandidateFacts(tx, scope, drafts, actor);
      return r.written.filter((w) => w.diffKind !== "duplicate").map((w) => w.factId);
    };

    // (1) entities: reuse same-name entities (never overwrite kept ones), refresh untouched AI candidates, create the rest
    for (const e of norm.entities) {
      if (isHandleShaped(e.name)) continue; // 설계 추가 0026 (P5): a handle is never an entity (its relations drop with it)
      const nameKey = `${e.entityType}|${normalizedKey(e.name)}`;
      // the author rejected this one before: never bring it back as a new candidate (its relations drop with it)
      if (rejected.keys.has(nameKey) || e.aliases.some((a) => rejected.keys.has(`${e.entityType}|${normalizedKey(a)}`))) {
        skippedRejected++;
        continue;
      }
      const match = (index.get(nameKey) ?? [])[0];
      if (match) {
        const it = itemByEntity.get(match);
        // another step's candidate (bible / extraction) with no world item: not reviewable here, so the world step
        // neither duplicates it nor hangs relations on it (they would stay held with no way to approve them here)
        if (!it && statusOf.get(match) === "candidate") continue;
        keyToEntity.set(e.key, match);
        if (it) touched.add(it.id);
        if (!it || kept(it)) continue;
        // untouched AI candidate of an earlier run: replace its summary / attribute facts with this run's version
        if (it.factIds.length) await ontology.withdrawFacts(tx, scope, it.factIds, actor, "세계관 다시 생성: 새 후보로 바뀜");
        await ontology.updateEntity(tx, scope, match, { summary: e.summary || null }, actor);
        const factIds = await writeAttrs(match, e);
        await itemsRepo.update(tx.db, scope, it.id, { kind: e.kind, factIds, taskId: task.id, runId, sources: sourcesOf(e.sourceUrls), fromBrief: e.fromBrief, heldReason: null, updatedAt: now });
        continue;
      }
      const r = await ontology.createEntity(
        tx,
        scope,
        {
          entityType: e.entityType,
          preferredName: { surface: e.name },
          status: "candidate",
          summary: e.summary || null,
          source: { kind: "system_derived", refType: "task", refId: task.id },
          names: e.aliases.filter((a) => !isHandleShaped(a)).map((a) => ({ surface: a, nameKind: "alias" as const, status: "proposed" as const, source: { kind: "system_derived" as const, refType: "task" as const, refId: task.id } })),
        },
        actor,
      );
      // review-gated: EN3(b) promotion only activates entities whose check passed — this one waits for the author's
      // world review, or for a bible approval that names it (the author approving the bible approves the entity)
      await ontology.setEquivalenceCheck(tx, scope, r.entity.id, { status: "review", source: "world_ontology", taskId: task.id });
      keyToEntity.set(e.key, r.entity.id);
      typeOf.set(r.entity.id, e.entityType);
      index.set(`${e.entityType}|${normalizedKey(e.name)}`, [r.entity.id]);
      created.push(r.entity.id);
      const factIds = await writeAttrs(r.entity.id, e);
      const row = await itemsRepo.insert(tx.db, {
        id: ids.next("woi"),
        novelId: scope.novelId,
        kind: e.kind,
        status: "pending",
        origin: "agent",
        entityId: r.entity.id,
        factIds,
        taskId: task.id,
        runId,
        sources: sourcesOf(e.sourceUrls),
        fromBrief: e.fromBrief,
        createdAt: now,
        updatedAt: now,
      });
      touched.add(row.id);
    }

    // (2) relations between known endpoints, checked against base@1 domain / range
    let relations = 0;
    for (const r of norm.relations) {
      const s = keyToEntity.get(r.subjectKey);
      const o = keyToEntity.get(r.objectKey);
      if (!s || !o || s === o) continue;
      const def = lookupPredicate(schema, r.predicate);
      if (!def || def.kind !== "relation") continue;
      const range = def.def.range;
      if (!def.def.domain.includes(typeOf.get(s) ?? "") || !Array.isArray(range) || !range.includes(typeOf.get(o) ?? "")) continue;
      const res = await ontology.writeCandidateFacts(
        tx,
        scope,
        [{ factKind: def.def.factKind, subjectEntityId: s, predicate: r.predicate, objectEntityId: o, timelineId: tl.id, storyRange: { from: 0, to: null }, sourceKind: "system_derived", source: src, runId }],
        actor,
      );
      const w = res.written[0];
      if (!w) continue;
      const owner = itemByFact.get(w.factId);
      if (w.diffKind === "duplicate") {
        if (owner) {
          touched.add(owner.id);
          if (!kept(owner) && owner.kind === "relation") await itemsRepo.update(tx.db, scope, owner.id, { taskId: task.id, runId, updatedAt: now });
        }
        continue;
      }
      const row = await itemsRepo.insert(tx.db, {
        id: ids.next("woi"),
        novelId: scope.novelId,
        kind: "relation",
        status: "pending",
        origin: "agent",
        entityId: null,
        factIds: [w.factId],
        taskId: task.id,
        runId,
        sources: sourcesOf(r.sourceUrls),
        note: r.note || null,
        createdAt: now,
        updatedAt: now,
      });
      touched.add(row.id);
      itemByFact.set(w.factId, row);
      relations++;
    }

    // (3) supersede untouched AI candidates of earlier runs (relations first, then entities that lost every reference)
    const stale = items.filter((i) => i.status === "pending" && !kept(i) && !touched.has(i.id) && i.taskId !== task.id);
    const staleIds = new Set(stale.map((i) => i.id));
    // an entity still used by a world relation that stays for review keeps its own item (decided before anything is
    // withdrawn, so an item is never left pending with its facts already withdrawn)
    const liveRels = [...itemByFact.values()].filter((i) => i.kind === "relation" && i.status === "pending" && !staleIds.has(i.id));
    const liveRelFacts = await ontology.getFactsByIds(scope, [...new Set(liveRels.flatMap((r) => r.factIds))], tx);
    const usedByLiveRel = new Set(liveRelFacts.filter((f) => f.canonStatus === "candidate").flatMap((f) => [f.subjectEntityId, f.objectEntityId ?? ""]));
    let superseded = 0;
    for (const it of [...stale.filter((i) => i.kind === "relation"), ...stale.filter((i) => i.kind !== "relation")]) {
      if (it.entityId && usedByLiveRel.has(it.entityId)) continue;
      if (it.factIds.length) await ontology.withdrawFacts(tx, scope, it.factIds, actor, "세계관 다시 생성: 이번 결과에 없음");
      if (it.entityId) {
        const ent = (await ontology.getEntities(scope, [it.entityId], tx))[0];
        if (ent?.status === "candidate") {
          try {
            await ontology.setEntityStatus(tx, scope, it.entityId, "retired", actor, "세계관 다시 생성: 이번 결과에 없음");
          } catch (err) {
            // referenced outside the world step (bible / extraction): that step owns the candidate from now on;
            // the world item is closed either way (its facts are already withdrawn)
            if (!(err instanceof ConflictError)) throw err;
          }
        }
      }
      await itemsRepo.update(tx.db, scope, it.id, { status: "superseded", updatedAt: now });
      superseded++;
    }
    log.info({ novelId: scope.novelId, taskId: task.id, entities: norm.entities.length, created: created.length, relations, superseded, skippedRejected, webSearch: p.webSearch?.status ?? null }, "world ontology candidates written");
    return {
      kind: "done",
      outputRefs: [...created.slice(0, 60).map((id) => ({ refType: "entity" as const, refId: id }))],
    };
  }

  // ── read model ───────────────────────────────────────────────────────────
  async function itemDtos(scope: NovelScope, rows: WorldOntologyItemsRow[], tx?: Tx): Promise<WorldItemDto[]> {
    const { schema } = await ontology.getSchema(scope, tx);
    const ents = await ontology.listEntities(scope, { statuses: ["candidate", "active", "merged", "retired"], limit: 2000 }, tx);
    const entById = new Map(ents.map((x) => [x.entity.id, x]));
    const facts = await ontology.getFactsByIds(scope, [...new Set(rows.flatMap((r) => r.factIds))], tx);
    const factById = new Map(facts.map((f) => [f.factId, f]));
    const out: WorldItemDto[] = [];
    for (const r of rows) {
      const ent = r.entityId ? entById.get(r.entityId) : undefined;
      const fs = r.factIds.map((id) => factById.get(id)).filter((f): f is FactAtAnchor => !!f);
      const aliases = r.entityId ? (await ontology.listEntityNames(scope, r.entityId, tx)).filter((n) => !n.isPreferred && n.status !== "retired").map((n) => n.surface) : [];
      const main = fs.find((f) => MAIN_PREDICATES.has(f.predicate) && f.canonStatus !== "rejected" && f.canonStatus !== "retracted");
      const rel = r.kind === "relation" ? fs[0] : undefined;
      const relDef = rel ? schema.relationTypes.find((t) => t.key === rel.predicate) : undefined;
      const nameOf = (id: string | null | undefined) => (id ? (entById.get(id)?.preferredName ?? id) : "?");
      out.push({
        id: r.id,
        kind: r.kind,
        status: displayStatus(r, ent?.entity.status ?? null, fs),
        origin: r.origin,
        userEdited: r.userEdited,
        fromBrief: r.fromBrief,
        entityId: r.entityId,
        entityType: (ent?.entity.entityType as WorldItemDto["entityType"]) ?? null,
        entityStatus: ent?.entity.status ?? null,
        name: rel ? `${nameOf(rel.subjectEntityId)} — ${relDef?.labelKo ?? rel.predicate} → ${nameOf(rel.objectEntityId)}` : (ent?.preferredName ?? "?"),
        aliases,
        summary: ent?.entity.summary ?? null,
        statement: main ? valueText(main.value) : null,
        details: fs.filter((f) => f.predicate === "ability_limit" && f.canonStatus !== "rejected" && f.canonStatus !== "retracted").map((f) => valueText(f.value)),
        relation: rel
          ? {
              subjectEntityId: rel.subjectEntityId ?? null,
              subjectName: nameOf(rel.subjectEntityId),
              predicate: rel.predicate,
              predicateLabel: relDef?.labelKo ?? rel.predicate,
              objectEntityId: rel.objectEntityId ?? null,
              objectName: nameOf(rel.objectEntityId),
            }
          : null,
        facts: fs.map((f) => ({ factId: f.factId, predicate: f.predicate, canonStatus: f.canonStatus, text: f.text })),
        sources: r.sources ?? [],
        note: r.note,
        heldReason: r.heldReason,
        taskId: r.taskId,
        runId: r.runId,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      });
    }
    return out;
  }

  /** a pending row whose ontology side was approved elsewhere (e.g. bible approval) reads as approved */
  function displayStatus(r: WorldOntologyItemsRow, entityStatus: string | null, fs: FactAtAnchor[]): WorldOntologyItemsRow["status"] {
    if (r.status !== "pending") return r.status;
    const live = fs.filter((f) => f.canonStatus !== "rejected" && f.canonStatus !== "retracted");
    const factsCanon = live.every((f) => f.canonStatus === "approved" || f.canonStatus === "published_locked");
    if (r.entityId) return entityStatus === "active" && factsCanon ? "approved" : "pending";
    return live.length > 0 && factsCanon ? "approved" : "pending";
  }

  async function getView(scope: NovelScope): Promise<WorldOntologyView> {
    const briefApproved = !!(await approvedBrief(scope));
    const rows = await itemsRepo.list(uow.db, scope, { statuses: ["pending", "approved", "rejected"] });
    const dtos = await itemDtos(scope, rows);
    const tasks = (await orchestration.listTasks(scope, { kinds: ["build_world_ontology"], includeCancelled: true, limit: 20 })).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const latest = tasks[0];
    const finished = tasks.find((t) => t.status === "done" || t.status === "failed");
    let webSearch: WorldOntologyView["generation"]["webSearch"] = null;
    let sources: WorldOntologyView["generation"]["sources"] = [];
    if (finished?.latestRun) {
      try {
        const calls = await deps.llm.listProviderCalls(scope, finished.latestRun.id);
        for (const c of calls) {
          const w = (c.response as { webSearch?: { status?: string; requests?: number; citations?: Array<{ url: string; title: string | null; retrievedAt: string }>; note?: string } } | null)?.webSearch;
          if (!w) continue;
          const status = (["used", "not_used", "disabled", "unsupported"] as const).find((x) => x === w.status) ?? "not_used";
          webSearch = { status, requests: w.requests ?? 0, note: w.note ?? null };
          sources = (w.citations ?? []).slice(0, 12);
        }
      } catch (err) {
        if (!(err instanceof NotImplementedError)) throw err;
      }
    }
    const state: WorldOntologyView["generation"]["state"] = !latest
      ? briefApproved
        ? "none"
        : "waiting_brief"
      : latest.status === "running"
        ? "running"
        : (ACTIVE_TASK as readonly string[]).includes(latest.status)
          ? "queued"
          : latest.status === "done"
            ? "done"
            : "failed";
    const groups = ENUMS.world_item_kind.map((kind) => ({ kind, items: dtos.filter((d) => d.kind === kind) })).filter((g) => g.items.length > 0);
    return {
      briefApproved,
      generation: {
        state,
        taskId: latest?.id ?? null,
        taskStatus: latest?.status ?? null,
        finishedAt: finished?.latestRun?.finishedAt?.toISOString() ?? null,
        error: latest && (latest.status === "failed" || latest.status === "cancelled") ? (latest.latestRun?.errorMessage ?? (latest.status === "cancelled" ? "작업이 취소됐습니다." : "생성에 실패했습니다.")) : null,
        webSearch,
        sources,
        createdAt: latest?.createdAt.toISOString() ?? null,
      },
      counts: {
        pending: dtos.filter((d) => d.status === "pending").length,
        approved: dtos.filter((d) => d.status === "approved").length,
        rejected: dtos.filter((d) => d.status === "rejected").length,
      },
      groups,
    };
  }

  // ── review ───────────────────────────────────────────────────────────────
  const HELD_KO: Record<string, string> = {
    entity_not_active: "연결된 항목을 먼저 승인하세요.",
    schema_violation: "기존 캐논과 충돌해 승인하지 못했습니다.",
    conflict: "기존 사실과 값이 달라 승인하지 못했습니다. 내용을 고친 뒤 다시 승인하세요.",
    link_pending: "연결 대상이 정해지지 않았습니다.",
  };
  const heldKo = (reason: string) => HELD_KO[reason] ?? (reason.startsWith("slot_conflict") ? "같은 자리에 이미 확정된 사실이 있어 승인하지 못했습니다." : `승인하지 못했습니다 (${reason}).`);

  async function approveRow(tx: Tx, scope: NovelScope, it: WorldOntologyItemsRow, actor: ActorRef): Promise<{ ok: boolean; reason?: string }> {
    if (it.status !== "pending") return { ok: it.status === "approved" };
    if (it.entityId) {
      const ent = (await ontology.getEntities(scope, [it.entityId], tx))[0];
      if (!ent) return { ok: false, reason: "엔티티를 찾을 수 없습니다." };
      if (ent.status === "candidate") await ontology.setEntityStatus(tx, scope, it.entityId, "active", actor, "세계관 후보 승인");
      else if (ent.status !== "active") return { ok: false, reason: "폐기되거나 병합된 엔티티입니다." };
    } else {
      const f = (await ontology.getFactsByIds(scope, it.factIds, tx))[0];
      const ends = f ? await ontology.getEntities(scope, [f.subjectEntityId, f.objectEntityId ?? ""].filter(Boolean), tx) : [];
      const pending = ends.filter((e) => e.status !== "active");
      if (pending.length) {
        const names = await Promise.all(pending.map(async (e) => (await ontology.listEntityNames(scope, e.id, tx)).find((n) => n.isPreferred)?.surface ?? e.id));
        return { ok: false, reason: `연결된 항목(${names.join(", ")})을 먼저 승인하세요.` };
      }
    }
    const live = (await ontology.getFactsByIds(scope, it.factIds, tx)).filter((f) => f.canonStatus === "candidate").map((f) => f.factId);
    if (live.length) {
      const r = await ontology.approveCandidateFacts(tx, scope, live, actor);
      const first = r.held[0];
      if (first) {
        const reason = heldKo(r.heldReasons[first] ?? "held");
        await itemsRepo.update(tx.db, scope, it.id, { heldReason: reason, updatedAt: clock.date() });
        return { ok: false, reason };
      }
    }
    await itemsRepo.update(tx.db, scope, it.id, { status: "approved", heldReason: null, updatedAt: clock.date() });
    return { ok: true };
  }

  async function approveItem(scope: NovelScope, itemId: string, actor: ActorRef): Promise<WorldReviewResult> {
    return uow.run(async (tx) => {
      await itemsRepo.lock(tx.db, scope);
      const it = await itemsRepo.get(tx.db, scope, itemId, true);
      if (it.status === "rejected" || it.status === "superseded") throw new ConflictError("world_item_closed", "기각되거나 대체된 항목은 승인할 수 없습니다.");
      const r = await approveRow(tx, scope, it, actor);
      return { approved: r.ok && it.status === "pending" ? 1 : 0, rejected: 0, held: r.ok ? [] : [{ itemId, reason: r.reason ?? "" }] };
    });
  }

  async function approveAll(scope: NovelScope, actor: ActorRef): Promise<WorldReviewResult> {
    return uow.run(async (tx) => {
      await itemsRepo.lock(tx.db, scope);
      const rows = await itemsRepo.list(tx.db, scope, { statuses: ["pending"] });
      const res: WorldReviewResult = { approved: 0, rejected: 0, held: [] };
      // entities first so relations find active endpoints
      for (const it of [...rows.filter((r) => r.kind !== "relation"), ...rows.filter((r) => r.kind === "relation")]) {
        const r = await approveRow(tx, scope, it, actor);
        if (r.ok) res.approved++;
        else res.held.push({ itemId: it.id, reason: r.reason ?? "" });
      }
      return res;
    });
  }

  async function rejectRow(tx: Tx, scope: NovelScope, it: WorldOntologyItemsRow, actor: ActorRef, reason: string): Promise<void> {
    // candidates only: an approved fact is canon and is retracted on the ontology screen, never by a world reject
    const cand = (await ontology.getFactsByIds(scope, it.factIds, tx)).filter((f) => f.canonStatus === "candidate").map((f) => f.factId);
    if (cand.length) await ontology.withdrawFacts(tx, scope, cand, actor, reason);
    if (it.entityId) {
      const ent = (await ontology.getEntities(scope, [it.entityId], tx))[0];
      if (ent?.status === "candidate") {
        try {
          await ontology.setEntityStatus(tx, scope, it.entityId, "retired", actor, reason);
        } catch (err) {
          if (!(err instanceof ConflictError)) throw err;
          // referenced outside the world step: stays a candidate, but no promotion path may activate it any more
          await ontology.setEquivalenceCheck(tx, scope, it.entityId, { status: "rejected", source: "world_ontology", ...(it.taskId ? { taskId: it.taskId } : {}) });
        }
      }
    }
    await itemsRepo.update(tx.db, scope, it.id, { status: "rejected", heldReason: null, updatedAt: clock.date() });
  }

  async function rejectItem(scope: NovelScope, itemId: string, actor: ActorRef, reason?: string): Promise<WorldReviewResult> {
    return uow.run(async (tx) => {
      await itemsRepo.lock(tx.db, scope);
      const it = await itemsRepo.get(tx.db, scope, itemId, true);
      if (it.status !== "pending") throw new ConflictError("world_item_not_pending", it.status === "approved" ? "승인된 항목은 온톨로지 화면에서 고치거나 철회하세요." : "이미 정리된 항목입니다.");
      // user edits do not block a reject; canon on the ontology side does
      const probe: WorldOntologyItemsRow = { ...it, userEdited: false, origin: "agent" };
      if ((await keptOf(scope, [probe], tx))(probe)) {
        throw new ConflictError("world_item_partly_canon", "이미 일부가 캐논에 반영된 항목입니다. 보류된 내용을 고쳐 승인하거나, 온톨로지 화면에서 철회하세요.");
      }
      const why = reason?.trim() || "세계관 후보 기각";
      let rejected = 0;
      if (it.entityId) {
        // pending relations that touch the entity go with it
        const rows = await itemsRepo.list(tx.db, scope, { statuses: ["pending"] });
        const rels = rows.filter((r) => r.kind === "relation");
        const facts = await ontology.getFactsByIds(scope, rels.flatMap((r) => r.factIds), tx);
        const touching = new Set(facts.filter((f) => f.subjectEntityId === it.entityId || f.objectEntityId === it.entityId).map((f) => f.factId));
        for (const r of rels.filter((x) => x.factIds.some((f) => touching.has(f)))) {
          await rejectRow(tx, scope, r, actor, why);
          rejected++;
        }
      }
      await rejectRow(tx, scope, it, actor, why);
      return { approved: 0, rejected: rejected + 1, held: [] };
    });
  }

  async function editItem(scope: NovelScope, itemId: string, patch: { name?: string; summary?: string | null; statement?: string; predicate?: string }, actor: ActorRef): Promise<WorldItemDto> {
    return uow.run(async (tx) => {
      await itemsRepo.lock(tx.db, scope);
      const it = await itemsRepo.get(tx.db, scope, itemId, true);
      if (it.status !== "pending") throw new ConflictError("world_item_not_pending", "검토 대기 중인 항목만 고칠 수 있습니다. 승인된 항목은 엔티티 화면에서 고치세요.");
      let factIds = it.factIds;
      const { schema } = await ontology.getSchema(scope, tx);
      const tl = await ontology.getDefaultTimeline(scope, tx);
      const userSrc = { refType: "task" as const, refId: it.taskId ?? it.id };
      if (it.entityId) {
        if (patch.predicate !== undefined) throw new DomainValidationError("not_a_relation", "관계 항목만 관계 종류를 바꿀 수 있습니다.");
        if (patch.name !== undefined) {
          const name = cleanName(patch.name);
          const names = await ontology.listEntityNames(scope, it.entityId, tx);
          const same = names.find((n) => n.normalizedKey === normalizedKey(name) && n.status !== "retired");
          const target = same ?? (await ontology.addEntityName(tx, scope, it.entityId, { surface: name, nameKind: "true_name", status: "active", source: { kind: "user_input", refType: "entity", refId: it.entityId } }, actor));
          if (target.status !== "active") await ontology.setEntityNameStatus(tx, scope, target.id, "active", actor);
          if (!target.isPreferred) await ontology.setPreferredName(tx, scope, it.entityId, target.id, actor);
        }
        if (patch.summary !== undefined) await ontology.updateEntity(tx, scope, it.entityId, { summary: patch.summary?.trim() || null }, actor);
        if (patch.statement !== undefined) {
          const facts = await ontology.getFactsByIds(scope, it.factIds, tx);
          const main = facts.find((f) => MAIN_PREDICATES.has(f.predicate) && f.canonStatus === "candidate");
          if (main) await ontology.reviseCandidateFact(tx, scope, main.factId, { value: clip(patch.statement, 1000) }, actor);
          else {
            const ent = (await ontology.getEntities(scope, [it.entityId], tx))[0]!;
            const predicate = ent.entityType === "ability" ? "ability_cost" : ent.entityType === "rule" ? "rule_statement" : null;
            if (!predicate) throw new DomainValidationError("no_statement", "이 항목에는 규칙 문장이 없습니다. 요약을 고치세요.");
            const def = lookupPredicate(schema, predicate)!;
            const r = await ontology.writeCandidateFacts(
              tx,
              scope,
              [{ factKind: def.kind === "attribute" ? def.def.factKind : "rule", subjectEntityId: it.entityId, predicate, value: clip(patch.statement, 1000), timelineId: tl.id, storyRange: { from: 0, to: null }, sourceKind: "user_input", source: userSrc }],
              actor,
            );
            factIds = [...factIds, ...r.written.map((w) => w.factId)];
          }
        }
      } else {
        if (patch.name !== undefined || patch.summary !== undefined || patch.statement !== undefined) throw new DomainValidationError("relation_edit", "관계 항목은 관계 종류만 바꿀 수 있습니다.");
        if (patch.predicate !== undefined) {
          if (!isWorldPredicate(patch.predicate)) throw new DomainValidationError("unknown_predicate", "세계관 관계로 쓸 수 없는 종류입니다.");
          const old = (await ontology.getFactsByIds(scope, it.factIds, tx))[0];
          if (!old) throw new DomainValidationError("fact_missing", "관계 사실을 찾을 수 없습니다.");
          if (old.predicate !== patch.predicate) {
            const def = lookupPredicate(schema, patch.predicate);
            const ends = await ontology.getEntities(scope, [old.subjectEntityId, old.objectEntityId ?? ""].filter(Boolean), tx);
            const t = new Map(ends.map((e) => [e.id, e.entityType as string]));
            const range = def?.kind === "relation" ? def.def.range : null;
            if (!def || def.kind !== "relation" || !def.def.domain.includes(t.get(old.subjectEntityId) ?? "") || !Array.isArray(range) || !range.includes(t.get(old.objectEntityId ?? "") ?? "")) {
              throw new DomainValidationError("predicate_mismatch", "두 항목의 유형에 맞지 않는 관계입니다.");
            }
            await ontology.withdrawFacts(tx, scope, it.factIds, actor, "세계관 관계 수정");
            const r = await ontology.writeCandidateFacts(
              tx,
              scope,
              [{ factKind: def.def.factKind, subjectEntityId: old.subjectEntityId, predicate: patch.predicate, objectEntityId: old.objectEntityId ?? null, timelineId: tl.id, storyRange: { from: 0, to: null }, sourceKind: "user_input", source: userSrc }],
              actor,
            );
            const w = r.written[0];
            if (!w) throw new DomainValidationError("relation_rejected", "관계를 기록하지 못했습니다.");
            factIds = [w.factId];
          }
        }
      }
      const row = await itemsRepo.update(tx.db, scope, it.id, { userEdited: true, factIds, heldReason: null, updatedAt: clock.date() });
      return (await itemDtos(scope, [row], tx))[0]!;
    });
  }

  // ── context for cast / bible / structure ───────────────────────────────────
  async function renderWorldContext(scope: NovelScope): Promise<{ text: string; factVersionIds: string[]; candidateFactVersionIds: string[] }> {
    const rows = await itemsRepo.list(uow.db, scope, { statuses: ["pending", "approved"] });
    if (!rows.length) return { text: "", factVersionIds: [], candidateFactVersionIds: [] };
    const dtos = await itemDtos(scope, rows);
    const facts = await ontology.getFactsByIds(scope, [...new Set(rows.flatMap((r) => r.factIds))]);
    const fv = new Map(facts.map((f) => [f.factId, f]));
    const approvedIds: string[] = [];
    const candIds: string[] = [];
    for (const d of dtos)
      for (const f of d.facts) {
        const v = fv.get(f.factId)?.factVersionId;
        if (!v) continue;
        if (f.canonStatus === "approved" || f.canonStatus === "published_locked") approvedIds.push(v);
        else if (f.canonStatus === "candidate") candIds.push(v);
      }
    const blocks: string[] = [];
    let used = 0;
    // approved first in each kind, then candidates — candidates carry the 미확정 flag
    for (const kind of ENUMS.world_item_kind as readonly WorldItemKind[]) {
      const list = dtos.filter((d) => d.kind === kind).sort((a, b) => Number(b.status === "approved") - Number(a.status === "approved"));
      if (!list.length) continue;
      const lines: string[] = [];
      for (const d of list) {
        const flag = d.status === "approved" ? "" : " [미확정 후보 — 작가 검토 전, 확정 사실처럼 단정하지 않음]";
        const body = d.relation
          ? `${d.relation.subjectName} —${d.relation.predicateLabel}→ ${d.relation.objectName}`
          : [d.name, d.summary ? `: ${clip(d.summary, 200)}` : "", d.statement ? ` / ${kind === "system" && d.entityType === "ability" ? "대가" : "규칙"}: ${clip(d.statement, 200)}` : "", d.details.length ? ` / 한계: ${d.details.map((x) => clip(x, 80)).join("; ")}` : ""].join("");
        const line = `- ${body}${flag}`;
        if (used + line.length > MAX_CONTEXT_CHARS) break;
        used += line.length;
        lines.push(line);
      }
      if (lines.length) blocks.push(`### ${labelKo("world_item_kind", kind)}\n${lines.join("\n")}`);
    }
    if (!blocks.length) return { text: "", factVersionIds: [], candidateFactVersionIds: [] };
    const head = dtos.some((d) => d.status !== "approved") ? "승인된 항목은 지켜야 할 설정입니다. [미확정 후보]는 참고만 하고, 바꾸거나 무시해도 됩니다." : "아래는 작가가 승인한 세계관 설정입니다. 지켜야 합니다.";
    return { text: `${head}\n${blocks.join("\n")}`, factVersionIds: approvedIds, candidateFactVersionIds: candIds };
  }

  return {
    service: { getView, requestGeneration, approveItem, approveAll, rejectItem, editItem, renderWorldContext },
    handler,
    onNovelStatusChanged,
    /** test seam: commit a proposal without the model */
    commitProposal,
  };
}

function valueText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return JSON.stringify(v);
}

export type WorldApp = ReturnType<typeof createWorldService>;
