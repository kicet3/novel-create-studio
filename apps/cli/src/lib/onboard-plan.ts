/** Pure part of `ncs onboard`: answers → config.json object (no secret values, 08 §5.1). */
import { INSTALL_DEFAULTS, isLoopbackHost } from "@ncs/shared";
import { setKey, type ConfigObject } from "./config.js";

export interface OnboardAnswers {
  home: string;
  /** undefined → default `<home>/files` */
  storageRoot?: string;
  host: string;
  port: number;
  /** extra Host header names (e.g. Tailscale MagicDNS name) */
  allowedHostnames?: string[];
  llmProvider: "anthropic";
}

export function buildOnboardConfig(existing: ConfigObject, a: OnboardAnswers): ConfigObject {
  let c: ConfigObject = { ...existing };
  // home is chosen via NCS_HOME (config.json lives inside it); keep the file free of a stale `home`
  delete c.home;
  c = setKey(c, "server.host", a.host);
  c = setKey(c, "server.port", a.port);
  const names = [...new Set((a.allowedHostnames ?? []).map((s) => s.trim()).filter(Boolean))];
  c = setKey(c, "server.allowed_hostnames", names.length ? names : undefined);
  c = setKey(c, "storage.root", a.storageRoot && a.storageRoot.trim() ? a.storageRoot.trim() : undefined);
  // `llm.provider` is NOT written: left unset, the server picks the default at boot (Anthropic API key → anthropic;
  // no key + Claude Code signed in with a Claude subscription → claude_code, dev mode only (NCS_DEV_MODE=1 / `pnpm dev`);
  // production always uses anthropic). An existing explicit value is kept.
  c = setKey(c, "deployment_mode", "local_trusted");
  c = setKey(c, "exposure", "private");
  for (const k of ["server", "storage"]) if (c[k] && !Object.keys(c[k] as object).length) delete c[k];
  return c;
}

/**
 * Host header names to allow for a Tailscale bind (CFG-6, 08 §5.3): the MagicDNS FQDN and its short
 * name (`snowfall-macmini.tail447a11.ts.net` → also `snowfall-macmini`), plus explicit extra names.
 */
export function tailscaleHostnames(dnsName: string | null | undefined, extra: string[] = []): string[] {
  const out: string[] = [];
  const fq = dnsName?.trim().toLowerCase().replace(/\.$/, "");
  if (fq) {
    out.push(fq);
    const short = fq.split(".")[0];
    if (short && short !== fq) out.push(short);
  }
  for (const e of extra) for (const n of e.split(",")) if (n.trim()) out.push(n.trim().toLowerCase().replace(/\.$/, ""));
  return [...new Set(out)];
}

export function hostWarning(host: string): string | null {
  if (isLoopbackHost(host)) return null;
  return (
    `서버를 ${host} 에 엽니다. local_trusted 모드에는 로그인이 없으므로 이 주소에 닿는 모든 기기(예: 같은 Tailscale tailnet)가 ` +
    "작품과 설정을 볼 수 있습니다. 신뢰하는 기기만 있는 네트워크에서만 쓰세요."
  );
}

export function parsePort(v: string): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

export const DEFAULT_PORT = INSTALL_DEFAULTS.serverPort;
