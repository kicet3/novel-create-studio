// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: publication (0021_public_site.sql, 설계 추가: 공개 사이트).
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** public_site_novels — per-novel opt-in to the read-only public site (default off) */
export const publicSiteNovels = pgTable("public_site_novels", {
  novelId: text("novel_id").notNull().primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  slug: text("slug"),
  intro: text("intro").notNull().default(""),
  authorName: text("author_name").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
export type PublicSiteNovelsRow = typeof publicSiteNovels.$inferSelect;
export type PublicSiteNovelsInsert = typeof publicSiteNovels.$inferInsert;
