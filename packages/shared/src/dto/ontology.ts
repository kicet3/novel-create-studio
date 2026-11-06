/**
 * DTOs of the `ontology` module — owned by the ontology module agent (see CONVENTIONS.md).
 * Request/response zod schemas for `/api/novels/:novelId/{entities,timelines,schema,identity-decisions}` (08 §9.5).
 * JSON is camelCase (drizzle row field names), timestamps ISO strings.
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime, queryInt } from "./common.js";

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)));

export const ontologyStoryRangeSchema = z.object({ from: z.number().int(), to: z.number().int().nullable() });
export type OntologyStoryRangeDto = z.infer<typeof ontologyStoryRangeSchema>;

// ── requests ─────────────────────────────────────────────────────────────
export const listEntitiesQuerySchema = z.object({
  type: csv(ENUMS.entity_type).optional(),
  status: csv(ENUMS.entity_status).optional(),
  q: z.string().max(100).optional(),
  limit: queryInt.pipe(z.number().int().min(1).max(500)).optional(),
});
export type ListEntitiesQuery = z.infer<typeof listEntitiesQuerySchema>;

export const listEntityMentionsQuerySchema = z.object({
  linkStatus: csv(ENUMS.link_status).optional(),
  limit: queryInt.pipe(z.number().int().min(1).max(2000)).optional(),
});

export const entityFactsQuerySchema = z.object({
  /** omitted → all current facts of the entity (any time) */
  storyPoint: queryInt.optional(),
  timelineId: z.string().optional(),
  include: z.enum(["canon", "canon_and_safe_candidates"]).optional(),
});

export const createEntityRequestSchema = z.object({
  entityType: z.enum(ENUMS.entity_type),
  preferredName: z.string().trim().min(1).max(100),
  nameKind: z.enum(ENUMS.name_kind).optional(),
  disambiguator: z.string().trim().max(50).nullable().optional(),
  summary: z.string().max(2000).nullable().optional(),
});
export type CreateEntityRequest = z.infer<typeof createEntityRequestSchema>;

export const addEntityNameRequestSchema = z.object({
  surface: z.string().trim().min(1).max(100),
  nameKind: z.enum(ENUMS.name_kind),
  storyRange: ontologyStoryRangeSchema.optional(),
  timelineId: z.string().nullable().optional(),
  surfaceVisibility: z.enum(ENUMS.name_visibility).optional(),
  identityVisibility: z.enum(ENUMS.name_visibility).optional(),
  identityKnownByEntityIds: z.array(z.string()).optional(),
  usedByCondition: z.unknown().optional(),
  readerRevealPoint: z.number().int().nullable().optional(),
});
export type AddEntityNameRequest = z.infer<typeof addEntityNameRequestSchema>;

export const listIdentityDecisionsQuerySchema = z.object({
  entityId: z.string().optional(),
  status: csv(ENUMS.identity_decision_status).optional(),
});

export const revertIdentityDecisionRequestSchema = z.object({ reason: z.string().max(500).optional() });

// ── responses ────────────────────────────────────────────────────────────
export const entityDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  entityType: z.string(),
  status: z.enum(ENUMS.entity_status),
  preferredNameId: z.string().nullable(),
  mergedIntoId: z.string().nullable(),
  confusableWithIds: z.array(z.string()),
  disambiguator: z.string().nullable(),
  createdFromMentionId: z.string().nullable(),
  equivalenceCheck: z.unknown().nullable(),
  isRealPerson: z.boolean(),
  conceptCharacterKey: z.string().nullable(),
  summary: z.string().nullable(),
  createdByActorType: z.enum(ENUMS.actor_type),
  createdByActorId: z.string(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type EntityDto = z.infer<typeof entityDtoSchema>;

export const entityNameDtoSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  surface: z.string(),
  normalizedKey: z.string(),
  nameKind: z.enum(ENUMS.name_kind),
  isPreferred: z.boolean(),
  status: z.enum(ENUMS.entity_name_status),
  /** int4range literal, e.g. "[0,)" */
  storyRange: z.string(),
  timelineId: z.string().nullable(),
  surfaceVisibility: z.enum(ENUMS.name_visibility),
  identityVisibility: z.enum(ENUMS.name_visibility),
  readerRevealPoint: z.number().nullable(),
  originEntityId: z.string().nullable(),
});
export type EntityNameDto = z.infer<typeof entityNameDtoSchema>;

export const entityListItemDtoSchema = z.object({
  entity: entityDtoSchema,
  preferredName: z.string(),
  appearanceEpisodeCount: z.number().int(),
  unresolvedMentionCount: z.number().int(),
});
export type EntityListItemDto = z.infer<typeof entityListItemDtoSchema>;

export const factAtAnchorDtoSchema = z.object({
  factId: z.string(),
  factVersionId: z.string(),
  canonStatus: z.enum(ENUMS.canon_status),
  factKind: z.enum(ENUMS.fact_kind),
  predicate: z.string(),
  subjectEntityId: z.string(),
  objectEntityId: z.string().nullable().optional(),
  value: z.unknown().optional(),
  text: z.string(),
  storyRange: ontologyStoryRangeSchema,
  timelineId: z.string(),
});
export type FactAtAnchorDto = z.infer<typeof factAtAnchorDtoSchema>;

export const identityDecisionDtoSchema = z.object({
  id: z.string(),
  kind: z.enum(ENUMS.identity_decision_kind),
  status: z.enum(ENUMS.identity_decision_status),
  sourceEntityIds: z.array(z.string()),
  survivorEntityId: z.string().nullable(),
  newEntityId: z.string().nullable(),
  relinkMentionIds: z.array(z.string()),
  relinkFromEntityId: z.string().nullable(),
  relinkToEntityId: z.string().nullable(),
  rationale: z.string().nullable(),
  impact: z.unknown(),
  questionId: z.string().nullable(),
  approvalId: z.string().nullable(),
  appliedAt: isoDateTime.nullable(),
  revertedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type IdentityDecisionDto = z.infer<typeof identityDecisionDtoSchema>;

export const entityDetailDtoSchema = z.object({
  entity: entityDtoSchema,
  names: z.array(entityNameDtoSchema),
  appearances: z.array(z.object({ episodeNo: z.number().int(), sceneId: z.string() })),
  titleHolders: z.array(z.object({ entityId: z.string(), storyRange: ontologyStoryRangeSchema })),
  factsSummary: z.array(factAtAnchorDtoSchema),
  identityDecisions: z.array(identityDecisionDtoSchema),
  /** set when the requested id was merged (FR-ONT-16 "옛 ID로 조회하면 새 ID로 안내") */
  redirectedFrom: z.string().nullable().optional(),
});
export type EntityDetailDto = z.infer<typeof entityDetailDtoSchema>;

/** `GET …/entities/:entityId` for a merged id → 200 `{ redirectTo }` */
export const entityRedirectDtoSchema = z.object({ redirectTo: z.string(), redirectedFrom: z.string() });

export const mentionDtoSchema = z.object({
  id: z.string(),
  sourceKind: z.enum(ENUMS.mention_source_kind),
  manuscriptVersionId: z.string().nullable(),
  sceneId: z.string().nullable(),
  charStart: z.number().nullable(),
  charEnd: z.number().nullable(),
  answerId: z.string().nullable(),
  storyPoint: z.number().int(),
  timelineId: z.string(),
  surface: z.string(),
  mentionKind: z.enum(ENUMS.mention_kind),
  speakerEntityId: z.string().nullable(),
  povEntityId: z.string().nullable(),
  chainKey: z.string().nullable(),
  candidates: z.unknown(),
  linkedEntityId: z.string().nullable(),
  viaNameId: z.string().nullable(),
  viaEntityId: z.string().nullable(),
  confidence: z.number().nullable(),
  rationale: z.string().nullable(),
  linkStatus: z.enum(ENUMS.link_status),
  linkerVersion: z.string(),
  questionId: z.string().nullable(),
  createdAt: isoDateTime,
});
export type MentionDto = z.infer<typeof mentionDtoSchema>;

export const timelineDtoSchema = z.object({
  id: z.string(),
  kind: z.enum(ENUMS.timeline_kind),
  label: z.string(),
  isDefault: z.boolean(),
  parentTimelineId: z.string().nullable(),
  branchStoryPoint: z.number().nullable(),
  rewindToStoryPoint: z.number().nullable(),
});
export type TimelineDto = z.infer<typeof timelineDtoSchema>;

export const identityImpactDtoSchema = z.object({
  mentions: z.number().int(),
  facts: z.number().int(),
  factsByStatus: z.record(z.string(), z.number()).optional(),
  names: z.number().int().optional(),
  setupLinks: z.number().int(),
  sceneParticipants: z.number().int(),
  slotConflicts: z.array(z.object({ slotKey: z.string(), factIds: z.array(z.string()) })),
  /** published_locked facts touched → identity_change approval required (FR-ONT-16) */
  requiresApproval: z.boolean(),
});
export type IdentityImpactDto = z.infer<typeof identityImpactDtoSchema>;

export const ontologySchemaDtoSchema = z.object({
  versionId: z.string(),
  versionNo: z.number().int(),
  baseSchemaKey: z.string(),
  entityTypes: z.array(z.object({ key: z.string(), labelKo: z.string(), enabled: z.boolean() }).passthrough()),
  relationTypes: z.array(z.object({ key: z.string(), labelKo: z.string() }).passthrough()),
  attributes: z.array(z.object({ key: z.string(), labelKo: z.string() }).passthrough()),
});
export type OntologySchemaDto = z.infer<typeof ontologySchemaDtoSchema>;
