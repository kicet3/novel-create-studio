import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKey, loadConfig, parseValue, readConfigFile, setKey, validateConfigObject, writeConfigFile } from "../src/lib/config.js";
import { buildOnboardConfig, hostWarning, parsePort, tailscaleHostnames } from "../src/lib/onboard-plan.js";
import { buildServiceSpec, cliInvocation, launchdPlist, systemdUnit, STOP_TIMEOUT_SECONDS } from "../src/lib/service-def.js";
import { listBundles, resolveBundle } from "../src/lib/bundles.js";
import { checkConfigFile, checkHomePermissions, checkNode, exitCodeOf } from "../src/lib/doctor.js";
import { isTailscaleIPv4 } from "../src/lib/net.js";
import { withDatabase, databaseNameOf } from "../src/lib/db.js";
import { restoreStamp } from "../src/lib/restore.js";
import { loadBackupEngine } from "../src/lib/server-loader.js";
import { buildProgram } from "../src/main.js";

let home: string;
const prevHome = process.env.NCS_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ncs-cli-"));
  process.env.NCS_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.NCS_HOME;
  else process.env.NCS_HOME = prevHome;
});

describe("config file", () => {
  it("dotted get/set with JSON values, 0600 file, rejects secret-looking keys", () => {
    let c = setKey({}, "server.port", parseValue("3200"));
    c = setKey(c, "server.allowed_hostnames", parseValue('["mac.tailnet.ts.net"]'));
    c = setKey(c, "logging.level", parseValue("debug"));
    expect(getKey(c, "server.port")).toBe(3200);
    expect(() => setKey(c, "llm.api_key", "sk-x")).toThrow(/secrets/);
    expect(() => setKey(c, "messaging.bot_token", "x")).toThrow();
    expect(setKey(c, "auth.session_secret_id", "auth.session")).toBeTruthy(); // *_id references are fine
    const p = writeConfigFile(c);
    if (process.platform !== "win32") expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readConfigFile()).toEqual(c);
    const { config } = loadConfig({ env: { NCS_HOME: home } });
    expect(config.server.port).toBe(3200);
    expect(config.home).toBe(home);
    // env beats file, flags beat env
    expect(loadConfig({ env: { NCS_HOME: home, NCS_PORT: "3300" } }).config.server.port).toBe(3300);
    expect(loadConfig({ env: { NCS_HOME: home, NCS_PORT: "3300" }, flags: { server: { port: 3400 } } }).config.server.port).toBe(3400);
  });

  it("validation reports schema and CFG cross-check issues", () => {
    expect(validateConfigObject({ server: { port: 0 } }).ok).toBe(false);
    const r = validateConfigObject({ exposure: "public" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(" ")).toMatch(/CFG-1/);
    expect(validateConfigObject({ server: { host: "100.101.102.103" } }).ok).toBe(true);
  });

  it("`ncs config set/get` through commander", async () => {
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write;
    try {
      await buildProgram().parseAsync(["node", "ncs", "config", "set", "backup.interval_hours", "12"]);
      await buildProgram().parseAsync(["node", "ncs", "config", "get", "backup.interval_hours"]);
    } finally {
      process.stdout.write = orig;
    }
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).backup.interval_hours).toBe(12);
    expect(out.join("")).toContain("12");
  });
});

describe("onboard plan", () => {
  it("builds a local_trusted config with Tailscale host + MagicDNS allowed hostname", () => {
    const c = buildOnboardConfig({ logging: { level: "warn" }, home: "/old" }, {
      home,
      host: "100.88.1.2",
      port: 3100,
      allowedHostnames: ["mac.tail1234.ts.net", ""],
      llmProvider: "anthropic",
    });
    expect(c).toEqual({
      logging: { level: "warn" },
      server: { host: "100.88.1.2", port: 3100, allowed_hostnames: ["mac.tail1234.ts.net"] },
      deployment_mode: "local_trusted",
      exposure: "private",
    });
    expect(validateConfigObject(c).ok).toBe(true);
    expect(JSON.stringify(c)).not.toMatch(/sk-|token/);
    expect(hostWarning("127.0.0.1")).toBeNull();
    expect(hostWarning("100.88.1.2")).toMatch(/Tailscale/);
    expect(parsePort("70000")).toBeNull();
    expect(isTailscaleIPv4("100.64.0.1")).toBe(true);
    expect(isTailscaleIPv4("100.128.0.1")).toBe(false);
    expect(isTailscaleIPv4("192.168.0.1")).toBe(false);
    // CFG-6: MagicDNS FQDN + its short name (review regression), extra names, no duplicates
    expect(tailscaleHostnames("snowfall-macmini.tail447a11.ts.net.")).toEqual(["snowfall-macmini.tail447a11.ts.net", "snowfall-macmini"]);
    expect(tailscaleHostnames(null, ["a,b", "a"])).toEqual(["a", "b"]);
  });
});

describe("service definitions", () => {
  it("launchd plist: KeepAlive/RunAtLoad, NCS_HOME pinned, ExitTimeOut = grace + 30", () => {
    const spec = buildServiceSpec({
      ncsHome: "/Users/me/.ncs",
      programArguments: cliInvocation({ mainUrl: "file:///opt/ncs/apps/cli/dist/main.js", execPath: "/usr/local/bin/node" }),
      workingDirectory: "/opt/ncs",
      path: "/usr/bin",
    });
    const plist = launchdPlist(spec);
    expect(plist).toContain("<string>com.novel-create-studio.server</string>");
    expect(plist).toContain("<string>/usr/local/bin/node</string>\n    <string>/opt/ncs/apps/cli/dist/main.js</string>\n    <string>run</string>");
    expect(plist).toContain("<key>NCS_HOME</key>\n    <string>/Users/me/.ncs</string>");
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toContain(`<integer>${STOP_TIMEOUT_SECONDS}</integer>`);
    expect(STOP_TIMEOUT_SECONDS).toBe(90);
    expect(plist).toContain("/Users/me/.ncs/logs/server.out.log");
    const unit = systemdUnit(spec);
    expect(unit).toContain("TimeoutStopSec=90");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("ExecStart=/usr/local/bin/node /opt/ncs/apps/cli/dist/main.js run");
  });
  it("source invocation goes through the tsx loader", () => {
    const args = cliInvocation({ mainUrl: "file:///r/apps/cli/src/main.ts", execPath: "node", tsxImport: "file:///r/node_modules/tsx/dist/loader.mjs" });
    expect(args).toEqual(["node", "--import", "file:///r/node_modules/tsx/dist/loader.mjs", "--conditions=@ncs/source", "/r/apps/cli/src/main.ts", "run"]);
  });
});

describe("bundles, doctor, misc", () => {
  it("resolves bundles by path, name, id and latest", () => {
    const dir = join(home, "backups");
    for (const [name, id] of [["20261101T000000Z-scheduled-aaaaaaaa", "bkp_A"], ["20261102T000000Z-manual-bbbbbbbb", "bkp_B"]] as const) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "manifest.json"), JSON.stringify({ backupId: id, createdAt: name, trigger: "manual", engine: "json" }));
    }
    mkdirSync(join(dir, "20261103T000000Z-manual-cccccccc.partial"), { recursive: true });
    mkdirSync(join(dir, "broken"), { recursive: true });
    expect(listBundles(dir).map((b) => [b.name, b.valid])).toEqual([
      ["broken", false],
      ["20261102T000000Z-manual-bbbbbbbb", true],
      ["20261101T000000Z-scheduled-aaaaaaaa", true],
    ]);
    expect(resolveBundle("latest", dir)).toBe(join(dir, "20261102T000000Z-manual-bbbbbbbb"));
    expect(resolveBundle("bkp_A", dir)).toBe(join(dir, "20261101T000000Z-scheduled-aaaaaaaa"));
    expect(resolveBundle("20261101T000000Z-scheduled-aaaaaaaa", dir)).toContain("aaaaaaaa");
    expect(resolveBundle(join(dir, "20261101T000000Z-scheduled-aaaaaaaa"), dir)).toContain("aaaaaaaa");
    expect(() => resolveBundle("nope", dir)).toThrow();
  });

  it("doctor local checks and exit codes", () => {
    expect(checkNode("22.11.0").status).toBe("pass");
    expect(checkNode("20.1.0").status).toBe("fail");
    expect(exitCodeOf([{ status: "pass" }])).toBe(0);
    expect(exitCodeOf([{ status: "pass" }, { status: "warn" }])).toBe(1);
    expect(exitCodeOf([{ status: "warn" }, { status: "fail" }])).toBe(2);
    const { config } = loadConfig({ env: { NCS_HOME: home } });
    if (process.platform !== "win32") {
      mkdirSync(join(home, "secrets"), { recursive: true });
      writeFileSync(join(home, "secrets", "master.key"), "k", { mode: 0o644 });
      expect(checkHomePermissions(config, {}).status).toBe("fail");
    }
    writeFileSync(join(home, "config.json"), "{bad json");
    expect(checkConfigFile(home).status).toBe("fail");
  });

  it("db url helpers and restore stamp", () => {
    expect(withDatabase("postgres://ncs:ncs@127.0.0.1:54329/ncs", "ncs_restore_x")).toBe("postgres://ncs:ncs@127.0.0.1:54329/ncs_restore_x");
    expect(databaseNameOf("postgres://u@h:1/abc")).toBe("abc");
    expect(restoreStamp(new Date("2026-11-05T09:30:01.123Z"))).toBe("20261105093001");
  });

  it("loads the server's backup engine from the monorepo", async () => {
    const e = await loadBackupEngine();
    expect(typeof e.writeBundle).toBe("function");
    expect(typeof e.restoreBundle).toBe("function");
    expect(e.bundleDirName("bkp_01JAAAAAAAAAAAAAAAAAAAAAAA", "manual", new Date("2026-11-05T09:30:00Z"))).toBe("20261105T093000Z-manual-aaaaaaaa");
  });
});
