/**
 * Task kind `check_continuity` (07 §5.1 P3d, 06 §9): (1) deterministic prefilter over the ontology port
 * (identity leaks CR-08, schema violations CR-09~11, death state CR-01, answer constraints CR-13,
 * ability/world rules CR-06), (2) one continuity_editor LLM review that gives closed verdicts on the
 * candidates that need judgement and may report further canon conflicts citing fact handles,
 * (3) commit: reconcile issues of this episode (C1 dedupe / C4 reproduce / C3·C5·C8 not reproduced)
 * and advance the manuscript check gate.
 */
import { z, ZodError } from "zod";
import { DEFAULTS, type ContinuityIssueKind, type IssueFixScope, type IssueSeverity } from "@ncs/shared";
import { actors, type NovelScope } from "../../../platform/index.js";
import type { AgentTaskHandler, ContextPack } from "../../agents/index.js";
import type { LlmMessage } from "../../llm/index.js";
import type { FactAtAnchor, Mention } from "../../ontology/index.js";
import { TaskFailure, type RunHandle } from "../../orchestration/index.js";
import { adjustSeverity, continuityReviewSchema, dedupeKeyOf, RULES, type ContinuityReview } from "../domain/rules.js";
import { CHECK_CONTINUITY_KINDS } from "../domain/transitions.js";
import type { IssueEvidenceInput } from "../index.js";
import type { ContinuityInternals, IssueDraft } from "./continuity-service.js";
import { orPlaceholder, type ContinuityPorts } from "./ports.js";

export const CHECK_CONTINUITY_PROMPT_VERSION = "continuity_editor.check_continuity@0.1.0";
export const CONTINUITY_REVIEW_SCHEMA = "ContinuityReview";

export const checkContinuityInputSchema = z
  .object({
    episode_id: z.string(),
    manuscript_version_id: z.string().optional(),
    cycle_key: z.string().optional(),
    /** candidate facts written by extract/link for this version (schema-violation intake, CR-09~11) */
    fact_ids: z.array(z.string()).optional(),
  })
  .passthrough();
export type CheckContinuityInput = z.infer<typeof checkContinuityInputSchema>;

interface SceneInfo {
  id: string;
  ord: number;
  charStart: number;
  charEnd: number;
  storyPoint: number;
  timelineId: string;
  povEntityId: string | null;
}

/** deterministic finding before LLM confirmation */
export interface Candidate {
  id: string;
  ruleId: string;
  kind: ContinuityIssueKind;
  severity: IssueSeverity;
  needsLlm: boolean;
  message: string;
  fixScope: IssueFixScope;
  sceneId: string | null;
  charStart: number | null;
  charEnd: number | null;
  evidence: IssueEvidenceInput[];
  entityIds: string[];
  /** canon status of fact evidence (severity adjustment) */
  evidenceCanon: string[];
  /** text shown to the LLM */
  prompt: string;
}

export interface CheckContinuityProposal {
  episodeId: string;
  versionId: string;
  isHumanEdit: boolean;
  sceneIds: string[];
  drafts: IssueDraft[];
  skippedRules: string[];
  verdictCounts: { violation: number; notViolation: number; uncertain: number; llmIssues: number };
}

const LINKED = new Set(["auto_linked", "confirmed"]);

function factValueIs(f: FactAtAnchor, needle: string): boolean {
  const v = f.value as unknown;
  if (typeof v === "string") return v === needle;
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).some((x) => x === needle);
  return false;
}

function sceneOf(scenes: SceneInfo[], m: { sceneId: string | null; charStart: number | null }): SceneInfo | undefined {
  if (m.sceneId) return scenes.find((s) => s.id === m.sceneId);
  if (m.charStart != null) return scenes.find((s) => m.charStart! >= s.charStart && m.charStart! < s.charEnd);
  return undefined;
}

export function locate(content: string, scenes: SceneInfo[], quote?: string, sceneOrd?: number): { sceneId: string | null; charStart: number | null; charEnd: number | null } {
  if (quote) {
    const idx = content.indexOf(quote.trim());
    if (idx >= 0) {
      const s = scenes.find((x) => idx >= x.charStart && idx < x.charEnd);
      return { sceneId: s?.id ?? null, charStart: idx, charEnd: idx + quote.trim().length };
    }
  }
  const s = sceneOrd != null ? scenes.find((x) => x.ord === sceneOrd) : undefined;
  return s ? { sceneId: s.id, charStart: s.charStart, charEnd: s.charEnd } : { sceneId: null, charStart: null, charEnd: null };
}

export const CHECK_INSTRUCTION = `당신은 웹소설의 연속성 편집자(continuity_editor)입니다.
[CANDIDATE]마다 원고를 보고 verdict를 violation / not_violation / uncertain 중 하나로 정하세요(닫힌 판정).
- 회상·꿈·다른 시간선 장면, 시체 언급, 회상 대사는 사망 인물 규칙 위반이 아닙니다.
- violation이면 quote에 문제 문장을 원고에서 그대로 옮기고, proposed_fix와 fix_scope(span/scene/outline)를 적으세요.
그 밖에 [FACTS]의 캐논과 모순되는 서술(외형·나이·관계·장소 이동·능력 규칙·인물 지식)을 찾으면 issues에 넣고,
evidence에 근거 사실 핸들(F1, F2 …)을 1개 이상 적으세요. 근거 사실이 없는 의심은 넣지 마세요.
[작품 구성]의 결말·현재 부 목표·플롯 핵심 사건·이번 화 계획에서 벗어난 전개는 kind=plan_deviation, evidence ["PLAN"]으로 보고하세요(사실 핸들 불필요).`;

export function checkContinuityHandler(deps: ContinuityPorts, svc: ContinuityInternals): AgentTaskHandler<CheckContinuityInput, CheckContinuityProposal> {
  const log = deps.platform.log;
  const scopeOf = (run: RunHandle): NovelScope => ({ novelId: run.novelId });

  async function load(run: RunHandle, input: CheckContinuityInput) {
    const scope = scopeOf(run);
    const ep = await deps.manuscript.getEpisode(scope, input.episode_id);
    const versionId = input.manuscript_version_id ?? input.cycle_key ?? ep.currentVersionId;
    if (!versionId) throw new TaskFailure("internal", "검사할 원고 버전이 없습니다.", false);
    const version = await deps.manuscript.getVersion(scope, versionId);
    const scenes: SceneInfo[] = (await deps.manuscript.listScenes(scope, ep.id, { versionId })).map((s) => ({
      id: s.id,
      ord: s.ord,
      charStart: s.charStart,
      charEnd: s.charEnd,
      storyPoint: s.storyPoint,
      timelineId: s.timelineId,
      povEntityId: s.povEntityId,
    }));
    return { scope, ep, versionId, version, scenes };
  }

  async function prefilter(scope: NovelScope, ctx: Awaited<ReturnType<typeof load>>, input: CheckContinuityInput, skipped: string[]) {
    const { ep, versionId, scenes } = ctx;
    const timelineId = ep.primaryTimelineId;
    const anchorPoint = scenes[0]?.storyPoint ?? ep.episodeNo * 1000;
    const candidates: Candidate[] = [];
    let seq = 0;
    const nextId = () => `C${++seq}`;
    const skip = (r: string) => () => {
      if (!skipped.includes(r)) skipped.push(r);
    };

    const mentions: Mention[] = await orPlaceholder(() => deps.ontology.listMentions(scope, { manuscriptVersionId: versionId, limit: 5000 }), [], skip("mentions"));
    const linked = mentions.filter((m) => m.linkedEntityId && LINKED.has(m.linkStatus));
    const rawEntityIds = [...new Set(linked.map((m) => m.linkedEntityId!))];
    const resolved = rawEntityIds.length ? await orPlaceholder(() => deps.ontology.resolveEntityIds(scope, rawEntityIds), new Map<string, string>()) : new Map<string, string>();
    const rid = (id: string) => resolved.get(id) ?? id;
    const entityIds = [...new Set(rawEntityIds.map(rid))];

    // CR-08 identity leaks (Q4)
    const leaks = await orPlaceholder(() => deps.ontology.findIdentityLeaks(scope, versionId), [], skip("CR-08"));
    for (const l of leaks) {
      const m = mentions.find((x) => x.id === l.mentionId);
      const reader = l.viewer === "reader" || l.viewer === "narrator";
      const rule = RULES[reader ? "CR-08a" : "CR-08b"]!;
      const s = m ? sceneOf(scenes, m) : undefined;
      candidates.push({
        id: nextId(),
        ruleId: rule.id,
        kind: rule.kind,
        severity: rule.severity,
        needsLlm: rule.llm,
        message: l.message || rule.title,
        fixScope: "span",
        sceneId: m?.sceneId ?? s?.id ?? null,
        charStart: m?.charStart ?? null,
        charEnd: m?.charEnd ?? null,
        evidence: [{ mentionId: l.mentionId, nameId: l.nameId }],
        entityIds: m?.linkedEntityId ? [rid(m.linkedEntityId)] : [],
        evidenceCanon: [],
        prompt: `${rule.title}: "${m?.surface ?? "?"}" (${l.message})`,
      });
    }

    // CR-09~11 schema violations (intake from the deterministic validator)
    const violations = await orPlaceholder(() => deps.ontology.findSchemaViolations(scope, input.fact_ids), [], skip("CR-09~11"));
    for (const v of violations as Array<{ factId: string; rule: string; message: string; manuscriptVersionId?: string | null; sourceManuscriptVersionId?: string | null; severity?: IssueSeverity }>) {
      const src = v.manuscriptVersionId ?? v.sourceManuscriptVersionId;
      if (!input.fact_ids && src !== versionId) continue; // only this version's facts (without fact_ids the port must tell the source)
      const ruleId = /cardinal|개수/i.test(v.rule) ? "CR-09" : /time|temporal|시간/i.test(v.rule) ? "CR-11" : "CR-10";
      candidates.push({
        id: nextId(),
        ruleId,
        kind: "schema_violation",
        severity: v.severity ?? (/asym|irreflex|비대칭|비반사/i.test(v.rule) ? "medium" : "high"),
        needsLlm: false,
        message: v.message,
        fixScope: "span",
        sceneId: null,
        charStart: null,
        charEnd: null,
        evidence: [{ factId: v.factId, schemaRuleKey: v.rule }],
        entityIds: [],
        evidenceCanon: [],
        prompt: v.message,
      });
    }

    // canon facts of mentioned entities per scene (CR-01, CR-06) + general review facts
    const factsByScene = new Map<string, FactAtAnchor[]>();
    const allFacts = new Map<string, FactAtAnchor>();
    for (const s of scenes) {
      const ids = [...new Set(linked.filter((m) => sceneOf(scenes, m)?.id === s.id).map((m) => rid(m.linkedEntityId!)))];
      if (!ids.length) continue;
      const facts = await orPlaceholder(() => deps.ontology.getCanonAt(scope, ids, s.storyPoint, s.timelineId || timelineId), [], skip("canon"));
      factsByScene.set(s.id, facts);
      for (const f of facts) allFacts.set(f.factVersionId, f);
    }
    for (const s of scenes) {
      for (const f of factsByScene.get(s.id) ?? []) {
        // CR-01 death state (mentions inside narrative frames — flashback, dream — are excluded)
        if (f.predicate === "life_status" && factValueIs(f, "dead")) {
          const ms = linked.filter((m) => sceneOf(scenes, m)?.id === s.id && rid(m.linkedEntityId!) === f.subjectEntityId && !m.narrativeFrameId);
          if (ms.length) {
            const rule = RULES["CR-01"]!;
            candidates.push({
              id: nextId(),
              ruleId: rule.id,
              kind: rule.kind,
              severity: rule.severity,
              needsLlm: true,
              message: `사망한 인물 "${ms[0]!.surface}"이(가) ${s.ord}씬에 등장합니다.`,
              fixScope: "scene",
              sceneId: s.id,
              charStart: ms[0]!.charStart,
              charEnd: ms[0]!.charEnd,
              evidence: [{ factId: f.factId, factVersionId: f.factVersionId }, { mentionId: ms[0]!.id }],
              entityIds: [f.subjectEntityId],
              evidenceCanon: [f.canonStatus],
              prompt: `${rule.title}: 캐논 "${f.text}" — ${s.ord}씬 언급 "${ms.map((m) => m.surface).join(", ")}"`,
            });
          }
        }
        // CR-06 ability / world rules
        if (f.factKind === "rule" || f.predicate === "rule_statement" || f.predicate === "ability_limit") {
          const rule = RULES["CR-06"]!;
          candidates.push({
            id: nextId(),
            ruleId: rule.id,
            kind: rule.kind,
            severity: rule.severity,
            needsLlm: true,
            message: `${s.ord}씬이 규칙 "${f.text}"을(를) 어길 수 있습니다.`,
            fixScope: "span",
            sceneId: s.id,
            charStart: null,
            charEnd: null,
            evidence: [{ factId: f.factId, factVersionId: f.factVersionId }],
            entityIds: [f.subjectEntityId],
            evidenceCanon: [f.canonStatus],
            prompt: `${rule.title}: 규칙 "${f.text}" — ${s.ord}씬`,
          });
        }
      }
    }

    // CR-13 answer constraints in range of this episode
    if (entityIds.length) {
      const constraints = await orPlaceholder(
        () => deps.ontology.getConstraints(scope, { entityIds, answerIds: [], anchor: { storyPoint: anchorPoint, timelineId } }),
        [],
        skip("CR-13"),
      );
      for (const f of constraints) {
        const rule = RULES["CR-13"]!;
        candidates.push({
          id: nextId(),
          ruleId: rule.id,
          kind: rule.kind,
          severity: rule.severity,
          needsLlm: true,
          message: `답변 제약 "${f.text}"을(를) 어길 수 있습니다.`,
          fixScope: "scene",
          sceneId: null,
          charStart: null,
          charEnd: null,
          evidence: [{ factId: f.factId, factVersionId: f.factVersionId }],
          entityIds: [f.subjectEntityId],
          evidenceCanon: [f.canonStatus],
          prompt: `${rule.title}: "${f.text}"`,
        });
        allFacts.set(f.factVersionId, f);
      }
    }

    // POV knowledge (CR-07b input for the LLM)
    const povKnowledge: string[] = [];
    for (const pov of [...new Set(scenes.map((s) => s.povEntityId).filter((x): x is string => !!x))]) {
      const k = await orPlaceholder(() => deps.ontology.knowledgeOf(scope, pov, anchorPoint, timelineId), [], skip("CR-07"));
      if (k.length) povKnowledge.push(`- 시점 인물 ${pov}: ${k.map((f) => f.text).join(" / ")}`);
    }
    return { candidates, facts: [...allFacts.values()], povKnowledge, entityIds };
  }

  return {
    kind: "check_continuity",
    role: "continuity_editor",
    promptTemplateVersion: CHECK_CONTINUITY_PROMPT_VERSION,
    inputSchema: checkContinuityInputSchema,
    allowedWrites: ["continuity.openIssue", "continuity.transitionIssue", "manuscript.advanceCheckGate"],
    async buildContext(run, input, builder) {
      const scope = scopeOf(run);
      const ep = await deps.manuscript.getEpisode(scope, input.episode_id);
      const versionId = input.manuscript_version_id ?? input.cycle_key ?? ep.currentVersionId ?? undefined;
      return builder.build(run, {
        anchor: { storyPoint: ep.episodeNo * 1000, timelineId: ep.primaryTimelineId },
        seeds: { entityIds: [], setupIds: [], answerIds: [], mentionIds: [] },
        sections: ["instruction", "constraints", "story_plan", "entity_cards", "knowledge", "canon_1hop"],
        maxInputTokens: DEFAULTS["context.max_input_tokens.default"],
        hopPredicates: { hop2: [] },
        episodeId: ep.id,
        manuscriptVersionId: versionId,
      });
    },
    async execute(run, input, context: ContextPack, llm) {
      const ctx = await load(run, input);
      const scope = ctx.scope;
      const skippedRules: string[] = [];
      const { candidates, facts, povKnowledge } = await prefilter(scope, ctx, input, skippedRules);
      if (skippedRules.length) log.warn({ episodeId: ctx.ep.id, skippedRules }, "check_continuity: ontology port not implemented for some rules");

      const handles = new Map<string, FactAtAnchor>();
      facts.forEach((f, i) => handles.set(`F${i + 1}`, f));
      const sceneBlocks = ctx.scenes.length
        ? ctx.scenes.map((s) => `[SCENE ${s.ord}]\n${ctx.version.content.slice(s.charStart, s.charEnd)}\n[/SCENE]`)
        : [`[SCENE 1]\n${ctx.version.content}\n[/SCENE]`];
      const user = [
        `[EPISODE] no=${ctx.ep.episodeNo} version=${ctx.versionId}`,
        "[FACTS]",
        ...[...handles.entries()].map(([h, f]) => `${h}: ${f.text}${f.canonStatus === "candidate" ? " (미확정)" : ""}`),
        "[/FACTS]",
        povKnowledge.length ? `[POV_KNOWLEDGE]\n${povKnowledge.join("\n")}\n[/POV_KNOWLEDGE]` : "",
        ...candidates.filter((c) => c.needsLlm).map((c) => `[CANDIDATE] id=${c.id} rule=${c.ruleId} ${c.prompt}`),
        "",
        ...sceneBlocks,
      ]
        .filter((x) => x !== "")
        .join("\n");
      const messages: LlmMessage[] = [...context.messages, { role: "user", content: user }];
      const out = await llm.call({
        run,
        purpose: "check",
        system: [context.system, CHECK_INSTRUCTION].filter(Boolean).join("\n\n"),
        messages,
        output: { kind: "object", schemaName: CONTINUITY_REVIEW_SCHEMA, schema: continuityReviewSchema },
      });
      let review: ContinuityReview;
      try {
        review = continuityReviewSchema.parse(out.value);
      } catch (err) {
        if (err instanceof ZodError) throw new TaskFailure("invalid_output", "ContinuityReview 출력 형식이 올바르지 않습니다.", true);
        throw err;
      }

      const counts = { violation: 0, notViolation: 0, uncertain: 0, llmIssues: 0 };
      const drafts: IssueDraft[] = [];
      const toDraft = (c: Candidate, over: Partial<Candidate> & { suggestion?: string | null } = {}): IssueDraft => {
        const m = { ...c, ...over };
        const severity = adjustSeverity(m.kind, m.severity, m.evidenceCanon);
        // 06 §9: hash = rule + evidence FACT ids + (resolved) entity ids — mention ids change per version and stay out
        const ids = m.evidence.flatMap((e) => [e.factId ?? e.factVersionId, e.nameId, e.answerId].filter((x): x is string => !!x));
        // plan deviation: one issue per plot + scene position (scene ids change per version, the model's wording per run)
        if (m.kind === "plan_deviation") ids.push(`plan:${m.evidence[0]?.arcId ?? ""}:${ctx.scenes.find((x) => x.id === m.sceneId)?.ord ?? "ep"}`);
        return {
          kind: m.kind,
          severity,
          detector: m.kind === "schema_violation" ? "schema_validator" : m.kind === "identity_leak" && !m.needsLlm ? "linker" : "continuity_editor",
          episodeId: ctx.ep.id,
          manuscriptVersionId: ctx.versionId,
          sceneId: m.sceneId,
          charStart: m.charStart,
          charEnd: m.charEnd,
          message: m.message,
          suggestion: over.suggestion ?? null,
          fixScope: m.fixScope,
          evidence: m.evidence,
          detectedByRunId: run.runId,
          ruleId: m.ruleId,
          entityIds: m.entityIds,
          dedupeKey: dedupeKeyOf(ctx.ep.id, m.kind, m.ruleId, ids, m.entityIds),
        };
      };
      for (const c of candidates) {
        if (!c.needsLlm) {
          drafts.push(toDraft(c));
          continue;
        }
        const v = review.verdicts.find((x) => x.candidate_id === c.id);
        const verdict = v?.verdict ?? "uncertain"; // a candidate the model skipped is not silently passed
        if (verdict === "not_violation") {
          counts.notViolation++;
          continue;
        }
        const loc = v?.quote ? locate(ctx.version.content, ctx.scenes, v.quote) : null;
        if (verdict === "violation") counts.violation++;
        else counts.uncertain++;
        drafts.push(
          toDraft(c, {
            severity: verdict === "uncertain" ? (c.severity === "high" ? "medium" : c.severity) : c.severity,
            message: `${verdict === "uncertain" ? "(불확실) " : ""}${v?.message ?? c.message}`,
            fixScope: v?.fix_scope ?? c.fixScope,
            sceneId: loc?.sceneId ?? c.sceneId,
            charStart: loc?.charStart ?? c.charStart,
            charEnd: loc?.charEnd ?? c.charEnd,
            suggestion: v?.proposed_fix ?? null,
          }),
        );
      }
      for (const i of review.issues) {
        if (i.kind === "plan_deviation") {
          // 설계 추가: deviation from the story plan — the plot is the evidence; medium (gate not blocked), fixed in the outline
          const loc = locate(ctx.version.content, ctx.scenes, i.quote, i.scene_ord);
          counts.llmIssues++;
          const d = toDraft(
              {
                id: "LLM:plan_deviation",
                ruleId: "LLM:plan_deviation",
                kind: "plan_deviation",
                severity: "medium",
                needsLlm: true,
                message: i.message,
                fixScope: "outline",
                sceneId: loc.sceneId,
                charStart: loc.charStart,
                charEnd: loc.charEnd,
                evidence: [{ arcId: ctx.ep.arcId, quote: i.quote ?? null }],
                entityIds: [],
                evidenceCanon: [],
                prompt: "",
              },
              { suggestion: i.proposed_fix ?? null },
            );
          // several deviations reported for the same scene become one issue with every message
          const same = drafts.find((x) => x.dedupeKey === d.dedupeKey);
          if (same) same.message = `${same.message}\n${d.message}`.slice(0, 2000);
          else drafts.push(d);
          continue;
        }
        const ev = i.evidence.map((h) => handles.get(h.trim())).filter((f): f is FactAtAnchor => !!f);
        if (!ev.length) continue; // INV-CI-01: no canon evidence → not an issue
        const loc = locate(ctx.version.content, ctx.scenes, i.quote, i.scene_ord);
        counts.llmIssues++;
        const ruleId = `LLM:${i.kind}`;
        drafts.push(
          toDraft(
            {
              id: ruleId,
              ruleId,
              kind: i.kind,
              severity: i.severity,
              needsLlm: true,
              message: i.message,
              fixScope: i.fix_scope,
              sceneId: loc.sceneId,
              charStart: loc.charStart,
              charEnd: loc.charEnd,
              evidence: ev.map((f) => ({ factId: f.factId, factVersionId: f.factVersionId, quote: i.quote ?? null })),
              entityIds: [...new Set(ev.map((f) => f.subjectEntityId))],
              evidenceCanon: ev.map((f) => f.canonStatus),
              prompt: "",
            },
            { suggestion: i.proposed_fix ?? null },
          ),
        );
      }
      return {
        episodeId: ctx.ep.id,
        versionId: ctx.versionId,
        isHumanEdit: ctx.version.isHumanEdit,
        sceneIds: ctx.scenes.map((s) => s.id),
        drafts,
        skippedRules,
        verdictCounts: counts,
      };
    },
    async commit(tx, run, _input, p, task) {
      const scope = scopeOf(run);
      const actor = actors.agent("continuity_editor", run.runId);
      const r = await svc.reconcile(
        tx,
        scope,
        {
          episodeId: p.episodeId,
          manuscriptVersionId: p.versionId,
          drafts: p.drafts,
          kinds: CHECK_CONTINUITY_KINDS,
          sceneIds: p.sceneIds.length ? new Set(p.sceneIds) : null,
          isHumanEdit: p.isHumanEdit,
        },
        actor,
      );
      await orPlaceholder(() => deps.manuscript.advanceCheckGate(tx, scope, p.episodeId, { completedTaskId: task.id }), null);
      return { kind: "done", outputRefs: [...r.opened, ...r.relinked].map((id) => ({ refType: "continuity_issue" as const, refId: id })) };
    },
  };
}
