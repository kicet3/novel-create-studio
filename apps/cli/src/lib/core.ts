/** Offline server core (server NOT running): open DB (migrate), build all modules, no HTTP/loops. */
import { openDatabase } from "@ncs/db";
import type { InstallConfig } from "@ncs/shared";
import { loadServer, type ServerCoreLike } from "./server-loader.js";

export async function withCore<T>(config: InstallConfig, fn: (core: ServerCoreLike) => Promise<T>, opts: { logLevel?: string } = {}): Promise<T> {
  const server = await loadServer();
  const log = server.createLogger(opts.logLevel ?? process.env.NCS_CLI_LOG_LEVEL ?? "error", { pretty: false });
  const database = await openDatabase(config, { appVersion: server.APP_VERSION });
  try {
    const core = server.createServerCore({ config, appVersion: server.APP_VERSION, db: database.db, log, databaseMode: database.mode });
    await core.start({ background: false });
    try {
      return await fn(core);
    } finally {
      await core.stop();
    }
  } finally {
    await database.close();
  }
}

/** CLI actions are taken by the install owner (local_trusted: single user). */
export async function ownerActor(core: ServerCoreLike): Promise<{ type: "user"; id: string } | { type: "system"; id: "backup" }> {
  const owner = await core.modules.novel.service.getOwnerUser();
  return owner ? { type: "user", id: owner.id } : { type: "system", id: "backup" };
}
