/**
 * 설계 추가 0015: entity resolver memory (glossary_terms, category `non_entity`): surfaces an agent or the author decided
 * are not story entities (generic places / objects / events, backdrop nouns). The linker filter rejects them later without
 * asking again. One active term per normalized key (glossary_terms_active_key).
 */
import { and, eq, inArray, ne } from "@ncs/db/orm";
import { entities, entityNames, glossaryTerms } from "@ncs/db/schema";
import type { ActorRef, Db, NovelScope, Tx } from "../../../../platform/index.js";
import { normalizedKey } from "../../domain/normalize.js";
import type { OntoDeps } from "./common.js";

export const NON_ENTITY_CATEGORY = "non_entity";

export async function recordNonEntitySurface(d: OntoDeps, tx: Tx, scope: NovelScope, surface: string, actor: ActorRef, note?: string): Promise<{ termId: string; created: boolean } | null> {
  const key = normalizedKey(surface);
  if (!key) return null;
  const [prev] = await tx.db.select().from(glossaryTerms).where(and(eq(glossaryTerms.novelId, scope.novelId), eq(glossaryTerms.normalizedKey, key), eq(glossaryTerms.status, "active")));
  if (prev) return { termId: prev.id, created: false };
  const id = d.platform.ids.next("gls");
  const now = d.platform.clock.date();
  await tx.db.insert(glossaryTerms).values({
    id,
    novelId: scope.novelId,
    surface: surface.trim(),
    normalizedKey: key,
    category: NON_ENTITY_CATEGORY,
    definition: note?.slice(0, 500) || "엔티티가 아닌 일반 표현(판정 에이전트 기록)",
    preferredSurface: surface.trim(),
    sourceKind: actor.type === "user" ? "user" : "agent",
    sourceRef: actor.type === "agent" ? (actor.runId ?? null) : null,
    createdAt: now,
    updatedAt: now,
  });
  await d.audit.record(tx, { novelId: scope.novelId, actor, action: "glossary.term_created", target: { type: "glossary_term", id }, after: { surface: surface.trim(), category: NON_ENTITY_CATEGORY }, reason: note ?? null });
  return { termId: id, created: true };
}

/** normalized keys of the active non-entity terms */
export async function listNonEntitySurfaces(db: Db, scope: NovelScope): Promise<string[]> {
  const rows = await db
    .select({ k: glossaryTerms.normalizedKey })
    .from(glossaryTerms)
    .where(and(eq(glossaryTerms.novelId, scope.novelId), eq(glossaryTerms.category, NON_ENTITY_CATEGORY), eq(glossaryTerms.status, "active")));
  return rows.map((r) => r.k);
}

/** live (candidate / active) entities with a non-retired, non-hidden name of the same normalized key (optionally of one type) */
export async function findExactNamedEntities(db: Db, scope: NovelScope, surface: string, entityType?: string): Promise<Array<{ entityId: string; entityType: string; status: string; nameId: string }>> {
  const key = normalizedKey(surface);
  if (!key) return [];
  const rows = await db
    .select({ entityId: entities.id, entityType: entities.entityType, status: entities.status, nameId: entityNames.id, createdAt: entities.createdAt })
    .from(entityNames)
    .innerJoin(entities, and(eq(entities.novelId, entityNames.novelId), eq(entities.id, entityNames.entityId)))
    .where(
      and(
        eq(entityNames.novelId, scope.novelId),
        eq(entityNames.normalizedKey, key),
        ne(entityNames.status, "retired"),
        ne(entityNames.nameKind, "hidden_variant"),
        inArray(entities.status, ["candidate", "active"]),
        ...(entityType ? [eq(entities.entityType, entityType as never)] : []),
      ),
    );
  const seen = new Set<string>();
  return rows
    .sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) || a.createdAt.getTime() - b.createdAt.getTime())
    .filter((r) => (seen.has(r.entityId) ? false : (seen.add(r.entityId), true)))
    .map(({ entityId, entityType: t, status, nameId }) => ({ entityId, entityType: t, status, nameId }));
}
