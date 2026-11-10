import { useEffect, useState } from "react";
import { PROSE_RHYTHM_LABELS, type EpisodeDetailDto, type RhythmMetricDto } from "@ncs/shared";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "../../api/client.js";
import { queryKeys } from "../../api/query-keys.js";
import { Badge, Button, Callout, Card } from "../../components/ui/index.js";
import { useDecideRhythmCandidate, useRhythmPolish, useRhythmTask } from "./api.js";

/** "문장 리듬: 보통 · 단문 비율 n% · 최장 단문 연속 k" (설계 추가 0024) */
export function rhythmSummary(r: Pick<RhythmMetricDto, "setting" | "shortRatio" | "longestShortRun">): string {
  return `문장 리듬: ${PROSE_RHYTHM_LABELS[r.setting]} · 단문 비율 ${Math.round(r.shortRatio * 100)}% · 최장 단문 연속 ${r.longestShortRun}`;
}

const POLISHABLE = ["awaiting_approval", "approved"] as const;
const TASK_TERMINAL = ["done", "failed", "cancelled"];

/**
 * 설계 추가 0024: rhythm metric of the working copy (narration only) + [문체 다듬기] for an episode that finished the
 * pipeline. The candidate version sits next to the current one: compare it in 버전 비교, then keep (사람 수정 규칙 —
 * 다시 검사, 승인된 화는 승인이 풀림) or discard.
 */
export function RhythmCard({ novelId, episode, onCompare }: { novelId: string; episode: EpisodeDetailDto; onCompare: (versionId: string) => void }) {
  const r = episode.rhythm;
  const polish = useRhythmPolish(novelId, episode.episodeNo);
  const decide = useDecideRhythmCandidate(novelId, episode.episodeNo);
  const qc = useQueryClient();
  const candidate = episode.rhythmCandidateVersionId ?? null;
  // the pass runs in the background: poll its task; when it ends, refresh the episode and tell the author when no
  // candidate came out (nothing to fix / every rewrite rejected → the text stays as is)
  const [taskId, setTaskId] = useState<string | null>(null);
  const [settledTaskId, setSettledTaskId] = useState<string | null>(null);
  const task = useRhythmTask(novelId, taskId);
  const taskStatus = task.data?.id === taskId ? task.data?.status : undefined;
  const ended = !!taskStatus && TASK_TERMINAL.includes(taskStatus);
  useEffect(() => {
    if (!ended || !taskId) return;
    let live = true;
    void qc.invalidateQueries({ queryKey: queryKeys.novel(novelId).episode(episode.episodeNo) }).then(() => {
      if (live) setSettledTaskId(taskId);
    });
    return () => {
      live = false;
    };
  }, [ended, taskId, qc, novelId, episode.episodeNo]);
  useEffect(() => {
    setTaskId(null);
    setSettledTaskId(null);
  }, [episode.episodeNo]);
  const waiting = !!taskId && settledTaskId !== taskId && !candidate && !task.error;
  const notice =
    taskId && settledTaskId === taskId && !candidate
      ? taskStatus === "done"
        ? "고칠 수 있는 문단이 없었습니다(원문 유지)."
        : "문체 다듬기 작업이 끝나지 못했습니다. 작업 보드에서 상태를 확인하세요(원문 유지)."
      : null;

  if (!r) return null;
  const flagged = r.flaggedParagraphs.length;
  const canPolish = (POLISHABLE as readonly string[]).includes(episode.status);
  return (
    <Card title="문장 리듬" actions={<Badge tone={flagged ? "warn" : "ok"} glyph>{flagged ? `지적 문단 ${flagged}개` : "기준 안"}</Badge>}>
      <p className="m-0 text-[13px] font-semibold tabular">{rhythmSummary(r)}</p>
      <p className="m-0 mt-1 text-xs text-muted tabular">
        서술 {r.narrationSentences}문장 · 평균 {r.avgSentenceLength}자 · 대사 {r.dialogueSentences}문장(지표에서 제외)
      </p>
      {candidate ? (
        <Callout tone="info" title="문체 다듬기 후보가 있습니다" className="mt-2">
          <p className="m-0 text-xs">지적 문단만 리듬을 고친 버전입니다. 버전 비교에서 확인한 뒤 적용하거나 버리세요. 적용하면 사람 수정으로 저장되어 다시 검사합니다{episode.status === "approved" ? "(승인이 풀립니다)" : ""}.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => onCompare(candidate)}>
              비교
            </Button>
            <Button size="sm" variant="primary" loading={decide.isPending} onClick={() => decide.mutate({ versionId: candidate, decision: "keep" })}>
              적용
            </Button>
            <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate({ versionId: candidate, decision: "discard" })}>
              버리기
            </Button>
          </div>
        </Callout>
      ) : (
        canPolish && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              loading={polish.isPending || waiting}
              disabled={!flagged}
              title={flagged ? undefined : "리듬 기준을 넘는 문단이 없습니다."}
              onClick={() =>
                polish.mutate(undefined, {
                  onSuccess: (res) => {
                    setSettledTaskId(null);
                    setTaskId(res.taskId);
                  },
                })
              }
            >
              문체 다듬기
            </Button>
            <span className="text-xs text-faint">{waiting ? "지적 문단을 다듬는 중입니다…" : "지적 문단만 리듬을 고친 후보 버전을 만듭니다(사건·사실·대사 유지)."}</span>
          </div>
        )
      )}
      {notice && !candidate && (
        <Callout tone={taskStatus === "done" ? "info" : "warn"} className="mt-2">
          {notice}
        </Callout>
      )}
      {(polish.error || decide.error) && (
        <Callout tone="danger" className="mt-2">
          {errorMessage(polish.error ?? decide.error)}
        </Callout>
      )}
    </Card>
  );
}
