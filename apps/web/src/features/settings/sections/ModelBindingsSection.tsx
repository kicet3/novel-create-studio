import { useState } from "react";
import { labelKo, type RoleModelBindingDto } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import { Button, Callout, Card, Checkbox, Input, QueryView, Select, Table, TableWrap, Td, Th } from "../../../components/ui/index.js";
import { callProviderConnected, useModelBindings, useProviderProfiles, useProviders, useUpdateModelBinding } from "../api.js";
import { PROVIDER_LABEL } from "./InstallSections.js";

/** 역할별 모델 (FR-UI-09): provider + model, max_output_tokens(필수), fallback. Applies from the next run. */
export function ModelBindingsSection({ novelId }: { novelId: string }) {
  const q = useModelBindings(novelId);
  const profiles = useProviderProfiles();
  const providers = useProviders();
  const connected = callProviderConnected(providers.data?.items ?? []);
  const active: ProfileOption[] = (profiles.data?.items ?? [])
    .filter((p) => p.isActive && p.providerKind === "llm")
    .map((p) => ({ id: p.id, provider: p.provider, label: PROVIDER_LABEL[p.provider] ?? p.provider, connected: connected.get(p.provider) ?? false, models: p.models.map((m) => ({ id: m.id, label: m.label ?? m.id, unpriced: m.input_price_micros_per_mtok === null })) }));
  return (
    <Card title="역할별 모델" actions={<span className="text-xs text-muted">다음 실행부터 적용</span>}>
      <QueryView query={q} compact notReadyDescription="LLM 모듈이 준비되면 역할별 모델을 바꿀 수 있습니다.">
        {(d) => (
          <TableWrap label="역할별 모델">
            {/* below 861px every role is a stacked card (provider, model, limit, fallback, save) instead of a wide row */}
            <Table className="max-[860px]:block">
              <thead className="max-[860px]:hidden">
                <tr>
                  <Th>역할</Th>
                  <Th>공급자</Th>
                  <Th>모델</Th>
                  <Th>출력 토큰 상한</Th>
                  <Th>대체 모델</Th>
                  <Th>
                    <span className="sr-only">저장</span>
                  </Th>
                </tr>
              </thead>
              <tbody className="max-[860px]:block">
                {d.items.map((b) => (
                  <BindingRow key={`${b.id}:${b.providerProfileId}:${b.modelId}`} novelId={novelId} b={b} profiles={active} />
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </QueryView>
      <p className="m-0 mt-2 text-xs text-faint">
        연결되지 않은 공급자를 고르면 그 역할의 호출이 실패합니다. 설치 설정 → AI 계정 연결에서 먼저 연결하세요. 외부로 보내는 데이터: 원고 본문, 아웃라인, 집필에 필요한 캐논 사실만 공급자로 전송하며, 이미 보낸 데이터는 공급자 보존 정책을 따릅니다.
      </p>
    </Card>
  );
}

interface ProfileOption {
  id: string;
  provider: string;
  label: string;
  connected: boolean;
  models: Array<{ id: string; label: string; unpriced: boolean }>;
}

function BindingRow({ novelId, b, profiles }: { novelId: string; b: RoleModelBindingDto; profiles: ProfileOption[] }) {
  const current = profiles.find((p) => p.id === b.providerProfileId);
  const [profileId, setProfileId] = useState(b.providerProfileId);
  const [modelId, setModelId] = useState(b.modelId);
  const [maxTokens, setMaxTokens] = useState(String(b.maxOutputTokens));
  const [fallback, setFallback] = useState(b.fallbackEnabled);
  const m = useUpdateModelBinding(novelId);
  const role = labelKo("agent_role", b.agentRole);
  const n = Number(maxTokens);
  const valid = Number.isInteger(n) && n > 0 && n <= 128_000;
  const profileOptions = current ? profiles : [{ id: b.providerProfileId, provider: "?", label: "이전 버전 프로필", connected: true, models: [{ id: b.modelId, label: b.modelId, unpriced: false }] }, ...profiles];
  const selected = profileOptions.find((p) => p.id === profileId);
  const models = selected?.models ?? [];
  const modelValid = models.some((x) => x.id === modelId);
  const dirty = profileId !== b.providerProfileId || modelId !== b.modelId || n !== b.maxOutputTokens || fallback !== b.fallbackEnabled;
  return (
    <tr className="max-[860px]:grid max-[860px]:grid-cols-1 max-[860px]:gap-2 max-[860px]:border-b max-[860px]:border-border max-[860px]:px-3 max-[860px]:py-3 max-[860px]:last:border-b-0">
      <Th scope="row" className="whitespace-nowrap bg-transparent text-[13px] leading-9 text-text max-[860px]:border-0 max-[860px]:p-0 max-[860px]:text-[14px] max-[860px]:leading-normal">
        {role}
      </Th>
      <Td className={CELL}>
        <MobileLabel>공급자</MobileLabel>
        <Select
          className="min-w-44"
          aria-label={`${role} 공급자`}
          value={profileId}
          onChange={(e) => {
            const next = profileOptions.find((p) => p.id === e.target.value);
            setProfileId(e.target.value);
            if (next && !next.models.some((x) => x.id === modelId)) setModelId(next.models[0]?.id ?? "");
          }}
        >
          {profileOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.connected ? "" : " (연결 안 됨)"}
            </option>
          ))}
        </Select>
      </Td>
      <Td className={CELL}>
        <MobileLabel>모델</MobileLabel>
        <Select className="min-w-40" aria-label={`${role} 모델`} value={modelId} onChange={(e) => setModelId(e.target.value)} aria-invalid={!modelValid || undefined}>
          {!modelValid && <option value={modelId}>{modelId || "모델 선택"}</option>}
          {models.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
              {o.unpriced ? " · 단가 미등록" : ""}
            </option>
          ))}
        </Select>
        {selected && !selected.connected && <div className="mt-1 text-xs text-warn">이 공급자는 아직 연결되지 않았습니다.</div>}
        {selected?.provider === "claude_code" && <div className="mt-1 text-xs text-muted">내 Claude 구독 한도에서 차감 · 예산에는 0원으로 기록(정가 환산 추정치는 호출 기록에 표시)</div>}
      </Td>
      <Td className={CELL}>
        <MobileLabel>출력 토큰 상한</MobileLabel>
        <Input aria-label={`${role} 출력 토큰 상한`} aria-invalid={!valid || undefined} inputMode="numeric" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} className="w-28" />
      </Td>
      <Td className={CELL}>
        <MobileLabel>대체 모델</MobileLabel>
        <Checkbox className="whitespace-nowrap pt-2 max-[860px]:pt-0" label="사용" aria-label={`${role} 대체 모델 사용`} checked={fallback} onChange={(e) => setFallback(e.target.checked)} hint={b.fallbackModelId ?? undefined} />
      </Td>
      <Td className={CELL}>
        <Button
          aria-label={`${role} 저장`}
          disabled={!dirty || !valid || !modelValid}
          loading={m.isPending}
          onClick={() => {
            m.mutate({
              role: b.agentRole,
              patch: {
                ...(profileId !== b.providerProfileId ? { providerProfileId: profileId } : {}),
                ...(modelId !== b.modelId || profileId !== b.providerProfileId ? { modelId } : {}),
                ...(n !== b.maxOutputTokens ? { maxOutputTokens: n } : {}),
                ...(fallback !== b.fallbackEnabled ? { fallbackEnabled: fallback } : {}),
              },
            });
          }}
        >
          저장
        </Button>
        {m.error && <Callout tone="danger" className="mt-1">{errorMessage(m.error)}</Callout>}
      </Td>
    </tr>
  );
}

/** cell layout: table cell from 861px, plain block inside the role card below */
const CELL = "max-[860px]:block max-[860px]:border-0 max-[860px]:p-0";

function MobileLabel({ children }: { children: string }) {
  return (
    <span aria-hidden="true" className="mb-1 block text-xs font-semibold text-muted min-[861px]:hidden">
      {children}
    </span>
  );
}
