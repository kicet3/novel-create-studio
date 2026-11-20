/**
 * 설계 추가 0026 — an entity handle (E1, E2 …) never stays in a stored sentence of the writing pipeline.
 * The only exemption is a "story token" (a handle-looking token inside a real entity name, "E3 구역"); a token that
 * merely appears in the run's input (stored text that already leaked one) is not exempt.
 *  - outline (shown marks): leaked tokens are rewritten to names with the pack's labels, the rest is rejected — and a
 *    token the run's input carried bare (another pack's numbering) is rejected as it stands, never rewritten
 *  - draft / per-scene rewrites / rhythm pass / recap / rework instructions (no marks): repaired or rejected
 *  - storage points (saveVersion, replaceScenes): agent-authored text with a handle is refused; human text is not
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actors } from "../../src/platform/index.js";
import { findHandleTokens, HandleLeakError } from "../../src/modules/agents/index.js";
import { factsChanged, inputHandleTokens, nameOutlineHandles } from "../../src/modules/manuscript/application/writing.js";
import { outlineRetryHold, OUTLINE_MAX_FAILED_IN_A_ROW } from "../../src/modules/manuscript/application/planning.js";
import { authoredHandleTokens, computeSpans, initialSpans } from "../../src/modules/manuscript/domain/attribution.js";
import { diffText } from "../../src/modules/manuscript/domain/diff.js";
import { factsKept } from "../../src/modules/manuscript/domain/text.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import type { ClaudeRequest } from "../support/scripted-claude.js";
import { padScene, POLISHED_SCENE_1, SCRIPTED_DRAFT, SCRIPTED_OUTLINE, SCRIPTED_RECAP, scriptPipeline } from "../support/pipeline-script.js";
import { approveStructure, bibleApproved, decideApproval, drain, planningNovel, type Scope } from "../structure/harness.js";

const DRAFT_SYS = "아웃라인의 씬을 순서대로 본문으로 씁니다";
const POLISH_SYS = "문장 교정자(line_editor)입니다. 주어진 씬의 문장만";
const LEAK_NOTE = "같은 기호가 남아 있습니다";
const isRhythm = (r: ClaudeRequest) => Object.keys((r.schema?.properties ?? {}) as object).includes("rewrites");

describe("0026 pure helpers", () => {
  it("factsKept: without handles it is the strict signature; a handle turned into a name is no fact change", () => {
    const names = ["서이온", "차경혁"];
    expect(factsKept("서이온은 3번 베었다.", "서이온이 3번 베었다.", names)).toBe(true);
    expect(factsKept("서이온은 3번 베었다.", "서이온이 4번 베었다.", names)).toBe(false);
    expect(factsKept("서이온은 베었다.", "차경혁은 베었다.", names)).toBe(false);
    // "E7" is no numeral and the name in its place is no new fact …
    expect(factsKept("E7은 3번 베었다.", "서이온은 3번 베었다.", names)).toBe(false); // (strict: the caller named no handle)
    expect(factsKept("E7은 3번 베었다.", "서이온은 3번 베었다.", names, ["E7"])).toBe(true);
    // … but every other numeral still has to stay, and a name that was there may not disappear
    expect(factsKept("E7은 3번 베었다.", "서이온은 5번 베었다.", names, ["E7"])).toBe(false);
    expect(factsKept("E7은 7번 베었다.", "서이온은 베었다.", names, ["E7"])).toBe(false);
    expect(factsKept("E7과 차경혁이 섰다.", "서이온이 섰다.", names, ["E7"])).toBe(false);
  });

  it("authoredHandleTokens: only the tokens that touch the version's own spans", () => {
    const content = "E7은 웃었다. 한결은 E9를 보았다.";
    const span = (start: number, end: number, originVersionId: string) => ({ start, end, actorType: "agent" as const, actorId: "writer", originVersionId });
    const cut = content.indexOf("한결");
    expect(authoredHandleTokens(content, [span(0, cut, "old"), span(cut, content.length, "new")], "new")).toEqual(["E9"]);
    expect(authoredHandleTokens(content, [span(0, content.length, "new")], "new")).toEqual(["E7", "E9"]);
    // a span boundary inside a token still counts as touching it
    expect(authoredHandleTokens(content, [span(0, 1, "old"), span(1, 3, "new"), span(3, content.length, "old")], "new")).toEqual(["E7"]);
    expect(authoredHandleTokens(content, [span(0, content.length, "old")], "new")).toEqual([]);
  });

  it("authoredHandleTokens: a rewrite so large that the diff collapses does not blame the version for an inherited token", () => {
    // three scenes; 1 and 3 are rewritten word for word (> diffText's edit budget), scene 2 — typed by the author — stays
    const words = (tag: string) => Array.from({ length: 1300 }, (_x, i) => `${tag}${i}`).join(" ");
    const middle = "작가가 직접 쓴 문장이다. E7 비자를 받았다.";
    const parent = `${words("가")}\n\n${middle}\n\n${words("나")}`;
    const next = `${words("다")}\n\n${middle}\n\n${words("라")}`;
    const user = { actorType: "user" as const, actorId: "u1" };
    const agent = { actorType: "agent" as const, actorId: "writer" };
    const ops = diffText(parent, next);
    const { spans } = computeSpans(initialSpans(parent.length, user, "mnv_old"), ops, next.length, agent, "mnv_new");
    // the collapsed diff attributes the untouched middle to the new version …
    expect(spans.filter((x) => x.originVersionId === "mnv_new").some((x) => x.start <= next.indexOf("E7") && next.indexOf("E7") < x.end)).toBe(true);
    expect(authoredHandleTokens(next, spans, "mnv_new")).toEqual(["E7"]);
    // … but the version has no more "E7" than its parent: nothing was written
    expect(authoredHandleTokens(next, spans, "mnv_new", parent)).toEqual([]);
    // one more than the parent has → written by this version
    const leaked = `${next}\n\nE7은 웃었다. E9도 웃었다.`;
    const again = computeSpans(initialSpans(parent.length, user, "mnv_old"), diffText(parent, leaked), leaked.length, agent, "mnv_new").spans;
    expect(authoredHandleTokens(leaked, again, "mnv_new", parent)).toEqual(["E7", "E9"]);
  });

  it("outline (P2): this pack's handles become names; a token the input carried bare is another numbering — left as it is and rejected", () => {
    const labels = ["한서율", "서이온", "강도윤", "민하린", "차경혁", "백무겸", "윤채아"];
    const context = { messages: [{ role: "user" as const, content: "- 한서율 [E1]\n- 서이온 (E2)\n[이전 화 계획] E7은 숨을 고른다." }] };
    const data = JSON.stringify({ episodePlan: { summary: "E1은 판정 안내를 듣는다." } });
    // marks ("[E1]", "(E2)") are this pack's; bare tokens of stored text are not
    expect([...inputHandleTokens(context, data)].sort()).toEqual(["E1", "E7"]);
    const draft = { summary: "E2가 재활 기록을 대조한다. E1은 판정 안내를 듣고 E7은 숨을 고른다.", outline: { scenes: [{ summary: "서이온(E2)이 문을 연다. E3 구역이다.", pov_entity_id: "E2", participant_entity_ids: ["E1", "E7"] }] } };
    const r = nameOutlineHandles(draft, labels, new Set(["E3"]), inputHandleTokens(context, data));
    // E2 was only ever a mark of this pack → 서이온; E1 / E7 keep their text (never "한서율은 …" / "윤채아는 …")
    expect(r.value.summary).toBe("서이온이 재활 기록을 대조한다. E1은 판정 안내를 듣고 E7은 숨을 고른다.");
    expect(r.value.outline.scenes[0]!.summary).toBe("서이온이 문을 연다. E3 구역이다.");
    expect(r.value.outline.scenes[0]).toMatchObject({ pov_entity_id: "E2", participant_entity_ids: ["E1", "E7"] }); // reference fields
    expect(r.left.map((l) => `${l.path}=${l.token}`)).toEqual(["summary=E1", "summary=E7"]);
    // nothing foreign in the input → every token of the table is rewritten, nothing is left
    const clean = nameOutlineHandles(draft, labels, new Set(["E3"]), new Set());
    expect(clean.value.summary).toBe("서이온이 재활 기록을 대조한다. 한서율은 판정 안내를 듣고 윤채아는 숨을 고른다.");
    expect(clean.left).toEqual([]);
  });

  it("factsChanged: symbol → name alone keeps the facts, but handles that went away force the re-check (their mentions were never extracted)", () => {
    const names = ["서이온"];
    const none = new Set<string>();
    expect(factsChanged("서이온은 3번 베었다.", "서이온은 세 차례 3번 베었다.", names, none)).toBe(false);
    expect(factsChanged("서이온은 3번 베었다.", "서이온은 5번 베었다.", names, none)).toBe(true);
    // the polish turned E7 into the name: fewer handles than the checked text had → re-check
    expect(factsChanged("E7은 3번 베었다.", "서이온은 3번 베었다.", names, none)).toBe(true);
    // the handle is still there (nothing fixed) and nothing else changed → no re-check for the wording
    expect(factsChanged("E7은 3번 베었다.", "E7은 3번 깊이 베었다.", names, none)).toBe(false);
    // a story token is no handle at all
    expect(factsChanged("E3 구역은 조용했다.", "E3 구역은 고요했다.", names, new Set(["E3"]))).toBe(false);
  });

  it("scheduler: a failed first outline is not started again at once, and not at all after a few failures in a row", () => {
    const now = new Date("2026-11-20T12:00:00Z");
    const ago = (min: number) => new Date(now.getTime() - min * 60_000);
    expect(outlineRetryHold([], now)).toBeNull();
    expect(outlineRetryHold([{ status: "done", at: ago(1) }], now)).toBeNull();
    expect(outlineRetryHold([{ status: "failed", at: ago(1) }], now)).toBe("backoff");
    expect(outlineRetryHold([{ status: "failed", at: ago(11) }], now)).toBeNull();
    // the backoff doubles with every failure in a row; cancelled tasks do not count
    const two = [{ status: "failed", at: ago(11) }, { status: "cancelled", at: ago(5) }, { status: "failed", at: ago(40) }];
    expect(outlineRetryHold(two, now)).toBe("backoff");
    expect(outlineRetryHold(two, new Date(now.getTime() + 10 * 60_000))).toBeNull();
    const many = Array.from({ length: OUTLINE_MAX_FAILED_IN_A_ROW }, (_x, i) => ({ status: "failed", at: ago(600 * (i + 1)) }));
    expect(outlineRetryHold(many, now)).toBe("failed");
    // a later success (a person retried the task) ends the streak
    expect(outlineRetryHold([{ status: "done", at: ago(1) }, ...many], now)).toBeNull();
  });
});

describe("0026 on the writing pipeline (the run's input already carries leaked handles)", () => {
  let t: TestCore;
  let scope: Scope;
  let e1Name = "";
  const ms = () => t.modules.manuscript.service;
  const ep1 = () => ms().getEpisodeByNo(scope, 1);

  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply(
      // the planner copies the handle of its input into sentences and proposes a handle as a new entity's name
      {
        times: 1,
        when: { schemaHas: ["summary", "outline"] },
        json: (r: ClaudeRequest) => {
          e1Name = /- (\S+) \[E1\]/.exec(r.prompt)?.[1] ?? "";
          return {
            ...SCRIPTED_OUTLINE,
            summary: "E1은 회귀를 깨닫고 손등의 흉터를 발견한다.",
            outline: {
              ...SCRIPTED_OUTLINE.outline,
              scenes: [
                { key: "s1", summary: `새벽 여관 방에서 ${e1Name}(E1)이 눈을 뜬다.`, pov_entity_id: "E1" },
                { key: "s2", summary: "거울 앞에서 흉터를 발견한다." },
              ],
              new_entity_proposals: [{ local_key: "n1", entity_type: "character", proposed_name: "E9", rationale: "새 인물" }],
            },
          };
        },
      },
      // the writer's first sample writes a symbol for a name; the retry is the scripted draft
      { times: 1, when: { text: true, system: DRAFT_SYS }, text: SCRIPTED_DRAFT.replace("한결은 새벽", "E7은 새벽") },
      // the line editor's first answer for scene 1 carries a symbol; the repair turn gets the scripted scene
      { times: 1, when: { text: true, system: POLISH_SYS, prompt: '"sceneOrd":1' }, text: POLISHED_SCENE_1.replace("한결은 새벽", "E7은 새벽") },
      { times: 1, when: { schemaHas: ["handoff", "summary_lines"] }, json: { ...SCRIPTED_RECAP, summary_lines: ["E7이 십 년 전 새벽 여관 방에서 눈을 뜬다.", ...SCRIPTED_RECAP.summary_lines.slice(1)] } },
      // plan_rework: a symbol of its own first, then a quote of what the author typed
      { times: 1, when: { schemaHas: ["target_scene_ords"] }, json: { target_scene_ords: [2], instructions: "E5의 대사를 줄입니다." } },
      { times: 1, when: { schemaHas: ["target_scene_ords"] }, json: { target_scene_ords: [2], instructions: "'E12' 같은 표기를 이름으로 고칩니다." } },
    );
    scriptPipeline(t.claude);
    ({ scope } = await planningNovel(t, { title: "핸들 누수 작품" }));
    await bibleApproved(t, scope);
    await approveStructure(t, scope);
    await drain(t, scope, async () => (await t.modules.novel.service.listArcs(scope)).some((a) => a.status === "plan_awaiting_approval"));
    // stored plan text written before 0025: handles inside sentences (fed back into every later run)
    await t.testDb.exec(`UPDATE episodes SET plan_summary = 'E1은 십 년 전 새벽에 눈을 뜬다. E7이 그를 지켜본다.' WHERE novel_id = '${scope.novelId}' AND episode_no = 1`);
    expect((await decideApproval(t, scope, "arc_plan", "approved")).status).toBeLessThan(300);
    await drain(t, scope, async () => (await ep1()).status === "awaiting_approval", 150);
  }, 120_000);
  afterAll(() => t.close());

  it("outline: a handle the input already carried bare is never rewritten with this pack's names — the answer is rejected and the retry is stored", async () => {
    expect(e1Name).not.toBe("");
    const outlineReq = t.claude.requests.find((r) => Object.keys((r.schema?.properties ?? {}) as object).includes("outline"))!;
    expect(outlineReq.prompt).toContain("E1은 십 년 전 새벽에 눈을 뜬다"); // the token was in the run's input (no exemption)
    // the first answer ("E1은 회귀를 깨닫고 …") was refused with the issue; the model was asked again
    const failed = await t.testDb.query<{ error_message: string }>(`SELECT error_message FROM runs WHERE novel_id = '${scope.novelId}' AND error_message LIKE '아웃라인 문장에%'`);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0]!.error_message).toContain("'E1'");
    expect(t.claude.requests.filter((r) => Object.keys((r.schema?.properties ?? {}) as object).includes("outline")).length).toBeGreaterThanOrEqual(2);
    const ep = await ep1();
    const outline = await ms().getVersion(scope, ep.outlineVersionId!);
    const data = outline.outlineData as { scenes: Array<{ summary: string; pov_entity_id: string | null }>; new_entity_proposals: unknown[] };
    expect(outline.content).toBe(SCRIPTED_OUTLINE.summary); // the retry's answer, not "<this pack's E1>은 회귀를 깨닫고 …"
    expect(JSON.stringify(data)).not.toContain("E9"); // a handle is never a new entity's name
    expect(findHandleTokens(`${outline.content}\n${JSON.stringify(data.scenes.map((s) => s.summary))}`)).toEqual([]);
  });

  it("draft: a symbol in the prose fails the run (even though the input carries that token) and the retry is stored", async () => {
    const drafts = t.claude.requests.filter((r) => r.schema === null && r.system.includes(DRAFT_SYS));
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    expect(drafts[0]!.prompt).toContain("E7이 그를 지켜본다");
    expect(drafts[0]!.system).toContain("기호나 ID를 이름 자리에 쓰지 않습니다");
    const ep = await ep1();
    const versions = await ms().listVersions(scope, ep.id);
    for (const v of versions.filter((x) => x.kind !== "outline")) expect(findHandleTokens(v.content), `version ${v.versionNo} (${v.kind})`).toEqual([]);
    const failed = await t.testDb.query<{ error_message: string }>(`SELECT error_message FROM runs WHERE novel_id = '${scope.novelId}' AND error_message LIKE '%E7%'`);
    expect(failed.some((r) => r.error_message.includes("기호 대신 인물·장소의 실제 이름을 쓰세요"))).toBe(true);
  });

  it("polish: a rewritten scene with a symbol goes back to the editor once with the issue; the instruction carries the rule", async () => {
    const polish = t.claude.requests.filter((r) => r.schema === null && r.system.includes(POLISH_SYS));
    expect(polish[0]!.system).toContain("E와 숫자로 된 기호는 이름이 아닙니다");
    const repairs = polish.filter((r) => r.prompt.includes(LEAK_NOTE));
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.messages.at(-1)).toMatchObject({ role: "user" });
    expect(repairs[0]!.messages.at(-1)!.content).toContain("'E7'");
    expect(repairs[0]!.messages.at(-2)).toMatchObject({ role: "assistant" });
    const ep = await ep1();
    const current = await ms().getVersion(scope, ep.currentVersionId!);
    expect(current.agentRole).toBe("line_editor");
    expect(current.content).toContain(POLISHED_SCENE_1);
  });

  it("recap: a symbol in the summary is repaired before the recap is stored", async () => {
    expect((await decideApproval(t, scope, "episode", "approved")).status).toBeLessThan(300);
    const ep = await ep1();
    const recaps = () => t.testDb.query<{ summary: string; handoff: unknown }>(`SELECT summary, handoff FROM episode_recaps WHERE episode_id = '${ep.id}'`);
    await drain(t, scope, async () => (await recaps()).length > 0);
    const [recap] = await recaps();
    expect(findHandleTokens(`${recap!.summary}\n${JSON.stringify(recap!.handoff)}`)).toEqual([]);
    expect(recap!.summary).toContain(SCRIPTED_RECAP.summary_lines[1]);
    const calls = t.claude.requests.filter((r) => Object.keys((r.schema?.properties ?? {}) as object).includes("summary_lines"));
    expect(calls[0]!.system).toContain("E와 숫자로 된 기호는 이름이 아니므로");
    expect(calls.some((r) => r.prompt.includes("화 정리 summary_lines[0]") && r.prompt.includes(LEAK_NOTE))).toBe(true);
  }, 60_000);

  it("plan_rework: the instructions may quote a symbol the author typed in the rejection, never one of their own", async () => {
    const r = await t.http("POST", `/api/novels/${scope.novelId}/episodes/1/revision-request`, { decisionNote: "E12 같은 표기가 어색합니다", reworkFrom: "polish" });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const ep = await ep1();
    const reworked = async () =>
      (await t.modules.orchestration.service.listTasks(scope, { kinds: ["polish_episode"], episodeId: ep.id, includeCancelled: true, limit: 50 })).find((x) => (x.input as { rework_cause?: string }).rework_cause === "rejection");
    await drain(t, scope, async () => !!(await reworked()));
    expect(((await reworked())!.input as { instructions?: string }).instructions).toBe("'E12' 같은 표기를 이름으로 고칩니다.");
    const calls = t.claude.requests.filter((x) => Object.keys((x.schema?.properties ?? {}) as object).includes("target_scene_ords"));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("'E5'");
    expect(calls[1]!.prompt).toContain(LEAK_NOTE);
    await drain(t, scope, async () => (await ep1()).status === "awaiting_approval", 150);
  }, 60_000);

  it("storage points: an agent's text with a handle is refused; a human's text and a real name like 'E3 구역' are not", async () => {
    const ep = await ep1();
    const base = (await ms().getVersion(scope, ep.currentVersionId!)).content;
    const [run] = await t.testDb.query<{ id: string }>(`SELECT id FROM runs WHERE novel_id = '${scope.novelId}' LIMIT 1`);
    const agent = actors.agent("writer", run!.id);
    const rollback = new Error("rollback");
    const inTx = (fn: Parameters<typeof t.platform.uow.run>[0]) =>
      t.platform.uow.run(async (tx) => {
        await fn(tx);
        throw rollback; // nothing of this test is kept
      });
    const save = (tx: Parameters<Parameters<typeof t.platform.uow.run>[0]>[0], content: string, author: typeof agent | typeof t.owner) => ms().saveVersion(tx, scope, ep.id, { kind: "revision", content, author, modelId: author.type === "agent" ? "test" : null });

    // an agent version that writes a handle is refused with the internal error
    const leak = await inTx((tx) => save(tx, `${base}\n\nE7은 문을 닫았다.`, agent)).catch((e: unknown) => e);
    expect(leak).toBeInstanceOf(HandleLeakError);
    expect((leak as HandleLeakError).message).toContain("content=E7");
    // an outline's sentences too; its reference fields are not sentences
    const outlineOf = (summary: string) => ({ beats: [], scenes: [{ key: "s1", summary, pov_entity_id: "E1", participant_entity_ids: ["E2"] }], new_entity_proposals: [], hook: "", target_chars: 5000 });
    const outlineLeak = await inTx((tx) => ms().saveVersion(tx, scope, ep.id, { kind: "outline", content: "한결이 눈을 뜬다.", outlineData: outlineOf("E2가 문을 연다."), author: agent, modelId: "test" })).catch((e: unknown) => e);
    expect(outlineLeak).toBeInstanceOf(HandleLeakError);
    await expect(inTx((tx) => ms().saveVersion(tx, scope, ep.id, { kind: "outline", content: "한결이 눈을 뜬다.", outlineData: outlineOf("한결이 문을 연다."), author: agent, modelId: "test" }))).rejects.toBe(rollback);
    // a token right after a line break is found too (scanned as a value, not as escaped JSON text)
    expect(await inTx((tx) => ms().saveVersion(tx, scope, ep.id, { kind: "outline", content: "한결이 눈을 뜬다.", outlineData: outlineOf("문이 닫혔다.\nE7은 숨을 골랐다."), author: agent, modelId: "test" })).catch((e: unknown) => e)).toBeInstanceOf(HandleLeakError);

    // what a human typed is stored as typed, and an agent version that inherits it is not judged for it
    await expect(
      inTx(async (tx) => {
        const human = await save(tx, `${base}\n\nE7은 문을 닫았다.`, t.owner);
        await save(tx, `${human.content}\n\n한결은 돌아섰다.`, agent);
        const again = await save(tx, `${human.content}\n\n한결은 돌아섰다.\n\nE9가 웃었다.`, agent).catch((e: unknown) => e);
        expect(again).toBeInstanceOf(HandleLeakError);
        expect((again as HandleLeakError).leaks.map((l) => l.token)).toEqual(["E9"]);
      }),
    ).rejects.toBe(rollback);

    // an agent can never make a name that carries a handle token (it would exempt the token for the whole novel) …
    const world = actors.agent("world_keeper", run!.id);
    await expect(t.platform.uow.run((tx) => t.modules.ontology.service.createEntity(tx, scope, { entityType: "organization", preferredName: { surface: "E12 일행" } }, world))).rejects.toMatchObject({ code: "handle_token_in_name" });
    expect([...(await t.modules.ontology.service.storyHandleTokens(scope))]).toEqual([]);
    await expect(inTx((tx) => save(tx, `${base}\n\n한결은 E3 구역으로 향했다.`, agent))).rejects.toBeInstanceOf(HandleLeakError);
    // … a real entity name a person gave is story text
    await t.platform.uow.run((tx) => t.modules.ontology.service.createEntity(tx, scope, { entityType: "place", preferredName: { surface: "E3 구역" }, status: "active" }, t.owner));
    expect([...(await t.modules.ontology.service.storyHandleTokens(scope))]).toEqual(["E3"]);
    await expect(inTx((tx) => save(tx, `${base}\n\n한결은 E3 구역으로 향했다.`, agent))).rejects.toBe(rollback);

    // scene summaries an agent writes
    const scenes = await ms().listScenes(scope, ep.id);
    const drafts = (summary: string) => scenes.map((s, i) => ({ ord: s.ord, charStart: s.charStart, charEnd: s.charEnd, summary: i === 0 ? summary : s.summary }));
    const sceneLeak = await inTx((tx) => ms().replaceScenes(tx, scope, ep.currentVersionId!, drafts("E7이 눈을 뜬다."), agent)).catch((e: unknown) => e);
    expect(sceneLeak).toBeInstanceOf(HandleLeakError);
    await expect(inTx((tx) => ms().replaceScenes(tx, scope, ep.currentVersionId!, drafts("한결이 E3 구역에서 눈을 뜬다."), agent))).rejects.toBe(rollback);
    await expect(inTx((tx) => ms().replaceScenes(tx, scope, ep.currentVersionId!, drafts("E7이 눈을 뜬다."), t.owner))).rejects.toBe(rollback);
  });
});

describe("0026 on the rhythm pass", () => {
  const H1 = "한결은 새벽 안개가 스며드는 여관 방에서 눈을 떴다. 창밖으로 들리는 종소리는 십 년 전 그날과 똑같았다.";
  const H2 = "거울 앞에 선 한결은 손등에 새겨진 흉터를 내려다보았다. 흉터는 희미하게 빛나다가 이내 사그라들었다.";
  const CHOPPY_A = "그는 문을 열었다. 복도는 어두웠다. 바람이 차가웠다. 그는 숨을 삼켰다.";
  const LEAKY_A = "E7이 문을 열자 어두운 복도에서 차가운 바람이 밀려왔고, 그는 숨을 삼켰다.";
  const LONG_P = "그는 오래전 이 복도를 지나며 들었던 발소리와 웃음소리를 하나하나 떠올리면서, 그때 놓친 것이 무엇이었는지 끝내 알아내야 한다고 생각했다.";
  const CHOPPY_B = "칼날이 번뜩였다. 피가 튀었다. 그는 물러섰다. 상대가 웃었다.";
  const GOOD_B = "칼날이 번뜩이며 피가 튀자 그는 물러섰고, 상대는 웃었다.";
  const DRAFT = `${padScene(`${H1}\n\n${CHOPPY_A}\n\n${LONG_P}\n\n${CHOPPY_B}`, 2700)}\n\n* * *\n\n${padScene(H2, 2700)}`;
  const sceneOf = (r: ClaudeRequest) => (JSON.parse(r.prompt.slice(r.prompt.lastIndexOf("\n{") + 1)) as { text: string }).text.trim().replace(/\n[ \t]*\*[ \t]*\*[ \t]*\*[ \t]*$/u, "").trim();
  const blocksOf = (r: ClaudeRequest) => (JSON.parse(r.prompt.slice(r.prompt.lastIndexOf("\n{") + 1)) as { blocks: Array<{ block: number; text: string }> }).blocks;
  let t: TestCore;
  let scope: Scope;

  beforeAll(async () => {
    t = await createTestCore();
    const map: Record<string, string> = { [CHOPPY_A]: LEAKY_A, [CHOPPY_B]: GOOD_B };
    t.claude.reply(
      { times: Infinity, when: { text: true, system: DRAFT_SYS }, text: DRAFT },
      { times: Infinity, when: { text: true, system: POLISH_SYS }, text: (r) => sceneOf(r) },
      { times: Infinity, when: { schemaHas: ["rewrites"] }, json: (r: ClaudeRequest) => ({ rewrites: blocksOf(r).flatMap((b) => (map[b.text] ? [{ block: b.block, text: map[b.text]! }] : [])) }) },
    );
    scriptPipeline(t.claude);
    ({ scope } = await planningNovel(t, { title: "리듬 핸들 작품" }));
    await bibleApproved(t, scope);
    await approveStructure(t, scope);
    await drain(t, scope, async () => (await t.modules.novel.service.listArcs(scope)).some((a) => a.status === "plan_awaiting_approval"));
    expect((await decideApproval(t, scope, "arc_plan", "approved")).status).toBeLessThan(300);
    await drain(t, scope, async () => (await t.modules.manuscript.service.getEpisodeByNo(scope, 1)).status === "awaiting_approval", 150);
  }, 120_000);
  afterAll(() => t.close());

  it("a block whose rewrite carries a symbol keeps the original; the other block is still rewritten", async () => {
    const calls = t.claude.requests.filter(isRhythm);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain("E와 숫자로 된 기호는 이름이 아닙니다");
    const ep = await t.modules.manuscript.service.getEpisodeByNo(scope, 1);
    const current = await t.modules.manuscript.service.getVersion(scope, ep.currentVersionId!);
    expect(current.content).toContain(CHOPPY_A);
    expect(current.content).not.toContain("E7");
    expect(current.content).toContain(GOOD_B);
    expect(current.rhythm).toMatchObject({ pass: { mode: "pipeline", rewrittenBlocks: 1, keptBlocks: 1 } });
  });
});
