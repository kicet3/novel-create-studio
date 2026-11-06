import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFetchTelegramTransport } from "../../src/modules/messaging/adapters/telegram/fetch-transport.js";
import { createTelegramClient } from "../../src/modules/messaging/adapters/telegram/client.js";
import { TelegramApiError } from "../../src/modules/messaging/index.js";
import { classifyTelegramError } from "../../src/modules/messaging/application/ports.js";

let server: Server;
let base = "";
const seen: Array<{ url: string; body: any }> = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url!, body });
      res.setHeader("content-type", "application/json");
      if (req.url!.endsWith("/sendMessage") && body.text === "slow") {
        res.statusCode = 429;
        return res.end(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } }));
      }
      if (req.url!.endsWith("/sendMessage")) return res.end(JSON.stringify({ ok: true, result: { message_id: 55 } }));
      if (req.url!.endsWith("/getMe")) return res.end(JSON.stringify({ ok: true, result: { id: 1, username: "b" } }));
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("fetch Telegram transport (real Bot API wire format)", () => {
  it("POSTs JSON to /bot<token>/<method> and maps ok/error/429 retry_after", async () => {
    const client = createTelegramClient(createFetchTelegramTransport("1:SECRET", { baseUrl: base }));
    expect(await client.getMe()).toEqual({ id: "1", username: "b" });
    const r = await client.send("10", { text: "**안녕**", buttons: [[{ label: "A", data: "v1|a|qst_x|0" }]] });
    expect(r.messageRef).toBe("55");
    const sent = seen.find((s) => s.url.endsWith("/sendMessage"))!;
    expect(sent.url).toBe("/bot1:SECRET/sendMessage");
    expect(sent.body).toMatchObject({ chat_id: "10", parse_mode: "HTML", text: "<b>안녕</b>", reply_markup: { inline_keyboard: [[{ text: "A", callback_data: "v1|a|qst_x|0" }]] } });
    const e429 = await client.send("10", { text: "slow", buttons: [] }).catch((e) => e);
    expect(e429).toBeInstanceOf(TelegramApiError);
    expect(classifyTelegramError(e429)).toMatchObject({ kind: "rate_limited", retryAfterSec: 3 });
    const e401 = await client.getChat("10").catch((e) => e);
    expect(classifyTelegramError(e401).kind).toBe("unauthorized");
  });

  it("network failure never leaks the token", async () => {
    const t = createFetchTelegramTransport("9:TOPSECRET", { baseUrl: "http://127.0.0.1:1" });
    const err = (await t.call("getMe", {}).catch((e: unknown) => e)) as TelegramApiError;
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(String(err.message)).not.toContain("TOPSECRET");
    expect(classifyTelegramError(err).kind).toBe("network");
  });
});
