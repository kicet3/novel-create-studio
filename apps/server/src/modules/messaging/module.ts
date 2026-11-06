/**
 * messaging module factory: Telegram via direct Bot API fetch (ADR-011 fixed decision), Discord via REST +
 * an own Gateway websocket client (DM only, outbound connection — no public endpoint), inbox/outbox
 * durability, binding, health checks `bot_token` / `channel_reach`, loops telegram.poller / messaging.inbox /
 * messaging.outbox. N1 participant (order 20) creates the web channel.
 */
import type { Platform, ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { NovelService } from "../novel/index.js";
import type { SystemService } from "../system/index.js";
import type { DiscordTransportFactory, MessagingService, TelegramTransportFactory } from "./index.js";
import { createMessagingService } from "./application/messaging-service.js";
import { createFetchTelegramTransport } from "./adapters/telegram/fetch-transport.js";
import { createTelegramClient, parseTelegramUpdate } from "./adapters/telegram/client.js";
import { mountMessagingRoutes } from "./adapters/http/routes.js";
import { createFetchDiscordTransport, createNativeDiscordSocket } from "./adapters/discord/rest.js";
import { createDiscordClient } from "./adapters/discord/client.js";
import { DISCORD_INTENTS } from "./adapters/discord/gateway.js";

export interface MessagingModuleDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  /** secrets (bot tokens) + health checks (bot_token, channel_reach) */
  system: SystemService;
  /** optional override (tests); default = fetch to api.telegram.org */
  telegramTransportFactory?: TelegramTransportFactory;
  /** optional override (tests); default = fetch to discord.com/api/v10 + global WebSocket Gateway */
  discordTransportFactory?: DiscordTransportFactory;
}

export function createMessagingModule(deps: MessagingModuleDeps): ServerModule<MessagingService> {
  let transportFactory: TelegramTransportFactory = 
    deps.telegramTransportFactory ??
    ((token) => createFetchTelegramTransport(token, { baseUrl: deps.platform.config.messaging.telegram_api_base_url?.replace(/\/+$/, "") }));
  const cfg = deps.platform.config.messaging;
  let discordTransport: DiscordTransportFactory = deps.discordTransportFactory ?? {
    rest: (token) => createFetchDiscordTransport(token, { baseUrl: cfg.discord_api_base_url }),
    socket: createNativeDiscordSocket,
  };
  const internals = createMessagingService({
    platform: deps.platform,
    audit: deps.audit,
    novel: deps.novel,
    system: deps.system,
    clientFactory: () => (token) => createTelegramClient(transportFactory(token)),
    parseUpdate: parseTelegramUpdate,
    setTransportFactory: (f) => {
      transportFactory = f;
    },
    discordClientFactory: () => (token) => createDiscordClient(discordTransport.rest(token)),
    discordSocketFactory: () => discordTransport.socket,
    discordGatewayTiming: () => discordTransport.gatewayTiming,
    setDiscordTransportFactory: (f) => {
      discordTransport = f;
    },
    discordIntents: DISCORD_INTENTS.DIRECT_MESSAGES | (cfg.discord_message_content_intent ? DISCORD_INTENTS.MESSAGE_CONTENT : 0),
  });
  const service = internals.service;

  deps.novel.registerCreationParticipant({
    module: "messaging",
    order: 20,
    async onNovelCreated(ctx) {
      ctx.outputs.webChannelId = (await service.createWebChannel(ctx.tx, ctx.scope)).id;
    },
  });

  deps.system.registerHealthCheck({
    name: "messaging.bot_token",
    kind: "bot_token",
    scope: "install",
    run: () => internals.checkBotTokens(),
  });
  deps.system.registerHealthCheck({
    name: "messaging.channel_reach",
    kind: "channel_reach",
    scope: "novel",
    run: (ctx) => internals.checkChannelReach(ctx.novelId!),
  });

  return {
    name: "messaging",
    implemented: true,
    service,
    routes: (r) => mountMessagingRoutes(r, service),
    loops: [
      // long polling: the tick itself waits up to telegram.poll_timeout_seconds (TP1)
      { name: "telegram.poller", intervalMs: 1000, runOnStart: true, tick: async (signal) => void (await service.pollOnce(signal)) },
      { name: "messaging.inbox", intervalMs: 2000, wakeOn: ["inbox"], tick: async () => void (await service.processInboxOnce()) },
      { name: "messaging.outbox", intervalMs: 2000, wakeOn: ["outbox"], tick: async () => void (await service.processOutboxOnce()) },
      // Discord: keeps one outbound Gateway websocket per active bot (events arrive asynchronously → inbox)
      { name: "discord.gateway", intervalMs: 15_000, runOnStart: true, tick: async () => void (await service.syncDiscordGateways()) },
    ],
    async start() {
      await internals.recoverOnBoot();
    },
    async stop() {
      internals.stopGateways();
      await internals.drainGateways();
    },
  };
}
