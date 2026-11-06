/** Shared setup: test core + fake Telegram + one bound Telegram channel. */
import { FakeClock } from "@ncs/test-kit";
import { eq } from "@ncs/db/orm";
import { channels } from "@ncs/db/schema";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { FakeTelegram } from "./fake-telegram.js";

export const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";
export const CHAT = 777001;

export interface TgEnv {
  t: TestCore;
  clock: FakeClock;
  fake: FakeTelegram;
  botId: string;
}

export async function createTgEnv(): Promise<TgEnv> {
  // 2026-11-05 12:00 KST (outside default quiet hours 23:00–08:00)
  const clock = new FakeClock("2026-11-05T03:00:00.000Z");
  const t = await createTestCore({ clock });
  const fake = new FakeTelegram();
  t.modules.messaging.service.setTelegramTransportFactory(fake.factory);
  const r = await t.http("POST", "/api/messaging/bots", { kind: "telegram", label: "테스트 봇", token: TOKEN });
  if (r.status !== 201) throw new Error(`register bot failed: ${JSON.stringify(r.body)}`);
  return { t, clock, fake, botId: r.body.id };
}

/** issue binding token via HTTP, deliver `/start <token>` via polling, process inbox+outbox */
export async function bindChat(env: TgEnv, novelId: string, chatId = CHAT) {
  const { t, fake } = env;
  const b = await t.http("POST", `/api/novels/${novelId}/channels/bindings`, { kind: "telegram", botId: env.botId });
  if (b.status !== 201) throw new Error(`binding failed: ${JSON.stringify(b.body)}`);
  fake.updateBatches.push([fake.textUpdate(chatId, `/start ${b.body.token}`)]);
  await t.modules.messaging.service.pollOnce();
  await t.modules.messaging.service.processInboxOnce();
  await flushOutbox(env);
  const [ch] = await t.testDb.db.select().from(channels).where(eq(channels.novelId, novelId));
  const all = await t.testDb.db.select().from(channels).where(eq(channels.novelId, novelId));
  return { binding: b.body, channel: all.find((c) => c.kind === "telegram")!, web: ch };
}

/** run the outbox until nothing is due, advancing the fake clock past the per-chat 1 msg/s limit */
export async function flushOutbox(env: TgEnv, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    env.clock.advance(1100);
    await env.t.modules.messaging.service.processOutboxOnce();
  }
}
