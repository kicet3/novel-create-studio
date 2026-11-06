/** In-memory Discord REST + Gateway double (no network) for messaging tests. */
import { DiscordApiError, type DiscordSocket, type DiscordTransport, type DiscordTransportFactory } from "../../src/modules/messaging/index.js";

export const DC_BOT_ID = "1300000000000000001";
/** syntactically valid bot token whose first segment encodes DC_BOT_ID (never a real token) */
export const DC_TOKEN = `${Buffer.from(DC_BOT_ID).toString("base64url")}.GfAkE0.${"x".repeat(27)}`;

export interface DcCall {
  token: string;
  method: string;
  path: string;
  body: any;
  /** gateway sessions identified so far when the call was made */
  session: number;
}

export class FakeGatewaySocket implements DiscordSocket {
  sent: any[] = [];
  closed: { code?: number; reason?: string } | null = null;
  constructor(
    readonly url: string,
    readonly h: { onOpen(): void; onMessage(data: string): void; onClose(code: number, reason: string): void },
    private readonly owner: FakeDiscord,
  ) {}
  send(data: string) {
    const f = JSON.parse(data);
    this.sent.push(f);
    this.owner.onClientFrame(this, f);
  }
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = { code, reason };
  }
  /** server → client frame */
  push(frame: unknown) {
    if (!this.closed) this.h.onMessage(JSON.stringify(frame));
  }
  /** server closes the connection */
  serverClose(code: number, reason = "") {
    if (this.closed) return;
    this.closed = { code, reason };
    this.h.onClose(code, reason);
  }
}

export class FakeDiscord {
  calls: DcCall[] = [];
  /** "METHOD /path-prefix" → errors thrown by the next matching calls */
  failures: Array<{ match: string; err: DiscordApiError }> = [];
  validTokens = new Set<string>([DC_TOKEN]);
  nextId = 1400000000000000000n;
  sockets: FakeGatewaySocket[] = [];
  /** DM history returned by GET /channels/:id/messages?after= */
  history = new Map<string, any[]>();
  autoReady = true;
  ackHeartbeats = true;
  heartbeatInterval = 60_000;
  seq = 0;
  sessions = 0;

  snowflake() {
    return String(this.nextId++);
  }

  rest = (token: string): DiscordTransport => ({
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      this.calls.push({ token, method, path, body, session: this.sessions });
      if (!this.validTokens.has(token)) throw new DiscordApiError(401, "401: Unauthorized", undefined, 0);
      const i = this.failures.findIndex((f) => `${method} ${path}`.startsWith(f.match));
      if (i >= 0) throw this.failures.splice(i, 1)[0]!.err;
      if (method === "GET" && path === "/users/@me") return { id: DC_BOT_ID, username: "ncs_discord_bot", bot: true } as T;
      if (method === "GET" && path === "/oauth2/applications/@me") return { id: DC_BOT_ID, name: "NCS" } as T;
      if (method === "GET" && path === "/gateway/bot") return { url: "wss://gateway.fake", shards: 1 } as T;
      let m = /^\/channels\/(\d+)\/messages\?after=(\d+)(?:&limit=(\d+))?/.exec(path);
      if (method === "GET" && m) {
        // like Discord: the `limit` messages right after `after`, returned newest first
        const after = BigInt(m[2]!);
        const limit = Number(m[3] ?? 50);
        const rows = (this.history.get(m[1]!) ?? []).filter((x) => BigInt(x.id) > after).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        return rows.slice(0, limit).reverse() as T;
      }
      m = /^\/channels\/(\d+)\/messages$/.exec(path);
      if (method === "POST" && m) return { id: this.snowflake(), channel_id: m[1] } as T;
      m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path);
      if (method === "PATCH" && m) return { id: m[2], channel_id: m[1] } as T;
      m = /^\/channels\/(\d+)$/.exec(path);
      if (method === "GET" && m) return { id: m[1], type: 1 } as T;
      if (method === "POST" && path.startsWith("/interactions/")) return null as T;
      throw new DiscordApiError(404, "404: Not Found", undefined, 10003);
    },
  });

  factory: DiscordTransportFactory = {
    rest: this.rest,
    socket: (url, h) => {
      const s = new FakeGatewaySocket(url, h, this);
      this.sockets.push(s);
      queueMicrotask(() => s.push({ op: 10, d: { heartbeat_interval: this.heartbeatInterval } }));
      return s;
    },
    gatewayTiming: { reconnectBaseMs: 5, reconnectMaxMs: 20, invalidSessionMs: () => 5, random: () => 0.5 },
  };

  onClientFrame(s: FakeGatewaySocket, f: any) {
    if (f.op === 1 && this.ackHeartbeats) queueMicrotask(() => s.push({ op: 11 }));
    if (f.op === 2 && this.autoReady) {
      this.sessions++;
      queueMicrotask(() =>
        s.push({ op: 0, t: "READY", s: ++this.seq, d: { v: 10, session_id: `sess${this.sessions}`, resume_gateway_url: "wss://resume.fake", user: { id: DC_BOT_ID, username: "ncs_discord_bot" }, application: { id: DC_BOT_ID } } }),
      );
    }
    if (f.op === 6 && this.autoReady) queueMicrotask(() => s.push({ op: 0, t: "RESUMED", s: ++this.seq, d: {} }));
  }

  get socket(): FakeGatewaySocket {
    return this.sockets.at(-1)!;
  }
  sent(path?: RegExp) {
    return this.calls.filter((c) => c.method === "POST" && /^\/channels\/\d+\/messages$/.test(c.path) && (!path || path.test(c.path)));
  }

  // event builders (Gateway dispatch payloads)
  dm(channelId: string, userId: string, content: string, opts: { replyTo?: string; id?: string; bot?: boolean } = {}) {
    return {
      id: opts.id ?? this.snowflake(),
      channel_id: channelId,
      author: { id: userId, username: "writer", global_name: "작가", ...(opts.bot ? { bot: true } : {}) },
      content,
      type: opts.replyTo ? 19 : 0,
      ...(opts.replyTo ? { message_reference: { message_id: opts.replyTo, channel_id: channelId } } : {}),
    };
  }
  click(channelId: string, userId: string, customId: string, messageId: string) {
    return {
      id: this.snowflake(),
      application_id: DC_BOT_ID,
      type: 3,
      token: "interaction-token-secret",
      channel_id: channelId,
      channel: { id: channelId, type: 1 },
      user: { id: userId, username: "writer" },
      message: { id: messageId },
      data: { custom_id: customId, component_type: 2 },
    };
  }
  /** deliver a dispatch on the current gateway socket */
  dispatch(t: string, d: unknown) {
    this.socket.push({ op: 0, t, s: ++this.seq, d });
  }
}
