/**
 * Live scenario (real Claude), shared by both lanes of claude.live.test.ts. Runs through the app's real HTTP API and
 * services on a test core (temp NCS_HOME + PGlite, random 127.0.0.1 port — never 3100):
 *   untitled novel → 1 concept turn (Korean premise) → schema-valid ConceptTurnProposal + 3–5 title suggestions →
 *   choose a title → import a synopsis (1 call) → confirm extracted fields (form edits for any gaps, no calls) →
 *   submit (check_concept_brief, 1 call) → approve (no call) → AI cast draft with 1 sub-protagonist (1 call) →
 *   exactly 1 protagonist, ≤ 1 sub-protagonist, Korean names.
 * Every ModelCallPort.call is recorded (purpose, schema, duration, validated value) — never credentials.
 */
import { sql } from "@ncs/db/orm";
import { expect } from "vitest";
import { conceptTurnProposalSchema, importProposalSchema, briefCheckProposalSchema } from "../../src/modules/concept/domain/proposal.js";
import { castDraftProposalSchema } from "../../src/modules/cast/application/prompts.js";
import type { ModelCallInput, ModelCallOutput } from "../../src/modules/llm/index.js";
import type { TestCore } from "../../test/support/test-core.js";

export interface RecordedCall {
  purpose: string;
  schemaName: string | null;
  modelId: string | null;
  ms: number;
  ok: boolean;
  error?: string;
  value?: unknown;
}

export interface ScenarioReport {
  lane: string;
  calls: RecordedCall[];
  providerCalls: number;
  titleSuggestions: string[];
  chosenTitle: string;
  briefApproved: boolean;
  cast: Array<{ role: string; name: string }>;
  totalMs: number;
}

/** wraps llm.modelCalls.call (concept and cast resolve it at call time) */
export function recordModelCalls(t: TestCore): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const port = t.modules.llm.service.modelCalls;
  const real = port.call.bind(port);
  port.call = async <T>(input: ModelCallInput<T>): Promise<ModelCallOutput<T>> => {
    const started = Date.now();
    const schemaName = input.output.kind === "object" ? input.output.schemaName : null;
    try {
      const out = await real(input);
      calls.push({ purpose: input.purpose, schemaName, modelId: out.modelId, ms: Date.now() - started, ok: true, value: out.value });
      return out;
    } catch (err) {
      calls.push({ purpose: input.purpose, schemaName, modelId: null, ms: Date.now() - started, ok: false, error: `${(err as Error).name}: ${(err as Error).message}`.slice(0, 300) });
      throw err;
    }
  };
  return calls;
}

const HANGUL = /[가-힣]/;

export const PREMISE =
  "현대 미스터리 장편을 쓰고 싶어요. 서울 변두리의 낡은 수선집을 물려받은 스물아홉 살 재봉사 주인공이, 손님이 맡긴 옷을 고칠 때마다 그 옷 주인의 잃어버린 기억 한 조각을 보게 됩니다. 주인공은 이 능력으로 칠 년 전 사라진 언니의 행방을 쫓습니다.";

/** synopsis pasted in import mode: every required field stated explicitly (no characters besides protagonist + one antagonist) */
export const SYNOPSIS = [
  "장르: 현대 미스터리",
  "연령 등급: 15세 이용가",
  "주인공 출발 조건: 서울 변두리의 낡은 수선집을 물려받은 스물아홉 살 재봉사 윤서하. 옷을 고칠 때마다 옷 주인의 잃어버린 기억 한 조각을 본다.",
  "주인공의 욕망: 칠 년 전 사라진 언니 윤서진이 어디로 갔는지 밝혀내고 싶다.",
  "대립: 언니의 실종을 덮으려는 재개발 조합장 강태오와 그를 돕는 사람들.",
  "핵심 훅: 손님이 맡긴 옷마다 남은 기억 조각이 하나의 사건으로 이어진다.",
  "결말 방향: 서하가 언니의 마지막 기억을 되찾고 조합장의 비리를 세상에 드러낸다.",
  "로그라인: 옷에 남은 기억을 읽는 재봉사가 사라진 언니의 행방을 쫓아 동네의 숨겨진 비밀을 파헤친다.",
].join("\n");

/** form edits (no model call) for required fields the import left empty */
const FALLBACK_FIELDS: Record<string, unknown> = {
  "category.genre_label": "현대 미스터리",
  age_rating: "age_15",
  "protagonist.starting_condition": "서울 변두리의 낡은 수선집을 물려받은 스물아홉 살 재봉사 윤서하. 옷을 고칠 때마다 옷 주인의 잃어버린 기억 한 조각을 본다.",
  "protagonist.desire": "칠 년 전 사라진 언니의 행방을 밝혀내고 싶다.",
  "protagonist.age_band": "adult",
  opposition: "언니의 실종을 덮으려는 재개발 조합장 강태오",
  core_hook: "손님이 맡긴 옷마다 남은 기억 조각이 하나의 사건으로 이어진다.",
  ending_direction: "서하가 언니의 마지막 기억을 되찾고 조합장의 비리를 드러낸다.",
  logline: "옷에 남은 기억을 읽는 재봉사가 사라진 언니의 행방을 쫓아 동네의 숨겨진 비밀을 파헤친다.",
};

async function expectOk<T = any>(p: Promise<{ status: number; body: T }>, status: number, what: string): Promise<T> {
  const r = await p;
  expect(r.status, `${what}: ${JSON.stringify(r.body).slice(0, 500)}`).toBe(status);
  return r.body;
}

/** run queued tasks until the novel has nothing ready (a retried task gets its back-off cleared, at most `rounds`) */
async function drain(t: TestCore, novelId: string, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await t.testDb.exec(`UPDATE tasks SET not_before_at = NULL WHERE novel_id = '${novelId}'`);
    const n = await t.modules.orchestration.service.runOnce();
    const open = (await t.testDb.db.execute(sql`SELECT count(*)::int AS n FROM tasks WHERE novel_id = ${novelId} AND status IN ('pending', 'ready', 'running')`)) as unknown as { rows: Array<{ n: number }> };
    if (!n || !open.rows[0]!.n) return;
  }
}

export async function runLiveScenario(t: TestCore, lane: string, opts: { modelOverride?: string } = {}): Promise<ScenarioReport> {
  const t0 = Date.now();
  const calls = recordModelCalls(t);

  // 1. untitled novel
  const novel = await expectOk(t.http("POST", "/api/novels", { ageRating: "age_15", entryMode: "conversation" }), 201, "create novel");
  expect(novel.title).toBe("제목 미정");
  const base = `/api/novels/${novel.id}`;

  if (opts.modelOverride) {
    const bindings = (await expectOk(t.http("GET", `${base}/model-bindings`), 200, "bindings")).items as Array<{ agentRole: string; providerProfileId: string }>;
    for (const role of ["concept_partner", "continuity_editor"]) {
      const b = bindings.find((x) => x.agentRole === role)!;
      await expectOk(t.http("PATCH", `${base}/model-bindings/${role}`, { providerProfileId: b.providerProfileId, modelId: opts.modelOverride }), 200, `bind ${role}`);
    }
  }

  // 2. one concept turn with a Korean premise
  let view = await expectOk(t.http("GET", `${base}/concept/session`), 200, "session");
  const sid = view.session.id as string;
  const posted = await expectOk(t.http("POST", `${base}/concept/sessions/${sid}/messages`, { body: PREMISE }), 201, "post premise");
  expect(posted.taskId).toBeTruthy();
  await drain(t, novel.id);
  const turnCalls = calls.filter((c) => c.schemaName === "ConceptTurnProposal");
  expect(turnCalls.length, JSON.stringify(calls.map(({ value, ...c }) => c))).toBeGreaterThanOrEqual(1);
  const turn = turnCalls.find((c) => c.ok);
  expect(turn, `concept turn failed: ${turnCalls.map((c) => c.error).join(" | ")}`).toBeTruthy();
  const proposal = conceptTurnProposalSchema.parse(turn!.value);
  expect(proposal.reply_text).toMatch(HANGUL);

  view = await expectOk(t.http("GET", `${base}/concept/session`), 200, "session after turn");
  const titles = (view.titleSuggestions.items as Array<{ title: string; reason: string }>).map((x) => x.title);
  expect(titles.length, `title suggestions: ${JSON.stringify(proposal.title_suggestions)}`).toBeGreaterThanOrEqual(3);
  expect(titles.length).toBeLessThanOrEqual(5);
  for (const title of titles) expect(title).toMatch(HANGUL);
  const agentReply = ((await expectOk(t.http("GET", `${base}/concept/sessions/${sid}/messages`), 200, "messages")).items as Array<{ authorKind: string; body: string }>)
    .filter((m) => m.authorKind === "agent")
    .pop();
  expect(agentReply?.body ?? "").toMatch(HANGUL);

  // 3. choose a title
  const chosenTitle = titles[0]!;
  await expectOk(t.http("POST", `${base}/concept/sessions/${sid}/title`, { title: chosenTitle }), 200, "choose title");
  const titled = await expectOk(t.http("GET", base), 200, "novel");
  expect(titled).toMatchObject({ title: chosenTitle, titleSource: "user" });

  // 4. brief: import a synopsis (1 call), confirm, fill gaps by form, submit (check, 1 call), approve
  await expectOk(t.http("POST", `${base}/concept/sessions/${sid}/entry-mode`, { mode: "import" }), 200, "entry-mode import");
  await expectOk(t.http("POST", `${base}/concept/sessions/${sid}/messages`, { body: SYNOPSIS, kind: "import_text" }), 201, "import text");
  await drain(t, novel.id);
  const importCall = calls.find((c) => c.schemaName === "ConceptImportProposal" && c.ok);
  if (importCall) importProposalSchema.parse(importCall.value);
  await expectOk(t.http("POST", `${base}/concept/sessions/${sid}/confirm`, { which: "imported" }), 200, "confirm imported");
  view = await expectOk(t.http("GET", `${base}/concept/session`), 200, "session after import");
  // like a user in the brief panel: confirm proposed values as they are (e.g. the turn's agent proposals), type the rest
  const filledByForm: string[] = [];
  for (let pass = 0; pass < 3 && view.progress.missing.length; pass++) {
    const missing = (view.progress.missing as Array<{ path: string }>).map((m) => m.path);
    const prov = view.workingBrief.field_provenance as Record<string, { slot_state: string } | undefined>;
    const proposed = missing.filter((p) => prov[p]?.slot_state === "proposed");
    if (proposed.length) {
      await expectOk(t.http("POST", `${base}/concept/sessions/${sid}/confirm`, { paths: proposed }), 200, "confirm proposed");
      filledByForm.push(...proposed.map((p) => `${p}(confirmed)`));
    }
    for (const path of missing.filter((p) => !proposed.includes(p))) {
      const value = FALLBACK_FIELDS[path];
      if (value === undefined) continue;
      await expectOk(t.http("PATCH", `${base}/concept/sessions/${sid}/brief`, { path, value }), 200, `form ${path}`);
      filledByForm.push(`${path}(typed)`);
    }
    view = await expectOk(t.http("GET", `${base}/concept/session`), 200, "session after form");
  }
  view = await expectOk(t.http("GET", `${base}/concept/session`), 200, "session before submit");
  let briefApproved = false;
  if (view.canSubmit) {
    await expectOk(t.http("POST", `${base}/concept/sessions/${sid}/submit`), 202, "submit");
    await drain(t, novel.id);
    const checkCall = calls.find((c) => c.schemaName === "ConceptBriefCheck" && c.ok) ?? calls.find((c) => c.purpose.includes("check") && c.ok);
    if (checkCall) briefCheckProposalSchema.parse(checkCall.value);
    view = await expectOk(t.http("GET", `${base}/concept/session`), 200, "session after submit");
    expect(view.session.status, `${JSON.stringify(view.blockers)} safety=${JSON.stringify((view.workingBrief.checks as { safety?: unknown })?.safety)} check=${JSON.stringify(checkCall?.value)}`).toBe("awaiting_approval");
    await expectOk(t.http("POST", `${base}/approvals/${view.session.pendingApprovalId}/decision`, { decision: "approved" }), 200, "approve brief");
    const approved = await expectOk(t.http("GET", base), 200, "novel after approval");
    expect(approved.status).toBe("onboarding");
    expect(approved.title).toBe(chosenTitle);
    briefApproved = true;
  }
  expect(briefApproved, `brief not submittable: missing=${JSON.stringify(view.progress.missing)} blockers=${JSON.stringify(view.blockers)}`).toBe(true);

  // 5. AI cast draft with 1 sub-protagonist
  const draft = await expectOk(t.http("POST", `${base}/cast/draft`, { subProtagonistCount: 1, includeAntagonist: true }), 202, "cast draft");
  expect(draft.taskId).toBeTruthy();
  await drain(t, novel.id);
  const castCall = calls.find((c) => c.schemaName !== null && /cast/i.test(c.schemaName) && c.ok);
  expect(castCall, `cast draft failed: ${JSON.stringify(calls.filter((c) => !c.ok).map((c) => c.error))}`).toBeTruthy();
  castDraftProposalSchema.parse(castCall!.value);
  const cast = await expectOk(t.http("GET", `${base}/cast`), 200, "cast");
  expect(cast.lastDraftError ?? null).toBeNull();
  const items = (cast.items as Array<{ role: string; name: string }>).map((c) => ({ role: c.role, name: c.name }));
  expect(items.filter((c) => c.role === "protagonist")).toHaveLength(1);
  expect(items.filter((c) => c.role === "sub_protagonist").length).toBeLessThanOrEqual(1);
  expect(items.length).toBeGreaterThanOrEqual(2);
  for (const c of items) {
    // a person's name, not a description line ("윤서하: 주인공. …" was a real failure)
    expect(c.name, JSON.stringify(items)).toMatch(/^[가-힣][가-힣A-Za-z·\s]{0,11}$/);
    expect(c.name).not.toBe("이름 미정");
  }
  expect(new Set(items.map((c) => c.name.replace(/\s+/g, ""))).size, `duplicate names: ${JSON.stringify(items)}`).toBe(items.length);

  const pc = (await t.testDb.db.execute(sql`SELECT count(*)::int AS n FROM provider_calls WHERE novel_id = ${novel.id}`)) as unknown as { rows: Array<{ n: number }> };
  return {
    lane,
    calls: calls.map((c) => ({ ...c, value: undefined })),
    providerCalls: pc.rows[0]!.n,
    titleSuggestions: titles,
    chosenTitle,
    briefApproved,
    cast: items,
    totalMs: Date.now() - t0,
    ...(filledByForm.length ? { filledByForm } : {}),
  } as ScenarioReport;
}

export function printReport(r: ScenarioReport): void {
  const lines = [
    `[live:${r.lane}] total ${(r.totalMs / 1000).toFixed(1)}s · model calls ${r.calls.length} (provider_calls rows ${r.providerCalls})`,
    ...r.calls.map((c, i) => `  #${i + 1} ${c.schemaName ?? "text"} (${c.purpose}) ${c.modelId ?? "-"} ${(c.ms / 1000).toFixed(1)}s ${c.ok ? "ok" : `FAIL ${c.error}`}`),
    `  title suggestions: ${r.titleSuggestions.join(" / ")}`,
    `  chosen title: ${r.chosenTitle} · brief approved: ${r.briefApproved}`,
    `  cast: ${r.cast.map((c) => `${c.name}(${c.role})`).join(", ")}`,
    ...((r as ScenarioReport & { filledByForm?: string[] }).filledByForm ? [`  filled by form (import left empty): ${(r as ScenarioReport & { filledByForm?: string[] }).filledByForm!.join(", ")}`] : []),
  ];
  console.log(lines.join("\n"));
}
