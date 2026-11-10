/**
 * 공개 사이트 DB rows — pure: published-only inputs → allow-listed rows of the public schema's content tables
 * (@ncs/public-schema PUBLIC_NOVEL_COLUMNS / PUBLIC_EPISODE_COLUMNS) with a content hash each, so a sync can skip
 * what did not change. Same cleaning as the static snapshot (domain/snapshot.ts).
 */
import { createHash } from "node:crypto";
import type { SnapshotNovelInput } from "./snapshot.js";

export interface PublicNovelRow {
  slug: string;
  title: string;
  author_name: string;
  intro: string;
  genre: string;
  age_rating: string;
  episode_count: number;
  latest_published_at: string | null;
  content_hash: string;
}

export interface PublicEpisodeRow {
  novel_slug: string;
  episode_no: number;
  title: string | null;
  body: string;
  char_count: number;
  published_at: string | null;
  /** v2 (설계 추가 0023): 에피소드 묶음 */
  unit_title: string | null;
  unit_part_no: number | null;
  unit_part_count: number | null;
  content_hash: string;
}

export interface PublicNovelRows {
  novel: PublicNovelRow;
  episodes: PublicEpisodeRow[];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const clean = (s: string | null | undefined) => (s ?? "").replace(/\r\n?/g, "\n").trim();
const cleanTitle = (s: string | null) => (s?.trim() ? s.trim() : null);
const hashOf = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export function toPublicRows(n: SnapshotNovelInput): PublicNovelRows {
  const eps = [...n.episodes].filter((e) => Number.isInteger(e.episodeNo) && e.episodeNo >= 1).sort((a, b) => a.episodeNo - b.episodeNo);
  const episodes = eps.map((e): PublicEpisodeRow => {
    const row = { novel_slug: n.slug, episode_no: e.episodeNo, title: cleanTitle(e.title), body: e.text, char_count: e.charCount, published_at: iso(e.publishedAt) };
    const unitTitle = cleanTitle(e.unitTitle ?? null);
    const unit = {
      unit_title: unitTitle,
      unit_part_no: unitTitle && e.unitPartNo ? e.unitPartNo : null,
      unit_part_count: unitTitle && e.unitPartCount ? e.unitPartCount : null,
    };
    // the hash covers the unit fields only when there is a 묶음 (unchanged rows of older syncs are not rewritten)
    return { ...row, ...unit, content_hash: hashOf(unitTitle ? { ...row, ...unit } : row) };
  });
  const latest = eps.reduce<Date | null>((m, e) => (e.publishedAt && (!m || e.publishedAt > m) ? e.publishedAt : m), null);
  const novel = {
    slug: n.slug,
    title: n.title.trim(),
    author_name: n.authorName.trim(),
    intro: clean(n.intro),
    genre: n.genre.trim(),
    age_rating: n.ageRating,
    episode_count: episodes.length,
    latest_published_at: iso(latest),
  };
  return { novel: { ...novel, content_hash: hashOf(novel) }, episodes };
}
