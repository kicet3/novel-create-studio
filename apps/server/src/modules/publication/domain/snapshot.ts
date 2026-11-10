/**
 * 공개 사이트 스냅숏 — pure: published-only inputs → the static files (relative path → JSON text).
 * Only allow-listed public fields are copied (see @ncs/reader-core/snapshot); everything else stays in the studio.
 */
import {
  PUBLIC_SNAPSHOT_VERSION,
  publicPaths,
  type PublicAgeRating,
  type PublicEpisode,
  type PublicNovelHome,
  type PublicNovelList,
  type PublicNovelSummary,
} from "@ncs/reader-core/snapshot";

export interface SnapshotEpisodeInput {
  episodeNo: number;
  title: string | null;
  text: string;
  charCount: number;
  publishedAt: Date | null;
  /** 설계 추가 0023: 에피소드 묶음 (title is already "묶음 제목 (n)"); omitted / null = none */
  unitTitle?: string | null;
  unitPartNo?: number | null;
  unitPartCount?: number | null;
}

export interface SnapshotNovelInput {
  slug: string;
  title: string;
  genre: string;
  ageRating: PublicAgeRating;
  authorName: string;
  intro: string;
  /** published episodes only (the caller filters status published + published version) */
  episodes: SnapshotEpisodeInput[];
}

export interface Snapshot {
  files: Map<string, string>;
  novelCount: number;
  episodeCount: number;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const clean = (s: string | null | undefined) => (s ?? "").replace(/\r\n?/g, "\n").trim();
const cleanTitle = (s: string | null) => (s?.trim() ? s.trim() : null);

export function buildSnapshot(novels: readonly SnapshotNovelInput[], now: Date): Snapshot {
  const files = new Map<string, string>();
  const summaries: PublicNovelSummary[] = [];
  let episodeCount = 0;
  const write = (path: string, body: unknown) => files.set(path, `${JSON.stringify(body)}\n`);

  for (const n of [...novels].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const eps = [...n.episodes].filter((e) => Number.isInteger(e.episodeNo) && e.episodeNo >= 1).sort((a, b) => a.episodeNo - b.episodeNo);
    const ref = (e: SnapshotEpisodeInput | undefined) => (e ? { episodeNo: e.episodeNo, title: cleanTitle(e.title) } : null);
    eps.forEach((e, i) => {
      const body: PublicEpisode = {
        version: PUBLIC_SNAPSHOT_VERSION,
        slug: n.slug,
        episodeNo: e.episodeNo,
        title: cleanTitle(e.title),
        text: e.text,
        charCount: e.charCount,
        publishedAt: iso(e.publishedAt),
        prev: ref(eps[i - 1]),
        next: ref(eps[i + 1]),
      };
      write(publicPaths.episode(n.slug, e.episodeNo), body);
    });
    episodeCount += eps.length;
    const home: PublicNovelHome = {
      version: PUBLIC_SNAPSHOT_VERSION,
      slug: n.slug,
      title: n.title.trim(),
      genre: n.genre.trim(),
      ageRating: n.ageRating,
      authorName: n.authorName.trim(),
      intro: clean(n.intro),
      episodes: eps.map((e) => ({ episodeNo: e.episodeNo, title: cleanTitle(e.title), charCount: e.charCount, publishedAt: iso(e.publishedAt) })),
    };
    write(publicPaths.home(n.slug), home);
    const latest = eps.reduce<Date | null>((m, e) => (e.publishedAt && (!m || e.publishedAt > m) ? e.publishedAt : m), null);
    summaries.push({
      slug: n.slug,
      title: home.title,
      genre: home.genre,
      ageRating: home.ageRating,
      authorName: home.authorName,
      intro: home.intro,
      episodeCount: eps.length,
      updatedAt: iso(latest),
    });
  }
  // newest first on the list
  summaries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.slug.localeCompare(b.slug));
  const list: PublicNovelList = { version: PUBLIC_SNAPSHOT_VERSION, generatedAt: now.toISOString(), novels: summaries };
  write(publicPaths.list, list);
  return { files, novelCount: summaries.length, episodeCount };
}
