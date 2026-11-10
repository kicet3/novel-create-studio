import { EPISODE_TITLE_MODE_LABELS, EPISODE_TITLE_MODES, type EpisodeTitleMode, type NovelDto } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import { Callout, Card, Select } from "../../../components/ui/index.js";
import { useUpdateNovel } from "../../novels/api.js";

const HINT: Record<EpisodeTitleMode, string> = {
  unit: "한 에피소드를 여러 화로 나눠 「묶음 제목 (1)」「묶음 제목 (2)」처럼 올립니다. 한 화로 끝나는 에피소드는 번호 없이 제목만 씁니다.",
  per_episode: "화마다 새 제목을 붙입니다(이전 방식).",
};

/**
 * 설계 추가 0023: 제목 방식 (PATCH /api/novels/:id {episodeTitleMode} → novel.settings_changed).
 * 앞으로 계획하는 화에 적용됩니다. 이미 있는 화의 제목은 구성 화면·원고 목록의 [제목 정리]로 바꿉니다.
 */
export function EpisodeTitleModeSection({ novel }: { novel: NovelDto }) {
  const m = useUpdateNovel(novel.id);
  const mode: EpisodeTitleMode = novel.episodeTitleMode ?? "unit";
  return (
    <Card title="제목 방식">
      <div className="flex flex-col gap-2 text-[13px]">
        <label className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">화 제목</span>
          <Select
            controlSize="sm"
            className="w-auto"
            value={mode}
            disabled={m.isPending}
            onChange={(e) => m.mutate({ episodeTitleMode: e.target.value as EpisodeTitleMode })}
          >
            {EPISODE_TITLE_MODES.map((x) => (
              <option key={x} value={x}>
                {EPISODE_TITLE_MODE_LABELS[x]}
              </option>
            ))}
          </Select>
        </label>
        <p className="m-0 text-xs text-muted">{HINT[mode]}</p>
        <p className="m-0 text-xs text-faint">앞으로 계획하는 화에 적용됩니다. 이미 있는 화의 제목은 구성 화면이나 원고 목록의 [제목 정리]로 바꿉니다(공개된 화는 직접 고를 때만 바뀝니다).</p>
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
      </div>
    </Card>
  );
}
