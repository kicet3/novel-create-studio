/**
 * Deterministic clock for tests (design/08 §6.2). Code under test should depend on the `Clock`
 * port (now/monotonic) instead of Date.now(); FakeClock implements it and also runs timers.
 */
export interface Clock {
  /** wall-clock ms since epoch */
  now(): number;
  /** Date for `now()` */
  date(): Date;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  date: () => new Date(),
};

interface Timer {
  id: number;
  at: number;
  fn: () => void;
  every?: number;
}

export class FakeClock implements Clock {
  private current: number;
  private timers: Timer[] = [];
  private nextId = 1;

  constructor(start: number | Date | string = "2026-11-01T00:00:00.000Z") {
    this.current = typeof start === "number" ? start : new Date(start).getTime();
  }

  now(): number {
    return this.current;
  }

  date(): Date {
    return new Date(this.current);
  }

  /** Set absolute time (must not go backwards); fires due timers. */
  set(to: number | Date | string): void {
    const t = typeof to === "number" ? to : new Date(to).getTime();
    if (t < this.current) throw new RangeError("FakeClock cannot go backwards");
    this.advance(t - this.current);
  }

  /** Advance by ms, firing timers in time order. */
  advance(ms: number): void {
    if (ms < 0) throw new RangeError("advance(ms) requires ms >= 0");
    const target = this.current + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.current = next.at;
      if (next.every !== undefined) next.at += next.every;
      else this.timers.shift();
      next.fn();
    }
    this.current = target;
  }

  advanceSeconds(s: number): void {
    this.advance(s * 1000);
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.push({ id, at: this.current + Math.max(0, ms), fn });
    return id;
  }

  setInterval(fn: () => void, ms: number): number {
    if (ms <= 0) throw new RangeError("interval must be > 0");
    const id = this.nextId++;
    this.timers.push({ id, at: this.current + ms, fn, every: ms });
    return id;
  }

  clear(id: number): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  get pendingTimers(): number {
    return this.timers.length;
  }
}
