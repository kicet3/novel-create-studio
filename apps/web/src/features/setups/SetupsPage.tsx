import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ENUMS, labelKo } from "@ncs/shared";
import { useNovelId } from "../../app/novel-context.js";
import { PageHeader } from "../../components/layout/PageHeader.js";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  formatDateTime,
  Input,
  KpiCard,
  QueryView,
  StatusBadge,
  Tabs,
  type Column,
  ToggleChip,
} from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { actorLabelKo, refTypeKo } from "../audit/labels.js";
import { useEpisodes } from "../manuscript/api.js";
import { useNovel } from "../novels/api.js";
import { useEntityNames } from "../ontology/api.js";
import {
  beatCounts,
  DUE_WARNING_EPISODES,
  dueState,
  SETUP_FLOW,
  useSetup,
  useSetupReport,
  useSetups,
  type DueState,
  type SetupDetailDto,
  type SetupDto,
  type SetupFilter,
  type SetupReportDto,
} from "./api.js";

/** `/novels/:novelId/setups[/:setupNo]` — foreshadowing (08 §9.6, FR-UI-06). */
export function SetupsPage() {
  const novelId = useNovelId();
  const { setupNo } = useParams();
  if (setupNo) return <SetupDetail key={setupNo} novelId={novelId} setupNo={setupNo} />;
  return <SetupsOverview novelId={novelId} />;
}

type View = "list" | "report";
type Quick = "all" | "due_soon" | "overdue";

function FilterChips<V extends string>({ label, values, selected, onChange, enumName }: { label: string; values: readonly V[]; selected: V[]; onChange: (v: V[]) => void; enumName: Parameters<typeof labelKo>[0] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <span className="text-xs whitespace-nowrap text-muted">{label}</span>
      {values.map((v) => {
        const on = selected.includes(v);
        return (
          <ToggleChip key={v} pressed={on} onClick={() => onChange(on ? selected.filter((x) => x !== v) : [...selected, v])}>
            {labelKo(enumName, v)}
          </ToggleChip>
        );
      })}
    </div>
  );
}

export function DueBadge({ state, remaining }: { state: DueState; remaining: number | null }) {
  if (state === "overdue") return <Badge tone="danger" glyph>기한 초과 {remaining !== null ? `${-remaining}화` : ""}</Badge>;
  if (state === "due_soon") return <Badge tone="warn" glyph>기한 임박 · {remaining}화 남음</Badge>;
  if (state === "ok") return <span className="text-xs text-muted tabular">{remaining}화 남음</span>;
  return <span className="text-faint">—</span>;
}

export function NarrativeStepper({ status }: { status: SetupDto["narrativeStatus"] }) {
  if (status === "abandoned") return <StatusBadge enum="setup_narrative_status" value="abandoned" />;
  const idx = SETUP_FLOW.indexOf(status);
  return (
    <ol className="m-0 flex list-none items-center gap-0.5 p-0 text-[11px]" aria-label={`서사 상태: ${labelKo("setup_narrative_status", status)}`}>
      {SETUP_FLOW.map((s, i) => (
        <li
          key={s}
          aria-current={i === idx ? "step" : undefined}
          className={cx(
            "rounded px-1.5 py-px",
            i < idx && "bg-ok-soft text-ok",
            i === idx && "bg-accent-soft font-semibold text-accent",
            i > idx && "text-faint",
          )}
        >
          {labelKo("setup_narrative_status", s)}
        </li>
      ))}
    </ol>
  );
}

function SetupsOverview({ novelId }: { novelId: string }) {
  const navigate = useNavigate();
  const [view, setView] = useState<View>("list");
  const [quick, setQuick] = useState<Quick>("all");
  const [narrative, setNarrative] = useState<string[]>([]);
  const [canon, setCanon] = useState<string[]>([]);
  const [importance, setImportance] = useState<string[]>([]);
  const filter: SetupFilter = {
    narrative,
    canon,
    importance,
    overdue: quick === "overdue" || undefined,
    dueWithin: quick === "due_soon" ? DUE_WARNING_EPISODES : undefined,
  };
  const setups = useSetups(novelId, filter);
  const all = useSetups(novelId);

  const counts = useMemo(() => {
    const c = { open: 0, dueSoon: 0, overdue: 0, paidOff: 0 };
    for (const s of all.data ?? []) {
      const d = dueState(s);
      if (s.narrativeStatus !== "paid_off" && s.narrativeStatus !== "abandoned") c.open++;
      if (d === "due_soon") c.dueSoon++;
      if (d === "overdue") c.overdue++;
      if (s.narrativeStatus === "paid_off") c.paidOff++;
    }
    return c;
  }, [all.data]);

  const columns: Column<SetupDto>[] = [
    {
      key: "no",
      header: "번호",
      rowHeader: true,
      className: "tabular w-16 whitespace-nowrap",
      cell: (s) => (
        <Link to={`/novels/${novelId}/setups/${s.displayNo}`} onClick={(e) => e.stopPropagation()} className="font-semibold">
          {s.displayLabel}
        </Link>
      ),
    },
    { key: "title", header: "떡밥", cell: (s) => <span className="font-semibold">{s.title}</span> },
    { key: "imp", header: "중요도", cell: (s) => <StatusBadge enum="setup_importance" value={s.importance} /> },
    { key: "narr", header: "서사 상태", cell: (s) => <NarrativeStepper status={s.narrativeStatus} /> },
    { key: "canon", header: "캐논", cell: (s) => <StatusBadge enum="canon_status" value={s.canonStatus} /> },
    {
      key: "beats",
      header: "비트(설치·강화·회수)",
      cell: (s) => {
        const c = beatCounts(s);
        return (
          <span className="tabular text-xs">
            {c.plant.done}/{c.plant.planned} · {c.reinforce.done}/{c.reinforce.planned} · {c.payoff.done}/{c.payoff.planned}
            {c.plant.missing + c.reinforce.missing + c.payoff.missing > 0 && (
              <Badge tone="danger" className="ml-1">
                누락 {c.plant.missing + c.reinforce.missing + c.payoff.missing}
              </Badge>
            )}
          </span>
        );
      },
    },
    {
      key: "due",
      header: "기한",
      cell: (s) => (
        <div className="grid gap-0.5">
          <span className="tabular">{s.effectiveDueEpisodeNo != null ? `${s.effectiveDueEpisodeNo}화` : "—"}</span>
          <DueBadge state={dueState(s)} remaining={s.remainingEpisodes} />
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="떡밥" subtitle="설치 → 강화 → 회수 흐름과 기한을 관리합니다. 기한 임박·초과 떡밥은 매 화 검사에서 다시 확인합니다." />
      <div className="mb-3 grid grid-cols-2 gap-3 min-[861px]:grid-cols-4">
        <KpiCard label="미회수" value={counts.open} of="개" />
        <KpiCard label="기한 임박" value={<span className={cx(counts.dueSoon > 0 && "text-warn")}>{counts.dueSoon}</span>} of="개" delta={`${DUE_WARNING_EPISODES}화 이내`} />
        <KpiCard label="기한 초과" value={<span className={cx(counts.overdue > 0 && "text-danger")}>{counts.overdue}</span>} of="개" />
        <KpiCard label="회수 완료" value={counts.paidOff} of="개" />
      </div>
      <Tabs
        label="떡밥 보기"
        value={view}
        onChange={setView}
        items={[
          { value: "list", label: "목록" },
          { value: "report", label: "리포트·지표" },
        ]}
      />
      <div className="mt-3">
        {view === "report" ? (
          <ReportView novelId={novelId} />
        ) : (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Tabs
                label="기한 필터"
                value={quick}
                onChange={setQuick}
                items={[
                  { value: "all", label: "전체" },
                  { value: "due_soon", label: "기한 임박" },
                  { value: "overdue", label: "기한 초과" },
                ]}
              />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              <FilterChips label="서사" values={ENUMS.setup_narrative_status} selected={narrative} onChange={setNarrative} enumName="setup_narrative_status" />
              <FilterChips label="캐논" values={ENUMS.canon_status} selected={canon} onChange={setCanon} enumName="canon_status" />
              <FilterChips label="중요도" values={ENUMS.setup_importance} selected={importance} onChange={setImportance} enumName="setup_importance" />
            </div>
            <QueryView query={setups} notReadyDescription="떡밥 모듈이 준비되면 목록이 표시됩니다.">
              {(items) => (
                <DataTable
                  label="떡밥 목록"
                  columns={columns}
                  rows={[...items].sort((a, b) => a.displayNo - b.displayNo)}
                  rowKey={(s) => s.id}
                  onRowClick={(s) => navigate(`/novels/${novelId}/setups/${s.displayNo}`)}
                  empty={quick === "all" && !narrative.length && !canon.length && !importance.length ? "아직 떡밥이 없습니다. 플롯 계획 때 함께 설계됩니다." : "조건에 맞는 떡밥이 없습니다."}
                />
              )}
            </QueryView>
          </div>
        )}
      </div>
    </>
  );
}

// ── detail ───────────────────────────────────────────────────────────────

function SetupDetail({ novelId, setupNo }: { novelId: string; setupNo: string }) {
  const q = useSetup(novelId, setupNo);
  return (
    <QueryView query={q} notReadyDescription="떡밥 모듈이 준비되면 상세가 표시됩니다.">
      {(s) => <SetupDetailBody novelId={novelId} setup={s} />}
    </QueryView>
  );
}

function SetupDetailBody({ novelId, setup }: { novelId: string; setup: SetupDetailDto }) {
  const episodes = useEpisodes(novelId);
  const novel = useNovel(novelId);
  const names = useEntityNames(novelId);
  const tz = novel.data?.timezone;
  const epNo = useMemo(() => new Map((episodes.data ?? []).map((e) => [e.id, e.episodeNo])), [episodes.data]);
  const beats = [...setup.beats].sort((a, b) => (a.plannedEpisodeNo ?? epNo.get(a.episodeId ?? "") ?? 1e9) - (b.plannedEpisodeNo ?? epNo.get(b.episodeId ?? "") ?? 1e9));
  const state = dueState(setup);

  return (
    <>
      <PageHeader
        title={`${setup.displayLabel} · ${setup.title}`}
        subtitle={
          <Link to={`/novels/${novelId}/setups`} className="underline">
            떡밥 목록
          </Link>
        }
        actions={
          <>
            <StatusBadge enum="setup_importance" value={setup.importance} />
            <StatusBadge enum="canon_status" value={setup.canonStatus} />
            <DueBadge state={state} remaining={setup.remainingEpisodes} />
          </>
        }
      />
      <div className="grid grid-cols-1 gap-3 min-[861px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-3">
          <Card title="내용">
            <p className="m-0 whitespace-pre-wrap text-[13px]">{setup.description}</p>
            <div className="mt-3">
              <NarrativeStepper status={setup.narrativeStatus} />
            </div>
            {setup.narrativeStatus === "abandoned" && setup.abandonedReason && <p className="mb-0 mt-2 text-xs text-muted">포기 사유: {setup.abandonedReason}</p>}
          </Card>
          <Card title="비트 타임라인">
            {beats.length === 0 ? (
              <EmptyState title="비트가 없습니다" />
            ) : (
              <ol className="relative m-0 list-none border-l-2 border-border p-0 pl-4">
                {beats.map((b) => {
                  const no = b.episodeId ? epNo.get(b.episodeId) : undefined;
                  const qs = new URLSearchParams();
                  if (b.manuscriptVersionId) qs.set("v", b.manuscriptVersionId);
                  if (b.charStart != null) qs.set("at", String(b.charStart));
                  if (b.charEnd != null) qs.set("end", String(b.charEnd));
                  return (
                    <li key={b.id} className="relative mb-3 last:mb-0">
                      <span
                        aria-hidden="true"
                        className={cx(
                          "absolute -left-[23px] top-1 size-3 rounded-full border-2 border-surface",
                          b.status === "confirmed" || b.status === "detected" ? "bg-ok" : b.status === "missing" ? "bg-danger" : b.status === "cancelled" ? "bg-faint" : "bg-border",
                        )}
                      />
                      <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                        <Badge tone="violet">{labelKo("setup_beat_kind", b.kind)}</Badge>
                        <StatusBadge enum="setup_beat_status" value={b.status} />
                        <span className="tabular text-muted">{b.plannedEpisodeNo != null ? `계획 ${b.plannedEpisodeNo}화` : "계획 화 미정"}</span>
                        {no !== undefined && (
                          <Link className="font-semibold text-accent underline" to={`/novels/${novelId}/episodes/${no}?${qs.toString()}`}>
                            {no}화 원고 위치 →
                          </Link>
                        )}
                      </div>
                      {b.plannedNote && <p className="m-0 mt-0.5 text-xs text-muted">{b.plannedNote}</p>}
                      {b.confirmedAt && <p className="m-0 text-xs text-faint">확정 {formatDateTime(b.confirmedAt, tz)}</p>}
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </div>
        <div className="grid content-start gap-3">
          <Card title="기한">
            <div className="text-[13px]">
              {setup.dueKind === "arc" ? "플롯 끝" : "화"} 기준 · {setup.effectiveDueEpisodeNo != null ? `${setup.effectiveDueEpisodeNo}화까지` : "미정"}
            </div>
            <div className="mt-1">
              <DueBadge state={state} remaining={setup.remainingEpisodes} />
            </div>
          </Card>
          <Card title="기한 변경 이력">
            {setup.dueChanges.length === 0 ? (
              <p className="m-0 text-[13px] text-muted">변경 이력이 없습니다.</p>
            ) : (
              <ul className="m-0 grid list-none gap-2 p-0 text-[13px]">
                {setup.dueChanges.map((c) => (
                  <li key={c.id} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
                    <div className="tabular">
                      {c.fromDueEpisodeNo != null ? `${c.fromDueEpisodeNo}화` : c.fromDueKind ? labelKo("setup_due_kind", c.fromDueKind) : "없음"} →{" "}
                      {c.toDueEpisodeNo != null ? `${c.toDueEpisodeNo}화` : labelKo("setup_due_kind", c.toDueKind)}
                    </div>
                    <div className="text-muted">{c.reason}</div>
                    <div className="text-xs text-faint">
                      {actorLabelKo({ actorType: c.changedByActorType, actorId: c.changedByActorId })} · {formatDateTime(c.createdAt, tz)}
                      {c.questionId && (
                        <>
                          {" · "}
                          <Link className="underline" to={`/novels/${novelId}/inbox/${c.questionId}`}>
                            관련 질문
                          </Link>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="연결">
            {setup.links.length === 0 ? (
              <p className="m-0 text-[13px] text-muted">연결된 엔티티·사실이 없습니다.</p>
            ) : (
              <ul className="m-0 grid list-none gap-1 p-0 text-[13px]">
                {setup.links.map((l) => (
                  <li key={`${l.type}:${l.id}`}>
                    <span className="mr-1 text-xs text-muted">{refTypeKo(l.type)}</span>
                    {l.type === "entity" ? (
                      <Link className="underline" to={`/novels/${novelId}/entities/${l.id}`}>
                        {names.get(l.id) ?? "엔티티"}
                      </Link>
                    ) : l.type === "episode" ? (
                      <span>{epNo.get(l.id) !== undefined ? `${epNo.get(l.id)}화` : "화"}</span>
                    ) : (
                      <span className="text-muted">{l.pinnedFactVersionId ? "고정된 사실 버전" : "연결됨"}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

// ── report ───────────────────────────────────────────────────────────────

function pct(m: { value: number | null; numerator: number; denominator: number }): string {
  if (m.value === null || m.denominator === 0) return "—";
  return `${Math.round(m.value * 100)}%`;
}

function ReportView({ novelId }: { novelId: string }) {
  const [asOfText, setAsOfText] = useState("");
  const asOf = asOfText.trim() === "" ? undefined : Number(asOfText);
  const q = useSetupReport(novelId, asOf !== undefined && Number.isFinite(asOf) ? asOf : undefined);
  return (
    <div className="grid gap-3">
      <label className="flex items-center gap-2 text-xs text-muted">
        기준 화
        <Input type="number" min={0} value={asOfText} onChange={(e) => setAsOfText(e.target.value)} placeholder="최근 승인 화" className="w-32" />
      </label>
      <QueryView query={q} notReadyDescription="떡밥 리포트가 준비되면 표시됩니다.">
        {(r) => <Report novelId={novelId} report={r} />}
      </QueryView>
    </div>
  );
}

function Report({ novelId, report }: { novelId: string; report: SetupReportDto }) {
  const m = report.r5Metrics;
  const link = (no: number, label: string) => (
    <Link to={`/novels/${novelId}/setups/${no}`} className="font-semibold underline">
      {label}
    </Link>
  );
  type R1 = SetupReportDto["r1Unresolved"][number];
  type R2 = SetupReportDto["r2Overdue"][number];
  type R3 = SetupReportDto["r3PaidOffWithoutReinforce"][number];
  type R4 = SetupReportDto["r4ContradictionCandidates"][number];
  const r1: Column<R1>[] = [
    { key: "no", header: "번호", rowHeader: true, cell: (r) => link(r.displayNo, r.displayLabel) },
    { key: "t", header: "떡밥", cell: (r) => r.title },
    { key: "n", header: "상태", cell: (r) => <StatusBadge enum="setup_narrative_status" value={r.narrativeStatus} /> },
    { key: "d", header: "기한", className: "tabular", cell: (r) => (r.dueEpisodeNo != null ? `${r.dueEpisodeNo}화` : "—") },
    { key: "r", header: "남은 화", className: "tabular", cell: (r) => (r.remainingEpisodes ?? "—") },
    { key: "k", header: "강화", className: "tabular", cell: (r) => `${r.reinforceCount}회` },
  ];
  const r2: Column<R2>[] = [
    { key: "no", header: "번호", rowHeader: true, cell: (r) => link(r.displayNo, r.displayLabel) },
    { key: "t", header: "떡밥", cell: (r) => r.title },
    { key: "o", header: "초과", className: "tabular", cell: (r) => <Badge tone="danger">{r.overdueEpisodes}화</Badge> },
    {
      key: "q",
      header: "질문",
      cell: (r) =>
        r.openQuestionId ? (
          <Link className="underline" to={`/novels/${novelId}/inbox/${r.openQuestionId}`}>
            {r.questionStatus ? labelKo("question_status", r.questionStatus) : "질문"}
          </Link>
        ) : (
          "—"
        ),
    },
  ];
  const r3: Column<R3>[] = [
    { key: "no", header: "번호", rowHeader: true, cell: (r) => link(r.displayNo, r.displayLabel) },
    { key: "t", header: "떡밥", cell: (r) => r.title },
    { key: "i", header: "중요도", cell: (r) => <StatusBadge enum="setup_importance" value={r.importance} /> },
  ];
  const r4: Column<R4>[] = [
    { key: "i", header: "이슈", rowHeader: true, cell: (r) => (r.issueDisplayNo != null ? `CI-${r.issueDisplayNo}` : "이슈") },
    { key: "s", header: "심각도", cell: (r) => <StatusBadge enum="issue_severity" value={r.severity} /> },
    { key: "m", header: "내용", cell: (r) => r.message },
  ];
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-1 gap-3 min-[521px]:grid-cols-3">
        <KpiCard label="회수율" value={pct(m.payoffRate)} delta={`${m.payoffRate.numerator} / ${m.payoffRate.denominator}`} />
        <KpiCard label="포기율" value={pct(m.abandonRate)} delta={`${m.abandonRate.numerator} / ${m.abandonRate.denominator}`} />
        <KpiCard label="초과 처리율" value={pct(m.overdueHandledRate)} delta={`${m.overdueHandledRate.numerator} / ${m.overdueHandledRate.denominator}`} />
      </div>
      <p className="m-0 text-xs text-muted">{report.asOfEpisodeNo != null ? `${report.asOfEpisodeNo}화 기준` : "승인된 화가 아직 없습니다."}</p>
      <Card title={`R1 미회수 ${report.r1Unresolved.length}`}>
        <DataTable label="미회수 떡밥" columns={r1} rows={report.r1Unresolved} rowKey={(r) => r.setupId} empty="미회수 떡밥이 없습니다." />
      </Card>
      <Card title={`R2 기한 초과 ${report.r2Overdue.length}`}>
        <DataTable label="기한 초과 떡밥" columns={r2} rows={report.r2Overdue} rowKey={(r) => r.setupId} empty="기한을 넘긴 떡밥이 없습니다." />
      </Card>
      <Card title={`R3 강화 없이 회수 ${report.r3PaidOffWithoutReinforce.length}`}>
        <DataTable label="강화 없이 회수된 떡밥" columns={r3} rows={report.r3PaidOffWithoutReinforce} rowKey={(r) => r.setupId} empty="해당 떡밥이 없습니다." />
      </Card>
      <Card title={`R4 모순 후보 ${report.r4ContradictionCandidates.length}`}>
        <DataTable label="모순 후보" columns={r4} rows={report.r4ContradictionCandidates} rowKey={(r) => r.issueId} empty="모순 후보가 없습니다." />
      </Card>
      <div>
        <Button size="sm" variant="ghost" onClick={() => window.print()}>
          인쇄
        </Button>
      </div>
    </div>
  );
}
