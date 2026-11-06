import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFetchDiscordTransport } from "../../src/modules/messaging/adapters/discord/rest.js";
import { createDiscordClient } from "../../src/modules/messaging/adapters/discord/client.js";
import { DiscordApiError } from "../../src/modules/messaging/index.js";
import { classifyTelegramError } from "../../src/modules/messaging/application/ports.js";

let server: Server;
let base = "";
const seen: Array<{ method: string; url: string; auth: string | undefined; body: any }> = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== "Bot GOOD.TOKEN.X") {
        res.statusCode = 401;
        return res.end(JSON.stringify({ message: "401: Unauthorized", code: 0 }));
      }
      if (req.url === "/users/@me") return res.end(JSON.stringify({ id: "42", username: "b" }));
      if (req.url === "/channels/10/messages" && body?.content === "slow") {
        res.statusCode = 429;
        res.setHeader("retry-after", "3");
        return res.end(JSON.stringify({ message: "You are being rate limited.", retry_after: 2.5, global: false }));
      }
      if (req.url === "/channels/10/messages") return res.end(JSON.stringify({ id: String(1000 + seen.length) }));
      if (req.url?.startsWith("/interactions/")) {
        res.statusCode = 204;
        return res.end();
      }
      res.statusCode = 403;
      res.end(JSON.stringify({ message: "Cannot send messages to this user", code: 50007 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("fetch Discord transport (REST v10 wire format)", () => {
  it("sends `Authorization: Bot <token>`, maps 429 retry_after / 403 / 204, splits > 2000 chars", async () => {
    const client = createDiscordClient(createFetchDiscordTransport("GOOD.TOKEN.X", { baseUrl: base }));
    expect(await client.getMe()).toEqual({ id: "42", username: "b" });
    const long = "가".repeat(2500);
    const r = await client.send("10", { text: long, buttons: [[{ label: "A", data: "v1|a|qst_x|0" }]] });
    const posts = seen.filter((s) => s.url === "/channels/10/messages");
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body.content).toHaveLength(2000);
    expect(posts[0]!.body.components).toBeUndefined();
    expect(posts[1]!.body.components).toEqual([{ type: 1, components: [{ type: 2, style: 2, label: "A", custom_id: "v1|a|qst_x|0" }] }]);
    expect(posts[1]!.body.allowed_mentions).toEqual({ parse: [] });
    expect(r.messageRef).toBe(String(1000 + seen.indexOf(posts[1]!) + 1));
    expect(seen[0]!.auth).toBe("Bot GOOD.TOKEN.X");
    await client.ackInteraction("77", "tok");
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/interactions/77/tok/callback", body: { type: 6 } });

    const e429 = await client.send("10", { text: "slow", buttons: [] }).catch((e) => e);
    expect(e429).toBeInstanceOf(DiscordApiError);
    expect(classifyTelegramError(e429)).toMatchObject({ kind: "rate_limited", retryAfterSec: 3 });
    const e403 = await client.send("11", { text: "x", buttons: [] }).catch((e) => e);
    expect(e403).toMatchObject({ status: 403, code: 50007 });
    expect(classifyTelegramError(e403).kind).toBe("forbidden");
    const e401 = await createDiscordClient(createFetchDiscordTransport("BAD.TOKEN.Y", { baseUrl: base })).getMe().catch((e) => e);
    expect(classifyTelegramError(e401).kind).toBe("unauthorized");
  });

  it("network failure never leaks the token", async () => {
    const t = createFetchDiscordTransport("TOP.SECRET.TOKEN", { baseUrl: "http://127.0.0.1:1" });
    const err = (await t.request("GET", "/users/@me").catch((e: unknown) => e)) as DiscordApiError;
    expect(err).toBeInstanceOf(DiscordApiError);
    expect(String(err.message)).not.toContain("TOP.SECRET.TOKEN");
    expect(classifyTelegramError(err).kind).toBe("network");
  });
});
