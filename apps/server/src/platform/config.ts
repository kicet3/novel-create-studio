/** Install config loading: flags > env (NCS_*, DATABASE_URL) > $NCS_HOME/config.json > defaults (08 §5.1). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  installConfigFromEnv,
  mergeConfigLayers,
  parseInstallConfig,
  type InstallConfig,
  type InstallConfigInput,
} from "@ncs/shared/config";
import { expandHome } from "@ncs/db";

export function loadInstallConfig(opts: { env?: NodeJS.ProcessEnv; flags?: InstallConfigInput } = {}): InstallConfig {
  const env = opts.env ?? process.env;
  const envLayer = installConfigFromEnv(env);
  const home = expandHome((envLayer as { home?: string }).home ?? "~/.ncs");
  const file = join(home, "config.json");
  const fileLayer = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as InstallConfigInput) : undefined;
  const cfg = parseInstallConfig(mergeConfigLayers(fileLayer, envLayer, opts.flags));
  return { ...cfg, home: expandHome(cfg.home) };
}
