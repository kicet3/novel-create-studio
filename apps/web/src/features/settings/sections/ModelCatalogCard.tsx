import { StateBadge } from "./status-badges.js";
import { useState, type FormEvent } from "react";
import { formatUsd, type LlmAvailableModels, type LlmCallProviderId, type LlmProviderModel, type LlmProviderProfileDto } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import { Badge, Button, Callout, Card, ConfirmDialog, Dialog, Field, formatNumber, Input, QueryView, Table, TableWrap, Tabs, Td, Th } from "../../../components/ui/index.js";
import {
  callProviderConnected,
  useAddProfileModel,
  useAvailableModels,
  useEditProfileModel,
  useProviderProfiles,
  useProviders,
  useRemoveProfileModel,
  useResetProfileModels,
} from "../api.js";
import { PROVIDER_LABEL } from "./InstallSections.js";

const CALL_PROVIDERS: LlmCallProviderId[] = ["anthropic", "claude_code", "openai", "xai", "google"];
/** short tab labels (the long PROVIDER_LABEL + badge overflowed the tab row) */
const TAB_LABEL: Record<string, string> = { anthropic: "Claude API", claude_code: "Claude 구독", openai: "OpenAI", xai: "xAI", google: "Gemini" };
/** below 861px each model is a stacked card instead of a wide row (same breakpoint as 역할별 모델) */
const CELL = "max-[860px]:block max-[860px]:border-0 max-[860px]:p-0";
function CellLabel({ children }: { children: string }) {
  return (
    <span aria-hidden="true" className="mb-0.5 block text-xs font-semibold text-muted min-[861px]:hidden">
      {children}
    </span>
  );
}

/** USD per 1M tokens (as typed) ↔ micro-USD per 1M tokens (stored); "" = unpriced */
const usdToMicros = (v: string): number | null => (v.trim() === "" ? null : Math.round(Number(v) * 1_000_000));
const microsToUsd = (v: number | null | undefined): string => (v === null || v === undefined ? "" : String(v / 1_000_000));
const priceValid = (v: string) => v.trim() === "" || (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1000);
const intOrEmpty = (v: string) => v.trim() === "" || (Number.isInteger(Number(v)) && Number(v) > 0);

/**
 * 설치 설정 → 모델: models of each provider's active profile. Every change makes a new profile version (past cost
 * records keep the version they were priced with). A model a role uses cannot be removed or switched off.
 */
export function ModelCatalogCard() {
  const profiles = useProviderProfiles();
  const providers = useProviders();
  const connected = callProviderConnected(providers.data?.items ?? []);
  // the catalog needs an API-key lane (Claude row: the Console key; others: API key is the active method)
  const apiKeyLane = new Map<string, boolean>(
    (providers.data?.items ?? []).map((p) => [p.provider, p.provider === "anthropic" ? p.methods.some((m) => m.method === "api_key" && m.configured) : p.activeMethod === "api_key"]),
  );
  const [tab, setTab] = useState<LlmCallProviderId>("anthropic");
  return (
    <Card title="모델 관리">
      <QueryView query={profiles} compact>
        {(d) => {
          const active = new Map(d.items.filter((p) => p.isActive && p.providerKind === "llm").map((p) => [p.provider, p]));
          const items = CALL_PROVIDERS.filter((p) => active.has(p)).map((p) => ({
            value: p,
            label: <span title={PROVIDER_LABEL[p] ?? p}>{TAB_LABEL[p] ?? p}</span>,
            adornment: connected.get(p) ? <Badge tone="ok">연결됨</Badge> : <Badge tone="neutral">연결 안 됨</Badge>,
          }));
          const profile = active.get(tab) ?? active.get(items[0]?.value ?? "");
          return (
            <div className="flex flex-col gap-3">
              <Tabs label="공급자" items={items} value={profile?.provider as LlmCallProviderId} onChange={setTab} />
              {profile ? (
                <ProviderModels key={profile.provider} profile={profile} canList={profile.provider === "claude_code" || (apiKeyLane.get(profile.provider) ?? false)} />
              ) : (
                <p className="m-0 text-[13px] text-muted">공급자 프로필이 없습니다.</p>
              )}
            </div>
          );
        }}
      </QueryView>
      <p className="m-0 mt-2 text-xs text-faint">
        단가는 1M 토큰당 USD입니다. 비워 두면 단가 미등록 모델이 되어 호출 전에 예산 확인을 요청합니다. 바꿀 때마다 프로필 새 버전이 생기고 이미 기록된 비용은 그때 버전 단가를 그대로 씁니다.
      </p>
    </Card>
  );
}

function ProviderModels({ profile, canList }: { profile: LlmProviderProfileDto; canList: boolean }) {
  const edit = useEditProfileModel();
  const remove = useRemoveProfileModel();
  const reset = useResetProfileModels();
  const [editing, setEditing] = useState<LlmProviderModel | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [adding, setAdding] = useState<{ id: string; label?: string; maxContextTokens?: number | null; maxOutputTokens?: number | null } | null>(null);
  const err = edit.error ?? remove.error ?? reset.error;
  const subscription = profile.provider === "claude_code";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>
          프로필 v{profile.versionNo} · 모델 {profile.models.length}개
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="primary" onClick={() => setAdding({ id: "" })}>
          모델 추가
        </Button>
        <Button size="sm" onClick={() => setConfirmReset(true)}>
          기본 목록으로
        </Button>
      </div>
      {err && <Callout tone="danger">{errorMessage(err)}</Callout>}
      <TableWrap label={`${PROVIDER_LABEL[profile.provider] ?? profile.provider} 모델`}>
        <Table className="max-[860px]:block">
          <thead className="max-[860px]:hidden">
            <tr>
              <Th>모델</Th>
              <Th>입력 / 출력 (1M)</Th>
              <Th>컨텍스트 · 출력 상한</Th>
              <Th>상태</Th>
              <Th>
                <span className="sr-only">동작</span>
              </Th>
            </tr>
          </thead>
          <tbody className="max-[860px]:block">
            {profile.models.map((m) => (
              <tr key={m.id} className="max-[860px]:grid max-[860px]:grid-cols-2 max-[860px]:gap-2 max-[860px]:border-b max-[860px]:border-border max-[860px]:px-3 max-[860px]:py-3 max-[860px]:last:border-b-0">
                <Th scope="row" className="min-w-40 bg-transparent font-normal max-[860px]:col-span-2 max-[860px]:border-0 max-[860px]:p-0">
                  <div className="font-semibold text-text">{m.label ?? m.id}</div>
                  {m.label && <code className="font-mono text-xs text-muted [overflow-wrap:anywhere]">{m.id}</code>}
                </Th>
                <Td className={`whitespace-nowrap tabular-nums ${CELL}`}>
                  <CellLabel>입력 / 출력 (1M)</CellLabel>
                  {subscription ? (
                    "구독 (0원)"
                  ) : m.input_price_micros_per_mtok === null || m.output_price_micros_per_mtok === null ? (
                    <Badge tone="warn">단가 미등록</Badge>
                  ) : (
                    `${formatUsd(m.input_price_micros_per_mtok)} / ${formatUsd(m.output_price_micros_per_mtok)}`
                  )}
                </Td>
                <Td className={`whitespace-nowrap tabular-nums text-muted ${CELL}`}>
                  <CellLabel>컨텍스트 · 출력 상한</CellLabel>
                  {m.max_context_tokens ? formatNumber(m.max_context_tokens) : "—"} · {m.max_output_tokens ? formatNumber(m.max_output_tokens) : "—"}
                </Td>
                <Td className={CELL}>
                  <CellLabel>상태</CellLabel>
                  {m.disabled ? <StateBadge state="off" /> : <Badge tone="ok">켜짐</Badge>}
                </Td>
                <Td className={`whitespace-nowrap ${CELL} max-[860px]:self-end`}>
                  <div className="flex gap-1">
                    <Button size="sm" onClick={() => setEditing(m)}>
                      편집
                    </Button>
                    <Button
                      size="sm"
                      loading={edit.isPending && edit.variables?.modelId === m.id}
                      onClick={() => edit.mutate({ profileId: profile.id, modelId: m.id, patch: { disabled: !m.disabled } })}
                    >
                      {m.disabled ? "켜기" : "끄기"}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setRemoving(m.id)}>
                      삭제
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
      <CatalogPicker provider={profile.provider as LlmCallProviderId} canList={canList} onPick={(m) => setAdding(m)} />

      <ModelDialog
        key={adding ? `add:${adding.id}` : editing ? `edit:${editing.id}` : "closed"}
        profile={profile}
        open={adding !== null || editing !== null}
        initial={editing ?? (adding ? { id: adding.id, label: adding.label, input_price_micros_per_mtok: subscription ? 0 : null, output_price_micros_per_mtok: subscription ? 0 : null, max_context_tokens: adding.maxContextTokens ?? undefined, max_output_tokens: adding.maxOutputTokens ?? undefined } : null)}
        mode={editing ? "edit" : "add"}
        onClose={() => {
          setAdding(null);
          setEditing(null);
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        title="모델을 목록에서 지울까요?"
        description={`${removing ?? ""} — 이 모델을 쓰는 역할이 있으면 지울 수 없습니다. 지난 비용 기록은 그대로 남습니다.`}
        danger
        confirmLabel="삭제"
        busy={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate({ profileId: profile.id, modelId: removing }, { onSettled: () => setRemoving(null) })}
      />
      <ConfirmDialog
        open={confirmReset}
        title="기본 모델 목록으로 되돌릴까요?"
        description="이 버전에 들어 있는 기본 모델과 단가로 되돌립니다. 추가한 모델 중 역할이 쓰고 있는 모델이 있으면 되돌릴 수 없습니다."
        confirmLabel="되돌리기"
        busy={reset.isPending}
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => reset.mutate(profile.id, { onSettled: () => setConfirmReset(false) })}
      />
    </div>
  );
}

/** [모델 목록 불러오기]: the provider API's list (API key connected) or the fixed Claude 구독 list */
function CatalogPicker({ provider, canList, onPick }: { provider: LlmCallProviderId; canList: boolean; onPick: (m: { id: string; label?: string; maxContextTokens?: number | null; maxOutputTokens?: number | null }) => void }) {
  const q = useAvailableModels();
  const [filter, setFilter] = useState("");
  const data: LlmAvailableModels | undefined = q.data?.provider === provider ? q.data : undefined;
  const shown = (data?.items ?? []).filter((m) => !filter.trim() || m.id.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <details className="rounded-[10px] border border-border px-3 py-2 text-[13px]">
      <summary className="cursor-pointer font-semibold">{provider === "claude_code" ? "Claude Code CLI가 받는 모델 보기" : "공급자에서 모델 목록 불러오기"}</summary>
      <div className="mt-2 flex flex-col gap-2">
        {!canList ? (
          <p className="m-0 text-xs text-muted">API 키로 연결한 공급자만 목록을 불러올 수 있습니다. 모델 ID를 알고 있으면 [모델 추가]로 직접 넣으세요.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" loading={q.isPending} onClick={() => q.mutate(provider)}>
              {data ? "다시 불러오기" : "목록 불러오기"}
            </Button>
            {data && <Input className="w-56" aria-label="모델 검색" placeholder="모델 ID 검색" value={filter} onChange={(e) => setFilter(e.target.value)} />}
            {provider === "claude_code" && <span className="text-xs text-muted">CLI를 실행하지 않고 `claude --model`이 받는 이름을 보여 줍니다.</span>}
          </div>
        )}
        {q.error && <Callout tone="danger">{errorMessage(q.error)}</Callout>}
        {data && (
          <ul className="m-0 flex max-h-64 list-none flex-col gap-1 overflow-y-auto p-0">
            {shown.length === 0 && <li className="text-xs text-muted">모델이 없습니다.</li>}
            {shown.map((m) => (
              <li key={m.id} className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{m.id}</code>
                {m.label && <span className="truncate text-xs text-muted">{m.label}</span>}
                {m.inProfile ? (
                  <Badge tone="neutral">목록에 있음</Badge>
                ) : (
                  <Button size="sm" onClick={() => onPick({ id: m.id, label: m.label ?? undefined, maxContextTokens: m.maxContextTokens, maxOutputTokens: m.maxOutputTokens })}>
                    추가
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function ModelDialog({ profile, open, initial, mode, onClose }: { profile: LlmProviderProfileDto; open: boolean; initial: Partial<LlmProviderModel> | null; mode: "add" | "edit"; onClose: () => void }) {
  const add = useAddProfileModel();
  const edit = useEditProfileModel();
  const subscription = profile.provider === "claude_code";
  const [id, setId] = useState(initial?.id ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [input, setInput] = useState(microsToUsd(initial?.input_price_micros_per_mtok));
  const [output, setOutput] = useState(microsToUsd(initial?.output_price_micros_per_mtok));
  const [ctx, setCtx] = useState(initial?.max_context_tokens ? String(initial.max_context_tokens) : "");
  const [maxOut, setMaxOut] = useState(initial?.max_output_tokens ? String(initial.max_output_tokens) : "");
  const m = mode === "add" ? add : edit;
  const idValid = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/.test(id.trim()) && id.trim().length <= 200;
  const valid = idValid && priceValid(input) && priceValid(output) && intOrEmpty(ctx) && intOrEmpty(maxOut);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const prices = subscription ? { input_price_micros_per_mtok: 0, output_price_micros_per_mtok: 0 } : { input_price_micros_per_mtok: usdToMicros(input), output_price_micros_per_mtok: usdToMicros(output) };
    if (mode === "add") {
      add.mutate(
        {
          profileId: profile.id,
          model: {
            id: id.trim(),
            ...(label.trim() ? { label: label.trim() } : {}),
            ...prices,
            ...(ctx.trim() ? { max_context_tokens: Number(ctx) } : {}),
            ...(maxOut.trim() ? { max_output_tokens: Number(maxOut) } : {}),
          },
        },
        { onSuccess: onClose },
      );
    } else {
      edit.mutate(
        {
          profileId: profile.id,
          modelId: initial!.id!,
          patch: { label: label.trim() || null, ...prices, max_context_tokens: ctx.trim() ? Number(ctx) : null, max_output_tokens: maxOut.trim() ? Number(maxOut) : null },
        },
        { onSuccess: onClose },
      );
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={mode === "add" ? "모델 추가" : "모델 편집"} description={PROVIDER_LABEL[profile.provider] ?? profile.provider} footer={false}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field label="모델 ID" required hint="공급자 API에 보내는 이름 그대로 (예: claude-sonnet-5-5, gpt-6.1-sol)" error={id && !idValid ? "영문·숫자·.-_:/@[] 만 쓸 수 있습니다." : undefined}>
          <Input autoFocus={mode === "add"} value={id} onChange={(e) => setId(e.target.value)} disabled={mode === "edit"} autoComplete="off" />
        </Field>
        <Field label="표시 이름" hint="비워 두면 모델 ID를 보여 줍니다.">
          <Input autoFocus={mode === "edit"} value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        {subscription ? (
          <p className="m-0 text-xs text-muted">Claude 구독 모델은 호출마다 과금되지 않아 단가가 0원으로 기록됩니다.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Field label="입력 단가 (USD / 1M 토큰)" hint="비우면 단가 미등록" error={priceValid(input) ? undefined : "0 이상 숫자"}>
              <Input inputMode="decimal" value={input} onChange={(e) => setInput(e.target.value)} />
            </Field>
            <Field label="출력 단가 (USD / 1M 토큰)" error={priceValid(output) ? undefined : "0 이상 숫자"}>
              <Input inputMode="decimal" value={output} onChange={(e) => setOutput(e.target.value)} />
            </Field>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label="컨텍스트 상한 (토큰)" error={intOrEmpty(ctx) ? undefined : "양의 정수"}>
            <Input inputMode="numeric" value={ctx} onChange={(e) => setCtx(e.target.value)} />
          </Field>
          <Field label="출력 상한 (토큰)" error={intOrEmpty(maxOut) ? undefined : "양의 정수"}>
            <Input inputMode="numeric" value={maxOut} onChange={(e) => setMaxOut(e.target.value)} />
          </Field>
        </div>
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            취소
          </Button>
          <Button type="submit" variant="primary" disabled={!valid} loading={m.isPending}>
            {mode === "add" ? "추가" : "저장"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
