/**
 * HTTP adapter of `revision` (`…` = /api/novels/:novelId). SSE contract = concept chat stream
 * (`delta` {text} / `reset` / `done` {messageId} / `error` {message}; ends with done null when nothing is in flight).
 */
import type { Request, Response } from "express";
import { z } from "zod";
import { revisionCloseRequestSchema, revisionPostMessageRequestSchema, revisionProposalDecisionRequestSchema, revisionRewriteRequestSchema } from "@ncs/shared";
import type { ApiRouters } from "../../../../platform/index.js";
import { actorOf, created, scopeOf, valid, validate } from "../../../../http/kit.js";
import type { TurnStreamEvent, TurnStreamHub } from "../../../concept/index.js";
import type { RevisionService } from "../../index.js";

const epParams = z.object({ episodeNo: z.coerce.number().int().min(1) });
const propParams = epParams.extend({ proposalId: z.string().regex(/^rvp_/) });
type P = { episodeNo: number };

export function mountRevisionRoutes({ novel }: ApiRouters, svc: RevisionService, streams: TurnStreamHub, opts: { heartbeatMs?: number; idleCheckMs?: number } = {}): void {
  const base = "/episodes/:episodeNo/revision-chat";
  novel.get(base, validate({ params: epParams }), async (_req, res) => {
    const { params } = valid<{ params: P }>(res);
    res.json(await svc.getView(scopeOf(res), params.episodeNo));
  });
  novel.post(`${base}/messages`, validate({ params: epParams, body: revisionPostMessageRequestSchema }), async (_req, res) => {
    const { params, body } = valid<{ params: P; body: z.output<typeof revisionPostMessageRequestSchema> }>(res);
    created(res, await svc.postMessage(scopeOf(res), params.episodeNo, body, actorOf(res)));
  });
  novel.post(`${base}/proposals/:proposalId/decision`, validate({ params: propParams, body: revisionProposalDecisionRequestSchema }), async (_req, res) => {
    const { params, body } = valid<{ params: P & { proposalId: string }; body: z.output<typeof revisionProposalDecisionRequestSchema> }>(res);
    res.json(await svc.decideProposal(scopeOf(res), params.episodeNo, params.proposalId, body, actorOf(res)));
  });
  novel.post(`${base}/close`, validate({ params: epParams, body: revisionCloseRequestSchema }), async (_req, res) => {
    const { params, body } = valid<{ params: P; body: z.output<typeof revisionCloseRequestSchema> }>(res);
    res.json(await svc.close(scopeOf(res), params.episodeNo, body, actorOf(res)));
  });
  novel.post(`${base}/rewrite`, validate({ params: epParams, body: revisionRewriteRequestSchema }), async (_req, res) => {
    const { params, body } = valid<{ params: P; body: z.output<typeof revisionRewriteRequestSchema> }>(res);
    res.json(await svc.rewrite(scopeOf(res), params.episodeNo, body, actorOf(res)));
  });
  novel.post(`${base}/stop-turn`, validate({ params: epParams }), async (_req, res) => {
    const { params } = valid<{ params: P }>(res);
    res.json(await svc.stopTurn(scopeOf(res), params.episodeNo, actorOf(res)));
  });

  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const idleCheckMs = opts.idleCheckMs ?? 3_000;
  novel.get(`${base}/stream`, validate({ params: epParams }), async (req: Request, res: Response) => {
    const { params } = valid<{ params: P }>(res);
    const scope = scopeOf(res);
    const view = await svc.getView(scope, params.episodeNo); // 404 before switching to SSE
    const sessionId = view.session?.id ?? null;
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
      if (!closed && !res.writableEnded) res.write(chunk);
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
    if (!sessionId) return send({ type: "done", messageId: null });
    const inFlight = await svc.inFlightTurnTaskId(scope, sessionId).catch(() => null);
    if (closed) return;
    const snap = streams.snapshot(sessionId);
    unsubscribe = streams.subscribe(sessionId, send);
    send({ type: "reset" });
    if (snap && !snap.end) {
      if (snap.text) send({ type: "delta", text: snap.text });
    } else if (!inFlight || (snap?.end && snap.taskId === inFlight)) {
      return send(snap?.end ?? { type: "done", messageId: null });
    }
    let orphanTicks = 0;
    const idleCheck = async () => {
      if (closed) return;
      const live = await svc.inFlightTurnTaskId(scope, sessionId).catch(() => undefined);
      if (closed || live === undefined) return;
      const now = streams.snapshot(sessionId);
      if (live) {
        orphanTicks = 0;
        return;
      }
      if (now && !now.end && ++orphanTicks < 2) return;
      send(now?.end ?? { type: "done", messageId: null });
    };
    timers.push(setInterval(() => write(": ping\n\n"), heartbeatMs));
    timers.push(setInterval(() => void idleCheck(), idleCheckMs));
    for (const t of timers) t.unref?.();
  });
}
