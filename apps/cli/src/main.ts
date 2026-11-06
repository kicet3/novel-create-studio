#!/usr/bin/env node
/** `ncs` CLI (design/08 §5.5): onboard, doctor, run, service, backup, restore, migrate, config, secrets. */
import { Command } from "commander";
import { EmbeddedPostgresRuntime, expandHome } from "@ncs/db";
import { registerOnboardCommand } from "./commands/onboard.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerRunCommand } from "./commands/run.js";
import { registerServiceCommands } from "./commands/service.js";
import { registerBackupCommands } from "./commands/backup.js";
import { registerRestoreCommand } from "./commands/restore.js";
import { registerMigrateCommands } from "./commands/migrate.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerSecretsCommands } from "./commands/secrets.js";
import { embeddedDataDir, loadConfig } from "./lib/config.js";
import { isLongRunning } from "./lib/output.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("ncs")
    .description("Novel Create Studio CLI")
    .version("0.1.0")
    .option("--home <dir>", "설치 홈(NCS_HOME)")
    .hook("preAction", (cmd) => {
      const home = cmd.opts<{ home?: string }>().home;
      if (home) process.env.NCS_HOME = expandHome(home);
    });

  registerOnboardCommand(program);
  registerDoctorCommand(program);
  registerRunCommand(program);
  registerServiceCommands(program);
  registerBackupCommands(program);
  registerRestoreCommand(program);
  registerMigrateCommands(program);
  registerConfigCommands(program);
  registerSecretsCommands(program);

  program
    .command("db-status")
    .description("embedded PostgreSQL 데이터 디렉터리 상태를 보여 줍니다")
    .action(() => {
      const { config } = loadConfig();
      const rt = new EmbeddedPostgresRuntime({ dataDir: embeddedDataDir(config), port: config.database.embedded_port });
      console.log(JSON.stringify(rt.status(), null, 2));
    });
  return program;
}

const isEntry = process.argv[1] && /[\\/]main\.(ts|js)$/.test(process.argv[1]) && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).slice(-2).join("/"));
if (isEntry) {
  try {
    await buildProgram().parseAsync(process.argv);
    if (!isLongRunning()) process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
  } catch (err) {
    process.stderr.write(`오류: ${(err as Error).message}\n`);
    process.exit(typeof process.exitCode === "number" && process.exitCode ? process.exitCode : 1);
  }
}
