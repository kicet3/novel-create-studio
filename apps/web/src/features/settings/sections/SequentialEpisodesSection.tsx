import type { NovelDto } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import { Callout, Card, Checkbox } from "../../../components/ui/index.js";
import { useUpdateNovel } from "../../novels/api.js";

/**
 * 설계 추가 0018: 한 화씩 진행 (PATCH /api/novels/:id {sequentialEpisodes} → novel.settings_changed).
 * 화별 승인에서만 의미가 있습니다: N화를 읽고 승인해야 N+1화를 쓰기 시작합니다.
 */
export function SequentialEpisodesSection({ novel }: { novel: NovelDto }) {
  const m = useUpdateNovel(novel.id);
  const on = novel.sequentialEpisodes ?? true;
  const applies = novel.autonomyLevel === "episode_approval";
  return (
    <Card title="한 화씩 진행">
      <div className="flex flex-col gap-2">
        <Checkbox
          label="한 화씩 진행"
          hint="한 화가 다 써지면 알림을 보내고, 읽고 승인해야 다음 화를 씁니다. 반려·다시 쓰기 중에는 다음 화를 시작하지 않습니다."
          checked={on}
          disabled={m.isPending || !applies}
          onChange={(e) => m.mutate({ sequentialEpisodes: e.target.checked })}
        />
        {!applies && <p className="m-0 text-xs text-faint">지금 자율성 수준({novel.autonomyLevel === "full_auto" ? "완전 자율" : "플롯별 승인"})에서는 적용되지 않습니다. 화별 승인에서만 씁니다.</p>}
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
      </div>
    </Card>
  );
}
