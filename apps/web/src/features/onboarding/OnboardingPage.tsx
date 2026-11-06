import { useEffect, useRef, useState } from "react";
import { PageHeader } from "../../components/layout/PageHeader.js";
import { Button, Callout, Card, Checkbox } from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { CreateNovelForm } from "../novels/CreateNovelForm.js";
import { HealthChecksSection } from "../settings/sections/HealthChecksSection.js";
import { BotsCard, SystemInfoCard } from "../settings/sections/InstallSections.js";
import { ProviderConnectionsCard } from "../settings/sections/ProviderConnectionsCard.js";

const STEPS = [
  { key: "env", title: "환경 점검", sub: "AI 계정 연결 · 외부 전송 안내" },
  { key: "bot", title: "메신저 봇", sub: "Telegram · Discord (선택)" },
  { key: "novel", title: "작품 만들기", sub: "컨셉 대화로 시작" },
] as const;

const ACK_KEY = "ncs.onboarding.dataScopeAck";

/**
 * `/onboarding` — 첫 실행 안내 (FR-NOV-01, NFR-SEC-04, NFR-REL-06).
 * 작품별 목표·자율성·채널 연결은 컨셉 승인 후 작품 홈의 ‘설정 마무리’에서 합니다(11 §5.8 N2→N3).
 */
export function OnboardingPage() {
  const [step, setStep] = useState(0);
  const [ack, setAck] = useState(() => {
    try {
      return localStorage.getItem(ACK_KEY) === "1";
    } catch {
      return false;
    }
  });
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    try {
      localStorage.setItem(ACK_KEY, ack ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }, [ack]);
  const go = (i: number) => {
    setStep(i);
    requestAnimationFrame(() => headingRef.current?.focus());
  };
  const current = STEPS[step] ?? STEPS[0];

  return (
    <>
      <PageHeader title="새 작품 만들기" subtitle="처음 설정 · 언제든 설치 설정에서 바꿀 수 있습니다" />
      <nav aria-label="설정 단계" className="mb-3">
        <ol className="m-0 grid list-none grid-cols-1 gap-2 p-0 min-[521px]:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => go(i)}
                aria-current={i === step ? "step" : undefined}
                className={cx(
                  "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-[13px]",
                  i === step ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-surface-2",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cx(
                    "grid size-6 flex-none place-items-center rounded-full text-xs font-bold",
                    i < step ? "bg-ok text-white" : i === step ? "bg-accent text-accent-text" : "bg-surface-2 text-muted",
                  )}
                >
                  {i < step ? "✓" : i + 1}
                </span>
                <span>
                  <b className="block">{s.title}</b>
                  <span className="text-xs text-muted">{s.sub}</span>
                </span>
                {i < step && <span className="sr-only">(완료)</span>}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <h2 ref={headingRef} tabIndex={-1} className="mb-2 text-[15px] font-bold focus:outline-none">
        {step + 1}단계 · {current.title}
      </h2>

      {step === 0 && (
        <div className="flex flex-col gap-3">
          <ProviderConnectionsCard />
          <div className="grid grid-cols-1 gap-3 min-[861px]:grid-cols-2">
            <SystemInfoCard />
            <HealthChecksSection />
          </div>
          <Card title="외부로 보내는 데이터">
            <ul className="m-0 mb-2 pl-4 text-[13px]">
              <li>집필·검사에 필요한 원고 발췌, 기획서, 온톨로지 사실을 LLM 공급자로 보냅니다.</li>
              <li>메신저에는 요약만 보내고, 전문은 인증이 필요한 웹 링크로 보냅니다.</li>
              <li>이미 보낸 데이터는 공급자의 보존 정책을 따릅니다.</li>
              <li>컴퓨터가 절전·종료 중이면 작업과 질문 발송·수신이 멈추고, 복귀하면 자동으로 다시 시작합니다.</li>
            </ul>
            <Checkbox label="위 내용을 확인했습니다" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          </Card>
          <StepNav onNext={() => go(1)} nextDisabled={!ack} nextHint={!ack ? "외부 전송 안내를 확인해야 다음 단계로 갈 수 있습니다." : undefined} />
        </div>
      )}

      {step === 1 && (
        <div className="flex flex-col gap-3">
          <Callout tone="info">
            Telegram 또는 Discord 봇을 등록해 두면 질문과 승인 요청을 휴대폰으로 받을 수 있습니다. 건너뛰어도 웹 인박스로 모든 질문에 답할 수 있습니다.
          </Callout>
          <BotsCard />
          <StepNav onPrev={() => go(0)} onNext={() => go(2)} nextLabel="다음 (건너뛰기 가능)" />
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-3">
          <Card title="작품 정보">
            <CreateNovelForm />
          </Card>
          <p className="m-0 text-xs text-faint">
            컨셉 브리프를 승인하면 작품 홈에서 연재 목표·자율성 수준·채널 연결을 마무리합니다.
          </p>
          <StepNav onPrev={() => go(1)} />
        </div>
      )}
    </>
  );
}

function StepNav({
  onPrev,
  onNext,
  nextLabel = "다음",
  nextDisabled,
  nextHint,
}: {
  onPrev?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  nextHint?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>{onPrev && <Button onClick={onPrev}>← 이전</Button>}</div>
      <div className="flex items-center gap-2">
        {nextHint && <span className="text-xs text-muted">{nextHint}</span>}
        {onNext && (
          <Button variant="primary" onClick={onNext} disabled={nextDisabled}>
            {nextLabel} →
          </Button>
        )}
      </div>
    </div>
  );
}
