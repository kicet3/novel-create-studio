import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "@ncs/db/orm";
import { channelBindingTokens, channels, messengerBots, messengerInbox, messengerOutbox } from "@ncs/db/schema";
import { TelegramApiError } from "../../src/modules/messaging/index.js";
import { decodeCallback, encodeCallback, renderQuestion } from "../../src/modules/messaging/domain/render.js";
import { CHANNEL_TRANSITIONS, findRule } from "../../src/modules/messaging/domain/transitions.js";
import { parseTelegramUpdate, toTelegramHtml } from "../../src/modules/messaging/adapters/telegram/client.js";
import { bindChat, CHAT, createTgEnv, flushOutbox, TOKEN, type TgEnv } from "./setup.js";

let env: TgEnv;
beforeAll(async () => {
  env = await createTgEnv();
});
afterAll(() => env.t.close());

describe("messaging domain", () => {
  it("encodes/decodes callback payloads within 64 bytes and rejects other versions", () => {
    const id = "qst_01JBX2Y3Z4A5B6C7D8E9F0G1H2";
    const data = encodeCallback({ action: "a", id, idx: 3 });
    expect(data).toBe(`v1|a|${id}|3`);
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    expect(decodeCallback(data)).toEqual({ ok: true, payload: { action: "a", id, idx: 3 } });
    expect(decodeCallback(`v0|a|${id}|3`)).toEqual({ ok: false, reason: "expired_version" });
    expect(decodeCallback("garbage")).toEqual({ ok: false, reason: "malformed" });
    expect(decodeCallback(`v1|a|cns_01JBX2Y3Z4A5B6C7D8E9F0G1H2|3`).ok).toBe(false);
  });

  it("channel transitions follow the CH table", () => {
    expect(findRule(CHANNEL_TRANSITIONS, "channel", "active", "degraded").id).toBe("CH3");
    expect(() => findRule(CHANNEL_TRANSITIONS, "channel", "revoked", "active")).toThrow(/바꿀 수 없습니다/);
  });

  it("renders questions with ≤ 8 buttons, recommended mark and free-text button; escapes HTML", () => {
    const view = {
      questionId: "qst_01JBX2Y3Z4A5B6C7D8E9F0G1H2",
      novelId: "nov_x",
      displayNo: "Q-1",
      grade: "blocking" as const,
      topic: "character_fate" as const,
      questionType: "single_choice" as const,
      targetLabel: "화",
      title: "C를 살릴까요?",
      body: "**중요** <b>",
      preview: [],
      recommendation: { label: "살린다", rationale: "근거" },
      blockingBasisLabel: "주요 인물 생사",
      gradeReason: "U3",
      options: [
        { optionId: "0", label: "살린다", value: { kind: "choice", key: "live" }, isRecommended: true },
        { optionId: "1", label: "죽인다", value: { kind: "choice", key: "die" }, isRecommended: false },
      ],
      allowFreeText: true,
      deadline: null,
      webUrl: "http://127.0.0.1:3100/novels/nov_x/inbox/qst_x",
    };
    const r = renderQuestion(view, "인물 운명");
    expect(r.buttons.flat().map((b) => b.label)).toEqual(["★ 살린다", "죽인다", "직접 입력"]);
    expect(r.buttons.flat()[2]!.data).toBe(`v1|t|${view.questionId}|900`);
    expect(toTelegramHtml(r.text)).toContain("<b>중요</b> &lt;b&gt;");
  });

  it("parses Telegram updates", () => {
    const u = parseTelegramUpdate({ update_id: 9, callback_query: { id: "c1", from: { id: 5 }, message: { message_id: 77, chat: { id: 5, type: "private" } }, data: "v1|a|x|0" } });
    expect(u).toMatchObject({ eventKind: "callback", senderRef: "5", chatRef: "5", messageRef: "77", callbackId: "c1" });
    expect(parseTelegramUpdate({ update_id: 10, message: { message_id: 1, chat: { id: 5, type: "group" }, text: "/help" } })).toMatchObject({ eventKind: "command", chatType: "group" });
  });
});

describe("bots, binding and polling", () => {
  it("registers a bot without exposing the token; rejects an invalid token", async () => {
    const { t } = env;
    const list = await t.http("GET", "/api/messaging/bots");
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(TOKEN);
    expect(await t.platform.uow.db.select().from(messengerBots)).toHaveLength(1);
    expect(await t.modules.system.service.secrets.get(`telegram.bot.${env.botId}`)).toBe(TOKEN);

    env.fake.fail("getMe", new TelegramApiError(401, "Unauthorized"));
    const bad = await t.http("POST", "/api/messaging/bots", { kind: "telegram", label: "x", token: "999:ZZZZZZZZZZZZZZZZZZZZZZZZZ" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("invalid_bot_token");
  });

  it("binds a chat with /start <token> (one-time, deep link), persists offset and sends confirmation", async () => {
    const { t, fake } = env;
    const novel = await t.modules.novel.service.createNovel({ title: "회귀자의 흉터" }, t.owner);
    const { binding, channel } = await bindChat(env, novel.id);
    expect(binding.deepLink).toBe(`https://t.me/ncs_test_bot?start=${binding.token}`);
    expect(binding.token).toHaveLength(32);
    expect(channel).toMatchObject({ kind: "telegram", status: "active", allowedUserRefs: [String(CHAT)] });
    expect(channel.externalChatRef).toEqual({ chatId: String(CHAT) });
    const [tok] = await t.testDb.db.select().from(channelBindingTokens).where(eq(channelBindingTokens.novelId, novel.id));
    expect(tok!.status).toBe("consumed");
    expect(tok!.tokenHash).not.toBe(binding.token);
    const confirm = fake.sent().find((c) => String(c.params.text).includes("연결됐습니다"));
    expect(confirm?.params.chat_id).toBe(String(CHAT));
    expect(confirm?.params.text).toContain("회귀자의 흉터");

    const [bot] = await t.testDb.db.select().from(messengerBots).where(eq(messengerBots.id, env.botId));
    const lastUpdateId = fake.calls.filter((c) => c.method === "getUpdates").length;
    expect(bot!.telegramUpdateOffset).toBeGreaterThan(0);
    expect(lastUpdateId).toBeGreaterThan(0);
    // next poll uses the persisted offset (TP2)
    await t.modules.messaging.service.pollOnce();
    const lastPoll = fake.calls.filter((c) => c.method === "getUpdates").at(-1)!;
    expect(lastPoll.params.offset).toBe(bot!.telegramUpdateOffset);

    // the token cannot be consumed twice (INV-BT-01)
    fake.updateBatches.push([fake.textUpdate(CHAT + 1, `/start ${binding.token}`)]);
    await t.modules.messaging.service.pollOnce();
    await t.modules.messaging.service.processInboxOnce();
    const rows = await t.testDb.db.select().from(channels).where(and(eq(channels.novelId, novel.id), eq(channels.kind, "telegram")));
    expect(rows).toHaveLength(1);

    const audit = (await t.modules.audit.service.list({ novelId: novel.id }, { actionPrefix: "channel." })).items.map((e) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["channel.binding_issued", "channel.bound"]));

    const http = await t.http("GET", `/api/novels/${novel.id}/channels`);
    expect(http.body.items.map((c: { kind: string }) => c.kind).sort()).toEqual(["telegram", "web"]);
    expect(JSON.stringify(http.body)).not.toContain(String(CHAT));
  });

  it("dedupes the same update_id (replay) and ACKs callbacks immediately", async () => {
    const { t, fake } = env;
    const u = fake.textUpdate(CHAT, "/help");
    const cb = fake.callbackUpdate(CHAT, "v0|a|qst_x|0", 1);
    fake.updateBatches.push([u, cb], [u, cb]);
    expect(await t.modules.messaging.service.pollOnce()).toBe(2);
    expect(await t.modules.messaging.service.pollOnce()).toBe(0); // replay: ON CONFLICT DO NOTHING
    const rows = await t.testDb.db.select().from(messengerInbox).where(eq(messengerInbox.providerEventId, String(u.update_id)));
    expect(rows).toHaveLength(1);
    expect(fake.sent("answerCallbackQuery").map((c) => c.params.callback_query_id)).toContain(cb.callback_query.id);
    await t.modules.messaging.service.processInboxOnce();
    const [helpRow] = await t.testDb.db.select().from(messengerInbox).where(eq(messengerInbox.id, rows[0]!.id));
    expect(helpRow!.status).toBe("processed");
    await flushOutbox(env);
    expect(fake.sent().some((c) => String(c.params.text).includes("사용법"))).toBe(true);
    expect(fake.sent().some((c) => String(c.params.text).includes("만료된 버튼"))).toBe(true);
  });

  it("ignores and audits input from a user outside the allowlist (INV-CH-02)", async () => {
    const { t, fake } = env;
    const u = fake.textUpdate(CHAT, "/help", { fromId: 999999 });
    fake.updateBatches.push([u]);
    await t.modules.messaging.service.pollOnce();
    await t.modules.messaging.service.processInboxOnce();
    const [row] = await t.testDb.db.select().from(messengerInbox).where(eq(messengerInbox.providerEventId, String(u.update_id)));
    expect(row).toMatchObject({ status: "ignored", ignoreReason: "unauthorized" });
    const ev = (await t.modules.audit.service.list({ novelId: row!.novelId! }, { actionPrefix: "channel.unauthorized" })).items;
    expect(ev).toHaveLength(1);
    // unbound chat → ignored/unbound_chat
    const v = fake.textUpdate(424242, "안녕");
    fake.updateBatches.push([v]);
    await t.modules.messaging.service.pollOnce();
    await t.modules.messaging.service.processInboxOnce();
    const [row2] = await t.testDb.db.select().from(messengerInbox).where(eq(messengerInbox.providerEventId, String(v.update_id)));
    expect(row2).toMatchObject({ status: "ignored", ignoreReason: "unbound_chat" });
  });

  it("outbox: 429 waits retry_after without counting the attempt; 5xx counts; 403 disconnects the channel", async () => {
    const { t, fake } = env;
    const novel = await t.modules.novel.service.createNovel({ title: "발신 테스트" }, t.owner);
    const { channel } = await bindChat(env, novel.id, CHAT + 50);
    const scope = { novelId: novel.id };
    fake.fail("sendMessage", new TelegramApiError(429, "Too Many Requests", 7));
    const { outboxId } = (await t.platform.uow.run((tx) => t.modules.messaging.service.sendNotice(tx, scope, { kind: "alert", channelId: channel.id, text: "알림", idempotencyKey: "alert:t1" })))!;
    env.clock.advance(1100);
    await t.modules.messaging.service.processOutboxOnce();
    let [row] = await t.testDb.db.select().from(messengerOutbox).where(eq(messengerOutbox.id, outboxId));
    expect(row).toMatchObject({ status: "retry", attemptCount: 0 });
    expect(row!.nextAttemptAt!.getTime()).toBe(env.clock.now() + 7000);
    env.clock.advance(8000);
    fake.fail("sendMessage", new TelegramApiError(502, "Bad Gateway"));
    await t.modules.messaging.service.processOutboxOnce();
    [row] = await t.testDb.db.select().from(messengerOutbox).where(eq(messengerOutbox.id, outboxId));
    expect(row).toMatchObject({ status: "retry", attemptCount: 1 });
    env.clock.advance(5000);
    await t.modules.messaging.service.processOutboxOnce();
    [row] = await t.testDb.db.select().from(messengerOutbox).where(eq(messengerOutbox.id, outboxId));
    expect(row!.status).toBe("sent");
    expect(row!.providerMessageRef).toBeTruthy();

    fake.fail("sendMessage", new TelegramApiError(403, "Forbidden: bot was blocked by the user"));
    await t.platform.uow.run((tx) => t.modules.messaging.service.sendNotice(tx, scope, { kind: "alert", channelId: channel.id, text: "알림2", idempotencyKey: "alert:t2" }));
    await flushOutbox(env, 2);
    const [ch] = await t.testDb.db.select().from(channels).where(eq(channels.id, channel.id));
    expect(ch!.status).toBe("disconnected");
    // health check restores it (CH6) once Telegram answers again
    const results = await t.modules.system.service.runHealthChecks({ kinds: ["channel_reach"], novelId: novel.id });
    expect(results.find((r) => r.name === "messaging.channel_reach")?.status).toBe("pass");
    const [ch2] = await t.testDb.db.select().from(channels).where(eq(channels.id, channel.id));
    expect(ch2!.status).toBe("active");
  });

  it("unbinds a telegram channel (CH7) but never the web channel (INV-CH-01)", async () => {
    const { t } = env;
    const novel = await t.modules.novel.service.createNovel({}, t.owner);
    const { channel, web } = await bindChat(env, novel.id, CHAT + 60);
    const r = await t.http("POST", `/api/novels/${novel.id}/channels/${channel.id}/unbind`, {});
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("revoked");
    const webCh = (await t.modules.messaging.service.listChannels({ novelId: novel.id })).find((c) => c.kind === "web")!;
    const w = await t.http("POST", `/api/novels/${novel.id}/channels/${webCh.id}/unbind`, {});
    expect(w.status).toBe(422);
    expect(web).toBeTruthy();
  });

  it("bot_token health check fails on 401 and disconnects the bot", async () => {
    const { t, fake } = env;
    fake.fail("getMe", new TelegramApiError(401, "Unauthorized"), 3);
    const results = await t.modules.system.service.runHealthChecks({ kinds: ["bot_token"] });
    expect(results.find((r) => r.name === "messaging.bot_token")?.status).toBe("fail");
    const [bot] = await t.testDb.db.select().from(messengerBots).where(eq(messengerBots.id, env.botId));
    expect(bot!.status).toBe("disconnected");
    fake.failures.clear();
    const ok = await t.modules.system.service.runHealthChecks({ kinds: ["bot_token"] });
    expect(ok.find((r) => r.name === "messaging.bot_token")?.status).toBe("pass");
  });
});
