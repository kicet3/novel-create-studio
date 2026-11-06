/**
 * Check gate decision (07 §5.3 GC-1…GC-6, 04 §3.3). Pure and deterministic (PR-04): LLM verdicts only
 * create issues; this function only reads contributor verdicts + task completion.
 * GC-4 (auto-fix) is applied by the continuity module inside its own check; the gate never patches text.
 */
import type { IssueFixScope } from "@ncs/shared";
import type { CheckGateVerdict } from "../index.js";

export type GateDecision =
  | { kind: "wait"; reason: string }
  | { kind: "pass" }
  | { kind: "rewrite_limit"; blockers: CheckGateVerdict["blockers"] }
  | { kind: "outline"; blockers: CheckGateVerdict["blockers"] }
  | { kind: "draft"; blockers: CheckGateVerdict["blockers"]; sceneIds: string[] };

const SCOPE_RANK: Record<IssueFixScope, number> = { span: 1, scene: 2, outline: 3 };

export function strongestFixScope(verdicts: readonly CheckGateVerdict[]): IssueFixScope | null {
  let best: IssueFixScope | null = null;
  for (const v of verdicts) {
    if (v.pass || !v.fixScope) continue;
    if (!best || SCOPE_RANK[v.fixScope] > SCOPE_RANK[best]) best = v.fixScope;
  }
  return best;
}

export function decideGate(input: {
  /** GC-1: required extraction/linking/check tasks not finished */
  tasksPending: string[];
  verdicts: readonly CheckGateVerdict[];
  autoRewriteCount: number;
  maxAutoRewrites: number;
}): GateDecision {
  if (input.tasksPending.length) return { kind: "wait", reason: `tasks: ${input.tasksPending.join(",")}` };
  const pending = input.verdicts.filter((v) => v.pending);
  if (pending.length) return { kind: "wait", reason: `contributors: ${pending.map((v) => v.source).join(",")}` };
  const failing = input.verdicts.filter((v) => !v.pass);
  if (!failing.length) return { kind: "pass" }; // GC-2
  const blockers = failing.flatMap((v) => v.blockers);
  if (input.autoRewriteCount >= input.maxAutoRewrites) return { kind: "rewrite_limit", blockers }; // GC-3
  if (strongestFixScope(failing) === "outline") return { kind: "outline", blockers }; // GC-5
  const sceneIds = [...new Set(blockers.map((b) => b.sceneId).filter((x): x is string => !!x))];
  return { kind: "draft", blockers, sceneIds }; // GC-6
}
