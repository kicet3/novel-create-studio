/**
 * foreshadow task handlers (04 §2.2, 07 §1.3 B4 / §5.2 P3e, FR-FOR-04):
 *   plan_setups (arc), check_setups (episode), review_setup_due (setup).
 * Built as agents `AgentTaskHandler`s → `agents.defineAgentTask` → `orchestration.registerTaskKind`.
 * execute = reads + LLM only (P-2); commit = deterministic writes in the engine's transaction.
 */
import { z, ZodError } from "zod";
import { DEFAULTS, defaultValue } from "@ncs/shared";
import { actors, type ActorRef, type NovelScope } from "../../../platform/index.js";
import { callWithRepair, handleLeakIssue, handleLeakRepairIssues, leakedHandleTokens, NO_HANDLE_RULE, type AgentTaskHandler, type ContextBuilder, type ContextPack, type ContextSpec } from "../../agents/index.js";
import type { ModelCallPort } from "../../llm/index.js";
import { TaskFailure, type RunHandle } from "../../orchestration/index.js";
import { foreshadowRepo as repo } from "../adapters/db/foreshadow-repository.js";
import { locateQuote, setupCheckReportSchema, setupDueReviewSchema, type SceneSpan, type SetupCheckReport, type SetupDueReview } from "../domain/check.js";
import { describeViolations, setupPlanSchema, validateSetupPlan, type PlanCheckContext, type SetupPlan } from "../domain/plan.js";
import { effectiveDue } from "../domain/report.js";
import { formatSetupNo, TERMINAL_NARRATIVE } from "../domain/transitions.js";
import type { SetupIssueDraft } from "../index.js";
import type { ForeshadowInternals } from "./foreshadow-service.js";
import { orPlaceholder, type ForeshadowPorts } from "./ports.js";
import { CHECK_INSTRUCTION, compose, DUE_INSTRUCTION, PLAN_INSTRUCTION, PROMPT_VERSIONS, SCHEMA_NAMES } from "./prompts.js";

const scopeOfRun = (run: RunHandle): NovelScope => ({ novelId: run.novelId });
const agentActor = (run: RunHandle): ActorRef => actors.agent("foreshadow_manager", run.runId);
const maxTokens = () => DEFAULTS["context.max_input_tokens.default"];

async function callObject<T>(llm: ModelCallPort, run: RunHandle, purpose: string, schemaName: string, schema: z.ZodType<T>, prompt: { system: string; messages: Array<{ role: "user" | "assistant"; content: string }> }): Promise<T> {
  const out = await llm.call<T>({ run, purpose, system: prompt.system, messages: prompt.messages, output: { kind: "object", schemaName, schema } });
  try {
    return schema.parse(out.value);
  } catch (err) {
    if (err instanceof ZodError) throw new TaskFailure("invalid_output", `${schemaName} 출력 형식이 올바르지 않습니다.`, true);
    throw err;
  }
}

async function buildSimpleContext(builder: ContextBuilder, run: RunHandle, spec: Partial<ContextSpec> & Pick<ContextSpec, "anchor">): Promise<ContextPack> {
  return builder.build(run, {
    seeds: { entityIds: [], setupIds: [], answerIds: [], mentionIds: [] },
    sections: ["instruction", "constraints", "entity_cards", "canon_1hop"],
    maxInputTokens: maxTokens(),
    hopPredicates: { hop2: [] },
    ...spec,
  });
}

/**
 * 설계 추가 0026 (P1): the only exemption — the novel's story tokens (handle-looking tokens inside a name a person gave an
 * entity, "E3 구역"). `storyHandleTokens` is optional on the port (narrow stubs).
 */
async function storyTokens(deps: ForeshadowPorts, scope: NovelScope): Promise<Set<string>> {
  return deps.ontology.storyHandleTokens ? orPlaceholder(() => deps.ontology.storyHandleTokens!(scope), new Set<string>()) : new Set<string>();
}
/** a diagnostic note of a check / review that still names someone by a handle is not stored (the verdict itself stays) */
const cleanNote = <T extends string | undefined>(text: T, story: ReadonlySet<string>): T | undefined => (text && leakedHandleTokens(text, story).length ? undefined : text);

// ── plan_setups ──────────────────────────────────────────────────────────
/**
 * 설계 추가 0026: fields of a SetupPlan that are not scanned — id references (resolved / validated as ids, never
 * sentences) and the plan's `rationale` (a comment on the arc text that is not stored in any setup / beat: it is
 * dropped when it carries a handle instead of sending the whole plan back).
 */
const PLAN_REFS = { skipKeys: ["entity_ids", "fact_ids", "setup_id", "rationale"] };
export const planSetupsInputSchema = z.object({ arc_id: z.string() }).passthrough();
export type PlanSetupsInput = z.infer<typeof planSetupsInputSchema>;
export interface PlanSetupsProposal {
  arcId: string;
  plan: SetupPlan;
}

export function planSetupsHandler(deps: ForeshadowPorts, svc: ForeshadowInternals): AgentTaskHandler<PlanSetupsInput, PlanSetupsProposal> {
  async function checkContext(scope: NovelScope, arcId: string): Promise<PlanCheckContext> {
    const arc = await deps.novel.getArc(scope, arcId);
    const arcs = await deps.novel.listArcs(scope);
    const setups = await repo.listSetups(deps.platform.uow.db, scope);
    const beats = await repo.listBeats(deps.platform.uow.db, scope, { setupIds: setups.map((s) => s.id) });
    return {
      arc: { id: arc.id, plannedEpisodeFrom: arc.plannedEpisodeFrom, plannedEpisodeTo: arc.plannedEpisodeTo },
      arcEnds: new Map(arcs.map((a) => [a.id, a.plannedEpisodeTo])),
      existing: new Map(
        setups.map((s) => {
          const plants = beats.filter((b) => b.setupId === s.id && b.kind === "plant" && b.status !== "cancelled" && b.plannedEpisodeNo != null);
          return [
            s.id,
            {
              narrativeStatus: s.narrativeStatus,
              dueKind: s.dueKind,
              dueEpisodeNo: s.dueEpisodeNo,
              dueArcId: s.dueArcId,
              plantConfirmed: s.narrativeStatus === "planted" || s.narrativeStatus === "reinforced",
              plantEpisodeNo: plants.length ? Math.min(...plants.map((b) => b.plannedEpisodeNo!)) : null,
            },
          ];
        }),
      ),
    };
  }

  return {
    kind: "plan_setups",
    role: "foreshadow_manager",
    promptTemplateVersion: PROMPT_VERSIONS.plan_setups,
    inputSchema: planSetupsInputSchema,
    allowedWrites: ["foreshadow.createSetup", "foreshadow.planBeats", "manuscript.requestArcPlanApproval"],
    async buildContext(run, input, builder) {
      const scope = scopeOfRun(run);
      const arc = await deps.novel.getArc(scope, input.arc_id);
      const tl = await deps.ontology.getDefaultTimeline(scope);
      const open = (await svc.listSetups(scope, { narrativeStatuses: ["planned", "planted", "reinforced"] })).filter((s) => s.canonStatus !== "rejected");
      return buildSimpleContext(builder, run, {
        anchor: { storyPoint: arc.plannedEpisodeFrom * 1000, timelineId: tl.id },
        seeds: { entityIds: [], setupIds: open.map((s) => s.id), answerIds: [], mentionIds: [] },
      });
    },
    async execute(run, input, context, llm) {
      const scope = scopeOfRun(run);
      const arc = await deps.novel.getArc(scope, input.arc_id);
      const open = (await svc.listSetups(scope, { narrativeStatuses: ["planned", "planted", "reinforced"] })).filter((s) => s.canonStatus !== "rejected" && s.canonStatus !== "retracted");
      const user = [
        `[ARC] id=${arc.id} from=${arc.plannedEpisodeFrom} to=${arc.plannedEpisodeTo}`,
        `제목: ${arc.title}`,
        `목표: ${arc.goalText}`,
        `갈등: ${arc.conflictText}`,
        `결말 조건: ${arc.endCondition}`,
        "",
        "[OPEN_SETUPS]",
        ...open.map((s) => `- id=${s.id} ${formatSetupNo(s.displayNo)} "${s.title}" 상태=${s.narrativeStatus} 기한=${s.effectiveDueEpisodeNo ?? "?"}화 중요도=${s.importance}: ${s.description}`),
        "[/OPEN_SETUPS]",
      ].join("\n");
      // 설계 추가 0026 (P7): "E7" style symbols are never written into a setup title / description / beat note
      const prompt = compose(context, `${PLAN_INSTRUCTION}\n- ${NO_HANDLE_RULE}`, user);
      // P1/P3: this run is shown no handle marks and its arc text may echo handles of other packs, so a token cannot be
      // mapped to a name with this pack's labels — it goes back for repair. Only a token inside a real entity name
      // (of the pack or of the novel: "E3 구역") is story text.
      const story = await storyTokens(deps, scope);
      const leaksOf = (p: SetupPlan) => leakedHandleTokens(p, story, PLAN_REFS);
      // 07 §1.3 correction request in the same run, as an agent-to-agent repair dialogue (recorded on the run)
      const repaired = await callWithRepair({
        llm,
        request: { run, purpose: "plan", system: prompt.system, messages: prompt.messages, output: { kind: "object", schemaName: SCHEMA_NAMES.plan, schema: setupPlanSchema } },
        validate: async (p: SetupPlan) => {
          const v = validateSetupPlan(p, await checkContext(scope, arc.id));
          return { result: v, issues: [...v.map((x) => ({ item: `[${x.rule}] ${x.target}`, problem: x.message })), ...handleLeakRepairIssues(leaksOf(p), "떡밥 문장")] };
        },
        label: "떡밥 배치 검사",
        critic: "떡밥 배치 검사 에이전트",
        instruction: "위반을 모두 고친 전체 계획을 다시 내세요.",
        maxRounds: Math.max(1, defaultValue("agents.repair_rounds")),
        repairPurpose: "repair",
      });
      const plan = setupPlanSchema.parse(repaired.value);
      if (leakedHandleTokens(plan.rationale, story).length) delete plan.rationale;
      if (repaired.result.length) throw new TaskFailure("invalid_output", `떡밥 배치 검사 실패(에이전트 간 수정 대화 ${repaired.rounds}회 후): ${describeViolations(repaired.result)}`, false);
      // never stored with a handle token left; the next attempt is told why (retry with feedback)
      const leaks = leaksOf(plan);
      if (leaks.length) throw new TaskFailure("invalid_output", `떡밥 문장 검사 실패(에이전트 간 수정 대화 ${repaired.rounds}회 후): ${handleLeakIssue(leaks)}`, true);
      return { arcId: arc.id, plan };
    },
    async commit(tx, run, _input, proposal) {
      const scope = scopeOfRun(run);
      const actor = agentActor(run);
      // re-validate against the committed state (another plan may have landed meanwhile)
      const violations = validateSetupPlan(proposal.plan, await (async () => {
        const arc = await deps.novel.getArc(scope, proposal.arcId, tx);
        const arcs = await deps.novel.listArcs(scope, tx);
        const setups = await repo.listSetups(tx.db, scope);
        const beats = await repo.listBeats(tx.db, scope, { setupIds: setups.map((s) => s.id) });
        return {
          arc: { id: arc.id, plannedEpisodeFrom: arc.plannedEpisodeFrom, plannedEpisodeTo: arc.plannedEpisodeTo },
          arcEnds: new Map(arcs.map((a) => [a.id, a.plannedEpisodeTo])),
          existing: new Map(
            setups.map((s) => {
              const plants = beats.filter((b) => b.setupId === s.id && b.kind === "plant" && b.status !== "cancelled" && b.plannedEpisodeNo != null);
              return [s.id, { narrativeStatus: s.narrativeStatus, dueKind: s.dueKind, dueEpisodeNo: s.dueEpisodeNo, dueArcId: s.dueArcId, plantConfirmed: s.narrativeStatus === "planted" || s.narrativeStatus === "reinforced", plantEpisodeNo: plants.length ? Math.min(...plants.map((b) => b.plannedEpisodeNo!)) : null }];
            }),
          ),
        } satisfies PlanCheckContext;
      })());
      if (violations.length) return { kind: "failed", reason: `떡밥 배치 검사 실패: ${describeViolations(violations)}` };
      const refs: Array<{ refType: "setup" | "setup_beat"; refId: string }> = [];
      for (const ns of proposal.plan.new_setups) {
        const s = await svc.createSetup(
          tx,
          scope,
          {
            title: ns.title,
            description: ns.description,
            importance: ns.importance,
            dueKind: ns.due_kind,
            dueEpisodeNo: ns.due_kind === "episode" ? (ns.due_episode_no ?? null) : null,
            dueArcId: ns.due_kind === "arc" ? proposal.arcId : null,
            plannedArcId: proposal.arcId,
            links: [...ns.entity_ids.map((id) => ({ type: "entity" as const, id })), ...ns.fact_ids.map((id) => ({ type: "fact" as const, id }))],
          },
          actor,
        );
        await svc.planBeats(tx, scope, s.id, ns.beats.map((b) => ({ kind: b.kind, plannedEpisodeNo: b.planned_episode_no, note: b.note })), actor);
        refs.push({ refType: "setup", refId: s.id });
      }
      for (const e of proposal.plan.existing_setup_beats) {
        const beats = await svc.planBeats(tx, scope, e.setup_id, e.beats.map((b) => ({ kind: b.kind, plannedEpisodeNo: b.planned_episode_no, note: b.note })), actor);
        refs.push(...beats.map((b) => ({ refType: "setup_beat" as const, refId: b.id })));
      }
      // B3 + B4 → G2: manuscript requests the arc_plan approval (no-op when already requested / full_auto handled there)
      await orPlaceholder(() => deps.manuscript.requestArcPlanApproval(tx, scope, proposal.arcId, actor), null);
      return { kind: "done", outputRefs: refs };
    },
  };
}

// ── check_setups ─────────────────────────────────────────────────────────
export const checkSetupsInputSchema = z
  .object({ episode_id: z.string(), manuscript_version_id: z.string().optional(), cycle_key: z.string().optional() })
  .passthrough();
export type CheckSetupsInput = z.infer<typeof checkSetupsInputSchema>;

export interface BeatResult {
  beatId: string;
  setupId: string;
  kind: "plant" | "reinforce" | "payoff";
  found: boolean;
  span: { sceneId: string; charStart: number; charEnd: number } | null;
  contradiction: "none" | "contradiction" | "uncertain";
  note: string | null;
}

export interface CheckSetupsProposal {
  episodeId: string;
  episodeNo: number;
  versionId: string;
  results: BeatResult[];
  /** current fact versions of the setups' fact links (pinned on plant detection) */
  pins: Array<{ setupId: string; versions: Array<{ factId: string; factVersionId: string }> }>;
  unplanned: SetupCheckReport["unplanned"];
}

function versionIdOf(input: CheckSetupsInput, episode: { currentVersionId: string | null }): string {
  const v = input.manuscript_version_id ?? input.cycle_key ?? episode.currentVersionId;
  if (!v) throw new TaskFailure("internal", "검사할 원고 버전이 없습니다.", false);
  return v;
}

export function checkSetupsHandler(deps: ForeshadowPorts, svc: ForeshadowInternals): AgentTaskHandler<CheckSetupsInput, CheckSetupsProposal> {
  return {
    kind: "check_setups",
    role: "foreshadow_manager",
    promptTemplateVersion: PROMPT_VERSIONS.check_setups,
    inputSchema: checkSetupsInputSchema,
    allowedWrites: ["foreshadow.recordBeatResult", "continuity.openIssue", "manuscript.advanceCheckGate"],
    async buildContext(run, input, builder) {
      const scope = scopeOfRun(run);
      const ep = await deps.manuscript.getEpisode(scope, input.episode_id);
      const beats = await svc.beatsForEpisode(scope, ep.episodeNo);
      return buildSimpleContext(builder, run, {
        anchor: { storyPoint: ep.episodeNo * 1000, timelineId: ep.primaryTimelineId },
        seeds: { entityIds: [], setupIds: [...new Set(beats.map((b) => b.setupId))], answerIds: [], mentionIds: [] },
        episodeId: ep.id,
        manuscriptVersionId: versionIdOf(input, ep),
      });
    },
    async execute(run, input, context, llm) {
      const scope = scopeOfRun(run);
      const ep = await deps.manuscript.getEpisode(scope, input.episode_id);
      const versionId = versionIdOf(input, ep);
      const all = await svc.beatsForEpisode(scope, ep.episodeNo);
      const targets = all.filter((b) => b.status === "planned" || b.status === "missing" || (b.status === "detected" && b.manuscriptVersionId !== versionId));
      const empty: CheckSetupsProposal = { episodeId: ep.id, episodeNo: ep.episodeNo, versionId, results: [], pins: [], unplanned: [] };
      if (!targets.length) return empty;

      const version = await deps.manuscript.getVersion(scope, versionId);
      const scenes: SceneSpan[] = (await deps.manuscript.listScenes(scope, ep.id, { versionId })).map((s) => ({ id: s.id, ord: s.ord, charStart: s.charStart, charEnd: s.charEnd }));
      const setupIds = [...new Set(targets.map((b) => b.setupId))];
      const links = (await repo.listLinks(deps.platform.uow.db, scope, setupIds)).filter((l) => l.refType === "fact");
      const facts = links.length ? await orPlaceholder(() => deps.ontology.getSetupLinkedFacts(scope, [...new Set(links.map((l) => l.refId))]), []) : [];
      // plant evidence excerpt for payoff comparison
      const setupBeats = await repo.listBeats(deps.platform.uow.db, scope, { setupIds });
      const plantExcerpt = new Map<string, string>();
      for (const sid of setupIds) {
        const plant = setupBeats.find((b) => b.setupId === sid && b.kind === "plant" && b.status === "confirmed" && b.manuscriptVersionId);
        if (plant && plant.charStart != null && plant.charEnd != null) {
          const v = await orPlaceholder(() => deps.manuscript.getVersion(scope, plant.manuscriptVersionId!), null);
          if (v) plantExcerpt.set(sid, v.content.slice(Math.max(0, plant.charStart - 200), Math.min(v.content.length, plant.charEnd + 200)));
        }
      }
      const sceneBlocks = scenes.length
        ? scenes.map((s) => `[SCENE ${s.ord}]\n${version.content.slice(s.charStart, s.charEnd)}\n[/SCENE]`)
        : [`[SCENE 1]\n${version.content}\n[/SCENE]`];
      const user = [
        `[EPISODE] no=${ep.episodeNo} version=${versionId}`,
        ...targets.map((b) => {
          const f = links.filter((l) => l.setupId === b.setupId).map((l) => facts.find((x) => x.factId === l.refId)?.text).filter(Boolean);
          return [
            `[BEAT] id=${b.id} kind=${b.kind} setup=${formatSetupNo(b.setup.displayNo)} "${b.setup.title}"`,
            `설명: ${b.setup.description}`,
            b.plannedNote ? `배정 메모: ${b.plannedNote}` : null,
            b.kind === "payoff" && f.length ? `[PLANTED]\n${f.join("\n")}\n[/PLANTED]` : null,
            b.kind === "payoff" && plantExcerpt.get(b.setupId) ? `설치 장면: ${plantExcerpt.get(b.setupId)}` : null,
          ]
            .filter(Boolean)
            .join("\n");
        }),
        "",
        ...sceneBlocks,
      ].join("\n");
      const raw = await callObject(llm, run, "check", SCHEMA_NAMES.check, setupCheckReportSchema, compose(context, `${CHECK_INSTRUCTION}\n- note·contradiction_note에는 'E7' 같은 'E숫자' 기호를 쓰지 말고 인물·장소의 이름을 쓰세요. quote는 원고 그대로 둡니다.`, user));
      // 설계 추가 0026: the notes end up in issue messages — one that carries a handle is dropped (quotes stay verbatim)
      const story = await storyTokens(deps, scope);
      const report: SetupCheckReport = {
        findings: raw.findings.map((f) => ({ ...f, note: cleanNote(f.note, story), contradiction_note: cleanNote(f.contradiction_note, story) })),
        unplanned: raw.unplanned.map((u) => ({ ...u, note: cleanNote(u.note, story) })),
      };
      const sceneFallback: SceneSpan[] = scenes.length ? scenes : [];
      const results: BeatResult[] = targets.map((b) => {
        const f = report.findings.find((x) => x.beat_id === b.id);
        const span = f?.found ? locateQuote(version.content, sceneFallback, f.quote, f.scene_ord) : null;
        return {
          beatId: b.id,
          setupId: b.setupId,
          kind: b.kind,
          found: !!span,
          span,
          contradiction: b.kind === "payoff" && span ? (f?.contradiction ?? "none") : "none",
          note: f ? (f.contradiction_note ?? f.note ?? (f.found && !span ? "근거 위치를 원고에서 찾지 못했습니다." : null)) : "검사 결과에 비트가 없습니다.",
        };
      });
      const pins = setupIds.map((sid) => ({
        setupId: sid,
        versions: links.filter((l) => l.setupId === sid).map((l) => facts.find((x) => x.factId === l.refId)).filter((x): x is NonNullable<typeof x> => !!x).map((x) => ({ factId: x.factId, factVersionId: x.factVersionId })),
      }));
      return { ...empty, results, pins, unplanned: report.unplanned };
    },
    async commit(tx, run, _input, p, task) {
      const scope = scopeOfRun(run);
      const actor = agentActor(run);
      const drafts: SetupIssueDraft[] = [];
      const refs: Array<{ refType: "setup_beat"; refId: string }> = [];
      for (const r of p.results) {
        const beat = await repo.getBeat(tx.db, scope, r.beatId);
        if (!beat || beat.status === "cancelled" || beat.status === "confirmed") continue; // changed meanwhile
        await svc.recordBeatResult(
          tx,
          scope,
          r.beatId,
          r.found && r.span
            ? { status: "detected", manuscriptVersionId: p.versionId, episodeId: p.episodeId, sceneId: r.span.sceneId, charStart: r.span.charStart, charEnd: r.span.charEnd, runId: run.runId }
            : { status: "missing", manuscriptVersionId: p.versionId, episodeId: p.episodeId, runId: run.runId },
          actor,
        );
        refs.push({ refType: "setup_beat", refId: r.beatId });
        const setup = await repo.getSetup(tx.db, scope, r.setupId);
        const label = setup ? `${formatSetupNo(setup.displayNo)} "${setup.title}"` : r.setupId;
        if (!r.found) {
          drafts.push({
            kind: "setup_missing",
            severity: "high",
            setupId: r.setupId,
            beatId: r.beatId,
            episodeId: p.episodeId,
            manuscriptVersionId: p.versionId,
            message: `${p.episodeNo}화에 배정된 떡밥 ${label}의 ${r.kind} 비트가 원고에 없습니다.`,
            suggestion: beat.plannedNote ? `배정 메모대로 구현하세요: ${beat.plannedNote}` : "배정된 씬에 비트를 넣어 다시 쓰세요.",
            fixScope: "scene",
          });
        } else if (r.kind === "plant") {
          const pin = p.pins.find((x) => x.setupId === r.setupId);
          if (pin) await svc.pinLinkedFacts(tx, scope, r.setupId, pin.versions);
        }
        if (r.found && r.contradiction !== "none") {
          const pin = p.pins.find((x) => x.setupId === r.setupId);
          drafts.push({
            kind: "setup_contradiction",
            severity: r.contradiction === "contradiction" ? "high" : "medium",
            setupId: r.setupId,
            beatId: r.beatId,
            episodeId: p.episodeId,
            manuscriptVersionId: p.versionId,
            sceneId: r.span?.sceneId ?? null,
            charStart: r.span?.charStart ?? null,
            charEnd: r.span?.charEnd ?? null,
            message: `떡밥 ${label}의 회수가 설치 내용과 ${r.contradiction === "contradiction" ? "모순됩니다" : "모순일 수 있습니다(불확실)"}.${r.note ? ` ${r.note}` : ""}`,
            fixScope: "scene",
            factVersionIds: pin?.versions ?? [],
          });
        }
      }
      for (const sink of svc.issueSinks) {
        await sink.reconcileSetupIssues(tx, scope, { episodeId: p.episodeId, manuscriptVersionId: p.versionId, drafts, runId: run.runId }, actor);
      }
      if (!svc.issueSinks.length && drafts.length) deps.platform.log.warn({ count: drafts.length }, "foreshadow: no issue sink registered, setup issues not persisted");
      await orPlaceholder(() => deps.manuscript.advanceCheckGate(tx, scope, p.episodeId, { completedTaskId: task.id }), null);
      return { kind: "done", outputRefs: refs };
    },
  };
}

// ── review_setup_due ─────────────────────────────────────────────────────
export const reviewSetupDueInputSchema = z.object({ setup_id: z.string(), as_of_episode_no: z.number().int().optional() }).passthrough();
export type ReviewSetupDueInput = z.infer<typeof reviewSetupDueInputSchema>;
export interface ReviewSetupDueProposal {
  setupId: string;
  asOf: number;
  due: number | null;
  review: SetupDueReview | null;
}

export function reviewSetupDueHandler(deps: ForeshadowPorts, svc: ForeshadowInternals): AgentTaskHandler<ReviewSetupDueInput, ReviewSetupDueProposal> {
  return {
    kind: "review_setup_due",
    role: "foreshadow_manager",
    promptTemplateVersion: PROMPT_VERSIONS.review_setup_due,
    inputSchema: reviewSetupDueInputSchema,
    allowedWrites: ["hitl.createQuestion"],
    async buildContext(run, input, builder) {
      const scope = scopeOfRun(run);
      const tl = await deps.ontology.getDefaultTimeline(scope);
      const asOf = input.as_of_episode_no ?? (await svc.currentEpisodeNo(scope)) ?? 1;
      return buildSimpleContext(builder, run, {
        anchor: { storyPoint: asOf * 1000, timelineId: tl.id },
        seeds: { entityIds: [], setupIds: [input.setup_id], answerIds: [], mentionIds: [] },
      });
    },
    async execute(run, input, context, llm) {
      const scope = scopeOfRun(run);
      const s = await svc.getSetup(scope, input.setup_id);
      const asOf = input.as_of_episode_no ?? (await svc.currentEpisodeNo(scope)) ?? 1;
      const due = s.effectiveDueEpisodeNo;
      if (TERMINAL_NARRATIVE.includes(s.narrativeStatus) || due == null || due >= asOf) return { setupId: s.id, asOf, due, review: null };
      const user = [
        `[DUE] current=${asOf} due=${due}`,
        `떡밥 ${formatSetupNo(s.displayNo)} "${s.title}" (중요도 ${s.importance}, 상태 ${s.narrativeStatus})`,
        s.description,
        `비트: ${s.beats.map((b) => `${b.kind}@${b.plannedEpisodeNo ?? "?"}화(${b.status})`).join(", ")}`,
      ].join("\n");
      const raw = await callObject(llm, run, "review_due", SCHEMA_NAMES.due, setupDueReviewSchema, compose(context, `${DUE_INSTRUCTION}\n${NO_HANDLE_RULE}`, user));
      // 설계 추가 0026: rationale / body become the question text — with a handle left, the built-in wording is used
      const story = await storyTokens(deps, scope);
      const review: SetupDueReview = { ...raw, rationale: cleanNote(raw.rationale, story) ?? "", body: cleanNote(raw.body, story) };
      return { setupId: s.id, asOf, due, review };
    },
    async commit(tx, run, _input, p) {
      const scope = scopeOfRun(run);
      const s = await repo.getSetup(tx.db, scope, p.setupId);
      if (!s || !p.review || TERMINAL_NARRATIVE.includes(s.narrativeStatus)) return { kind: "done", outputRefs: [] };
      const due = effectiveDue(s, await svc.arcEnds(scope, tx));
      if (due == null || due >= p.asOf) return { kind: "done", outputRefs: [] }; // changed meanwhile
      const extendTo = Math.max(p.review.extend_to_episode_no ?? p.asOf + 3, p.asOf + 1);
      const assignTo = Math.max(p.review.assign_episode_no ?? p.asOf + 1, p.asOf + 1);
      const label = `${formatSetupNo(s.displayNo)} "${s.title}"`;
      const rec = p.review.recommendation;
      const { questionId } = await deps.hitl.createQuestion(
        tx,
        scope,
        {
          topic: "setup_due",
          questionType: "single_choice",
          title: `떡밥 ${label}의 회수 기한이 지났습니다`,
          body:
            p.review.body ??
            `떡밥 ${label}은(는) ${due}화까지 회수할 예정이었지만 ${p.asOf}화까지 회수되지 않았습니다. 어떻게 처리할지 정해 주세요.`,
          options: [
            { label: `기한을 ${extendTo}화로 연장`, value: { kind: "extend", to_due_episode_no: extendTo, setup_id: s.id }, isRecommended: rec === "extend" },
            { label: `${assignTo}화에서 회수`, value: { kind: "assign", episode_no: assignTo, setup_id: s.id }, isRecommended: rec === "assign" },
            { label: "떡밥 폐기(승인 필요)", value: { kind: "abandon", setup_id: s.id }, isRecommended: rec === "abandon" },
          ],
          recommendation: {
            optionValue: rec === "assign" ? { kind: "assign", episode_no: assignTo, setup_id: s.id } : rec === "abandon" ? { kind: "abandon", setup_id: s.id } : { kind: "extend", to_due_episode_no: extendTo, setup_id: s.id },
            // INV-Q-04: abandonment is never applied by default
            defaultAction: rec === "abandon" ? "hold" : "apply",
            rationale: p.review.rationale || "기한 초과 떡밥을 처리해야 합니다.",
          },
          rationale: p.review.rationale,
          links: [{ type: "setup", id: s.id }],
          proposedBlockingBasis: s.importance === "high" ? "setup_due_high" : "none",
        },
        { createdBy: agentActor(run), taskId: run.taskId, runId: run.runId },
      );
      return { kind: "done", outputRefs: [{ refType: "question", refId: questionId }] };
    },
  };
}
