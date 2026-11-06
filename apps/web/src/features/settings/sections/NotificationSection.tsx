import { useEffect, useState } from "react";
import type { NotificationPolicyDto } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import { Button, Callout, Card, Checkbox, Field, Input, QueryView } from "../../../components/ui/index.js";
import { useNotificationPolicy, useUpdateNotificationPolicy } from "../api.js";

/** 질문 수신 통제 (notification_policies): 방해금지·일일 상한·긴급 예외·질문 일시정지. */
export function NotificationSection({ novelId }: { novelId: string }) {
  const q = useNotificationPolicy(novelId);
  return (
    <Card title="질문 수신 통제">
      <QueryView query={q} compact>
        {(p) => <NotificationForm novelId={novelId} p={p} />}
      </QueryView>
    </Card>
  );
}

function NotificationForm({ novelId, p }: { novelId: string; p: NotificationPolicyDto }) {
  const [start, setStart] = useState(p.quietHoursStart?.slice(0, 5) ?? "");
  const [end, setEnd] = useState(p.quietHoursEnd?.slice(0, 5) ?? "");
  const [cap, setCap] = useState(String(p.dailyCapNonBlocking));
  const [urgent, setUrgent] = useState(p.urgentExceptionEnabled);
  const [paused, setPaused] = useState(p.questionsPaused);
  const [summary, setSummary] = useState(p.dailySummaryTime.slice(0, 5));
  const [err, setErr] = useState<string | null>(null);
  const m = useUpdateNotificationPolicy(novelId);
  useEffect(() => setPaused(p.questionsPaused), [p.questionsPaused]);

  const save = () => {
    const capN = Number(cap);
    if (!Number.isInteger(capN) || capN < 0) return setErr("일일 질문 상한은 0 이상의 정수여야 합니다.");
    if ((start === "") !== (end === "")) return setErr("방해금지 시작·끝을 모두 입력하거나 모두 비우세요.");
    setErr(null);
    m.mutate({
      quietHoursStart: start || null,
      quietHoursEnd: end || null,
      dailyCapNonBlocking: capN,
      urgentExceptionEnabled: urgent,
      questionsPaused: paused,
      dailySummaryTime: summary,
    });
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 items-start gap-3">
        <Field label="방해금지 시작">
          <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="방해금지 끝">
          <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <Field label="일일 질문 상한(비차단형)">
          <Input inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} />
        </Field>
        <Field label="일일 요약 시각">
          <Input type="time" value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
      </div>
      <Checkbox label="긴급 예외" hint="보안 이벤트·예산 하드 한도는 방해금지 중에도 보냅니다." checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
      <Checkbox label="질문 일시정지" hint="비차단형 질문 발송을 멈춥니다. 차단형 질문은 인박스에 계속 쌓입니다." checked={paused} onChange={(e) => setPaused(e.target.checked)} />
      {(err || m.error) && <Callout tone="danger">{err ?? errorMessage(m.error)}</Callout>}
      {m.isSuccess && <Callout tone="ok">저장했습니다.</Callout>}
      <div className="flex justify-end">
        <Button variant="primary" onClick={save} loading={m.isPending}>
          저장
        </Button>
      </div>
    </div>
  );
}
