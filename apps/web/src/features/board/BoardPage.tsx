import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ENUMS, formatUsd, labelKo, type TaskDto, type TaskStatus } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { useNovelId } from "../../app/novel-context.js";
import { PageHeader } from "../../components/layout/PageHeader.js";
import { novelPath } from "../../components/layout/nav.js";
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Chip,
  ConfirmDialog,
  DataTable,
  Field,
  formatDateTime,
  formatRelative,
  QueryView,
  Select,
  StatusBadge,
  Tabs,
} from "../../components/ui/index.js";
import { useNovel } from "../novels/api.js";
import { PauseControl } from "../home/PauseControl.js";
import { allowedActions, TASK_ACTION_LABEL, useTaskAction, useTasks, type TaskAction } from "./api.js";

const COLUMNS: TaskStatus[] = ["pending", "ready", "running", "blocked", "done"];
type View = "kanban" | "list";
const VIEW_KEY = "ncs.board.view";

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "kanban";
  } catch {
    return "kanban";
  }
}

/** `/novels/:novelId/board` — 작업 보드 (08 §9.3, FR-UI-02). Polls every 5s. */
export function BoardPage() {
  const novelId = useNovelId();
  const novel = useNovel(novelId);
  const [view, setView] = useState<View>(readView);
  const [role, setRole] = useState<string>("");
  const [showCancelled, setShowCancelled] = useState(false);
  const tasks = useTasks(novelId, { includeCancelled: showCancelled, agentRole: role || undefined });
  const tz = novel.data?.timezone;

  const changeView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      <PageHeader
        title="작업 보드"
        subtitle="에이전트 작업의 상태 · 5초마다 갱신"
        actions={novel.data && <PauseControl novel={novel.data} />}
      />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="담당 역할" className="w-48">
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">전체</option>
            {ENUMS.agent_role.map((r) => (
              <option key={r} value={r}>
                {labelKo("agent_role", r)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex h-9 items-center">
          <Checkbox label="취소된 작업 포함" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
        </div>
        <div className="ml-auto">
          <Tabs<View>
            label="보기"
            value={view}
            onChange={changeView}
            items={[
              { value: "kanban", label: "칸반" },
              { value: "list", label: "목록" },
            ]}
            className="[&>div]:mb-0"
          />
        </div>
      </div>
      {novel.data?.pausedAt && (
        <Callout tone="warn" className="mb-3">
          작품이 일시정지되어 새 작업이 시작되지 않습니다.
        </Callout>
      )}
      <QueryView query={tasks} loadingLabel="작업을 불러오는 중…">
        {(d) => <BoardBody novelId={novelId} tasks={d.items} view={view} timezone={tz} showCancelled={showCancelled} />}
      </QueryView>
    </>
  );
}

function BoardBody({ novelId, tasks, view, timezone, showCancelled }: { novelId: string; tasks: TaskDto[]; view: View; timezone?: string; showCancelled: boolean }) {
  const failed = tasks.filter((t) => t.status === "failed");
  const byStatus = useMemo(() => {
    const m = new Map<TaskStatus, TaskDto[]>();
    for (const t of tasks) m.set(t.status, [...(m.get(t.status) ?? []), t]);
    for (const list of m.values()) list.sort((a, b) => b.priority - a.priority || a.displayNo - b.displayNo);
    return m;
  }, [tasks]);
  const cols = showCancelled ? [...COLUMNS, "cancelled" as const] : COLUMNS;

  if (tasks.length === 0) {
    return <p className="m-0 rounded-lg border border-dashed border-border bg-surface p-6 text-center text-[13px] text-muted">아직 작업이 없습니다. 컨셉 대화나 목표 저장이 끝나면 작업이 생깁니다.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {failed.length > 0 && (
        <section aria-labelledby="needs-human" className="rounded-[10px] border border-l-[3px] border-border border-l-danger bg-surface p-3">
          <h2 id="needs-human" className="mb-2 text-[13.5px] font-bold">
            사람 조치 필요 <Badge tone="danger">{failed.length}</Badge>
          </h2>
          <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 min-[861px]:grid-cols-2">
            {failed.map((t) => (
              <li key={t.id}>
                <TaskCard novelId={novelId} t={t} timezone={timezone} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {view === "kanban" ? (
        <div className="grid grid-cols-1 items-start gap-3 pb-2 min-[861px]:grid-flow-col min-[861px]:grid-cols-none min-[861px]:auto-cols-[minmax(176px,1fr)] min-[861px]:overflow-x-auto" role="region" aria-label="작업 칸반" tabIndex={0}>
          {cols.map((s) => {
            const list = byStatus.get(s) ?? [];
            return (
              <section key={s} aria-labelledby={`col-${s}`} className="flex min-w-0 flex-col gap-2 rounded-[10px] bg-surface-2 p-2">
                <h2 id={`col-${s}`} className="flex items-center justify-between px-1 text-[12.5px] font-bold">
                  <StatusBadge enum="task_status" value={s} />
                  <span className="tabular text-muted">{list.length}</span>
                </h2>
                <ul className="m-0 flex list-none flex-col gap-2 p-0 max-h-[60dvh] overflow-y-auto min-[861px]:max-h-[calc(100dvh-15rem)]">
                  {list.map((t) => (
                    <li key={t.id}>
                      <TaskCard novelId={novelId} t={t} timezone={timezone} />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      ) : (
        <DataTable
          label="작업 목록"
          rows={tasks.filter((t) => t.status !== "failed")}
          rowKey={(t) => t.id}
          columns={[
            { key: "no", header: "번호", cell: (t) => `T-${t.displayNo}`, rowHeader: true },
            { key: "kind", header: "작업", cell: (t) => labelKo("task_kind", t.kind) },
            { key: "role", header: "담당", cell: (t) => labelKo("agent_role", t.agentRole) },
            { key: "status", header: "상태", cell: (t) => <StatusBadge enum="task_status" value={t.status} /> },
            { key: "att", header: "시도", cell: (t) => `${t.attemptCount}/${t.maxAttempts}` },
            { key: "upd", header: "변경", className: "whitespace-nowrap tabular-nums", cell: (t) => formatDateTime(t.updatedAt, timezone) },
            { key: "act", header: <span className="sr-only">조치</span>, cell: (t) => <TaskActions novelId={novelId} t={t} /> },
          ]}
        />
      )}
    </div>
  );
}

function blockLink(novelId: string, t: TaskDto): { to: string; label: string } | null {
  if (!t.blockedRefType) return null;
  switch (t.blockedRefType) {
    case "question":
      return { to: novelPath(novelId, `inbox/${t.blockedRefId ?? ""}`), label: "인박스에서 답하기" };
    case "approval":
      return { to: novelPath(novelId, "inbox"), label: "인박스에서 승인" };
    case "budget_policy":
      return { to: novelPath(novelId, "settings"), label: "예산 설정" };
    case "continuity_issue":
    case "episode":
      return { to: novelPath(novelId, "manuscript"), label: "원고 보기" };
    default:
      return null;
  }
}

function TaskCard({ novelId, t, timezone }: { novelId: string; t: TaskDto; timezone?: string }) {
  const run = t.latestRun;
  const stale = t.status === "running" && t.leaseExpiresAt !== null && new Date(t.leaseExpiresAt).getTime() < Date.now();
  const link = blockLink(novelId, t);
  return (
    <article aria-label={`T-${t.displayNo} ${labelKo("task_kind", t.kind)}`} className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface p-2.5 text-[12.5px] shadow-card">
      <div className="flex items-center gap-1.5">
        <Chip>T-{t.displayNo}</Chip>
        <b className="min-w-0 flex-1 truncate">{labelKo("task_kind", t.kind)}</b>
        {t.pausedAt && <Badge tone="warn">일시정지</Badge>}
      </div>
      <div className="text-xs text-muted">
        {labelKo("agent_role", t.agentRole)} · {labelKo("target_type", t.targetType)} · 시도 {t.attemptCount}/{t.maxAttempts}
        {t.priority !== 0 && ` · 우선순위 ${t.priority}`}
      </div>
      {t.status === "running" && run && (
        <div className="text-xs">
          {stale ? <Badge tone="danger" glyph>응답 없음</Badge> : <Badge tone="info" glyph>실행 중</Badge>} 시작 {formatRelative(run.startedAt)} · 하트비트 {formatRelative(run.heartbeatAt)} ·{" "}
          {formatUsd(run.costMicros)}
        </div>
      )}
      {t.status === "blocked" && (
        <div className="text-xs">
          <Badge tone="danger" glyph>
            {t.blockReason ? labelKo("task_block_reason", t.blockReason) : "차단"}
          </Badge>{" "}
          {link && <Link to={link.to}>{link.label} →</Link>}
        </div>
      )}
      {t.status === "failed" && run && (
        <div className="text-xs text-danger">
          {run.errorFamily ? labelKo("error_family", run.errorFamily) : "실패"}
          {run.errorMessage ? ` — ${run.errorMessage}` : ""}
        </div>
      )}
      {t.status === "pending" && t.notBeforeAt && <div className="text-xs text-muted">예약 {formatDateTime(t.notBeforeAt, timezone)}</div>}
      <TaskActions novelId={novelId} t={t} />
    </article>
  );
}

const CONFIRM_TEXT: Record<TaskAction, string | null> = {
  retry: null,
  resume: null,
  pause: "진행 중인 실행은 다음 안전 지점에서 멈춥니다.",
  cancel: "취소한 작업은 되돌릴 수 없습니다. 필요하면 새 작업이 다시 만들어집니다.",
};

function TaskActions({ novelId, t }: { novelId: string; t: TaskDto }) {
  const m = useTaskAction(novelId);
  const [confirm, setConfirm] = useState<TaskAction | null>(null);
  const actions = allowedActions(t);
  if (actions.length === 0) return null;
  const run = (action: TaskAction) => m.mutate({ taskId: t.id, action }, { onSettled: () => setConfirm(null) });
  return (
    <div className="flex flex-wrap gap-1.5">
      {actions.map((a) => (
        <Button
          key={a}
          size="sm"
          variant={a === "cancel" ? "danger" : a === "retry" ? "primary" : "default"}
          loading={m.isPending && m.variables?.action === a}
          onClick={() => (CONFIRM_TEXT[a] ? setConfirm(a) : run(a))}
          aria-label={`T-${t.displayNo} ${TASK_ACTION_LABEL[a]}`}
        >
          {TASK_ACTION_LABEL[a]}
        </Button>
      ))}
      {m.error && !confirm && <span role="alert" className="text-xs text-danger">{errorMessage(m.error)}</span>}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm ? `T-${t.displayNo} 작업을 ${TASK_ACTION_LABEL[confirm]}할까요?` : ""}
        description={confirm ? (CONFIRM_TEXT[confirm] ?? undefined) : undefined}
        danger={confirm === "cancel"}
        confirmLabel={confirm ? TASK_ACTION_LABEL[confirm] : "확인"}
        busy={m.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && run(confirm)}
      >
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
      </ConfirmDialog>
    </div>
  );
}
