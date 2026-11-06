/**
 * WorkSignal (02 §3.2, §5.1): non-durable in-process wake-up hint for queue consumers.
 * Register with `tx.afterCommit(() => signal.notify("wake", novelId))`. Consumers still poll the DB
 * every `scheduler.poll_interval_seconds`, so a lost hint only adds latency.
 */
export type WorkSignalKind = "wake" | "task" | "outbox" | "inbox" | "question" | "export" | (string & {});

export interface WorkSignal {
  notify(kind: WorkSignalKind, novelId?: string): void;
  /** returns an unsubscribe function */
  subscribe(kind: WorkSignalKind, fn: (novelId?: string) => void): () => void;
}

export function createWorkSignal(): WorkSignal {
  const subs = new Map<string, Set<(novelId?: string) => void>>();
  return {
    notify(kind, novelId) {
      for (const fn of subs.get(kind) ?? []) {
        try {
          fn(novelId);
        } catch {
          /* hints are best-effort */
        }
      }
    },
    subscribe(kind, fn) {
      let set = subs.get(kind);
      if (!set) subs.set(kind, (set = new Set()));
      set.add(fn);
      return () => set!.delete(fn);
    },
  };
}
