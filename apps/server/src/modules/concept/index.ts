/**
 * concept — public API (design/11 entire; 03 §3.11, §4.12–4.13 CS1–CS9/CB1–CB8; 05 §3.7; FR-NOV-07~11).
 * Owns: concept_sessions, concept_messages (append-only), concept_briefs (version rows).
 *
 * Flow: N1 creates the initial session (CS1) → user/agent turns (`concept_turn`, `import_concept`;
 * web chat + Telegram continuation via messaging InboundActionHandler `concept_message`) →
 * user "승인 요청" → `check_concept_brief` → CB1 + hitl.requestApproval(concept_brief) → approval
 * handler (registered with hitl) does CS4/CB2 + novel.applyConceptApproval (N2, M-01~M-05).
 * Registers task kinds: concept_turn, import_concept, check_concept_brief (goal_id NULL allowed).
 */
import type { ConceptEntryMode, ConceptMessageKind, ConceptPauseReason, ConceptSessionStatus, ConceptStage } from "@ncs/shared";
import type { ConceptBriefsRow, ConceptMessagesRow, ConceptSessionsRow } from "@ncs/db/schema";
import type { ActorRef, NovelScope, Tx } from "../../platform/index.js";
import type { GoalFormDefaults, SessionView } from "./application/concept-app.js";

export type ConceptSession = ConceptSessionsRow;
export type ConceptMessage = ConceptMessagesRow;
export type ConceptBrief = ConceptBriefsRow;

export interface StartSessionInput {
  entryMode: ConceptEntryMode;
  activeChannelId: string;
  createdByUserId: string;
  purpose?: "initial" | "revision";
  baseBriefId?: string | null;
}

export interface PostMessageInput {
  body: string;
  kind?: Extract<ConceptMessageKind, "text" | "option_pick" | "import_text">;
  /** option_pick: value of the picked option (or a control value such as "@recommend") */
  optionValue?: string;
  /** option_pick: idx of the picked option (messenger callback idx, reserved 900–907) */
  pickedIdx?: number;
  channelId: string;
  /** messenger_inbox id / web request key for idempotent replays */
  sourceKey?: string;
  /**
   * web chat: reject (409 `concept_turn_in_flight`) while an agent turn of the session is still queued/running.
   * Messenger messages keep the X-7 behavior (queued, the running turn's reply is marked superseded).
   */
  rejectWhileTurnInFlight?: boolean;
}

export interface ConceptService {
  /** N1 participant body (CS1, purpose=initial) — already implemented */
  startInitialSession(tx: Tx, scope: NovelScope, input: StartSessionInput, actor: ActorRef): Promise<ConceptSession>;
  /** "컨셉 고치기" (CS1, purpose=revision) */
  startRevision(scope: NovelScope, actor: ActorRef): Promise<ConceptSession>;
  getActiveSession(scope: NovelScope, tx?: Tx): Promise<ConceptSession | null>;
  getSession(scope: NovelScope, sessionId: string, tx?: Tx): Promise<ConceptSession>;
  listMessages(scope: NovelScope, sessionId: string, opts?: { afterSeq?: number; limit?: number }): Promise<ConceptMessage[]>;
  /** saves the user message and creates/coalesces a concept_turn task (cycle_key = message id) */
  postUserMessage(scope: NovelScope, sessionId: string, input: PostMessageInput, actor: ActorRef, tx?: Tx): Promise<{ message: ConceptMessage; taskId: string | null }>;
  /** working-brief direct edit (concept_brief.field_edited, INV-CON-03 slot guard) */
  editWorkingBrief(scope: NovelScope, sessionId: string, path: string, value: unknown, actor: ActorRef): Promise<ConceptSession>;
  setStage(tx: Tx, scope: NovelScope, sessionId: string, stage: ConceptStage, actor: ActorRef): Promise<ConceptSession>;
  pauseSession(scope: NovelScope, sessionId: string, reason: ConceptPauseReason, actor: ActorRef): Promise<ConceptSession>;
  resumeSession(scope: NovelScope, sessionId: string, actor: ActorRef): Promise<ConceptSession>;
  extendLimit(scope: NovelScope, sessionId: string, input: { turns?: number; budgetMicros?: number }, actor: ActorRef): Promise<ConceptSession>;
  switchEntryMode(scope: NovelScope, sessionId: string, mode: ConceptEntryMode, actor: ActorRef): Promise<ConceptSession>;
  abandonSession(scope: NovelScope, sessionId: string, actor: ActorRef): Promise<ConceptSession>;
  /** CS3 precondition: runs check_concept_brief; on success CB1 + approval (A1) */
  submitForApproval(scope: NovelScope, sessionId: string, actor: ActorRef): Promise<{ taskId: string }>;
  getBrief(scope: NovelScope, briefId: string, tx?: Tx): Promise<ConceptBrief>;
  listBriefs(scope: NovelScope): Promise<ConceptBrief[]>;
  getApprovedBrief(scope: NovelScope, tx?: Tx): Promise<ConceptBrief | null>;
  sessionStatusLabel(status: ConceptSessionStatus): string;

  // ── widened in the concept implementation phase (A7) ──
  /** session + parsed working brief + progress/blockers/badges for the concept screen (null when the novel has none) */
  getSessionView(scope: NovelScope, sessionId?: string): Promise<SessionView | null>;
  /** 11 M-06~M-08, M-22: goal form initial values from the approved brief */
  getGoalFormDefaults(scope: NovelScope): Promise<GoalFormDefaults | null>;
  /** INV-CON-03 (b): accept/reject an agent change proposal */
  decideChangeProposal(scope: NovelScope, sessionId: string, proposalId: string, decision: "accepted" | "rejected", actor: ActorRef): Promise<ConceptSession>;
  /** [추출값 전체 확인] / [모두 확정] / per-field confirm (origin kept, D-4) */
  confirmFields(scope: NovelScope, sessionId: string, which: "imported" | "delegated" | { paths: string[] }, actor: ActorRef): Promise<ConceptSession>;
  /** "처음부터 다시" (CS8 + new CS1 session) */
  restartSession(scope: NovelScope, sessionId: string, actor: ActorRef): Promise<{ abandoned: ConceptSession; session: ConceptSession }>;
  /** 설계 추가: "다른 추천 받기" — concept_turn (input.titles=true) that refreshes the session's title suggestions */
  requestTitleSuggestions(scope: NovelScope, sessionId: string, actor: ActorRef): Promise<{ taskId: string }>;
  /** 설계 추가: the user picks/edits a (suggested) title → brief `title` (user_edited) + novel title_source=user */
  chooseTitle(scope: NovelScope, sessionId: string, title: string, actor: ActorRef): Promise<ConceptSession>;
  /** 설계 추가 (답변 스트리밍): id of the session's agent turn/import task while it is still queued or running, else null */
  inFlightTurnTaskId(scope: NovelScope, sessionId: string): Promise<string | null>;
  /**
   * 설계 추가: "답변 멈추기" — cancels the in-flight turn (a running one is dropped at its next safe point, before its
   * commit), clears `inFlightTaskId` and leaves a notice. Unprocessed user messages stay for the next turn. Idempotent.
   */
  stopTurn(scope: NovelScope, sessionId: string, actor: ActorRef): Promise<ConceptSession>;
  /** 3.9 idle reminder (48h) / paused(idle) after 14 days — run by the `concept.idle_sweeper` loop */
  sweepIdle(now?: Date): Promise<{ reminded: number; paused: number }>;
}

export type { SessionView, GoalFormDefaults } from "./application/concept-app.js";

export type { ConceptModuleDeps } from "./module.js";
export { createConceptModule } from "./module.js";
