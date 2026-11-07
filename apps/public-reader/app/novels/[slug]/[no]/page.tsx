/** /novels/[slug]/[no] — 화 읽기. Not published → 404. */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { episodeLabel } from "@ncs/reader-core";
import { isPublicSlug } from "@ncs/reader-core/snapshot";
import { EpisodeReader } from "@/src/reader/EpisodeReader";
import { href, SITE_NAME } from "@/src/lib/href";
import { cachedEpisode } from "@/src/server/cached";

type Props = { params: Promise<{ slug: string; no: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const parseNo = (no: string) => (/^[1-9]\d{0,5}$/.test(no) ? Number(no) : null);

async function load(params: Props["params"]) {
  const { slug, no } = await params;
  const n = parseNo(no);
  if (!isPublicSlug(slug) || n === null) return null;
  return cachedEpisode(slug, n);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const ep = await load(params);
  if (!ep) return { title: "찾을 수 없습니다", robots: { index: false } };
  const heading = episodeLabel(ep.episodeNo, ep.title);
  const description = (ep.text.replace(/\s+/g, " ").trim().slice(0, 140) || ep.novelIntro).slice(0, 160);
  const url = href.episode(ep.slug, ep.episodeNo);
  return {
    title: `${ep.novelTitle} ${heading}`,
    description,
    alternates: { canonical: url },
    openGraph: { type: "article", siteName: SITE_NAME, locale: "ko_KR", url, title: `${ep.novelTitle} ${heading} · ${SITE_NAME}`, description, publishedTime: ep.publishedAt ?? undefined },
  };
}

export default async function EpisodePage({ params, searchParams }: Props) {
  const ep = await load(params);
  if (!ep) notFound();
  const sp = await searchParams;
  const { novelTitle, novelIntro: _intro, authorName: _author, ...episode } = ep;
  return <EpisodeReader ep={episode} novelTitle={novelTitle} startAtEnd={sp.at === "end"} />;
}
