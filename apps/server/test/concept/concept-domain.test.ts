import { describe, expect, it } from "vitest";
import { emptyWorkingBrief, workingBriefHash, type WorkingBrief } from "../../src/modules/concept/domain/brief.js";
import { DEFAULT_SAFETY_LISTS, groundedRealPersonName, runDeterministicChecks, submitBlockers } from "../../src/modules/concept/domain/checks.js";
import { selectNext } from "../../src/modules/concept/domain/next-question.js";
import { coerceValue, requiredPaths, splitCharacterText } from "../../src/modules/concept/domain/question-set.js";
import { assertBriefTransition, assertSessionTransition, assertStageTransition } from "../../src/modules/concept/domain/transitions.js";
import { conceptTurnProposalSchema } from "../../src/modules/concept/domain/proposal.js";
import { planFieldEdit, planImport, planTurn, sortByQuestionOrder, type TurnMessage } from "../../src/modules/concept/domain/turn.js";

const limits = { flipLimit: 3, softWarning: 30, agentTurnCount: 0, turnLimit: 40, messenger: false, replyMaxChars: 1200 };
let n = 0;
const newId = () => `cpr_${++n}`;
const userMsg = (id: string, body: string, extra: Partial<TurnMessage> = {}): TurnMessage => ({ id, seq: 2, authorKind: "user", kind: "text", body, channelId: "chn_web", pickedIdx: null, options: null, askedFieldPaths: null, ...extra });
const prompt = (path: string, options: TurnMessage["options"] = []): TurnMessage => ({ id: "cnm_p", seq: 1, authorKind: "agent", kind: "question", body: "", channelId: "chn_web", pickedIdx: null, options, askedFieldPaths: [path] });

function filled(): WorkingBrief {
  const b = emptyWorkingBrief({ web_channel_id: "chn_web" });
  const set = (path: string, v: unknown) => {
    const r = planFieldEdit({ brief: b, stage: "diverging", entryMode: "conversation", messageId: `cnm_${path}`, path, value: v, lists: DEFAULT_SAFETY_LISTS, flipLimit: 3, newId });
    Object.assign(b, r.brief);
  };
  set("category.genre_label", "SF");
  set("age_rating", "age_12");
  set("protagonist.starting_condition", "화성 기지의 정비공");
  set("protagonist.desire", "지구로 돌아가기");
  set("opposition", "기지를 봉쇄한 회사");
  set("core_hook", "정비공만 기지의 AI와 대화할 수 있다");
  set("ending_direction", "귀환에 성공하지만 AI를 남겨 둔다");
  set("logline", "화성 정비공이 회사의 봉쇄를 뚫고 지구로 돌아간다");
  return b;
}

describe("concept state machines (03 §4.12–4.13, 11 §5.2/5.4)", () => {
  it("accepts tabled transitions and rejects the rest", () => {
    expect(assertSessionTransition("active", "awaiting_approval").id).toBe("CS3");
    expect(assertSessionTransition("awaiting_approval", "active", "CS9").id).toBe("CS9");
    expect(assertSessionTransition("paused", "abandoned").id).toBe("CS8");
    expect(() => assertSessionTransition("approved", "active")).toThrow(/바꿀 수 없습니다/);
    expect(() => assertSessionTransition("abandoned", "active")).toThrow();
    expect(() => assertSessionTransition("paused", "awaiting_approval")).toThrow();
    expect(assertBriefTransition("awaiting_approval", "approved").id).toBe("CB2");
    expect(assertBriefTransition("approved", "superseded").id).toBe("CB5");
    expect(() => assertBriefTransition("rejected", "approved")).toThrow();
    expect(() => assertBriefTransition("superseded", "approved")).toThrow();
    expect(assertStageTransition("opening", "diverging").id).toBe("CS2-a");
    expect(() => assertStageTransition("confirming", "opening")).toThrow();
  });
});

describe("INV-CON-03 slot guard (CT-06) and provenance", () => {
  it("drops an agent-only change of a user_stated field into change_proposals", () => {
    const b = filled();
    const before = b.content.opposition;
    const proposal = conceptTurnProposalSchema.parse({
      slot_updates: [{ field_path: "opposition", new_value: "외계 생명체", origin_claim: "user_stated", evidence_message_id: "cnm_x", evidence_quote: "외계 생명체", key_phrase: "외계 생명체" }],
    });
    const out = planTurn({ brief: b, stage: "converging", entryMode: "conversation", messages: [userMsg("cnm_x", "좋아요, 다음으로 가요")], prompt: prompt("serial_plan.long_conflict_engine"), proposal, runId: "run_1", lists: DEFAULT_SAFETY_LISTS, limits, newId });
    expect(out.brief.content.opposition).toBe(before);
    expect(out.brief.field_provenance.opposition!.origin).toBe("user_edited");
    expect(out.brief.change_proposals).toEqual([expect.objectContaining({ field_path: "opposition", new_value: "외계 생명체", status: "pending" })]);
    // next question asks the user about the proposal first (3.5 order 1)
    expect(out.reply.body).toContain("바꾸자는 제안");
    expect(out.reply.options.map((o) => o.value)).toContain(`@accept_proposal:${out.brief.change_proposals[0]!.id}`);
  });

  it("verifies quotes: user_stated needs the quote in the message and the key phrase in quote and value", () => {
    const b = emptyWorkingBrief();
    b.content.category = { genre_label: "현판" };
    b.field_provenance["category.genre_label"] = { origin: "user_stated", slot_state: "confirmed", evidence_message_ids: ["m0"], history_count: 1 };
    const proposal = conceptTurnProposalSchema.parse({
      slot_updates: [
        { field_path: "protagonist.desire", new_value: "가족을 살리기", origin_claim: "user_stated", evidence_message_id: "cnm_a", evidence_quote: "가족을 살리고 싶어요", key_phrase: "가족" },
        { field_path: "opposition", new_value: "마왕군", origin_claim: "user_stated", evidence_message_id: "cnm_a", evidence_quote: "마왕군이 막아요", key_phrase: "마왕군" },
      ],
    });
    const out = planTurn({ brief: b, stage: "diverging", entryMode: "conversation", messages: [userMsg("cnm_a", "주인공은 가족을 살리고 싶어요")], prompt: prompt("protagonist.desire"), proposal, runId: "run_1", lists: DEFAULT_SAFETY_LISTS, limits, newId });
    expect(out.brief.field_provenance["protagonist.desire"]).toMatchObject({ origin: "user_stated", slot_state: "confirmed", evidence_message_ids: ["cnm_a"] });
    // quote not in the message → interpretation needs confirmation (R4), never user_stated
    expect(out.brief.field_provenance.opposition).toMatchObject({ origin: "agent_proposed_modified", slot_state: "proposed" });
    expect(out.reply.body).toContain("이해했습니다");
  });

  it("deictic answer to agent candidates → agent_proposed_accepted (CT-22)", () => {
    const b = emptyWorkingBrief();
    const p = prompt("protagonist.desire", [{ idx: 1, label: "배신자에게 복수", value: "배신자에게 복수", source: "agent", field_path: "protagonist.desire", is_recommended: true }]);
    const proposal = conceptTurnProposalSchema.parse({
      slot_updates: [{ field_path: "protagonist.desire", new_value: "배신자에게 복수", origin_claim: "user_stated", evidence_message_id: "cnm_b", evidence_quote: "그걸로", key_phrase: "그걸로" }],
    });
    const out = planTurn({ brief: b, stage: "diverging", entryMode: "conversation", messages: [userMsg("cnm_b", "그래 그걸로")], prompt: p, proposal, runId: "run_1", lists: DEFAULT_SAFETY_LISTS, limits, newId });
    expect(out.brief.field_provenance["protagonist.desire"]).toMatchObject({ origin: "agent_proposed_accepted", slot_state: "confirmed" });
  });

  it("delegation: two [추천해 줘] on the same slot → agent_delegated/proposed (3.5)", () => {
    let b = emptyWorkingBrief();
    const p = prompt("protagonist.desire");
    const pick = (id: string) => userMsg(id, "추천해 줘", { kind: "option_pick", pickedIdx: 901 });
    let out = planTurn({ brief: b, stage: "diverging", entryMode: "conversation", messages: [pick("cnm_1")], prompt: p, proposal: null, runId: null, lists: DEFAULT_SAFETY_LISTS, limits, newId });
    expect(out.brief.content.protagonist?.desire).toBeUndefined();
    expect(out.reply.options.filter((o) => o.source === "agent").length).toBe(3);
    expect(out.reply.options.find((o) => o.is_recommended)).toBeTruthy();
    b = out.brief;
    out = planTurn({ brief: b, stage: "diverging", entryMode: "conversation", messages: [pick("cnm_2")], prompt: { ...p, options: out.reply.options }, proposal: null, runId: null, lists: DEFAULT_SAFETY_LISTS, limits, newId });
    expect(out.brief.field_provenance["protagonist.desire"]).toMatchObject({ origin: "agent_delegated", slot_state: "proposed" });
    expect(out.reply.body).toContain("추천안");
  });

  it("cross-channel conflicting answers are not overwritten (4.4) and flips are not counted", () => {
    const b = emptyWorkingBrief();
    const out = planTurn({
      brief: b,
      stage: "diverging",
      entryMode: "conversation",
      messages: [userMsg("cnm_w", "복수", { channelId: "chn_web" }), userMsg("cnm_t", "생존", { channelId: "chn_tg", seq: 3 })],
      prompt: prompt("protagonist.desire"),
      proposal: null,
      runId: null,
      lists: DEFAULT_SAFETY_LISTS,
      limits,
      newId,
    });
    expect(out.brief.meta.conflicts).toHaveLength(1);
    expect(out.reply.body).toContain("서로 다른 답");
    expect((out.brief.meta as any).flips ?? {}).toEqual({});
  });

  it("parent change re-confirms dependants and empties the logline (3.7 field dependencies)", () => {
    const b = filled();
    const out = planFieldEdit({ brief: b, stage: "confirming", entryMode: "conversation", messageId: "cnm_e", path: "protagonist.starting_condition", value: "빙의한 악역 영애", lists: DEFAULT_SAFETY_LISTS, flipLimit: 3, newId });
    expect(out.brief.content.logline).toBeUndefined();
    expect(out.brief.field_provenance.logline!.slot_state).toBe("empty");
    expect(out.brief.field_provenance["protagonist.desire"]!.slot_state).toBe("proposed");
    expect(out.brief.field_provenance.core_hook!.slot_state).toBe("proposed");
    expect(submitBlockers(out.brief).map((x) => x.code)).toContain("missing_required");
  });

  it("flip limit produces a comparison card (CT-07)", () => {
    let b = filled();
    for (const v of ["A 회사", "B 회사", "C 회사"]) {
      b = planFieldEdit({ brief: b, stage: "converging", entryMode: "conversation", messageId: `cnm_${v}`, path: "opposition", value: v, lists: DEFAULT_SAFETY_LISTS, flipLimit: 3, newId }).brief;
    }
    expect(b.meta.flip_cards?.[0]?.field_path).toBe("opposition");
    expect(selectNext(b, "converging").kind).toBe("flip");
  });
});

describe("X-9 checks and CS3 blockers (INV-CON-05, 10, 12, 15)", () => {
  it("ready brief has no blockers; hash is stable and content-sensitive", () => {
    const b = filled();
    expect(requiredPaths(b.content)).toHaveLength(8);
    expect(submitBlockers(b)).toEqual([]);
    const h = workingBriefHash(b);
    expect(workingBriefHash(structuredClone(b))).toBe(h);
    b.content.premise = "x";
    expect(workingBriefHash(b)).not.toBe(h);
  });

  it("age_15 + over-age keyword blocks; the value stays proposed (CT-10 b)", () => {
    const b = filled();
    const r = planFieldEdit({ brief: b, stage: "converging", entryMode: "conversation", messageId: "cnm_g", path: "age_rating", value: "age_15", lists: DEFAULT_SAFETY_LISTS, flipLimit: 3, newId });
    const r2 = planFieldEdit({ brief: r.brief, stage: "converging", entryMode: "conversation", messageId: "cnm_h", path: "core_hook", value: "잔혹한 고문 장면이 매 화 나온다", lists: DEFAULT_SAFETY_LISTS, flipLimit: 3, newId });
    expect(r2.brief.field_provenance.core_hook!.slot_state).toBe("proposed");
    const codes = submitBlockers({ ...r2.brief, checks: runDeterministicChecks(r2.brief, DEFAULT_SAFETY_LISTS) }).map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(["age_rating_exceeded", "missing_required"]));
  });

  it("academy/romance needs age bands; minors in romance are blocked (INV-CON-12, CT-23)", () => {
    let b = filled();
    b = planFieldEdit({ brief: b, stage: "diverging", entryMode: "conversation", messageId: "cnm_t", path: "category.trope_labels", value: "아카데미, 로맨스", lists: DEFAULT_SAFETY_LISTS, flipLimit: 3, newId }).brief;
    expect(requiredPaths(b.content)).toContain("protagonist.age_band");
    expect(submitBlockers(b).map((x) => x.code)).toContain("age_band_unknown");
    b = planFieldEdit({ brief: b, stage: "diverging", entryMode: "conversation", messageId: "cnm_a", path: "protagonist.age_band", value: "청소년", lists: DEFAULT_SAFETY_LISTS, flipLimit: 3, newId }).brief;
    expect(b.content.protagonist?.age_band).toBe("teen");
    expect(submitBlockers(b).map((x) => x.code)).toContain("minor_in_romance");
  });

  it("possession of a real published work blocks (INV-CON-15, CT-25)", () => {
    let b = filled();
    b = planFieldEdit({ brief: b, stage: "diverging", entryMode: "conversation", messageId: "cnm_p", path: "category.trope_labels", value: "빙의", lists: DEFAULT_SAFETY_LISTS, flipLimit: 3, newId }).brief;
    b = planFieldEdit({ brief: b, stage: "diverging", entryMode: "conversation", messageId: "cnm_q", path: "world_rules[item_key=possession]", value: "원작 악역", lists: DEFAULT_SAFETY_LISTS, flipLimit: 3, newId }).brief;
    b = planFieldEdit({ brief: b, stage: "diverging", entryMode: "conversation", messageId: "cnm_r", path: "world_rules[item_key=possession_source]", value: "실제 출간작", lists: DEFAULT_SAFETY_LISTS, flipLimit: 3, newId }).brief;
    expect(submitBlockers(b).map((x) => x.code)).toContain("possession_real_work");
  });

  it("copy request: same-turn values with the title are dropped and recorded (INV-CON-11, CT-20)", () => {
    const b = filled();
    const proposal = conceptTurnProposalSchema.parse({
      copy_request_detected: { work_title: "전지적 독자 시점", quote: "전지적 독자 시점 그대로", message_id: "cnm_c" },
      slot_updates: [{ field_path: "world_rules[item_key=core]", new_value: "전지적 독자 시점의 스타 스트림", origin_claim: "user_stated", evidence_message_id: "cnm_c", evidence_quote: "전지적 독자 시점 그대로", key_phrase: "전지적 독자 시점" }],
    });
    const out = planTurn({ brief: b, stage: "converging", entryMode: "conversation", messages: [userMsg("cnm_c", "전지적 독자 시점 그대로 따라 해 줘")], prompt: prompt("world_rules[item_key=core]"), proposal, runId: "run_1", lists: DEFAULT_SAFETY_LISTS, limits, newId });
    expect(out.brief.content.world_rules?.find((r) => r.item_key === "core")).toBeUndefined();
    expect(out.brief.checks.similarity.copy_requests[0]!.work_title).toBe("전지적 독자 시점");
    expect(out.reply.body).toContain("그대로 따라 할 수는 없습니다");
  });
});

describe("INV-CON-03 seed options are not user evidence by themselves (review regression)", () => {
  const ageOptions: TurnMessage["options"] = [
    { idx: 1, label: "12세", value: "age_12", source: "seed", field_path: "age_rating" },
    { idx: 2, label: "15세", value: "age_15", source: "seed", field_path: "age_rating" },
  ];
  const base = () => {
    const b = emptyWorkingBrief();
    b.content.age_rating = "age_12" as never;
    b.field_provenance["age_rating"] = { origin: "user_stated", slot_state: "confirmed", evidence_message_ids: ["m0"], history_count: 1 };
    return b;
  };
  const claim = (quote: string) =>
    conceptTurnProposalSchema.parse({ slot_updates: [{ field_path: "age_rating", new_value: "age_15", origin_claim: "user_stated", evidence_message_id: "cnm_x", evidence_quote: quote, key_phrase: quote }] });

  it("an LLM claim equal to a seed option does not overwrite a user value when the user never named it", () => {
    const out = planTurn({ brief: base(), stage: "converging", entryMode: "conversation", messages: [userMsg("cnm_x", "글쎄요 생각해 볼게요")], prompt: prompt("age_rating", ageOptions), proposal: claim("15세"), runId: "r", lists: DEFAULT_SAFETY_LISTS, limits, newId });
    expect(out.brief.content.age_rating).toBe("age_12");
    expect(out.brief.field_provenance["age_rating"]).toMatchObject({ origin: "user_stated", slot_state: "confirmed" });
    expect(out.brief.change_proposals.some((p) => p.field_path === "age_rating" && p.new_value === "age_15" && p.status === "pending")).toBe(true);
  });

  it("the same claim applies when the user's message names the option", () => {
    const out = planTurn({ brief: base(), stage: "converging", entryMode: "conversation", messages: [userMsg("cnm_x", "15세로 할게요")], prompt: prompt("age_rating", ageOptions), proposal: claim("15세"), runId: "r", lists: DEFAULT_SAFETY_LISTS, limits, newId });
    expect(out.brief.content.age_rating).toBe("age_15");
    expect(out.brief.field_provenance["age_rating"]).toMatchObject({ origin: "user_stated", slot_state: "confirmed" });
  });

  it("an empty slot filled from an unnamed seed stays proposed, not user_stated", () => {
    const b = emptyWorkingBrief();
    const out = planTurn({ brief: b, stage: "converging", entryMode: "conversation", messages: [userMsg("cnm_x", "글쎄요")], prompt: prompt("age_rating", ageOptions), proposal: claim("15세"), runId: "r", lists: DEFAULT_SAFETY_LISTS, limits, newId });
    expect(out.brief.field_provenance["age_rating"]?.origin).not.toBe("user_stated");
    expect(out.brief.field_provenance["age_rating"]?.slot_state).not.toBe("confirmed");
  });
});

describe("import_concept: dependents extracted with their parents survive (live-test regression)", () => {
  it("a logline listed before changed parent fields is kept (parents are written first)", () => {
    // an earlier import already set the genre / starting condition (not user-owned); a second paste restates them differently
    const first = {
      source_kind: "notes" as const,
      reply_text: "",
      slot_updates: [
        { field_path: "category.genre_label", new_value: "미스터리" },
        { field_path: "protagonist.starting_condition", new_value: "수선집 재봉사" },
      ],
    };
    const b = planImport({ brief: emptyWorkingBrief({ web_channel_id: "chn_web" }), stage: "diverging", message: userMsg("cnm_0", "메모", { kind: "import_text" }), proposal: first, lists: DEFAULT_SAFETY_LISTS, limits, newId }).brief;
    const proposal = {
      source_kind: "synopsis" as const,
      reply_text: "",
      slot_updates: [
        { field_path: "logline", new_value: "옷에 남은 기억을 읽는 재봉사가 사라진 언니를 쫓는다." },
        { field_path: "core_hook", new_value: "옷마다 남은 기억 조각이 하나의 사건으로 이어진다." },
        { field_path: "category.genre_label", new_value: "현대 미스터리" },
        { field_path: "protagonist.starting_condition", new_value: "낡은 수선집을 물려받은 스물아홉 살 재봉사" },
      ],
    };
    const out = planImport({ brief: b, stage: "diverging", message: userMsg("cnm_i", "시놉시스", { kind: "import_text" }), proposal, lists: DEFAULT_SAFETY_LISTS, limits, newId });
    expect(out.brief.content.logline).toBe("옷에 남은 기억을 읽는 재봉사가 사라진 언니를 쫓는다.");
    expect(out.brief.content.category?.genre_label).toBe("현대 미스터리");
    expect(out.brief.field_provenance["logline"]).toMatchObject({ origin: "imported", slot_state: "proposed" });
    expect(sortByQuestionOrder([{ field_path: "logline" }, { field_path: "x.unknown" }, { field_path: "opposition" }, { field_path: "category.genre_label" }]).map((u) => u.field_path)).toEqual([
      "category.genre_label",
      "opposition",
      "x.unknown",
      "logline",
    ]);
  });
});

describe("check_concept_brief real_person flags (live-test regression)", () => {
  it("count only when the flagged name appears in the brief", () => {
    const c = { protagonist: { name: "윤서하" }, opposition: "재개발 조합장 강태오와 배우 김연예" } as never;
    expect(groundedRealPersonName(c, "김연예")).toBe("김연예");
    expect(groundedRealPersonName(c, " 김 연예 ")).toBe("김 연예");
    expect(groundedRealPersonName(c, "")).toBeNull();
    expect(groundedRealPersonName(c, "실존 인물")).toBeNull();
    expect(groundedRealPersonName(c, "홍길동")).toBeNull();
  });
});

describe("main_characters given as \"name: description\" lines (live-test regression)", () => {
  it("splits the name from the sketch", () => {
    expect(splitCharacterText("윤서진: 서하의 언니. 칠 년 전 실종")).toEqual({ name: "윤서진", sketch: "서하의 언니. 칠 년 전 실종" });
    expect(splitCharacterText("강태오(재개발 조합장)")).toEqual({ name: "강태오", sketch: "재개발 조합장" });
    expect(splitCharacterText("백우진 - 형사")).toEqual({ name: "백우진", sketch: "형사" });
    expect(splitCharacterText("서린")).toEqual({ name: "서린", sketch: "" });
    expect(splitCharacterText("회귀 전 S급 헌터에게 배신당해 죽은 F급 짐꾼: 주인공")).toEqual({ name: "회귀 전 S급 헌터에게 배신당해 죽은 F급 짐꾼: 주인공", sketch: "" });
    let k = 0;
    const key = () => `c_${++k}`;
    const fromLines = coerceValue("main_characters", ["윤서하: 주인공. 스물아홉 살 재봉사", "강태오: 재개발 조합장"], key) as Array<{ name: string; sketch: string }>;
    expect(fromLines.map((c) => [c.name, c.sketch])).toEqual([
      ["윤서하", "주인공. 스물아홉 살 재봉사"],
      ["강태오", "재개발 조합장"],
    ]);
    const fromObjects = coerceValue("main_characters", [{ name: "윤서진: 서하의 언니" }, { name: "민혜란", sketch: "단골 손님" }], key) as Array<{ name: string; sketch: string }>;
    expect(fromObjects.map((c) => [c.name, c.sketch])).toEqual([
      ["윤서진", "서하의 언니"],
      ["민혜란", "단골 손님"],
    ]);
  });
});
