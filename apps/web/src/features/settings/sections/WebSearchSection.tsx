import { useState } from "react";
import { WEB_SEARCH_MAX_USES_RANGE, type NovelDto } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import { Button, Callout, Card, Checkbox, Field, Input } from "../../../components/ui/index.js";
import { useUpdateNovel } from "../../novels/api.js";

const { min: MIN, max: MAX } = WEB_SEARCH_MAX_USES_RANGE;

/**
 * 설계 추가 0011: 인터넷 검색 (PATCH /api/novels/:id {webSearchEnabled, webSearchMaxUses} → novel.settings_changed).
 * 컨셉 대화·기획서·전체 구성·세계관 생성에서 AI가 사실·장르 관습·용어를 확인할 때만 검색합니다.
 */
export function WebSearchSection({ novel }: { novel: NovelDto }) {
  const [enabled, setEnabled] = useState(novel.webSearchEnabled);
  const [cap, setCap] = useState(String(novel.webSearchMaxUses));
  const m = useUpdateNovel(novel.id);
  const n = Number(cap);
  const capValid = Number.isInteger(n) && n >= MIN && n <= MAX;
  const patch = {
    ...(enabled !== novel.webSearchEnabled ? { webSearchEnabled: enabled } : {}),
    ...(capValid && n !== novel.webSearchMaxUses ? { webSearchMaxUses: n } : {}),
  };
  const dirty = Object.keys(patch).length > 0;
  return (
    <Card title="인터넷 검색">
      <div className="flex flex-col gap-3">
        <Checkbox
          label="인터넷 검색 사용"
          hint="컨셉 대화, 기획서, 전체 구성, 세계관 생성에서 고증·장르 관습·용어를 확인할 때만 검색합니다. 쓴 출처는 답변 아래 ‘출처’에 표시됩니다."
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <Field label="한 번에 검색할 수 있는 횟수" hint={`AI 호출 1회당 최대 ${MIN}~${MAX}회. 검색 1회당 비용이 예산에 포함됩니다(Claude 구독 연결은 별도 과금 없음).`} error={capValid ? undefined : `${MIN}~${MAX} 사이 정수를 입력하세요.`}>
          <Input type="number" min={MIN} max={MAX} step={1} value={cap} disabled={!enabled} onChange={(e) => setCap(e.target.value)} className="max-w-28" />
        </Field>
        <p className="m-0 text-xs text-faint">
          원고 본문이나 브리프 문장을 그대로 검색어로 보내지 않고, 실존 인물은 검색하지 않습니다. Grok(xAI)과 ChatGPT 로그인 연결은 아직 검색을 지원하지 않아 검색 없이 진행합니다.
        </p>
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
        {m.isSuccess && !dirty && <Callout tone="ok">저장했습니다.</Callout>}
        <div className="flex justify-end">
          <Button variant="primary" disabled={!dirty || !capValid} loading={m.isPending} onClick={() => m.mutate(patch)}>
            변경 저장
          </Button>
        </div>
      </div>
    </Card>
  );
}
