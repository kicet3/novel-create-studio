/**
 * Discord bot (DM only) over the fake REST + Gateway double: token validation, invite URL, gateway identify /
 * resume / reconnect, one-time binding, allowlist, HITL buttons + free text, concept routing, 2000-char
 * splitting, 429 handling, catch-up after a fresh session, health checks. No network, no real token.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "@ncs/db/orm";
import { answers, channels, conceptMessages, conceptSessions, messengerBots, messengerInbox, messengerOutbox, questions } from "@ncs/db/schema";
import { FakeClock } from "@ncs/test-kit";
import { actors, type NovelScope } from "../../src/platform/index.js";
import { DiscordApiError, type InboundAction } from "../../src/modules/messaging/index.js";
import {
  createDiscordClient,
  DISCORD_PARTIAL_NOTICE,
  discordIdFromToken,
  normalizeDiscordText,
  parseDiscordEvent,
  splitDiscordText,
  toDiscordComponents,
} from "../../src/modules/messaging/adapters/discord/client.js";
import { classifyTelegramError } from "../../src/modules/messaging/application/ports.js";
import type { QuestionDraft } from "../../src/modules/hitl/index.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { DC_BOT_ID, DC_TOKEN, FakeDiscord } from "./fake-discord.js";

const DM = "1200000000000000100";
const USER = "1100000000000000007";

let t: TestCore;
let clock: FakeClock;
let fake: FakeDiscord;
let botId = "";
const msg = () => t.modules.messaging.service;

/** concept_message spy (the real concept handler ignores unknown sessions, then this one runs) */
const conceptSeen: InboundAction[] = [];

beforeAll(async () => {
  clock = new FakeClock("2026-11-05T03:00:00.000Z"); // 12:00 KST, outside quiet hours
  t = await createTestCore({ clock });
  fake = new FakeDiscord();
  msg().setDiscordTransportFactory(fake.factory);
  msg().registerInboundHandler({
    kinds: ["concept_message"],
    async handle(action) {
      conceptSeen.push(action);
      return { status: "processed" };
    },
  });
});
afterAll(() => t.close());

async function flushOutbox(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    clock.advance(1100);
    await msg().processOutboxOnce();
  }
}
async function inboxRow(providerEventId: string) {
  return vi.waitFor(
    async () => {
      const [r] = await t.testDb.db.select().from(messengerInbox).where(eq(messengerInbox.providerEventId, providerEventId));
      if (!r) throw new Error(`not recorded yet: ${providerEventId}`);
      return r;
    },
    { timeout: 3000, interval: 10 },
  );
}
/** deliver a DM over the gateway and process it */
async function sendDm(content: string, opts: { channel?: string; user?: string; replyTo?: string } = {}) {
  const m = fake.dm(opts.channel ?? DM, opts.user ?? USER, content, { replyTo: opts.replyTo });
  fake.dispatch("MESSAGE_CREATE", m);
  await inboxRow(m.id);
  await msg().processInboxOnce();
  return (await t.testDb.db.select().from(messengerInbox).where(eq(messengerInbox.providerEventId, m.id)))[0]!;
}
async function click(customId: string, messageId: string, user = USER) {
  const i = fake.click(DM, user, customId, messageId);
  fake.dispatch("INTERACTION_CREATE", i);
  await inboxRow(i.id);
  await msg().processInboxOnce();
  return i;
}
const lastPostTo = (channelId: string, contains?: string) =>
  fake.calls.filter((c) => c.method === "POST" && c.path === `/channels/${channelId}/messages` && (!contains || String(c.body.content).includes(contains))).at(-1);

describe("discord adapter (pure)", () => {
  it("splits long text at boundaries into ≤ 2000-char chunks", () => {
    const text = Array.from({ length: 60 }, (_, i) => `${i}번째 문단 `.repeat(10)).join("\n\n");
    const parts = splitDiscordText(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 2000)).toBe(true);
    expect(parts.join("").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
    expect(splitDiscordText("짧은 글")).toEqual(["짧은 글"]);
  });

  it("never splits a surrogate pair, keeps indentation, closes/reopens code fences across parts", () => {
    const emoji = splitDiscordText(`${"가".repeat(1999)}😀${"나".repeat(100)}`);
    for (const p of emoji) {
      expect(p.length).toBeLessThanOrEqual(2000);
      expect(/[\uD800-\uDBFF]$/.test(p)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(p)).toBe(false);
    }
    expect(emoji.join("")).toBe(`${"가".repeat(1999)}😀${"나".repeat(100)}`);

    const indented = splitDiscordText(`${"a".repeat(1500)}\n    들여쓴 줄 ${"b".repeat(600)}`);
    expect(indented[1]!.startsWith("    들여쓴 줄")).toBe(true);

    const code = "설명\n```ts\n" + Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n```\n끝";
    const parts = splitDiscordText(code);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(2000);
      expect((p.split("```").length - 1) % 2).toBe(0); // every part is balanced
    }
    expect(parts[1]!.startsWith("```ts\n")).toBe(true);
  });

  it("`!` + an ASCII word is a command; other `!` text stays a message", () => {
    expect(normalizeDiscordText("!help")).toBe("/help");
    expect(normalizeDiscordText("!start abcdefghijklmnopqrstuvwxyz")).toBe("/start abcdefghijklmnopqrstuvwxyz");
    expect(normalizeDiscordText("!중요한 메모입니다")).toBe("!중요한 메모입니다");
    expect(normalizeDiscordText("!!!")).toBe("!!!");
    expect(parseDiscordEvent({ t: "MESSAGE_CREATE", d: { id: "9", channel_id: "5", author: { id: "7" }, content: "!중요한 메모" } })?.eventKind).toBe("message");
  });

  it("edit() replaces the last part of a split message with the last part of the new text", async () => {
    const f = new FakeDiscord();
    const client = createDiscordClient(f.rest(DC_TOKEN));
    const text = "질문 ".repeat(1000).trim() + "\n\n✓ 답변이 채택됐습니다";
    await client.edit(DM, "1400000000000000999", { text, buttons: [] });
    const patch = f.calls.find((c) => c.method === "PATCH")!;
    const parts = splitDiscordText(text);
    expect(parts.length).toBe(2);
    expect(patch.body.content).toBe(parts[1]);
    expect(patch.body.content).toContain("답변이 채택됐습니다");
  });

  it("a button whose custom_id exceeds 100 chars is listed as text instead of being dropped", () => {
    const { components, overflow } = toDiscordComponents([[{ label: "정상", data: "v1|a|q|0" }], [{ label: "너무 긴 값", data: `v1|a|${"x".repeat(120)}|1` }]]);
    expect((components as any[]).flatMap((r) => r.components).map((b) => b.label)).toEqual(["정상"]);
    expect(overflow).toEqual(["너무 긴 값"]);
  });

  it("packs buttons into ≤ 5 action rows × 5; overflow becomes text; ★ = primary", () => {
    const rows = Array.from({ length: 8 }, (_, i) => [{ label: i === 0 ? "★ 추천" : `옵션 ${i}`, data: `v1|a|qst_x|${i}` }]);
    const { components, overflow } = toDiscordComponents([...rows, [{ label: "직접 입력", data: "v1|t|qst_x|900" }]]);
    expect(components).toHaveLength(2);
    expect((components as any[]).every((r) => r.type === 1 && r.components.length <= 5)).toBe(true);
    expect((components as any[])[0].components[0]).toMatchObject({ type: 2, style: 1, custom_id: "v1|a|qst_x|0" });
    expect(overflow).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => [{ label: `L${i}`, data: `v1|a|qst_x|${i}` }]);
    expect(toDiscordComponents(many).overflow).toHaveLength(5);
  });

  it("parses Gateway dispatches; `!help` / `start <code>` are commands", () => {
    expect(parseDiscordEvent({ t: "MESSAGE_CREATE", d: { id: "9", channel_id: "5", author: { id: "7" }, content: "!help" } })).toMatchObject({
      eventKind: "command",
      text: "/help",
      chatRef: "5",
      chatType: "private",
      senderRef: "7",
    });
    expect(parseDiscordEvent({ t: "MESSAGE_CREATE", d: { id: "9", channel_id: "5", author: { id: "7" }, content: "start abcdefghijklmnopqrstuvwxyz" } })?.text).toBe("/start abcdefghijklmnopqrstuvwxyz");
    expect(parseDiscordEvent({ t: "MESSAGE_CREATE", d: { id: "9", channel_id: "5", guild_id: "1", author: { id: "7" }, content: "hi" } })?.chatType).toBe("group");
    expect(parseDiscordEvent({ t: "INTERACTION_CREATE", d: { id: "3", type: 3, channel_id: "5", user: { id: "7" }, message: { id: "88" }, data: { custom_id: "v1|a|x|0" } } })).toMatchObject({
      eventKind: "callback",
      callbackData: "v1|a|x|0",
      messageRef: "88",
    });
    expect(discordIdFromToken(DC_TOKEN)).toBe(DC_BOT_ID);
    expect(classifyTelegramError(new DiscordApiError(429, "rate", 0.3))).toMatchObject({ kind: "rate_limited", retryAfterSec: 1 });
    expect(classifyTelegramError(new DiscordApiError(403, "Cannot send messages to this user", undefined, 50007)).kind).toBe("forbidden");
  });
});

describe("discord bot", () => {
  it("validates the token (format + GET /users/@me) and never returns it; shows the invite URL", async () => {
    const badFormat = await t.http("POST", "/api/messaging/bots", { kind: "discord", label: "x", token: "not-a-discord-token" });
    expect(badFormat.status).toBe(422);
    expect(badFormat.body.error.code).toBe("invalid_bot_token");
    const revoked = `${Buffer.from("1300000000000000999").toString("base64url")}.GfAkE0.${"y".repeat(27)}`;
    const bad = await t.http("POST", "/api/messaging/bots", { kind: "discord", label: "x", token: revoked });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("invalid_bot_token");

    const r = await t.http("POST", "/api/messaging/bots", { kind: "discord", label: "디스코드 봇", token: `Bot ${DC_TOKEN}` });
    expect(r.status).toBe(201);
    botId = r.body.id;
    expect(r.body).toMatchObject({ kind: "discord", receiveMode: null, status: "active", username: "ncs_discord_bot" });
    expect(r.body.inviteUrl).toBe(`https://discord.com/oauth2/authorize?client_id=${DC_BOT_ID}&scope=bot+applications.commands&permissions=0`);
    expect(fake.calls.some((c) => c.path === "/users/@me" && c.token === DC_TOKEN)).toBe(true);
    const list = await t.http("GET", "/api/messaging/bots");
    expect(JSON.stringify(list.body)).not.toContain(DC_TOKEN);
    expect(list.body.items.find((b: any) => b.id === botId).inviteUrl).toContain(DC_BOT_ID);
    expect(await t.modules.system.service.secrets.get(`discord.bot.${botId}`)).toBe(DC_TOKEN);
  });

  it("rejects registering the same Discord bot twice (two Gateway sessions would fight over the DM)", async () => {
    const dup = await t.http("POST", "/api/messaging/bots", { kind: "discord", label: "중복", token: DC_TOKEN });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("bot_already_registered");
    expect(JSON.stringify(dup.body)).not.toContain(DC_TOKEN);
    const list = await t.http("GET", "/api/messaging/bots");
    expect(list.body.items.filter((b: any) => b.kind === "discord")).toHaveLength(1);
  });

  it("connects the Gateway: GET /gateway/bot → identify with DIRECT_MESSAGES → READY", async () => {
    await msg().syncDiscordGateways();
    await vi.waitFor(() => expect(fake.socket?.sent.some((f) => f.op === 2)).toBe(true), { timeout: 2000, interval: 5 });
    expect(fake.socket.url).toBe("wss://gateway.fake/?v=10&encoding=json");
    const identify = fake.socket.sent.find((f) => f.op === 2)!;
    expect(identify.d).toMatchObject({ token: DC_TOKEN, intents: 1 << 12 });
    await vi.waitFor(
      async () => {
        const [b] = await t.testDb.db.select().from(messengerBots).where(eq(messengerBots.id, botId));
        expect(b!.lastConnectedAt).not.toBeNull();
      },
      { timeout: 2000, interval: 10 },
    );
    expect(await msg().syncDiscordGateways()).toBe(1); // idempotent: still one connection
    expect(fake.sockets).toHaveLength(1);
  });

  let novelId = "";
  let channelId = "";
  it("binds the DM with a one-time `/start <token>` and confirms in the DM", async () => {
    const novel = await t.modules.novel.service.createNovel({ title: "디스코드 연재" }, t.owner);
    novelId = novel.id;
    const b = await t.http("POST", `/api/novels/${novelId}/channels/bindings`, { kind: "discord", botId });
    expect(b.status).toBe(201);
    expect(b.body.deepLink).toBe(`https://discord.com/users/${DC_BOT_ID}`);
    // wrong kind for the bot → 404
    expect((await t.http("POST", `/api/novels/${novelId}/channels/bindings`, { kind: "telegram", botId })).status).toBe(404);
    const row = await sendDm(`/start ${b.body.token}`);
    expect(row.status).toBe("processed");
    await flushOutbox();
    const [ch] = await t.testDb.db.select().from(channels).where(and(eq(channels.novelId, novelId), eq(channels.kind, "discord")));
    expect(ch).toMatchObject({ status: "active", botId, allowedUserRefs: [USER], label: "작가" });
    expect(ch!.externalChatRef).toEqual({ chatId: DM, userId: USER });
    channelId = ch!.id;
    const confirm = lastPostTo(DM, "연결됐습니다")!;
    expect(confirm.body.content).toContain("디스코드 연재");
    expect(confirm.body.content).toContain("!help");
    expect(confirm.body.allowed_mentions).toEqual({ parse: [] });
    // one-time: the same code again from another DM does not bind
    await sendDm(`/start ${b.body.token}`, { channel: "1200000000000000200", user: "1100000000000000008" });
    expect(await t.testDb.db.select().from(channels).where(and(eq(channels.novelId, novelId), eq(channels.kind, "discord")))).toHaveLength(1);
    const http = await t.http("GET", `/api/novels/${novelId}/channels`);
    expect(http.body.items.map((c: { kind: string }) => c.kind).sort()).toEqual(["discord", "web"]);
    expect(JSON.stringify(http.body)).not.toContain(DM);
  });

  it("accepts only the bound user: other DMs are unbound, foreign authors unauthorized, bot/guild messages dropped", async () => {
    const other = await sendDm("안녕", { channel: "1200000000000000300", user: "1100000000000000009" });
    expect(other).toMatchObject({ status: "ignored", ignoreReason: "unbound_chat" });
    expect(lastPostTo("1200000000000000300")?.body.content).toContain("연결되지 않았습니다");
    // repeated DMs from an unbound chat get the notice at most once per 10 minutes (no reply flood / 429)
    const noticesBefore = fake.sent(/1200000000000000300/).length;
    expect((await sendDm("또 안녕", { channel: "1200000000000000300", user: "1100000000000000009" })).ignoreReason).toBe("unbound_chat");
    expect(fake.sent(/1200000000000000300/).length).toBe(noticesBefore);
    const foreign = await sendDm("!help", { user: "1100000000000000010" });
    expect(foreign).toMatchObject({ status: "ignored", ignoreReason: "unauthorized" });
    expect((await t.modules.audit.service.list({ novelId }, { actionPrefix: "channel.unauthorized" })).items).toHaveLength(1);

    const own = fake.dm(DM, DC_BOT_ID, "봇 자신의 메시지", { bot: true });
    const guild = { ...fake.dm(DM, USER, "서버 메시지"), guild_id: "1000000000000000001" };
    fake.dispatch("MESSAGE_CREATE", own);
    fake.dispatch("MESSAGE_CREATE", guild);
    const help = await sendDm("!help");
    expect(help.status).toBe("processed");
    const ids = (await t.testDb.db.select().from(messengerInbox)).map((r) => r.providerEventId);
    expect(ids).not.toContain(own.id);
    expect(ids).not.toContain(guild.id);
    await flushOutbox();
    expect(lastPostTo(DM, "사용법")).toBeTruthy();
  });

  const hitl = () => t.modules.hitl.service;
  const draft = (scope: NovelScope, over: Partial<QuestionDraft> = {}): QuestionDraft => ({
    topic: "character_fate",
    gradeHints: { majorCharacterFate: true },
    questionType: "single_choice",
    title: "조연 이름을 고르세요",
    body: "12화에 나올 조연의 이름입니다.",
    options: [
      { label: "윤서", value: { kind: "choice", key: "a" }, isRecommended: true },
      { label: "하린", value: { kind: "choice", key: "b" } },
    ],
    links: [{ type: "novel", id: scope.novelId }],
    ...over,
  });

  it("delivers a question with buttons; a click is ACKed (type 6), answered once and the message edited", async () => {
    const scope = { novelId };
    const r = await t.platform.uow.run((tx) => hitl().createQuestion(tx, scope, draft(scope, { title: "버튼 질문" }), { createdBy: t.owner }));
    await hitl().runDispatcherOnce();
    await flushOutbox();
    const post = lastPostTo(DM, "버튼 질문")!;
    const ids = post.body.components.flatMap((row: any) => row.components.map((b: any) => b.custom_id));
    expect(ids).toContain(`v1|a|${r.questionId}|1`);
    expect(post.body.components[0].components[0]).toMatchObject({ style: 1, label: "★ 윤서" });
    const [ob] = await t.testDb.db.select().from(messengerOutbox).where(and(eq(messengerOutbox.questionId, r.questionId), eq(messengerOutbox.kind, "question")));
    expect(ob).toMatchObject({ status: "sent", channelId });

    const i = await click(`v1|a|${r.questionId}|1`, ob!.providerMessageRef!);
    const ack = fake.calls.find((c) => c.path === `/interactions/${i.id}/interaction-token-secret/callback`)!;
    expect(ack.body).toEqual({ type: 6 });
    const [row] = await t.testDb.db.select().from(messengerInbox).where(eq(messengerInbox.providerEventId, i.id));
    expect(JSON.stringify(row!.payload)).not.toContain("interaction-token-secret"); // short-lived credential not stored
    expect(row!.status).toBe("processed");
    // the same interaction replayed (resume) is deduped
    fake.dispatch("INTERACTION_CREATE", i);
    await click(`v1|a|${r.questionId}|1`, ob!.providerMessageRef!); // second press = new interaction
    const rows = await t.testDb.db.select().from(answers).where(eq(answers.questionId, r.questionId));
    expect(rows.map((a) => a.disposition).sort()).toEqual(["accepted", "duplicate"]);
    const [q] = await t.testDb.db.select().from(questions).where(eq(questions.id, r.questionId));
    expect(q!.status).toBe("resolved");
    await flushOutbox();
    const edit = fake.calls.find((c) => c.method === "PATCH" && c.path === `/channels/${DM}/messages/${ob!.providerMessageRef}`)!;
    expect(edit.body.content).toContain("선택: 하린");
    expect(edit.body.components).toEqual([]);
  });

  it("free text: [직접 입력] then a plain DM (no ForceReply on Discord) becomes the answer", async () => {
    const scope = { novelId };
    const r = await t.platform.uow.run((tx) => hitl().createQuestion(tx, scope, draft(scope, { title: "서술형 질문", allowFreeText: true }), { createdBy: t.owner }));
    await hitl().runDispatcherOnce();
    await flushOutbox();
    const [ob] = await t.testDb.db.select().from(messengerOutbox).where(and(eq(messengerOutbox.questionId, r.questionId), eq(messengerOutbox.kind, "question")));
    await click(`v1|t|${r.questionId}|900`, ob!.providerMessageRef!);
    await flushOutbox();
    expect(lastPostTo(DM, "답장으로")).toBeTruthy();
    await sendDm("둘 다 아니고 섭정 윤씨로 해 줘");
    const [ans] = await t.testDb.db.select().from(answers).where(eq(answers.questionId, r.questionId));
    expect(ans!.payload).toMatchObject({ text: "둘 다 아니고 섭정 윤씨로 해 줘" });
  });

  it("routes plain DMs and concept option buttons to concept_message like Telegram", async () => {
    conceptSeen.length = 0;
    // a second novel bound to the same DM (newest binding wins for plain text) without open questions
    const n2 = await t.modules.novel.service.createNovel({ title: "컨셉 대화" }, t.owner);
    const b = await t.http("POST", `/api/novels/${n2.id}/channels/bindings`, { kind: "discord", botId });
    await sendDm(`start ${b.body.token}`); // bare `start <code>` works too
    await flushOutbox();
    const [c2] = await t.testDb.db.select().from(channels).where(and(eq(channels.novelId, n2.id), eq(channels.kind, "discord")));
    expect(c2!.status).toBe("active");
    const conceptChannel = c2!.id;
    // plain DM → the novel's open concept session (real concept handler), which now answers on this channel
    const inb = await sendDm("주인공은 복수를 원해");
    expect(inb.status).toBe("processed");
    const [cm] = await t.testDb.db.select().from(conceptMessages).where(eq(conceptMessages.inboxId, inb.id));
    expect(cm).toMatchObject({ novelId: n2.id, channelId: conceptChannel, body: "주인공은 복수를 원해", authorKind: "user" });
    const [sess] = await t.testDb.db.select().from(conceptSessions).where(eq(conceptSessions.id, cm!.sessionId));
    expect(sess!.activeChannelId).toBe(conceptChannel);
    // option buttons / replies of a concept message carry its session id (spy session: unknown to concept)
    const cns = "cns_01JBX2Y3Z4A5B6C7D8E9F0G1H2";
    await t.platform.uow.run((tx) =>
      msg().sendConceptMessage(tx, { novelId: n2.id }, { channelId: conceptChannel, conceptMessageId: "cnm_test_1", text: "누구에게 복수하나요?", conceptSessionId: cns, options: [{ label: "배신자", value: "1" }, { label: "직접 입력", value: "900" }] }),
    );
    await flushOutbox();
    const post = lastPostTo(DM, "누구에게 복수하나요?")!;
    expect(post.body.components[0].components.map((b: any) => b.custom_id)).toEqual([`v1|c|${cns}|1`, `v1|c|${cns}|900`]);
    const [ob] = await t.testDb.db.select().from(messengerOutbox).where(eq(messengerOutbox.idempotencyKey, `concept_message:cnm_test_1:${conceptChannel}:1`));
    await click(`v1|c|${cns}|1`, ob!.providerMessageRef!);
    expect(conceptSeen.at(-1)).toMatchObject({ kind: "concept_message", conceptSessionId: cns, optionValue: "1" });
    // a reply to the concept message carries its session id
    await sendDm("배신한 사형", { replyTo: ob!.providerMessageRef! });
    expect(conceptSeen.at(-1)).toMatchObject({ kind: "concept_message", conceptSessionId: cns, text: "배신한 사형" });
  });

  it("splits long messages into ≤ 2000-char posts (buttons on the last) and handles 429 retry_after", async () => {
    const scope = { novelId };
    const long = Array.from({ length: 40 }, (_, i) => `문단 ${i} `.repeat(15)).join("\n\n");
    const before = fake.sent().length;
    const { outboxId } = (await t.platform.uow.run((tx) =>
      msg().sendNotice(tx, scope, { kind: "alert", channelId, text: long, idempotencyKey: "alert:dc-long", buttons: [{ label: "보기", value: "v1|t|qst_01JBX2Y3Z4A5B6C7D8E9F0G1H2|900" }] }),
    ))!;
    await flushOutbox(1);
    const posts = fake.sent().slice(before);
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts.every((p) => p.body.content.length <= 2000)).toBe(true);
    expect(posts.slice(0, -1).every((p) => !p.body.components)).toBe(true);
    expect(posts.at(-1)!.body.components).toHaveLength(1);
    const [row] = await t.testDb.db.select().from(messengerOutbox).where(eq(messengerOutbox.id, outboxId));
    expect(row!.status).toBe("sent");

    // 429 on the first part: the whole bot pauses retry_after, attempt not counted
    await flushOutbox();
    fake.failures.push({ match: `POST /channels/${DM}/messages`, err: new DiscordApiError(429, "You are being rate limited.", 2.5) });
    const n = (await t.platform.uow.run((tx) => msg().sendNotice(tx, scope, { kind: "alert", channelId, text: "알림", idempotencyKey: "alert:dc-429" })))!;
    clock.advance(1100);
    await msg().processOutboxOnce();
    let [r2] = await t.testDb.db.select().from(messengerOutbox).where(eq(messengerOutbox.id, n.outboxId));
    expect(r2).toMatchObject({ status: "retry", attemptCount: 0 });
    expect(r2!.nextAttemptAt!.getTime()).toBe(clock.now() + 3000);
    clock.advance(3100);
    await msg().processOutboxOnce();
    [r2] = await t.testDb.db.select().from(messengerOutbox).where(eq(messengerOutbox.id, n.outboxId));
    expect(r2!.status).toBe("sent");

    // 429 in the middle of a split message is waited out inside the send (no duplicate first part)
    const before2 = fake.sent().length;
    const m3 = (await t.platform.uow.run((tx) => msg().sendNotice(tx, scope, { kind: "alert", channelId, text: long, idempotencyKey: "alert:dc-mid429" })))!;
    const origRequest = fake.rest;
    let posts3 = 0;
    msg().setDiscordTransportFactory({
      ...fake.factory,
      rest: (token) => {
        const inner = origRequest(token);
        return {
          request: async (method, path, body, o) => {
            if (method === "POST" && path === `/channels/${DM}/messages` && ++posts3 === 2) throw new DiscordApiError(429, "slow down", 0.01);
            return inner.request(method, path, body, o);
          },
        };
      },
    });
    clock.advance(1100);
    await msg().processOutboxOnce();
    const [r3] = await t.testDb.db.select().from(messengerOutbox).where(eq(messengerOutbox.id, m3.outboxId));
    expect(r3!.status).toBe("sent");
    expect(fake.sent().length - before2).toBe(posts3 - 1); // every part exactly once
    msg().setDiscordTransportFactory(fake.factory);
    const sessions = fake.sessions;
    await msg().syncDiscordGateways();
    await vi.waitFor(() => expect(fake.sessions).toBe(sessions + 1), { timeout: 2000, interval: 5 }); // new connection identified
  });

  it("a long 429 in the middle of a split message resumes at the failed part later (no duplicates, buttons kept)", async () => {
    const scope = { novelId };
    await flushOutbox();
    const long = Array.from({ length: 40 }, (_, i) => `문단 ${i} `.repeat(15)).join("\n\n");
    const parts = splitDiscordText(long);
    const before = fake.sent().length;
    const origRest = fake.rest;
    let posts = 0;
    msg().setDiscordTransportFactory({
      ...fake.factory,
      rest: (token) => {
        const inner = origRest(token);
        return {
          request: async (method, path, body, o) => {
            if (method === "POST" && path === `/channels/${DM}/messages` && ++posts === 2) throw new DiscordApiError(429, "slow down", 30);
            return inner.request(method, path, body, o);
          },
        };
      },
    });
    const n = (await t.platform.uow.run((tx) =>
      msg().sendNotice(tx, scope, { kind: "alert", channelId, text: long, idempotencyKey: "alert:dc-long429", buttons: [{ label: "보기", value: "v1|t|qst_01JBX2Y3Z4A5B6C7D8E9F0G1H2|901" }] }),
    ))!;
    clock.advance(1100);
    await msg().processOutboxOnce();
    let [row] = await t.testDb.db.select().from(messengerOutbox).where(eq(messengerOutbox.id, n.outboxId));
    expect(row).toMatchObject({ status: "retry", attemptCount: 0 });
    expect((row!.payload as any).message.resumeFromPart).toBe(1);
    expect(row!.nextAttemptAt!.getTime()).toBe(clock.now() + 30_000);
    clock.advance(31_000);
    await msg().processOutboxOnce();
    [row] = await t.testDb.db.select().from(messengerOutbox).where(eq(messengerOutbox.id, n.outboxId));
    expect(row!.status).toBe("sent");
    const sent = fake.sent().slice(before);
    expect(sent.map((p) => p.body.content)).toEqual(parts); // every part exactly once, in order
    expect(sent.at(-1)!.body.components).toHaveLength(1);
    expect(sent.some((p) => p.body.content === DISCORD_PARTIAL_NOTICE)).toBe(false);

    // unknown outcome (5xx) mid-message: no resume, but the user is told where to answer
    posts = 0;
    msg().setDiscordTransportFactory({
      ...fake.factory,
      rest: (token) => {
        const inner = origRest(token);
        return {
          request: async (method, path, body, o) => {
            if (method === "POST" && path === `/channels/${DM}/messages` && ++posts === 2) throw new DiscordApiError(502, "bad gateway");
            return inner.request(method, path, body, o);
          },
        };
      },
    });
    const before2 = fake.sent().length;
    const m2 = (await t.platform.uow.run((tx) => msg().sendNotice(tx, scope, { kind: "alert", channelId, text: long, idempotencyKey: "alert:dc-long502" })))!;
    clock.advance(1100);
    await msg().processOutboxOnce();
    const [r2] = await t.testDb.db.select().from(messengerOutbox).where(eq(messengerOutbox.id, m2.outboxId));
    expect(r2!.status).toBe("delivery_unknown");
    expect(fake.sent().slice(before2).at(-1)!.body.content).toBe(DISCORD_PARTIAL_NOTICE);

    msg().setDiscordTransportFactory(fake.factory);
    const sessions = fake.sessions;
    await msg().syncDiscordGateways();
    await vi.waitFor(() => expect(fake.sessions).toBe(sessions + 1), { timeout: 2000, interval: 5 });
  });

  it("reconnects: server close → resume on resume_gateway_url; Reconnect(7); zombie heartbeat; invalid session → identify + catch-up", async () => {
    await vi.waitFor(() => expect(fake.socket.closed === null && fake.socket.sent.some((f) => f.op === 2)).toBe(true), { timeout: 2000, interval: 5 });
    // a dispatch establishes seq
    const first = await sendDm("!help");
    expect(first.status).toBe("processed");
    const n0 = fake.sockets.length;
    fake.socket.serverClose(4000, "unknown error");
    await vi.waitFor(() => expect(fake.sockets.length).toBe(n0 + 1), { timeout: 2000, interval: 5 });
    await vi.waitFor(() => expect(fake.socket.sent.some((f) => f.op === 6)).toBe(true), { timeout: 2000, interval: 5 });
    expect(fake.socket.url).toBe("wss://resume.fake/?v=10&encoding=json");
    const resume = fake.socket.sent.find((f) => f.op === 6)!;
    expect(resume.d).toMatchObject({ token: DC_TOKEN, session_id: expect.stringMatching(/^sess/), seq: expect.any(Number) });
    expect((await sendDm("!help")).status).toBe("processed"); // events flow on the resumed session

    // op 7 Reconnect
    fake.socket.push({ op: 7, d: null });
    await vi.waitFor(() => expect(fake.sockets.length).toBe(n0 + 2), { timeout: 2000, interval: 5 });
    expect(fake.sockets.at(-2)!.closed?.code).toBe(4900);

    // zombie: heartbeats are never ACKed → close + resume
    fake.ackHeartbeats = false;
    fake.heartbeatInterval = 30;
    fake.socket.push({ op: 7, d: null });
    await vi.waitFor(() => expect(fake.sockets.some((s) => s.closed?.reason === "heartbeat timeout")).toBe(true), { timeout: 3000, interval: 5 });
    fake.ackHeartbeats = true;
    fake.heartbeatInterval = 60_000;
    await vi.waitFor(() => expect(fake.socket.closed).toBeNull(), { timeout: 2000, interval: 5 });
    await vi.waitFor(() => expect(fake.socket.sent.some((f) => f.op === 6)).toBe(true), { timeout: 2000, interval: 5 });

    // invalid session (not resumable) → fresh identify → READY → catch-up of DMs sent meanwhile
    const missed = fake.dm(DM, USER, "꺼져 있는 동안 보낸 메시지");
    fake.history.set(DM, [missed]);
    const sessionsBefore = fake.sessions;
    fake.socket.push({ op: 9, d: false });
    await vi.waitFor(() => expect(fake.sessions).toBe(sessionsBefore + 1), { timeout: 2000, interval: 5 });
    const row = await inboxRow(missed.id);
    expect(row.botId).toBe(botId);
    await msg().processInboxOnce();
    expect(fake.calls.some((c) => c.method === "GET" && c.path.startsWith(`/channels/${DM}/messages?after=`))).toBe(true);

    // more than one page (50) of missed DMs is paged through, not truncated
    const lots = Array.from({ length: 60 }, (_, i) => fake.dm(DM, USER, `밀린 메시지 ${i}`));
    fake.history.set(DM, lots);
    const s2 = fake.sessions;
    fake.socket.push({ op: 9, d: false });
    await vi.waitFor(() => expect(fake.sessions).toBe(s2 + 1), { timeout: 2000, interval: 5 });
    await inboxRow(lots.at(-1)!.id);
    // both pages were fetched by the catch-up of this one session
    const pageCalls = fake.calls.filter((c) => c.path.startsWith(`/channels/${DM}/messages?after=`) && c.session === s2 + 1);
    expect(pageCalls.some((c) => c.path.includes(`after=${lots[49]!.id}&`))).toBe(true);
    const recorded = new Set((await t.testDb.db.select().from(messengerInbox)).map((r) => r.providerEventId));
    expect(lots.every((m) => recorded.has(m.id))).toBe(true);
    for (let i = 0; i < 70 && (await msg().processInboxOnce()); i++);
    fake.history.delete(DM);
  });

  it("health checks: bot_token + channel_reach pass; 4014 (privileged intent) degrades and is reported; restart restores", async () => {
    let res = await t.modules.system.service.runHealthChecks({ kinds: ["bot_token"] });
    expect(res.find((r) => r.name === "messaging.bot_token")?.status).toBe("pass");
    res = await t.modules.system.service.runHealthChecks({ kinds: ["channel_reach"], novelId });
    expect(res.find((r) => r.name === "messaging.channel_reach")?.status).toBe("pass");
    expect(fake.calls.some((c) => c.method === "GET" && c.path === `/channels/${DM}`)).toBe(true);

    fake.socket.serverClose(4014, "Disallowed intent(s).");
    await vi.waitFor(
      async () => {
        const [b] = await t.testDb.db.select().from(messengerBots).where(eq(messengerBots.id, botId));
        expect(b!.status).toBe("degraded");
      },
      { timeout: 2000, interval: 10 },
    );
    const [ch] = await t.testDb.db.select().from(channels).where(eq(channels.id, channelId));
    expect(ch!.status).toBe("degraded");
    res = await t.modules.system.service.runHealthChecks({ kinds: ["bot_token"] });
    const bt = res.find((r) => r.name === "messaging.bot_token")!;
    expect(bt.status).toBe("fail");
    expect(bt.message).toContain("MESSAGE CONTENT");
    const sockets = fake.sockets.length;
    expect(await msg().syncDiscordGateways()).toBe(0); // fatal: no immediate reconnect loop
    expect(fake.sockets.length).toBe(sockets);
    clock.advance(5 * 60_000 + 1000);
    await msg().syncDiscordGateways();
    await vi.waitFor(
      async () => {
        const [b] = await t.testDb.db.select().from(messengerBots).where(eq(messengerBots.id, botId));
        expect(b!.status).toBe("active");
        const [c] = await t.testDb.db.select().from(channels).where(eq(channels.id, channelId));
        expect(c!.status).toBe("active");
      },
      { timeout: 2000, interval: 10 },
    );
  });

  it("revoked token: 401 on REST → bot disconnected, gateway stopped; never logs or returns the token", async () => {
    fake.validTokens.clear();
    const res = await t.modules.system.service.runHealthChecks({ kinds: ["bot_token"] });
    expect(res.find((r) => r.name === "messaging.bot_token")?.status).toBe("fail");
    const [b] = await t.testDb.db.select().from(messengerBots).where(eq(messengerBots.id, botId));
    expect(b!.status).toBe("disconnected");
    expect(await msg().syncDiscordGateways()).toBe(0);
    expect(fake.socket.closed?.code).toBe(1000);
    const audit = await t.modules.audit.service.list({ novelId }, {});
    expect(JSON.stringify(audit)).not.toContain(DC_TOKEN);
    expect(actors.system("messenger")).toBeTruthy();
  });
});
