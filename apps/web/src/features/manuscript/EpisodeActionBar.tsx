import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { labelKo } from "@ncs/shared";
import { api, errorMessage } from "../../api/client.js";
import { queryKeys } from "../../api/query-keys.js";
import { Button, Callout, ConfirmDialog, Spinner } from "../../components/ui/index.js";
import { novelPath } from "../../components/layout/nav.js";
import { usePendingApprovals } from "../inbox/api.js";
import { useState } from "react";
import type { EpisodeDto } from "./api.js";
import { episodeAction } from "./episode-action.js";

/**
 * Bottom of the 수정 대화: once the edits are in, approve / approve and publish / publish without leaving the chat.
 * Approval goes through the same hitl decision as the inbox; publishing is E13 (approved → published).
 */
export function EpisodeActionBar({ novelId, episode }: { novelId: string; episode: EpisodeDto }) {
  const qc = useQueryClient();
  const approvals = usePendingApprovals(novelId);
  const approval = approvals.data?.items.find((a) => a.approvalType === "episode" && a.subjectId === episode.id) ?? null;
  const [confirm, setConfirm] = useState<null | "approve" | "approve_publish" | "publish">(null);
  const m = useMutation({
    mutationFn: async (kind: "approve" | "approve_publish" | "publish") => {
      if (kind !== "publish") {
        if (!approval) throw new Error("승인 요청을 찾지 못했습니다. 인박스에서 확인해 주세요.");
        await api.post(`/novels/${novelId}/approvals/${approval.id}/decision`, { decision: "approved" });
      }
      if (kind !== "approve") await api.post(`/novels/${novelId}/episodes/${episode.episodeNo}/publish`, {});
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: queryKeys.novel(novelId).all }),
    onSuccess: () => setConfirm(null),
  });
  const a = episodeAction(episode.status, !!approval);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[10px] border border-border bg-surface px-4 py-3 shadow-card">
      <span className="min-w-0 flex-1 text-[13px]">
        {a.busy && <Spinner />} {a.message}
      </span>
      {a.canApprove && (
        <>
          <Button size="sm" onClick={() => setConfirm("approve")}>
            승인
          </Button>
          <Button size="sm" variant="primary" onClick={() => setConfirm("approve_publish")}>
            승인하고 공개
          </Button>
        </>
      )}
      {a.waitingInbox && (
        <Link to={novelPath(novelId, "inbox")} className="text-[13px]">
          인박스 열기
        </Link>
      )}
      {a.canPublish && (
        <Button size="sm" variant="primary" onClick={() => setConfirm("publish")}>
          공개
        </Button>
      )}
      {m.error && <Callout tone="danger" className="w-full">{errorMessage(m.error)}</Callout>}
      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === "approve" ? `${episode.episodeNo}화를 승인할까요?` : confirm === "approve_publish" ? `${episode.episodeNo}화를 승인하고 공개할까요?` : `${episode.episodeNo}화를 공개할까요?`
        }
        description={
          confirm === "approve"
            ? "승인하면 이 화의 사실이 확정됩니다. 한 화씩 진행이면 다음 화 작성을 시작합니다."
            : "공개된 화의 사실은 확정 캐논이 되어 이후 수정에 승인이 필요합니다."
        }
        confirmLabel={confirm === "approve" ? "승인" : confirm === "approve_publish" ? "승인하고 공개" : "공개"}
        busy={m.isPending}
        onCancel={() => {
          m.reset();
          setConfirm(null);
        }}
        onConfirm={() => confirm && m.mutate(confirm)}
      />
      <span className="sr-only">{labelKo("episode_status", episode.status)}</span>
    </div>
  );
}
