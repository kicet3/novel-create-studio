/**
 * Deterministic ID factory for fixtures: same seed → same IDs, valid `<prefix>_<ULID>` format.
 */
import { CROCKFORD_ALPHABET, type Id, type IdPrefix } from "@ncs/shared/ids";

export class SeqIdFactory {
  private counter = 0;
  constructor(private readonly timeMs = Date.UTC(2026, 10, 1), private readonly seed = 0) {}

  next<P extends IdPrefix>(prefix: P): Id<P> {
    const n = this.counter++;
    let time = "";
    let t = this.timeMs;
    for (let i = 0; i < 10; i++) {
      time = CROCKFORD_ALPHABET[t % 32] + time;
      t = Math.floor(t / 32);
    }
    let rand = "";
    let r = n + this.seed * 1_000_003;
    for (let i = 0; i < 16; i++) {
      rand = CROCKFORD_ALPHABET[r % 32] + rand;
      r = Math.floor(r / 32);
    }
    return `${prefix}_${time}${rand}` as Id<P>;
  }

  reset(): void {
    this.counter = 0;
  }
}
