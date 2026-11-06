import { useEffect, useState, type FormEvent } from "react";
import { labelKo, type LlmProviderId, type ProviderMethodInfo, type ProviderOAuthSessionDto, type ProviderStatusDto } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import { Badge, Button, Callout, Card, Field, formatDateTime, Input, QueryView } from "../../../components/ui/index.js";
import {
  useConnectClaudeCli,
  useRefreshProviders,
  useCancelProviderLogin,
  useDisconnectProvider,
  useImportCodexSession,
  useProviderLogin,
  useProviders,
  useSetProviderActiveMethod,
  useSetProviderApiKey,
  useStartProviderLogin,
  useTestProvider,
} from "../api.js";

const HEALTH: Record<ProviderStatusDto["health"], { tone: "ok" | "warn" | "danger" | "neutral"; label: string }> = {
  healthy: { tone: "ok", label: "연결됨" },
  warning: { tone: "warn", label: "확인 필요" },
  reauth_required: { tone: "danger", label: "다시 로그인 필요" },
  not_connected: { tone: "neutral", label: "연결 안 됨" },
};

const KEY_PLACEHOLDER: Record<LlmProviderId, string> = { anthropic: "sk-ant-…", openai: "sk-…", xai: "xai-…", google: "AIza…" };

/** 설치 설정 → AI 계정 연결: Claude(구독 CLI·Console API 키)·GPT·Grok·Gemini 연결 방식, 로그인, API 키, 연결 시험. */
export function ProviderConnectionsCard() {
  const q = useProviders();
  return (
    <Card title="AI 계정 연결">
      <QueryView query={q} compact notReadyDescription="LLM 모듈이 준비되면 AI 계정을 연결할 수 있습니다.">
        {(d) => (
          <div className="flex flex-col gap-3">
            <p className="m-0 text-xs text-muted">
              역할마다 연결된 공급자의 모델을 고를 수 있습니다(작품 설정 → 역할별 모델). 키와 로그인 토큰은 암호화해 이 컴퓨터에만 저장하며 화면·로그에 표시하지 않습니다.
            </p>
            {d.items.map((p) => (
              <ProviderRow key={p.provider} p={p} />
            ))}
          </div>
        )}
      </QueryView>
    </Card>
  );
}

function ProviderRow({ p }: { p: ProviderStatusDto }) {
  const test = useTestProvider();
  const disconnect = useDisconnectProvider();
  const h = HEALTH[p.health];
  const claude = p.provider === "anthropic";
  return (
    <section aria-label={p.label} className="rounded-[8px] border border-border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 text-[13.5px] font-bold">{p.label}</h3>
        <Badge tone={h.tone}>{h.label}</Badge>
        {p.isDefault && <Badge tone="accent">새 작품 기본</Badge>}
        {p.imageGeneration ? <Badge tone="violet">이미지 생성 지원</Badge> : <Badge tone="neutral">텍스트 전용</Badge>}
        <span className="flex-1" />
        {p.connected && !claude && (
          <Button size="sm" loading={test.isPending} onClick={() => test.mutate({ provider: p.provider })}>
            연결 시험
          </Button>
        )}
        {p.connected && (
          <Button size="sm" variant="ghost" loading={disconnect.isPending} onClick={() => disconnect.mutate({ provider: p.provider })}>
            모두 연결 해제
          </Button>
        )}
      </div>
      {p.connected && claude && (
        <p className="m-0 mt-1 text-xs text-muted">
          연결됨:{" "}
          <b>
            {p.methods
              .filter((m) => m.configured)
              .map((m) => m.label)
              .join(", ")}
          </b>{" "}
          · 역할마다 어느 쪽으로 호출할지 작품 설정 → 역할별 모델에서 고릅니다.
        </p>
      )}
      {p.connected && !claude && (
        <p className="m-0 mt-1 text-xs text-muted">
          사용 중: <b>{p.methods.find((m) => m.method === p.activeMethod)?.label ?? "—"}</b>
          {p.account && (
            <>
              {" "}
              · 계정 {p.account.email ?? p.account.accountId ?? "—"}
              {p.account.plan ? ` (${p.account.plan})` : ""}
            </>
          )}
          {p.expiresAt && <> · 토큰 만료 {formatDateTime(p.expiresAt)} (자동 갱신)</>}
        </p>
      )}
      {p.health === "reauth_required" && <Callout tone="danger" className="mt-2">로그인 세션을 갱신하지 못했습니다. 다시 로그인하세요.</Callout>}
      {test.data && (
        <Callout tone={test.data.status === "pass" ? "ok" : test.data.status === "warn" ? "warn" : "danger"} className="mt-2" title={`연결 시험: ${labelKo("health_status", test.data.status)}`}>
          {test.data.message}
        </Callout>
      )}
      {test.error && <Callout tone="danger" className="mt-2">{errorMessage(test.error)}</Callout>}
      {disconnect.error && <Callout tone="danger" className="mt-2">{errorMessage(disconnect.error)}</Callout>}

      <div className="mt-2 flex flex-col gap-2">
        {p.methods.map((m) => (
          <MethodBlock key={m.method} p={p} m={m} />
        ))}
        {p.unsupported.map((u) => (
          <div key={u.label} className="rounded-[6px] bg-surface-2 px-2.5 py-2 text-xs text-muted">
            <Badge tone="neutral">미지원</Badge> <b>{u.label}</b> — {u.reason}
          </div>
        ))}
      </div>
      <p className="m-0 mt-2 text-xs text-faint">{p.termsNote} 연결하면 해당 공급자와 맺은 내 약정이 그대로 적용됩니다.</p>
    </section>
  );
}

function MethodBlock({ p, m }: { p: ProviderStatusDto; m: ProviderMethodInfo }) {
  const setActive = useSetProviderActiveMethod();
  const disconnect = useDisconnectProvider();
  const test = useTestProvider();
  const active = p.activeMethod === m.method;
  if (m.availability === "dev_only") return <DevOnlyMethodBlock m={m} />;
  if (m.method === "claude_cli") return <ClaudeCliBlock p={p} m={m} />;
  // Claude: both lanes stay connected side by side (no "active method" switch)
  const claude = p.provider === "anthropic";
  return (
    <div className="rounded-[6px] border border-border/70 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[13px] font-semibold">{m.label}</span>
        {m.official ? <Badge tone="ok">공식 지원</Badge> : <Badge tone="warn">비공식</Badge>}
        {m.experimental && <Badge tone="warn">실험적</Badge>}
        {m.configured && <Badge tone={active ? "accent" : "neutral"}>{active ? "사용 중" : "등록됨"}</Badge>}
        {m.source === "env" && <Badge tone="info">환경 변수</Badge>}
        <span className="flex-1" />
        {m.configured && !active && !claude && (
          <Button size="sm" loading={setActive.isPending} onClick={() => setActive.mutate({ provider: p.provider, method: m.method })}>
            이 방식 사용
          </Button>
        )}
        {m.configured && claude && (
          <Button size="sm" loading={test.isPending} onClick={() => test.mutate({ provider: p.provider, method: m.method })}>
            연결 시험
          </Button>
        )}
        {m.configured && m.source !== "env" && (
          <Button size="sm" variant="ghost" loading={disconnect.isPending} onClick={() => disconnect.mutate({ provider: p.provider, method: m.method })}>
            {m.method === "api_key" ? "키 삭제" : "로그아웃"}
          </Button>
        )}
      </div>
      <p className="m-0 mt-1 text-xs text-muted">{m.note}</p>
      {(setActive.error || disconnect.error) && <Callout tone="danger" className="mt-1">{errorMessage(setActive.error ?? disconnect.error)}</Callout>}
      {test.data && <TestResult r={test.data} />}
      {test.error && <Callout tone="danger" className="mt-1">{errorMessage(test.error)}</Callout>}
      {m.method === "api_key" ? <ApiKeyForm p={p} m={m} /> : <OAuthControls p={p} m={m} />}
    </div>
  );
}

/**
 * Subscription / OAuth method on a server not in dev mode: shown, but disabled (no connect / login buttons).
 * A stored login session is kept for dev mode and ignored for calls.
 */
function DevOnlyMethodBlock({ m }: { m: ProviderMethodInfo }) {
  return (
    <div className="rounded-[6px] border border-dashed border-border/70 px-2.5 py-2 opacity-70" aria-disabled="true">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[13px] font-semibold">{m.label}</span>
        <Badge tone="neutral">개발 모드 전용</Badge>
        {m.configured && <Badge tone="neutral">저장된 로그인 보관 중 (사용 안 함)</Badge>}
      </div>
      <p className="m-0 mt-1 text-xs text-muted">
        {m.unavailableReason ?? "개발 모드에서만 사용할 수 있습니다 (`pnpm dev` 또는 NCS_DEV_MODE=1)."}
      </p>
    </div>
  );
}

function TestResult({ r }: { r: { status: "pass" | "warn" | "fail"; message: string } }) {
  return (
    <Callout tone={r.status === "pass" ? "ok" : r.status === "warn" ? "warn" : "danger"} className="mt-1" title={`연결 시험: ${labelKo("health_status", r.status)}`}>
      {r.message}
    </Callout>
  );
}

/**
 * Claude 구독 (Claude Code CLI): the app runs the Claude Code the user installed and signed in to. The app never starts
 * the login — the user runs `claude auth login` in a terminal, then presses [상태 새로고침]. "사용 중지" only switches
 * the method off in this app (the CLI login is untouched).
 */
function ClaudeCliBlock({ p, m }: { p: ProviderStatusDto; m: ProviderMethodInfo }) {
  const connect = useConnectClaudeCli();
  const refresh = useRefreshProviders();
  const disconnect = useDisconnectProvider();
  const test = useTestProvider();
  const [asked, setAsked] = useState(false);
  const cli = p.claudeCli;
  const subscription = !!cli?.loggedIn && cli.authMethod === "claude.ai";
  const needsLogin = !!cli?.enabled && !cli.usable;
  return (
    <div className="rounded-[6px] border border-border/70 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[13px] font-semibold">{m.label}</span>
        {cli && (
          <>
            <Badge tone={cli.installed ? "ok" : "neutral"}>{cli.installed ? "Claude Code 설치됨" : "Claude Code 없음"}</Badge>
            {cli.installed && <Badge tone={subscription ? "ok" : cli.loggedIn ? "warn" : "neutral"}>{subscription ? "구독 로그인됨" : cli.loggedIn ? `구독 아님(${cli.authMethod ?? "알 수 없음"})` : "로그인 필요"}</Badge>}
            {!cli.enabled && <Badge tone="neutral">앱에서 사용 중지</Badge>}
            {cli.usable && <Badge tone="accent">사용 가능</Badge>}
          </>
        )}
        <span className="flex-1" />
        {cli?.usable && (
          <Button size="sm" loading={test.isPending} onClick={() => test.mutate({ provider: p.provider, method: "claude_cli" })}>
            연결 시험
          </Button>
        )}
        <Button size="sm" variant="ghost" loading={refresh.isPending} onClick={() => refresh.mutate()}>
          상태 새로고침
        </Button>
        {cli?.enabled ? (
          cli.usable && (
            <Button size="sm" variant="ghost" loading={disconnect.isPending} onClick={() => disconnect.mutate({ provider: p.provider, method: "claude_cli" })}>
              사용 중지
            </Button>
          )
        ) : (
          <Button size="sm" variant="primary" loading={connect.isPending} onClick={() => connect.mutate(undefined, { onSuccess: () => setAsked(true) })}>
            연결
          </Button>
        )}
        {cli?.enabled && !cli.usable && !asked && (
          <Button size="sm" variant="primary" onClick={() => setAsked(true)}>
            연결
          </Button>
        )}
      </div>
      <p className="m-0 mt-1 text-xs text-muted">{m.note}</p>
      {cli && <p className="m-0 mt-1 text-xs text-faint">상태: {cli.message} · 확인 {formatDateTime(cli.checkedAt)}</p>}
      {needsLogin && asked && (
        <Callout tone="info" className="mt-1" title="Claude Code에 로그인하세요">
          {cli?.installed ? (
            <>
              터미널에서 <code className="font-mono">claude auth login</code> 실행 후 [상태 새로고침]을 누르세요. 로그인은 Claude Code가 직접 처리하며, 이 앱은 로그인 화면을 열거나 로그인 정보를 받지 않습니다.
            </>
          ) : (
            <>Claude Code를 설치한 뒤 터미널에서 <code className="font-mono">claude auth login</code> 실행 후 [상태 새로고침]을 누르세요.</>
          )}
        </Callout>
      )}
      {test.data && <TestResult r={test.data} />}
      {(connect.error || refresh.error || disconnect.error || test.error) && <Callout tone="danger" className="mt-1">{errorMessage(connect.error ?? refresh.error ?? disconnect.error ?? test.error)}</Callout>}
    </div>
  );
}

function ApiKeyForm({ p, m }: { p: ProviderStatusDto; m: ProviderMethodInfo }) {
  const [key, setKey] = useState("");
  const save = useSetProviderApiKey();
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    save.mutate({ provider: p.provider, apiKey: key.trim() }, { onSuccess: () => setKey("") });
  };
  return (
    <form onSubmit={onSubmit} className="mt-1.5 flex flex-col gap-2">
      <Field
        label={`${m.label}`}
        hint={m.configured ? "등록됨 · 값은 다시 보여 주지 않습니다" : undefined}
        action={
          <Button type="submit" variant="primary" disabled={!key.trim()} loading={save.isPending}>
            {m.configured ? "교체" : "저장"}
          </Button>
        }
      >
        <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={m.configured ? "새 키로 교체" : KEY_PLACEHOLDER[p.provider]} />
      </Field>
      {save.error && <Callout tone="danger">{errorMessage(save.error)}</Callout>}
    </form>
  );
}

function OAuthControls({ p, m }: { p: ProviderStatusDto; m: ProviderMethodInfo }) {
  const start = useStartProviderLogin();
  const cancel = useCancelProviderLogin();
  const importCodex = useImportCodexSession();
  const [session, setSession] = useState<ProviderOAuthSessionDto | null>(null);
  const [confirmImport, setConfirmImport] = useState(false);
  const live = useProviderLogin(p.provider, session?.status === "pending" ? session.sessionId : null);
  const current = live.data ?? session;

  const begin = (flow: "browser" | "device") =>
    start.mutate(
      { provider: p.provider, flow },
      {
        onSuccess: (s) => {
          setSession(s);
          if (flow === "browser" && s.verificationUrl) window.open(s.verificationUrl, "_blank", "noopener");
        },
      },
    );

  useEffect(() => {
    if (current && current.status !== "pending") {
      const t = setTimeout(() => setSession(null), current.status === "complete" ? 4000 : 15000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [current]);

  const pending = current?.status === "pending";
  return (
    <div className="mt-1.5 flex flex-col gap-2">
      {!pending && (
        <div className="flex flex-wrap gap-2">
          {m.flows.includes("browser") && (
            <Button size="sm" variant="primary" loading={start.isPending && start.variables?.flow === "browser"} onClick={() => begin("browser")}>
              브라우저로 로그인
            </Button>
          )}
          {m.flows.includes("device") && (
            <Button size="sm" variant={m.flows.includes("browser") ? "default" : "primary"} loading={start.isPending && start.variables?.flow === "device"} onClick={() => begin("device")}>
              기기 코드로 로그인
            </Button>
          )}
          {m.flows.includes("import_codex") && (
            <Button size="sm" variant="ghost" onClick={() => setConfirmImport((v) => !v)}>
              Codex CLI 로그인 가져오기
            </Button>
          )}
        </div>
      )}
      {confirmImport && !pending && (
        <Callout tone="warn" title="Codex CLI 로그인을 한 번 복사합니다">
          ~/.codex/auth.json의 ChatGPT 세션을 복사해 이 서버에 따로 보관합니다. 갱신 토큰은 쓸 때마다 바뀌므로, 이 서버가 토큰을 갱신하면 Codex CLI는 다시 로그인해야 할 수 있습니다. 가능하면 위의 로그인을 쓰세요.
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="primary" loading={importCodex.isPending} onClick={() => importCodex.mutate(p.provider, { onSuccess: () => setConfirmImport(false) })}>
              그래도 가져오기
            </Button>
            <Button size="sm" onClick={() => setConfirmImport(false)}>
              취소
            </Button>
          </div>
          {importCodex.error && <p className="m-0 mt-1 text-danger">{errorMessage(importCodex.error)}</p>}
        </Callout>
      )}
      {start.error && <Callout tone="danger">{errorMessage(start.error)}</Callout>}
      {current && pending && (
        <Callout tone="info" title={current.flow === "device" ? "기기 코드로 로그인하세요" : "브라우저에서 로그인을 마치세요"}>
          {current.flow === "device" ? (
            <>
              <a href={current.verificationUrl ?? "#"} target="_blank" rel="noreferrer">
                {current.verificationUrl}
              </a>
              에서 아래 코드를 입력하세요.
              <div className="my-2 font-mono text-xl font-bold tracking-widest" aria-label="로그인 코드">
                {current.userCode}
              </div>
            </>
          ) : (
            <>
              새 창이 열리지 않으면{" "}
              <a href={current.verificationUrl ?? "#"} target="_blank" rel="noreferrer">
                로그인 페이지 열기
              </a>
              를 누르세요. 이 서버와 같은 컴퓨터의 브라우저에서만 완료됩니다.
            </>
          )}
          <div className="mt-1 flex items-center gap-2 text-xs text-muted">
            만료 {formatDateTime(current.expiresAt)} · 로그인을 기다리는 중…
            <Button size="sm" variant="ghost" onClick={() => cancel.mutate({ provider: p.provider, sessionId: current.sessionId }, { onSuccess: () => setSession(null) })}>
              취소
            </Button>
          </div>
        </Callout>
      )}
      {current && current.status === "complete" && <Callout tone="ok">로그인했습니다{current.accountEmail ? ` (${current.accountEmail})` : ""}.</Callout>}
      {current && (current.status === "error" || current.status === "expired") && <Callout tone="danger">{current.message ?? "로그인하지 못했습니다."}</Callout>}
    </div>
  );
}
