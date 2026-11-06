import { Link } from "react-router";
import { formatDateTime } from "../../components/ui/index.js";
import { Callout } from "../../components/ui/index.js";
import { novelPath } from "../../components/layout/nav.js";
import { useHealthChecks } from "../settings/api.js";
import { useAutopilot } from "./api.js";
import { AutopilotHaltButton } from "./AutopilotHaltButton.js";
import { bannerTitle, todayLine } from "./labels.js";

/**
 * 설계 추가 0014: "완전 자율 진행 중 · 다음: 3화 초안 작성" — waiting human gates, today's starts / cost, throttle or
 * halt reason, the kill switch. Renders nothing unless the novel is at full_auto.
 */
export function AutopilotBanner({ novelId, autonomyLevel, timezone, compact = false }: { novelId: string; autonomyLevel: string; timezone?: string; compact?: boolean }) {
  const q = useAutopilot(novelId, { enabled: autonomyLevel === "full_auto" });
  const checks = useHealthChecks();
  const v = q.data;
  if (autonomyLevel !== "full_auto" || !v || v.level !== "full_auto") return null;
  // same source as the global "AI 공급자 연결을 확인하세요" banner: the latest install-level llm_key check
  const llm = checks.data?.items.filter((r) => r.kind === "llm_key" && r.novelId === null).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
  const llmDown = !!llm && llm.status === "fail";
  const halted = !!v.halted;
  const tone = halted || v.phase === "paused" || llmDown ? "warn" : v.throttle ? "info" : "violet";
  return (
    <Callout tone={tone} title={bannerTitle(v, { llmDown })} actions={<AutopilotHaltButton novelId={novelId} halted={halted} size="sm" />}>
      <div className="flex flex-col gap-1 text-[13px]">
        <span>
          {todayLine(v)}
          {v.throttle ? ` · ${formatDateTime(v.throttle.until, timezone)}에 다시 시작` : ""}
        </span>
        {v.waitingHuman.length > 0 && (
          <span>
            사람 확인 대기 {v.waitingHuman.length}건 — 그 갈래만 멈추고 다른 작업은 계속합니다.{" "}
            <Link to={novelPath(novelId, "inbox")}>인박스 열기</Link>
            {!compact && (
              <ul className="m-0 mt-1 list-disc pl-5">
                {v.waitingHuman.slice(0, 5).map((w, i) => (
                  <li key={`${w.approvalId ?? w.kind}-${i}`}>{w.title}</li>
                ))}
              </ul>
            )}
          </span>
        )}
        {v.scheduled.length > 0 && !compact && (
          <span>
            자동 승인 예정 {v.scheduled.length}건: {v.scheduled.slice(0, 3).map((s) => `${s.title}(${formatDateTime(s.at, timezone)})`).join(", ")}
          </span>
        )}
      </div>
    </Callout>
  );
}
