/** Provider / model choices for role bindings and 새 작품 기본 모델: active LLM profiles, enabled models, connection state. */
import type { LlmProviderProfileDto, ProviderStatusDto } from "@ncs/shared";
import { callProviderConnected } from "../api.js";
import { PROVIDER_LABEL } from "./InstallSections.js";

export interface ModelOption {
  id: string;
  label: string;
  unpriced: boolean;
}

export interface ProviderOption {
  profileId: string;
  provider: string;
  label: string;
  connected: boolean;
  /** enabled models only (switched-off models are not offered) */
  models: ModelOption[];
}

const ORDER = ["anthropic", "claude_code", "openai", "xai", "google"];

export function providerOptions(profiles: readonly LlmProviderProfileDto[], statuses: readonly ProviderStatusDto[]): ProviderOption[] {
  const connected = callProviderConnected(statuses);
  return profiles
    .filter((p) => p.isActive && p.providerKind === "llm")
    .map((p) => ({
      profileId: p.id,
      provider: p.provider,
      label: PROVIDER_LABEL[p.provider] ?? p.provider,
      connected: connected.get(p.provider) ?? false,
      models: p.models.filter((m) => !m.disabled).map((m) => ({ id: m.id, label: m.label ?? m.id, unpriced: m.input_price_micros_per_mtok === null || m.output_price_micros_per_mtok === null })),
    }))
    .sort((a, b) => ORDER.indexOf(a.provider) - ORDER.indexOf(b.provider));
}

/** "<provider label> · <model label>" for a binding / default */
export function modelDisplay(options: readonly ProviderOption[], provider: string, modelId: string): string {
  const p = options.find((o) => o.provider === provider);
  const m = p?.models.find((x) => x.id === modelId);
  return `${p?.label ?? PROVIDER_LABEL[provider] ?? provider} · ${m?.label ?? modelId}`;
}
