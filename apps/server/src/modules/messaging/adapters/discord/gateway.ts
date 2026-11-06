/**
 * Minimal Discord Gateway (v10, JSON) client — outbound websocket only, so the app never needs a public
 * interactions endpoint. https://discord.com/developers/docs/events/gateway
 *
 * Hello(10) → heartbeat every `heartbeat_interval` (first beat jittered) → Identify(2) or Resume(6).
 * Heartbeat ACK(11) missing at the next beat = zombie connection → close + resume. Reconnect(7) → resume.
 * Invalid Session(9, d=false) → drop the session and identify again after 1–5 s. Fatal close codes (4004 auth,
 * 4010–4014 shard/intents) stop the client until it is restarted (health check / token re-entry).
 * Backoff: the reconnect attempt counter is only reset after a session stayed up for `stableMs` (default 30 s), so a
 * server that closes right after READY/RESUMED cannot cause a zero-delay reconnect/identify loop. Before every fresh
 * Identify the `/gateway/bot` session_start_limit is honoured (remaining = 0 → wait reset_after).
 * The token is only sent in the Identify/Resume payloads and never logged.
 */
import type { DiscordSocket, DiscordSocketFactory } from "../../index.js";

/** GUILDS is not needed: the bot only works in DMs. */
export const DISCORD_INTENTS = {
  DIRECT_MESSAGES: 1 << 12,
  /** privileged — DM content is delivered without it; only needed if the portal toggle is on and content is empty */
  MESSAGE_CONTENT: 1 << 15,
} as const;

export const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg";
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const SESSION_RESET_CLOSE = new Set([4007, 4009]);
/** close code we use ourselves when we want to resume (non-1000 keeps the session alive) */
const RESUME_CLOSE = 4900;

export type GatewayState = "idle" | "connecting" | "ready" | "reconnecting" | "fatal" | "stopped";

export interface DiscordGatewayOptions {
  token: string;
  intents: number;
  socket: DiscordSocketFactory;
  /** GET /gateway/bot (url + session_start_limit); falls back to wss://gateway.discord.gg on failure */
  resolveUrl: () => Promise<string | GatewayBotInfo>;
  onDispatch: (t: string, d: unknown) => void;
  onReady?: (info: { resumed: boolean; applicationId: string | null; username: string | null }) => void;
  onFatal?: (code: number, reason: string) => void;
  log?: { warn(obj: object, msg: string): void; info?(obj: object, msg: string): void };
  timing?: { reconnectBaseMs?: number; reconnectMaxMs?: number; invalidSessionMs?: () => number; random?: () => number; stableMs?: number; now?: () => number };
}

/** GET /gateway/bot result (session_start_limit.remaining / reset_after in ms) */
export interface GatewayBotInfo {
  url: string;
  remaining?: number | null;
  resetAfterMs?: number | null;
}

export interface DiscordGateway {
  start(): void;
  stop(): void;
  readonly state: GatewayState;
  readonly fatal: { code: number; reason: string } | null;
  /** consecutive reconnects (reset once a session stayed up for `stableMs`) */
  readonly reconnectAttempts: number;
}

interface GatewayFrame {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

export function createDiscordGateway(o: DiscordGatewayOptions): DiscordGateway {
  const base = o.timing?.reconnectBaseMs ?? 1000;
  const max = o.timing?.reconnectMaxMs ?? 60_000;
  const random = o.timing?.random ?? Math.random;
  const stableMs = o.timing?.stableMs ?? 30_000;
  const nowMs = o.timing?.now ?? Date.now;
  let state: GatewayState = "idle";
  let fatal: { code: number; reason: string } | null = null;
  let socket: DiscordSocket | null = null;
  let seq: number | null = null;
  let sessionId: string | null = null;
  let resumeUrl: string | null = null;
  let gatewayUrl: string | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let invalidSessionTimer: ReturnType<typeof setTimeout> | null = null;
  /** when the current session became READY/RESUMED (null = not ready) */
  let readyAt: number | null = null;
  let acked = true;
  let interval = 0;
  let attempts = 0;
  let generation = 0;
  let closedGen = -1;

  const send = (frame: GatewayFrame) => socket?.send(JSON.stringify(frame));
  const clearHeartbeat = () => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  };

  function beat(gen: number) {
    if (gen !== generation) return;
    if (!acked) {
      // zombie connection (no ACK since the last beat) → reconnect and resume
      o.log?.warn({ resumable: !!sessionId }, "discord gateway: heartbeat not acknowledged, reconnecting");
      drop(gen, RESUME_CLOSE, "heartbeat timeout");
      return;
    }
    acked = false;
    send({ op: 1, d: seq });
    heartbeatTimer = setTimeout(() => beat(gen), interval);
  }

  function identifyOrResume() {
    if (sessionId && seq !== null) {
      send({ op: 6, d: { token: o.token, session_id: sessionId, seq } });
    } else {
      send({ op: 2, d: { token: o.token, intents: o.intents, properties: { os: process.platform, browser: "novel-create-studio", device: "novel-create-studio" } } });
    }
  }

  function onMessage(gen: number, raw: string) {
    if (gen !== generation) return;
    let f: GatewayFrame;
    try {
      f = JSON.parse(raw) as GatewayFrame;
    } catch {
      return;
    }
    if (typeof f.s === "number") seq = f.s;
    switch (f.op) {
      case 10: {
        interval = Number((f.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 41_250);
        acked = true;
        clearHeartbeat();
        heartbeatTimer = setTimeout(() => beat(gen), Math.floor(interval * random()));
        identifyOrResume();
        return;
      }
      case 11:
        acked = true;
        return;
      case 1:
        send({ op: 1, d: seq });
        return;
      case 7:
        drop(gen, RESUME_CLOSE, "reconnect requested");
        return;
      case 9: {
        const resumable = f.d === true;
        if (!resumable) {
          sessionId = null;
          seq = null;
          resumeUrl = null;
        }
        const wait = o.timing?.invalidSessionMs?.() ?? 1000 + Math.floor(random() * 4000);
        if (invalidSessionTimer) clearTimeout(invalidSessionTimer);
        invalidSessionTimer = setTimeout(() => {
          invalidSessionTimer = null;
          drop(gen, RESUME_CLOSE, "invalid session");
        }, wait);
        return;
      }
      case 0: {
        if (f.t === "READY") {
          const d = f.d as { session_id?: string; resume_gateway_url?: string; application?: { id?: string }; user?: { username?: string } };
          sessionId = d.session_id ?? null;
          resumeUrl = d.resume_gateway_url ?? null;
          state = "ready";
          readyAt = nowMs();
          o.onReady?.({ resumed: false, applicationId: d.application?.id ?? null, username: d.user?.username ?? null });
          return;
        }
        if (f.t === "RESUMED") {
          state = "ready";
          readyAt = nowMs();
          o.onReady?.({ resumed: true, applicationId: null, username: null });
          return;
        }
        if (f.t) o.onDispatch(f.t, f.d);
        return;
      }
      default:
        return;
    }
  }

  /** close our side and continue immediately (a dead TCP connection may never deliver its close event) */
  function drop(gen: number, code: number, reason: string) {
    if (gen !== generation) return;
    const s = socket;
    onClose(gen, code, reason);
    s?.close(code, reason);
  }

  function onClose(gen: number, code: number, reason: string) {
    if (gen !== generation || closedGen === gen) return;
    closedGen = gen;
    clearHeartbeat();
    socket = null;
    // only a session that stayed up long enough resets the backoff (a close right after READY keeps backing off)
    if (readyAt !== null && nowMs() - readyAt >= stableMs) attempts = 0;
    readyAt = null;
    if (state === "stopped") return;
    if (FATAL_CLOSE.has(code)) {
      state = "fatal";
      fatal = { code, reason };
      o.log?.warn({ code, reason }, "discord gateway: fatal close");
      o.onFatal?.(code, reason);
      return;
    }
    if (SESSION_RESET_CLOSE.has(code) || code === 1000 || code === 1001) {
      sessionId = null;
      seq = null;
      resumeUrl = null;
    }
    state = "reconnecting";
    const delay = attempts === 0 ? 0 : Math.min(max, base * 2 ** (attempts - 1)) * (0.5 + random() / 2);
    attempts++;
    reconnectTimer = setTimeout(() => void connect(), delay);
  }

  async function connect() {
    reconnectTimer = null;
    if (state === "stopped" || state === "fatal") return;
    const gen = ++generation;
    if (state !== "reconnecting") state = "connecting";
    let url = sessionId ? resumeUrl : null;
    if (!url) {
      // fresh Identify: re-read /gateway/bot for session_start_limit (identifies are capped per 24 h)
      const info = await o
        .resolveUrl()
        .then((r): GatewayBotInfo => (typeof r === "string" ? { url: r } : r))
        .catch(() => null);
      if (gen !== generation || (state as GatewayState) === "stopped") return;
      if (info?.url) gatewayUrl = info.url;
      if (info && info.remaining === 0) {
        const wait = Math.max(1000, info.resetAfterMs ?? 60_000);
        o.log?.warn({ waitMs: wait }, "discord gateway: identify limit reached, waiting for session_start_limit reset");
        state = "reconnecting";
        reconnectTimer = setTimeout(() => void connect(), wait);
        return;
      }
      url = gatewayUrl ?? DEFAULT_GATEWAY_URL;
    }
    if (gen !== generation || (state as GatewayState) === "stopped") return;
    const full = `${url.replace(/\/+$/, "")}/?v=10&encoding=json`;
    try {
      socket = o.socket(full, {
        onOpen: () => undefined,
        onMessage: (data) => onMessage(gen, data),
        onClose: (code, reason) => onClose(gen, code, reason),
      });
    } catch (err) {
      o.log?.warn({ err: err instanceof Error ? err.message : String(err) }, "discord gateway: connect failed");
      onClose(gen, 1006, "connect failed");
    }
  }

  return {
    start() {
      if (state !== "idle") return;
      void connect();
    },
    stop() {
      state = "stopped";
      generation++;
      clearHeartbeat();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (invalidSessionTimer) clearTimeout(invalidSessionTimer);
      reconnectTimer = invalidSessionTimer = null;
      const s = socket;
      socket = null;
      s?.close(1000, "shutdown");
    },
    get state() {
      return state;
    },
    get fatal() {
      return fatal;
    },
    get reconnectAttempts() {
      return attempts;
    },
  };
}
