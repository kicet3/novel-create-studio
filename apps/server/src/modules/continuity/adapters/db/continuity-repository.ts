/** drizzle access to continuity_issues / continuity_issue_evidence. Every query filters by novel_id (03 T-3). */
import { and, asc, desc, eq, inArray, or, sql } from "@ncs/db/orm";
import { continuityIssueEvidence, continuityIssues } from "@ncs/db/schema";
import type { IssueSeverity } from "@ncs/shared";
import type { Db, NovelScope } from "../../../../platform/index.js";
import type { ContinuityIssue, ContinuityIssueEvidence, IssueFilter } from "../../index.js";

type IssueInsert = typeof continuityIssues.$inferInsert;
type EvidenceInsert = typeof continuityIssueEvidence.$inferInsert;

export const continuityRepo = {
  async insertIssue(db: Db, row: IssueInsert): Promise<ContinuityIssue> {
    const [i] = await db.insert(continuityIssues).values(row).returning();
    return i!;
  },
  async insertEvidence(db: Db, rows: EvidenceInsert[]): Promise<void> {
    if (rows.length) await db.insert(continuityIssueEvidence).values(rows);
  },
  async getIssue(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<ContinuityIssue | null> {
    const q = db.select().from(continuityIssues).where(and(eq(continuityIssues.novelId, scope.novelId), eq(continuityIssues.id, id)));
    const [i] = forUpdate ? await q.for("update") : await q;
    return i ?? null;
  },
  async listEvidence(db: Db, scope: NovelScope, issueIds: string[]): Promise<ContinuityIssueEvidence[]> {
    if (!issueIds.length) return [];
    return db
      .select()
      .from(continuityIssueEvidence)
      .where(and(eq(continuityIssueEvidence.novelId, scope.novelId), inArray(continuityIssueEvidence.issueId, issueIds)))
      .orderBy(asc(continuityIssueEvidence.id));
  },
  async listIssues(db: Db, scope: NovelScope, f: IssueFilter = {}): Promise<ContinuityIssue[]> {
    const conds = [eq(continuityIssues.novelId, scope.novelId)];
    if (f.episodeId) conds.push(eq(continuityIssues.episodeId, f.episodeId));
    if (f.manuscriptVersionId) conds.push(eq(continuityIssues.manuscriptVersionId, f.manuscriptVersionId));
    if (f.statuses?.length) conds.push(inArray(continuityIssues.status, f.statuses));
    if (f.severities?.length) conds.push(inArray(continuityIssues.severity, f.severities));
    if (f.kinds?.length) conds.push(inArray(continuityIssues.kind, f.kinds));
    const q = db.select().from(continuityIssues).where(and(...conds)).orderBy(desc(continuityIssues.displayNo));
    return f.limit ? q.limit(f.limit) : q;
  },
  async updateIssue(db: Db, scope: NovelScope, id: string, patch: Partial<IssueInsert>): Promise<ContinuityIssue> {
    const [i] = await db
      .update(continuityIssues)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(continuityIssues.novelId, scope.novelId), eq(continuityIssues.id, id)))
      .returning();
    return i!;
  },
  /** 설계 추가(화 삭제): issues about the episode's text (its own, or detected on one of its versions) */
  async listForDeletedText(db: Db, scope: NovelScope, episodeId: string, versionIds: string[]): Promise<ContinuityIssue[]> {
    const where = versionIds.length ? or(eq(continuityIssues.episodeId, episodeId), inArray(continuityIssues.manuscriptVersionId, versionIds)) : eq(continuityIssues.episodeId, episodeId);
    return db.select().from(continuityIssues).where(and(eq(continuityIssues.novelId, scope.novelId), where)).orderBy(asc(continuityIssues.displayNo));
  },
  /** 설계 추가(화 삭제): hard delete (evidence first; re-open chains pointing at them are cut) */
  async deleteIssues(db: Db, scope: NovelScope, issueIds: string[]): Promise<number> {
    if (!issueIds.length) return 0;
    await db.delete(continuityIssueEvidence).where(and(eq(continuityIssueEvidence.novelId, scope.novelId), inArray(continuityIssueEvidence.issueId, issueIds)));
    await db.update(continuityIssues).set({ previousIssueId: null, updatedAt: sql`now()` }).where(and(eq(continuityIssues.novelId, scope.novelId), inArray(continuityIssues.previousIssueId, issueIds)));
    const rows = await db.delete(continuityIssues).where(and(eq(continuityIssues.novelId, scope.novelId), inArray(continuityIssues.id, issueIds))).returning({ id: continuityIssues.id });
    return rows.length;
  },
  async countOpenBySeverity(db: Db, scope: NovelScope, episodeId?: string): Promise<Record<IssueSeverity, number>> {
    const conds = [eq(continuityIssues.novelId, scope.novelId), inArray(continuityIssues.status, ["open", "fixing"])];
    if (episodeId) conds.push(eq(continuityIssues.episodeId, episodeId));
    const rows = await db
      .select({ severity: continuityIssues.severity, n: sql<number>`count(*)::int` })
      .from(continuityIssues)
      .where(and(...conds))
      .groupBy(continuityIssues.severity);
    const out: Record<IssueSeverity, number> = { high: 0, medium: 0, low: 0 };
    for (const r of rows) out[r.severity] = Number(r.n);
    return out;
  },
};
