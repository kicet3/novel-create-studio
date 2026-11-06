# Paperclip 소스 재확인 (10-paperclip-mapping, 08-tech-stack 근거)

- 작성일: 2026-10-27
- 대상: `https://github.com/paperclipai/paperclip` main, `git clone --depth 1`, 커밋 `0cb3fc7db591ba23e21fbbc70042bc44ec7d6f20`(2026-10-26 21:34 -0700)
- 로컬 경로: 조사 세션의 임시 폴더(삭제됨). 다시 보려면 `git clone https://github.com/paperclipai/paperclip.git` 후 커밋 `0cb3fc7` 기준으로 봅니다. 아래 경로는 저장소 루트 기준 상대 경로입니다.
- 방법: 읽기와 grep만 했습니다. 설치·빌드·스크립트 실행은 하지 않았습니다. chat SDK는 npm tarball(`chat`, `@chat-adapter/telegram`, `@chat-adapter/discord` 4.39.0)을 별도 디렉터리(`scratchpad/npm-chat`)에 풀어 `dist/*.js`를 읽었습니다.
- 기준 보고서: `/Users/snowfall/orca/docs/paperclip-architecture-map.md`(이하 "지도"). 지도는 다른 시점의 클론을 분석했습니다.
- 등급: [1차] 소스·공식 레지스트리에서 직접 확인, [추론] 소스 근거로 한 추론, [미확인] 확인하지 않음.

---

## 1. 확인한 사실

### 1.1 라이선스와 서드파티 고지

| 항목 | 사실 | 근거 |
|---|---|---|
| 저장소 라이선스 | MIT, "Copyright (c) 2025 Paperclip AI" | `LICENSE` [1차] |
| 패키지별 라이선스 | `server`, `ui`, `cli`, `packages/{db,shared,adapter-utils,mcp-server,plugins/sdk,…}`, `packages/adapters/*` 모두 `"license": "MIT"` | 각 `package.json` [1차] |
| 루트 NOTICE / THIRD_PARTY 파일 | 없음 | 저장소 루트 목록, `find -iname '*NOTICE*'` [1차] |
| 부분 고지 | 번들 폰트 Inter v4.1, SIL OFL 1.1 | `ui/public/fonts/NOTICE.md` [1차] |
| 주요 의존 라이선스 | `chat`·`@chat-adapter/*` 4.39.0 MIT(repo `vercel/chat`), `embedded-postgres` MIT, `better-auth` MIT, `drizzle-orm` Apache-2.0 | npm registry 메타데이터 [1차] https://registry.npmjs.org/chat/4.39.0 , https://registry.npmjs.org/@chat-adapter/telegram/4.39.0 , https://registry.npmjs.org/drizzle-orm/latest |
| 패치된 서드파티 | `patches/` 14개: `postgres@3.4.9`, `embedded-postgres@18.1.0-beta.16`, `acpx`×2, ACP×2, `pi-acp`, `@chat-adapter/{slack,discord,telegram,teams,github}@4.39.0`, `@discordjs/ws@1.2.3`, `brace-expansion` | `patches/`, `pnpm-workspace.yaml` `patchedDependencies` [1차] |

시사점: Paperclip 코드를 복사하면 MIT 고지(저작권·허가 문구)를 보존하면 됩니다. 패치 파일을 가져오면 패치 대상 패키지의 라이선스(MIT)도 함께 따릅니다. PRD D-15의 "라이선스 확인 필요(미확인)"는 해소됩니다.

### 1.2 런타임·패키지 매니저·모노레포

| 항목 | 사실 | 근거 |
|---|---|---|
| Node | `engines.node >=24.11.0`, `.nvmrc` 24, Docker base `node:24-trixie-slim` | `package.json:108-110`, `.nvmrc`, `Dockerfile:2` |
| 패키지 매니저 | `pnpm@9.15.4` | `package.json:111` |
| 모노레포 | pnpm workspace만 사용. Turborepo·Nx 없음. 빌드는 `pnpm -r build` | `pnpm-workspace.yaml`, `package.json` scripts |
| 언어 | TypeScript(`tsconfig.base.json`), runner는 Rust(Dockerfile `rust-toolchain`~`runner-build` 단계) | `Dockerfile:60-131` |
| 테스트 | Vitest(`scripts/run-vitest-stable.mjs`), Playwright | `package.json` scripts |

### 1.3 DB

| 항목 | 사실 | 근거 |
|---|---|---|
| DB | PostgreSQL 전용. 로컬은 `embedded-postgres`(^18.1.0-beta.16, 포트 기본 54329), 외부는 `DATABASE_URL` | `packages/db/package.json`, `packages/db/src/runtime-config.ts:223` |
| PGlite | 설정값 `pglite`는 남아 있지만 embedded-postgres로 처리 | `runtime-config.ts:114` |
| 드라이버·ORM | `postgres`(postgres.js) ^3.4.9 + `drizzle-orm` ^0.45.2 | `packages/db/package.json` |
| 마이그레이션 | SQL 생성은 `drizzle-kit generate`, 적용은 자체 runner(`inspectMigrations`·`reconcilePendingMigrationHistory`·`applyPendingMigrations`) | `packages/db/package.json` `generate`/`migrate`, `packages/db/src/client.ts:938,1052,1121` |
| 마이그레이션 가드 | `check-migration-numbering.ts`, `check-migration-safety.ts`, `migration-safety-baseline.ts` | `packages/db/src/` |
| 규모 | schema 파일 174개, `src/migrations/*.sql` 378개 | `ls` [1차] |
| embedded PG 관리 | `packages/db/src/embedded-postgres-{lifecycle,native,error}.ts`(합 228줄), `server/src/embedded-postgres-{owner,supervisor}.ts`(104줄) | `wc -l` |
| embedded-postgres 패치 | 30줄. initdb·실행 env에 `LC_MESSAGES=C`만 추가 | `patches/embedded-postgres@18.1.0-beta.16.patch` |
| work-signals | 프로세스 내 큐 힌트(트랜잭션 커밋 후 listener 호출). SQL 트리거·LISTEN/NOTIFY 아님 | `packages/db/src/work-signals.ts:1-10`(114줄) |

### 1.4 서버·UI·실시간

| 항목 | 사실 | 근거 |
|---|---|---|
| 서버 | Express ^5.1.0, `ws` ^8.22, `pino`, `better-auth` 1.7.2, `zod` ^4.4.3, `@modelcontextprotocol/sdk`, `ai` 7.0.130 + `@ai-sdk/{anthropic,openai,google,xai,amazon-bedrock}` | `server/package.json` dependencies |
| 진입 파일 | `server/src/index.ts` 2,287줄, `app.ts` 1,513줄 | `wc -l` |
| 서비스 규모 | `services/*.ts` 비테스트 681개, 하위 포함 비테스트 1,182개, `routes/*.ts` 비테스트 92개, `services/native-runtime/` 268개 | `ls`/`find` |
| UI | React ^19.2.8, Vite ^8.2.2, Tailwind ^4.3.3, React Query ^5.102.8, react-router-dom ^7.18.4 | `ui/package.json` |
| 실시간 | 서버 프로세스 내 `EventEmitter`(company별 채널) → WebSocket(`ws`, `noServer`). 이벤트 id는 프로세스 메모리 카운터라 재시작 시 0부터, 재전송(replay) 없음 | `server/src/services/live-events.ts`(66줄), `server/src/realtime/live-events-ws.ts:242-256` |
| SSE | live events에는 쓰지 않음. `board-chat`, `plugins`, `public-mcp` 등 일부 라우트만 `text/event-stream` | `grep text/event-stream server/src` |
| UI 수신 | `ui/src/context/LiveUpdatesProvider.tsx` 2,267줄 | `wc -l` |

### 1.5 활동 로그·승인

| 항목 | 사실 | 근거 |
|---|---|---|
| `activity_log` | `actorType`(기본 `system`), `actorId`, `action`, `entityType`, `entityId`, `agentId`, `runId`, `responsibleUserId`, `details` jsonb | `packages/db/src/schema/activity_log.ts:9-19` |
| 기록·발행 분리 | `persistActivity`(redaction 후 insert) → `publishActivity`(live event `activity.logged` + plugin domain event) | `server/src/services/activity-log.ts:150-200`(241줄) |
| `approvals` | `type` text, `status` 기본 `pending`, `payload` jsonb, `decisionNote`, `decidedByUserId`, 요청자 agent/user | `packages/db/src/schema/approvals.ts:8-16` |
| 승인 enum | `APPROVAL_TYPES` = `hire_agent`, `approve_ceo_strategy`, `budget_override_required`, `request_board_approval`. `APPROVAL_STATUSES` = `pending`, `revision_requested`, `approved`, `rejected`, `cancelled` | `packages/shared/src/constants.ts:689-704` |

### 1.6 작업 잠금(원자적 checkout)

`server/src/services/issues.ts`(13,875줄)의 `checkout`(11822행~)이 구현입니다. [1차]

1. 선행 검사: 담당 가능 여부(`assertAssignableAgent`), subtree pause hold, 종료된 run이 쥔 잠금 정리(`clearExecutionRunIfTerminal`·`clearCheckoutRunIfTerminal`), 미해결 blocker(422).
2. 잠금 획득: `SELECT … FOR UPDATE`가 아니라 **조건부 UPDATE 한 문장(CAS)** 입니다.
   ```sql
   UPDATE issues
      SET assignee_agent_id=$agent, assignee_user_id=NULL,
          checkout_run_id=$run, execution_run_id=$run,
          status='in_progress', started_at=now(), updated_at=now()
    WHERE id=$id
      AND status = ANY($expectedStatuses)
      AND (assignee_agent_id IS NULL
           OR (assignee_agent_id=$agent AND (checkout_run_id IS NULL OR checkout_run_id=$run)))
      AND (execution_run_id IS NULL OR execution_run_id=$run)
   RETURNING *;
   ```
   (Drizzle 코드 `issues.ts:11887-11924`, UPDATE는 11906행을 SQL로 옮긴 것)
3. 실패 시 현재 행을 읽고 두 경로로 회수합니다.
   - 같은 담당자·`in_progress`·`checkout_run_id IS NULL`이면 조건부 UPDATE로 채택(adopt).
   - 다른 run이 쥐고 있으면 `adoptStaleCheckoutRun`(7606행)이 `heartbeat_runs`·`issues` 행을 `FOR UPDATE`로 잠그고, 기존 run이 종료됐거나 없을 때만(`isTerminalOrMissingHeartbeatRun`, 7599행) 넘겨받습니다.
- 지도 10절 4번의 "잠금 다섯 곳 중 checkout이 어느 것인가"에 대한 답: 획득은 CAS UPDATE이고, `FOR UPDATE`는 stale 회수(7606~7770행)와 종료 run 정리(7772·7822행)에서 씁니다.

### 1.7 wake queue·heartbeat·run 분리

| 항목 | 사실 | 근거 |
|---|---|---|
| 큐 본체 | `server/src/services/heartbeat/queue.ts` 4,942줄. `claimQueuedRun`(945행)이 case handoff, Slack mention, agent 존재·invokability, 예산 차단을 한 함수에서 검사 | [1차] |
| idempotency | `agent_wakeup_requests.idempotencyKey`. 접두어로 출처 구분(`chat-inbound:`, `case-handoff:`, `execution-reconciliation:` 등) | `queue.ts:1861,2176,2310` |
| `heartbeat.ts` | 4,171줄 | `wc -l` |
| `modules/wake-queue` | 4,494줄(테스트 제외). 공개 API는 `createWakeQueue` → `releaseIssueExecution`, `admitWakeBehindIssueExecution`, 그리고 queued comment 편집·재정렬·폐기 | `server/src/modules/wake-queue/index.ts` |
| 경계 | 주석상 "heartbeat.ts holds the only caller", "The admission half is temporary: heartbeat.ts still opens and owns the transaction". `WakeQueueDeps`가 `resolveResponsibleUserId`, `getRoutineEnv`, `resolveSessionBeforeForWakeup`, wake admission helper를 heartbeat에서 주입받음 | `modules/wake-queue/index.ts:60-110` |
| `modules/run-dispatch` | 2,424줄. scheduled retry 승격 게이트와 queued run staleness 게이트만 소유. 도메인 상수에 `CHAT_CONVERSATION_ID_KEY`, `WORKSPACE_BUSY_RETRY_REASON`, `AI_CONNECTION_*` 포함 | `modules/run-dispatch/index.ts` |

결론: 두 모듈은 heartbeat에서 일부만 떼어 낸 상태이고 issue·agent·chat·workspace 개념에 묶여 있습니다. 독립 차용 단위가 아닙니다. [1차+추론]

### 1.8 비용 원장·예산 하드 한도

| 항목 | 사실 | 근거 |
|---|---|---|
| `cost_events` | `idempotencyKey`(company+key 유니크), `receiptHash`, `providerRequestId`, `provider`, `biller`, `billingType`, `costStatus`, `model`, 입력·캐시·출력 토큰, `costCents` numeric(24,7) | `packages/db/src/schema/cost_events.ts:17-44` |
| `budget_policies` | `scopeType`(company/agent/project), `metric`(현재 `billed_cents`만), `windowKind`(`calendar_month_utc`/`lifetime`), `amount`, `reservationCents`, `warnPercent` 80, `hardStopEnabled` true, `unpricedUsagePolicy` `block`, `enforcementVersion` | `schema/budget_policies.ts:10-29`, `shared/src/constants.ts:875-888` |
| **사전 예약(지도에 없음)** | `reserveRunBudget`: company 단위 회계 트랜잭션 안에서 run 행 `FOR UPDATE` → 정책 평가 → `원장 + 미정산 예약 + 이번 예약 > 한도`면 거부 → `budget_reservations` 행 삽입. 주석 "Estimates constrain admission; they cannot cap a provider's bill. A reservation survives timeouts and restarts until accounting proves closure." | `server/src/services/budget-reservations.ts:70-131`(132줄) |
| 하드 한도 도달 | `pauseScopeForBudget`: agent는 budget hold, project는 `pauseReason='budget'`, company는 `status='paused'` | `server/src/services/budgets.ts:276-310`(1,136줄) |
| 가격 미상 | `unpricedUsagePolicy='block'`이 기본 | `budget_policies.ts:18` |

PRD의 예약 상한 방식(6.8절, fidelity #8 메모)과 같은 구조가 Paperclip에 이미 있습니다.

### 1.9 adapter SPI

`packages/adapter-utils/src/types.ts`(812줄)의 `ServerAdapterModule`(506행) [1차]

- 필수: `type`, `execute(ctx): Promise<AdapterExecutionResult>`, `testEnvironment(ctx)`.
- 선택: `acp`, `listSkills`/`syncSkills`, `sessionCodec`, `sessionManagement`, `runtimeToolDelivery`, `models`/`listModels`/`refreshModels`, `onHireApproved`, `getQuotaWindows`, `detectModel`, `getConfigSchema`, capability flag 다수.
- `AdapterExecutionContext`(237행): `runId`, `agent`, `runtime`, `config`, `context`, `signal`, `executionTarget`, `stopRemoteStartup`, `onProviderStopped`, sandbox·원격 전송 필드.
- `AdapterExecutionResult`(102행): `exitCode`, `signal`, `timedOut`, `errorFamily`, `retryNotBefore`, `usage`, `usageByModel`, `usageBasis`(`per_run`/`session_cumulative`), `sessionId`, `executionRecovery`.
- 모양은 "외부 코딩 에이전트 CLI 프로세스를 한 번 실행하고 종료 코드·사용량을 받는" 계약입니다. LLM API 한 번 호출하는 계약이 아닙니다. 서버가 직접 LLM API를 부르는 곳은 AI SDK(`ai`)를 쓰는 `services/{decision-model-provider,fast-response-provider,prompt-injection-provider}.ts` 3개뿐입니다. [1차]

### 1.10 plugin host

| 항목 | 사실 | 근거 |
|---|---|---|
| 규모 | `server/src/services/plugin-*.ts` 비테스트 합 약 22,400줄(33개 파일). `plugin-worker-manager.ts` 3,955줄, SDK `protocol.ts` 2,721줄 | `wc -l` |
| 구조 | worker 자식 프로세스, stdio JSON-RPC 2.0 | `plugin-worker-manager.ts:3` |
| DB 격리 | `CREATE SCHEMA IF NOT EXISTS <namespace>`; namespace mode는 `schema`만 | `plugin-database.ts:376`, `constants.ts:1429` |
| capability | `PLUGIN_CAPABILITIES`(constants.ts:1322~1427) 대부분이 `issues.*`, `agents.*`, `goals.*`, `approvals.respond`, `projects.managed` 같은 도메인 키 | [1차] |
| 의존 | worker manager가 `@paperclipai/adapter-utils/acpx-engine/startup-timing`, server instrumentation을 import | `plugin-worker-manager.ts:62-69` |

### 1.11 CLI·설정·비밀·Docker

| 항목 | 사실 | 근거 |
|---|---|---|
| CLI | `commander` ^15, `@clack/prompts` ^1.7. 명령 `onboard`, `doctor`, `run`, `service`, `configure`, `db-backup`, `channels`, `worktree`, `update`, `uninstall` 등 | `cli/package.json`, `cli/src/commands/` |
| doctor 점검 | `cli/src/checks/`: config, database, deployment-auth, agent-jwt-secret, llm, log, managed-install, port, secrets, service-health, storage | [1차] |
| 설정 스키마 | `packages/shared/src/config-schema.ts`(349줄). `deploymentMode` 기본 `local_trusted`, `exposure` 기본 `private`. `local_trusted`면 `exposure=private` 강제, `authenticated`+`public`이면 `auth.baseUrlMode=explicit` 강제 | `config-schema.ts:49-50,145-178` |
| 홈 디렉터리 | `PAPERCLIP_HOME` 또는 `~/.paperclip` | `packages/shared/src/home-paths.ts:17-19` |
| 비밀 | `SECRET_PROVIDERS` = `local_encrypted`, `aws_secrets_manager`, `gcp_secret_manager`, `vault`. gcp·vault는 `unavailableProvider` 스텁. 로컬은 AES-256-GCM, 마스터 키는 `PAPERCLIP_SECRETS_MASTER_KEY(_FILE)` 또는 키 파일 자동 생성 | `shared/src/constants.ts:706-711`, `server/src/secrets/external-stub-providers.ts:84-87`, `local-encrypted-provider.ts:23-76,216-231` |
| Docker | 멀티스테이지(base → deps → Rust runner 4단계 → build → runner-provider-pack → production → cloud-plugins/cloud). tini PID 1, gosu, `EXPOSE 3100`, `CMD node server/dist-runtime/index.mjs` | `Dockerfile:2-243,266-333` |
| Compose | `docker/docker-compose.yml`(postgres:17-alpine + 서버), `docker-compose.quickstart.yml`, `docker-compose.untrusted-review.yml`, quadlet, ECS | `docker/` |

### 1.12 chat 어댑터 (D-15 "미분석" 항목)

**정체**: `@chat-adapter/*`는 Paperclip 자체 패키지가 아니라 Vercel의 오픈소스 Chat SDK(`chat` 코어 + 공급자별 어댑터)입니다. 4.39.0 고정, 모두 MIT, 저장소 `github.com/vercel/chat`. 2026-10-27 현재 `chat` latest는 4.43.0. [1차] https://registry.npmjs.org/chat , https://chat-sdk.dev/docs

**Paperclip 쪽 규모**: `server/src` 안 chat 관련 비테스트 파일 241개, 81,456줄. `services/chat-*.ts` 비테스트 75개, `services/chat-channels/`(slack, discord, telegram, teams, github, imessage-photon, inbound, interactions, publications, runtime). DB 테이블은 `packages/db/src/schema/chat_channels.ts`(808줄)의 12개(`chat_endpoints`, `chat_conversations`, `chat_deliveries`, `chat_publications`, `chat_actions`, `chat_endpoint_leases`, `chat_sdk_state` 등) + `chat_*.ts` 11개 파일. [1차]

**어댑터 생성**: `server/src/services/chat-sdk-runtime.ts`(3,308줄) `createProviderAdapter`(1350행). `new Chat({ …, concurrency: "concurrent" })`(2188-2194행).

| 관심사 | Telegram | Discord | 근거 |
|---|---|---|---|
| 인바운드 수신 (upstream 지원) | `mode: "auto" \| "webhook" \| "polling"`. polling은 `getUpdates` long polling 루프, 실패 시 지수 백오프(최대 30초) | Gateway(discord.js `Client`, 인텐트 Guilds/GuildMessages/MessageContent/DirectMessages/Reactions) 또는 HTTP interactions(`publicKey` 서명 검증) | `npm-chat/telegram/package/dist/index.js:1051-1066,3318-3400`, `npm-chat/discord/package/dist/index.js:868-873,2333-2380` |
| 인바운드 수신 (Paperclip 사용) | **`mode: "webhook"` 고정**. `setWebhook`에 `secret_token`, `allowed_updates` 지정. 공개 HTTPS URL(포트 443/80/88/8443) 필수 | **Gateway 전용**. `webhookVerifier: async () => false`로 HTTP interaction 차단. upstream `startGatewayListener`는 기간 제한(기본 180초) 서버리스형이라 Paperclip이 재시작 루프로 감싸 상시 실행 | `chat-sdk-runtime.ts:1484-1494,1427-1470,2320-2345`, `chat-channels/telegram/setup.ts:30-80,118` |
| 버튼·콜백 | `callback_query` → `processAction` → `answerCallbackQuery` 자동 ACK. `callback_data` 64바이트 제한을 인코더가 검사 | `custom_id` 1~100자 검사, component interaction은 `deferUpdate` | telegram `dist/index.js:32,82-96,1543-1575`; discord `dist/index.js:88-119,1327` |
| 중복 수신 (upstream) | webhook 경로만 `setIfNotExists("telegram:webhook-update:<scope>:<update_id>", TTL 24h)`. **polling 경로는 update_id 중복 검사 없음, offset은 메모리에만 있고 `processUpdate`를 기다리지 않음** | 코어 `Chat`이 `dedupe:<adapter>:<messageId>`를 `setIfNotExists`(TTL 10분) | telegram `dist/index.js:1199-1235,3340-3360`; chat `dist/index.js:574,2075-2079` |
| 중복 수신 (Paperclip 추가) | `chat_deliveries`에 `(endpoint_id, provider_event_id)`·`(endpoint_id, deduplication_key=sha256)` 유니크, 상태 `received/filtered/processing/processed/retry/failed`. `chat_actions`에 `(endpoint_id, provider_action_id)` 유니크 | 같음. Gateway 소유자는 `chat_endpoint_leases`로 1개 프로세스만 | `chat_channels.ts:431-510,647-705,748-779`, `chat-channels/inbound/admission.ts:220-250` |
| 상태 저장소 | upstream은 `StateAdapter` 인터페이스(memory, redis, pg 등 별도 패키지). Paperclip은 `chat_sdk_state` 테이블 위 CAS 구현(`ChatSdkStatePersistence.compareAndSet/deleteIfVersion/read`, 609줄) | 같음 | `server/src/services/chat-sdk-state.ts:1-60`; https://registry.npmjs.org/@chat-adapter/state-pg/4.39.0 |
| rate limit | upstream: HTTP 429면 `AdapterRateLimitError(retry_after)` 던짐, 재시도는 호출자 몫 | upstream: `discordFetch`가 비정상 응답을 `NetworkError`로 던짐, 429 전용 처리 없음 | telegram `dist/index.js:3485-3486`; discord `dist/index.js:2290-2318` |
| rate limit (Paperclip) | 발신은 `chat_publications` outbox(상태 `pending/streaming/published/retry/delivery_unknown/failed/cancelled/awaiting_consent`). 공급자 rate limit은 5회 재시도 한도에서 제외하고 공급자 지정 간격까지 재시도. 공급자가 받았는데 결과 미확인이면 `delivery_unknown`(재발송 안 함) | 같음 | `chat_channels.ts:511-583`, `chat-channels/publications/failures.ts:60-100`(publications 합 4,162줄) |
| 질문 폼 | `chat` 코어의 `Modal`/`Select`/`RadioSelect`/`TextInput`로 질문 세트를 그림. 토큰 TTL 7일 | 같음(Discord는 native modal 패치) | `server/src/services/chat-question-forms.ts`(1,076줄) |
| Paperclip 패치 | 238줄: 다운로드 상한 설정, draft 스트리밍 중단 제어, API 타임아웃 45초 | 3,518줄(+1,655줄): Gateway 이벤트 콜백, guild 필터, root thread 생성 승인 hook, native modal, `paperclipCompatibilityRevision`(d.ts v5 / js v6). 별도로 `@discordjs/ws` 1,168줄 패치 | `patches/` |

---

## 2. 지도 보고서와 다른 점

| 지도 서술 | 이번 확인 | 영향 |
|---|---|---|
| schema 파일 173개, migration 370개 | 174개, 378개 | 활발히 변경 중. 수치는 시점 의존 |
| `heartbeat.ts` 4,143줄, `index.ts` 2,222줄, `services/issues.ts` 11k줄 이상 | 4,171 / 2,287 / 13,875줄 | 같음 |
| `routes/` 98개, `services/` 최상위 비테스트 650개 | 92개, 681개 | 기준 차이 가능. 판단에는 영향 없음 |
| `LiveUpdatesProvider` 2,200줄 | 2,267줄 | — |
| chat 서비스 134개 | `services/chat-*.ts` 비테스트 75개(테스트 포함 147개). chat 관련 비테스트 전체 241개·81k줄 | 지도 수치는 테스트 포함 기준으로 보임 |
| checkout은 `SELECT … FOR UPDATE`와 조건부 UPDATE | 획득은 조건부 UPDATE(CAS) 한 문장. `FOR UPDATE`는 stale 회수·종료 run 정리 경로 | 10절 4번 해소 |
| 예산: 원장 + 정책 + 하드 한도 일시정지 | 여기에 **사전 예약(`budget_reservations`, `reserveRunBudget`)** 과 `unpricedUsagePolicy=block`이 있음 | PRD 예약 상한 설계의 직접 근거 |
| `approvals` 타입 예: `hire_agent`, `approve_ceo_strategy` | 4종 + 상태 5종(`revision_requested` 포함) | 질문·승인 상태 enum 설계 참고 |
| wake queue: "두 모듈이 heartbeat와 떨어져 있다면 차용으로 올릴 수 있음" | 떨어져 있지 않음. heartbeat가 유일 호출자이고 트랜잭션·helper를 주입 | "패턴" 확정 |
| plugin host: "가장 큰 범용 자산, 차용" | 약 22k줄, capability 키 대부분이 도메인 키, ACP 런타임 import | MVP 차용 대상에서 제외 |
| chat 채널: "교체(도메인 전용·실험적), 내부 미분석" | 공급자 접속부는 Vercel Chat SDK(MIT, npm). Paperclip 코드는 그 위의 내구성 계층(inbox·outbox·lease·CAS state) | 판단 변경(4절) |
| 서버 스택: AI SDK 언급 | 서버가 직접 LLM API를 부르는 곳은 3개 파일. 실행 경로는 코딩 CLI 어댑터 | adapter SPI를 LLM 어댑터로 쓰기 어려움 |
| 실시간: company별 EventEmitter → WS | 같음. 추가로 이벤트 id가 메모리 카운터(재시작 시 초기화, replay 없음), 단일 프로세스 전제 | 재연결 시 전체 refetch 필요 |
| 비밀 provider: local/AWS | 4종 선언, gcp·vault는 스텁 | — |
| 라이선스 미확인(PRD D-15) | MIT, 루트 NOTICE 없음 | 해소 |

---

## 3. 재사용 판단 갱신

분류: **그대로 차용**(코드 복사 또는 npm 의존, 이름만 바꿈) / **패턴만**(설계만 가져와 새로 작성) / **따르지 않음**.

D-15(c)에 따라 Paperclip 저장소를 의존성으로 걸지 않습니다. "그대로 차용"은 해당 파일을 MIT 고지와 함께 복사하거나, Paperclip이 쓰는 같은 외부 npm 패키지를 직접 쓰는 것을 뜻합니다.

| 구성요소 | 지도 판단 | 갱신 판단 | 근거 |
|---|---|---|---|
| embedded/external PG 해석·수명주기 (`runtime-config.ts`, `embedded-postgres-*.ts`, `createDb`) | 차용 | **그대로 차용** | 합 약 600줄, 도메인 무관. 단 `embedded-postgres`가 beta(18.1.0-beta.16) 버전이라 버전 고정과 패치(30줄) 함께 가져옴 |
| migration runner + safety linter + numbering 검사 | 차용 | **그대로 차용**(runner), **패턴만**(safety baseline) | runner는 `client.ts` 안 함수들(938~1200행). baseline은 Paperclip 이력 전용 |
| `backup-lib.ts` | 차용 | **그대로 차용** | 1,133줄, 도메인 무관 |
| `work-signals.ts` | 차용 | **패턴만** | 114줄. 프로세스 내 힌트라 단일 프로세스 전제. 필요 시 재작성 |
| config 로딩 + 설정 보안 모델(deployment mode × exposure × bind) | 차용 | **그대로 차용**(스키마 구조), 키는 새로 정의 | `config-schema.ts` 349줄의 refinement 규칙이 NFR-SEC-03과 일치 |
| `HttpError`·`errorHandler`·`validate` | 차용 | **그대로 차용** | — |
| 주체 모델·mutation guard·hostname guard | 차용(이름 변경) | **그대로 차용(이름 변경)** | 확인 범위 밖 변경 없음 |
| storage / secrets registry, `local_encrypted` | 차용 | **그대로 차용**(local_encrypted만) | AES-256-GCM, 키 파일 자동 생성. AWS·스텁 provider는 가져오지 않음 |
| `activity_log` + persist/publish 분리 | 차용 | **그대로 차용**(스키마·redaction·커밋 후 발행) | — |
| live events(EventEmitter → WS) | 차용 | **패턴만** | 66줄로 작음. 이벤트 id를 DB 시퀀스로 바꾸고 재연결 replay를 넣는 편이 맞음(메신저·UI 동시 사용) [추론] |
| `approvals` | 차용(type 교체) | **패턴만** | 테이블은 단순. PRD는 `Question`/`Approval`을 1급 객체로 따로 둠. 상태 enum(`revision_requested` 포함)만 참고 |
| `cost_events` + `budget_policies` + `budget_reservations` + hard stop | 패턴 | **패턴만**(강하게 권장) | idempotencyKey 유니크, 사전 예약, unpriced=block, scope 일시정지 구조를 그대로 설계에 반영. 코드는 heartbeat_runs·native runtime에 결합 |
| 원자적 checkout | 패턴 | **패턴만** | 조건부 UPDATE(CAS) + 종료 run 확인 후 stale 채택. `Task`에 같은 SQL 모양 적용 |
| wake queue / run 분리 | 패턴(잠정) | **패턴만(확정)** | 1.7절. idempotencyKey 접두어, coalescing, claim 시 재검사만 가져옴 |
| adapter SPI | 패턴(잠정) | **패턴만**, LLM 어댑터 계약으로는 **따르지 않음** | 코딩 CLI 프로세스 실행 계약. `testEnvironment`, capability flag, `getConfigSchema`, `usageBasis`, `retryNotBefore`, `errorFamily` 아이디어만 사용 |
| plugin host + SDK | 차용 | **따르지 않음(MVP)**, 패턴만(v1 이후) | 22k줄, 도메인 capability, ACP 결합. MVP에 플러그인 요구 없음 |
| `modules/` 육각형 구조 + `check-module-boundaries.mjs` | 차용 | **패턴만** | 규칙은 가져오되 스크립트는 경로·패키지명이 Paperclip 전용 |
| UI 인프라 골격 | 차용 | **패턴만** | 같은 라이브러리(React 19, Vite 8, Tailwind 4, React Query 5)를 쓰고 파일은 새로 작성 |
| CLI 골격(onboard → doctor → run, check registry, service) | 차용 | **패턴만** | commander + @clack/prompts 조합과 check 목록 구조만. 명령 대부분 도메인 전용 |
| Docker | 차용(Rust 제거) | **패턴만** | Rust runner·provider pack·cloud 단계가 Dockerfile 대부분. tini·gosu·compose 구성만 참고 |
| MCP facade | 패턴 | 패턴만(유지) | — |
| agents 조직도, heartbeat 실행 계층, 코딩 CLI 어댑터, runner, cloud 미들웨어 | 교체 | **따르지 않음**(유지) | — |
| chat 채널 | 교체 | **4절 참조** | — |

---

## 4. chat 어댑터 판단

### 4.1 결론

| 층 | 판단 | 이유 |
|---|---|---|
| 공급자 접속(Vercel Chat SDK: `chat`, `@chat-adapter/telegram`, `@chat-adapter/discord`) | **그대로 차용(npm 직접 의존)** | MIT. Telegram webhook/polling, Discord Gateway/interactions, 버튼·모달·셀렉트, 메시지 정규화, 429 오류 분류를 이미 갖춤. Paperclip을 거치지 않고 upstream 패키지를 씀 |
| Paperclip 패치(`patches/@chat-adapter__*`) | **따르지 않음**(Discord root-thread 승인 hook만 필요 시 참고) | Telegram 패치는 draft 스트리밍 제어 등 Paperclip 기능용. Discord 패치 3,518줄은 유지 부담이 크고 4.39.0에 고정돼 있음 |
| Paperclip chat 서비스(`chat-sdk-runtime.ts`, `chat-channels/**`, 81k줄) | **따르지 않음** | issue·run·agent·wake queue에 결합. 6개 공급자 지원 |
| Paperclip 내구성 계층 설계 | **패턴만** | `chat_deliveries`(인바운드 inbox, 공급자 이벤트 ID 유니크, 상태 머신), `chat_actions`(버튼 클릭 유니크), `chat_publications`(outbox, `delivery_unknown`, rate limit은 재시도 횟수에서 제외), `chat_endpoint_leases`(Gateway 소유자 1개), `chat_sdk_state`(PG 위 CAS StateAdapter) |

### 4.2 설계 시 메울 것

| 항목 | 이유 | 대응(설계 제안) |
|---|---|---|
| Telegram 로컬 수신 | Paperclip은 webhook만 씀(공개 HTTPS 필요). PRD 11절은 "로컬은 long polling, 서버는 webhook+secret_token" | upstream `mode: "polling"` 사용(로컬), `mode: "webhook"` + `secretToken`(자체 호스팅) |
| Telegram polling 중복·유실 | upstream polling은 update_id dedupe 없음, offset 메모리 보관, 처리 완료 전 offset 전진 | 수신 즉시 `update_id`를 키로 inbox 테이블에 유니크 insert 후 처리. 마지막 처리 offset을 DB에 저장해 재시작 시 사용 |
| Discord 상시 Gateway | upstream `startGatewayListener`는 기간 제한(기본 180초) | Paperclip처럼 감독 루프로 재시작(`chat-sdk-runtime.ts:2320-2345` 패턴). 단일 프로세스면 lease 불필요, 자체 호스팅 다중 프로세스면 lease 테이블 |
| Discord 429 | upstream REST 호출이 429를 일반 오류로 던짐 | outbox worker가 상태 코드·`retry_after`를 읽어 재시도 시각 결정 |
| StateAdapter | 코어 `Chat`의 dedupe·lock·구독이 StateAdapter에 의존 | `@chat-adapter/state-pg`(MIT, `pg` 드라이버) 또는 `chat_sdk_state` 패턴의 CAS 구현. 가정: 메모리 StateAdapter는 재시작 시 dedupe 상태 유실 |
| 버튼 데이터 | Telegram 64바이트, Discord 100자 | PRD 11절대로 질문 ID + 선택지 인덱스만. SDK 인코더가 초과 시 오류를 던짐 |
| 버전 | 4.39.0(Paperclip 고정) → latest 4.43.0. 4.40~4.43 변경 내역 [미확인] | 설계 시 최신 버전 고정 후 polling·gateway 동작 재확인 |

---

## 5. 기술 스택 시사점 (08-tech-stack 입력)

| 영역 | 시사점 | 근거 등급 |
|---|---|---|
| 런타임 | Node 24 LTS + TypeScript, pnpm workspace. Paperclip 패턴·Chat SDK·AI SDK와 같은 생태계라 이식 비용이 가장 낮음 | [1차]+[추론] |
| RDB | PostgreSQL + embedded-postgres(로컬 무설정) → 외부 PG(자체 호스팅). D-2 경로와 일치. 단 embedded-postgres가 beta 버전이고 OS별 바이너리 패키지라 설치 크기·플랫폼 지원 확인 필요 [미확인] | [1차] |
| ORM·마이그레이션 | drizzle-orm(Apache-2.0) + postgres.js, SQL 생성은 drizzle-kit, 적용은 자체 runner(파일 단위 트랜잭션) | [1차] |
| 서버 | Express 5 + ws + zod 4 + pino. 실시간은 WS. 이벤트 id를 DB 기반으로 두면 재연결 replay 가능 | [1차]+[추론] |
| UI | React 19, Vite 8, Tailwind 4, React Query 5, react-router 7 | [1차] |
| LLM 호출 | Paperclip adapter SPI는 코딩 CLI용이라 D-9 역할별 혼합 어댑터의 근거가 아님. Paperclip 서버도 직접 호출에는 Vercel AI SDK(`ai` + `@ai-sdk/*`)를 씀. Chat SDK의 `ai` peer 의존(optional)과도 맞음 | [1차]+[추론] |
| 메신저 | Vercel Chat SDK(`chat` + `@chat-adapter/telegram`·`discord`)를 직접 의존. 내구성(inbox/outbox/lease/CAS state)은 자체 테이블 | [1차] |
| 예산 | `cost_events`(idempotencyKey 유니크) + `budget_policies`(metric·window·hard stop) + `budget_reservations`(사전 예약) 3테이블 구조를 텍스트·이미지·영상 metric으로 확장 | [1차] |
| 작업 잠금 | `Task`에 조건부 UPDATE CAS + run 종료 확인 후 stale 채택 | [1차] |
| 비밀 | `local_encrypted`(AES-256-GCM, 키 파일) 패턴. 메신저 봇 토큰·LLM 키 저장에 사용 | [1차] |
| CLI | commander + @clack/prompts, `onboard`/`doctor`/`run`/`service` 구성 | [1차] |
| Graph DB | Paperclip에 Graph DB·온톨로지 저장소 코드 없음(`neo4j`·`ontology`·`cypher` grep 결과는 외부 커넥터 Enterpret의 Cypher 도구 위험 주석 2건뿐: `server/src/services/connectors/enterpret/risk.ts:6`, `packages/shared/src/app-definitions.ts:280`). D-27·FR-ONT-12~19의 엔티티 해소·통제 어휘는 참고 대상 없음 | [1차] |
| 라이선스 | Paperclip MIT, Chat SDK MIT, drizzle Apache-2.0. 복사한 파일에는 Paperclip MIT 고지 유지, 배포물에 서드파티 고지 파일 생성 필요 | [1차] |

---

## 6. 남은 미확인

1. Chat SDK 4.40~4.43 변경 내역(polling dedupe·Gateway 상시 실행 추가 여부).
2. embedded-postgres beta 바이너리의 macOS/Windows/Linux arm64 지원과 설치 크기.
3. Paperclip `chat_deliveries` 처리 worker의 재시도·순서 보장 세부(`chat-delivery-work.ts`, `durable-chat-wakeup.ts` 384줄은 읽지 않음).
4. `services/native-runtime/`(268개)과 ACP 경로는 이번에도 읽지 않았습니다. 판단은 "따르지 않음"이라 영향 없음.
5. 런타임 동작은 관찰하지 않았습니다(빌드·실행 안 함).
