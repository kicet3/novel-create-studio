/**
 * Cached reads for the server-rendered pages (Next data cache; tag `snowpage-content`). Pages themselves are
 * rendered per request (nonce CSP), so `next build` never touches the database.
 *
 * Freshness: the studio calls POST /api/admin/revalidate right after a sync that changed something (bearer
 * ADMIN_TOKEN), which marks the tag stale so the next request re-reads the database. The 30 s time-based
 * revalidate is only the fallback for when that token is not configured in the studio.
 */
import "server-only";
import { unstable_cache } from "next/cache";
import { CONTENT_TAG } from "./cache-tags";
import { getEpisode, getNovel, listNovels, novelAggregates, sitemapRows } from "./content";
import { getDb } from "./db";

export { CONTENT_TAG };
/** fallback freshness when the studio cannot purge on demand */
export const CONTENT_REVALIDATE_S = 30;
const opts = { revalidate: CONTENT_REVALIDATE_S, tags: [CONTENT_TAG] };

export const cachedNovelList = unstable_cache(async () => {
  const { client, schema } = getDb();
  return listNovels(client, schema);
}, ["snowpage:list:v1"], opts);

export const cachedNovel = unstable_cache(async (slug: string) => {
  const { client, schema } = getDb();
  return getNovel(client, schema, slug);
}, ["snowpage:novel:v1"], opts);

export const cachedEpisode = unstable_cache(async (slug: string, episodeNo: number) => {
  const { client, schema } = getDb();
  return getEpisode(client, schema, slug, episodeNo);
}, ["snowpage:episode:v1"], opts);

export const cachedNovelAggregates = unstable_cache(async (slug: string) => {
  const { client, schema } = getDb();
  return novelAggregates(client, schema, slug);
}, ["snowpage:novel-agg:v1"], opts);

export const cachedSitemap = unstable_cache(async () => {
  const { client, schema } = getDb();
  return sitemapRows(client, schema);
}, ["snowpage:sitemap:v1"], { revalidate: 600, tags: [CONTENT_TAG] });
