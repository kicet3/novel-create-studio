import { useState } from "react";
import { AGENT_ROLE, labelKo, type LlmCallProviderId, type RoleModelDefaultDto } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import { Badge, Button, Callout, Card, QueryView, Select, Table, TableWrap, Td, Th } from "../../../components/ui/index.js";
import { useProviderProfiles, useProviders, useResetRoleDefaults, useRoleDefaults, useSetRoleDefaults } from "../api.js";
import { providerOptions, type ProviderOption } from "./model-options.js";

/** 설치 설정 → 새 작품 기본 모델: provider + model per role used when a novel is created (existing novels unchanged). */
export function RoleDefaultsCard() {
  const q = useRoleDefaults();
  const profiles = useProviderProfiles();
  const providers = useProviders();
  const options = providerOptions(profiles.data?.items ?? [], providers.data?.items ?? []);
  const set = useSetRoleDefaults();
  const reset = useResetRoleDefaults();
  const err = set.error ?? reset.error;
  return (
    <Card
      title="새 작품 기본 모델"
      actions={
        <Button size="sm" loading={reset.isPending && reset.variables === undefined} onClick={() => reset.mutate(undefined)}>
          모두 기본값으로
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <AllRolesRow options={options} busy={set.isPending} onApply={(provider, modelId) => set.mutate({ items: AGENT_ROLE.map((agentRole) => ({ agentRole, provider, modelId })) })} />
        {err && <Callout tone="danger">{errorMessage(err)}</Callout>}
        <QueryView query={q} compact>
          {(d) => (
            <TableWrap label="역할별 새 작품 기본 모델">
              {/* below 861px each role is a stacked card (the two selects were cut to a few characters) */}
              <Table className="max-[860px]:block">
                <thead className="max-[860px]:hidden">
                  <tr>
                    <Th>역할</Th>
                    <Th>공급자 · 모델</Th>
                    <Th>
                      <span className="sr-only">동작</span>
                    </Th>
                  </tr>
                </thead>
                <tbody className="max-[860px]:block">
                  {d.items.map((r) => (
                    <DefaultRow
                      key={`${r.agentRole}:${r.provider}:${r.modelId}`}
                      row={r}
                      options={options}
                      busy={set.isPending}
                      onSave={(provider, modelId) => set.mutate({ items: [{ agentRole: r.agentRole, provider, modelId }] })}
                      onReset={() => reset.mutate(r.agentRole)}
                    />
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </QueryView>
        <p className="m-0 text-xs text-faint">작품을 만들 때 역할별 모델로 복사됩니다. 이미 만든 작품은 작품 설정 → 역할별 모델에서 바꾸세요. 연결된 공급자의 켜진 모델만 고를 수 있습니다.</p>
      </div>
    </Card>
  );
}

/** provider select + model select over connected providers' enabled models */
export function ProviderModelSelect({
  options,
  provider,
  modelId,
  onChange,
  label,
  disabled,
  size = "md",
}: {
  options: readonly ProviderOption[];
  provider: string;
  modelId: string;
  onChange: (provider: string, modelId: string) => void;
  label: string;
  disabled?: boolean;
  size?: "md" | "sm";
}) {
  const sel = options.find((o) => o.provider === provider);
  const models = sel?.models ?? [];
  const known = models.some((m) => m.id === modelId);
  return (
    <div className="flex min-w-0 flex-wrap gap-2">
      <Select
        className="min-w-44 max-w-full flex-1"
        controlSize={size}
        aria-label={`${label} 공급자`}
        value={provider}
        disabled={disabled}
        onChange={(e) => {
          const next = options.find((o) => o.provider === e.target.value);
          onChange(e.target.value, next?.models.some((m) => m.id === modelId) ? modelId : (next?.models[0]?.id ?? ""));
        }}
      >
        {!sel && <option value={provider}>{provider}</option>}
        {options.map((o) => (
          <option key={o.provider} value={o.provider} disabled={!o.connected && o.provider !== provider}>
            {o.label}
            {o.connected ? "" : " (연결 안 됨)"}
          </option>
        ))}
      </Select>
      <Select className="min-w-44 max-w-full flex-1" controlSize={size} aria-label={`${label} 모델`} value={modelId} disabled={disabled} onChange={(e) => onChange(provider, e.target.value)} aria-invalid={!known || undefined}>
        {!known && <option value={modelId}>{modelId || "모델 선택"}</option>}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
            {m.unpriced ? " · 단가 미등록" : ""}
          </option>
        ))}
      </Select>
    </div>
  );
}

function DefaultRow({ row, options, busy, onSave, onReset }: { row: RoleModelDefaultDto; options: ProviderOption[]; busy: boolean; onSave: (p: LlmCallProviderId, m: string) => void; onReset: () => void }) {
  const [provider, setProvider] = useState<string>(row.provider);
  const [modelId, setModelId] = useState(row.modelId);
  const role = labelKo("agent_role", row.agentRole);
  const target = options.find((o) => o.provider === provider);
  const valid = !!target?.connected && target.models.some((m) => m.id === modelId);
  const dirty = provider !== row.provider || modelId !== row.modelId;
  return (
    <tr className="max-[860px]:grid max-[860px]:grid-cols-1 max-[860px]:gap-2 max-[860px]:border-b max-[860px]:border-border max-[860px]:px-3 max-[860px]:py-3 max-[860px]:last:border-b-0">
      <Th scope="row" className="whitespace-nowrap bg-transparent max-[860px]:flex max-[860px]:items-center max-[860px]:gap-2 max-[860px]:border-0 max-[860px]:p-0">
        {role}
        <div className="mt-0.5 flex gap-1 max-[860px]:mt-0">
          {row.source === "custom" ? <Badge tone="accent">지정</Badge> : <Badge tone="neutral">기본</Badge>}
          {!row.usable && <Badge tone="warn">쓸 수 없음</Badge>}
        </div>
      </Th>
      <Td className="min-w-[24rem] max-[860px]:block max-[860px]:min-w-0 max-[860px]:border-0 max-[860px]:p-0">
        <ProviderModelSelect
          options={options}
          provider={provider}
          modelId={modelId}
          label={role}
          onChange={(p, m) => {
            setProvider(p);
            setModelId(m);
          }}
        />
      </Td>
      <Td className="whitespace-nowrap max-[860px]:block max-[860px]:border-0 max-[860px]:p-0">
        <div className="flex gap-1">
          <Button size="sm" variant="primary" disabled={!dirty || !valid} loading={busy && dirty} onClick={() => onSave(provider as LlmCallProviderId, modelId)}>
            저장
          </Button>
          {row.source === "custom" && (
            <Button size="sm" onClick={onReset}>
              기본값
            </Button>
          )}
        </div>
      </Td>
    </tr>
  );
}

/** [모든 역할에 적용]: one provider + model for every role */
export function AllRolesRow({ options, busy, onApply, label = "모든 역할에 적용" }: { options: ProviderOption[]; busy: boolean; onApply: (p: LlmCallProviderId, m: string) => void; label?: string }) {
  const first = options.find((o) => o.connected && o.models.length);
  const [provider, setProvider] = useState<string>("");
  const [modelId, setModelId] = useState("");
  const p = provider || first?.provider || "";
  const m = modelId || (provider ? "" : (first?.models[0]?.id ?? ""));
  const target = options.find((o) => o.provider === p);
  const valid = !!target?.connected && target.models.some((x) => x.id === m);
  if (!first) return <p className="m-0 text-xs text-muted">연결된 공급자가 없습니다. 위의 AI 계정 연결에서 먼저 연결하세요.</p>;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-border bg-surface-2 px-3 py-2">
      <span className="text-[13px] font-semibold">{label}</span>
      <ProviderModelSelect
        size="sm"
        options={options}
        provider={p}
        modelId={m}
        label={label}
        onChange={(np, nm) => {
          setProvider(np);
          setModelId(nm);
        }}
      />
      <Button size="sm" disabled={!valid} loading={busy} onClick={() => onApply(p as LlmCallProviderId, m)}>
        적용
      </Button>
    </div>
  );
}

