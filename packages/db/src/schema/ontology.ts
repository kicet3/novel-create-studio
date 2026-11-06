// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: ontology (design/08 §2.3).
import { bigint, boolean, integer, jsonb, pgTable, primaryKey, real, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ENUMS } from "@ncs/shared/enums";
import { int4range } from "./_types.js";

/** ontology_schema_versions */
export const ontologySchemaVersions = pgTable(
  "ontology_schema_versions",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    versionNo: integer("version_no").notNull(),
    baseSchemaKey: text("base_schema_key").notNull().default("base@1"),
    extension: jsonb("extension").$type<unknown>().notNull().default({}),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    approvalId: text("approval_id"),
    proposalIds: text("proposal_ids").array().notNull().default(sql`'{}'`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type OntologySchemaVersionsRow = typeof ontologySchemaVersions.$inferSelect;
export type OntologySchemaVersionsInsert = typeof ontologySchemaVersions.$inferInsert;

/** timelines */
export const timelines = pgTable(
  "timelines",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    kind: text("kind", { enum: ENUMS.timeline_kind }).notNull().default("main"),
    label: text("label").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    parentTimelineId: text("parent_timeline_id"),
    branchStoryPoint: integer("branch_story_point"),
    rewindToStoryPoint: integer("rewind_to_story_point"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type TimelinesRow = typeof timelines.$inferSelect;
export type TimelinesInsert = typeof timelines.$inferInsert;

/** entities */
export const entities = pgTable(
  "entities",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    entityType: text("entity_type").notNull(),
    status: text("status", { enum: ENUMS.entity_status }).notNull().default("candidate"),
    preferredNameId: text("preferred_name_id"),
    mergedIntoId: text("merged_into_id"),
    confusableWithIds: text("confusable_with_ids").array().notNull().default(sql`'{}'`),
    disambiguator: text("disambiguator"),
    createdFromMentionId: text("created_from_mention_id"),
    equivalenceCheck: jsonb("equivalence_check").$type<unknown>(),
    isRealPerson: boolean("is_real_person").notNull().default(false),
    conceptCharacterKey: text("concept_character_key"),
    summary: text("summary"),
    createdByActorType: text("created_by_actor_type", { enum: ENUMS.actor_type }).notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type EntitiesRow = typeof entities.$inferSelect;
export type EntitiesInsert = typeof entities.$inferInsert;

/** entity_names */
export const entityNames = pgTable(
  "entity_names",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    entityId: text("entity_id").notNull(),
    surface: text("surface").notNull(),
    normalizedKey: text("normalized_key").notNull(),
    jamoKey: text("jamo_key").notNull(),
    translitKey: text("translit_key").notNull(),
    nameKind: text("name_kind", { enum: ENUMS.name_kind }).notNull(),
    isPreferred: boolean("is_preferred").notNull().default(false),
    status: text("status", { enum: ENUMS.entity_name_status }).notNull().default("active"),
    storyRange: int4range("story_range").notNull().default(sql`'[0,)'`),
    timelineId: text("timeline_id"),
    surfaceVisibility: text("surface_visibility", { enum: ENUMS.name_visibility }).notNull().default("public"),
    surfaceKnownByEntityIds: text("surface_known_by_entity_ids").array().notNull().default(sql`'{}'`),
    identityVisibility: text("identity_visibility", { enum: ENUMS.name_visibility }).notNull().default("public"),
    identityKnownByEntityIds: text("identity_known_by_entity_ids").array().notNull().default(sql`'{}'`),
    usedByCondition: jsonb("used_by_condition").$type<unknown>(),
    readerRevealPoint: integer("reader_reveal_point"),
    originEntityId: text("origin_entity_id"),
    forbiddenByGlossaryTermId: text("forbidden_by_glossary_term_id"),
    mergedConflictWithId: text("merged_conflict_with_id"),
    sourceKind: text("source_kind", { enum: ENUMS.fact_source_kind }).notNull(),
    sourceRefType: text("source_ref_type", { enum: ENUMS.ref_type }).notNull(),
    sourceRefId: text("source_ref_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type EntityNamesRow = typeof entityNames.$inferSelect;
export type EntityNamesInsert = typeof entityNames.$inferInsert;

/** narrative_frames */
export const narrativeFrames = pgTable(
  "narrative_frames",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    sceneId: text("scene_id").notNull(),
    manuscriptVersionId: text("manuscript_version_id").notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    frameKind: text("frame_kind", { enum: ENUMS.narrative_frame_kind }).notNull(),
    targetStoryPoint: integer("target_story_point"),
    targetTimelineId: text("target_timeline_id"),
    sourceKind: text("source_kind", { enum: ENUMS.fact_source_kind }).notNull(),
    runId: text("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type NarrativeFramesRow = typeof narrativeFrames.$inferSelect;
export type NarrativeFramesInsert = typeof narrativeFrames.$inferInsert;

/** mentions */
export const mentions = pgTable(
  "mentions",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    sourceKind: text("source_kind", { enum: ENUMS.mention_source_kind }).notNull(),
    manuscriptVersionId: text("manuscript_version_id"),
    sceneId: text("scene_id"),
    charStart: integer("char_start"),
    charEnd: integer("char_end"),
    answerId: text("answer_id"),
    storyPoint: integer("story_point").notNull(),
    timelineId: text("timeline_id").notNull(),
    narrativeFrameId: text("narrative_frame_id"),
    redirectedFromEntityId: text("redirected_from_entity_id"),
    surface: text("surface").notNull(),
    mentionKind: text("mention_kind", { enum: ENUMS.mention_kind }).notNull(),
    speakerEntityId: text("speaker_entity_id"),
    povEntityId: text("pov_entity_id"),
    chainKey: text("chain_key"),
    candidates: jsonb("candidates").$type<unknown>().notNull().default([]),
    linkedEntityId: text("linked_entity_id"),
    viaNameId: text("via_name_id"),
    viaEntityId: text("via_entity_id"),
    confidence: real("confidence"),
    rationale: text("rationale"),
    linkStatus: text("link_status", { enum: ENUMS.link_status }).notNull(),
    linkerVersion: text("linker_version").notNull(),
    questionId: text("question_id"),
    runId: text("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type MentionsRow = typeof mentions.$inferSelect;
export type MentionsInsert = typeof mentions.$inferInsert;

/** facts */
export const facts = pgTable(
  "facts",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    factKind: text("fact_kind", { enum: ENUMS.fact_kind }).notNull(),
    subjectEntityId: text("subject_entity_id"),
    predicate: text("predicate").notNull(),
    objectEntityId: text("object_entity_id"),
    objectFactId: text("object_fact_id"),
    objectNameId: text("object_name_id"),
    value: jsonb("value").$type<unknown>(),
    knowledgeStance: text("knowledge_stance", { enum: ENUMS.knowledge_stance }),
    slotKey: text("slot_key").notNull(),
    isNegation: boolean("is_negation").notNull().default(false),
    isSecret: boolean("is_secret").notNull().default(false),
    readerRevealPoint: integer("reader_reveal_point"),
    timelineId: text("timeline_id").notNull(),
    storyRange: int4range("story_range").notNull(),
    fromSceneId: text("from_scene_id"),
    toSceneId: text("to_scene_id"),
    canonStatus: text("canon_status", { enum: ENUMS.canon_status }).notNull().default("candidate"),
    currentVersionNo: integer("current_version_no").notNull().default(1),
    sourceKind: text("source_kind", { enum: ENUMS.fact_source_kind }).notNull(),
    sourceRefType: text("source_ref_type", { enum: ENUMS.ref_type }).notNull(),
    sourceRefId: text("source_ref_id").notNull(),
    sourceSceneId: text("source_scene_id"),
    mentionIds: text("mention_ids").array(),
    observedAsNameId: text("observed_as_name_id"),
    narrativeFrameId: text("narrative_frame_id"),
    schemaVersionId: text("schema_version_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type FactsRow = typeof facts.$inferSelect;
export type FactsInsert = typeof facts.$inferInsert;

/** fact_versions */
export const factVersions = pgTable(
  "fact_versions",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    factId: text("fact_id").notNull(),
    versionNo: integer("version_no").notNull(),
    content: jsonb("content").$type<unknown>().notNull(),
    canonStatus: text("canon_status", { enum: ENUMS.canon_status }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true, mode: "date" }),
    recordedByActorType: text("recorded_by_actor_type", { enum: ENUMS.actor_type }).notNull(),
    recordedByActorId: text("recorded_by_actor_id").notNull(),
    runId: text("run_id"),
    changeReason: text("change_reason", { enum: ENUMS.fact_change_reason }).notNull(),
    approvalId: text("approval_id"),
    identityDecisionId: text("identity_decision_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type FactVersionsRow = typeof factVersions.$inferSelect;
export type FactVersionsInsert = typeof factVersions.$inferInsert;

/** fact_cardinality_slots */
export const factCardinalitySlots = pgTable(
  "fact_cardinality_slots",
  {
    novelId: text("novel_id").notNull(),
    factId: text("fact_id").notNull(),
    timelineId: text("timeline_id").notNull(),
    slotKey: text("slot_key").notNull(),
    storyRange: int4range("story_range").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.novelId, t.factId, t.slotKey] })],
);
export type FactCardinalitySlotsRow = typeof factCardinalitySlots.$inferSelect;
export type FactCardinalitySlotsInsert = typeof factCardinalitySlots.$inferInsert;

/** schema_change_proposals */
export const schemaChangeProposals = pgTable(
  "schema_change_proposals",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    kind: text("kind", { enum: ENUMS.schema_change_kind }).notNull(),
    status: text("status", { enum: ENUMS.schema_change_status }).notNull().default("proposed"),
    payload: jsonb("payload").$type<unknown>().notNull(),
    examples: jsonb("examples").$type<unknown>().notNull().default([]),
    similarKeys: jsonb("similar_keys").$type<unknown>().notNull().default([]),
    mappedToKey: text("mapped_to_key"),
    questionId: text("question_id"),
    approvalId: text("approval_id"),
    resultingSchemaVersionId: text("resulting_schema_version_id"),
    proposedByActorType: text("proposed_by_actor_type", { enum: ENUMS.actor_type }).notNull(),
    proposedByActorId: text("proposed_by_actor_id").notNull(),
    decidedByActorType: text("decided_by_actor_type", { enum: ENUMS.actor_type }),
    decidedByActorId: text("decided_by_actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type SchemaChangeProposalsRow = typeof schemaChangeProposals.$inferSelect;
export type SchemaChangeProposalsInsert = typeof schemaChangeProposals.$inferInsert;

/** glossary_terms */
export const glossaryTerms = pgTable(
  "glossary_terms",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    surface: text("surface").notNull(),
    normalizedKey: text("normalized_key").notNull(),
    category: text("category").notNull(),
    definition: text("definition").notNull(),
    preferredSurface: text("preferred_surface").notNull(),
    spellingRules: jsonb("spelling_rules").$type<unknown>().notNull().default({}),
    linkedEntityId: text("linked_entity_id"),
    linkedSchemaKey: text("linked_schema_key"),
    status: text("status", { enum: ENUMS.glossary_term_status }).notNull().default("active"),
    sourceKind: text("source_kind", { enum: ENUMS.glossary_source_kind }).notNull(),
    sourceRef: text("source_ref"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type GlossaryTermsRow = typeof glossaryTerms.$inferSelect;
export type GlossaryTermsInsert = typeof glossaryTerms.$inferInsert;

/** identity_decisions */
export const identityDecisions = pgTable(
  "identity_decisions",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    kind: text("kind", { enum: ENUMS.identity_decision_kind }).notNull(),
    status: text("status", { enum: ENUMS.identity_decision_status }).notNull().default("proposed"),
    sourceEntityIds: text("source_entity_ids").array().notNull().default(sql`'{}'`),
    survivorEntityId: text("survivor_entity_id"),
    newEntityId: text("new_entity_id"),
    relinkMentionIds: text("relink_mention_ids").array().notNull().default(sql`'{}'`),
    relinkFromEntityId: text("relink_from_entity_id"),
    relinkToEntityId: text("relink_to_entity_id"),
    rationale: text("rationale"),
    evidence: jsonb("evidence").$type<unknown>().notNull().default({}),
    impact: jsonb("impact").$type<unknown>().notNull().default({}),
    questionId: text("question_id"),
    approvalId: text("approval_id"),
    proposedByActorType: text("proposed_by_actor_type", { enum: ENUMS.actor_type }).notNull(),
    proposedByActorId: text("proposed_by_actor_id").notNull(),
    decidedByActorType: text("decided_by_actor_type", { enum: ENUMS.actor_type }),
    decidedByActorId: text("decided_by_actor_id"),
    appliedAt: timestamp("applied_at", { withTimezone: true, mode: "date" }),
    revertedAt: timestamp("reverted_at", { withTimezone: true, mode: "date" }),
    revertedByActorType: text("reverted_by_actor_type", { enum: ENUMS.actor_type }),
    revertedByActorId: text("reverted_by_actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type IdentityDecisionsRow = typeof identityDecisions.$inferSelect;
export type IdentityDecisionsInsert = typeof identityDecisions.$inferInsert;

/** identity_decision_moves */
export const identityDecisionMoves = pgTable(
  "identity_decision_moves",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    decisionId: text("decision_id").notNull(),
    refTable: text("ref_table").notNull(),
    refId: text("ref_id").notNull(),
    refColumn: text("ref_column").notNull(),
    fromEntityId: text("from_entity_id").notNull(),
    toEntityId: text("to_entity_id").notNull(),
    createdFactVersionId: text("created_fact_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type IdentityDecisionMovesRow = typeof identityDecisionMoves.$inferSelect;
export type IdentityDecisionMovesInsert = typeof identityDecisionMoves.$inferInsert;

/** entity_distinct_pairs */
export const entityDistinctPairs = pgTable(
  "entity_distinct_pairs",
  {
    novelId: text("novel_id").notNull(),
    entityAId: text("entity_a_id").notNull(),
    entityBId: text("entity_b_id").notNull(),
    decisionId: text("decision_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.novelId, t.entityAId, t.entityBId] })],
);
export type EntityDistinctPairsRow = typeof entityDistinctPairs.$inferSelect;
export type EntityDistinctPairsInsert = typeof entityDistinctPairs.$inferInsert;
