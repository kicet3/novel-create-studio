/**
 * DTOs of the `revision` module (설계 추가 0018: 화별 수정 대화). Paths: `…` = `/api/novels/:novelId`.
 *
 *   GET  …/episodes/:episodeNo/revision-chat                       → revisionChatViewSchema
 *   POST …/episodes/:episodeNo/revision-chat/messages              {body, anchor?} → 201 {message, taskId} (409 revision_turn_in_flight)
 *   GET  …/episodes/:episodeNo/revision-chat/stream                SSE delta/reset/done/error (like the concept chat)
 *   POST …/episodes/:episodeNo/revision-chat/proposals/:id/decision {decision, patchIdx?} → view
 *   POST …/episodes/:episodeNo/revision-chat/close                 {saveNote, note?} → view
 *   POST …/episodes/:episodeNo/revision-chat/rewrite               {decisionNote, reworkFrom} → view (전체 다시 쓰기)
 *   POST …/episodes/:episodeNo/revision-chat/stop-turn             → view
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime } from "./common.js";

/** a passage the author selected in the episode text ([이 부분 묻기]); offsets are JS string indices of `versionId`'s content */
export const revisionAnchorSchema = z.object({
  versionId: z.string().min(1),
  quote: z.string().min(1).max(3000),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
});
export type RevisionAnchor = z.infer<typeof revisionAnchorSchema>;

export const revisionPostMessageRequestSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  anchor: revisionAnchorSchema.optional(),
});
export type RevisionPostMessageRequest = z.input<typeof revisionPostMessageRequestSchema>;

export const revisionProposalDecisionRequestSchema = z.object({
  decision: z.enum(["accepted", "rejected"]),
  /** text_patch: indexes of the patches to apply (partial accept); omitted = all */
  patchIdx: z.array(z.number().int().min(0)).max(50).optional(),
});
export type RevisionProposalDecisionRequest = z.input<typeof revisionProposalDecisionRequestSchema>;

export const revisionCloseRequestSchema = z.object({
  /** save "작가 확인: 의도대로 둠" as an author note that later writing contexts include */
  saveNote: z.boolean().default(false),
  note: z.string().trim().max(2000).optional(),
});
export type RevisionCloseRequest = z.input<typeof revisionCloseRequestSchema>;

export const revisionRewriteRequestSchema = z.object({
  decisionNote: z.string().trim().min(1).max(2000),
  reworkFrom: z.enum(ENUMS.rework_from).default("draft"),
});
export type RevisionRewriteRequest = z.input<typeof revisionRewriteRequestSchema>;

export const revisionSourceSchema = z.object({
  kind: z.enum(["outline", "plan", "fact", "setup", "cast", "world", "prompt_input", "previous_episode", "author_note", "none"]),
  refId: z.string().nullable().default(null),
  quote: z.string().nullable().default(null),
});
export type RevisionSource = z.infer<typeof revisionSourceSchema>;

export const revisionQuestionSchema = z.object({ text: z.string(), options: z.array(z.string()) });

export const revisionTextPatchSchema = z.object({ quote: z.string(), replacement: z.string(), reason: z.string() });
export type RevisionTextPatch = z.infer<typeof revisionTextPatchSchema>;

export const revisionTextPatchPayloadSchema = z.object({
  patches: z.array(revisionTextPatchSchema),
  /** set on accept: indexes that were applied */
  appliedPatchIdx: z.array(z.number().int()).optional(),
  staleReason: z.string().optional(),
});
export const revisionSettingChangePayloadSchema = z.object({
  target: z.enum(["fact", "character"]),
  id: z.string(),
  field: z.string().nullable().default(null),
  newValue: z.string(),
  reason: z.string(),
  /** display: the value at proposal time */
  oldValue: z.string().nullable().default(null),
  /** fact path: the candidate fact written for the approval */
  newFactId: z.string().nullable().optional(),
  /** the change targets approved/published canon or a confirmed character → human approval */
  needsApproval: z.boolean().default(false),
});
export const revisionImpactItemSchema = z.object({ episodeId: z.string(), episodeNo: z.number().int(), title: z.string().nullable(), via: z.string() });
export const revisionImpactPayloadSchema = z.object({ subject: z.string(), items: z.array(revisionImpactItemSchema) });

export const revisionProposalDtoSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  messageId: z.string(),
  kind: z.enum(ENUMS.revision_proposal_kind),
  status: z.enum(ENUMS.revision_proposal_status),
  baseVersionId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  resultVersionId: z.string().nullable(),
  approvalId: z.string().nullable(),
  decidedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type RevisionProposalDto = z.infer<typeof revisionProposalDtoSchema>;

export const revisionMessageDtoSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  seq: z.number().int(),
  authorKind: z.enum(ENUMS.revision_chat_author),
  body: z.string(),
  runId: z.string().nullable(),
  anchor: revisionAnchorSchema.nullable(),
  diagnosisKind: z.enum(ENUMS.revision_diagnosis_kind).nullable(),
  question: revisionQuestionSchema.nullable(),
  sources: z.array(revisionSourceSchema).nullable(),
  createdAt: isoDateTime,
});
export type RevisionMessageDto = z.infer<typeof revisionMessageDtoSchema>;

export const revisionAuthorNoteDtoSchema = z.object({
  id: z.string(),
  episodeId: z.string(),
  body: z.string(),
  status: z.enum(ENUMS.author_note_status),
  createdAt: isoDateTime,
});
export type RevisionAuthorNoteDto = z.infer<typeof revisionAuthorNoteDtoSchema>;

export const revisionChatViewSchema = z.object({
  episode: z.object({
    id: z.string(),
    episodeNo: z.number().int(),
    title: z.string().nullable(),
    status: z.enum(ENUMS.episode_status),
    currentVersionId: z.string().nullable(),
  }),
  session: z
    .object({
      id: z.string(),
      status: z.enum(ENUMS.revision_chat_session_status),
      outcome: z.enum(ENUMS.revision_chat_outcome).nullable(),
      inFlightTaskId: z.string().nullable(),
      createdAt: isoDateTime,
      updatedAt: isoDateTime,
    })
    .nullable(),
  /** can the author send a message now (episode has text in a chat-able status) */
  canChat: z.boolean(),
  /** can text patches be applied (published → retcon, not here) */
  canPatch: z.boolean(),
  /** why chat / patch is unavailable (Korean) */
  notice: z.string().nullable(),
  /** applying a patch re-runs the checks; approved episodes need approval again */
  patchWarning: z.string().nullable(),
  /** the agent turn in flight (queued / running / blocked), null when idle */
  turn: z
    .object({ taskId: z.string(), status: z.enum(ENUMS.task_status), blockReason: z.enum(ENUMS.task_block_reason).nullable(), waitingReason: z.string().nullable() })
    .nullable(),
  messages: z.array(revisionMessageDtoSchema),
  proposals: z.array(revisionProposalDtoSchema),
  notes: z.array(revisionAuthorNoteDtoSchema),
});
export type RevisionChatView = z.infer<typeof revisionChatViewSchema>;
