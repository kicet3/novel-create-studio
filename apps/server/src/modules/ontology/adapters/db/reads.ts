/** Read side of PgOntologyRepository (06 §3.3 name functions, §6.4 canon queries, §7 knowledge, §11.5 Q1–Q9). */
import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from "@ncs/db/orm";
import { entities, entityDistinctPairs, entityNames, facts, factVersions, identityDecisions, mentions, timelines } from "@ncs/db/schema";
import type { CanonStatus, EntityType, LinkStatus } from "@ncs/shared";
import { defaultValue } from "@ncs/shared";
import { NotFoundError, type Db, type NovelScope } from "../../../../platform/index.js";
import type {
  EntityCard,
  EntityDetail,
  EntityListFilter,
  EntityListItem,
  EntityName,
  Fact,
  FactAtAnchor,
  Mention,
  NameCandidate,
  StoryAnchor,
  Timeline,
  Viewer,
} from "../../index.js";
import { editDistance, isCrossScript, jamoKey, normalizedKey, syllableCount, translitKey, valueHash } from "../../domain/normalize.js";
import { parseRange, rangeContains, renderFactText } from "../../domain/facts.js";
import { CANON, activeSchema, currentContents, preferredNames, project, resolveId, type FactContent } from "./common.js";
import { UNRESOLVED_LINK } from "../../domain/transitions.js";

const isViewerEntity = (v: Viewer) => v !== "narrator" && v !== "reader";

export async function getDefaultTimeline(db: Db, scope: NovelScope): Promise<Timeline> {
  const [t] = await db.select().from(timelines).where(and(eq(timelines.novelId, scope.novelId), eq(timelines.isDefault, true))).limit(1);
  if (!t) throw new NotFoundError("기본 시간선");
  return t;
}

export async function listTimelines(db: Db, scope: NovelScope): Promise<Timeline[]> {
  return db.select().from(timelines).where(eq(timelines.novelId, scope.novelId)).orderBy(asc(timelines.createdAt));
}

// ── names (L2 candidate generation, 06 §3.8) ─────────────────────────────
export async function findNameCandidates(db: Db, scope: NovelScope, surface: string, p: number, timelineId: string, opts: { relaxed?: boolean } = {}): Promise<NameCandidate[]> {
  const key = normalizedKey(surface);
  if (!key) return [];
  const cap = defaultValue("linking.hidden_variant_rule_score_cap");
  const live = and(eq(entityNames.novelId, scope.novelId), ne(entityNames.status, "retired"), inArray(entities.status, ["candidate", "active"]));
  const base = db
    .select({ n: entityNames, entityStatus: entities.status })
    .from(entityNames)
    .innerJoin(entities, and(eq(entities.novelId, entityNames.novelId), eq(entities.id, entityNames.entityId)));
  const exact = await base.where(and(live, eq(entityNames.normalizedKey, key)));
  const valid = (n: EntityName) => n.status === "active" && (n.timelineId === null || n.timelineId === timelineId) && rangeContains(parseRange(n.storyRange), p);
  const out: NameCandidate[] = [];
  const push = (n: EntityName, matchKind: NameCandidate["matchKind"], score: number) => {
    const s = n.nameKind === "hidden_variant" ? Math.min(score, cap) : score;
    const prev = out.find((c) => c.entityId === n.entityId);
    if (prev && prev.score >= s) return;
    if (prev) out.splice(out.indexOf(prev), 1);
    out.push({ entityId: n.entityId, nameId: n.id, surface: n.surface, nameKind: n.nameKind, matchKind, score: s });
  };
  // 1st pass: exact key within validity (Q2)
  for (const { n } of exact) if (valid(n)) push(n, n.surface === surface ? "exact" : "normalized", 1);
  if (out.length > 0 && !opts.relaxed) return out.sort((a, b) => b.score - a.score);
  // 2nd pass: out-of-range names, translit, jamo distance ≤ 1 (4+ syllables only), proposed names
  for (const { n } of exact) if (!valid(n)) push(n, "normalized", 0.6);
  const tkey = translitKey(surface);
  const tl = await base.where(and(live, eq(entityNames.translitKey, tkey)));
  for (const { n } of tl) if (n.normalizedKey !== key && isCrossScript(n.surface, surface)) push(n, "translit", 0.8);
  const syl = syllableCount(surface);
  const jkey = jamoKey(surface);
  if (syl >= 4) {
    const len = [...jkey].length;
    const near = await base.where(and(live, sql`char_length(${entityNames.jamoKey}) between ${len - 1} and ${len + 1}`));
    for (const { n } of near) {
      if (n.normalizedKey === key) continue;
      if (editDistance(n.jamoKey, jkey) <= 1) push(n, "jamo", syllableCount(n.surface) <= defaultValue("dedup.short_name_max_syllables") ? 0.4 : 0.7);
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export async function getNamesByIds(db: Db, scope: NovelScope, ids: string[]): Promise<EntityName[]> {
  if (ids.length === 0) return [];
  return db.select().from(entityNames).where(and(eq(entityNames.novelId, scope.novelId), inArray(entityNames.id, ids)));
}

export async function listEntityNames(db: Db, scope: NovelScope, entityId: string): Promise<EntityName[]> {
  const id = await resolveId(db, scope, entityId);
  return db.select().from(entityNames).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.entityId, id))).orderBy(desc(entityNames.isPreferred), asc(entityNames.createdAt));
}

// ── title holders (Q6, 06 §3.5) ──────────────────────────────────────────
export async function getTitleHolders(db: Db, scope: NovelScope, titleEntityId: string, timelineId: string, p?: number) {
  const id = await resolveId(db, scope, titleEntityId);
  const rows = await db
    .select()
    .from(facts)
    .where(and(eq(facts.novelId, scope.novelId), eq(facts.predicate, "holds_title"), eq(facts.objectEntityId, id), eq(facts.timelineId, timelineId), inArray(facts.canonStatus, CANON), eq(facts.isNegation, false)))
    .orderBy(asc(sql`lower(${facts.storyRange})`));
  return rows
    .filter((f) => f.subjectEntityId && (p === undefined || rangeContains(parseRange(f.storyRange), p)))
    .map((f) => ({ entityId: f.subjectEntityId!, storyRange: parseRange(f.storyRange) }));
}

// ── canon at anchor (Q1, 06 §6.4) ────────────────────────────────────────
async function safeCandidateFilter(db: Db, scope: NovelScope, rows: Fact[]): Promise<Fact[]> {
  const mids = [...new Set(rows.flatMap((r) => r.mentionIds ?? []))];
  const ms = mids.length ? await db.select({ id: mentions.id, s: mentions.linkStatus }).from(mentions).where(and(eq(mentions.novelId, scope.novelId), inArray(mentions.id, mids))) : [];
  const st = new Map(ms.map((m) => [m.id, m.s]));
  const linked = rows.filter((r) => r.subjectEntityId && !(r.mentionIds ?? []).some((m) => UNRESOLVED_LINK.includes(st.get(m) ?? "ambiguous")));
  if (!linked.length) return linked;
  // a candidate in conflict with canon or held for a canon-change decision is not "safe" (설계 추가: 미확정 사실 선행 집필)
  const contents = await currentContents(db, scope, linked.map((r) => r.id));
  return linked.filter((r) => {
    const c = contents.get(r.id)?.content;
    return !c?.conflictWith && c?.reconcilePending !== true;
  });
}

function dedupe(rows: Fact[]): Fact[] {
  // 06 §4.6: identical slot + value → only one
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.slotKey}|${r.objectEntityId ?? ""}|${valueHash(r.value ?? null)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function canonRowsAt(db: Db, scope: NovelScope, entityIds: string[] | null, p: number, timelineId: string, include: "canon" | "canon_and_safe_candidates" = "canon"): Promise<Fact[]> {
  const ids = entityIds ? [...new Set(entityIds)] : null;
  if (ids && ids.length === 0) return [];
  const statuses: CanonStatus[] = include === "canon" ? CANON : [...CANON, "candidate"];
  const rows = await db
    .select()
    .from(facts)
    .where(
      and(
        eq(facts.novelId, scope.novelId),
        eq(facts.timelineId, timelineId),
        inArray(facts.canonStatus, statuses),
        eq(facts.isNegation, false),
        sql`${facts.storyRange} @> ${p}::int4`,
        ids ? or(inArray(facts.subjectEntityId, ids), inArray(facts.objectEntityId, ids)) : undefined,
      ),
    )
    .orderBy(asc(facts.id));
  const canon = rows.filter((r) => CANON.includes(r.canonStatus));
  const cands = include === "canon" ? [] : await safeCandidateFilter(db, scope, rows.filter((r) => r.canonStatus === "candidate"));
  return dedupe([...canon, ...cands]);
}

export async function getCanonAt(db: Db, scope: NovelScope, entityIds: string[], p: number, timelineId: string, include: "canon" | "canon_and_safe_candidates" = "canon"): Promise<FactAtAnchor[]> {
  const { schema } = await activeSchema(db, scope);
  const resolved = await Promise.all(entityIds.map((id) => resolveId(db, scope, id).catch(() => id)));
  return project(db, scope, await canonRowsAt(db, scope, resolved, p, timelineId, include), schema);
}

/** 06 §6.2 recorded-time query: canon as the system knew it at `recordedAt` */
export async function getCanonAsRecorded(db: Db, scope: NovelScope, entityIds: string[], p: number, timelineId: string, recordedAt: Date): Promise<FactAtAnchor[]> {
  const { schema } = await activeSchema(db, scope);
  const rows = await db
    .select()
    .from(factVersions)
    .where(
      and(
        eq(factVersions.novelId, scope.novelId),
        lte(factVersions.recordedAt, recordedAt),
        or(isNull(factVersions.supersededAt), sql`${factVersions.supersededAt} > ${recordedAt}`),
        inArray(factVersions.canonStatus, CANON),
      ),
    );
  const ids = new Set(entityIds);
  const picked = rows
    .map((v) => ({ v, c: v.content as FactContent }))
    .filter(({ c }) => c.timelineId === timelineId && !c.isNegation && rangeContains(c.storyRange, p) && (ids.has(c.subjectEntityId ?? "") || ids.has(c.objectEntityId ?? "")));
  const names = await preferredNames(db, scope, picked.flatMap(({ c }) => [c.subjectEntityId ?? "", c.objectEntityId ?? ""]));
  return picked.map(({ v, c }) => ({
    factId: v.factId,
    factVersionId: v.id,
    canonStatus: v.canonStatus,
    factKind: c.factKind as FactAtAnchor["factKind"],
    predicate: c.predicate,
    subjectEntityId: c.subjectEntityId ?? "",
    objectEntityId: c.objectEntityId,
    value: c.value,
    text: renderFactText(schema, { ...c, factKind: c.factKind as FactAtAnchor["factKind"], value: c.value ?? undefined }, (id) => names.get(id) ?? id, c.storyRange),
    storyRange: c.storyRange,
    timelineId: c.timelineId,
  }));
}

// ── knowledge (06 §7) ────────────────────────────────────────────────────
export async function knowledgeRows(db: Db, scope: NovelScope, viewer: Viewer, p: number, timelineId: string): Promise<Fact[]> {
  if (isViewerEntity(viewer)) {
    const v = await resolveId(db, scope, viewer).catch(() => viewer);
    const rows = await canonRowsAt(db, scope, null, p, timelineId);
    return rows.filter((f) => f.factKind === "knowledge" && f.subjectEntityId === v);
  }
  // reader / narrator layer: secret facts revealed to the reader at p
  const rows = await db
    .select()
    .from(facts)
    .where(and(eq(facts.novelId, scope.novelId), eq(facts.timelineId, timelineId), inArray(facts.canonStatus, CANON), eq(facts.isSecret, true), lte(facts.readerRevealPoint, p)));
  return rows;
}

export async function knowledgeOf(db: Db, scope: NovelScope, viewer: Viewer, p: number, timelineId: string): Promise<FactAtAnchor[]> {
  const { schema } = await activeSchema(db, scope);
  return project(db, scope, await knowledgeRows(db, scope, viewer, p, timelineId), schema);
}

async function nameRow(db: Db, scope: NovelScope, nameId: string): Promise<EntityName> {
  const [n] = await db.select().from(entityNames).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.id, nameId)));
  if (!n) throw new NotFoundError("이름", nameId);
  return n;
}

export function nameValidAtRow(n: EntityName, p: number, timelineId: string): boolean {
  return n.status === "active" && (n.timelineId === null || n.timelineId === timelineId) && rangeContains(parseRange(n.storyRange), p);
}

async function knowsIdentityFact(db: Db, scope: NovelScope, viewer: string, nameId: string, p: number, timelineId?: string): Promise<boolean> {
  const rows = await db
    .select({ id: facts.id })
    .from(facts)
    .where(
      and(
        eq(facts.novelId, scope.novelId),
        eq(facts.predicate, "knows_identity"),
        eq(facts.subjectEntityId, viewer),
        eq(facts.objectNameId, nameId),
        inArray(facts.canonStatus, CANON),
        eq(facts.knowledgeStance, "knows"),
        timelineId ? eq(facts.timelineId, timelineId) : undefined,
        sql`${facts.storyRange} @> ${p}::int4`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function surfaceKnownByRow(db: Db, scope: NovelScope, n: EntityName, viewer: Viewer, p: number): Promise<boolean> {
  if (n.surfaceVisibility === "public") return true;
  if (!isViewerEntity(viewer)) return n.readerRevealPoint !== null && p >= n.readerRevealPoint;
  if (n.surfaceVisibility === "secret") return false;
  if (viewer === n.entityId || n.surfaceKnownByEntityIds.includes(viewer)) return true;
  return knowsIdentityFact(db, scope, viewer, n.id, p);
}

export async function identityKnownByRow(db: Db, scope: NovelScope, n: EntityName, viewer: Viewer, p: number): Promise<boolean> {
  if (n.identityVisibility === "public") return true;
  if (!isViewerEntity(viewer)) return n.readerRevealPoint !== null && p >= n.readerRevealPoint;
  if (n.identityVisibility === "secret") return viewer === n.entityId;
  if (viewer === n.entityId || n.identityKnownByEntityIds.includes(viewer)) return true;
  return knowsIdentityFact(db, scope, viewer, n.id, p);
}

/** address_term `used_by_condition` (06 §3.7): `{speakers}` or `{relation, target_role}` evaluated on canon at p */
export async function addressConditionHolds(db: Db, scope: NovelScope, n: EntityName, speaker: Viewer, p: number, timelineId: string): Promise<boolean> {
  if (n.nameKind !== "address_term") return true;
  if (!isViewerEntity(speaker)) return false;
  const c = (n.usedByCondition ?? {}) as { speakers?: string[]; relation?: string; target_role?: "subject" | "object" | "either" };
  if (Array.isArray(c.speakers)) return c.speakers.includes(speaker);
  if (c.relation) {
    const rows = await canonRowsAt(db, scope, [n.entityId, speaker], p, timelineId);
    return rows.some(
      (f) =>
        f.predicate === c.relation &&
        ((c.target_role !== "object" && f.subjectEntityId === n.entityId && f.objectEntityId === speaker) ||
          (c.target_role !== "subject" && f.objectEntityId === n.entityId && f.subjectEntityId === speaker)),
    );
  }
  return false;
}

export async function nameValidAt(db: Db, scope: NovelScope, nameId: string, p: number, timelineId: string) {
  return nameValidAtRow(await nameRow(db, scope, nameId), p, timelineId);
}
export async function surfaceKnownBy(db: Db, scope: NovelScope, nameId: string, viewer: Viewer, p: number) {
  return surfaceKnownByRow(db, scope, await nameRow(db, scope, nameId), viewer, p);
}
export async function identityKnownBy(db: Db, scope: NovelScope, nameId: string, viewer: Viewer, p: number) {
  return identityKnownByRow(db, scope, await nameRow(db, scope, nameId), viewer, p);
}
export async function nameUsableBy(db: Db, scope: NovelScope, nameId: string, viewer: Viewer, anchor: StoryAnchor) {
  const n = await nameRow(db, scope, nameId);
  return (
    nameValidAtRow(n, anchor.storyPoint, anchor.timelineId) &&
    (await surfaceKnownByRow(db, scope, n, viewer, anchor.storyPoint)) &&
    (await addressConditionHolds(db, scope, n, viewer, anchor.storyPoint, anchor.timelineId))
  );
}

// ── entity cards (04 §9.6, 06 §3.12 C6 split cards) ──────────────────────
export async function getEntityCards(db: Db, scope: NovelScope, entityIds: string[], anchor: StoryAnchor, layer: "canon" | "reader" | "pov"): Promise<EntityCard[]> {
  const { schema } = await activeSchema(db, scope);
  const ids = [...new Set(await Promise.all(entityIds.map((id) => resolveId(db, scope, id))))];
  if (ids.length === 0) return [];
  const ents = await db.select().from(entities).where(and(eq(entities.novelId, scope.novelId), inArray(entities.id, ids)));
  const names = await db.select().from(entityNames).where(and(eq(entityNames.novelId, scope.novelId), inArray(entityNames.entityId, ids)));
  const factRows = await canonRowsAt(db, scope, ids, anchor.storyPoint, anchor.timelineId, "canon_and_safe_candidates");
  const projected = await project(db, scope, factRows, schema);
  const viewer: Viewer = layer === "canon" ? "narrator" : layer === "reader" ? "reader" : (anchor.povEntityId ?? "reader");
  const cards: EntityCard[] = [];
  for (const id of ids) {
    const e = ents.find((x) => x.id === id);
    if (!e) continue;
    const own = names.filter((n) => n.entityId === id && nameValidAtRow(n, anchor.storyPoint, anchor.timelineId) && n.nameKind !== "hidden_variant");
    const hiddenIdentity: EntityName[] = [];
    const usable: EntityName[] = [];
    for (const n of own) {
      if (layer === "canon") {
        usable.push(n);
        continue;
      }
      if (n.nameKind === "disguise" && !(await identityKnownByRow(db, scope, n, viewer, anchor.storyPoint))) hiddenIdentity.push(n);
      else if (await surfaceKnownByRow(db, scope, n, viewer, anchor.storyPoint)) usable.push(n);
    }
    const preferred = own.find((n) => n.isPreferred) ?? usable[0];
    const factsOf = projected.filter((f, i) => {
      const row = factRows[i]!;
      if (f.subjectEntityId !== id && f.objectEntityId !== id) return false;
      if (layer !== "canon" && row.isSecret && !(row.readerRevealPoint !== null && anchor.storyPoint >= row.readerRevealPoint)) return false;
      return !hiddenIdentity.some((h) => h.id === row.observedAsNameId);
    });
    cards.push({
      entityId: id,
      displayName: preferred ? `${preferred.surface}${e.disambiguator ? `(${e.disambiguator})` : ""}` : id,
      entityType: e.entityType as EntityType,
      disambiguator: e.disambiguator,
      usableNames: usable.map((n) => ({ nameId: n.id, surface: n.surface, nameKind: n.nameKind })),
      facts: factsOf,
      notes: [
        ...(e.status === "candidate" ? ["미확정 엔티티"] : []),
        ...factsOf.filter((f) => f.canonStatus === "candidate").map(() => "미확정 사실 포함").slice(0, 1),
      ],
    });
    // the disguise is shown as its own card; the link between the two is not revealed (FR-ONT-17)
    for (const h of hiddenIdentity) {
      cards.push({
        entityId: id,
        displayName: h.surface,
        entityType: e.entityType as EntityType,
        disambiguator: null,
        usableNames: [{ nameId: h.id, surface: h.surface, nameKind: h.nameKind }],
        facts: projected.filter((_f, i) => factRows[i]!.observedAsNameId === h.id),
        notes: ["정체 비공개 이름"],
      });
    }
  }
  return cards;
}

export async function getConstraints(db: Db, scope: NovelScope, q: { entityIds: string[]; answerIds: string[]; anchor: StoryAnchor }): Promise<FactAtAnchor[]> {
  const { schema } = await activeSchema(db, scope);
  const rows = await canonRowsAt(db, scope, null, q.anchor.storyPoint, q.anchor.timelineId);
  const ids = new Set(q.entityIds);
  const answers = new Set(q.answerIds);
  const picked = rows.filter(
    (f) =>
      f.factKind === "constraint" ||
      (f.factKind === "rule" && (ids.size === 0 || ids.has(f.subjectEntityId ?? ""))) ||
      (f.sourceRefType === "answer" && answers.has(f.sourceRefId)),
  );
  return project(db, scope, picked, schema);
}

// ── lists / detail (08 §9.5 UI) ──────────────────────────────────────────
export async function listEntities(db: Db, scope: NovelScope, f: EntityListFilter = {}): Promise<EntityListItem[]> {
  const conds = [eq(entities.novelId, scope.novelId)];
  if (f.entityTypes?.length) conds.push(inArray(entities.entityType, f.entityTypes));
  if (f.statuses?.length) conds.push(inArray(entities.status, f.statuses));
  else conds.push(ne(entities.status, "merged"));
  if (f.q) {
    const k = normalizedKey(f.q);
    conds.push(
      sql`exists (select 1 from entity_names n where n.novel_id = ${entities.novelId} and n.entity_id = ${entities.id} and n.status <> 'retired' and n.name_kind <> 'hidden_variant' and n.normalized_key like ${`%${k}%`})`,
    );
  }
  const rows = await db
    .select({
      e: entities,
      preferred: entityNames.surface,
      eps: sql<number>`(select count(distinct m.story_point / 1000)::int from mentions m where m.novel_id = ${entities.novelId} and m.linked_entity_id = ${entities.id} and m.source_kind = 'manuscript' and m.link_status in ('auto_linked','confirmed'))`,
      unresolved: sql<number>`(select count(*)::int from mentions m where m.novel_id = ${entities.novelId} and m.linked_entity_id = ${entities.id} and m.link_status in ('ambiguous','new_entity_candidate'))`,
    })
    .from(entities)
    .leftJoin(entityNames, and(eq(entityNames.novelId, entities.novelId), eq(entityNames.id, entities.preferredNameId)))
    .where(and(...conds))
    .orderBy(asc(entityNames.surface), asc(entities.id))
    .limit(Math.min(f.limit ?? 200, 500));
  return rows.map((r) => ({ entity: r.e, preferredName: r.preferred ?? r.e.id, appearanceEpisodeCount: Number(r.eps ?? 0), unresolvedMentionCount: Number(r.unresolved ?? 0) }));
}

export async function getEntityDetail(db: Db, scope: NovelScope, entityId: string): Promise<EntityDetail> {
  const id = await resolveId(db, scope, entityId);
  const { schema } = await activeSchema(db, scope);
  const [entity] = await db.select().from(entities).where(and(eq(entities.novelId, scope.novelId), eq(entities.id, id)));
  if (!entity) throw new NotFoundError("엔티티", entityId);
  const names = await db.select().from(entityNames).where(and(eq(entityNames.novelId, scope.novelId), eq(entityNames.entityId, id))).orderBy(desc(entityNames.isPreferred), asc(entityNames.createdAt));
  const app = await db
    .selectDistinct({ storyPoint: mentions.storyPoint, sceneId: mentions.sceneId })
    .from(mentions)
    .where(and(eq(mentions.novelId, scope.novelId), eq(mentions.linkedEntityId, id), eq(mentions.sourceKind, "manuscript"), inArray(mentions.linkStatus, ["auto_linked", "confirmed"])))
    .orderBy(asc(mentions.storyPoint));
  const appearances: Array<{ episodeNo: number; sceneId: string }> = [];
  for (const a of app) if (a.sceneId && !appearances.some((x) => x.sceneId === a.sceneId)) appearances.push({ episodeNo: Math.floor(a.storyPoint / 1000), sceneId: a.sceneId });
  let titleHolders: EntityDetail["titleHolders"] = [];
  if (entity.entityType === "title") {
    const tl = await getDefaultTimeline(db, scope);
    titleHolders = (await getTitleHolders(db, scope, id, tl.id)).map((h) => ({ entityId: h.entityId, storyRange: h.storyRange }));
  }
  const factRows = await db
    .select()
    .from(facts)
    .where(and(eq(facts.novelId, scope.novelId), or(eq(facts.subjectEntityId, id), eq(facts.objectEntityId, id)), inArray(facts.canonStatus, ["candidate", "approved", "published_locked"])))
    .orderBy(asc(sql`lower(${facts.storyRange})`), asc(facts.id));
  const decisions = await db
    .select()
    .from(identityDecisions)
    .where(
      and(
        eq(identityDecisions.novelId, scope.novelId),
        or(
          sql`${identityDecisions.sourceEntityIds} @> ARRAY[${id}]::text[]`,
          eq(identityDecisions.survivorEntityId, id),
          eq(identityDecisions.newEntityId, id),
          eq(identityDecisions.relinkFromEntityId, id),
          eq(identityDecisions.relinkToEntityId, id),
        ),
      ),
    )
    .orderBy(desc(identityDecisions.createdAt));
  return { entity, names, appearances, titleHolders, factsSummary: await project(db, scope, factRows, schema), identityDecisions: decisions };
}

export async function listMentions(
  db: Db,
  scope: NovelScope,
  q: { entityId?: string; linkStatus?: LinkStatus[]; manuscriptVersionId?: string; limit?: number; questionId?: string; ids?: string[]; sourceKinds?: Mention["sourceKind"][] },
): Promise<Mention[]> {
  const conds = [eq(mentions.novelId, scope.novelId)];
  if (q.entityId) {
    const id = await resolveId(db, scope, q.entityId);
    conds.push(or(eq(mentions.linkedEntityId, id), sql`${mentions.candidates} @> ${JSON.stringify([{ entityId: id }])}::jsonb`)!);
  }
  if (q.linkStatus?.length) conds.push(inArray(mentions.linkStatus, q.linkStatus));
  if (q.manuscriptVersionId) conds.push(eq(mentions.manuscriptVersionId, q.manuscriptVersionId));
  if (q.questionId) conds.push(eq(mentions.questionId, q.questionId));
  if (q.ids) {
    if (q.ids.length === 0) return [];
    conds.push(inArray(mentions.id, q.ids));
  }
  if (q.sourceKinds?.length) conds.push(inArray(mentions.sourceKind, q.sourceKinds));
  return db
    .select()
    .from(mentions)
    .where(and(...conds))
    .orderBy(asc(mentions.storyPoint), asc(mentions.charStart), asc(mentions.id))
    .limit(Math.min(q.limit ?? 500, 2000));
}

export async function listDistinctPairs(db: Db, scope: NovelScope, ids: string[]): Promise<Array<[string, string]>> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(entityDistinctPairs)
    .where(and(eq(entityDistinctPairs.novelId, scope.novelId), or(inArray(entityDistinctPairs.entityAId, ids), inArray(entityDistinctPairs.entityBId, ids))));
  return rows.map((r) => [r.entityAId, r.entityBId]);
}

/** CR-08 heuristic (06 §3.12): in one scene, an unaware viewer refers to E both via a hidden disguise and another of E's names */
export async function findIdentityLeaks(db: Db, scope: NovelScope, manuscriptVersionId: string) {
  const ms = await db
    .select()
    .from(mentions)
    .where(and(eq(mentions.novelId, scope.novelId), eq(mentions.manuscriptVersionId, manuscriptVersionId), inArray(mentions.linkStatus, ["auto_linked", "confirmed"])));
  const nameIds = [...new Set(ms.map((m) => m.viaNameId).filter((x): x is string => !!x))];
  const names = new Map((await getNamesByIds(db, scope, nameIds)).map((n) => [n.id, n]));
  const out: Array<{ mentionId: string; nameId: string; viewer: Viewer; message: string }> = [];
  const groups = new Map<string, Mention[]>();
  for (const m of ms) {
    const viewer: Viewer = m.speakerEntityId ?? m.povEntityId ?? "narrator";
    const k = `${m.sceneId}|${m.linkedEntityId}|${viewer}`;
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  for (const list of groups.values()) {
    const viewer: Viewer = list[0]!.speakerEntityId ?? list[0]!.povEntityId ?? "narrator";
    for (const dm of list) {
      const dn = dm.viaNameId ? names.get(dm.viaNameId) : undefined;
      if (!dn || dn.nameKind !== "disguise" || (await identityKnownByRow(db, scope, dn, viewer, dm.storyPoint))) continue;
      for (const other of list) {
        const on = other.viaNameId ? names.get(other.viaNameId) : undefined;
        if (other.id === dm.id || !on || on.nameKind === "disguise") continue;
        out.push({ mentionId: other.id, nameId: dn.id, viewer, message: `정체를 모르는 시점에서 '${dn.surface}'와(과) '${on.surface}'가 같은 인물로 드러납니다.` });
      }
    }
  }
  return out;
}

export async function getFactsByIds(db: Db, scope: NovelScope, factIds: string[]): Promise<FactAtAnchor[]> {
  if (factIds.length === 0) return [];
  const { schema } = await activeSchema(db, scope);
  const rows = await db.select().from(facts).where(and(eq(facts.novelId, scope.novelId), inArray(facts.id, factIds)));
  return project(db, scope, rows, schema);
}

