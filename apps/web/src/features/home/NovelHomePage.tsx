import { formatUsd, labelKo, type NovelDto } from "@ncs/shared";
import { Link } from "react-router";
import { useNovelId } from "../../app/novel-context.js";
import { PageHeader } from "../../components/layout/PageHeader.js";
import { novelPath } from "../../components/layout/nav.js";
import {
  Badge,
  ButtonLink,
  Callout,
  Card,
  Chip,
  DataTable,
  formatDateTime,
  Grid,
  KpiCard,
  List,
  ListItem,
  NotReady,
  Progress,
  QueryView,
  Split,
  StatusBadge,
  toneForStatus,
} from "../../components/ui/index.js";
import { useTasks } from "../board/api.js";
import { GoalForm } from "./GoalForm.js";
import { PausedCallout, PauseControl } from "./PauseControl.js";
import { useHome, type HomeData } from "./api.js";
import { NovelSetupFlow } from "./NovelSetupFlow.js";

/** `/novels/:novelId` — 작품 홈 (08 §9.2, FR-UI-01). */
export function NovelHomePage() {
  const novelId = useNovelId();
  const home = useHome(novelId);
  return (
    <QueryView query={home} loadingLabel="작품 홈을 불러오는 중…">
      {(data) => <HomeBody data={data} />}
    </QueryView>
  );
}

function goalSummary(d: HomeData): string {
  const g = d.goal;
  if (!g) return labelKo("novel_status", d.novel.status);
  const total = g.totalEpisodesMax ? `${g.totalEpisodesMin}~${g.totalEpisodesMax}화` : `${g.totalEpisodesMin}화`;
  const cadence = g.cadenceEpisodesPerWeek === 7 ? "하루 1화" : `주 ${g.cadenceEpisodesPerWeek}화`;
  const active = d.arcs.find((a) => a.status === "active");
  const arc = active ? ` · 아크 ${active.ord}(${active.plannedEpisodeFrom}~${active.plannedEpisodeTo}화) 진행 중` : "";
  return `목표 ${total} · ${cadence}${arc} · 결말 방향 “${g.endingDirection}”`;
}

function HomeBody({ data }: { data: HomeData }) {
  const { novel } = data;
  return (
    <>
      <PageHeader
        title={novel.title}
        subtitle={goalSummary(data)}
        actions={
          <>
            <StatusBadge enum="novel_status" value={novel.status} />
            <StatusBadge enum="autonomy_level" value={novel.autonomyLevel} />
            <PauseControl novel={novel} />
          </>
        }
      />
      <div className="flex flex-col gap-3">
        <PausedCallout novel={novel} />
        <HealthCallout data={data} />
        {novel.status === "concept" && <ConceptStageCallout novel={novel} />}
        {novel.status === "onboarding" && <NovelSetupFlow novel={novel} />}
        <Kpis data={data} />
        <Split>
          <div className="flex min-w-0 flex-col gap-3">
            <QuestionsCard data={data} />
            <RunningTasksCard novelId={novel.id} />
            <ArcsCard data={data} />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <ContinuityCard data={data} />
            <SetupsCard data={data} />
            <BudgetCard data={data} />
            {novel.status !== "concept" && novel.status !== "onboarding" && data.goal && (
              <details className="rounded-[10px] border border-border bg-surface px-4 py-3">
                <summary className="cursor-pointer text-[13.5px] font-bold">연재 목표 수정</summary>
                <div className="mt-3">
                  <GoalForm novelId={novel.id} title="연재 목표" />
                </div>
              </details>
            )}
          </div>
        </Split>
      </div>
    </>
  );
}

function HealthCallout({ data }: { data: HomeData }) {
  const fails = data.health.filter((h) => h.status === "fail" || h.status === "warn");
  if (fails.length === 0) {
    return (
      <p role="status" className="m-0 text-[12.5px] text-muted">
        <Badge tone="ok" glyph>
          시스템 정상
        </Badge>{" "}
        최근 연결 점검에서 실패가 없습니다.
      </p>
    );
  }
  const worst = fails.some((f) => f.status === "fail") ? "danger" : "warn";
  return (
    <Callout
      tone={worst}
      title={`연결 점검 ${fails.length}건 확인 필요`}
      actions={
        <ButtonLink size="sm" to={novelPath(data.novel.id, "settings")}>
          설정에서 점검
        </ButtonLink>
      }
    >
      <ul className="m-0 list-disc pl-4 text-muted">
        {fails.map((f) => (
          <li key={f.id}>
            {labelKo("health_check_kind", f.kind)} · {labelKo("health_status", f.status)} — {f.message}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

function ConceptStageCallout({ novel }: { novel: NovelDto }) {
  return (
    <Callout
      tone="accent"
      title="컨셉을 먼저 정합니다"
      actions={
        <ButtonLink variant="primary" size="sm" to={novelPath(novel.id, "concept")}>
          컨셉 대화로 이동
        </ButtonLink>
      }
    >
      <span className="text-muted">
        컨셉 파트너와 대화해 장르·주인공·결말 방향을 정하고 컨셉 브리프를 승인하면, 연재 목표를 정하는 단계로 넘어갑니다.
      </span>
    </Callout>
  );
}

function Kpis({ data }: { data: HomeData }) {
  const g = data.goal;
  const ep = data.episodes;
  const target = g?.totalEpisodesMax ?? g?.totalEpisodesMin ?? 0;
  const approved = ep ? ep.approved + ep.published : null;
  const r = data.reserve;
  const q = data.questions;
  const budget = data.budget?.find((b) => b.category === "all") ?? data.budget?.[0] ?? null;
  const ratio = budget && budget.hardLimitMicros > 0 ? budget.spentMicros / budget.hardLimitMicros : 0;
  return (
    <Grid cols={4}>
      <KpiCard label="목표 진척 (승인 기준)" value={approved ?? "—"} of={target ? `/ ${target}화` : undefined} delta={ep ? `공개 ${ep.published}화 · 진행 중 ${ep.inProgress}화` : "원고 모듈 준비 중"}>
        {approved !== null && target > 0 && <Progress className="my-1" value={approved} max={target} label="목표 진척" valueText={`${approved} / ${target}화`} />}
      </KpiCard>
      <KpiCard
        label="비축분 (승인 대기 포함)"
        value={r ? r.includingAwaiting : "—"}
        of={r ? `/ 목표 ${r.target}화` : undefined}
        delta={r ? `승인 대기 제외 ${r.approvedOnly}화 · 목표 대비 ${r.includingAwaiting - r.target >= 0 ? "+" : ""}${r.includingAwaiting - r.target}` : "원고 모듈 준비 중"}
      >
        {r && <Progress className="my-1" tone={r.includingAwaiting < r.target ? "warn" : "ok"} value={r.includingAwaiting} max={Math.max(r.target, 1)} label="비축분" />}
      </KpiCard>
      <KpiCard
        label="대기 질문"
        value={q ? q.blocking + q.nonBlocking : "—"}
        of={q ? `차단형 ${q.blocking}` : undefined}
        delta={q ? `승인 대기 ${q.approvals}건 · 가장 이른 마감 ${formatDateTime(q.earliestDeadlineAt, data.novel.timezone)}` : "인박스 준비 중"}
      />
      <KpiCard
        label="예산 소진"
        value={budget ? `${Math.round(ratio * 100)}%` : "—"}
        delta={budget ? `${formatUsd(budget.spentMicros)} / ${formatUsd(budget.hardLimitMicros)} · ${labelKo("budget_window", budget.window)}` : "예산 모듈 준비 중"}
      >
        {budget && <Progress className="my-1" tone={ratio >= budget.softWarnRatio ? "warn" : "accent"} value={ratio * 100} label="예산 소진율" valueText={`${Math.round(ratio * 100)}%`} />}
      </KpiCard>
    </Grid>
  );
}

function QuestionsCard({ data }: { data: HomeData }) {
  const q = data.questions;
  return (
    <Card
      title="대기 질문"
      actions={
        <Link className="text-xs" to={novelPath(data.novel.id, "inbox")}>
          인박스 →
        </Link>
      }
    >
      {!q ? (
        <NotReady compact title="인박스 준비 중" />
      ) : q.blocking + q.nonBlocking + q.informational + q.approvals === 0 ? (
        <p className="m-0 text-[13px] text-muted">답할 질문이 없습니다.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Badge tone={q.blocking > 0 ? "danger" : "neutral"} glyph>
            차단형 {q.blocking}
          </Badge>
          <Badge tone={q.nonBlocking > 0 ? "warn" : "neutral"} glyph>
            비차단형 {q.nonBlocking}
          </Badge>
          <Badge tone="info" glyph>
            정보성 {q.informational}
          </Badge>
          <Badge tone={q.approvals > 0 ? "warn" : "neutral"} glyph>
            승인 요청 {q.approvals}
          </Badge>
          {q.earliestDeadlineAt && <span className="text-xs text-muted">가장 이른 마감 {formatDateTime(q.earliestDeadlineAt, data.novel.timezone)}</span>}
        </div>
      )}
    </Card>
  );
}

function RunningTasksCard({ novelId }: { novelId: string }) {
  const tasks = useTasks(novelId, { status: ["running", "ready", "blocked", "failed"] }, { poll: false });
  return (
    <Card
      title="에이전트 실행 현황"
      actions={
        <Link className="text-xs" to={novelPath(novelId, "board")}>
          작업 보드 →
        </Link>
      }
    >
      <QueryView query={tasks} compact>
        {(d) => (
          <DataTable
            label="실행 중인 작업"
            rows={d.items.slice(0, 6)}
            rowKey={(t) => t.id}
            empty="진행 중인 작업이 없습니다."
            columns={[
              { key: "role", header: "역할", cell: (t) => labelKo("agent_role", t.agentRole) },
              { key: "kind", header: "작업", cell: (t) => <>{`T-${t.displayNo}`} {labelKo("task_kind", t.kind)}</>, rowHeader: true },
              { key: "status", header: "상태", cell: (t) => <StatusBadge enum="task_status" value={t.status} /> },
              { key: "cost", header: "이번 실행", cell: (t) => (t.latestRun ? formatUsd(t.latestRun.costMicros) : "—") },
            ]}
          />
        )}
      </QueryView>
    </Card>
  );
}

function ArcsCard({ data }: { data: HomeData }) {
  if (data.arcs.length === 0) return null;
  return (
    <Card title="아크">
      <List>
        {data.arcs.map((a) => (
          <ListItem key={a.id}>
            <Chip>아크 {a.ord}</Chip>
            <div className="min-w-0 flex-1">
              <b>{a.title}</b>
              <div className="text-xs text-muted">
                {a.plannedEpisodeFrom}~{a.plannedEpisodeTo}화 · {a.goalText}
              </div>
            </div>
            <StatusBadge enum="arc_status" value={a.status} />
          </ListItem>
        ))}
      </List>
    </Card>
  );
}

function ContinuityCard({ data }: { data: HomeData }) {
  const c = data.continuityIssues;
  const total = c ? Object.values(c).reduce((a, b) => a + b, 0) : 0;
  return (
    <Card
      title={`열린 연속성 이슈${c ? ` ${total}건` : ""}`}
      actions={
        <Link className="text-xs" to={novelPath(data.novel.id, "manuscript")}>
          원고 →
        </Link>
      }
    >
      {!c ? (
        <NotReady compact title="연속성 검사 준비 중" />
      ) : total === 0 ? (
        <p className="m-0 text-[13px] text-muted">열린 이슈가 없습니다.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {(["high", "medium", "low"] as const).map((sev) => (
            <Badge key={sev} tone={toneForStatus("issue_severity", sev)} glyph>
              {labelKo("issue_severity", sev)} {c[sev] ?? 0}
            </Badge>
          ))}
        </div>
      )}
      {c && (c.high ?? 0) > 0 && <p className="m-0 mt-2 text-xs text-muted">심각도 높음 이슈가 열려 있는 화는 승인 대기로 넘어가지 않습니다.</p>}
    </Card>
  );
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}

function SetupsCard({ data }: { data: HomeData }) {
  const s = data.setupsDueSoon;
  return (
    <Card
      title="기한 임박 떡밥"
      actions={
        <Link className="text-xs" to={novelPath(data.novel.id, "setups")}>
          떡밥 →
        </Link>
      }
    >
      {!s ? (
        <NotReady compact title="떡밥 관리 준비 중" />
      ) : s.length === 0 ? (
        <p className="m-0 text-[13px] text-muted">기한이 임박한 떡밥이 없습니다.</p>
      ) : (
        <List>
          {s.slice(0, 5).map((it, i) => {
            const no = str(it.setupNo) ?? str(it.displayNo);
            const due = str(it.dueEpisodeNo);
            return (
              <ListItem key={str(it.id) ?? i}>
                {no && <Chip>{no.startsWith("S-") ? no : `S-${no.padStart(2, "0")}`}</Chip>}
                <span className="min-w-0 flex-1">{str(it.title) ?? str(it.name) ?? "떡밥"}</span>
                {due && <span className="text-xs text-muted">기한 {due}화</span>}
              </ListItem>
            );
          })}
        </List>
      )}
    </Card>
  );
}

function BudgetCard({ data }: { data: HomeData }) {
  const b = data.budget;
  return (
    <Card
      title="예산"
      actions={
        <Link className="text-xs" to={novelPath(data.novel.id, "settings")}>
          설정 →
        </Link>
      }
    >
      {!b ? (
        <NotReady compact title="예산 모듈 준비 중" />
      ) : b.length === 0 ? (
        <p className="m-0 text-[13px] text-muted">예산 정책이 없습니다.</p>
      ) : (
        <List>
          {b.map((p) => (
            <ListItem key={p.policyId}>
              <span className="min-w-0 flex-1">
                <b>{labelKo("budget_category", p.category)}</b> <span className="text-xs text-muted">({labelKo("budget_window", p.window)})</span>
                <div className="text-xs text-muted">
                  소프트 경고 {Math.round(p.softWarnRatio * 100)}% · {p.hardStopEnabled ? "하드 한도 도달 시 자동 일시정지" : "하드 정지 꺼짐"}
                </div>
              </span>
              <span className="tabular text-[13px]">
                {formatUsd(p.spentMicros)} / {formatUsd(p.hardLimitMicros)}
              </span>
              <StatusBadge enum="budget_status" value={p.status} />
            </ListItem>
          ))}
        </List>
      )}
    </Card>
  );
}
