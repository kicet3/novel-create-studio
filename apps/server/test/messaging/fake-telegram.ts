/** In-memory Telegram Bot API double (TelegramTransport) for messaging/hitl tests. */
import { TelegramApiError, type TelegramTransport } from "../../src/modules/messaging/index.js";

export interface FakeCall {
  token: string;
  method: string;
  params: Record<string, any>;
}

export class FakeTelegram {
  calls: FakeCall[] = [];
  /** queued getUpdates batches (each call shifts one; empty → []) */
  updateBatches: unknown[][] = [];
  /** method → errors to throw on the next calls */
  failures = new Map<string, TelegramApiError[]>();
  nextMessageId = 1000;
  nextUpdateId = 5000;
  validTokens = new Set<string>();
  username = "ncs_test_bot";

  factory = (token: string): TelegramTransport => ({
    call: async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      this.calls.push({ token, method, params: params as Record<string, any> });
      if (this.validTokens.size && !this.validTokens.has(token)) throw new TelegramApiError(401, "Unauthorized");
      const queued = this.failures.get(method);
      if (queued?.length) throw queued.shift()!;
      switch (method) {
        case "getMe":
          return { id: 42, is_bot: true, username: this.username } as T;
        case "getUpdates":
          return (this.updateBatches.shift() ?? []) as T;
        case "sendMessage":
          return { message_id: this.nextMessageId++, chat: { id: params.chat_id } } as T;
        case "getChat":
          return { id: Number(params.chat_id), type: "private" } as T;
        case "getWebhookInfo":
          return { url: "" } as T;
        default:
          return true as T;
      }
    },
  });

  fail(method: string, err: TelegramApiError, times = 1) {
    const list = this.failures.get(method) ?? [];
    for (let i = 0; i < times; i++) list.push(err);
    this.failures.set(method, list);
  }
  sent(method = "sendMessage") {
    return this.calls.filter((c) => c.method === method);
  }

  // update builders
  textUpdate(chatId: number, text: string, opts: { fromId?: number; replyTo?: number; updateId?: number } = {}) {
    return {
      update_id: opts.updateId ?? this.nextUpdateId++,
      message: {
        message_id: this.nextMessageId++,
        from: { id: opts.fromId ?? chatId, first_name: "작가" },
        chat: { id: chatId, type: "private" },
        text,
        ...(opts.replyTo ? { reply_to_message: { message_id: opts.replyTo } } : {}),
      },
    };
  }
  callbackUpdate(chatId: number, data: string, messageId: number, opts: { fromId?: number; updateId?: number; callbackId?: string } = {}) {
    return {
      update_id: opts.updateId ?? this.nextUpdateId++,
      callback_query: {
        id: opts.callbackId ?? `cb${this.nextUpdateId}`,
        from: { id: opts.fromId ?? chatId, first_name: "작가" },
        message: { message_id: messageId, chat: { id: chatId, type: "private" } },
        data,
      },
    };
  }
}
