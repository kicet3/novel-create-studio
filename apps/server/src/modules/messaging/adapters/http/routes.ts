/** HTTP adapter of `messaging` (CONVENTIONS §13 "채널 (messaging)" + `/api/messaging/bots`). */
import { z } from "zod";
import { messagingIssueBindingRequestSchema, messagingRegisterBotRequestSchema } from "@ncs/shared";
import type { ApiRouters } from "../../../../platform/index.js";
import { actorOf, created, scopeOf, valid, validate } from "../../../../http/kit.js";
import type { Channel, MessagingService, MessengerBot } from "../../index.js";

type Body<S extends z.ZodType> = { body: z.output<S> };

/** never expose secret ids / chat refs / allowed user ids */
export function botDto(b: MessengerBot, links: { username: string | null; inviteUrl: string | null } = { username: null, inviteUrl: null }) {
  return {
    id: b.id,
    kind: b.kind,
    label: b.label,
    receiveMode: b.receiveMode,
    status: b.status,
    lastConnectedAt: b.lastConnectedAt,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    username: links.username,
    inviteUrl: links.inviteUrl,
  };
}
export function channelDto(c: Channel) {
  return {
    id: c.id,
    novelId: c.novelId,
    kind: c.kind,
    status: c.status,
    botId: c.botId,
    label: c.label,
    boundAt: c.boundAt,
    lastHealthAt: c.lastHealthAt,
    lastHealthStatus: c.lastHealthStatus,
    disconnectedReason: c.disconnectedReason,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export function mountMessagingRoutes({ api, novel }: ApiRouters, svc: MessagingService): void {
  api.get("/messaging/bots", async (_req, res) => {
    const bots = await svc.listBots();
    res.json({ items: await Promise.all(bots.map(async (b) => botDto(b, await svc.botLinks(b)))) });
  });
  api.post("/messaging/bots", validate({ body: messagingRegisterBotRequestSchema }), async (_req, res) => {
    const { body } = valid<Body<typeof messagingRegisterBotRequestSchema>>(res);
    const bot = await svc.registerBot(body, actorOf(res));
    created(res, botDto(bot, await svc.botLinks(bot)));
  });

  novel.get("/channels", async (_req, res) => {
    res.json({ items: (await svc.listChannels(scopeOf(res))).map(channelDto) });
  });
  novel.post("/channels/bindings", validate({ body: messagingIssueBindingRequestSchema }), async (_req, res) => {
    const { body } = valid<Body<typeof messagingIssueBindingRequestSchema>>(res);
    created(res, await svc.issueBindingToken(scopeOf(res), body, actorOf(res)));
  });
  novel.post("/channels/:channelId/unbind", validate({ params: z.object({ channelId: z.string().regex(/^chn_/) }) }), async (_req, res) => {
    const { params } = valid<{ params: { channelId: string } }>(res);
    res.json(channelDto(await svc.unbindChannel(scopeOf(res), params.channelId, actorOf(res))));
  });
}
