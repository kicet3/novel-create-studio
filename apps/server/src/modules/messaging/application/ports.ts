/**
 * Ports of the messaging application layer (05 §9.1 `ChannelAdapter`). The Telegram implementation lives
 * in `adapters/telegram/**` (the only place that talks to api.telegram.org).
 */
import type { InboxEventKind } from "@ncs/shared";
import type { RenderedMessage } from "../domain/render.js";
export type { RenderedMessage };

/** Error thrown by a TelegramTransport (Bot API `ok:false`, HTTP failure or network failure). */
export class TelegramApiError extends Error {
  constructor(
    /** Bot API `error_code` / HTTP status; 0 = network failure before a response; -1 = timeout/abort after sending */
    readonly status: number,
    readonly description: string,
    /** `parameters.retry_after` (seconds) on 429 */
    readonly retryAfter?: number,
  ) {
    super(`telegram ${status}: ${description}`);
    this.name = "TelegramApiError";
  }
}

export type ProviderErrorKind =
  | "rate_limited"
  | "unauthorized"
  | "forbidden"
  | "bad_request"
  | "not_modified"
  | "conflict"
  | "server"
  | "network"
  | "unknown_delivery";

export function classifyTelegramError(err: unknown): { kind: ProviderErrorKind; retryAfterSec?: number; message: string } {
  if (err instanceof TelegramApiError) {
    const d = err.description ?? "";
    if (err.status === 429) return { kind: "rate_limited", retryAfterSec: err.retryAfter ?? 1, message: d };
    if (err.status === 401) return { kind: "unauthorized", message: d };
    if (err.status === 403) return { kind: "forbidden", message: d };
    if (err.status === 409) return { kind: "conflict", message: d };
    if (err.status === 400 && /message is not modified/i.test(d)) return { kind: "not_modified", message: d };
    if (err.status === 400 || err.status === 404) return { kind: "bad_request", message: d };
    if (err.status >= 500) return { kind: "server", message: d };
    if (err.status === -1) return { kind: "unknown_delivery", message: d };
    return { kind: "network", message: d };
  }
  return { kind: "network", message: err instanceof Error ? err.message : String(err) };
}

/** Provider-neutral inbound event (05 §6.1 I1/I5 input). */
export interface NormalizedInbound {
  eventKind: InboxEventKind;
  providerEventId: string;
  chatRef: string | null;
  chatType: "private" | "group" | "other" | null;
  senderRef: string | null;
  senderLabel: string | null;
  text: string | null;
  callbackId: string | null;
  callbackData: string | null;
  /** message the event belongs to (sent message id, or the message whose button was pressed) */
  messageRef: string | null;
  replyToRef: string | null;
  edited: boolean;
}


export interface OutboxPayload {
  op: "send" | "edit";
  message: RenderedMessage;
  /** edit target (question_update) */
  editRef?: string | null;
  /** reply to the delivered message of this question on the channel (resolved at send time) */
  replyToQuestionId?: string | null;
  /** edit the delivered message of this question (resolved at send time) */
  editQuestionId?: string | null;
  conceptMessageId?: string;
  conceptSessionId?: string;
}

/** Bot-level Telegram client used by the application (wraps a TelegramTransport). */
export interface TelegramClient {
  getUpdates(p: { offset: number | null; timeoutSec: number }, signal?: AbortSignal): Promise<unknown[]>;
  parseUpdate(raw: unknown): NormalizedInbound | null;
  updateId(raw: unknown): number | null;
  send(chatRef: string, msg: RenderedMessage): Promise<{ messageRef: string }>;
  edit(chatRef: string, messageRef: string, msg: RenderedMessage): Promise<void>;
  ack(callbackId: string, text?: string): Promise<void>;
  getMe(): Promise<{ id: string; username: string | null }>;
  getChat(chatRef: string): Promise<{ id: string; type: string }>;
  getWebhookUrl(): Promise<string>;
  deleteWebhook(): Promise<void>;
}

export type TelegramClientFactory = (token: string) => TelegramClient;
