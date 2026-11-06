import { describe, expect, it } from "vitest";
import {
  actorView,
  areaGroupOf,
  areaLabelKo,
  buildSentence,
  dayKey,
  dayLabelKo,
  exactTimeKo,
  groupByDay,
  josa,
  relativeTimeKo,
  sentenceText,
  targetNameOf,
  targetTextKo,
} from "./timeline.js";

const SEOUL = "Asia/Seoul";
// 2026-11-06 14:00 KST
const NOW = Date.parse("2026-11-06T05:00:00Z");

describe("day grouping (novel timezone)", () => {
  it("keys by wall-clock day in the zone, not UTC", () => {
    expect(dayKey("2026-11-05T16:30:00Z", SEOUL)).toBe("2026-11-06");
    expect(dayKey("2026-11-05T16:30:00Z", "UTC")).toBe("2026-11-05");
    expect(dayKey("not a date", SEOUL)).toBe("");
    expect(dayKey("2026-01-02T03:00:00Z", "America/New_York")).toBe("2026-01-01");
  });

  it("one group per day even when seq order and occurredAt disagree around midnight", () => {
    const items = [
      { id: "a", occurredAt: "2026-11-05T15:01:00Z" }, // 11-06 00:01 KST
      { id: "b", occurredAt: "2026-11-05T14:59:00Z" }, // 11-05 23:59 KST
      { id: "c", occurredAt: "2026-11-05T15:00:30Z" }, // 11-06 00:00 KST (committed later, lower clock)
    ];
    const g = groupByDay(items, SEOUL);
    expect(g.map((x) => [x.key, x.items.map((i) => i.id)])).toEqual([
      ["2026-11-06", ["a", "c"]],
      ["2026-11-05", ["b"]],
    ]);
  });

  it("groups consecutive items and keeps order", () => {
    const items = [
      { id: "a", occurredAt: "2026-11-06T04:00:00Z" },
      { id: "b", occurredAt: "2026-11-05T16:00:00Z" },
      { id: "c", occurredAt: "2026-11-05T14:00:00Z" },
      { id: "d", occurredAt: "2026-11-03T01:00:00Z" },
    ];
    const g = groupByDay(items, SEOUL);
    expect(g.map((x) => [x.key, x.items.map((i) => i.id)])).toEqual([
      ["2026-11-06", ["a", "b"]],
      ["2026-11-05", ["c"]],
      ["2026-11-03", ["d"]],
    ]);
  });

  it("labels 오늘 / 어제 / date / other year", () => {
    expect(dayLabelKo("2026-11-06", NOW, SEOUL)).toEqual({
      title: "오늘",
      sub: "11월 6일 (금)",
    });
    expect(dayLabelKo("2026-11-05", NOW, SEOUL)).toEqual({
      title: "어제",
      sub: "11월 5일 (목)",
    });
    expect(dayLabelKo("2026-11-01", NOW, SEOUL)).toEqual({
      title: "11월 1일 (일)",
    });
    expect(dayLabelKo("2025-12-31", NOW, SEOUL)).toEqual({
      title: "2025년 12월 31일 (수)",
    });
  });
});

describe("relative time", () => {
  it("방금 / 분 / 시간 (same day) / clock otherwise", () => {
    expect(relativeTimeKo(new Date(NOW - 20_000), NOW, SEOUL)).toBe("방금 전");
    expect(relativeTimeKo(new Date(NOW + 5_000), NOW, SEOUL)).toBe("방금 전");
    expect(relativeTimeKo(new Date(NOW - 3 * 60_000), NOW, SEOUL)).toBe("3분 전");
    expect(relativeTimeKo(new Date(NOW - 5 * 3_600_000), NOW, SEOUL)).toBe("5시간 전");
    // yesterday 23:10 KST
    expect(relativeTimeKo("2026-11-05T14:10:00Z", NOW, SEOUL)).toBe("23:10");
  });

  it("a row under 어제 never reads 'N분 전' just after midnight", () => {
    const justAfterMidnight = Date.parse("2026-11-05T15:05:00Z"); // 11-06 00:05 KST
    expect(relativeTimeKo("2026-11-05T14:55:00Z", justAfterMidnight, SEOUL)).toBe("23:55");
    expect(relativeTimeKo("2026-11-05T15:02:00Z", justAfterMidnight, SEOUL)).toBe("3분 전");
  });

  it("exact time for tooltips", () => {
    expect(exactTimeKo("2026-11-06T05:02:33Z", SEOUL)).toBe("2026년 11월 6일 (금) 14:02:33");
  });
});

describe("sentence building", () => {
  it("particles follow the final consonant", () => {
    expect(josa("작가 에이전트", "이가")).toBe("작가 에이전트가");
    expect(josa("스케줄러", "이가")).toBe("스케줄러가");
    expect(josa("3화 원고", "을를")).toBe("3화 원고를");
    expect(josa("작품", "을를")).toBe("작품을");
    expect(josa("3화", "을를")).toBe("3화를");
    expect(josa("언급 12건", "을를")).toBe("언급 12건을");
    expect(josa("작업 ‘초고 작성’", "을를")).toBe("작업 ‘초고 작성’을");
    expect(josa("나", "이가")).toBe("내가");
    expect(josa("API", "을를")).toBe("API을(를)");
  });

  it("builds one natural sentence with actor and target parts", () => {
    const p = buildSentence(
      "manuscript.human_edited",
      "작가 에이전트",
      targetTextKo("manuscript.human_edited", {
        type: "episode",
        episodeNo: 3,
      }),
    );
    expect(sentenceText(p)).toBe("작가 에이전트가 3화 원고를 직접 고쳤습니다");
    expect(p.find((x) => x.kind === "target")?.text).toBe("3화 원고");
    expect(p.find((x) => x.kind === "actor")?.text).toBe("작가 에이전트");

    expect(sentenceText(buildSentence("novel.settings_changed", "나", "작품"))).toBe("내가 작품의 설정을 바꿨습니다");
    expect(sentenceText(buildSentence("episode.approved", "사용자", "3화"))).toBe("사용자가 3화를 승인했습니다");
    expect(sentenceText(buildSentence("task.created", "총괄 에이전트", "작업 ‘초고 작성’"))).toBe("총괄 에이전트가 작업 ‘초고 작성’을 만들었습니다");
    // unknown verb falls back without crashing
    expect(sentenceText(buildSentence("novel.something_new", "스케줄러", "작품"))).toBe("스케줄러가 작품에서 ‘something new’ 동작을 기록했습니다");
  });

  it("target text: episode number, name, bulk count", () => {
    expect(targetTextKo("episode.approved", { type: "episode", episodeNo: 7 })).toBe("7화");
    expect(targetTextKo("mention.batch_linked", { type: "mention", count: 12 })).toBe("언급 12건");
    expect(targetTextKo("task.created", { type: "task", name: "초고 작성" })).toBe("작업 ‘초고 작성’");
    expect(targetNameOf(null, { title: "  첫 만남 " })).toBe("첫 만남");
    expect(targetNameOf({ name: "민준" }, null)).toBe("민준");
  });

  it("novel-targeted actions name what actually changed (review: structure / export / reorder)", () => {
    const say = (action: string, actor: string, t: Parameters<typeof targetTextKo>[1]) => sentenceText(buildSentence(action, actor, targetTextKo(action, t)));
    expect(say("structure.created", "작가 에이전트", { type: "novel" })).toBe("작가 에이전트가 작품 전체 구성을 만들었습니다");
    expect(say("structure.updated", "나", { type: "novel" })).toBe("내가 작품 전체 구성을 수정했습니다");
    expect(say("structure.status_changed", "나", { type: "novel" })).toBe("내가 작품 전체 구성의 상태를 바꿨습니다");
    expect(say("export.created", "나", { type: "novel", count: 5 })).toBe("내가 작품 내보내기 파일을 만들었습니다");
    expect(say("character.reordered", "나", { type: "novel", count: 5 })).toBe("내가 작품 캐릭터의 순서를 바꿨습니다");
    expect(say("novel.settings_changed", "나", { type: "novel" })).toBe("내가 작품의 설정을 바꿨습니다");
  });

  it("no doubled nouns: scene re-segmentation, image jobs", () => {
    const say = (action: string, actor: string, t: Parameters<typeof targetTextKo>[1]) => sentenceText(buildSentence(action, actor, targetTextKo(action, t)));
    expect(say("scene.resegmented", "시스템", { type: "episode", episodeNo: 3 })).toBe("시스템이 3화의 씬 경계를 다시 나눴습니다");
    expect(say("image.completed", "이미지 생성기", { type: "media_asset" })).toBe("이미지 생성기가 이미지 생성을 마쳤습니다");
    expect(say("image.requested", "나", { type: "media_asset" })).toBe("내가 이미지 생성을 요청했습니다");
    expect(say("image.deleted", "나", { type: "media_asset" })).toBe("내가 이미지를 삭제했습니다");
    expect(say("image.failed", "이미지 생성기", { type: "media_asset" })).not.toContain("미디어 자산");
  });

  it("actor identity and area grouping", () => {
    expect(actorView({ actorType: "user", actorId: "u1" }, { id: "u1", displayName: "민준" })).toMatchObject({ name: "나", isMe: true, kind: "사용자" });
    expect(actorView({ actorType: "user", actorId: "u2" }, { id: "u1", displayName: "민준" })).toMatchObject({ name: "사용자", isMe: false });
    expect(actorView({ actorType: "agent", actorId: "writer" })).toMatchObject({
      name: "작가 에이전트",
      label: "작가",
      initials: "작",
      kind: "에이전트",
    });
    expect(actorView({ actorType: "system", actorId: "scheduler" })).toMatchObject({ name: "스케줄러", kind: "시스템" });
    expect(areaGroupOf("manuscript.human_edited").label).toBe("원고");
    expect(areaGroupOf("budget.policy_changed").tone).toBe("danger");
    expect(areaLabelKo("episode")).toBe("회차");
    expect(areaLabelKo("manuscript")).toBe("원고");
    // amounts are shown in USD, so the glyph matches
    expect(areaGroupOf("budget.policy_changed").glyph).toBe("$");
    expect(areaGroupOf("settings.changed").id).toBe("system");
  });
});
