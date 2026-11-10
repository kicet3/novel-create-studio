/**
 * 읽기 viewer bodies of the studio: 페이지 넘김 / 스크롤 보기 (optional 다음 화 이어 보기). The view mechanics
 * (pagination, track, wheel / swipe / tap zones, scroll anchors, progress store) live in @ncs/reader-ui and are shared
 * with snowpage; this file supplies the studio data (episode DTO, react-query sections, badges) to them.
 */
import { memo, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { labelKo, type ReaderEpisodeDto, type ReaderMode } from "@ncs/shared";
import {
  EndCard as SharedEndCard,
  EpisodeHeading,
  PageView as SharedPageView,
  ReadingArticle,
  ScrollView as SharedScrollView,
  type InitialPosition,
  type ProgressStore,
  type ViewEvents,
  type ViewHandle,
} from "@ncs/reader-ui";
import { Badge, QueryError, formatNumber } from "../../components/ui/index.js";
import { useReaderEpisodeExact } from "./api.js";
import { KIND_BADGE, ReaderIcon } from "./ReaderShell.js";
import { episodeLabel, readingMinutes, skippedLabel, textBlocks, type BlocksOf } from "./reader-model.js";
import type { PageGeometry } from "./reader-layout.js";

export { createProgressStore, useProgress, type InitialPosition, type ProgressState, type ProgressStore, type ViewEvents, type ViewHandle } from "@ncs/reader-ui";

// ── text ────────────────────────────────────────────────────────────────
/** title block at the top of an episode (scroll view: above the text; page view: top of page 1) */
function EpisodeHeader({ ep, titleId }: { ep: ReaderEpisodeDto; titleId?: string }) {
  const badge = KIND_BADGE[ep.source];
  return (
    <EpisodeHeading
      episodeNo={ep.episodeNo}
      title={ep.title}
      titleId={titleId}
      meta={
        <>
          <span className="tabular">
            {formatNumber(ep.charCount)}자 ({labelKo("count_basis", ep.countBasis)})
          </span>
          <span aria-hidden="true">·</span>
          <span>약 {readingMinutes(ep.charCount)}분</span>
          <Badge tone={badge.tone} glyph={ep.source === "draft"}>
            {badge.label}
          </Badge>
        </>
      }
      notice={
        ep.source === "draft" && (
          <p className="mx-auto mt-4 max-w-[30em] rounded-[10px] border border-violet/40 bg-violet-soft px-3 py-2 text-[13px] text-text">
            승인 전 초안입니다 ({labelKo("episode_status", ep.status)}). 내용이 바뀔 수 있습니다.
          </p>
        )
      }
    />
  );
}

/** `blocksOf`: extension point for illustrations (paragraphs | scene breaks | images); keep it referentially stable */
export const EpisodeArticle = memo(function EpisodeArticle({ ep, titleId, blocksOf = textBlocks }: { ep: ReaderEpisodeDto; titleId?: string; blocksOf?: BlocksOf }) {
  const blocks = useMemo(() => blocksOf(ep), [ep, blocksOf]);
  return <ReadingArticle blocks={blocks} header={<EpisodeHeader ep={ep} titleId={titleId} />} titleId={titleId} />;
});

// ── end of episode ──────────────────────────────────────────────────────
export interface EndActions {
  onGo(episodeNo: number): void;
  onOpenToc(): void;
  /** a later episode exists but is not readable yet */
  moreLater(episodeNo: number): boolean;
  /** 설계 추가 0018: an episode waiting for approval → open its 수정 대화 (승인은 인박스) */
  onReview?(episodeNo: number): void;
}

/** end of an episode. `paged`: 페이지 넘김's last page (one more flip opens the next episode) */
export function EndCard({ ep, actions, paged = false }: { ep: ReaderEpisodeDto; actions: EndActions; paged?: boolean }) {
  return (
    <SharedEndCard
      episodeNo={ep.episodeNo}
      title={ep.title}
      next={ep.next}
      prev={ep.prev}
      paged={paged}
      moreLater={actions.moreLater(ep.episodeNo)}
      skipped={skippedLabel(ep.next?.skipped)}
      onGo={actions.onGo}
      onOpenToc={actions.onOpenToc}
      extra={
        ep.status === "awaiting_approval" &&
        actions.onReview && (
          <button
            type="button"
            onClick={() => actions.onReview!(ep.episodeNo)}
            className="flex min-h-12 w-full items-center justify-center rounded-[12px] border border-accent bg-accent-soft text-[14px] font-semibold text-accent hover:brightness-105"
          >
            읽고 승인 · 수정 대화
          </button>
        )
      }
    />
  );
}

/** 다음 화 이어 보기: divider between two appended episodes; the last one asks for the next episode when it nears the screen */
function ContinueDivider({ ep, sentinel, onNeed }: { ep: ReaderEpisodeDto; sentinel: boolean; onNeed: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const need = useRef(onNeed);
  need.current = onNeed;
  useEffect(() => {
    if (!sentinel || !ref.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) need.current();
    }, { rootMargin: "0px 0px 1200px 0px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [sentinel]);
  const skipped = skippedLabel(ep.next?.skipped);
  return (
    <div ref={ref} className="reader-column my-16" role="separator" aria-label={`${ep.episodeNo}화 끝`}>
      <div className="rounded-[14px] border border-border bg-surface px-4 py-5 text-center">
        <p className="text-[13px] font-semibold tracking-[0.18em] text-muted">{ep.episodeNo}화 끝</p>
        {ep.next && (
          <p className="mt-1.5 inline-flex max-w-full items-center gap-1 text-[14.5px] font-semibold text-text">
            <span className="truncate">이어서 {episodeLabel(ep.next.episodeNo, ep.next.title)}</span>
            <ReaderIcon name="next" size={15} />
          </p>
        )}
        {skipped && <p className="mt-1.5 text-[12.5px] font-semibold text-warn">{skipped} 건너뜀</p>}
      </div>
    </div>
  );
}

// ── scroll view ─────────────────────────────────────────────────────────
const MAX_CHAIN = 12;

function ScrollSection({ novelId, no, mode, isLast, continuous, canGrow, onAppend, actions, root, blocksOf }: {
  novelId: string;
  no: number;
  mode: ReaderMode;
  isLast: boolean;
  continuous: boolean;
  canGrow: boolean;
  onAppend: (no: number) => void;
  actions: EndActions;
  root: boolean;
  blocksOf?: BlocksOf;
}) {
  const q = useReaderEpisodeExact(novelId, no, mode);
  const ep = q.data;
  return (
    <>
      {ep ? (
        <EpisodeArticle ep={ep} titleId={root ? "reader-title" : undefined} blocksOf={blocksOf} />
      ) : q.error ? (
        <div className="reader-column py-10">
          <QueryError error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        </div>
      ) : (
        <div className="reader-column py-16 text-center text-muted" aria-busy="true">
          {no}화를 불러오는 중…
        </div>
      )}
      {ep && (continuous && ep.next && (canGrow || !isLast) ? <ContinueDivider ep={ep} sentinel={isLast} onNeed={() => onAppend(ep.next!.episodeNo)} /> : <EndCard ep={ep} actions={actions} />)}
    </>
  );
}

export function ScrollView({ novelId, mode, chain, onAppend, continuous, initial, typoKey, handleRef, events, store, actions, barsShown, blocksOf }: {
  novelId: string;
  mode: ReaderMode;
  /** episode numbers shown one after another (first = the opened episode) */
  chain: readonly number[];
  onAppend: (no: number) => void;
  continuous: boolean;
  initial: InitialPosition;
  typoKey: string;
  handleRef: RefObject<ViewHandle | null>;
  events: ViewEvents;
  store: ProgressStore;
  actions: EndActions;
  barsShown: boolean;
  /** illustrations extension point (default: the text alone) */
  blocksOf?: BlocksOf;
}) {
  const renderSection = (no: number, { root, isLast }: { root: boolean; isLast: boolean }): ReactNode => (
    <ScrollSection
      novelId={novelId}
      no={no}
      mode={mode}
      root={root}
      isLast={isLast}
      continuous={continuous}
      canGrow={chain.length < MAX_CHAIN}
      onAppend={onAppend}
      actions={actions}
      blocksOf={blocksOf}
    />
  );
  return <SharedScrollView chain={chain} renderSection={renderSection} initial={initial} typoKey={typoKey} handleRef={handleRef} events={events} store={store} barsShown={barsShown} />;
}

// ── page view ───────────────────────────────────────────────────────────
/** 페이지 넘김 of one studio episode (pages of about `maxChars` characters; the page after the last is the end card) */
export function PageView({ ep, geometry, initial, typoKey, maxChars, fontPx, lineHeight, handleRef, events, store, actions, reducedMotion, blocksOf = textBlocks }: {
  ep: ReaderEpisodeDto;
  geometry: PageGeometry;
  initial: InitialPosition;
  typoKey: string;
  /** target characters per page (보기 설정 → 글자 수) */
  maxChars: number;
  /** font size (px) and line-height factor: estimate fallback when nothing can be measured */
  fontPx: number;
  lineHeight: number;
  handleRef: RefObject<ViewHandle | null>;
  events: ViewEvents;
  store: ProgressStore;
  actions: EndActions;
  reducedMotion: boolean;
  /** illustrations extension point (default: the text alone) */
  blocksOf?: BlocksOf;
}) {
  const blocks = useMemo(() => blocksOf(ep), [ep, blocksOf]);
  const header = useMemo(() => <EpisodeHeader ep={ep} titleId="reader-title" />, [ep]);
  const measureHeader = useMemo(() => <EpisodeHeader ep={ep} />, [ep]);
  return (
    <SharedPageView
      episodeNo={ep.episodeNo}
      blocks={blocks}
      header={header}
      measureHeader={measureHeader}
      runningHead={episodeLabel(ep.episodeNo, ep.title)}
      endCard={<EndCard ep={ep} actions={actions} paged />}
      geometry={geometry}
      initial={initial}
      typoKey={typoKey}
      maxChars={maxChars}
      fontPx={fontPx}
      lineHeight={lineHeight}
      handleRef={handleRef}
      events={events}
      store={store}
      reducedMotion={reducedMotion}
    />
  );
}
