import { useState } from "react";
import { errorMessage } from "../../api/client.js";
import { Button, Callout, Checkbox, ConfirmDialog } from "../../components/ui/index.js";
import { useHaltAutopilot, useResumeAutopilot } from "./api.js";

/** 설계 추가 0014: 킬 스위치 "자율 진행 멈춤" / "자율 진행 재개" (shown only for full_auto novels) */
export function AutopilotHaltButton({ novelId, halted, size = "md" }: { novelId: string; halted: boolean; size?: "md" | "sm" }) {
  const [open, setOpen] = useState(false);
  const [alsoPause, setAlsoPause] = useState(false);
  const halt = useHaltAutopilot(novelId);
  const resume = useResumeAutopilot(novelId);
  const m = halted ? resume : halt;
  return (
    <>
      <Button size={size} variant={halted ? "primary" : "danger"} onClick={() => setOpen(true)}>
        {halted ? "자율 진행 재개" : "자율 진행 멈춤"}
      </Button>
      <ConfirmDialog
        open={open}
        title={halted ? "완전 자율을 다시 진행할까요?" : "완전 자율 진행을 멈출까요?"}
        description={
          halted
            ? "자동 승인·질문 자동 응답·준비 단계(세계관·캐릭터·목표·구성) 자동 진행이 다시 시작됩니다."
            : "자동 승인·질문 자동 응답·준비 단계(세계관·캐릭터·목표·구성) 자동 진행과 새 화 착수가 바로 멈춥니다. 자동 승인을 기다리던 요청은 메신저로도 보냅니다. 진행 중인 작업은 다음 승인 지점까지만 갑니다. ‘작품 일시정지’는 에이전트 작업 자체를 멈추고, 이 버튼은 자동 결정만 멈춥니다(직접 승인하면 작업은 이어집니다)."
        }
        confirmLabel={halted ? "자율 진행 재개" : "자율 진행 멈춤"}
        danger={!halted}
        busy={m.isPending}
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          const done = { onSuccess: () => setOpen(false) };
          if (halted) resume.mutate(undefined, done);
          else halt.mutate({ alsoPauseTasks: alsoPause }, done);
        }}
      >
        {!halted && <Checkbox label="진행 중인 작업도 즉시 멈춤(작품 일시정지)" checked={alsoPause} onChange={(e) => setAlsoPause(e.target.checked)} />}
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
      </ConfirmDialog>
    </>
  );
}
