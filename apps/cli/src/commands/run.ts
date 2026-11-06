/** `ncs run` — server in the foreground (service managers run this too). */
import type { Command } from "commander";
import { loadConfig } from "../lib/config.js";
import { loadServer } from "../lib/server-loader.js";
import { markLongRunning } from "../lib/output.js";
import { detectTailscale, isTailscaleIPv4 } from "../lib/net.js";
import { tailscaleHostnames } from "../lib/onboard-plan.js";

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("서버를 포그라운드로 실행합니다(마이그레이션 → HTTP → 백그라운드 루프)")
    .option("--host <host>", "바인드 주소(예: 127.0.0.1 또는 Tailscale IP)")
    .option("--port <port>", "HTTP 포트")
    .option("--allowed-hostname <name...>", "Host 헤더로 허용할 추가 이름(예: MagicDNS 이름, 쉼표·반복 가능)")
    .action(async (o: { host?: string; port?: string; allowedHostname?: string[] }) => {
      const base = loadConfig().config;
      const host = o.host ?? base.server.host;
      // a Tailscale IP bind also allows its MagicDNS names (CFG-6); explicit names are added
      const extra = tailscaleHostnames(isTailscaleIPv4(host) ? detectTailscale().dnsName : null, o.allowedHostname);
      const names = [...new Set([...base.server.allowed_hostnames, ...extra])];
      const { config } = loadConfig({
        flags: { server: { ...(o.host ? { host: o.host } : {}), ...(o.port ? { port: Number(o.port) } : {}), ...(names.length ? { allowed_hostnames: names } : {}) } },
      });
      markLongRunning();
      const server = await loadServer();
      const started = await server.startServer(config);
      process.stdout.write(`Novel Create Studio ${server.APP_VERSION} — ${started.url}\n`);
      let stopping = false;
      const shutdown = async (sig: string) => {
        if (stopping) return;
        stopping = true;
        process.stdout.write(`${sig} 수신, 종료합니다…\n`);
        const force = setTimeout(() => process.exit(1), 80_000);
        force.unref();
        try {
          await started.stop();
          process.exit(0);
        } catch (err) {
          console.error(err);
          process.exit(1);
        }
      };
      process.once("SIGINT", () => void shutdown("SIGINT"));
      process.once("SIGTERM", () => void shutdown("SIGTERM"));
    });
}
