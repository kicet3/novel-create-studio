import { labelKo } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import { Badge, Button, Callout, Card, formatDateTime, List, ListItem, QueryView, StatusBadge } from "../../../components/ui/index.js";
import { useHealthChecks, useRunHealthChecks } from "../api.js";

/** 연결 점검 (08 §5.6, system health checks): latest result per check + "지금 점검". */
export function HealthChecksSection({ novelId, timezone }: { novelId?: string; timezone?: string }) {
  const q = useHealthChecks(novelId);
  const run = useRunHealthChecks(novelId);
  return (
    <Card
      title="연결 점검"
      actions={
        <Button size="sm" loading={run.isPending} onClick={() => run.mutate(undefined)}>
          지금 점검
        </Button>
      }
    >
      {run.error && <Callout tone="danger" className="mb-2">{errorMessage(run.error)}</Callout>}
      <QueryView query={q} compact>
        {(d) =>
          d.items.length === 0 ? (
            <p className="m-0 text-[13px] text-muted">아직 점검 결과가 없습니다. ‘지금 점검’을 누르세요.</p>
          ) : (
            <List>
              {d.items.map((h) => (
                <ListItem key={h.id}>
                  <StatusBadge enum="health_status" value={h.status} />
                  <span className="min-w-0 flex-1">
                    <b>{labelKo("health_check_kind", h.kind)}</b>
                    {checkTarget(h.name) && <span className="text-muted"> · {checkTarget(h.name)}</span>}
                    <div className="text-xs text-muted">{h.message}</div>
                  </span>
                  <span className="text-xs text-faint">{formatDateTime(h.checkedAt, timezone)}</span>
                </ListItem>
              ))}
            </List>
          )
        }
      </QueryView>
      {q.data && q.data.checks.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          <span className="text-xs text-faint">등록된 점검:</span>
          {q.data.checks.map((c, i) => (
            <Badge key={`${c.name}-${i}`}>
              {labelKo("health_check_kind", c.kind)}
              {checkTarget(c.name) ? ` · ${checkTarget(c.name)}` : ""}
            </Badge>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Korean target of a registered check (dotted ids such as `llm.anthropic` are never shown) */
const CHECK_TARGET: Record<string, string> = {
  "llm.anthropic": "Claude API",
  "llm.claude_code": "Claude 구독",
  "llm.openai": "GPT",
  "llm.xai": "Grok",
  "llm.google": "Gemini",
  "messaging.bot_token": "Telegram 봇",
  "messaging.channel_reach": "Telegram 채널",
  "system.backups": "백업",
  ontology_integrity: "온톨로지",
};
function checkTarget(name: string | null | undefined): string {
  if (!name) return "";
  return CHECK_TARGET[name] ?? "";
}
