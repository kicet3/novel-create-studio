/**
 * Model-list edits of a provider profile (install settings → 모델). Pure: no I/O.
 * Every edit returns the NEW models list; the service stores it as a new profile version (INV-PP-01) so cost events
 * keep the version they were priced with.
 */
import { DEFAULT_MODELS } from "@ncs/shared";
import { DomainValidationError } from "../../../platform/index.js";
import { defaultProfileModels, parseProfileModels, type ProfileModelEntry } from "./pricing.js";

export type ModelEntry = ProfileModelEntry & { disabled?: boolean };

export interface AddModelInput {
  id: string;
  label?: string;
  input_price_micros_per_mtok: number | null;
  output_price_micros_per_mtok: number | null;
  cached_input_price_micros_per_mtok?: number | null;
  max_output_tokens?: number;
  max_context_tokens?: number;
}

export interface EditModelInput {
  label?: string | null;
  input_price_micros_per_mtok?: number | null;
  output_price_micros_per_mtok?: number | null;
  cached_input_price_micros_per_mtok?: number | null;
  max_output_tokens?: number | null;
  max_context_tokens?: number | null;
  disabled?: boolean;
}

export const modelsOf = (models: unknown): ModelEntry[] => parseProfileModels(models) as ModelEntry[];

export const isEnabled = (m: ModelEntry | undefined): m is ModelEntry => !!m && m.disabled !== true;

export function addModel(models: unknown, input: AddModelInput): ModelEntry[] {
  const list = modelsOf(models);
  if (list.some((m) => m.id === input.id)) throw new DomainValidationError("model_exists", `이미 목록에 있는 모델입니다: ${input.id}`);
  const entry: ModelEntry = {
    id: input.id,
    ...(input.label ? { label: input.label } : {}),
    input_price_micros_per_mtok: input.input_price_micros_per_mtok,
    output_price_micros_per_mtok: input.output_price_micros_per_mtok,
    ...(input.cached_input_price_micros_per_mtok !== undefined ? { cached_input_price_micros_per_mtok: input.cached_input_price_micros_per_mtok } : {}),
    ...(input.max_output_tokens ? { max_output_tokens: input.max_output_tokens } : {}),
    ...(input.max_context_tokens ? { max_context_tokens: input.max_context_tokens } : {}),
  };
  return [...list, entry];
}

export function editModel(models: unknown, modelId: string, patch: EditModelInput): ModelEntry[] {
  const list = modelsOf(models);
  const i = list.findIndex((m) => m.id === modelId);
  if (i < 0) throw new DomainValidationError("model_not_in_profile", `공급자 프로필에 없는 모델입니다: ${modelId}`);
  const next: ModelEntry = { ...list[i]! };
  const setOrDrop = <K extends keyof ModelEntry>(k: K, v: ModelEntry[K] | null | undefined) => {
    if (v === undefined) return;
    if (v === null) delete next[k];
    else next[k] = v;
  };
  setOrDrop("label", patch.label);
  if (patch.input_price_micros_per_mtok !== undefined) next.input_price_micros_per_mtok = patch.input_price_micros_per_mtok;
  if (patch.output_price_micros_per_mtok !== undefined) next.output_price_micros_per_mtok = patch.output_price_micros_per_mtok;
  if (patch.cached_input_price_micros_per_mtok !== undefined) next.cached_input_price_micros_per_mtok = patch.cached_input_price_micros_per_mtok;
  setOrDrop("max_output_tokens", patch.max_output_tokens);
  setOrDrop("max_context_tokens", patch.max_context_tokens);
  if (patch.disabled !== undefined) {
    if (patch.disabled) next.disabled = true;
    else delete next.disabled;
  }
  const out = [...list];
  out[i] = next;
  if (!out.some(isEnabled)) throw new DomainValidationError("no_enabled_model", "켜진 모델이 하나는 있어야 합니다.");
  return out;
}

export function removeModel(models: unknown, modelId: string): ModelEntry[] {
  const list = modelsOf(models);
  if (!list.some((m) => m.id === modelId)) throw new DomainValidationError("model_not_in_profile", `공급자 프로필에 없는 모델입니다: ${modelId}`);
  const out = list.filter((m) => m.id !== modelId);
  if (!out.some(isEnabled)) throw new DomainValidationError("no_enabled_model", "켜진 모델이 하나는 있어야 합니다. 다른 모델을 먼저 추가하세요.");
  return out;
}

/** Model ids that stop being bindable going from `before` to `after` (removed or switched off). */
export function retiredModelIds(before: unknown, after: unknown): string[] {
  const next = new Map(modelsOf(after).map((m) => [m.id, m]));
  return modelsOf(before)
    .filter(isEnabled)
    .filter((m) => !isEnabled(next.get(m.id)))
    .map((m) => m.id);
}

export const resetModels = (provider: string): ModelEntry[] => defaultProfileModels(provider);

/**
 * Claude subscription lane (`claude -p --model <m>`): `claude --help` documents "an alias for the latest model (e.g.
 * 'fable', 'opus', or 'sonnet') or a model's full name" (checked 2026-11-06). Fixed list: the full ids of this
 * version's Claude models + those aliases. Prices 0 (covered by the plan).
 */
export function claudeCliKnownModels(): Array<{ id: string; label: string }> {
  return [
    { id: DEFAULT_MODELS.opus, label: "Claude Opus 5.5" },
    { id: DEFAULT_MODELS.sonnet, label: "Claude Sonnet 5.5" },
    { id: DEFAULT_MODELS.haiku, label: "Claude Haiku 5.5" },
    { id: "opus", label: "opus (CLI 별칭: 최신 Opus)" },
    { id: "sonnet", label: "sonnet (CLI 별칭: 최신 Sonnet)" },
    { id: "fable", label: "fable (CLI 별칭: 최신 Fable)" },
  ];
}
