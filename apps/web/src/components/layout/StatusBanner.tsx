import { labelKo } from "@ncs/shared";
import { useHealth } from "../../api/health.js";
import { errorMessage } from "../../api/client.js";
import { Callout } from "../ui/Callout.js";
import { Button, ButtonLink } from "../ui/Button.js";
import { useHealthChecks } from "../../features/settings/api.js";

/**
 * Global outage banner (08 §9.1 "장애 배너"): shown at the top of every screen only when something is wrong.
 * MVP-α source: `GET /api/health`. Later agents extend it with channel / budget / pause state
 * (health_check_results, novels.pause_reason, budget_policies.status) once those APIs exist.
 */
export function StatusBanner() {
  const health = useHealth();
  const checks = useHealthChecks();
  // latest install-level llm_key result: the agents need a working connection of the provider their roles use
  const llm = checks.data?.items
    .filter((r) => r.kind === "llm_key" && r.novelId === null)
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
  const llmBanner =
    llm && llm.status === "fail" ? (
      <Callout
        tone="danger"
        title="AI 공급자 연결을 확인하세요"
        actions={
          <ButtonLink size="sm" variant="primary" to="/settings">
            AI 계정 연결
          </ButtonLink>
        }
      >
        <span className="text-muted">{llm.message} 연결이 될 때까지 이 공급자를 쓰는 컨셉 대화·집필 에이전트가 동작하지 않습니다.</span>
      </Callout>
    ) : null;

  if (health.isError) {
    return (
      <Callout
        tone="danger"
        title="서버 상태를 확인할 수 없습니다"
        actions={
          <Button size="sm" onClick={() => void health.refetch()} loading={health.isFetching}>
            다시 확인
          </Button>
        }
      >
        <span className="text-muted">{errorMessage(health.error)} 화면의 데이터가 최신이 아닐 수 있습니다.</span>
      </Callout>
    );
  }
  const data = health.data;
  if (!data || (data.status === "ok" && data.database === "pass")) return llmBanner;

  return (
    <Callout tone={data.database === "fail" ? "danger" : "warn"} title="시스템 상태 불안정">
      <span className="text-muted">
        데이터베이스 점검: {labelKo("health_status", data.database)} · 서버 v{data.version}
      </span>
    </Callout>
  );
}
