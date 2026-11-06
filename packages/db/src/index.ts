export * as schema from "./schema/index.js";
export * from "./schema/_types.js";
export {
  runMigrations,
  loadMigrations,
  validateMigrations,
  checksumOf,
  MigrationError,
  DEFAULT_MIGRATIONS_DIR,
  type MigrationFile,
  type MigrationTarget,
  type RunMigrationsOptions,
  type RunMigrationsResult,
} from "./migrate/runner.js";
export { postgresJsTarget, pgliteTarget } from "./migrate/targets.js";
export { EmbeddedPostgresRuntime, type EmbeddedPgOptions, type EmbeddedPgStatus } from "./runtime/embedded.js";
export {
  createDb,
  openDatabase,
  type DbHandle,
  type CreateDbOptions,
  type OpenDatabaseOptions,
  type OpenedDatabase,
  type NcsDb,
  type NcsPostgresDb,
  type Schema,
} from "./runtime/connection.js";
export { expandHome } from "./runtime/paths.js";
export {
  acquireServerLock,
  readLiveServerLock,
  serverLockPath,
  acquireInstanceAdvisoryLock,
  InstanceLockError,
  INSTANCE_LOCK_KEY,
  type ServerLockInfo,
  type HeldServerLock,
  type HeldAdvisoryLock,
} from "./runtime/instance-lock.js";
