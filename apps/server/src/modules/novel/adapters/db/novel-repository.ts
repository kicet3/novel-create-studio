/** drizzle access to the tables owned by `novel` (08 §2.3). Every novel-owned query filters by novel_id (03 T-3). */
import { and, asc, desc, eq, isNull, max, ne, sql } from "@ncs/db/orm";
import { arcs, goals, lengthProfiles, notificationPolicies, novelCounters, novels, seriesBibles, storyParts, storyStructures, users } from "@ncs/db/schema";
import type { StoryPartsRow, StoryStructuresRow } from "@ncs/db/schema";
import type { NovelCounterKind } from "@ncs/shared";
import type { Db, NovelScope } from "../../../../platform/index.js";
import type { Arc, Goal, LengthProfile, NotificationPolicy, Novel, SeriesBible, User } from "../../index.js";

type NovelInsert = typeof novels.$inferInsert;
type ArcInsert = typeof arcs.$inferInsert;
type BibleInsert = typeof seriesBibles.$inferInsert;

export const novelRepo = {
  // users
  async firstOwner(db: Db): Promise<User | null> {
    const [u] = await db.select().from(users).where(eq(users.role, "owner")).orderBy(asc(users.createdAt)).limit(1);
    return u ?? null;
  },
  async insertUser(db: Db, row: typeof users.$inferInsert): Promise<User> {
    const [u] = await db.insert(users).values(row).returning();
    return u!;
  },

  // novels
  async insertNovel(db: Db, row: NovelInsert): Promise<Novel> {
    const [n] = await db.insert(novels).values(row).returning();
    return n!;
  },
  async getNovel(db: Db, novelId: string, opts: { forUpdate?: boolean } = {}): Promise<Novel | null> {
    const q = db.select().from(novels).where(eq(novels.id, novelId));
    const [n] = opts.forUpdate ? await q.for("update") : await q;
    return n ?? null;
  },
  async listNovels(db: Db, includeArchived: boolean): Promise<Novel[]> {
    return db
      .select()
      .from(novels)
      .where(includeArchived ? undefined : ne(novels.status, "archived"))
      .orderBy(desc(novels.updatedAt));
  },
  async updateNovel(db: Db, novelId: string, patch: Partial<NovelInsert>): Promise<Novel> {
    const [n] = await db
      .update(novels)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(novels.id, novelId))
      .returning();
    return n!;
  },

  // counters (00 §5.2)
  async nextCounter(db: Db, scope: NovelScope, kind: NovelCounterKind): Promise<number> {
    const [row] = await db
      .insert(novelCounters)
      .values({ novelId: scope.novelId, counterKind: kind, lastValue: 1 })
      .onConflictDoUpdate({
        target: [novelCounters.novelId, novelCounters.counterKind],
        set: { lastValue: sql`${novelCounters.lastValue} + 1`, updatedAt: sql`now()` },
      })
      .returning({ v: novelCounters.lastValue });
    return Number(row!.v);
  },

  // goals
  async getGoal(db: Db, scope: NovelScope, forUpdate = false): Promise<Goal | null> {
    const q = db.select().from(goals).where(eq(goals.novelId, scope.novelId));
    const [g] = forUpdate ? await q.for("update") : await q;
    return g ?? null;
  },
  async insertGoal(db: Db, row: typeof goals.$inferInsert): Promise<Goal> {
    const [g] = await db.insert(goals).values(row).returning();
    return g!;
  },
  async updateGoal(db: Db, scope: NovelScope, goalId: string, patch: Partial<typeof goals.$inferInsert>): Promise<Goal> {
    const [g] = await db
      .update(goals)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(goals.novelId, scope.novelId), eq(goals.id, goalId)))
      .returning();
    return g!;
  },

  // series bibles
  async nextBibleVersionNo(db: Db, scope: NovelScope): Promise<number> {
    const [r] = await db.select({ v: max(seriesBibles.versionNo) }).from(seriesBibles).where(eq(seriesBibles.novelId, scope.novelId));
    return Number(r?.v ?? 0) + 1;
  },
  async insertBible(db: Db, row: BibleInsert): Promise<SeriesBible> {
    const [b] = await db.insert(seriesBibles).values(row).returning();
    return b!;
  },
  async getBible(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<SeriesBible | null> {
    const q = db.select().from(seriesBibles).where(and(eq(seriesBibles.novelId, scope.novelId), eq(seriesBibles.id, id)));
    const [b] = forUpdate ? await q.for("update") : await q;
    return b ?? null;
  },
  async getApprovedBible(db: Db, scope: NovelScope): Promise<SeriesBible | null> {
    const [b] = await db
      .select()
      .from(seriesBibles)
      .where(and(eq(seriesBibles.novelId, scope.novelId), eq(seriesBibles.status, "approved")));
    return b ?? null;
  },
  async listBibles(db: Db, scope: NovelScope): Promise<SeriesBible[]> {
    return db.select().from(seriesBibles).where(eq(seriesBibles.novelId, scope.novelId)).orderBy(desc(seriesBibles.versionNo));
  },
  async updateBible(db: Db, scope: NovelScope, id: string, patch: Partial<BibleInsert>): Promise<SeriesBible> {
    const [b] = await db
      .update(seriesBibles)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(seriesBibles.novelId, scope.novelId), eq(seriesBibles.id, id)))
      .returning();
    return b!;
  },

  // arcs
  async insertArc(db: Db, row: ArcInsert): Promise<Arc> {
    const [a] = await db.insert(arcs).values(row).returning();
    return a!;
  },
  async getArc(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<Arc | null> {
    const q = db.select().from(arcs).where(and(eq(arcs.novelId, scope.novelId), eq(arcs.id, id)));
    const [a] = forUpdate ? await q.for("update") : await q;
    return a ?? null;
  },
  async listArcs(db: Db, scope: NovelScope): Promise<Arc[]> {
    return db.select().from(arcs).where(eq(arcs.novelId, scope.novelId)).orderBy(asc(arcs.ord));
  },
  async updateArc(db: Db, scope: NovelScope, id: string, patch: Partial<ArcInsert>): Promise<Arc> {
    const [a] = await db
      .update(arcs)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(arcs.novelId, scope.novelId), eq(arcs.id, id)))
      .returning();
    return a!;
  },

  // story structure (0008)
  async getStructure(db: Db, scope: NovelScope, forUpdate = false): Promise<StoryStructuresRow | null> {
    const q = db.select().from(storyStructures).where(eq(storyStructures.novelId, scope.novelId));
    const [s] = forUpdate ? await q.for("update") : await q;
    return s ?? null;
  },
  async insertStructure(db: Db, row: typeof storyStructures.$inferInsert): Promise<StoryStructuresRow> {
    const [s] = await db.insert(storyStructures).values(row).returning();
    return s!;
  },
  async updateStructure(db: Db, scope: NovelScope, id: string, patch: Partial<typeof storyStructures.$inferInsert>): Promise<StoryStructuresRow> {
    const [s] = await db
      .update(storyStructures)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(storyStructures.novelId, scope.novelId), eq(storyStructures.id, id)))
      .returning();
    return s!;
  },
  async listParts(db: Db, scope: NovelScope): Promise<StoryPartsRow[]> {
    return db.select().from(storyParts).where(eq(storyParts.novelId, scope.novelId)).orderBy(asc(storyParts.ord));
  },
  async insertParts(db: Db, rows: Array<typeof storyParts.$inferInsert>): Promise<StoryPartsRow[]> {
    return rows.length ? db.insert(storyParts).values(rows).returning() : [];
  },
  async updatePart(db: Db, scope: NovelScope, id: string, patch: Partial<typeof storyParts.$inferInsert>): Promise<StoryPartsRow> {
    const [p] = await db
      .update(storyParts)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(storyParts.novelId, scope.novelId), eq(storyParts.id, id)))
      .returning();
    return p!;
  },

  // length profiles
  async presets(db: Db): Promise<LengthProfile[]> {
    return db.select().from(lengthProfiles).where(isNull(lengthProfiles.novelId)).orderBy(asc(lengthProfiles.createdAt));
  },
  async getLengthProfile(db: Db, id: string): Promise<LengthProfile | null> {
    const [p] = await db.select().from(lengthProfiles).where(eq(lengthProfiles.id, id));
    return p ?? null;
  },
  async insertLengthProfile(db: Db, row: typeof lengthProfiles.$inferInsert): Promise<LengthProfile> {
    const [p] = await db.insert(lengthProfiles).values(row).returning();
    return p!;
  },
  async updateLengthProfile(db: Db, scope: NovelScope, id: string, patch: Partial<typeof lengthProfiles.$inferInsert>): Promise<LengthProfile> {
    const [p] = await db
      .update(lengthProfiles)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(lengthProfiles.novelId, scope.novelId), eq(lengthProfiles.id, id)))
      .returning();
    return p!;
  },

  // notification policies
  async insertNotificationPolicy(db: Db, row: typeof notificationPolicies.$inferInsert): Promise<NotificationPolicy> {
    const [p] = await db.insert(notificationPolicies).values(row).returning();
    return p!;
  },
  async getNotificationPolicy(db: Db, scope: NovelScope): Promise<NotificationPolicy | null> {
    const [p] = await db.select().from(notificationPolicies).where(eq(notificationPolicies.novelId, scope.novelId));
    return p ?? null;
  },
  async updateNotificationPolicy(db: Db, scope: NovelScope, patch: Partial<typeof notificationPolicies.$inferInsert>): Promise<NotificationPolicy> {
    const [p] = await db
      .update(notificationPolicies)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(notificationPolicies.novelId, scope.novelId))
      .returning();
    return p!;
  },
};
