/**
 * 설계 추가 0026 (P3 / P5) for the linking outputs: an entity handle (E1, E2 …) is a reference mark of a context pack,
 * never a name and never part of a stored sentence. The linking tasks are not shown handle marks, so a handle token
 * in their output cannot be mapped to anyone: the producer is asked to repair it (`…HandleIssues`, for
 * agents.callWithRepair) and whatever is still there afterwards is dropped (`scrub…`), never stored.
 * Entity REFERENCE fields (mention local keys, bible keys) are left alone — they are resolved to ids.
 * `story` = the handle-looking tokens inside real names of the novel (agents.storyHandleTokens), the only exemption.
 */
import type { RepairIssueDto } from "@ncs/shared";
import { handleLeakIssue, isHandleShaped, leakedHandleTokens } from "../../agents/index.js";
import type { ExtractionResult, InitialOntology } from "../domain/schemas.js";

type Story = ReadonlySet<string>;
const tokensOf = (value: unknown, story: Story) => [...new Set(leakedHandleTokens(value, story).map((l) => l.token))];

const UNKNOWN_WHO = "누구인지 알 수 없으면 이 항목을 빼세요.";

/** extract_facts: the sentence parts of a fact (free value, predicate label) and of an identity assertion (evidence) */
function extractionLeaks(x: ExtractionResult, story: Story): { facts: Map<number, string[]>; evidence: Map<number, string[]> } {
  const facts = new Map<number, string[]>();
  const evidence = new Map<number, string[]>();
  x.facts.forEach((f, i) => {
    const t = tokensOf({ predicate: f.predicate, value: f.object_mention_key ? null : f.value }, story);
    if (t.length) facts.set(i, t);
  });
  x.identity_assertions.forEach((ia, i) => {
    const t = tokensOf(ia.evidence ?? null, story);
    if (t.length) evidence.set(i, t);
  });
  return { facts, evidence };
}

export function extractionHandleIssues(x: ExtractionResult, story: Story): RepairIssueDto[] {
  const { facts, evidence } = extractionLeaks(x, story);
  return [
    ...[...facts].map(([i, t]) => ({ item: `fact ${x.facts[i]!.local_key} value`, problem: `${handleLeakIssue(t)} ${UNKNOWN_WHO}` })),
    ...[...evidence].map(([i, t]) => ({ item: `identity_assertion ${x.identity_assertions[i]!.mention_key_a}/${x.identity_assertions[i]!.mention_key_b} evidence`, problem: handleLeakIssue(t) })),
  ];
}

/** what the repair dialogue left: such facts are dropped, such evidence is removed (the assertion itself stays) */
export function scrubExtraction(x: ExtractionResult, story: Story): { extraction: ExtractionResult; droppedFacts: string[]; clearedEvidence: number } {
  const { facts, evidence } = extractionLeaks(x, story);
  if (facts.size === 0 && evidence.size === 0) return { extraction: x, droppedFacts: [], clearedEvidence: 0 };
  return {
    extraction: {
      ...x,
      facts: x.facts.filter((_f, i) => !facts.has(i)),
      identity_assertions: x.identity_assertions.map((ia, i) => (evidence.has(i) ? { mention_key_a: ia.mention_key_a, mention_key_b: ia.mention_key_b } : ia)),
    },
    droppedFacts: [...facts.keys()].map((i) => x.facts[i]!.local_key),
    clearedEvidence: evidence.size,
  };
}

/** build_initial_ontology: names / aliases / summaries / free fact values of the model's answer */
export function initialOntologyHandleIssues(p: InitialOntology, story: Story): RepairIssueDto[] {
  const issues: RepairIssueDto[] = [];
  for (const e of p.entities) {
    if (isHandleShaped(e.name)) {
      issues.push({ item: `entity ${e.key} name`, problem: `'${e.name.trim()}'은(는) 이름이 아니라 기호입니다. 기획서에 적힌 실제 이름을 쓰거나, 이름을 알 수 없으면 이 엔티티를 빼세요.` });
      continue;
    }
    const t = tokensOf({ name: e.name, aliases: e.aliases, disambiguator: e.disambiguator ?? null, summary: e.summary ?? null }, story);
    if (t.length) issues.push({ item: `entity ${e.key} "${e.name}"`, problem: `${handleLeakIssue(t)} ${UNKNOWN_WHO}` });
  }
  p.facts.forEach((f) => {
    const t = tokensOf({ predicate: f.predicate, value: f.object_key ? null : f.value }, story);
    if (t.length) issues.push({ item: `fact ${f.subject_key} ${f.predicate} value`, problem: `${handleLeakIssue(t)} ${UNKNOWN_WHO}` });
  });
  return issues;
}

export interface OntologyScrub {
  ontology: InitialOntology;
  /** names of the entities that were dropped */
  droppedEntities: string[];
  droppedAliases: number;
  clearedSummaries: number;
  droppedFacts: number;
}

/**
 * What must not be stored of a bible ontology (deterministic parse + model answer): an entity whose name is a handle
 * or carries one, such aliases, such summaries / disambiguators, facts with such a value. A rule that lost its
 * sentence (summary) and has no fact left is an empty shell and goes too.
 */
export function scrubInitialOntology(p: InitialOntology, story: Story): OntologyScrub {
  const leaks = (v: unknown) => tokensOf(v, story).length > 0;
  const out: OntologyScrub = { ontology: p, droppedEntities: [], droppedAliases: 0, clearedSummaries: 0, droppedFacts: 0 };
  const gone = new Set<string>();
  const lostSummary = new Set<string>();
  let entities: InitialOntology["entities"] = [];
  for (const e of p.entities) {
    if (isHandleShaped(e.name) || leaks(e.name)) {
      gone.add(e.key);
      out.droppedEntities.push(e.name);
      continue;
    }
    const aliases = e.aliases.filter((a) => !isHandleShaped(a) && !leaks(a));
    out.droppedAliases += e.aliases.length - aliases.length;
    const badSummary = !!e.summary && leaks(e.summary);
    if (badSummary) {
      if (e.entity_type === "rule") lostSummary.add(e.key);
      out.clearedSummaries++;
    }
    entities.push({ ...e, aliases, summary: badSummary ? null : e.summary, disambiguator: e.disambiguator && leaks(e.disambiguator) ? null : e.disambiguator });
  }
  const facts = p.facts.filter((f) => !leaks({ predicate: f.predicate, value: f.object_key ? null : f.value }));
  const used = new Set(facts.flatMap((f) => [f.subject_key, f.object_key ?? ""]));
  entities = entities.filter((e) => {
    if (!lostSummary.has(e.key) || used.has(e.key)) return true;
    gone.add(e.key);
    out.droppedEntities.push(e.name);
    return false;
  });
  const kept = facts.filter((f) => !gone.has(f.subject_key) && !(f.object_key && gone.has(f.object_key)));
  out.droppedFacts = p.facts.length - kept.length;
  if (out.droppedEntities.length || out.droppedAliases || out.clearedSummaries || out.droppedFacts) out.ontology = { entities, facts: kept };
  return out;
}
