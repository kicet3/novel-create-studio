/** Error classification shared by real adapters (04 §10.3) and the retry policy (04 §7.2). Pure. */
import type { ErrorFamily } from "@ncs/shared";

const QUOTA_HINT = /credit balance|billing|quota|insufficient[_ ]funds|payment/i;
/** 400 bodies that mean "bad key" (xAI: "Incorrect API key provided", Gemini: API_KEY_INVALID / "API key not valid") */
export const BAD_KEY_HINT = /incorrect api key|invalid api key|invalid[_ ]?x?-?api[_ ]?key|API_KEY_INVALID|API key not valid/i;

export function classifyHttpError(status: number | undefined, message = ""): ErrorFamily {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 402) return "quota_exhausted";
  if (status === 429) return QUOTA_HINT.test(message) ? "quota_exhausted" : "rate_limited";
  if (status === 400 && BAD_KEY_HINT.test(message)) return "auth_failed";
  if (status === 400 && QUOTA_HINT.test(message)) return "quota_exhausted";
  if (status === 408) return "timeout";
  if (status !== undefined && (status >= 500 || status === 529)) return "provider_unavailable";
  if (status === undefined) return "provider_unavailable";
  return "internal";
}

/** families retried inside one ModelCallPort.call (04 §7.2 "호출 층 재시도") */
export function isCallLevelRetryable(f: ErrorFamily): boolean {
  return f === "rate_limited" || f === "provider_unavailable";
}

/** families that end the call immediately */
export function isTerminalForCall(f: ErrorFamily): boolean {
  return f === "auth_failed" || f === "quota_exhausted" || f === "timeout" || f === "budget_blocked" || f === "internal";
}
