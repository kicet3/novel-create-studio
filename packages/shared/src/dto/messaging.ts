/**
 * DTOs of the `messaging` module (05 §9). Bots are install-level (`/api/messaging/bots`); channels are
 * novel-scoped (`/api/novels/:novelId/channels`). Bot tokens are write-only (never returned).
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime } from "./common.js";

export const messagingRegisterBotRequestSchema = z.object({
  kind: z.literal("telegram"),
  label: z.string().trim().min(1).max(80),
  token: z.string().trim().min(10).max(200),
  receiveMode: z.enum(ENUMS.telegram_receive_mode).optional(),
});
export type MessagingRegisterBotRequest = z.infer<typeof messagingRegisterBotRequestSchema>;

/** MessengerBot row without secrets */
export const messagingBotDtoSchema = z.object({
  id: z.string(),
  kind: z.enum(ENUMS.channel_kind),
  label: z.string(),
  receiveMode: z.enum(ENUMS.telegram_receive_mode).nullable(),
  status: z.enum(ENUMS.channel_status),
  lastConnectedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type MessagingBotDto = z.infer<typeof messagingBotDtoSchema>;

export const messagingChannelDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  kind: z.enum(ENUMS.channel_kind),
  status: z.enum(ENUMS.channel_status),
  botId: z.string().nullable(),
  label: z.string(),
  boundAt: isoDateTime.nullable(),
  lastHealthAt: isoDateTime.nullable(),
  lastHealthStatus: z.enum(ENUMS.health_status).nullable(),
  disconnectedReason: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type MessagingChannelDto = z.infer<typeof messagingChannelDtoSchema>;

export const messagingIssueBindingRequestSchema = z.object({
  kind: z.literal("telegram"),
  botId: z.string().regex(/^bot_/),
});
export type MessagingIssueBindingRequest = z.infer<typeof messagingIssueBindingRequestSchema>;

export const messagingBindingTokenDtoSchema = z.object({
  /** plaintext, shown once (DB keeps only the hash) — user sends `/start <token>` */
  token: z.string(),
  expiresAt: isoDateTime,
  /** `https://t.me/<bot>?start=<token>` when the bot username is known */
  deepLink: z.string().nullable(),
});
export type MessagingBindingTokenDto = z.infer<typeof messagingBindingTokenDtoSchema>;
