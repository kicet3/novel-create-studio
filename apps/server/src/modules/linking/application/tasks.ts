/**
 * Task kinds of `linking` (04 §2.2, 07 §4, 07 B2): extract_facts (P3b+P3c), link_mentions, dedupe_entities,
 * build_initial_ontology. LLM tasks are wrapped with agents.defineAgentTask; dedupe is deterministic.
 */
import { z } from "zod";
import { defaultValue } from "@ncs/shared";
import { NotImplementedError, actors, type ActorRef, type Logger, type NovelScope, type Tx } from "../../../platform/index.js";
import { callWithRepair, summarizeIssues, type AgentTaskHandler, type AgentsService, type ContextBuilder, type ContextPack } from "../../agents/index.js";
import type { HitlService } from "../../hitl/index.js";
import type { LlmService } from "../../llm/index.js";
import type { NovelService } from "../../novel/index.js";
import { lookupPredicate, mapPredicateLabel, normalizedKey, type CandidateFactDraft, type OntologyService, type StoryAnchor } from "../../ontology/index.js";
import { TaskFailure, type CommitOutcome, type OrchestrationService, type RunHandle, type Task, type TaskKindHandler } from "../../orchestration/index.js";
import type { LinkerInputMention, LinkerResult, SceneSource, SceneText } from "../index.js";
import { extractionResultSchema, initialOntologySchema, type ExtractionResult, type InitialOntology } from "../domain/schemas.js";
import { dictionaryMentions, excerpt, parseBibleContent } from "../domain/text.js";
import { checkExtraction, normalizeEntityType } from "../domain/extraction-check.js";
import { commitLinkerResult, disambiguationDraft, duplicateDraft, tryCreateQuestion } from "./commit.js";
import { runLinker } from "./linker.js";

export interface TaskDeps {
  ontology: OntologyService;
  llm: LlmService;
  hitl: HitlService;
  novel: NovelService;
  agents: AgentsService;
  orchestration: OrchestrationService;
  sceneSources: SceneSource[];
  log?: Logger;
}

const EMPTY_PACK: ContextPack = { snapshotId: "", system: "", messages: [], handles: { entities: [], names: [] }, tokenEstimate: 0, droppedSections: [] };

async function safeContext(builder: ContextBuilder, run: RunHandle, anchor: StoryAnchor, extra: Partial<Parameters<ContextBuilder["build"]>[1]> = {}): Promise<ContextPack> {
  try {
    return await builder.build(run, {
      anchor,
      seeds: { entityIds: [], setupIds: [], answerIds: [], mentionIds: [] },
      sections: ["instruction", "entity_cards", "unresolved_surfaces"],
      maxInputTokens: 20_000,
      hopPredicates: { hop2: [] },
      ...extra,
    });
  } catch (err) {
    if (err instanceof NotImplementedError) return EMPTY_PACK;
    throw err;
  }
}

/** agents.defineAgentTask when available; minimal local adapter otherwise (placeholder agents) */
export function defineTask<I, P>(deps: TaskDeps, h: AgentTaskHandler<I, P>): TaskKindHandler<I, unknown> {
  try {
    return deps.agents.defineAgentTask(h) as TaskKindHandler<I, unknown>;
  } catch (err) {
    if (!(err instanceof NotImplementedError)) throw err;
    return {
      kind: h.kind,
      role: h.role,
      promptTemplateVersion: h.promptTemplateVersion,
      inputSchema: h.inputSchema,
      gate: h.gate,
      async execute(ctx) {
        return { proposal: await h.execute(ctx.run, ctx.input, EMPTY_PACK, deps.llm.modelCalls) };
      },
      async commit(tx, ctx, p) {
        return h.commit(tx, ctx.run, ctx.input, (p as { proposal: P }).proposal, ctx.task);
      },
    };
  }
}

const agentActor = (run: RunHandle): ActorRef => actors.agent("world_keeper", run.runId);

// ── extract_facts ────────────────────────────────────────────────────────
const sceneTextSchema = z.object({
  sceneId: z.string(),
  sceneOrd: z.number().int(),
  storyPoint: z.number().int(),
  timelineId: z.string(),
  text: z.string(),
  charOffset: z.number().int().default(0),
  povEntityId: z.string().nullable().optional(),
  narrationMode: z.enum(["first_person", "third_limited", "third_omniscient"]).nullable().optional(),
  participantEntityIds: z.array(z.string()).optional(),
});
export const extractFactsInputSchema = z.object({
  episode_id: z.string(),
  manuscript_version_id: z.string(),
  /** optional inline scenes (else the registered SceneSource is used) */
  scenes: z.array(sceneTextSchema).optional(),
});
type ExtractInput = z.infer<typeof extractFactsInputSchema>;

interface ExtractProposal {
  linker: LinkerResult;
  extraction: ExtractionResult;
  scenes: Array<Pick<SceneText, "sceneId" | "sceneOrd" | "storyPoint" | "timelineId">>;
  excerpts: Record<number, string>;
  dropped: number;
}

async function loadScenes(deps: TaskDeps, scope: NovelScope, input: ExtractInput): Promise<SceneText[]> {
  if (input.scenes?.length) return input.scenes.map((s) => ({ ...s, charOffset: s.charOffset ?? 0 }));
  for (const src of deps.sceneSources) {
    const s = await src.getScenes(scope, { episodeId: input.episode_id, manuscriptVersionId: input.manuscript_version_id });
    if (s.length) return s;
  }
  return []; // no SceneSource registered yet (manuscript integration pending): extraction is skipped, the chain continues
}

/** P3c → P3d/P3e chain (07 §2.2): link_mentions after extract_facts, continuity/setup checks after link_mentions */
async function followUps(deps: TaskDeps, tx: Tx, scope: NovelScope, task: Task, kinds: Array<"link_mentions" | "check_continuity" | "check_setups">, input: { episode_id?: string; manuscript_version_id?: string | null; fact_ids?: string[] }, actor: ActorRef) {
  if (!input.episode_id || !input.manuscript_version_id) return;
  for (const kind of kinds) {
    if (!deps.orchestration.getTaskKind(kind)) continue;
    await deps.orchestration.createTask(tx, scope, {
      kind,
      targetType: "episode",
      targetId: input.episode_id,
      episodeId: input.episode_id,
      arcId: task.arcId ?? null,
      input: {
        episode_id: input.episode_id,
        manuscript_version_id: input.manuscript_version_id,
        cycle_key: input.manuscript_version_id,
        ...(input.fact_ids ? { fact_ids: input.fact_ids } : {}),
      },
      cycleKey: input.manuscript_version_id,
      createdBy: actor,
      parentTaskId: task.id,
      priority: 700,
    });
  }
}

/** below this share of located mentions the answer is unusable → invalid_output (else unlocated ones are dropped) */
const MIN_LOCATED_RATIO = 0.5;

const EXTRACT_SYSTEM = [
  "원고의 <scene> 안 본문에서 엔티티 언급(L0)과 새로 드러난 사실을 추출합니다. 엔티티 ID를 정하지 말고, 사실의 주어·목적어는 언급 local_key로만 가리킵니다. predicate는 스키마 키(관계·속성)를 씁니다.",
  "언급 규칙:",
  "- surface: 원문에 적힌 표기를 글자 그대로 씁니다(조사·따옴표 제외). 고치거나 줄이거나 지어내지 않습니다.",
  "- quote: 그 언급을 포함한 원문 그대로의 짧은 구절(10~40자, 한 줄)입니다. 서버는 quote로 위치를 찾으므로 같은 이름이 여러 번 나오면 어느 것인지 알 수 있게 앞뒤 문맥을 넣습니다.",
  "- char_start/char_end는 선택 힌트입니다. 씬 본문 첫 글자를 0으로 세며, 본문이 줄바꿈으로 시작하면 그 줄바꿈도 1자로 셉니다. 정확히 셀 수 없으면 비워 둡니다.",
  "- scene_ord는 언급이 실제로 있는 씬의 ord입니다.",
  "- 사실의 주어·목적어가 되는 언급과 각 씬에 처음 등장하는 인물·장소·조직 언급은 빠짐없이 냅니다.",
].join("\n");

function extractionPrompt(scenes: SceneText[], known: Array<{ surface: string; entityType: string }> = [], entityTypes: string[] = []): string {
  const names = [...new Map(known.map((k) => [k.surface, k])).values()].slice(0, 200);
  const dict = names.length ? `<known_entities>\n${names.map((k) => `- ${k.surface} | ${k.entityType}`).join("\n")}\n</known_entities>\n\n` : "";
  return dict + (entityTypes.length ? `<entity_types>${entityTypes.join(", ")}</entity_types>\n(entity_type_hint는 이 키 중 하나만 씁니다.)\n\n` : "") + scenes.map((s) => `<scene ord="${s.sceneOrd}" story_point="${s.storyPoint}" chars="${s.text.length}">\n${s.text}\n</scene>`).join("\n\n");
}

export function extractFactsHandler(deps: TaskDeps): AgentTaskHandler<ExtractInput, ExtractProposal> {
  return {
    kind: "extract_facts",
    role: "world_keeper",
    promptTemplateVersion: "world_keeper.extract_facts@0.1.0",
    inputSchema: extractFactsInputSchema,
    allowedWrites: ["ontology.writeMentions", "ontology.writeCandidateFacts", "ontology.createEntity", "hitl.createQuestion"],
    async buildContext(run, input, builder) {
      const tl = await deps.ontology.getDefaultTimeline({ novelId: run.novelId });
      return safeContext(builder, run, { storyPoint: 0, timelineId: tl.id }, { episodeId: input.episode_id, manuscriptVersionId: input.manuscript_version_id });
    },
    async execute(run, input, context, llm) {
      const scope = { novelId: run.novelId };
      const scenes = await loadScenes(deps, scope, input);
      if (scenes.length === 0) {
        return { linker: { mentions: [], questionsNeeded: [], linkerVersion: "none" }, extraction: extractionResultSchema.parse({}), scenes: [], excerpts: {}, dropped: 0 };
      }
      // dictionary of known names (L0 supplement below; also listed to the model so it reuses the canonical surfaces)
      const dict = (await deps.ontology.listEntities(scope, { statuses: ["candidate", "active"], limit: 500 })).map((e) => e.entity);
      const dictNames: Array<{ surface: string; nameKind: string; entityType: string }> = [];
      for (const e of dict) for (const n of await deps.ontology.listEntityNames(scope, e.id)) if (n.status !== "retired" && n.nameKind !== "hidden_variant") dictNames.push({ surface: n.surface, nameKind: n.nameKind, entityType: e.entityType });
      // P3b: LLM extraction (L0). The server locates every mention (surface + quote; offsets are hints). Mentions it
      // cannot place go back to the producer as a validator critique in the same conversation (agent-to-agent repair).
      const entityTypes = new Set((await deps.ontology.getSchema(scope)).schema.entityTypes.filter((t) => t.enabled).map((t) => t.key as string));
      const check = (value: ExtractionResult) => {
        const c = checkExtraction(scenes, value, { entityTypes });
        return { result: c, issues: c.issues };
      };
      const repaired = await callWithRepair({
        llm,
        request: {
          run,
          purpose: "extract_facts",
          system: `${context.system ? `${context.system}\n\n` : ""}${EXTRACT_SYSTEM}`,
          messages: [...context.messages, { role: "user", content: extractionPrompt(scenes, dictNames, [...entityTypes]) }],
          output: { kind: "object", schemaName: "linking_extraction", schema: extractionResultSchema },
        },
        validate: check,
        label: "언급 위치 검증",
        instruction: "각 항목을 원문에 적힌 그대로의 surface와, 그 언급을 포함한 원문 그대로의 quote(10~40자, 한 줄)로 다시 지정하거나, 원문에 없는 언급이면 빼세요.",
      });
      const extraction = repaired.value;
      const checked = repaired.result;
      // deterministic check (07 §4.3): unlocated mentions are dropped one by one; only a mostly-unusable answer fails
      const dropped = checked.unlocated.length;
      run.noteOutputSummary?.("mentionCheck", { ...checked.stats, repairRounds: repaired.rounds });
      if (dropped > 0) deps.log?.info({ runId: run.runId, dropped, total: extraction.mentions.length, rounds: repaired.rounds, issues: repaired.issues.slice(0, 5).map((i) => i.item) }, "extract_facts: unlocated mentions dropped");
      if (extraction.mentions.length > 0 && checked.located.length / extraction.mentions.length < MIN_LOCATED_RATIO) {
        throw new TaskFailure("invalid_output", `언급 위치가 원문과 맞지 않는 비율이 높습니다(${dropped}/${extraction.mentions.length}, 에이전트 간 수정 대화 ${repaired.rounds}회 후). ${summarizeIssues("언급 위치 검증", repaired.issues)}`, true);
      }
      const sceneByOrd = new Map(scenes.map((s) => [s.sceneOrd, s]));
      const mentions: LinkerInputMention[] = [];
      const excerpts: Record<number, string> = {};
      const taken = new Map<number, Array<[number, number]>>();
      for (const loc of checked.located) {
        const m = extraction.mentions[loc.index]!;
        const sc = sceneByOrd.get(loc.sceneOrd)!;
        taken.set(sc.sceneOrd, [...(taken.get(sc.sceneOrd) ?? []), [loc.start, loc.end]]);
        excerpts[mentions.length] = excerpt(sc.text, loc.start, loc.end);
        mentions.push({
          surface: loc.surface,
          charStart: sc.charOffset + loc.start,
          charEnd: sc.charOffset + loc.end,
          sceneId: sc.sceneId,
          storyPoint: sc.storyPoint,
          mentionKind: m.mention_kind,
          chainKey: m.chain_key ?? null,
          povEntityId: sc.povEntityId ?? null,
          localKey: m.local_key,
          // unknown types left after the dialogue → no hint (never an entity of a type the schema lacks)
          entityTypeHint: normalizeEntityType(m.entity_type_hint, entityTypes) || null,
          sceneParticipantEntityIds: sc.participantEntityIds,
          excerpt: excerpts[mentions.length - 1],
        });
      }
      for (const sc of scenes) {
        for (const hit of dictionaryMentions(sc.text, dictNames)) {
          if ((taken.get(sc.sceneOrd) ?? []).some(([a, b]) => hit.start < b && hit.end > a)) continue;
          excerpts[mentions.length] = excerpt(sc.text, hit.start, hit.end);
          mentions.push({ surface: hit.surface, charStart: sc.charOffset + hit.start, charEnd: sc.charOffset + hit.end, sceneId: sc.sceneId, storyPoint: sc.storyPoint, mentionKind: hit.mentionKind, povEntityId: sc.povEntityId ?? null, sceneParticipantEntityIds: sc.participantEntityIds, excerpt: excerpts[mentions.length - 1] });
        }
      }
      await run.checkpoint();
      // P3c: linker (L4 through the model port)
      const tl = scenes[0]!.timelineId;
      const linker = await runLinker({ ontology: deps.ontology, llm: deps.llm }, scope, { manuscriptVersionId: input.manuscript_version_id, anchor: { storyPoint: scenes[0]!.storyPoint, timelineId: tl, povEntityId: scenes[0]!.povEntityId ?? undefined }, mentions, sourceKind: "manuscript" }, run);
      return { linker, extraction, scenes: scenes.map(({ sceneId, sceneOrd, storyPoint, timelineId }) => ({ sceneId, sceneOrd, storyPoint, timelineId })), excerpts, dropped };
    },
    async commit(tx, run, input, p, task) {
      const scope = { novelId: run.novelId };
      const actor = agentActor(run);
      const written = await commitLinkerResult({ ontology: deps.ontology, hitl: deps.hitl }, tx, scope, p.linker, actor, { taskId: task.id, runId: run.runId, excerpts: p.excerpts });
      const facts = await materializeFacts(deps, tx, scope, p, written.byLocalKey, input, actor);
      // identity assertions (06 §3.12 경로 B): two linked mentions, different entities → proposed merge + question
      for (const ia of p.extraction.identity_assertions) {
        const a = written.byLocalKey[ia.mention_key_a];
        const b = written.byLocalKey[ia.mention_key_b];
        if (!a?.entityId || !b?.entityId || a.entityId === b.entityId) continue;
        const dec = await deps.ontology.proposeIdentityDecision(tx, scope, { kind: "merge", entityIds: [a.entityId, b.entityId], survivorEntityId: a.entityId, rationale: ia.evidence ?? "원고 속 정체 공개", evidence: { identityAssertion: ia } }, actor);
        const qid = await tryCreateQuestion({ ontology: deps.ontology, hitl: deps.hitl }, tx, scope, await duplicateDraft({ ontology: deps.ontology, hitl: deps.hitl }, tx, scope, { newEntityId: b.entityId, existingId: a.entityId, decisionId: dec.id }), actor, { taskId: task.id, runId: run.runId });
        if (qid) await deps.ontology.setIdentityDecisionRefs(tx, scope, dec.id, { questionId: qid });
      }
      await followUps(deps, tx, scope, task, ["link_mentions"], { episode_id: input.episode_id, manuscript_version_id: input.manuscript_version_id, fact_ids: facts }, actor);
      return {
        kind: "done",
        outputRefs: [
          { refType: "manuscript_version", refId: input.manuscript_version_id },
          ...written.mentionIds.slice(0, 50).map((id) => ({ refType: "mention" as const, refId: id })),
          ...facts.slice(0, 50).map((id) => ({ refType: "fact" as const, refId: id })),
          ...written.questionIds.map((id) => ({ refType: "question" as const, refId: id })),
        ],
      } satisfies CommitOutcome;
    },
  };
}

/** 07 §4.1 사실 물질화: mention → entity (ambiguous → NULL + arg_mentions), predicate mapping, unmapped → proposal */
async function materializeFacts(
  deps: TaskDeps,
  tx: Tx,
  scope: NovelScope,
  p: ExtractProposal,
  byKey: Record<string, { mentionId: string; entityId: string | null; status: string; viaNameId: string | null }>,
  input: ExtractInput,
  actor: ActorRef,
): Promise<string[]> {
  const { schema } = await deps.ontology.getSchema(scope, tx);
  const drafts: CandidateFactDraft[] = [];
  for (const f of p.extraction.facts) {
    const subj = byKey[f.subject_mention_key];
    if (!subj || subj.status === "rejected") continue;
    let obj = f.object_mention_key ? byKey[f.object_mention_key] : undefined;
    if (f.object_mention_key && (!obj || obj.status === "rejected")) continue;
    let mapped = lookupPredicate(schema, f.predicate) ? { key: f.predicate, inverted: false } : mapPredicateLabel(schema, f.predicate);
    if (!mapped) {
      await deps.ontology.proposeSchemaChange(tx, scope, { label: f.predicate, examples: [{ manuscriptVersionId: input.manuscript_version_id, factKey: f.local_key }] }, actor);
      continue;
    }
    let s = subj;
    if (mapped.inverted && obj) [s, obj] = [obj, s];
    if (f.scope_hint === "flashback") continue; // frame target unknown → not stored in MVP-α (06 §3.5)
    const [mentionRow] = await deps.ontology.listMentions(scope, { ids: [subj.mentionId] }, tx);
    const sc = mentionRow?.sceneId ? p.scenes.find((x) => x.sceneId === mentionRow.sceneId) : undefined;
    const point = sc?.storyPoint ?? mentionRow?.storyPoint ?? 0;
    const def = lookupPredicate(schema, mapped.key)!;
    drafts.push({
      factKind: f.fact_kind === "knowledge" || def.kind === "attribute" ? f.fact_kind : (def.def as { factKind: CandidateFactDraft["factKind"] }).factKind,
      subjectEntityId: s.entityId as string,
      predicate: mapped.key,
      objectEntityId: obj ? obj.entityId : null,
      value: obj ? undefined : f.value,
      knowledgeStance: f.knowledge_stance ?? null,
      isSecret: f.is_secret ?? false,
      timelineId: mentionRow?.timelineId ?? p.scenes[0]!.timelineId,
      storyRange: f.scope_hint === "point" ? { from: point, to: point + 1 } : { from: point, to: null },
      sourceKind: "manuscript",
      source: { refType: "manuscript_version", refId: input.manuscript_version_id },
      sourceSceneId: mentionRow?.sceneId ?? null,
      mentionIds: [s.mentionId, ...(obj ? [obj.mentionId] : [])],
      argMentions: { subject: s.mentionId, object: obj?.mentionId ?? null },
      episodeId: input.episode_id,
      observedAsNameId: s.viaNameId,
    });
  }
  if (drafts.length === 0) return [];
  const r = await deps.ontology.writeCandidateFacts(tx, scope, drafts, actor);
  return r.written.map((w) => w.factId);
}

// ── link_mentions ────────────────────────────────────────────────────────
export const linkMentionsInputSchema = z.object({
  episode_id: z.string().optional(),
  /** facts written by the preceding extract_facts (forwarded to check_continuity for schema violations) */
  fact_ids: z.array(z.string()).optional(),
  manuscript_version_id: z.string().nullable().optional(),
  answer_id: z.string().nullable().optional(),
  source_kind: z.enum(["manuscript", "answer", "user_input", "series_bible", "import"]).optional(),
  anchor: z.object({ story_point: z.number().int(), timeline_id: z.string().optional(), pov_entity_id: z.string().nullable().optional() }).optional(),
  mentions: z
    .array(
      z.object({
        surface: z.string(),
        char_start: z.number().int().default(0),
        char_end: z.number().int().default(0),
        scene_id: z.string().default(""),
        story_point: z.number().int(),
        mention_kind: z.enum(["named", "title", "address", "pronoun", "zero", "descriptive"]).optional(),
        speaker_entity_id: z.string().nullable().optional(),
        chain_key: z.string().nullable().optional(),
        hint_entity_id: z.string().nullable().optional(),
      }),
    )
    .optional(),
});
type LinkInput = z.infer<typeof linkMentionsInputSchema>;

interface LinkProposal {
  linker: LinkerResult | null;
  /** ambiguous mentions of the version still without a question (re-ask after hitl outage / cap) */
  pendingMentionIds: string[];
}

export function linkMentionsHandler(deps: TaskDeps): AgentTaskHandler<LinkInput, LinkProposal> {
  return {
    kind: "link_mentions",
    role: "world_keeper",
    promptTemplateVersion: "world_keeper.link_mentions@0.1.0",
    inputSchema: linkMentionsInputSchema,
    allowedWrites: ["ontology.writeMentions", "ontology.createEntity", "hitl.createQuestion"],
    async buildContext(run, input, builder) {
      const tl = input.anchor?.timeline_id ?? (await deps.ontology.getDefaultTimeline({ novelId: run.novelId })).id;
      return safeContext(builder, run, { storyPoint: input.anchor?.story_point ?? 0, timelineId: tl });
    },
    async execute(run, input) {
      const scope = { novelId: run.novelId };
      if (input.mentions?.length) {
        const tl = input.anchor?.timeline_id ?? (await deps.ontology.getDefaultTimeline(scope)).id;
        const anchor: StoryAnchor = { storyPoint: input.anchor?.story_point ?? input.mentions[0]!.story_point, timelineId: tl, povEntityId: input.anchor?.pov_entity_id ?? undefined };
        const linker = await runLinker(
          { ontology: deps.ontology, llm: deps.llm },
          scope,
          {
            manuscriptVersionId: input.manuscript_version_id ?? null,
            anchor,
            sourceKind: input.source_kind,
            answerId: input.answer_id ?? null,
            mentions: input.mentions.map((m) => ({ surface: m.surface, charStart: m.char_start, charEnd: m.char_end, sceneId: m.scene_id, storyPoint: m.story_point, mentionKind: m.mention_kind, speakerEntityId: m.speaker_entity_id ?? null, chainKey: m.chain_key ?? null, hintEntityId: m.hint_entity_id ?? null })),
          },
          run,
        );
        return { linker, pendingMentionIds: [] };
      }
      const pending = input.manuscript_version_id ? await deps.ontology.listMentions(scope, { manuscriptVersionId: input.manuscript_version_id, linkStatus: ["ambiguous"] }) : [];
      return { linker: null, pendingMentionIds: pending.filter((m) => !m.questionId && m.mentionKind !== "zero").map((m) => m.id) };
    },
    async commit(tx, run, _input, p, task) {
      const scope = { novelId: run.novelId };
      const actor = agentActor(run);
      const cd = { ontology: deps.ontology, hitl: deps.hitl };
      const refs: Array<{ refType: "mention" | "question"; refId: string }> = [];
      if (p.linker) {
        const w = await commitLinkerResult(cd, tx, scope, p.linker, actor, { taskId: task.id, runId: run.runId });
        refs.push(...w.mentionIds.map((id) => ({ refType: "mention" as const, refId: id })), ...w.questionIds.map((id) => ({ refType: "question" as const, refId: id })));
      }
      if (p.pendingMentionIds.length) {
        const ms = (await deps.ontology.listMentions(scope, { ids: p.pendingMentionIds }, tx)).filter((m) => m.linkStatus === "ambiguous" && !m.questionId);
        const groups = new Map<string, typeof ms>();
        for (const m of ms) {
          const k = `${m.sceneId}|${m.chainKey ?? ""}|${normalizedKey(m.surface)}|${JSON.stringify(m.candidates)}`;
          groups.set(k, [...(groups.get(k) ?? []), m]);
        }
        for (const g of groups.values()) {
          const draft = await disambiguationDraft(cd, tx, scope, g.map((m) => ({ id: m.id, surface: m.surface, mentionKind: m.mentionKind, storyPoint: m.storyPoint, candidates: (m.candidates ?? []) as Array<{ entityId: string; score: number }> })));
          const qid = await tryCreateQuestion(cd, tx, scope, draft, actor, { taskId: task.id, runId: run.runId });
          if (!qid) continue;
          await deps.ontology.setMentionQuestion(tx, scope, g.map((m) => m.id), qid);
          refs.push({ refType: "question", refId: qid });
        }
      }
      await followUps(deps, tx, scope, task, ["check_continuity", "check_setups"], { episode_id: _input.episode_id, manuscript_version_id: _input.manuscript_version_id, fact_ids: _input.fact_ids }, actor);
      return { kind: "done", outputRefs: refs };
    },
  };
}

// ── dedupe_entities (deterministic) ──────────────────────────────────────
export const dedupeInputSchema = z.object({ entity_id: z.string().optional(), min_score: z.number().min(0).max(1).optional() });
type DedupeInput = z.infer<typeof dedupeInputSchema>;

export function dedupeHandler(deps: TaskDeps): TaskKindHandler<DedupeInput, Array<{ entityIds: [string, string]; score: number; reason: string }>> {
  return {
    kind: "dedupe_entities",
    role: "world_keeper",
    promptTemplateVersion: "code.dedupe_entities@0.1.0",
    inputSchema: dedupeInputSchema,
    async execute(ctx) {
      const min = ctx.input.min_score ?? defaultValue("dedup.similar_entity_min_score");
      return (await deps.ontology.findDuplicateCandidates(ctx.scope, ctx.input.entity_id)).filter((c) => c.score >= min);
    },
    async commit(tx, ctx, pairs) {
      const actor = agentActor(ctx.run);
      const open = await deps.ontology.listIdentityDecisions(ctx.scope, { statuses: ["proposed"] }, tx);
      const refs: Array<{ refType: "identity_decision" | "question"; refId: string }> = [];
      for (const pr of pairs) {
        if (open.some((d) => d.kind === "merge" && pr.entityIds.every((id) => d.sourceEntityIds.includes(id)))) continue;
        const ents = await deps.ontology.getEntities(ctx.scope, pr.entityIds, tx);
        if (ents.length < 2 || ents.some((e) => e.status === "merged" || e.status === "retired")) continue;
        // survivor: the active / older one (P-4: no automatic merge — only a proposal + question)
        const [a, b] = [...ents].sort((x, y) => (x.status === "active" ? 0 : 1) - (y.status === "active" ? 0 : 1) || x.createdAt.getTime() - y.createdAt.getTime());
        const dec = await deps.ontology.proposeIdentityDecision(tx, ctx.scope, { kind: "merge", entityIds: [a!.id, b!.id], survivorEntityId: a!.id, rationale: `중복 의심(${pr.reason})`, evidence: { score: pr.score } }, actor);
        refs.push({ refType: "identity_decision", refId: dec.id });
        const qid = await tryCreateQuestion({ ontology: deps.ontology, hitl: deps.hitl }, tx, ctx.scope, await duplicateDraft({ ontology: deps.ontology, hitl: deps.hitl }, tx, ctx.scope, { newEntityId: b!.id, existingId: a!.id, decisionId: dec.id, score: pr.score }), actor, { taskId: ctx.task.id, runId: ctx.run.runId });
        if (qid) {
          await deps.ontology.setIdentityDecisionRefs(tx, ctx.scope, dec.id, { questionId: qid });
          refs.push({ refType: "question", refId: qid });
        }
      }
      return { kind: "done", outputRefs: refs };
    },
  };
}

// ── build_initial_ontology (07 B2) ───────────────────────────────────────
export const buildInitialOntologyInputSchema = z.object({ series_bible_id: z.string() });
type BuildInput = z.infer<typeof buildInitialOntologyInputSchema>;

export function buildInitialOntologyHandler(deps: TaskDeps): AgentTaskHandler<BuildInput, InitialOntology> {
  return {
    kind: "build_initial_ontology",
    role: "world_keeper",
    promptTemplateVersion: "world_keeper.build_initial_ontology@0.1.0",
    inputSchema: buildInitialOntologyInputSchema,
    allowedWrites: ["ontology.createEntity", "ontology.writeMentions", "ontology.writeCandidateFacts", "hitl.createQuestion"],
    async buildContext(run, _input, builder) {
      const tl = await deps.ontology.getDefaultTimeline({ novelId: run.novelId });
      return safeContext(builder, run, { storyPoint: 0, timelineId: tl.id });
    },
    async execute(run, input, context, llm) {
      const scope = { novelId: run.novelId };
      const bible = await deps.novel.getBible(scope, input.series_bible_id);
      const det = parseBibleContent(bible.content);
      let fromLlm: InitialOntology = { entities: [], facts: [] };
      try {
        const out = await llm.call({
          run,
          purpose: "build_initial_ontology",
          system: `${context.system ? `${context.system}\n\n` : ""}기획서에서 엔티티와 사실을 추출합니다. 기획서에 적힌 내용만 씁니다. predicate는 스키마 키를 씁니다.`,
          messages: [...context.messages, { role: "user", content: `<series_bible>\n${bible.contentMd}\n</series_bible>` }],
          output: { kind: "object", schemaName: "linking_initial_ontology", schema: initialOntologySchema },
        });
        const v = initialOntologySchema.safeParse(out.value);
        if (v.success) fromLlm = v.data;
      } catch (err) {
        if (!(err instanceof NotImplementedError)) throw err;
      }
      // deterministic entries first; LLM adds entities with new names only
      const names = new Set(det.entities.map((e) => `${e.entity_type}|${normalizedKey(e.name)}`));
      const keys = new Set(det.entities.map((e) => e.key));
      const extra = fromLlm.entities.filter((e) => !names.has(`${e.entity_type}|${normalizedKey(e.name)}`) && !keys.has(e.key));
      const extraKeys = new Set(extra.map((e) => e.key));
      return { entities: [...det.entities, ...extra], facts: [...det.facts, ...fromLlm.facts.filter((f) => extraKeys.has(f.subject_key))] };
    },
    async commit(tx, run, input, p) {
      return commitInitialOntology(deps, tx, { novelId: run.novelId }, input.series_bible_id, p, agentActor(run));
    },
  };
}

export async function commitInitialOntology(deps: TaskDeps, tx: Tx, scope: NovelScope, bibleId: string, p: InitialOntology, actor: ActorRef): Promise<CommitOutcome> {
  const { schema } = await deps.ontology.getSchema(scope, tx);
  const tl = await deps.ontology.getDefaultTimeline(scope, tx);
  const keyToEntity = new Map<string, string>();
  const created: string[] = [];
  const mentionDrafts: LinkerResult["mentions"] = [];
  const existing = (await deps.ontology.listEntities(scope, { statuses: ["candidate", "active"], limit: 500 }, tx)).map((x) => x.entity);
  const nameIndex = new Map<string, string[]>();
  for (const e of existing) for (const n of await deps.ontology.listEntityNames(scope, e.id, tx)) if (n.status !== "retired") nameIndex.set(`${e.entityType}|${n.normalizedKey}`, [...(nameIndex.get(`${e.entityType}|${n.normalizedKey}`) ?? []), e.id]);
  const cd = { ontology: deps.ontology, hitl: deps.hitl };
  const dupQuestions: string[] = [];
  for (const e of p.entities) {
    if (!schema.entityTypes.some((t) => t.key === e.entity_type && t.enabled)) continue;
    // 06 §3.14: same character_key → reuse (rename path), never a second entity
    const byKey = e.character_key ? existing.find((x) => x.conceptCharacterKey === e.character_key && x.status === "active") : undefined;
    const sameName = nameIndex.get(`${e.entity_type}|${normalizedKey(e.name)}`) ?? [];
    // 설계 추가(cast): a character confirmed in the cast step (active, user_input, concept key set) with the same
    // name is the same person — reuse it instead of opening a duplicate_entity question
    const byCastName =
      !byKey && e.entity_type === "character" ? existing.find((x) => sameName.includes(x.id) && x.status === "active" && x.conceptCharacterKey) : undefined;
    if (byCastName) {
      keyToEntity.set(e.key, byCastName.id);
      continue;
    }
    // 설계 추가(world): a world ontology entity (concept-approval step) with the same type + name is the same thing —
    // the bible's facts attach to it instead of opening a duplicate_entity question
    const byWorldName =
      !byKey && e.entity_type !== "character"
        ? existing.find((x) => sameName.includes(x.id) && (x.equivalenceCheck as { source?: string } | null)?.source === "world_ontology")
        : undefined;
    if (byWorldName) {
      keyToEntity.set(e.key, byWorldName.id);
      continue;
    }
    if (byKey) {
      keyToEntity.set(e.key, byKey.id);
      if (!sameName.includes(byKey.id)) await deps.ontology.addEntityName(tx, scope, byKey.id, { surface: e.name, nameKind: "true_name", status: "proposed", source: { kind: "series_bible", refType: "series_bible", refId: bibleId } }, actor);
      continue;
    }
    const r = await deps.ontology.createEntity(
      tx,
      scope,
      {
        entityType: e.entity_type as never,
        preferredName: { surface: e.name },
        status: "candidate",
        disambiguator: e.disambiguator ?? null,
        summary: e.summary ?? null,
        conceptCharacterKey: e.entity_type === "character" ? (e.character_key ?? null) : null,
        source: { kind: "series_bible", refType: "series_bible", refId: bibleId },
        names: e.aliases.filter((a) => normalizedKey(a) !== normalizedKey(e.name)).map((a) => ({ surface: a, nameKind: "alias" as const, status: "proposed" as const, source: { kind: "series_bible" as const, refType: "series_bible" as const, refId: bibleId } })),
      },
      actor,
    );
    keyToEntity.set(e.key, r.entity.id);
    created.push(r.entity.id);
    mentionDrafts.push({ sourceKind: "series_bible", storyPoint: 0, timelineId: tl.id, surface: e.name, mentionKind: "named", candidates: [{ entityId: r.entity.id, score: 1 }, ...sameName.map((id) => ({ entityId: id, score: 1 }))], linkedEntityId: r.entity.id, confidence: 1, linkStatus: "new_entity_candidate", linkerVersion: "bible@0.1.0", runId: actor.type === "agent" ? actor.runId : null });
    // 동명·유사 이름 → duplicate_entity question (06 §3.10); approval keeps it candidate until answered
    if (sameName.length > 0) {
      const dec = await deps.ontology.proposeIdentityDecision(tx, scope, { kind: "merge", entityIds: [sameName[0]!, r.entity.id], survivorEntityId: sameName[0]!, rationale: "기획서에 같은 이름의 엔티티가 있습니다" }, actor).catch(() => null);
      if (dec) {
        const qid = await tryCreateQuestion(cd, tx, scope, await duplicateDraft(cd, tx, scope, { newEntityId: r.entity.id, existingId: sameName[0]!, decisionId: dec.id }), actor, {});
        if (qid) {
          dupQuestions.push(qid);
          await deps.ontology.setIdentityDecisionRefs(tx, scope, dec.id, { questionId: qid });
        }
        await deps.ontology.setEquivalenceCheck(tx, scope, r.entity.id, { status: "question", duplicateOf: sameName[0]!, questionId: qid, seriesBibleId: bibleId } as never);
      }
    } else {
      await deps.ontology.setEquivalenceCheck(tx, scope, r.entity.id, { status: "passed", seriesBibleId: bibleId } as never);
    }
    nameIndex.set(`${e.entity_type}|${normalizedKey(e.name)}`, [...sameName, r.entity.id]);
  }
  if (mentionDrafts.length) await deps.ontology.writeMentions(tx, scope, mentionDrafts, actor);
  const drafts: CandidateFactDraft[] = [];
  for (const f of p.facts) {
    const subj = keyToEntity.get(f.subject_key);
    if (!subj) continue;
    let mapped = lookupPredicate(schema, f.predicate) ? { key: f.predicate, inverted: false } : mapPredicateLabel(schema, f.predicate);
    if (!mapped) {
      await deps.ontology.proposeSchemaChange(tx, scope, { label: f.predicate, examples: [{ seriesBibleId: bibleId, subject: f.subject_key }] }, actor);
      continue;
    }
    let s: string = subj;
    let o: string | null = f.object_key ? (keyToEntity.get(f.object_key) ?? null) : null;
    if (f.object_key && !o) continue;
    if (mapped.inverted && o) [s, o] = [o, s];
    const def = lookupPredicate(schema, mapped.key)!;
    drafts.push({
      factKind: def.kind === "attribute" ? def.def.factKind : def.def.factKind,
      subjectEntityId: s,
      predicate: mapped.key,
      objectEntityId: o,
      value: o ? undefined : f.value,
      timelineId: tl.id,
      storyRange: { from: f.from_story_point ?? 0, to: null },
      sourceKind: f.user_stated ? "user_input" : "series_bible",
      source: { refType: "series_bible", refId: bibleId },
      seriesBibleId: bibleId,
    });
  }
  const written = drafts.length ? await deps.ontology.writeCandidateFacts(tx, scope, drafts, actor) : { written: [], rejected: [] };
  // INV-BIB-03: B2 is created by the bible approval commit (04 §3 table), so its facts join that approval —
  // once the bible is approved, promote them here (same rule as approveBibleFacts in the approval transaction)
  if (written.written.length && (await deps.novel.getBible(scope, bibleId, tx)).status === "approved") {
    await deps.ontology.approveBibleFacts(tx, scope, bibleId, actor);
  }
  return {
    kind: "done",
    outputRefs: [
      { refType: "series_bible", refId: bibleId },
      ...created.map((id) => ({ refType: "entity" as const, refId: id })),
      ...written.written.slice(0, 50).map((w) => ({ refType: "fact" as const, refId: w.factId })),
      ...dupQuestions.map((id) => ({ refType: "question" as const, refId: id })),
    ],
  };
}

export type { Task };
