/**
 * llm — public API (design/04 §6.2–6.3, §10; ADR-010; FR-AGT-08, NFR-EXT-01).
 * Owns: provider_profiles (install), role_model_bindings, provider_calls.
 *
 * Vendor confinement (08 §3.2): only `modules/llm/adapters/**` may import `@anthropic-ai/sdk`.
 * Adapters: `anthropic` (official Anthropic SDK, Claude API; API key from system.secrets
 * "llm.anthropic.api_key" or ANTHROPIC_API_KEY), `claude_code` (the user's Claude subscription through the
 * unmodified Claude Code CLI, `claude -p`), `openai`, `xai`, `google`. Tests run the real adapters
 * against local mock HTTP servers (`llm.endpoints.*`) with responses scripted per test.
 *
 * Other modules never call an adapter directly: they use `ModelCallPort.call()` with their RunHandle,
 * which resolves the RoleModelBinding, reserves budget, records ProviderCall P1–P5, reuses responses
 * on rerun (RU-1..4), validates structured output with zod and retries per 04 §7.
 */
import type { z } from "zod";
import type { AgentRole, ErrorFamily } from "@ncs/shared";
import type { ProviderCallsRow, ProviderProfilesRow, RoleModelBindingsRow } from "@ncs/db/schema";
import type { ActorRef, NovelScope, Tx } from "../../platform/index.js";
import type { RunHandle } from "../orchestration/index.js";
import type { ProviderConnections } from "./application/connections.js";
export type { ProviderConnections } from "./application/connections.js";

export type ProviderProfile = ProviderProfilesRow;
export type RoleModelBinding = RoleModelBindingsRow;
export type ProviderCall = ProviderCallsRow;

// ── provider SPI (04 §10.2, verbatim shape; money as number micro-USD) ──
export interface LlmCapabilities {
  structuredOutput: "json_schema" | "tool_call" | "none";
  maxContextTokens: number;
  maxOutputTokens: number;
  promptCaching: boolean;
  reportsUsage: boolean;
  reportsCost: boolean;
  outputLimitCoversReasoning: boolean | "unknown";
  /**
   * "subscription": calls are covered by the user's plan (Claude subscription via `claude -p`) — the ledger records
   * the profile price (0); a provider-reported cost is a list-price estimate kept in provider_calls.usage only.
   * Default "per_call".
   */
  billing?: "per_call" | "subscription";
}

/** `claude auth status` projection (installed / signed in / auth method — never credentials) */
export interface LlmCliStatus {
  installed: boolean;
  loggedIn: boolean;
  authMethod: string | null;
  message: string;
}

export interface LlmEnvironmentCheck {
  status: "pass" | "warn" | "fail";
  errorFamily?: ErrorFamily;
  remainingBalanceMicros?: number;
  message: string;
}

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
  cacheBoundary?: boolean;
}

export type LlmOutputSpec = { kind: "text" } | { kind: "object"; schemaName: string; jsonSchema: Record<string, unknown> };

export interface LlmRequest {
  modelId: string;
  system: string;
  messages: LlmMessage[];
  output: LlmOutputSpec;
  maxOutputTokens: number;
  temperature?: number;
  seed?: number;
  /** Non-hashed call metadata (purpose, role, sample index); adapters may ignore it. Never put secrets here. */
  meta?: { purpose: string; role?: AgentRole; sampleIndex?: number; repairAttempt?: number };
}

/**
 * Resolved credential for one provider (application/credentials.ts). Never logged, never returned over HTTP.
 * `apiKey` in the options below is always `credential.token` (kept for adapters that only know API keys).
 */
export interface LlmCredential {
  method: "api_key" | "chatgpt_oauth" | "xai_oauth" | "claude_cli";
  /** API key or OAuth access token (claude_cli: a fixed non-secret marker — the CLI holds its own login) */
  token: string;
  /** extra request headers bound to the credential (e.g. `chatgpt-account-id`) */
  headers?: Record<string, string>;
  /**
   * OAuth only: the provider rejected `token` (401) → refresh once (single-flight) and return the new credential,
   * or null when the session cannot be refreshed (re-login needed).
   */
  refresh?(): Promise<LlmCredential | null>;
}

export interface LlmInvokeOptions {
  apiKey: string;
  credential?: LlmCredential;
  signal: AbortSignal;
  timeoutMs: number;
  idempotencyKey?: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  reportedCostMicros?: number;
}

export type LlmResult =
  | {
      ok: true;
      text?: string;
      object?: unknown;
      finishReason: "stop" | "length" | "content_filter" | "other";
      usage: LlmUsage;
      modelVersion?: string;
      providerRequestId?: string;
      raw: unknown;
    }
  | {
      ok: false;
      errorFamily: ErrorFamily;
      message: string;
      httpStatus?: number;
      retryNotBefore?: Date;
      billed: "yes" | "no" | "unknown";
      usage?: LlmUsage;
      providerRequestId?: string;
    };

export interface LlmAdapter {
  /** ProviderProfile.provider, e.g. "anthropic", "openai" */
  readonly provider: string;
  capabilities(modelId: string): LlmCapabilities;
  testEnvironment(input: { apiKey: string; credential?: LlmCredential; modelId?: string; signal: AbortSignal }): Promise<LlmEnvironmentCheck>;
  countInputTokens?(req: LlmRequest, opts: { apiKey: string; credential?: LlmCredential; signal: AbortSignal }): Promise<number>;
  /** one call; never throws (errors are results) */
  invoke(req: LlmRequest, opts: LlmInvokeOptions): Promise<LlmResult>;
  /** gateway limits for this adapter: concurrent calls (others wait for a slot) and per-call timeout */
  readonly limits?: { maxConcurrent?: number; callTimeoutMs?: number };
  /** local CLI adapters (claude_code): installation / sign-in state, no credentials read */
  status?(signal?: AbortSignal): Promise<LlmCliStatus>;
}

// ── port used by agents / task handlers ──
export interface ModelCallInput<T> {
  run: RunHandle;
  /** e.g. "draft", "repair", "l4_sample" */
  purpose: string;
  sampleIndex?: number;
  system: string;
  messages: LlmMessage[];
  output: { kind: "text" } | { kind: "object"; schemaName: string; schema: z.ZodType<T> };
  maxOutputTokens?: number;
  temperature?: number;
}

export interface ModelCallOutput<T> {
  providerCallId: string;
  reused: boolean;
  value: T | string;
  usage: LlmUsage;
  costMicros: number;
  modelId: string;
  modelVersion?: string;
}

export interface ModelCallPort {
  call<T>(input: ModelCallInput<T>): Promise<ModelCallOutput<T>>;
}

/** thrown by ModelCallPort.call; the engine maps errorFamily via 04 §7.2 */
export class ModelCallError extends Error {
  constructor(
    readonly errorFamily: ErrorFamily,
    readonly providerCallId: string | null,
    readonly retryNotBefore?: Date,
    message?: string,
  ) {
    super(message ?? errorFamily);
    this.name = "ModelCallError";
  }
  get retryable(): boolean {
    return !["auth_failed", "content_filtered", "budget_blocked"].includes(this.errorFamily);
  }
}

export interface ProviderProfilePatch {
  models?: unknown[];
  priceSourceUrl?: string;
  verifiedAt?: Date;
  retentionPolicyUrl?: string | null;
  isActive?: boolean;
}

export interface LlmConnectionTestResult {
  provider: string;
  modelId: string | null;
  status: "pass" | "warn" | "fail";
  errorFamily: ErrorFamily | null;
  message: string;
  checkedAt: Date;
}

export interface BindingPatch {
  providerProfileId?: string;
  modelId?: string;
  maxOutputTokens?: number;
  fallbackModelId?: string | null;
  fallbackEnabled?: boolean;
}

export interface LlmService {
  readonly modelCalls: ModelCallPort;
  /** provider connections: status, API keys, OAuth sign-in (ChatGPT / xAI), disconnect — install level */
  readonly providers: ProviderConnections;
  /** cancels pending OAuth logins (module stop) */
  stop(): void;
  /**
   * Credential of the provider's active connection method (OAuth refreshed when near expiry; `refresh()` on 401).
   * For other modules that call a provider API outside the LLM gateway (module imaging). Never log / return it.
   */
  resolveCredential(provider: string): Promise<LlmCredential | null>;
  /** active `provider_kind='image'` profile (created / missing models appended) — the image catalog lives in imaging */
  ensureImageProviderProfile(provider: string, models: Array<{ id: string } & Record<string, unknown>>, priceSourceUrl: string): Promise<ProviderProfile>;
  registerAdapter(adapter: LlmAdapter): void;
  getAdapter(provider: string): LlmAdapter | undefined;
  /** N1 participant body: one binding per agent role incl. concept_partner (INV-NOV-06) — already implemented */
  createDefaultBindings(tx: Tx, scope: NovelScope): Promise<RoleModelBinding[]>;
  getBinding(scope: NovelScope, role: AgentRole, tx?: Tx): Promise<RoleModelBinding>;
  listBindings(scope: NovelScope): Promise<RoleModelBinding[]>;
  updateBinding(scope: NovelScope, role: AgentRole, patch: BindingPatch, actor: ActorRef): Promise<RoleModelBinding>;
  listProviderProfiles(): Promise<ProviderProfile[]>;
  /** install-level default profile for InstallConfig llm.provider (created on boot) — already implemented */
  ensureDefaultProviderProfile(): Promise<ProviderProfile>;
  /**
   * When the user did not choose `llm.provider`, there is no Anthropic API key and the Claude subscription (Claude Code
   * CLI signed in by the user, enabled in the app) is usable: make `claude_code` the default provider, ensure its
   * profile and move roles bound to unconnected providers to it. Runs at boot and after a connect / status refresh.
   * Only `claude auth status` runs; no credential is read. Returns true when it switched.
   */
  applyClaudeSubscriptionDefault(opts?: { refreshCli?: boolean }): Promise<boolean>;
  listProviderCalls(scope: NovelScope, runId: string): Promise<ProviderCall[]>;

  // ── additions (A2) ──
  getProviderProfile(profileId: string): Promise<ProviderProfile>;
  /** edits the profile in place (prices, active flag); audit `provider_profile.changed` (install level) */
  updateProviderProfile(profileId: string, patch: ProviderProfilePatch, actor: ActorRef): Promise<ProviderProfile>;
  /** FR-SET-03 llm_key: provider reachability with the stored key (no secrets in the result) */
  testConnection(input?: { provider?: string; modelId?: string; signal?: AbortSignal }): Promise<LlmConnectionTestResult>;
  /** sum of usage/cost recorded for a run (orchestration copies it to runs.* — 04 §8.6) */
  runUsage(
    scope: NovelScope,
    runId: string,
  ): Promise<{
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
    modelsUsed: string[];
    /** list-price estimate of subscription calls (claude_code; usage.reportedCostMicros) — not in costMicros / the ledger */
    subscriptionEstimateMicros: number;
  }>;
  /**
   * Reclaim hook (04 §6.2, FR-AGT-02 (3)), called by orchestration in the reclaim transaction:
   * P5 `sent` → `unknown` + budget.closeUnknown, P6 `prepared` → `abandoned` + budget.release.
   */
  recoverInterruptedRun(tx: Tx, scope: NovelScope, runId: string): Promise<{ unknown: number; abandoned: number }>;
}

export { MODEL_PRICES_MICROS_PER_MTOK } from "./domain/pricing.js";
export type { LlmModuleDeps } from "./module.js";
export { createLlmModule } from "./module.js";
