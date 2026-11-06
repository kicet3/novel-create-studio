/**
 * In-process pub/sub of live concept replies (설계 추가: 컨셉 답변 스트리밍). Single server process: the concept_turn
 * handler and the SSE route share this hub, keyed by concept session id. Display only — the persisted agent message
 * (validated output, written in the commit) is the source of truth; `done` tells clients to refetch it.
 *
 * Per session there is at most one live turn (`taskId`). Events of an older task are ignored, so a stopped /
 * superseded turn can never write into a newer one. Late joiners get the accumulated text (`snapshot()`), and a
 * finished turn's `done`/`error` is kept for a short while so a client that connects just after it still learns it.
 */

export type TurnStreamEvent =
  | { type: "delta"; text: string }
  | { type: "reset" }
  | { type: "done"; messageId: string | null }
  | { type: "error"; message: string };

export interface TurnStreamSnapshot {
  taskId: string;
  text: string;
  /** set once the turn ended */
  end: Extract<TurnStreamEvent, { type: "done" | "error" }> | null;
}

type Listener = (ev: TurnStreamEvent) => void;

interface Entry {
  taskId: string;
  text: string;
  end: TurnStreamSnapshot["end"];
  endedAt: number;
}

export interface TurnStreamHub {
  /** a turn starts streaming (replaces any previous entry of the session) */
  begin(sessionId: string, taskId: string): void;
  delta(sessionId: string, taskId: string, text: string): void;
  reset(sessionId: string, taskId: string): void;
  /** the turn committed (messageId = persisted agent message, null = no reply message) */
  done(sessionId: string, taskId: string | null, messageId: string | null): void;
  error(sessionId: string, taskId: string | null, message: string): void;
  /**
   * the run of `taskId` stopped without committing but the task lives on (paused, lease lost, retry, budget wait):
   * drop the shown text (`reset`) and forget the entry, so the stream waits for the next run instead of a frozen bubble
   */
  abandon(sessionId: string, taskId: string): void;
  snapshot(sessionId: string): TurnStreamSnapshot | null;
  subscribe(sessionId: string, listener: Listener): () => void;
  /** live subscriber count (tests / diagnostics) */
  listeners(sessionId: string): number;
}

export function createTurnStreamHub(opts: { now?: () => number; keepEndedMs?: number } = {}): TurnStreamHub {
  const now = opts.now ?? Date.now;
  const keepEndedMs = opts.keepEndedMs ?? 60_000;
  const entries = new Map<string, Entry>();
  const subs = new Map<string, Set<Listener>>();

  const publish = (sessionId: string, ev: TurnStreamEvent) => {
    for (const l of [...(subs.get(sessionId) ?? [])]) {
      try {
        l(ev);
      } catch {
        /* a broken subscriber must not break the turn */
      }
    }
  };
  const sweep = () => {
    const t = now();
    for (const [k, e] of entries) if (e.end && t - e.endedAt > keepEndedMs) entries.delete(k);
  };
  const live = (sessionId: string, taskId: string | null): Entry | null => {
    const e = entries.get(sessionId);
    if (!e || e.end) return null;
    return taskId === null || e.taskId === taskId ? e : null;
  };
  const finish = (sessionId: string, taskId: string | null, end: NonNullable<Entry["end"]>) => {
    const e = entries.get(sessionId);
    if (e && !e.end && (taskId === null || e.taskId === taskId)) {
      e.end = end;
      e.endedAt = now();
    } else if (e?.end && taskId !== null && e.taskId === taskId) {
      return; // this turn already ended (e.g. stopped, then its run finished): never a second done/error
    } else if (!e || e.end) {
      // the turn never streamed (deterministic path, reused response): remember the end anyway
      entries.set(sessionId, { taskId: taskId ?? "", text: "", end, endedAt: now() });
    } else return; // a different task is live: not ours
    publish(sessionId, end);
  };

  return {
    begin(sessionId, taskId) {
      sweep();
      const prev = entries.get(sessionId);
      entries.set(sessionId, { taskId, text: "", end: null, endedAt: 0 });
      if (prev && prev.text && !prev.end) publish(sessionId, { type: "reset" });
    },
    delta(sessionId, taskId, text) {
      const e = live(sessionId, taskId);
      if (!e || !text) return;
      e.text += text;
      publish(sessionId, { type: "delta", text });
    },
    reset(sessionId, taskId) {
      const e = live(sessionId, taskId);
      if (!e || !e.text) return;
      e.text = "";
      publish(sessionId, { type: "reset" });
    },
    done(sessionId, taskId, messageId) {
      finish(sessionId, taskId, { type: "done", messageId });
    },
    error(sessionId, taskId, message) {
      finish(sessionId, taskId, { type: "error", message });
    },
    abandon(sessionId, taskId) {
      const e = live(sessionId, taskId);
      if (!e) return;
      entries.delete(sessionId);
      if (e.text) publish(sessionId, { type: "reset" });
    },
    snapshot(sessionId) {
      sweep();
      const e = entries.get(sessionId);
      return e ? { taskId: e.taskId, text: e.text, end: e.end } : null;
    },
    subscribe(sessionId, listener) {
      let set = subs.get(sessionId);
      if (!set) subs.set(sessionId, (set = new Set()));
      set.add(listener);
      return () => {
        const s = subs.get(sessionId);
        if (!s) return;
        s.delete(listener);
        if (!s.size) subs.delete(sessionId);
      };
    },
    listeners(sessionId) {
      return subs.get(sessionId)?.size ?? 0;
    },
  };
}
