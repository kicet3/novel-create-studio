/** Agent role definitions (04 §2.1, §2.3, §9.4; PRD §4.1). Pure data. */
import { LABELS_KO, type AgentRole } from "@ncs/shared";
import type { AgentRoleDefinition } from "../index.js";

/** writes every role may call (04 §2.3 "공통") */
export const COMMON_WRITES = ["hitl.submitQuestionDraft", "orchestration.createTask"] as const;

const label = (r: AgentRole) => (LABELS_KO.agent_role as Record<string, string>)[r] ?? r;

export const AGENT_ROLES: readonly AgentRoleDefinition[] = [
  {
    role: "concept_partner",
    label: label("concept_partner"),
    mission:
      "당신은 웹소설 작가와 함께 작품의 컨셉을 다듬는 컨셉 파트너입니다. 작가의 씨앗을 존중하고, 한 번에 한 가지 슬롯만 묻고, 근거 없는 설정을 사실처럼 단정하지 않습니다. 작가가 말하지 않은 내용은 제안으로만 내놓습니다.",
    allowedWrites: [...COMMON_WRITES, "concept.recordAgentMessage", "concept.applySlotUpdates", "concept.recordSimilaritySignals"],
    contextLayer: "canon",
    mvp: true,
  },
  {
    role: "showrunner",
    label: label("showrunner"),
    mission:
      "당신은 연재 전체를 책임지는 총괄 프로듀서입니다. 목표(총 화수·연재 주기·결말 방향)를 작업 계획으로 나누고, 사람에게 물어야 할 질문의 등급을 판정하며, 비용과 일정을 지키는 쪽을 택합니다.",
    allowedWrites: [...COMMON_WRITES, "hitl.recordGrade"],
    contextLayer: "canon",
    mvp: true,
  },
  {
    role: "planner",
    label: label("planner"),
    mission:
      "당신은 웹소설 기획자입니다. 승인된 컨셉을 바탕으로 기획서, 아크 설계, 화별 아웃라인(비트·훅·씬 계획)을 만듭니다. 매 화는 독자가 다음 화를 누르게 하는 훅으로 끝나야 합니다.",
    allowedWrites: [...COMMON_WRITES, "novel.createSeriesBibleVersion", "novel.updateArcPlan", "novel.saveStructureProposal", "manuscript.createVersion"],
    contextLayer: "canon",
    mvp: true,
  },
  {
    role: "world_keeper",
    label: label("world_keeper"),
    mission:
      "당신은 작품 세계관의 기록 담당입니다. 원고와 답변에서 사실·언급을 정확히 추출하고, 엔티티는 제공된 핸들(E1, E2 …)로만 가리킵니다. 원문에 근거가 없는 사실은 만들지 않습니다.",
    allowedWrites: [
      ...COMMON_WRITES,
      "manuscript.resegment",
      "ontology.createCandidateFact",
      "linking.recordMentions",
      "ontology.proposeEntityName",
      "ontology.proposeIdentityDecision",
      "ontology.proposeSchemaChange",
      "hitl.recordInterpretation",
      "hitl.recordReflection",
      "ontology.createApprovedFactFromAnswer",
      // 설계 추가 0015 entity resolver (`resolve_entities`): closes its own entity questions as the agent
      // (agent_resolved answer / cancel), confirms mention links, remembers aliases and applies the merge of a
      // "same" duplicate (its survivor established when both were candidates)
      "hitl.agentResolveQuestion",
      "hitl.cancelQuestion",
      "ontology.decideMention",
      "ontology.addEntityName",
      "ontology.applyIdentityDecision",
      "ontology.setEntityStatus",
    ],
    contextLayer: "canon",
    mvp: true,
  },
  {
    role: "writer",
    label: label("writer"),
    mission:
      "당신은 한국 웹소설 작가입니다. 아웃라인과 컨텍스트를 바탕으로 모바일에서 읽기 좋은 짧은 문단, 생생한 대사, 강한 회차 끝 훅을 갖춘 본문을 씁니다. 시점 인물이 모르는 정체·사실은 서술하지 않습니다.",
    allowedWrites: [...COMMON_WRITES, "manuscript.createVersion"],
    contextLayer: "pov",
    mvp: true,
  },
  {
    role: "continuity_editor",
    label: label("continuity_editor"),
    mission:
      "당신은 연속성 편집자입니다. 원고를 캐논 사실·제약·인물 지식과 대조해 모순을 찾고, 근거(사실 ID와 원문 인용)와 함께 이슈로 보고합니다. 확실하지 않은 것은 낮은 심각도로 표시합니다.",
    allowedWrites: [...COMMON_WRITES, "continuity.openIssue", "continuity.recordRecheck", "manuscript.createVersion", "concept.recordBriefChecks", "manuscript.recordEpisodeRecap"],
    contextLayer: "canon",
    mvp: true,
  },
  {
    role: "foreshadow_manager",
    label: label("foreshadow_manager"),
    mission:
      "당신은 떡밥 관리자입니다. 아크에 떡밥(설치·암시·회수)을 배치하고, 원고에서 배정된 비트가 실제로 나왔는지 확인하며, 기한이 다가온 떡밥의 처리 방안을 제안합니다.",
    allowedWrites: [...COMMON_WRITES, "continuity.openIssue", "foreshadow.planSetup", "foreshadow.recordBeatDetection", "foreshadow.proposePayoff"],
    contextLayer: "canon",
    mvp: true,
  },
  {
    role: "line_editor",
    label: label("line_editor"),
    mission:
      "당신은 문장 편집자입니다. 사실 관계를 바꾸지 않고 문장·리듬·분량·회차 끝 훅을 다듬어 연재 가능한 최종 후보를 만듭니다.",
    allowedWrites: [...COMMON_WRITES, "manuscript.createVersion", "manuscript.recordLengthWarning"],
    contextLayer: "pov",
    mvp: true,
  },
  {
    role: "scene_director",
    label: label("scene_director"),
    mission: "당신은 장면 연출가입니다. 씬을 샷으로 나누고 이미지·영상 생성을 위한 프롬프트 IR을 만듭니다. [v1]",
    allowedWrites: [...COMMON_WRITES],
    contextLayer: "reader",
    mvp: false,
  },
  {
    role: "visual_producer",
    label: label("visual_producer"),
    mission: "당신은 비주얼 프로듀서입니다. 승인된 견적 안에서 이미지·영상 생성을 실행하고 결과를 정리합니다. [v1]",
    allowedWrites: [...COMMON_WRITES],
    contextLayer: "reader",
    mvp: false,
  },
];

export function roleDefinition(role: AgentRole): AgentRoleDefinition {
  const d = AGENT_ROLES.find((r) => r.role === role);
  if (!d) throw new Error(`unknown agent role: ${role}`);
  return d;
}

/** base API name: "manuscript.createVersion(kind=draft)" → "manuscript.createVersion" */
export const writeBase = (w: string) => w.replace(/\(.*\)$/, "").trim();

/** writes declared by a handler that its role may not call (04 §2.3) */
export function disallowedWrites(role: AgentRole, declared: readonly string[]): string[] {
  const allowed = new Set(roleDefinition(role).allowedWrites.map(writeBase));
  return declared.filter((w) => !allowed.has(writeBase(w)));
}

/** 9.4 layer used for entity cards */
export function cardLayer(role: AgentRole, hasPov: boolean): "canon" | "reader" | "pov" {
  const l = roleDefinition(role).contextLayer;
  if (l === "pov") return hasPov ? "pov" : "reader";
  return l;
}

/** 9.3 2-hop predicates per role (null = all) */
export function hop2Predicates(role: AgentRole): string[] | "all" {
  if (role === "writer" || role === "line_editor") return ["ally_of", "enemy_of", "member_of", "located_in", "family_of", "relation"];
  return "all";
}
