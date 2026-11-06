/**
 * Agent-to-agent repair dialogue transcript (runs.output_summary.repairDialogues): the validator's critique of each
 * round and the producing agent's answer. Shown on the board task card and in the agents page run detail. The runs
 * of the task are fetched only while the disclosure is open.
 */
import { useState } from "react";
import { labelKo, repairDialoguesOf, type RepairDialogueDto } from "@ncs/shared";
import { Badge } from "../../components/ui/index.js";
import { useTaskRuns } from "./api.js";

const STATUS: Record<RepairDialogueDto["status"], { label: string; tone: "ok" | "warn" | "danger" }> = {
  resolved: { label: "해결", tone: "ok" },
  partial: { label: "일부 해결", tone: "warn" },
  unresolved: { label: "미해결", tone: "danger" },
};

export function repairRoundsLabel(rounds: number): string {
  return `에이전트 간 수정 대화 ${rounds}회`;
}

export function RepairDialogueDisclosure({ novelId, taskId, rounds, runId }: { novelId: string; taskId: string; rounds: number; runId?: string }) {
  const [open, setOpen] = useState(false);
  const q = useTaskRuns(novelId, open ? taskId : null);
  const items = (q.data?.items ?? [])
    .filter((r) => !runId || r.id === runId)
    .flatMap((r) => repairDialoguesOf(r.outputSummary).map((d, i) => ({ key: `${r.id}:${i}`, d })));
  return (
    <details className="text-xs" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer text-muted">{repairRoundsLabel(rounds)}</summary>
      <div className="mt-1.5 flex max-h-80 flex-col gap-2 overflow-auto">
        {q.isLoading && <span className="text-muted">불러오는 중…</span>}
        {q.isError && <span className="text-danger">대화 기록을 불러오지 못했습니다.</span>}
        {q.isSuccess && items.length === 0 && <span className="text-muted">기록된 대화가 없습니다.</span>}
        {items.map(({ key, d }) => (
          <RepairTranscript key={key} d={d} />
        ))}
      </div>
    </details>
  );
}

function RepairTranscript({ d }: { d: RepairDialogueDto }) {
  const producer = labelKo("agent_role", d.producerRole);
  const s = STATUS[d.status];
  return (
    <section aria-label={`${d.label} 수정 대화`} className="rounded-md border border-border bg-surface-2 p-2">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <b>{d.label}</b>
        <Badge tone={s.tone}>{s.label}</Badge>
        <span className="text-muted">
          {d.critic} ↔ {producer} · 지적 {d.initialIssueCount}건 → 남음 {d.finalIssueCount}건 · 최대 {d.maxRounds}회
        </span>
      </div>
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
        {d.rounds.map((r) => (
          <li key={r.round} className="flex flex-col gap-1">
            <div className="font-semibold">
              {r.round}회차 · {d.critic} → {producer} ({r.issueCount}건)
            </div>
            <pre className="m-0 whitespace-pre-wrap break-words rounded bg-surface p-1.5 font-sans text-[11.5px]">{r.critique}</pre>
            <div className="text-muted">
              {producer} 응답: {r.remainingIssueCount === null ? "응답 실패" : r.remainingIssueCount === 0 ? "모두 고침" : `남은 문제 ${r.remainingIssueCount}건`}
              {r.responseCallId && <code className="ml-1.5">{r.responseCallId}</code>}
            </div>
            {r.responseExcerpt && (
              <details>
                <summary className="cursor-pointer text-muted">응답 앞부분</summary>
                <pre className="m-0 whitespace-pre-wrap break-all rounded bg-surface p-1.5 text-[11px]">{r.responseExcerpt}</pre>
              </details>
            )}
          </li>
        ))}
      </ol>
      {d.remaining.length > 0 && (
        <div className="mt-1 text-muted">
          남은 문제: {d.remaining.slice(0, 5).map((i) => `${i.item} — ${i.problem}`).join(" / ")}
          {d.remaining.length > 5 ? ` 외 ${d.remaining.length - 5}건` : ""}
        </div>
      )}
    </section>
  );
}
