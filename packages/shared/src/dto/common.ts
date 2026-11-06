/**
 * Shared DTO building blocks. API JSON is camelCase (same names as the drizzle row fields);
 * timestamps are ISO-8601 strings; money is integer micro-USD (`*Micros`, ADR-016).
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";

/** Standard error body returned by the HTTP layer. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Cursor pagination envelope. */
export const pageSchema = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export type PageDto<T> = { items: T[]; nextCursor: string | null };

export const isoDateTime = z.string();
export const idString = z.string().min(1);

/** `(actor_type, actor_id)` pair as returned by the API (03 §6.1). */
export const actorDtoSchema = z.object({
  type: z.enum(ENUMS.actor_type),
  id: z.string(),
  runId: z.string().nullable().optional(),
  /** resolved display name (user display_name, agent role label, system component label) */
  displayName: z.string().optional(),
});
export type ActorDto = z.infer<typeof actorDtoSchema>;

export const refDtoSchema = z.object({ type: z.enum(ENUMS.ref_type), id: z.string() });
export type RefDto = z.infer<typeof refDtoSchema>;

/** Query-string boolean ("true"/"false"/"1"/"0"). */
export const queryBool = z.union([z.boolean(), z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1")]);
/** Query-string integer. */
export const queryInt = z.coerce.number().int();
