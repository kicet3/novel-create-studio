/** reading text: blocks (paragraph | scene break | illustration), the episode heading, the end-of-episode card. */
import { memo, useMemo, type ReactNode } from "react";
import { episodeLabel, paragraphIndexes, type ReadingBlock } from "@ncs/reader-core/model";
import { ReaderIcon } from "./icons.js";

/** one block; text paragraphs carry `data-p` (paragraph index = ReadingAnchor.para) */
export function Block({ b, p }: { b: ReadingBlock; p: number | null }) {
  switch (b.type) {
    case "p":
      return <p data-p={p ?? undefined}>{b.text}</p>;
    case "break":
      return (
        <div className="reader-break" role="separator" aria-label="장면 전환">
          <span aria-hidden="true">◆</span>
        </div>
      );
    case "image":
      return (
        <figure className="reader-figure">
          <img src={b.src} alt={b.alt} loading="lazy" decoding="async" width={b.width ?? undefined} height={b.height ?? undefined} />
          {b.caption && <figcaption>{b.caption}</figcaption>}
        </figure>
      );
  }
}

/** title block at the top of an episode (scroll view: above the text; page view: top of page 1) */
export function EpisodeHeading({ episodeNo, title, titleId, meta, notice }: { episodeNo: number; title: string | null | undefined; titleId?: string; meta?: ReactNode; notice?: ReactNode }) {
  return (
    <header className="mb-10 pt-2 text-center sm:mb-12">
      {title?.trim() && <p className="mb-2 text-[0.8em] font-semibold tracking-wide text-muted tabular">{episodeNo}화</p>}
      <h1 id={titleId} className="reader-title text-[1.4em] leading-snug font-bold text-balance">
        {title?.trim() || `${episodeNo}화`}
      </h1>
      {meta && <p className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[13px] text-muted">{meta}</p>}
      {notice}
    </header>
  );
}

/** an episode as one column: heading + text (scroll view, server render) */
export const ReadingArticle = memo(function ReadingArticle({ blocks, header, titleId }: { blocks: readonly ReadingBlock[]; header: ReactNode; titleId?: string }) {
  const paras = useMemo(() => paragraphIndexes(blocks), [blocks]);
  return (
    <article className="reader-column" aria-labelledby={titleId}>
      {header}
      {blocks.length ? (
        <div className="reader-prose">
          {blocks.map((b, i) => (
            <Block key={i} b={b} p={paras[i] ?? null} />
          ))}
        </div>
      ) : (
        <p className="text-center text-muted">본문이 비어 있습니다.</p>
      )}
    </article>
  );
});

export interface EpisodeRefLike {
  episodeNo: number;
  title: string | null;
}

/**
 * end of an episode. `paged`: 페이지 넘김's last page (one more flip opens the next episode).
 * `extra`: app actions under the main button (studio: 읽고 승인 · 수정 대화; snowpage: 좋아요 · 댓글 · 평점).
 */
export function EndCard({ episodeNo, title, next, prev, paged = false, moreLater = false, skipped = null, onGo, onOpenToc, extra }: {
  episodeNo: number;
  title: string | null | undefined;
  next: EpisodeRefLike | null | undefined;
  prev: EpisodeRefLike | null | undefined;
  paged?: boolean;
  /** a later episode exists but is not readable yet */
  moreLater?: boolean;
  /** "3화" / "3·4화": episodes the 다음 화 skips (nothing readable) */
  skipped?: string | null;
  onGo: (episodeNo: number) => void;
  onOpenToc: () => void;
  extra?: ReactNode;
}) {
  return (
    <div className="reader-column rv-end-card py-12 text-center">
      <p className="text-[13px] font-semibold tracking-[0.18em] text-muted">{episodeNo}화 끝</p>
      <p className="reader-title mx-auto mt-2 max-w-[22em] text-[18px] leading-snug font-bold text-balance text-text">{title?.trim() || `${episodeNo}화`}</p>
      <div className="mx-auto mt-7 grid max-w-[420px] gap-2.5">
        {next ? (
          <button
            type="button"
            onClick={() => onGo(next.episodeNo)}
            className="flex min-h-[64px] w-full flex-col items-center justify-center rounded-[14px] bg-accent px-4 py-2.5 text-accent-text shadow-card hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span className="flex items-center gap-1 text-[16px] font-bold">
              다음 화 보기 <ReaderIcon name="next" size={18} />
            </span>
            <span className="mt-0.5 block max-w-full truncate text-[13px] font-medium opacity-90">{episodeLabel(next.episodeNo, next.title)}</span>
          </button>
        ) : (
          <div className="rounded-[14px] border border-dashed border-border px-4 py-5 text-[14px] text-muted">
            <p className="m-0 font-semibold text-text">지금 읽을 수 있는 최신 화입니다</p>
            {moreLater && <p className="m-0 mt-1 text-[13px]">다음 화는 아직 읽을 수 없습니다</p>}
          </div>
        )}
        {extra}
        {paged && next && <p className="m-0 text-[12.5px] text-muted">한 번 더 넘기면 다음 화로 넘어갑니다</p>}
        {skipped && (
          <p className="rounded-[10px] bg-warn-soft px-3 py-2 text-[13px] font-semibold text-warn">
            {skipped}는 아직 읽을 수 있는 원고가 없어 건너뜁니다
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!prev}
            onClick={() => prev && onGo(prev.episodeNo)}
            className="flex min-h-12 items-center justify-center gap-1 rounded-[12px] border border-border bg-surface text-[14px] font-semibold text-text hover:bg-surface-2 disabled:opacity-50"
          >
            <ReaderIcon name="back" size={17} /> 이전 화
          </button>
          <button
            type="button"
            onClick={onOpenToc}
            className="flex min-h-12 items-center justify-center gap-1.5 rounded-[12px] border border-border bg-surface text-[14px] font-semibold text-text hover:bg-surface-2"
          >
            <ReaderIcon name="list" size={17} /> 목차
          </button>
        </div>
      </div>
    </div>
  );
}
