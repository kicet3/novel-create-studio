/** Korean count / date formatting (pure). */
export const formatCount = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000) / 10}만` : n.toLocaleString("ko-KR"));

const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });

/** YYYY.MM.DD in Korea time (same on the server and in the browser — no hydration mismatch) */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return ymd.format(d).replace(/-/g, ".");
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}일 전`;
  return formatDate(iso);
}

