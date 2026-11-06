/**
 * Platform: leaf services every module may use (08 §3.2 platform-leaf: never imports modules/http/runtime).
 */
import { join } from "node:path";
import type { InstallConfig } from "@ncs/shared";
import type { Db } from "./db.js";
import { createUnitOfWork, type UnitOfWork } from "./db.js";
import { systemClock, type Clock } from "./clock.js";
import { createIdGenerator, type IdGenerator } from "./ids.js";
import type { Logger } from "./logger.js";
import { createWorkSignal, type WorkSignal } from "./work-signal.js";
import { createLocalDiskStorage, type StorageProvider } from "./storage.js";
import { createLocalSecretCipher, type SecretCipher } from "./secrets.js";

export * from "./types.js";
export * from "./errors.js";
export * from "./db.js";
export * from "./clock.js";
export * from "./ids.js";
export * from "./logger.js";
export * from "./work-signal.js";
export * from "./storage.js";
export * from "./secrets.js";
export * from "./module.js";

export interface Platform {
  readonly config: InstallConfig;
  readonly appVersion: string;
  readonly log: Logger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly uow: UnitOfWork;
  readonly workSignal: WorkSignal;
  readonly storage: StorageProvider;
  /** AES-GCM cipher for `local_encrypted` secrets; the provider itself is `system.service.secrets` */
  readonly secretCipher: SecretCipher;
}

export interface CreatePlatformOptions {
  config: InstallConfig;
  appVersion: string;
  db: Db;
  log: Logger;
  clock?: Clock;
  ids?: IdGenerator;
  storage?: StorageProvider;
  secretCipher?: SecretCipher;
}

export function createPlatform(o: CreatePlatformOptions): Platform {
  const clock = o.clock ?? systemClock;
  return {
    config: o.config,
    appVersion: o.appVersion,
    log: o.log,
    clock,
    ids: o.ids ?? createIdGenerator(clock),
    uow: createUnitOfWork(o.db, (err) => o.log.error({ err }, "afterCommit hook failed")),
    workSignal: createWorkSignal(),
    storage: o.storage ?? createLocalDiskStorage(o.config.storage.root ?? join(o.config.home, "files")),
    secretCipher: o.secretCipher ?? createLocalSecretCipher(o.config.secrets.master_key_file ?? join(o.config.home, "secrets", "master.key"), { envKey: process.env.NCS_SECRETS_MASTER_KEY }),
  };
}
