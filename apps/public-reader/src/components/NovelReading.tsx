"use client";
/** 작품 홈의 독자별 부분(localStorage): 첫 화 / 이어 보기 버튼, 목차의 읽음 표시. Server HTML shows the plain list. */
import Link from "next/link";
import { useMemo } from "react";
import { FINISHED_RATIO, episodeLabel, loadHistory, loadResume, readingMinutes } from "@ncs/reader-core";
import type { PublicTocEntry } from "@ncs/reader-core/snapshot";
import { browserStore, useMounted } from "../lib/hooks";
import { href } from "../lib/href";
import { formatDate } from "./format";
import { Message } from "./ui";

export function StartReading({ slug, episodes }: { slug: string; episodes: PublicTocEntry[] }) {
  const mounted = useMounted();
  const resume = useMemo(() => (mounted ? loadResume(browserStore(), slug) : null), [mounted, slug]);
  const first = episodes[0];
  const resumeEp = resume && episodes.find((e) => e.episodeNo === resume.episodeNo);
  if (resumeEp)
    return (
      <Link className="pr-btn pr-btn-primary pr-btn-block" href={href.episode(slug, resumeEp.episodeNo)}>
        {resume!.ratio >= FINISHED_RATIO ? "다시 보기" : "이어 보기"} · {episodeLabel(resumeEp.episodeNo, resumeEp.title)}
      </Link>
    );
  return first ? (
    <Link className="pr-btn pr-btn-primary pr-btn-block" href={href.episode(slug, first.episodeNo)}>
      첫 화 보기
    </Link>
  ) : null;
}

export function NovelToc({ slug, episodes }: { slug: string; episodes: PublicTocEntry[] }) {
  const mounted = useMounted();
  const history = useMemo(() => (mounted ? loadHistory(browserStore(), slug) : {}), [mounted, slug]) as Record<number, string | undefined>;
  if (!episodes.length) return <Message>아직 공개된 화가 없습니다.</Message>;
  return (
    <ol className="pr-toc">
      {episodes.map((e) => (
        <li key={e.episodeNo}>
          <Link href={href.episode(slug, e.episodeNo)} className="pr-toc-row" data-read={history[e.episodeNo] ?? "none"}>
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
  );
}
