/**
 * Shared low-level helpers of PgOntologyRepository (06 §11.4). Every query filters by novel_id (03 T-3).
 * Functions take a drizzle handle `db` (tx.db inside a transaction, uow.db for plain reads).
 */
import { and, desc, eq, inArray, isNull, sql } from "@ncs/db/orm";
import { entities, entityNames, factCardinalitySlots, facts, factVersions, ontologySchemaVersions } from "@ncs/db/schema";
import type { CanonStatus, FactChangeReason } from "@ncs/shared";
import { NotFoundError, type ActorRef, type Db, type NovelScope, type Platform, type Tx } from "../../../../platform/index.js";
import type { AuditService } from "../../../audit/index.js";
import type { Entity, Fact, FactAtAnchor, OntologySchemaVersion } from "../../index.js";
import { compileSchema, type OntologySchemaData } from "../../domain/base-schema.js";
import { cardinalitySlotKeys, parseRange, rangeLiteral, rangesOverlap, renderFactText, type FactShape, type Range } from "../../domain/facts.js";

export interface OntoDeps {
  platform: Platform;
  audit: AuditService;
}

// ── schema ───────────────────────────────────────────────────────────────
export async function activeSchema(db: Db, scope: NovelScope): Promise<{ version: OntologySchemaVersion; schema: OntologySchemaData }> {
  const [v] = await db
    .select()
    .from(ontologySchemaVersions)
    .where(eq(ontologySchemaVersions.novelId, scope.novelId))
    .orderBy(desc(ontologySchemaVersions.versionNo))
    .limit(1);
  if (!v) throw new NotFoundError("온톨로지 스키마");
  return { version: v, schema: compileSchema(v.baseSchemaKey, v.extension) };
}

// ── entity id resolution (Q9) ────────────────────────────────────────────
export async function resolveIds(db: Db, scope: NovelScope, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const cur = new Map<string, string>([...new Set(ids.filter(Boolean))].map((id) => [id, id]));
  for (let hop = 0; hop < 16 && cur.size > 0; hop++) {
    const pending = [...new Set(cur.values())];
    const rows = await db
      .select({ id: entities.id, status: entities.status, mergedIntoId: entities.mergedIntoId })
      .from(entities)
      .where(and(eq(entities.novelId, scope.novelId), inArray(entities.id, pending)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [key, at] of [...cur.entries()]) {
      const r = byId.get(at);
      if (!r) cur.delete(key);
      else if (r.status === "merged" && r.mergedIntoId) cur.set(key, r.mergedIntoId);
      else {
        out.set(key, r.id);
        cur.delete(key);
      }
    }
  }
  return out;
}

export async function resolveId(db: Db, scope: NovelScope, id: string): Promise<string> {
  const m = await resolveIds(db, scope, [id]);
  const r = m.get(id);
  if (!r) throw new NotFoundError("엔티티", id);
  return r;
}

export async function getEntityRow(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<Entity> {
  const q = db.select().from(entities).where(and(eq(entities.novelId, scope.novelId), eq(entities.id, id)));
  const [e] = forUpdate ? await q.for("update") : await q;
  if (!e) throw new NotFoundError("엔티티", id);
  return e;
}

export async function preferredNames(db: Db, scope: NovelScope, entityIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(entityIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ entityId: entities.id, surface: entityNames.surface, disambiguator: entities.disambiguator })
    .from(entities)
    .leftJoin(entityNames, and(eq(entityNames.novelId, entities.novelId), eq(entityNames.id, entities.preferredNameId)))
    .where(and(eq(entities.novelId, scope.novelId), inArray(entities.id, ids)));
  return new Map(rows.map((r) => [r.entityId, `${r.surface ?? r.entityId}${r.disambiguator ? `(${r.disambiguator})` : ""}`]));
}

// ── facts ────────────────────────────────────────────────────────────────
export interface FactContent {
  factKind: string;
  subjectEntityId: string | null;
  predicate: string;
  objectEntityId: string | null;
  objectFactId: string | null;
  objectNameId: string | null;
  value: unknown;
  knowledgeStance: string | null;
  isNegation: boolean;
  isSecret: boolean;
  readerRevealPoint: number | null;
  timelineId: string;
  storyRange: Range;
  slotKey: string;
  argMentions: { subject?: string | null; object?: string | null };
  episodeId?: string | null;
  seriesBibleId?: string | null;
  writtenForEntityIds?: Record<string, string>;
  /** transition: the earlier fact whose open upper bound closes when this one is promoted (06 §6.2) */
  rangeCloseOf?: string | null;
  /** conflict classification (06 §6.6): excluded from promotion */
  conflictWith?: string | null;
  diffKind?: string;
  /** 설계 추가(수정 반영): the earlier fact of the same episode this one replaces after a text edit (never an overwrite) */
  supersedes?: string | null;
  /** set on the replaced fact: its successor */
  supersededByFactId?: string | null;
  /** a text-edit change of approved canon waits for the author's canon_change / retcon approval: excluded from promotion */
  reconcilePending?: boolean;
  /** set on an approved fact whose text-edit change the author rejected (keep the old setting): not asked again unless a
   * different replacement appears */
  reconcileKeptBy?: { approvalId: string; rejectedNewText: string | null } | null;
  [k: string]: unknown;
}

export function snapshot(f: Fact, prev: Partial<FactContent> = {}): FactContent {
  return {
    ...prev,
    factKind: f.factKind,
    subjectEntityId: f.subjectEntityId,
    predicate: f.predicate,
    objectEntityId: f.objectEntityId,
    objectFactId: f.objectFactId,
    objectNameId: f.objectNameId,
    value: f.value ?? null,
    knowledgeStance: f.knowledgeStance,
    isNegation: f.isNegation,
    isSecret: f.isSecret,
    readerRevealPoint: f.readerRevealPoint,
    timelineId: f.timelineId,
    storyRange: parseRange(f.storyRange),
    slotKey: f.slotKey,
    argMentions: prev.argMentions ?? {},
  };
}

export function factShape(f: Fact, content?: Partial<FactContent>): FactShape {
  return {
    factKind: f.factKind,
    subjectEntityId: f.subjectEntityId,
    predicate: f.predicate,
    objectEntityId: f.objectEntityId,
    objectFactId: f.objectFactId,
    objectNameId: f.objectNameId,
    value: f.value ?? undefined,
    isNegation: f.isNegation,
    argMentions: content?.argMentions,
  };
}

export async function currentContents(db: Db, scope: NovelScope, factIds: string[]): Promise<Map<string, { versionId: string; content: FactContent }>> {
  if (factIds.length === 0) return new Map();
  const rows = await db
    .select({ factId: factVersions.factId, id: factVersions.id, content: factVersions.content })
    .from(factVersions)
    .where(and(eq(factVersions.novelId, scope.novelId), inArray(factVersions.factId, factIds), isNull(factVersions.supersededAt)));
  return new Map(rows.map((r) => [r.factId, { versionId: r.id, content: r.content as FactContent }]));
}

export async function getFactRow(db: Db, scope: NovelScope, factId: string, forUpdate = false): Promise<Fact> {
  const q = db.select().from(facts).where(and(eq(facts.novelId, scope.novelId), eq(facts.id, factId)));
  const [f] = forUpdate ? await q.for("update") : await q;
  if (!f) throw new NotFoundError("사실", factId);
  return f;
}

export interface NewVersionOpts {
  changeReason: FactChangeReason;
  actor: ActorRef;
  approvalId?: string | null;
  identityDecisionId?: string | null;
  contentPatch?: Partial<FactContent>;
}

/**
 * Append a FactVersion (INV-ONT-11: version rows are never updated except `superseded_at`) and move the
 * `facts` current pointer. `patch` = new semantic field values.
 */
export async function appendFactVersion(
  d: OntoDeps,
  tx: Tx,
  scope: NovelScope,
  fact: Fact,
  patch: Partial<Pick<Fact, "subjectEntityId" | "objectEntityId" | "objectNameId" | "objectFactId" | "value" | "storyRange" | "slotKey" | "canonStatus" | "mentionIds" | "toSceneId">>,
  o: NewVersionOpts,
): Promise<{ fact: Fact; versionId: string }> {
  const now = d.platform.clock.date();
  const cur = (await currentContents(tx.db, scope, [fact.id])).get(fact.id);
  await tx.db
    .update(factVersions)
    .set({ supersededAt: now })
    .where(and(eq(factVersions.novelId, scope.novelId), eq(factVersions.factId, fact.id), isNull(factVersions.supersededAt)));
  const versionNo = fact.currentVersionNo + 1;
  const [updated] = await tx.db
    .update(facts)
    .set({ ...patch, currentVersionNo: versionNo, updatedAt: now })
    .where(and(eq(facts.novelId, scope.novelId), eq(facts.id, fact.id)))
    .returning();
  const versionId = d.platform.ids.next("fcv");
  await tx.db.insert(factVersions).values({
    id: versionId,
    novelId: scope.novelId,
    factId: fact.id,
    versionNo,
    content: snapshot(updated!, { ...(cur?.content ?? {}), ...(o.contentPatch ?? {}) }),
    canonStatus: updated!.canonStatus,
    recordedAt: now,
    recordedByActorType: o.actor.type,
    recordedByActorId: o.actor.id,
    runId: o.actor.type === "agent" ? o.actor.runId : null,
    changeReason: o.changeReason,
    approvalId: o.approvalId ?? null,
    identityDecisionId: o.identityDecisionId ?? null,
  });
  return { fact: updated!, versionId };
}

// ── cardinality slots (06 §2.5 SL-1..SL-4) ───────────────────────────────
export async function lockSlots(tx: Tx, scope: NovelScope): Promise<void> {
  await tx.db.execute(sql`select pg_advisory_xact_lock(hashtext(${`ontology_slots:${scope.novelId}`}))`);
}

export async function titleMaxHoldersMap(db: Db, scope: NovelScope, titleIds: string[]): Promise<Map<string, number | "unbounded">> {
  const ids = [...new Set(titleIds.filter(Boolean))];
  const out = new Map<string, number | "unbounded">();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ subject: facts.subjectEntityId, value: facts.value })
    .from(facts)
    .where(and(eq(facts.novelId, scope.novelId), eq(facts.predicate, "max_holders"), inArray(facts.subjectEntityId, ids), inArray(facts.canonStatus, ["candidate", "approved", "published_locked"])));
  for (const r of rows) {
    if (!r.subject) continue;
    const v = r.value;
    out.set(r.subject, v === "unbounded" ? "unbounded" : typeof v === "number" && v >= 1 ? v : 1);
  }
  return out;
}

export async function deleteSlots(tx: Tx, scope: NovelScope, factId: string): Promise<void> {
  await tx.db.delete(factCardinalitySlots).where(and(eq(factCardinalitySlots.novelId, scope.novelId), eq(factCardinalitySlots.factId, factId)));
}

/**
 * SL-2..SL-4: pre-check overlaps, then insert inside a savepoint; any overlap (pre-check or 23P01) → not written.
 * Caller must hold lockSlots (SL-1) and must not have promoted the fact yet.
 */
export async function writeSlots(
  tx: Tx,
  scope: NovelScope,
  schema: OntologySchemaData,
  fact: Fact,
  titleMax: Map<string, number | "unbounded">,
): Promise<{ ok: true } | { ok: false; slotKey: string; conflictFactIds: string[] }> {
  const keys = cardinalitySlotKeys(schema, factShape(fact), (t) => titleMax.get(t) ?? 1);
  if (keys.length === 0) return { ok: true };
  const range = parseRange(fact.storyRange);
  for (const k of keys) {
    const rows = await tx.db
      .select({ factId: factCardinalitySlots.factId, storyRange: factCardinalitySlots.storyRange })
      .from(factCardinalitySlots)
      .where(and(eq(factCardinalitySlots.novelId, scope.novelId), eq(factCardinalitySlots.timelineId, fact.timelineId), eq(factCardinalitySlots.slotKey, k)));
    const hits = rows.filter((r) => r.factId !== fact.id && rangesOverlap(parseRange(r.storyRange), range));
    if (hits.length > 0) return { ok: false, slotKey: k, conflictFactIds: hits.map((h) => h.factId) };
  }
  try {
    await tx.db.transaction(async (sp) => {
      for (const k of keys) {
        await sp
          .insert(factCardinalitySlots)
          .values({ novelId: scope.novelId, factId: fact.id, timelineId: fact.timelineId, slotKey: k, storyRange: rangeLiteral(range) })
          .onConflictDoUpdate({
            target: [factCardinalitySlots.novelId, factCardinalitySlots.factId, factCardinalitySlots.slotKey],
            set: { storyRange: rangeLiteral(range), timelineId: fact.timelineId },
          });
      }
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23P01" || (err as { cause?: { code?: string } }).cause?.code === "23P01") {
      return { ok: false, slotKey: keys[0]!, conflictFactIds: [] };
    }
    throw err;
  }
  return { ok: true };
}

/** recompute slot rows of a canon fact after its range / subject / object changed (06 §3.11 step 6, §6.2) */
export async function rewriteSlots(tx: Tx, scope: NovelScope, schema: OntologySchemaData, fact: Fact, titleMax: Map<string, number | "unbounded">) {
  await deleteSlots(tx, scope, fact.id);
  if (fact.canonStatus !== "approved" && fact.canonStatus !== "published_locked") return { ok: true as const };
  return writeSlots(tx, scope, schema, fact, titleMax);
}

// ── projection ──────────────────────────────────────────────────────────
export function toFactAtAnchor(f: Fact, versionId: string, schema: OntologySchemaData, names: Map<string, string>, content?: Partial<FactContent>): FactAtAnchor {
  const range = parseRange(f.storyRange);
  return {
    factId: f.id,
    factVersionId: versionId,
    canonStatus: f.canonStatus,
    factKind: f.factKind,
    predicate: f.predicate,
    subjectEntityId: f.subjectEntityId ?? "",
    objectEntityId: f.objectEntityId,
    value: f.value ?? (f.objectFactId ? { factId: f.objectFactId } : f.objectNameId ? { nameId: f.objectNameId } : null),
    text: renderFactText(schema, { ...factShape(f, content), knowledgeStance: f.knowledgeStance }, (id) => names.get(id) ?? id, range),
    storyRange: { from: range.from, to: range.to },
    timelineId: f.timelineId,
  };
}

export async function project(db: Db, scope: NovelScope, rows: Fact[], schema: OntologySchemaData): Promise<FactAtAnchor[]> {
  const names = await preferredNames(
    db,
    scope,
    rows.flatMap((r) => [r.subjectEntityId ?? "", r.objectEntityId ?? ""]),
  );
  const cur = await currentContents(db, scope, rows.map((r) => r.id));
  return rows.map((r) => toFactAtAnchor(r, cur.get(r.id)?.versionId ?? "", schema, names, cur.get(r.id)?.content));
}

export const CANON: CanonStatus[] = ["approved", "published_locked"];

export function rangeSqlContains(p: number) {
  return sql`${facts.storyRange} @> ${p}::int4`;
}

/** text[] parameter (drizzle spreads JS arrays inside sql``; ids contain no array metacharacters) */
export function textArray(ids: readonly string[]) {
  return sql`${`{${ids.map((x) => `"${x.replace(/["\\]/g, "")}"`).join(",")}}`}::text[]`;
}
