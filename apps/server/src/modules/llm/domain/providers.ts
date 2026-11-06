/**
 * Provider catalog (pure): display names, connection methods, secret ids, Korean notes on each provider's terms.
 *
 * Claude (code.claude.com/docs/en/legal-and-compliance, checked 2026-11-06): two methods —
 * - `claude_cli`: the user's own Claude subscription by running the UNMODIFIED Claude Code CLI (`claude -p`) the user
 *   installed and signed in to themselves (`claude auth login` in a terminal). The app never reads, stores or
 *   intermediates Claude.ai credentials, never mints tokens and never starts the login itself. Calls go to provider
 *   "claude_code" (own zero-priced profile: a subscription is not billed per call);
 * - `api_key`: a Claude Console API key (provider "anthropic", API prices).
 * GPT: ChatGPT sign-in through OpenAI's Codex client (ported from ima2-gen; Codex backend) or an API key.
 * Grok: xAI account sign-in (device code; undocumented by xAI → experimental) or an API key (recommended).
 * Gemini: Google AI Studio API key only (Google's user OAuth for the Gemini API needs the user's own GCP OAuth
 * client and is documented as a testing setup; reusing Gemini CLI / Antigravity sign-in violates Google's terms).
 */
import type { LlmProviderId, ProviderConnectionMethod } from "@ncs/shared";

export const LLM_PROVIDERS: readonly LlmProviderId[] = ["anthropic", "openai", "xai", "google"];

/** provider id of the Claude subscription lane (ClaudeCliLlmAdapter, profile `claude_code`) */
export const CLAUDE_CODE_PROVIDER = "claude_code";
/** providers with a production adapter and a profile created on boot (bindings may point at any of them) */
export const LLM_CALL_PROVIDERS: readonly string[] = ["anthropic", CLAUDE_CODE_PROVIDER, "openai", "xai", "google"];
/** secret-store marker: "0" = the user deactivated the Claude subscription method in this app (not a credential) */
export const claudeCliEnabledId = "llm.claude_code.enabled";

/** connection row (Claude/GPT/Grok/Gemini) of a calling provider */
export function connectionRowOf(provider: string): LlmProviderId | null {
  if (provider === CLAUDE_CODE_PROVIDER) return "anthropic";
  return isLlmProviderId(provider) ? provider : null;
}

/** Korean label of a calling provider */
export function callProviderLabel(provider: string): string {
  if (provider === CLAUDE_CODE_PROVIDER) return "Claude 구독 (Claude Code CLI)";
  return isLlmProviderId(provider) ? PROVIDER_SPECS[provider].label : provider;
}

export const CLAUDE_CLI_NOTE =
  "내 PC에 설치·로그인된 Claude Code를 그대로 실행합니다. 앱은 로그인 정보를 읽거나 저장하지 않습니다. 구독 사용 한도는 개인적인 일반 사용 기준이라 자동 연재처럼 호출이 많으면 한도에 빨리 닿을 수 있습니다.";
export const CLAUDE_CLI_CONNECT_HINT = "터미널에서 `claude auth login` 실행 후 [상태 새로고침]";

/**
 * Subscription / OAuth connection methods (Claude subscription via the Claude Code CLI, ChatGPT sign-in, xAI sign-in):
 * usable only in dev mode (InstallConfig `dev_mode`, `pnpm dev` / NCS_DEV_MODE=1). Production uses API keys only.
 */
export const DEV_ONLY_METHODS: ReadonlySet<ProviderConnectionMethod> = new Set<ProviderConnectionMethod>(["claude_cli", "chatgpt_oauth", "xai_oauth"]);
export const isDevOnlyMethod = (m: ProviderConnectionMethod | string | null | undefined): boolean => !!m && DEV_ONLY_METHODS.has(m as ProviderConnectionMethod);
export const DEV_ONLY_CODE = "oauth_dev_only";
export const DEV_ONLY_REASON = "개발 모드에서만 사용할 수 있습니다 (`pnpm dev` 또는 NCS_DEV_MODE=1). 운영 모드에서는 API 키로 연결하세요.";

export function isLlmProviderId(p: string): p is LlmProviderId {
  return (LLM_PROVIDERS as readonly string[]).includes(p);
}

export interface MethodSpec {
  method: ProviderConnectionMethod;
  flows: Array<"api_key" | "browser" | "device" | "import_codex" | "cli">;
  label: string;
  official: boolean;
  experimental: boolean;
  note: string;
}

export interface ProviderSpec {
  provider: LlmProviderId;
  label: string;
  methods: MethodSpec[];
  unsupported: Array<{ label: string; reason: string }>;
  termsNote: string;
  imageGeneration: boolean;
  /** env fallbacks of the api key, in order */
  apiKeyEnv: string[];
}

export const PROVIDER_SPECS: Readonly<Record<LlmProviderId, ProviderSpec>> = {
  anthropic: {
    provider: "anthropic",
    label: "Claude (Anthropic)",
    methods: [
      {
        method: "claude_cli",
        flows: ["cli"],
        label: "Claude 구독 (Claude Code CLI)",
        official: true,
        experimental: false,
        note: CLAUDE_CLI_NOTE,
      },
      {
        method: "api_key",
        flows: ["api_key"],
        label: "Console API 키",
        official: true,
        experimental: false,
        note: "console.anthropic.com에서 발급한 API 키로 연결합니다. 사용량은 API 요금으로 청구됩니다.",
      },
    ],
    unsupported: [],
    termsNote: "Claude 구독은 내 Claude 요금제 약관과 사용 한도가, Console API 키는 Anthropic 상용 약관(Commercial Terms)이 적용되며 둘 다 Anthropic 사용 정책을 따릅니다.",
    imageGeneration: false,
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
  },
  openai: {
    provider: "openai",
    label: "GPT (OpenAI)",
    methods: [
      {
        method: "chatgpt_oauth",
        flows: ["browser", "device", "import_codex"],
        label: "ChatGPT 로그인",
        official: false,
        experimental: true,
        note:
          "OpenAI의 Codex 클라이언트로 ChatGPT에 로그인해 내 ChatGPT 요금제 사용량으로 호출합니다. 브라우저 로그인은 이 서버와 같은 컴퓨터의 브라우저에서만 됩니다(localhost:1455). 다른 기기에서는 기기 코드 로그인을 쓰세요. OpenAI가 외부 앱용으로 문서화한 경로가 아니어서 바뀌거나 막힐 수 있습니다.",
      },
      {
        method: "api_key",
        flows: ["api_key"],
        label: "OpenAI API 키",
        official: true,
        experimental: false,
        note: "platform.openai.com에서 발급한 API 키(sk-…)로 연결합니다. 사용량은 OpenAI API 요금으로 청구됩니다.",
      },
    ],
    unsupported: [],
    termsNote: "ChatGPT 로그인은 내 ChatGPT 요금제 한도를 쓰며, OpenAI 이용약관과 내 OpenAI 계정 약정이 적용됩니다. API 키는 OpenAI API 약관이 적용됩니다.",
    imageGeneration: true,
    apiKeyEnv: ["OPENAI_API_KEY"],
  },
  xai: {
    provider: "xai",
    label: "Grok (xAI)",
    methods: [
      {
        method: "api_key",
        flows: ["api_key"],
        label: "xAI API 키 (권장)",
        official: true,
        experimental: false,
        note: "console.x.ai에서 발급한 API 키(xai-…)로 연결합니다. xAI가 공식 문서로 안내하는 방식입니다.",
      },
      {
        method: "xai_oauth",
        flows: ["device"],
        label: "xAI 계정 로그인 (실험적)",
        official: false,
        experimental: true,
        note:
          "기기 코드로 xAI 계정에 로그인합니다. xAI가 외부 앱용으로 문서화하지 않은 방식이라 SuperGrok 등 구독이 필요하거나 403으로 거부될 수 있고, 사용량은 구독 한도에서 차감됩니다. 거부되면 API 키를 쓰세요.",
      },
    ],
    unsupported: [],
    termsNote: "xAI 이용약관과 내 xAI 계정·구독 약정이 적용됩니다.",
    imageGeneration: true,
    apiKeyEnv: ["XAI_API_KEY"],
  },
  google: {
    provider: "google",
    label: "Gemini (Google)",
    methods: [
      {
        method: "api_key",
        flows: ["api_key"],
        label: "Gemini API 키 (Google AI Studio)",
        official: true,
        experimental: false,
        note: "aistudio.google.com에서 발급한 API 키로 연결합니다. 무료 등급은 입력 데이터가 제품 개선에 쓰일 수 있습니다.",
      },
    ],
    unsupported: [
      {
        label: "Google 계정 로그인",
        reason:
          "Gemini API의 사용자 OAuth는 직접 만든 GCP OAuth 클라이언트가 필요한 테스트용 설정이고, Gemini CLI·Antigravity 로그인을 외부 앱에서 쓰는 것은 Google 약관 위반이라 지원하지 않습니다.",
      },
    ],
    termsNote: "Gemini API 추가 약관과 Google 이용약관이 적용됩니다.",
    imageGeneration: true,
    apiKeyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
};

export const apiKeySecretId = (provider: string) => `llm.${provider}.api_key`;
export const oauthSecretId = (provider: string) => `llm.${provider}.oauth_session`;
export const activeMethodSecretId = (provider: string) => `llm.${provider}.active_method`;

export function oauthMethodOf(provider: LlmProviderId): ProviderConnectionMethod | null {
  return provider === "openai" ? "chatgpt_oauth" : provider === "xai" ? "xai_oauth" : null;
}

/** "someone@example.com" → "so•••@example.com" */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return `${email.slice(0, 2)}•••`;
  return `${email.slice(0, Math.min(2, at))}•••${email.slice(at)}`;
}

export function maskId(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.length <= 8 ? `${id.slice(0, 2)}…` : `${id.slice(0, 8)}…`;
}

/** basic key-shape check (prefix hints only; the connection test is authoritative) */
export function apiKeyShapeProblem(provider: LlmProviderId, key: string): string | null {
  if (provider === "anthropic" && !key.startsWith("sk-ant-")) return "Claude Console API 키는 sk-ant-로 시작합니다.";
  if (provider === "openai" && !key.startsWith("sk-")) return "OpenAI API 키는 sk-로 시작합니다.";
  if (provider === "xai" && !key.startsWith("xai-")) return "xAI API 키는 xai-로 시작합니다.";
  return null;
}
