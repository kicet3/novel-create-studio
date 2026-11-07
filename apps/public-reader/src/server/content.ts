/**
 * Published content (read-only): rows the studio synced into `<schema>.novels` / `<schema>.episodes`. A novel or
 * episode that is not there is not public (unpublished / opted out) → callers answer 404.
 * Pure over a SqlClient (postgres.js in production, PGlite in tests). Every value is a bind parameter; the schema
 * is a validated, quoted identifier.
 */
import { assertSchemaName, quoteIdent, type SqlClient } from "@ncs/public-schema";
import {
  isPublicSlug,
  PUBLIC_SNAPSHOT_VERSION,
  type PublicAgeRating,
  type PublicEpisode,
  type PublicEpisodeRef,
  type PublicNovelHome,
  type PublicNovelSummary,
} from "@ncs/reader-core/snapshot";

const AGE: readonly PublicAgeRating[] = ["all", "age_12", "age_15", "age_19"];
const age = (v: unknown): PublicAgeRating => (AGE.includes(v as PublicAgeRating) ? (v as PublicAgeRating) : "all");
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export const isEpisodeNo = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 999_999;

interface NovelRow {
  slug: string;
  title: string;
  author_name: string;
  intro: string;
  genre: string;
  age_rating: string;
  episode_count: number | string;
  latest_published_at: Date | string | null;
}

const NOVEL_COLS = "slug, title, author_name, intro, genre, age_rating, episode_count, latest_published_at";

const summary = (r: NovelRow): PublicNovelSummary => ({
  slug: r.slug,
  title: r.title,
  genre: r.genre,
  ageRating: age(r.age_rating),
  authorName: r.author_name,
  intro: r.intro,
  episodeCount: Number(r.episode_count),
  updatedAt: iso(r.latest_published_at),
});

export async function listNovels(c: SqlClient, schema: string): Promise<PublicNovelSummary[]> {
  const s = quoteIdent(assertSchemaName(schema));
  const rows = await c.query<NovelRow>(`SELECT ${NOVEL_COLS} FROM ${s}.novels ORDER BY latest_published_at DESC NULLS LAST, slug LIMIT 500`);
  return rows.map(summary);
}

export async function getNovel(c: SqlClient, schema: string, slug: string): Promise<PublicNovelHome | null> {
  if (!isPublicSlug(slug)) return null;
  const s = quoteIdent(assertSchemaName(schema));
  const [n] = await c.query<NovelRow>(`SELECT ${NOVEL_COLS} FROM ${s}.novels WHERE slug = $1`, [slug]);
  if (!n) return null;
  const eps = await c.query<{ episode_no: number | string; title: string | null; char_count: number | string; published_at: Date | string | null }>(
    `SELECT episode_no, title, char_count, published_at FROM ${s}.episodes WHERE novel_slug = $1 ORDER BY episode_no`,
    [slug],
  );
  const sm = summary(n);
  return {
    version: PUBLIC_SNAPSHOT_VERSION,
    slug: sm.slug,
    title: sm.title,
    genre: sm.genre,
    ageRating: sm.ageRating,
    authorName: sm.authorName,
    intro: sm.intro,
    episodes: eps.map((e) => ({ episodeNo: Number(e.episode_no), title: e.title, charCount: Number(e.char_count), publishedAt: iso(e.published_at) })),
  };
}

export interface EpisodePage extends PublicEpisode {
  novelTitle: string;
  novelIntro: string;
  authorName: string;
}

export async function getEpisode(c: SqlClient, schema: string, slug: string, episodeNo: number): Promise<EpisodePage | null> {
  if (!isPublicSlug(slug) || !isEpisodeNo(episodeNo)) return null;
  const s = quoteIdent(assertSchemaName(schema));
  const [e] = await c.query<{ title: string | null; body: string; char_count: number | string; published_at: Date | string | null; novel_title: string; intro: string; author_name: string }>(
    `SELECT e.title, e.body, e.char_count, e.published_at, n.title AS novel_title, n.intro, n.author_name
     FROM ${s}.episodes e JOIN ${s}.novels n ON n.slug = e.novel_slug WHERE e.novel_slug = $1 AND e.episode_no = $2`,
    [slug, episodeNo],
  );
  if (!e) return null;
  const ref = async (dir: "prev" | "next"): Promise<PublicEpisodeRef | null> => {
    const [r] = await c.query<{ episode_no: number | string; title: string | null }>(
      dir === "prev"
        ? `SELECT episode_no, title FROM ${s}.episodes WHERE novel_slug = $1 AND episode_no < $2 ORDER BY episode_no DESC LIMIT 1`
        : `SELECT episode_no, title FROM ${s}.episodes WHERE novel_slug = $1 AND episode_no > $2 ORDER BY episode_no ASC LIMIT 1`,
      [slug, episodeNo],
    );
    return r ? { episodeNo: Number(r.episode_no), title: r.title } : null;
  };
  const [prev, next] = [await ref("prev"), await ref("next")];
  return {
    version: PUBLIC_SNAPSHOT_VERSION,
    slug,
    episodeNo,
    title: e.title,
    text: e.body,
    charCount: Number(e.char_count),
    publishedAt: iso(e.published_at),
    prev,
    next,
    novelTitle: e.novel_title,
    novelIntro: e.intro,
    authorName: e.author_name,
  };
}

export async function novelExists(c: SqlClient, schema: string, slug: string): Promise<boolean> {
  if (!isPublicSlug(slug)) return false;
  const s = quoteIdent(assertSchemaName(schema));
  return (await c.query(`SELECT 1 AS x FROM ${s}.novels WHERE slug = $1`, [slug])).length > 0;
}

export async function episodeExists(c: SqlClient, schema: string, slug: string, episodeNo: number): Promise<boolean> {
  if (!isPublicSlug(slug) || !isEpisodeNo(episodeNo)) return false;
  const s = quoteIdent(assertSchemaName(schema));
  return (await c.query(`SELECT 1 AS x FROM ${s}.episodes WHERE novel_slug = $1 AND episode_no = $2`, [slug, episodeNo])).length > 0;
}

/** public aggregates shown on the server-rendered novel page (per-visitor bits come from the API) */
export async function novelAggregates(c: SqlClient, schema: string, slug: string): Promise<{ likes: number; ratingAverage: number | null; ratingCount: number }> {
  const s = quoteIdent(assertSchemaName(schema));
  const [l] = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${s}.novel_likes WHERE novel_slug = $1`, [slug]);
  const [r] = await c.query<{ n: number; avg: string | number | null }>(`SELECT count(*)::int AS n, round(avg(score)::numeric, 1)::text AS avg FROM ${s}.ratings WHERE novel_slug = $1`, [slug]);
  return { likes: Number(l?.n ?? 0), ratingCount: Number(r?.n ?? 0), ratingAverage: r?.avg === null || r?.avg === undefined ? null : Number(r.avg) };
}

export async function sitemapRows(c: SqlClient, schema: string): Promise<Array<{ slug: string; episodeNo: number | null; updatedAt: string | null }>> {
  const s = quoteIdent(assertSchemaName(schema));
  const novels = await c.query<{ slug: string; updated_at: Date | string | null }>(`SELECT slug, updated_at FROM ${s}.novels ORDER BY slug LIMIT 1000`);
  const eps = await c.query<{ novel_slug: string; episode_no: number | string; updated_at: Date | string | null }>(
    `SELECT novel_slug, episode_no, updated_at FROM ${s}.episodes ORDER BY novel_slug, episode_no LIMIT 40000`,
  );
  return [
    ...novels.map((n) => ({ slug: n.slug, episodeNo: null, updatedAt: iso(n.updated_at) })),
    ...eps.map((e) => ({ slug: e.novel_slug, episodeNo: Number(e.episode_no), updatedAt: iso(e.updated_at) })),
  ];
}
