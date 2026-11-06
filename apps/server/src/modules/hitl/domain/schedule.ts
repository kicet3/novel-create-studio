/**
 * Dispatch-time rules (05 §5.1 D4 quiet hours, §5.5 deadlines/reminders) in the novel timezone (00 §5.5).
 * Pure: the current time is always an argument.
 */
import type { QuestionGrade } from "@ncs/shared";

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function localParts(at: Date, timeZone: string): LocalParts {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

/** "11/05 21:00" in the novel timezone */
export function wallClock(at: Date, timeZone: string): string {
  const p = localParts(at, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(p.month)}/${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

export function hhmm(at: Date, timeZone: string): string {
  const p = localParts(at, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

const toMinutes = (t: string): number => {
  const [h, m] = t.split(":");
  return Number(h) * 60 + Number(m ?? 0);
};

/** D4: is `at` inside [start, end) local wall-clock window (may wrap midnight)? null window = never quiet */
export function inQuietHours(at: Date, timeZone: string, start: string | null, end: string | null): boolean {
  if (!start || !end) return false;
  const p = localParts(at, timeZone);
  const cur = p.hour * 60 + p.minute;
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === e) return false;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

export function deadlineHours(grade: QuestionGrade, policy: { deadlineHoursBlocking: number; deadlineHoursNonBlocking: number }): number | null {
  if (grade === "blocking") return policy.deadlineHoursBlocking;
  if (grade === "non_blocking") return policy.deadlineHoursNonBlocking;
  return null;
}

/** 05 §5.5: on posting, `max(existing, sent_at + hours)` so late-sent questions keep a full window */
export function recomputeDeadline(existing: Date | null, sentAt: Date, hours: number | null): Date | null {
  if (hours === null) return existing;
  const fresh = new Date(sentAt.getTime() + hours * 3600_000);
  return existing && existing.getTime() > fresh.getTime() ? existing : fresh;
}

/** next reminder due for a blocking question (offsets in minutes after the deadline, 05 §5.5) */
export function nextReminderAt(deadlineAt: Date | null, offsetsMinutes: readonly number[], reminderCount: number): Date | null {
  if (!deadlineAt || reminderCount >= offsetsMinutes.length) return null;
  return new Date(deadlineAt.getTime() + offsetsMinutes[reminderCount]! * 60_000);
}

export function afterDeadlineLabel(grade: QuestionGrade, defaultAction: "apply" | "hold" | null): string {
  if (grade === "blocking") return "지나도 자동 결정하지 않습니다";
  if (grade === "informational") return "";
  return defaultAction === "apply" ? "지나면 추천안을 적용합니다" : "지나면 보류합니다(캐논에 넣지 않음)";
}

export function hoursAgoLabel(from: Date, now: Date): string {
  const h = Math.max(0, Math.round((now.getTime() - from.getTime()) / 3600_000));
  return h < 1 ? "방금" : `${h}시간 전`;
}
