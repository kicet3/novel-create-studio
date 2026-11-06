/**
 * Background runtime (02 §2.2, §7.1, §7.3): runs registered BackgroundLoops on an interval plus
 * WorkSignal hints, never overlapping ticks of the same loop. `stop()` aborts the shared signal,
 * waits for in-flight ticks (bounded by `graceMs`) and drains the worker pool.
 */
import type { BackgroundLoop, Logger, WorkSignal } from "../platform/index.js";
import { createWorkerPool, type WorkerPool } from "./worker-pool.js";

export interface Runtime {
  readonly signal: AbortSignal;
  /** shared pool for task execution (size = run.max_concurrent_global) */
  readonly pool: WorkerPool;
  add(loop: BackgroundLoop): void;
  start(): void;
  /** trigger one loop immediately (tests / admin) */
  kick(name: string): Promise<void>;
  stop(graceMs?: number): Promise<void>;
  readonly loops: readonly string[];
}

interface LoopState {
  loop: BackgroundLoop;
  timer: NodeJS.Timeout | null;
  running: Promise<void> | null;
  rerun: boolean;
  unsubscribe: Array<() => void>;
}

export function createRuntime(o: { log: Logger; workSignal: WorkSignal; concurrency: number }): Runtime {
  const ac = new AbortController();
  const pool = createWorkerPool(o.concurrency);
  const states = new Map<string, LoopState>();
  let started = false;

  const runTick = (st: LoopState): Promise<void> => {
    if (ac.signal.aborted) return Promise.resolve();
    if (st.running) {
      st.rerun = true; // coalesce hints that arrive mid-tick into one follow-up tick
      return st.running;
    }
    st.running = (async () => {
      do {
        st.rerun = false;
        try {
          await st.loop.tick(ac.signal);
        } catch (err) {
          if (!ac.signal.aborted) o.log.error({ err, loop: st.loop.name }, "background loop tick failed");
        }
      } while (st.rerun && !ac.signal.aborted);
    })().finally(() => {
      st.running = null;
    });
    return st.running;
  };

  const schedule = (st: LoopState) => {
    if (ac.signal.aborted) return;
    st.timer = setTimeout(async () => {
      await runTick(st);
      schedule(st);
    }, st.loop.intervalMs);
    st.timer.unref?.();
  };

  const begin = (st: LoopState) => {
    for (const kind of st.loop.wakeOn ?? []) st.unsubscribe.push(o.workSignal.subscribe(kind, () => void runTick(st)));
    if (st.loop.runOnStart ?? true) void runTick(st);
    schedule(st);
  };

  return {
    signal: ac.signal,
    pool,
    get loops() {
      return [...states.keys()];
    },
    add(loop) {
      if (states.has(loop.name)) throw new Error(`duplicate background loop: ${loop.name}`);
      const st: LoopState = { loop, timer: null, running: null, rerun: false, unsubscribe: [] };
      states.set(loop.name, st);
      if (started) begin(st);
    },
    start() {
      if (started) return;
      started = true;
      for (const st of states.values()) begin(st);
      o.log.info({ loops: [...states.keys()] }, "runtime started");
    },
    kick(name) {
      const st = states.get(name);
      if (!st) throw new Error(`unknown loop: ${name}`);
      return runTick(st);
    },
    async stop(graceMs = 10_000) {
      if (ac.signal.aborted) return;
      ac.abort();
      pool.close();
      for (const st of states.values()) {
        if (st.timer) clearTimeout(st.timer);
        st.unsubscribe.forEach((u) => u());
      }
      const inflight = Promise.all([...states.values()].map((s) => s.running ?? Promise.resolve()).concat(pool.drain()));
      let t: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        inflight.then(() => false),
        new Promise<boolean>((r) => {
          t = setTimeout(() => r(true), graceMs);
        }),
      ]);
      clearTimeout(t);
      if (timedOut) o.log.warn({ graceMs }, "runtime stop: in-flight work did not finish within grace period");
    },
  };
}
