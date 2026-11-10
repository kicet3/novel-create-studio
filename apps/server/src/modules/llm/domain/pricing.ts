/**
 * Price table + cost math (04 §8.2, FR-BUD-03/04). Pure: no I/O.
 * Prices: micro-USD per 1M tokens (so cost_micros = tokens * price / 1e6).
 * Source: Anthropic pricing (claude-api reference, cached 2026-10-06):
 *   Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50 per MTok; cache reads Opus/Sonnet $0.20.
 *   Fable 5.1 $10 / $50 per MTok, cache reads $0.25 (claude-api reference models.md, checked 2026-11-10).
 */
import { DEFAULT_MODELS, EXTRA_CLAUDE_MODELS } from "@ncs/shared";

/** every Claude id this version offers: the defaults + the extras (Fable 5.1) */
export const CLAUDE_MODEL_IDS: readonly string[] = [...Object.values(DEFAULT_MODELS), ...Object.values(EXTRA_CLAUDE_MODELS)];

export interface ModelPrice {
  input: number | null;
  output: number | null;
  cachedInput?: number | null;
}

export const MODEL_PRICES_MICROS_PER_MTOK: Readonly<Record<string, ModelPrice>> = {
  [DEFAULT_MODELS.opus]: { input: 4_000_000, output: 20_000_000, cachedInput: 200_000 },
  [DEFAULT_MODELS.sonnet]: { input: 2_000_000, output: 10_000_000, cachedInput: 200_000 },
  [DEFAULT_MODELS.haiku]: { input: 100_000, output: 500_000, cachedInput: 10_000 },
  [EXTRA_CLAUDE_MODELS.fable]: { input: 10_000_000, output: 50_000_000, cachedInput: 250_000 },
};

/** Profile `models[]` entry as stored in provider_profiles.models (jsonb). */
export interface ProfileModelEntry {
  id: string;
  label?: string;
  input_price_micros_per_mtok: number | null;
  output_price_micros_per_mtok: number | null;
  cached_input_price_micros_per_mtok?: number | null;
  max_output_tokens?: number;
  max_context_tokens?: number;
  model_version?: string;
}

export const MODEL_LIMITS: Readonly<Record<string, { maxOutputTokens: number; maxContextTokens: number }>> = {
  [DEFAULT_MODELS.opus]: { maxOutputTokens: 128_000, maxContextTokens: 1_000_000 },
  [DEFAULT_MODELS.sonnet]: { maxOutputTokens: 128_000, maxContextTokens: 1_000_000 },
  [DEFAULT_MODELS.haiku]: { maxOutputTokens: 128_000, maxContextTokens: 1_000_000 },
  [EXTRA_CLAUDE_MODELS.fable]: { maxOutputTokens: 128_000, maxContextTokens: 1_000_000 },
};

const M = (usd: number) => Math.round(usd * 1_000_000);

/**
 * Default priced model lists of the other providers (micro-USD per 1M tokens; null = unpriced → the budget asks).
 * Sources (checked 2026-11-06): developers.openai.com/api/docs/pricing, docs.x.ai/developers/models,
 * aistudio.google.com/docs/pricing. Gemini 4 Argon doubles to $4/$20 on 2026-12-01 (edit the profile then).
 * `gpt-6-sol` is a ChatGPT sign-in model without a published API price.
 */
export const PROVIDER_DEFAULT_MODELS: Readonly<Record<string, readonly ProfileModelEntry[]>> = {
  openai: [
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", input_price_micros_per_mtok: M(2), output_price_micros_per_mtok: M(10), cached_input_price_micros_per_mtok: M(0.1), max_context_tokens: 272_000 },
    { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", input_price_micros_per_mtok: M(1), output_price_micros_per_mtok: M(5), cached_input_price_micros_per_mtok: M(0.05), max_context_tokens: 272_000 },
    { id: "gpt-6-luna", label: "GPT-6 Luna", input_price_micros_per_mtok: M(0.1), output_price_micros_per_mtok: M(0.5), cached_input_price_micros_per_mtok: M(0.01), max_context_tokens: 272_000 },
    { id: "gpt-6-astra", label: "GPT-6 Astra", input_price_micros_per_mtok: M(10), output_price_micros_per_mtok: M(50), cached_input_price_micros_per_mtok: M(1), max_context_tokens: 272_000 },
    { id: "gpt-6-sol", label: "GPT-6 Sol (ChatGPT 로그인)", input_price_micros_per_mtok: null, output_price_micros_per_mtok: null, max_context_tokens: 272_000 },
  ],
  xai: [
    { id: "grok-4.7", label: "Grok 4.7", input_price_micros_per_mtok: M(2), output_price_micros_per_mtok: M(6), max_context_tokens: 500_000 },
    { id: "grok-4.3", label: "Grok 4.3", input_price_micros_per_mtok: M(1.25), output_price_micros_per_mtok: M(2.5), max_context_tokens: 1_000_000 },
    { id: "grok-4.20-0309-non-reasoning", label: "Grok 4.20 (non-reasoning)", input_price_micros_per_mtok: M(1.25), output_price_micros_per_mtok: M(2.5), max_context_tokens: 1_000_000 },
  ],
  google: [
    { id: "gemini-4-argon", label: "Gemini 4 Argon", input_price_micros_per_mtok: M(2), output_price_micros_per_mtok: M(10), max_output_tokens: 65_536, max_context_tokens: 1_000_000 },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", input_price_micros_per_mtok: M(0.75), output_price_micros_per_mtok: M(3.75), max_output_tokens: 65_536, max_context_tokens: 1_000_000 },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", input_price_micros_per_mtok: M(0.3), output_price_micros_per_mtok: M(2.5), max_output_tokens: 65_536, max_context_tokens: 1_000_000 },
  ],
};

export const PROVIDER_PRICE_SOURCE: Readonly<Record<string, string>> = {
  anthropic: "https://www.anthropic.com/pricing",
  claude_code: "https://claude.com/pricing",
  openai: "https://developers.openai.com/api/docs/pricing",
  xai: "https://docs.x.ai/developers/models",
  google: "https://aistudio.google.com/docs/pricing",
};

const CLAUDE_MODEL_LABELS: Readonly<Record<string, string>> = {
  [DEFAULT_MODELS.opus]: "Claude Opus 5.5",
  [DEFAULT_MODELS.sonnet]: "Claude Sonnet 5.5",
  [DEFAULT_MODELS.haiku]: "Claude Haiku 5.5",
  [EXTRA_CLAUDE_MODELS.fable]: "Claude Fable 5.1",
};

/**
 * Claude subscription lane (`claude -p`, provider "claude_code"): the Claude model ids at price 0 — a Pro/Max plan is
 * not billed per call, so the budget ledger records 0. The CLI's list-price estimate (`total_cost_usd`) is kept in
 * provider_calls.usage.reportedCostMicros and shown as an estimate only.
 */
export function claudeSubscriptionModels(): ProfileModelEntry[] {
  return CLAUDE_MODEL_IDS.map((id) => ({
    id,
    label: `${CLAUDE_MODEL_LABELS[id] ?? id} (구독)`,
    input_price_micros_per_mtok: 0,
    output_price_micros_per_mtok: 0,
    cached_input_price_micros_per_mtok: 0,
    max_output_tokens: MODEL_LIMITS[id]!.maxOutputTokens,
    max_context_tokens: MODEL_LIMITS[id]!.maxContextTokens,
  }));
}

/** Default `models` for a new profile (list prices; unknown providers get the Claude model set). */
export function defaultProfileModels(provider: string): ProfileModelEntry[] {
  if (provider === "claude_code") return claudeSubscriptionModels();
  const other = PROVIDER_DEFAULT_MODELS[provider];
  if (other) return other.map((m) => ({ ...m }));
  return CLAUDE_MODEL_IDS.map((id) => {
    const p = MODEL_PRICES_MICROS_PER_MTOK[id]!;
    const lim = MODEL_LIMITS[id]!;
    return {
      id,
      input_price_micros_per_mtok: p.input,
      output_price_micros_per_mtok: p.output,
      cached_input_price_micros_per_mtok: p.cachedInput ?? null,
      max_output_tokens: lim.maxOutputTokens,
      max_context_tokens: lim.maxContextTokens,
    };
  });
}

/** default model per role tier for a provider (premium = planning roles, standard = the rest) */
export const PROVIDER_ROLE_DEFAULTS: Readonly<Record<string, { premium: string; standard: string }>> = {
  anthropic: { premium: DEFAULT_MODELS.opus, standard: DEFAULT_MODELS.opus },
  claude_code: { premium: DEFAULT_MODELS.opus, standard: DEFAULT_MODELS.opus },
  openai: { premium: "gpt-6.1-sol", standard: "gpt-6.1-terra" },
  xai: { premium: "grok-4.7", standard: "grok-4.3" },
  google: { premium: "gemini-4-argon", standard: "gemini-3.8-flash" },
};

export function parseProfileModels(models: unknown): ProfileModelEntry[] {
  if (!Array.isArray(models)) return [];
  return models.filter((m): m is ProfileModelEntry => !!m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string");
}

export function findModel(models: unknown, modelId: string): ProfileModelEntry | undefined {
  return parseProfileModels(models).find((m) => m.id === modelId);
}

/** true when both input and output prices are known (null = unpriced → 04 §8.4). */
export function isPriced(m: ProfileModelEntry | undefined): m is ProfileModelEntry & { input_price_micros_per_mtok: number; output_price_micros_per_mtok: number } {
  return !!m && typeof m.input_price_micros_per_mtok === "number" && typeof m.output_price_micros_per_mtok === "number";
}

/**
 * Rough token estimate without a tokenizer: Hangul/CJK ≈ 1 token per char, other text ≈ 1 token per
 * 4 chars. Used for reservations (with margin).
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3130 && c <= 0x318f) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

/** 04 §8.2 upper bound: ceil(input_upper × in_price) + max_output × out_price. null when unpriced. */
export function maxCallCostMicros(m: ProfileModelEntry | undefined, inputTokensUpper: number, maxOutputTokens: number): number | null {
  if (!isPriced(m)) return null;
  return Math.ceil((inputTokensUpper * m.input_price_micros_per_mtok) / 1_000_000) + Math.ceil((maxOutputTokens * m.output_price_micros_per_mtok) / 1_000_000);
}

export function inputTokensUpper(estimate: number, marginRatio: number): number {
  return Math.ceil(estimate * (1 + marginRatio));
}

/** Measured cost from usage; cached input tokens are billed at the cached price when known. */
export function usageCostMicros(
  m: ProfileModelEntry | undefined,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number },
): number | null {
  if (!isPriced(m)) return null;
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const cachedPrice = m.cached_input_price_micros_per_mtok ?? m.input_price_micros_per_mtok;
  return Math.ceil(
    ((usage.inputTokens - cached) * m.input_price_micros_per_mtok + cached * cachedPrice + usage.outputTokens * m.output_price_micros_per_mtok) / 1_000_000,
  );
}

// ── web search (설계 추가 0011) ──
/**
 * Price of one server-side web search in micro-USD (search tool fee only; result tokens are billed as input tokens).
 * Sources (checked 2026-11-06, unverified placeholders like the model prices above): Anthropic web search $10 / 1,000
 * searches; OpenAI Responses `web_search` tool $10 / 1,000 calls; Gemini grounding with Google Search $14 / 1,000
 * queries. The Claude subscription lane (claude_code) is plan-billed → 0. Providers without a lane that searches: absent.
 */
export const WEB_SEARCH_PRICE_MICROS: Readonly<Record<string, number>> = {
  anthropic: 10_000,
  claude_code: 0,
  openai: 10_000,
  google: 14_000,
};

/** reservation allowance: input tokens one search may add to the context (results) */
export const WEB_SEARCH_INPUT_TOKENS_ALLOWANCE = 12_000;

/** search fee of `requests` searches (0 when the provider has no price) */
export function webSearchCostMicros(provider: string, requests: number | undefined): number {
  return Math.max(0, requests ?? 0) * (WEB_SEARCH_PRICE_MICROS[provider] ?? 0);
}

/** reservation upper bound for `maxUses` searches: fee + result tokens at the input price; null when unpriced */
export function webSearchReserveMicros(provider: string, m: ProfileModelEntry | undefined, maxUses: number): number | null {
  if (!isPriced(m)) return null;
  return maxUses * ((WEB_SEARCH_PRICE_MICROS[provider] ?? 0) + Math.ceil((WEB_SEARCH_INPUT_TOKENS_ALLOWANCE * m.input_price_micros_per_mtok) / 1_000_000));
}
