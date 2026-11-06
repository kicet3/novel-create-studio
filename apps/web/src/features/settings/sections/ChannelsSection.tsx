import { useState } from "react";
import { labelKo, type MessagingBindingTokenDto } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import {
  Button,
  ButtonLink,
  Callout,
  Card,
  ConfirmDialog,
  Field,
  formatDateTime,
  List,
  ListItem,
  NotReady,
  QueryView,
  Select,
  StatusBadge,
  isUnavailable,
} from "../../../components/ui/index.js";
import { useBots, useChannels, useIssueBinding, useUnbindChannel } from "../api.js";

/**
 * 채널 연결 (05 §9, FR-MSG-*): Telegram / Discord 1:1 binding via a one-time code (`/start <token>`; Telegram deep link,
 * Discord DM to the bot),
 * unbind, web inbox always on. Messenger gets summaries only; full text needs the authenticated web link.
 */
export function ChannelsSection({ novelId, timezone }: { novelId: string; timezone?: string }) {
  const channels = useChannels(novelId);
  const bots = useBots();
  const issue = useIssueBinding(novelId);
  const unbind = useUnbindChannel(novelId);
  const [botId, setBotId] = useState<string>("");
  const [token, setToken] = useState<(MessagingBindingTokenDto & { botId: string }) | null>(null);
  const [unbindId, setUnbindId] = useState<string | null>(null);
  const botList = bots.data?.items ?? [];
  const selectedBot = botId || botList[0]?.id || "";
  const selected = botList.find((b) => b.id === selectedBot);
  const tokenBot = token ? botList.find((b) => b.id === token.botId) : undefined;

  return (
    <Card title="채널 연결" actions={<span className="text-xs text-muted">우선순위 순</span>}>
      <QueryView query={channels} compact notReadyDescription="메신저 모듈이 준비되면 Telegram·Discord를 연결할 수 있습니다.">
        {(d) => (
          <List>
            {d.items.map((c, i) => (
              <ListItem key={c.id}>
                <span className="tabular w-4 text-muted">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <b>{labelKo("channel_kind", c.kind)}</b> <span className="text-muted">{c.label}</span>
                  <div className="text-xs text-muted">
                    {c.kind === "web"
                      ? "항상 사용 · 메신저 장애 시에도 모든 질문에 답할 수 있습니다."
                      : c.boundAt
                        ? `연결 ${formatDateTime(c.boundAt, timezone)}${c.lastHealthAt ? ` · 점검 ${formatDateTime(c.lastHealthAt, timezone)}` : ""}`
                        : (c.disconnectedReason ?? "연결 대기")}
                  </div>
                </span>
                <StatusBadge enum="channel_status" value={c.status} />
                {c.kind !== "web" && c.status !== "revoked" && (
                  <Button size="sm" variant="danger" onClick={() => setUnbindId(c.id)}>
                    연결 해제
                  </Button>
                )}
              </ListItem>
            ))}
          </List>
        )}
      </QueryView>

      <div className="mt-3 border-t border-border pt-3">
        <h3 className="mb-2 text-[13px] font-bold">메신저 연결 (Telegram · Discord)</h3>
        {bots.isError && isUnavailable(bots.error) ? (
          <NotReady compact title="봇 관리 준비 중" />
        ) : botList.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">
            등록된 봇이 없습니다. 먼저 설치 설정에서 Telegram 또는 Discord 봇 토큰을 등록하세요.{" "}
            <ButtonLink size="sm" to="/settings">
              설치 설정
            </ButtonLink>
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="봇" className="min-w-48">
                <Select value={selectedBot} onChange={(e) => setBotId(e.target.value)}>
                  {botList.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label} · {labelKo("channel_kind", b.kind)} ({labelKo("channel_status", b.status)})
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                variant="primary"
                loading={issue.isPending}
                disabled={!selected || (selected.kind !== "telegram" && selected.kind !== "discord")}
                onClick={() =>
                  selected &&
                  (selected.kind === "telegram" || selected.kind === "discord") &&
                  issue.mutate({ id: selected.id, kind: selected.kind }, { onSuccess: (r) => setToken({ ...r, botId: selected.id }) })
                }
              >
                {selected?.kind === "discord" ? "일회용 연결 코드 만들기" : "일회용 연결 링크 만들기"}
              </Button>
            </div>
            {issue.error && <Callout tone="danger">{errorMessage(issue.error)}</Callout>}
            {token && tokenBot?.kind === "discord" && (
              <Callout tone="accent" title="Discord에서 봇에게 DM으로 아래 문장을 보내세요">
                <p className="m-0">
                  <code className="break-all font-mono">/start {token.token}</code>
                </p>
                <p className="m-0 mt-1 text-xs text-muted">
                  {token.deepLink ? (
                    <>
                      <a href={token.deepLink} target="_blank" rel="noreferrer">
                        봇 프로필 열기
                      </a>{" "}
                      → ‘메시지 보내기’.{" "}
                    </>
                  ) : null}
                  봇이 내 서버에 초대돼 있어야 DM을 열 수 있습니다. 슬래시 명령 창이 뜨면 <code className="font-mono">!start {token.token}</code> 로 보내도 됩니다.
                </p>
                <p className="m-0 mt-1 text-xs text-muted">
                  1회용 · {formatDateTime(token.expiresAt, timezone)}에 만료됩니다. 연결한 계정의 메시지만 받습니다. 연결되면 위 목록에 표시됩니다.
                </p>
                <div className="mt-2">
                  <Button size="sm" onClick={() => void channels.refetch()}>
                    연결 확인
                  </Button>
                </div>
              </Callout>
            )}
            {token && tokenBot?.kind !== "discord" && (
              <Callout tone="accent" title="Telegram에서 아래 링크를 열고 시작(/start)을 누르세요">
                {token.deepLink ? (
                  <a href={token.deepLink} target="_blank" rel="noreferrer" className="break-all font-mono text-[12.5px]">
                    {token.deepLink}
                  </a>
                ) : (
                  <p className="m-0">
                    봇과의 1:1 대화에서 <code className="font-mono">/start {token.token}</code> 를 보내세요.
                  </p>
                )}
                <p className="m-0 mt-1 text-xs text-muted">
                  1회용 · {formatDateTime(token.expiresAt, timezone)}에 만료됩니다. 연결되면 위 목록에 표시됩니다.
                </p>
                <div className="mt-2">
                  <Button size="sm" onClick={() => void channels.refetch()}>
                    연결 확인
                  </Button>
                </div>
              </Callout>
            )}
          </div>
        )}
        <p className="m-0 mt-2 text-xs text-faint">
          메신저에는 요약만 보내고 전문은 인증이 필요한 웹 링크로 보냅니다. 컴퓨터가 절전·종료 중이면 질문 발송·수신이 멈추고, 복귀하면 자동으로 다시 시작합니다.
        </p>
      </div>
      <ConfirmDialog
        open={unbindId !== null}
        title="채널 연결을 해제할까요?"
        description="해제하면 이 채널로 질문을 보내지 않습니다. 웹 인박스는 계속 사용할 수 있습니다."
        danger
        confirmLabel="연결 해제"
        busy={unbind.isPending}
        onCancel={() => setUnbindId(null)}
        onConfirm={() => unbindId && unbind.mutate(unbindId, { onSettled: () => setUnbindId(null) })}
      >
        {unbind.error && <Callout tone="danger">{errorMessage(unbind.error)}</Callout>}
      </ConfirmDialog>
    </Card>
  );
}
