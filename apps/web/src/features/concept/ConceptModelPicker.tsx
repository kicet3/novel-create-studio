import { errorMessage } from "../../api/client.js";
import { Select } from "../../components/ui/index.js";
import { useModelBindings, useProviderProfiles, useProviders, useUpdateModelBinding } from "../settings/api.js";
import { providerOptions } from "../settings/sections/model-options.js";

/**
 * Concept page header: the concept_partner role's model of this novel (same binding as 작품 설정 → 역할별 모델).
 * One select grouped by connected provider; disabled while an agent turn is in flight. Applies from the next turn.
 */
export function ConceptModelPicker({ novelId, busy }: { novelId: string; busy: boolean }) {
  const bindings = useModelBindings(novelId);
  const profiles = useProviderProfiles();
  const providers = useProviders();
  const update = useUpdateModelBinding(novelId);
  const binding = bindings.data?.items.find((b) => b.agentRole === "concept_partner");
  if (!binding || !profiles.data) return null;
  const options = providerOptions(profiles.data.items, providers.data?.items ?? []);
  const value = `${binding.providerProfileId}|${binding.modelId}`;
  const listed = options.some((o) => o.profileId === binding.providerProfileId && o.models.some((m) => m.id === binding.modelId));
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted" title={busy ? "에이전트가 답하는 중에는 바꿀 수 없습니다." : "컨셉 파트너 모델 · 다음 턴부터 적용"}>
      <span className="whitespace-nowrap">대화 모델</span>
      <Select
        controlSize="sm"
        className="max-w-56"
        aria-label="컨셉 파트너 모델"
        value={value}
        disabled={busy || update.isPending}
        aria-invalid={update.isError || undefined}
        onChange={(e) => {
          const [providerProfileId, ...rest] = e.target.value.split("|");
          const modelId = rest.join("|");
          if (providerProfileId && modelId) update.mutate({ role: "concept_partner", patch: { providerProfileId, modelId } });
        }}
      >
        {!listed && <option value={value}>{binding.modelId}</option>}
        {options
          .filter((o) => o.connected || o.profileId === binding.providerProfileId)
          .map((o) => (
            <optgroup key={o.profileId} label={o.connected ? o.label : `${o.label} (연결 안 됨)`}>
              {o.models.map((m) => (
                <option key={m.id} value={`${o.profileId}|${m.id}`} disabled={!o.connected}>
                  {m.label}
                  {m.unpriced ? " · 단가 미등록" : ""}
                </option>
              ))}
            </optgroup>
          ))}
      </Select>
      {update.error && (
        <span role="alert" className="max-w-48 truncate text-danger" title={errorMessage(update.error)}>
          {errorMessage(update.error)}
        </span>
      )}
    </label>
  );
}
