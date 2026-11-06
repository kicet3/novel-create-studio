/** Clock port (02 §3.2). Same shape as @ncs/test-kit FakeClock so tests can inject it. */
export interface Clock {
  /** wall-clock ms since epoch */
  now(): number;
  /** Date for now() */
  date(): Date;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  date: () => new Date(),
};
