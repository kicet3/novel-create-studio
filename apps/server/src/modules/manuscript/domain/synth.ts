/**
 * Deterministic structure builders (pure), used only to complete sparse-but-valid LLM outputs
 * (missing logline / arc episodes / outline scene summaries). They never produce manuscript prose.
 */
import type { ArcPlanProposal, BibleProposal, OutlineData, OutlineProposal } from "./schemas.js";
import { SCENE_SEPARATOR } from "./text.js";

export interface NovelFacts {
  title: string;
  genre: string;
  endingDirection: string;
  totalEpisodesMin: number;
}

export function synthBible(n: NovelFacts, rejectionNote?: string | null): BibleProposal {
  const arcLen = Math.max(3, Math.min(10, Math.ceil(n.totalEpisodesMin / 4)));
  return {
    logline: `${n.title}: ${n.genre || "장르 미정"} 연재물`,
    synopsis: `${n.title}의 주인공은 자신에게 주어진 과제를 따라 성장합니다. 결말 방향: ${n.endingDirection}.${rejectionNote ? ` 반려 사유 반영: ${rejectionNote}` : ""}`,
    world: `${n.genre || "현대"} 배경의 세계입니다.`,
    hook: "첫 화 끝에서 주인공의 비밀이 드러납니다.",
    ending_direction: n.endingDirection,
    characters: [
      { name: "주인공", role: "protagonist", description: "이야기를 이끄는 인물입니다.", source_field_path: "protagonist", character_key: null },
      { name: "조력자", role: "supporting", description: "주인공을 돕는 인물입니다.", source_field_path: null, character_key: null },
    ],
    world_rules: [{ statement: "세계의 규칙은 이야기 내내 일관되게 유지됩니다.", source_field_path: null }],
    avoid_list: [],
    arc_outline: [
      { title: "1부 시작", episode_count: arcLen, summary: "주인공이 사건에 휘말립니다." },
      { title: "2부 전개", episode_count: arcLen, summary: "갈등이 깊어집니다." },
    ],
    open_questions: [],
  };
}

export function bibleMarkdown(p: BibleProposal): string {
  const lines = [`# 기획서`, ``, `**로그라인** ${p.logline}`, ``, `## 시놉시스`, p.synopsis, ``, `## 세계관`, p.world, ``, `## 인물`];
  for (const c of p.characters) lines.push(`- **${c.name}** (${c.role}): ${c.description}`);
  lines.push(``, `## 세계 규칙`);
  for (const r of p.world_rules) lines.push(`- ${r.statement}`);
  if (p.avoid_list.length) lines.push(``, `## 피할 요소`, ...p.avoid_list.map((a) => `- ${a}`));
  lines.push(``, `## 아크 개요`);
  for (const a of p.arc_outline) lines.push(`- ${a.title} (${a.episode_count}화): ${a.summary}`);
  lines.push(``, `## 결말 방향`, p.ending_direction, ``, `## 훅`, p.hook);
  return lines.join("\n");
}

export function synthArcPlan(arc: { ord: number; title: string; plannedEpisodeFrom: number; plannedEpisodeTo: number }, outline?: { title: string; summary: string }): ArcPlanProposal {
  const episodes = [];
  for (let no = arc.plannedEpisodeFrom; no <= arc.plannedEpisodeTo; no++) {
    episodes.push({ episode_no: no, title: `${no}화`, hook_note: `${no}화의 끝에서 다음 화로 이어지는 훅`, summary: `${outline?.summary ?? arc.title}의 ${no - arc.plannedEpisodeFrom + 1}번째 화입니다.`, scene_count: null, target_chars: null });
  }
  return {
    title: outline?.title ?? arc.title,
    goal_text: `${arc.ord}번째 아크의 목표를 달성합니다.`,
    conflict_text: "주인공의 목표를 가로막는 갈등이 있습니다.",
    end_condition: `${arc.plannedEpisodeTo}화에서 아크 갈등이 일단락됩니다.`,
    core_event: "",
    involved_character_ids: [],
    change_text: "",
    setup_plan: { plant: [], payoff: [] },
    new_characters: [],
    episodes,
  };
}

export function synthOutline(ep: { episodeNo: number; title: string | null; hookNote: string | null }, targetChars: number, beatIds: string[] = []): OutlineProposal {
  const scenes = [1, 2, 3].map((i) => ({
    key: `s${i}`,
    summary: i === 1 ? "도입: 상황을 보여 줍니다." : i === 2 ? "전개: 갈등이 커집니다." : "마무리: 훅으로 끝납니다.",
    pov_entity_id: null,
    location_entity_id: null,
    participant_entity_ids: [],
    timeline_id: null,
    setup_beat_ids: i === 2 ? beatIds : [],
    answer_ids: [],
  }));
  const outline: OutlineData = {
    beats: scenes.map((s, i) => ({ ord: i + 1, purpose: s.summary })),
    scenes,
    new_entity_proposals: [],
    hook: ep.hookNote ?? "다음 화가 궁금해지는 장면으로 끝납니다.",
    target_chars: targetChars,
  };
  return { summary: `${ep.episodeNo}화 아웃라인: ${scenes.map((s) => s.summary).join(" ")}`, title: ep.title, outline };
}
