/**
 * Fact writes: candidate facts (F1/F2, 06 §6.6 classification), promotion (06 §6.4, F3/F5/F6, F11 range_close,
 * SL-1..SL-4), bible approval (INV-BIB-03).
 */
import { and, eq, inArray, isNull, or, sql } from "@ncs/db/orm";
import { entities, entityNames, facts, factVersions, identityDecisions, mentions } from "@ncs/db/schema";
import type { CanonStatus } from "@ncs/shared";
import type { ActorRef, NovelScope, Tx } from "../../../../platform/index.js";
import type { CandidateFactDraft, CandidateFactResult, Fact } from "../../index.js";
import { lookupPredicate, type OntologySchemaData } from "../../domain/base-schema.js";
import {
  canonicalOrientation,
  cardinalitySlotKeys,
  classifyFact,
  computeSlotKey,
  factValueKey,
  isLinkHeld,
  parseRange,
  rangeLiteral,
  type ExistingFactForDiff,
  type FactShape,
} from "../../domain/facts.js";
import { validateFacts, type ValidatorFact } from "../../domain/schema-validator.js";
import { assertEntityTransition, assertFactTransition, isCanon, UNRESOLVED_LINK } from "../../domain/transitions.js";
import {
  activeSchema,
  appendFactVersion,
  currentContents,
  deleteSlots,
  factShape,
  lockSlots,
  preferredNames,
  resolveIds,
  rewriteSlots,
  titleMaxHoldersMap,
  writeSlots,
  type FactContent,
  textArray,
  type OntoDeps,
} from "./common.js";

const LIVE: CanonStatus[] = ["candidate", "approved", "published_locked"];

export async function writeCandidateFacts(d: OntoDeps, tx: Tx, scope: NovelScope, drafts: CandidateFactDraft[], actor: ActorRef): Promise<CandidateFactResult> {
  const result: CandidateFactResult = { written: [], rejected: [] };
  if (drafts.length === 0) return result;
  const { version, schema } = await activeSchema(tx.db, scope);
  const ids = drafts.flatMap((x) => [x.subjectEntityId, x.objectEntityId ?? ""]).filter(Boolean);
  const resolved = await resolveIds(tx.db, scope, ids);
  const entRows = resolved.size
    ? await tx.db.select({ id: entities.id, status: entities.status, preferredNameId: entities.preferredNameId }).from(entities).where(and(eq(entities.novelId, scope.novelId), inArray(entities.id, [...new Set(resolved.values())])))
    : [];
  const entById = new Map(entRows.map((e) => [e.id, e]));
  const now = d.platform.clock.date();
  const createdIds: string[] = [];
  const duplicateIds: string[] = [];

  for (let i = 0; i < drafts.length; i++) {
    const dr = drafts[i]!;
    const pdef = lookupPredicate(schema, dr.predicate);
    if (!pdef) {
      result.rejected.push({ index: i, reason: `unknown_predicate:${dr.predicate}` }); // INV-ONT-06 / FR-ONT-18
      continue;
    }
    const mentionIds = dr.mentionIds ?? [];
    if ((dr.sourceKind === "manuscript" || dr.sourceKind === "answer") && mentionIds.length === 0) {
      result.rejected.push({ index: i, reason: "mention_ids_required" }); // FR-ONT-14
      continue;
    }
    if (dr.factKind === "knowledge" && !dr.knowledgeStance) {
      result.rejected.push({ index: i, reason: "knowledge_stance_required" });
      continue;
    }
    const written: Record<string, string> = {};
    const subj = dr.subjectEntityId ? (resolved.get(dr.subjectEntityId) ?? null) : null;
    if (dr.subjectEntityId && !subj) {
      result.rejected.push({ index: i, reason: "subject_not_found" });
      continue;
    }
    if (subj && subj !== dr.subjectEntityId) written.subject = dr.subjectEntityId;
    const obj = dr.objectEntityId ? (resolved.get(dr.objectEntityId) ?? null) : null;
    if (dr.objectEntityId && !obj) {
      result.rejected.push({ index: i, reason: "object_not_found" });
      continue;
    }
    if (obj && obj !== dr.objectEntityId) written.object = dr.objectEntityId!;
    let canonStatus: CanonStatus = dr.canonStatus ?? "candidate";
    const shape0: FactShape = {
      factKind: dr.factKind,
      subjectEntityId: subj,
      predicate: dr.predicate,
      objectEntityId: obj,
      objectFactId: dr.objectFactId ?? null,
      objectNameId: dr.objectNameId ?? null,
      value: dr.value,
      isNegation: dr.isNegation ?? false,
      argMentions: dr.argMentions ?? {},
    };
    const shape = canonicalOrientation(schema, shape0);
    if (isLinkHeld(shape)) {
      // INV-ONT-08: NULL role only for candidate facts with a pending mention in that role
      if (!shape.argMentions?.subject && !shape.subjectEntityId) {
        result.rejected.push({ index: i, reason: "subject_required" });
        continue;
      }
      canonStatus = "candidate";
    }
    if (isCanon(canonStatus)) {
      const s = shape.subjectEntityId ? entById.get(shape.subjectEntityId) : undefined;
      if (!s || s.status !== "active") {
        result.rejected.push({ index: i, reason: "approved_requires_active_subject" }); // INV-ONT-07
        continue;
      }
    }
    const range = { from: dr.storyRange.from, to: dr.storyRange.to };
    if (range.to !== null && range.to <= range.from) {
      result.rejected.push({ index: i, reason: "empty_story_range" });
      continue;
    }
    const slotKey = computeSlotKey(schema, shape);
    // 06 §6.6 classification against live facts of the same timeline touching the slot / cardinality slots
    let diff: { kind: "new" | "duplicate" | "transition" | "conflict"; againstFactId?: string } = { kind: "new" };
    if (!isLinkHeld(shape)) {
      const titleMax = await titleMaxHoldersMap(tx.db, scope, shape.objectEntityId ? [shape.objectEntityId] : []);
      const ents = [shape.subjectEntityId, shape.objectEntityId].filter((x): x is string => !!x);
      const near = await tx.db
        .select()
        .from(facts)
        .where(
          and(
            eq(facts.novelId, scope.novelId),
            eq(facts.timelineId, dr.timelineId),
            eq(facts.predicate, dr.predicate),
            inArray(facts.canonStatus, LIVE),
            or(inArray(facts.subjectEntityId, ents), inArray(facts.objectEntityId, ents)),
          ),
        );
      const existing: ExistingFactForDiff[] = near.map((f) => ({
        id: f.id,
        slotKey: f.slotKey,
        cardSlots: cardinalitySlotKeys(schema, factShape(f), (t) => titleMax.get(t) ?? 1),
        range: parseRange(f.storyRange),
        valueKey: factValueKey(factShape(f)),
        canon: isCanon(f.canonStatus),
      }));
      diff = classifyFact(schema, shape, range, existing, (t) => titleMax.get(t) ?? 1);
    }
    if (diff.kind === "duplicate" && diff.againstFactId) {
      // 06 §6.6 "동일": no new fact, record the evidence mentions on the existing fact
      if (mentionIds.length > 0) {
        await tx.db
          .update(facts)
          .set({ mentionIds: sql`(select array(select distinct unnest(coalesce(${facts.mentionIds}, '{}'::text[]) || ${textArray(mentionIds)})))`, updatedAt: now })
          .where(and(eq(facts.novelId, scope.novelId), eq(facts.id, diff.againstFactId)));
      }
      const v = (await currentContents(tx.db, scope, [diff.againstFactId])).get(diff.againstFactId);
      result.written.push({ factId: diff.againstFactId, factVersionId: v?.versionId ?? "", diffKind: "duplicate" });
      duplicateIds.push(diff.againstFactId);
      continue;
    }
    const id = d.platform.ids.next("fct");
    const [row] = await tx.db
      .insert(facts)
      .values({
        id,
        novelId: scope.novelId,
        factKind: dr.factKind,
        subjectEntityId: shape.subjectEntityId,
        predicate: dr.predicate,
        objectEntityId: shape.objectEntityId ?? null,
        objectFactId: shape.objectFactId ?? null,
        objectNameId: shape.objectNameId ?? null,
        value: shape.value === undefined ? null : shape.value,
        knowledgeStance: dr.knowledgeStance ?? null,
        slotKey,
        isNegation: dr.isNegation ?? false,
        isSecret: dr.isSecret ?? false,
        readerRevealPoint: dr.readerRevealPoint ?? null,
        timelineId: dr.timelineId,
        storyRange: rangeLiteral(range),
        canonStatus,
        currentVersionNo: 1,
        sourceKind: dr.sourceKind,
        sourceRefType: dr.source.refType,
        sourceRefId: dr.source.refId,
        sourceSceneId: dr.sourceSceneId ?? null,
        mentionIds: mentionIds.length > 0 ? mentionIds : null,
        observedAsNameId: dr.observedAsNameId ?? null,
        narrativeFrameId: dr.narrativeFrameId ?? null,
        schemaVersionId: version.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const content: FactContent = {
      factKind: dr.factKind,
      subjectEntityId: shape.subjectEntityId,
      predicate: dr.predicate,
      objectEntityId: shape.objectEntityId ?? null,
      objectFactId: shape.objectFactId ?? null,
      objectNameId: shape.objectNameId ?? null,
      value: shape.value === undefined ? null : shape.value,
      knowledgeStance: dr.knowledgeStance ?? null,
      isNegation: dr.isNegation ?? false,
      isSecret: dr.isSecret ?? false,
      readerRevealPoint: dr.readerRevealPoint ?? null,
      timelineId: dr.timelineId,
      storyRange: range,
      slotKey,
      argMentions: shape.argMentions ?? {},
      episodeId: dr.episodeId ?? null,
      seriesBibleId: dr.seriesBibleId ?? null,
      ...(Object.keys(written).length ? { writtenForEntityIds: written } : {}),
      rangeCloseOf: diff.kind === "transition" ? (diff.againstFactId ?? null) : null,
      conflictWith: diff.kind === "conflict" ? (diff.againstFactId ?? null) : null,
      diffKind: diff.kind,
    };
    const versionId = d.platform.ids.next("fcv");
    await tx.db.insert(factVersions).values({
      id: versionId,
      novelId: scope.novelId,
      factId: id,
      versionNo: 1,
      content,
      canonStatus,
      recordedAt: now,
      recordedByActorType: actor.type,
      recordedByActorId: actor.id,
      runId: dr.runId ?? (actor.type === "agent" ? actor.runId : null),
      changeReason: actor.type === "user" ? "user_edit" : "extracted",
    });
    if (isCanon(canonStatus)) {
      await lockSlots(tx, scope);
      const titleMax = await titleMaxHoldersMap(tx.db, scope, row!.objectEntityId ? [row!.objectEntityId] : []);
      const slot = await writeSlots(tx, scope, schema, row!, titleMax);
      if (!slot.ok) {
        // SL-3: never two overlapping canon facts — keep as candidate
        await tx.db.update(facts).set({ canonStatus: "candidate" }).where(and(eq(facts.novelId, scope.novelId), eq(facts.id, id)));
        await tx.db.update(factVersions).set({ canonStatus: "candidate" }).where(and(eq(factVersions.novelId, scope.novelId), eq(factVersions.id, versionId)));
      }
    }
    createdIds.push(id);
    result.written.push({ factId: id, factVersionId: versionId, diffKind: diff.kind });
  }
  if (createdIds.length > 0) {
    await d.audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "fact.created",
      target: { type: "fact", id: createdIds[0]! },
      details: {
        ids: createdIds,
        count: createdIds.length,
        duplicates: duplicateIds,
        rejected: result.rejected,
        diffKinds: result.written.reduce<Record<string, number>>((a, w) => ((a[w.diffKind] = (a[w.diffKind] ?? 0) + 1), a), {}),
      },
    });
  }
  return result;
}

// ── promotion ────────────────────────────────────────────────────────────
export interface PromotionTarget {
  /** current-version content filter */
  episodeId?: string;
  seriesBibleId?: string;
}

async function factsByTarget(tx: Tx, scope: NovelScope, t: PromotionTarget, statuses: CanonStatus[]): Promise<Fact[]> {
  const cond = t.episodeId
    ? sql`${factVersions.content}->>'episodeId' = ${t.episodeId}`
    : sql`(${factVersions.content}->>'seriesBibleId' = ${t.seriesBibleId!} or (${facts.sourceRefType} = 'series_bible' and ${facts.sourceRefId} = ${t.seriesBibleId!}))`;
  const rows = await tx.db
    .select({ f: facts })
    .from(facts)
    .innerJoin(factVersions, and(eq(factVersions.novelId, facts.novelId), eq(factVersions.factId, facts.id), isNull(factVersions.supersededAt)))
    .where(and(eq(facts.novelId, scope.novelId), inArray(facts.canonStatus, statuses), cond))
    .orderBy(facts.id)
    .for("update", { of: facts });
  return rows.map((r) => r.f);
}

async function validatorFacts(db: Tx["db"], scope: NovelScope, overrides?: Map<string, { from: number; to: number | null }>): Promise<{ list: ValidatorFact[]; types: Map<string, string> }> {
  const rows = await db.select().from(facts).where(and(eq(facts.novelId, scope.novelId), inArray(facts.canonStatus, LIVE)));
  const ents = await db.select({ id: entities.id, t: entities.entityType }).from(entities).where(eq(entities.novelId, scope.novelId));
  return {
    list: rows.map((f) => ({
      factId: f.id,
      factKind: f.factKind,
      predicate: f.predicate,
      subjectEntityId: f.subjectEntityId,
      objectEntityId: f.objectEntityId,
      objectFactId: f.objectFactId,
      objectNameId: f.objectNameId,
      value: f.value,
      timelineId: f.timelineId,
      range: overrides?.get(f.id) ?? parseRange(f.storyRange),
      canonStatus: f.canonStatus,
      isNegation: f.isNegation,
    })),
    types: new Map(ents.map((e) => [e.id, e.t])),
  };
}

export async function schemaFindings(db: Tx["db"], scope: NovelScope, schema: OntologySchemaData, factIds?: string[], overrides?: Map<string, { from: number; to: number | null }>) {
  const { list, types } = await validatorFacts(db, scope, overrides);
  const titleIds = list.filter((f) => f.predicate === "holds_title" && f.objectEntityId).map((f) => f.objectEntityId!);
  const titleMax = await titleMaxHoldersMap(db, scope, titleIds);
  const names = await preferredNames(db, scope, list.flatMap((f) => [f.subjectEntityId ?? "", f.objectEntityId ?? ""]));
  return validateFacts(
    list,
    { schema, entityType: (id) => types.get(id), entityName: (id) => names.get(id) ?? id, titleMaxHolders: (t) => titleMax.get(t) ?? 1 },
    factIds ? new Set(factIds) : undefined,
  );
}

export interface PromotionResult {
  promoted: number;
  held: string[];
  heldReasons: Record<string, string>;
  activatedEntityIds: string[];
  closedFactIds: string[];
}

/**
 * 06 §6.4 order inside the caller's transaction:
 * (1) EN3(b) candidate entity activation (2) range_close (F11) (3) slot pre-check (SL-1/2)
 * (4) promotion (F3) (5) slot rows (SL-4). Unpromotable facts stay candidate and are returned as `held`.
 */
export async function promoteCandidates(d: OntoDeps, tx: Tx, scope: NovelScope, target: PromotionTarget, actor: ActorRef, opts: { approvalId?: string | null } = {}): Promise<PromotionResult> {
  const res: PromotionResult = { promoted: 0, held: [], heldReasons: {}, activatedEntityIds: [], closedFactIds: [] };
  const { schema } = await activeSchema(tx.db, scope);
  await lockSlots(tx, scope); // SL-1
  let candidates = await factsByTarget(tx, scope, target, ["candidate"]);
  if (candidates.length === 0) return res;
  const contents = await currentContents(tx.db, scope, candidates.map((f) => f.id));
  const allMentionIds = [...new Set(candidates.flatMap((f) => f.mentionIds ?? []))];
  const mentionRows = allMentionIds.length
    ? await tx.db.select({ id: mentions.id, linkStatus: mentions.linkStatus, linkedEntityId: mentions.linkedEntityId }).from(mentions).where(and(eq(mentions.novelId, scope.novelId), inArray(mentions.id, allMentionIds)))
    : [];
  const mentionById = new Map(mentionRows.map((m) => [m.id, m]));

  // (1) EN3(b): candidate entities referenced by these facts whose equivalence check passed (or bible path)
  const entIds = [...new Set(candidates.flatMap((f) => [f.subjectEntityId, f.objectEntityId]).filter((x): x is string => !!x))];
  const entRows = entIds.length ? await tx.db.select().from(entities).where(and(eq(entities.novelId, scope.novelId), inArray(entities.id, entIds))).for("update") : [];
  const proposedDecisions = entIds.length
    ? await tx.db
        .select({ ids: identityDecisions.sourceEntityIds, survivor: identityDecisions.survivorEntityId })
        .from(identityDecisions)
        .where(and(eq(identityDecisions.novelId, scope.novelId), eq(identityDecisions.status, "proposed")))
    : [];
  const blockedByDecision = new Set(proposedDecisions.flatMap((r) => [...r.ids, r.survivor ?? ""]));
  const entityStatus = new Map(entRows.map((e) => [e.id, e.status]));
  for (const e of entRows) {
    if (e.status !== "candidate") continue;
    const check = (e.equivalenceCheck ?? null) as { status?: string } | null;
    const okCheck = target.seriesBibleId ? check?.status !== "failed" && check?.status !== "question" : !check || check.status === "passed";
    if (!okCheck || blockedByDecision.has(e.id) || !e.preferredNameId) continue;
    // the entity's own mentions must not be ambiguous (new_entity_candidate is what we resolve here)
    const amb = await tx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(mentions)
      .where(and(eq(mentions.novelId, scope.novelId), eq(mentions.linkedEntityId, e.id), eq(mentions.linkStatus, "ambiguous")));
    if ((amb[0]?.n ?? 0) > 0) continue;
    assertEntityTransition("candidate", "active");
    await tx.db.update(entities).set({ status: "active", updatedAt: d.platform.clock.date() }).where(and(eq(entities.novelId, scope.novelId), eq(entities.id, e.id)));
    await tx.db
      .update(entityNames)
      .set({ status: "active" })
      .where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.entityId, e.id), eq(entityNames.status, "proposed"), inArray(entityNames.nameKind, ["true_name", "alias", "title", "disguise"])));
    // MN7: new_entity_candidate → auto_linked
    await tx.db
      .update(mentions)
      .set({ linkStatus: "auto_linked", updatedAt: d.platform.clock.date() })
      .where(and(eq(mentions.novelId, scope.novelId), eq(mentions.linkedEntityId, e.id), eq(mentions.linkStatus, "new_entity_candidate")));
    entityStatus.set(e.id, "active");
    res.activatedEntityIds.push(e.id);
  }
  if (res.activatedEntityIds.length > 0) {
    const refreshed = await tx.db.select({ id: mentions.id, linkStatus: mentions.linkStatus, linkedEntityId: mentions.linkedEntityId }).from(mentions).where(and(eq(mentions.novelId, scope.novelId), inArray(mentions.id, allMentionIds.length ? allMentionIds : ["-"])));
    for (const m of refreshed) mentionById.set(m.id, m);
    await d.audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "entity.status_changed",
      target: { type: "entity", id: res.activatedEntityIds[0]! },
      before: { status: "candidate" },
      after: { status: "active" },
      details: { ids: res.activatedEntityIds, count: res.activatedEntityIds.length, rule: "EN3" },
    });
  }

  // gate per fact (F3 guard + schema validator)
  // planned F11 closes are applied virtually so a succession is not seen as two holders / a posthumous reign
  const planned = new Map<string, { from: number; to: number | null }>();
  /** F11/F8: closing a published fact at or before its last published mention needs a retcon approval */
  const retconRequired = new Set<string>();
  for (const f of candidates) {
    const c = contents.get(f.id)?.content;
    if (!c?.rangeCloseOf) continue;
    const [old] = await tx.db.select().from(facts).where(and(eq(facts.novelId, scope.novelId), eq(facts.id, c.rangeCloseOf)));
    if (!old || !isCanon(old.canonStatus)) continue;
    const r = parseRange(old.storyRange);
    const newFrom = parseRange(f.storyRange).from;
    if (r.to !== null || newFrom <= r.from) continue;
    if (old.canonStatus === "published_locked" && newFrom <= (await publishedMentionMax(tx, scope, old))) {
      retconRequired.add(f.id);
      continue;
    }
    planned.set(old.id, { from: r.from, to: newFrom });
  }
  const candIds = new Set(candidates.map((f) => f.id));
  const findings = await schemaFindings(tx.db, scope, schema, [...candIds], planned);
  const violated = new Set(findings.filter((v) => v.severity !== "low").flatMap((v) => [v.factId, ...v.relatedFactIds]).filter((id) => candIds.has(id)));
  const hold = (f: Fact, reason: string) => {
    res.held.push(f.id);
    res.heldReasons[f.id] = reason;
  };
  const promotable: Fact[] = [];
  for (const f of candidates) {
    const c = contents.get(f.id)?.content;
    if (!f.subjectEntityId) hold(f, "link_pending");
    else if (entityStatus.get(f.subjectEntityId) !== "active" || (f.objectEntityId && entityStatus.get(f.objectEntityId) !== "active")) hold(f, "entity_not_active");
    else if ((f.mentionIds ?? []).some((m) => UNRESOLVED_LINK.includes(mentionById.get(m)?.linkStatus ?? "ambiguous") || mentionById.get(m)?.linkStatus === "rejected")) hold(f, "mention_unresolved");
    else if (c?.conflictWith) hold(f, "conflict");
    else if (retconRequired.has(f.id)) hold(f, "retcon_required");
    else if (violated.has(f.id)) hold(f, "schema_violation");
    else if (f.narrativeFrameId && !c?.storyRange) hold(f, "frame_target_missing");
    else promotable.push(f);
  }

  // (2) range_close (F11) before slot writes
  for (const f of promotable) {
    const c = contents.get(f.id)?.content;
    if (!c?.rangeCloseOf) continue;
    const [old] = await tx.db.select().from(facts).where(and(eq(facts.novelId, scope.novelId), eq(facts.id, c.rangeCloseOf))).for("update");
    if (!old || !isCanon(old.canonStatus)) continue;
    const oldRange = parseRange(old.storyRange);
    const newFrom = parseRange(f.storyRange).from;
    if (oldRange.to !== null || newFrom <= oldRange.from) continue;
    if (old.canonStatus === "published_locked" && newFrom <= (await publishedMentionMax(tx, scope, old))) {
      hold(f, "retcon_required"); // defensive: re-checked under the row lock
      continue;
    }
    const { fact: closed } = await appendFactVersion(d, tx, scope, old, { storyRange: rangeLiteral({ from: oldRange.from, to: newFrom }) }, { changeReason: "range_close", actor, approvalId: opts.approvalId });
    const titleMax = await titleMaxHoldersMap(tx.db, scope, closed.objectEntityId ? [closed.objectEntityId] : []);
    await rewriteSlots(tx, scope, schema, closed, titleMax);
    res.closedFactIds.push(old.id);
  }

  // (3)–(5) slot pre-check, promotion, slot rows
  const promotedIds: string[] = [];
  for (const f of promotable) {
    const titleMax = await titleMaxHoldersMap(tx.db, scope, f.objectEntityId ? [f.objectEntityId] : []);
    const slot = await writeSlots(tx, scope, schema, f, titleMax);
    if (!slot.ok) {
      hold(f, `slot_conflict:${slot.slotKey}`);
      continue;
    }
    assertFactTransition("candidate", "approved");
    await appendFactVersion(d, tx, scope, f, { canonStatus: "approved" }, { changeReason: "canon_change", actor, approvalId: opts.approvalId });
    promotedIds.push(f.id);
  }
  res.promoted = promotedIds.length;
  if (promotedIds.length > 0 || res.held.length > 0) {
    await d.audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "fact.status_changed",
      target: target.episodeId ? { type: "episode", id: target.episodeId } : { type: "series_bible", id: target.seriesBibleId! },
      approvalId: opts.approvalId ?? null,
      before: { canonStatus: "candidate" },
      after: { canonStatus: "approved" },
      details: { ids: promotedIds, count: promotedIds.length, held: res.heldReasons, closedFactIds: res.closedFactIds, rule: "F3" },
    });
  }
  candidates = [];
  return res;
}

/**
 * Largest story_point among the mentions that ground a published fact (F11 condition: a range_close
 * bound `b` must be greater than this). A fact becomes published_locked together with its source
 * episode (F5), so its mentions are the published evidence; with no mentions the range start counts.
 */
async function publishedMentionMax(tx: Tx, scope: NovelScope, fact: Fact): Promise<number> {
  const ids = fact.mentionIds ?? [];
  const from = parseRange(fact.storyRange).from;
  if (ids.length === 0) return from;
  const [row] = await tx.db
    .select({ max: sql<number | null>`max(${mentions.storyPoint})::int` })
    .from(mentions)
    .where(and(eq(mentions.novelId, scope.novelId), inArray(mentions.id, ids)));
  return Math.max(from, row?.max ?? from);
}

/** F5 (approved → published_locked) / F6 (reverse) for every fact of the episode */
export async function relockEpisodeFacts(d: OntoDeps, tx: Tx, scope: NovelScope, episodeId: string, from: CanonStatus, to: CanonStatus, actor: ActorRef): Promise<number> {
  const rows = await factsByTarget(tx, scope, { episodeId }, [from]);
  const rule = assertFactTransition(from, to);
  for (const f of rows) await appendFactVersion(d, tx, scope, f, { canonStatus: to }, { changeReason: "canon_change", actor });
  if (rows.length > 0) {
    await d.audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "fact.status_changed",
      target: { type: "episode", id: episodeId },
      before: { canonStatus: from },
      after: { canonStatus: to },
      details: { ids: rows.map((r) => r.id), count: rows.length, rule: rule.id },
    });
  }
  return rows.length;
}

/** bible approval: activate bible-sourced candidate entities (series_bible mentions) then promote (INV-BIB-03) */
export async function approveBible(d: OntoDeps, tx: Tx, scope: NovelScope, seriesBibleId: string, actor: ActorRef): Promise<{ approved: number; activatedEntityIds: string[]; held: string[] }> {
  // entities that only exist through this bible's B2 run (mentions source series_bible) pass EN3(a)
  const ents = await tx.db
    .selectDistinct({ id: mentions.linkedEntityId })
    .from(mentions)
    .where(and(eq(mentions.novelId, scope.novelId), eq(mentions.sourceKind, "series_bible"), eq(mentions.linkStatus, "new_entity_candidate")));
  const activated: string[] = [];
  for (const { id } of ents) {
    if (!id) continue;
    const [e] = await tx.db.select().from(entities).where(and(eq(entities.novelId, scope.novelId), eq(entities.id, id))).for("update");
    if (!e || e.status !== "candidate") continue;
    const check = (e.equivalenceCheck ?? null) as { status?: string; seriesBibleId?: string } | null;
    if (check?.status === "failed" || check?.status === "question") continue;
    if (check?.seriesBibleId && check.seriesBibleId !== seriesBibleId) continue;
    await tx.db.update(entities).set({ status: "active", updatedAt: d.platform.clock.date() }).where(and(eq(entities.novelId, scope.novelId), eq(entities.id, id)));
    await tx.db
      .update(entityNames)
      .set({ status: "active" })
      .where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.entityId, id), eq(entityNames.status, "proposed"), inArray(entityNames.nameKind, ["true_name", "alias", "title", "disguise"])));
    await tx.db
      .update(mentions)
      .set({ linkStatus: "auto_linked", updatedAt: d.platform.clock.date() })
      .where(and(eq(mentions.novelId, scope.novelId), eq(mentions.linkedEntityId, id), eq(mentions.linkStatus, "new_entity_candidate"), eq(mentions.sourceKind, "series_bible")));
    activated.push(id);
  }
  if (activated.length > 0) {
    await d.audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "entity.status_changed",
      target: { type: "series_bible", id: seriesBibleId },
      before: { status: "candidate" },
      after: { status: "active" },
      details: { ids: activated, count: activated.length, rule: "EN3(a)" },
    });
  }
  const r = await promoteCandidates(d, tx, scope, { seriesBibleId }, actor);
  return { approved: r.promoted, activatedEntityIds: [...activated, ...r.activatedEntityIds], held: r.held };
}

/**
 * User-sourced fact withdrawal (e.g. a cast field changed and confirmed again): approved / published_locked → retracted
 * (F9 — the user's confirm is the approval), candidate → rejected (F4). Slots are released so the replacement fact can
 * take them. Facts in other states are skipped. Returns the ids changed.
 */
export async function withdrawFacts(d: OntoDeps, tx: Tx, scope: NovelScope, factIds: string[], actor: ActorRef, reason: string): Promise<string[]> {
  const ids = [...new Set(factIds)];
  if (!ids.length) return [];
  const rows = await tx.db.select().from(facts).where(and(eq(facts.novelId, scope.novelId), inArray(facts.id, ids))).for("update");
  const changed: string[] = [];
  await lockSlots(tx, scope);
  for (const f of rows) {
    const to: CanonStatus | null = isCanon(f.canonStatus) ? "retracted" : f.canonStatus === "candidate" ? "rejected" : null;
    if (!to) continue;
    const rule = assertFactTransition(f.canonStatus, to);
    await deleteSlots(tx, scope, f.id);
    await appendFactVersion(d, tx, scope, f, { canonStatus: to }, { changeReason: "user_edit", actor });
    await d.audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "fact.status_changed",
      target: { type: "fact", id: f.id },
      before: { canonStatus: f.canonStatus },
      after: { canonStatus: to },
      reason,
      details: { rule: rule.id },
    });
    changed.push(f.id);
  }
  return changed;
}
