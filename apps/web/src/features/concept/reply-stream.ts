import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiUrl } from "../../api/client.js";
import { queryKeys } from "../../api/query-keys.js";

/**
 * Live concept reply over SSE (`GET …/concept/sessions/:id/stream`, 설계 추가: 답변 스트리밍).
 * Display only: the persisted agent message (refetched on `done`) replaces the live bubble.
 * Polling of the session view / messages keeps running as the fallback when SSE is unavailable.
 */

export type ReplyStreamPhase = "idle" | "streaming" | "ended" | "failed";

export interface ReplyStreamState {
  /** in-flight task this stream belongs to */
  taskId: string | null;
  text: string;
  phase: ReplyStreamPhase;
  /** `done.messageId` (null: ended without a reply message) */
  messageId: string | null;
}

export type ReplyStreamEvent =
  | { type: "delta"; text: string }
  | { type: "reset" }
  | { type: "done"; messageId: string | null }
  | { type: "error"; message?: string }
  /** transport gave up (fallback to polling) */
  | { type: "transport_failed" };

export const IDLE_REPLY: ReplyStreamState = { taskId: null, text: "", phase: "idle", messageId: null };

/** pure reducer (unit-tested) */
export function applyReplyEvent(s: ReplyStreamState, ev: ReplyStreamEvent): ReplyStreamState {
  if (s.phase === "ended" || s.phase === "failed") return s; // a finished turn never changes again
  switch (ev.type) {
    case "delta":
      return ev.text ? { ...s, phase: "streaming", text: s.text + ev.text } : s;
    case "reset":
      return s.text ? { ...s, text: "" } : s;
    case "done":
      return { ...s, phase: "ended", messageId: ev.messageId };
    case "error":
      return { ...s, phase: "ended", messageId: null };
    case "transport_failed":
      return { ...s, phase: "failed" };
  }
}

/**
 * Whether the live bubble should still be shown. After `done` it stays until the persisted message is in the list
 * (no flicker, no duplicate); without a message id until the session is no longer in flight.
 */
export function showLiveReply(s: ReplyStreamState, messageIds: ReadonlySet<string>, inFlight: boolean): boolean {
  if (!s.text) return false;
  if (s.phase === "streaming" || s.phase === "idle") return true;
  if (s.phase === "failed") return inFlight;
  return s.messageId ? !messageIds.has(s.messageId) : inFlight;
}

const FLUSH_MS = 60;
const MAX_TRANSPORT_ERRORS = 3;

/** opens the stream while `taskId` (session.inFlightTaskId) is set; one stream per task */
export function useConceptReplyStream(novelId: string, sessionId: string, taskId: string | null): ReplyStreamState {
  const qc = useQueryClient();
  const [state, setState] = useState<ReplyStreamState>(IDLE_REPLY);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!taskId) return;
    // a new turn: start empty (the previous turn's bubble is already replaced by its message)
    let cur: ReplyStreamState = { ...IDLE_REPLY, taskId };
    setState(cur);
    if (typeof EventSource === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let transportErrors = 0;
    const flush = () => {
      timer = null;
      setState(cur);
    };
    const apply = (ev: ReplyStreamEvent, now = false) => {
      cur = applyReplyEvent(cur, ev);
      if (now) {
        if (timer) clearTimeout(timer);
        flush();
      } else timer ??= setTimeout(flush, FLUSH_MS); // batch token deltas into ~16 renders/s
    };
    const es = new EventSource(apiUrl(`/novels/${novelId}/concept/sessions/${sessionId}/stream`));
    const close = () => {
      if (closed) return;
      closed = true;
      es.close();
    };
    const refetch = () => {
      void qc.invalidateQueries({ queryKey: queryKeys.novel(novelId).concept() });
    };
    const data = (e: Event): Record<string, unknown> => {
      try {
        return JSON.parse((e as MessageEvent<string>).data) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    es.addEventListener("delta", (e) => {
      transportErrors = 0;
      const text = data(e).text;
      if (typeof text === "string") apply({ type: "delta", text });
    });
    es.addEventListener("reset", () => {
      transportErrors = 0;
      apply({ type: "reset" });
    });
    es.addEventListener("done", (e) => {
      const id = data(e).messageId;
      close();
      apply({ type: "done", messageId: typeof id === "string" ? id : null }, true);
      refetch();
    });
    es.addEventListener("error", (e) => {
      // a server `event: error` carries data; a transport error does not
      if ((e as MessageEvent).data) {
        close();
        apply({ type: "error" }, true);
        refetch();
        return;
      }
      transportErrors++;
      if (es.readyState === EventSource.CLOSED || transportErrors >= MAX_TRANSPORT_ERRORS) {
        close();
        apply({ type: "transport_failed" }, true); // polling (TURN_POLL_MS) carries on
      }
    });
    return () => {
      close();
      if (timer) clearTimeout(timer);
    };
  }, [novelId, sessionId, taskId, qc]);

  return state;
}
