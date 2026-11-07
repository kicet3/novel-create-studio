/** 작품 홈: 소개, 평점·좋아요, 공개된 화 목차, 첫 화 / 이어 보기. */
import { useMemo } from "react";
import { FINISHED_RATIO, episodeLabel, loadHistory, loadResume, readingMinutes } from "@ncs/reader-core";
import { PUBLIC_AGE_LABELS } from "@ncs/reader-core/snapshot";
import { SITE_NAME, browserStore, useDocumentMeta } from "../lib/hooks.js";
import { href, Link } from "../lib/router.js";
import { loadNovel, useAsync } from "../lib/data.js";
import { Message, formatDate } from "../components/ui.js";
import { NovelSocial } from "../components/social.js";
import { AppHeader } from "./AppHeader.js";

export function NovelHome({ slug }: { slug: string }) {
  const q = useAsync(`novel:${slug}`, () => loadNovel(slug));
  const n = q.data?.slug === slug ? q.data : undefined;
  useDocumentMeta(n ? `${n.title} · ${SITE_NAME}` : null, n?.intro || (n ? `${n.title} — 공개된 ${n.episodes.length}화` : null));
  const resume = useMemo(() => loadResume(browserStore(), slug), [slug]);
  const history = useMemo(() => loadHistory(browserStore(), slug), [slug]);
  const first = n?.episodes[0];
  const resumeEp = resume && n?.episodes.find((e) => e.episodeNo === resume.episodeNo);
  return (
    <div className="pr-page">
      <AppHeader back={href.list()} title={n?.title} />
      <main className="pr-main" id="main">
        {q.error && <Message tone="danger">{q.error.message === "찾을 수 없습니다." ? "공개된 작품이 아닙니다." : "작품을 불러오지 못했습니다."}</Message>}
        {!n && !q.error && <Message>불러오는 중…</Message>}
        {n && (
          <>
            <section className="pr-hero">
              <h1 className="pr-h1">{n.title}</h1>
              <p className="pr-hero-meta">{[n.authorName, n.genre, PUBLIC_AGE_LABELS[n.ageRating], `공개 ${n.episodes.length}화`].filter(Boolean).join(" · ")}</p>
              {n.intro && <p className="pr-intro">{n.intro}</p>}
              <div className="pr-hero-actions">
                {resumeEp ? (
                  <Link className="pr-btn pr-btn-primary pr-btn-block" to={href.episode(slug, resumeEp.episodeNo)}>
                    {resume!.ratio >= FINISHED_RATIO ? "다시 보기" : "이어 보기"} · {episodeLabel(resumeEp.episodeNo, resumeEp.title)}
                  </Link>
                ) : (
                  first && (
                    <Link className="pr-btn pr-btn-primary pr-btn-block" to={href.episode(slug, first.episodeNo)}>
                      첫 화 보기
                    </Link>
                  )
                )}
              </div>
              <NovelSocial slug={slug} />
            </section>
            <section aria-labelledby="toc-title">
              <h2 id="toc-title" className="pr-h2">
                목차 <span className="pr-faint">{n.episodes.length}화</span>
              </h2>
              {!n.episodes.length && <Message>아직 공개된 화가 없습니다.</Message>}
              <ol className="pr-toc">
                {n.episodes.map((e) => (
                  <li key={e.episodeNo}>
                    <Link to={href.episode(slug, e.episodeNo)} className="pr-toc-row" data-read={history[e.episodeNo] ?? "none"}>
                      <span className="pr-toc-no">{e.episodeNo}화</span>
                      <span className="pr-toc-title">{e.title ?? ""}</span>
                      <span className="pr-toc-meta">
                        {history[e.episodeNo] === "read" ? "읽음 · " : ""}
                        {formatDate(e.publishedAt)} · {readingMinutes(e.charCount)}분
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
