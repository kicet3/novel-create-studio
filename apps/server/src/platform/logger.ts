import { pino, type Logger } from "pino";

export type { Logger };

/** Keys whose values are always masked in logs (NFR-SEC-02, 08 §3.3 ncs/no-secret-in-log). */
export const REDACT_KEYS = ["token", "botToken", "bot_token", "apiKey", "api_key", "password", "secret", "plaintext", "authorization", "cookie"];

/** Structured logger with secret redaction (NFR-SEC-02). */
export function createLogger(level = "info", opts: { pretty?: boolean } = {}): Logger {
  const paths = [
    ...REDACT_KEYS,
    ...REDACT_KEYS.map((k) => `*.${k}`),
    ...REDACT_KEYS.map((k) => `*.*.${k}`),
    "headers.authorization",
    "headers.cookie",
    "headers['x-api-key']",
    "req.headers.authorization",
    "req.headers.cookie",
  ];
  return pino({
    level,
    redact: { paths, censor: "[redacted]" },
    ...(opts.pretty ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" } } } : {}),
  });
}

/** Recursively mask secret-looking keys in arbitrary JSON (used by audit before/after/details). */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    out[k] = /(token|secret|password|api_?key|authorization|cookie|plaintext)$/.test(lower) ? "[redacted]" : redactDeep(v, depth + 1);
  }
  return out;
}
