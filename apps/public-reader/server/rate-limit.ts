/** In-memory fixed-window rate limiter (per key, e.g. "login:ip:1.2.3.4"). Good enough for one process. */
export interface RateRule {
  limit: number;
  windowMs: number;
}

export class RateLimiter {
  private buckets = new Map<string, { start: number; count: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  /** count one hit; false when the key is over its limit in the current window */
  hit(key: string, rule: RateRule): boolean {
    const t = this.now();
    const b = this.buckets.get(key);
    if (!b || t - b.start >= rule.windowMs) {
      this.buckets.set(key, { start: t, count: 1 });
      this.sweep(t);
      return true;
    }
    b.count++;
    return b.count <= rule.limit;
  }

  /** would the next hit pass? (does not count) */
  peek(key: string, rule: RateRule): boolean {
    const b = this.buckets.get(key);
    return !b || this.now() - b.start >= rule.windowMs || b.count < rule.limit;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private lastSweep = 0;
  private sweep(t: number): void {
    if (t - this.lastSweep < 60_000 && this.buckets.size < 50_000) return;
    this.lastSweep = t;
    for (const [k, b] of this.buckets) if (t - b.start > 24 * 3600 * 1000) this.buckets.delete(k);
  }
}

const MIN = 60_000;
export const RULES = {
  signupIp: { limit: 5, windowMs: 60 * MIN },
  loginIp: { limit: 20, windowMs: 10 * MIN },
  loginFailNick: { limit: 8, windowMs: 10 * MIN },
  commentReader: { limit: 6, windowMs: MIN },
  commentReaderHour: { limit: 60, windowMs: 60 * MIN },
  commentIp: { limit: 20, windowMs: MIN },
  likeReader: { limit: 60, windowMs: MIN },
  likeIp: { limit: 120, windowMs: MIN },
  rateReader: { limit: 30, windowMs: MIN },
  adminIp: { limit: 30, windowMs: MIN },
} satisfies Record<string, RateRule>;
