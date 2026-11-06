/** Test helper: scripted answers for build_world_ontology (설계 추가: 세계관 온톨로지, module world). */
import type { ClaudeRequest, ScriptedClaude } from "./scripted-claude.js";
import type { WorldProposal } from "../../src/modules/world/domain/proposal.js";

/** the world step's request carries these output keys */
export const WORLD_SCHEMA_KEYS = ["factions", "places", "systems", "constraints"];
export const isWorldRequest = (r: Pick<ClaudeRequest, "system">) => r.system.includes("세계관 온톨로지 작성 규칙");
export const notWorld = <R extends Pick<ClaudeRequest, "system">>(rs: readonly R[]) => rs.filter((r) => !isWorldRequest(r));

/** a small world of a hunter / regression novel (F~S급 등급, 길드, 균열) */
export const SAMPLE_WORLD: WorldProposal = {
  factions: [
    { key: "f_sun", name: "태양 길드", aliases: ["태양"], summary: "S급 길드장이 이끄는 최대 길드. 균열 공략을 독점한다.", source_urls: [] },
    { key: "f_assoc", name: "헌터 협회", aliases: [], summary: "헌터 등급을 매기고 균열 출입을 관리하는 공공 기관.", source_urls: [] },
  ],
  places: [
    { key: "p_seoul", name: "서울", aliases: [], summary: "균열이 가장 많이 열리는 도시.", parent_key: "", source_urls: [] },
    { key: "p_rift", name: "균열 던전", aliases: ["균열"], summary: "짐꾼만 볼 수 있는 틈이 있는 던전.", parent_key: "p_seoul", source_urls: [] },
  ],
  systems: [
    { key: "s_rank", name: "헌터 등급", system_kind: "ability", summary: "F~S급으로 나뉘는 각성자 등급.", cost_or_rule: "등급을 올리려면 균열 핵을 흡수해야 한다.", limits: ["한 번 정해진 각성 계열은 바뀌지 않는다."], source_urls: [] },
  ],
  objects: [{ key: "o_core", name: "균열 핵", aliases: [], summary: "균열을 닫으면 남는 결정. 등급 상승에 쓰인다.", source_urls: [] }],
  history: [{ key: "h_first", name: "첫 균열", summary: "10년 전 서울 하늘에 첫 균열이 열렸다.", when: "10년 전", place_key: "p_seoul", participant_keys: ["f_assoc"], source_urls: [] }],
  relations: [
    { subject_key: "f_sun", predicate: "headquartered_in", object_key: "p_seoul", note: "", source_urls: [] },
    { subject_key: "f_sun", predicate: "enemy_of", object_key: "f_assoc", note: "", source_urls: [] },
  ],
  constraints: [{ key: "c_rank", title: "등급 체계", statement: "헌터 등급은 F급부터 S급까지 여섯 단계뿐이다.", from_brief: true, source_urls: [] }],
  sources_note: "",
};

/** answers every world request with `json` (default SAMPLE_WORLD) */
export function scriptWorld(claude: ScriptedClaude, json: unknown = SAMPLE_WORLD, times = Infinity): void {
  claude.reply({ times, when: (r) => isWorldRequest(r), json });
}
