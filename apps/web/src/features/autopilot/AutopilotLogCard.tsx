import { Badge, Card, EmptyState, formatDateTime } from "../../components/ui/index.js";
import { useAutopilot } from "./api.js";
import { autopilotActionLabel, autopilotEventText } from "./labels.js";

const TONE: Record<string, "violet" | "warn" | "ok" | "neutral" | "info"> = {
  "autopilot.approval_decided": "violet",
  "autopilot.question_answered": "violet",
  "autopilot.gate_hit": "warn",
  "autopilot.halted": "warn",
  "autopilot.throttled": "info",
  "autopilot.completed": "ok",
};

/** 설계 추가 0014: "자동 진행 기록" — autopilot.* activity (자동 승인 / 자동 응답 / 사람 확인 필요 …) */
export function AutopilotLogCard({ novelId, autonomyLevel, timezone }: { novelId: string; autonomyLevel: string; timezone?: string }) {
  const q = useAutopilot(novelId, { enabled: autonomyLevel === "full_auto" });
  if (autonomyLevel !== "full_auto") return null;
  const items = q.data?.recent ?? [];
  return (
    <Card title="자동 진행 기록">
      {items.length === 0 ? (
        <EmptyState title="아직 자동 진행 기록이 없습니다" />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
          {items.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline gap-2">
              <span className="text-xs text-faint">{formatDateTime(e.occurredAt, timezone)}</span>
              <Badge tone={TONE[e.action] ?? "neutral"}>{autopilotActionLabel(e.action)}</Badge>
              <span className="min-w-0">{autopilotEventText(e)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
