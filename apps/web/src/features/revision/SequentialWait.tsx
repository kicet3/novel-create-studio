import { Link } from "react-router";
import type { EpisodeStatus } from "@ncs/shared";
import { novelPath } from "../../components/layout/nav.js";
import { Callout } from "../../components/ui/index.js";

/** 설계 추가 0018: 한 화씩 진행 — the episode the author must read and approve before the next one is written */
export function sequentialWait(novel: { autonomyLevel: string; sequentialEpisodes?: boolean } | undefined, episodes: ReadonlyArray<{ episodeNo: number; status: EpisodeStatus }> | undefined): { waitingEpisodeNo: number; nextEpisodeNo: number | null } | null {
  if (!novel || novel.autonomyLevel !== "episode_approval" || novel.sequentialEpisodes === false || !episodes) return null;
  // the writing frontier only (an older approved episode re-opened for an edit does not hold the next one)
  const doneMax = episodes.filter((e) => e.status === "approved" || e.status === "published").reduce((x, e) => Math.max(x, e.episodeNo), 0);
  const waiting = [...episodes].filter((e) => e.status === "awaiting_approval" && e.episodeNo >= doneMax).sort((a, b) => a.episodeNo - b.episodeNo)[0];
  if (!waiting) return null;
  const next = episodes.find((e) => e.episodeNo === waiting.episodeNo + 1 && e.status === "planned");
  return { waitingEpisodeNo: waiting.episodeNo, nextEpisodeNo: next ? next.episodeNo : null };
}

export function sequentialWaitText(w: { waitingEpisodeNo: number; nextEpisodeNo: number | null }): string {
  return `${w.waitingEpisodeNo}화 승인 대기${w.nextEpisodeNo ? ` — 승인하면 ${w.nextEpisodeNo}화를 씁니다` : ""}`;
}

export function SequentialWaitCallout({ novelId, wait }: { novelId: string; wait: { waitingEpisodeNo: number | null; nextEpisodeNo: number | null } | null | undefined }) {
  if (!wait || wait.waitingEpisodeNo == null) return null;
  const no = wait.waitingEpisodeNo;
  return (
    <Callout tone="info" title={sequentialWaitText({ waitingEpisodeNo: no, nextEpisodeNo: wait.nextEpisodeNo })}>
      <Link to={`${novelPath(novelId, "read")}/${no}?mode=draft`}>읽기</Link>
      {" · "}
      <Link to={`${novelPath(novelId, "episodes")}/${no}?mode=chat`}>수정 대화</Link>
      {" · "}
      <Link to={novelPath(novelId, "inbox")}>인박스에서 승인</Link>
    </Callout>
  );
}
