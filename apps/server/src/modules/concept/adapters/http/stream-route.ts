/**
 * SSE of a concept session's live agent reply (설계 추가: 답변 스트리밍).
 *
 *   GET /api/novels/:novelId/concept/sessions/:sessionId/stream   (text/event-stream)
 *
 * Events: `delta` {text} (append), `reset` {} (drop what was shown), `done` {messageId} (the turn committed — refetch
 * the session view/messages; messageId null = no reply message, e.g. stopped / nothing in flight), `error` {message}.
 * On connect the client always gets `reset` then the accumulated text as one `delta` (late join / reconnect safe).
 * `: ping` comments keep proxies from closing an idle stream. The stream also ends with `done` {messageId:null} when
 * the session has no live turn any more (import, stop, a commit that rolled back), so clients never hang.
 * Behind the app's host guard like every /api route; no compression middleware is in the chain.
 */
import type { Request, Response, Router } from "express";
import { z } from "zod";
import { scopeOf, valid, validate } from "../../../../http/kit.js";
import type { ConceptService } from "../../index.js";
import type { TurnStreamEvent, TurnStreamHub } from "../../application/turn-stream.js";

export interface TurnStreamRouteOptions {
  heartbeatMs?: number;
  /** how often the route re-checks that a turn is still in flight (no live entry) */
  idleCheckMs?: number;
}

const sessionParams = z.object({ sessionId: z.string().regex(/^cns_/) });

export function mountTurnStreamRoute(novel: Router, svc: ConceptService, streams: TurnStreamHub, opts: TurnStreamRouteOptions = {}): void {
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const idleCheckMs = opts.idleCheckMs ?? 3_000;

  novel.get("/concept/sessions/:sessionId/stream", validate({ params: sessionParams }), async (req: Request, res: Response) => {
    const { params } = valid<{ params: { sessionId: string } }>(res);
    const scope = scopeOf(res);
    const sessionId = params.sessionId;
    await svc.getSession(scope, sessionId); // 404 before switching to SSE

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    req.socket.setNoDelay?.(true);
    req.socket.setTimeout?.(0);

    let closed = false;
    const timers: NodeJS.Timeout[] = [];
    let unsubscribe = () => {};
    const cleanup = () => {
      if (closed) return;
      closed = true;
      timers.forEach((t) => clearInterval(t));
      unsubscribe();
    };
    const write = (chunk: string) => {
      if (closed || res.writableEnded) return;
      res.write(chunk);
    };
    const send = (ev: TurnStreamEvent) => {
      const { type, ...data } = ev;
      write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      if (type === "done" || type === "error") {
        cleanup();
        res.end();
      }
    };
    req.on("close", cleanup);
    res.on("close", cleanup);

    write("retry: 3000\n\n");
    const inFlight = await svc.inFlightTurnTaskId(scope, sessionId).catch(() => null);
    if (closed) return;
    // synchronous from here: the snapshot already holds every event published before the subscription
    const snap = streams.snapshot(sessionId);
    unsubscribe = streams.subscribe(sessionId, send);
    send({ type: "reset" });
    if (snap && !snap.end) {
      if (snap.text) send({ type: "delta", text: snap.text });
    } else if (!inFlight || (snap?.end && snap.taskId === inFlight)) {
      // nothing queued/running (or this very turn already ended): end now, the client falls back to the session view
      return send(snap?.end ?? { type: "done", messageId: null });
    }
    // else: a turn is queued but has not started streaming yet → wait for it

    let orphanTicks = 0;
    const idleCheck = async () => {
      if (closed) return;
      const live = await svc.inFlightTurnTaskId(scope, sessionId).catch(() => undefined);
      if (closed || live === undefined) return; // lookup failed: try again next tick
      const now = streams.snapshot(sessionId);
      if (live) {
        orphanTicks = 0;
        return; // queued, or streaming
      }
      // no turn queued/running any more. An entry still marked live is either a commit whose `done` is about to be
      // published (after-commit) or a run that ended without its commit: give it one more tick, then end the stream
      // so the client refetches instead of hanging
      if (now && !now.end && ++orphanTicks < 2) return;
      send(now?.end ?? { type: "done", messageId: null });
    };
    timers.push(setInterval(() => write(": ping\n\n"), heartbeatMs));
    timers.push(setInterval(() => void idleCheck(), idleCheckMs));
    for (const t of timers) t.unref?.();
  });
}
