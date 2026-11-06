/**
 * DTOs of the `world` module (설계 추가: 컨셉 승인 뒤 세계관 온톨로지 생성).
 * Paths: `…` = `/api/novels/:novelId`.
 *
 *   GET   …/world-ontology                                   → worldOntologyViewSchema
 *   POST  …/world-ontology/generate      worldGenerateRequestSchema → 202 { taskId, created }
 *   POST  …/world-ontology/approve-all                       → worldReviewResultSchema
 *   POST  …/world-ontology/items/:itemId/approve             → worldReviewResultSchema
 *   POST  …/world-ontology/items/:itemId/reject  worldRejectRequestSchema → worldReviewResultSchema
 *   PATCH …/world-ontology/items/:itemId   worldItemPatchRequestSchema → worldItemDtoSchema
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime } from "./common.js";
import { llmWebSearchStatusSchema, llmWebSourceSchema } from "./llm.js";

/** base@1 relation predicates a world candidate may use (character endpoints only for existing cast entities) */
export const WORLD_RELATION_PREDICATES = [
  "located_in",
  "headquartered_in",
  "part_of",
  "ally_of",
  "enemy_of",
  "member_of",
  "leader_of",
  "subordinate_of",
  "owns",
  "has_ability",
  "participated_in",
  "occurred_at",
] as const;
export type WorldRelationPredicate = (typeof WORLD_RELATION_PREDICATES)[number];

export const worldItemDtoSchema = z.object({
  id: z.string(),
  kind: z.enum(ENUMS.world_item_kind),
  status: z.enum(ENUMS.world_item_status),
  origin: z.enum(ENUMS.world_item_origin),
  userEdited: z.boolean(),
  fromBrief: z.boolean(),
  /** entity item: entity + its preferred name / summary; relation item: null */
  entityId: z.string().nullable(),
  entityType: z.enum(ENUMS.entity_type).nullable(),
  entityStatus: z.enum(ENUMS.entity_status).nullable(),
  name: z.string(),
  aliases: z.array(z.string()),
  summary: z.string().nullable(),
  /** the item's statement (rule_statement / ability_cost) — editable */
  statement: z.string().nullable(),
  /** other attribute lines (ability_limit …) */
  details: z.array(z.string()),
  relation: z
    .object({
      subjectEntityId: z.string().nullable(),
      subjectName: z.string(),
      predicate: z.string(),
      predicateLabel: z.string(),
      objectEntityId: z.string().nullable(),
      objectName: z.string(),
    })
    .nullable(),
  facts: z.array(z.object({ factId: z.string(), predicate: z.string(), canonStatus: z.enum(ENUMS.canon_status), text: z.string() })),
  sources: z.array(llmWebSourceSchema),
  note: z.string().nullable(),
  /** why the last approval left it pending (e.g. 양쪽 항목이 승인되지 않음) */
  heldReason: z.string().nullable(),
  taskId: z.string().nullable(),
  runId: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type WorldItemDto = z.infer<typeof worldItemDtoSchema>;

export const WORLD_GENERATION_STATES = ["none", "waiting_brief", "queued", "running", "done", "failed"] as const;
export const worldGenerationDtoSchema = z.object({
  state: z.enum(WORLD_GENERATION_STATES),
  taskId: z.string().nullable(),
  taskStatus: z.enum(ENUMS.task_status).nullable(),
  /** last finished run (done / failed) */
  finishedAt: isoDateTime.nullable(),
  error: z.string().nullable(),
  /** web search of the last finished run */
  webSearch: z.object({ status: llmWebSearchStatusSchema, requests: z.number().int(), note: z.string().nullable() }).nullable(),
  sources: z.array(llmWebSourceSchema),
  createdAt: isoDateTime.nullable(),
});
export type WorldGenerationDto = z.infer<typeof worldGenerationDtoSchema>;

export const worldOntologyViewSchema = z.object({
  briefApproved: z.boolean(),
  generation: worldGenerationDtoSchema,
  counts: z.object({ pending: z.number().int(), approved: z.number().int(), rejected: z.number().int() }),
  groups: z.array(z.object({ kind: z.enum(ENUMS.world_item_kind), items: z.array(worldItemDtoSchema) })),
});
export type WorldOntologyView = z.infer<typeof worldOntologyViewSchema>;

export const worldGenerateRequestSchema = z.object({ instructions: z.string().trim().max(2000).optional() }).default({});
export type WorldGenerateRequest = z.infer<typeof worldGenerateRequestSchema>;

export const worldRejectRequestSchema = z.object({ reason: z.string().trim().max(500).optional() }).default({});

export const worldItemPatchRequestSchema = z
  .object({
    name: z.string().trim().min(1, "이름을 입력해 주세요.").max(80).optional(),
    summary: z.string().trim().max(2000).nullable().optional(),
    statement: z.string().trim().min(1, "내용을 입력해 주세요.").max(1000).optional(),
    predicate: z.string().min(1).max(60).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "고칠 내용을 입력해 주세요.");
export type WorldItemPatchRequest = z.infer<typeof worldItemPatchRequestSchema>;

export const worldReviewResultSchema = z.object({
  approved: z.number().int(),
  rejected: z.number().int(),
  /** items that stayed pending, with a Korean reason */
  held: z.array(z.object({ itemId: z.string(), reason: z.string() })),
});
export type WorldReviewResult = z.infer<typeof worldReviewResultSchema>;
