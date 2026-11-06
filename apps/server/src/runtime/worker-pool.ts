/**
 * Bounded-concurrency worker pool (02 §2.2 run_worker). Jobs beyond `concurrency` wait in FIFO order.
 * `drain()` waits for running + queued jobs; `close()` rejects new submissions.
 */
export interface WorkerPool {
  readonly concurrency: number;
  readonly active: number;
  readonly queued: number;
  /** free slots right now (dispatchers use this to decide how many items to claim) */
  available(): number;
  submit<T>(job: () => Promise<T>): Promise<T>;
  drain(): Promise<void>;
  close(): void;
}

export function createWorkerPool(concurrency: number): WorkerPool {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("concurrency must be a positive integer");
  let active = 0;
  let closed = false;
  const queue: Array<() => void> = [];
  const idleWaiters: Array<() => void> = [];

  const settleIdle = () => {
    if (active === 0 && queue.length === 0) idleWaiters.splice(0).forEach((r) => r());
  };
  const next = () => {
    while (active < concurrency && queue.length) queue.shift()!();
    settleIdle();
  };

  return {
    concurrency,
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
    available: () => Math.max(0, concurrency - active - queue.length),
    submit<T>(job: () => Promise<T>) {
      if (closed) return Promise.reject(new Error("worker pool is closed"));
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          active++;
          Promise.resolve()
            .then(job)
            .then(resolve, reject)
            .finally(() => {
              active--;
              next();
            });
        });
        next();
      });
    },
    drain: () => (active === 0 && queue.length === 0 ? Promise.resolve() : new Promise<void>((r) => idleWaiters.push(r))),
    close() {
      closed = true;
    },
  };
}
