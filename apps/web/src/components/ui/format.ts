/** Display formatters (00 §5.5: show times on the novel's wall clock). */

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string | undefined, withDate: boolean): Intl.DateTimeFormat {
  const key = `${timeZone ?? ""}|${withDate}`;
  let f = fmtCache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("ko-KR", {
        timeZone,
        ...(withDate ? { month: "numeric", day: "numeric" } : {}),
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    } catch {
      f = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    }
    fmtCache.set(key, f);
  }
  return f;
}

/** "11. 5. 14:02" in the given IANA zone (default: browser zone). Returns "—" for null. */
export function formatDateTime(value: string | Date | null | undefined, timeZone?: string): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return formatter(timeZone, true).format(d);
}

/** "3분 전" / "2시간 후" relative to now. */
export function formatRelative(value: string | Date | null | undefined, now: number = Date.now()): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  const diff = d.getTime() - now;
  if (Number.isNaN(diff)) return "—";
  const abs = Math.abs(diff);
  const suffix = diff < 0 ? "전" : "후";
  const min = Math.round(abs / 60_000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 ${suffix}`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}시간 ${suffix}`;
  return `${Math.round(h / 24)}일 ${suffix}`;
}

/** "1,234" */
export function formatNumber(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString("ko-KR");
}

/** `T-12` style display number. */
export function displayNo(prefix: string, n: number | string | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const s = String(n);
  return s.includes("-") ? s : `${prefix}-${s}`;
}
