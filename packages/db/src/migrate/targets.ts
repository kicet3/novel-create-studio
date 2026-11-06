/** MigrationTarget adapters for postgres.js and PGlite. */
import type { Sql, TransactionSql } from "postgres";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import type { MigrationTarget } from "./runner.js";

export function postgresJsTarget(sql: Sql | TransactionSql): MigrationTarget {
  return {
    async exec(text) {
      await sql.unsafe(text);
    },
    async query(text, params = []) {
      return (await sql.unsafe(text, params as never[])) as never;
    },
    async transaction(fn) {
      if (!("begin" in sql)) throw new Error("nested transactions are not supported by the migration target");
      return (await (sql as Sql).begin(async (tx) => fn(postgresJsTarget(tx)))) as never;
    },
  };
}

export function pgliteTarget(pg: PGlite | Transaction): MigrationTarget {
  return {
    async exec(text) {
      await pg.exec(text);
    },
    async query(text, params = []) {
      const r = await pg.query(text, params);
      return r.rows as never;
    },
    async transaction(fn) {
      if (!("transaction" in pg)) throw new Error("nested transactions are not supported by the migration target");
      return (pg as PGlite).transaction(async (tx) => fn(pgliteTarget(tx)));
    },
  };
}
