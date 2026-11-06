/**
 * Minimal seed helpers for DB tests (work with any NcsDb: PGlite or postgres.js).
 * seedNovel() performs the N1 creation set (03 §4.12): novel(status=concept) + base schema version
 * + main timeline + web channel + concept session + default budget policy. Optionally a user.
 */
import { newId, usdToMicros, DEFAULTS } from "@ncs/shared";
import type { NcsDb } from "../runtime/connection.js";
import {
  users,
  lengthProfiles,
  novels,
  ontologySchemaVersions,
  timelines,
  channels,
  conceptSessions,
  budgetPolicies,
  arcs,
} from "../schema/index.js";

export interface SeededNovel {
  userId: string;
  novelId: string;
  lengthProfileId: string;
  schemaVersionId: string;
  timelineId: string;
  webChannelId: string;
  conceptSessionId: string;
  budgetPolicyId: string;
}

export async function seedUser(db: NcsDb, displayName = "작가"): Promise<string> {
  const id = newId("usr");
  await db.insert(users).values({ id, displayName, role: "owner" });
  return id;
}

export async function seedNovel(db: NcsDb, opts: { userId?: string; title?: string } = {}): Promise<SeededNovel> {
  const userId = opts.userId ?? (await seedUser(db));
  const ids = {
    novelId: newId("nov"),
    lengthProfileId: newId("lpf"),
    schemaVersionId: newId("osv"),
    timelineId: newId("tln"),
    webChannelId: newId("chn"),
    conceptSessionId: newId("cns"),
    budgetPolicyId: newId("bgp"),
  };
  await db.transaction(async (tx) => {
    await tx.insert(lengthProfiles).values({ id: ids.lengthProfileId, name: "기본" });
    // novels.active_schema_version_id is DEFERRABLE INITIALLY DEFERRED → insert novel first
    await tx.insert(novels).values({
      id: ids.novelId,
      title: opts.title ?? "임시 제목",
      ageRating: "age_15",
      lengthProfileId: ids.lengthProfileId,
      activeSchemaVersionId: ids.schemaVersionId,
    });
    await tx.insert(ontologySchemaVersions).values({ id: ids.schemaVersionId, novelId: ids.novelId, versionNo: 1 });
    await tx.insert(timelines).values({ id: ids.timelineId, novelId: ids.novelId, kind: "main", label: "T1", isDefault: true });
    await tx.insert(channels).values({ id: ids.webChannelId, novelId: ids.novelId, kind: "web", status: "active", label: "웹 인박스" });
    await tx.insert(conceptSessions).values({
      id: ids.conceptSessionId,
      novelId: ids.novelId,
      budgetLimitMicros: usdToMicros(DEFAULTS["concept.session_budget_usd"]),
      activeChannelId: ids.webChannelId,
      createdByUserId: userId,
    });
    await tx.insert(budgetPolicies).values({
      id: ids.budgetPolicyId,
      novelId: ids.novelId,
      category: "all",
      hardLimitMicros: usdToMicros(DEFAULTS["budget.novel_monthly_hard_limit_usd"]),
      windowStartedAt: new Date(),
    });
  });
  return { userId, ...ids };
}

export async function seedArc(db: NcsDb, novelId: string, opts: { ord?: number; from?: number; to?: number } = {}): Promise<string> {
  const id = newId("arc");
  await db.insert(arcs).values({
    id,
    novelId,
    ord: opts.ord ?? 1,
    title: "1부",
    goalText: "목표",
    conflictText: "갈등",
    endCondition: "결말 조건",
    plannedEpisodeFrom: opts.from ?? 1,
    plannedEpisodeTo: opts.to ?? 10,
  });
  return id;
}
