/** Process-wide API instance over the real env + postgres.js pool (server only). */
import "server-only";
import { createReaderApi, type ReaderApi } from "./api";
import { getDb } from "./db";
import { getEnv } from "./env";

let api: ReaderApi | null = null;

export function getReaderApi(): ReaderApi {
  api ??= createReaderApi({ env: getEnv(), db: () => getDb().client });
  return api;
}
