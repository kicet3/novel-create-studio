/**
 * DTOs of the `linking` module — owned by the linking module agent (see CONVENTIONS.md).
 * linking has no HTTP endpoints (the UI reads mentions through ontology); these are the shapes of the
 * disambiguation question options so web / messaging can render them consistently.
 */
import { z } from "zod";

/** option value of an `entity_disambiguation` question (hitl OPTION_VALUE_SCHEMAS) */
export const linkingDisambiguationValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entity"), entity_id: z.string() }),
  z.object({ kind: z.literal("new_entity") }),
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
