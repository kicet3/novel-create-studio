import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { formatUsd, labelKo, type AgentRole, type AgentRunSpanDto } from "@ncs/shared";
import { novelPath } from "../../components/layout/nav.js";
import { Badge, DataTable, formatDateTime, KeyValueList, StatusBadge } from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { useTaskRuns } from "./api.js";
import { describeRun, formatElapsed, formatTokens, LANE_PAD, LANE_ROW_H, layoutTimeline, RUN_STATUS_TONE, RUN_STATUS_VAR, runAttempt, runInterval, type TimelineBar } from "./model.js";
import { RepairDialogueDisclosure, repairRoundsLabel } from "./RepairDialogue.js";

const LABEL_W = 92;

const STOP_REASON_LABEL: Record<NonNullable<AgentRunSpanDto["stopReason"]>, string> = {
  completed: "완료",
  paused: "일시정지",
  cancelled_by_user: "사용자 취소",
  budget_blocked: "예산 차단",
  awaiting_human: "사람 대기",
  lease_lost: "작업 점유 만료(연결 끊김)",
  error: "오류",
  superseded: "대체됨",
};
const AXIS_H = 22;
const BAR_H = 12;
/** minimum px per hour so short bars stay visible; narrower screens scroll sideways */
const PX_PER_HOUR = 140;

const hhmmCache = new Map<string, Intl.DateTimeFormat>();
function hhmm(t: number, tz: string): string {
  let f = hhmmCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("ko-KR", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
    } catch {
      f = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
    }
    hhmmCache.set(tz, f);
  }
  return f.format(new Date(t));
}

/**
 * Width of an element that may mount later (the scroller only exists once there are runs): a callback ref
 * (re)attaches the observer whenever the element appears or changes.
 */
function useWidth<T extends HTMLElement>(): [(el: T | null) => void, React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const [w, setW] = useState(0);
  const attach = useCallback((el: T | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    ref.current = el;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    roRef.current = ro;
  }, []);
  useEffect(() => () => roRef.current?.disconnect(), []);
  return [attach, ref, w];
}

export interface RunTimelineProps {
  novelId: string;
  runs: AgentRunSpanDto[];
  order: readonly AgentRole[];
  since: number;
  now: number;
  hours: number;
  timezone: string;
  truncated: boolean;
}

/** Gantt-like swimlanes (one per role) of runs in the window; hover = tooltip, click/Enter = detail panel. */
export function RunTimeline({ novelId, runs, order, since, now, hours, timezone, truncated }: RunTimelineProps) {
  const [attachScroll, scrollRef, viewW] = useWidth<HTMLDivElement>();
  const width = Math.max(viewW, Math.round(hours * PX_PER_HOUR));
  const layout = useMemo(() => layoutTimeline(runs, { since, now, width: width || 600, gutter: 0, order }), [runs, since, now, width, order]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hover, setHover] = useState<{ bar: TimelineBar; x: number; y: number } | null>(null);
  const selected = runs.find((r) => r.id === selectedId) ?? null;

  // keep "now" in view: once the scroller has a width, and again whenever the range changes
  // (the scroller mounts late when the window starts empty)
  const hasLanes = layout.lanes.length > 0;
  const scrolledFor = useRef<number | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !viewW || !hasLanes || scrolledFor.current === hours) return;
    el.scrollLeft = el.scrollWidth;
    scrolledFor.current = hours;
  }, [viewW, hours, hasLanes, scrollRef]);

  const legend = (["queued", "running", "succeeded", "failed", "interrupted", "cancelled"] as const).map((s) => (
    <span key={s} className="inline-flex items-center gap-1">
      <span aria-hidden="true" className={cx("inline-block h-2.5 w-4 rounded-[3px]", s === "running" && "agents-bar-live")} style={{ background: RUN_STATUS_VAR[RUN_STATUS_TONE[s]] }} />
      {labelKo("run_status", s)}
    </span>
  ));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted" aria-label="범례">
        {legend}
        {truncated && <span className="text-warn">최근 실행만 표시합니다.</span>}
      </div>

      {layout.lanes.length === 0 ? (
        <p className="m-0 rounded-lg border border-dashed border-border p-5 text-center text-[13px] text-muted">최근 {hours}시간 동안 실행이 없습니다.</p>
      ) : (
        <div className="flex rounded-[10px] border border-border bg-surface">
          {/* fixed lane labels */}
          <div aria-hidden="true" className="shrink-0 border-r border-border" style={{ width: LABEL_W }}>
            <div style={{ height: AXIS_H }} />
            {layout.lanes.map((l) => (
              <div key={l.role} className="flex items-center truncate border-t border-border px-2 text-[12px] font-semibold" style={{ height: l.height }}>
                {l.label}
              </div>
            ))}
          </div>
          <div ref={attachScroll} className="relative min-w-0 flex-1 overflow-x-auto" role="region" aria-label={`실행 타임라인, 최근 ${hours}시간`} tabIndex={0}>
            <svg width={width} height={layout.height + AXIS_H} className="block" role="list" aria-label="역할별 실행">
              {/* axis + grid */}
              <g aria-hidden="true">
                {layout.ticks.map((tk) => (
                  <g key={tk.t}>
                    <line x1={tk.x} x2={tk.x} y1={AXIS_H - 4} y2={layout.height + AXIS_H} stroke="var(--border)" strokeWidth={1} />
                    <text x={tk.x + 3} y={13} fontSize={10.5} fill="var(--muted)" className="tabular">
                      {hhmm(tk.t, timezone)}
                    </text>
                  </g>
                ))}
                {layout.lanes.map((l) => (
                  <line key={l.role} x1={0} x2={width} y1={l.y + AXIS_H} y2={l.y + AXIS_H} stroke="var(--border)" strokeWidth={1} />
                ))}
                <line x1={layout.nowX - 1} x2={layout.nowX - 1} y1={AXIS_H - 6} y2={layout.height + AXIS_H} stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="3 3" />
                <text x={layout.nowX - 4} y={13} fontSize={10.5} fill="var(--accent)" textAnchor="end" fontWeight={700}>
                  지금
                </text>
              </g>
              {layout.lanes.map((l) => (
                <g key={l.role} role="listitem" aria-label={`${l.label} 실행 ${l.bars.length}건`}>
                  {l.bars.map((b) => {
                    const y = AXIS_H + l.y + LANE_PAD + b.row * LANE_ROW_H + (LANE_ROW_H - BAR_H) / 2;
                    const color = RUN_STATUS_VAR[RUN_STATUS_TONE[b.run.status]];
                    const isSel = b.run.id === selectedId;
                    return (
                      <g
                        key={b.run.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`${l.label} ${describeRun(b.run, now)}`}
                        aria-pressed={isSel}
                        className="cursor-pointer outline-none [&:focus-visible>rect.agents-hit]:stroke-[var(--accent)]"
                        onClick={() => setSelectedId(isSel ? null : b.run.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedId(isSel ? null : b.run.id);
                          }
                        }}
                        onPointerEnter={() => setHover({ bar: b, x: b.x + b.w / 2, y })}
                        onPointerLeave={() => setHover((h) => (h?.bar.run.id === b.run.id ? null : h))}
                        onFocus={() => setHover({ bar: b, x: b.x + b.w / 2, y })}
                        onBlur={() => setHover(null)}
                      >
                        {/* hit target larger than the mark */}
                        <rect className="agents-hit" x={b.x - 3} y={y - 3} width={b.w + 6} height={BAR_H + 6} rx={5} fill="transparent" stroke="transparent" strokeWidth={1.5} />
                        <rect
                          x={b.x}
                          y={y}
                          width={b.w}
                          height={BAR_H}
                          rx={3}
                          fill={color}
                          opacity={b.run.status === "cancelled" ? 0.5 : 1}
                          className={b.live ? "agents-bar-live" : undefined}
                          stroke={isSel ? "var(--text)" : "var(--surface)"}
                          strokeWidth={isSel ? 1.5 : 1}
                        />
                        {b.run.status === "failed" && b.w >= 10 && (
                          <text x={b.x + b.w / 2} y={y + BAR_H - 2.5} fontSize={9.5} textAnchor="middle" fill="var(--surface)" aria-hidden="true">
                            ✕
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              ))}
            </svg>
            {hover && (
              <div
                role="tooltip"
                className="pointer-events-none absolute z-10 w-max max-w-[260px] rounded-md border border-border bg-surface px-2 py-1.5 text-[11.5px] shadow-card"
                style={{ left: Math.min(Math.max(4, hover.x - 120), width - 264), top: hover.y + BAR_H + 6 }}
              >
                <RunSummary run={hover.bar.run} now={now} />
              </div>
            )}
          </div>
        </div>
      )}

      {selected && <RunDetail novelId={novelId} run={selected} now={now} timezone={timezone} onClose={() => setSelectedId(null)} />}

      <details className="text-[12.5px]">
        <summary className="cursor-pointer text-muted">표로 보기 ({runs.length}건)</summary>
        <DataTable
          className="mt-2"
          label="실행 목록"
          rows={runs}
          rowKey={(r) => r.id}
          columns={[
            { key: "task", header: "작업", rowHeader: true, cell: (r) => `T-${r.taskDisplayNo} ${labelKo("task_kind", r.kind)}` },
            { key: "role", header: "담당", cell: (r) => labelKo("agent_role", r.role) },
            { key: "status", header: "상태", cell: (r) => <StatusBadge enum="run_status" value={r.status} /> },
            { key: "start", header: "시작", className: "whitespace-nowrap tabular-nums", cell: (r) => formatDateTime(r.startedAt ?? r.createdAt, timezone) },
            { key: "dur", header: "소요", className: "whitespace-nowrap tabular-nums", cell: (r) => { const i = runInterval(r, now); return formatElapsed(i.end - i.start); } },
            { key: "cost", header: "비용", className: "tabular-nums", cell: (r) => formatUsd(r.costMicros) },
          ]}
        />
      </details>
    </div>
  );
}

function RunSummary({ run, now }: { run: AgentRunSpanDto; now: number }) {
  const i = runInterval(run, now);
  return (
    <>
      <div className="font-semibold">
        T-{run.taskDisplayNo} {labelKo("task_kind", run.kind)}
      </div>
      <div className="text-muted">
        {labelKo("run_status", run.status)} · {i.live ? "경과 " : ""}
        {formatElapsed(i.end - i.start)}
        {run.costMicros > 0 ? ` · ${formatUsd(run.costMicros)}` : ""}
      </div>
      {run.errorFamily && <div className="text-danger">{labelKo("error_family", run.errorFamily)}</div>}
      {run.repairRounds > 0 && <div>{repairRoundsLabel(run.repairRounds)}</div>}
    </>
  );
}

function RunDetail({ novelId, run, now, timezone, onClose }: { novelId: string; run: AgentRunSpanDto; now: number; timezone: string; onClose: () => void }) {
  const i = runInterval(run, now);
  const attempt = runAttempt(run, i.live);
  // the error message is not in the polled timeline; read it from the task's runs while the detail is open
  const detail = useTaskRuns(novelId, run.errorFamily || run.status === "failed" || run.status === "interrupted" ? run.taskId : null);
  const errorMessage = detail.data?.items.find((r) => r.id === run.id)?.errorMessage ?? null;
  return (
    <section aria-label="선택한 실행" className="rounded-[10px] border border-border bg-surface-2 p-3 text-[12.5px]">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <b className="text-[13.5px]">
          T-{run.taskDisplayNo} {labelKo("task_kind", run.kind)}
        </b>
        <StatusBadge enum="run_status" value={run.status} />
        {run.stopReason && run.stopReason !== "completed" && run.stopReason !== "error" && <Badge>{STOP_REASON_LABEL[run.stopReason]}</Badge>}
        <span className="ml-auto flex items-center gap-3">
          <Link to={novelPath(novelId, "board")}>작업 보드에서 보기 →</Link>
          <button type="button" onClick={onClose} className="rounded border border-border bg-surface px-2 py-0.5 text-xs">
            닫기
          </button>
        </span>
      </div>
      <KeyValueList
        items={[
          { label: "담당", value: labelKo("agent_role", run.role) },
          attempt,
          { label: "시작", value: formatDateTime(run.startedAt ?? run.createdAt, timezone) },
          { label: i.live ? "경과" : "소요", value: formatElapsed(i.end - i.start) },
          { label: "종료", value: run.finishedAt ? formatDateTime(run.finishedAt, timezone) : "진행 중" },
          { label: "토큰", value: `입력 ${formatTokens(run.inputTokens)} · 출력 ${formatTokens(run.outputTokens)}` },
          { label: "비용", value: formatUsd(run.costMicros) },
          { label: "모델", value: run.models.length ? run.models.join(", ") : "—" },
          ...(run.repairRounds > 0 ? [{ label: "수정 대화", value: <RepairDialogueDisclosure novelId={novelId} taskId={run.taskId} runId={run.id} rounds={run.repairRounds} /> }] : []),
          ...(run.errorFamily || errorMessage
            ? [
                {
                  label: "오류",
                  value: (
                    <span className="text-danger">
                      {[run.errorFamily && labelKo("error_family", run.errorFamily), errorMessage].filter(Boolean).join(" — ")}
                      {detail.isFetching && !errorMessage ? " …" : ""}
                    </span>
                  ),
                },
              ]
            : []),
        ].map((it) => ({ key: it.label, ...it }))}
        labelWidth="5rem"
      />
    </section>
  );
}
