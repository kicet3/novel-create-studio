import { PROSE_RHYTHM_HINTS, PROSE_RHYTHM_LABELS, PROSE_RHYTHMS, type NovelDto, type ProseRhythm } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import { Callout, Card, Select } from "../../../components/ui/index.js";
import { useUpdateNovel } from "../../novels/api.js";

/**
 * 설계 추가 0024: 문체 — 문장 리듬 (PATCH /api/novels/:id {proseRhythm} → novel.settings_changed).
 * 집필·다듬기 프롬프트와 리듬 지표의 기준값이 바뀝니다. 기준을 넘는 문단은 다듬기 단계에서 그 문단만 한 번 더 고칩니다.
 */
export function ProseRhythmSection({ novel }: { novel: NovelDto }) {
  const m = useUpdateNovel(novel.id);
  const mode: ProseRhythm = novel.proseRhythm ?? "normal";
  return (
    <Card title="문체">
      <div className="flex flex-col gap-2 text-[13px]">
        <label className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">문장 리듬</span>
          <Select
            controlSize="sm"
            className="w-auto"
            value={mode}
            disabled={m.isPending}
            onChange={(e) => m.mutate({ proseRhythm: e.target.value as ProseRhythm })}
          >
            {PROSE_RHYTHMS.map((x) => (
              <option key={x} value={x}>
                {PROSE_RHYTHM_LABELS[x]}
                {x === "normal" ? " (기본)" : ""}
              </option>
            ))}
          </Select>
        </label>
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs">
          {PROSE_RHYTHMS.map((x) => (
            <li key={x} className={x === mode ? "text-text" : "text-muted"}>
              <b>{PROSE_RHYTHM_LABELS[x]}</b> — {PROSE_RHYTHM_HINTS[x]}
            </li>
          ))}
        </ul>
        <p className="m-0 text-xs text-faint">앞으로 쓰고 다듬는 원고에 적용됩니다. 이미 쓴 화는 원고 화면의 [문체 다듬기]로 다시 다듬을 수 있습니다. 대사는 리듬 지표에서 빠집니다.</p>
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
      </div>
    </Card>
  );
}
