import { useCallback, useState } from "react";
import { Link } from "react-router";
import type { AgentGateOverviewDto, AgentPipelineGate, AgentStageOverviewDto, AgentStatusCounts } from "@ncs/shared";
import { novelPath } from "../../components/layout/nav.js";
import { cx } from "../../lib/cx.js";
import { describeGate, describeOther, describeStage, flowEdges, flowNodes, totalOf, type FlowNode } from "./model.js";

/** Overflow state of a horizontal scroller (for the "more →" hint and edge fades). */
function useOverflow() {
  const [state, setState] = useState({ left: false, right: false });
  const ro = useState(() => (typeof ResizeObserver === "undefined" ? null : new ResizeObserver(([e]) => measure(e!.target as HTMLElement))))[0];
  function measure(el: HTMLElement) {
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setState((s) => (s.left === left && s.right === right ? s : { left, right }));
  }
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      ro?.disconnect();
      if (!el) return;
      measure(el);
      ro?.observe(el);
      if (el.firstElementChild) ro?.observe(el.firstElementChild);
    },
    [ro],
  );
  return { ref, state, onScroll: (e: React.UIEvent<HTMLDivElement>) => measure(e.currentTarget) };
}

/**
 * Pipeline stages as an ordered list of HTML nodes (the text IS the accessible equivalent) joined by
 * small SVG connectors. Connectors animate (motion-safe only) where work is moving; approval gates
 * are diamond-marked nodes with their pending count.
 */
export function PipelineFlow({
  novelId,
  stages,
  gates,
  other,
  approvals,
  autoGates,
}: {
  novelId: string;
  stages: AgentStageOverviewDto[];
  gates: AgentGateOverviewDto[];
  other: AgentStatusCounts;
  /** pending approvals per gate (undefined while loading) */
  approvals: Record<AgentPipelineGate, number> | undefined;
  /** 설계 추가 0014: gates the autopilot decides (full_auto) — ◇ instead of ◆ */
  autoGates?: Partial<Record<AgentPipelineGate, boolean>>;
}) {
  const nodes = flowNodes(stages, gates, approvals);
  const edges = flowEdges(nodes);
  const ov = useOverflow();
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <div ref={ov.ref} onScroll={ov.onScroll} role="region" aria-label="파이프라인 흐름" tabIndex={0} className="-mx-1 overflow-x-auto px-1 pb-1">
          <ol className="m-0 flex w-full min-w-max list-none items-stretch p-0">
            {nodes.map((n, i) => (
              <li key={`${n.type}-${n.id}`} className={cx("flex min-w-0 items-stretch", n.type === "stage" ? "flex-[1_1_0]" : "flex-[0.75_1_0]")}>
                {n.type === "stage" ? <StageNode n={n} /> : <GateNode novelId={novelId} n={n} loading={!approvals} auto={!!autoGates?.[n.id as AgentPipelineGate]} />}
                {i < edges.length && <Connector state={edges[i]!.state} />}
              </li>
            ))}
          </ol>
        </div>
        {/* edge fades: the strip continues sideways */}
        {ov.state.left && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-surface to-transparent" />}
        {ov.state.right && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface to-transparent" />}
      </div>
      {(ov.state.right || ov.state.left) && (
        <p aria-hidden="true" className="m-0 text-right text-[11px] text-muted">
          {ov.state.right ? "옆으로 밀면 다음 단계가 보입니다 →" : "← 앞 단계는 왼쪽에 있습니다"}
        </p>
      )}
      <OtherWork c={other} />
    </div>
  );
}

/** Tasks with no pipeline stage (answer handling, visual production) — shown so no work is invisible. */
function OtherWork({ c }: { c: AgentStatusCounts }) {
  if (totalOf(c) === 0) return null;
  const waiting = c.pending + c.ready;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-[12px]">
      <span className="sr-only">{describeOther(c)}</span>
      <b aria-hidden="true" className="text-[12px]">
        그 밖의 작업
      </b>
      <span aria-hidden="true" className="text-[11.5px] text-muted">
        답변 처리·비주얼 등
      </span>
      <span aria-hidden="true" className="flex flex-wrap gap-x-1.5 text-[11.5px]">
        {c.running > 0 && <span className="font-semibold text-info">● {c.running}</span>}
        {waiting > 0 && <span className="text-accent">○ {waiting}</span>}
        {c.blocked > 0 && <span className="text-warn">! {c.blocked}</span>}
        {c.failed > 0 && <span className="text-danger">✕ {c.failed}</span>}
        {c.done > 0 && <span className="text-faint">✓ {c.done}</span>}
      </span>
    </div>
  );
}

function Connector({ state }: { state: "moving" | "waiting" | "idle" }) {
  return (
    <svg aria-hidden="true" width="12" viewBox="0 0 28 20" preserveAspectRatio="none" className="shrink-0 self-center" height="14">
      <line
        x1="1"
        y1="10"
        x2="21"
        y2="10"
        strokeWidth="2"
        strokeLinecap="round"
        className={cx(state === "moving" ? "stroke-info agents-flow-moving" : state === "waiting" ? "stroke-warn" : "stroke-border")}
        strokeDasharray={state === "idle" ? undefined : "4 4"}
      />
      <path d="M20 5.5 25.5 10 20 14.5" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={state === "moving" ? "stroke-info" : state === "waiting" ? "stroke-warn" : "stroke-border"} />
    </svg>
  );
}

function StageNode({ n }: { n: Extract<FlowNode, { type: "stage" }> }) {
  const c = n.stage.counts;
  const waiting = c.pending + c.ready;
  const stuck = c.blocked - n.human;
  return (
    <div
      className={cx(
        "relative flex min-w-[64px] flex-1 flex-col gap-0.5 rounded-[10px] border bg-surface px-1.5 py-2 min-[1400px]:px-2 shadow-card",
        n.active ? "border-info" : c.failed ? "border-danger" : "border-border",
      )}
    >
      {n.active && <span aria-hidden="true" className="agents-pulse-ring pointer-events-none absolute inset-[-3px] rounded-[12px] border-2 border-info" />}
      <span className="sr-only">{describeStage(n)}</span>
      <div aria-hidden="true" className="flex items-center justify-between gap-1">
        <b className="text-[12.5px]">{n.label}</b>
        <span className="tabular text-[11px] text-muted" title="전체 작업">
          {n.total}
        </span>
      </div>
      <div aria-hidden="true" className="flex min-h-[18px] flex-wrap gap-x-1.5 text-[11px] leading-[18px]">
        {c.running > 0 && <span className="font-semibold text-info">● {c.running}</span>}
        {waiting > 0 && <span className="text-accent">○ {waiting}</span>}
        {n.human > 0 && <span className="text-violet">◇ {n.human}</span>}
        {stuck > 0 && <span className="text-warn">! {stuck}</span>}
        {c.failed > 0 && <span className="text-danger">✕ {c.failed}</span>}
        {c.running + waiting + c.blocked + c.failed === 0 && <span className="text-faint">{c.done ? `✓ ${c.done}` : "—"}</span>}
      </div>
      <StageBar c={c} human={n.human} />
    </div>
  );
}

/** Thin proportional bar of the stage's task statuses (done / active / blocked+failed). */
function StageBar({ c, human }: { c: AgentStageOverviewDto["counts"]; human: number }) {
  const total = c.pending + c.ready + c.running + c.blocked + c.failed + c.done;
  if (!total) return <div aria-hidden="true" className="mt-1 h-1 rounded-full bg-surface-2" />;
  const seg = [
    { v: c.done, cls: "bg-ok" },
    { v: c.running, cls: "bg-info" },
    { v: c.pending + c.ready, cls: "bg-accent opacity-60" },
    { v: human, cls: "bg-violet" },
    { v: c.blocked - human, cls: "bg-warn" },
    { v: c.failed, cls: "bg-danger" },
  ].filter((s) => s.v > 0);
  return (
    <div aria-hidden="true" className="mt-1 flex h-1 gap-[2px] overflow-hidden rounded-full">
      {seg.map((s, i) => (
        <span key={i} className={cx("h-full rounded-full", s.cls)} style={{ flexGrow: s.v, flexBasis: 0 }} />
      ))}
    </div>
  );
}

function GateNode({ novelId, n, loading, auto = false }: { novelId: string; n: Extract<FlowNode, { type: "gate" }>; loading: boolean; auto?: boolean }) {
  const pending = n.pending > 0;
  const body = (
    <>
      <span aria-hidden="true" className={cx("block size-3 rotate-45 rounded-[2px] border-2", auto ? "border-violet" : pending ? "border-warn bg-warn-soft" : "border-faint")} />
      <span className="text-[11px] font-semibold leading-tight">
        {n.label}
        {auto && <span className="block text-[10px] font-normal text-violet">자동 승인</span>}
      </span>
      <span className={cx("tabular text-[11px]", pending ? "font-bold text-warn" : "text-faint")}>{loading ? "…" : pending ? `대기 ${n.pending}건` : "—"}</span>
      {n.blockedTasks > 0 && <span className="tabular break-keep text-[10.5px] leading-tight text-muted">작업 {n.blockedTasks} 멈춤</span>}
    </>
  );
  const cls = cx(
    "flex min-w-[52px] flex-1 flex-col items-center justify-center gap-1 rounded-[10px] border border-dashed px-1 py-2 text-center no-underline",
    pending ? "border-warn bg-warn-soft/60 text-text" : "border-border text-muted",
  );
  return pending ? (
    <Link to={novelPath(novelId, "inbox")} className={cls} aria-label={`${describeGate(n)}, 인박스로 이동`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>
      <span className="sr-only">{loading ? `사람 승인 단계 ${n.label}: 불러오는 중` : describeGate(n)}</span>
      <span aria-hidden="true" className="contents">
        {body}
      </span>
    </div>
  );
}
