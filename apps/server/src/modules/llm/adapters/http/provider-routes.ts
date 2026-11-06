/**
 * HTTP: provider connections (install level). Responses never contain API keys or tokens.
 *
 *   GET    /api/providers?refresh=1                         → {items: ProviderStatus[]} (refresh: re-run `claude auth status`)
 *   GET    /api/providers/:provider                         → ProviderStatus
 *   PUT    /api/providers/:provider/api-key   {apiKey}      → ProviderStatus
 *   PUT    /api/providers/:provider/active-method {method}  → ProviderStatus
 *   DELETE /api/providers/:provider/connection?method=      → ProviderStatus
 *   POST   /api/providers/:provider/test      {modelId?, method?} → LlmTestResponse (anthropic + claude_cli → claude_code)
 *   POST   /api/providers/anthropic/claude-cli              → ProviderStatus (switch the Claude subscription method on
 *          in this app and re-check `claude auth status`; the login itself is `claude auth login` in the user's terminal)
 *   POST   /api/providers/:provider/oauth     {flow}        → 201 OAuthSession (browser: authorize URL; device: code)
 *   GET    /api/providers/:provider/oauth/:sessionId        → OAuthSession (poll)
 *   DELETE /api/providers/:provider/oauth/:sessionId        → 204
 *   POST   /api/providers/openai/import-codex               → ProviderStatus (one-time copy of ~/.codex/auth.json)
 *
 * Outside dev mode (InstallConfig `dev_mode`) the subscription / OAuth routes (claude-cli, oauth start, import-codex,
 * active-method / test with an OAuth method) answer 422 `oauth_dev_only`; API-key routes are unaffected.
 */
import type { z } from "zod";
import {
  providerActiveMethodRequestSchema,
  providerApiKeyRequestSchema,
  providerDisconnectQuerySchema,
  providerListQuerySchema,
  providerOAuthSessionParamsSchema,
  providerOAuthStartRequestSchema,
  providerParamsSchema,
  providerTestRequestSchema,
  type LlmProviderId,
} from "@ncs/shared";
import { DomainValidationError, type ApiRouters } from "../../../../platform/index.js";
import { actorOf, created, valid, validate } from "../../../../http/kit.js";
import type { LlmService } from "../../index.js";
import { CLAUDE_CODE_PROVIDER, isDevOnlyMethod } from "../../domain/providers.js";
import { devOnlyError } from "../../application/connections.js";

type P = { provider: LlmProviderId };
type V<Params = P, B = unknown, Q = unknown> = { params: Params; body: B; query: Q };

export function mountProviderRoutes({ api }: ApiRouters, svc: LlmService): void {
  const providers = svc.providers;

  api.get("/providers", validate({ query: providerListQuerySchema }), async (_req, res) => {
    const { query } = valid<V<P, unknown, z.output<typeof providerListQuerySchema>>>(res);
    res.json({ items: await providers.list({ refresh: query.refresh === "1" || query.refresh === "true" }) });
  });
  api.post("/providers/anthropic/claude-cli", async (_req, res) => {
    res.json(await providers.connectClaudeCli(actorOf(res)));
  });
  api.get("/providers/:provider", validate({ params: providerParamsSchema }), async (_req, res) => {
    const { params } = valid<V>(res);
    res.json(await providers.status(params.provider));
  });
  api.put("/providers/:provider/api-key", validate({ params: providerParamsSchema, body: providerApiKeyRequestSchema }), async (_req, res) => {
    const { params, body } = valid<V<P, z.output<typeof providerApiKeyRequestSchema>>>(res);
    res.json(await providers.setApiKey(params.provider, body.apiKey, actorOf(res)));
  });
  api.put("/providers/:provider/active-method", validate({ params: providerParamsSchema, body: providerActiveMethodRequestSchema }), async (_req, res) => {
    const { params, body } = valid<V<P, z.output<typeof providerActiveMethodRequestSchema>>>(res);
    res.json(await providers.setActiveMethod(params.provider, body.method, actorOf(res)));
  });
  api.delete("/providers/:provider/connection", validate({ params: providerParamsSchema, query: providerDisconnectQuerySchema }), async (_req, res) => {
    const { params, query } = valid<V<P, unknown, z.output<typeof providerDisconnectQuerySchema>>>(res);
    res.json(await providers.disconnect(params.provider, query.method, actorOf(res)));
  });
  api.post("/providers/:provider/test", validate({ params: providerParamsSchema, body: providerTestRequestSchema }), async (_req, res) => {
    const { params, body } = valid<V<P, z.output<typeof providerTestRequestSchema>>>(res);
    if (!providers.devMode && isDevOnlyMethod(body.method)) throw devOnlyError(body.method!);
    const provider = body.method === "claude_cli" ? (params.provider === "anthropic" ? CLAUDE_CODE_PROVIDER : null) : params.provider;
    if (!provider) throw new DomainValidationError("method_unsupported", "이 공급자가 지원하지 않는 연결 방식입니다.");
    res.json(await svc.testConnection({ provider, modelId: body.modelId }));
  });
  api.post("/providers/:provider/oauth", validate({ params: providerParamsSchema, body: providerOAuthStartRequestSchema }), async (_req, res) => {
    const { params, body } = valid<V<P, z.output<typeof providerOAuthStartRequestSchema>>>(res);
    created(res, await providers.startLogin(params.provider, body.flow, actorOf(res)));
  });
  api.get("/providers/:provider/oauth/:sessionId", validate({ params: providerOAuthSessionParamsSchema }), async (_req, res) => {
    const { params } = valid<V<z.output<typeof providerOAuthSessionParamsSchema>>>(res);
    res.json(providers.getLogin(params.provider, params.sessionId));
  });
  api.delete("/providers/:provider/oauth/:sessionId", validate({ params: providerOAuthSessionParamsSchema }), async (_req, res) => {
    const { params } = valid<V<z.output<typeof providerOAuthSessionParamsSchema>>>(res);
    providers.cancelLogin(params.provider, params.sessionId);
    res.status(204).end();
  });
  api.post("/providers/:provider/import-codex", validate({ params: providerParamsSchema }), async (_req, res) => {
    const { params } = valid<V>(res);
    if (params.provider !== "openai") throw new DomainValidationError("import_unsupported", "Codex CLI 로그인 가져오기는 GPT에서만 쓸 수 있습니다.");
    res.json(await providers.importCodexSession(actorOf(res)));
  });
}
