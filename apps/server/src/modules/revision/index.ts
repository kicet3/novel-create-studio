/**
 * revision — public API (설계 추가 0018: 화별 수정 대화).
 * Owns: revision_chat_sessions, revision_chat_messages, revision_chat_proposals, episode_author_notes.
 *
 * One chat thread per episode with text. The author asks (free text or a selected passage — anchor), the editor agent
 * (`revision_chat_turn`, line_editor, read only) answers with sources ("근거 없이 쓴 부분" when there is none), asks /
 * offers alternatives, and proposes minimal text patches, setting (fact) changes and an impact list once the direction
 * is agreed. Every proposal is decided by the author: patches → manuscript.applyHumanEditTx (E16); approved canon →
 * hitl canon_change / retcon approval (handlers registered here). Author notes go into later writing contexts
 * (agents section `constraints`).
 */
import type { RevisionChatView } from "@ncs/shared";
import type { RevisionChatMessagesRow, RevisionChatSessionsRow } from "@ncs/db/schema";
import type { ActorRef, NovelScope } from "../../platform/index.js";

export type RevisionSession = RevisionChatSessionsRow;
export type RevisionMessage = RevisionChatMessagesRow;
type UserActor = Extract<ActorRef, { type: "user" }>;

export interface RevisionService {
  getView(scope: NovelScope, episodeNo: number): Promise<RevisionChatView>;
  /** 409 revision_turn_in_flight while a turn is queued/running; 409 revision_chat_unavailable without text */
  postMessage(scope: NovelScope, episodeNo: number, input: { body: string; anchor?: { versionId: string; quote: string; start: number; end: number } }, actor: ActorRef): Promise<{ message: RevisionMessage; taskId: string }>;
  decideProposal(scope: NovelScope, episodeNo: number, proposalId: string, input: { decision: "accepted" | "rejected"; patchIdx?: number[]; confirmedFactIds?: string[] }, actor: UserActor): Promise<RevisionChatView>;
  /** 고치지 않고 끝내기 (+ "작가 확인: 의도대로 둠" note) */
  close(scope: NovelScope, episodeNo: number, input: { saveNote: boolean; note?: string }, actor: UserActor): Promise<RevisionChatView>;
  /** 전체 다시 쓰기 → requestRevision (approved) / episode approval rejection (awaiting_approval) */
  rewrite(scope: NovelScope, episodeNo: number, input: { decisionNote: string; reworkFrom: "outline" | "draft" | "polish" }, actor: UserActor): Promise<RevisionChatView>;
  stopTurn(scope: NovelScope, episodeNo: number, actor: ActorRef): Promise<RevisionChatView>;
  inFlightTurnTaskId(scope: NovelScope, sessionId: string): Promise<string | null>;
  sessionOf(scope: NovelScope, episodeId: string): Promise<RevisionSession | null>;
}

export type { RevisionModuleDeps } from "./module.js";
export { createRevisionModule } from "./module.js";
