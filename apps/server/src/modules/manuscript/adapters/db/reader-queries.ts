/** 읽기(reader): read-only batch lookups on manuscript-owned tables (every query filters by novel_id, 03 T-3). */
import { and, eq, inArray } from "@ncs/db/orm";
import { manuscriptVersions } from "@ncs/db/schema";
import type { Db, NovelScope } from "../../../../platform/index.js";

export interface VersionMeta {
  id: string;
  kind: string;
  versionNo: number;
  charCountWithSpaces: number;
  charCountWithoutSpaces: number;
}

export const readerQueries = {
  /** kind + stored counts of many versions without loading their bodies */
  async versionMeta(db: Db, scope: NovelScope, ids: readonly string[]): Promise<Map<string, VersionMeta>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const rows = await db
      .select({
        id: manuscriptVersions.id,
        kind: manuscriptVersions.kind,
        versionNo: manuscriptVersions.versionNo,
        charCountWithSpaces: manuscriptVersions.charCountWithSpaces,
        charCountWithoutSpaces: manuscriptVersions.charCountWithoutSpaces,
      })
      .from(manuscriptVersions)
      .where(and(eq(manuscriptVersions.novelId, scope.novelId), inArray(manuscriptVersions.id, unique)));
    return new Map(rows.map((r) => [r.id, r]));
  },
};
