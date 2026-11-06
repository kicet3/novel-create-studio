/**
 * DTOs of the `llm` module (ProviderProfile, RoleModelBinding, ProviderCall, connection test).
 * Owned by the llm module agent (CONVENTIONS §0). Never import server code here.
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime } from "./common.js";

// ── web search (설계 추가 0011: 인터넷 검색) ─────────────────────────────────
/** One source a model used through web search (provider_calls.response.webSearch.citations, concept message `sources`). */
export const llmWebSourceSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),
  /** ISO time the call that found it returned */
  retrievedAt: z.string(),
});
export type LlmWebSource = z.infer<typeof llmWebSourceSchema>;

/** web search outcome of one call: used / allowed but not used / disabled for the novel / unsupported by the provider lane */
export const llmWebSearchStatusSchema = z.enum(["used", "not_used", "disabled", "unsupported"]);
export type LlmWebSearchStatus = z.infer<typeof llmWebSearchStatusSchema>;

/** smallest / largest per-call search cap (novels.web_search_max_uses CHECK) */
export const WEB_SEARCH_MAX_USES_RANGE = { min: 1, max: 10 } as const;

// ── provider profile ─────────────────────────────────────────────────────
/** One entry of `provider_profiles.models` (prices: micro-USD per 1M tokens; null = unpriced → budget `unpriced`). */
export const llmProviderModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  input_price_micros_per_mtok: z.number().int().nonnegative().nullable(),
  output_price_micros_per_mtok: z.number().int().nonnegative().nullable(),
  cached_input_price_micros_per_mtok: z.number().int().nonnegative().nullable().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  max_context_tokens: z.number().int().positive().optional(),
  model_version: z.string().optional(),
  /** switched off by the user: listed but not offered for new bindings / defaults (a bound model cannot be disabled) */
  disabled: z.boolean().optional(),
});
export type LlmProviderModel = z.infer<typeof llmProviderModelSchema>;

export const llmProviderProfileDtoSchema = z.object({
  id: z.string(),
  providerKind: z.enum(ENUMS.provider_kind),
  provider: z.string(),
  versionNo: z.number().int(),
  models: z.array(llmProviderModelSchema),
  priceSourceUrl: z.string(),
  verifiedAt: isoDateTime,
  retentionPolicyUrl: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type LlmProviderProfileDto = z.infer<typeof llmProviderProfileDtoSchema>;

export const llmProviderProfileListSchema = z.object({ items: z.array(llmProviderProfileDtoSchema) });

export const llmUpdateProviderProfileRequestSchema = z
  .object({
    models: z.array(llmProviderModelSchema).min(1).optional(),
    priceSourceUrl: z.string().min(1).optional(),
    /** ISO time the prices were checked (default: now when models/priceSourceUrl change) */
    verifiedAt: z.string().datetime({ offset: true }).optional(),
    retentionPolicyUrl: z.string().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "변경할 항목이 없습니다." });
export type LlmUpdateProviderProfileRequest = z.infer<typeof llmUpdateProviderProfileRequestSchema>;

// ── connection test (POST /api/llm/test) ─────────────────────────────────
export const llmTestRequestSchema = z.object({
  /** default: the install's configured provider */
  provider: z.enum(["anthropic", "claude_code", "openai", "xai", "google"]).optional(),
  modelId: z.string().min(1).optional(),
});
export type LlmTestRequest = z.infer<typeof llmTestRequestSchema>;

export const llmTestResponseSchema = z.object({
  provider: z.string(),
  modelId: z.string().nullable(),
  status: z.enum(ENUMS.health_status),
  errorFamily: z.enum(ENUMS.error_family).nullable(),
  message: z.string(),
  checkedAt: isoDateTime,
});
export type LlmTestResponse = z.infer<typeof llmTestResponseSchema>;

// ── role model bindings ──────────────────────────────────────────────────
export const roleModelBindingDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  agentRole: z.enum(ENUMS.agent_role),
  providerProfileId: z.string(),
  modelId: z.string(),
  maxOutputTokens: z.number().int(),
  fallbackModelId: z.string().nullable(),
  fallbackEnabled: z.boolean(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type RoleModelBindingDto = z.infer<typeof roleModelBindingDtoSchema>;

export const roleModelBindingListSchema = z.object({ items: z.array(roleModelBindingDtoSchema) });

export const roleModelBindingParamsSchema = z.object({ role: z.enum(ENUMS.agent_role) });

export const updateRoleModelBindingRequestSchema = z
  .object({
    providerProfileId: z.string().regex(/^prv_/).optional(),
    modelId: z.string().min(1).optional(),
    maxOutputTokens: z.number().int().positive().max(128_000).optional(),
    fallbackModelId: z.string().min(1).nullable().optional(),
    fallbackEnabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "변경할 항목이 없습니다." });
export type UpdateRoleModelBindingRequest = z.infer<typeof updateRoleModelBindingRequestSchema>;

// ── provider calls (GET …/runs/:runId/provider-calls) ────────────────────
export const providerCallDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  runId: z.string(),
  seq: z.number().int(),
  providerKind: z.enum(ENUMS.provider_kind),
  provider: z.string(),
  modelId: z.string(),
  modelVersion: z.string().nullable(),
  idempotencyKey: z.string(),
  requestHash: z.string(),
  maxOutputTokens: z.number().int().nullable(),
  maxCostMicros: z.number().int(),
  reservationId: z.string(),
  status: z.enum(ENUMS.provider_call_status),
  responseStorageKey: z.string().nullable(),
  response: z.unknown().nullable(),
  usage: z.unknown().nullable(),
  errorFamily: z.enum(ENUMS.error_family).nullable(),
  retryOfCallId: z.string().nullable(),
  sentAt: isoDateTime.nullable(),
  respondedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type ProviderCallDto = z.infer<typeof providerCallDtoSchema>;

export const providerCallListSchema = z.object({ items: z.array(providerCallDtoSchema) });
export const providerCallParamsSchema = z.object({ runId: z.string().regex(/^run_/) });

// ── provider connections (GET/PUT/DELETE /api/providers/…) ───────────────
/** Production LLM providers. Claude = anthropic, GPT = openai, Grok = xai, Gemini = google. */
export const LLM_PROVIDER_IDS = ["anthropic", "openai", "xai", "google"] as const;
/**
 * Providers a role binding / provider profile can call (ProviderProfile.provider). Same as LLM_PROVIDER_IDS plus
 * "claude_code": Claude through the user's own subscription by running the unmodified Claude Code CLI (`claude -p`);
 * it is a connection method of the Claude row (`claude_cli`), with its own zero-priced profile.
 */
export const LLM_CALL_PROVIDER_IDS = ["anthropic", "claude_code", "openai", "xai", "google"] as const;
export const llmCallProviderIdSchema = z.enum(LLM_CALL_PROVIDER_IDS);
export type LlmCallProviderId = z.infer<typeof llmCallProviderIdSchema>;
export const llmProviderIdSchema = z.enum(LLM_PROVIDER_IDS);
export type LlmProviderId = z.infer<typeof llmProviderIdSchema>;

/**
 * How a provider is connected:
 * - api_key: the provider's developer API key (Claude Console, OpenAI, xAI, Google AI Studio);
 * - chatgpt_oauth: ChatGPT sign-in through OpenAI's Codex client (browser PKCE or device code), Codex backend;
 * - xai_oauth: xAI account sign-in (device code; not documented by xAI → experimental);
 * - claude_cli: Claude subscription through the unmodified Claude Code CLI the user installed and signed in to
 *   themselves (`claude auth login` in a terminal). The app never reads/stores Claude.ai credentials; calls run
 *   `claude -p` (provider "claude_code"). Disconnecting only deactivates the method in the app.
 */
export const PROVIDER_CONNECTION_METHODS = ["api_key", "chatgpt_oauth", "xai_oauth", "claude_cli"] as const;
export const providerConnectionMethodSchema = z.enum(PROVIDER_CONNECTION_METHODS);
export type ProviderConnectionMethod = z.infer<typeof providerConnectionMethodSchema>;

export const providerMethodInfoSchema = z.object({
  method: providerConnectionMethodSchema,
  /** "api_key" input, or OAuth login flows offered for this method */
  flows: z.array(z.enum(["api_key", "browser", "device", "import_codex", "cli"])),
  label: z.string(),
  /** documented by the provider for third-party apps */
  official: z.boolean(),
  experimental: z.boolean(),
  note: z.string(),
  /** a credential for this method is stored (or given by env for api_key) */
  configured: z.boolean(),
  /** where the api key comes from */
  source: z.enum(["secret", "env"]).nullable(),
  /**
   * "dev_only": a subscription / OAuth method (Claude subscription CLI, ChatGPT sign-in, xAI sign-in) on a server not in
   * dev mode (`pnpm dev` / NCS_DEV_MODE=1) — listed but not usable; a stored session is kept but ignored for calls.
   */
  availability: z.enum(["available", "dev_only"]).default("available"),
  /** user-facing Korean reason when not available */
  unavailableReason: z.string().nullable().default(null),
});
export type ProviderMethodInfo = z.infer<typeof providerMethodInfoSchema>;

export const providerConnectionHealthSchema = z.enum(["healthy", "warning", "reauth_required", "not_connected"]);

export const providerStatusDtoSchema = z.object({
  provider: llmProviderIdSchema,
  /** Korean display name, e.g. "Claude (Anthropic)" */
  label: z.string(),
  connected: z.boolean(),
  /** method used for calls (null = not connected) */
  activeMethod: providerConnectionMethodSchema.nullable(),
  methods: z.array(providerMethodInfoSchema),
  /** methods that exist on the provider side but are not offered, with the reason */
  unsupported: z.array(z.object({ label: z.string(), reason: z.string() })),
  health: providerConnectionHealthSchema,
  /** masked account info of the OAuth session (never tokens) */
  account: z.object({ email: z.string().nullable(), plan: z.string().nullable(), accountId: z.string().nullable() }).nullable(),
  /** OAuth access-token expiry (refreshed automatically when a refresh token exists) */
  expiresAt: isoDateTime.nullable(),
  /** user-facing Korean note on the provider's terms */
  termsNote: z.string(),
  /** the provider has an image-generation API */
  imageGeneration: z.boolean(),
  /** this provider is the install default for new novels (Claude row: either Claude lane) */
  isDefault: z.boolean(),
  /**
   * Claude row only: state of the local Claude Code CLI (`claude auth status`: installed / signed in / auth method;
   * never credentials) and whether the subscription method is active in this app. null for other providers.
   */
  claudeCli: z
    .object({
      installed: z.boolean(),
      loggedIn: z.boolean(),
      /** "claude.ai" = Claude subscription; other values (e.g. API key login) are not the subscription */
      authMethod: z.string().nullable(),
      /** the user deactivated the method in this app (CLI login untouched) */
      enabled: z.boolean(),
      /** usable for calls: installed + signed in with a subscription + enabled */
      usable: z.boolean(),
      message: z.string(),
      checkedAt: isoDateTime,
    })
    .nullable(),
});
export type ProviderStatusDto = z.infer<typeof providerStatusDtoSchema>;
export const providerStatusListSchema = z.object({ items: z.array(providerStatusDtoSchema) });

export const providerParamsSchema = z.object({ provider: llmProviderIdSchema });
export const providerApiKeyRequestSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(8, "API 키가 너무 짧습니다.")
    .max(4_000)
    .refine((v) => !/[\s\u0000-\u001f\u007f]/.test(v), "API 키에 공백이나 제어 문자를 넣을 수 없습니다."),
});
export type ProviderApiKeyRequest = z.infer<typeof providerApiKeyRequestSchema>;

export const providerDisconnectQuerySchema = z.object({ method: providerConnectionMethodSchema.optional() });
export const providerActiveMethodRequestSchema = z.object({ method: providerConnectionMethodSchema });
export const providerTestRequestSchema = z.object({ modelId: z.string().min(1).optional(), method: providerConnectionMethodSchema.optional() });
/** GET /api/providers?refresh=1 re-runs `claude auth status` instead of using the short cache */
export const providerListQuerySchema = z.object({ refresh: z.enum(["0", "1", "true", "false"]).optional() });

export const providerOAuthStartRequestSchema = z.object({ flow: z.enum(["browser", "device"]) });
export const providerOAuthSessionParamsSchema = z.object({ provider: llmProviderIdSchema, sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) });

export const providerOAuthSessionDtoSchema = z.object({
  sessionId: z.string(),
  provider: llmProviderIdSchema,
  flow: z.enum(["browser", "device"]),
  status: z.enum(["pending", "complete", "error", "expired", "cancelled"]),
  /** browser: authorize URL to open; device: page where the user enters the code */
  verificationUrl: z.string().nullable(),
  userCode: z.string().nullable(),
  expiresAt: isoDateTime,
  /** Korean message on error/expiry */
  message: z.string().nullable(),
  /** masked e-mail after completion */
  accountEmail: z.string().nullable(),
});
export type ProviderOAuthSessionDto = z.infer<typeof providerOAuthSessionDtoSchema>;

// ── model management (install settings → 모델) ──────────────────────────
/** model id as providers spell it (letters, digits, `.-_:/@[]`), e.g. `claude-sonnet-5-5`, `models/gemini-4-argon`, `opus` */
export const llmModelIdSchema = z
  .string()
  .trim()
  .min(1, "모델 ID를 입력하세요.")
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]*$/, "모델 ID에는 영문·숫자·.-_:/@[] 만 쓸 수 있습니다.");

const price = z.number().int().nonnegative().max(1_000_000_000).nullable();

/** POST /api/llm/provider-profiles/:profileId/models — adds a model (new profile version). Prices: micro-USD per 1M tokens; null/omitted = unpriced. */
export const llmAddModelRequestSchema = z.object({
  id: llmModelIdSchema,
  label: z.string().trim().min(1).max(120).optional(),
  input_price_micros_per_mtok: price.default(null),
  output_price_micros_per_mtok: price.default(null),
  cached_input_price_micros_per_mtok: price.optional(),
  max_output_tokens: z.number().int().positive().max(10_000_000).optional(),
  max_context_tokens: z.number().int().positive().max(100_000_000).optional(),
});
export type LlmAddModelRequest = z.input<typeof llmAddModelRequestSchema>;

/** PATCH /api/llm/provider-profiles/:profileId/models/:modelId — edits one model (new profile version); `label: null` clears it */
export const llmEditModelRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(120).nullable().optional(),
    input_price_micros_per_mtok: price.optional(),
    output_price_micros_per_mtok: price.optional(),
    cached_input_price_micros_per_mtok: price.optional(),
    max_output_tokens: z.number().int().positive().max(10_000_000).nullable().optional(),
    max_context_tokens: z.number().int().positive().max(100_000_000).nullable().optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "변경할 항목이 없습니다." });
export type LlmEditModelRequest = z.infer<typeof llmEditModelRequestSchema>;

export const llmProfileModelParamsSchema = z.object({ profileId: z.string().regex(/^prv_/), modelId: z.string().min(1).max(200) });

/** 409 `model_in_use` details: who still uses the model (remove / disable refused) */
export const llmModelUsageSchema = z.object({
  modelId: z.string(),
  bindings: z.array(z.object({ novelId: z.string(), novelTitle: z.string().nullable(), agentRole: z.enum(ENUMS.agent_role), asFallback: z.boolean() })),
  /** roles whose 새 작품 기본 모델 is this model */
  defaults: z.array(z.enum(ENUMS.agent_role)),
});
export type LlmModelUsage = z.infer<typeof llmModelUsageSchema>;

/** GET /api/llm/providers/:provider/available-models — the provider's own model list (API key lanes) or a fixed list (Claude subscription CLI) */
export const llmAvailableModelsSchema = z.object({
  provider: llmCallProviderIdSchema,
  /** "api": listed by the provider API with the connected key; "fixed": known list (claude_code: what `claude --model` accepts) */
  source: z.enum(["api", "fixed"]),
  items: z.array(
    z.object({
      id: z.string(),
      label: z.string().nullable(),
      maxContextTokens: z.number().int().nullable(),
      maxOutputTokens: z.number().int().nullable(),
      /** already in the active profile */
      inProfile: z.boolean(),
    }),
  ),
});
export type LlmAvailableModels = z.infer<typeof llmAvailableModelsSchema>;
export const llmCallProviderParamsSchema = z.object({ provider: llmCallProviderIdSchema });

// ── 새 작품 기본 모델 (install level, role_model_defaults) ─────────────────
export const roleModelDefaultDtoSchema = z.object({
  agentRole: z.enum(ENUMS.agent_role),
  provider: llmCallProviderIdSchema,
  modelId: z.string(),
  /** "custom": set by the user; "builtin": the install default provider's built-in model (no row) */
  source: z.enum(["custom", "builtin"]),
  /** the default can be used now (active profile lists the model enabled, provider usable on this server) */
  usable: z.boolean(),
});
export type RoleModelDefaultDto = z.infer<typeof roleModelDefaultDtoSchema>;
export const roleModelDefaultListSchema = z.object({ items: z.array(roleModelDefaultDtoSchema) });

/** PUT /api/llm/role-defaults — set the default of the listed roles (other roles unchanged) */
export const updateRoleModelDefaultsRequestSchema = z.object({
  items: z
    .array(z.object({ agentRole: z.enum(ENUMS.agent_role), provider: llmCallProviderIdSchema, modelId: z.string().min(1).max(200) }))
    .min(1)
    .max(ENUMS.agent_role.length)
    .refine((v) => new Set(v.map((x) => x.agentRole)).size === v.length, { message: "같은 역할을 두 번 지정할 수 없습니다." }),
});
export type UpdateRoleModelDefaultsRequest = z.infer<typeof updateRoleModelDefaultsRequestSchema>;
/** DELETE /api/llm/role-defaults?role= — back to built-in (all roles when omitted) */
export const resetRoleModelDefaultsQuerySchema = z.object({ role: z.enum(ENUMS.agent_role).optional() });
