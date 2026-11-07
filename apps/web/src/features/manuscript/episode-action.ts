/** what the revision-chat action bar offers for an episode status (pure; unit-tested) */
export interface EpisodeAction {
  message: string;
  canApprove: boolean;
  canPublish: boolean;
  /** awaiting approval but the approval request isn't visible (e.g. still being created) */
  waitingInbox: boolean;
  busy: boolean;
}

const WORKING = new Set(["outlining", "drafting", "checking", "polishing", "revising", "adjusting"]);

export function episodeAction(status: string, hasApproval: boolean): EpisodeAction {
  const base = { canApprove: false, canPublish: false, waitingInbox: false, busy: false };
  if (status === "awaiting_approval")
    return hasApproval
      ? { ...base, canApprove: true, message: "수정이 끝났으면 승인하거나 바로 공개할 수 있습니다." }
      : { ...base, waitingInbox: true, message: "승인 요청을 준비하는 중입니다. 인박스에서도 승인할 수 있습니다." };
  if (status === "approved") return { ...base, canPublish: true, message: "승인된 화입니다. 공개할 수 있습니다." };
  if (status === "published") return { ...base, message: "공개된 화입니다. 더 고치려면 공개 취소나 리트콘 승인이 필요합니다." };
  if (WORKING.has(status)) return { ...base, busy: true, message: "수정 내용을 반영하는 중입니다(검사·다듬기). 끝나면 여기서 승인·공개할 수 있습니다." };
  return { ...base, message: "아직 승인·공개할 수 없는 상태입니다." };
}
