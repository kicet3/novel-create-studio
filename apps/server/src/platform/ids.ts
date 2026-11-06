/** ID generation (ADR-018): `<prefix>_<ULID>`, monotonic within the process, timestamps from the Clock. */
import { monotonicUlidFactory, type Id, type IdPrefix } from "@ncs/shared";
import type { Clock } from "./clock.js";

export interface IdGenerator {
  next<P extends IdPrefix>(prefix: P): Id<P>;
}

export function createIdGenerator(clock: Clock): IdGenerator {
  const ulid = monotonicUlidFactory(() => clock.now());
  return {
    next<P extends IdPrefix>(prefix: P): Id<P> {
      return `${prefix}_${ulid()}` as Id<P>;
    },
  };
}
