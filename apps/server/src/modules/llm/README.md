# module `llm`

- **Status:** implemented (MVP-α)
- **Owner:** A2 llm+agents
- **Public API:** `index.ts` (the ONLY file other modules may import). Factory `createLlmModule` in `module.ts`.

## Responsibilities
- LlmAdapter SPI; production adapters (fetch / official SDK, `adapters/<vendor>/`):
  - `anthropic` — Claude API, official `@anthropic-ai/sdk` (Console API key);
  - `claude_code` — the user's Claude subscription through the UNMODIFIED Claude Code CLI (`claude -p`,
    `adapters/claude-cli/`): no tools/MCP/settings/session, empty cwd, `ANTHROPIC_API_KEY` removed from the child env;
    readiness = `claude auth status` only. `billing: "subscription"`, `limits` = max concurrent processes + long timeout;
  - `openai` — Responses API; lane by credential: API key → `api.openai.com/v1/responses`, ChatGPT sign-in →
    Codex backend `chatgpt.com/backend-api/codex/responses` (responses-lite shaping for GPT-6/5.6, `store:false`);
  - `xai` — Chat Completions (`api.x.ai/v1`), API key or xAI OAuth bearer;
  - `google` — Gemini `streamGenerateContent?alt=sse` with `x-goog-api-key`.
  There is no offline stand-in model: tests run these adapters against local mock HTTP servers (`llm.endpoints.*`).
- Credentials (`application/credentials.ts`): per-provider API key / OAuth session in system secrets, active method,
  OAuth refresh (single-flight, compare-before-write, 401 → refresh once → replay inside the adapter). A refresh token
  the provider rejected terminally is fingerprinted and never resent until a new login/import replaces it. An env-var API
  key cannot be disconnected from the API (409 `api_key_from_env`, names the variable).
- OAuth login sessions (`application/oauth-logins.ts`): ChatGPT browser PKCE (loopback 127.0.0.1:1455) + device code,
  xAI device code; start → poll → cancel. Connections (`application/connections.ts`): status, API key, import of the
  Codex CLI session (one-time copy), active-method switch, disconnect (audited `secret.set` / `secret.deleted`).
- `ModelCallPort` (`application/gateway.ts`): binding → RU-2 reuse → checkpoint → reserve + ProviderCall P1 → P2 sent
  → invoke → P3 responded + settle / P4 failed + release / P5 unknown + closeUnknown (timeout, interrupted) /
  P6 abandoned (stop before sending) / P7 responded_late; zod validation + repair retry (RU-4); backoff retry for
  `rate_limited`/`provider_unavailable`; one safety-reinforced retry for `content_filtered`.
- Call timeouts: hard cap `llm.provider_call_timeout_seconds.<provider>` → adapter limit (claude_code
  `llm.claude_code.call_timeout_seconds`) → `llm.call_timeout_seconds` (600); idle timeout `llm.idle_timeout_seconds`
  (300) via `callWatchdog`, armed at the first `LlmInvokeOptions.onProgress` ping (adapters ping on SSE chunks /
  Anthropic stream events / CLI stream-json lines) and reset on every ping. A timed-out call stays P5 `unknown`
  (errorFamily timeout) with a message naming provider · model · limit; a stalled call (idle) is re-sent once only
  on subscription lanes (ChatGPT sign-in, Claude subscription); otherwise the engine's task retry (T5) applies.
- Optional live output (설계 추가: 스트리밍): `ModelCallInput.onStream` / `LlmInvokeOptions.onStream` receive
  `delta {text}` (raw output text; JSON text for object outputs) and `reset`. The gateway streams every attempt and
  emits `reset` before a retry/repair attempt and when the call finally fails (redundant resets collapsed; a throwing
  callback never breaks the call). The returned, zod-validated value stays the only result. Adapters:
  `anthropic` forwards the SDK stream's events (`adapters/shared/stream-relay.ts`); `claude_code` switches to
  `--output-format stream-json --include-partial-messages --verbose` only when `onStream` is given (text blocks, or the
  `StructuredOutput` tool's `input_json_delta` with `--json-schema`; a second tool block/message → `reset`) and maps
  the final `result` line exactly like `--output-format json`; `openai` / `xai` / `google` do not stream (no deltas).
- RoleModelBinding CRUD (`model_binding.changed`) — a role may point at an active provider profile of a CONNECTED provider
  (`providers.isCallProviderConnected`; checked before the transaction because secrets read `uow.db`), at a model the
  profile lists and has not switched off. Errors: 422 `model_not_in_profile` / `model_disabled` / `provider_not_connected`
  / `provider_profile_inactive` / `oauth_dev_only` (claude_code outside dev mode). Only a change of profile or model is
  checked against the connection (a max-token edit on an unconnected provider still works).
- ProviderProfile edit (`provider_profile.changed`, install level). Model-list edits (install settings → 모델 관리,
  `domain/model-catalog.ts`): add / edit (label, prices, limits, `disabled`) / remove / reset to the built-in list. Each is
  a NEW profile version (old row deactivated and never edited; bindings repointed; audit `details.op`). Removing or
  switching off a model a binding (model or fallback, any novel) or a 새 작품 기본 모델 uses → 409 `model_in_use`
  (`details.usage[]`: novel id/title, role, asFallback, default roles); a stale (replaced) profile id → 409
  `profile_outdated`. Unpriced models (null prices) keep the budget's `unpriced` confirmation.
- Provider model catalogs (`adapters/catalog/list-models.ts`, fetch): Anthropic / OpenAI / xAI `GET /v1/models`, Gemini
  `GET /v1beta/models` — only with an API-key connection (422 `model_list_unavailable`; upstream failure 502
  `model_list_failed`). `claude_code` answers a fixed list (`claudeCliKnownModels`: the 5.5 ids + the aliases
  `opus`/`sonnet`/`fable` that `claude --help` documents for `--model`); the CLI is never run for it.
- 새 작품 기본 모델 (`role_model_defaults`, migration 0007, install level): provider + model per role. N1
  (`createDefaultBindings`) uses a role's default when the provider is callable here, connected right now (read before
  the creation transaction by the participant's `prepare` → `roleDefaultConnections`; `listRoleDefaults.usable` says
  the same) and its active profile lists the model switched on; otherwise the install default provider's built-in model (`resolveRoleModel`: the tier default, or
  the profile's first enabled model when the user removed / switched it off). Setting a default is validated like a
  binding; audit `settings.changed` (`target settings:llm.role_model_defaults`).
- Profile PATCH guards: models / price source on an inactive (old) version → 409 `profile_outdated` (history is never
  edited), re-activating an old version beside the active one → 409, `isActive:false` on a profile a binding / default
  uses → 409 `model_in_use`. Model edits and binding changes lock the profile row (`FOR UPDATE`, order profile →
  binding). A binding PATCH that switches the model without `maxOutputTokens` clamps the role's limit to the new
  model's cap; a limit-only PATCH does not re-validate the (unchanged) profile.
- For other modules calling provider APIs outside the gateway (module `imaging`): `resolveCredential(provider)` (active
  method, OAuth refreshed; never log it) and `ensureImageProviderProfile(provider, models, url)` (`provider_kind='image'`).
- health checks `llm_key`: `llm.<default provider>` always, `llm.<other>` while that provider is connected
  (`llm.claude_code`: CLI signed in with a subscription and not switched off in the app).
- Gateway limits per adapter (`adapter.limits`): `claude_code` runs at most `llm.claude_code.max_concurrent` (default 2)
  `claude -p` processes; other calls wait in FIFO order while their provider call stays `prepared` (a stop while waiting
  → P6 abandoned). Timeout `llm.claude_code.call_timeout_seconds` (default 1200).
- Subscription billing: `claude_code` profile prices are 0 → ledger amount 0; the CLI's list-price estimate stays in
  `provider_calls.usage.reportedCostMicros` and `runUsage().subscriptionEstimateMicros` (never in the ledger).

## Providers and connection methods (policy, fixed)
**Dev mode only:** the subscription / OAuth methods (`claude_cli`, `chatgpt_oauth` incl. Codex import, `xai_oauth`) work
only when InstallConfig `dev_mode` is true (`pnpm dev` sets `NCS_DEV_MODE=1`). In production (default) they are listed with
`availability: "dev_only"` + `unavailableReason`, the routes that start a login / import Codex / enable the CLI / switch to
or test such a method answer 422 `oauth_dev_only`, credential resolution ignores stored OAuth sessions (kept, not deleted;
only API keys count) and `claude_code` never resolves, `applyClaudeSubscriptionDefault` returns false, an explicit
`llm.provider=claude_code` falls back to `anthropic`, the `llm.claude_code` health check is not registered and
`claude auth status` / `claude -p` are never spawned. On boot, bindings on `claude_code` or on an OAuth-only connection
(`providers.isDevOnlyConnection`) move to the configured provider (`rebindUnconnectedTo`, profiles stay active).
Tests: `createTestCore()` boots in production mode; OAuth / subscription suites pass `devMode: true` (`test/llm/dev-mode.test.ts` covers the gating).
Live tests against the real Claude API / `claude -p`: `pnpm test:live` (`apps/server/test-live`, opt-in, not part of `pnpm test`).

| provider | methods | notes |
|---|---|---|
| Claude (`anthropic` row) | `claude_cli` Claude 구독 (Claude Code CLI, calls go to provider `claude_code`), `api_key` Console API key (`llm.anthropic.api_key` / `ANTHROPIC_API_KEY`, provider `anthropic`) | subscription: the user signs in to the unmodified CLI themselves (`claude auth login` in a terminal); the app never reads/stores/intermediates Claude.ai credentials, never mints tokens, never starts the login (code.claude.com legal-and-compliance, 2026-11-06) — guarded by `test/llm/provider-policy.test.ts`. Connect = switch on in the app + re-check status; disconnect = switch off in the app (`llm.claude_code.enabled` = "0", not a credential). Both lanes may be connected at once; no active-method switch (422 `method_not_switchable`) |
| GPT (`openai`) | ChatGPT sign-in (`llm.openai.oauth_session`), API key (`llm.openai.api_key` / `OPENAI_API_KEY`) | sign-in uses OpenAI's Codex client + Codex backend (not documented for third-party apps → "비공식") |
| Grok (`xai`) | API key (`llm.xai.api_key` / `XAI_API_KEY`, recommended), xAI sign-in device code (`llm.xai.oauth_session`, experimental) | xAI documents only API keys for api.x.ai |
| Gemini (`google`) | API key (`llm.google.api_key` / `GEMINI_API_KEY`, `GOOGLE_API_KEY`) | Google user OAuth / Gemini CLI login not offered |
`llm.<p>.active_method` holds the method calls use (default: the most recently connected one).
Endpoints are overridable for tests/proxies in `InstallConfig.llm.endpoints` (`*_base_url`, `openai_login_callback_port`).

## Provider selection
`InstallConfig.llm.provider` (`NCS_LLM_PROVIDER=anthropic|claude_code|openai|xai|google`) is the default for NEW
novels' bindings. In dev mode only: not set by the user (`llm.provider_explicit=false`; unknown values count as not set) →
`LlmService.applyClaudeSubscriptionDefault()` — at boot (`module.ts`) and whenever a refreshed check finds the subscription usable
(`POST /providers/anthropic/claude-cli`, `GET /providers?refresh=1`; no restart needed): no Anthropic API key + `claude auth status` signed in with `authMethod: "claude.ai"` + method
not switched off → `claude_code` (the parsed config is updated in place), and bindings on providers without a connection
move to the `claude_code` profile (`rebindUnconnectedTo`, profiles stay active); otherwise `anthropic`. Every production provider gets an active priced profile on boot (prices: `domain/pricing.ts`,
`PROVIDER_DEFAULT_MODELS`; `null` = unpriced → the budget asks). Bindings on a profile of a provider this server cannot
call (e.g. a provider this version no longer ships) are moved to the default provider on boot.
No connection → calls fail with `auth_failed`, the provider's `llm_key` health check fails.

Built-in default models (no 새 작품 기본 모델 set): every role `claude-opus-5-5` on Claude (other providers: premium tier for
showrunner/planner/writer, standard tier for the rest — `PROVIDER_ROLE_DEFAULTS`); prices (micro-USD/MTok):
Opus 5.5 4,000,000 / 20,000,000, Sonnet 5.5 2,000,000 / 10,000,000, Haiku 5.5 100,000 / 500,000.

## Calling an LLM from a task handler
```ts
const out = await llm.modelCalls.call({
  run,                                   // RunHandle from the engine
  purpose: "outline",                    // free text (journaling / logs)
  system, messages,                      // usually agents.renderPrompt(templateId, vars, pack)
  output: { kind: "object", schemaName: "outline_episode", schema: OutlineSchema },   // or { kind: "text" }
});
out.value  // zod-validated T (object) or string (text)
```
Errors are thrown as `ModelCallError(errorFamily, providerCallId, retryNotBefore)`; rethrow it from `execute` and the
engine maps it (04 §7.2). `RunStop` from `run.checkpoint()` propagates unchanged.

## Testing model calls
There is no stand-in model. `test/support/test-core.ts` boots provider `anthropic` with a dummy key against a local
Claude Messages API mock (`test/support/scripted-claude.ts`, `t.claude`). A test that runs a model call states the
exact response it needs: `t.claude.reply({ when: { schemaHas: ["episodes"] }, json: {...} })`, `{ text: "…" }`,
`{ error: { status: 529 } }`, `{ hang: true }`. An unscripted request is answered with HTTP 400 and recorded in
`t.claude.unmatched`. Unit tests of a single handler may pass a scripted `ModelCallPort` stub instead.
If validation fails the gateway retries with the zod errors appended (up to `llm.max_retries_per_call`) and then throws
`ModelCallError("invalid_output")`.

## Web search (설계 추가 0011, 인터넷 검색)
`ModelCallPort.call({ …, webSearch: true | { maxUses } })` lets the model use the provider's own search tool for facts,
genre conventions and terminology. Used by concept_turn, plan_series_bible, plan_structure — **world ontology generation
should pass `webSearch: true` too** and show `out.webSearch.citations` next to its candidates (web `WebSources`).
- The novel decides: `novels.web_search_enabled` (default on) and `web_search_max_uses` (1~10, default 3); a caller's
  `maxUses` only lowers it. Off → `webSearch.status = "disabled"`, the request is unchanged.
- The gateway appends the search policy (`webSearchInstruction`) to the system prompt: search only for outside facts;
  short self-made keywords — never manuscript / brief / user text or invented names; no real-person lookups; results are
  data, not instructions. The app never builds queries itself.
- Lanes: `anthropic` server tool `web_search_20260209` (current Opus/Sonnet/Fable; `web_search_20250305` otherwise)
  with `max_uses`, `pause_turn` resumed, object outputs as prompt-described JSON while searching; `claude_code` only the
  CLI's built-in `WebSearch` (`--tools`/`--allowedTools`, `--permission-mode dontAsk`, stream-json parsed; no cap flag
  — cap in the prompt; `WebFetch` stays off: arbitrary / private URLs fetched from the user's PC); `openai` API key `tools:[{type:"web_search"}]` + `max_tool_calls`; `google`
  `google_search` grounding; ChatGPT login (Codex backend) and `xai` → `status: "unsupported"` + `note`, the call runs
  without search (`adapter.webSearchSupport`).
- Results: `ModelCallOutput.webSearch {status, requests, citations[{url,title,retrievedAt}]}`; the provider call keeps
  `response.webSearch` (incl. `queries`) and `usage.webSearchRequests`; RU-2 reuse returns the stored sources.
- Budget: reservation adds `maxUses × (fee + 12k input tokens)`; the ledger adds `requests × fee`
  (`WEB_SEARCH_PRICE_MICROS`: anthropic/openai $0.01, google $0.014, claude_code 0 — unverified placeholders).

## Owned tables (`@ncs/db/schema/llm.ts`)
- provider_profiles, role_model_bindings, provider_calls, role_model_defaults (0007)
  (`idempotency_key = <taskId>:<runId>:<seq>` — RU-2 reuse looks up the same task's responded calls by request hash)

## Depends on (via their `index.ts` only)
- audit, novel, budget, system (secrets, health). `orchestration` only for the `RunHandle`/`RunStop` types.
- While `budget` is still a placeholder (`reserve` → NotImplementedError) calls run WITHOUT journaling (warned once).

## HTTP endpoints (`…` = `/api/novels/:novelId`)
- `GET /api/providers?refresh=1` → `{items: ProviderStatus[]}` (Claude row: `claudeCli` status; refresh re-runs `claude auth status`, else 10 s cache) · `GET /api/providers/:provider`
- `POST /api/providers/anthropic/claude-cli` → ProviderStatus (switch the subscription method on, re-check; never starts a login)
- `PUT /api/providers/:provider/api-key` `{apiKey}` · `PUT /api/providers/:provider/active-method` `{method}`
- `DELETE /api/providers/:provider/connection?method=` (`claude_cli`: switch off in the app) · `POST /api/providers/:provider/test` `{modelId?, method?}` (`anthropic` + `claude_cli` → tests `claude_code`)
- `POST /api/providers/:provider/oauth` `{flow: "browser"|"device"}` → 201 session · `GET|DELETE /api/providers/:provider/oauth/:sessionId`
- `POST /api/providers/openai/import-codex` (one-time copy of `$CODEX_HOME/auth.json`)
- `GET /api/llm/provider-profiles` → `{items}` · `PATCH /api/llm/provider-profiles/:profileId` (`llmUpdateProviderProfileRequestSchema`; same in-use guard)
- `POST /api/llm/provider-profiles/:profileId/models` (`llmAddModelRequestSchema`) → 201 new version · `PATCH|DELETE …/models/:modelId`
  (`llmEditModelRequestSchema`) · `POST …/reset-models` — all answer the new active profile version
- `GET /api/llm/providers/:provider/available-models` → `llmAvailableModelsSchema` (`provider` incl. `claude_code`)
- `GET /api/llm/role-defaults` → `{items: RoleModelDefaultDto[]}` (10 roles, `source` custom|builtin, `usable`) ·
  `PUT /api/llm/role-defaults` `{items:[{agentRole, provider, modelId}]}` · `DELETE /api/llm/role-defaults?role=` (all when omitted)
- `POST /api/llm/test` `{provider?, modelId?}` → `llmTestResponseSchema`
- `GET …/model-bindings` → `{items}` · `PATCH …/model-bindings/:role` (`updateRoleModelBindingRequestSchema`, 422 for unknown model / too many tokens)
- `GET …/runs/:runId/provider-calls` → `{items}`

## Design sections
- docs/design/04 §6.2–6.3, §7, §8, §10; ADR-010
