/**
 * Pure backup policy (no I/O): schedule / missed-backup catch-up / failure back-off (02 §8.3) and
 * retention (`backup.retention` = daily 7 + weekly 4, 00 §7.7).
 */
export interface BackupRecordLike {
  id: string;
  status: "running" | "succeeded" | "failed";
  trigger: "scheduled" | "pre_migration" | "pre_restore" | "manual";
  startedAt: Date;
  finishedAt: Date | null;
}

export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;

export type ScheduleDecision =
  | { due: true; reason: "never" | "interval_elapsed" | "retry_after_failure" }
  | { due: false; reason: "running" | "fresh" | "backoff"; nextAt: Date };

/**
 * Due when the last succeeded *scheduled* backup is older than `intervalHours` (or none exists).
 * Consecutive failures since then back off exponentially (1 min · 2^(n-1), capped at 1 h).
 * Evaluated against the wall clock on every tick, so a sleep/stop longer than the interval is
 * caught up on the first tick after start or wake-up.
 */
export function scheduleDecision(records: BackupRecordLike[], now: Date, intervalHours: number): ScheduleDecision {
  const scheduled = records.filter((r) => r.trigger === "scheduled");
  const running = records.find((r) => r.status === "running");
  if (running) return { due: false, reason: "running", nextAt: now };
  const lastOk = scheduled
    .filter((r) => r.status === "succeeded" && r.finishedAt)
    .reduce<BackupRecordLike | null>((a, r) => (!a || r.finishedAt! > a.finishedAt! ? r : a), null);
  const intervalMs = intervalHours * 3_600_000;
  if (lastOk) {
    const nextAt = new Date(lastOk.finishedAt!.getTime() + intervalMs);
    if (now < nextAt) return { due: false, reason: "fresh", nextAt };
  }
  const since = lastOk?.finishedAt ?? new Date(0);
  const failures = scheduled
    .filter((r) => r.status === "failed" && (r.finishedAt ?? r.startedAt) > since)
    .sort((a, b) => (b.finishedAt ?? b.startedAt).getTime() - (a.finishedAt ?? a.startedAt).getTime());
  if (failures.length) {
    const wait = Math.min(BACKOFF_BASE_MS * 2 ** (failures.length - 1), BACKOFF_MAX_MS);
    const nextAt = new Date((failures[0]!.finishedAt ?? failures[0]!.startedAt).getTime() + wait);
    if (now < nextAt) return { due: false, reason: "backoff", nextAt };
    return { due: true, reason: "retry_after_failure" };
  }
  return { due: true, reason: lastOk ? "interval_elapsed" : "never" };
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export interface RetentionPolicy {
  daily: number;
  weekly: number;
  /** pre_migration / pre_restore bundles kept per trigger (default 3) */
  keepSafetyPerTrigger?: number;
  /** failed rows kept (default 20) */
  keepFailed?: number;
}

/**
 * Ids to prune. Scheduled successes: newest per UTC day for the `daily` most recent days, plus the
 * newest per ISO week for the `weekly` most recent weeks. Manual backups are never pruned.
 * Running rows are never touched.
 */
export function retentionPlan(records: BackupRecordLike[], policy: RetentionPolicy): string[] {
  const keep = new Set<string>();
  const by = (a: BackupRecordLike, b: BackupRecordLike) => (b.finishedAt ?? b.startedAt).getTime() - (a.finishedAt ?? a.startedAt).getTime();
  const ok = records.filter((r) => r.status === "succeeded").sort(by);

  const pick = (list: BackupRecordLike[], key: (d: Date) => string, n: number) => {
    const seen = new Set<string>();
    for (const r of list) {
      const k = key(r.finishedAt ?? r.startedAt);
      if (seen.has(k)) continue;
      if (seen.size >= n) break;
      seen.add(k);
      keep.add(r.id);
    }
  };
  const sched = ok.filter((r) => r.trigger === "scheduled");
  pick(sched, dayKey, policy.daily);
  pick(sched, isoWeekKey, policy.weekly);
  for (const trig of ["pre_migration", "pre_restore"] as const) {
    ok.filter((r) => r.trigger === trig)
      .slice(0, policy.keepSafetyPerTrigger ?? 3)
      .forEach((r) => keep.add(r.id));
  }
  ok.filter((r) => r.trigger === "manual").forEach((r) => keep.add(r.id));
  records
    .filter((r) => r.status === "failed")
    .sort(by)
    .slice(0, policy.keepFailed ?? 20)
    .forEach((r) => keep.add(r.id));
  return records.filter((r) => r.status !== "running" && !keep.has(r.id)).map((r) => r.id);
}
