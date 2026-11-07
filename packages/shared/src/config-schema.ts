/**
 * InstallConfig (design/08 §5.1–5.3, simplified for MVP-α).
 *
 * Deviations (fixed implementation decisions):
 * - install home default `~/.ncs` (08 says `~/.novel-create-studio`), embedded data dir `<home>/data/pg`
 * - server.port default 3100 (08: 3210), database.embedded_port default 54329 (08: 54339)
 * - server.host may be a non-loopback private address (e.g. a Tailscale IP) while exposure=private.
 *   CFG-1 is relaxed: local_trusted requires exposure=private, but host is not forced to loopback;
 *   `isLoopbackHost` is exported so the HTTP layer can apply the host-header guard (CFG-6).
 *
 * Pure module (no fs / process access) so it can be used by server, cli and web.
 */
import { z } from "zod";
import { ENUMS } from "./enum-registry.js";
import { DEFAULTS, INSTALL_DEFAULTS } from "./defaults.js";
import { LLM_CALL_PROVIDER_IDS } from "./dto/llm.js";

const portSchema = z.number().int().min(1).max(65535);

export const installConfigSchema = z
  .object({
    deployment_mode: z.enum(ENUMS.deployment_mode).default("local_trusted"),
    /**
     * Development mode (`pnpm dev` sets NCS_DEV_MODE=1). Only in dev mode are the subscription / OAuth connection
     * methods usable: Claude subscription via the Claude Code CLI (`claude_cli`), ChatGPT sign-in (browser / device /
     * Codex auth.json import) and xAI device-code sign-in. Production (default false) calls provider APIs with API keys only.
     * Unrelated to `deployment_mode`.
     */
    dev_mode: z.boolean().default(false),
    exposure: z.enum(ENUMS.exposure).default("private"),
    home: z.string().min(1).default(INSTALL_DEFAULTS.home),
    server: z
      .object({
        host: z.string().min(1).default(INSTALL_DEFAULTS.serverHost),
        port: portSchema.default(INSTALL_DEFAULTS.serverPort),
        public_base_url: z.url().optional(),
        trusted_proxies: z.array(z.string()).optional(),
        /** Extra Host header names accepted by the host guard (e.g. a Tailscale MagicDNS name). */
        allowed_hostnames: z.array(z.string()).default([]),
        /** Directory of the built web UI to serve statically (apps/web/dist). */
        web_dist_dir: z.string().optional(),
      })
      .prefault({}),
    database: z
      .object({
        mode: z.enum(ENUMS.database_mode).default("embedded"),
        url: z.string().optional(),
        embedded_port: portSchema.default(INSTALL_DEFAULTS.embeddedPort),
        /** Defaults to `<home>/data/pg` (see resolveEmbeddedDataDir). */
        embedded_data_dir: z.string().optional(),
        auto_migrate: z.boolean().default(true),
        /**
         * External DB hosting. Not set → detected from the URL host (`*.supabase.co`, `*.supabase.com`) else "postgres".
         * "supabase": TLS required, transaction pooler (6543) refused, app tables isolated in `schema` (default `ncs`).
         */
        provider: z.enum(ENUMS.database_provider).optional(),
        /**
         * Dedicated schema for every app object (tables, functions, `app_migrations`), applied via the connection
         * `search_path` (app schema first, then the extensions schema). Supabase default `ncs`; other external DBs
         * default to the server's search_path (public). Never add it to Supabase's "Exposed schemas".
         */
        schema: z
          .string()
          .regex(/^[a-z_][a-z0-9_]{0,62}$/, "스키마 이름은 소문자·숫자·밑줄만 쓸 수 있습니다.")
          .optional(),
        /** schema where btree_gist / pg_trgm are created when missing (Supabase: `extensions`) */
        extensions_schema: z
          .string()
          .regex(/^[a-z_][a-z0-9_]{0,62}$/, "스키마 이름은 소문자·숫자·밑줄만 쓸 수 있습니다.")
          .default("extensions"),
        /** Supabase only: allow `schema=public` (refused by default — public is exposed through the Data API) */
        allow_public_schema: z.boolean().default(false),
        /** postgres.js pool size (default 10; Supabase 5 — shared pooler/connection limits) */
        pool_max: z.number().int().min(1).max(100).optional(),
        /** PEM CA bundle for TLS verify-full (e.g. Supabase "Download certificate") */
        ssl_ca_file: z.string().min(1).optional(),
      })
      .prefault({}),
    storage: z
      .object({
        provider: z.enum(ENUMS.storage_provider).default("local_disk"),
        root: z.string().optional(),
      })
      .prefault({}),
    secrets: z
      .object({
        provider: z.enum(ENUMS.secret_provider).default("local_encrypted"),
        master_key_file: z.string().optional(),
      })
      .prefault({}),
    messaging: z
      .object({
        telegram_receive_mode: z.enum(ENUMS.telegram_receive_mode).optional(),
        /** Telegram Bot API base URL (default https://api.telegram.org); a local Bot API server or a test mock */
        telegram_api_base_url: z.url().optional(),
        /** Discord REST base URL (default https://discord.com/api/v10); a test mock */
        discord_api_base_url: z.url().optional(),
        /** also request the privileged MESSAGE_CONTENT intent (DM content arrives without it; enable the portal toggle first) */
        discord_message_content_intent: z.boolean().optional(),
      })
      .prefault({}),
    llm: z
          .object({
            /**
             * Default provider for NEW novels' role bindings (each role can be moved to any connected provider):
             * "anthropic" = Claude API (Console API key: secret `llm.anthropic.api_key` or ANTHROPIC_API_KEY),
             * "claude_code" = the user's Claude subscription through the unmodified Claude Code CLI (`claude -p`),
             * "openai" (ChatGPT sign-in or API key), "xai" (xAI sign-in or API key), "google" (Gemini API key).
             * An unknown value (e.g. a provider this version no longer ships) falls back to "anthropic".
             * Not set → boot-time detection (llm module): no Anthropic API key + Claude Code signed in with a Claude
             * subscription → "claude_code", else "anthropic".
             */
            provider: z.enum(LLM_CALL_PROVIDER_IDS).optional().catch(undefined),
            /** set by the parser: `provider` was given explicitly (false = default, boot-time detection allowed) */
            provider_explicit: z.boolean().optional(),
            /** hard cap of one provider call (API lanes); `provider_call_timeout_seconds` overrides it per provider */
            call_timeout_seconds: z.number().int().positive().default(DEFAULTS["llm.call_timeout_seconds"]),
            /** per-provider hard cap, e.g. `{ openai: 900 }` (claude_code: `claude_code.call_timeout_seconds`) */
            provider_call_timeout_seconds: z.record(z.string(), z.number().int().positive()).default({}),
            /** streaming calls: abort after this many seconds without any received bytes (armed at the first byte; 0 = off) */
            idle_timeout_seconds: z.number().int().min(0).default(DEFAULTS["llm.idle_timeout_seconds"]),
            /** Claude subscription lane (`claude -p`, provider "claude_code") */
            claude_code: z
              .object({
                /** executable (default `claude` on PATH, or NCS_CLAUDE_PATH) */
                bin: z.string().min(1).optional(),
                /** concurrent `claude -p` processes (other calls wait for a slot) */
                max_concurrent: z.number().int().min(1).max(16).default(DEFAULTS["llm.claude_code.max_concurrent"]),
                /** per-call timeout (CLI start-up + long drafts) */
                call_timeout_seconds: z.number().int().positive().default(DEFAULTS["llm.claude_code.call_timeout_seconds"]),
              })
              .prefault({}),
            /**
             * Provider endpoints (default: the vendors' public URLs). Overridden by tests (local mock servers)
             * or a corporate proxy. Never put credentials in these URLs.
             */
            endpoints: z
              .object({
                anthropic_api_base_url: z.url().optional(),
                openai_api_base_url: z.url().optional(),
                /** ChatGPT sign-in lane: Codex backend (default https://chatgpt.com/backend-api/codex) */
                openai_codex_base_url: z.url().optional(),
                /** ChatGPT OAuth issuer (default https://auth.openai.com) */
                openai_auth_base_url: z.url().optional(),
                /** local port of the ChatGPT browser-login callback (default 1455, registered for the Codex client; 0 = random, tests) */
                openai_login_callback_port: z.number().int().min(0).max(65535).optional(),
                /** Codex client version sent to the model catalog (default 0.157.0 floor) */
                openai_codex_client_version: z.string().optional(),
                xai_api_base_url: z.url().optional(),
                /** xAI OAuth issuer (default https://auth.x.ai) */
                xai_auth_base_url: z.url().optional(),
                google_api_base_url: z.url().optional(),
              })
              .prefault({}),
          })
          .transform(({ provider, provider_explicit, ...rest }) => ({
            ...rest,
            provider: provider ?? ("anthropic" as const),
            provider_explicit: provider_explicit ?? provider !== undefined,
          }))
      .prefault({}),
    run: z
      .object({
        max_concurrent_per_novel: z.number().int().positive().default(DEFAULTS["run.max_concurrent_per_novel"]),
        max_concurrent_global: z.number().int().positive().default(DEFAULTS["run.max_concurrent_global"]),
      })
      .prefault({}),
    channel: z
      .object({
        binding_token_ttl_minutes: z.number().int().positive().default(DEFAULTS["channel.binding_token_ttl_minutes"]),
        health_check_interval_minutes: z
          .number()
          .int()
          .positive()
          .default(DEFAULTS["channel.health_check_interval_minutes"]),
      })
      .prefault({}),
    budget: z
      .object({
        unpriced_usage_policy: z.enum(ENUMS.unpriced_usage_policy).default(DEFAULTS["budget.unpriced_usage_policy"]),
      })
      .prefault({}),
    backup: z
      .object({
        mode: z.enum(ENUMS.backup_mode).default("full"),
        /** backup bundle directory (default `<home>/backups`); may point to another disk */
        dir: z.string().min(1).optional(),
        interval_hours: z.number().int().positive().default(DEFAULTS["backup.interval_hours"]),
        retention: z
          .object({ daily: z.number().int().min(0).default(7), weekly: z.number().int().min(0).default(4) })
          .prefault({}),
      })
      .prefault({}),
    auth: z.object({ session_secret_id: z.string().optional() }).prefault({}),
    /** 설계 추가 0021: 공개 사이트 정적 스냅숏(공개된 화만) 출력 폴더 (default `<home>/public-site/data`) */
    public_site: z.object({ output_dir: z.string().min(1).optional() }).prefault({}),
    logging: z
      .object({
        level: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
        retention_days: z.number().int().positive().default(14),
      })
      .prefault({}),
  })
  .superRefine((cfg, ctx) => {
    for (const issue of crossValidateInstallConfig(cfg)) {
      ctx.addIssue({ code: "custom", message: `${issue.id}: ${issue.message}`, path: issue.path });
    }
  });

export type InstallConfigInput = z.input<typeof installConfigSchema>;
export type InstallConfig = z.output<typeof installConfigSchema>;

export interface ConfigIssue {
  id: `CFG-${number}`;
  message: string;
  path: string[];
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function ipv4Octets(h: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((x) => x <= 255) ? o : null;
}

/**
 * Bind hosts allowed for `local_trusted` (CFG-1, relaxed by the fixed decision "Tailscale IP 가능"):
 * loopback, Tailscale CGNAT 100.64.0.0/10 and fd7a:115c:a1e0::/48, RFC1918 private ranges, link-local,
 * and host names. Wildcards (0.0.0.0, ::) and public IP literals are rejected: the Host-header guard
 * trusts a client-controlled header, so the bind address is the real network boundary.
 */
export function bindHostKind(host: string): "loopback" | "tailscale" | "private" | "name" | "wildcard" | "public" {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "" || h === "0.0.0.0" || h === "::" || h === "*") return "wildcard";
  if (isLoopbackHost(h)) return "loopback";
  const o = ipv4Octets(h);
  if (o) {
    if (o[0] === 100 && o[1]! >= 64 && o[1]! <= 127) return "tailscale";
    if (o[0] === 10 || (o[0] === 172 && o[1]! >= 16 && o[1]! <= 31) || (o[0] === 192 && o[1] === 168) || (o[0] === 169 && o[1] === 254)) return "private";
    return "public";
  }
  if (h.includes(":")) {
    if (h.startsWith("fd7a:115c:a1e0:")) return "tailscale";
    if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return "private";
    if (/^[0:]+$/.test(h)) return "wildcard";
    return "public";
  }
  return "name";
}

/** 08 §5.3 cross-validation (CFG-1..CFG-5; CFG-6..8 are runtime behaviour). */
export function crossValidateInstallConfig(cfg: {
  deployment_mode: string;
  exposure: string;
  server: { host: string; public_base_url?: string | undefined; trusted_proxies?: string[] | undefined };
  database: { mode: string; url?: string | undefined; provider?: string | undefined; schema?: string | undefined; allow_public_schema?: boolean | undefined };
  messaging: { telegram_receive_mode?: string | undefined };
  auth: { session_secret_id?: string | undefined };
}): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (cfg.deployment_mode === "local_trusted" && cfg.exposure !== "private") {
    issues.push({ id: "CFG-1", message: "local_trusted 모드는 exposure=private 이어야 합니다.", path: ["exposure"] });
  }
  if (cfg.deployment_mode === "local_trusted") {
    const kind = bindHostKind(cfg.server.host);
    if (kind === "wildcard" || kind === "public") {
      issues.push({
        id: "CFG-1",
        message: `local_trusted 모드는 인증이 없어 모든 인터페이스(0.0.0.0, ::)나 공인 IP에 바인드할 수 없습니다(현재 ${cfg.server.host}). 127.0.0.1 또는 Tailscale·사설 IP를 쓰세요.`,
        path: ["server", "host"],
      });
    }
  }
  if (cfg.deployment_mode === "self_hosted" && !cfg.auth.session_secret_id) {
    issues.push({ id: "CFG-2", message: "self_hosted 모드는 auth.session_secret_id 가 필요합니다.", path: ["auth", "session_secret_id"] });
  }
  if (cfg.exposure === "public") {
    if (!cfg.server.public_base_url?.startsWith("https://")) {
      issues.push({ id: "CFG-3", message: "exposure=public 은 https:// server.public_base_url 이 필요합니다.", path: ["server", "public_base_url"] });
    }
    if (!cfg.server.trusted_proxies?.length) {
      issues.push({ id: "CFG-3", message: "exposure=public 은 server.trusted_proxies 가 필요합니다.", path: ["server", "trusted_proxies"] });
    }
  }
  if (cfg.messaging.telegram_receive_mode === "webhook") {
    if (cfg.deployment_mode !== "self_hosted" || cfg.exposure !== "public" || !cfg.server.public_base_url) {
      issues.push({
        id: "CFG-4",
        message: "Telegram webhook 은 self_hosted + exposure=public + public_base_url 에서만 쓸 수 있습니다.",
        path: ["messaging", "telegram_receive_mode"],
      });
    }
  }
  if (cfg.database.mode === "external" && !cfg.database.url) {
    issues.push({ id: "CFG-5", message: "database.mode=external 은 database.url(또는 DATABASE_URL)이 필요합니다.", path: ["database", "url"] });
  }
  if (cfg.database.mode === "external" && cfg.database.url) {
    const sb = cfg.database.provider === "supabase" || (!cfg.database.provider && isSupabaseHost(databaseUrlHost(cfg.database.url)));
    if (sb && cfg.database.schema === "public" && !cfg.database.allow_public_schema) {
      issues.push({
        id: "CFG-7",
        message: "Supabase 에서는 public 스키마를 쓰지 않습니다(Data API로 노출됨). database.schema 를 비우거나(기본 ncs) 다른 이름을 쓰세요.",
        path: ["database", "schema"],
      });
    }
  }
  return issues;
}

/** host of a postgres URL (lower-case, no brackets) or null when unparsable */
export function databaseUrlHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Supabase-managed Postgres hosts: direct `db.<ref>.supabase.co`, Supavisor `*.pooler.supabase.com` */
export function isSupabaseHost(host: string | null): boolean {
  return !!host && /(^|\.)supabase\.(co|com)$/.test(host);
}

/** Effective Telegram receive mode (CFG-4): webhook only for self_hosted + public, else polling. */
export function effectiveTelegramReceiveMode(cfg: InstallConfig): "polling" | "webhook" {
  if (cfg.messaging.telegram_receive_mode) return cfg.messaging.telegram_receive_mode;
  return cfg.deployment_mode === "self_hosted" && cfg.exposure === "public" ? "webhook" : "polling";
}

/** Env-variable overlay (precedence: flags > env > config.json > defaults, 08 §5.1). */
export function installConfigFromEnv(env: Record<string, string | undefined>): InstallConfigInput {
  const out: Record<string, Record<string, unknown> | string | boolean> = {};
  const set = (section: string, key: string, value: unknown) => {
    const s = (out[section] ??= {}) as Record<string, unknown>;
    s[key] = value;
  };
  if (env.NCS_HOME) out.home = env.NCS_HOME;
  if (env.NCS_DEPLOYMENT_MODE) out.deployment_mode = env.NCS_DEPLOYMENT_MODE;
  if (env.NCS_DEV_MODE !== undefined && env.NCS_DEV_MODE !== "") out.dev_mode = /^(1|true|yes|on)$/i.test(env.NCS_DEV_MODE.trim());
  if (env.NCS_EXPOSURE) out.exposure = env.NCS_EXPOSURE;
  if (env.NCS_HOST) set("server", "host", env.NCS_HOST);
  if (env.NCS_PORT) set("server", "port", Number(env.NCS_PORT));
  if (env.NCS_ALLOWED_HOSTNAMES) set("server", "allowed_hostnames", env.NCS_ALLOWED_HOSTNAMES.split(",").map((s) => s.trim()).filter(Boolean));
  if (env.NCS_WEB_DIST) set("server", "web_dist_dir", env.NCS_WEB_DIST);
  if (env.DATABASE_URL) {
    set("database", "mode", "external");
    set("database", "url", env.DATABASE_URL);
  }
  if (env.NCS_DB_PROVIDER) set("database", "provider", env.NCS_DB_PROVIDER.trim().toLowerCase());
  if (env.NCS_DB_SCHEMA) set("database", "schema", env.NCS_DB_SCHEMA.trim());
  if (env.NCS_DB_EXTENSIONS_SCHEMA) set("database", "extensions_schema", env.NCS_DB_EXTENSIONS_SCHEMA.trim());
  if (env.NCS_DB_ALLOW_PUBLIC_SCHEMA !== undefined && env.NCS_DB_ALLOW_PUBLIC_SCHEMA !== "")
    set("database", "allow_public_schema", /^(1|true|yes|on)$/i.test(env.NCS_DB_ALLOW_PUBLIC_SCHEMA.trim()));
  if (env.NCS_DB_POOL_MAX) set("database", "pool_max", Number(env.NCS_DB_POOL_MAX));
  if (env.NCS_DB_SSL_CA_FILE) set("database", "ssl_ca_file", env.NCS_DB_SSL_CA_FILE);
  if (env.NCS_PG_PORT) set("database", "embedded_port", Number(env.NCS_PG_PORT));
  if (env.NCS_PG_DATA_DIR) set("database", "embedded_data_dir", env.NCS_PG_DATA_DIR);
  if (env.NCS_TELEGRAM_API_BASE_URL) set("messaging", "telegram_api_base_url", env.NCS_TELEGRAM_API_BASE_URL);
  if (env.NCS_DISCORD_API_BASE_URL) set("messaging", "discord_api_base_url", env.NCS_DISCORD_API_BASE_URL);
  if (env.NCS_DISCORD_MESSAGE_CONTENT_INTENT !== undefined && env.NCS_DISCORD_MESSAGE_CONTENT_INTENT !== "")
    set("messaging", "discord_message_content_intent", /^(1|true|yes|on)$/i.test(env.NCS_DISCORD_MESSAGE_CONTENT_INTENT.trim()));
  if (env.NCS_LLM_PROVIDER) set("llm", "provider", env.NCS_LLM_PROVIDER);
  if (env.NCS_ANTHROPIC_BASE_URL) set("llm", "endpoints", { anthropic_api_base_url: env.NCS_ANTHROPIC_BASE_URL });
  if (env.NCS_CLAUDE_MAX_CONCURRENT) set("llm", "claude_code", { max_concurrent: Number(env.NCS_CLAUDE_MAX_CONCURRENT) });
  if (env.NCS_LLM_CALL_TIMEOUT_SECONDS) set("llm", "call_timeout_seconds", Number(env.NCS_LLM_CALL_TIMEOUT_SECONDS));
  if (env.NCS_LOG_LEVEL) set("logging", "level", env.NCS_LOG_LEVEL);
  if (env.NCS_PUBLIC_SITE_DATA_DIR) set("public_site", "output_dir", env.NCS_PUBLIC_SITE_DATA_DIR);
  if (env.NCS_SECRETS_MASTER_KEY_FILE) set("secrets", "master_key_file", env.NCS_SECRETS_MASTER_KEY_FILE);
  return out as InstallConfigInput;
}

/** Deep-merge config layers (later wins). Arrays are replaced, not concatenated. */
export function mergeConfigLayers(...layers: Array<InstallConfigInput | undefined>): InstallConfigInput {
  const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
    const res: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) continue;
      const prev = res[k];
      res[k] =
        v && typeof v === "object" && !Array.isArray(v) && prev && typeof prev === "object" && !Array.isArray(prev)
          ? merge(prev as Record<string, unknown>, v as Record<string, unknown>)
          : v;
    }
    return res;
  };
  return layers.reduce<Record<string, unknown>>((acc, l) => (l ? merge(acc, l as Record<string, unknown>) : acc), {}) as InstallConfigInput;
}

export function parseInstallConfig(input: unknown): InstallConfig {
  return installConfigSchema.parse(input ?? {});
}

/** 공개 사이트 스냅숏 폴더: explicit config, else `<home>/public-site/data`. `~` is NOT expanded here. */
export function resolvePublicSiteDataDir(cfg: InstallConfig): string {
  return cfg.public_site.output_dir ?? `${cfg.home.replace(/\/+$/, "")}/public-site/data`;
}

/** Embedded PG data dir: explicit config, else `<home>/data/pg`. `~` is NOT expanded here (no fs/os access). */
export function resolveEmbeddedDataDir(cfg: InstallConfig): string {
  return cfg.database.embedded_data_dir ?? `${cfg.home.replace(/\/+$/, "")}/data/pg`;
}
