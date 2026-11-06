# 10. Paperclip 대응 (Paperclip Mapping)

| 항목 | 내용 |
|---|---|
| 문서 | novel-create-studio 상세 설계 10 |
| 버전 | v0.1 (2026-10-27) |
| 기준 | PRD v0.3, `00-foundation.md` v0.1, `03-domain-model.md` v0.1 |
| 역할 | Paperclip의 개념·코드 영역이 이 제품의 어느 모듈·설계 절에 대응하는지, 무엇을 코드로 가져오고 무엇을 패턴만 따르고 무엇을 따르지 않는지 정합니다. 코드 차용 시 MIT 고지 방식과 chat 어댑터 재사용 판단(D-15)을 정합니다. |
| 작성 | AI 초안. 사람 검토 필요 |

**표기**
- **[1차]** 소스·공식 레지스트리에서 직접 확인, **[추론]** 소스 근거의 추론, **[미확인]** 확인하지 않음, **가정:** 조사·실측 없는 전제.
- Paperclip 경로는 저장소 루트 기준 상대 경로이고 `파일:행`으로 적습니다. 줄 수는 기준 커밋의 `wc -l` 값입니다.
- "→ 0X"는 해당 설계 문서를 가리킵니다. 02·04~09는 이 문서와 동시에 작성 중이라 절 번호 대신 주제로 가리킵니다.

---

## 0. 목적·범위·관련 요구·선행 문서

| 항목 | 내용 |
|---|---|
| 목적 | ADR-001(새 코드베이스, 패턴·범용 인프라만 차용)을 영역별 판단으로 펼칩니다. 구현자가 "이 부분은 Paperclip에서 가져오는가, 무엇을 참고하는가, 왜 다르게 하는가"를 이 문서 한 곳에서 찾게 합니다. |
| 범위 | Paperclip main 커밋 `0cb3fc7`의 패키지·서버·UI·CLI·배포 영역, Paperclip이 쓰는 외부 패키지(Vercel Chat SDK, Vercel AI SDK, embedded-postgres, drizzle). 각 영역의 상세 설계는 담당 문서가 소유하고 여기서는 참조만 합니다. |
| 범위 밖 | 세계관 온톨로지·엔티티 식별(D-27, FR-ONT-12~19). Paperclip에는 Graph DB·온톨로지 코드가 없습니다 [1차, `neo4j`·`ontology`·`cypher` grep 결과는 외부 커넥터 위험 주석 2건뿐]. → 06 |
| 관련 요구 | PRD 요구 5, 14.2절, D-2, D-7, D-9, D-15, D-16, FR-AGT-02, FR-BUD-01~04, FR-HIL-03, FR-MAN-06a·06b, FR-MSG-02, FR-SET-01·03, NFR-REL-01~06, NFR-SEC-01~05, NFR-OBS-01, NFR-EXT-01, NFR-EXT-04a, R-8, R-12, R-13 |
| 관련 ADR | ADR-001, 002, 003, 004, 008, 009, 010, 011, 013, 014, 015, 016, 017 (→ 00 3절) |
| 선행 문서 | `00-foundation.md`(용어·ADR·모듈·enum), `03-domain-model.md`(엔티티·불변식), `08-tech-stack-and-repo.md`(저장소 구조·빌드, 작성 중) |
| 근거 | (1) Paperclip 소스 재확인 조사(2026-10-27, 커밋 `0cb3fc7`, 읽기·grep만, 빌드·실행 안 함). (2) 지도 보고서 `/Users/snowfall/orca/docs/paperclip-architecture-map.md` 8절 재사용 판단표. (3) 이 문서 작성 중 같은 클론에서 추가로 확인한 import 관계(1.3절). |

---

## 1. 기준과 분류 규칙

### 1.1 기준 소스

| 항목 | 값 |
|---|---|
| 저장소 | https://github.com/paperclipai/paperclip |
| 커밋 | `0cb3fc7db591ba23e21fbbc70042bc44ec7d6f20` (2026-10-26) [1차] |
| 라이선스 | MIT, "Copyright (c) 2025 Paperclip AI". 루트 NOTICE·THIRD_PARTY 파일 없음. 모든 패키지 `"license": "MIT"` [1차, `LICENSE`, 각 `package.json`] |
| 확인 방법 | `git clone --depth 1` 후 읽기·grep. 설치·빌드·실행은 하지 않았습니다. 런타임 동작은 [미확인]입니다. |

PRD D-15의 "라이선스 확인 필요(미확인)"와 "chat 어댑터 미분석"은 이 문서로 해소합니다(→ 01 6절 P-05).

### 1.2 분류

| 분류 | 의미 | 라이선스 의무 |
|---|---|---|
| **그대로 차용(복사)** | Paperclip 파일(또는 함수)을 복사해 이름·설정 키만 바꿔 씁니다. | MIT 고지 필요(5절) |
| **그대로 차용(npm)** | Paperclip이 쓰는 **같은 외부 패키지**를 우리가 직접 의존합니다. Paperclip 코드는 거치지 않습니다. | 해당 패키지 라이선스 고지(5.4절) |
| **패턴만** | 설계(테이블 모양, 상태 기계, 알고리즘)만 가져와 새로 작성합니다. | 가정: 코드 표현을 복사하지 않으면 MIT 고지 대상이 아닙니다(8절 미결) |
| **따르지 않음** | 가져오지 않습니다. 대신 쓰는 설계를 함께 적습니다. | — |

D-15(c)에 따라 Paperclip 저장소나 `@paperclipai/*` 패키지를 의존성으로 걸지 않습니다(ADR-001).

### 1.3 조사 판단에서 바꾼 것

조사 파일의 갱신 판단(지도 8절 대비)을 따르되, 이 문서 작성 중 import를 확인해 아래 네 항목은 판단을 낮췄습니다.

| 영역 | 조사 판단 | 이 문서 판단 | 근거 [1차, 이번 확인] |
|---|---|---|---|
| 중앙 `errorHandler` | 그대로 차용 | **패턴만** (`HttpError`·`validate`는 복사 유지) | `server/src/middleware/error-handler.ts`(328줄)가 `modules/agent-lifecycle`, `routes/company-import-paths`, `services/responsible-user-denial-run-outcomes`, telemetry, sentry를 import |
| `activity_log` 기록 서비스 | 그대로 차용(스키마·redaction·커밋 후 발행) | **패턴만** | `server/src/services/activity-log.ts`(241줄)가 `heartbeatRuns`, `issues`, `agentApiKeys`, plugin SDK, delivery-work를 import. 우리 스키마는 `seq`·`before`/`after`·`question_id` 등으로 다름(→ 03 6.2) |
| 회사 삭제 participant | 차용(이름 변경) | **패턴만** | `lib/company-deletion.ts`는 인터페이스 9줄, 순서·트랜잭션은 `services/company-deletion.ts`(123줄)가 company 테이블에 결합 |
| MCP facade | 패턴만(유지) | **따르지 않음(MVP)** | 이 제품의 에이전트는 외부 프로세스가 아니라 서버 안의 LLM 호출(ADR-010)이라 MCP 소비자가 없음 |

---

## 2. 개념 대응

PRD 14.2절 개념 매핑을 설계 이름으로 갱신합니다.

| Paperclip 개념 | 이 제품 | 판단 | 차이 | 상세 |
|---|---|---|---|---|
| Instance | 설치(install) | 패턴만 | 설치 단위 테이블(`users`, `provider_profiles`, `messenger_bots` 등) | → 03 2.2 T-6 |
| Company (테넌트 루트) | `Novel` | 패턴만 | 모든 작품 소속 테이블 `novel_id NOT NULL` + 복합 FK. Paperclip은 일부 오래된 테이블이 단일 FK [1차, 지도 4절] | → 03 2.2 T-1~T-4 |
| Goal → Project → Issue, "because" 체인 | `Goal` → `Arc` → `Episode` → `Scene`, 대상별 `Task` | 패턴만 | 레벨 이름을 서사 단위로 교체. `Task.goal_id` 필수(`INV-TSK-01`) | → 03 3.3 |
| Agent (조직도, persona, 고용 승인) | `agent_role` enum | 따르지 않음 | 에이전트는 엔티티가 아니라 역할 값. 조직도·고용 승인 없음 | → 00 6.3, 04 |
| Issue checkout / stale 채택 | `Task` lease (`lease_run_id`, `lease_expires_at`) | 패턴만 | 기한 있는 임대 + 갱신. Paperclip은 기한 없이 run 종료 여부로 판단 | → 03 3.3 `INV-TSK-03`, 04 |
| `agent_wakeup_requests` / `heartbeat_runs` | `WakeRequest` / `Run` | 패턴만 | `wake_reason`, `wake_status` 자체 정의 | → ADR-009, 04 |
| Heartbeat (주기 깨우기) | 스케줄러 + 사건 기반 깨우기 | 따르지 않음 | 에이전트 세션·transcript가 없음. 실행은 작업 단위 LLM 호출 묶음 | → 04 |
| Comment (유일한 소통 채널) | `Question` + `Answer` + `AnswerReflection` | 따르지 않음 | 질문은 등급·마감·추천안·반영 기록을 가진 1급 객체 | → 03 3.4, 05 |
| Approval | `Approval` + 1:1 `Question` | 패턴만 | 승인 결정은 `Approval`, 사람에게 묻기는 `Question`(ADR-014) | → 03 3.4, 05 |
| Board (사람 거버넌스) | 사용자(`user_role=owner`) 통제 | 패턴만 | 일시정지·재개·override는 사용자 권한. 다중 사용자는 D-16에 따라 이후 | → 03 6.1 |
| Budget / CostEvent / hard stop | `BudgetPolicy` / `BudgetReservation` / `CostEvent` | 패턴만 | 금액 micro-USD 정수(ADR-016), `cost_category` 텍스트·이미지·영상 | → 03 7절 |
| Activity log + live events | `ActivityLog` + `seq` replay | 패턴만 | 이벤트 ID를 DB 순번으로(ADR-017) | → 03 6.2, 02 |
| Adapter SPI (코딩 CLI) | `LlmAdapter` 포트 + 이미지·영상·메신저 어댑터 | 따르지 않음(아이디어만) | 호출 1회 계약(ADR-010) | → 04 |
| Plugin host | 없음(MVP) | 따르지 않음 | 확장은 모듈·어댑터로 | 3.8절 |
| deployment mode × exposure | `deployment_mode`(`local_trusted`/`self_hosted`) × `exposure` | 그대로 차용(구조) | Paperclip `authenticated`를 `self_hosted`로 이름 변경 | → ADR-002, 02 |
| CLI onboard → doctor → run | `apps/cli` 같은 흐름 | 패턴만 | 점검 항목은 `health_check_kind` | → 08, FR-SET-01·03 |
| 원칙 "surface-not-self-heal" | 같은 원칙 | 패턴만 | 연속성 이슈·답변 반영을 조용히 고치지 않고 기록·통지 | FR-AGT-10, FR-MSG-09 |

---

## 3. 코드 영역 대응표

행 ID `PM-nn`은 다른 문서가 이 표의 판단을 인용할 때 씁니다.

### 3.1 DB 런타임·마이그레이션·백업 (`packages/db`)

| ID | Paperclip 영역 (근거) | 판단 | 우리 쪽 | 차이와 이유 |
|---|---|---|---|---|
| PM-01 | embedded/external PG 해석: `packages/db/src/runtime-config.ts`(236줄, `resolveDatabaseTarget`) | 그대로 차용(복사) | `packages/db` 런타임, → 02 저장소 구성, 08 | 도메인 무관 [1차]. `@paperclipai/shared/home-paths`의 경로 함수와 설정 파일 이름(`config.json`)만 우리 것으로 바꿉니다. PGlite 설정값을 embedded로 바꾸는 분기(`runtime-config.ts:114`)는 제거합니다. 우리는 PGlite를 테스트에만 씁니다(ADR-004). |
| PM-02 | embedded PG 수명주기: `packages/db/src/embedded-postgres-{lifecycle,native,error}.ts`(54+85+89줄), `server/src/embedded-postgres-{owner,supervisor}.ts`(12+92줄) | 그대로 차용(복사) | `packages/db`, `system` 모듈(시작·종료), → 02 장애·재시작 | 도메인 무관. Paperclip은 `embedded-postgres@^18.1.0-beta.16` + 30줄 패치(`LC_MESSAGES=C`) [1차]. 우리는 18.4.0-beta.17(ADR-004)이라 패치 필요 여부를 스파이크 S-1에서 확인합니다(8절). |
| PM-03 | DB 클라이언트: `packages/db/src/client.ts` `createDb`(291행) | 그대로 차용(함수 추출) | `packages/db` | `client.ts`(1,244줄)는 `schema/index`, `work-signals`, `response-capture`, `prepared-queries`를 import [1차]. 파일 전체가 아니라 `createDb`·연결 옵션 함수만 떼어 옵니다. |
| PM-04 | 마이그레이션 runner: `client.ts` `reconcilePendingMigrationHistory`(938), `inspectMigrations`(1052), `applyPendingMigrations`(1121), `migratePostgresIfEmpty`(1170) | 그대로 차용(함수 추출) | `packages/db` 마이그레이션, `system` 모듈 마이그레이션 게이트, → 08 | 파일 단위 트랜잭션, journal reconcile, 스키마가 오래되면 시작 거부 [1차, 지도 5절 흐름 B]. NFR-REL-05(업그레이드 실패 시 되돌림)는 runner만으로 부족해 업그레이드 전 자동 백업(PM-07)을 앞에 둡니다(→ 02). SQL 생성은 drizzle-kit(npm). |
| PM-05 | 마이그레이션 번호 검사: `check-migration-numbering.ts`(89줄) | 그대로 차용(복사) | CI 품질 게이트, → 08 | 도메인 무관. |
| PM-06 | 마이그레이션 안전 linter·baseline: `check-migration-safety.ts`(1,052줄), `migration-safety-baseline.ts` | 패턴만 | CI 품질 게이트, → 08 | baseline은 Paperclip 이력 전용 [1차]. 규칙(큰 테이블 잠금, 비가역 변경)만 골라 씁니다. MVP 테이블 규모가 작아 1,052줄 전체는 과합니다(가정). |
| PM-07 | 백업·복원: `packages/db/src/backup-lib.ts`(1,133줄) | 그대로 차용(복사) | `system` 모듈 백업·복원, `apps/cli backup/restore`, → 02 백업 | Node 내장 모듈과 `postgres`만 import [1차]. 백업 엔진은 `auto`/`pg_dump`/`javascript`이고 `pg_dump`가 없으면 JS 엔진으로 내려갑니다(`backup-lib.ts:535-574`). 복원은 `psql`을 먼저 쓰고 실패하면 구문 단위 JS 재생으로 내려갑니다(`1091-1110`) [1차]. ADR-004의 "`pg_dump` 동봉 [미확인]" 위험을 줄입니다. 차용한 JS 엔진은 단일 `REPEATABLE READ READ ONLY` 트랜잭션 안에서 모든 테이블 덤프와 참조 파일 목록 조회를 하도록 수정해야 합니다(→ 02 8.2 결정 표). 범위 타입·`EXCLUDE` 제약·확장이 JS 엔진으로 왕복되는지는 [미확인] → 스파이크 S-7. |
| PM-08 | work-signals: `packages/db/src/work-signals.ts`(114줄) | 패턴만 | `orchestration` 모듈 깨우기 힌트, → 04 | 트랜잭션 커밋 후 프로세스 안 listener 호출 [1차]. 단일 프로세스 전제이고 MVP는 두 모드 모두 단일 프로세스라 맞습니다(→ 02 2.3). 다중 프로세스는 이후(02 10절)이며 그때는 DB 폴링이 기준입니다. 힌트는 지연을 줄이는 용도로만 씁니다. |
| PM-09 | drizzle 스키마 174개·migration 378개 | 따르지 않음 | 자체 스키마(→ 03, 06) | 도메인 테이블. 단 파일 하나에 테이블 하나, 복합 테넌트 FK, enum은 text+CHECK(ADR-013) 관례는 따릅니다. |

### 3.2 서버 골격·설정·보안

| ID | Paperclip 영역 (근거) | 판단 | 우리 쪽 | 차이와 이유 |
|---|---|---|---|---|
| PM-10 | 설정 스키마: `packages/shared/src/config-schema.ts`(349줄) | 그대로 차용(구조) | `packages/shared` 설정 스키마, `system` 모듈 설정 로딩, → 08 | env → 파일 → 기본값 순서와 zod cross-field refinement를 가져옵니다. `local_trusted`면 `exposure=private` 강제(`config-schema.ts:145-149`), `public`이면 base URL 명시 강제(175행) [1차]. 키는 새로 정의합니다. `deploymentMode`의 `authenticated`는 `self_hosted`로 바꿉니다(→ 00 6.12). |
| PM-11 | 홈 경로: `packages/shared/src/home-paths.ts`(92줄, `PAPERCLIP_HOME` 또는 `~/.paperclip`) | 패턴만 | `packages/shared`, → 08 | 환경 변수·디렉터리 이름이 제품 전용입니다. 우리 이름은 08에서 정합니다. |
| PM-12 | `HttpError`와 생성 함수: `server/src/errors.ts`(46줄) | 그대로 차용(복사) | `apps/server` 공통 HTTP 계층 | import 없음 [1차]. |
| PM-13 | 중앙 오류 처리: `server/src/middleware/error-handler.ts`(328줄) | 패턴만 | `apps/server` 공통 HTTP 계층, → 02 | Zod → 400, redaction 후 로그, 예상 오류와 장애 구분은 따릅니다. 도메인 import가 많아(1.3절) 새로 씁니다. |
| PM-14 | 요청 검증: `server/src/middleware/validate.ts`(51줄) | 그대로 차용(복사) | `apps/server` 공통 HTTP 계층 | 도메인 무관. |
| PM-15 | 주체 미들웨어: `server/src/middleware/auth.ts`(1,044줄, `actorMiddleware`) | 패턴만 | `apps/server`, 주체 모델 → 03 6.1 | `req.actor` 개념만. Paperclip은 board·agent JWT·API 키·cloud 주체를 함께 처리합니다. 우리 MVP 주체는 `user`(owner 1명)와 서버 내부 `agent`/`system`입니다. |
| PM-16 | mutation·hostname guard: `server/src/middleware/board-mutation-guard.ts`(109줄), `private-hostname-guard.ts`(96줄) | 그대로 차용(복사, 이름 변경) | `apps/server` 공통 HTTP 계층, → 02 배포 모드 | `express` 타입만 import [1차]. "board" 이름을 바꿉니다. CSRF·same-origin·DNS rebinding 방어는 `local_trusted`에서도 필요합니다(NFR-SEC-03). |
| PM-17 | 로그 redaction: `server/src/middleware/redact-sensitive.ts`(264줄) / `server/src/redaction.ts`(1,021줄) | 전자 그대로 차용(복사), 후자 패턴만 | `audit` 모듈 redaction, → 03 6.2 규칙 | 전자는 import 없음, 후자는 `@paperclipai/adapter-utils` 명령 redaction에 의존 [1차]. 우리 가릴 대상은 API 키·봇 토큰·바인딩 토큰 원문입니다(NFR-SEC-02). |
| PM-18 | 테넌트 접근: `routes/authz.ts`(290줄) `assertCompanyAccess`, `getAccessibleResource`(404-not-403) | 패턴만 | `/api/novels/:novelId/...` 라우터 수준 테넌트 미들웨어, → 03 2.2 T-3·T-4 | Paperclip은 핸들러가 assert를 직접 호출합니다 [1차, 지도 4절]. 우리는 라우터와 repository 첫 인자(`NovelScope`)에서 강제하고 lint로 막습니다. |
| PM-19 | membership + `principal_permission_grants` | 따르지 않음(MVP) | `user_role=owner` 하나(D-16) | 다중 사용자 협업은 이후입니다. 이후 도입하면 키 기반 grant 패턴을 다시 봅니다. |
| PM-20 | 비밀: `server/src/secrets/local-encrypted-provider.ts`(313줄), `provider-registry.ts`(34줄) | 전자 그대로 차용(복사), registry 패턴만 | `system` 모듈 비밀 저장소, `secret_provider=local_encrypted`(→ 00 6.12) | AES-256-GCM, 마스터 키는 환경 변수 또는 자동 생성 키 파일 [1차]. 전자는 `home-paths`·`errors`·`types`만 import. AWS·GCP·Vault provider(뒤 둘은 스텁)는 가져오지 않습니다. 봇 토큰·LLM 키 저장에 씁니다(NFR-SEC-02). |
| PM-21 | 파일 저장소: `server/src/storage/local-disk-provider.ts`(97줄), `types.ts`, `provider-registry.ts`(18줄), S3 provider | local disk 그대로 차용(복사), S3는 보류 | `system` 모듈 `StorageProvider`(ADR-015) | MVP는 `local_disk`만. S3 호환은 `self_hosted` 요구가 생길 때 Paperclip `s3-provider.ts`를 다시 봅니다. |
| PM-22 | 서버 부트스트랩: `server/src/index.ts`(2,287줄), `app.ts`(1,513줄) | 패턴만 | `apps/server` 시작 순서, → 02 프로세스 구성 | 순서(설정 → DB·마이그레이션 게이트 → 서비스 → app → WS → 백그라운드 루프 → shutdown)만 따릅니다. 손 배선 대형 파일은 따르지 않고 모듈 등록 목록으로 씁니다(6절 AP-04). |

### 3.3 감사·실시간

| ID | Paperclip 영역 (근거) | 판단 | 우리 쪽 | 차이와 이유 |
|---|---|---|---|---|
| PM-23 | `activity_log` 스키마: `packages/db/src/schema/activity_log.ts:9-19` | 패턴만 | `activity_log`(→ 03 6.2), `audit` 모듈 | 테이블 이름은 그대로 씁니다(→ 00 5.3 예외). 우리는 `seq` 순번, `before`/`after`, `question_id`·`approval_id`·`answer_id`, `reason`을 더합니다(NFR-OBS-01). |
| PM-24 | 기록·발행 분리: `services/activity-log.ts:150-200` `persistActivity` → `publishActivity` | 패턴만 | `audit` 모듈: 상태 변경 트랜잭션 안에서 기록, 커밋 후 발행 | 구조는 같습니다. 코드는 도메인 import 때문에 새로 씁니다(1.3절). |
| PM-25 | live events: `services/live-events.ts`(66줄), `realtime/live-events-ws.ts`(460줄) | 패턴만 | `audit` 모듈 실시간 발행, → 02 이벤트·실시간 흐름 | Paperclip 이벤트 ID는 프로세스 메모리 카운터라 재시작 시 0부터이고 replay가 없습니다 [1차, `live-events-ws.ts:242-256`]. 우리는 `activity_log.seq`를 ID로 쓰고 재연결 시 replay합니다(ADR-017, FR-UI-08). |

### 3.4 작업·실행 (`orchestration`, `agents`)

| ID | Paperclip 영역 (근거) | 판단 | 우리 쪽 | 차이와 이유 |
|---|---|---|---|---|
| PM-26 | 원자적 checkout: `server/src/services/issues.ts`(13,875줄) `checkout` 11822행~, CAS UPDATE 11906행, stale 채택 `adoptStaleCheckoutRun` 7606행 | 패턴만 | `Task` lease(`INV-TSK-02·03`), → 04 lease | 획득은 조건부 UPDATE 한 문장(CAS), `FOR UPDATE`는 stale 회수에만 [1차]. 우리는 여기에 `lease_expires_at`과 갱신 주기(`lease.ttl_seconds`, `lease.renew_interval_seconds`, → 00 7.2)를 더합니다. 기한이 있어야 프로세스가 죽은 경우를 run 행 확인 없이도 판별할 수 있습니다. |
| PM-27 | wake queue: `server/src/services/heartbeat/queue.ts`(4,942줄), `modules/wake-queue`(4,494줄) | 패턴만(확정) | `WakeRequest`(→ 03 3.3), → ADR-009, 04 | 모듈 주석이 "heartbeat.ts holds the only caller", 트랜잭션은 heartbeat가 소유하고 helper를 주입받습니다 [1차, `modules/wake-queue/index.ts:60-110`]. 독립 차용 단위가 아닙니다. 가져오는 것: 출처 접두어가 있는 `idempotency_key`(→ 00 5.4), 같은 작업 대기 요청 합치기(`coalesced`), claim 시점 재검사. |
| PM-28 | run dispatch: `modules/run-dispatch`(2,424줄) | 패턴만 | → 04 재시도·대기 실행 정리 | scheduled retry 승격 게이트, 대기 run staleness 게이트만 소유하며 chat·workspace 상수에 결합 [1차]. 재시도 대기는 `tasks.not_before_at`으로 표현합니다. |
| PM-29 | claim 검사: `queue.ts` `claimQueuedRun`(945행) | 패턴만 | → 04 claim 가드 | 한 함수가 case handoff, Slack mention, agent 상태, 예산을 함께 검사합니다 [1차]. 우리는 가드를 이름 있는 검사 목록(일시정지, 예산, 의존, 임대)으로 나눕니다(6절 AP-05). |
| PM-30 | 고아 run 회수·재개(지도 5절 흐름 B 7단계) | 패턴만 | `run_status=interrupted`, `wake_reason=reclaim`, → 04 고아 실행 회수 | 우리는 `provider_calls` 응답 선저장(`INV-PC-01·02`)과 `unknown_cost`(→ 03 7.4 6단계)를 회수에 묶습니다(FR-AGT-02). |
| PM-31 | `heartbeat.ts`(4,171줄), `native-runtime/`(268개), transcript, agent 세션 | 따르지 않음 | → 04 | 코딩 에이전트 세션 실행 계층입니다. 우리 실행은 `Run` 하나 안의 `ProviderCall` 묶음입니다. |
| PM-32 | goals/projects/issues 계층 | 패턴만 | `Goal` → `Arc` → `Episode` → `Scene`, `Task.goal_id` | "모든 작업은 목표로 이어진다"만 가져옵니다. |
| PM-33 | `issues` 실행 결합 필드(checkout/execution run, workMode, tree hold, watchdog, recovery action) | 따르지 않음 | `tasks` 필드(→ 03 3.3) | 작업 상태 기계를 새로 정의했습니다(→ 03 4.2). |

### 3.5 비용·예산 (`budget`)

| ID | Paperclip 영역 (근거) | 판단 | 우리 쪽 | 차이와 이유 |
|---|---|---|---|---|
| PM-34 | `cost_events`: `schema/cost_events.ts:17-44` (`idempotencyKey` 유일, `costCents numeric(24,7)`) | 패턴만 | `cost_events`(→ 03 7.3) | `idempotency_key` 유일·append-only는 같습니다. 금액은 micro-USD 정수(ADR-016). `cost_basis`(`measured`/`estimated`/`unknown`)와 정정 행(`adjusts_cost_event_id`)을 더합니다(FR-BUD-04). |
| PM-35 | `budget_policies`: `schema/budget_policies.ts:10-29` (`warnPercent` 80, `hardStopEnabled`, `unpricedUsagePolicy=block`) | 패턴만 | `budget_policies`(→ 03 7.1) | scope는 작품 하나(T-5), metric은 `budget_category`. 기본값 `budget.soft_warn_ratio=0.80`, `budget.unpriced_usage_policy=block`은 Paperclip 값과 같습니다(→ 00 7.1). |
| PM-36 | 사전 예약: `server/src/services/budget-reservations.ts:70-131` `reserveRunBudget`, `budget_reservations` | 패턴만(강하게 권장) | `budget_reservations`(→ 03 7.2), 7.4 1단계 | "원장 + 미정산 예약 + 이번 예약 > 한도면 거부"를 회계 트랜잭션 안에서 판정 [1차]. 우리는 예약 단위를 run이 아니라 `ProviderCall`로 내리고 예약액을 상한으로 정의합니다(FR-BUD-03). 동시성은 작품 단위 advisory lock입니다(→ 03 7.4). |
| PM-37 | 하드 한도 일시정지: `services/budgets.ts:276-310` `pauseScopeForBudget`(1,136줄 파일) | 패턴만 | 7.4 7단계, `pause_reason`, `budget_resume` 승인 | 범위별 일시정지는 같습니다. 재개는 `Approval(type=budget_resume)`으로 기록합니다. |

### 3.6 승인·질문 (`hitl`)

| ID | Paperclip 영역 (근거) | 판단 | 우리 쪽 | 차이와 이유 |
|---|---|---|---|---|
| PM-38 | `approvals`: `schema/approvals.ts:8-16`, `APPROVAL_STATUSES`(`pending`, `revision_requested`, `approved`, `rejected`, `cancelled`) `shared/src/constants.ts:689-704` | 패턴만 | `Approval`(→ 03 3.4, 4.5), `approval_type`·`approval_status`(→ 00 6.4) | 유형을 서사 게이트로 교체했습니다. `revision_requested`는 두지 않고 반려 + `rework_from`(`EpisodeRejection`)으로 표현합니다. 같은 대상의 새 요청은 `superseded`로 닫습니다. |
| PM-39 | `issue_comments` | 따르지 않음 | `Question`/`Answer`/`AnswerReflection`(→ 03 3.4, 05) | 질문을 등급·마감·추천안·반영 기록을 가진 1급 객체로 둡니다(PRD 14.2). |
| PM-40 | `chat-question-forms.ts`(1,076줄, Modal/Select로 질문 세트) | 패턴만 | → 05 메신저 질문 렌더링 | 질문 세트를 SDK 폼 요소로 그리는 방식만 참고합니다. 버튼 데이터는 질문 ID + 선택지 인덱스만 담습니다(PRD 11절). |
| PM-41 | UI 인박스·감사 타임라인 화면 | 패턴만 | → 05 웹 인박스, 목업 `mockups-src/SPEC.md` | 화면은 목업 계약으로 새로 만듭니다. |

### 3.7 LLM 호출 (`llm`)

| ID | Paperclip 영역 (근거) | 판단 | 우리 쪽 | 차이와 이유 |
|---|---|---|---|---|
| PM-42 | adapter SPI: `packages/adapter-utils/src/types.ts`(812줄) `ServerAdapterModule`(506행) | 따르지 않음(아이디어만) | `LlmAdapter` 포트(ADR-010), → 04 | 외부 코딩 CLI 프로세스를 한 번 실행해 종료 코드·사용량을 받는 계약입니다 [1차]. 가져오는 아이디어: `testEnvironment`(→ 연결 점검 `llm_key`), `errorFamily`(→ `error_family`), `retryNotBefore`(→ `not_before_at`), `usageBasis`, `getConfigSchema`(설정 폼 자동 생성). |
| PM-43 | 직접 LLM 호출: `ai` 7.0.130 + `@ai-sdk/{anthropic,openai,google,xai,amazon-bedrock}`, `services/{decision-model-provider,fast-response-provider,prompt-injection-provider}.ts` | 그대로 차용(npm) | `llm` 모듈 어댑터 구현, → 04, 08 | Paperclip 코드가 아니라 Vercel AI SDK를 직접 의존합니다. 버전은 08에서 고정합니다. |
| PM-44 | `packages/adapters/*`(claude/codex/cursor/gemini 등), runner(Rust), sandbox provider, agent-shim | 따르지 않음 | — | 코딩 에이전트 실행 평면입니다. |

### 3.8 확장 지점

| ID | Paperclip 영역 (근거) | 판단 | 우리 쪽 | 차이와 이유 |
|---|---|---|---|---|
| PM-45 | plugin host + SDK: `services/plugin-*.ts` 33개 약 22,400줄, `plugin-worker-manager.ts`(3,955줄), SDK `protocol.ts`(2,721줄) | 따르지 않음(MVP), v1 이후 재검토 | 모듈·어댑터 교체(NFR-EXT-01) | capability 키 대부분이 `issues.*`, `agents.*` 같은 도메인 키이고 ACP 런타임을 import합니다 [1차]. MVP에 플러그인 요구가 없습니다. 이미지·영상 공급자 추가는 어댑터 + 공급자 프로필 데이터(NFR-EXT-03)로 합니다. |
| PM-46 | MCP facade: `packages/mcp-server`, `publicMcpIngress` | 따르지 않음(MVP) | — | 1.3절. 외부 도구가 작품 데이터를 읽어야 하는 요구가 생기면 REST 위 얇은 facade 패턴으로 다시 봅니다. |
| PM-47 | skills/teams 카탈로그(`packages/skills-catalog`, `teams-catalog`) | 따르지 않음 | 프롬프트 템플릿 버전(`runs.prompt_template_version`, → 03 8.2) | 장르 템플릿은 데이터로 관리합니다(NFR-EXT-03, → 07). |
| PM-48 | company package export/import(template/snapshot) | 패턴만 | `export_format=novel_package`(v1, FR-MAN-06b), → 07 | preview → import 두 단계와 ID 유지(→ 03 T-8)만 가져옵니다. |
| PM-49 | 회사 삭제 participant: `lib/company-deletion.ts`(9줄), `services/company-deletion.ts`(123줄) | 패턴만 | 작품 하드 삭제(→ 03 T-7), → 02 | 모듈마다 삭제 참여자를 두고 정해진 순서로 한 트랜잭션에서 호출하는 구조를 따릅니다. 파일 저장소 삭제는 커밋 후 단계로 분리합니다(NFR-SEC-05). |

### 3.9 모듈 구조·공유 계약

| ID | Paperclip 영역 (근거) | 판단 | 우리 쪽 | 차이와 이유 |
|---|---|---|---|---|
| PM-50 | `server/src/modules/` `adapters → application → domain`, `modules/README.md`(58줄) | 패턴만 | `apps/server/src/modules/<module>/{domain,application,adapters}`(ADR-008, → 00 4.2) | Paperclip은 실제 모듈 5개이고 나머지는 평면 `services/`입니다 [1차]. 우리는 처음부터 모든 기능을 모듈로 둡니다. |
| PM-51 | 경계 검사: `scripts/check-module-boundaries.mjs`(194줄) | 패턴만 | CI 경계 검사, → 08 | 계층 방향 검사와 DB 패키지 import 허용 목록은 같습니다. 스크립트는 `check-agent-lifecycle-boundaries.mjs`와 Paperclip 파일 목록(`configurationTransactionCallers`)을 담고 있어 [1차] 새로 씁니다. |
| PM-52 | const-array enum → 타입/zod/label (`packages/shared/src/constants.ts` 1,740줄) | 패턴만 | `packages/shared/src/enums.ts`(ADR-013) | 패턴은 같습니다. enum 이외의 DTO·라우트 맵·상수는 도메인별 파일로 나눕니다(6절 AP-07). |
| PM-53 | `API` 라우트 맵 + `validate` | 패턴만 | `packages/shared` DTO, → 08 | 라우트 맵 하나를 서버·UI가 공유하는 방식만 따릅니다. |

### 3.10 UI·CLI·배포·테스트

| ID | Paperclip 영역 (근거) | 판단 | 우리 쪽 | 차이와 이유 |
|---|---|---|---|---|
| PM-54 | UI 스택: React 19, Vite 8, Tailwind 4, React Query 5, react-router 7 [1차, `ui/package.json`] | 그대로 차용(npm) | `apps/web`, → 08 | 같은 라이브러리를 직접 의존하고 파일은 새로 씁니다. |
| PM-55 | UI 골격: `ui/src/api/client.ts`(209줄, GET coalescing·ApiError), `queryKeys` factory, `src/features/` 구조 | 패턴만 | `apps/web`, → 08 | 도메인을 모르는 골격이지만 경로·타입이 Paperclip API에 맞춰져 있어 새로 씁니다. |
| PM-56 | `ui/src/context/LiveUpdatesProvider.tsx`(2,267줄), `lib/cross-tab-poll.ts`(829줄) | 따르지 않음 | 기능별 실시간 구독 훅 + `seq` replay(ADR-017) | 한 파일이 모든 캐시 patch를 맡습니다. replay가 있으면 리더 탭 폴링이 필요 없습니다. |
| PM-57 | CLI: `commander` ^15 + `@clack/prompts` ^1.7, `onboard`/`doctor`/`run`/`service`, `cli/src/checks/*` | 그대로 차용(npm) + 패턴만(명령 구조) | `apps/cli`(→ 00 4.1), 점검 항목 `health_check_kind`(→ 00 6.12), → 08 | 점검 레지스트리 구조를 따르고 항목은 FR-SET-03 기준(LLM 키, 봇 토큰, 채널 도달성, DB, 온톨로지 무결성, 백업 위치, 저장소)으로 새로 정의합니다. |
| PM-58 | Docker: 멀티스테이지(Rust runner 4단계 포함), tini PID 1, gosu, `docker/docker-compose.yml`(postgres:17-alpine + 서버) | 패턴만 | `self_hosted` 배포, → 02·08 | Rust runner·provider pack·cloud 단계를 빼면 남는 것은 tini·gosu·compose 구성뿐입니다. |
| PM-59 | 테스트: Vitest(`scripts/run-vitest-stable.mjs`), embedded PG 위 migration 테스트 약 60개, Playwright | 패턴만 | `packages/test-kit`, → 08 품질 게이트 | migration 테스트를 실제 PG에서 돌리는 관례를 따릅니다. 복사한 파일(PM-01·02·07)은 Paperclip 테스트 파일(`backup-lib.test.ts`, `embedded-postgres-lifecycle.test.ts` 등)도 함께 가져옵니다. |
| PM-60 | `paperclip-eval-kernel`, promptfoo 케이스 | 따르지 않음(MVP) | 골든 테스트셋 G01~G22(→ 06), `packages/test-kit` | 평가 대상이 링킹·추출 정확도(NFR-QUAL-01)라 자체 하네스로 시작합니다. v1 품질 평가에서 다시 봅니다. |
| PM-61 | cloud 미들웨어, idle admission, `customer-success/v1`, muse transport, voice·email | 따르지 않음 | — | 매니지드 클라우드·Paperclip 제품 전용입니다(D-2 호스팅 SaaS 범위 밖). |
| PM-62 | `better-auth` 1.7.2(Paperclip `authenticated` 모드) | 판단 보류 | `self_hosted` 인증, → 02·08 | MVP-α는 `local_trusted`만 씁니다. `self_hosted` 인증 수단은 8절 미결입니다. |

---

## 4. chat 어댑터 재사용 판단 (D-15)

### 4.1 정체

`@chat-adapter/*`는 Paperclip 패키지가 아니라 Vercel의 오픈소스 Chat SDK(`chat` 코어 + 공급자 어댑터)입니다. MIT, 저장소 `vercel/chat`, Paperclip은 4.39.0에 고정하고 패치합니다. 2026-10-27 기준 `chat` latest는 4.43.0입니다 [1차] https://registry.npmjs.org/chat , https://chat-sdk.dev/docs . Paperclip chat 쪽 코드는 그 위의 내구성 계층과 공급자 6종 통합이며 비테스트 241개 파일·81,456줄입니다 [1차].

### 4.2 판단

| ID | 층 | 판단 | 우리 쪽 | 이유 |
|---|---|---|---|---|
| PM-63 | 공급자 접속: `chat`, `@chat-adapter/telegram`, `@chat-adapter/discord` | **그대로 차용(npm 직접 의존)** | `messaging` 모듈 adapters(ADR-011) | Telegram webhook/long polling, Discord Gateway/interactions, 버튼·모달·셀렉트, 메시지 정규화, 429 오류 분류를 갖췄습니다 [1차, `dist/index.js`]. |
| PM-64 | Paperclip 패치 `patches/@chat-adapter__*@4.39.0`, `@discordjs/ws@1.2.3` | **따르지 않음** | 업스트림 버전 그대로 | Telegram 패치(238줄)는 draft 스트리밍 등 Paperclip 기능용, Discord 패치(3,518줄)와 `@discordjs/ws` 패치(1,168줄)는 유지 부담이 큽니다 [1차]. Discord root thread 생성 승인 hook은 MVP-β에서 필요해지면 참고만 합니다. |
| PM-65 | Paperclip chat 서비스: `chat-sdk-runtime.ts`(3,308줄), `chat-channels/**`, `chat-*.ts` 75개 | **따르지 않음** | `messaging`·`hitl` 모듈, → 05 | issue·run·agent·wake queue에 결합돼 있습니다 [1차]. |
| PM-66 | 내구성 계층 설계: `chat_deliveries`, `chat_actions`, `chat_publications`, `chat_endpoint_leases`, `chat_sdk_state` (`schema/chat_channels.ts`) | **패턴만** | `messenger_inbox`, `messenger_outbox`(→ 03 3.5), `inbox_status`·`outbox_status`(→ 00 6.5), → 05 | 공급자 이벤트 ID 유일 수신함, 상태 기계, 발신함의 `delivery_unknown`(재발송 안 함), rate limit 재시도를 횟수에서 제외(`outbox.max_attempts`, → 00 7.4), Gateway 소유자 lease, PG 위 CAS 상태 저장소를 가져옵니다 [1차, `chat_channels.ts:431-583,647-779`, `publications/failures.ts:60-100`]. `chat_actions`(클릭 유일)는 별도 테이블 없이 `messenger_inbox`의 `event_kind=callback` + `dedupe_key`로 합칩니다. |

### 4.3 업스트림 빈틈과 자체 계층의 대응

상세 구현은 → 05 메신저 어댑터. 여기서는 판단 근거만 둡니다.

| 빈틈 [1차, 업스트림 4.39.0 `dist/index.js`] | 영향 | 대응 | 근거 요구 |
|---|---|---|---|
| Paperclip은 Telegram을 webhook으로만 씀(공개 HTTPS 필요) | 로컬 설치에서 수신 불가 | 업스트림 `mode: "polling"`(`local_trusted`), `mode: "webhook"` + `secret_token`(`self_hosted`). `telegram_receive_mode`(→ 00 6.5) | PRD 11절, NFR-SEC-01 |
| Telegram polling: `update_id` 중복 검사 없음, offset 메모리 보관, 처리 완료 전 offset 전진 | 재시작 시 중복·유실 | 수신 즉시 `messenger_inbox`에 `dedupe_key` 유일 insert 후 처리(`INV-IN-01`). 처리 완료 offset을 `messenger_bots.telegram_update_offset`에 저장(→ 03 3.5) | NFR-REL-02 |
| Discord `startGatewayListener`는 기간 제한(기본 180초) | 상시 수신 불가 | 감독 루프로 재시작(Paperclip `chat-sdk-runtime.ts:2320-2345` 패턴). MVP는 두 모드 모두 단일 프로세스라 lease 불필요(→ 02 2.3). 다중 프로세스 Gateway 소유 lease는 이후(02 10절 다중 인스턴스 미결) | NFR-REL-06 |
| Discord REST 429를 일반 `NetworkError`로 던짐 | 재시도 폭주·차단 | 발신함 worker가 상태 코드·`retry_after`를 읽어 `next_attempt_at` 결정 | NFR-REL-03 |
| 코어 `Chat`의 dedupe·lock이 `StateAdapter`에 의존, 메모리 구현은 재시작 시 상태 유실(가정) | 중복 처리 | PG 위 `StateAdapter` 구현. `@chat-adapter/state-pg`(MIT, `pg` 드라이버) 또는 `chat_sdk_state` 패턴의 CAS 자체 구현 중 선택(8절) | NFR-REL-02 |
| 버튼 데이터: Telegram 64바이트, Discord 100자. SDK 인코더가 초과 시 오류 | 버튼 생성 실패 | 질문 ID + 선택지 인덱스만 담음(`QuestionOption`) | PRD 11절 |

### 4.4 버전

Paperclip 고정 4.39.0이 아니라 착수 시점 최신(현재 4.43.0)을 정확한 버전으로 고정합니다. 4.40~4.43 변경 내역(polling dedupe·Gateway 상시 실행 추가 여부)은 [미확인]이고, 추가됐다면 4.3절 대응 일부를 줄일 수 있습니다(→ 09 스파이크).

---

## 5. 라이선스와 고지 방식

### 5.1 의무

MIT 라이선스는 "위 저작권 표시와 이 허가 표시를 소프트웨어의 모든 복제본 또는 중요한 부분에 포함"하도록 요구합니다 [1차, Paperclip `LICENSE`]. 3절에서 **그대로 차용(복사)** 으로 표시한 행(PM-01~05, 07, 12, 14, 16, 17 전자, 20 전자, 21 local disk)과 그 테스트 파일이 대상입니다.

### 5.2 고지 방식

| 단계 | 방식 | 위치 |
|---|---|---|
| 1. 원문 보관 | Paperclip `LICENSE` 원문을 그대로 둡니다. | `third_party/paperclip/LICENSE` |
| 2. 파일 머리 주석 | 복사·변형한 파일 첫머리에 아래 형식을 둡니다. 함수만 떼어 온 경우 해당 함수 위에 같은 주석을 둡니다. | 각 파일 |
| 3. 차용 원장 | 복사한 파일마다 1행: 원 경로, 원 커밋, 우리 경로, 변경 요약, PM ID. | `third_party/paperclip/BORROWED.md` |
| 4. 배포물 고지 | 배포물(npm 패키지·Docker 이미지·앱 번들)에 서드파티 고지 파일을 넣습니다. Paperclip 항목(저작권 + MIT 전문)과 npm 의존 라이선스(5.4절)를 함께 담습니다. | `THIRD_PARTY_NOTICES.md` (배포물 루트) |
| 5. 검사 | 원장에 있는 파일이 머리 주석을 갖는지, 머리 주석이 있는 파일이 원장에 있는지 CI가 확인합니다. | → 08 품질 게이트 |

파일 머리 주석 형식:

```ts
// SPDX-License-Identifier: MIT
// Portions derived from Paperclip (https://github.com/paperclipai/paperclip),
// file packages/db/src/backup-lib.ts at commit 0cb3fc7.
// Copyright (c) 2025 Paperclip AI. See third_party/paperclip/LICENSE.
// Modified for novel-create-studio: <변경 요약 한 줄>.
```

- 경로·디렉터리 이름(`third_party/paperclip/`, `THIRD_PARTY_NOTICES.md`)은 제안이며 저장소 구조를 소유하는 08에서 확정합니다.
- 우리 저장소 자체 라이선스는 D-1·D-2 범위 밖이라 이 문서에서 정하지 않습니다. 어떤 라이선스든 MIT 고지 보존 의무는 같습니다.

### 5.3 패턴만 따른 영역

가정: 코드 표현을 복사하지 않고 설계(테이블 모양, 상태 이름, 알고리즘)만 따른 영역은 MIT 고지 대상이 아닙니다. 그래도 출처 추적을 위해 해당 설계 절에 "Paperclip 패턴(PM-nn)"을 적습니다. 출시 전 법률 검토에서 이 가정을 확인합니다(8절).

### 5.4 함께 고지할 외부 패키지

| 패키지 | 라이선스 | 근거 | 비고 |
|---|---|---|---|
| `chat`, `@chat-adapter/telegram`, `@chat-adapter/discord` | MIT | [1차] https://registry.npmjs.org/chat/4.39.0 | 4.43.0 라이선스 재확인은 버전 고정 시 |
| `embedded-postgres` | MIT | [1차] https://www.npmjs.com/package/embedded-postgres | PostgreSQL 바이너리를 함께 배포하므로 PostgreSQL License도 고지 |
| PostgreSQL | PostgreSQL License | [1차, Graph DB 조사 파일] | |
| `drizzle-orm` | Apache-2.0 | [1차] https://registry.npmjs.org/drizzle-orm/latest | 패키지에 NOTICE 파일이 있으면 함께 포함해야 함. 있는지 [미확인] |
| `ai`, `@ai-sdk/*` | [미확인] | — | 버전 고정 시 확인(→ 08) |
| Paperclip `ui/public/fonts` Inter(OFL 1.1) | — | [1차] | 가져오지 않으므로 해당 없음 |

배포물 고지 파일은 의존성 라이선스를 빌드 시 자동 수집해 만듭니다(→ 08).

---

## 6. 따라 하지 말 것과 대신 쓰는 구조

| ID | Paperclip 패턴 (근거 [1차]) | 문제 | 대신 쓰는 구조 | 강제 수단 |
|---|---|---|---|---|
| AP-01 | 거대 파일: `services/issues.ts` 13,875줄, `heartbeat/queue.ts` 4,942줄, `heartbeat.ts` 4,171줄, `chat-sdk-runtime.ts` 3,308줄, `index.ts` 2,287줄, `LiveUpdatesProvider.tsx` 2,267줄, `IssueDetail` 약 8.7k줄 | 한 파일이 여러 집합체·관심사를 소유해 경계가 흐려지고, 잠금 지점 같은 핵심 경로를 찾기 어렵습니다(지도 10절 4번이 checkout 위치를 특정하지 못한 사례). | 파일 하나는 유스케이스 하나 또는 집합체 하나. 상태 전이는 `domain`의 순수 함수(→ 03 4절) | 파일 줄 수 상한 lint(값은 08, 8절 미결) |
| AP-02 | 평면 `services/`: 최상위 비테스트 681개, route → service → drizzle 직접 호출, repository 없음 | 다른 기능의 테이블을 직접 조회해 결합이 생깁니다. | `modules/<m>/{domain,application,adapters}`(ADR-008). DB 접근은 `adapters`의 repository만, 다른 모듈은 `application` 공개 API로 호출 | 경계 검사 스크립트(PM-51) |
| AP-03 | 반쯤 떼어 낸 모듈: `modules/wake-queue`가 트랜잭션과 helper를 `heartbeat.ts`에서 주입받음(`index.ts:60-110`) | 모듈이 자기 불변식을 혼자 지키지 못합니다. | 여러 집합체를 바꾸는 유스케이스는 호출한 `application` 서비스가 트랜잭션을 열고, 하위 모듈 API는 트랜잭션 핸들을 인자로 받습니다(→ 03 2.1). 모듈은 다른 모듈의 helper를 주입받지 않습니다. | 코드 리뷰, 경계 검사 |
| AP-04 | 손 배선 부트스트랩: `index.ts`·`app.ts`에서 라우트 약 80개와 서비스 그래프를 직접 연결 | 기능 추가 때마다 대형 파일을 고칩니다. | 모듈마다 `register(app, deps)`를 내보내고 서버는 모듈 목록을 순서대로 등록(→ 02) | — |
| AP-05 | 한 함수가 여러 정책 검사: `claimQueuedRun`(queue.ts:945)이 case handoff·Slack mention·agent 상태·예산을 한꺼번에 판정 | 검사 하나를 바꾸면 전체를 다시 읽어야 합니다. | claim 가드를 이름 있는 검사 목록으로 두고 거부 사유를 `task_block_reason`·`run_stop_reason`으로 남김(→ 04) | 단위 테스트 |
| AP-06 | 단일 FK 테넌트 테이블: `issues` 등 오래된 테이블은 `company_id` 단일 FK, RLS 없음(지도 4절) | 다른 테넌트 행 참조를 DB가 막지 못할 수 있습니다 [추론]. | 처음부터 모든 작품 소속 FK를 복합 FK로(→ 03 T-2), repository 첫 인자 `NovelScope`(T-3) | 마이그레이션 lint, T-3 lint |
| AP-07 | 거대 공유 상수: `packages/shared/src/constants.ts` 1,740줄(enum·capability·커넥터 카탈로그 혼재), shared barrel | 공유 패키지가 모든 도메인 변경에 같이 바뀝니다. | enum은 `enums.ts` 한 곳(ADR-013), DTO·라우트 맵은 도메인별 파일 | — |
| AP-08 | 프로세스 메모리 상태: 실시간 이벤트 ID 카운터, Telegram polling offset, 메모리 StateAdapter | 재시작 시 replay 불가, 중복·유실 | DB 순번(ADR-017), `telegram_update_offset`, PG StateAdapter | 재시작 통합 테스트(MVP-α 완료 기준 4) |
| AP-09 | 업스트림 대형 패치: Discord 3,518줄, `@discordjs/ws` 1,168줄 | 업스트림 버전 갱신이 막힙니다. | 패치하지 않고 SDK 바깥 계층(수신함·발신함·감독 루프)에서 메웁니다. 불가피한 패치는 업스트림 이슈 링크와 함께 차용 원장에 기록 | 리뷰 |
| AP-10 | 필요 전 범용화: plugin host 약 22k줄, 공급자 6종 chat, 비밀 provider 4종(2종 스텁) | 유지 비용이 요구보다 큽니다. | 릴리스 범위의 공급자만 구현(MVP-α Telegram, MVP-β Discord, `local_encrypted`, `local_disk`). 포트는 두되 구현은 필요할 때 추가 | 로드맵(→ 09) |
| AP-11 | 쌍둥이 화면: UI production/streamlined로 나뉜 같은 페이지(지도 8절) | 같은 기능의 이중 유지 | 화면 하나, 목업 계약(`mockups-src/SPEC.md`) 기준 | — |
| AP-12 | 핸들러별 수동 테넌트 assert(`assertCompanyAccess`를 각 핸들러가 호출) | 누락 위험 | 라우터 수준 미들웨어 + repository 시그니처(PM-18) | T-3 lint |

---

## 7. 차용 작업 절차

복사 차용(5.1절 대상)을 구현할 때 따르는 순서입니다.

| 순서 | 할 일 |
|---|---|
| 1 | 기준 커밋 `0cb3fc7`에서 대상 파일과 그 테스트 파일을 복사합니다. 다른 커밋에서 가져오면 원장에 그 커밋을 적습니다. |
| 2 | `@paperclipai/*` import를 우리 패키지(`packages/shared`, `packages/db`)나 Node 내장으로 바꿉니다. 바꿀 수 없는 의존이 남으면 그 행을 패턴만으로 낮추고 이 문서를 고칩니다. |
| 3 | 제품 이름이 들어간 식별자·환경 변수·경로(`PAPERCLIP_*`, `~/.paperclip`, "board")를 우리 이름으로 바꿉니다(→ 08 명명). |
| 4 | 머리 주석과 차용 원장 행을 추가합니다(5.2절). |
| 5 | 가져온 테스트를 우리 테스트 러너에서 통과시킵니다. 런타임 동작은 조사에서 검증하지 않았으므로 이 단계가 첫 검증입니다. |
| 6 | 업스트림 추적: 자동 동기화하지 않습니다. 가정: 릴리스 준비 때 원장의 파일에 대해 업스트림 보안 수정 여부를 확인합니다. |

---

## 8. 미결 사항

| 항목 | 내용 | 정하는 시점 / 문서 |
|---|---|---|
| embedded-postgres 패치 필요 여부 | Paperclip은 18.1.0-beta.16에 `LC_MESSAGES=C` 패치(30줄). 우리 기준 18.4.0-beta.17에서도 필요한지 [미확인] | 스파이크 S-1(→ 09), MVP-α DB 착수 전 |
| JS 백업 엔진의 범위 타입·`EXCLUDE`·확장 왕복 | `backup-lib.ts` JS 엔진·구문 재생 복원이 `int4range`, `btree_gist` `EXCLUDE`, `pg_trgm` 인덱스를 보존하는지 [미확인] | 스파이크 S-7(→ 09), FR-MAN-06a 구현 전 |
| Chat SDK `StateAdapter` 선택 | `@chat-adapter/state-pg`(`pg` 드라이버 추가) vs postgres.js 위 CAS 자체 구현. 후자면 상태 테이블 이름을 03에 추가해야 함 | → 05, MVP-α 메신저 착수 전 |
| Chat SDK 4.40~4.43 변경 내역 | polling dedupe·Gateway 상시 실행 추가 여부 [미확인] | → 09 스파이크, MVP-α 메신저 착수 전 |
| `self_hosted` 인증 수단 | `better-auth`(Paperclip 사용) 채택 여부 | → 02·08, `self_hosted` 착수 전 |
| 파일 줄 수 상한 값 | AP-01 lint 기준. 가정: 경고 400줄, 실패 800줄 | → 08 품질 게이트 |
| 홈 디렉터리·환경 변수·설정 파일 이름 | PM-10·11·20의 이름 교체 대상 | → 08 |
| 고지 파일 경로 | `third_party/paperclip/`, `THIRD_PARTY_NOTICES.md` 제안 | → 08 저장소 구조 |
| 마이그레이션 안전 규칙 범위 | PM-06에서 가져올 규칙 목록 | → 08, 첫 마이그레이션 작성 시 |
| 패턴 차용의 고지 불필요 가정 | 5.3절 | 출시 전 법률 검토 |
| `drizzle-orm` NOTICE 파일, `ai`·`@ai-sdk/*` 라이선스 | [미확인] | → 08 버전 고정 시 |
| Paperclip `chat_deliveries` 처리 worker의 재시도·순서 보장 | `chat-delivery-work.ts`, `durable-chat-wakeup.ts`는 읽지 않음 | 05 설계에서 순서 보장 요구가 생기면 확인 |
| plugin host·MCP facade 재검토 | 외부 확장·외부 도구 접근 요구가 생기면 | v1 이후(→ 09) |
| 복사 대상의 실제 동작 | 조사는 빌드·실행을 하지 않음 | 7절 5단계(가져온 테스트 통과) |
| PRD 반영 | D-15 "라이선스 미확인", 14.2 "chat 미분석"·"plugin host 차용 후보"·"approvals 차용 후보"를 이 문서 판단으로 갱신 | → 01 6절 P-05 |
