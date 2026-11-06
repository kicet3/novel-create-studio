export { startServer, APP_VERSION, type StartedServer } from "./main.js";
export { createServerCore, type ServerCore, type CreateServerCoreOptions } from "./app-core.js";
export { createApp, type AppDeps } from "./http/app.js";
export { loadInstallConfig } from "./platform/config.js";
export { createLogger, type Logger } from "./platform/logger.js";
export * as backupEngine from "./modules/system/adapters/backup/backup-engine.js";
