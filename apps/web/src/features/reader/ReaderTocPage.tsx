/** 읽기 — 목차 (/novels/:novelId/read): 부 → 플롯 → 화, 승인된 화만 / 초안 포함, 이어 읽기. */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { labelKo, READER_MODES, type ReaderTocDto } from "@ncs/shared";
import { useNovelId } from "../../app/novel-context.js";
import { novelPath } from "../../components/layout/nav.js";
import { Badge, ButtonLink, QueryView, formatNumber } from "../../components/ui/index.js";
import { useDocumentTitle } from "../../lib/use-document-title.js";
import { cx } from "../../lib/cx.js";
import { useReaderToc } from "./api.js";
import { ICON_BTN, KIND_BADGE, ReaderIcon, ReaderRoot, ReaderSettingsButton, browserStore, useHideOnScroll, useReadHistory, useReaderSettings } from "./ReaderShell.js";
import { READER_MODE_LABELS, groupToc, loadResume, partLabel, readableEpisodes, type ReadState, type ReaderResume, type TocRow } from "./reader-model.js";

export function ReaderTocPage() {
  const novelId = useNovelId();
  const [settings, update] = useReaderSettings();
  const toc = useReaderToc(novelId);
  const headerShown = useHideOnScroll();
  useDocumentTitle(toc.data ? `${toc.data.title} 읽기` : "읽기");
  // block body: scrollTo may return a Promise in newer browsers, and React would call it as a cleanup
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <ReaderRoot settings={settings}>
      <header className="reader-bar sticky top-0 z-30 border-b border-border" data-hidden={!headerShown}>
        <div className="mx-auto flex h-14 max-w-[880px] items-center gap-1 px-2 sm:px-4">
          <Link to={novelPath(novelId)} className={ICON_BTN} aria-label="작품 홈으로">
            <ReaderIcon name="back" />
          </Link>
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">목차</span>
          <ReaderSettingsButton settings={settings} onChange={update} headerHidden={!headerShown} />
        </div>
      </header>
      <main className="mx-auto max-w-[880px] px-4 pt-6 pb-16 sm:px-6 sm:pt-10">
        <QueryView query={toc} loadingLabel="목차를 불러오는 중…">
          {(data) => <TocBody data={data} novelId={novelId} mode={settings.mode} onMode={(mode) => update({ mode })} />}
        </QueryView>
      </main>
    </ReaderRoot>
  );
}

function TocBody({ data, novelId, mode, onMode }: { data: ReaderTocDto; novelId: string; mode: (typeof READER_MODES)[number]; onMode: (m: (typeof READER_MODES)[number]) => void }) {
  const groups = useMemo(() => groupToc(data, mode), [data, mode]);
  const readable = useMemo(() => readableEpisodes(data, mode), [data, mode]);
  const draftOnly = useMemo(() => readableEpisodes(data, "draft").length - readableEpisodes(data, "approved").length, [data]);
  // read after mount: the reader page saves its last position in its unmount cleanup, which runs before this effect
  const [resume, setResume] = useState<ReaderResume | null>(null);
  const [history] = useReadHistory(novelId);
  useEffect(() => {
    setResume(loadResume(browserStore(), novelId));
  }, [novelId]);
  // the saved position belongs to the text read in its own mode (승인본 vs 초안): resume in that mode
  const resumeRow = useMemo(() => (resume ? readableEpisodes(data, resume.mode).find((r) => r.episodeNo === resume.episodeNo) : undefined), [data, resume]);
  const total = readable.reduce((n, r) => n + r.charCount, 0);
  const basis = labelKo("count_basis", data.countBasis);
  const readPath = (no: number) => novelPath(novelId, `read/${no}`);

  return (
    <>
      <section className="mb-7">
        <p className="mb-1 text-[13px] font-semibold text-muted">읽기</p>
        <h1 className="reader-title text-[26px] leading-tight font-bold sm:text-[32px]">{data.title}</h1>
        <p className="mt-2 text-[13.5px] text-muted">
          {readable.length ? `${readable.length}화 · 총 ${formatNumber(total)}자 (${basis})` : "아직 읽을 수 있는 화가 없습니다"}
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {resumeRow ? (
            <ButtonLink
              to={`${readPath(resumeRow.episodeNo)}?resume=1`}
              variant="primary"
              className="h-11 px-5 text-[14px]"
              onClick={() => resume && resume.mode !== mode && onMode(resume.mode)}
            >
              이어 읽기 · {resumeRow.episodeNo}화
              {resume && resume.mode !== mode ? <span className="font-normal opacity-80">· {READER_MODE_LABELS[resume.mode]}</span> : null}
              {resume && resume.ratio > 0.02 && resume.ratio < 0.98 ? <span className="font-normal opacity-80">({Math.round(resume.ratio * 100)}%)</span> : null}
            </ButtonLink>
          ) : null}
          {readable[0] && (
            <ButtonLink to={readPath(readable[0].episodeNo)} variant={resumeRow ? "default" : "primary"} className="h-11 px-5 text-[14px]">
              첫 화부터 읽기
            </ButtonLink>
          )}
        </div>
      </section>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div role="group" aria-label="표시할 화" className="flex rounded-[9px] border border-border bg-surface-2 p-0.5">
          {READER_MODES.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => onMode(m)}
              className={cx("min-h-10 rounded-[7px] px-3.5 text-[13px] font-semibold", mode === m ? "bg-surface text-text shadow-card" : "text-muted hover:text-text")}
            >
              {READER_MODE_LABELS[m]}
            </button>
          ))}
        </div>
        {mode === "draft" ? (
          <span className="text-[12.5px] text-muted">
            <Badge tone="violet" glyph>초안</Badge> 표시는 아직 승인되지 않은 원고입니다
          </span>
        ) : draftOnly > 0 ? (
          <span className="text-[12.5px] text-muted">승인 전 원고 {draftOnly}화는 ‘초안 포함’에서 볼 수 있습니다</span>
        ) : null}
      </div>

      {!groups.length ? (
        <div className="rounded-[12px] border border-dashed border-border px-5 py-10 text-center text-muted">
          <p className="font-semibold text-text">{mode === "approved" ? "승인된 화가 아직 없습니다" : "읽을 수 있는 원고가 없습니다"}</p>
          <p className="mt-1 text-[13.5px]">
            {mode === "approved" && draftOnly > 0 ? "‘초안 포함’을 선택하면 작성 중인 원고를 읽을 수 있습니다." : "원고가 작성되면 여기에 화가 나타납니다."}
          </p>
        </div>
      ) : (
        <div className="grid gap-8">
          {groups.map((g, gi) => (
            <section key={g.part?.id ?? `rest-${gi}`} aria-label={g.part ? partLabel(g.part) : undefined}>
              {g.part ? <h2 className="reader-title mb-3 text-[19px] font-bold">{partLabel(g.part)}</h2> : groups.length > 1 ? <h2 className="mb-3 text-[15px] font-bold text-muted">기타</h2> : null}
              <div className="grid gap-5">
                {g.plots.map((p, pi) => (
                  <div key={p.plot?.id ?? `p-${pi}`}>
                    {p.plot && (
                      <h3 className="mb-1.5 flex items-baseline gap-2 text-[13px] font-semibold text-muted">
                        <span className="tabular">플롯 {p.plot.ord}</span>
                        <span className="text-text">{p.plot.title}</span>
                      </h3>
                    )}
                    <ol className="m-0 list-none divide-y divide-border overflow-hidden rounded-[12px] border border-border bg-surface p-0">
                      {p.rows.map((r) => (
                        <TocItem key={r.episodeNo} row={r} to={readPath(r.episodeNo)} current={r.episodeNo === resume?.episodeNo} state={history[r.episodeNo]} />
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function TocItem({ row, to, current, state }: { row: TocRow; to: string; current: boolean; state: ReadState | undefined }) {
  const badge = KIND_BADGE[row.kind];
  return (
    <li>
      <Link to={to} className="flex min-h-[58px] items-center gap-3 px-4 py-2.5 text-text no-underline hover:bg-surface-2" aria-current={current ? "true" : undefined}>
        <span className="w-12 shrink-0 text-[13px] font-semibold text-muted tabular">{row.episodeNo}화</span>
        <span className="min-w-0 flex-1">
          {row.title?.trim() ? (
            <span className="block truncate text-[15px] font-medium">{row.title.trim()}</span>
          ) : (
            <span className="block truncate text-[15px] font-medium text-muted">제목 없음</span>
          )}
          <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted">
            <span className="tabular">{formatNumber(row.charCount)}자</span>
            {current ? <span className="font-semibold text-accent">· 읽던 화</span> : state === "read" ? <span className="inline-flex items-center gap-0.5 font-semibold"><span aria-hidden="true">·</span> <ReaderIcon name="check" size={13} /> 읽음</span> : null}
            {row.kind === "draft" && <span>· {labelKo("episode_status", row.status)}</span>}
          </span>
        </span>
        <Badge tone={badge.tone} glyph={row.kind === "draft"}>
          {badge.label}
        </Badge>
      </Link>
    </li>
  );
}
