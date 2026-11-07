import type { MetadataRoute } from "next";
import { getEnv } from "@/src/server/env";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const origin = getEnv().publicOrigin;
  return { rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/admin"] }], sitemap: `${origin}/sitemap.xml`, host: origin };
}
