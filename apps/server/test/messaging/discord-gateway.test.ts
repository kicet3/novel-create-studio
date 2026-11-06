/**
 * Discord Gateway client in isolation (fake timers, in-memory socket): reconnect backoff is not reset by a session
 * that dies right after READY, session_start_limit is honoured before Identify, stop() clears pending timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscordGateway, type GatewayBotInfo } from "../../src/modules/messaging/adapters/discord/gateway.js";

interface Sock {
  url: string;
  sent: any[];
  h: { onOpen(): void; onMessage(data: string): void; onClose(code: number, reason: string): void };
  closed: boolean;
}

function harness(opts: { resolve?: () => Promise<string | GatewayBotInfo>; stableMs?: number } = {}) {
  const sockets: Sock[] = [];
  let clock = 0;
  const gw = createDiscordGateway({
    token: "test-token-not-real",
    intents: 1 << 12,
    resolveUrl: opts.resolve ?? (async () => ({ url: "wss://g.fake", remaining: 1000, resetAfterMs: 0 })),
    socket: (url, h) => {
      const s: Sock = { url, sent: [], h, closed: false };
      sockets.push(s);
      return {
        send: (d: string) => s.sent.push(JSON.parse(d)),
        close: () => {
          s.closed = true;
        },
      };
    },
    onDispatch: () => undefined,
    timing: { reconnectBaseMs: 1000, reconnectMaxMs: 60_000, random: () => 1, invalidSessionMs: () => 2000, stableMs: opts.stableMs ?? 30_000, now: () => clock },
  });
  const push = (s: Sock, f: unknown) => s.h.onMessage(JSON.stringify(f));
  /** hello + READY on the newest socket */
  const ready = (s = sockets.at(-1)!) => {
    push(s, { op: 10, d: { heartbeat_interval: 1_000_000 } });
    push(s, { op: 0, t: "READY", s: 1, d: { session_id: "s", resume_gateway_url: "wss://r.fake" } });
  };
  return { gw, sockets, push, ready, advanceClock: (ms: number) => (clock += ms) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("discord gateway client", () => {
  it("a session closed right after READY keeps backing off (no zero-delay identify loop); a stable one resets", async () => {
    const h = harness();
    h.gw.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sockets).toHaveLength(1);
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      h.ready();
      h.sockets.at(-1)!.h.onClose(4009, "session timed out"); // forces a fresh identify each time
      const n = h.sockets.length;
      let waited = 0;
      while (h.sockets.length === n && waited < 120_000) {
        await vi.advanceTimersByTimeAsync(100);
        waited += 100;
      }
      delays.push(waited);
    }
    // first reconnect is immediate, then 1 s, 2 s, 4 s … (READY no longer resets the counter)
    expect(delays[0]).toBeLessThanOrEqual(100);
    expect(delays[1]).toBeGreaterThanOrEqual(1000);
    expect(delays[2]).toBeGreaterThanOrEqual(2000);
    expect(delays[3]).toBeGreaterThanOrEqual(4000);
    expect(h.gw.reconnectAttempts).toBe(4);

    // a session that stayed up for stableMs resets the backoff
    h.ready();
    h.advanceClock(31_000);
    h.sockets.at(-1)!.h.onClose(4000, "unknown error");
    expect(h.gw.reconnectAttempts).toBe(1);
    const n = h.sockets.length;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sockets.length).toBe(n + 1);
    h.gw.stop();
  });

  it("waits for session_start_limit.reset_after when no identifies are left", async () => {
    let remaining = 0;
    const resolve = vi.fn(async () => ({ url: "wss://g.fake", remaining, resetAfterMs: 10_000 }));
    const h = harness({ resolve });
    h.gw.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.sockets).toHaveLength(0);
    expect(h.gw.state).toBe("reconnecting");
    remaining = 5;
    await vi.advanceTimersByTimeAsync(5_100);
    expect(h.sockets).toHaveLength(1);
    expect(resolve).toHaveBeenCalledTimes(2);
    // a plain string from resolveUrl is still accepted
    const h2 = harness({ resolve: async () => "wss://plain.fake" });
    h2.gw.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h2.sockets[0]!.url).toBe("wss://plain.fake/?v=10&encoding=json");
    h.gw.stop();
    h2.gw.stop();
  });

  it("stop() clears the pending invalid-session timer", async () => {
    const h = harness();
    h.gw.start();
    await vi.advanceTimersByTimeAsync(0);
    h.ready();
    h.push(h.sockets[0]!, { op: 9, d: false });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    h.gw.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.gw.state).toBe("stopped");
  });
});
