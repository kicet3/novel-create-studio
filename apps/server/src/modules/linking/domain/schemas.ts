/** zod schemas for LLM structured outputs of the linking tasks (07 §4.3, 06 §3.8 L4, 07 B2). */
import { z } from "zod";

const mentionKind = z.enum(["named", "title", "address", "pronoun", "zero", "descriptive"]);

/** 07 §4.3 ExtractionResult */
export const extractionResultSchema = z.object({
  mentions: z
    .array(
      z.object({
        local_key: z.string().min(1),
        scene_ord: z.number().int().min(0),
        /** verbatim surface as written in the scene (without particles) */
        surface: z.string(),
        /** 설계 추가: short verbatim context (10–40 chars, one line) containing the surface — the server locates the span with it */
        quote: z.string().nullable().optional(),
        /** offsets in the scene text (0 = first char of the scene body): hints only, the server locates the span */
        char_start: z.number().int().min(0).nullable().optional(),
        char_end: z.number().int().min(0).nullable().optional(),
        mention_kind: mentionKind,
        speaker_hint: z.string().nullable().optional(),
        chain_key: z.string().nullable().optional(),
        entity_type_hint: z.string().nullable().optional(),
      }),
    )
    .default([]),
  facts: z
    .array(
      z.object({
        local_key: z.string().min(1),
        fact_kind: z.enum(["attribute", "relation", "event", "state", "knowledge", "rule", "constraint"]),
        subject_mention_key: z.string(),
        predicate: z.string().min(1),
        object_mention_key: z.string().nullable().optional(),
        value: z.unknown().optional(),
        knowledge_stance: z.enum(["knows", "suspects", "misbelieves", "unaware"]).nullable().optional(),
        scope_hint: z.enum(["point", "from_here", "flashback"]).default("from_here"),
        is_secret: z.boolean().optional(),
      }),
    )
    .default([]),
  identity_assertions: z.array(z.object({ mention_key_a: z.string(), mention_key_b: z.string(), evidence: z.string().optional() })).default([]),
  unmapped_predicates: z.array(z.object({ surface_predicate: z.string(), example_fact_key: z.string().optional() })).default([]),
  non_entity_spans: z.array(z.object({ scene_ord: z.number().int(), char_start: z.number().int(), char_end: z.number().int(), surface: z.string() })).default([]),
});
export type ExtractionResult = z.infer<typeof extractionResultSchema>;

/** L4 closed choice: a candidate handle (C1…) or NIL / NON_ENTITY / UNSURE (P-3) */
export const l4ChoiceSchema = z.object({
  choice: z.string().min(1),
  rationale: z.string().default(""),
});
export type L4Choice = z.infer<typeof l4ChoiceSchema>;

/** 07 B2 build_initial_ontology output */
export const initialOntologySchema = z.object({
  entities: z
    .array(
      z.object({
        key: z.string().min(1),
        entity_type: z.string().min(1),
        name: z.string().min(1),
        aliases: z.array(z.string()).default([]),
        disambiguator: z.string().nullable().optional(),
        summary: z.string().nullable().optional(),
        character_key: z.string().nullable().optional(),
        is_secret_identity: z.boolean().optional(),
      }),
    )
    .default([]),
  facts: z
    .array(
      z.object({
        subject_key: z.string(),
        predicate: z.string().min(1),
        object_key: z.string().nullable().optional(),
        value: z.unknown().optional(),
        from_story_point: z.number().int().min(0).default(0),
        user_stated: z.boolean().optional(),
      }),
    )
    .default([]),
});
export type InitialOntology = z.infer<typeof initialOntologySchema>;
