/** Entity / EntityName / Mention writes (06 §3.1 EN, §3.2 NM, §3.8 MN). */
import { and, eq, inArray, ne, or, sql } from "@ncs/db/orm";
import { entities, entityNames, facts, mentions } from "@ncs/db/schema";
import type { EntityStatus } from "@ncs/shared";
import { ConflictError, DomainValidationError, NotFoundError, type ActorRef, type NovelScope, type Tx } from "../../../../platform/index.js";
import type { AddEntityNameInput, CreateEntityInput, Entity, EntityName, Mention, MentionDecision, MentionDraft } from "../../index.js";
import { nameKeys, normalizedKey, splitParenthetical } from "../../domain/normalize.js";
import { assertEntityTransition, assertMentionTransition, assertNameTransition, type NameStatus } from "../../domain/transitions.js";
import { computeSlotKey, parseRange, rangeLiteral, rangesOverlap } from "../../domain/facts.js";
import { activeSchema, appendFactVersion, currentContents, getEntityRow, resolveId, resolveIds, type OntoDeps } from "./common.js";

const actorCols = (a: ActorRef) => ({ createdByActorType: a.type, createdByActorId: a.id });

// ── 설계 추가 0026: entity handles (E1, E2 …) never become ontology data ─────────────────────────────────────────
// The ontology is the common gate of every write path (linker, resolver, HITL, bible, world, cast). Same token shape
// as agents/domain/handle-text.ts — kept local because agents imports ontology (no import cycle).
const HANDLE_SHAPED = /^[[(（]?E\d{1,3}[\])）]?$/;
const HANDLE_TOKEN = /(?<![A-Za-z0-9_])E\d{1,3}(?![A-Za-z0-9_])/g;

/** P5: the whole surface is a handle ("E6", "[E11]") — never a name, an alias or a mention surface */
export function isHandleShapedSurface(surface: string | null | undefined): boolean {
  return typeof surface === "string" && HANDLE_SHAPED.test(surface.trim());
}

function assertNotHandleShaped(surface: string): void {
  if (isHandleShapedSurface(surface)) {
    throw new DomainValidationError("handle_shaped_name", `'${surface.trim()}' 같은 'E숫자' 기호는 이름이 될 수 없습니다. 인물·장소의 실제 이름을 쓰세요.`, { surface: surface.trim() });
  }
}

/** handle-looking tokens in every string leaf of a JSON-like value, deduplicated */
export function handleTokensIn(value: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") for (const m of v.matchAll(HANDLE_TOKEN)) out.add(m[0]);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return [...out];
}

/** a name may carry a handle-looking token only as story text: not handle-shaped, and no token outside `story` */
const carriesHandle = (surface: string, story: ReadonlySet<string>) => isHandleShapedSurface(surface) || handleTokensIn(surface).some((t) => !story.has(t));

/**
 * P1: the story tokens of a novel — handle-looking tokens inside a live, non-handle-shaped name of a live entity that a
 * PERSON created ("E3 구역" → E3). Names agents made (linker / resolver / bible ontology) never count: they are derived
 * from stored sentences, so a leaked handle in one ("E12 일행") would exempt its token everywhere, forever.
 */
export async function storyHandleTokensOf(db: Tx["db"], scope: NovelScope): Promise<Set<string>> {
  const names = await db
    .select({ surface: entityNames.surface })
    .from(entityNames)
    .innerJoin(entities, and(eq(entities.novelId, entityNames.novelId), eq(entities.id, entityNames.entityId)))
    .where(
      and(
        eq(entityNames.novelId, scope.novelId),
        ne(entityNames.status, "retired"),
        inArray(entities.status, ["candidate", "active"]),
        eq(entities.createdByActorType, "user"),
        sql`${entityNames.surface} ~ 'E[0-9]'`,
      ),
    );
  return new Set(names.filter((n) => !isHandleShapedSurface(n.surface)).flatMap((n) => handleTokensIn(n.surface)));
}

/**
 * P6 (agent-authored text only): the handle tokens of `value` that are not story tokens. [] = clean. The names are
 * read only when a token is there.
 */
export async function leakedHandleTokensOf(db: Tx["db"], scope: NovelScope, value: unknown): Promise<string[]> {
  const tokens = handleTokensIn(value);
  if (tokens.length === 0) return [];
  const story = await storyHandleTokensOf(db, scope);
  return tokens.filter((t) => !story.has(t));
}

async function assertAgentTextClean(db: Tx["db"], scope: NovelScope, actor: ActorRef, what: string, value: unknown): Promise<void> {
  if (actor.type !== "agent") return; // a person may type anything
  const leaks = await leakedHandleTokensOf(db, scope, value);
  if (leaks.length) throw new DomainValidationError("handle_token_in_text", `entity handle left in stored text (${what}): ${leaks.slice(0, 5).join(", ")}`, { what, tokens: leaks });
}

/** P5 / P1: a name an AGENT stores never carries a handle token ("E12 일행") — it would become a story token otherwise */
async function assertAgentNamesClean(db: Tx["db"], scope: NovelScope, actor: ActorRef, surfaces: readonly string[]): Promise<void> {
  if (actor.type !== "agent" || !handleTokensIn(surfaces).length) return;
  const story = await storyHandleTokensOf(db, scope);
  const bad = surfaces.find((s) => carriesHandle(s, story));
  if (bad) throw new DomainValidationError("handle_token_in_name", `'${bad.trim()}'에는 'E숫자' 기호가 들어 있어 이름으로 저장할 수 없습니다. 인물·장소의 실제 이름을 쓰세요.`, { surface: bad.trim() });
}

export async function createEntity(d: OntoDeps, tx: Tx, scope: NovelScope, input: CreateEntityInput, actor: ActorRef): Promise<{ entity: Entity; preferredName: EntityName }> {
  const { schema } = await activeSchema(tx.db, scope);
  const type = schema.entityTypes.find((t) => t.key === input.entityType);
  if (!type) throw new DomainValidationError("unknown_entity_type", `스키마에 없는 엔티티 유형입니다: ${input.entityType}`);
  const surface = input.preferredName.surface.trim();
  if (!surface) throw new DomainValidationError("name_required", "엔티티에는 이름이 1개 이상 있어야 합니다.");
  // 설계 추가 0026 (P5 / P6): checked before anything is written
  const { main, variants } = splitParenthetical(surface);
  assertNotHandleShaped(surface);
  assertNotHandleShaped(main);
  for (const n of input.names ?? []) assertNotHandleShaped(n.surface);
  await assertAgentNamesClean(tx.db, scope, actor, [main, ...(input.names ?? []).map((n) => n.surface)]);
  await assertAgentTextClean(tx.db, scope, actor, "entity summary", input.summary ?? null);
  const status: "candidate" | "active" = input.status ?? (actor.type === "user" ? "active" : "candidate");
  const id = d.platform.ids.next("ent");
  const now = d.platform.clock.date();
  await tx.db.insert(entities).values({
    id,
    novelId: scope.novelId,
    entityType: input.entityType,
    status: "candidate",
    disambiguator: input.disambiguator ?? null,
    summary: input.summary ?? null,
    createdFromMentionId: input.createdFromMentionId ?? null,
    conceptCharacterKey: input.conceptCharacterKey ?? null,
    ...actorCols(actor),
    createdAt: now,
    updatedAt: now,
  });
  const src = input.source ?? { kind: actor.type === "user" ? ("user_input" as const) : ("system_derived" as const), refType: "entity" as const, refId: id };
  const preferred = await insertName(d, tx, scope, id, {
    surface: main,
    nameKind: input.preferredName.nameKind ?? "true_name",
    status: "active",
    surfaceVisibility: input.preferredName.visibility ?? "public",
    source: src,
  }, true);
  // N4: parenthetical (한자 병기) → hidden_variant proposal
  for (const v of variants) {
    if (isHandleShapedSurface(v)) continue; // "서이온(E6)": a leaked reference mark, not a variant spelling
    await insertName(d, tx, scope, id, { surface: v, nameKind: "hidden_variant", status: "proposed", source: src }, false).catch((e) => {
      if (!(e instanceof ConflictError)) throw e;
    });
  }
  for (const n of input.names ?? []) {
    await insertName(d, tx, scope, id, { ...n, source: n.source ?? src }, false);
  }
  const [entity] = await tx.db
    .update(entities)
    .set({ preferredNameId: preferred.id, status, updatedAt: now })
    .where(and(eq(entities.novelId, scope.novelId), eq(entities.id, id)))
    .returning();
  await d.audit.record(tx, {
    novelId: scope.novelId,
    actor,
    action: "entity.created",
    target: { type: "entity", id },
    after: { entityType: input.entityType, status, preferredName: preferred.surface },
    details: { createdFromMentionId: input.createdFromMentionId ?? null, conceptCharacterKey: input.conceptCharacterKey ?? null },
  });
  return { entity: entity!, preferredName: preferred };
}

async function insertName(d: OntoDeps, tx: Tx, scope: NovelScope, entityId: string, n: AddEntityNameInput, isPreferred: boolean): Promise<EntityName> {
  const surface = n.surface.trim();
  if (!surface) throw new DomainValidationError("name_required", "이름 표기가 비어 있습니다.");
  assertNotHandleShaped(surface); // 설계 추가 0026 (P5)
  if (n.nameKind === "address_term" && n.usedByCondition == null) {
    throw new DomainValidationError("address_condition_required", "호칭(address_term)에는 사용 조건(used_by_condition)이 필요합니다.");
  }
  const keys = nameKeys(surface);
  const range = n.storyRange ? { from: n.storyRange.from, to: n.storyRange.to } : { from: 0, to: null };
  // INV-ONT-03 (app-level, EXCLUDE may be missing): same entity + key + kind + timeline overlapping; variant vs hidden_variant exclusive
  const existing = await tx.db
    .select()
    .from(entityNames)
    .where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.entityId, entityId), eq(entityNames.normalizedKey, keys.normalizedKey), ne(entityNames.status, "retired")));
  for (const e of existing) {
    const sameTl = (e.timelineId ?? "*") === (n.timelineId ?? "*");
    const kindClash = e.nameKind === n.nameKind || (["variant", "hidden_variant"].includes(e.nameKind) && ["variant", "hidden_variant"].includes(n.nameKind));
    if (sameTl && kindClash && rangesOverlap(parseRange(e.storyRange), range)) {
      throw new ConflictError("duplicate_name", `이미 같은 이름이 등록되어 있습니다: ${surface}`, { nameId: e.id });
    }
  }
  const id = d.platform.ids.next("enm");
  const now = d.platform.clock.date();
  const [row] = await tx.db
    .insert(entityNames)
    .values({
      id,
      novelId: scope.novelId,
      entityId,
      surface,
      ...keys,
      nameKind: n.nameKind,
      isPreferred,
      status: n.status ?? "active",
      storyRange: rangeLiteral(range),
      timelineId: n.timelineId ?? null,
      surfaceVisibility: n.surfaceVisibility ?? "public",
      surfaceKnownByEntityIds: n.surfaceKnownByEntityIds ?? [],
      identityVisibility: n.identityVisibility ?? (n.nameKind === "disguise" ? "restricted" : "public"),
      identityKnownByEntityIds: n.identityKnownByEntityIds ?? [],
      usedByCondition: n.usedByCondition ?? null,
      readerRevealPoint: n.readerRevealPoint ?? null,
      sourceKind: n.source?.kind ?? "user_input",
      sourceRefType: n.source?.refType ?? "entity",
      sourceRefId: n.source?.refId ?? entityId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row!;
}

export async function addEntityName(d: OntoDeps, tx: Tx, scope: NovelScope, entityId: string, n: AddEntityNameInput, actor: ActorRef): Promise<EntityName> {
  const id = await resolveId(tx.db, scope, entityId);
  const e = await getEntityRow(tx.db, scope, id);
  if (e.status === "retired") throw new DomainValidationError("entity_retired", "폐기된 엔티티에는 이름을 추가할 수 없습니다.");
  await assertAgentNamesClean(tx.db, scope, actor, [n.surface]); // 설계 추가 0026 (P5 / P1)
  const status = n.status ?? (actor.type === "user" ? "active" : "proposed");
  const row = await insertName(d, tx, scope, id, { ...n, status }, false);
  await d.audit.record(tx, {
    novelId: scope.novelId,
    actor,
    action: "entity_name.added",
    target: { type: "entity_name", id: row.id },
    after: { entityId: id, surface: row.surface, nameKind: row.nameKind, status: row.status },
  });
  return row;
}

export async function setNameStatus(d: OntoDeps, tx: Tx, scope: NovelScope, nameId: string, to: NameStatus, actor: ActorRef): Promise<EntityName> {
  const [n] = await tx.db.select().from(entityNames).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.id, nameId))).for("update");
  if (!n) throw new NotFoundError("이름", nameId);
  const rule = assertNameTransition(n.status, to);
  if (to === "retired" && n.isPreferred) throw new DomainValidationError("preferred_name", "대표명은 다른 대표명을 지정한 뒤에 폐기할 수 있습니다.");
  const [row] = await tx.db
    .update(entityNames)
    .set({ status: to, updatedAt: d.platform.clock.date() })
    .where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.id, nameId)))
    .returning();
  await d.audit.record(tx, { novelId: scope.novelId, actor, action: rule.audit, target: { type: "entity_name", id: nameId }, before: { status: n.status }, after: { status: to }, details: { rule: rule.id } });
  return row!;
}

export async function referenceCount(db: Tx["db"], scope: NovelScope, entityId: string): Promise<number> {
  const [m] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mentions)
    .where(
      and(
        eq(mentions.novelId, scope.novelId),
        or(eq(mentions.linkedEntityId, entityId), eq(mentions.speakerEntityId, entityId), eq(mentions.povEntityId, entityId), eq(mentions.viaEntityId, entityId)),
        ne(mentions.linkStatus, "rejected"),
      ),
    );
  const [f] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(facts)
    .where(and(eq(facts.novelId, scope.novelId), or(eq(facts.subjectEntityId, entityId), eq(facts.objectEntityId, entityId)), inArray(facts.canonStatus, ["candidate", "approved", "published_locked"])));
  return (m?.n ?? 0) + (f?.n ?? 0);
}

export async function setEntityStatus(d: OntoDeps, tx: Tx, scope: NovelScope, entityId: string, to: EntityStatus, actor: ActorRef, reason?: string): Promise<Entity> {
  const e = await getEntityRow(tx.db, scope, entityId, true);
  if (to === "merged") throw new DomainValidationError("use_identity_decision", "병합은 IdentityDecision(merge)으로만 할 수 있습니다.");
  const rule = assertEntityTransition(e.status, to);
  if (to === "retired" && (await referenceCount(tx.db, scope, entityId)) > 0) {
    throw new ConflictError("entity_referenced", "참조가 남아 있는 엔티티는 폐기할 수 없습니다(INV-ONT-01).");
  }
  if (to === "active" && !e.preferredNameId) throw new DomainValidationError("preferred_name_required", "대표명이 없는 엔티티는 활성화할 수 없습니다.");
  const [row] = await tx.db
    .update(entities)
    .set({ status: to, updatedAt: d.platform.clock.date() })
    .where(and(eq(entities.novelId, scope.novelId), eq(entities.id, entityId)))
    .returning();
  if (to === "active") {
    // the preferred name and proposed true names become usable with the entity (NM3 for the preferred row)
    await tx.db
      .update(entityNames)
      .set({ status: "active" })
      .where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.entityId, entityId), eq(entityNames.status, "proposed"), eq(entityNames.isPreferred, true)));
  }
  await d.audit.record(tx, { novelId: scope.novelId, actor, action: rule.audit, target: { type: "entity", id: entityId }, before: { status: e.status }, after: { status: to }, reason: reason ?? null, details: { rule: rule.id } });
  return row!;
}

/** 설계 추가(world): edit the description fields of an entity (summary / disambiguator); names go through the name APIs */
export async function updateEntity(d: OntoDeps, tx: Tx, scope: NovelScope, entityId: string, patch: { summary?: string | null; disambiguator?: string | null }, actor: ActorRef): Promise<Entity> {
  const e = await getEntityRow(tx.db, scope, entityId, true);
  const set: Partial<Entity> = {};
  if (patch.summary !== undefined && patch.summary !== e.summary) set.summary = patch.summary;
  if (patch.disambiguator !== undefined && patch.disambiguator !== e.disambiguator) set.disambiguator = patch.disambiguator;
  if (!Object.keys(set).length) return e;
  if (set.summary) await assertAgentTextClean(tx.db, scope, actor, "entity summary", set.summary); // 설계 추가 0026 (P6)
  const [row] = await tx.db
    .update(entities)
    .set({ ...set, updatedAt: d.platform.clock.date() })
    .where(and(eq(entities.novelId, scope.novelId), eq(entities.id, entityId)))
    .returning();
  await d.audit.record(tx, {
    novelId: scope.novelId,
    actor,
    action: "entity.updated",
    target: { type: "entity", id: entityId },
    before: Object.fromEntries(Object.keys(set).map((k) => [k, e[k as keyof Entity]])),
    after: set,
  });
  return row!;
}

export async function setEquivalenceCheck(d: OntoDeps, tx: Tx, scope: NovelScope, entityId: string, check: unknown): Promise<void> {
  await tx.db
    .update(entities)
    .set({ equivalenceCheck: check, updatedAt: d.platform.clock.date() })
    .where(and(eq(entities.novelId, scope.novelId), eq(entities.id, entityId)));
}

// ── mentions ────────────────────────────────────────────────────────────
export async function writeMentions(d: OntoDeps, tx: Tx, scope: NovelScope, drafts: MentionDraft[], actor: ActorRef): Promise<{ mentionIds: string[] }> {
  if (drafts.length === 0) return { mentionIds: [] };
  // 설계 추가 0026 (P5): the linker drops such surfaces before they get here; one that still arrives is a bug upstream
  for (const m of drafts) if (m.mentionKind !== "zero") assertNotHandleShaped(m.surface);
  const ids = drafts.flatMap((m) => [m.linkedEntityId, m.speakerEntityId, m.povEntityId, m.viaEntityId].filter((x): x is string => !!x));
  const resolved = await resolveIds(tx.db, scope, ids);
  const r = (id: string | null | undefined) => (id ? (resolved.get(id) ?? null) : null);
  const now = d.platform.clock.date();
  const rows = drafts.map((m) => {
    const linked = r(m.linkedEntityId);
    if (["auto_linked", "confirmed", "new_entity_candidate"].includes(m.linkStatus) && !linked) {
      throw new DomainValidationError("mention_link_required", "연결 상태의 언급에는 대상 엔티티가 필요합니다.");
    }
    return {
      id: d.platform.ids.next("mnt"),
      novelId: scope.novelId,
      sourceKind: m.sourceKind,
      manuscriptVersionId: m.manuscriptVersionId ?? null,
      sceneId: m.sceneId ?? null,
      charStart: m.charStart ?? null,
      charEnd: m.charEnd ?? null,
      answerId: m.answerId ?? null,
      storyPoint: m.storyPoint,
      timelineId: m.timelineId,
      narrativeFrameId: m.narrativeFrameId ?? null,
      redirectedFromEntityId: m.linkedEntityId && linked && linked !== m.linkedEntityId ? m.linkedEntityId : null,
      surface: m.mentionKind === "zero" ? "" : m.surface,
      mentionKind: m.mentionKind,
      speakerEntityId: r(m.speakerEntityId),
      povEntityId: r(m.povEntityId),
      chainKey: m.chainKey ?? null,
      candidates: m.candidates.map((c) => ({ ...c, entityId: resolved.get(c.entityId) ?? c.entityId })),
      linkedEntityId: linked,
      viaNameId: m.viaNameId ?? null,
      viaEntityId: r(m.viaEntityId),
      confidence: Math.max(0, Math.min(1, m.confidence)),
      rationale: m.rationale ?? null,
      linkStatus: m.linkStatus,
      linkerVersion: m.linkerVersion,
      questionId: m.questionId ?? null,
      runId: m.runId ?? (actor.type === "agent" ? actor.runId : null),
      createdAt: now,
      updatedAt: now,
    };
  });
  await tx.db.insert(mentions).values(rows);
  const counts: Record<string, number> = {};
  for (const m of rows) counts[m.linkStatus] = (counts[m.linkStatus] ?? 0) + 1;
  await d.audit.record(tx, {
    novelId: scope.novelId,
    actor,
    action: "mention.batch_linked",
    target: drafts[0]!.manuscriptVersionId ? { type: "manuscript_version", id: drafts[0]!.manuscriptVersionId } : { type: "mention", id: rows[0]!.id },
    details: { ids: rows.map((m) => m.id), count: rows.length, byStatus: counts, linkerVersion: drafts[0]!.linkerVersion },
  });
  return { mentionIds: rows.map((m) => m.id) };
}

export async function getMentionRow(db: Tx["db"], scope: NovelScope, id: string, forUpdate = false): Promise<Mention> {
  const q = db.select().from(mentions).where(and(eq(mentions.novelId, scope.novelId), eq(mentions.id, id)));
  const [m] = forUpdate ? await q.for("update") : await q;
  if (!m) throw new NotFoundError("언급", id);
  return m;
}

export async function setMentionQuestion(d: OntoDeps, tx: Tx, scope: NovelScope, mentionIds: string[], questionId: string): Promise<void> {
  if (mentionIds.length === 0) return;
  await tx.db
    .update(mentions)
    .set({ questionId, updatedAt: d.platform.clock.date() })
    .where(and(eq(mentions.novelId, scope.novelId), inArray(mentions.id, mentionIds)));
}

/** facts whose current version cites the mention (mention_ids or arg_mentions) */
async function factsCitingMention(db: Tx["db"], scope: NovelScope, mentionId: string) {
  return db
    .select()
    .from(facts)
    .where(and(eq(facts.novelId, scope.novelId), sql`${facts.mentionIds} @> ARRAY[${mentionId}]::text[]`));
}

export async function decideMention(
  d: OntoDeps,
  tx: Tx,
  scope: NovelScope,
  mentionId: string,
  decision: MentionDecision,
  actor: ActorRef,
  ctx: { questionId?: string; answerId?: string } = {},
): Promise<{ mention: Mention; filledFactIds: string[]; rejectedFactIds: string[] }> {
  const m = await getMentionRow(tx.db, scope, mentionId, true);
  const to = decision.kind === "entity" ? "confirmed" : "rejected";
  const rule = assertMentionTransition(m.linkStatus, to);
  let entityId: string | null = null;
  if (decision.kind === "entity") {
    if (!decision.entityId) throw new DomainValidationError("entity_required", "연결할 엔티티를 지정해야 합니다.");
    entityId = await resolveId(tx.db, scope, decision.entityId);
    const e = await getEntityRow(tx.db, scope, entityId);
    if (e.status === "retired") throw new DomainValidationError("entity_retired", "폐기된 엔티티에는 연결할 수 없습니다.");
  }
  const now = d.platform.clock.date();
  const [mention] = await tx.db
    .update(mentions)
    .set({
      linkStatus: to,
      linkedEntityId: entityId ?? (to === "rejected" ? null : m.linkedEntityId),
      confidence: 1,
      questionId: ctx.questionId ?? m.questionId,
      rationale: decision.kind === "entity" ? "사용자 판별" : "엔티티 아님(사용자)",
      updatedAt: now,
    })
    .where(and(eq(mentions.novelId, scope.novelId), eq(mentions.id, mentionId)))
    .returning();
  // LB-3
  const filled: string[] = [];
  const rejected: string[] = [];
  const cited = await factsCitingMention(tx.db, scope, mentionId);
  const contents = await currentContents(tx.db, scope, cited.map((f) => f.id));
  const { schema } = await activeSchema(tx.db, scope);
  for (const f of cited) {
    const c = contents.get(f.id)?.content;
    const arg = c?.argMentions ?? {};
    if (decision.kind === "entity") {
      const patch: { subjectEntityId?: string; objectEntityId?: string } = {};
      if (arg.subject === mentionId && f.subjectEntityId === null) patch.subjectEntityId = entityId!;
      if (arg.object === mentionId && f.objectEntityId === null && f.value == null && !f.objectFactId && !f.objectNameId) patch.objectEntityId = entityId!;
      if (Object.keys(patch).length === 0) continue;
      const next = { ...f, ...patch };
      const slotKey = computeSlotKey(schema, { ...next, value: next.value ?? undefined, argMentions: arg });
      await appendFactVersion(d, tx, scope, f, { ...patch, slotKey }, { changeReason: "resolution_filled", actor });
      filled.push(f.id);
    } else if (f.canonStatus === "candidate") {
      await appendFactVersion(d, tx, scope, f, { canonStatus: "rejected" }, { changeReason: "user_edit", actor });
      rejected.push(f.id);
    }
  }
  await d.audit.record(tx, {
    novelId: scope.novelId,
    actor,
    action: rule.audit,
    target: { type: "mention", id: mentionId },
    before: { linkStatus: m.linkStatus, linkedEntityId: m.linkedEntityId },
    after: { linkStatus: to, linkedEntityId: mention!.linkedEntityId },
    questionId: ctx.questionId ?? null,
    answerId: ctx.answerId ?? null,
    details: { rule: rule.id, filledFactIds: filled, rejectedFactIds: rejected },
  });
  if (rejected.length > 0) {
    await d.audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "fact.status_changed",
      target: { type: "fact", id: rejected[0]! },
      after: { canonStatus: "rejected" },
      questionId: ctx.questionId ?? null,
      details: { ids: rejected, count: rejected.length, rule: "F4" },
    });
  }
  return { mention: mention!, filledFactIds: filled, rejectedFactIds: rejected };
}

/** used by name-key lookups (the linker normalizes input once) */
export const keyOf = normalizedKey;

/** make an active name of the entity its preferred (대표) name — e.g. a cast character renamed and confirmed again */
export async function setPreferredName(d: OntoDeps, tx: Tx, scope: NovelScope, entityId: string, nameId: string, actor: ActorRef): Promise<EntityName> {
  const id = await resolveId(tx.db, scope, entityId);
  const e = await getEntityRow(tx.db, scope, id, true);
  const [n] = await tx.db.select().from(entityNames).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.id, nameId))).for("update");
  if (!n || n.entityId !== id) throw new NotFoundError("이름", nameId);
  if (n.status !== "active") throw new DomainValidationError("name_not_active", "활성 이름만 대표명으로 지정할 수 있습니다.");
  if (e.preferredNameId === nameId) return n;
  const now = d.platform.clock.date();
  await tx.db.update(entityNames).set({ isPreferred: false, updatedAt: now }).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.entityId, id), eq(entityNames.isPreferred, true)));
  const [row] = await tx.db.update(entityNames).set({ isPreferred: true, updatedAt: now }).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.id, nameId))).returning();
  await tx.db.update(entities).set({ preferredNameId: nameId, updatedAt: now }).where(and(eq(entities.novelId, scope.novelId), eq(entities.id, id)));
  await d.audit.record(tx, {
    novelId: scope.novelId,
    actor,
    action: "entity_name.updated",
    target: { type: "entity_name", id: nameId },
    before: { preferredNameId: e.preferredNameId },
    after: { preferredNameId: nameId, surface: n.surface },
    details: { entityId: id },
  });
  return row!;
}
