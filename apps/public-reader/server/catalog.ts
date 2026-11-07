/**
 * What is public right now, read from the snapshot in DATA_DIR (written by the studio's publication module).
 * Likes / ratings / comments only attach to novels and episodes listed here; an unpublished episode disappears
 * from the snapshot, so its comments stop being served (they stay in the DB).
 * Cached per file by mtime + size (the snapshot is rewritten atomically by rename).
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PublicNovelHome, PublicNovelList } from "@ncs/reader-core/snapshot";

/** same rule as PUBLIC_SLUG_RE in @ncs/reader-core/snapshot (kept local: the server has no runtime workspace deps) */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const isSlug = (s: string) => SLUG_RE.test(s) && !s.includes("--");

export interface Catalog {
  list(): PublicNovelList | null;
  novel(slug: string): PublicNovelHome | null;
  hasEpisode(slug: string, episodeNo: number): boolean;
}

export function createCatalog(dataDir: string): Catalog {
  const cache = new Map<string, { key: string; value: unknown }>();
  const load = <T>(rel: string): T | null => {
    const path = join(dataDir, rel);
    try {
      const st = statSync(path);
      if (!st.isFile()) return null;
      const key = `${st.mtimeMs}:${st.size}`;
      const hit = cache.get(rel);
      if (hit && hit.key === key) return hit.value as T;
      const value = JSON.parse(readFileSync(path, "utf8")) as T;
      cache.set(rel, { key, value });
      if (cache.size > 2000) cache.delete(cache.keys().next().value!);
      return value;
    } catch {
      cache.delete(rel);
      return null;
    }
  };
  const novel = (slug: string) => {
    if (!isSlug(slug)) return null;
    // listed in novels.json AND has its own index (an opted-out novel is gone from both)
    const listed = load<PublicNovelList>("novels.json")?.novels?.some((n) => n.slug === slug);
    return listed ? load<PublicNovelHome>(`novels/${slug}/index.json`) : null;
  };
  return {
    list: () => load<PublicNovelList>("novels.json"),
    novel,
    hasEpisode: (slug, no) => Number.isInteger(no) && no >= 1 && !!novel(slug)?.episodes?.some((e) => e.episodeNo === no),
  };
}
