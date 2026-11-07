/** / — 소설 목록 (공개된 작품 전부). */
import Link from "next/link";
import type { Metadata } from "next";
import { PUBLIC_AGE_LABELS } from "@ncs/reader-core/snapshot";
import { AppHeader } from "@/src/components/AppHeader";
import { formatDate } from "@/src/components/format";
import { Message } from "@/src/components/ui";
import { href, SITE_DESCRIPTION, SITE_NAME } from "@/src/lib/href";
import { cachedNovelList } from "@/src/server/cached";

export const metadata: Metadata = {
  title: { absolute: `${SITE_NAME} — 연재 소설 읽기` },
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/" },
};

export default async function NovelListPage() {
  const novels = await cachedNovelList();
  return (
    <div className="pr-page">
      <AppHeader />
      <main className="pr-main" id="main">
        <h1 className="pr-h1">작품</h1>
        {!novels.length && <Message>아직 공개된 작품이 없습니다.</Message>}
        <ul className="pr-novel-grid">
          {novels.map((n) => (
            <li key={n.slug}>
              <Link href={href.novel(n.slug)} className="pr-card">
                <span className="pr-card-title">{n.title}</span>
                <span className="pr-card-meta">{[n.authorName, n.genre, n.ageRating !== "all" ? PUBLIC_AGE_LABELS[n.ageRating] : null].filter(Boolean).join(" · ")}</span>
                {n.intro && <span className="pr-card-intro">{n.intro}</span>}
                <span className="pr-card-foot">
                  공개 {n.episodeCount}화{n.updatedAt ? ` · ${formatDate(n.updatedAt)} 업데이트` : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
