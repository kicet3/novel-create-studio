/**
 * Publish slots of the autopilot (설계 추가 0014, publish_policy=scheduled). Pure.
 * The weekly cadence is spread over the week (7 → every day, 5 → Mon–Fri, 3 → Mon/Wed/Fri …) at `publishTimeLocal`
 * in the novel timezone; at most one episode per slot day.
 */
import { wallParts, zonedTime } from "@ncs/shared";

/** weekdays (0 = Sunday) for N episodes a week */
export function publishWeekdays(perWeek: number): number[] {
  const n = Math.max(1, Math.min(7, Math.round(perWeek)));
  switch (n) {
    case 7:
      return [0, 1, 2, 3, 4, 5, 6];
    case 6:
      return [1, 2, 3, 4, 5, 6];
    case 5:
      return [1, 2, 3, 4, 5];
    case 4:
      return [1, 2, 4, 5];
    case 3:
      return [1, 3, 5];
    case 2:
      return [2, 5];
    default:
      return [1];
  }
}

const dayKey = (d: Date, tz: string) => {
  const p = wallParts(d, tz);
  return `${p.year}-${p.month}-${p.day}`;
};

/**
 * the next `count` free slots strictly after `after` (a slot on a day that already has a scheduled episode is taken)
 */
export function nextPublishSlots(i: { after: Date; count: number; perWeek: number; timeLocal: string; timeZone: string; taken: Date[] }): Date[] {
  const days = new Set(publishWeekdays(i.perWeek));
  const [hh, mm] = i.timeLocal.split(":").map(Number) as [number, number];
  const taken = new Set(i.taken.map((d) => dayKey(d, i.timeZone)));
  const out: Date[] = [];
  const start = wallParts(i.after, i.timeZone);
  for (let k = 0; k < 400 && out.length < i.count; k++) {
    const slot = zonedTime(start.year, start.month, start.day + k, hh, mm, i.timeZone);
    if (slot.getTime() <= i.after.getTime()) continue;
    const p = wallParts(slot, i.timeZone);
    if (!days.has(p.weekday)) continue;
    const key = dayKey(slot, i.timeZone);
    if (taken.has(key)) continue;
    taken.add(key);
    out.push(slot);
  }
  return out;
}
