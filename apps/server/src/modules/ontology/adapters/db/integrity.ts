/** Schema change proposals (06 §4.5 SP1) and the `ontology_integrity` checks (INV-ONT-02/05/07/09). */
import { and, eq, inArray, ne, sql } from "@ncs/db/orm";
import { entities, entityNames, factCardinalitySlots, facts, mentions, schemaChangeProposals } from "@ncs/db/schema";
import type { ActorRef, Db, NovelScope, Tx } from "../../../../platform/index.js";
import type { IntegrityProblem } from "../../index.js";
import { normalizedKey } from "../../domain/normalize.js";
import { parseRange, rangesOverlap } from "../../domain/facts.js";
import { CANON, textArray, type OntoDeps } from "./common.js";

export async function proposeSchemaChange(
  d: OntoDeps,
  tx: Tx,
  scope: NovelScope,
  input: { label: string; examples: unknown[]; similarKeys?: Array<{ key: string; score: number; reason: string }> },
  actor: ActorRef,
): Promise<{ proposalId: string; created: boolean }> {
  const key = normalizedKey(input.label);
  const open = await tx.db
    .select()
    .from(schemaChangeProposals)
    .where(and(eq(schemaChangeProposals.novelId, scope.novelId), eq(schemaChangeProposals.status, "proposed"), sql`${schemaChangeProposals.payload}->>'labelKey' = ${key}`))
    .limit(1)
    .for("update");
  if (open[0]) {
    const merged = [...((open[0].examples as unknown[]) ?? []), ...input.examples].slice(0, 5);
    await tx.db.update(schemaChangeProposals).set({ examples: merged, updatedAt: d.platform.clock.date() }).where(and(eq(schemaChangeProposals.novelId, scope.novelId), eq(schemaChangeProposals.id, open[0].id)));
    return { proposalId: open[0].id, created: false };
  }
  const id = d.platform.ids.next("scp");
  await tx.db.insert(schemaChangeProposals).values({
    id,
    novelId: scope.novelId,
    kind: "add_relation_type",
    payload: { label: input.label, labelKey: key },
    examples: input.examples.slice(0, 5),
    similarKeys: input.similarKeys ?? [],
    proposedByActorType: actor.type,
    proposedByActorId: actor.id,
  });
  await d.audit.record(tx, { novelId: scope.novelId, actor, action: "schema.change_proposed", target: { type: "schema_proposal", id }, after: { kind: "add_relation_type", label: input.label } });
  return { proposalId: id, created: true };
}

export async function checkIntegrity(db: Db, scope: NovelScope): Promise<IntegrityProblem[]> {
  const out: IntegrityProblem[] = [];
  // INV-ONT-09: no live reference to merged entities
  const merged = await db.select({ id: entities.id }).from(entities).where(and(eq(entities.novelId, scope.novelId), eq(entities.status, "merged")));
  const mergedIds = merged.map((m) => m.id);
  if (mergedIds.length) {
    const ms = await db.select({ id: mentions.id }).from(mentions).where(and(eq(mentions.novelId, scope.novelId), inArray(mentions.linkedEntityId, mergedIds)));
    const fs = await db
      .select({ id: facts.id })
      .from(facts)
      .where(and(eq(facts.novelId, scope.novelId), sql`(${facts.subjectEntityId} = any(${textArray(mergedIds)}) or ${facts.objectEntityId} = any(${textArray(mergedIds)}))`));
    if (ms.length || fs.length) out.push({ rule: "INV-ONT-09", message: "병합된 엔티티를 가리키는 참조가 남아 있습니다.", refs: [...ms.map((m) => m.id), ...fs.map((f) => f.id)] });
    const chain = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.novelId, scope.novelId), eq(entities.status, "merged"), sql`${entities.mergedIntoId} in (select e2.id from entities e2 where e2.novel_id = ${scope.novelId} and e2.status <> 'active')`));
    if (chain.length) out.push({ rule: "INV-ONT-09", message: "병합 대상이 활성 엔티티가 아닙니다.", refs: chain.map((c) => c.id) });
  }
  // INV-ONT-02: active entity has exactly one active preferred name
  const noPref = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.novelId, scope.novelId),
        eq(entities.status, "active"),
        sql`not exists (select 1 from entity_names n where n.novel_id = ${entities.novelId} and n.entity_id = ${entities.id} and n.is_preferred and n.status = 'active')`,
      ),
    );
  if (noPref.length) out.push({ rule: "INV-ONT-02", message: "활성 대표명이 없는 엔티티가 있습니다.", refs: noPref.map((e) => e.id) });
  // INV-ONT-07: canon facts need an active subject and no unresolved evidence mentions
  const canon = await db.select().from(facts).where(and(eq(facts.novelId, scope.novelId), inArray(facts.canonStatus, CANON)));
  const subjIds = [...new Set(canon.map((f) => f.subjectEntityId).filter((x): x is string => !!x))];
  const subj = subjIds.length ? await db.select({ id: entities.id, s: entities.status }).from(entities).where(and(eq(entities.novelId, scope.novelId), inArray(entities.id, subjIds))) : [];
  const subjStatus = new Map(subj.map((e) => [e.id, e.s]));
  const mids = [...new Set(canon.flatMap((f) => f.mentionIds ?? []))];
  const mrows = mids.length ? await db.select({ id: mentions.id, s: mentions.linkStatus }).from(mentions).where(and(eq(mentions.novelId, scope.novelId), inArray(mentions.id, mids))) : [];
  const mstat = new Map(mrows.map((m) => [m.id, m.s]));
  const bad = canon.filter((f) => !f.subjectEntityId || subjStatus.get(f.subjectEntityId) !== "active" || (f.mentionIds ?? []).some((m) => mstat.get(m) === "ambiguous" || mstat.get(m) === "new_entity_candidate"));
  if (bad.length) out.push({ rule: "INV-ONT-07", message: "확정되지 않은 엔티티·언급에 기댄 캐논 사실이 있습니다.", refs: bad.map((f) => f.id) });
  // INV-ONT-05 (app-level; EXCLUDE may be missing without btree_gist)
  const slots = await db.select().from(factCardinalitySlots).where(eq(factCardinalitySlots.novelId, scope.novelId));
  const bySlot = new Map<string, typeof slots>();
  for (const s of slots) bySlot.set(`${s.timelineId}|${s.slotKey}`, [...(bySlot.get(`${s.timelineId}|${s.slotKey}`) ?? []), s]);
  const overlaps: string[] = [];
  for (const list of bySlot.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) if (rangesOverlap(parseRange(list[i]!.storyRange), parseRange(list[j]!.storyRange))) overlaps.push(list[i]!.factId, list[j]!.factId);
  if (overlaps.length) out.push({ rule: "INV-ONT-05", message: "개수 1 슬롯의 캐논 사실 기간이 겹칩니다.", refs: [...new Set(overlaps)] });
  // names attached to merged entities must be retired or moved
  const strayNames = await db
    .select({ id: entityNames.id })
    .from(entityNames)
    .where(and(eq(entityNames.novelId, scope.novelId), ne(entityNames.status, "retired"), mergedIds.length ? inArray(entityNames.entityId, mergedIds) : sql`false`));
  if (strayNames.length) out.push({ rule: "INV-ONT-09", message: "병합된 엔티티에 남은 이름이 있습니다.", refs: strayNames.map((n) => n.id) });
  return out;
}
