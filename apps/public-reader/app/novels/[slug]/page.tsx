/** /novels/[slug] — 작품 홈: 소개, 평점 평균·좋아요, 목차. Not published → 404. */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PUBLIC_AGE_LABELS, isPublicSlug } from "@ncs/reader-core/snapshot";
import { AppHeader } from "@/src/components/AppHeader";
import { NovelSocial } from "@/src/components/social";
import { NovelToc, StartReading } from "@/src/components/NovelReading";
import { href, SITE_NAME } from "@/src/lib/href";
import { cachedNovel, cachedNovelAggregates } from "@/src/server/cached";

type Props = { params: Promise<{ slug: string }> };

const describe = (intro: string, title: string, count: number) => (intro.replace(/\s+/g, " ").trim() || `${title} — 공개된 ${count}화`).slice(0, 160);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const n = isPublicSlug(slug) ? await cachedNovel(slug) : null;
  if (!n) return { title: "찾을 수 없습니다", robots: { index: false } };
  const description = describe(n.intro, n.title, n.episodes.length);
  return {
    title: n.title,
    description,
    alternates: { canonical: href.novel(slug) },
    openGraph: { type: "book", siteName: SITE_NAME, locale: "ko_KR", url: href.novel(slug), title: `${n.title} · ${SITE_NAME}`, description },
  };
}

export default async function NovelHomePage({ params }: Props) {
  const { slug } = await params;
  if (!isPublicSlug(slug)) notFound();
  const n = await cachedNovel(slug);
  if (!n) notFound();
  const agg = await cachedNovelAggregates(slug);
  return (
    <div className="pr-page">
      <AppHeader back={href.list()} title={n.title} />
      <main className="pr-main" id="main">
        <section className="pr-hero">
          <h1 className="pr-h1">{n.title}</h1>
          <p className="pr-hero-meta">{[n.authorName, n.genre, PUBLIC_AGE_LABELS[n.ageRating], `공개 ${n.episodes.length}화`].filter(Boolean).join(" · ")}</p>
          {n.intro && <p className="pr-intro">{n.intro}</p>}
          <div className="pr-hero-actions">
            <StartReading slug={slug} episodes={n.episodes} />
          </div>
          <NovelSocial slug={slug} initial={agg} />
        </section>
        <section aria-labelledby="toc-title">
          <h2 id="toc-title" className="pr-h2">
            목차 <span className="pr-faint">{n.episodes.length}화</span>
          </h2>
          <NovelToc slug={slug} episodes={n.episodes} />
        </section>
      </main>
    </div>
  );
}
