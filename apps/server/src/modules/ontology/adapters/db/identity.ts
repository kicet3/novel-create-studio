/**
 * IdentityDecision merge / split / relink / confirm_distinct and revert (06 §3.11, FR-ONT-16).
 * Every reference move is recorded in identity_decision_moves; values the moves table cannot hold
 * (old name ranges, preferred flags, retired conflict rows, confusable lists, distinct pairs, demoted facts)
 * are kept in `identity_decisions.evidence.applied` so revert restores the exact prior state.
 */
import { and, asc, desc, eq, inArray, ne, or, sql } from "@ncs/db/orm";
import { entities, entityDistinctPairs, entityNames, facts, identityDecisionMoves, identityDecisions, mentions } from "@ncs/db/schema";
import type { CanonStatus } from "@ncs/shared";
import { defaultValue } from "@ncs/shared";
import { ConflictError, DomainValidationError, NotFoundError, type ActorRef, type Db, type NovelScope, type Tx } from "../../../../platform/index.js";
import type { Fact, IdentityDecision, IdentityImpact, ProposeIdentityInput } from "../../index.js";
import { cardinalitySlotKeys, computeSlotKey, parseRange, rangeLiteral, rangesOverlap, unionRange } from "../../domain/facts.js";
import { editDistance, isCrossScript, syllableCount } from "../../domain/normalize.js";
import { assertEntityTransition, assertIdentityTransition, isCanon } from "../../domain/transitions.js";
import {
  activeSchema,
  appendFactVersion,
  currentContents,
  deleteSlots,
  factShape,
  getEntityRow,
  lockSlots,
  resolveIds,
  rewriteSlots,
  titleMaxHoldersMap,
  textArray,
  type OntoDeps,
} from "./common.js";
import { createEntity } from "./entities.js";

const MENTION_COLS = ["linkedEntityId", "speakerEntityId", "povEntityId", "viaEntityId"] as const;
type MentionCol = (typeof MENTION_COLS)[number];
const SQL_COL: Record<MentionCol, string> = { linkedEntityId: "linked_entity_id", speakerEntityId: "speaker_entity_id", povEntityId: "pov_entity_id", viaEntityId: "via_entity_id" };

interface Restore {
  movedNames: Array<{ nameId: string; wasPreferred: boolean }>;
  retiredNames: Array<{ nameId: string; conflictWith: string }>;
  widened: Array<{ nameId: string; range: string; identityKnownBy: string[] }>;
  viaName: Array<{ mentionId: string; from: string; to: string }>;
  objectName: Array<{ factId: string; from: string; to: string }>;
  confusable: Array<{ entityId: string; old: string[] }>;
  pairs: Array<{ a: string; b: string; decisionId: string | null }>;
  demoted: Array<{ factId: string; status: CanonStatus }>;
  proposedNames: string[];
  absorbed: Array<{ entityId: string; status: "candidate" | "active" }>;
}
const emptyRestore = (): Restore => ({ movedNames: [], retiredNames: [], widened: [], viaName: [], objectName: [], confusable: [], pairs: [], demoted: [], proposedNames: [], absorbed: [] });

export async function getDecision(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<IdentityDecision> {
  const q = db.select().from(identityDecisions).where(and(eq(identityDecisions.novelId, scope.novelId), eq(identityDecisions.id, id)));
  const [r] = forUpdate ? await q.for("update") : await q;
  if (!r) throw new NotFoundError("동일성 결정", id);
  return r;
}

export async function listDecisions(db: Db, scope: NovelScope, q: { entityId?: string; statuses?: IdentityDecision["status"][] } = {}): Promise<IdentityDecision[]> {
  const conds = [eq(identityDecisions.novelId, scope.novelId)];
  if (q.statuses?.length) conds.push(inArray(identityDecisions.status, q.statuses));
  if (q.entityId) {
    const id = q.entityId;
    conds.push(
      or(
        sql`${identityDecisions.sourceEntityIds} @> ARRAY[${id}]::text[]`,
        eq(identityDecisions.survivorEntityId, id),
        eq(identityDecisions.newEntityId, id),
        eq(identityDecisions.relinkFromEntityId, id),
        eq(identityDecisions.relinkToEntityId, id),
      )!,
    );
  }
  return db.select().from(identityDecisions).where(and(...conds)).orderBy(desc(identityDecisions.createdAt));
}

// ── impact (Q8) ─────────────────────────────────────────────────────────
async function slotConflictsFor(db: Db, scope: NovelScope, factRows: Fact[], remap: (id: string | null) => string | null) {
  const { schema } = await activeSchema(db, scope);
  const canon = factRows.filter((f) => isCanon(f.canonStatus) && !f.isNegation);
  const titleMax = await titleMaxHoldersMap(db, scope, canon.map((f) => remap(f.objectEntityId) ?? ""));
  const bySlot = new Map<string, Array<{ f: Fact; origin: string }>>();
  for (const f of canon) {
    const mapped = { ...factShape(f), subjectEntityId: remap(f.subjectEntityId), objectEntityId: remap(f.objectEntityId) };
    for (const k of cardinalitySlotKeys(schema, mapped, (t) => titleMax.get(t) ?? 1)) {
      const key = `${f.timelineId}|${k}`;
      bySlot.set(key, [...(bySlot.get(key) ?? []), { f, origin: `${f.subjectEntityId}|${f.objectEntityId}` }]);
    }
  }
  const out: Array<{ slotKey: string; factIds: string[] }> = [];
  for (const [k, list] of bySlot) {
    const ids = new Set<string>();
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const same = remap(a.f.subjectEntityId) === remap(b.f.subjectEntityId) && remap(a.f.objectEntityId) === remap(b.f.objectEntityId) && JSON.stringify(a.f.value) === JSON.stringify(b.f.value);
        if (a.origin !== b.origin && !same && rangesOverlap(parseRange(a.f.storyRange), parseRange(b.f.storyRange))) {
          ids.add(a.f.id);
          ids.add(b.f.id);
        }
      }
    if (ids.size) out.push({ slotKey: k.slice(k.indexOf("|") + 1), factIds: [...ids] });
  }
  return out;
}

export async function computeIdentityImpact(db: Db, scope: NovelScope, entityIds: string[]): Promise<IdentityImpact> {
  const ids = [...new Set(entityIds)];
  if (ids.length === 0) return { mentions: 0, facts: 0, setupLinks: 0, sceneParticipants: 0, slotConflicts: [] };
  const [m] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mentions)
    .where(and(eq(mentions.novelId, scope.novelId), or(...MENTION_COLS.map((c) => inArray(mentions[c], ids)))));
  const factRows = await db.select().from(facts).where(and(eq(facts.novelId, scope.novelId), or(inArray(facts.subjectEntityId, ids), inArray(facts.objectEntityId, ids))));
  const [nm] = await db.select({ n: sql<number>`count(*)::int` }).from(entityNames).where(and(eq(entityNames.novelId, scope.novelId), inArray(entityNames.entityId, ids)));
  const byStatus: Partial<Record<CanonStatus, number>> = {};
  for (const f of factRows) byStatus[f.canonStatus] = (byStatus[f.canonStatus] ?? 0) + 1;
  const survivor = ids[0]!;
  const set = new Set(ids);
  return {
    mentions: m?.n ?? 0,
    facts: factRows.length,
    factsByStatus: byStatus,
    names: nm?.n ?? 0,
    // setup_links / scene_participants belong to foreshadow / manuscript (not visible to ontology): reported 0
    setupLinks: 0,
    sceneParticipants: 0,
    slotConflicts: await slotConflictsFor(db, scope, factRows, (id) => (id && set.has(id) ? survivor : id)),
  };
}

export async function computeRelinkImpact(db: Db, scope: NovelScope, mentionIds: string[], toEntityId: string): Promise<IdentityImpact> {
  if (mentionIds.length === 0) return { mentions: 0, facts: 0, setupLinks: 0, sceneParticipants: 0, slotConflicts: [] };
  const ms = await db.select().from(mentions).where(and(eq(mentions.novelId, scope.novelId), inArray(mentions.id, mentionIds)));
  const cited = await db.select().from(facts).where(and(eq(facts.novelId, scope.novelId), sql`${facts.mentionIds} && ${textArray(mentionIds)}`));
  const from = new Set(ms.map((x) => x.linkedEntityId).filter((x): x is string => !!x));
  const others = await db.select().from(facts).where(and(eq(facts.novelId, scope.novelId), or(eq(facts.subjectEntityId, toEntityId), eq(facts.objectEntityId, toEntityId))));
  const byStatus: Partial<Record<CanonStatus, number>> = {};
  for (const f of cited) byStatus[f.canonStatus] = (byStatus[f.canonStatus] ?? 0) + 1;
  const citedIds = new Set(cited.map((f) => f.id));
  return {
    mentions: ms.length,
    facts: cited.length,
    factsByStatus: byStatus,
    setupLinks: 0,
    sceneParticipants: 0,
    slotConflicts: await slotConflictsFor(db, scope, [...cited, ...others.filter((o) => !citedIds.has(o.id))], (id) => (id && from.has(id) ? toEntityId : id)),
  };
}

// ── propose (ID1) ───────────────────────────────────────────────────────
export async function proposeDecision(d: OntoDeps, tx: Tx, scope: NovelScope, input: ProposeIdentityInput, actor: ActorRef): Promise<IdentityDecision> {
  const resolved = await resolveIds(tx.db, scope, input.entityIds);
  const ids = [...new Set(input.entityIds.map((id) => resolved.get(id)))].filter((x): x is string => !!x);
  if (ids.length !== new Set(input.entityIds).size) throw new DomainValidationError("entity_not_found", "결정 대상 엔티티를 찾을 수 없습니다.");
  const now = d.platform.clock.date();
  const id = d.platform.ids.next("idd");
  let impact: IdentityImpact;
  const base = {
    id,
    novelId: scope.novelId,
    kind: input.kind,
    rationale: input.rationale,
    evidence: { ...(input.evidence ?? {}), ...(input.split ? { split: input.split } : {}) },
    questionId: input.questionId ?? null,
    approvalId: input.approvalId ?? null,
    proposedByActorType: actor.type,
    proposedByActorId: actor.id,
    createdAt: now,
    updatedAt: now,
  };
  let row: IdentityDecision | undefined;
  if (input.kind === "merge") {
    if (ids.length < 2) throw new DomainValidationError("merge_needs_two", "병합에는 엔티티가 2개 이상 필요합니다.");
    const survivor = input.survivorEntityId ? resolved.get(input.survivorEntityId) ?? input.survivorEntityId : ids[0]!;
    if (!ids.includes(survivor)) throw new DomainValidationError("survivor_not_in_set", "생존 엔티티는 대상 중 하나여야 합니다.");
    impact = await computeIdentityImpact(tx.db, scope, [survivor, ...ids.filter((x) => x !== survivor)]);
    [row] = (await tx.db.insert(identityDecisions).values({ ...base, sourceEntityIds: ids, survivorEntityId: survivor, impact }).returning()) as IdentityDecision[];
  } else if (input.kind === "split") {
    if (ids.length !== 1 || !input.split) throw new DomainValidationError("split_input", "분리에는 원 엔티티 1개와 옮길 참조 목록이 필요합니다.");
    impact = await computeIdentityImpact(tx.db, scope, ids);
    [row] = (await tx.db.insert(identityDecisions).values({ ...base, sourceEntityIds: ids, relinkMentionIds: input.mentionIds ?? [], impact }).returning()) as IdentityDecision[];
  } else if (input.kind === "relink") {
    const to = input.relinkToEntityId ? (resolved.get(input.relinkToEntityId) ?? (await resolveIds(tx.db, scope, [input.relinkToEntityId])).get(input.relinkToEntityId)) : undefined;
    if (!to || ids.length !== 1 || !input.mentionIds?.length) throw new DomainValidationError("relink_input", "재연결에는 원 엔티티·대상 엔티티·언급 목록이 필요합니다.");
    impact = await computeRelinkImpact(tx.db, scope, input.mentionIds, to);
    [row] = (await tx.db
      .insert(identityDecisions)
      .values({ ...base, sourceEntityIds: [ids[0]!, to], relinkMentionIds: input.mentionIds, relinkFromEntityId: ids[0]!, relinkToEntityId: to, impact })
      .returning()) as IdentityDecision[];
  } else {
    // confirm_distinct: applied immediately (06 §3.11)
    if (ids.length < 2) throw new DomainValidationError("distinct_needs_two", "다름 확인에는 엔티티가 2개 이상 필요합니다.");
    [row] = (await tx.db
      .insert(identityDecisions)
      .values({ ...base, sourceEntityIds: ids, status: "applied", appliedAt: now, decidedByActorType: actor.type, decidedByActorId: actor.id, impact: {} })
      .returning()) as IdentityDecision[];
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = [ids[i]!, ids[j]!].sort() as [string, string];
        await tx.db.insert(entityDistinctPairs).values({ novelId: scope.novelId, entityAId: a, entityBId: b, decisionId: id }).onConflictDoNothing();
      }
    await d.audit.record(tx, { novelId: scope.novelId, actor, action: "identity.applied", target: { type: "identity_decision", id }, after: { kind: "confirm_distinct", entityIds: ids }, questionId: input.questionId ?? null });
    return row!;
  }
  await d.audit.record(tx, {
    novelId: scope.novelId,
    actor,
    action: "identity.proposed",
    target: { type: "identity_decision", id },
    after: { kind: input.kind, entityIds: ids },
    reason: input.rationale,
    questionId: input.questionId ?? null,
    details: { impact },
  });
  return row!;
}

export async function rejectDecision(d: OntoDeps, tx: Tx, scope: NovelScope, id: string, actor: ActorRef, reason?: string): Promise<IdentityDecision> {
  const dec = await getDecision(tx.db, scope, id, true);
  const rule = assertIdentityTransition(dec.status, "rejected");
  const [row] = await tx.db
    .update(identityDecisions)
    .set({ status: "rejected", decidedByActorType: actor.type, decidedByActorId: actor.id, updatedAt: d.platform.clock.date() })
    .where(and(eq(identityDecisions.novelId, scope.novelId), eq(identityDecisions.id, id)))
    .returning();
  await d.audit.record(tx, { novelId: scope.novelId, actor, action: rule.audit, target: { type: "identity_decision", id }, before: { status: dec.status }, after: { status: "rejected" }, reason: reason ?? null });
  return row!;
}

// ── apply (ID2) ─────────────────────────────────────────────────────────
async function recordMove(tx: Tx, scope: NovelScope, decisionId: string, refTable: string, refId: string, refColumn: string, from: string, to: string, createdFactVersionId?: string) {
  await tx.db.insert(identityDecisionMoves).values({ novelId: scope.novelId, decisionId, refTable, refId, refColumn, fromEntityId: from, toEntityId: to, createdFactVersionId: createdFactVersionId ?? null });
}

/** move fact subject/object `from → to`, new FactVersion, slot rewrite; canon slot conflict → demote to candidate */
async function moveFactRefs(d: OntoDeps, tx: Tx, scope: NovelScope, dec: IdentityDecision, f: Fact, map: (id: string | null) => string | null, reason: "identity_merge" | "identity_split" | "identity_relink", actor: ActorRef, restore: Restore, demoteOnConflict: boolean) {
  const { schema } = await activeSchema(tx.db, scope);
  const content = (await currentContents(tx.db, scope, [f.id])).get(f.id)?.content;
  const subj = map(f.subjectEntityId);
  const obj = map(f.objectEntityId);
  if (subj === f.subjectEntityId && obj === f.objectEntityId) return;
  const slotKey = computeSlotKey(schema, { ...factShape(f, content), subjectEntityId: subj, objectEntityId: obj });
  const { fact, versionId } = await appendFactVersion(d, tx, scope, f, { subjectEntityId: subj, objectEntityId: obj, slotKey }, { changeReason: reason, actor, identityDecisionId: dec.id, approvalId: dec.approvalId });
  if (subj !== f.subjectEntityId) await recordMove(tx, scope, dec.id, "facts", f.id, "subject_entity_id", f.subjectEntityId!, subj!, versionId);
  if (obj !== f.objectEntityId) await recordMove(tx, scope, dec.id, "facts", f.id, "object_entity_id", f.objectEntityId!, obj!, versionId);
  if (isCanon(fact.canonStatus)) {
    const titleMax = await titleMaxHoldersMap(tx.db, scope, fact.objectEntityId ? [fact.objectEntityId] : []);
    const r = await rewriteSlots(tx, scope, schema, fact, titleMax);
    if (!r.ok) {
      if (!demoteOnConflict) throw new ConflictError("slot_conflict", "옮긴 사실이 다른 캐논 사실과 기간이 겹칩니다.", { factId: f.id, slotKey: r.slotKey });
      // 06 §3.11 step 6: demote the absorbed-side fact (INV-ONT-05 kept)
      await deleteSlots(tx, scope, fact.id);
      restore.demoted.push({ factId: fact.id, status: fact.canonStatus });
      await appendFactVersion(d, tx, scope, fact, { canonStatus: "candidate" }, { changeReason: reason, actor, identityDecisionId: dec.id });
    }
  }
}

async function moveMentionCols(tx: Tx, scope: NovelScope, decId: string, ids: string[], map: (id: string) => string | null, onlyMentionIds?: string[]) {
  for (const col of MENTION_COLS) {
    const rows = await tx.db
      .select({ id: mentions.id, v: mentions[col] })
      .from(mentions)
      .where(and(eq(mentions.novelId, scope.novelId), inArray(mentions[col], ids), onlyMentionIds ? inArray(mentions.id, onlyMentionIds.length ? onlyMentionIds : ["-"]) : undefined));
    for (const r of rows) {
      const to = map(r.v!);
      if (!to || to === r.v) continue;
      await tx.db.update(mentions).set({ [col]: to, updatedAt: sql`now()` }).where(and(eq(mentions.novelId, scope.novelId), eq(mentions.id, r.id)));
      await recordMove(tx, scope, decId, "mentions", r.id, SQL_COL[col], r.v!, to);
    }
  }
}

function needsApproval(impact: IdentityImpact): boolean {
  return (impact.factsByStatus?.published_locked ?? 0) > 0;
}

export async function applyDecision(d: OntoDeps, tx: Tx, scope: NovelScope, decisionId: string, actor: ActorRef): Promise<IdentityDecision> {
  const dec = await getDecision(tx.db, scope, decisionId, true);
  const rule = assertIdentityTransition(dec.status, "applied");
  const restore = emptyRestore();
  await lockSlots(tx, scope);
  let newEntityId: string | null = null;
  let impact: IdentityImpact;

  if (dec.kind === "merge") {
    const S = dec.survivorEntityId!;
    const Ls = dec.sourceEntityIds.filter((x) => x !== S);
    const locked = await tx.db.select().from(entities).where(and(eq(entities.novelId, scope.novelId), inArray(entities.id, [S, ...Ls]))).orderBy(asc(entities.id)).for("update");
    const sRow = locked.find((e) => e.id === S);
    if (!sRow || sRow.status !== "active") throw new ConflictError("survivor_not_active", "생존 엔티티는 활성 상태여야 합니다(INV-ONT-09).");
    impact = await computeIdentityImpact(tx.db, scope, [S, ...Ls]);
    if (needsApproval(impact) && !dec.approvalId) {
      throw new ConflictError("identity_change_approval_required", "공개된 사실에 닿는 병합은 identity_change 승인이 필요합니다.", { impact });
    }
    const set = new Set(Ls);
    const map = (id: string | null) => (id && set.has(id) ? S : id);
    for (const L of Ls) {
      const lRow = locked.find((e) => e.id === L);
      if (!lRow) throw new NotFoundError("엔티티", L);
      if (lRow.status !== "candidate" && lRow.status !== "active") throw new ConflictError("not_mergeable", "병합할 수 없는 상태의 엔티티입니다.");
      restore.absorbed.push({ entityId: L, status: lRow.status });
      // names (step 4)
      const sNames = await tx.db.select().from(entityNames).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.entityId, S), ne(entityNames.status, "retired")));
      const lNames = await tx.db.select().from(entityNames).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.entityId, L), ne(entityNames.status, "retired")));
      for (const n of lNames) {
        const clash = sNames.find(
          (s) =>
            s.normalizedKey === n.normalizedKey &&
            (s.timelineId ?? "*") === (n.timelineId ?? "*") &&
            (s.nameKind === n.nameKind || (["variant", "hidden_variant"].includes(s.nameKind) && ["variant", "hidden_variant"].includes(n.nameKind))) &&
            rangesOverlap(parseRange(s.storyRange), parseRange(n.storyRange)),
        );
        if (clash) {
          await tx.db.update(entityNames).set({ status: "retired", mergedConflictWithId: clash.id, isPreferred: false }).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.id, n.id)));
          restore.retiredNames.push({ nameId: n.id, conflictWith: clash.id });
          restore.movedNames.push({ nameId: n.id, wasPreferred: n.isPreferred });
          restore.widened.push({ nameId: clash.id, range: clash.storyRange, identityKnownBy: clash.identityKnownByEntityIds });
          await tx.db
            .update(entityNames)
            .set({
              storyRange: rangeLiteral(unionRange(parseRange(clash.storyRange), parseRange(n.storyRange))),
              identityKnownByEntityIds: [...new Set([...clash.identityKnownByEntityIds, ...n.identityKnownByEntityIds])],
            })
            .where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.id, clash.id)));
          await recordMove(tx, scope, dec.id, "entity_names", n.id, "merged_conflict_with_id", L, S);
          const via = await tx.db.select({ id: mentions.id }).from(mentions).where(and(eq(mentions.novelId, scope.novelId), eq(mentions.viaNameId, n.id)));
          for (const v of via) {
            await tx.db.update(mentions).set({ viaNameId: clash.id }).where(and(eq(mentions.novelId, scope.novelId), eq(mentions.id, v.id)));
            restore.viaName.push({ mentionId: v.id, from: n.id, to: clash.id });
          }
          const on = await tx.db.select({ id: facts.id }).from(facts).where(and(eq(facts.novelId, scope.novelId), eq(facts.objectNameId, n.id)));
          for (const o of on) {
            await tx.db.update(facts).set({ objectNameId: clash.id }).where(and(eq(facts.novelId, scope.novelId), eq(facts.id, o.id)));
            restore.objectName.push({ factId: o.id, from: n.id, to: clash.id });
          }
        } else {
          await tx.db.update(entityNames).set({ entityId: S, originEntityId: L, isPreferred: false, updatedAt: sql`now()` }).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.id, n.id)));
          restore.movedNames.push({ nameId: n.id, wasPreferred: n.isPreferred });
          await recordMove(tx, scope, dec.id, "entity_names", n.id, "entity_id", L, S);
        }
      }
      // L loses its preferred pointer only via status merged (preferred_name_id keeps pointing at the moved row: allowed, FK by id)
    }
    // mentions (step 3)
    await moveMentionCols(tx, scope, dec.id, Ls, (id) => map(id));
    // facts (step 5/6): absorbed-side facts
    const fRows = await tx.db.select().from(facts).where(and(eq(facts.novelId, scope.novelId), or(inArray(facts.subjectEntityId, Ls), inArray(facts.objectEntityId, Ls)))).orderBy(asc(facts.id));
    for (const f of fRows) await moveFactRefs(d, tx, scope, dec, f, map, "identity_merge", actor, restore, true);
    // confusable / distinct pairs (step 7)
    const conf = await tx.db.select({ id: entities.id, c: entities.confusableWithIds }).from(entities).where(and(eq(entities.novelId, scope.novelId), sql`${entities.confusableWithIds} && ${textArray(Ls)}`));
    for (const r of conf) {
      restore.confusable.push({ entityId: r.id, old: r.c });
      const next = [...new Set(r.c.map((x) => map(x)!).filter((x) => x !== r.id))];
      await tx.db.update(entities).set({ confusableWithIds: next }).where(and(eq(entities.novelId, scope.novelId), eq(entities.id, r.id)));
    }
    const pairs = await tx.db.select().from(entityDistinctPairs).where(and(eq(entityDistinctPairs.novelId, scope.novelId), or(inArray(entityDistinctPairs.entityAId, Ls), inArray(entityDistinctPairs.entityBId, Ls))));
    for (const p of pairs) {
      restore.pairs.push({ a: p.entityAId, b: p.entityBId, decisionId: p.decisionId });
      await tx.db.delete(entityDistinctPairs).where(and(eq(entityDistinctPairs.novelId, scope.novelId), eq(entityDistinctPairs.entityAId, p.entityAId), eq(entityDistinctPairs.entityBId, p.entityBId)));
      const a = map(p.entityAId)!;
      const b = map(p.entityBId)!;
      if (a !== b) {
        const [x, y] = [a, b].sort() as [string, string];
        await tx.db.insert(entityDistinctPairs).values({ novelId: scope.novelId, entityAId: x, entityBId: y, decisionId: p.decisionId }).onConflictDoNothing();
      }
    }
    for (const L of Ls) {
      const from = restore.absorbed.find((a) => a.entityId === L)!.status;
      const r = assertEntityTransition(from, "merged");
      await tx.db.update(entities).set({ status: "merged", mergedIntoId: S, updatedAt: sql`now()` }).where(and(eq(entities.novelId, scope.novelId), eq(entities.id, L)));
      await d.audit.record(tx, { novelId: scope.novelId, actor, action: r.audit, target: { type: "entity", id: L }, before: { status: from }, after: { status: "merged", mergedIntoId: S }, details: { rule: r.id, decisionId: dec.id } });
    }
  } else if (dec.kind === "split") {
    const E = dec.sourceEntityIds[0]!;
    const eRow = await getEntityRow(tx.db, scope, E, true);
    impact = await computeIdentityImpact(tx.db, scope, [E]);
    const split = ((dec.evidence as { split?: ProposeIdentityInput["split"] }).split)!;
    const movedFacts = split.factIds ?? [];
    if (needsApproval(impact) && !dec.approvalId) {
      const pub = movedFacts.length ? await tx.db.select({ id: facts.id }).from(facts).where(and(eq(facts.novelId, scope.novelId), inArray(facts.id, movedFacts), eq(facts.canonStatus, "published_locked"))) : [];
      if (pub.length) throw new ConflictError("identity_change_approval_required", "공개된 사실에 닿는 분리는 identity_change 승인이 필요합니다.", { impact });
    }
    const created = await createEntity(d, tx, scope, { entityType: (split.newEntity.entityType ?? eRow.entityType) as never, preferredName: { surface: split.newEntity.preferredName }, status: "active" }, actor);
    newEntityId = created.entity.id;
    const N = newEntityId;
    const map = (id: string | null) => (id === E ? N : id);
    await moveMentionCols(tx, scope, dec.id, [E], () => N, dec.relinkMentionIds);
    if (movedFacts.length) {
      const fRows = await tx.db.select().from(facts).where(and(eq(facts.novelId, scope.novelId), inArray(facts.id, movedFacts)));
      for (const f of fRows) await moveFactRefs(d, tx, scope, dec, f, map, "identity_split", actor, restore, true);
    }
    for (const nameId of split.nameIds ?? []) {
      const [n] = await tx.db.select().from(entityNames).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.id, nameId), eq(entityNames.entityId, E)));
      if (!n || n.isPreferred) continue;
      await tx.db.update(entityNames).set({ entityId: N }).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.id, nameId)));
      restore.movedNames.push({ nameId, wasPreferred: false });
      await recordMove(tx, scope, dec.id, "entity_names", nameId, "entity_id", E, N);
    }
  } else if (dec.kind === "relink") {
    const from = dec.relinkFromEntityId!;
    const to = dec.relinkToEntityId!;
    impact = await computeRelinkImpact(tx.db, scope, dec.relinkMentionIds, to);
    if (needsApproval(impact) && !dec.approvalId) throw new ConflictError("identity_change_approval_required", "공개된 사실에 닿는 재연결은 identity_change 승인이 필요합니다.", { impact });
    const ms = await tx.db.select().from(mentions).where(and(eq(mentions.novelId, scope.novelId), inArray(mentions.id, dec.relinkMentionIds)));
    for (const m of ms) {
      if (m.linkedEntityId !== from) continue;
      await tx.db.update(mentions).set({ linkedEntityId: to, linkStatus: "confirmed", updatedAt: sql`now()` }).where(and(eq(mentions.novelId, scope.novelId), eq(mentions.id, m.id)));
      await recordMove(tx, scope, dec.id, "mentions", m.id, "linked_entity_id", from, to);
    }
    // RL-1: facts citing the mentions in a role
    const cited = await tx.db.select().from(facts).where(and(eq(facts.novelId, scope.novelId), sql`${facts.mentionIds} && ${textArray(dec.relinkMentionIds)}`));
    const contents = await currentContents(tx.db, scope, cited.map((f) => f.id));
    const mset = new Set(dec.relinkMentionIds);
    for (const f of cited) {
      const arg = contents.get(f.id)?.content.argMentions ?? {};
      const map = (id: string | null, role: "subject" | "object") => (id === from && arg[role] && mset.has(arg[role]!) ? to : id);
      await moveFactRefs(d, tx, scope, dec, f, (id) => (id === f.subjectEntityId ? map(id, "subject") : map(id, "object")), "identity_relink", actor, restore, false);
    }
    // RL-2: names that came from these mentions go back to proposed
    const fromNames = await tx.db.select().from(entityNames).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.sourceRefType, "mention"), inArray(entityNames.sourceRefId, dec.relinkMentionIds), eq(entityNames.status, "active"), eq(entityNames.isPreferred, false)));
    for (const n of fromNames) {
      await tx.db.update(entityNames).set({ status: "proposed" }).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.id, n.id)));
      restore.proposedNames.push(n.id);
    }
    await d.audit.record(tx, { novelId: scope.novelId, actor, action: "mention.relinked", target: { type: "identity_decision", id: dec.id }, details: { ids: dec.relinkMentionIds, count: dec.relinkMentionIds.length, from, to } });
  } else {
    throw new DomainValidationError("confirm_distinct_applied", "다름 확인은 제안 없이 바로 적용됩니다.");
  }

  const [row] = await tx.db
    .update(identityDecisions)
    .set({
      status: "applied",
      appliedAt: d.platform.clock.date(),
      decidedByActorType: actor.type,
      decidedByActorId: actor.id,
      newEntityId,
      impact,
      evidence: { ...(dec.evidence as object), applied: restore },
      updatedAt: d.platform.clock.date(),
    })
    .where(and(eq(identityDecisions.novelId, scope.novelId), eq(identityDecisions.id, dec.id)))
    .returning();
  await d.audit.record(tx, {
    novelId: scope.novelId,
    actor,
    action: rule.audit,
    target: { type: "identity_decision", id: dec.id },
    before: { status: dec.status },
    after: { status: "applied", kind: dec.kind, newEntityId },
    approvalId: dec.approvalId,
    questionId: dec.questionId,
    details: { impact, demoted: restore.demoted.map((x) => x.factId) },
  });
  return row!;
}

// ── revert (ID4) ────────────────────────────────────────────────────────
const MENTION_SQL_TO_COL: Record<string, MentionCol> = { linked_entity_id: "linkedEntityId", speaker_entity_id: "speakerEntityId", pov_entity_id: "povEntityId", via_entity_id: "viaEntityId" };

export async function revertDecision(d: OntoDeps, tx: Tx, scope: NovelScope, decisionId: string, actor: ActorRef): Promise<IdentityDecision> {
  const dec = await getDecision(tx.db, scope, decisionId, true);
  const rule = assertIdentityTransition(dec.status, "reverted");
  if (dec.kind === "confirm_distinct") {
    await tx.db.delete(entityDistinctPairs).where(and(eq(entityDistinctPairs.novelId, scope.novelId), eq(entityDistinctPairs.decisionId, dec.id)));
  }
  await lockSlots(tx, scope);
  const restore = { ...emptyRestore(), ...(((dec.evidence as { applied?: Restore }).applied ?? {}) as Partial<Restore>) } as Restore;
  const impact = (dec.impact ?? {}) as IdentityImpact;
  if (needsApproval(impact) && !dec.approvalId) throw new ConflictError("identity_change_approval_required", "공개된 사실에 닿는 되돌리기는 identity_change 승인이 필요합니다.");
  const moves = await tx.db.select().from(identityDecisionMoves).where(and(eq(identityDecisionMoves.novelId, scope.novelId), eq(identityDecisionMoves.decisionId, dec.id))).orderBy(desc(identityDecisionMoves.id));

  // steps 1–3: verify every move still holds its `to` value; any drift → conflict list, nothing applied (step 5)
  const conflicts: Array<{ refTable: string; refId: string; refColumn: string; expected: string; actual: string | null }> = [];
  for (const m of moves) {
    let actual: string | null = null;
    if (m.refTable === "mentions") {
      const col = MENTION_SQL_TO_COL[m.refColumn]!;
      const [r] = await tx.db.select({ v: mentions[col] }).from(mentions).where(and(eq(mentions.novelId, scope.novelId), eq(mentions.id, m.refId)));
      actual = r?.v ?? null;
    } else if (m.refTable === "facts") {
      const [r] = await tx.db.select({ s: facts.subjectEntityId, o: facts.objectEntityId }).from(facts).where(and(eq(facts.novelId, scope.novelId), eq(facts.id, m.refId)));
      actual = m.refColumn === "subject_entity_id" ? (r?.s ?? null) : (r?.o ?? null);
    } else if (m.refTable === "entity_names" && m.refColumn === "entity_id") {
      const [r] = await tx.db.select({ e: entityNames.entityId }).from(entityNames).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.id, m.refId)));
      actual = r?.e ?? null;
    } else continue;
    if (actual !== m.toEntityId) conflicts.push({ refTable: m.refTable, refId: m.refId, refColumn: m.refColumn, expected: m.toEntityId, actual });
  }
  if (conflicts.length > 0) {
    throw new ConflictError("identity_revert_conflict", "이후 변경과 충돌해 되돌릴 수 없는 항목이 있습니다. 항목별로 확인하세요.", { conflicts });
  }
  const { schema } = await activeSchema(tx.db, scope);
  // facts: group moves per fact → one new version each (identity_revert)
  const factMoves = new Map<string, { subject?: string; object?: string }>();
  for (const m of moves) {
    if (m.refTable === "mentions") {
      const col = MENTION_SQL_TO_COL[m.refColumn]!;
      await tx.db.update(mentions).set({ [col]: m.fromEntityId, updatedAt: sql`now()` }).where(and(eq(mentions.novelId, scope.novelId), eq(mentions.id, m.refId)));
    } else if (m.refTable === "facts") {
      const cur = factMoves.get(m.refId) ?? {};
      if (m.refColumn === "subject_entity_id") cur.subject = m.fromEntityId;
      else cur.object = m.fromEntityId;
      factMoves.set(m.refId, cur);
    } else if (m.refTable === "entity_names" && m.refColumn === "entity_id") {
      const was = restore.movedNames.find((x) => x.nameId === m.refId);
      await tx.db.update(entityNames).set({ entityId: m.fromEntityId, originEntityId: null, isPreferred: was?.wasPreferred ?? false }).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.id, m.refId)));
    }
  }
  for (const r of restore.retiredNames) {
    const was = restore.movedNames.find((x) => x.nameId === r.nameId);
    await tx.db.update(entityNames).set({ status: "active", mergedConflictWithId: null, isPreferred: was?.wasPreferred ?? false }).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.id, r.nameId)));
  }
  for (const w of restore.widened) {
    await tx.db.update(entityNames).set({ storyRange: w.range, identityKnownByEntityIds: w.identityKnownBy }).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.id, w.nameId)));
  }
  for (const v of restore.viaName) await tx.db.update(mentions).set({ viaNameId: v.from }).where(and(eq(mentions.novelId, scope.novelId), eq(mentions.id, v.mentionId), eq(mentions.viaNameId, v.to)));
  for (const o of restore.objectName) await tx.db.update(facts).set({ objectNameId: o.from }).where(and(eq(facts.novelId, scope.novelId), eq(facts.id, o.factId), eq(facts.objectNameId, o.to)));
  for (const n of restore.proposedNames) await tx.db.update(entityNames).set({ status: "active" }).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.id, n), eq(entityNames.status, "proposed")));
  for (const c of restore.confusable) await tx.db.update(entities).set({ confusableWithIds: c.old }).where(and(eq(entities.novelId, scope.novelId), eq(entities.id, c.entityId)));

  // absorbed entities back to their previous status before facts/slots are recomputed (EN7)
  for (const a of restore.absorbed) {
    const r = assertEntityTransition("merged", "active");
    await tx.db.update(entities).set({ status: a.status, mergedIntoId: null, updatedAt: sql`now()` }).where(and(eq(entities.novelId, scope.novelId), eq(entities.id, a.entityId)));
    await d.audit.record(tx, { novelId: scope.novelId, actor, action: r.audit, target: { type: "entity", id: a.entityId }, before: { status: "merged" }, after: { status: a.status }, details: { rule: r.id, decisionId: dec.id } });
  }
  if (restore.pairs.length) {
    const absorbedIds = restore.absorbed.map((a) => a.entityId);
    const survivor = dec.survivorEntityId;
    if (survivor) {
      // drop the remapped pairs then restore the originals
      for (const p of restore.pairs) {
        const mapped = [p.a, p.b].map((x) => (absorbedIds.includes(x) ? survivor : x)).sort() as [string, string];
        await tx.db.delete(entityDistinctPairs).where(and(eq(entityDistinctPairs.novelId, scope.novelId), eq(entityDistinctPairs.entityAId, mapped[0]), eq(entityDistinctPairs.entityBId, mapped[1])));
      }
    }
    for (const p of restore.pairs) await tx.db.insert(entityDistinctPairs).values({ novelId: scope.novelId, entityAId: p.a, entityBId: p.b, decisionId: p.decisionId }).onConflictDoNothing();
  }

  // facts: restore refs (+ demoted canon status), slot recompute (step 6)
  const touched = [...factMoves.keys()];
  const fRows = touched.length ? await tx.db.select().from(facts).where(and(eq(facts.novelId, scope.novelId), inArray(facts.id, touched))) : [];
  // free the slots of all touched facts first so restored ranges do not collide with their own moved state
  for (const f of fRows) await deleteSlots(tx, scope, f.id);
  for (const f of fRows) {
    const mv = factMoves.get(f.id)!;
    const content = (await currentContents(tx.db, scope, [f.id])).get(f.id)?.content;
    const subj = mv.subject ?? f.subjectEntityId;
    const obj = mv.object ?? f.objectEntityId;
    const demoted = restore.demoted.find((x) => x.factId === f.id);
    const slotKey = computeSlotKey(schema, { ...factShape(f, content), subjectEntityId: subj, objectEntityId: obj });
    const { fact } = await appendFactVersion(
      d,
      tx,
      scope,
      f,
      { subjectEntityId: subj, objectEntityId: obj, slotKey, ...(demoted ? { canonStatus: demoted.status } : {}) },
      { changeReason: "identity_revert", actor, identityDecisionId: dec.id, approvalId: dec.approvalId },
    );
    if (isCanon(fact.canonStatus)) {
      const titleMax = await titleMaxHoldersMap(tx.db, scope, fact.objectEntityId ? [fact.objectEntityId] : []);
      const r = await rewriteSlots(tx, scope, schema, fact, titleMax);
      if (!r.ok) throw new ConflictError("identity_revert_conflict", "되돌린 사실의 기간이 다른 캐논 사실과 겹칩니다.", { factId: fact.id, slotKey: r.slotKey });
    }
  }

  // step 4: references created after the merge that reached S through a name that went back to L
  const postMerge: string[] = [];
  if (dec.kind === "merge" && dec.appliedAt) {
    const movedBack = restore.movedNames.map((x) => x.nameId);
    if (movedBack.length) {
      const moved = new Set(moves.filter((m) => m.refTable === "mentions").map((m) => m.refId));
      const late = await tx.db
        .select()
        .from(mentions)
        .where(and(eq(mentions.novelId, scope.novelId), inArray(mentions.viaNameId, movedBack), eq(mentions.linkedEntityId, dec.survivorEntityId!), sql`${mentions.createdAt} >= ${dec.appliedAt}`));
      for (const m of late) {
        if (moved.has(m.id)) continue;
        postMerge.push(m.id);
        await tx.db
          .update(mentions)
          .set({ linkStatus: "ambiguous", linkedEntityId: null, candidates: [{ entityId: dec.survivorEntityId, score: 0.5 }, ...restore.absorbed.map((a) => ({ entityId: a.entityId, score: 0.5 }))], rationale: "병합 되돌리기 후 재링킹 대상", updatedAt: sql`now()` })
          .where(and(eq(mentions.novelId, scope.novelId), eq(mentions.id, m.id)));
      }
      if (postMerge.length) {
        const cited = await tx.db.select().from(facts).where(and(eq(facts.novelId, scope.novelId), sql`${facts.mentionIds} && ${textArray(postMerge)}`, inArray(facts.canonStatus, ["approved"])));
        for (const f of cited) {
          await deleteSlots(tx, scope, f.id);
          await appendFactVersion(d, tx, scope, f, { canonStatus: "candidate" }, { changeReason: "identity_revert", actor, identityDecisionId: dec.id });
        }
      }
    }
  }
  if (dec.kind === "split" && dec.newEntityId) {
    // N keeps only its own preferred name → retire (EN8, 0 references)
    await tx.db.update(entities).set({ status: "retired", updatedAt: sql`now()` }).where(and(eq(entities.novelId, scope.novelId), eq(entities.id, dec.newEntityId)));
    await d.audit.record(tx, { novelId: scope.novelId, actor, action: "entity.status_changed", target: { type: "entity", id: dec.newEntityId }, before: { status: "active" }, after: { status: "retired" }, details: { rule: "EN8", decisionId: dec.id } });
  }
  const now = d.platform.clock.date();
  const [row] = await tx.db
    .update(identityDecisions)
    .set({ status: "reverted", revertedAt: now, revertedByActorType: actor.type, revertedByActorId: actor.id, updatedAt: now })
    .where(and(eq(identityDecisions.novelId, scope.novelId), eq(identityDecisions.id, dec.id)))
    .returning();
  await d.audit.record(tx, {
    novelId: scope.novelId,
    actor,
    action: rule.audit,
    target: { type: "identity_decision", id: dec.id },
    before: { status: "applied" },
    after: { status: "reverted" },
    details: { moves: moves.length, postMergeRelink: postMerge },
  });
  return row!;
}

// ── duplicate candidates (06 §3.10 유사 엔티티 점수) ─────────────────────
export async function findDuplicateCandidates(db: Db, scope: NovelScope, entityId?: string) {
  const ents = await db.select().from(entities).where(and(eq(entities.novelId, scope.novelId), inArray(entities.status, ["candidate", "active"])));
  const names = await db.select().from(entityNames).where(and(eq(entityNames.novelId, scope.novelId), ne(entityNames.status, "retired")));
  const fs = await db.select().from(facts).where(and(eq(facts.novelId, scope.novelId), inArray(facts.canonStatus, ["candidate", "approved", "published_locked"])));
  const pairs = await db.select().from(entityDistinctPairs).where(eq(entityDistinctPairs.novelId, scope.novelId));
  const distinct = new Set(pairs.map((p) => `${p.entityAId}|${p.entityBId}`));
  const co = await db
    .selectDistinct({ sceneId: mentions.sceneId, entityId: mentions.linkedEntityId })
    .from(mentions)
    .where(and(eq(mentions.novelId, scope.novelId), inArray(mentions.linkStatus, ["auto_linked", "confirmed"])));
  const scenesOf = new Map<string, Set<string>>();
  for (const c of co) if (c.sceneId && c.entityId) scenesOf.set(c.entityId, (scenesOf.get(c.entityId) ?? new Set()).add(c.sceneId));
  const short = defaultValue("dedup.short_name_max_syllables");
  const nameScore = (a: string, b: string) => {
    let best = 0;
    for (const x of names.filter((n) => n.entityId === a))
      for (const y of names.filter((n) => n.entityId === b)) {
        let s = 0;
        if (x.normalizedKey === y.normalizedKey) s = 1;
        else if (x.translitKey === y.translitKey && x.translitKey.length >= 2 && isCrossScript(x.surface, y.surface)) s = 0.8;
        else if (editDistance(x.jamoKey, y.jamoKey) <= 1) s = Math.min(syllableCount(x.surface), syllableCount(y.surface)) <= short ? 0.4 : 0.7;
        best = Math.max(best, s);
      }
    return best;
  };
  const attrs = (id: string) => new Map(fs.filter((f) => f.subjectEntityId === id && f.value !== null).map((f) => [f.predicate, JSON.stringify(f.value)]));
  const rels = (id: string) =>
    new Set(fs.filter((f) => f.objectEntityId && (f.subjectEntityId === id || f.objectEntityId === id)).map((f) => `${f.predicate}:${f.subjectEntityId === id ? f.objectEntityId : f.subjectEntityId}`));
  const out: Array<{ entityIds: [string, string]; score: number; reason: string }> = [];
  for (let i = 0; i < ents.length; i++)
    for (let j = i + 1; j < ents.length; j++) {
      const a = ents[i]!;
      const b = ents[j]!;
      if (entityId && a.id !== entityId && b.id !== entityId) continue;
      if (a.entityType !== b.entityType) continue;
      const [x, y] = [a.id, b.id].sort() as [string, string];
      if (distinct.has(`${x}|${y}`)) continue;
      const ns = nameScore(a.id, b.id);
      if (ns === 0) continue;
      const aa = attrs(a.id);
      const ab = attrs(b.id);
      const shared = [...aa.keys()].filter((k) => ab.has(k));
      const as = shared.length ? shared.filter((k) => aa.get(k) === ab.get(k)).length / shared.length : 0;
      const ra = rels(a.id);
      const rb = rels(b.id);
      const union = new Set([...ra, ...rb]);
      const rs = union.size ? [...ra].filter((r) => rb.has(r)).length / union.size : 0;
      let score = 0.5 * ns + 0.2 * as + 0.3 * rs;
      // co-presence in the same scene → cannot be the same entity
      const sa = scenesOf.get(a.id);
      const sb = scenesOf.get(b.id);
      if (sa && sb && [...sa].some((s) => sb.has(s))) score = 0;
      if (score <= 0) continue;
      out.push({ entityIds: [a.id, b.id], score: Math.round(score * 1000) / 1000, reason: `name=${ns} attr=${as.toFixed(2)} rel=${rs.toFixed(2)}` });
    }
  return out.sort((p, q) => q.score - p.score);
}
