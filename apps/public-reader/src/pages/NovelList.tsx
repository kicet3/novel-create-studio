/** 작품 목록 — every novel in the published snapshot. */
import { PUBLIC_AGE_LABELS } from "@ncs/reader-core/snapshot";
import { SITE_NAME, useDocumentMeta } from "../lib/hooks.js";
import { href, Link } from "../lib/router.js";
import { loadList, useAsync } from "../lib/data.js";
import { Message, formatDate } from "../components/ui.js";
import { AppHeader } from "./AppHeader.js";

export function NovelList() {
  const q = useAsync("list", loadList);
  useDocumentMeta(SITE_NAME, "공개된 연재 소설을 읽는 곳입니다.");
  const novels = q.data?.novels ?? [];
  return (
    <div className="pr-page">
      <AppHeader />
      <main className="pr-main" id="main">
        <h1 className="pr-h1">작품</h1>
        {q.error && <Message tone="danger">작품 목록을 불러오지 못했습니다.</Message>}
        {q.loading && !q.data && <Message>불러오는 중…</Message>}
        {q.data && !novels.length && <Message>아직 공개된 작품이 없습니다.</Message>}
        <ul className="pr-novel-grid">
          {novels.map((n) => (
            <li key={n.slug}>
              <Link to={href.novel(n.slug)} className="pr-card">
                <span className="pr-card-title">{n.title}</span>
                <span className="pr-card-meta">
                  {[n.authorName, n.genre, n.ageRating !== "all" ? PUBLIC_AGE_LABELS[n.ageRating] : null].filter(Boolean).join(" · ")}
                </span>
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
