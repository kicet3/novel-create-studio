/**
 * DTOs of the `linking` module — owned by the linking module agent (see CONVENTIONS.md).
 * linking has no HTTP endpoints (the UI reads mentions through ontology); these are the shapes of the
 * disambiguation question options so web / messaging can render them consistently.
 */
import { z } from "zod";

/** option value of an `entity_disambiguation` question (hitl OPTION_VALUE_SCHEMAS) */
export const linkingDisambiguationValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entity"), entity_id: z.string() }),
  z.object({ kind: z.literal("new_entity"), entity_type: z.string().optional() }),
  z.object({ kind: z.literal("not_entity") }),
  z.object({ kind: z.literal("hold") }),
]);
export type LinkingDisambiguationValue = z.infer<typeof linkingDisambiguationValueSchema>;

/** option value of a `duplicate_entity` question */
export const linkingDuplicateValueSchema = z.object({
  kind: z.enum(["same", "distinct", "hold"]),
  identity_decision_id: z.string().optional(),
  survivor_entity_id: z.string().optional(),
});
export type LinkingDuplicateValue = z.infer<typeof linkingDuplicateValueSchema>;

/** POST /api/novels/:novelId/linking/resolve-backlog — 설계 추가 0015: 열린 엔티티 질문을 판정 에이전트가 정리하는 작업 */
export const linkingResolveBacklogResponseSchema = z.object({
  taskId: z.string(),
  /** false = 이미 진행 중인 정리 작업을 돌려줌 */
  created: z.boolean(),
  /** 정리 대상 열린 질문 수(작업을 만들 때 기준) */
  openQuestions: z.number().int(),
});
export type LinkingResolveBacklogResponse = z.infer<typeof linkingResolveBacklogResponseSchema>;

/** GET /api/novels/:novelId/linking/backlog — 설계 추가 0015: 판정 에이전트가 정리할 수 있는 열린 엔티티 질문 수 */
export const linkingBacklogDtoSchema = z.object({ openQuestions: z.number().int() });
export type LinkingBacklogDto = z.infer<typeof linkingBacklogDtoSchema>;
