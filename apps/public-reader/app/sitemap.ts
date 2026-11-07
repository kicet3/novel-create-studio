/** sitemap.xml — published novels and episodes only (rows the studio synced). */
import type { MetadataRoute } from "next";
import { href } from "@/src/lib/href";
import { cachedSitemap } from "@/src/server/cached";
import { getEnv } from "@/src/server/env";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = getEnv().publicOrigin;
  const rows = await cachedSitemap();
  return [
    { url: `${origin}/`, changeFrequency: "daily", priority: 1 },
    ...rows.map((r) => ({
      url: `${origin}${r.episodeNo === null ? href.novel(r.slug) : href.episode(r.slug, r.episodeNo)}`,
      lastModified: r.updatedAt ?? undefined,
      changeFrequency: r.episodeNo === null ? ("daily" as const) : ("weekly" as const),
      priority: r.episodeNo === null ? 0.8 : 0.6,
    })),
  ];
}
