/** world_ontology_items access (module world owns the table; ontology rows only through OntologyService). */
import { and, asc, eq, inArray, sql } from "@ncs/db/orm";
import { worldOntologyItems, type WorldOntologyItemsInsert, type WorldOntologyItemsRow } from "@ncs/db/schema";
import { NotFoundError, type NovelScope, type Tx } from "../../../../platform/index.js";

type Db = Tx["db"];

export const itemsRepo = {
  async list(db: Db, scope: NovelScope, opts: { statuses?: WorldOntologyItemsRow["status"][] } = {}): Promise<WorldOntologyItemsRow[]> {
    const conds = [eq(worldOntologyItems.novelId, scope.novelId)];
    if (opts.statuses?.length) conds.push(inArray(worldOntologyItems.status, opts.statuses));
    return db.select().from(worldOntologyItems).where(and(...conds)).orderBy(asc(worldOntologyItems.createdAt), asc(worldOntologyItems.id));
  },
  async get(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<WorldOntologyItemsRow> {
    const q = db.select().from(worldOntologyItems).where(and(eq(worldOntologyItems.novelId, scope.novelId), eq(worldOntologyItems.id, id)));
    const [row] = forUpdate ? await q.for("update") : await q;
    if (!row) throw new NotFoundError("세계관 항목", id);
    return row;
  },
  async insert(db: Db, row: WorldOntologyItemsInsert): Promise<WorldOntologyItemsRow> {
    const [r] = await db.insert(worldOntologyItems).values(row).returning();
    return r!;
  },
  async update(db: Db, scope: NovelScope, id: string, patch: Partial<WorldOntologyItemsInsert>): Promise<WorldOntologyItemsRow> {
    const [r] = await db
      .update(worldOntologyItems)
      .set(patch)
      .where(and(eq(worldOntologyItems.novelId, scope.novelId), eq(worldOntologyItems.id, id)))
      .returning();
    if (!r) throw new NotFoundError("세계관 항목", id);
    return r;
  },
  /** per-novel lock for review / commit (one writer at a time) */
  async lock(db: Db, scope: NovelScope): Promise<void> {
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`world_items:${scope.novelId}`}))`);
  },
};
