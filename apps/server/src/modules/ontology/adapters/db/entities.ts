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

export async function createEntity(d: OntoDeps, tx: Tx, scope: NovelScope, input: CreateEntityInput, actor: ActorRef): Promise<{ entity: Entity; preferredName: EntityName }> {
  const { schema } = await activeSchema(tx.db, scope);
  const type = schema.entityTypes.find((t) => t.key === input.entityType);
  if (!type) throw new DomainValidationError("unknown_entity_type", `스키마에 없는 엔티티 유형입니다: ${input.entityType}`);
  const surface = input.preferredName.surface.trim();
  if (!surface) throw new DomainValidationError("name_required", "엔티티에는 이름이 1개 이상 있어야 합니다.");
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
  const { main, variants } = splitParenthetical(surface);
  const preferred = await insertName(d, tx, scope, id, {
    surface: main,
    nameKind: input.preferredName.nameKind ?? "true_name",
    status: "active",
    surfaceVisibility: input.preferredName.visibility ?? "public",
    source: src,
  }, true);
  // N4: parenthetical (한자 병기) → hidden_variant proposal
  for (const v of variants) {
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
