import { useState } from "react";
import type { NovelDto } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import { Button, Callout, Card, Checkbox, Field, Input } from "../../../components/ui/index.js";
import { useUpdateNovel } from "../../novels/api.js";

/**
 * 설계 추가 0015: 엔티티 판정 에이전트 (PATCH /api/novels/:id {entityAgentResolution, entityAgentMinConfidence} → novel.settings_changed).
 * 대명사·흔한 명사는 엔티티로 만들거나 묻지 않고, 모호한 표기는 세계관 관리자 에이전트가 문맥으로 판단합니다.
 */
export function EntityResolutionSection({ novel }: { novel: NovelDto }) {
  const [enabled, setEnabled] = useState(novel.entityAgentResolution ?? true);
  const [conf, setConf] = useState(String(novel.entityAgentMinConfidence ?? 0.75));
  const m = useUpdateNovel(novel.id);
  const n = Number(conf);
  const valid = Number.isFinite(n) && n >= 0.3 && n <= 1;
  const patch = {
    ...(enabled !== (novel.entityAgentResolution ?? true) ? { entityAgentResolution: enabled } : {}),
    ...(valid && n !== (novel.entityAgentMinConfidence ?? 0.75) ? { entityAgentMinConfidence: n } : {}),
  };
  const dirty = Object.keys(patch).length > 0;
  return (
    <Card title="엔티티 판정 에이전트">
      <div className="flex flex-col gap-3">
        <Checkbox
          label="에이전트가 엔티티를 판정"
          hint="‘그’, ‘선생님’ 같은 대명사·호칭과 ‘화면’, ‘결승전’ 같은 일반 명사는 엔티티로 만들거나 묻지 않습니다. 모호한 표기는 세계관 관리자 에이전트가 문맥으로 연결·별칭·새 엔티티·무시를 정하고, 한 번 정한 별칭은 다음 화부터 자동으로 연결합니다."
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <Field label="바로 적용할 확신도" hint="0.3~1. 이 값 이상이면 에이전트 판단을 바로 적용하고(감사 타임라인에 기록, 되돌릴 수 있음), 미만이면서 그럴듯한 인물이 둘 이상일 때만 인박스에 묻습니다." error={valid ? undefined : "0.3~1 사이 숫자를 입력하세요."}>
          <Input type="number" min={0.3} max={1} step={0.05} value={conf} disabled={!enabled} onChange={(e) => setConf(e.target.value)} className="max-w-28" />
        </Field>
        <p className="m-0 text-xs text-faint">끄면 이전처럼 판단이 어려운 표기를 모두 인박스에 질문으로 올립니다.</p>
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
        {m.isSuccess && !dirty && <Callout tone="ok">저장했습니다.</Callout>}
        <div className="flex justify-end">
          <Button variant="primary" disabled={!dirty || !valid} loading={m.isPending} onClick={() => m.mutate(patch)}>
            변경 저장
          </Button>
        </div>
      </div>
    </Card>
  );
}
