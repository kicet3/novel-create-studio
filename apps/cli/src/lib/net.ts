import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";

/** Tailscale CGNAT range 100.64.0.0/10 */
export function isTailscaleIPv4(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

export interface TailscaleInfo {
  ips: string[];
  dnsName: string | null;
}

/** `tailscale ip -4` / `tailscale status --json` when the CLI exists, else interface scan. */
export function detectTailscale(): TailscaleInfo {
  const ips = new Set<string>();
  let dnsName: string | null = null;
  for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      const out = execFileSync(bin, ["status", "--json"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
      const j = JSON.parse(out) as { Self?: { TailscaleIPs?: string[]; DNSName?: string } };
      for (const ip of j.Self?.TailscaleIPs ?? []) if (isTailscaleIPv4(ip)) ips.add(ip);
      dnsName = j.Self?.DNSName?.replace(/\.$/, "") || null;
      break;
    } catch {
      /* not installed / not running */
    }
  }
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && isTailscaleIPv4(a.address)) ips.add(a.address);
  }
  return { ips: [...ips], dnsName };
}

/** true when nothing listens on host:port (we can bind it). */
export function portFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.listen(port, host, () => s.close(() => res(true)));
  });
}
