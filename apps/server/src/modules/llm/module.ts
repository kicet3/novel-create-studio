/**
 * llm module factory: Anthropic (Claude API) + Claude subscription (Claude Code CLI) + other providers + injected
 * extras, gateway, routes, N1 participant, boot-time default-provider detection.
 *
 * Dev mode (InstallConfig `dev_mode`, `pnpm dev`): only then are the subscription / OAuth methods usable. In production
 * the default provider is never the Claude subscription (an explicit `claude_code` falls back to anthropic), no
 * subscription detection runs, and role bindings on `claude_code` or on OAuth-only connections are rebound to the
 * configured provider at boot (stored OAuth sessions are kept for dev mode).
 */
import type { Platform, ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { BudgetService } from "../budget/index.js";
import type { NovelService } from "../novel/index.js";
import type { SystemService } from "../system/index.js";
import type { LlmAdapter, LlmService } from "./index.js";
import { AnthropicLlmAdapter } from "./adapters/anthropic/anthropic-adapter.js";
import { OpenAiLlmAdapter } from "./adapters/openai/openai-adapter.js";
import { XaiLlmAdapter } from "./adapters/xai/xai-adapter.js";
import { GeminiLlmAdapter } from "./adapters/google/gemini-adapter.js";
import { ClaudeCliLlmAdapter } from "./adapters/claude-cli/claude-cli-adapter.js";
import { mountProviderRoutes } from "./adapters/http/provider-routes.js";
import { mountLlmRoutes } from "./adapters/http/routes.js";
import { createLlmService } from "./application/llm-service.js";
import { ensureProviderProfile, rebindToConfiguredProvider, rebindUnconnectedTo } from "./adapters/db/bootstrap.js";
import { CLAUDE_CODE_PROVIDER, LLM_CALL_PROVIDERS } from "./domain/providers.js";

export interface LlmModuleDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  budget: BudgetService;
  /** secrets (API keys) + health-check registry (llm_key) */
  system: SystemService;
  /** extra adapters injected by the composition root (test seam; production passes none) */
  adapters?: LlmAdapter[];
  /** test seams for OAuth device-login polling */
  oauth?: { xaiPollFloorMs?: number; chatgptPollFloorMs?: number };
}

export function createLlmModule(deps: LlmModuleDeps): ServerModule<LlmService> {
  const devMode = deps.platform.config.dev_mode;
  if (!devMode && deps.platform.config.llm.provider === CLAUDE_CODE_PROVIDER) {
    deps.platform.log.warn({ configured: CLAUDE_CODE_PROVIDER }, "the Claude subscription (claude_code) is available only in dev mode (NCS_DEV_MODE=1); default LLM provider = anthropic");
    (deps.platform.config.llm as { provider: string }).provider = "anthropic";
  }
  const ep = deps.platform.config.llm.endpoints;
  const cc = deps.platform.config.llm.claude_code;
  const service = createLlmService({
    platform: deps.platform,
    audit: deps.audit,
    budget: deps.budget,
    system: deps.system,
    adapters: [
      new AnthropicLlmAdapter({ baseURL: ep.anthropic_api_base_url }),
      new OpenAiLlmAdapter({ apiBaseUrl: ep.openai_api_base_url, codexBaseUrl: ep.openai_codex_base_url, codexClientVersion: ep.openai_codex_client_version }),
      new XaiLlmAdapter({ apiBaseUrl: ep.xai_api_base_url }),
      new GeminiLlmAdapter({ apiBaseUrl: ep.google_api_base_url }),
      new ClaudeCliLlmAdapter({ bin: cc.bin, maxConcurrent: cc.max_concurrent, callTimeoutMs: cc.call_timeout_seconds * 1000 }),
      ...(deps.adapters ?? []),
    ],
    oauth: deps.oauth,
    novelTitles: async () => (await deps.novel.listNovels({ includeArchived: true })).map((n) => ({ id: n.id, title: n.title })),
  });
  deps.novel.registerCreationParticipant({
    module: "llm",
    order: 40,
    // connection state reads secrets through uow.db: before the creation transaction
    prepare: () => service.roleDefaultConnections(),
    async onNovelCreated(ctx) {
      await service.createDefaultBindings(ctx.tx, ctx.scope, ctx.prepared.llm as ReadonlySet<string> | undefined);
    },
  });
  return {
    name: "llm",
    implemented: true,
    service,
    routes: (r) => {
      mountLlmRoutes(r, service);
      mountProviderRoutes(r, service);
    },
    async start() {
      let detected = false;
      try {
        const llm = deps.platform.config.llm;
        // a restart keeps the detected default (not stored): re-detect, and re-apply the rebinding when already on it
        detected = (await service.applyClaudeSubscriptionDefault({ refreshCli: true })) || (!llm.provider_explicit && llm.provider === CLAUDE_CODE_PROVIDER);
      } catch (err) {
        deps.platform.log.warn({ err: (err as Error).message }, "Claude subscription detection failed; default LLM provider stays anthropic");
      }
      await service.ensureDefaultProviderProfile();
      // every production provider gets a priced profile so a role can be bound to any connected provider
      for (const p of LLM_CALL_PROVIDERS) await ensureProviderProfile(deps.platform, p);
      const moved = await rebindToConfiguredProvider(deps.platform, (p) => !!service.getAdapter(p));
      if (moved) deps.platform.log.info({ moved, provider: deps.platform.config.llm.provider }, "role model bindings moved to the configured LLM provider");
      if (!devMode) {
        // production: bindings on the subscription lane or on an OAuth-only connection go to the configured provider
        const rebound = await rebindUnconnectedTo(deps.platform, deps.platform.config.llm.provider, async (p) => !(await service.providers.isDevOnlyConnection(p)));
        if (rebound) deps.platform.log.info({ moved: rebound, provider: deps.platform.config.llm.provider }, "role model bindings on dev-only connections (subscription / OAuth) moved to the configured LLM provider");
      }
      if (detected) {
        // profiles of every provider exist now: roles on a provider without a connection move to the subscription
        const rebound = await rebindUnconnectedTo(deps.platform, CLAUDE_CODE_PROVIDER, (p) => service.providers.isCallProviderConnected(p));
        if (rebound) deps.platform.log.info({ moved: rebound }, "role model bindings on unconnected providers moved to the Claude subscription");
      }
    },
    async stop() {
      service.stop();
    },
  };
}
