/**
 * OS service definitions (08 §8.2): macOS launchd LaunchAgent (user), Linux systemd user unit.
 * Pure builders — the command layer writes files and calls launchctl / systemctl.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVICE_LABEL = "com.novel-create-studio.server";
export const SYSTEMD_UNIT = "novel-create-studio.service";
/** shutdown.grace_seconds (00 §7.2, 60 s) + 30 s for PG stop (08 §8.2) */
export const STOP_TIMEOUT_SECONDS = 90;

export interface ServiceSpec {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
  exitTimeoutSeconds: number;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function launchdPlist(spec: ServiceSpec): string {
  const args = spec.programArguments.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const env = Object.entries(spec.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(spec.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>${spec.exitTimeoutSeconds}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(spec.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.stderrPath)}</string>
</dict>
</plist>
`;
}

const sq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`);

export function systemdUnit(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `Environment=${sq(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=Novel Create Studio server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${spec.workingDirectory}
ExecStart=${spec.programArguments.map(sq).join(" ")}
${env}
Restart=on-failure
RestartSec=10
TimeoutStopSec=${spec.exitTimeoutSeconds}
KillSignal=SIGTERM
StandardOutput=append:${spec.stdoutPath}
StandardError=append:${spec.stderrPath}

[Install]
WantedBy=default.target
`;
}

export function launchAgentPath(label = SERVICE_LABEL, home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

export function systemdUnitPath(home = homedir()): string {
  return join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
}

/**
 * How the service re-invokes this CLI: built `dist/main.js` under plain node, or the TS entry via
 * the tsx loader when running from sources.
 */
export function cliInvocation(opts: { mainUrl: string; execPath?: string; tsxImport?: string | null }): string[] {
  const node = opts.execPath ?? process.execPath;
  const main = fileURLToPath(opts.mainUrl);
  if (main.endsWith(".ts")) {
    return [node, "--import", opts.tsxImport ?? "tsx", "--conditions=@ncs/source", main, "run"];
  }
  return [node, main, "run"];
}

export function buildServiceSpec(o: {
  ncsHome: string;
  programArguments: string[];
  workingDirectory: string;
  path?: string;
  extraEnv?: Record<string, string>;
}): ServiceSpec {
  return {
    label: SERVICE_LABEL,
    programArguments: o.programArguments,
    workingDirectory: o.workingDirectory,
    env: { NCS_HOME: o.ncsHome, PATH: o.path ?? process.env.PATH ?? "/usr/bin:/bin", ...o.extraEnv },
    stdoutPath: join(o.ncsHome, "logs", "server.out.log"),
    stderrPath: join(o.ncsHome, "logs", "server.err.log"),
    exitTimeoutSeconds: STOP_TIMEOUT_SECONDS,
  };
}
