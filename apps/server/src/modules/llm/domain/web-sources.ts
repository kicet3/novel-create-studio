/**
 * 설계 추가 0011: sources the model says it used. The search policy asks the model to end a string that used search
 * results with a trailer
 *
 *   출처:
 *   - [제목](https://…)
 *
 * The gateway cuts these trailers out of the output (text, or any string inside an object output) before validation
 * and storage, and keeps their links as the call's citations — the app shows sources itself (footnote "출처"), and a
 * search result the model did not use never shows up as a source. Pure.
 */
import type { LlmCitation } from "../index.js";

const HEAD = /(?:^|\n)[ \t]*(?:\*\*)?(?:출처|참고 자료|참고|Sources?)(?:\*\*)?[ \t]*[:：]?[ \t]*(?:\n|$)/i;
const MD_LINK = /\[([^\]\n]{0,200})\]\((https?:\/\/[^\s)]+)\)/;
const BARE = /(https?:\/\/[^\s)>\]]+)/;

/** one trailer line → link (null when the line is not a source line) */
function lineLink(line: string): { url: string; title: string | null } | null | "blank" {
  const t = line.trim();
  if (!t) return "blank";
  const body = t.replace(/^(?:[-*•·]|\d+[.)])\s*/, "");
  const md = MD_LINK.exec(body);
  if (md) return { url: md[2]!, title: md[1]!.trim() || null };
  const bare = BARE.exec(body);
  if (bare) {
    const title = body.replace(bare[1]!, "").replace(/[—–:\-·|]+\s*$/, "").replace(/^\s*[—–:\-·|]+/, "").trim();
    return { url: bare[1]!.replace(/[.,;]+$/, ""), title: title || null };
  }
  return null;
}

/** cut a trailing source block off one string; returns the string unchanged when the tail is not a pure link list */
export function cutSourceTrailer(s: string): { text: string; links: Array<{ url: string; title: string | null }> } {
  let at = -1;
  let from = 0;
  // the LAST heading whose following lines are all links (or blank)
  for (;;) {
    const m = HEAD.exec(s.slice(from));
    if (!m) break;
    const start = from + m.index;
    at = start;
    from = start + Math.max(1, m[0].length);
  }
  if (at < 0) return { text: s, links: [] };
  const head = HEAD.exec(s.slice(at))!;
  const tail = s.slice(at + head.index + head[0].length);
  const links: Array<{ url: string; title: string | null }> = [];
  for (const line of tail.split("\n")) {
    const l = lineLink(line);
    if (l === "blank") continue;
    if (!l) return { text: s, links: [] };
    // several markdown links on one line
    const all = [...line.matchAll(new RegExp(MD_LINK, "g"))];
    if (all.length > 1) for (const x of all) links.push({ url: x[2]!, title: x[1]!.trim() || null });
    else links.push(l);
  }
  if (!links.length) return { text: s, links: [] };
  return { text: s.slice(0, at).replace(/\s+$/, ""), links };
}

/** inline form "출처: [a](u1), [b](u2)" at the very end of a string */
function cutInlineTrailer(s: string): { text: string; links: Array<{ url: string; title: string | null }> } {
  const m = /(?:^|\n)[ \t]*(?:\*\*)?(?:출처|Sources?)(?:\*\*)?[ \t]*[:：][ \t]*((?:\[[^\]\n]{0,200}\]\(https?:\/\/[^\s)]+\)[ \t,·]*)+)\s*$/i.exec(s);
  if (!m) return { text: s, links: [] };
  const links = [...m[1]!.matchAll(new RegExp(MD_LINK, "g"))].map((x) => ({ url: x[2]!, title: x[1]!.trim() || null }));
  return { text: s.slice(0, m.index).replace(/\s+$/, ""), links };
}

function cut(s: string) {
  const a = cutSourceTrailer(s);
  if (a.links.length) return a;
  return cutInlineTrailer(s);
}

/**
 * Strip source trailers from a text or from every string inside an object output.
 * Returns the cleaned value and the links found (deduped, in order).
 */
export function extractSourceTrailers<T>(value: T, retrievedAt: string): { value: T; citations: LlmCitation[] } {
  const found: LlmCitation[] = [];
  const seen = new Set<string>();
  const add = (links: Array<{ url: string; title: string | null }>) => {
    for (const l of links) {
      if (seen.has(l.url)) continue;
      seen.add(l.url);
      found.push({ url: l.url, title: l.title, retrievedAt });
    }
  };
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 12) return v;
    if (typeof v === "string") {
      const r = cut(v);
      if (!r.links.length) return v;
      add(r.links);
      return r.text;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x, depth + 1);
      return o;
    }
    return v;
  };
  return { value: walk(value, 0) as T, citations: found };
}
