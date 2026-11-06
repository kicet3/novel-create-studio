/**
 * Explicit Claude responses for the MVP-α writing pipeline tests (manuscript pipeline, integration E2E).
 * Every value below is literal test data: nothing is generated from the request, there is no schema-driven
 * filler. Each response is matched by its task's prompt marker (system instruction) or output-schema keys and
 * is sticky (`times: Infinity`) because the pipeline repeats task kinds (episodes 1..N, rework loops).
 *
 * The novel these responses describe: a 3-episode first arc, episode texts with two scenes separated by the
 * scene separator line (so scene segmentation is deterministic), one setup planted in episode 2 and paid off
 * in episode 3 (episode 1 has no assigned beats), no safety / continuity findings.
 */
import type { ClaudeRequest, ClaudeScript, ScriptedClaude } from "./scripted-claude.js";

export const SCRIPTED_BIBLE = {
  logline: "회귀한 검사가 흉터의 비밀을 쫓는다",
  synopsis: "몰락한 검사 한결은 죽음 직전 십 년 전으로 회귀한다. 손등의 흉터가 회귀의 열쇠임을 알게 된 그는 흉터를 새긴 자를 찾아 나선다.",
  world: "검술 길드가 도시를 다스리는 대륙. 흉터는 계약의 흔적으로 여겨진다.",
  hook: "첫 화 끝에서 흉터가 처음으로 빛난다.",
  ending_direction: "흉터의 비밀을 밝히고 회귀를 끝낸다",
  characters: [
    { name: "한결", role: "protagonist", description: "회귀한 검사.", source_field_path: null, character_key: null },
    { name: "서린", role: "supporting", description: "길드의 기록관.", source_field_path: null, character_key: null },
  ],
  world_rules: [{ statement: "흉터는 계약을 맺은 자에게만 생긴다.", source_field_path: null }],
  avoid_list: [],
  arc_outline: [
    { title: "1부 흉터의 기억", episode_count: 3, summary: "한결이 회귀를 깨닫고 흉터의 첫 단서를 찾는다." },
    { title: "2부 계약자", episode_count: 9, summary: "흉터를 새긴 계약자를 추적한다." },
  ],
  open_questions: [],
};

export const SCRIPTED_ARC_PLAN = {
  title: "1부 흉터의 기억",
  goal_text: "한결이 회귀를 받아들이고 흉터의 첫 단서를 얻는다.",
  conflict_text: "길드는 한결의 귀환을 의심한다.",
  end_condition: "흉터가 계약의 흔적임을 알게 된다.",
  core_event: "한결이 회귀를 깨닫고 흉터가 계약의 흔적임을 알아낸다.",
  involved_character_ids: [],
  change_text: "한결이 회귀를 현실로 받아들인다.",
  setup_plan: { plant: ["장부의 흉터 문양"], payoff: [] },
  new_characters: [],
  episodes: [
    { episode_no: 1, title: "다시 뜬 눈", hook_note: "흉터가 빛난다.", summary: "한결이 십 년 전 새벽에 눈을 뜬다.", scene_count: 2, target_chars: 5200 },
    { episode_no: 2, title: "기록관", hook_note: "낡은 장부.", summary: "서린의 장부에서 흉터 문양을 본다.", scene_count: 2, target_chars: 5200 },
    { episode_no: 3, title: "첫 단서", hook_note: "계약의 흔적.", summary: "흉터가 계약의 흔적임을 안다.", scene_count: 2, target_chars: 5200 },
  ],
};

export const SCRIPTED_SETUP_PLAN = {
  new_setups: [
    {
      key: "N1",
      title: "장부의 흉터 문양",
      description: "서린의 장부에 한결의 흉터와 같은 문양이 그려져 있다.",
      importance: "medium",
      due_kind: "arc",
      beats: [
        { kind: "plant", planned_episode_no: 2, note: "장부의 문양을 보여 줍니다." },
        { kind: "payoff", planned_episode_no: 3, note: "문양이 계약의 표식임을 밝힙니다." },
      ],
      entity_ids: [],
      fact_ids: [],
    },
  ],
  existing_setup_beats: [],
  rationale: "아크 범위 안에서 설치와 회수를 배치했습니다.",
};

export const SCRIPTED_OUTLINE = {
  summary: "한결이 회귀를 깨닫고 손등의 흉터를 발견한다.",
  title: null,
  outline: {
    beats: [
      { ord: 1, purpose: "회귀를 깨닫는다" },
      { ord: 2, purpose: "흉터를 발견한다" },
    ],
    scenes: [
      { key: "s1", summary: "새벽 여관 방에서 한결이 눈을 뜬다." },
      { key: "s2", summary: "거울 앞에서 흉터를 발견한다." },
    ],
    new_entity_proposals: [],
    hook: "흉터가 희미하게 빛난다.",
    target_chars: 0,
  },
};

/**
 * Deterministic filler (literal text, repeated) so each scene is ~2,700 chars and a two-scene episode passes the
 * 5,000-char profile minimum (설계 추가 0008: 3,000-char floor, continuation below the minimum). The scene openings
 * stay the literal sentences tests match on.
 */
const FILLER = [
  "골목 끝에서 바람이 불어와 낡은 간판을 흔들었다. 한결은 걸음을 멈추고 귀를 기울였다. 멀리서 장사꾼들이 물건을 늘어놓는 소리가 들렸고, 어딘가에서 아이가 웃었다.",
  "그는 그 모든 소리가 십 년 전과 같다는 사실을 하나하나 확인했다. 기억 속의 도시는 불타고 무너졌지만, 지금 눈앞의 도시는 아직 아무것도 잃지 않았다.",
  "한결은 손등을 쓸어내렸다. 흉터는 차갑게 식어 있었다. 그는 이번에는 누구에게도 등을 내주지 않겠다고, 그러나 지켜야 할 사람은 끝까지 지키겠다고 다짐했다.",
];
export function padScene(head: string, target = 2700): string {
  const parts = [head];
  let i = 0;
  while (parts.join("\n\n").length < target) parts.push(FILLER[i++ % FILLER.length]!);
  return parts.join("\n\n");
}
export const SCENE_1 = padScene("한결은 새벽 안개가 스며드는 여관 방에서 눈을 떴다. 창밖으로 들리는 종소리는 십 년 전 그날과 똑같았다. 그는 숨을 고르며 자신이 돌아왔다는 사실을 받아들였다.");
export const SCENE_2 = padScene("거울 앞에 선 한결은 손등에 새겨진 흉터를 내려다보았다. 흉터는 희미하게 빛나다가 이내 사그라들었다. 그는 이 흉터가 모든 일의 시작이라는 것을 직감했다.");
export const SCRIPTED_DRAFT = `${SCENE_1}\n\n* * *\n\n${SCENE_2}`;
export const POLISHED_SCENE_1 = padScene("한결은 새벽 안개가 스며드는 여관 방에서 천천히 눈을 떴다. 창밖의 종소리는 십 년 전 그날과 똑같았다. 그는 숨을 고르며 자신이 돌아왔다는 사실을 받아들였다.", 2710);
export const POLISHED_SCENE_2 = padScene("거울 앞에 선 한결은 손등의 흉터를 내려다보았다. 흉터는 희미하게 빛나다가 곧 사그라들었다. 그는 이 흉터가 모든 일의 시작임을 직감했다.", 2710);
export const REVISED_SCENE = padScene("한결은 칼자루를 움켜쥐고 문을 박차고 나갔다. 복도 끝에서 누군가 그의 이름을 불렀다. 흉터가 다시 욱신거렸다.");

/**
 * plan_structure (설계 추가): 4 parts × 3 episodes + structured ending. Character ids are only known at run time,
 * so the response reads the roster ids of the request (no other request-derived content).
 */
export const SCRIPTED_STRUCTURE_PARTS = [
  { ord: 1, title: "흉터의 기억", goal: "한결이 회귀를 받아들이고 흉터의 첫 단서를 얻는다.", plot: "흉터의 기억" },
  { ord: 2, title: "계약자", goal: "흉터를 새긴 계약자를 추적한다.", plot: "계약자 추적" },
  { ord: 3, title: "배신의 밤", goal: "길드의 배신을 되갚는다.", plot: "배신의 밤" },
  { ord: 4, title: "회귀의 끝", goal: "흉터의 비밀을 밝히고 회귀를 끝낸다.", plot: "마지막 계약" },
];
export function scriptedStructure(prompt: string, episodesPerPart = 3) {
  const roster = [...prompt.matchAll(/"id":"(chr_[0-9A-HJKMNP-TV-Z]{26})","name":"([^"]+)","role":"(\w+)"/g)].map((m) => ({ id: m[1]!, name: m[2]!, role: m[3]! }));
  const main = roster.filter((r) => r.role === "protagonist" || r.role === "sub_protagonist");
  return {
    ending: {
      world_state: "검술 길드의 지배가 끝나고 도시는 스스로를 다스린다.",
      conflict_resolution: "한결이 계약자를 쓰러뜨리고 흉터의 계약을 끊는다.",
      character_final_states: main.map((r) => ({ character_id: r.id, final_state: `${r.name}은 회귀의 굴레에서 벗어난다.` })),
      protagonist_change: { from: "아무도 믿지 않는 외톨이", to: "동료에게 등을 맡기는 검사" },
      foreshadow_payoffs: [{ setup: "장부의 흉터 문양", payoff: "문양은 계약자의 표식이었다." }],
    },
    parts: SCRIPTED_STRUCTURE_PARTS.map((p) => ({
      ord: p.ord,
      title: p.title,
      goal: p.goal,
      turning_points: [`${p.ord}부 전환점`],
      episode_from: (p.ord - 1) * episodesPerPart + 1,
      episode_to: p.ord * episodesPerPart,
      character_states: main.map((r) => ({ character_id: r.id, state: `${p.ord}부 끝: ${r.name}이 한 걸음 성장한다.` })),
      plots: [{ title: p.plot, core_event: p.goal, episode_count: episodesPerPart }],
    })),
    first_appearances: roster.map((r) => ({ character_id: r.id, episode_no: 1 })),
  };
}

/** text-output steps are told apart by their task instruction (system prompt) */
const SYS = {
  draft: "아웃라인의 씬을 순서대로 본문으로 씁니다",
  polish: "문장 교정자(line_editor)",
  revise: "주어진 씬 하나만 다시 씁니다",
} as const;

/** scripts every model call of the pipeline with the literal responses above */
export function scriptPipeline(claude: ScriptedClaude): void {
  const sticky = (s: ClaudeScript): ClaudeScript => ({ times: Infinity, ...s });
  claude.reply(
    // planning
    sticky({ when: { schemaHas: ["logline", "synopsis", "arc_outline"] }, json: SCRIPTED_BIBLE }),
    sticky({ when: { schemaHas: ["entities", "facts"] }, json: { entities: [], facts: [] } }),
    sticky({ when: { schemaHas: ["parts", "ending"] }, json: (r: ClaudeRequest) => scriptedStructure(r.prompt) }),
    sticky({ when: { schemaHas: ["goal_text", "episodes"] }, json: SCRIPTED_ARC_PLAN }),
    sticky({ when: { schemaHas: ["new_setups"], prompt: /\[ARC\] id=\S+ from=1 to=3/ }, json: SCRIPTED_SETUP_PLAN }),
    sticky({ when: { schemaHas: ["new_setups"] }, json: { new_setups: [], existing_setup_beats: [], rationale: "이번 아크에는 새 떡밥이 없습니다." } }),
    // writing
    sticky({ when: { schemaHas: ["summary", "outline"] }, json: SCRIPTED_OUTLINE }),
    sticky({ when: { text: true, system: SYS.draft }, text: SCRIPTED_DRAFT }),
    sticky({ when: { text: true, system: SYS.polish, prompt: '"sceneOrd":1' }, text: POLISHED_SCENE_1 }),
    sticky({ when: { text: true, system: SYS.polish, prompt: '"sceneOrd":2' }, text: POLISHED_SCENE_2 }),
    sticky({ when: { text: true, system: SYS.revise }, text: REVISED_SCENE }),
    // boundary estimate when a rewritten text no longer splits on separator lines: one scene from the start
    sticky({ when: { schemaHas: ["scenes"] }, json: { scenes: [{ char_start: 0, summary: "한결이 흉터의 의미를 깨닫는다.", narration_mode: "third_limited" }] } }),
    sticky({ when: { schemaHas: ["target_scene_ords"] }, json: { target_scene_ords: [2], instructions: "마지막 씬의 긴장감을 높입니다." } }),
    // checks: nothing found
    sticky({ when: { schemaHas: ["violations"] }, json: { violations: [] } }),
    sticky({ when: { schemaHas: ["mentions", "facts"] }, json: { mentions: [], facts: [] } }),
    // L4: the bible's names found by the dictionary pass ("한결", "서린") each have exactly one candidate card
    sticky({ when: { schemaHas: ["choice"], prompt: '표기: "한결"' }, json: { choice: "C1", rationale: "주인공 한결" } }),
    sticky({ when: { schemaHas: ["choice"], prompt: '표기: "서린"' }, json: { choice: "C1", rationale: "기록관 서린" } }),
    sticky({ when: { schemaHas: ["verdicts"] }, json: { verdicts: [], issues: [] } }),
    sticky({ when: { schemaHas: ["findings"] }, json: { findings: [], unplanned: [] } }),
    sticky({ when: { schemaHas: ["blocking"] }, json: { blocking: false, basis: "none", reason_ko: "" } }),
  );
}
