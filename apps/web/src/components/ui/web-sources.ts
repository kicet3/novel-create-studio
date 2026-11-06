import type { LlmWebSource } from "@ncs/shared";

/** 설계 추가 0011: display rows of web sources — http(s) only, deduped by URL, title or host as the label */
export function sourceRows(sources: readonly LlmWebSource[] | null | undefined, max = 8): Array<{ url: string; label: string; host: string }> {
  const out: Array<{ url: string; label: string; host: string }> = [];
  const seen = new Set<string>();
  for (const s of sources ?? []) {
    let u: URL;
    try {
      u = new URL(s.url);
    } catch {
      continue;
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || seen.has(u.href)) continue;
    seen.add(u.href);
    const host = u.hostname.replace(/^www\./, "");
    const title = s.title?.trim();
    out.push({ url: u.href, label: title && title !== host ? title : host, host });
    if (out.length >= max) break;
  }
  return out;
}
