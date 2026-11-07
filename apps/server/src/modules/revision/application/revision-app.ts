/**
 * Revision chat application (설계 추가 0018: 화별 수정 대화).
 *
 *  - one thread per episode (revision_chat_sessions), messages append-only, one agent turn in flight (409 otherwise);
 *  - turn = `revision_chat_turn` task (line_editor, read only): full thread history + the current text + plan/outline,
 *    canon facts [F:id], setups [S:id], previous episodes, author notes and the draft's generation record;
 *    structured output validated with callWithRepair (patch quotes unique, ≤ 25 %, known fact ids);
 *  - proposals are decided one by one by the author: text patches → manuscript.applyHumanEditTx (E16, re-checks),
 *    setting changes → candidate fact edit, or a canon_change / retcon approval for approved canon (never silent);
 *  - "고치지 않고 끝내기" (+ author note fed to later writing contexts), "전체 다시 쓰기" → existing rework flow.
 */
import { z } from "zod";
import { labelKo, type EpisodeStatus, type RevisionChatView } from "@ncs/shared";
import type { RevisionChatMessagesRow, RevisionChatProposalsRow, RevisionChatSessionsRow } from "@ncs/db/schema";
import {
  actors,
  ConflictError,
  DomainValidationError,
  InvalidTransitionError,
  NotFoundError,
  type ActorRef,
  type NovelScope,
  type Platform,
  type Tx,
} from "../../../platform/index.js";
import type { AuditService } from "../../audit/index.js";
import { callWithRepair, type AgentsService, type AgentTaskHandler, type ContextPack, type ContextSectionProvider, type RepairIssue } from "../../agents/index.js";
import { createFieldStreamer, createTurnStreamHub, type TurnStreamHub } from "../../concept/index.js";
import type { ForeshadowService } from "../../foreshadow/index.js";
import type { ApprovalDecisionContext, HitlService } from "../../hitl/index.js";
import type { LlmStreamEvent } from "../../llm/index.js";
import type { Episode, ManuscriptService } from "../../manuscript/index.js";
import type { MessagingService } from "../../messaging/index.js";
import type { NovelService } from "../../novel/index.js";
import type { FactAtAnchor, OntologyService } from "../../ontology/index.js";
import type { OrchestrationService, RunHandle, TaskKindHandler } from "../../orchestration/index.js";
import { revisionRepo as repo } from "../adapters/db/repository.js";
import { applyPatches, DEFAULT_MAX_PATCH_RATIO, excerptAround, locatePatches, normalizeText, type TextPatch } from "../domain/patch.js";
import { ensureNoSourcePhrase, revisionTurnOutputSchema, type RevisionTurnOutput } from "../domain/turn.js";

export interface RevisionDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  ontology: OntologyService;
  orchestration: OrchestrationService;
  agents: AgentsService;
  hitl: HitlService;
  messaging: MessagingService;
  manuscript: ManuscriptService;
  foreshadow: ForeshadowService;
}

export const TURN_TEMPLATE_ID = "line_editor.revision_chat_turn@0.1.0";
const TURN_PRIORITY = 950;
/** statuses with text the author can talk about */
export const CHAT_STATUSES: readonly EpisodeStatus[] = ["checking", "polishing", "awaiting_approval", "approved", "published"];
const FULL_TEXT_MAX = 14_000;
const MAX_HISTORY = 40;

type Session = RevisionChatSessionsRow;
type Message = RevisionChatMessagesRow;
type Proposal = RevisionChatProposalsRow;

interface TurnInput {
  session_id: string;
  episode_id: string;
}
interface TurnResult {
  output: RevisionTurnOutput | null;
  observedMaxSeq: number;
  baseVersionId: string | null;
  /** impact notes per fact id, computed before the commit (read-only, outside the commit transaction) */
  impacts?: Record<string, ImpactPayload>;
  failed?: string;
}
type ImpactPayload = {
  subject: string;
  factId: string;
  items: Array<{ episodeId: string; episodeNo: number; title: string | null; via: string }>;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const LIVE = (status: string) => !["done", "failed", "cancelled"].includes(status);
const factText = (f: FactAtAnchor) => `[F:${f.factId}] (${labelKo("canon_status", f.canonStatus)}) ${f.text}`;
const valueText = (f: FactAtAnchor) => {
  const v = f.value as { text?: unknown } | string | null | undefined;
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof v.text === "string") return v.text;
  return f.text;
};

export function createRevisionApp(deps: RevisionDeps) {
  const { platform, audit, novel, ontology, orchestration, agents, hitl, messaging, manuscript, foreshadow } = deps;
  const { uow, ids, clock, log } = platform;
  const streams: TurnStreamHub = createTurnStreamHub();
  const orchestrator = actors.system("orchestrator");
  const epRef = (id: string) => ({ type: "episode" as const, id });

  // ── helpers ──────────────────────────────────────────────────────────
  async function liveTask(scope: NovelScope, taskId: string | null, tx?: Tx) {
    if (!taskId) return null;
    const t = await orchestration.getTask(scope, taskId, tx).catch(() => null);
    return t && LIVE(t.status) ? t : null;
  }

  function chatState(ep: Episode): { canChat: boolean; canPatch: boolean; notice: string | null; patchWarning: string | null } {
    const hasText = !!ep.currentVersionId && CHAT_STATUSES.includes(ep.status);
    if (!hasText) return { canChat: false, canPatch: false, notice: "이 화는 아직 원고가 없거나 쓰는 중이라 수정 대화를 할 수 없습니다.", patchWarning: null };
    if (ep.status === "published") return { canChat: true, canPatch: false, notice: "공개된 화는 대화로 묻고 설정을 확인할 수 있지만, 본문은 리트콘 승인으로만 고칠 수 있습니다.", patchWarning: null };
    const patchWarning =
      ep.status === "approved"
        ? "적용하면 승인이 풀리고 검사를 다시 거친 뒤 다시 승인해야 합니다."
        : ep.status === "awaiting_approval"
          ? "적용하면 지금 승인 요청이 닫히고 검사·다듬기를 다시 거쳐 새 승인 요청이 옵니다."
          : "적용하면 검사를 다시 시작합니다.";
    return { canChat: true, canPatch: true, notice: null, patchWarning };
  }

  async function currentContent(scope: NovelScope, ep: Episode, tx?: Tx): Promise<{ versionId: string; content: string } | null> {
    if (!ep.currentVersionId) return null;
    const v = await manuscript.getVersion(scope, ep.currentVersionId, tx);
    return { versionId: v.id, content: normalizeText(v.content) };
  }

  /** entity seeds like the writing pipeline: the outline's cast, else the novel's main active entities */
  async function seedEntities(scope: NovelScope, ep: Episode): Promise<string[]> {
    const out = new Set<string>();
    const v = ep.outlineVersionId ? await manuscript.getVersion(scope, ep.outlineVersionId).catch(() => null) : null;
    const scenes = (v?.outlineData as { scenes?: Array<Record<string, unknown>> } | null)?.scenes ?? [];
    for (const s of scenes) {
      for (const x of [s.pov_entity_id, s.location_entity_id, ...(Array.isArray(s.participant_entity_ids) ? s.participant_entity_ids : [])]) if (typeof x === "string" && x.startsWith("ent_")) out.add(x);
    }
    const all = await ontology.listEntities(scope, { statuses: ["active"], limit: 200 }).catch(() => []);
    const rank = (t: string) => {
      const i = ["character", "place", "organization", "item", "ability", "rule"].indexOf(t);
      return i < 0 ? 9 : i;
    };
    for (const e of [...all].sort((a, b) => rank(a.entity.entityType) - rank(b.entity.entityType) || b.appearanceEpisodeCount - a.appearanceEpisodeCount).slice(0, 16)) out.add(e.entity.id);
    return [...out].slice(0, 24);
  }

  async function relevantFacts(scope: NovelScope, ep: Episode): Promise<FactAtAnchor[]> {
    const entityIds = await seedEntities(scope, ep);
    if (!entityIds.length) return [];
    const facts = await ontology.getCanonAt(scope, entityIds, ep.episodeNo * 1000, ep.primaryTimelineId, { include: "canon_and_safe_candidates" }).catch(() => []);
    return facts.slice(0, 120);
  }

  // ── session / messages ───────────────────────────────────────────────
  async function ensureSession(tx: Tx, scope: NovelScope, ep: Episode, actor: ActorRef): Promise<Session> {
    const existing = await repo.sessionByEpisode(tx.db, scope, ep.id, true);
    if (existing) return existing;
    await repo.insertSession(tx.db, { id: ids.next("rvs"), novelId: scope.novelId, episodeId: ep.id, createdByUserId: actor.type === "user" ? actor.id : "system" });
    return (await repo.sessionByEpisode(tx.db, scope, ep.id, true))!;
  }

  async function addMessage(tx: Tx, scope: NovelScope, s: Session, m: Omit<Parameters<typeof repo.insertMessage>[1], "id" | "novelId" | "sessionId" | "seq">): Promise<Message> {
    const seq = await repo.nextSeq(tx.db, scope, s.id);
    return repo.insertMessage(tx.db, { id: ids.next("rvm"), novelId: scope.novelId, sessionId: s.id, seq, ...m });
  }

  async function postMessage(scope: NovelScope, episodeNo: number, input: { body: string; anchor?: { versionId: string; quote: string; start: number; end: number } }, actor: ActorRef) {
    return uow.run(async (tx) => {
      const ep = await manuscript.getEpisodeByNo(scope, episodeNo, tx);
      const st = chatState(ep);
      if (!st.canChat) throw new ConflictError("revision_chat_unavailable", st.notice ?? "지금은 수정 대화를 할 수 없습니다.");
      let s = await ensureSession(tx, scope, ep, actor);
      if (await liveTask(scope, s.inFlightTaskId, tx)) throw new ConflictError("revision_turn_in_flight", "답을 쓰는 중입니다. 답변이 끝난 뒤에 보내 주세요.");
      let anchor = null as null | { versionId: string; quote: string; start: number; end: number };
      if (input.anchor) {
        const v = await manuscript.getVersion(scope, input.anchor.versionId, tx).catch(() => null);
        if (!v || v.episodeId !== ep.id) throw new DomainValidationError("anchor_invalid", "선택한 구간이 이 화의 원고가 아닙니다.");
        const text = normalizeText(v.content);
        const quote = normalizeText(input.anchor.quote);
        let start = input.anchor.start;
        if (text.slice(start, start + quote.length) !== quote) start = text.indexOf(quote);
        if (start < 0) throw new DomainValidationError("anchor_invalid", "선택한 구간을 원고에서 찾지 못했습니다. 다시 선택해 주세요.");
        anchor = { versionId: v.id, quote, start, end: start + quote.length };
      }
      if (s.status === "closed") s = await repo.updateSession(tx.db, scope, s.id, { status: "active", outcome: null });
      const msg = await addMessage(tx, scope, s, { authorKind: "user", body: input.body.trim(), anchor });
      const { taskId } = await orchestration.createTask(tx, scope, {
        kind: "revision_chat_turn",
        targetType: "episode",
        targetId: ep.id,
        episodeId: ep.id,
        arcId: ep.arcId,
        input: { session_id: s.id, episode_id: ep.id },
        createdBy: actor,
        cycleKey: msg.id,
        priority: TURN_PRIORITY,
      });
      await repo.updateSession(tx.db, scope, s.id, { inFlightTaskId: taskId });
      tx.afterCommit(() => platform.workSignal.notify("task", scope.novelId));
      return { message: msg, taskId };
    });
  }

  // ── view ─────────────────────────────────────────────────────────────
  async function getView(scope: NovelScope, episodeNo: number): Promise<RevisionChatView> {
    const ep = await manuscript.getEpisodeByNo(scope, episodeNo);
    const s = await repo.sessionByEpisode(uow.db, scope, ep.id);
    const st = chatState(ep);
    const task = s ? await liveTask(scope, s.inFlightTaskId) : null;
    const msgs = s ? await repo.listMessages(uow.db, scope, s.id) : [];
    const props = s ? await repo.listProposals(uow.db, scope, s.id) : [];
    const notes = await repo.activeNotes(uow.db, scope, [ep.id]);
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      episode: { id: ep.id, episodeNo: ep.episodeNo, title: ep.title, status: ep.status, currentVersionId: ep.currentVersionId },
      session: s ? { id: s.id, status: s.status, outcome: s.outcome, inFlightTaskId: task?.id ?? null, createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString() } : null,
      ...st,
      turn: task
        ? {
            taskId: task.id,
            status: task.status,
            blockReason: task.blockReason ?? null,
            waitingReason:
              task.status === "running"
                ? null
                : task.status === "blocked"
                  ? `대기 중(${labelKo("task_block_reason", task.blockReason ?? "")})`
                  : task.pausedAt
                    ? "대기 중(일시정지)"
                    : "차례를 기다리는 중",
          }
        : null,
      messages: msgs.map((m) => ({
        id: m.id,
        sessionId: m.sessionId,
        seq: m.seq,
        authorKind: m.authorKind,
        body: m.body,
        runId: m.runId,
        anchor: m.anchor ?? null,
        diagnosisKind: m.diagnosisKind,
        question: m.question ?? null,
        sources: (m.sources ?? null) as RevisionChatView["messages"][number]["sources"],
        createdAt: m.createdAt.toISOString(),
      })),
      proposals: props.map((p) => ({
        id: p.id,
        sessionId: p.sessionId,
        messageId: p.messageId,
        kind: p.kind,
        status: p.status,
        baseVersionId: p.baseVersionId,
        payload: p.payload,
        resultVersionId: p.resultVersionId,
        approvalId: p.approvalId,
        decidedAt: iso(p.decidedAt),
        createdAt: p.createdAt.toISOString(),
      })),
      notes: notes.map((n) => ({ id: n.id, episodeId: n.episodeId, body: n.body, status: n.status, createdAt: n.createdAt.toISOString() })),
    };
  }

  // ── turn task ────────────────────────────────────────────────────────
  async function buildPromptData(scope: NovelScope, ep: Episode, msgs: Message[], content: { versionId: string; content: string }) {
    const text = content.content;
    const anchors = msgs.filter((m) => m.authorKind === "user" && m.anchor).map((m) => m.anchor!);
    let manuscriptText: string;
    if (text.length <= FULL_TEXT_MAX) manuscriptText = text;
    else {
      const parts = anchors.slice(-4).map((a) => {
        const at = a.versionId === content.versionId ? a.start : text.indexOf(a.quote);
        return at >= 0 ? excerptAround(text, at, at + a.quote.length, 1500) : "";
      });
      manuscriptText = [text.slice(0, 3000), ...parts.filter(Boolean)].join("\n\n[…]\n\n");
    }
    const outlineV = ep.outlineVersionId ? await manuscript.getVersion(scope, ep.outlineVersionId).catch(() => null) : null;
    const outlineData = (outlineV?.outlineData ?? null) as { scenes?: Array<{ key?: string; summary?: string }>; hook?: string } | null;
    const arc = await novel.getArc(scope, ep.arcId).catch(() => null);
    const plan = [
      `${ep.episodeNo}화${ep.title ? ` 「${ep.title}」` : ""} 계획: ${ep.planSummary || "(없음)"}`,
      ep.hookNote ? `회차 말 훅(계획): ${ep.hookNote}` : "",
      arc ? `플롯 「${arc.title}」 목표: ${arc.goalText} / 핵심 사건: ${arc.coreEvent ?? ""}` : "",
      outlineV ? `아웃라인 요약: ${outlineV.content}` : "아웃라인 없음",
      ...(outlineData?.scenes ?? []).map((s) => `- 씬 ${s.key ?? ""}: ${s.summary ?? ""}`),
      outlineData?.hook ? `아웃라인 훅: ${outlineData.hook}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const facts = await relevantFacts(scope, ep);
    const beats = await foreshadow.beatsForEpisode(scope, ep.episodeNo).catch(() => []);
    const setups = beats.map((b) => `[S:${b.setup.id}] 「${b.setup.title}」 ${labelKo("setup_beat_kind", b.kind)} — ${b.setup.description}`);
    const prevEps = (await manuscript.listEpisodes(scope, { toNo: ep.episodeNo - 1 }).catch(() => []))
      .filter((e) => e.episodeNo < ep.episodeNo)
      .sort((a, b) => a.episodeNo - b.episodeNo)
      .slice(-5);
    const prev: string[] = [];
    for (const e of prevEps) {
      const scenes = await manuscript.listScenes(scope, e.id).catch(() => []);
      const sum = scenes.map((x) => x.summary).filter(Boolean).join(" / ");
      prev.push(`- ${e.episodeNo}화${e.title ? ` 「${e.title}」` : ""}: ${clip(sum || e.planSummary || "(요약 없음)", 400)}`);
    }
    const allEps = await manuscript.listEpisodes(scope, { toNo: ep.episodeNo }).catch(() => []);
    const noOf = new Map(allEps.map((e) => [e.id, e.episodeNo]));
    const notes = (await repo.activeNotes(uow.db, scope, allEps.map((e) => e.id))).map((n) => `- ${noOf.get(n.episodeId)}화: ${n.body}`);
    // generation record: versions + the draft run's actual prompt inputs (context snapshot)
    const versions = await manuscript.listVersions(scope, ep.id).catch(() => []);
    const record = versions.map((v) => `- v${v.versionNo} ${labelKo("manuscript_version_kind", v.kind)} (${v.agentRole ? labelKo("agent_role", v.agentRole) : labelKo("actor_type", v.authorActorType)}${v.isHumanEdit ? ", 작가 편집" : ""})`);
    const draft = [...versions].reverse().find((v) => v.kind === "draft" && v.runId);
    let promptInputs = "";
    if (draft?.runId) {
      const run = await orchestration.getRun(scope, draft.runId).catch(() => null);
      const pack = run?.contextSnapshotId ? await agents.getContextPack(scope, run.contextSnapshotId).catch(() => null) : null;
      if (pack) promptInputs = clip(pack.messages.map((m) => m.content).join("\n\n"), 6000);
    }
    return {
      manuscriptText,
      plan,
      facts: facts.map(factText),
      factIds: new Set(facts.map((f) => f.factId)),
      setups,
      prev,
      notes,
      record,
      promptInputs,
    };
  }

  const userContent = (m: Message) => (m.anchor ? `[선택한 구간]\n"""\n${m.anchor.quote}\n"""\n\n${m.body}` : m.body);

  /** one line per proposal of an agent turn + how the author decided it (so the next turn does not repeat a rejected one) */
  function proposalLines(props: Proposal[]): string[] {
    const st = (p: Proposal) => labelKo("revision_proposal_status", p.status);
    const out: string[] = [];
    for (const p of props) {
      const pl = (p.payload ?? {}) as { patches?: TextPatch[]; appliedPatchIdx?: number[]; id?: string; oldValue?: string | null; newValue?: string; subject?: string; staleReason?: string };
      if (p.kind === "text_patch") {
        const applied = pl.appliedPatchIdx ? new Set(pl.appliedPatchIdx) : null;
        (pl.patches ?? []).forEach((x, i) => {
          const state = p.status === "accepted" && applied ? (applied.has(i) ? st(p) : "적용 안 함") : st(p);
          out.push(`[제안: 본문 수정 "${clip(x.quote, 80)}" → "${clip(x.replacement, 80)}" — ${state}]`);
        });
      } else if (p.kind === "setting_change") out.push(`[제안: 설정 변경 [F:${pl.id ?? ""}] "${clip(pl.oldValue ?? "", 80)}" → "${clip(pl.newValue ?? "", 80)}" — ${st(p)}]`);
      else out.push(`[영향 범위 안내: ${clip(pl.subject ?? "", 80)}]`);
      if (p.status === "stale" && pl.staleReason) out.push(`  (적용 못 함: ${clip(pl.staleReason, 120)})`);
    }
    return out;
  }

  /** thread → chat messages: agent turns carry their question/options and proposals (+ decisions); system notes as context */
  function historyMessages(all: Message[], props: Proposal[]): Array<{ role: "user" | "assistant"; content: string }> {
    const byMsg = new Map<string, Proposal[]>();
    for (const p of props) byMsg.set(p.messageId, [...(byMsg.get(p.messageId) ?? []), p]);
    const out: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const m of all.slice(-MAX_HISTORY)) {
      let role: "user" | "assistant";
      let content: string;
      if (m.authorKind === "user") {
        role = "user";
        content = userContent(m);
      } else if (m.authorKind === "system") {
        role = "user";
        content = `[안내] ${m.body}`;
      } else {
        role = "assistant";
        const q = m.question as { text?: string; options?: string[] } | null;
        content = [
          m.body,
          q?.text ? `질문: ${q.text}${q.options?.length ? `\n${q.options.map((o, i) => `  ${i + 1}) ${o}`).join("\n")}` : ""}` : "",
          ...proposalLines(byMsg.get(m.id) ?? []),
        ]
          .filter(Boolean)
          .join("\n");
      }
      const last = out[out.length - 1];
      if (last && last.role === role) last.content = `${last.content}\n\n${content}`;
      else out.push({ role, content });
    }
    while (out.length && out[0]!.role === "assistant") out.shift();
    return out;
  }

  const turnHandler: AgentTaskHandler<TurnInput, TurnResult> = {
    kind: "revision_chat_turn",
    role: "line_editor",
    promptTemplateVersion: TURN_TEMPLATE_ID,
    inputSchema: z.object({ session_id: z.string(), episode_id: z.string() }),
    allowedWrites: [],
    async buildContext(run, input, builder) {
      const scope = { novelId: run.novelId };
      const ep = await manuscript.getEpisode(scope, input.episode_id);
      return builder.build(run, {
        anchor: { storyPoint: ep.episodeNo * 1000, timelineId: ep.primaryTimelineId },
        seeds: { entityIds: await seedEntities(scope, ep), setupIds: [], answerIds: [], mentionIds: [] },
        sections: ["instruction", "constraints", "story_plan", "assigned_beats", "outline", "cast", "entity_cards", "knowledge", "canon_1hop", "glossary", "recent_text", "world"],
        maxInputTokens: 60_000,
        hopPredicates: { hop2: [] },
        episodeId: ep.id,
        manuscriptVersionId: ep.currentVersionId ?? undefined,
      });
    },
    async execute(run, input, context: ContextPack, llm) {
      const scope = { novelId: run.novelId };
      const s = await repo.getSession(uow.db, scope, input.session_id);
      if (!s) return { output: null, observedMaxSeq: 0, baseVersionId: null, failed: "session_missing" };
      const ep = await manuscript.getEpisode(scope, input.episode_id);
      const content = await currentContent(scope, ep);
      const thread = await repo.listMessages(uow.db, scope, s.id);
      const msgs = thread.filter((m) => m.authorKind !== "system");
      const observedMaxSeq = msgs.reduce((n, m) => Math.max(n, m.seq), s.lastProcessedSeq);
      if (!content || !msgs.some((m) => m.authorKind === "user" && m.seq > s.lastProcessedSeq)) return { output: null, observedMaxSeq, baseVersionId: content?.versionId ?? null };
      const d = await buildPromptData(scope, ep, msgs, content);
      const vars: Record<string, unknown> = {
        episodeNo: ep.episodeNo,
        "이번 화 원고": d.manuscriptText,
        "화 계획·아웃라인": d.plan,
        "관련 사실(바꾸려면 [F:id]를 씁니다)": d.facts.length ? d.facts.join("\n") : "(없음)",
        "이번 화 떡밥": d.setups.length ? d.setups.join("\n") : "(없음)",
        "이전 화 요약": d.prev.length ? d.prev.join("\n") : "(첫 화)",
        "작가 확인 메모": d.notes.length ? d.notes.join("\n") : "(없음)",
        "생성 기록": [d.record.join("\n"), d.promptInputs ? `초고를 쓸 때 받은 입력(일부):\n${d.promptInputs}` : "초고 입력 기록 없음"].join("\n\n"),
      };
      const base = agents.renderPrompt(TURN_TEMPLATE_ID, vars, context);
      const history = historyMessages(thread, await repo.listProposals(uow.db, scope, s.id));
      const messages = [...base.messages, ...history];
      streams.begin(s.id, run.taskId);
      const reply = createFieldStreamer("reply_text");
      const onStream = (ev: LlmStreamEvent) => {
        if (ev.type === "reset") {
          reply.reset();
          streams.reset(s.id, run.taskId);
          return;
        }
        const add = reply.push(ev.text);
        if (add) streams.delta(s.id, run.taskId, add);
      };
      const validate = async (out: RevisionTurnOutput, round: number) => {
        const issues: RepairIssue[] = [];
        const proposals: RevisionTurnOutput["proposals"] = [];
        for (const [pi, p] of out.proposals.entries()) {
          if (p.kind === "text_patch") {
            if (!p.patches.length) {
              issues.push({ item: `proposals[${pi}]`, problem: "text_patch에 patches가 없습니다." });
              continue;
            }
            const r = locatePatches(content.content, p.patches, { maxRatio: DEFAULT_MAX_PATCH_RATIO });
            for (const i of r.issues) issues.push({ item: `proposals[${pi}].patches[${i.idx}]`, problem: i.message, excerpt: clip(p.patches[i.idx]?.quote ?? "", 200) });
            const okIdx = new Set(r.located.map((x) => x.idx));
            const kept = p.patches.filter((_x, i) => okIdx.has(i));
            if (kept.length) proposals.push({ ...p, patches: kept });
          } else {
            const fid = p.fact_id?.replace(/^\[?F:/, "").replace(/\]$/, "") ?? null;
            let known = !!fid && d.factIds.has(fid);
            if (fid && !known) known = (await ontology.getFactsByIds(scope, [fid]).catch(() => [])).length > 0;
            if (!fid || !known) {
              issues.push({ item: `proposals[${pi}].fact_id`, problem: "컨텍스트의 [F:id] 사실을 가리켜야 합니다." });
              continue;
            }
            if (p.kind === "setting_change" && !p.new_value?.trim()) {
              issues.push({ item: `proposals[${pi}].new_value`, problem: "바꿀 값이 비어 있습니다." });
              continue;
            }
            proposals.push({ ...p, fact_id: fid });
          }
        }
        if (issues.length && round < 2) {
          reply.reset();
          streams.reset(s.id, run.taskId);
        }
        return { result: { ...out, proposals }, issues };
      };
      try {
        const repaired = await callWithRepair({
          llm,
          request: {
            run,
            purpose: "revision_chat_turn",
            system: base.system,
            messages,
            output: { kind: "object", schemaName: "RevisionChatTurn", schema: revisionTurnOutputSchema },
            onStream,
          },
          validate,
          label: "수정 제안 검증",
          critic: "원고 대조 검증",
          instruction: "quote는 원고 원문 그대로 한 번만 나오는 부분으로, 범위는 문장·문단 단위로 줄이세요. 사실은 [F:id]로 가리키세요.",
          maxRounds: 2,
          repairPurpose: "revision_chat_turn_repair",
        });
        // issues still open after the repair rounds: the offending items were dropped (result), the reply stays
        const impacts: Record<string, ImpactPayload> = {};
        for (const pr of repaired.result.proposals) {
          if (pr.kind === "text_patch" || !pr.fact_id || impacts[pr.fact_id]) continue;
          const note = await impactOf(scope, ep, pr.fact_id);
          if (note) impacts[pr.fact_id] = note;
        }
        return { output: ensureNoSourcePhrase(repaired.result), observedMaxSeq, baseVersionId: content.versionId, impacts };
      } catch (err) {
        streams.reset(s.id, run.taskId);
        throw err;
      }
    },
    async commit(tx, run, input, p) {
      const scope = { novelId: run.novelId };
      const s = await repo.getSession(tx.db, scope, input.session_id, true);
      if (!s) return { kind: "done", outputRefs: [] };
      const clear = s.inFlightTaskId === run.taskId ? { inFlightTaskId: null } : {};
      if (!p.output) {
        await repo.updateSession(tx.db, scope, s.id, { ...clear, lastProcessedSeq: Math.max(s.lastProcessedSeq, p.observedMaxSeq) });
        tx.afterCommit(() => streams.done(s.id, run.taskId, null));
        return { kind: "done", outputRefs: [{ refType: "episode", refId: input.episode_id }] };
      }
      const out = p.output;
      const msg = await addMessage(tx, scope, s, {
        authorKind: "agent",
        body: out.reply_text,
        runId: run.runId,
        diagnosisKind: out.diagnosis_kind,
        question: out.question && out.question.text ? { text: out.question.text, options: out.question.options } : null,
        sources: out.sources.map((x) => ({ kind: x.kind, refId: x.ref_id, quote: x.quote })),
      });
      const ep = await manuscript.getEpisode(scope, input.episode_id, tx);
      const impactFacts = new Set<string>();
      for (const pr of out.proposals) {
        if (pr.kind === "text_patch") {
          await repo.insertProposal(tx.db, {
            id: ids.next("rvp"),
            novelId: scope.novelId,
            sessionId: s.id,
            messageId: msg.id,
            kind: "text_patch",
            baseVersionId: p.baseVersionId,
            payload: { patches: pr.patches.map((x) => ({ quote: normalizeText(x.quote), replacement: normalizeText(x.replacement), reason: x.reason })) },
          });
        } else if (pr.kind === "setting_change" && pr.fact_id) {
          const [f] = await ontology.getFactsByIds(scope, [pr.fact_id], tx);
          if (!f) continue;
          await repo.insertProposal(tx.db, {
            id: ids.next("rvp"),
            novelId: scope.novelId,
            sessionId: s.id,
            messageId: msg.id,
            kind: "setting_change",
            baseVersionId: p.baseVersionId,
            payload: {
              target: "fact",
              id: f.factId,
              field: f.predicate,
              newValue: pr.new_value ?? "",
              reason: pr.reason,
              oldValue: valueText(f),
              needsApproval: f.canonStatus === "approved" || f.canonStatus === "published_locked",
            },
          });
          impactFacts.add(f.factId);
        } else if (pr.kind === "impact_note" && pr.fact_id) impactFacts.add(pr.fact_id);
      }
      for (const fid of impactFacts) {
        const note = p.impacts?.[fid];
        if (note) {
          await repo.insertProposal(tx.db, { id: ids.next("rvp"), novelId: scope.novelId, sessionId: s.id, messageId: msg.id, kind: "impact_note", baseVersionId: p.baseVersionId, payload: note });
        }
      }
      await repo.updateSession(tx.db, scope, s.id, { ...clear, lastProcessedSeq: Math.max(s.lastProcessedSeq, p.observedMaxSeq) });
      tx.afterCommit(() => streams.done(s.id, run.taskId, msg.id));
      return { kind: "done", outputRefs: [{ refType: "episode", refId: ep.id }] };
    },
  };

  /**
   * other episodes whose CURRENT text mentions the fact itself — listed, never edited. Relation facts: both entities appear
   * in the episode; value facts: the subject appears and the value text occurs in the episode. Runs in `execute` (no
   * commit lock); one mention probe per episode, content loads only for value facts and bounded.
   */
  async function impactOf(scope: NovelScope, ep: Episode, factId: string): Promise<ImpactPayload | null> {
    const [f] = await ontology.getFactsByIds(scope, [factId]).catch(() => []);
    if (!f) return null;
    const others = (await manuscript.listEpisodes(scope).catch(() => [])).filter((e) => e.id !== ep.id && !!e.currentVersionId).sort((a, b) => a.episodeNo - b.episodeNo);
    const mentions = async (entityId: string, versionId: string) => (await ontology.listMentions(scope, { entityId, manuscriptVersionId: versionId, limit: 1 }).catch(() => [])).length > 0;
    const needle = f.objectEntityId ? "" : normalizeText(valueText(f)).trim();
    const valueProbe = !f.objectEntityId && needle.length >= 2 && needle !== f.text;
    const items: ImpactPayload["items"] = [];
    let loads = 0;
    for (const e of others) {
      if (items.length >= 30) break;
      const vid = e.currentVersionId!;
      if (!(await mentions(f.subjectEntityId, vid))) continue;
      if (f.objectEntityId) {
        if (await mentions(f.objectEntityId, vid)) items.push({ episodeId: e.id, episodeNo: e.episodeNo, title: e.title, via: "같은 관계(두 대상이 함께) 언급" });
      } else if (valueProbe && loads < 40) {
        loads++;
        const v = await manuscript.getVersion(scope, vid).catch(() => null);
        if (v && normalizeText(v.content).includes(needle)) items.push({ episodeId: e.id, episodeNo: e.episodeNo, title: e.title, via: "같은 설정 값 언급" });
      }
    }
    return { subject: f.text, factId: f.factId, items };
  }

  /** a run that ended without its commit: clear in-flight when the task is over, end/reset the live reply */
  async function onUncommitted(tx: Tx, scope: NovelScope, taskId: string, input: TurnInput) {
    const s = await repo.getSession(tx.db, scope, input.session_id, true);
    if (!s) return;
    const t = await orchestration.getTask(scope, taskId, tx).catch(() => null);
    const over = !t || !LIVE(t.status);
    if (over && s.inFlightTaskId === taskId) {
      await repo.updateSession(tx.db, scope, s.id, { inFlightTaskId: null });
      if (t?.status === "failed") await addMessage(tx, scope, s, { authorKind: "system", body: "답을 만들지 못했습니다. 잠시 뒤 다시 보내 주세요." });
    }
    tx.afterCommit(() => (over ? streams.done(s.id, taskId, null) : streams.abandon(s.id, taskId)));
  }

  function taskHandler(): TaskKindHandler {
    const wrapped = agents.defineAgentTask(turnHandler);
    return {
      ...wrapped,
      onUncommitted: (tx, ctx) => onUncommitted(tx, ctx.scope, ctx.task.id, ctx.input as TurnInput),
    } as TaskKindHandler;
  }

  // ── proposal decisions ───────────────────────────────────────────────
  async function decideProposal(scope: NovelScope, episodeNo: number, proposalId: string, input: { decision: "accepted" | "rejected"; patchIdx?: number[] }, actor: ActorRef & { type: "user" }) {
    await uow.run(async (tx) => {
      const ep0 = await manuscript.getEpisodeByNo(scope, episodeNo, tx);
      const s = await repo.sessionByEpisode(tx.db, scope, ep0.id, true);
      if (!s) throw new NotFoundError("수정 대화", String(episodeNo));
      const p = await repo.getProposal(tx.db, scope, proposalId, true);
      if (!p || p.sessionId !== s.id) throw new NotFoundError("수정 제안", proposalId);
      if (p.status !== "pending") throw new ConflictError("proposal_not_pending", `이미 처리된 제안입니다(${labelKo("revision_proposal_status", p.status)}).`);
      const decided = { decidedByUserId: actor.id, decidedAt: clock.date() };
      if (input.decision === "rejected") {
        await repo.updateProposal(tx.db, scope, p.id, { status: "rejected", ...decided });
        await audit.record(tx, { novelId: scope.novelId, actor, action: "revision_chat.proposal_rejected", target: epRef(ep0.id), details: { proposalId: p.id, kind: p.kind, sessionId: s.id, episodeNo } });
        return;
      }
      if (p.kind === "impact_note") {
        await repo.updateProposal(tx.db, scope, p.id, { status: "accepted", ...decided });
        await audit.record(tx, { novelId: scope.novelId, actor, action: "revision_chat.proposal_accepted", target: epRef(ep0.id), details: { proposalId: p.id, kind: p.kind, sessionId: s.id, episodeNo } });
        return;
      }
      if (p.kind === "text_patch") return acceptPatch(tx, scope, s, p, ep0, input.patchIdx, actor);
      return acceptSetting(tx, scope, s, p, ep0, actor);
    });
    return getView(scope, episodeNo);
  }

  async function acceptPatch(tx: Tx, scope: NovelScope, s: Session, p: Proposal, ep: Episode, patchIdx: number[] | undefined, actor: ActorRef & { type: "user" }) {
    if (ep.status === "published") throw new DomainValidationError("retcon_required", "공개된 화는 직접 고칠 수 없습니다. 리트콘 승인으로 진행하세요.");
    const st = chatState(ep);
    if (!st.canPatch) throw new ConflictError("revision_chat_unavailable", st.notice ?? "지금은 본문을 고칠 수 없습니다.");
    const all = ((p.payload as { patches?: TextPatch[] }).patches ?? []) as TextPatch[];
    const idx = patchIdx?.length ? [...new Set(patchIdx)].filter((i) => i >= 0 && i < all.length).sort((a, b) => a - b) : all.map((_x, i) => i);
    if (!idx.length) throw new DomainValidationError("patch_selection_empty", "적용할 수정을 하나 이상 고르세요.");
    const cur = await currentContent(scope, ep, tx);
    if (!cur) throw new ConflictError("revision_chat_unavailable", "원고가 없습니다.");
    const selected = idx.map((i) => all[i]!);
    const r = locatePatches(cur.content, selected);
    if (r.issues.length || r.located.length !== selected.length) {
      // the text changed since the proposal (or the quote no longer fits): never apply blindly
      await repo.updateProposal(tx.db, scope, p.id, { status: "stale", payload: { ...p.payload, staleReason: r.issues[0]?.message ?? "원고가 바뀌었습니다." } });
      return;
    }
    const next = applyPatches(cur.content, r.located);
    const provenance = { revision_chat: { sessionId: s.id, proposalIds: [p.id], patchIdx: idx, agentProposed: true, acceptedBy: actor.id } };
    const version = await manuscript.applyHumanEditTx(tx, scope, ep.id, { content: next, baseVersionId: cur.versionId, writerAnnotations: provenance, auditDetails: provenance }, actor);
    await repo.updateProposal(tx.db, scope, p.id, { status: "accepted", resultVersionId: version.id, payload: { ...p.payload, appliedPatchIdx: idx }, decidedByUserId: actor.id, decidedAt: clock.date() });
    await repo.updateSession(tx.db, scope, s.id, { outcome: "patched" });
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "revision_chat.proposal_accepted",
      target: epRef(ep.id),
      details: { proposalId: p.id, kind: "text_patch", sessionId: s.id, episodeNo: ep.episodeNo, versionId: version.id, baseVersionId: cur.versionId, patchIdx: idx, agentProposed: true },
    });
    // other pending patches: still applicable on the new text? otherwise stale
    for (const o of await repo.listProposals(tx.db, scope, s.id, ["pending"])) {
      if (o.kind !== "text_patch") continue;
      const rr = locatePatches(next, ((o.payload as { patches?: TextPatch[] }).patches ?? []) as TextPatch[]);
      if (rr.issues.length) await repo.updateProposal(tx.db, scope, o.id, { status: "stale", payload: { ...o.payload, staleReason: "다른 수정이 먼저 적용돼 원문이 바뀌었습니다." } });
    }
  }

  async function acceptSetting(tx: Tx, scope: NovelScope, s: Session, p: Proposal, ep: Episode, actor: ActorRef & { type: "user" }) {
    const pl = p.payload as { target?: string; id?: string; newValue?: string; reason?: string; oldValue?: string | null };
    if (pl.target !== "fact" || !pl.id) throw new DomainValidationError("setting_target_unsupported", "이 설정은 설정 화면에서 바꿔 주세요.");
    const [f] = await ontology.getFactsByIds(scope, [pl.id], tx);
    if (!f) throw new NotFoundError("사실", pl.id);
    const newValue = String(pl.newValue ?? "").trim();
    const base = { proposalId: p.id, sessionId: s.id, episodeNo: ep.episodeNo, factId: f.factId, oldValue: pl.oldValue ?? valueText(f), newValue };
    if (f.canonStatus === "candidate") {
      await ontology.reviseCandidateFact(tx, scope, f.factId, { value: { text: newValue } }, actor);
      await repo.updateProposal(tx.db, scope, p.id, { status: "applied", decidedByUserId: actor.id, decidedAt: clock.date() });
      await repo.updateSession(tx.db, scope, s.id, { outcome: "setting_changed" });
      await audit.record(tx, { novelId: scope.novelId, actor, action: "revision_chat.setting_changed", target: { type: "fact", id: f.factId }, details: { ...base, via: "candidate_edit" } });
      return;
    }
    if (f.canonStatus !== "approved" && f.canonStatus !== "published_locked") throw new ConflictError("fact_not_active", "이미 철회되거나 기각된 사실입니다.");
    // approved canon: human approval (canon_change / retcon) — never silent; the new value is written when approved
    const type = f.canonStatus === "published_locked" ? "retcon" : "canon_change";
    // a newer request on the same fact supersedes the pending one (hitl A5): its proposal can no longer be approved
    for (const a of (await hitl.listApprovals(scope, { statuses: ["pending"], types: [type] }, tx)).filter((x) => x.subjectId === f.factId)) {
      const op = await repo.proposalByApproval(tx.db, scope, a.id);
      if (op && op.id !== p.id && op.status === "awaiting_approval") await repo.updateProposal(tx.db, scope, op.id, { status: "stale", payload: { ...op.payload, staleReason: "같은 설정을 바꾸는 새 요청으로 대체되었습니다." } });
    }
    const req = await hitl.requestApproval(tx, scope, {
      approvalType: type,
      target: { type: "fact", id: f.factId },
      question: {
        title: `${ep.episodeNo}화 수정 대화: 설정 변경 ${type === "retcon" ? "(리트콘)" : ""}`.trim(),
        body: [`설정: ${f.text}`, `지금 값: ${base.oldValue}`, `바꿀 값: ${newValue}`, pl.reason ? `이유: ${pl.reason}` : "", "승인하면 승인된 설정이 바뀝니다. 다른 화 본문은 자동으로 고치지 않습니다."].filter(Boolean).join("\n"),
        links: [{ type: "fact", id: f.factId }, epRef(ep.id)],
      },
      requestedBy: actor,
      payload: { oldFactId: f.factId, newValue, proposalId: p.id, episodeId: ep.id, sessionId: s.id },
    });
    await repo.updateProposal(tx.db, scope, p.id, { status: "awaiting_approval", approvalId: req.approvalId, decidedByUserId: actor.id, decidedAt: clock.date() });
    await audit.record(tx, { novelId: scope.novelId, actor, action: "revision_chat.setting_change_requested", target: { type: "fact", id: f.factId }, approvalId: req.approvalId, details: { ...base, approvalType: type } });
  }

  /** canon_change / retcon approvals raised by this module */
  async function onSettingApproval(ctx: ApprovalDecisionContext) {
    const { tx, scope, approval, actor } = ctx;
    const pl = (approval.payload ?? {}) as { oldFactId?: string; newValue?: string; proposalId?: string; episodeId?: string };
    if (!pl.proposalId || !pl.oldFactId || typeof pl.newValue !== "string") {
      log.warn({ approvalId: approval.id, type: approval.approvalType }, "canon change approval without a revision proposal: decision recorded only");
      return;
    }
    const p = await repo.getProposal(tx.db, scope, pl.proposalId, true);
    if (ctx.decision === "rejected") {
      if (p) await repo.updateProposal(tx.db, scope, p.id, { status: "rejected" });
      await audit.record(tx, { novelId: scope.novelId, actor, action: "revision_chat.proposal_rejected", target: { type: "fact", id: pl.oldFactId }, approvalId: approval.id, details: { proposalId: pl.proposalId, via: approval.approvalType } });
      return;
    }
    const [f] = await ontology.getFactsByIds(scope, [pl.oldFactId], tx);
    // the fact may have moved on since the request (another change approved first, a cast/world edit): never write over it
    const expected = (p?.payload as { oldValue?: string | null } | undefined)?.oldValue;
    const staleReason = !p
      ? null
      : p.status !== "awaiting_approval"
        ? `제안 상태가 바뀌었습니다(${labelKo("revision_proposal_status", p.status)}).`
        : !f || (f.canonStatus !== "approved" && f.canonStatus !== "published_locked")
          ? "승인 전에 이 설정이 이미 바뀌거나 철회되었습니다."
          : expected != null && valueText(f) !== expected
            ? "승인 전에 이 설정의 값이 바뀌었습니다."
            : null;
    if (!p || !f || staleReason) {
      if (p && p.status === "awaiting_approval") await repo.updateProposal(tx.db, scope, p.id, { status: "stale", payload: { ...p.payload, staleReason } });
      log.warn({ approvalId: approval.id, proposalId: pl.proposalId, reason: staleReason ?? "proposal_or_fact_missing" }, "setting change approval is stale: nothing written");
      return;
    }
    // withdraw the old canon first (slot released), then the new value as approved canon (the author approved it)
    await ontology.withdrawFacts(tx, scope, [f.factId], actor, `설정 변경 승인(${approval.id})`);
    const written = await ontology.writeCandidateFacts(
      tx,
      scope,
      [
        {
          factKind: f.factKind,
          subjectEntityId: f.subjectEntityId,
          predicate: f.predicate,
          objectEntityId: f.objectEntityId ?? null,
          value: { text: pl.newValue },
          timelineId: f.timelineId,
          storyRange: f.storyRange,
          sourceKind: "user_input",
          source: { refType: "approval", refId: approval.id },
          canonStatus: f.canonStatus === "published_locked" ? "published_locked" : "approved",
        },
      ],
      actor,
    );
    const newFactId = written.written[0]?.factId ?? null;
    if (!newFactId) throw new DomainValidationError("setting_change_rejected", `새 값을 사실로 만들 수 없습니다: ${written.rejected[0]?.reason ?? "알 수 없는 이유"}`);
    // a slot conflict may have demoted the new value to a candidate: then nothing was changed — roll back, don't report success
    const [nf] = await ontology.getFactsByIds(scope, [newFactId], tx);
    if (!nf || (nf.canonStatus !== "approved" && nf.canonStatus !== "published_locked"))
      throw new ConflictError("setting_change_conflict", "같은 항목에 다른 확정 설정이 있어 새 값을 확정하지 못했습니다. 설정 화면에서 충돌을 먼저 정리해 주세요.");
    if (p) await repo.updateProposal(tx.db, scope, p.id, { status: "applied", payload: { ...p.payload, newFactId } });
    if (p) await repo.updateSession(tx.db, scope, p.sessionId, { outcome: "setting_changed" });
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: "revision_chat.setting_changed",
      target: { type: "fact", id: f.factId },
      approvalId: approval.id,
      details: { proposalId: pl.proposalId, oldFactId: f.factId, newFactId, newValue: pl.newValue, via: approval.approvalType, episodeId: pl.episodeId ?? null },
    });
  }

  // ── close / rewrite / stop ───────────────────────────────────────────
  async function close(scope: NovelScope, episodeNo: number, input: { saveNote: boolean; note?: string }, actor: ActorRef & { type: "user" }) {
    await uow.run(async (tx) => {
      const ep = await manuscript.getEpisodeByNo(scope, episodeNo, tx);
      const s = await repo.sessionByEpisode(tx.db, scope, ep.id, true);
      if (!s) throw new NotFoundError("수정 대화", String(episodeNo));
      if (await liveTask(scope, s.inFlightTaskId, tx)) throw new ConflictError("revision_turn_in_flight", "답을 쓰는 중입니다. 답변이 끝난 뒤에 끝내 주세요.");
      const props = await repo.listProposals(tx.db, scope, s.id);
      for (const p of props.filter((x) => x.status === "pending")) await repo.updateProposal(tx.db, scope, p.id, { status: "rejected", decidedByUserId: actor.id, decidedAt: clock.date() });
      const outcome = s.outcome ?? "explanation_only";
      await repo.updateSession(tx.db, scope, s.id, { status: "closed", outcome });
      // after a patch / setting change the text was not "kept as intended": a note needs the author's own words
      const changed = outcome === "patched" || outcome === "setting_changed";
      if (input.saveNote && (!changed || input.note?.trim())) {
        const msgs = await repo.listMessages(tx.db, scope, s.id);
        const anchor = [...msgs].reverse().find((m) => m.anchor)?.anchor;
        const detail = input.note?.trim() || (anchor ? `"${clip(anchor.quote, 160)}"` : clip(msgs.find((m) => m.authorKind === "user")?.body ?? "", 160));
        const body = clip(`작가 확인: 의도대로 둠${detail ? ` — ${detail}` : ""}`, 2000);
        const note = await repo.insertNote(tx.db, { id: ids.next("ean"), novelId: scope.novelId, episodeId: ep.id, sessionId: s.id, body, createdByUserId: actor.id });
        await addMessage(tx, scope, s, { authorKind: "system", body: `작가 메모를 남겼습니다: ${body}` });
        await audit.record(tx, { novelId: scope.novelId, actor, action: "revision_chat.author_note_saved", target: epRef(ep.id), details: { noteId: note.id, sessionId: s.id, episodeNo } });
      }
      await audit.record(tx, { novelId: scope.novelId, actor, action: "revision_chat.closed", target: epRef(ep.id), details: { sessionId: s.id, outcome, episodeNo } });
    });
    return getView(scope, episodeNo);
  }

  async function rewrite(scope: NovelScope, episodeNo: number, input: { decisionNote: string; reworkFrom: "outline" | "draft" | "polish" }, actor: ActorRef & { type: "user" }) {
    const ep = await manuscript.getEpisodeByNo(scope, episodeNo);
    if (ep.status === "approved") {
      await manuscript.requestRevision(scope, episodeNo, input, actor);
    } else if (ep.status === "awaiting_approval") {
      const [approval] = (await hitl.listApprovals(scope, { statuses: ["pending"], types: ["episode"] })).filter((a) => a.subjectId === ep.id);
      if (!approval) throw new ConflictError("episode_approval_missing", "이 화의 승인 요청을 찾지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
      const web = (await messaging.preferredChannels(scope)).find((c) => c.kind === "web");
      if (!web) throw new ConflictError("web_channel_missing", "웹 인박스 채널이 없습니다.");
      await hitl.acceptAnswer(scope, {
        questionId: approval.questionId,
        channelId: web.id,
        responderUserId: actor.id,
        approval: { decision: "rejected", decisionNote: input.decisionNote, reworkFrom: input.reworkFrom },
        sourceKey: `revision_chat:${approval.id}`,
      });
    } else throw new InvalidTransitionError("episode", ep.status, "revising", "승인 대기 중이거나 승인된(공개 전) 화만 전체 다시 쓰기를 할 수 있습니다.");
    await uow.run(async (tx) => {
      const s = await repo.sessionByEpisode(tx.db, scope, ep.id, true);
      if (s) await repo.updateSession(tx.db, scope, s.id, { status: "closed", outcome: "handed_off" });
      if (s) await addMessage(tx, scope, s, { authorKind: "system", body: `전체 다시 쓰기로 넘겼습니다: ${clip(input.decisionNote, 200)}` });
      await audit.record(tx, { novelId: scope.novelId, actor, action: "revision_chat.handed_off", target: epRef(ep.id), details: { sessionId: s?.id ?? null, episodeNo, reworkFrom: input.reworkFrom, statusAtHandOff: ep.status } });
    });
    return getView(scope, episodeNo);
  }

  async function stopTurn(scope: NovelScope, episodeNo: number, actor: ActorRef) {
    await uow.run(async (tx) => {
      const ep = await manuscript.getEpisodeByNo(scope, episodeNo, tx);
      const s = await repo.sessionByEpisode(tx.db, scope, ep.id, true);
      if (!s) return;
      const t = await liveTask(scope, s.inFlightTaskId, tx);
      if (t) await orchestration.cancelTask(tx, scope, t.id, actor);
      await repo.updateSession(tx.db, scope, s.id, { inFlightTaskId: null });
      if (t) tx.afterCommit(() => streams.done(s.id, t.id, null));
    });
    return getView(scope, episodeNo);
  }

  async function inFlightTurnTaskId(scope: NovelScope, sessionId: string): Promise<string | null> {
    const s = await repo.getSession(uow.db, scope, sessionId);
    return (await liveTask(scope, s?.inFlightTaskId ?? null))?.id ?? null;
  }

  // ── writing context: author notes (constraints) ──────────────────────
  const notesSection: ContextSectionProvider = {
    section: "constraints",
    module: "revision",
    async build(scope, spec) {
      if (!spec.episodeId) return null;
      const ep = await manuscript.getEpisode(scope, spec.episodeId).catch(() => null);
      if (!ep) return null;
      const eps = await manuscript.listEpisodes(scope, { toNo: ep.episodeNo }).catch(() => []);
      const noOf = new Map(eps.filter((e) => e.episodeNo <= ep.episodeNo).map((e) => [e.id, e.episodeNo]));
      const notes = await repo.activeNotes(uow.db, scope, [...noOf.keys()]);
      if (!notes.length) return null;
      const text = ["작가 확인 메모(작가가 의도대로 두기로 한 부분 — 뒤 화에서도 이 설정을 지킵니다):", ...notes.slice(-30).map((n) => `- ${noOf.get(n.episodeId)}화: ${n.body}`)].join("\n");
      return { text, tokenEstimate: Math.ceil(text.length / 2), refs: {} };
    },
  };

  return {
    streams,
    taskHandler,
    notesSection,
    onSettingApproval,
    service: { getView, postMessage, decideProposal, close, rewrite, stopTurn, inFlightTurnTaskId, sessionOf: (scope: NovelScope, episodeId: string) => repo.sessionByEpisode(uow.db, scope, episodeId) },
  };
}

export type RevisionApp = ReturnType<typeof createRevisionApp>;
