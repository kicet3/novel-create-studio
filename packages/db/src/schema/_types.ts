import { customType } from "drizzle-orm/pg-core";

/**
 * PostgreSQL `int4range` (story_range, 00 §5.5). Represented as the canonical text form,
 * e.g. "[0,11000)" or "[0,)". Use `storyRange()` / `parseStoryRange()` to build/parse.
 */
export const int4range = customType<{ data: string; driverData: string }>({
  dataType() {
    return "int4range";
  },
});

export interface StoryRange {
  /** inclusive lower bound */
  from: number;
  /** exclusive upper bound; null = unbounded ("이후 계속") */
  to: number | null;
}

/** Build a half-open int4range literal `[from,to)`. */
export function storyRange(from: number, to: number | null = null): string {
  if (!Number.isInteger(from) || (to !== null && !Number.isInteger(to))) throw new RangeError("story_range bounds must be integers");
  if (to !== null && to <= from) throw new RangeError(`empty story_range [${from},${to})`);
  return `[${from},${to === null ? "" : to})`;
}

/** Parse PostgreSQL's canonical int4range text (always `[lo,hi)` for discrete ranges). */
export function parseStoryRange(text: string): StoryRange {
  const m = /^\[(-?\d*),(-?\d*)\)$/.exec(text.trim());
  if (!m) throw new TypeError(`Unsupported int4range literal: ${text}`);
  return { from: m[1] === "" ? Number.NEGATIVE_INFINITY : Number(m[1]), to: m[2] === "" ? null : Number(m[2]) };
}

/** story_point = episode_no × 1000 + scene_ord (00 §5.5). */
export function storyPoint(episodeNo: number, sceneOrd = 0): number {
  if (sceneOrd < 0 || sceneOrd > 999) throw new RangeError("scene_ord must be 0..999");
  return episodeNo * 1000 + sceneOrd;
}
