import { StateBadge } from "./status-badges.js";
import { useEffect, useState } from "react";
import { parseAutopilotSettings, type AutopilotSettings, type NovelDto } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import { Badge, Button, Callout, Card, Checkbox, Field, Input } from "../../../components/ui/index.js";
import { useUpdateAutopilotSettings } from "../../autopilot/api.js";

type BoolKey = { [K in keyof AutopilotSettings]: AutopilotSettings[K] extends boolean ? K : never }[keyof AutopilotSettings];

const AUTO_GROUP: Array<{ key: BoolKey; label: string; hint?: string }> = [
  { key: "autoApproveEpisodes", label: "화 자동 승인", hint: "분량 3,000자 미만이거나 심각도 높음 연속성 이슈·정책 경고 이력·재작성 상한이 있으면 사람에게 넘깁니다." },
  { key: "autoApprovePlots", label: "플롯 계획 자동 승인", hint: "새 인물은 AI가 빈 항목을 채우고 제안을 수락합니다(직접 쓴 항목은 그대로)." },
  { key: "autoAcceptWorld", label: "세계관 후보 자동 승인", hint: "충돌하는 후보는 '미확정'으로 남습니다." },
  { key: "autoCompleteCast", label: "캐릭터 빈 항목 채움·캐스트 확정" },
  { key: "autoSaveGoal", label: "컨셉 값으로 연재 목표 저장" },
  { key: "autoApproveBible", label: "기획서 자동 승인" },
];

/** 설계 추가 0014 — "완전 자율 설정": what full_auto decides, question auto answers, safety and pace. */
export function AutopilotSection({ novel }: { novel: NovelDto }) {
  const saved = parseAutopilotSettings(novel.autopilotSettings);
  const [s, setS] = useState<AutopilotSettings>(saved);
  const [ack, setAck] = useState(false);
  const m = useUpdateAutopilotSettings(novel.id);
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    setS(parseAutopilotSettings(novel.autopilotSettings));
    setAck(false);
  }, [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const editable = novel.autonomyLevel === "full_auto";
  const dirty = JSON.stringify(s) !== savedKey;
  const optInTurnedOn = (s.autoConfirmConcept && !saved.autoConfirmConcept) || (s.autoApproveStructure && !saved.autoApproveStructure);
  const set = <K extends keyof AutopilotSettings>(k: K, v: AutopilotSettings[K]) => setS((cur) => ({ ...cur, [k]: v }));
  const num = (k: "autoAnswerAfterMinutes" | "approveDelayMinutes" | "maxEpisodesPerDay", min: number, max: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = Math.round(Number(e.target.value));
    if (Number.isFinite(n)) set(k, Math.min(max, Math.max(min, n)));
  };
  const save = () => {
    const patch: Record<string, unknown> = {};
    for (const k of Object.keys(s) as Array<keyof AutopilotSettings>) if (JSON.stringify(s[k]) !== JSON.stringify(saved[k])) patch[k] = s[k];
    m.mutate({ ...patch, ...(optInTurnedOn ? { acknowledgedStructureAutoWarning: ack } : {}) });
  };

  return (
    <Card title="완전 자율 설정" actions={editable ? <StateBadge state="active" /> : <StateBadge state="off">완전 자율일 때 적용</StateBadge>}>
      <fieldset disabled={!editable} className="m-0 flex flex-col gap-3 border-0 p-0">
        {!editable && <p className="m-0 text-[13px] text-muted">자율성 수준을 ‘완전 자율’로 바꾸면 아래 설정대로 진행합니다.</p>}
        <div className="flex flex-col gap-1.5">
          <h3 className="m-0 text-[13px] font-semibold">에이전트가 자동으로 진행</h3>
          {AUTO_GROUP.map((g) => (
            <Checkbox key={g.key} label={g.label} hint={g.hint} checked={s[g.key]} onChange={(e) => set(g.key, e.target.checked)} />
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          <h3 className="m-0 text-[13px] font-semibold">컨셉 확정·구성·결말도 자동 승인</h3>
          <Callout tone="warn">
            켜면 컨셉 확정(첫 컨셉, 안전·유사성 신호 0건일 때만)과 전체 구성(1~4부·결말) 승인도 에이전트가 합니다. 이야기의 큰 방향이 사람 검토 없이 정해질 수
            있습니다. 승인된 결말이 바뀐 재승인은 이 설정과 관계없이 항상 직접 합니다.
          </Callout>
          <Checkbox label="컨셉 확정 자동 승인" checked={s.autoConfirmConcept} onChange={(e) => set("autoConfirmConcept", e.target.checked)} />
          <Checkbox label="전체 구성 자동 승인" checked={s.autoApproveStructure} onChange={(e) => set("autoApproveStructure", e.target.checked)} />
          {optInTurnedOn && <Checkbox label="위 경고를 확인했습니다" checked={ack} onChange={(e) => setAck(e.target.checked)} />}
        </div>
        <div className="flex flex-col gap-1.5">
          <h3 className="m-0 text-[13px] font-semibold">질문</h3>
          <Checkbox label="질문 자동 응답" hint="민감도 ‘보통’인 선택형 질문에 추천안으로 답합니다(기록: 자동 응답)." checked={s.autoAnswerQuestions} onChange={(e) => set("autoAnswerQuestions", e.target.checked)} />
          <Field label="자동 응답까지 기다리는 시간(분)" className="w-56">
            <Input type="number" min={5} max={1440} value={s.autoAnswerAfterMinutes} onChange={num("autoAnswerAfterMinutes", 5, 1440)} />
          </Field>
          <Checkbox label="중요 질문(플롯 목표·중요 떡밥 기한)도 자동 응답" checked={s.autoAnswerImportant} onChange={(e) => set("autoAnswerImportant", e.target.checked)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <h3 className="m-0 text-[13px] font-semibold">안전·속도</h3>
          <Field label="자동 승인 전 대기 시간(분)" className="w-56" hint="이 시간 동안 직접 승인·반려할 수 있습니다. 0이면 바로 승인합니다.">
            <Input type="number" min={0} max={1440} value={s.approveDelayMinutes} onChange={num("approveDelayMinutes", 0, 1440)} />
          </Field>
          <Checkbox label="심각도 중간 연속성 이슈가 열려 있어도 사람에게 넘김" checked={s.holdOnMediumIssues} onChange={(e) => set("holdOnMediumIssues", e.target.checked)} />
          <Field label="하루 새 화 착수 상한" className="w-56">
            <Input type="number" min={1} max={20} value={s.maxEpisodesPerDay} onChange={num("maxEpisodesPerDay", 1, 20)} />
          </Field>
          <Field label="하루 비용 상한(USD, 비우면 없음)" className="w-56">
            <Input
              type="number"
              min={0.01}
              step={0.5}
              value={s.dailyBudgetUsd ?? ""}
              onChange={(e) => set("dailyBudgetUsd", e.target.value === "" ? null : Math.max(0.01, Number(e.target.value)))}
            />
          </Field>
          <Checkbox label="월 예산 경고 비율에 닿으면 자율 진행 멈춤" checked={s.haltOnBudgetWarning} onChange={(e) => set("haltOnBudgetWarning", e.target.checked)} />
          <Field label="예약 공개 시각(작품 시간대)" className="w-56">
            <Input type="time" value={s.publishTimeLocal} onChange={(e) => e.target.value && set("publishTimeLocal", e.target.value.slice(0, 5))} />
          </Field>
        </div>
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
        {m.isSuccess && !dirty && <Callout tone="ok">완전 자율 설정을 저장했습니다.</Callout>}
        <div className="flex justify-end">
          <Button variant="primary" disabled={!dirty || (optInTurnedOn && !ack)} loading={m.isPending} onClick={save}>
            설정 저장
          </Button>
        </div>
      </fieldset>
    </Card>
  );
}
