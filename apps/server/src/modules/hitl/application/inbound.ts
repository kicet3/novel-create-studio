/**
 * Messenger inbound handler of hitl (05 §6.1 I6, §6.3 AnswerSession, §6.4 routing):
 * answer_option / answer_text / start_text_input / session_step / unrelated_text → acceptAnswer.
 * Multi-step input (reject reason, multi choice, free text) lives in AnswerSession; only the last
 * step submits one Answer (intermediate steps never race, 05 §6.3).
 */
import { DEFAULTS } from "@ncs/shared";
import type { NovelScope, Tx } from "../../../platform/index.js";
import type { InboundAction, InboundActionHandler, InboundContext, InboundResult, MessagingService } from "../../messaging/index.js";
import type { AcceptAnswerInput, Question } from "../index.js";
import { hitlRepo as repo, type AnswerSession } from "../adapters/db/hitl-repository.js";
import { SESSION_TRANSITIONS, findRule } from "../domain/transitions.js";
import type { HitlCore } from "./hitl-service.js";

const processed: InboundResult = { status: "processed" };
const REWORK_IDX: Record<number, "outline" | "draft" | "polish"> = { 11: "outline", 12: "draft", 13: "polish" };

export function createHitlInboundHandler(core: HitlCore, messaging: MessagingService, platform: { ids: { next(p: "ase"): string }; clock: { date(): Date } }): InboundActionHandler {
  const now = () => platform.clock.date();

  async function say(ctx: InboundContext, text: string, key: string, extra: { forceReply?: boolean; questionId?: string; buttons?: Array<{ label: string; value: string }> } = {}) {
    await messaging.sendNotice(ctx.tx, ctx.scope, {
      kind: "command_reply",
      channelId: ctx.channel.id,
      text,
      idempotencyKey: `command_reply:${ctx.inboxId}:${ctx.channel.id}:${key}`,
      forceReply: extra.forceReply,
      buttons: extra.buttons,
      refs: extra.questionId ? [{ refType: "question", refId: extra.questionId }] : [],
    });
  }

  async function submit(ctx: InboundContext, q: Question, input: Omit<AcceptAnswerInput, "questionId" | "channelId" | "responderUserId" | "sourceKey">) {
    const r = await core.acceptAnswer(ctx.scope, { ...input, questionId: q.id, channelId: ctx.channel.id, responderUserId: ctx.actor.id, sourceKey: ctx.inboxId }, ctx.tx);
    if (r.disposition === "late") await say(ctx, `Q-${q.displayNo}: 이미 다른 답이 채택돼 늦은 답변으로 기록했습니다. 웹 인박스에서 확인하세요.`, "late");
    return r;
  }

  async function startSession(ctx: InboundContext, q: Question, step: string, collected: Record<string, unknown>): Promise<AnswerSession> {
    const at = now();
    const prev = await repo.activeSession(ctx.tx.db, ctx.scope, ctx.channel.id, ctx.senderExternalRef);
    if (prev) {
      findRule(SESSION_TRANSITIONS, "answer_session", prev.status, "cancelled");
      await repo.updateSession(ctx.tx.db, ctx.scope, prev.id, { status: "cancelled", updatedAt: at }); // AS4: one active per channel/responder (INV-AS-01)
    }
    return repo.insertSession(ctx.tx.db, {
      id: platform.ids.next("ase"),
      novelId: ctx.scope.novelId,
      channelId: ctx.channel.id,
      questionId: q.id,
      responderExternalRef: ctx.senderExternalRef,
      step,
      collected,
      status: "active", // AS1
      expiresAt: new Date(at.getTime() + DEFAULTS["answer_session.ttl_minutes"] * 60_000),
      createdAt: at,
      updatedAt: at,
    });
  }

  async function complete(tx: Tx, scope: NovelScope, s: AnswerSession) {
    findRule(SESSION_TRANSITIONS, "answer_session", s.status, "completed");
    await repo.updateSession(tx.db, scope, s.id, { status: "completed", updatedAt: now() }); // AS2 (also when late)
  }

  async function openQuestion(ctx: InboundContext, questionId: string): Promise<Question | "unknown" | "closed"> {
    const q = await repo.getQuestion(ctx.tx.db, ctx.scope, questionId, true);
    if (!q) return "unknown"; // restored backup etc. (02 §8.4)
    if (q.status !== "open" && q.status !== "pending") return "closed";
    return q;
  }

  async function closedReply(ctx: InboundContext, questionId: string) {
    const q = await repo.getQuestion(ctx.tx.db, ctx.scope, questionId);
    await say(ctx, `${q ? `Q-${q.displayNo}` : "이 질문"}은(는) 이미 닫혔습니다.`, "closed");
  }

  async function handle(action: InboundAction, ctx: InboundContext): Promise<InboundResult> {
    switch (action.kind) {
      case "answer_option": {
        const q = await repo.getQuestion(ctx.tx.db, ctx.scope, action.questionId, true);
        if (!q) return { status: "ignored", reason: "unknown_question" };
        const idx = Number(action.optionId);
        if ((q.questionType === "approve_reject" || q.questionType === "attachment_review") && idx === 1) {
          return handle({ kind: "session_step", answerSessionId: "", value: { questionId: q.id, action: "r", idx: 1 } }, ctx);
        }
        // closed questions still go through acceptAnswer → late / duplicate (05 §6.2)
        await submit(ctx, q, { optionIds: [action.optionId] });
        return processed;
      }
      case "start_text_input": {
        const q = await openQuestion(ctx, action.questionId);
        if (q === "unknown") return { status: "ignored", reason: "unknown_question" };
        if (q === "closed") return closedReply(ctx, action.questionId).then(() => processed);
        await startSession(ctx, q, "enter_text", {});
        await say(ctx, `Q-${q.displayNo} 답을 이 메시지에 답장으로 보내 주세요.`, "prompt", { forceReply: true, questionId: q.id });
        return processed;
      }
      case "session_step": {
        const v = action.value as { questionId?: string; action?: string; idx?: number };
        if (!v?.questionId) return { status: "ignored", reason: "unsupported" };
        const q = await openQuestion(ctx, v.questionId);
        if (q === "unknown") return { status: "ignored", reason: "unknown_question" };
        if (q === "closed") return closedReply(ctx, v.questionId).then(() => processed);
        const idx = v.idx ?? 0;
        if (v.action === "r") {
          if (idx === 1) {
            const approval = q.approvalId ? await repo.getApproval(ctx.tx.db, ctx.scope, q.approvalId) : null;
            if (approval?.approvalType === "episode") {
              await startSession(ctx, q, "choose_rework_from", {});
              await say(ctx, `Q-${q.displayNo} 반려: 어느 단계부터 다시 쓸까요?`, "rework", {
                buttons: [
                  { label: "아웃라인부터", value: `v1|r|${q.id}|11` },
                  { label: "초고부터", value: `v1|r|${q.id}|12` },
                  { label: "문장만", value: `v1|r|${q.id}|13` },
                ],
              });
              return processed;
            }
            await startSession(ctx, q, "enter_reason", {});
            await say(ctx, `Q-${q.displayNo} 반려 사유를 이 메시지에 답장으로 보내 주세요.`, "reason", { forceReply: true, questionId: q.id });
            return processed;
          }
          const rework = REWORK_IDX[idx];
          const s = await repo.activeSession(ctx.tx.db, ctx.scope, ctx.channel.id, ctx.senderExternalRef);
          if (!rework || !s || s.questionId !== q.id || s.step !== "choose_rework_from") {
            await say(ctx, "입력 시간이 지났습니다. 다시 누르세요.", "stale");
            return processed;
          }
          await repo.updateSession(ctx.tx.db, ctx.scope, s.id, { step: "enter_reason", collected: { ...(s.collected as object), rework_from: rework }, updatedAt: now() });
          await say(ctx, `Q-${q.displayNo} 반려 사유를 이 메시지에 답장으로 보내 주세요.`, "reason", { forceReply: true, questionId: q.id });
          return processed;
        }
        if (v.action === "m") {
          let s = await repo.activeSession(ctx.tx.db, ctx.scope, ctx.channel.id, ctx.senderExternalRef);
          if (!s || s.questionId !== q.id || s.step !== "toggle_options") s = await startSession(ctx, q, "toggle_options", { selected: [] });
          const sel = new Set<number>(((s.collected as { selected?: number[] }).selected ?? []) as number[]);
          if (sel.has(idx)) sel.delete(idx);
          else sel.add(idx);
          const selected = [...sel].sort((a, b) => a - b);
          await repo.updateSession(ctx.tx.db, ctx.scope, s.id, { collected: { selected }, updatedAt: now() });
          const options = await repo.listOptions(ctx.tx.db, ctx.scope, q.id);
          await say(ctx, `Q-${q.displayNo} 선택: ${selected.map((i) => options[i]?.label).filter(Boolean).join(", ") || "없음"} — 다 고르면 [선택 완료]를 누르세요.`, `toggle:${idx}`);
          return processed;
        }
        if (v.action === "d") {
          const s = await repo.activeSession(ctx.tx.db, ctx.scope, ctx.channel.id, ctx.senderExternalRef);
          const selected = s && s.questionId === q.id ? ((s.collected as { selected?: number[] }).selected ?? []) : [];
          if (!selected.length) {
            await say(ctx, "선택한 항목이 없습니다. 항목을 누른 뒤 [선택 완료]를 누르세요.", "empty");
            return processed;
          }
          await complete(ctx.tx, ctx.scope, s!);
          await submit(ctx, q, { optionIds: selected.map(String) });
          return processed;
        }
        return { status: "ignored", reason: "unsupported" };
      }
      case "answer_text": {
        const s = await repo.activeSession(ctx.tx.db, ctx.scope, ctx.channel.id, ctx.senderExternalRef);
        if (s && (action.questionId === null || action.questionId === s.questionId) && (s.step === "enter_text" || s.step === "enter_reason")) {
          const q = await repo.getQuestion(ctx.tx.db, ctx.scope, s.questionId, true);
          if (!q) return { status: "ignored", reason: "unknown_question" };
          await complete(ctx.tx, ctx.scope, s);
          if (s.step === "enter_reason") {
            const rework = (s.collected as { rework_from?: "outline" | "draft" | "polish" }).rework_from;
            await submit(ctx, q, { approval: { decision: "rejected", decisionNote: action.text, ...(rework ? { reworkFrom: rework } : {}) } });
          } else {
            await submit(ctx, q, { text: action.text });
          }
          return processed;
        }
        if (!action.questionId) return { status: "ignored", reason: "unsupported" }; // let concept / fallback routing try
        const q = await repo.getQuestion(ctx.tx.db, ctx.scope, action.questionId, true);
        if (!q) return { status: "ignored", reason: "unknown_question" };
        if (q.questionType === "approve_reject" || q.questionType === "multi_choice" || q.questionType === "attachment_review" || q.grade === "informational") {
          await say(ctx, `Q-${q.displayNo}은(는) 버튼으로 답해 주세요.`, "buttons");
          return processed;
        }
        await submit(ctx, q, { text: action.text });
        return processed;
      }
      case "unrelated_text": {
        const open = await repo.listQuestions(ctx.tx.db, ctx.scope, { statuses: ["open"], limit: 20 });
        const here: Question[] = [];
        for (const q of open) {
          if (q.questionType !== "free_text" && q.questionType !== "single_choice") continue;
          const ds = await repo.listDeliveries(ctx.tx.db, ctx.scope, q.id);
          if (ds.some((d) => d.channelId === ctx.channel.id && (d.state === "posted" || d.state === "pending"))) here.push(q);
        }
        if (!here.length) return { status: "ignored", reason: "unsupported" };
        await say(ctx, "어느 질문의 답인지 알 수 없습니다. 답할 질문을 고른 뒤 다시 입력하세요.", "which", {
          buttons: here.slice(0, 5).map((q) => ({ label: `Q-${q.displayNo} ${q.title}`.slice(0, 40), value: `v1|t|${q.id}|900` })),
        });
        return processed;
      }
      default:
        return { status: "ignored", reason: "unsupported" };
    }
  }

  return { kinds: ["answer_option", "answer_text", "start_text_input", "session_step", "unrelated_text"], handle };
}
