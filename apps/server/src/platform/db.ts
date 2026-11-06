/**
 * Database access for modules: `UnitOfWork` (02 §3.2, §5.2).
 *
 * - `uow.run(fn)` opens ONE transaction; `fn` receives a `Tx` whose `db` is the drizzle transaction.
 * - Cross-module calls pass the caller's `Tx` down (02 M-2). Callees never open their own transaction;
 *   when a service method may be called both standalone and inside a caller's transaction, take an
 *   optional `tx` and use `uow.join(tx, fn)`.
 * - `tx.afterCommit(fn)` runs `fn` only after a successful COMMIT (dropped on rollback). Hooks must
 *   not do external I/O (02 §5.2 step 4) — they publish in-process signals (WorkSignal, ActivityBus).
 * - Serialization failures / deadlocks (40001, 40P01) are retried (default 3 attempts).
 * - Reads that need no transaction may use `uow.db` directly.
 */
import type { NcsDb } from "@ncs/db";

export type Db = NcsDb;

export interface Tx {
  /** drizzle handle bound to the open transaction */
  readonly db: Db;
  /** register a hook to run after COMMIT (in registration order) */
  afterCommit(fn: () => void | Promise<void>): void;
}

export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

export interface RunOptions {
  isolation?: IsolationLevel;
  /** max attempts on serialization failure / deadlock (default 3) */
  attempts?: number;
}

export interface UnitOfWork {
  /** non-transactional handle for plain reads */
  readonly db: Db;
  run<T>(fn: (tx: Tx) => Promise<T>, opts?: RunOptions): Promise<T>;
  /** reuse `outer` when given (callee inside caller's transaction), otherwise open a new one */
  join<T>(outer: Tx | undefined, fn: (tx: Tx) => Promise<T>, opts?: RunOptions): Promise<T>;
}

const RETRYABLE = new Set(["40001", "40P01"]);

function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isUniqueViolation(err: unknown): boolean {
  return pgCode(err) === "23505";
}

export function isForeignKeyViolation(err: unknown): boolean {
  return pgCode(err) === "23503";
}

export function isCheckViolation(err: unknown): boolean {
  return pgCode(err) === "23514";
}

/**
 * Run `fn` inside a SAVEPOINT of the caller's transaction: when `fn` throws, only its writes roll back (the outer
 * transaction stays usable) and the error is rethrown. `afterCommit` hooks registered inside are kept only when the
 * savepoint is released. Used where one failing item of a batch must not abort the rest.
 */
export async function savepoint<T>(tx: Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const hooks: Array<() => void | Promise<void>> = [];
  const result = await tx.db.transaction(async (t) => fn({ db: t as unknown as Db, afterCommit: (h) => void hooks.push(h) }));
  for (const h of hooks) tx.afterCommit(h);
  return result;
}

export function createUnitOfWork(db: Db, onHookError: (err: unknown) => void = () => {}): UnitOfWork {
  const run = async <T>(fn: (tx: Tx) => Promise<T>, opts: RunOptions = {}): Promise<T> => {
    const attempts = opts.attempts ?? 3;
    for (let attempt = 1; ; attempt++) {
      const hooks: Array<() => void | Promise<void>> = [];
      try {
        const result = await db.transaction(
          async (t) => fn({ db: t as unknown as Db, afterCommit: (h) => void hooks.push(h) }),
          opts.isolation ? { isolationLevel: opts.isolation } : undefined,
        );
        for (const h of hooks) {
          try {
            await h();
          } catch (err) {
            onHookError(err);
          }
        }
        return result;
      } catch (err) {
        const code = pgCode(err);
        if (code && RETRYABLE.has(code) && attempt < attempts) continue;
        throw err;
      }
    }
  };
  return {
    db,
    run,
    join: (outer, fn, opts) => (outer ? fn(outer) : run(fn, opts)),
  };
}
