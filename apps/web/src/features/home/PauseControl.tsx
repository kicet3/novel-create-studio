import { useState } from "react";
import { Link } from "react-router";
import { labelKo, type NovelDto } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { Button, ButtonLink, Callout, ConfirmDialog, Field, Textarea } from "../../components/ui/index.js";
import { novelPath } from "../../components/layout/nav.js";
import { usePauseNovel } from "../novels/api.js";
import { usePendingApprovals } from "../inbox/api.js";

/**
 * Pause reasons that a plain "재개" cannot clear: the server answers 409 and the novel resumes
 * through an approval (budget_resume, 03 §5.7 step 7) or after the integrity problem is fixed.
 */
const GUARDED_PAUSE = new Set(["budget_hard_limit", "ontology_integrity"]);
export const isGuardedPause = (novel: NovelDto) => novel.pausedAt !== null && !!novel.pauseReason && GUARDED_PAUSE.has(novel.pauseReason);

/** 작품 일시정지·재개 (FR-HIL-03). Running runs stop at the next safe point. */
export function PauseControl({ novel, size = "md" }: { novel: NovelDto; size?: "md" | "sm" }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const m = usePauseNovel(novel.id);
  const paused = novel.pausedAt !== null;
  if (isGuardedPause(novel)) return <GuardedResumeLink novel={novel} size={size} />;
  return (
    <>
      <Button size={size} variant={paused ? "primary" : "default"} onClick={() => setOpen(true)}>
        {paused ? "작품 재개" : "작품 일시정지"}
      </Button>
      <ConfirmDialog
        open={open}
        title={paused ? "작품을 재개할까요?" : "작품을 일시정지할까요?"}
        description={
          paused
            ? "멈춰 있던 작업이 다시 예약됩니다."
            : "새 작업은 시작하지 않고, 진행 중인 실행은 다음 안전 지점에서 멈춥니다. 질문 답변은 계속 받을 수 있습니다."
        }
        confirmLabel={paused ? "재개" : "일시정지"}
        busy={m.isPending}
        onCancel={() => setOpen(false)}
        onConfirm={() =>
          m.mutate(
            { pause: !paused, reason: reason.trim() || undefined },
            {
              onSuccess: () => {
                setOpen(false);
                setReason("");
              },
            },
          )
        }
      >
        {!paused && (
          <Field label="사유(선택)">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
      </ConfirmDialog>
    </>
  );
}

/** budget / integrity pause: point at the approval (or the screen) that resumes the novel instead of a failing button */
function GuardedResumeLink({ novel, size }: { novel: NovelDto; size: "md" | "sm" }) {
  const approvals = usePendingApprovals(novel.id);
  if (novel.pauseReason === "budget_hard_limit") {
    const ap = approvals.data?.items.find((a) => a.approvalType === "budget_resume");
    return ap ? (
      <ButtonLink size={size} variant="primary" to={novelPath(novel.id, `inbox/${ap.questionId}`)}>
        예산 재개 승인으로 이동
      </ButtonLink>
    ) : (
      <ButtonLink size={size} to={novelPath(novel.id, "settings")}>
        예산 설정 열기
      </ButtonLink>
    );
  }
  return (
    <ButtonLink size={size} to={novelPath(novel.id, "ontology")}>
      온톨로지 문제 확인
    </ButtonLink>
  );
}

export function PausedCallout({ novel }: { novel: NovelDto }) {
  if (!novel.pausedAt) return null;
  const guarded = isGuardedPause(novel);
  return (
    <Callout tone="warn" title="작품이 일시정지되어 있습니다" actions={<PauseControl novel={novel} size="sm" />}>
      <span className="text-muted">
        사유: {novel.pauseReason ? labelKo("pause_reason", novel.pauseReason) : "사용자 요청"} · 새 작업이 시작되지 않습니다.
      </span>
      {guarded && novel.pauseReason === "budget_hard_limit" && (
        <span className="mt-1 block text-muted">
          예산 한도에 도달해 멈췄습니다. <Link to={novelPath(novel.id, "settings")}>설정 › 예산</Link>에서 한도를 올린 뒤 인박스의 예산 재개 승인을 승인하면
          다시 시작합니다.
        </span>
      )}
      {guarded && novel.pauseReason === "ontology_integrity" && (
        <span className="mt-1 block text-muted">온톨로지 무결성 점검에서 문제가 발견돼 멈췄습니다. 문제를 고친 뒤 다시 점검하면 재개할 수 있습니다.</span>
      )}
    </Callout>
  );
}
