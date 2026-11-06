import { useMemo, useState } from "react";
import { formatUsd, parseAutopilotSettings } from "@ncs/shared";
import { useNovelId } from "../../app/novel-context.js";
import { PageHeader } from "../../components/layout/PageHeader.js";
import { Badge, Callout, Card, Field, QueryView, Select } from "../../components/ui/index.js";
import { usePendingApprovals } from "../inbox/api.js";
import { AgentRoster } from "./AgentRoster.js";
import { useAgentsOverview, useAgentsTimeline } from "./api.js";
import { formatTokens, gateApprovalCounts, rosterSummary } from "./model.js";
import { PipelineFlow } from "./PipelineFlow.js";
import { RunTimeline } from "./RunTimeline.js";
import { useNow } from "./use-now.js";
import { useNovel } from "../novels/api.js";
import { AutopilotLogCard } from "../autopilot/AutopilotLogCard.js";

const HOURS = [1, 3, 6, 12, 24] as const;
const HOURS_KEY = "ncs.agents.hours";

function readHours(): number {
  try {
    const v = Number(localStorage.getItem(HOURS_KEY));
    return (HOURS as readonly number[]).includes(v) ? v : 6;
  } catch {
    return 6;
  }
}

/** Motion only when the user allows it (global reduced-motion rule also clamps durations). */
const MOTION_CSS = `
@media (prefers-reduced-motion: no-preference) {
  .agents-flow-moving { animation: agents-dash 0.9s linear infinite; }
  .agents-pulse-ring { animation: agents-pulse 1.8s ease-out infinite; }
  .agents-ping { animation: agents-ping 1.6s cubic-bezier(0,0,.2,1) infinite; }
  .agents-bar-live { animation: agents-breathe 1.6s ease-in-out infinite; }
}
@keyframes agents-dash { to { stroke-dashoffset: -16; } }
@keyframes agents-pulse { 0% { opacity: .55; transform: scale(1); } 100% { opacity: 0; transform: scale(1.06); } }
@keyframes agents-ping { 75%, 100% { transform: scale(2.2); opacity: 0; } }
@keyframes agents-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
`;

/**
 * `/novels/:novelId/agents` — 에이전트 현황: roster, pipeline flow with approval gates, run swimlanes.
 * Roster/flow poll every 3s, the timeline every 12s, pending approvals at the inbox interval.
 */
export function AgentsPage() {
  const novelId = useNovelId();
  const [hours, setHours] = useState(readHours);
  const q = useAgentsOverview(novelId);
  const tl = useAgentsTimeline(novelId, hours);
  const approvals = usePendingApprovals(novelId);
  const approvalCounts = useMemo(() => (approvals.data ? gateApprovalCounts(approvals.data.items) : undefined), [approvals.data]);
  const now = useNow(q.data?.clockOffsetMs ?? 0);
  const novel = useNovel(novelId);
  const level = novel.data?.autonomyLevel ?? "episode_approval";
  const autoGates = useMemo(() => {
    const n = novel.data;
    if (!n || n.autonomyLevel !== "full_auto" || n.autopilotHaltedAt) return undefined;
    const st = parseAutopilotSettings(n.autopilotSettings);
    return { concept: st.autoConfirmConcept, structure: st.autoApproveBible && st.autoApproveStructure, plot: st.autoApprovePlots, episode: st.autoApproveEpisodes };
  }, [novel.data]);

  const changeHours = (h: number) => {
    setHours(h);
    try {
      localStorage.setItem(HOURS_KEY, String(h));
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      <style>{MOTION_CSS}</style>
      <PageHeader
        title="에이전트 현황"
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={q.isFetching ? "text-info" : "text-ok"}>
              ●
            </span>
            에이전트가 하는 일을 실시간으로 봅니다 · 3초마다 갱신
          </span>
        }
        actions={
          <Field label="타임라인 범위" className="w-36">
            <Select value={hours} onChange={(e) => changeHours(Number(e.target.value))} controlSize="sm">
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  최근 {h}시간
                </option>
              ))}
            </Select>
          </Field>
        }
      />
      <QueryView query={q} loadingLabel="에이전트 현황을 불러오는 중…">
        {(d) => {
          const s = rosterSummary(d.roles);
          const order = d.roles.map((r) => r.role);
          return (
            <div className="flex flex-col gap-3">
              {d.paused && <Callout tone="warn">작품이 일시정지되어 새 작업이 시작되지 않습니다.</Callout>}
              <div className="flex flex-wrap items-center gap-1.5" aria-label="요약">
                <Badge tone="info" glyph>실행 중 {s.running}</Badge>
                <Badge tone="accent">대기 {s.waiting}</Badge>
                <Badge tone={s.awaitingHuman ? "violet" : "neutral"}>사람 대기 {s.awaitingHuman}</Badge>
                <Badge tone={s.blocked ? "warn" : "neutral"} glyph={s.blocked > 0}>막힘 {s.blocked}</Badge>
                <Badge tone={s.failed ? "danger" : "neutral"} glyph={s.failed > 0}>실패 작업 {s.failed}</Badge>
                <span className="tabular ml-1 text-[12px] text-muted">
                  오늘 {formatTokens(s.todayTokens)} 토큰 · {formatUsd(s.todayCostMicros)}
                </span>
              </div>

              <Card title="작업 흐름" actions={<span className="text-[11.5px] text-muted">● 실행 · ○ 대기 · ◇ 사람 대기 · ! 막힘 · ✕ 실패 · ◆ 사람 승인{autoGates ? " · 보라 ◆ 자동 승인(완전 자율)" : ""}</span>}>
                <PipelineFlow novelId={novelId} stages={d.stages} gates={d.gates} other={d.other} approvals={approvalCounts} autoGates={autoGates} />
              </Card>

              <section aria-labelledby="agents-roster" className="flex flex-col gap-2">
                <h2 id="agents-roster" className="text-[13.5px] font-bold">
                  에이전트
                </h2>
                <AgentRoster novelId={novelId} roles={d.roles} now={now} />
              </section>

              <Card title="실행 타임라인">
                {tl.data ? (
                  <RunTimeline
                    novelId={novelId}
                    runs={tl.data.runs}
                    order={order}
                    since={now - hours * 3_600_000}
                    now={now}
                    hours={hours}
                    timezone={d.timezone}
                    truncated={tl.data.runsTruncated}
                  />
                ) : tl.isError ? (
                  <Callout tone="danger">실행 타임라인을 불러오지 못했습니다. 잠시 뒤 다시 시도합니다.</Callout>
                ) : (
                  <p className="m-0 p-5 text-center text-[13px] text-muted">실행 타임라인을 불러오는 중…</p>
                )}
              </Card>
              <AutopilotLogCard novelId={novelId} autonomyLevel={level} timezone={d.timezone} />
            </div>
          );
        }}
      </QueryView>
    </>
  );
}
