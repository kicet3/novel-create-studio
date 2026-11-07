/**
 * SqlClient over a postgres.js `Sql` (structural type: this package has no runtime dependency). Statements are sent
 * unprepared (`prepare: false`): compatible with the Supabase transaction pooler. Multi-statement DDL goes through the
 * simple query protocol.
 */
import type { SqlClient } from "./apply.js";

export interface PostgresJsQueryLike extends PromiseLike<unknown> {
  simple?: () => PromiseLike<unknown>;
}

export interface PostgresJsLike {
  unsafe(text: string, params?: unknown[], opts?: { prepare?: boolean }): PostgresJsQueryLike;
  begin?: <T>(fn: (tx: PostgresJsLike) => Promise<T>) => Promise<unknown>;
}

function wrap(sql: PostgresJsLike, inTx: boolean): SqlClient {
  const c: SqlClient = {
    query: async <T>(text: string, params: readonly unknown[] = []) => [...((await sql.unsafe(text, [...params], { prepare: false })) as Iterable<T>)],
    exec: async (text) => {
      const q = sql.unsafe(text);
      await (q.simple ? q.simple() : q);
    },
    transaction: async <T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> => {
      if (inTx || !sql.begin) return fn(c);
      return (await sql.begin((tx) => fn(wrap(tx, true)))) as T;
    },
  };
  return c;
}

export function postgresJsSqlClient(sql: PostgresJsLike): SqlClient {
  return wrap(sql, false);
}
