/**
 * Task kinds owned by hitl (04 §3 table): interpret_answer (world_keeper, LLM), grade_question
 * (showrunner, LLM — G3, upgrade only), apply_answer (deterministic re-apply of a pending reflection).
 * LLM outputs are validated with zod (domain/questions.ts, domain/grading.ts).
 */
import { z } from "zod";
import { actors, NotImplementedError, type NovelScope, type Platform } from "../../../platform/index.js";
import { callWithRepair, handleLeakRepairIssues, humanHandleTokens, leakedHandleTokens, NO_HANDLE_RULE, type AgentsService, type ContextPack, type ContextSpec } from "../../agents/index.js";
import type { AuditService } from "../../audit/index.js";
import type { ModelCallPort } from "../../llm/index.js";
import type { OntologyService } from "../../ontology/index.js";
import { TaskFailure, type OrchestrationService, type RunHandle } from "../../orchestration/index.js";
import { hitlRepo as repo } from "../adapters/db/hitl-repository.js";
import { applyLlmGrade, gradeQuestionOutputSchema, HIGH_SENSITIVITY_BASES, type GradeQuestionOutput } from "../domain/grading.js";
import { interpretAnswerOutputSchema, readRecommendation, type AnswerPayload, type InterpretAnswerOutput } from "../domain/questions.js";
import type { HitlCore } from "./hitl-service.js";

const interpretInput = z.object({
  question_id: z.string(),
  answer_id: z.string(),
  root_question_id: z.string(),
  correction_text: z.string().nullable().optional(),
  round: z.number().int().min(0).default(0),
});
const gradeInput = z.object({ question_id: z.string() });
const applyInput = z.object({ question_id: z.string() });

export interface HitlTaskDeps {
  platform: Platform;
  audit?: AuditService;
  agents: AgentsService;
  orchestration: OrchestrationService;
  ontology: OntologyService;
}

async function minimalContext(deps: HitlTaskDeps, run: RunHandle, builderArgs: { answerIds?: string[] }, builder: { build(run: RunHandle, spec: ContextSpec): Promise<ContextPack> }): Promise<ContextPack> {
  let timelineId = "";
  try {
    timelineId = (await deps.ontology.getDefaultTimeline({ novelId: run.novelId })).id;
  } catch {
    /* ontology placeholder */
  }
  return builder.build(run, {
    anchor: { storyPoint: 0, timelineId },
    seeds: { entityIds: [], setupIds: [], answerIds: builderArgs.answerIds ?? [], mentionIds: [] },
    sections: ["instruction", "constraints", "entity_cards"],
    maxInputTokens: 8000,
    hopPredicates: { hop2: [] },
  });
}

// ── 설계 추가 0026: the sentences of an interpretation / a grade never keep an entity handle ("E7") ──
/** id reference fields of an interpretation (never sentences) */
const INTERPRET_REFS = { skipKeys: ["entity_ids", "subject_entity_id", "object_entity_id", "predicate"] };
const NEUTRAL_SUMMARY = "답변을 해석했습니다. 아래 항목을 확인해 주세요.";

/**
 * What the repair round left (P3 / P4): a change whose description still names someone by a handle is dropped, such a
 * follow-up question is removed, such a summary becomes a neutral line. Nothing with a handle reaches the
 * interpretation row or the confirmation question. `allow`: story tokens + what the person typed in the answer.
 */
export function scrubInterpretation(out: InterpretAnswerOutput, allow: ReadonlySet<string>): InterpretAnswerOutput {
  const leaks = (v: unknown) => leakedHandleTokens(v, allow).length > 0;
  if (!leakedHandleTokens(out, allow, INTERPRET_REFS).length) return out;
  const { followup_question_ko: followup, ...rest } = out;
  return {
    ...rest,
    summary_ko: leaks(out.summary_ko) ? NEUTRAL_SUMMARY : out.summary_ko,
    changes: out.changes.filter((c) => !leaks(c.description_ko)),
    ...(followup && !leaks(followup) ? { followup_question_ko: followup } : {}),
  };
}

/** story tokens of the novel; none while the ontology is a placeholder */
async function storyTokensOf(deps: HitlTaskDeps, scope: NovelScope): Promise<Set<string>> {
  try {
    return await deps.ontology.storyHandleTokens(scope);
  } catch {
    return new Set();
  }
}

function parseOutput<T>(schema: z.ZodType<T>, v: unknown): T {
  const raw = typeof v === "string" ? safeJson(v) : v;
  const r = schema.safeParse(raw);
  if (!r.success) throw new TaskFailure("invalid_output", `structured output failed validation: ${r.error.issues[0]?.message ?? "invalid"}`);
  return r.data;
}
function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Registers the three kinds; returns which LLM kinds are available (agents may still be a placeholder). */
export function registerHitlTasks(core: HitlCore, deps: HitlTaskDeps, already: { interpret: boolean; grade: boolean; apply?: boolean } = { interpret: false, grade: false }): { interpret: boolean; grade: boolean } {
  const { agents, orchestration, platform } = deps;
  const out = { interpret: already.interpret, grade: already.grade };
  const scopeOf = (run: RunHandle): NovelScope => ({ novelId: run.novelId });

  // deterministic: apply_answer re-runs the application of an accepted choice answer whose reflection is pending
  if (!already.apply) try {
    orchestration.registerTaskKind({
      kind: "apply_answer",
      role: "world_keeper",
      promptTemplateVersion: "code.apply_answer@0.1.0",
      inputSchema: applyInput,
      async execute() {
        return {};
      },
      async commit(tx, ctx) {
        const scope = ctx.scope;
        const q = await core.mustQuestion(tx, scope, ctx.input.question_id, true);
        const refl = await repo.reflectionByQuestion(tx.db, scope, q.id);
        if (q.status !== "answered" || (refl && refl.status !== "pending") || !q.acceptedAnswerId) return { kind: "done", outputRefs: [{ refType: "question", refId: q.id }] };
        const answer = (await repo.getAnswer(tx.db, scope, q.acceptedAnswerId))!;
        if ((answer.payload as AnswerPayload).text) return { kind: "done", outputRefs: [{ refType: "question", refId: q.id }] }; // free text waits for interpretation
        await core.applyChoice(tx, scope, q, answer, actors.agent("world_keeper", ctx.run.runId));
        return { kind: "done", outputRefs: [{ refType: "question", refId: q.id }] };
      },
    });
  } catch (err) {
    if (!(err instanceof NotImplementedError) && !/already registered/.test(String(err))) throw err;
  }

  if (!already.interpret) try {
    orchestration.registerTaskKind(
      agents.defineAgentTask<z.infer<typeof interpretInput>, InterpretAnswerOutput>({
        kind: "interpret_answer",
        role: "world_keeper",
        promptTemplateVersion: "world_keeper.interpret_answer@0.1.0",
        inputSchema: interpretInput as z.ZodType<z.infer<typeof interpretInput>>,
        allowedWrites: ["hitl.answer_interpretations", "hitl.questions"],
        buildContext: (run, input, builder) => minimalContext(deps, run, { answerIds: [input.answer_id] }, builder),
        async execute(run, input, context, llm: ModelCallPort) {
          const scope = scopeOf(run);
          const q = await core.mustQuestion(undefined, scope, input.question_id);
          const root = await core.mustQuestion(undefined, scope, input.root_question_id);
          const answer = await repo.getAnswer(platform.uow.db, scope, input.answer_id);
          const options = await repo.listOptions(platform.uow.db, scope, root.id);
          const text = input.correction_text ?? (answer?.payload as AnswerPayload | undefined)?.text ?? "";
          // P4: the interpretation may quote a symbol the person typed in the answer; nothing else
          const allow = new Set([...(await storyTokensOf(deps, scope)), ...humanHandleTokens(text)]);
          const r = await callWithRepair<InterpretAnswerOutput, null>({
            llm,
            request: {
              run,
              purpose: "interpret",
              system: `${context.system}\n\n당신은 world_keeper입니다. 사용자의 서술형 답을 작품 변경 후보(사실·제약·작업 변경·이름 규칙)로 해석합니다. 엔티티는 ID로만 가리키고, 모호하면 status=needs_followup과 followup_question_ko를 냅니다. 확인 전에는 아무것도 캐논이 되지 않습니다. ${NO_HANDLE_RULE}`,
              messages: [
                ...context.messages,
                {
                  role: "user",
                  content: JSON.stringify({
                    question: { title: root.title, body: root.body, options: options.map((o) => ({ idx: o.idx, label: o.label, value: o.value })), recommendation: readRecommendation(root.recommendation).rationale },
                    answering_question: q.id === root.id ? null : { title: q.title, body: q.body },
                    answer_text: text,
                    correction_round: input.round,
                  }),
                },
              ],
              output: { kind: "object", schemaName: "interpret_answer", schema: interpretAnswerOutputSchema as z.ZodType<InterpretAnswerOutput> },
            },
            validate: (v) => {
              const parsed = interpretAnswerOutputSchema.safeParse(v);
              return { result: null, issues: parsed.success ? handleLeakRepairIssues(leakedHandleTokens(parsed.data, allow, INTERPRET_REFS), "해석 문장") : [] };
            },
            label: "해석 문장 표기 검사",
            maxRounds: 1,
          });
          const out = scrubInterpretation(parseOutput(interpretAnswerOutputSchema, r.value), allow);
          // a follow-up was needed but its question could not be kept: the next attempt writes it with names
          if (out.status === "needs_followup" && !out.followup_question_ko) throw new TaskFailure("invalid_output", "후속 질문 문장에 'E숫자' 기호가 남아 있습니다. 인물·장소의 이름으로 다시 쓰세요.", true);
          return out;
        },
        async commit(tx, run, input, proposal) {
          const res = await core.commitInterpretation(tx, scopeOf(run), { ...input, round: input.round ?? 0 }, run.runId, actors.agent("world_keeper", run.runId), proposal);
          return { kind: "done", outputRefs: [{ refType: "question", refId: res.questionId }] };
        },
      }),
    );
    out.interpret = true;
  } catch (err) {
    if (!(err instanceof NotImplementedError)) throw err;
  }

  if (!already.grade) try {
    orchestration.registerTaskKind(
      agents.defineAgentTask<z.infer<typeof gradeInput>, GradeQuestionOutput>({
        kind: "grade_question",
        role: "showrunner",
        promptTemplateVersion: "showrunner.grade_question@0.1.0",
        inputSchema: gradeInput,
        allowedWrites: ["hitl.questions"],
        buildContext: (run, _input, builder) => minimalContext(deps, run, {}, builder),
        async execute(run, input, context, llm) {
          const q = await core.mustQuestion(undefined, scopeOf(run), input.question_id);
          const options = await repo.listOptions(platform.uow.db, scopeOf(run), q.id);
          const r = await llm.call<GradeQuestionOutput>({
            run,
            purpose: "grade",
            system: `${context.system}\n\n당신은 showrunner입니다. 이 질문의 결정이 결말 방향·아크 목표·주요 인물 생사·승인된 캐논·공개된 캐논에 닿는지 판단합니다. 닿으면 blocking=true와 basis를 냅니다. 확실하지 않으면 blocking=false입니다. ${NO_HANDLE_RULE}`,
            messages: [...context.messages, { role: "user", content: JSON.stringify({ topic: q.topic, title: q.title, body: q.body, options: options.map((o) => o.label), current_grade: q.grade }) }],
            output: { kind: "object", schemaName: "grade_question", schema: gradeQuestionOutputSchema as z.ZodType<GradeQuestionOutput> },
          });
          const out = parseOutput(gradeQuestionOutputSchema, r.value);
          // 설계 추가 0026 (P3): the reason is appended to the question's grade reason — never with a handle (the grade stays)
          return leakedHandleTokens(out.reason_ko, await storyTokensOf(deps, scopeOf(run))).length ? { ...out, reason_ko: "" } : out;
        },
        async commit(tx, run, input, proposal) {
          const scope = scopeOf(run);
          const q = await core.mustQuestion(tx, scope, input.question_id, true);
          const next = applyLlmGrade({ grade: q.grade, basis: q.blockingBasis }, proposal);
          if (next.changed && (q.status === "pending" || q.status === "open") && !q.acceptedAnswerId) {
            const at = platform.clock.date();
            await repo.updateQuestion(tx.db, scope, q.id, ["pending", "open"], {
              grade: "blocking",
              blockingBasis: next.basis,
              ...(HIGH_SENSITIVITY_BASES.has(next.basis) ? { sensitivity: "high" as const } : {}),
              gradeReason: `${q.gradeReason}; G3 LLM 판정: ${proposal.reason_ko || next.basis}`,
              digestBatchId: q.status === "pending" ? null : q.digestBatchId,
              recommendation: { ...readRecommendation(q.recommendation), default_action: "hold" },
              updatedAt: at,
            });
            await deps.audit?.record(tx, {
              novelId: scope.novelId,
              actor: actors.agent("showrunner", run.runId),
              action: "question.regraded",
              target: { type: "question", id: q.id },
              before: { grade: q.grade, blockingBasis: q.blockingBasis },
              after: { grade: "blocking", blockingBasis: next.basis },
              reason: proposal.reason_ko || null,
              questionId: q.id,
            });
            const origin = readRecommendation(q.recommendation).origin_task_id;
            if (origin) {
              try {
                await orchestration.blockTask(tx, scope, origin, "question", { refType: "question", refId: q.id }, actors.agent("showrunner", run.runId));
              } catch {
                /* origin task already finished / terminal */
              }
            }
          }
          return { kind: "done", outputRefs: [{ refType: "question", refId: q.id }] };
        },
      }),
    );
    out.grade = true;
  } catch (err) {
    if (!(err instanceof NotImplementedError)) throw err;
  }
  return out;
}
