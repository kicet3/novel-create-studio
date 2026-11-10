/**
 * 공개 사이트 스냅숏 — the static JSON contract between the studio (writer: apps/server module `publication`)
 * and the public reader (reader: apps/public-reader). Only PUBLISHED episodes of non-archived novels
 * are ever written; nothing here may carry internal ids, notes, outlines, bible or ontology data.
 *
 *   <data>/novels.json                         → PublicNovelList
 *   <data>/novels/<slug>/index.json            → PublicNovelHome
 *   <data>/novels/<slug>/episodes/<no>.json    → PublicEpisode
 *
 * The allow-lists below are the complete key sets (tests assert written files contain exactly these keys).
 */
export const PUBLIC_SNAPSHOT_VERSION = 1;

/**
 * public address of a novel: lowercase letters, digits and inner hyphens / underscores, 1–64 chars (no "--").
 * The studio uses the lowercased novel id (e.g. nov_01m6qxdwfxeahe006mnnhf9j5j). Same rule as the public schema
 * check (v3) and PUBLIC_SITE_SLUG_RE in @ncs/shared.
 */
export const PUBLIC_SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
export const isPublicSlug = (s: unknown): s is string => typeof s === "string" && PUBLIC_SLUG_RE.test(s) && !s.includes("--");

export type PublicAgeRating = "all" | "age_12" | "age_15" | "age_19";
export const PUBLIC_AGE_LABELS: Record<PublicAgeRating, string> = { all: "전체 이용가", age_12: "12세 이용가", age_15: "15세 이용가", age_19: "19세 이용가" };

export interface PublicNovelSummary {
  slug: string;
  title: string;
  genre: string;
  ageRating: PublicAgeRating;
  authorName: string;
  intro: string;
  episodeCount: number;
  /** ISO time of the latest published episode (null: none yet) */
  updatedAt: string | null;
}

export interface PublicNovelList {
  version: number;
  generatedAt: string;
  novels: PublicNovelSummary[];
}

export interface PublicEpisodeRef {
  episodeNo: number;
  title: string | null;
}

export interface PublicTocEntry extends PublicEpisodeRef {
  charCount: number;
  publishedAt: string | null;
}

export interface PublicNovelHome {
  version: number;
  slug: string;
  title: string;
  genre: string;
  ageRating: PublicAgeRating;
  authorName: string;
  intro: string;
  episodes: PublicTocEntry[];
}

export interface PublicEpisode {
  version: number;
  slug: string;
  episodeNo: number;
  title: string | null;
  /** reading text: one non-empty line = one paragraph, `* * *` line = scene break */
  text: string;
  charCount: number;
  publishedAt: string | null;
  prev: PublicEpisodeRef | null;
  next: PublicEpisodeRef | null;
}

export const PUBLIC_LIST_KEYS = ["version", "generatedAt", "novels"] as const;
export const PUBLIC_SUMMARY_KEYS = ["slug", "title", "genre", "ageRating", "authorName", "intro", "episodeCount", "updatedAt"] as const;
export const PUBLIC_HOME_KEYS = ["version", "slug", "title", "genre", "ageRating", "authorName", "intro", "episodes"] as const;
export const PUBLIC_TOC_KEYS = ["episodeNo", "title", "charCount", "publishedAt"] as const;
export const PUBLIC_EPISODE_KEYS = ["version", "slug", "episodeNo", "title", "text", "charCount", "publishedAt", "prev", "next"] as const;
export const PUBLIC_REF_KEYS = ["episodeNo", "title"] as const;

/** relative paths inside the data dir */
export const publicPaths = {
  list: "novels.json",
  home: (slug: string) => `novels/${slug}/index.json`,
  episode: (slug: string, episodeNo: number) => `novels/${slug}/episodes/${episodeNo}.json`,
};
