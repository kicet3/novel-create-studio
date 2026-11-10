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

/** schema not created yet (studio never synced) or DB unreachable → a calm "준비 중" instead of a 500 */
async function loadNovels(): Promise<Awaited<ReturnType<typeof cachedNovelList>> | null> {
  try {
    return await cachedNovelList();
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? "unknown";
    console.error(`[snowpage] novel list unavailable (code ${code})`); // no message: it may contain connection details
    return null;
  }
}

export default async function NovelListPage() {
  const loaded = await loadNovels();
  const novels = loaded ?? [];
  return (
    <div className="pr-page">
      <AppHeader />
      <main className="pr-main" id="main">
        <h1 className="pr-h1">작품</h1>
        {loaded === null ? <Message>사이트를 준비하고 있습니다. 잠시 후 다시 들러 주세요.</Message> : !novels.length && <Message>아직 공개된 작품이 없습니다.</Message>}
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
