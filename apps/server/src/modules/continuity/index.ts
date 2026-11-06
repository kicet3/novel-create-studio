/**
 * continuity — public API (design/03 §3.6, §4.6; 06 §9 CR-*; 07 §5.1, §5.3–5.6; FR-ONT-06).
 * Owns: continuity_issues, continuity_issue_evidence.
 * Registers task kind `check_continuity` (deterministic CR rules via ontology port + LLM review) and a
 * CheckGateContributor with manuscript ("open high issues = 0", fix_scope → E4/E5). Text safety
 * (`check_text_safety`) is a manuscript handler that opens issues through the issue sink this module
 * registers with manuscript (`manuscript.registerIssueSink`). check_setups (foreshadow) opens
 * setup_missing / setup_contradiction issues through the `SetupIssueSink` registered with foreshadow.
 */
import type { ContinuityIssueKind, ContinuityIssueStatus, IssueDetector, IssueFixScope, IssueResolutionKind, IssueSeverity } from "@ncs/shared";
import type { ContinuityIssueEvidenceRow, ContinuityIssuesRow } from "@ncs/db/schema";
import type { ActorRef, NovelScope, Tx } from "../../platform/index.js";

export type ContinuityIssue = ContinuityIssuesRow;
export type ContinuityIssueEvidence = ContinuityIssueEvidenceRow;

export interface IssueEvidenceInput {
  /** fact evidence: fact id (ref_id) + version (fact_version_id). With only a version, the version id is used as ref_id. */
  factId?: string | null;
  factVersionId?: string | null;
  answerId?: string | null;
  nameId?: string | null;
  mentionId?: string | null;
  setupId?: string | null;
  setupBeatId?: string | null;
  glossaryTermId?: string | null;
  /** 설계 추가: plot (arc) of a plan_deviation issue */
  arcId?: string | null;
  /** schema rule (CR-09~11) — stored on the evidence row */
  schemaRuleKey?: string | null;
  /** short quote / note (stored as evidence note; never copied to the audit log) */
  quote?: string | null;
}

export interface OpenIssueInput {
  kind: ContinuityIssueKind;
  severity: IssueSeverity;
  detector: IssueDetector;
  episodeId: string;
  manuscriptVersionId: string;
  sceneId?: string | null;
  charStart?: number | null;
  charEnd?: number | null;
  message: string;
  suggestion?: string | null;
  fixScope?: IssueFixScope | null;
  evidence: IssueEvidenceInput[];
  /** run that detected it (FK runs) */
  detectedByRunId?: string | null;
  /** rule id used for the dedupe hash (06 §9), e.g. "CR-01"; defaults to kind */
  ruleId?: string;
  /** entity ids (already resolved with resolveEntityId) that enter the dedupe hash */
  entityIds?: string[];
  /** explicit dedupe key (otherwise computed from episode, kind, rule, evidence, entities) */
  dedupeKey?: string;
  previousIssueId?: string | null;
}

export interface IssueFilter {
  episodeId?: string;
  statuses?: ContinuityIssueStatus[];
  severities?: IssueSeverity[];
  kinds?: ContinuityIssueKind[];
  manuscriptVersionId?: string;
  limit?: number;
}

export interface TransitionIssueOptions {
  resolutionKind?: IssueResolutionKind;
  note?: string;
  /** required when resolution_kind = auto_fixed (FR-AGT-10) */
  autoFixDiff?: unknown;
  /** INV-CI-04 retcon approval (waive published_canon_conflict) / canon_change approval (C5 canon_updated) */
  approvalId?: string | null;
  /** rewrite-limit question (C4) */
  questionId?: string | null;
}

export interface ContinuityService {
  /** display number CI-n; continuity_issue.opened. Same dedupe key as an open issue → re-linked, no new row (C1). */
  openIssue(tx: Tx, scope: NovelScope, input: OpenIssueInput, actor: ActorRef): Promise<ContinuityIssue>;
  transitionIssue(tx: Tx, scope: NovelScope, issueId: string, to: ContinuityIssueStatus, actor: ActorRef, opts?: TransitionIssueOptions): Promise<ContinuityIssue>;
  /** C8: a version rewritten from the outline supersedes open issues of older versions */
  supersedeForNewVersion(tx: Tx, scope: NovelScope, episodeId: string, newVersionId: string, actor: ActorRef): Promise<number>;
  /** C2 for every open high issue of the episode (rewrite / auto-fix cycle started) */
  markFixing(tx: Tx, scope: NovelScope, episodeId: string, actor: ActorRef, opts?: { issueIds?: string[] }): Promise<number>;
  listIssues(scope: NovelScope, filter?: IssueFilter, tx?: Tx): Promise<ContinuityIssue[]>;
  getIssue(scope: NovelScope, issueId: string): Promise<ContinuityIssue & { evidence: ContinuityIssueEvidence[] }>;
  /** open + fixing */
  countOpenBySeverity(scope: NovelScope, opts?: { episodeId?: string }): Promise<Record<IssueSeverity, number>>;
}

export type { ContinuityModuleDeps } from "./module.js";
export { createContinuityModule } from "./module.js";
