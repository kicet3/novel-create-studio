import { useEffect, useState } from "react";
import { labelKo, type AutonomyLevel, type NovelDto, type PublishPolicy } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import { Badge, Button, Callout, Card, Checkbox, ChoiceGroup, ConfirmDialog, Field, Select, type ChoiceOption } from "../../../components/ui/index.js";
import { useChangeAutonomy } from "../../novels/api.js";

const OPTIONS: ChoiceOption<AutonomyLevel>[] = [
  {
    value: "episode_approval",
    label: "화별 승인",
    adornment: <Badge tone="accent">기본값</Badge>,
    description: "기획서·플롯 계획·매 화를 직접 확인하고 승인합니다. 신규 사실과 떡밥 회수는 화 승인 때 확정됩니다.",
  },
  {
    value: "arc_approval",
    label: "플롯별 승인",
    adornment: <Badge>준비 중</Badge>,
    description: "비축분이 쌓이면 플롯 단위로 묶어 승인합니다. 그 전의 사실은 ‘미확정’으로 씁니다.",
  },
  {
    value: "full_auto",
    label: "완전 자율",
    adornment: <Badge tone="violet">준비 중</Badge>,
    description: "기획서 확정과 질문 응답만 사람이 하고 나머지는 에이전트가 진행합니다. 정책·저작권 경고 확인이 필요합니다.",
  },
  { value: "co_writing", label: "공동 집필", adornment: <Badge>v1</Badge>, description: "v1에서 제공합니다.", disabled: true },
];

/**
 * 자율성 수준 (FR-UI-09, INV-NOV-02/04). Change is recorded as `novel.autonomy_changed`.
 * 기존 approved 사실 변경·리트콘·결말 방향 변경·예산 재개·떡밥 폐기는 모든 수준에서 사람 승인입니다.
 */
export function AutonomySection({ novel }: { novel: NovelDto }) {
  const [level, setLevel] = useState<AutonomyLevel>(novel.autonomyLevel);
  const [policy, setPolicy] = useState<PublishPolicy>(novel.publishPolicy);
  const [ack, setAck] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const m = useChangeAutonomy(novel.id);
  useEffect(() => {
    setLevel(novel.autonomyLevel);
    setPolicy(novel.publishPolicy);
  }, [novel.autonomyLevel, novel.publishPolicy]);

  const dirty = level !== novel.autonomyLevel || (level === "full_auto" && policy !== novel.publishPolicy);
  const needsAck = level === "full_auto";
  return (
    <Card title="자율성 수준" actions={<Badge tone="accent">현재 {labelKo("autonomy_level", novel.autonomyLevel)}</Badge>}>
      <div className="flex flex-col gap-3">
        <p className="m-0 text-[13px] text-muted">
          사람 승인 게이트의 위치를 정합니다. 질문 민감도와는 별개이며, 변경 이력은 감사 로그에 남습니다.
        </p>
        <ChoiceGroup legend="자율성 수준" legendHidden name={`autonomy-${novel.id}`} value={level} onChange={setLevel} options={OPTIONS} />
        {level === "full_auto" && (
          <>
            <Field label="공개 처리 방식">
              <Select value={policy} onChange={(e) => setPolicy(e.target.value as PublishPolicy)}>
                {(["manual", "batch_question", "scheduled"] as const).map((p) => (
                  <option key={p} value={p}>
                    {labelKo("publish_policy", p)}
                  </option>
                ))}
              </Select>
            </Field>
            <Callout tone="warn" title="완전 자율 경고">
              에이전트가 만든 원고가 사람 검토 없이 확정·공개될 수 있습니다. 연재 플랫폼의 AI 생성물 정책과 저작권 책임은 작가에게 있습니다.
            </Callout>
            <Checkbox label="위 정책·저작권 경고를 확인했습니다" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          </>
        )}
        <p className="m-0 text-xs text-faint">
          모든 수준에서 항상 사람 승인: 기존 승인 사실 변경 · 리트콘 · 결말 방향 변경 · 예산 하드 한도 도달 후 재개 · 떡밥 폐기.
        </p>
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
        {m.isSuccess && !dirty && <Callout tone="ok">자율성 수준을 바꿨습니다.</Callout>}
        <div className="flex justify-end">
          <Button variant="primary" disabled={!dirty || (needsAck && !ack)} onClick={() => setConfirm(true)}>
            자율성 수준 저장
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        title={`자율성 수준을 ‘${labelKo("autonomy_level", level)}’(으)로 바꿀까요?`}
        description="다음 작업부터 적용됩니다."
        busy={m.isPending}
        onCancel={() => setConfirm(false)}
        onConfirm={() =>
          m.mutate(
            { autonomyLevel: level, publishPolicy: level === "full_auto" ? policy : undefined, acknowledgedFullAutoWarning: needsAck ? ack : false },
            { onSettled: () => setConfirm(false) },
          )
        }
      />
    </Card>
  );
}
