// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: messaging (design/08 §2.3).
import { bigint, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { ENUMS } from "@ncs/shared/enums";

/** messenger_bots */
export const messengerBots = pgTable(
  "messenger_bots",
  {
    id: text("id").notNull().primaryKey(),
    kind: text("kind", { enum: ENUMS.channel_kind }).notNull(),
    label: text("label").notNull(),
    tokenSecretId: text("token_secret_id").notNull(),
    receiveMode: text("receive_mode", { enum: ENUMS.telegram_receive_mode }),
    webhookSecretId: text("webhook_secret_id"),
    telegramUpdateOffset: bigint("telegram_update_offset", { mode: "number" }),
    status: text("status", { enum: ENUMS.channel_status }).notNull().default("active"),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type MessengerBotsRow = typeof messengerBots.$inferSelect;
export type MessengerBotsInsert = typeof messengerBots.$inferInsert;

/** channels */
export const channels = pgTable(
  "channels",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    kind: text("kind", { enum: ENUMS.channel_kind }).notNull(),
    status: text("status", { enum: ENUMS.channel_status }).notNull().default("pending_binding"),
    botId: text("bot_id"),
    label: text("label").notNull(),
    externalChatRef: jsonb("external_chat_ref").$type<unknown>(),
    allowedUserRefs: text("allowed_user_refs").array(),
    boundAt: timestamp("bound_at", { withTimezone: true, mode: "date" }),
    lastHealthAt: timestamp("last_health_at", { withTimezone: true, mode: "date" }),
    lastHealthStatus: text("last_health_status", { enum: ENUMS.health_status }),
    disconnectedReason: text("disconnected_reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type ChannelsRow = typeof channels.$inferSelect;
export type ChannelsInsert = typeof channels.$inferInsert;

/** channel_binding_tokens */
export const channelBindingTokens = pgTable(
  "channel_binding_tokens",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    channelKind: text("channel_kind", { enum: ENUMS.channel_kind }).notNull(),
    botId: text("bot_id"),
    tokenHash: text("token_hash").notNull(),
    status: text("status", { enum: ENUMS.binding_token_status }).notNull().default("issued"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    consumedExternalRef: text("consumed_external_ref"),
    channelId: text("channel_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type ChannelBindingTokensRow = typeof channelBindingTokens.$inferSelect;
export type ChannelBindingTokensInsert = typeof channelBindingTokens.$inferInsert;

/** messenger_inbox — novel_id filled after binding resolution (T-6) */
export const messengerInbox = pgTable(
  "messenger_inbox",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id"),
    botId: text("bot_id").notNull(),
    channelId: text("channel_id"),
    eventKind: text("event_kind", { enum: ENUMS.inbox_event_kind }).notNull(),
    providerEventId: text("provider_event_id").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status", { enum: ENUMS.inbox_status }).notNull().default("received"),
    ignoreReason: text("ignore_reason", { enum: ENUMS.inbox_ignore_reason }),
    senderExternalRef: text("sender_external_ref"),
    payload: jsonb("payload").$type<unknown>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type MessengerInboxRow = typeof messengerInbox.$inferSelect;
export type MessengerInboxInsert = typeof messengerInbox.$inferInsert;

/** messenger_outbox */
export const messengerOutbox = pgTable(
  "messenger_outbox",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    channelId: text("channel_id").notNull(),
    kind: text("kind", { enum: ENUMS.outbox_kind }).notNull(),
    status: text("status", { enum: ENUMS.outbox_status }).notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    questionId: text("question_id"),
    digestBatchId: text("digest_batch_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }),
    providerMessageRef: text("provider_message_ref"),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type MessengerOutboxRow = typeof messengerOutbox.$inferSelect;
export type MessengerOutboxInsert = typeof messengerOutbox.$inferInsert;
