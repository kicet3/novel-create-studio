import { useState } from "react";
import { formatUsd, labelKo, MICROS_PER_USD, type BudgetStatusViewDto } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import { Button, Callout, Card, Checkbox, ConfirmDialog, Field, Input, Progress, QueryView, StatusBadge } from "../../../components/ui/index.js";
import { useBudget, useResumeBudget, useUpdateBudgetPolicy } from "../api.js";

/** 예산 정책 (FR-BUD-01·02): 하드 한도·소프트 경고·하드 정지, 한도 도달 후 재개. */
export function BudgetSection({ novelId }: { novelId: string }) {
  const q = useBudget(novelId);
  return (
    <Card title="예산">
      <QueryView query={q} compact notReadyDescription="예산 모듈이 준비되면 정책을 바꿀 수 있습니다.">
        {(d) => (
          <div className="flex flex-col gap-3">
            {d.hardStopped && <Callout tone="danger" title="예산 하드 한도에 도달해 작품이 멈췄습니다">재개하려면 아래 정책에서 ‘재개’를 누르세요(사람 승인 필요).</Callout>}
            {d.items.length === 0 && <p className="m-0 text-[13px] text-muted">예산 정책이 없습니다.</p>}
            {d.items.map((p) => (
              <PolicyRow key={p.policyId} novelId={novelId} p={p} />
            ))}
            <p className="m-0 text-xs text-faint">하드 한도는 예약 상한(출력 토큰 상한 포함 최대 과금) 기준으로 지킵니다. 예약 중 실행 {d.activeReservations}건.</p>
          </div>
        )}
      </QueryView>
    </Card>
  );
}

function PolicyRow({ novelId, p }: { novelId: string; p: BudgetStatusViewDto }) {
  const [limit, setLimit] = useState((p.hardLimitMicros / MICROS_PER_USD).toFixed(2));
  const [warn, setWarn] = useState(String(Math.round(p.softWarnRatio * 100)));
  const [hardStop, setHardStop] = useState(p.hardStopEnabled);
  const [err, setErr] = useState<string | null>(null);
  const [confirmResume, setConfirmResume] = useState(false);
  const upd = useUpdateBudgetPolicy(novelId);
  const resume = useResumeBudget(novelId);
  const ratio = p.hardLimitMicros > 0 ? p.spentMicros / p.hardLimitMicros : 0;

  const save = () => {
    const usd = Number(limit);
    const w = Number(warn);
    if (!Number.isFinite(usd) || usd < 0) return setErr("하드 한도는 0 이상이어야 합니다.");
    if (!Number.isFinite(w) || w < 0 || w > 100) return setErr("경고 비율은 0~100% 사이여야 합니다.");
    setErr(null);
    upd.mutate({ category: p.category, patch: { hardLimitMicros: Math.round(usd * MICROS_PER_USD), softWarnRatio: w / 100, hardStopEnabled: hardStop } });
  };

  return (
    <section aria-label={`${labelKo("budget_category", p.category)} 예산`} className="rounded-lg border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <b className="text-[13px]">{labelKo("budget_category", p.category)}</b>
        <span className="text-xs text-muted">{labelKo("budget_window", p.window)}</span>
        <StatusBadge enum="budget_status" value={p.status} />
        <span className="tabular ml-auto text-[13px]">
          {formatUsd(p.spentMicros)} / {formatUsd(p.hardLimitMicros)} · 예약 {formatUsd(p.reservedMicros)}
        </span>
      </div>
      <Progress className="mb-3" value={ratio * 100} tone={ratio >= p.softWarnRatio ? "warn" : "accent"} label={`${labelKo("budget_category", p.category)} 예산 소진율`} valueText={`${Math.round(ratio * 100)}%`} />
      <div className="grid grid-cols-1 items-start gap-3 min-[521px]:grid-cols-3">
        <Field label="하드 한도 (USD)">
          <Input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} />
        </Field>
        <Field label="소프트 경고 (%)">
          <Input inputMode="numeric" value={warn} onChange={(e) => setWarn(e.target.value)} />
        </Field>
        <div className="min-[521px]:pt-8">
          <Checkbox label="한도 도달 시 자동 일시정지" checked={hardStop} onChange={(e) => setHardStop(e.target.checked)} />
        </div>
      </div>
      {(err || upd.error || resume.error) && <Callout className="mt-2" tone="danger">{err ?? errorMessage(upd.error ?? resume.error)}</Callout>}
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        {p.status === "hard_stopped" && (
          <Button onClick={() => setConfirmResume(true)} loading={resume.isPending}>
            재개
          </Button>
        )}
        <Button variant="primary" onClick={save} loading={upd.isPending}>
          저장
        </Button>
      </div>
      <ConfirmDialog
        open={confirmResume}
        title="예산 한도 도달 상태에서 재개할까요?"
        description="한도를 올리지 않으면 다음 실행에서 다시 멈출 수 있습니다."
        busy={resume.isPending}
        onCancel={() => setConfirmResume(false)}
        onConfirm={() => resume.mutate(p.category, { onSettled: () => setConfirmResume(false) })}
      />
    </section>
  );
}
