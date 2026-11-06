import { Link } from "react-router";
import { formatUsd, labelKo, type AgentCurrentWorkDto, type AgentRoleOverviewDto } from "@ncs/shared";
import { novelPath } from "../../components/layout/nav.js";
import { Badge, Chip, formatRelative } from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { formatElapsed, formatSignalAge, formatTokens, heartbeatHealth, ROLE_STATE_LABEL, ROLE_STATE_TONE, roleLabel } from "./model.js";

const DOT: Record<AgentRoleOverviewDto["state"], string> = {
  running: "bg-info",
  error: "bg-danger",
  blocked: "bg-warn",
  awaiting_human: "bg-violet",
  waiting: "bg-accent",
  idle: "bg-faint",
};

/** One card per agent role; stacks to a single column on narrow screens. */
export function AgentRoster({ novelId, roles, now }: { novelId: string; roles: AgentRoleOverviewDto[]; now: number }) {
  return (
    <ul className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 min-[600px]:grid-cols-2 min-[1100px]:grid-cols-3 min-[1500px]:grid-cols-4">
      {roles.map((r) => (
        <li key={r.role} className="min-w-0">
          <RoleCard novelId={novelId} r={r} now={now} />
        </li>
      ))}
    </ul>
  );
}

function RoleCard({ novelId, r, now }: { novelId: string; r: AgentRoleOverviewDto; now: number }) {
  const tone = ROLE_STATE_TONE[r.state];
  const waiting = r.counts.pending + r.counts.ready;
  const stuck = r.counts.blocked - r.awaitingHuman;
  const first = r.blocked[0];
  const firstHuman = first && (first.blockReason === "question" || first.blockReason === "approval");
  return (
    <article
      aria-labelledby={`agent-${r.role}`}
      className={cx(
        "flex h-full flex-col min-[600px]:min-h-[148px] gap-2 rounded-[10px] border border-l-[3px] border-border bg-surface p-3 shadow-card",
        { info: "border-l-info", danger: "border-l-danger", warn: "border-l-warn", accent: "border-l-accent", neutral: "border-l-border", ok: "border-l-ok", violet: "border-l-violet" }[tone],
      )}
    >
      <header className="flex items-center gap-2">
        <span aria-hidden="true" className="relative flex size-2.5 shrink-0">
          {r.state === "running" && <span className={cx("agents-ping absolute inset-0 rounded-full", DOT[r.state])} />}
          <span className={cx("relative size-2.5 rounded-full", DOT[r.state])} />
        </span>
        <h3 id={`agent-${r.role}`} className="min-w-0 flex-1 truncate text-[13.5px] font-bold">
          {roleLabel(r.role)}
        </h3>
        <Badge tone={tone} glyph>
          {ROLE_STATE_LABEL[r.state]}
          {r.current.length > 1 ? ` ${r.current.length}` : ""}
        </Badge>
      </header>

      <div className="flex flex-col gap-1.5 text-[12.5px] min-[600px]:min-h-[54px]">
        {r.current.length > 0 ? (
          r.current.slice(0, 2).map((c) => <CurrentWork key={c.taskId} novelId={novelId} c={c} now={now} fallbackModel={r.boundModelId} />)
        ) : r.state === "error" && r.lastError ? (
          <div className="min-w-0">
            <Link to={novelPath(novelId, "board")} className="font-semibold">
              T-{r.lastError.displayNo} {labelKo("task_kind", r.lastError.kind)}
            </Link>{" "}
            <span className="text-danger">{r.lastError.errorFamily ? labelKo("error_family", r.lastError.errorFamily) : "실패"}</span>
            {r.lastError.errorMessage && <p className="m-0 line-clamp-2 text-xs text-muted">{r.lastError.errorMessage}</p>}
          </div>
        ) : first ? (
          <div className="min-w-0">
            <Link to={novelPath(novelId, firstHuman ? "inbox" : "board")} className="font-semibold">
              T-{first.displayNo} {labelKo("task_kind", first.kind)}
            </Link>
            <div className={cx("text-xs", firstHuman ? "text-violet" : "text-warn")}>
              {first.blockReason ? labelKo("task_block_reason", first.blockReason) : "막힘"}
              {r.counts.blocked > 1 ? ` 외 ${r.counts.blocked - 1}건` : ""}
            </div>
          </div>
        ) : (
          <p className="m-0 text-xs text-muted">{r.lastActiveAt ? `마지막 활동 ${formatRelative(r.lastActiveAt, now)}` : "오늘은 아직 활동이 없습니다."}</p>
        )}
      </div>

      <footer className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-2 text-[11.5px] text-muted">
        <span className="tabular" title="오늘 실행 횟수 · 토큰 · 비용">
          오늘 {r.today.runs}회 · {formatTokens(r.today.inputTokens + r.today.outputTokens)} 토큰 · {formatUsd(r.today.costMicros)}
        </span>
        {(waiting > 0 || r.counts.blocked > 0 || r.counts.failed > 0) && (
          <span className="tabular">
            {[waiting && `대기 ${waiting}`, r.awaitingHuman && `사람 대기 ${r.awaitingHuman}`, stuck > 0 && `막힘 ${stuck}`, r.counts.failed && `실패 ${r.counts.failed}`]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
        {r.current.length === 0 && r.boundModelId && <Chip className="ml-auto max-w-full truncate font-mono text-[11px]">{r.boundModelId}</Chip>}
      </footer>
    </article>
  );
}

function CurrentWork({ novelId, c, now, fallbackModel }: { novelId: string; c: AgentCurrentWorkDto; now: number; fallbackModel: string | null }) {
  const hb = heartbeatHealth(c.heartbeatAt, c.leaseExpiresAt, now);
  const elapsed = c.startedAt ? now - new Date(c.startedAt).getTime() : 0;
  const model = c.model?.modelId ?? fallbackModel;
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-baseline gap-1.5">
        <Link to={novelPath(novelId, "board")} className="min-w-0 truncate font-semibold">
          T-{c.displayNo} {labelKo("task_kind", c.kind)}
        </Link>
        <span className="tabular ml-auto shrink-0 font-semibold text-info" aria-label={`경과 ${formatElapsed(elapsed)}`}>
          {formatElapsed(elapsed)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted">
        <span className={cx("tabular", hb === "stale" ? "font-semibold text-danger" : hb === "late" ? "text-warn" : undefined)}>
          {hb === "stale" ? "응답 없음" : c.heartbeatAt ? `마지막 신호 ${formatSignalAge(now - new Date(c.heartbeatAt).getTime())}` : "신호 기다리는 중"}
        </span>
        <span>
          시도 {c.attempt}/{c.maxAttempts}
        </span>
        {c.costMicros > 0 && <span className="tabular">{formatUsd(c.costMicros)}</span>}
        {model && <Chip className="max-w-full truncate font-mono text-[11px]">{model}</Chip>}
      </div>
    </div>
  );
}

