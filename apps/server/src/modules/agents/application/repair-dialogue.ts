/**
 * Agent-to-agent repair dialogue (설계 추가): when a DETERMINISTIC check rejects an agent's structured output
 * (offsets that do not match the source, a plan that breaks placement rules, …), the system does not throw the
 * task away and re-run the identical prompt. A validator critique — which items failed, why, and the relevant
 * source excerpt — is sent back to the producing agent as a follow-up turn of the SAME conversation, up to
 * `agents.repair_rounds` rounds. The best answer (fewest issues) is returned with the issues still open; the
 * caller decides whether those are dropped individually or the task fails (retry path, with feedback).
 *
 * Every dialogue is recorded on the run (`runs.output_summary.repairDialogues`, `repairRounds`) with the critique
 * of each round and the provider_call id of the answer, so the board and the agents page can show the transcript.
 * The gateway's own JSON-schema repair retry (wrong shape) stays below this layer.
 */
import type { z } from "zod";
import { defaultValue, type AgentRole, type RepairDialogueDto, type RepairIssueDto } from "@ncs/shared";
import type { LlmMessage, ModelCallInput, ModelCallOutput, ModelCallPort } from "../../llm/index.js";
import type { RunHandle } from "../../orchestration/index.js";

export type RepairIssue = RepairIssueDto;

export interface RepairVerdict<R> {
  /** what the caller keeps from this answer (e.g. located mentions) */
  result: R;
  /** problems found; empty = accepted */
  issues: RepairIssue[];
}

export interface RepairDialogueOptions<T, R> {
  llm: ModelCallPort;
  /** the producer's call (object output); repair rounds append turns to `messages` */
  request: ModelCallInput<T> & { output: { kind: "object"; schemaName: string; schema: z.ZodType<T> } };
  /** deterministic check of one answer (pure / read-only) */
  validate(value: T, round: number): RepairVerdict<R> | Promise<RepairVerdict<R>>;
  /** what is checked, shown in the critique and the transcript (e.g. "언급 위치 검증") */
  label: string;
  /** reviewing side (default "검증 에이전트") */
  critic?: string;
  /** closing instruction of each critique (what the producer should do) */
  instruction?: string;
  /** cap (default agents.repair_rounds); 0 = validate only */
  maxRounds?: number;
  /** issues listed in one critique (default 12; the count of the rest is mentioned) */
  maxIssuesShown?: number;
  /** purpose of the repair calls (default `<purpose>_repair`) */
  repairPurpose?: string;
}

export interface RepairDialogueResult<T, R> {
  /** the best answer (schema-parsed) */
  value: T;
  result: R;
  /** issues still open in the returned (best) answer */
  issues: RepairIssue[];
  rounds: number;
  dialogue: RepairDialogueDto | null;
  output: ModelCallOutput<T>;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** critique text the validator sends to the producer */
export function formatCritique(o: { critic: string; label: string; issues: RepairIssue[]; instruction?: string; maxShown?: number }): string {
  const shown = o.issues.slice(0, o.maxShown ?? 12);
  const lines = [`${o.critic}(${o.label}): 직전 출력에서 다음 ${o.issues.length}개 항목이 검증을 통과하지 못했습니다.`];
  shown.forEach((i, n) => {
    lines.push(`${n + 1}. ${i.item} — ${i.problem}`);
    if (i.excerpt) lines.push(`   원문: ${i.excerpt}`);
  });
  if (o.issues.length > shown.length) lines.push(`… 외 ${o.issues.length - shown.length}개`);
  if (o.instruction) lines.push("", o.instruction);
  lines.push("문제가 없는 항목은 그대로 두고, 고친 전체 JSON을 같은 스키마로 다시 출력하세요.");
  return lines.join("\n");
}

/** per-run list of dialogues (the run handle is one object per run) */
const dialoguesByRun = new WeakMap<RunHandle, RepairDialogueDto[]>();

function record(run: RunHandle, d: RepairDialogueDto, isNew: boolean): void {
  if (!run.noteOutputSummary) return;
  const list = dialoguesByRun.get(run) ?? [];
  if (isNew) list.push(d);
  dialoguesByRun.set(run, list);
  run.noteOutputSummary("repairDialogues", list.slice(-10));
  run.noteOutputSummary(
    "repairRounds",
    list.reduce((n, x) => n + x.rounds.length, 0),
  );
}

/** dialogues noted on this run so far (tests / handlers) */
export function repairDialoguesOfRun(run: RunHandle): readonly RepairDialogueDto[] {
  return dialoguesByRun.get(run) ?? [];
}

/**
 * call → validate → (critique → corrected answer → validate)×N. Model-call errors propagate unchanged
 * (the dialogue so far stays recorded on the run).
 */
export async function callWithRepair<T, R>(o: RepairDialogueOptions<T, R>): Promise<RepairDialogueResult<T, R>> {
  const run = o.request.run;
  const critic = o.critic ?? "검증 에이전트";
  const maxRounds = Math.max(0, o.maxRounds ?? defaultValue("agents.repair_rounds"));
  // the gateway already validated the object against the schema; parse narrows `T | string` to T
  const valueOf = (out: ModelCallOutput<T>): T => o.request.output.schema.parse(out.value);
  const first = await o.llm.call<T>(o.request);
  let verdict = await o.validate(valueOf(first), 0);
  let best = { output: first, value: valueOf(first), verdict };
  if (verdict.issues.length === 0 || maxRounds === 0) return { value: best.value, result: verdict.result, issues: verdict.issues, rounds: 0, dialogue: null, output: first };

  const dialogue: RepairDialogueDto = {
    purpose: o.request.purpose,
    label: o.label,
    critic,
    producerRole: run.role as AgentRole,
    maxRounds,
    initialCallId: first.providerCallId,
    initialIssueCount: verdict.issues.length,
    finalIssueCount: verdict.issues.length,
    status: "unresolved",
    rounds: [],
    remaining: verdict.issues.slice(0, 20),
  };
  record(run, dialogue, true);

  let messages: LlmMessage[] = [...o.request.messages];
  let last = best.value;
  for (let round = 1; round <= maxRounds && verdict.issues.length > 0; round++) {
    await run.checkpoint();
    const critique = formatCritique({ critic, label: o.label, issues: verdict.issues, instruction: o.instruction, maxShown: o.maxIssuesShown });
    messages = [...messages, { role: "assistant", content: JSON.stringify(last) }, { role: "user", content: critique }];
    const entry: RepairDialogueDto["rounds"][number] = { round, critique, issueCount: verdict.issues.length, responseCallId: null, responseExcerpt: null, remainingIssueCount: null };
    dialogue.rounds.push(entry);
    record(run, dialogue, false);
    const out = await o.llm.call<T>({ ...o.request, purpose: o.repairPurpose ?? `${o.request.purpose}_repair`, messages });
    last = valueOf(out);
    verdict = await o.validate(last, round);
    entry.responseCallId = out.providerCallId;
    entry.responseExcerpt = clip(JSON.stringify(last) ?? "", 600);
    entry.remainingIssueCount = verdict.issues.length;
    // keep the best answer (fewest open issues; the later one on a tie — it saw the critique)
    if (verdict.issues.length <= best.verdict.issues.length) best = { output: out, value: last, verdict };
    dialogue.finalIssueCount = best.verdict.issues.length;
    dialogue.remaining = best.verdict.issues.slice(0, 20);
    dialogue.status = best.verdict.issues.length === 0 ? "resolved" : best.verdict.issues.length < dialogue.initialIssueCount ? "partial" : "unresolved";
    record(run, dialogue, false);
  }
  return { value: best.value, result: best.verdict.result, issues: best.verdict.issues, rounds: dialogue.rounds.length, dialogue, output: best.output };
}

/** short text of the open issues for a TaskFailure message (also what the next attempt is told) */
export function summarizeIssues(label: string, issues: RepairIssue[], max = 5): string {
  const head = issues
    .slice(0, max)
    .map((i) => `${i.item}: ${i.problem}`)
    .join("; ");
  return `${label}에서 ${issues.length}개 항목이 끝까지 해결되지 않았습니다 — ${head}${issues.length > max ? ` 외 ${issues.length - max}개` : ""}`;
}
