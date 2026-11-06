import { useParams } from "react-router";
import { PageHeader } from "../../components/layout/PageHeader.js";
import { EmptyState } from "../../components/ui/index.js";
import { useNovelId } from "../../app/novel-context.js";
import { EpisodeList } from "./EpisodeList.js";
import { EpisodeScreen } from "./EpisodeScreen.js";

/**
 * `/novels/:novelId/manuscript` (episode list) and `/novels/:novelId/episodes/:episodeNo`
 * (version viewer · diff · direct edit), 08 §9.4. Query params on the episode route:
 * `v` (version id), `mode` (read|diff|edit), `at`/`end` (char range to highlight, e.g. from a mention link).
 */
export function ManuscriptPage() {
  const novelId = useNovelId();
  const { episodeNo } = useParams();
  if (episodeNo === undefined) return <EpisodeList novelId={novelId} />;
  const no = Number(episodeNo);
  if (!Number.isInteger(no) || no < 1) {
    return (
      <>
        <PageHeader title="원고" />
        <EmptyState title="화 번호가 올바르지 않습니다" description="화 목록에서 다시 고르세요." />
      </>
    );
  }
  return <EpisodeScreen key={no} novelId={novelId} episodeNo={no} />;
}
