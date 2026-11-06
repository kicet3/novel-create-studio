// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: cast (0006_cast.sql).
import { boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { ENUMS } from "@ncs/shared/enums";

export interface CharacterRelationshipJson {
  targetCharacterId: string;
  kind: string;
  description: string;
}

/** values written to the ontology on the last cast confirm (re-confirm only writes changes) */
export interface CharacterOntologySyncJson {
  at: string;
  /** field key (age / gender / personality / rel:<predicate>:<characterId>) → value recorded as an approved fact */
  values: Record<string, string>;
  factIds: string[];
  /** field key → approved fact id holding `values[field]` (withdrawn when the field changes) */
  fieldFacts?: Record<string, string>;
  rejected: Array<{ field: string; reason: string }>;
  /** role + profile as last confirmed (the writing context keeps using it while the character is edited) */
  confirmed?: {
    role: string;
    name: string;
    aliases: string[];
    age: string;
    gender: string;
    personality: string;
    background: string;
    desire: string;
    weakness: string;
    relationships: CharacterRelationshipJson[];
    notes: string;
    /** 0008 required profile fields (absent on rows confirmed before 0008) */
    appearance?: string;
    motivation?: string;
    speechSample?: string;
    arcStart?: string;
    arcEnd?: string;
    storyRole?: string;
  };
}

/** characters — one row per cast member (설계 추가: 캐릭터 설정 단계) */
export const characters = pgTable("characters", {
  id: text("id").notNull().primaryKey(),
  novelId: text("novel_id").notNull(),
  role: text("role", { enum: ENUMS.character_role }).notNull(),
  ord: integer("ord").notNull().default(0),
  status: text("status", { enum: ENUMS.character_status }).notNull().default("draft"),
  name: text("name").notNull(),
  aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
  age: text("age").notNull().default(""),
  gender: text("gender").notNull().default(""),
  personality: text("personality").notNull().default(""),
  background: text("background").notNull().default(""),
  desire: text("desire").notNull().default(""),
  weakness: text("weakness").notNull().default(""),
  relationships: jsonb("relationships").$type<CharacterRelationshipJson[]>().notNull().default([]),
  notes: text("notes").notNull().default(""),
  /** 0008 required profile fields + first appearance */
  appearance: text("appearance").notNull().default(""),
  motivation: text("motivation").notNull().default(""),
  speechSample: text("speech_sample").notNull().default(""),
  arcStart: text("arc_start").notNull().default(""),
  arcEnd: text("arc_end").notNull().default(""),
  storyRole: text("story_role").notNull().default(""),
  firstAppearanceEpisodeNo: integer("first_appearance_episode_no"),
  introducedArcId: text("introduced_arc_id"),
  fieldOrigins: jsonb("field_origins").$type<Record<string, "user" | "agent">>().notNull().default({}),
  proposed: boolean("proposed").notNull().default(false),
  conceptCharacterKey: text("concept_character_key"),
  entityId: text("entity_id"),
  ontologySync: jsonb("ontology_sync").$type<CharacterOntologySyncJson | null>(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
export type CharactersRow = typeof characters.$inferSelect;
export type CharactersInsert = typeof characters.$inferInsert;

/** character_design_sheets — visual spec + selected images per view (1:1 with characters) */
export const characterDesignSheets = pgTable("character_design_sheets", {
  id: text("id").notNull().primaryKey(),
  novelId: text("novel_id").notNull(),
  characterId: text("character_id").notNull(),
  spec: jsonb("spec").$type<Record<string, unknown>>().notNull().default({}),
  fieldOrigins: jsonb("field_origins").$type<Record<string, "user" | "agent">>().notNull().default({}),
  primaryImages: jsonb("primary_images").$type<Partial<Record<(typeof ENUMS.character_sheet_view)[number], string>>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
export type CharacterDesignSheetsRow = typeof characterDesignSheets.$inferSelect;
export type CharacterDesignSheetsInsert = typeof characterDesignSheets.$inferInsert;

/** character_sheet_images — image generations (imaging) made for a design sheet view */
export const characterSheetImages = pgTable("character_sheet_images", {
  id: text("id").notNull().primaryKey(),
  novelId: text("novel_id").notNull(),
  characterId: text("character_id").notNull(),
  view: text("view", { enum: ENUMS.character_sheet_view }).notNull(),
  generationId: text("generation_id").notNull(),
  prompt: text("prompt").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
export type CharacterSheetImagesRow = typeof characterSheetImages.$inferSelect;
export type CharacterSheetImagesInsert = typeof characterSheetImages.$inferInsert;
