// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: imaging (0005_imaging.sql).
import { bigint, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { ENUMS } from "@ncs/shared/enums";

/** image_generations — one request of the image tab (install level when novel_id is null) */
export const imageGenerations = pgTable("image_generations", {
  id: text("id").notNull().primaryKey(),
  novelId: text("novel_id"),
  provider: text("provider").notNull(),
  modelId: text("model_id").notNull(),
  credentialMethod: text("credential_method"),
  prompt: text("prompt").notNull(),
  params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
  imageCount: integer("image_count").notNull(),
  status: text("status", { enum: ENUMS.image_generation_status }).notNull().default("queued"),
  errorFamily: text("error_family"),
  errorMessage: text("error_message"),
  estimatedMicros: bigint("estimated_micros", { mode: "number" }),
  costMicros: bigint("cost_micros", { mode: "number" }),
  costBasis: text("cost_basis", { enum: ["measured", "estimated", "plan"] }),
  costEventId: text("cost_event_id"),
  revisedPrompt: text("revised_prompt"),
  providerProfileId: text("provider_profile_id"),
  requestedByActorType: text("requested_by_actor_type", { enum: ENUMS.actor_type }).notNull(),
  requestedByActorId: text("requested_by_actor_id").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
export type ImageGenerationsRow = typeof imageGenerations.$inferSelect;
export type ImageGenerationsInsert = typeof imageGenerations.$inferInsert;

/** image_assets — one stored image file of a generation */
export const imageAssets = pgTable("image_assets", {
  id: text("id").notNull().primaryKey(),
  generationId: text("generation_id").notNull(),
  novelId: text("novel_id"),
  ord: integer("ord").notNull(),
  storageKey: text("storage_key").notNull(),
  mimeType: text("mime_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: text("sha256").notNull(),
  width: integer("width"),
  height: integer("height"),
  revisedPrompt: text("revised_prompt"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
export type ImageAssetsRow = typeof imageAssets.$inferSelect;
export type ImageAssetsInsert = typeof imageAssets.$inferInsert;
