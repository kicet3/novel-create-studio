/**
 * SqlClient over a PGlite-like object (structural type: no runtime dependency on PGlite). Used by tests, where an
 * in-process PGlite stands in for the Supabase database.
 */
import type { SqlClient } from "./apply.js";

export interface PgliteLike {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<unknown>;
  transaction<T>(fn: (tx: PgliteTxLike) => Promise<T>): Promise<T>;
}

export interface PgliteTxLike {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<unknown>;
}

function txClient(tx: PgliteTxLike): SqlClient {
  const c: SqlClient = {
    query: async <T>(text: string, params: readonly unknown[] = []) => (await tx.query<T>(text, [...params])).rows,
    exec: async (text) => void (await tx.exec(text)),
    // nested: same transaction
    transaction: (fn) => fn(c),
  };
  return c;
}

export function pgliteSqlClient(pg: PgliteLike): SqlClient {
  return {
    query: async <T>(text: string, params: readonly unknown[] = []) => (await pg.query<T>(text, [...params])).rows,
    exec: async (text) => void (await pg.exec(text)),
    transaction: (fn) => pg.transaction((tx) => fn(txClient(tx))),
  };
}
