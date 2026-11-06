import { useEffect, useState } from "react";
import { formatUsd, labelKo, parseAutopilotSettings, type AutonomyLevel, type NovelDto, type PublishPolicy } from "@ncs/shared";
import { api, errorMessage } from "../../../api/client.js";
import { Badge, Button, Callout, Card, Checkbox, ChoiceGroup, ConfirmDialog, Field, Select, type ChoiceOption } from "../../../components/ui/index.js";
import { useChangeAutonomy } from "../../novels/api.js";
import { ALWAYS_HUMAN, AUTO_ITEMS, AUTO_PUBLISH_ITEM, bannerTitle, PHASE_LABEL, STRUCTURE_OPT_IN_LABEL } from "../../autopilot/labels.js";
import { useAutopilot } from "../../autopilot/api.js";
import { StateBadge, StateBadges } from "./status-badges.js";
import { usePendingApprovals } from "../../inbox/api.js";

/** per level: what the agents do on their own vs. what waits for you (shown under each option) */
export const LEVEL_SCOPE: Record<Exclude<AutonomyLevel, "co_writing">, { auto: string; human: string }> = {
  episode_approval: { auto: "초안 작성·검토·수정", human: "기획서, 플롯 계획, 매 화 승인" },
  arc_approval: { auto: "초안 작성·검토·수정, 플롯 안의 화들", human: "기획서, 플롯 계획, 플롯 단위 묶음 승인" },
  full_auto: { auto: "화·플롯 계획·세계관·캐스트·기획서 승인, 선택형 질문 응답", human: "항상 사람 승인 항목만(아래)" },
};

function Scope({ level }: { level: keyof typeof LEVEL_SCOPE }) {
  const sc = LEVEL_SCOPE[level];
  return (
    <span className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-[12px]">
      <span className="font-semibold text-ok">자동</span>
      <span>{sc.auto}</span>
      <span className="font-semibold text-accent">직접</span>
      <span>{sc.human}</span>
    </span>
  );
}

const DESCRIPTIONS: Record<keyof typeof LEVEL_SCOPE, string> = {
  episode_approval: "기획서·플롯 계획·매 화를 직접 확인하고 승인합니다. 신규 사실과 떡밥 회수는 화 승인 때 확정됩니다.",
  arc_approval: "화는 플롯 단위로 묶어 승인합니다. 비축분이 차면 그때까지 쓴 화를 묶어 먼저 승인 요청하고, 그 전의 사실은 ‘미확정’으로 씁니다. 플롯 계획은 직접 승인합니다.",
  full_auto: "사람 확인이 필요한 곳에서는 그 갈래만 멈추고 인박스·메신저로 알립니다. 켤 때 정책·저작권 경고 확인이 필요합니다.",
};

export function autonomyOptions(current: AutonomyLevel): ChoiceOption<AutonomyLevel>[] {
  const levels = ["episode_approval", "arc_approval", "full_auto"] as const;
  return [
    ...levels.map((v) => ({
      value: v,
      label: labelKo("autonomy_level", v),
      adornment: <StateBadges states={[current === v && "active", v === "episode_approval" && "default", v === "full_auto" && "caution"]} />,
      description: (
        <>
          {DESCRIPTIONS[v]}
          <Scope level={v} />
        </>
      ),
    })),
    { value: "co_writing", label: labelKo("autonomy_level", "co_writing"), adornment: <StateBadge state="planned" />, description: "작가와 에이전트가 한 화를 함께 쓰는 방식입니다. 다음 버전에서 제공합니다.", disabled: true },
  ];
}

const PUBLISH_OPTIONS: Array<{ value: PublishPolicy; disabled?: boolean; suffix?: string }> = [
  { value: "manual" },
  { value: "scheduled" },
  { value: "batch_question", disabled: true, suffix: " (예정)" },
];

/** header badge: the applied level, and for full_auto the live autopilot state */
function LiveStatus({ novel }: { novel: NovelDto }) {
  const q = useAutopilot(novel.id, { enabled: novel.autonomyLevel === "full_auto" });
  const label = labelKo("autonomy_level", novel.autonomyLevel);
  if (novel.autonomyLevel !== "full_auto") return <StateBadge state="active">사용 중 · {label}</StateBadge>;
  const v = q.data;
  if (!v) return <StateBadge state="active">사용 중 · {label}</StateBadge>;
  const stopped = !!v.halted || v.phase === "paused" || v.phase === "throttled";
  return (
    <Badge tone={stopped ? "warn" : "violet"} glyph title={bannerTitle(v)}>
      {label} · {PHASE_LABEL[v.phase] ?? v.phase}
      {!stopped && v.waitingHuman.length > 0 ? ` · 확인 대기 ${v.waitingHuman.length}` : ""}
    </Badge>
  );
}

/**
 * 자율성 수준 (FR-UI-09, INV-NOV-02/04). Change is recorded as `novel.autonomy_changed` (+ `autopilot.enabled/disabled`).
 * 기존 approved 사실 변경·리트콘·결말 방향 변경·예산 재개·떡밥 폐기는 모든 수준에서 사람 승인입니다.
 */
export function AutonomySection({ novel }: { novel: NovelDto }) {
  const [level, setLevel] = useState<AutonomyLevel>(novel.autonomyLevel);
  const [policy, setPolicy] = useState<PublishPolicy>(novel.publishPolicy === "batch_question" ? "manual" : novel.publishPolicy);
  const [ack, setAck] = useState(false);
  const [ackItems, setAckItems] = useState(false);
  const [optIn, setOptIn] = useState(false);
  const [ackOptIn, setAckOptIn] = useState(false);
  const [conceptAuto, setConceptAuto] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [conceptError, setConceptError] = useState<string | null>(null);
  const m = useChangeAutonomy(novel.id);
  useEffect(() => {
    setLevel(novel.autonomyLevel);
    setPolicy(novel.publishPolicy === "batch_question" ? "manual" : novel.publishPolicy);
  }, [novel.autonomyLevel, novel.publishPolicy]);

  const turningOn = level === "full_auto" && novel.autonomyLevel !== "full_auto";
  const dirty = level !== novel.autonomyLevel || (level === "full_auto" && policy !== novel.publishPolicy);
  const needsAck = level === "full_auto";
  const settings = parseAutopilotSettings(novel.autopilotSettings);
  const approvals = usePendingApprovals(novel.id);
  const pendingApprovals = approvals.data?.items.length ?? 0;
  const canSubmit = !needsAck || (ack && (!turningOn || (ackItems && (!optIn || ackOptIn))));

  const submit = () =>
    m.mutate(
      {
        autonomyLevel: level,
        publishPolicy: level === "full_auto" ? policy : undefined,
        acknowledgedFullAutoWarning: needsAck ? ack : false,
        acknowledgedAutoItems: turningOn ? ackItems : false,
        acknowledgedStructureAutoWarning: turningOn && optIn ? ackOptIn : false,
        // the opt-ins are sent explicitly when turning on (never carried over from an earlier full_auto period)
        ...(turningOn ? { autopilot: { autoConfirmConcept: optIn, autoApproveStructure: optIn } } : {}),
      },
      {
        onSuccess: async () => {
          setConfirm(false);
          if (!(turningOn && conceptAuto)) return;
          // 진행 중인 컨셉 대화에 자동 승인도 켜기 (concept chat auto-approve, user action)
          try {
            const view = await api.get<{ session?: { id: string; status: string } | null; id?: string }>(`/novels/${novel.id}/concept/session`);
            const sid = view.session?.id ?? view.id;
            if (sid) await api.post(`/novels/${novel.id}/concept/sessions/${sid}/auto-approve`, { enabled: true });
          } catch (err) {
            setConceptError(`컨셉 대화 자동 승인을 켜지 못했습니다: ${errorMessage(err)}`);
          }
        },
        onSettled: () => setConfirm(false),
      },
    );

  return (
    <Card title="자율성 수준" actions={<LiveStatus novel={novel} />}>
      <div className="flex flex-col gap-3">
        <p className="m-0 text-[13px] text-muted">
          사람 승인 게이트의 위치를 정합니다. 질문 민감도와는 별개이며, 변경 이력은 감사 로그에 남습니다.
        </p>
        <ChoiceGroup legend="자율성 수준" legendHidden name={`autonomy-${novel.id}`} value={level} onChange={setLevel} options={autonomyOptions(novel.autonomyLevel)} />
        {level === "full_auto" && (
          <>
            <div className="rounded-[8px] border border-border p-3 text-[13px]">
              <p className="m-0 mb-1 font-semibold">에이전트가 자동으로 진행하는 항목</p>
              <ul className="m-0 list-disc pl-5">
                {AUTO_ITEMS.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <p className="m-0 mt-2 text-muted">
                세부 항목과 질문 대기 시간·하루 상한은 아래 ‘완전 자율 설정’에서 바꿀 수 있습니다{novel.autonomyLevel === "full_auto" && settings.autoApproveStructure ? " (구성 자동 승인 켜짐)" : ""}.
              </p>
            </div>
            <Field label="공개 처리 방식">
              <Select value={policy} onChange={(e) => setPolicy(e.target.value as PublishPolicy)}>
                {PUBLISH_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value} disabled={p.disabled}>
                    {labelKo("publish_policy", p.value)}
                    {p.suffix ?? ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Callout tone="warn" title="완전 자율 경고">
              에이전트가 만든 원고가 사람 검토 없이 확정·공개될 수 있습니다. 연재 플랫폼의 AI 생성물 정책과 저작권 책임은 작가에게 있습니다.
            </Callout>
            <Checkbox label="위 정책·저작권 경고를 확인했습니다" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            {turningOn && (
              <>
                <Checkbox label="위 항목을 에이전트가 자동으로 진행하는 것을 확인했습니다" checked={ackItems} onChange={(e) => setAckItems(e.target.checked)} />
                <Checkbox
                  label={STRUCTURE_OPT_IN_LABEL}
                  hint="첫 컨셉 확정과 전체 구성(1~4부·결말) 승인도 에이전트가 합니다. 승인된 결말이 바뀐 재승인은 항상 직접 합니다."
                  checked={optIn}
                  onChange={(e) => setOptIn(e.target.checked)}
                />
                {optIn && (
                  <>
                    <Callout tone="warn">이야기의 큰 방향(컨셉·전체 구성·결말)이 사람 검토 없이 정해질 수 있습니다.</Callout>
                    <Checkbox label="컨셉 확정·구성·결말 자동 승인 경고를 확인했습니다" checked={ackOptIn} onChange={(e) => setAckOptIn(e.target.checked)} />
                  </>
                )}
                {novel.status === "concept" && (
                  <Checkbox label="진행 중인 컨셉 대화에 자동 승인도 켜기" checked={conceptAuto} onChange={(e) => setConceptAuto(e.target.checked)} />
                )}
              </>
            )}
          </>
        )}
        <p className="m-0 text-xs text-faint">모든 수준에서 항상 사람 승인: {ALWAYS_HUMAN.join(" · ")}.</p>
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
        {conceptError && <Callout tone="warn">{conceptError}</Callout>}
        {m.isSuccess && !dirty && <Callout tone="ok">자율성 수준을 바꿨습니다.</Callout>}
        <div className="flex justify-end">
          <Button variant="primary" disabled={!dirty || !canSubmit} onClick={() => setConfirm(true)}>
            자율성 수준 저장
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        title={`자율성 수준을 ‘${labelKo("autonomy_level", level)}’(으)로 바꿀까요?`}
        description={
          turningOn
            ? "저장하면 바로 자동 진행을 시작합니다. 언제든 ‘자율 진행 멈춤’으로 멈출 수 있습니다."
            : novel.autonomyLevel === "full_auto" && level !== "full_auto"
              ? "자동 승인을 바로 멈춥니다. 대기 중인 승인은 그대로 남아 직접 결정합니다."
              : "다음 작업부터 적용됩니다."
        }
        confirmLabel={turningOn ? "완전 자율 켜기" : novel.autonomyLevel === "full_auto" && level !== "full_auto" ? "자동 승인 끄기" : "바꾸기"}
        busy={m.isPending}
        onCancel={() => setConfirm(false)}
        onConfirm={submit}
      >
        {turningOn && (
          <div className="flex flex-col gap-2 text-[13px]">
            <div>
              <p className="m-0 font-semibold">자동으로 진행</p>
              <ul className="m-0 list-disc pl-5">
                {[...AUTO_ITEMS, ...(policy === "scheduled" ? [AUTO_PUBLISH_ITEM] : []), ...(optIn ? ["첫 컨셉 확정과 전체 구성(1~4부·결말) 승인"] : [])].map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="m-0 font-semibold">속도·비용 한도(‘완전 자율 설정’에서 변경)</p>
              <ul className="m-0 list-disc pl-5">
                <li>하루 새 화 착수 최대 {settings.maxEpisodesPerDay}화</li>
                <li>
                  하루 비용 상한 {settings.dailyBudgetUsd === null ? "없음 — 월 예산을 정하지 않았다면 비용 제한은 하루 착수 화 수뿐입니다" : formatUsd(Math.round(settings.dailyBudgetUsd * 1_000_000))}
                </li>
                <li>월 예산 경고 시 {settings.haltOnBudgetWarning ? "자율 진행 멈춤" : "계속 진행"}</li>
              </ul>
            </div>
            {pendingApprovals > 0 && (
              <Callout tone="warn">지금 승인 대기 중인 요청 {pendingApprovals}건도 조건을 만족하면 켜는 즉시 자동 승인됩니다. 직접 결정하려면 먼저 처리하세요.</Callout>
            )}
            <p className="m-0 text-muted">
              정책·저작권: 에이전트가 만든 원고가 사람 검토 없이 확정{policy === "scheduled" ? "·공개" : ""}될 수 있으며, 연재 플랫폼의 AI 생성물 정책과 저작권 책임은 작가에게 있습니다(확인함).
            </p>
            <div>
              <p className="m-0 font-semibold">항상 사람이 결정</p>
              <ul className="m-0 list-disc pl-5">
                {ALWAYS_HUMAN.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </ConfirmDialog>
    </Card>
  );
}
