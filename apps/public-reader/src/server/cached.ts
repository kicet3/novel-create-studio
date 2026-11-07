/**
 * Cached reads for the server-rendered pages (Next data cache, 60 s; tag `snowpage-content`). Pages themselves are
 * rendered per request (nonce CSP), so `next build` never touches the database.
 */
import "server-only";
import { unstable_cache } from "next/cache";
import { getEpisode, getNovel, listNovels, novelAggregates, sitemapRows } from "./content";
import { getDb } from "./db";

export const CONTENT_TAG = "snowpage-content";
const opts = { revalidate: 60, tags: [CONTENT_TAG] };

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
}, ["snowpage:novel-agg:v1"], { revalidate: 60, tags: [CONTENT_TAG] });

export const cachedSitemap = unstable_cache(async () => {
  const { client, schema } = getDb();
  return sitemapRows(client, schema);
}, ["snowpage:sitemap:v1"], { revalidate: 600, tags: [CONTENT_TAG] });
