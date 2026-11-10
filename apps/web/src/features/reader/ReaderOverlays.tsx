/**
 * 읽기 viewer overlays of the studio. Bars, 보기 설정 sheet, drawer shell, first-time hint and dimmer are the shared
 * @ncs/reader-ui pieces; the studio supplies router links and its 부 → 플롯 → 화 목차.
 */
import { useMemo } from "react";
import { Link } from "react-router";
import type { ReaderEpisodeDto, ReaderMode, ReaderTocDto } from "@ncs/shared";
import { DRAWER_LINK, ICON_BTN, ReaderDrawer, ReaderIcon, TocDrawerItem, TopBar as SharedTopBar } from "@ncs/reader-ui";
import { QueryError } from "../../components/ui/index.js";
import { groupToc, partLabel, readableEpisodes, type ReadHistory } from "./reader-model.js";

export { BottomBar, Dimmer, SettingsSheet, TapHint } from "@ncs/reader-ui";

// ── bars ────────────────────────────────────────────────────────────────
export function TopBar({ backTo, ...rest }: {
  shown: boolean;
  novelTitle: string | undefined;
  episodeNo: number;
  ep: ReaderEpisodeDto | undefined;
  backTo: string;
  onToc: () => void;
  onSettings: () => void;
}) {
  return (
    <SharedTopBar
      {...rest}
      back={
        <Link to={backTo} className={ICON_BTN} aria-label="작품 목차로">
          <ReaderIcon name="back" />
        </Link>
      }
    />
  );
}

// ── 목차 drawer ──────────────────────────────────────────────────────────
export function TocDrawer({ open, onClose, toc, error, onRetry, mode, history, currentNo, onJump, tocHref, editHref }: {
  open: boolean;
  onClose: () => void;
  toc: ReaderTocDto | undefined;
  error: unknown;
  onRetry: () => void;
  mode: ReaderMode;
  history: ReadHistory;
  currentNo: number;
  onJump: (no: number) => void;
  tocHref: string;
  editHref: string;
}) {
  const groups = useMemo(() => (toc ? groupToc(toc, mode) : []), [toc, mode]);
  const total = useMemo(() => (toc ? readableEpisodes(toc, mode).length : 0), [toc, mode]);
  const readCount = useMemo(() => (toc ? readableEpisodes(toc, mode).filter((r) => history[r.episodeNo] === "read").length : 0), [toc, mode, history]);
  return (
    <ReaderDrawer
      open={open}
      onClose={onClose}
      title={toc?.title ?? "목차"}
      titleId="rv-toc-title"
      subtitle={toc ? `${total}화 · 읽음 ${readCount}화` : undefined}
      closeLabel="목차 닫기"
      initial='[aria-current="page"]'
      scrollKey={groups}
      footer={
        <div className="grid grid-cols-2 gap-2">
          <Link to={tocHref} className={DRAWER_LINK}>
            <ReaderIcon name="book" size={18} /> 작품 목차
          </Link>
          <Link to={editHref} className={DRAWER_LINK}>
            <ReaderIcon name="edit" size={17} /> 이 화 편집
          </Link>
        </div>
      }
    >
      {error && !toc ? (
        <div className="p-2">
          <QueryError error={error} onRetry={onRetry} />
        </div>
      ) : !toc ? (
        <p className="p-4 text-[14px] text-muted" aria-busy="true">
          목차를 불러오는 중…
        </p>
      ) : !groups.length ? (
        <p className="p-4 text-[14px] text-muted">읽을 수 있는 화가 없습니다.</p>
      ) : (
        groups.map((g, gi) => (
          <section key={g.part?.id ?? `rest-${gi}`} className="mb-3">
            {g.part && <h3 className="reader-title px-2 pt-2 pb-1 text-[14px] font-bold text-text">{partLabel(g.part)}</h3>}
            {g.plots.map((p, pi) => (
              <div key={p.plot?.id ?? `p-${pi}`}>
                {p.plot && (
                  <h4 className="flex items-baseline gap-1.5 px-2 pt-2 pb-1 text-[12px] font-semibold text-muted">
                    <span className="tabular">플롯 {p.plot.ord}</span>
                    <span className="truncate">{p.plot.title}</span>
                  </h4>
                )}
                <ol className="m-0 list-none p-0">
                  {p.rows.map((r) => (
                    <TocDrawerItem
                      key={r.episodeNo}
                      episodeNo={r.episodeNo}
                      title={r.title}
                      charCount={r.charCount}
                      note={r.kind === "draft" ? "초안" : null}
                      current={r.episodeNo === currentNo}
                      state={history[r.episodeNo]}
                      onJump={onJump}
                    />
                  ))}
                </ol>
              </div>
            ))}
          </section>
        ))
      )}
    </ReaderDrawer>
  );
}
