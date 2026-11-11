/**
 * 설계 추가(화 삭제): the ontology side of deleting an episode's generated manuscript. Everything the text produced is
 * taken back — facts are closed through their state machine (candidate → rejected, approved → retracted; history kept),
 * evidence mentions / narrative frames / unused extracted names are removed, and candidate entities that only existed
 * through this text are retired (EN5). Active entities, facts of other episodes (minus the removed evidence) and
 * fact_versions stay. Runs in the caller's transaction; the caller deletes the scenes / versions afterwards.
 */
import { and, eq, inArray, isNull, ne, or, sql } from "@ncs/db/orm";
import { entities, entityNames, facts, factVersions, mentions, narrativeFrames } from "@ncs/db/schema";
import type { CanonStatus } from "@ncs/shared";
import type { ActorRef, Db, NovelScope, Tx } from "../../../../platform/index.js";
import type { Fact, ManuscriptPurgeInput, ManuscriptPurgePreview, ManuscriptPurgeResult, Mention } from "../../index.js";
import { referenceCount, setEntityStatus } from "./entities.js";
import { retireFacts } from "./fact-writes.js";
import { textArray, type OntoDeps } from "./common.js";

const LIVE: CanonStatus[] = ["candidate", "approved", "published_locked"];

/** live facts the episode produced: current version extracted from it, or sourced from one of its manuscript versions */
export async function episodeFactRows(db: Db, scope: NovelScope, input: Pick<ManuscriptPurgeInput, "episodeId" | "versionIds">): Promise<Fact[]> {
  const byContent = await db
    .select({ f: facts })
    .from(facts)
    .innerJoin(factVersions, and(eq(factVersions.novelId, facts.novelId), eq(factVersions.factId, facts.id), isNull(factVersions.supersededAt)))
    .where(and(eq(facts.novelId, scope.novelId), inArray(facts.canonStatus, LIVE), sql`${factVersions.content}->>'episodeId' = ${input.episodeId}`));
  const rows = new Map(byContent.map((r) => [r.f.id, r.f]));
  if (input.versionIds.length) {
    const bySource = await db
      .select()
      .from(facts)
      .where(and(eq(facts.novelId, scope.novelId), inArray(facts.canonStatus, LIVE), eq(facts.sourceRefType, "manuscript_version"), inArray(facts.sourceRefId, input.versionIds)));
    for (const f of bySource) rows.set(f.id, f);
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** mentions found in the episode's text (any of its versions / scenes) */
async function episodeMentionRows(db: Db, scope: NovelScope, input: Pick<ManuscriptPurgeInput, "versionIds"> & { sceneIds?: string[] }): Promise<Mention[]> {
  const conds = [];
  if (input.versionIds.length) conds.push(inArray(mentions.manuscriptVersionId, input.versionIds));
  if (input.sceneIds?.length) conds.push(inArray(mentions.sceneId, input.sceneIds));
  if (!conds.length) return [];
  return db.select().from(mentions).where(and(eq(mentions.novelId, scope.novelId), or(...conds)));
}

/** candidate entities created from these mentions whose only evidence is these mentions / these facts (rule 3c) */
async function retirableCandidates(db: Db, scope: NovelScope, mentionIds: string[], episodeFactIds: Set<string>): Promise<string[]> {
  if (!mentionIds.length) return [];
  const created = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.novelId, scope.novelId), eq(entities.status, "candidate"), inArray(entities.createdFromMentionId, mentionIds)));
  if (!created.length) return [];
  const ids = created.map((e) => e.id);
  const gone = new Set(mentionIds);
  const otherMentions = await db
    .select({ id: mentions.id, linked: mentions.linkedEntityId, speaker: mentions.speakerEntityId, pov: mentions.povEntityId, via: mentions.viaEntityId })
    .from(mentions)
    .where(
      and(
        eq(mentions.novelId, scope.novelId),
        ne(mentions.linkStatus, "rejected"),
        or(inArray(mentions.linkedEntityId, ids), inArray(mentions.speakerEntityId, ids), inArray(mentions.povEntityId, ids), inArray(mentions.viaEntityId, ids)),
      ),
    );
  const otherFacts = await db
    .select({ id: facts.id, subject: facts.subjectEntityId, object: facts.objectEntityId })
    .from(facts)
    .where(and(eq(facts.novelId, scope.novelId), inArray(facts.canonStatus, LIVE), or(inArray(facts.subjectEntityId, ids), inArray(facts.objectEntityId, ids))));
  const keep = new Set<string>();
  for (const m of otherMentions) {
    if (gone.has(m.id)) continue;
    for (const e of [m.linked, m.speaker, m.pov, m.via]) if (e) keep.add(e);
  }
  for (const f of otherFacts) {
    if (episodeFactIds.has(f.id)) continue;
    for (const e of [f.subject, f.object]) if (e) keep.add(e);
  }
  return ids.filter((id) => !keep.has(id));
}

export async function previewManuscriptPurge(db: Db, scope: NovelScope, input: Pick<ManuscriptPurgeInput, "episodeId" | "versionIds">): Promise<ManuscriptPurgePreview> {
  const rows = await episodeFactRows(db, scope, input);
  const ms = await episodeMentionRows(db, scope, input);
  const mentionIds = ms.map((m) => m.id);
  // facts of other episodes whose only evidence is this text are retired too (facts_ck_4)
  const factIds = new Set(rows.map((r) => r.id));
  if (mentionIds.length) {
    const others = await db
      .select({ id: facts.id, mentionIds: facts.mentionIds, sourceKind: facts.sourceKind })
      .from(facts)
      .where(and(eq(facts.novelId, scope.novelId), inArray(facts.canonStatus, LIVE), sql`${facts.mentionIds} && ${textArray(mentionIds)}`));
    const gone = new Set(mentionIds);
    for (const f of others) {
      if (factIds.has(f.id)) continue;
      if ((f.sourceKind === "manuscript" || f.sourceKind === "answer") && (f.mentionIds ?? []).every((m) => gone.has(m))) factIds.add(f.id);
    }
  }
  const count = (s: CanonStatus) => rows.filter((r) => r.canonStatus === s).length;
  return {
    facts: { candidate: count("candidate"), approved: count("approved"), publishedLocked: count("published_locked") },
    mentionCount: mentionIds.length,
    entityRetireCount: (await retirableCandidates(db, scope, mentionIds, factIds)).length,
  };
}

export async function purgeManuscriptVersions(d: OntoDeps, tx: Tx, scope: NovelScope, input: ManuscriptPurgeInput, actor: ActorRef, opts: { reason: string }): Promise<ManuscriptPurgeResult> {
  const now = () => d.platform.clock.date();
  const nid = scope.novelId;
  const details = { episodeId: input.episodeId, manuscriptVersionIds: input.versionIds, decidedBy: "episode_deleted" };
  const result: ManuscriptPurgeResult = { factsRejected: 0, factsRetracted: 0, otherFactsPruned: 0, otherFactsRetired: 0, mentions: 0, entitiesRetired: 0, namesDeleted: 0, frames: 0, questionIds: [] };

  // (a) facts the episode produced → rejected / retracted (slots released by retireFacts)
  const own = await episodeFactRows(tx.db, scope, input);
  const ownIds = new Set(own.map((f) => f.id));
  const changed = new Set(await retireFacts(d, tx, scope, own.map((f) => ({ factId: f.id })), actor, { changeReason: "episode_deleted", reason: opts.reason, details }));
  for (const f of own) {
    if (!changed.has(f.id)) continue;
    if (f.canonStatus === "candidate") result.factsRejected++;
    else result.factsRetracted++;
  }

  // (b) evidence of other facts that pointed into this text
  const ms = await episodeMentionRows(tx.db, scope, input);
  const mentionIds = ms.map((m) => m.id);
  const gone = new Set(mentionIds);
  result.questionIds = [...new Set(ms.map((m) => m.questionId).filter((q): q is string => !!q))];
  if (mentionIds.length) {
    const others = await tx.db
      .select()
      .from(facts)
      .where(and(eq(facts.novelId, nid), inArray(facts.canonStatus, LIVE), sql`${facts.mentionIds} && ${textArray(mentionIds)}`))
      .for("update");
    const orphaned: string[] = [];
    for (const f of others) {
      if (ownIds.has(f.id)) continue;
      const kept = (f.mentionIds ?? []).filter((m) => !gone.has(m));
      if (kept.length === 0 && (f.sourceKind === "manuscript" || f.sourceKind === "answer")) {
        orphaned.push(f.id); // its only evidence was this episode (facts_ck_4 would reject an empty list)
        continue;
      }
      await tx.db.update(facts).set({ mentionIds: kept, updatedAt: now() }).where(and(eq(facts.novelId, nid), eq(facts.id, f.id)));
      result.otherFactsPruned++;
    }
    if (orphaned.length) {
      const retired = await retireFacts(d, tx, scope, orphaned.map((factId) => ({ factId, details: { evidenceOnlyInEpisode: true } })), actor, { changeReason: "episode_deleted", reason: opts.reason, details });
      result.otherFactsRetired = retired.length;
      for (const id of retired) ownIds.add(id);
    }
  }

  // scenes of this text: facts (any status) may anchor on them — the scenes are deleted by the caller
  if (input.sceneIds.length) {
    await tx.db.update(facts).set({ fromSceneId: null, updatedAt: now() }).where(and(eq(facts.novelId, nid), inArray(facts.fromSceneId, input.sceneIds)));
    await tx.db.update(facts).set({ toSceneId: null, updatedAt: now() }).where(and(eq(facts.novelId, nid), inArray(facts.toSceneId, input.sceneIds)));
    await tx.db.update(facts).set({ sourceSceneId: null, updatedAt: now() }).where(and(eq(facts.novelId, nid), inArray(facts.sourceSceneId, input.sceneIds)));
  }

  // (e) narrative frames of this text (facts / mentions elsewhere may point at them)
  const frameConds = [];
  if (input.versionIds.length) frameConds.push(inArray(narrativeFrames.manuscriptVersionId, input.versionIds));
  if (input.sceneIds.length) frameConds.push(inArray(narrativeFrames.sceneId, input.sceneIds));
  const frames = frameConds.length ? await tx.db.select({ id: narrativeFrames.id }).from(narrativeFrames).where(and(eq(narrativeFrames.novelId, nid), or(...frameConds))) : [];
  const frameIds = frames.map((f) => f.id);
  if (frameIds.length) {
    await tx.db.update(facts).set({ narrativeFrameId: null, updatedAt: now() }).where(and(eq(facts.novelId, nid), inArray(facts.narrativeFrameId, frameIds)));
    await tx.db.update(mentions).set({ narrativeFrameId: null, updatedAt: now() }).where(and(eq(mentions.novelId, nid), inArray(mentions.narrativeFrameId, frameIds)));
  }

  // (c) candidates that only existed through these mentions — decided before the mentions disappear
  const retirable = await retirableCandidates(tx.db, scope, mentionIds, ownIds);

  // (b) the mentions themselves (entities.created_from_mention_id is provenance, kept as NULL)
  if (mentionIds.length) {
    await tx.db.update(entities).set({ createdFromMentionId: null, updatedAt: now() }).where(and(eq(entities.novelId, nid), inArray(entities.createdFromMentionId, mentionIds)));
    await tx.db.delete(mentions).where(and(eq(mentions.novelId, nid), inArray(mentions.id, mentionIds)));
    result.mentions = mentionIds.length;
  }
  if (frameIds.length) {
    await tx.db.delete(narrativeFrames).where(and(eq(narrativeFrames.novelId, nid), inArray(narrativeFrames.id, frameIds)));
    result.frames = frameIds.length;
  }

  // (d) names this text introduced that nothing else uses (preferred names and referenced names stay)
  if (input.versionIds.length) {
    const names = await tx.db
      .select({ id: entityNames.id })
      .from(entityNames)
      .where(and(eq(entityNames.novelId, nid), eq(entityNames.sourceRefType, "manuscript_version"), inArray(entityNames.sourceRefId, input.versionIds), eq(entityNames.isPreferred, false)));
    const nameIds = names.map((n) => n.id);
    if (nameIds.length) {
      const used = new Set<string>();
      for (const r of await tx.db.select({ id: entities.preferredNameId }).from(entities).where(and(eq(entities.novelId, nid), inArray(entities.preferredNameId, nameIds)))) if (r.id) used.add(r.id);
      for (const r of await tx.db.select({ id: mentions.viaNameId }).from(mentions).where(and(eq(mentions.novelId, nid), inArray(mentions.viaNameId, nameIds)))) if (r.id) used.add(r.id);
      for (const r of await tx.db.select({ a: facts.objectNameId, b: facts.observedAsNameId }).from(facts).where(and(eq(facts.novelId, nid), or(inArray(facts.objectNameId, nameIds), inArray(facts.observedAsNameId, nameIds))))) {
        if (r.a) used.add(r.a);
        if (r.b) used.add(r.b);
      }
      for (const r of await tx.db.select({ id: entityNames.mergedConflictWithId }).from(entityNames).where(and(eq(entityNames.novelId, nid), inArray(entityNames.mergedConflictWithId, nameIds)))) if (r.id) used.add(r.id);
      const drop = nameIds.filter((id) => !used.has(id));
      if (drop.length) {
        await tx.db.delete(entityNames).where(and(eq(entityNames.novelId, nid), inArray(entityNames.id, drop)));
        result.namesDeleted = drop.length;
      }
    }
  }

  // (c) EN5: candidate → retired once nothing references it any more (re-checked on the live rows)
  for (const id of retirable) {
    if ((await referenceCount(tx.db, scope, id)) > 0) continue;
    await setEntityStatus(d, tx, scope, id, "retired", actor, opts.reason);
    result.entitiesRetired++;
  }
  return result;
}
