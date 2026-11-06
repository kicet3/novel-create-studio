# CONVENTIONS — novel-create-studio 서버·모듈 작업 규칙

이 문서는 병렬로 모듈을 구현하는 에이전트가 서로의 파일을 건드리지 않고 같은 계약 위에서 일하기 위한 규칙입니다.
설계 원문은 `docs/`(PRD v0.4, `docs/design/00~11`)이고, 이 문서와 설계가 충돌하면 **이 문서와 루트 README의 "고정 결정"이 우선**합니다.

## 0. 소유권 규칙 (병렬 작업에서 가장 중요)

같은 디스크의 파일을 여러 에이전트가 동시에 고치면 서로의 변경을 덮어씁니다. 그래서 아래를 지킵니다.

| 파일·디렉터리 | 누가 고치나 |
|---|---|
| `apps/server/src/modules/<m>/**` | 그 모듈 담당 에이전트만 (아래 §12 표) |
| `packages/shared/src/dto/<m>.ts` | 그 모듈 담당 에이전트만. `dto/index.ts`는 이미 모두 re-export하므로 **고치지 않음** |
| `apps/server/test/<m>/**`, `apps/server/test/<m>.*.test.ts` | 그 모듈 담당 |
| `apps/web/**` | 웹 담당만 |
| `apps/server/src/{platform,http,runtime,composition}/**`, `app-core.ts`, `main.ts` | **고치지 않음.** 필요하면 최종 보고에 요청을 적음 |
| `packages/shared/src/{enums,enum-registry,labels.ko,ids,defaults,config-schema,activity-actions}.ts` | **고치지 않음.** 필요한 enum 값·라벨·기본값·감사 action은 보고에 적음 |
| `packages/db/src/schema/**`, `packages/db/src/migrations/**` | **고치지 않음.** 마이그레이션 번호가 연속이어야 해서(runner가 `bad_numbering`으로 거부) 병렬로 추가할 수 없습니다. 필요한 DDL은 보고에 SQL로 적으면 통합 단계에서 `0002_*.sql`로 합칩니다 |
| 다른 모듈의 `index.ts` 계약 | **고치지 않음.** 바꿔야 하면 보고에 "계약 변경 요청"으로 적고, 그동안은 자기 모듈 안에서 어댑터로 감쌉니다 |

자기 모듈의 `index.ts` 계약은 **넓히는 것(메서드·선택 필드 추가)은 자유**, 기존 시그니처를 바꾸거나 지우는 것은 그 계약을 쓰는 모듈 담당과 합의(보고)한 뒤에만 합니다.

## 1. 저장소·명령

```
corepack enable --install-directory ~/.local/bin pnpm   # pnpm 9.15.4 (packageManager)
export PATH=$HOME/.local/bin:$PATH
pnpm install
pnpm typecheck                     # 전 패키지
pnpm test                          # vitest (projects: shared, db, test-kit, server, cli, web)
pnpm exec vitest run --project server            # 서버만
pnpm exec vitest run --project server test/novel.test.ts
pnpm --filter @ncs/server dev      # tsx watch, embedded PG(~/.ncs/data/pg, 54329) + http://127.0.0.1:3100
NCS_HOME=/tmp/ncs-x pnpm --filter @ncs/server dev   # 임시 홈(데이터·키 분리)
pnpm --filter @ncs/server build && node apps/server/dist/main.js
```

환경 변수: `NCS_DEV_MODE`(`1`/`true` = 개발 모드: 구독·OAuth 연결 방식 허용, `pnpm dev`가 설정. 없으면 운영 모드 = API 키만), `NCS_HOME`, `NCS_HOST`, `NCS_PORT`, `NCS_ALLOWED_HOSTNAMES`(Tailscale MagicDNS 이름 등), `DATABASE_URL`(external PG·Supabase), `NCS_DB_PROVIDER`·`NCS_DB_SCHEMA`·`NCS_DB_EXTENSIONS_SCHEMA`·`NCS_DB_ALLOW_PUBLIC_SCHEMA`·`NCS_DB_POOL_MAX`·`NCS_DB_SSL_CA_FILE`(README "Supabase 사용"), `NCS_PG_PORT`, `NCS_PG_DATA_DIR`, `NCS_LLM_PROVIDER`(`anthropic` 기본 / `openai` / `xai` / `google`), `NCS_ANTHROPIC_BASE_URL`(Claude API 주소, 프록시·mock), `NCS_TELEGRAM_API_BASE_URL`(Bot API 주소, 로컬 Bot API 서버·mock), `NCS_SECRETS_MASTER_KEY`(base64 32바이트, `secrets/master.key`보다 우선), `NCS_LOG_LEVEL`, `NCS_LOG_PRETTY=1`.

단일 인스턴스(02 §2.3): 서버는 `$NCS_HOME/run/server.lock`(PID·host·port)과 DB advisory lock `instance_lock`을 잡습니다. 같은 홈·같은 DB로 두 번째 서버를 띄우면 바로 종료하고, `ncs restore`·`ncs migrate apply`·`ncs doctor`는 잠금 파일로 실행 중인 서버(환경 변수로만 지정한 host·port 포함)를 판단합니다.


테스트용 대체 모델은 없습니다. 실제 모델 호출은 연결한 공급자로만 하고, 테스트는 실제 어댑터를 로컬 mock 서버에 연결해 응답을 테스트마다 직접 적습니다(§10).

## 2. 서버 구조

```
apps/server/src/
  main.ts            조립 지점: config → DB(embedded|external, migrate) → createServerCore → listen → runtime
  app-core.ts        createServerCore({config, db, log, …}): platform → modules → HTTP app → runtime (테스트도 이것을 씀)
  platform/          leaf: config, logger(redaction), db(UnitOfWork/Tx), clock, ids, errors, secrets, storage, work-signal, module 계약
  http/              app.ts(Express 5, host guard, /api, tenant guard, SPA fallback, error handler), kit.ts(validate/valid/scopeOf/actorOf)
  runtime/           runtime.ts(BackgroundLoop 스케줄러, graceful stop), worker-pool.ts
  composition/       modules.ts(모듈 생성 순서 = 의존 순서), home-route.ts(GET …/home 집계)
  modules/<m>/       index.ts(공개 계약) · module.ts(팩토리) · domain/ · application/ · adapters/{db,http,<ext>}/ · README.md
```

모듈 생성 순서(의존은 위쪽으로만): `audit → system → novel → budget → llm → ontology → orchestration → agents → messaging → hitl → linking → manuscript → foreshadow → continuity → concept → export → imaging → world → cast` (world = 설계 추가 0012 세계관 온톨로지; cast가 캐릭터 초안에 world 컨텍스트를 씀).
순환이 필요해 보이면 **등록부(registry)** 로 뒤집습니다(아래 §6).

## 3. 계층 규칙 (ADR-008, 08 §3.2)

- `adapters → application → domain`. `domain/`은 I/O 없음(`node:*`, drizzle, fetch, `Date.now()` 금지 — 시각은 인자로).
- 다른 모듈은 **`modules/<other>/index.ts`만** import합니다. 하위 파일 import 금지. 타입만 필요해도 `import type … from "../<other>/index.js"`.
- `platform/`은 modules·http·runtime을 import하지 않습니다. 모듈은 `../../platform/index.js`, HTTP 어댑터는 `../../../../http/kit.js`를 씁니다.
- 벤더 격리: `ai`·`@ai-sdk/*`는 `modules/llm/adapters/**`만, Telegram `fetch`는 `modules/messaging/adapters/**`만.
- 다른 모듈 테이블을 직접 읽거나 쓰지 않습니다(`no-foreign-tables`). 온톨로지 테이블은 `OntologyRepository`로만.
- ESM + NodeNext: 상대 import에 `.js` 확장자를 붙입니다. `verbatimModuleSyntax`라서 타입은 `import type`.

## 4. 모듈 계약 형식

`index.ts`가 내보내는 것: 행 타입 별칭(`export type Episode = EpisodesRow`), 입력·출력 타입, `<Name>Service` 인터페이스, `create<Name>Module`(실체는 `module.ts`).

```ts
export function createXModule(deps: XModuleDeps): ServerModule<XService>
// ServerModule = { name, service, implemented, routes?(r), loops?, start?(), stop?() }
```

- `implemented: false`인 모듈은 계약 단계의 placeholder입니다. `notImplementedService()`/`partialService()`가 만든 서비스는 호출하면 `NotImplementedError`(HTTP 501)를 던지고, `register*`/`on*` 메서드는 no-op입니다(구현된 모듈이 아직 placeholder인 모듈에 등록해도 부팅이 깨지지 않게).
- 담당자는 `module.ts`의 팩토리를 실제 구현으로 바꾸고 `implemented: true`로 둡니다. `XModuleDeps`에 새 의존이 필요하면 `composition/modules.ts` 변경 요청을 보고에 적습니다(이미 넉넉히 넣어 둠).
- 이미 구현돼 있는 부트스트랩 코드(`adapters/db/bootstrap.ts`: N1 참여자 본문)는 유지하거나 자기 구조로 옮겨도 되지만, **N1 참여자 등록과 `ctx.outputs` 키는 유지**합니다.

## 5. DB 접근과 트랜잭션

- 테이블: `import { episodes } from "@ncs/db/schema"`, 연산자: `import { and, eq, sql } from "@ncs/db/orm"`(drizzle 단일 인스턴스).
- 자기 테이블만: `packages/db/src/schema/<m>.ts`(파일 이름 = 소유 모듈). 제약·FK·인덱스는 SQL(`0001_init.sql`)에만 있습니다.
- 작품 소속 쿼리는 항상 `novel_id` 조건(T-3). 공개 메서드 첫 인자는 `scope: NovelScope`(쓰기는 `tx: Tx`가 그 앞).
- 트랜잭션은 `platform.uow`:
  - `uow.run(async (tx) => …)` — 새 트랜잭션. `tx.db`가 drizzle 핸들. 직렬화 실패(40001/40P01) 3회 재시도.
  - `uow.join(tx?, fn)` — 호출자 트랜잭션이 있으면 그 안에서, 없으면 새로(02 M-2: 피호출 모듈은 자기 트랜잭션을 열지 않음).
  - `tx.afterCommit(() => platform.workSignal.notify("task", novelId))` — 커밋 후 힌트. 훅 안에서 외부 I/O 금지.
  - 트랜잭션 안에서 `uow.db`(트랜잭션 밖 핸들)를 쓰지 않습니다. PGlite(테스트)는 연결이 하나라 교착됩니다.
- 행 잠금: `db.select()…for("update")`. 상태 CAS는 `UPDATE … WHERE status IN (…) RETURNING`.
- 오류 판별: `isUniqueViolation(err)`, `isForeignKeyViolation`, `isCheckViolation` (`platform/db.ts`).
- 돈: micro-USD 정수 `number`(`*Micros`). ID: `platform.ids.next("tsk")`(테스트 재현을 위해 `newId` 대신). 시각: `platform.clock.date()`.
- 스키마 변경이 필요하면 §0대로 보고(SQL)만 합니다.

## 6. 모듈 사이 상호작용 (등록부)

동기 호출은 아래 방향으로만, 반대 방향은 등록부로 합니다.

| 등록부 | 소유 | 등록하는 쪽 |
|---|---|---|
| `novel.registerCreationParticipant({module, order, onNovelCreated})` | novel | ontology(10: schema v1 + main timeline), messaging(20: web 채널), budget(30: 기본 정책), llm(40: 역할 바인딩), concept(50: 세션 CS1) — 모두 **이미 구현** |
| `novel.onGoalSaved` / `novel.onStatusChanged` | novel | manuscript(N3에서 `plan_series_bible` 생성), orchestration(INV-GOL-02 깨우기), cast(N2에서 브리프 인물로 캐스트 시드) |
| `novel.registerGoalGuard` (설계 추가) | novel | cast(첫 목표 저장 전 캐스트 확정 필수, 422 `cast_not_confirmed`) |
| `orchestration.registerTaskKind(handler)` | orchestration | LLM 작업은 `agents.defineAgentTask(h)`로 감싸 등록: concept(concept_turn, import_concept, check_concept_brief), manuscript(plan_series_bible, plan_arc, schedule_episodes, outline/draft/split_scenes/polish/revise_episode, plan_rework, check_text_safety), linking(extract_facts, link_mentions, dedupe_entities, build_initial_ontology), continuity(check_continuity), foreshadow(plan_setups, check_setups, review_setup_due), hitl(interpret_answer, apply_answer, grade_question) |
| `agents.registerContextSection(provider)` | agents | manuscript(outline, recent_text), foreshadow(assigned_beats), hitl(answers → constraints), cast(cast) |
| `hitl.registerApprovalHandler(type, h)` | hitl | concept(`concept_brief`), manuscript(`series_bible`, `arc_plan`, `arc`, `episode`), budget(`budget_resume`) |
| `hitl.registerAnswerApplier(topic, a)` | hitl | linking(`entity_disambiguation`, `duplicate_entity`), 기타 주제별 |
| `messaging.registerInboundHandler(h)` | messaging | hitl(`answer_*`, `session_step`), concept(`concept_message`) |
| `manuscript.registerCheckGateContributor(c)` / `onEpisodeTransition(hook)` | manuscript | continuity(열린 high 이슈), foreshadow(missing 비트, E9 비트 확정); ontology 승격은 manuscript가 직접 `ontology.promoteEpisodeFacts` 호출 |
| `system.registerHealthCheck(def)` | system | llm(`llm_key`), messaging(`bot_token`, `channel_reach`), ontology(`ontology_integrity`), system(`database`, `storage`, 이미 구현) |

등록은 팩토리(create…Module) 안이나 `start()`에서 합니다. 등록부 호출 순서는 모듈 생성 순서를 따르므로 아래쪽 모듈이 위쪽 모듈에 등록합니다.

## 7. 작업 종류(task kind) 등록

```ts
orchestration.registerTaskKind({
  kind: "draft_episode", role: "writer", promptTemplateVersion: "writer.draft_episode@0.1.0",
  inputSchema: z.object({ episode_id: z.string() }),
  async gate(scope, task) { return { ok: true } },          // 선택: 임대 전 게이트(INV-BIB-02 등)
  async execute(ctx) { /* 도메인 쓰기 금지. LLM은 llm.modelCalls.call({ run: ctx.run, … }) */ },
  async commit(tx, ctx, proposal) { /* 한 트랜잭션: 모듈 API로 반영, 후속 작업 orchestration.createTask(tx, …) */
    return { kind: "done", outputRefs: [...] } },           // | awaiting_human | retry | failed
});
```

- `TASK_KIND_ROLE`·`TASK_KIND_TARGET`(orchestration/index.ts)이 역할·대상의 기준입니다.
- 작업 생성: `orchestration.createTask(tx, scope, { kind, targetType, targetId, input, createdBy, dependsOn?, episodeId?, arcId? })` — 컨셉 3종과 캐릭터 설정 2종(`draft_cast`, `draft_design_sheet`), 세계관 온톨로지(`build_world_ontology`, 0012) — `GOAL_OPTIONAL_TASK_KINDS` — 외에는 `Goal`이 있어야 합니다(INV-GOL-01).
- 실패 분류는 `TaskFailure(errorFamily, message, retryable)` 또는 llm의 `ModelCallError`를 던집니다. 안전 지점은 `await ctx.run.checkpoint()`.
- 현재 엔진은 **placeholder**(`orchestration/application/placeholder-runner.ts`)입니다. 계약(`TaskKindHandler`, `OrchestrationService`)은 그대로 두고 orchestration 담당이 교체합니다. 테스트에서는 `orchestration.runOnce()`로 한 번 돌립니다.

## 8. 상태 전이와 감사 로그

- 전이는 `domain/`의 표(`{ id, from[], to }`)로만 하고, 표에 없는 전이는 `InvalidTransitionError`(409). 예: `modules/novel/domain/transitions.ts`.
- 상태를 바꾸는 모든 유스케이스는 **같은 트랜잭션에서** `audit.record(tx, { novelId, actor, action, target, before?, after?, reason?, details?, questionId?, approvalId?, answerId? })`.
- `action`은 `packages/shared/src/activity-actions.ts` 목록만(03 §6.3). 새 이름이 필요하면 보고.
- 주체: `actors.user(id)`, `actors.agent(role, runId)`(runId 필수), `actors.system("orchestrator")`. HTTP에서는 `actorOf(res)`.
- 대량 변경은 1행 + `details: { ids, count }`. 비밀(`*token`, `*secret`, `apiKey`, `password`)은 자동 마스킹되지만 애초에 넣지 않습니다.
- 커밋 후 `audit.subscribe()`로 발행됩니다(UI 갱신 힌트 전용, 업무 로직이 소비하지 않음).

## 9. HTTP API

- 접두사 `/api`. 작품 소속은 **`/api/novels/:novelId/...`** — `routes({ api, novel })`의 `novel` 라우터에 상대 경로로 붙입니다(`novel.get("/episodes", …)`). 이 라우터 앞에서 작품 존재를 확인하고 없거나 형식이 틀리면 404(T-4, 403 아님). 핸들러에서는 `scopeOf(res)`.
- 설치 단위는 `api` 라우터(`/api/system/...`, `/api/llm/...`, `/api/messaging/...`).
- 입력 검증: `validate({ params, query, body })` + `valid<T>(res)`. 스키마는 `@ncs/shared`의 DTO(zod). ZodError → 400 `validation_failed`.
- 오류: `NotFoundError`(404), `ConflictError`(409), `InvalidTransitionError`(409), `DomainValidationError`(422), `NotImplementedError`(501), 그 밖 `AppError(status, code, message)`. 본문 `{ error: { code, message, details? } }`, `message`는 사용자에게 보일 한국어.
- 응답 JSON은 **camelCase**(drizzle 행 필드명 그대로), 시각은 ISO 문자열, 금액 `*Micros` 정수. 목록은 `{ items, nextCursor? }`. 생성은 201(`created(res, body)`).
- DTO: `packages/shared/src/dto/<module>.ts`에 요청·응답 zod 스키마와 타입. 이름 충돌을 피하려고 모듈 접두사를 붙입니다(`episodeDtoSchema`, `hitlQuestionViewSchema`). `node:*` import 금지(웹에서도 씀).
- 웹은 `/api`만 호출합니다(Vite dev 프록시 → 3100). 프로덕션은 서버가 `apps/web/dist`를 제공하고 SPA fallback.

## 10. 테스트

- 위치: `apps/server/test/**/*.test.ts` (vitest project `server`).
- 전체 서버 코어 + 새 PGlite DB: `createTestCore()` (`apps/server/test/support/test-core.ts`)
  ```ts
  const t = await createTestCore();               // 모든 모듈, HTTP 앱(임의 포트), 임시 홈
  const novel = await t.modules.novel.service.createNovel({}, t.owner);
  const r = await t.http("GET", `/api/novels/${novel.id}/activity`);
  await t.platform.uow.run((tx) => …);
  t.testDb.db / t.testDb.query(sql) / t.testDb.exec(sql)   // 테스트 전용 직접 접근
  await t.close();
  ```
  배경 루프는 돌지 않습니다(`orchestration.runOnce()`, `t.core.runtime.kick(name)`으로 직접).
  `createTestCore()`는 운영 모드(`dev_mode: false`, API 키만)로 부팅합니다. Claude 구독·ChatGPT/xAI 로그인을 다루는 테스트는 `createTestCore({ devMode: true })`.
- 실제 Claude 호출 테스트는 `pnpm test:live`(`apps/server/test-live/**/*.live.test.ts`, `vitest.live.config.ts`)로 따로 돌리며 `pnpm test`에는 들어가지 않습니다. `ANTHROPIC_API_KEY`가 없거나 Claude Code CLI가 구독으로 로그인돼 있지 않으면 해당 레인은 이유를 출력하고 건너뜁니다.
- DB만 필요하면 `createTestDb()`(`@ncs/db/testing`), `seedNovel()`.
- 가짜 시계·ID: `@ncs/test-kit`의 `FakeClock`, `SeqIdFactory` → `createTestCore({ clock })`.
- PGlite에서 `btree_gist`가 없으면 EXCLUDE 제약이 빠집니다(`t.testDb.extensions`). 앱 수준 검사도 같이 둡니다(예: 아크 범위 겹침).
- LLM: `createTestCore()`는 공급자 `anthropic`(더미 키)을 로컬 mock Claude API(`test/support/scripted-claude.ts`, `t.claude`)에 연결합니다. 모델 호출이 있는 테스트는 필요한 응답을 `t.claude.reply({ when, json | text | error })`로 직접 적습니다(자동 생성·키워드 픽스처 없음). 스크립트가 없는 요청은 HTTP 400으로 실패하고 `t.claude.unmatched`에 남습니다. 단일 핸들러 단위 테스트는 스크립트된 `ModelCallPort` 스텁을 써도 됩니다.

## 11. 한국어 UI·문구

- 사용자에게 보이는 문구(오류 `message`, 질문·알림 본문, 라벨)는 한국어, 존댓말 평서문("…할 수 없습니다.", "…하세요.").
- enum 값은 원문 그대로 저장·전송하고 표시만 `labelKo(name, value)`/`LABELS_KO`로 바꿉니다. 내부 ID 대신 표시 번호(`T-12`, `Q-3`, `CI-3`, `S-01`).
- 시각은 작품 `timezone` 벽시계로 표시(00 §5.5). 금액은 `formatUsd(micros)`.
- 로그·코드 주석은 영어 또는 한국어 모두 가능, 로그에는 비밀을 넣지 않습니다.

## 12. 다음 단계 담당 (module → owner agent)

| 에이전트 | 모듈·영역 | 비고 |
|---|---|---|
| A1 orchestration+budget | `orchestration`, `budget` | placeholder 엔진 교체(lease·fencing·reclaim·coalescing·동시성·예약 게이트), 예산 원장 |
| A2 llm+agents | `llm`, `agents` | Anthropic·OpenAI·xAI·Gemini 어댑터, ModelCallPort, 역할·프롬프트 템플릿·ContextBuilder·`defineAgentTask` |
| A3 ontology+linking | `ontology`, `linking` | OntologyRepository, base@1, 링커 L0~L8, 추출·링킹 작업, 골든셋 |
| A4 manuscript+export | `manuscript`, `export` | 화 상태 기계 E1~E16, 기획·집필 파이프라인 작업, 승인 처리기(기획서·아크·화), 내보내기 |
| A5 continuity+foreshadow | `continuity`, `foreshadow` | 검사 작업, 게이트 기여자, 떡밥 리포트 |
| A6 hitl+messaging | `hitl`, `messaging` | 질문·승인·답변·반영, Telegram long polling, inbox/outbox |
| A7 concept | `concept` | 컨셉 대화·브리프·승인(N2) |
| A8 web | `apps/web` | 아래 §13 API로 화면 구현 |
| (선택) A9 ops/CLI | `system` 백업·복원, `apps/cli` | MA-6. 없으면 통합 단계에서 처리 |

`audit`, `system`(백업 제외), `novel`은 계약 단계에서 구현을 마쳤습니다. 버그·확장 요청은 보고에 적습니다.

## 13. API 엔드포인트 (웹이 기준으로 삼을 목록)

`…` = `/api/novels/:novelId`. ✅ = 지금 동작, ⏳ = 해당 모듈 담당이 구현.

**설치 단위**
- ✅ `GET /api/health` → `{status, version, database}`
- ✅ `GET /api/me` → `{id, displayName, role}`
- ✅ `GET /api/novels?includeArchived=true` → `{items: Novel[]}` · `POST /api/novels` `{title?, ageRating?, entryMode?, timezone?}` → 201 Novel (N1)
- ✅ `GET /api/length-profiles` → 프리셋
- ✅ `GET /api/activity` (설치 단위 감사, 쿼리는 아래 activity와 같음)
- ✅ `GET /api/system/info` · `GET /api/system/health-checks` → `{checks, items}` · `POST /api/system/health-checks/run` `{kinds?, novelId?}`
- ✅ `GET /api/system/secrets` (메타데이터만) · `PUT /api/system/secrets/:secretId` `{value, label?}` → 204 · `DELETE …` → 204
- ✅ llm: `GET /api/llm/provider-profiles`, `POST /api/llm/test`
- ✅ AI 계정 연결: `GET /api/providers` · `PUT /api/providers/:provider/api-key` `{apiKey}` · `PUT …/active-method` `{method}` · `DELETE …/connection?method=` · `POST …/test` · `POST …/oauth` `{flow}` → `GET|DELETE …/oauth/:sessionId` · `POST /api/providers/openai/import-codex` (provider = anthropic|openai|xai|google, 상세는 `modules/llm/README.md`)
- ✅ 이미지 생성(imaging): `GET /api/images/providers` · `POST /api/images/generations` `{novelId?, provider, modelId, prompt, negativePrompt?, styleNotes?, aspectRatio, resolution, quality?, count}` → 202 · `GET /api/images/generations?novelId&scope&status&limit&before` · `GET|DELETE /api/images/generations/:id` · `POST …/:id/cancel` · `GET /api/images/assets/:assetId/file?download=1` (상세는 `modules/imaging/README.md`)
- ⏳ messaging: `GET|POST /api/messaging/bots` `{kind:"telegram", label, token}`
- ⏳ system(MA-6): `GET|POST /api/system/backups`

**작품 (novel, 감사, 홈)**
- ✅ `GET …` · `PATCH …` `{title?, targetAudience?, questionThreshold?, defaultNarrationMode?, timezone?, possessionModeEnabled?, webSearchEnabled?, webSearchMaxUses?(1~10)}` (인터넷 검색, 설계 추가 0011 — `modules/llm/README.md` Web search)
- ✅ `PUT …/autonomy` `{autonomyLevel, publishPolicy?, acknowledgedFullAutoWarning, reason?}`
- ✅ `POST …/pause` `{reason?}` · `POST …/resume` · `POST …/status` `{to: "completed"|"archived", reason?}`
- ✅ `GET …/goal` (없으면 `null`) · `PUT …/goal` `{totalEpisodesMin, totalEpisodesMax, cadenceEpisodesPerWeek, reserveTargetEpisodes, endingDirection, notes, expectedRevision?}` (concept 상태면 422 `concept_not_approved`, 처음 저장이면 N3)
- ✅ `GET …/bibles` · `GET …/bibles/approved` · `GET …/bibles/:bibleId`
- ✅ `GET …/arcs` · `POST …/arcs` · `GET|PATCH …/arcs/:arcId` · `POST …/arcs/:arcId/pause|resume`
- ✅ `GET|PATCH …/length-profile` (`minChars`·`maxChars` ≥ 3,000: zod 400 / 서버 422 `length_min_too_low`, 기본 5000/5500) · `GET|PATCH …/notification-policy`
- ✅ 전체 구성 편집(설계 추가 0008): `PATCH …/structure/ending` `{expectedRevision, ending: {worldState?, conflictResolution?, characterFinalStates?, protagonistChange?, foreshadowPayoffs?}}` · `PATCH …/structure/parts/:partId` `{expectedRevision, title?, goalText?, turningPoints?, plannedEpisodeFrom?, plannedEpisodeTo?, characterStates?, plotOutline?}` → `storyStructureDtoSchema` (409 `revision_conflict`, 422 `part_range_invalid`·`part_range_locked`; 승인된 구성은 draft로 돌아가 재승인 필요) · `POST …/arcs/:arcId/acknowledge-flags` → Arc (플롯 확인 표시 해제 = 지금 계획 유지)
- ✅ `GET …/activity?actorType&actorId&targetType&targetId=a,b&actionPrefix=episode.&afterSeq&beforeSeq&limit` → `{items, nextCursor, latestSeq}` (seq 내림차순, 다음 페이지는 `beforeSeq=nextCursor`, 새 이벤트 폴링은 `afterSeq=latestSeq`)
- ✅ `GET …/health-checks`
- ✅ `GET …/home` → `{novel, goal, arcs, episodes, reserve, questions, continuityIssues, setupsDueSoon, budget, health, modules}` (placeholder 모듈 영역은 `null`)

**작업 (orchestration)**
- ✅ `GET …/tasks?status=ready,running&kind=draft_episode&agentRole&arcId&episodeId&includeCancelled=true` → `{items: (Task & {latestRun})[]}`
- ✅ `GET …/tasks/:taskId` · `GET …/tasks/:taskId/runs` · `POST …/tasks/:taskId/retry|cancel|pause|resume`
- ⏳ `POST …/tasks/:taskId/reassign` `{toRole}`

**예산 (budget)** ⏳ `GET …/budget` · `PATCH …/budget/policies/:category` · `POST …/budget/policies/:category/resume` · `GET …/budget/cost-events?runId&since`

**모델 (llm)** ⏳ `GET …/model-bindings` · `PATCH …/model-bindings/:role` · `GET …/runs/:runId/provider-calls`

**캐릭터 (cast, 설계 추가)** ✅ `GET …/cast` · `POST …/cast/characters` · `PATCH|DELETE …/cast/characters/:characterId` · `POST …/cast/characters/:characterId/accept` · `PUT …/cast/order` `{ids}` · `POST …/cast/import-brief` · `POST …/cast/draft` `{subProtagonistCount?, includeAntagonist, instructions?, fillMissing?, characterIds?}` → 202 (fillMissing: 빈 필수 항목만 AI로 채움, 없으면 422 `nothing_to_fill`) · `POST …/cast/confirm` · `GET|PATCH …/cast/characters/:characterId/design-sheet` · `POST …/design-sheet/draft` → 202 · `GET …/design-sheet/prompt?view&outfitIndex` · `POST …/design-sheet/images` `{view, provider, modelId, aspectRatio?, resolution, quality?, count, outfitIndex}` → 202 · `PUT …/design-sheet/primary` `{view, assetId|null}` (상세는 `modules/cast/README.md`). 첫 목표 저장(`PUT …/goal`)은 캐스트 확정 전이면 422 `cast_not_confirmed`. `GET …/cast`의 `completeness`는 전체 구성 전 필수 항목 체크리스트입니다(주인공·서브 주인공: 나이·외형·성격·목표·동기·약점·과거사·말투 예시·관계·변화 아크, 조연·적대자: 역할·목표·주인공과의 관계; 확정된 값만 인정).

**컨셉 (concept)** ⏳ `GET …/concept/session` · `GET …/concept/sessions/:sessionId` · `GET|POST …/concept/sessions/:sessionId/messages` (`?afterSeq`) · `PATCH …/concept/sessions/:sessionId/brief` `{path, value}` · `POST …/concept/sessions/:sessionId/{pause,resume,abandon,submit,extend,entry-mode}` · `POST …/concept/revisions` · `GET …/concept/briefs` · `GET …/concept/briefs/:briefId` · `POST …/concept/sessions/:sessionId/title-suggestions` → 202 · `POST …/concept/sessions/:sessionId/title` `{title}` · `GET …/concept/sessions/:sessionId/stream` (SSE: `delta {text}` / `reset` / `done {messageId}` / `error {message}`, 실시간 답변) · `POST …/concept/sessions/:sessionId/stop-turn` (답변 멈추기) · 웹 `POST …/messages`는 답변 작성 중이면 409 `concept_turn_in_flight`

**인박스 (hitl)** ⏳ `GET …/inbox/summary` · `GET …/questions?status&grade&topic` · `GET …/questions/:questionId` (QuestionView + answers) · `POST …/questions/:questionId/open` · `POST …/questions/:questionId/answers` `{optionIds?, text?, approval?: {decision, decisionNote?, reworkFrom?}}` · `GET …/approvals?status&type` · `GET …/approvals/:approvalId` · `POST …/approvals/:approvalId/decision`

**채널 (messaging)** ⏳ `GET …/channels` · `POST …/channels/bindings` `{kind, botId}` → `{token, expiresAt, deepLink}` · `POST …/channels/:channelId/unbind`

**전체 구성 (manuscript, 설계 추가 0008)** ✅ `GET …/structure` → `structureViewSchema` (구성·게이트·플롯·화 계획·진행 중 작업) · `POST …/structure/generate` `{scope: all|ending|parts, instructions?}` → 202 `{taskId}` (422 `goal_required`·`bible_not_approved`·`cast_incomplete`(details.items)·`structure_too_short`) · `POST …/structure/decision` `{decision, note?, expectedRevision}` → structureView (사용자만, 자율 단계와 무관; 409 `revision_conflict`·`structure_not_pending`, 422 `structure_incomplete`·`cast_incomplete`·`structure_user_only`) · `POST …/arcs/:arcId/replan` `{note?}` → 202 (409 `arc_not_replannable`, 422 `structure_not_approved`). 인박스 `POST …/approvals/:id/decision`(story_structure·arc_plan)도 같은 처리기로 갑니다(arc_plan: 플롯 신규 인물 미완성이면 422 `plot_cast_incomplete`).

**원고 (manuscript)** ⏳ `GET …/episodes?arcId&status` · `GET …/episodes/:episodeNo` · `GET …/episodes/:episodeNo/versions` · `GET …/versions/:versionId?with=spans,scenes,issues,beats` · `POST …/episodes/:episodeNo/versions` `{content, baseVersionId}` (E16) · `POST …/episodes/:episodeNo/revision-request` `{decisionNote, reworkFrom}` (E11) · `POST …/episodes/:episodeNo/publish` · `POST …/episodes/:episodeNo/unpublish` `{reason, confirmedNotPublishedExternally: true}` · `POST …/episodes/:episodeNo/pause|resume` · `GET …/episodes/:episodeNo/scenes` · `POST …/planning/schedule`

**세계관 온톨로지 (world, 설계 추가 0012)** ✅ `GET …/world-ontology` → `worldOntologyViewSchema` (생성 상태·웹 검색·분류별 후보) · `POST …/world-ontology/generate` `{instructions?}` → 202 `{taskId, created}` (422 `concept_not_approved`; 진행 중이면 같은 작업) · `POST …/world-ontology/approve-all` · `POST …/world-ontology/items/:itemId/approve|reject` `{reason?}` → `worldReviewResultSchema` · `PATCH …/world-ontology/items/:itemId` `{name?, summary?, statement?, predicate?}` (검토 대기 항목만, 409 `world_item_not_pending`). 컨셉 승인(N2)이 `build_world_ontology`(world_keeper, 목표 없이 가능)를 자동으로 만들고, 후보는 온톨로지에 candidate로 들어갑니다(`modules/world/README.md`).

**온톨로지 (ontology)** ⏳ `GET …/entities?type&status&q&limit` · `GET …/entities/:entityId` (병합된 ID면 `{redirectTo}`) · `GET …/entities/:entityId/mentions?linkStatus` · `GET …/entities/:entityId/facts?storyPoint&timelineId&include` · `POST …/entities` · `POST …/entities/:entityId/names` · `GET …/timelines` · `GET …/schema` · `GET …/identity-decisions?entityId` · `GET …/identity-decisions/:id/impact` · `POST …/identity-decisions/:id/revert`

**연속성 (continuity)** ⏳ `GET …/continuity-issues?episodeId&status&severity` · `GET …/continuity-issues/:issueId` · `POST …/continuity-issues/:issueId/transition` `{to, note?}`

**떡밥 (foreshadow)** ⏳ `GET …/setups?narrative&canon&importance&overdue&dueWithin` · `GET …/setups/:setupNo` · `GET …/setups/report?asOf`

**내보내기 (export)** ⏳ `POST …/exports` `{scopeKind, targetId?, format: "txt"|"markdown", versionSelection}` · `GET …/exports` · `GET …/exports/:exportId` · `GET …/exports/:exportId/download`

⏳ 엔드포인트의 정확한 요청·응답은 각 모듈 담당이 `packages/shared/src/dto/<module>.ts`에 zod로 정의합니다. 웹 담당은 그 파일이 생기기 전까지 이 목록과 `modules/<m>/index.ts`의 타입을 기준으로 작업하고, placeholder 응답 501(`not_implemented`)을 "준비 중" 상태로 표시합니다.

## 14. 계약 단계에서 정한 것 (설계와 다르거나 새로 정한 점)

- 작업 종류 등록부는 `orchestration.registerTaskKind`(설계 04 §13은 agents의 `registerHandler`) — agents는 `defineAgentTask`로 어댑터만 제공.
- 감사 action 추가: `arc.updated`, `secret.deleted`.
- novel 상태 N4(planning→serializing), N5(serializing→completed), N6(→archived)는 가정(03 §9 미결).
- arc 전이 AR3(plan_awaiting_approval→planned, 계획 반려), AR4(full_auto에서 planned→active), AR6(awaiting_approval→active, 아크 반려)를 추가.
- 금액은 설계의 `bigint` 대신 `number`(micro-USD 정수).
- 메신저는 Chat SDK 대신 Telegram Bot API를 `fetch`로 직접 호출(고정 결정).
- 기본 역할 모델: showrunner·planner·writer = `claude-opus-5-5`, 나머지 = `claude-sonnet-5-5`(가정; llm 담당이 조정). 가격표는 미검증 placeholder.
