import { StateBadge } from "./status-badges.js";
import { useState, type FormEvent } from "react";
import { labelKo, type MessagingBotKind } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  DataTable,
  Field,
  formatDateTime,
  formatNumber,
  Input,
  KeyValueList,
  List,
  ListItem,
  QueryView,
  Select,
  StatusBadge,
} from "../../../components/ui/index.js";
import {
  useBackups,
  useBots,
  useCreateBackup,
  useDeleteSecret,
  useProviderProfiles,
  useRegisterBot,
  useSecrets,
  useSystemInfo,
  useVerifyBackup,
} from "../api.js";

/** calling providers (profiles / bindings): Claude has two lanes — Console API key and subscription CLI */
export const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Claude API (Console 키)",
  claude_code: "Claude 구독 (Claude Code CLI)",
  openai: "GPT (OpenAI)",
  xai: "Grok (xAI)",
  google: "Gemini (Google)",
};

export function SystemInfoCard() {
  const q = useSystemInfo();
  return (
    <Card title="설치 정보" actions={<span className="text-xs text-muted">
          변경은 <code>ncs config set</code> 후 재시작
        </span>}>
      <QueryView query={q} compact>
        {(i) => (
          <KeyValueList
            items={[
              { key: "v", label: "버전", value: i.version },
              { key: "mode", label: "배포 형태", value: labelKo("deployment_mode", i.deploymentMode) },
              {
                key: "dev",
                label: "실행 모드",
                value: i.devMode ? (
                  <Badge tone="warn">개발 모드 · 구독·OAuth 로그인 사용 가능</Badge>
                ) : (
                  <Badge tone="neutral">운영 모드 · API 키만 사용</Badge>
                ),
              },
              { key: "exp", label: "노출 범위", value: labelKo("exposure", i.exposure) },
              {
                key: "db",
                label: "데이터베이스",
                value:
                  i.databaseMode === "external" && i.database
                    ? [
                        labelKo("database_provider", i.database.provider),
                        i.database.host,
                        i.database.schema ? `스키마 ${i.database.schema}` : null,
                        i.database.pooler === "session" ? "Session pooler" : i.database.pooler === "direct" ? "직접 연결" : null,
                        i.database.sslMode ? `TLS ${i.database.sslMode}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : labelKo("database_mode", i.databaseMode),
              },
              {
                key: "llm",
                label: "LLM 공급자",
                value: <StateBadge state="default">새 작품 기본값: {PROVIDER_LABEL[i.llmProvider] ?? i.llmProvider}</StateBadge>,
              },
              { key: "srv", label: "서버", value: `${i.server.host}:${i.server.port}` },
              { key: "home", label: "설치 홈", value: <code className="font-mono text-xs">{i.home}</code> },
              { key: "start", label: "시작 시각", value: formatDateTime(i.startedAt) },
            ]}
          />
        )}
      </QueryView>
    </Card>
  );
}

/** Provider profiles (priced model lists per provider, versioned). Connections live in ProviderConnectionsCard. */
export function LlmCard() {
  const profiles = useProviderProfiles();
  return (
    <Card title="단가 프로필 버전 기록">
      <div className="flex flex-col gap-3">
        <QueryView query={profiles} compact>
          {(d) => (
            <DataTable
              label="공급자 프로필"
              rows={d.items}
              rowKey={(p) => p.id}
              empty="공급자 프로필이 없습니다."
              columns={[
                {
                  key: "p",
                  header: "공급자",
                  rowHeader: true,
                  cell: (p) => (
                    <div className="flex flex-col items-start gap-0.5">
                      <span className="whitespace-nowrap">{PROVIDER_LABEL[p.provider] ?? p.provider}</span>
                      {p.isActive ? <StateBadge state="active" /> : null}
                    </div>
                  ),
                },
                { key: "v", header: "버전", className: "whitespace-nowrap", cell: (p) => `v${p.versionNo}` },
                { key: "m", header: "모델", className: "min-w-48", cell: (p) => p.models.map((m) => `${m.label ?? m.id}${m.input_price_micros_per_mtok === null ? " (단가 미등록)" : ""}${m.disabled ? " (꺼짐)" : ""}`).join(", ") },
                { key: "d", header: "단가 확인", className: "whitespace-nowrap tabular-nums", cell: (p) => formatDateTime(p.verifiedAt) },
                {
                  key: "r",
                  header: "보존 정책",
                  className: "whitespace-nowrap",
                  cell: (p) =>
                    p.retentionPolicyUrl ? (
                      <a href={p.retentionPolicyUrl} target="_blank" rel="noreferrer">
                        보기
                      </a>
                    ) : (
                      "—"
                    ),
                },
              ]}
            />
          )}
        </QueryView>
        <p className="m-0 text-xs text-faint">
          모델 관리에서 바꿀 때마다 새 버전이 생기며, 지난 비용 기록은 그때 버전 단가를 그대로 씁니다. 단가는 1M 토큰 기준이며 예산 예약·정산에 쓰입니다. 단가가 없는 모델은 호출 전에 예산 확인을 요청합니다. 외부 공급자로 원고 발췌·기획서·온톨로지 사실이 전송되며, 이미 보낸 데이터는 공급자의 보존 정책을 따릅니다.
        </p>
      </div>
    </Card>
  );
}

const BOT_KIND_HINT: Record<MessagingBotKind, string> = {
  telegram: "@BotFather에서 받은 토큰. 저장 후 다시 보여 주지 않습니다.",
  discord: "Discord Developer Portal › Bot › Reset Token으로 받은 토큰. 저장 후 다시 보여 주지 않습니다.",
};

export function BotsCard() {
  const bots = useBots();
  const reg = useRegisterBot();
  const [kind, setKind] = useState<MessagingBotKind>("telegram");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    reg.mutate(
      { kind, label: label.trim(), token: token.trim() },
      {
        onSuccess: () => {
          setLabel("");
          setToken("");
        },
      },
    );
  };
  return (
    <Card title="메신저 봇">
      <QueryView query={bots} compact notReadyDescription="메신저 모듈이 준비되면 봇을 등록할 수 있습니다.">
        {(d) => (
          <div className="flex flex-col gap-3">
            {d.items.length === 0 ? (
              <p className="m-0 text-[13px] text-muted">등록된 봇이 없습니다.</p>
            ) : (
              <List>
                {d.items.map((b) => (
                  <ListItem key={b.id}>
                    <span className="min-w-0 flex-1">
                      <b>{b.label}</b> <span className="text-muted">{labelKo("channel_kind", b.kind)}</span>
                      <div className="text-xs text-muted">
                        {b.kind === "discord" ? "Gateway 연결" : b.receiveMode ? labelKo("telegram_receive_mode", b.receiveMode) : "—"} · 마지막 연결 {formatDateTime(b.lastConnectedAt)}
                      </div>
                      {b.kind === "discord" && b.inviteUrl && (
                        <div className="text-xs">
                          <a href={b.inviteUrl} target="_blank" rel="noreferrer">
                            내 서버에 봇 초대하기
                          </a>
                          <span className="text-muted"> · 초대 후 봇 프로필에서 ‘메시지 보내기’로 DM을 엽니다.</span>
                        </div>
                      )}
                    </span>
                    <StatusBadge enum="channel_status" value={b.status} />
                  </ListItem>
                ))}
              </List>
            )}
            <form onSubmit={onSubmit} className="grid grid-cols-1 items-start gap-2 min-[521px]:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,2fr)]">
              <Field label="종류">
                <Select value={kind} onChange={(e) => setKind(e.target.value as MessagingBotKind)}>
                  <option value="telegram">Telegram</option>
                  <option value="discord">Discord</option>
                </Select>
              </Field>
              <Field label="이름">
                <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="예) 내 작업 봇" />
              </Field>
              <Field
                label="봇 토큰"
                hint={BOT_KIND_HINT[kind]}
                action={
                  <Button type="submit" variant="primary" disabled={!label.trim() || token.trim().length < 10} loading={reg.isPending}>
                    봇 등록
                  </Button>
                }
              >
                <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
              </Field>
            </form>
            {reg.error && <Callout tone="danger">{errorMessage(reg.error)}</Callout>}
            {kind === "discord" && (
              <Callout tone="info" title="Discord 봇 준비 (Developer Portal)">
                <ol className="m-0 pl-4 text-xs">
                  <li>discord.com/developers/applications › New Application → 이름 입력.</li>
                  <li>Bot 메뉴 › Reset Token으로 토큰을 복사해 위에 붙여 넣습니다.</li>
                  <li>Privileged Gateway Intents는 켜지 않아도 됩니다(DM 본문은 기본으로 받습니다).</li>
                  <li>
                    다른 사람이 봇을 추가하지 못하게 Installation › Install Link를 None으로 바꾸고 User Install을 끈 뒤, Bot › Public Bot을
                    끕니다(연결한 내 계정 외의 DM은 어차피 거부됩니다).
                  </li>
                  <li>등록 후 ‘내 서버에 봇 초대하기’로 내 서버에 추가하고, 봇에게 DM을 보낼 수 있게 둡니다.</li>
                </ol>
                <p className="m-0 mt-1 text-xs text-muted">앱이 Discord로 바깥 연결(websocket)만 열기 때문에 공개 주소나 포트 개방이 필요 없습니다.</p>
              </Callout>
            )}
            <p className="m-0 text-xs text-faint">봇을 등록한 뒤 작품 설정의 ‘채널 연결’에서 일회용 코드로 1:1 대화(DM)를 바인딩하세요.</p>
          </div>
        )}
      </QueryView>
    </Card>
  );
}

export function SecretsCard() {
  const q = useSecrets();
  const del = useDeleteSecret();
  const [target, setTarget] = useState<string | null>(null);
  return (
    <Card title="저장된 비밀">
      <QueryView query={q} compact>
        {(items) => (
          <DataTable
            label="저장된 비밀"
            rows={items}
            rowKey={(s) => s.id}
            empty="저장된 비밀이 없습니다."
            columns={[
              { key: "id", header: "키", cell: (s) => <code className="font-mono text-xs">{s.id}</code>, rowHeader: true },
              { key: "l", header: "설명", cell: (s) => s.label ?? "—" },
              { key: "u", header: "변경", className: "whitespace-nowrap tabular-nums", cell: (s) => formatDateTime(s.updatedAt) },
              {
                key: "a",
                header: <span className="sr-only">삭제</span>,
                cell: (s) => (
                  <Button size="sm" variant="danger" onClick={() => setTarget(s.id)}>
                    삭제
                  </Button>
                ),
              },
            ]}
          />
        )}
      </QueryView>
      <p className="m-0 mt-2 text-xs text-faint">값은 암호화해 저장하며 화면·로그·감사 기록에 보이지 않습니다.</p>
      <ConfirmDialog
        open={target !== null}
        title="비밀을 삭제할까요?"
        description={target ?? undefined}
        danger
        confirmLabel="삭제"
        busy={del.isPending}
        onCancel={() => setTarget(null)}
        onConfirm={() => target && del.mutate(target, { onSettled: () => setTarget(null) })}
      >
        {del.error && <Callout tone="danger">{errorMessage(del.error)}</Callout>}
      </ConfirmDialog>
    </Card>
  );
}

export function BackupsCard() {
  const q = useBackups();
  const create = useCreateBackup();
  const verify = useVerifyBackup();
  return (
    <Card
      title="백업"
      actions={
        <Button size="sm" loading={create.isPending} onClick={() => create.mutate()}>
          지금 백업
        </Button>
      }
    >
      {create.error && <Callout tone="danger" className="mb-2">{errorMessage(create.error)}</Callout>}
      {verify.data && (
        <Callout tone={verify.data.ok ? "ok" : "danger"} className="mb-2">
          {verify.data.message}
        </Callout>
      )}
      {verify.error && <Callout tone="danger" className="mb-2">{errorMessage(verify.error)}</Callout>}
      <QueryView query={q} compact notReadyDescription="백업 기능이 준비되면 여기서 실행합니다. 지금은 `ncs backup`을 쓰세요.">
        {(d) => (
          <div className="flex flex-col gap-2">
            {d.schedule && (
              <p className="m-0 text-xs text-muted">
                주기 {d.schedule.intervalHours}시간 · 다음 {formatDateTime(d.schedule.nextAt)} · 위치 <code className="font-mono">{d.schedule.backupsDir}</code>
                {d.schedule.due && <Badge tone="warn" className="ml-1">백업 필요</Badge>}
              </p>
            )}
            <DataTable
              label="백업 기록"
              rows={d.items.slice(0, 10)}
              rowKey={(b) => b.id}
              empty="백업 기록이 없습니다."
              columns={[
                { key: "s", header: "상태", cell: (b) => <StatusBadge enum="backup_status" value={b.status} /> },
                { key: "t", header: "시작", className: "whitespace-nowrap tabular-nums", cell: (b) => formatDateTime(b.startedAt), rowHeader: true },
                { key: "k", header: "종류", cell: (b) => `${labelKo("backup_trigger", b.trigger)} · ${labelKo("backup_mode", b.mode)}` },
                { key: "z", header: "크기", className: "whitespace-nowrap", cell: (b) => (b.sizeBytes ? `${formatNumber(Math.round(b.sizeBytes / 1024))} KB` : "—") },
                {
                  key: "v",
                  header: <span className="sr-only">검증</span>,
                  cell: (b) =>
                    b.status === "succeeded" ? (
                      <Button size="sm" onClick={() => verify.mutate(b.id)} loading={verify.isPending && verify.variables === b.id}>
                        검증
                      </Button>
                    ) : (
                      (b.errorMessage ?? "")
                    ),
                },
              ]}
            />
          </div>
        )}
      </QueryView>
    </Card>
  );
}
