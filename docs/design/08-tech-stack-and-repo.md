# 08. 기술 스택과 저장소 구성

| 항목 | 내용 |
|---|---|
| 문서 | novel-create-studio 상세 설계 08 |
| 버전 | v0.1 (2026-10-27). v0.1.1(2026-10-28): 5.2 끝에 공급자 단가와 컨셉 세션 비용 기본값 검증 주석(11 9.4) |
| 기준 | PRD v0.3, `00-foundation.md` v0.1, `03-domain-model.md` v0.1 |
| 작성 | AI 초안. 사람 검토 필요 |

**목적.** ADR-003(Node 24 + TypeScript, pnpm 모노레포), ADR-004(PostgreSQL), ADR-005(같은 PG 안의 온톨로지 테이블)를 구현 가능한 수준으로 구체화합니다. 라이브러리와 버전, 저장소 구조, 의존 규칙과 강제 방법, 마이그레이션, 설정·비밀, CLI, 테스트, CI 품질 게이트, 패키징·배포를 정합니다.

**범위.**
- 다루는 것: 기술 선택과 이유·대안, 디렉터리 트리, 패키지·모듈 의존 규칙(lint), 관계형 DDL과 온톨로지 스키마의 버전 관리, 설정 파일·환경 변수·비밀 저장, CLI 명령, 테스트 계층(단위·통합·골든셋 평가·LLM 녹화 재생), CI 게이트, 로컬 상시 실행 패키징, `self_hosted` Docker, MVP-α 웹 UI 화면 구성과 데이터 출처·접근성 기준(9절).
- 다루지 않는 것: 프로세스·계층·이벤트 흐름·장애 복구 절차(→ 02), 테이블 필드·불변식(→ 03), 링커·그래프 질의·OntologySchema 문법(→ 06), LLM 어댑터 SPI와 실행 수명주기(→ 04), 메신저 내구성 계층과 인박스 질문 표현(→ 05), Paperclip 대응표(→ 10), 스파이크 일정(→ 09), 시각 디자인(→ 목업 `mockups-src`).

**관련 요구.** D-2, D-8, D-9, D-15, D-22, D-27 / FR-SET-01~03, FR-MAN-06a·06b, FR-AGT-02, FR-ONT-12~19, FR-UI-01·02·04·05a·06·07·09 / NFR-REL-01·04·05·06, NFR-SEC-01~05, NFR-EXT-01·03·04a, NFR-QUAL-01, NFR-OBS-01·02, NFR-PERF-04, NFR-ACC-01 / R-4, R-8, R-9, R-18.

**선행 문서.** `00-foundation.md`(ADR, 모듈 이름, enum·기본값 레지스트리), `03-domain-model.md`(테넌트 규칙 T-1~T-8, 감사 이벤트). 02는 동시 작성 중이며 프로세스 구성은 02를 따릅니다.

**표기.** 00과 같습니다. 외부 사실의 근거는 2026-10-27 조사 파일 3개(Paperclip 소스 재확인 커밋 `0cb3fc7`, Graph DB 후보, 엔티티 식별 기법)입니다. 버전 범위 옆 [1차]는 Paperclip `package.json` 또는 npm 레지스트리에서 확인한 값이고, [미확인]은 착수 시 고정할 값입니다.

---

## 1. 기술 선택 요약

### 1.1 런타임·빌드

| 영역 | 선택 | 버전 범위 | 이유 | 대안(채택 안 함) |
|---|---|---|---|---|
| 언어 | TypeScript | 5.x, 착수 시 고정 [미확인] | 서버·UI·CLI가 enum·zod 스키마·DTO를 공유합니다(ADR-003, ADR-013). | Python, Go (ADR-003) |
| 런타임 | Node.js | `>=24.11 <25` [1차, Paperclip `engines`] | Chat SDK·AI SDK·Paperclip 차용 코드와 같은 런타임입니다. | Bun, Deno: `embedded-postgres` 자식 프로세스 관리와 Chat SDK 동작을 검증하지 않았습니다. |
| 패키지 매니저 | pnpm workspace | `9.15.x` [1차, Paperclip `pnpm@9.15.4`] | Paperclip과 같은 구성. Turbo·Nx 없이 `pnpm -r`로 충분합니다(패키지 6개). | pnpm 10: 의존성 설치 스크립트 기본 차단 정책이 `embedded-postgres` 바이너리 설치에 주는 영향을 확인하지 않았습니다 [미확인]. 착수 시 재평가합니다. |
| 서버 번들 | `tsc` 빌드(`dist/`), 번들러 없음 | — | 서버는 Node에서 바로 실행합니다. 네이티브 바이너리(`embedded-postgres`)를 번들에 넣지 않습니다. | esbuild 단일 파일: v1 단일 실행 파일 검토 때 다시 봅니다(8.4절). |
| UI 번들 | Vite | `^8.2.2` [1차] | Paperclip UI와 같습니다. | — |

### 1.2 서버

| 영역 | 선택 | 버전 범위 | 이유 | 대안 |
|---|---|---|---|---|
| HTTP | Express | `^5.1.0` [1차] | Paperclip `HttpError`·`errorHandler`·`validate`를 그대로 차용합니다(→ 10). | Fastify: 차용 코드를 다시 써야 합니다. |
| 실시간 | MVP-α: 없음(React Query 주기·포커스 재조회, → 02 5.3.1). v1: `ws` | `^8.22` [1차] | v1(FR-UI-08)에 WebSocket 하나를 붙입니다. 이벤트 ID는 `activity_log.seq`(ADR-017, → 02 5.3.2). MVP-α는 `seq` 기록만 합니다. | SSE: 메신저·UI 동시 갱신에 양방향이 필요하지 않지만 Paperclip 패턴과 맞추려고 WS를 씁니다. |
| 검증 | zod | `^4.4.3` [1차] | enum·DTO·`jsonb` 구조·설정 스키마를 한 도구로 검증합니다. | — |
| 로깅 | pino | Paperclip 사용 [1차], 버전 [미확인] | 구조화 로그, `redact` 경로로 비밀을 가립니다(NFR-SEC-02, 5.4절). | — |
| 인증(`self_hosted`) | better-auth | `1.7.x` [1차, Paperclip 1.7.2, MIT] | `self_hosted`에서만 켭니다(ADR-002, NFR-SEC-03). `local_trusted`는 인증 없이 루프백만 받습니다. | 자체 세션 구현 |
| ID | 자체 ULID 생성기(`packages/shared/src/ids.ts`) | — | 50줄 안팎이고 접두사 검사(00 5.1절)와 함께 둡니다. 외부 의존을 하나 줄입니다. | `ulid` npm 패키지 |

### 1.3 저장소

| 영역 | 선택 | 버전 범위 | 이유 | 대안 |
|---|---|---|---|---|
| 관계형 + 온톨로지 | PostgreSQL 한 데이터베이스(ADR-004, ADR-005) | 메이저 18 기준. 외부 PG는 17 이상 허용(가정) | 범위 타입·`btree_gist` `EXCLUDE`로 칭호 보유 기간 겹침 같은 제약을 DB가 강제합니다. 답변 반영·사실 쓰기·병합 참조 이동을 한 트랜잭션으로 처리합니다. | LadybugDB(파생 읽기 모델 후보), SQLite. 상세 → 06 엔진 선택 절 |
| 로컬 PG | `embedded-postgres` | `18.4.0-beta.17` 정확 고정 [1차, 2026-06-05, MIT] | 별도 설치 없이 자식 프로세스로 PG를 띄웁니다. Paperclip 수명주기 코드(약 600줄)를 차용합니다. | PGlite 운영 사용: 단일 연결, `dumpDataDir()` 복원 호환 미보장 [1차] |
| 드라이버 | postgres.js (`postgres`) | `^3.4.9` [1차] | Paperclip과 같습니다. | `pg`: Chat SDK `state-pg`가 `pg`를 쓰지만 드라이버를 둘 두지 않으려고 쓰지 않습니다(5.3절 참고). |
| ORM | drizzle-orm | `^0.45.2` [1차, Apache-2.0] | 타입 있는 질의. 범위 타입·`EXCLUDE`는 SQL 마이그레이션으로 직접 씁니다(4절). | Kysely, Prisma |
| 마이그레이션 생성 | drizzle-kit | 착수 시 고정 [미확인] | `generate`로 SQL 초안을 만들고 손으로 보완합니다. 적용은 자체 runner(4.2절). | drizzle-kit `migrate`: 업그레이드 전 백업·실패 복귀(NFR-REL-05)를 넣을 수 없습니다. |
| 테스트 DB | PGlite (`@electric-sql/pglite`) | `0.5.x` [1차, 0.5.12 2026-10-26, Apache-2.0] | 단위·저장소 테스트를 프로세스 안에서 빠르게 돌립니다. contrib에 `btree_gist`·`pg_trgm` 포함 [1차]. | — |
| 파일 저장소 | `StorageProvider` `local_disk`(ADR-015) | — | 미디어·내보내기·백업·실행 로그 원문. S3 호환은 이후. | — |
| 확장 | `btree_gist`(필수), `pg_trgm`(선택, S-5 결과에 따름), `pgvector`(선택) | — | 필수는 범위 배타 제약용 `btree_gist`뿐입니다. 이름 후보 생성은 이름 사전 정규화 키가 기본이고, `pg_trgm`이 있고 한글 trigram이 동작하면(S-5 [미확인]) 부분 일치 인덱스로 씁니다. 없으면 정규화 키 + 접두 인덱스 + 앱 `jamo_key` 편집거리로 대체합니다(→ 02 4.3, 06 11.3). 선택 확장이 없으면 `doctor`는 `warn`입니다. 동봉 여부는 스파이크 S-1 [미확인]. | — |

### 1.4 외부 연동

| 영역 | 선택 | 버전 범위 | 이유 | 대안 |
|---|---|---|---|---|
| LLM | Vercel AI SDK `ai` + `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google` | `ai` 7.x [1차, Paperclip 7.0.130], 공급자 패키지는 `ai`와 같은 릴리스 줄 | 자체 `LlmAdapter` 포트 뒤 구현으로만 씁니다(ADR-010, → 04). 구조화 출력·사용량·오류를 공급자 공통 형태로 받습니다. | 공급자 SDK 직접 사용, Paperclip adapter SPI(코딩 CLI 실행 계약이라 맞지 않음) |
| 메신저 | Vercel Chat SDK `chat`, `@chat-adapter/telegram`, `@chat-adapter/discord` | 후보 4.43.0(세 패키지 같은 버전 정확 고정), S-14 후 확정(4.39.0 또는 4.43.0, 09 U-08) [1차, latest 4.43.0, MIT] | Telegram polling/webhook, Discord Gateway/interactions, 버튼·모달·429 분류를 갖췄습니다. 내구성은 자체 inbox/outbox(ADR-011, → 05). | Paperclip chat 서비스 81k줄(도메인 결합), API 직접 구현 |
| Chat SDK 상태 | 필요 여부·방식은 메신저 스파이크(05 미결 9, 09 S-14) 후 확정. 필요하면 자체 `StateAdapter`(PG 위 CAS, postgres.js, `chat_sdk_state`)가 1순위 후보 | — | `Chat` 코어 없이 어댑터를 직접 부르면 StateAdapter가 필요 없을 수 있습니다(→ 05 9.1). 필요하면 메모리 상태는 재시작 시 dedupe 상태를 잃으므로(가정) Paperclip `chat_sdk_state` 패턴을 따릅니다. | `@chat-adapter/state-pg`(MIT, `pg` 드라이버) |
| 이미지·영상 [v1/v2] | 공급자별 HTTP 어댑터 | — | IR 중립(ADR-012). 공급자 선정 → 07, D-19 | — |

Paperclip의 `@chat-adapter/*` 패치는 가져오지 않습니다. 4.39.0 → 4.43.0 변경 내역은 [미확인]이고, upstream polling의 `update_id` 중복·offset 메모리 보관 문제는 자체 inbox가 메웁니다(→ 05).

### 1.5 UI

| 영역 | 선택 | 버전 범위 | 이유 |
|---|---|---|---|
| 프레임워크 | React | `^19.2.8` [1차] | Paperclip UI와 같은 조합. 파일은 새로 작성(패턴만, → 10) |
| 스타일 | Tailwind CSS | `^4.3.3` [1차] | 목업(`mockups-src`)의 토큰을 테마 변수로 옮깁니다. |
| 서버 상태 | TanStack Query (`@tanstack/react-query`) | `^5.102.8` [1차] | MVP-α는 주기·포커스 재조회, v1은 WS 이벤트로 질의 무효화 |
| 라우팅 | react-router | `^7.18.4` [1차] | — |
| 원고 에디터·diff | 후보: CodeMirror 6, ProseMirror / `diff`(jsdiff) | [미확인] | MVP-α 착수 전에 시제품으로 고릅니다. 선택 기준은 9.4절 원고 화면 요구입니다: (1) 문자 오프셋 구간 장식(작성 주체 `attribution_spans`, 이슈·떡밥 비트 위치, 씬 경계)을 본문 편집 없이 겹쳐 표시, (2) 줄 단위 작성 주체 표시(FR-MAN-01), (3) 두 버전 나란히·통합 diff, (4) 5,500자 원고에서 장식 수백 개일 때 입력 지연 없음(가정), (5) 키보드만으로 주석 사이 이동(NFR-ACC-01). |
| 접근성 검사 | `@axe-core/playwright` | [미확인] | E2E에서 화면별 자동 검사(9.9절, QG-19) |

화면 구성·데이터 출처는 9절입니다.

### 1.6 CLI·개발 도구

| 영역 | 선택 | 버전 범위 | 이유 |
|---|---|---|---|
| CLI 파서 | commander | `^15` [1차] | Paperclip CLI 골격 패턴 |
| 대화형 입력 | `@clack/prompts` | `^1.7` [1차] | `onboard` 마법사 |
| 테스트 | Vitest, Playwright | Paperclip 사용 [1차], 버전 [미확인] | 단위·통합·E2E |
| 속성 테스트 | fast-check | [미확인] | `story_range` 연산, 상태 기계 전이 표 |
| lint | ESLint 9(flat config) + typescript-eslint, 자체 규칙 플러그인 `eslint-plugin-ncs` | [미확인] | 3.3절 |
| 의존 경계 | dependency-cruiser | [미확인] | 3.2절. Paperclip `check-module-boundaries.mjs`는 경로가 Paperclip 전용이라 규칙만 가져옵니다. |
| 포맷 | Prettier | [미확인] | — |
| 라이선스 검사 | `pnpm licenses list --json` + 자체 스크립트 | — | 7절 QG-12 |

### 1.7 의존성 버전 정책

| 대상 | 규칙 |
|---|---|
| 동작이 버전에 민감한 패키지(`embedded-postgres`, `chat`·`@chat-adapter/*`, `ai`·`@ai-sdk/*`, `drizzle-orm`·`drizzle-kit`) | 정확한 버전으로 고정(`"x.y.z"`). 올릴 때는 해당 계약 테스트(6.3절)와 재생 평가(6.5절)를 통과해야 합니다. |
| 그 밖 | `^` 범위 + `pnpm-lock.yaml` 커밋. 주 1회 업데이트 PR(도구는 착수 시 선택). |
| 라이선스 허용 | MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, MPL-2.0(파일 단위), PostgreSQL License, SIL OFL(폰트). GPL·AGPL·SSPL·BSL·Commons Clause는 런타임 의존 금지(D-2 (b)·(c) 확장 경로를 막지 않기 위함). npm 메타데이터에 잡히지 않는 네이티브 바이너리(PostgreSQL과 동봉 라이브러리, `pg_dump`·`pg_restore`)도 같은 목록으로 판정합니다(QG-12). |
| `embedded-postgres` 업스트림 중단 | beta 태그 패키지이고 유지보수 지속성은 [미확인]입니다. 업스트림이 멈추면 (a) 같은 zonky 플랫폼 바이너리를 직접 내려받아 쓰거나 (b) 패키지를 포크합니다. 수명주기 코드(시작·정지·고아 회수)는 이미 `@ncs/db/runtime`에 자체 보유하므로(2.2절) 바꿀 부분은 바이너리 설치 경로뿐입니다(→ 09 DR-01). |

---

## 2. 저장소 구조

### 2.1 패키지 이름

npm 스코프는 `@ncs`(가정)입니다. 배포용 패키지 이름은 `novel-create-studio`(8.1절)입니다.

| 경로 | 패키지 | 책임(→ 00 4.1) | 배포 |
|---|---|---|---|
| `apps/server` | `@ncs/server` | HTTP·WS·스케줄러·worker·메신저 수신. `startServer(config)`를 내보냅니다. | 배포 패키지에 포함 |
| `apps/web` | `@ncs/web` | React UI. 빌드 결과(`dist/`)를 서버가 정적 파일로 제공 | 빌드 산출물만 포함 |
| `apps/cli` | `@ncs/cli` | `ncs` 명령(5.5절) | 배포 패키지 진입점 |
| `packages/shared` | `@ncs/shared` | enum·라벨·ID·zod DTO·설정 스키마·기본 온톨로지 스키마 데이터 | 포함 |
| `packages/db` | `@ncs/db` | drizzle 스키마, SQL 마이그레이션, runner, embedded/external PG 런타임, 백업 라이브러리 | 포함 |
| `packages/test-kit` | `@ncs/test-kit` | 가짜 어댑터, LLM 카세트, 골든셋, 픽스처, 평가 러너 | 포함하지 않음(개발 전용) |

### 2.2 디렉터리 트리

```text
novel-create-studio/
├── package.json                  # private 루트. engines, packageManager, 공통 scripts
├── pnpm-workspace.yaml
├── .nvmrc                        # 24
├── tsconfig.base.json
├── eslint.config.js
├── .dependency-cruiser.cjs       # 3.2절 규칙
├── vitest.workspace.ts
├── LICENSE
├── THIRD_PARTY_NOTICES.md        # 생성물(scripts/gen-notices.ts). 커밋함
├── borrowed-files.json           # Paperclip에서 복사한 파일 목록(원 경로, 커밋 0cb3fc7, 라이선스)
├── apps/
│   ├── server/
│   │   └── src/
│   │       ├── main.ts           # 조립 지점(composition root): 설정 → DB → 모듈 → 런타임
│   │       ├── platform/         # 모듈이 쓰는 기반: config, logger, db 연결, secrets, storage, clock, ids
│   │       ├── http/             # Express 앱, 라우트 등록, 오류 처리, 인증·호스트 가드
│   │       ├── realtime/         # [v1] WS 서버, seq 기반 replay(→ 02 5.3.2)
│   │       ├── runtime/          # 스케줄러 루프, worker 풀, 메신저 수신 감독, 종료 처리(→ 02, 04)
│   │       └── modules/
│   │           └── <module>/     # novel, manuscript, ontology, linking, continuity, foreshadow,
│   │               │             # orchestration, agents, llm, hitl, messaging, budget, audit,
│   │               │             # media, export, system (→ 00 4.2)
│   │               ├── domain/       # 타입, 불변식, 상태 전이 함수. I/O 없음
│   │               ├── application/  # 유스케이스, ports.ts(포트 인터페이스), 도메인 이벤트
│   │               ├── adapters/
│   │               │   ├── db/       # 이 모듈 테이블의 repository 구현
│   │               │   ├── http/     # 라우트 핸들러
│   │               │   └── <ext>/    # llm, telegram, discord, web, storage 등 외부 구현
│   │               ├── index.ts      # 공개 API(다른 모듈이 import할 수 있는 유일한 파일)
│   │               └── *.test.ts     # 같은 위치 단위 테스트
│   ├── web/
│   │   └── src/
│   │       ├── app/              # 라우터, 레이아웃, 테마
│   │       ├── features/         # home, board, inbox, manuscript, ontology, setups, audit, settings, media
│   │       ├── components/       # 공통 UI
│   │       ├── api/              # fetch 클라이언트(DTO는 @ncs/shared)
│   │       └── realtime/         # MVP-α 주기·포커스 재조회, [v1] WS 구독·질의 무효화
│   └── cli/
│       └── src/
│           ├── commands/         # onboard, doctor, run, service, backup, restore, migrate, config, secrets, eval
│           ├── checks/           # doctor 점검 레지스트리(5.6절)
│           └── service/          # launchd, systemd-user, windows-task 설치기(8.2절)
├── packages/
│   ├── shared/src/
│   │   ├── enums.ts              # 00 6절의 유일한 코드 표현(ADR-013)
│   │   ├── labels.ko.ts          # 한국어 표시 라벨
│   │   ├── ids.ts                # 접두사 + ULID 생성·검사
│   │   ├── config-schema.ts      # InstallConfig zod 스키마(5.1절)
│   │   ├── defaults.ts           # 00 7절 기본값의 코드 표현
│   │   ├── dto/                  # API 요청·응답 스키마
│   │   └── ontology/base-schema/ # 기본 OntologySchema 데이터(v1.json …, 4.4절)
│   ├── db/src/
│   │   ├── schema/<module>.ts    # 모듈별 drizzle 테이블 정의(소유 모듈 = 파일 이름)
│   │   ├── migrations/           # NNNN_<slug>.sql (+ 선택 NNNN_<slug>.data.ts)
│   │   ├── migrate/              # runner, safety 검사, 번호 검사(Paperclip 차용)
│   │   ├── runtime/              # embedded/external 해석, 수명주기, 감독(Paperclip 차용)
│   │   └── backup/               # pg_dump/복원 래퍼(Paperclip backup-lib 차용)
│   └── test-kit/src/
│       ├── fakes/                # FakeLlmAdapter, FakeMessengerTransport, FakeClock, FakeStorage
│       ├── cassettes/            # LLM 녹화 파일(6.4절)
│       ├── golden/               # 골든 테스트셋(6.5절)
│       ├── fixtures/             # 작품·화·엔티티 빌더
│       └── eval/                 # 평가 러너·지표 계산
├── docker/
│   ├── Dockerfile
│   ├── compose.yaml
│   └── compose.proxy.yaml        # HTTPS 역방향 프록시 예시(Telegram webhook용)
├── scripts/                      # check-enum-sync, check-migrations, gen-notices, check-licenses, check-contrast
└── docs/                         # PRD, 설계 문서, 목업
```

### 2.3 테이블 소유 모듈

`packages/db/src/schema/<module>.ts` 파일 이름이 소유 모듈입니다. 모듈은 자기 스키마 파일만 import합니다(3.2절 규칙 `no-foreign-tables`). 필드는 → 03.

| 소유 모듈 | 테이블 |
|---|---|
| `novel` | `novels`, `goals`, `series_bibles`, `arcs`, `length_profiles`, `notification_policies`, `novel_counters`, `users` |
| `manuscript` | `episodes`, `manuscript_versions`, `episode_rejections`, `scenes`, `scene_participants` |
| `ontology` | `entities`, `entity_names`, `facts`, `fact_versions`, `timelines`, `ontology_schema_versions`, `schema_change_proposals`, `glossary_terms`, `identity_decisions`, `identity_decision_moves`, `entity_distinct_pairs`, `fact_cardinality_slots`, `mentions` |
| `linking` | 없음(`Mention` 도메인·링커 로직만 소유. 저장은 `OntologyRepository.writeMentions`) |
| `continuity` | `continuity_issues`, `continuity_issue_evidence` |
| `foreshadow` | `setups`, `setup_beats`, `setup_due_changes`, `setup_links` |
| `orchestration` | `tasks`, `task_dependencies`, `wake_requests`, `runs` |
| `agents` | `context_snapshots` |
| `llm` | `provider_profiles`, `role_model_bindings`, `provider_calls` |
| `hitl` | `questions`, `question_options`, `question_links`, `question_deliveries`, `answers`, `answer_interpretations`, `answer_reflections`, `answer_reflection_items`, `approvals`, `digest_batches`, `answer_sessions` |
| `messaging` | `channels`, `messenger_bots`, `channel_binding_tokens`, `messenger_inbox`, `messenger_outbox`, `chat_sdk_state`(조건부, 1.4절) |
| `budget` | `budget_policies`, `budget_reservations`, `cost_events` |
| `audit` | `activity_log` |
| `media` [v1] | `shots`, `scene_prompt_irs`, `rendered_prompts`, `media_quotes`, `media_assets`, `visual_references` |
| `export` | `export_jobs` |
| `system` | `secrets`, `backup_records`, `health_check_results`, `app_migrations` |

`mentions`는 00 4.2에서 `Mention` 도메인 소유가 `linking`이지만, 쓰기·질의 구현이 `ontology`의 `PgOntologyRepository`(06 11.4 `writeMentions`·`listMentions`)이므로 스키마 파일은 `ontology.ts`에 둡니다. `no-foreign-tables`와 `ontology-port`를 함께 지키기 위한 배치입니다.

`chat_sdk_state`, `export_jobs`, `app_migrations`는 이 문서가 처음 쓰는 테이블 이름입니다(미결 10절). `export_jobs`는 07 3.8의 결과를 담습니다: 범위(화·아크·전체와 대상 ID), 형식(`export_format`), 대상 버전 선택(기본·현재 버전), 화별 버전 ID, 화별 글자 수, 파일 경로·해시, 제외 목록(대상 버전이 없는 화). 필드 정의는 → 03 3.10입니다. `identity_decision_moves`, `entity_distinct_pairs`, `fact_cardinality_slots`는 06 2.4, `answer_sessions`는 05 미결 3의 제안입니다.

---

## 3. 의존 규칙과 강제 방법

### 3.1 패키지 의존 방향

| 패키지 | import 허용 | 금지 |
|---|---|---|
| `@ncs/shared` | `zod`만 | 다른 모든 workspace 패키지, `node:*`(브라우저에서도 쓰므로) |
| `@ncs/db` | `@ncs/shared`, `drizzle-orm`, `postgres`, `embedded-postgres` | `@ncs/server`, `@ncs/web` |
| `@ncs/server` | `@ncs/shared`, `@ncs/db` | `@ncs/web`(정적 파일 경로만 설정으로 받음), `@ncs/cli`, `@ncs/test-kit` |
| `@ncs/web` | `@ncs/shared` | `@ncs/db`, `@ncs/server`, `node:*` |
| `@ncs/cli` | `@ncs/shared`, `@ncs/db`, `@ncs/server`(`startServer`만) | `@ncs/web`, `@ncs/test-kit` |
| `@ncs/test-kit` | 모든 workspace 패키지 | 런타임 패키지의 `dependencies`에 들어갈 수 없음(`devDependencies`만) |

### 3.2 서버 내부 규칙 (ADR-008)

| 규칙 ID | 내용 | 강제 |
|---|---|---|
| `no-domain-io` | `modules/*/domain/**`은 `@ncs/shared`와 같은 모듈의 `domain/**`만 import합니다. `node:*`, `drizzle-orm`, `postgres`, `ai`, `chat`, `fetch` 사용 금지 | dependency-cruiser + ESLint `no-restricted-globals`(`fetch`) |
| `layer-direction` | `adapters → application → domain`. `domain`은 `application`·`adapters`를, `application`은 `adapters`를 import하지 않습니다. | dependency-cruiser |
| `module-public-api-only` | 다른 모듈은 `modules/<other>/index.ts`만 import합니다. `index.ts`는 `application`의 유스케이스·포트 타입·도메인 이벤트 타입만 다시 내보냅니다. | dependency-cruiser |
| `no-foreign-tables` | `modules/<m>/adapters/db/**`은 `@ncs/db/schema/<m>`만 import합니다. 다른 모듈의 데이터가 필요하면 그 모듈의 공개 API를 같은 트랜잭션 핸들로 호출합니다(03 5.1절). | dependency-cruiser(경로 패턴) |
| `no-cycles` | 모듈 사이 순환 import 금지 | dependency-cruiser `no-circular` |
| `platform-leaf` | `platform/**`은 `modules/**`·`http/**`·`runtime/**`을 import하지 않습니다. | dependency-cruiser |
| `vendor-confinement` | `ai`·`@ai-sdk/*`는 `modules/llm/adapters/**`만, `chat`·`@chat-adapter/*`는 `modules/messaging/adapters/**`만, `embedded-postgres`는 `@ncs/db/runtime/**`만, `better-auth`는 `http/auth/**`만 import합니다. 공급자 교체가 원고·온톨로지 데이터를 바꾸지 않게 합니다(NFR-EXT-01). | dependency-cruiser |
| `ontology-port` | 온톨로지 테이블(`mentions` 포함, 2.3절) 접근은 `OntologyRepository`(ontology 모듈 포트) 구현만 합니다. `linking`, `continuity`도 `ontology` 공개 API를 거칩니다(ADR-005 엔진 교체 경계). | `no-foreign-tables`에 포함 |

### 3.3 자체 ESLint 규칙 (`eslint-plugin-ncs`)

| 규칙 | 대상 | 내용 | 근거 |
|---|---|---|---|
| `ncs/require-novel-scope` | `modules/*/adapters/db/**` | 작품 소속 테이블(스키마에 `novel_id` 열이 있는 테이블)을 읽거나 쓰는 drizzle 호출은 `scoped(scope, table)` 헬퍼를 거쳐야 합니다. repository 공개 메서드의 첫 인자는 `NovelScope`여야 합니다. 설치 단위 테이블(03 T-6)은 허용 목록으로 뺍니다. | 03 T-3 |
| `ncs/no-raw-enum-literal` | `apps/**` | `episode_status` 등 레지스트리 enum 값을 문자열 리터럴로 비교하지 않고 `@ncs/shared/enums`의 상수를 씁니다. | ADR-013 |
| `ncs/no-secret-in-log` | 전체 | `logger.*`와 `activity` 기록 인자에 `*token*`, `*secret*`, `*apiKey*` 이름의 식별자를 직접 넘기지 않습니다. | NFR-SEC-02 |
| `ncs/no-wallclock-in-domain` | `modules/*/domain/**` | `Date.now()`, `new Date()` 금지. `Clock` 포트로 받습니다(테스트 재현성). | 6.2절 |
| `ncs/money-micros` | 전체 | `_micros` 이름 변수에 소수 리터럴·`parseFloat` 대입 금지 | ADR-016 |

lint는 정적 보장일 뿐이라 DB 수준 보장을 함께 둡니다. 복합 외래 키(03 T-2)가 다른 작품 행 참조를 거부하고, 통합 테스트 `tenant-isolation.int.test.ts`가 작품 2개를 만들어 모든 공개 API에 다른 작품 ID를 넣었을 때 404가 나는지 확인합니다(03 T-4).

---

## 4. 마이그레이션 전략

### 4.1 버전 관리 대상

이름에 "스키마"가 붙는 것이 다섯 가지이고 변경 경로가 다릅니다.

| 대상 | 무엇 | 저장 위치 | 변경 경로 | 소유 |
|---|---|---|---|---|
| (1) DB 스키마 | 테이블·열·제약·인덱스(관계형 + 온톨로지 테이블) | `packages/db/src/migrations/*.sql` | 릴리스. 앱 시작 시 runner가 적용(4.2절) | 이 문서 |
| (2) 기본 온톨로지 스키마 | 통제 어휘 기본판: `entity_type` 기본 키, 관계 유형, 정의역/치역, 개수·시간 제약, 동의어 | `packages/shared/src/ontology/base-schema/v<N>.json` | 릴리스. 추가만 허용(4.4절) | 문법 → 06, 배포 규칙은 이 문서 |
| (3) 작품 온톨로지 스키마 | 작품별 확장(`OntologySchemaVersion`, `SchemaChangeProposal` 승인) | `ontology_schema_versions` 행 | 데이터. 사용자 승인으로 새 버전 발행(FR-ONT-18) | → 06 |
| (4) 처리기 버전 | `linker_version`, 프롬프트 템플릿 버전, 추출기 버전 | 코드 상수 + 각 행의 버전 열 | 릴리스. 재처리 여부는 4.5절 | → 04, 06 |
| (5) IR 스키마 [v1] | `ScenePromptIR.ir.ir_schema_version` | `scene_prompt_irs.ir` | 릴리스. 읽기 시 상향 변환 | → 07 |

### 4.2 DB 스키마 마이그레이션 (1)

| 항목 | 규칙 |
|---|---|
| 작성 | `packages/db/src/schema/*.ts`를 고친 뒤 `pnpm db:generate`(drizzle-kit generate)로 SQL 초안을 만듭니다. drizzle이 표현하지 못하는 것(범위 타입 `int4range`의 `EXCLUDE USING gist`, 부분 유니크 인덱스, `CHECK (id ~ …)`, enum `CHECK`)은 같은 파일에 손으로 씁니다. drizzle-kit의 `EXCLUDE` 지원 여부는 [미확인]입니다. |
| 파일 이름 | `NNNN_<slug>.sql`(4자리 연번). 같은 번호 중복·빈 번호는 `check-migrations`가 실패시킵니다(Paperclip `check-migration-numbering` 패턴). |
| 데이터 이전 | SQL로 어려운 이전은 `NNNN_<slug>.data.ts`(같은 번호)를 둡니다. 멱등이어야 하고 작품 단위 배치로 처리합니다. |
| 기록 테이블 | `app_migrations(id, name, checksum, applied_at, app_version, duration_ms)`. 적용된 파일의 내용이 바뀌면(체크섬 불일치) 시작을 거부합니다. |
| 적용 단위 | 파일 하나 = 트랜잭션 하나. `CREATE INDEX CONCURRENTLY`처럼 트랜잭션 밖 문장은 쓰지 않습니다(로컬 규모에서 불필요, 가정). |
| 안전 검사 | `DROP TABLE`, `DROP COLUMN`, `ALTER … TYPE`, `RENAME`, `NOT NULL` 추가(기본값 없음)는 파일 머리에 `-- ncs:destructive <사유>` 표기가 있어야 통과합니다. 열 삭제는 "읽기 중단 릴리스 → 다음 릴리스에서 삭제" 2단계로 합니다. |
| enum 변경 | 00 6절 → `packages/shared/src/enums.ts` → 마이그레이션의 `CHECK` 순서로 고칩니다(ADR-013). `check-enum-sync`가 DB 카탈로그의 `CHECK` 값 목록과 `enums.ts`를 비교합니다. 값 삭제는 그 값을 가진 행의 이전을 같은 마이그레이션에 넣어야 합니다. |
| 테넌트 규칙 | 새 작품 소속 테이블은 `novel_id NOT NULL`, `UNIQUE (novel_id, id)`, 복합 외래 키(03 T-1·T-2)를 갖춰야 합니다. `check-migrations`가 카탈로그를 조회해 검사합니다. |
| 되돌리기 | down 마이그레이션은 만들지 않습니다. 실패 복귀는 업그레이드 전 백업 복원으로 합니다(4.3절). |

### 4.3 앱 업그레이드 절차 (NFR-REL-05)

`ncs run` 시작(또는 `ncs migrate apply`) 때 `system` 모듈의 마이그레이션 게이트가 실행합니다. 감사 이벤트는 03 6.3절 `system.migration_applied`, `backup.completed`, `backup.failed`, `backup.restored`를 씁니다.

| 단계 | 동작 | 실패 시 |
|---|---|---|
| 1 | DB의 `app_migrations` 최신 번호와 코드의 마이그레이션 목록을 비교합니다. DB가 코드보다 앞서면(다운그레이드) 시작을 거부하고 `ncs restore` 안내를 표시합니다. | 시작 거부 |
| 2 | 적용할 파일이 없으면 종료합니다. | — |
| 3 | 실행 중인 작품을 `pause_reason=maintenance`로 일시정지 상태로 표시합니다(서버가 아직 worker를 시작하지 않은 상태). | — |
| 4 | 업그레이드 전 백업을 만듭니다(`backup_records`, 사유 `pre_migration`, 00 6.12 `backup_trigger`). | 업그레이드 중단, 기존 버전으로 계속 실행 가능 |
| 5 | 마이그레이션을 번호 순서로 적용합니다. `.data.ts`는 같은 번호 SQL 다음에 실행합니다. | 4단계 백업으로 복원 후 시작 거부, 원인 표시 |
| 6 | 기본 온톨로지 스키마 새 판을 등록합니다(4.4절). | 5단계와 같음 |
| 7 | 무결성 점검(`health_check_kind=database`, `ontology_integrity`)을 돌립니다. | 5단계와 같음 |
| 8 | `maintenance` 일시정지를 풀고 worker를 시작합니다. | — |

`self_hosted`는 설정 `database.auto_migrate`(기본 `true`, 가정)를 `false`로 두면 2단계 이후를 수동 `ncs migrate apply`로 넘깁니다. 운영자가 외부 PG 백업을 따로 하는 경우를 위한 선택입니다.

**PG 메이저 업그레이드.** `embedded-postgres`를 메이저가 다른 버전으로 올리는 릴리스는 dump(옛 바이너리) → 새 클러스터 초기화 → restore → 옛 데이터 디렉터리 보관 순서로 이전합니다. 옛 바이너리를 확보하는 방법과 `pg_dump` 동봉 여부는 스파이크 S-7·S-8입니다(→ 09). 통과 전까지 `embedded-postgres` 메이저 버전을 올리지 않습니다.

**클러스터 초기화 옵션.** 인코딩·로케일은 클러스터를 만든 뒤 바꿀 수 없습니다. `initdb`는 `UTF8` 인코딩으로 고정하고, 로케일 공급자(libc `C.UTF-8` 또는 ICU)는 스파이크 S-5(`pg_trgm`의 한글 trigram 생성)의 결과로 MVP-α 첫 릴리스 전에 정합니다. Paperclip 패치는 `LC_MESSAGES=C`만 더합니다 [1차].

### 4.4 기본 온톨로지 스키마 배포 (2)

| 항목 | 규칙 |
|---|---|
| 형식 | `base-schema/v<N>.json`. zod 스키마 `BaseOntologySchema`로 검증합니다. 내용 문법(유형·관계·정의역/치역·개수·시간 제약·동의어)은 → 06. |
| 변경 허용 | 추가만: 유형·관계·속성·동의어 추가, 제약 완화. 키 삭제·이름 변경·제약 강화는 새 판에서 `deprecated` 표시로만 합니다. 기존 사실이 새 판에서 위반이 되는 변경은 금지합니다. |
| 작품 적용 | 작품은 생성 시점의 최신 기본판 위에 `OntologySchemaVersion`을 만듭니다(`novels.active_schema_version_id`). 새 기본판이 나와도 기존 작품의 활성 버전을 자동으로 바꾸지 않습니다. `system` 모듈이 `schema_change_kind=add_*` 제안을 묶어 `SchemaChangeProposal`로 올리고, 승인되면 새 작품 버전을 발행합니다(FR-ONT-18, 흐름 → 06). |
| 검증 | CI `check-base-schema`: (a) 직전 판 대비 추가만 했는지 (b) 골든셋 G17(관계 동의어)·G18(스키마 위반) 기대 결과가 유지되는지. |
| 등록 | 4.3절 6단계에서 기본판 내용을 해시와 함께 읽기 전용 데이터로 등록합니다. 저장 형태(설치 단위 테이블 행 또는 번들 파일 직접 참조)는 → 06(미결 10절). |

### 4.5 처리기 버전과 재처리 (4)

| 버전 | 기록 위치 | 버전이 바뀌었을 때 |
|---|---|---|
| `linker_version` | `mentions.linker_version` | 이미 `confirmed`인 언급은 재처리하지 않습니다. `auto_linked`·`ambiguous` 언급은 재처리 대상으로 표시만 하고, 재링킹은 `task_kind=link_mentions` 작업을 사용자가 시작하거나 다음 화 처리 때 해당 화만 합니다. 캐논 사실을 자동으로 바꾸지 않습니다(R-4). |
| 프롬프트 템플릿 버전 | `runs`·`context_snapshots`(→ 04) | 재처리하지 않습니다. 감사·평가 재현용 |
| `ir_schema_version` [v1] | IR `jsonb` | 읽을 때 상향 변환 함수로 최신 형태로 바꿉니다. 저장본은 그대로 둡니다. |

### 4.6 파생 읽기 모델 (조건부)

ADR-005 재검토 조건이 충족돼 LadybugDB 투영이나 Apache AGE를 추가하면, 그 저장소는 마이그레이션 대상이 아닙니다. 버전이 바뀌면 PG 원천에서 다시 만듭니다(`ncs ontology rebuild-projection`, v1 이후). 백업에도 넣지 않습니다.

---

## 5. 설정·비밀·CLI

### 5.1 설치 홈과 설정 파일

| 항목 | 값 |
|---|---|
| 설치 홈 | 환경 변수 `NCS_HOME`, 없으면 `~/.novel-create-studio`(가정) |
| 설정 파일 | `$NCS_HOME/config.json`. 비밀 값은 넣지 않습니다(비밀 참조 ID만). |
| 하위 디렉터리 | `db/`(embedded 데이터 디렉터리), `storage/`(`local_disk` 루트), `backups/`, `logs/`, `secrets/master.key`, `run/`(PID·포트 잠금 파일) |
| 권한 | 디렉터리 `0700`, `master.key`·`config.json` `0600`. `doctor`가 검사합니다. Windows는 사용자 ACL만 확인합니다(가정). |
| 우선순위 | CLI 플래그 > 환경 변수(`NCS_*`, `DATABASE_URL`) > `config.json` > 코드 기본값(00 7절, `@ncs/shared/defaults`) |
| 스키마 | `InstallConfig`(zod, `packages/shared/src/config-schema.ts`). Paperclip `config-schema.ts`의 교차 검증 구조를 차용하고 키는 새로 정의합니다(→ 10). |

### 5.2 `InstallConfig` 주요 키

00 7절의 `install` 범위 기본값(`llm.call_timeout_seconds`, `run.max_concurrent_*`, `channel.*`, `budget.unpriced_usage_policy`, `backup.interval_hours`·`backup.retention`, `platform_profile.recheck_days`)은 같은 키 이름으로 이 파일에 둡니다. 아래는 이 문서가 더하는 설치 키(`backup.mode` 포함)이며, 00 7.7은 설치 설정 파일 전용 키의 키·기본값 소유를 이 절에 둡니다. 이 표가 그 단일 출처입니다.

| 키 | 기본값 | 설명 |
|---|---|---|
| `deployment_mode` | `local_trusted` | enum `deployment_mode` |
| `exposure` | `private` | enum `exposure` |
| `server.host` | `127.0.0.1` | `local_trusted`는 루프백만 허용 |
| `server.port` | 3210 (가정) | |
| `server.public_base_url` | 없음 | `exposure=public` 또는 Telegram `webhook`이면 필수(HTTPS) |
| `server.trusted_proxies` | 없음 | 신뢰할 역방향 프록시 주소 목록. `exposure=public`이면 필수(CFG-3) |
| `database.mode` | `embedded` | `embedded` 또는 `external` |
| `database.url` | 없음 | `external`이면 필수. 환경 변수 `DATABASE_URL`이 우선 |
| `database.embedded_port` | 54339 (가정) | Paperclip 기본 54329와 겹치지 않게 함 |
| `database.auto_migrate` | `true` | 4.3절 |
| `backup.mode` | `full` (가정) | `full`(DB + 파일) 또는 `files_only`(운영자가 PG 자체 백업을 쓸 때, 8.3절) |
| `storage.provider` | `local_disk` | |
| `storage.root` | `$NCS_HOME/storage` | |
| `secrets.provider` | `local_encrypted` | enum `secret_provider` |
| `secrets.master_key_file` | `$NCS_HOME/secrets/master.key` | `NCS_SECRETS_MASTER_KEY` 또는 `NCS_SECRETS_MASTER_KEY_FILE`이 우선 |
| `messaging.telegram_receive_mode` | 모드에 따름 | `self_hosted` + `exposure=public`이면 `webhook`, 그 밖(`local_trusted`, `self_hosted` + `private`)은 `polling`(enum `telegram_receive_mode`, CFG-4) |
| `auth.session_secret_id` | 없음 | `self_hosted`면 필수(비밀 참조) |
| `logging.level` | `info` | |
| `logging.retention_days` | 14 (가정) | `logs/` 회전 보관 |

**공급자 단가(`provider_profiles`)와 비용 기본값 검증** (2026-10-28 추가, 11 9.4 요청): `provider_profiles`는 사용자가 설치 때 입력하는 데이터이고 이 저장소는 시드 단가를 두지 않습니다(03 3.8, `price_source_url`·`verified_at` 필수). 그래서 비용 기본값의 가정 단가는 공급자 1차 단가로 대조합니다. 11 9.4 `concept.session_budget_usd`(6 USD = 40턴 × 입력 16k·출력 2.5k 토큰 × 입력 5·출력 25 USD/100만 토큰 + 점검 예약 0.3)를 Anthropic 공개 단가로 대조한 결과: Claude Opus 5·4.8·4.7·4.6은 5/25로 가정과 같아 6.0 USD, Claude Opus 5.5는 4/20으로 약 4.9 USD, Claude Fable 5.1(10/50)은 약 11.7 USD라 상한 6 USD로는 약 20턴만 덮습니다[1차, https://platform.claude.com/docs/en/about-claude/pricing , 확인일 2026-10-28(단가표 캐시본 2026-10-06)]. 다른 공급자(OpenAI·Google) 상위 모델 단가는 [미확인]입니다. `doctor`(5.6)에 "`concept_partner` 바인딩 모델의 단가 × 40턴 상한 + `concept.check_reserve_usd` > `concept.session_budget_usd`이면 경고" 점검을 추가하기를 제안합니다(가정, 미구현).

### 5.3 교차 검증 규칙

교차 검증 규칙의 단일 출처는 이 절입니다(02 6.2는 이 표를 참조). 시작 시 `InstallConfig` 검증에서 위반이면 시작을 거부하고 `doctor` 조치 문구를 표시합니다. CFG-7·8은 거부가 아니라 정해진 조치 후 기동합니다.

| ID | 규칙 | 근거 |
|---|---|---|
| CFG-1 | `deployment_mode=local_trusted` ⇒ `exposure=private`, 인증 끔, `server.host`는 루프백(`127.0.0.1`, `::1`, `localhost`) | ADR-002, NFR-SEC-03 |
| CFG-2 | `deployment_mode=self_hosted` ⇒ 인증 켬, `auth.session_secret_id` 존재, `users`에 `owner` 1명 이상 | NFR-SEC-03 |
| CFG-3 | `exposure=public` ⇒ 인증 켬, `server.public_base_url`이 `https://`, 역방향 프록시 신뢰 설정 존재 | NFR-SEC-01, NFR-SEC-03 |
| CFG-4 | `telegram_receive_mode=webhook` ⇒ `deployment_mode=self_hosted`, `exposure=public`, `server.public_base_url` 존재, 봇의 `webhook_secret_id` 존재. `local_trusted`는 `polling` 고정 | NFR-SEC-01, PRD 11절 |
| CFG-5 | `database.mode=external` ⇒ `database.url` 존재, 연결 후 `btree_gist` 생성 가능. `pg_trgm`·`pgvector`는 없어도 기동하고 대체 경로를 씁니다(1.3절, `doctor` `warn`). | ADR-005, 06 11.3 |
| CFG-6 | 호스트 헤더 가드: `local_trusted`는 `Host`가 루프백 이름일 때만 요청을 받습니다(DNS rebinding 방지, Paperclip hostname guard 차용). | NFR-SEC-03 |
| CFG-7 | `telegram_receive_mode=polling` ⇒ 같은 봇에 webhook이 설정돼 있으면 시작 시 해제한 뒤 polling합니다(Telegram은 둘 중 하나만 허용 [1차, PRD 11절]). | PRD 11절 |
| CFG-8 | 비밀 마스터 키 없음 ⇒ 최초 실행이면 생성합니다. 기존 비밀이 있는데 키가 없으면 "비밀 복호화 불가" 상태로 기동하고 재입력을 요구합니다(→ 02 8.2). | NFR-SEC-02 |

### 5.4 비밀 (NFR-SEC-02)

| 항목 | 설계 |
|---|---|
| 대상 | LLM·미디어 API 키, 메신저 봇 토큰, Telegram webhook secret, Discord public key, `self_hosted` 세션 비밀 |
| 저장 | `secrets` 테이블(설치 단위, 03 T-6)에 AES-256-GCM 암호문, nonce, 키 버전을 둡니다. 다른 테이블은 `*_secret_id`로만 참조합니다(예: `messenger_bots.token_secret_id`). Paperclip `local_encrypted` provider를 차용합니다 [1차]. |
| 마스터 키 | 우선순위: `NCS_SECRETS_MASTER_KEY` → `NCS_SECRETS_MASTER_KEY_FILE` → `secrets.master_key_file`. 파일이 없으면 `onboard`가 32바이트 무작위 키를 만들고 `0600`으로 저장합니다. OS 키체인 연동은 v1 후보입니다(가정). |
| 복호화 범위 | 복호화는 `system` 모듈의 `SecretResolver`만 합니다. 평문은 호출 직전 메모리에서만 쓰고 로그·감사 로그·`provider_calls` 요청 원문·내보내기에 넣지 않습니다. |
| 가리기 | (1) pino `redact` 경로 목록, (2) 감사 로그 기록 전 redaction(Paperclip `persistActivity` 차용), (3) `provider_calls` 저장 전 헤더 제거, (4) 내보내기·작품 패키지에서 `secrets` 제외, (5) LLM 카세트 녹화 시 헤더·키 제거(6.4절). 검사: 통합 테스트가 알려진 가짜 키 문자열을 넣고 로그 파일·DB·내보내기 산출물 전체에서 검색해 0건인지 확인합니다. |
| 백업 | 백업에는 암호문만 들어가고 마스터 키는 들어가지 않습니다. 다른 기기에서 복원하면 키 파일을 함께 옮기거나 비밀을 다시 입력해야 하며, `restore`가 이 점을 안내합니다. |
| 회전 | `ncs secrets rotate-master-key`: 새 키로 전체 재암호화(한 트랜잭션) 후 옛 키 파일을 `master.key.<시각>.old`로 남깁니다. MVP-β(가정). |
| 감사 | 값 설정은 `secret.set`(03 6.3절)으로 남기고 값은 남기지 않습니다. |

### 5.5 CLI 명령 (`ncs`)

00 4.1절의 `onboard`, `doctor`, `run`, `service`, `backup`, `restore`에 `migrate`, `config`, `secrets`, `eval`과 [v1] `export`·`import`를 더합니다. 이 명령들은 00 4.1절에 등록됐습니다. 테이블(`app_migrations` 등)과 `database.mode`·`backup.mode` 키는 이 문서가 소유합니다(5.2절, 03 3.10).

| 명령 | 하는 일 | 릴리스 | 근거 |
|---|---|---|---|
| `ncs onboard` | 대화형 초기 설정: 설치 홈 생성, 마스터 키, DB 초기화·마이그레이션, LLM 키 입력과 유효성 확인, 외부로 보내는 데이터 범위 안내(NFR-SEC-04), Telegram 봇 토큰과 `/start` 바인딩 코드 발급, 서비스 등록 제안, 웹 UI 열기. 첫 작품 생성은 웹 UI에서 이어 합니다. | MVP-α | FR-SET-01, 02 |
| `ncs doctor [--json]` | 5.6절 점검을 실행하고 실패마다 원인·조치를 표시합니다. 종료 코드 0/1/2(`pass`/`warn`/`fail`). | MVP-α | FR-SET-03 |
| `ncs run` | 서버를 포그라운드로 실행합니다(마이그레이션 게이트 → HTTP·WS·스케줄러·worker·메신저 수신). 서비스 관리자도 이 명령을 실행합니다. | MVP-α | NFR-REL-06 |
| `ncs service install\|uninstall\|start\|stop\|status\|logs` | OS 서비스 관리자에 사용자 단위 서비스로 등록합니다(8.2절). | MVP-α | D-2, NFR-REL-06 |
| `ncs backup` | 즉시 백업. 설치 전체(→ 02 8.1). 작품 단위 `--novel <id>` 옵션은 S-7 결과에 따라 추가 여부를 정하고(09 U-06), 정해지기 전까지 작품 단위는 v1 작품 패키지(`ncs export`, FR-MAN-06b)로 합니다. | MVP-α(`--novel`은 미정) | FR-MAN-06a, NFR-REL-04 |
| `ncs restore <backup>` | 백업 복원. 절차는 02 8.4: 작품 일시정지 → `pre_restore` 백업 → 새 DB에 백업 엔진의 복원 경로(02 8.2 결정 표)로 복원 → 마이그레이션·무결성 점검 → 활성 DB 교체. 클러스터가 기동하지 않으면 앱이 꺼진 상태에서 이 명령으로만 실행합니다(02 8.4 "클러스터 기동 불가 분기"). 다른 기기 복원 시 마스터 키 안내 | MVP-α | FR-MAN-06a |
| `ncs migrate status\|apply` | 4.3절 게이트를 수동 실행 | MVP-α | NFR-REL-05 |
| `ncs config get\|set\|validate` | `InstallConfig` 조회·변경·검증. 변경은 `settings.changed` 감사 이벤트. 웹 설정 화면이 바꾸지 않는 재시작 필요 키(9.8절)는 이 명령으로만 바꿉니다. | MVP-α | FR-UI-09 |
| `ncs secrets set\|list\|rotate-master-key` | 비밀 입력(표준 입력, 화면 표시 없음), 목록(이름·갱신일만) | MVP-α(`rotate`는 MVP-β) | NFR-SEC-02 |
| `ncs eval golden [--live] [--suite <id>]` | 골든셋 평가(6.5절). 개발·운영 진단용. `--live`는 실제 공급자 호출과 비용 발생을 확인한 뒤 실행 | MVP-α | NFR-QUAL-01 |
| `ncs export` / `ncs import` | 작품 패키지 내보내기·가져오기 | v1 | FR-MAN-06b |

### 5.6 `doctor` 점검 목록

`health_check_kind`(00 6.12절) 값은 서버의 주기 점검과 공유하고 결과를 `health_check_results`에 남깁니다. 나머지는 CLI 전용 로컬 점검이며 DB에 남기지 않습니다.

| 점검 | `health_check_kind` | 내용 |
|---|---|---|
| Node 버전 | — (CLI 전용) | `>=24.11 <25` |
| 설치 홈 권한 | — | 5.1절 권한 |
| 설정 검증 | — | `InstallConfig` 스키마 + CFG-1~8 |
| 포트 | — | `server.port`, `database.embedded_port` 점유 여부, 고아 postmaster(S-9) |
| 마이그레이션 | — | 미적용·다운그레이드·체크섬 불일치 |
| 데이터베이스 | `database` | 연결, PG 버전, 필수 확장 `btree_gist`(없으면 `fail`), 선택 확장 `pg_trgm`·`pgvector`(없거나 한글 trigram 불가면 `warn`과 대체 경로 표시) |
| 온톨로지 무결성 | `ontology_integrity` | 대표명 1개, `merged` 엔티티의 `merged_into_id`, 범위 제약 위반 0건, 스키마 밖 `predicate` 0건 등. 규칙 목록 → 06 |
| LLM 키 | `llm_key` | 공급자별 최소 호출 또는 모델 목록 조회, 잔액(제공 시) |
| 봇 토큰 | `bot_token` | Telegram `getMe`, Discord 로그인 |
| 채널 도달성 | `channel_reach` | 바인딩된 채널 조회(Telegram `getChat`, 메시지는 보내지 않음). Telegram polling이면 `getWebhookInfo` URL 잔존 여부와 최근 409 Conflict 여부도 보고, 해당하면 `warn`과 원인 "다른 곳에서 같은 봇을 수신 중이거나 webhook이 설정됨"·조치(다른 기기의 앱 끄기 또는 봇 토큰 재발급)를 표시합니다(→ 05 9.2 TP4, 9.6, CFG-7) |
| 백업 위치 | `backup_location` | 쓰기 가능, 남은 공간, 최근 성공 시각이 `backup.interval_hours` 이내 |
| 저장소 | `storage` | `storage.root` 쓰기·해시 검증 |

---

## 6. 테스트 전략

### 6.1 계층

| 계층 | 도구 | 대상 | DB | 외부 호출 | 실행 시점 |
|---|---|---|---|---|---|
| 단위 | Vitest | `domain/**` 상태 전이·불변식(03 4절 표를 표 기반 테스트로), `story_range` 연산, 임계값 판정, 비용 계산(micros) | 없음 | 없음 | 모든 PR |
| 저장소 | Vitest + PGlite | repository, 마이그레이션 적용 결과, `CHECK`·복합 FK·`EXCLUDE` 기본 동작 | PGlite(테스트마다 새 인스턴스 또는 트랜잭션 롤백) | 없음 | 모든 PR |
| 통합(실제 PG) | Vitest + `embedded-postgres` | 동시성: CAS lease 경합, wake coalescing, 예산 예약 동시성(FR-BUD-03), 병합·분리 트랜잭션(S-6), 백업·복원 | embedded PG(테스트 스위트당 클러스터 1개, 테스트마다 DB 생성) | 가짜 어댑터 | 모든 PR(Linux), 야간(macOS, Windows는 MB-5부터, 7절 QG-15) |
| 계약 | Vitest | `LlmAdapter` 구현이 공통 계약(출력 토큰 상한 필수, 오류 분류 `error_family`, 사용량 보고)을 지키는지. 메신저 어댑터가 버튼 데이터 한도·429 처리·중복 수신 규칙을 지키는지 | PGlite | 카세트 재생 / 가짜 HTTP 서버 | 모든 PR |
| 복원력 | Vitest + 자식 프로세스 | 서버를 실행 중 `SIGKILL` → 재시작: 작업 재큐, 응답 재사용, 원장 중복 0건, 미응답 호출 `unknown_cost`(FR-AGT-02, MVP-α 완료 기준 4). 절전 주입(`FakeClock` 점프) 중 응답 도착: 응답 보존, 호출 원장 1행 + 정정 1행 이하, 활성 실행은 회수되지 않음(→ 04 LR-1~LR-4) | embedded PG | 가짜 LLM(응답 지연 주입) | 모든 PR(축약), 야간(반복 50회, 가정) |
| E2E | Playwright + `@axe-core/playwright` | 인박스 답변, 승인·반려, 키보드만으로 주요 흐름(NFR-ACC-01, 9.9절 단축키·포커스 순서), 9절 MVP-α 화면별 axe 자동 검사, 가짜 Telegram으로 질문→답변→반영 통지 | embedded PG | 가짜 LLM·메신저 | 모든 PR(스모크), 야간(전체) |
| 골든셋 평가 | `ncs eval golden` | 6.5절 | embedded PG | 재생(PR) / 실제(수동·주간) | 6.5절 |

### 6.2 테스트 재현성

| 항목 | 방법 |
|---|---|
| 시간 | `Clock` 포트. 테스트는 `FakeClock`으로 마감·리마인더·방해금지·lease 만료를 진행시킵니다. |
| ID | `IdGenerator` 포트. 테스트는 결정적 ULID 시퀀스를 씁니다. |
| 동시성 | 통합 테스트는 실제 연결 여러 개로 경합을 만듭니다. PGlite는 단일 연결이라 동시성 테스트에 쓰지 않습니다 [1차]. |
| 외부 공급자 | 기본은 연결 차단. 테스트가 실제 네트워크를 쓰면 실패합니다(`--live` 평가 제외). |

### 6.3 가짜 어댑터 (`@ncs/test-kit/fakes`)

| 가짜 | 대신하는 포트 | 기능 |
|---|---|---|
| `FakeLlmAdapter` | `LlmAdapter`(→ 04) | 스크립트 응답, 지연, 오류(`rate_limited`, `timeout`, `content_filtered`, `invalid_output`) 주입, 사용량 보고 |
| `FakeMessengerTransport` | Chat SDK 접속부 아래 HTTP | Telegram `getUpdates`·`sendMessage`·`answerCallbackQuery`, Discord interaction을 흉내 냅니다. 같은 `update_id` 재전송, 429 + `retry_after` 주입 |
| `FakeStorage` | `StorageProvider` | 메모리 파일 |
| `FakeClock`, `FixedIdGenerator` | `Clock`, `IdGenerator` | 6.2절 |

### 6.4 LLM 녹화·재생 (`LlmCassette`)

에이전트 출력은 비결정적이고 실제 호출은 비용이 들므로, LLM 경로 테스트는 녹화한 응답을 재생합니다.

| 항목 | 설계 |
|---|---|
| 위치 | `LlmAdapter` 구현 바깥을 감싸는 `CassetteLlmAdapter`. 공급자 SDK 호출은 그대로 두고 포트 수준에서 녹화합니다. |
| 키 | `sha256(provider, model_id, prompt_template_id@version, 정규화한 messages, 출력 스키마 해시, max_output_tokens, temperature 등 생성 파라미터)`. 정규화는 ID·시각 같은 휘발 값을 자리표시자로 바꿉니다. |
| 저장 | `packages/test-kit/src/cassettes/<suite>/<key>.json`: 요청 요약, 응답 본문, 구조화 출력, 사용량(토큰), 공급자 요청 ID(가림), 녹화 일시, 모델 버전 |
| 모드 | `replay`(CI 기본. 키가 없으면 테스트 실패), `record`(로컬 수동. API 키와 비용 확인 필요, 기존 파일 덮어쓰기는 `--update`), `passthrough`(실제 호출, 녹화 안 함) |
| 비밀 | 녹화 전 헤더·키·`Authorization` 제거. CI의 비밀 검사(QG-13)가 카세트도 검사합니다. |
| 운영 데이터 재사용 | `provider_calls`에 저장된 요청·응답(FR-AGT-02)을 `ncs eval export-cassettes`로 카세트로 바꿀 수 있습니다(개발자 기기에서 사용자 동의 후, 가정). 원고 본문이 들어가므로 저장소에 커밋하지 않습니다. |
| 무효화 | 프롬프트 템플릿 버전이나 출력 스키마가 바뀌면 키가 바뀌어 재생이 실패합니다. 그 PR이 해당 스위트를 다시 녹화해야 합니다. 녹화 비용은 PR 설명에 적습니다. |
| 한계 | 재생은 회귀 검출용입니다. 모델 품질 변화는 6.5절 실제 평가로만 봅니다. |

### 6.5 골든셋 평가 (NFR-QUAL-01)

| 항목 | 설계 |
|---|---|
| 구성 | `packages/test-kit/src/golden/`: (a) 엔티티 식별 시드 G01~G22(유형 정의 → 06, 엔티티 식별 조사 6.5절), (b) 연속성 시드(모순·떡밥 누락을 심은 30화 분량 원고, 시드 50건 이상, 가정), (c) 인물 지식 위반 시드. 사례마다 `input/`(기획서·원고·답변), `expected.json`(언급별 정답 엔티티 또는 `NIL`, 기대 이슈, 기대 질문 발생), `meta.json`(시드 유형, 이름 사전 완전도) |
| 이름 사전 불완전 | G22에 따라 사례 일부는 정답 별칭을 이름 사전에 미리 넣지 않습니다. |
| 지표 | 엔티티 연결 정밀도·재현율, `mention_kind`별 자동 확정 구간 정밀도, `ambiguous` 언급의 자동 캐논 확정 건수, 높음 심각도 모순 재현율·정밀도, 떡밥 배정 누락 재현율, 인물 지식 위반 재현율, 질문 발생 수, 호출 비용(micros) |
| 목표 | NFR-QUAL-01 값. 연결 정밀도 95% 이상·재현율 90% 이상, 자동 확정 구간 정밀도 `linking.auto_precision_target`(0.98), `ambiguous` 자동 캐논 확정 0건 |
| 재생 평가(PR) | 녹화된 카세트로 전체 파이프라인(추출 → 링킹 → 검사)을 돌립니다. 결정적이므로 지표가 직전 기준선(`golden/baseline.json`)보다 나빠지면 실패합니다. 허용 폭 0(결정적 재생이라 흔들림이 없음). 기준선 갱신은 PR에서 명시적으로 합니다. |
| 실제 평가(수동·주간·모델 변경 시) | `ncs eval golden --live`. 역할별 모델 지정(`RoleModelBinding`)마다 실행해 지표와 비용을 `eval-reports/<날짜>-<모델 조합>.json`으로 남깁니다(저장소 밖 산출물). 실행 비용 상한을 인자로 받고 예약 방식(FR-BUD-03)으로 지킵니다. |
| 임계값 보정 | 00 7.5절 `calibrated` 기본값(`linking.tau_auto.*`, `linking.tau_ask`, `linking.margin_delta`, `dedup.*`, `scene.id_retention_overlap_min`, `prompt.self_consistency_samples`)은 실제 평가 결과로 보정한 뒤 릴리스에 반영합니다. 순서: 자동 확정 구간 정밀도 0.98 이상을 먼저 맞추고 자동 확정 비율을 올립니다(00 7.5절). 보정 기록은 `golden/calibration-log.md`에 남깁니다. |
| 항상 실패시키는 조건 | `ambiguous` 언급에서 나온 사실이 캐논이 됨(F3 가드, 03 4.8·5.2절), `confusable_with` 엔티티(G11)가 자동 확정됨, 3음절 이하 이름이 퍼지 일치만으로 연결됨(`dedup.short_name_max_syllables`) |

---

## 7. CI 품질 게이트

CI는 GitHub Actions(가정)에서 실행합니다. PR 병합 조건은 "필수" 열이 예인 게이트 전체 통과입니다.

| ID | 게이트 | 내용 | 필수 | 시점 |
|---|---|---|---|---|
| QG-01 | 타입 검사 | `pnpm -r typecheck`(`strict`, `noUncheckedIndexedAccess`) | 예 | PR |
| QG-02 | lint | ESLint(3.3절 자체 규칙 포함), Prettier 검사 | 예 | PR |
| QG-03 | 의존 경계 | dependency-cruiser(3.1·3.2절) | 예 | PR |
| QG-04 | enum 동기화 | `check-enum-sync`: `enums.ts` ↔ 마이그레이션 후 DB `CHECK` ↔ `labels.ko.ts` 키 누락 없음 | 예 | PR |
| QG-05 | 마이그레이션 | 번호·체크섬, 안전 검사(4.2절), 빈 DB 전체 적용, 직전 릴리스 DB 스냅숏에서 업그레이드 적용, drizzle 스키마와 실제 DB 차이 없음, 테넌트 규칙 카탈로그 검사 | 예 | PR |
| QG-06 | 기본 온톨로지 스키마 | `check-base-schema`(4.4절) | 예 | PR |
| QG-07 | 단위·저장소·계약 테스트 | 6.1절 해당 계층 | 예 | PR |
| QG-08 | 통합 테스트(실제 PG) | Linux x64 | 예 | PR |
| QG-09 | 복원력 축약 | `SIGKILL` 재시작 시나리오 핵심 5종(가정) | 예 | PR |
| QG-10 | 골든셋 재생 평가 | 6.5절 기준선 대비 회귀 없음, 항상 실패 조건 0건 | 예 | PR |
| QG-11 | E2E 스모크 | Playwright 핵심 흐름 | 예 | PR |
| QG-12 | 라이선스 | (a) 런타임 npm 의존 라이선스가 1.7절 허용 목록 안. (b) 네이티브 바이너리 목록: `scripts/check-licenses`가 플랫폼별 `embedded-postgres` 바이너리 패키지의 `bin/`·`lib/`·`share/` 구성을 열거하고, PostgreSQL License와 동봉 라이브러리(ICU·OpenSSL·zlib 등, 실제 구성 [미확인])의 라이선스를 `THIRD_PARTY_NOTICES.md`에 생성합니다. 목록에 없는 새 파일이 생기면 실패합니다. S-7에서 `pg_dump`·`pg_restore`를 따로 동봉하면 같은 목록에 넣습니다. (c) `THIRD_PARTY_NOTICES.md` 재생성 결과와 커밋본 일치. (d) `borrowed-files.json`의 파일마다 머리 주석에 원 저작권 문구 존재 | 예 | PR |
| QG-13 | 비밀 검사 | 저장소·카세트·픽스처에서 키 형태 문자열 탐지(도구 착수 시 선택) | 예 | PR |
| QG-14 | 빌드·패키지 | `pnpm -r build`, 배포 패키지 `pack` 후 깨끗한 디렉터리에서 `ncs doctor --json` 실행 | 예 | PR |
| QG-15 | 플랫폼 매트릭스 | embedded PG 기동·확장 로드·서비스 설치 dry-run(S-1, S-9). MVP-α는 Linux x64만 매트릭스에 두고 주 개발 OS인 macOS arm64는 수동 확인합니다. Windows x64는 MB-5부터 매트릭스에 넣습니다(09 P-8, MB-5) | 아니오(실패 시 이슈 생성) | 야간 |
| QG-16 | 복원력 반복·E2E 전체·백업 복원 RTO | 6.1절 야간 항목, 복원 소요 시간 기록(NFR-REL-04 RTO 1시간) | 아니오 | 야간 |
| QG-17 | Docker | 이미지 빌드, compose로 기동 후 `/api/health` 통과 | `self_hosted` 착수(MB-5) 전까지 아니오. MB-5부터 예(`docker/`·서버 변경 시) | MB-5 전 야간, 이후 PR |
| QG-18 | 골든셋 실제 평가 | 6.5절, 결과 보고서 첨부 | 아니오 | 주간·수동 |
| QG-19 | 접근성 | (a) `check-contrast`: 테마 토큰 쌍(전경·배경)의 대비를 라이트·다크 두 테마에서 계산해 9.9절 기준 미달 0건 (b) E2E 스모크 화면의 axe 검사에서 `serious`·`critical` 위반 0건 (c) 키보드 전용 흐름 E2E(인박스 답변·승인·반려) 통과 | 예 | PR |

릴리스 태그 조건: QG-01~17·QG-19 통과(QG-17은 MB-5부터) + 최근 7일 안의 QG-18 보고서가 NFR-QUAL-01 목표를 만족(MVP-α 완료 기준 3)합니다.

---

## 8. 패키징·배포

### 8.1 배포 형태

| 단계 | 형태 | 설치 | 비고 |
|---|---|---|---|
| MVP-α·β | npm 패키지 `novel-create-studio`(bin `ncs`) | 전제: Node 24. `npm i -g novel-create-studio` 후 `ncs onboard`, 또는 `npx novel-create-studio onboard` | 웹 UI 빌드 산출물 포함. `embedded-postgres` 플랫폼 바이너리는 해당 패키지의 플랫폼별 의존으로 설치됩니다 [1차, zonky 바이너리]. 설치 크기 [미확인] |
| v1 후보 | 플랫폼별 설치 파일 또는 단일 실행 파일(Node SEA + 동봉 PG 바이너리) | Node 설치 불필요 | 네이티브 바이너리 동봉·서명·자동 업데이트 방식 [미확인]. v1 착수 시 스파이크 |
| `self_hosted` | Docker 이미지 + compose(8.4절) | `docker compose up` | MVP-β MB-5부터 지원(09 3.2) |

**업그레이드.** `npm i -g novel-create-studio@<버전>` → `ncs service restart`(또는 `stop`/`start`) → 시작 시 4.3절 게이트. 앱이 자기 자신을 내려받아 바꾸는 자동 업데이트는 MVP에 두지 않습니다. 새 버전 확인 알림은 v1 후보입니다.

### 8.2 로컬 상시 실행 (NFR-REL-06, D-2)

서버 프로세스 하나가 HTTP·스케줄러·worker·메신저 수신을 모두 맡습니다(ADR-002, → 02). OS 서비스 관리자가 이 프로세스를 로그인 시 시작하고, 죽으면 다시 시작합니다. 관리자 권한이 필요 없는 사용자 단위 등록을 기본으로 합니다.

| OS | 방식 | 등록 위치 | 재시작 | 비고 |
|---|---|---|---|---|
| macOS | launchd LaunchAgent | `~/Library/LaunchAgents/<label>.plist` | `KeepAlive`, `RunAtLoad` | 로그인 사용자 세션에서 실행 |
| Linux | systemd 사용자 유닛 | `~/.config/systemd/user/novel-create-studio.service` | `Restart=on-failure` | 로그아웃 후에도 실행하려면 `loginctl enable-linger` 필요. `service install`이 안내합니다. |
| Windows | 작업 스케줄러 "로그온 시" 작업(가정) | 사용자 작업 | 실패 시 재시작 설정 | Windows 서비스 등록은 관리자 권한·래퍼가 필요해 MVP에서 쓰지 않습니다. 동작 검증은 스파이크 대상 |

| 항목 | 설계 |
|---|---|
| 서비스 명령 | 등록된 서비스는 `ncs run`을 실행합니다. 환경 변수 `NCS_HOME`을 고정해 등록합니다. |
| 단일 인스턴스 | 2단계 잠금입니다(→ 02 2.3). 1단계(`local_trusted`): `$NCS_HOME/run/server.lock`(PID + 포트 기록)을 OS 배타 잠금으로 잡아 같은 홈의 두 번째 서버 실행을 막습니다. 잠금은 프로세스가 끝나면 OS가 풀므로 PID 생존 검사로 고아를 판정하지 않고, 남은 파일은 잠금을 잡은 뒤 내용만 덮어씁니다. PID는 `doctor`·오류 메시지 표시용입니다. 2단계(두 모드): DB advisory lock `instance_lock`. |
| embedded PG 수명주기 | 서버가 PG 자식 프로세스를 시작·정지합니다. 서버가 강제 종료돼 남은 postmaster는 다음 시작 때 `postmaster.pid`를 확인해 정리합니다(Paperclip `embedded-postgres-{owner,supervisor}` 차용, S-9). |
| 절전·재개 | 절전 중에는 OS가 프로세스를 멈춥니다. 재개 후 스케줄러가 벽시계 점프(가정: 2분 이상)를 감지하면 즉시 고아 실행 회수(`reclaim`), 임대 만료 처리, 메신저 재연결, 마감·리마인더 재계산을 합니다(→ 02, 04). 절전 중 질문 발송·수신이 멈춘다는 안내는 설정 화면과 `onboard`에 표시합니다(NFR-REL-06). |
| 종료 처리 | `SIGTERM`/서비스 정지 시 새 실행 시작을 멈추고, 진행 중 외부 호출의 응답 저장(`safe_point`)을 최대 `shutdown.grace_seconds`(00 7.2, 가정 60초, 순서 → 02 7.3)까지 기다린 뒤 PG를 정지합니다. 기다림을 넘기면 그대로 종료하고 재시작 시 `unknown` 처리합니다(FR-AGT-02, → 02 7.2, 04). 순서는 → 02 7.3. |
| 서비스 정지 대기 | `ncs service install`이 만드는 정의 파일에 강제 종료 전 대기 시간을 `shutdown.grace_seconds + 30`초(30초는 PG 정지 여유, 가정)로 명시합니다. systemd: `TimeoutStopSec=`. 지정하지 않으면 `DefaultTimeoutStopSec` 기본 90초가 적용됩니다 [1차, https://www.freedesktop.org/software/systemd/man/latest/systemd-system.conf.html]. launchd: plist `ExitTimeOut`. 지정하지 않을 때 기본값은 [미확인]이며 S-17에서 확인합니다. 앱이 SIGKILL되면 embedded PG 자식이 고아로 남을 수 있고, 다음 시작 때 고아 postmaster 회수(아래 행, S-9)로 정리합니다. Windows 작업 스케줄러의 정지 동작은 S-17의 MB-5 구간(Windows) 확인 대상입니다(→ 09 S-17). |
| 로그 | `$NCS_HOME/logs/server-<날짜>.log`, 일 단위 회전, `logging.retention_days` 보관. `ncs service logs`가 마지막 로그를 보여 줍니다. |
| 상태 표시 | MVP: 웹 UI 상단 배너(서버·채널·예산 상태)와 `ncs service status`. **트레이 아이콘은 v1 후보**입니다. 후보 방식(소형 데스크톱 셸 또는 네이티브 트레이 라이브러리)은 조사하지 않았습니다 [미확인]. 트레이를 넣더라도 서버 프로세스와 분리해 트레이 종료가 서버를 멈추지 않게 합니다. |
| 브라우저 열기 | `onboard` 끝과 `ncs open`(가정)에서 `http://127.0.0.1:<port>`를 엽니다. |

### 8.3 백업 경로 (FR-MAN-06a, NFR-REL-04)

절차·복원 순서는 → 02. 이 문서는 도구만 정합니다.

| 항목 | 설계 |
|---|---|
| DB | `pg_dump` 사용자 정의 형식(`-Fc`)으로 실행 중 일관 스냅숏을 만듭니다. `embedded-postgres` 바이너리에 `pg_dump`·`pg_restore`가 들어 있는지는 S-7 [미확인]. 없으면 (a) 짧은 일시정지 후 데이터 디렉터리 복사, (b) 클라이언트 바이너리 별도 동봉 중 S-7 결과로 고릅니다. |
| 파일 | `storage/`에서 DB에 기록된 저장 키 목록만 복사(해시 검증) |
| 묶음 | `backups/<시각>-<사유>/`에 `db.dump`, `files/`, `manifest.json`(앱 버전, 마이그레이션 번호, 기본 스키마 판, 파일 해시) |
| 주기·보관 | `backup.interval_hours`(24), `backup.retention`(일간 7 + 주간 4) → 00 7.7절 |
| `self_hosted` | 이미지에 `postgresql-client`(외부 PG와 같은 메이저)를 넣어 같은 명령으로 백업합니다. 운영자가 PG 자체 백업을 쓰면 `backup.mode=files_only`(가정)로 파일만 백업합니다. |

### 8.4 Docker (`self_hosted`)

Paperclip Dockerfile은 Rust runner·provider pack·cloud 단계가 대부분이라 구조만 참고합니다(패턴만, → 10).

| 항목 | 설계 |
|---|---|
| 이미지 단계 | `deps`(pnpm fetch, lockfile 고정) → `build`(`pnpm -r build`, web 정적 파일) → `runtime`(`node:24-trixie-slim` [1차, Paperclip base], 운영 의존만 `pnpm deploy`로 추림, `postgresql-client`) |
| 실행 | PID 1은 `tini`, 비루트 사용자 `ncs`(UID 고정), `CMD ["ncs", "run"]`, `EXPOSE 3210` |
| 설정 | `NCS_DEPLOYMENT_MODE=self_hosted`, `NCS_EXPOSURE`, `DATABASE_URL`, `NCS_PUBLIC_BASE_URL`, `NCS_SECRETS_MASTER_KEY_FILE=/run/secrets/ncs_master_key`(Docker secret) |
| 볼륨 | `/data` = `NCS_HOME`(storage, backups, logs). `db/`는 쓰지 않음(외부 PG) |
| DB | compose의 `postgres:18`(가정, embedded와 같은 메이저) 서비스 + 볼륨. 첫 기동 때 `btree_gist` 확장 생성 권한 필요(CFG-5). `pg_trgm`은 공식 이미지 contrib에 있으면 함께 생성하고, 없으면 대체 경로를 씁니다(1.3절) |
| 헬스체크 | `GET /api/health`(프로세스·DB·마이그레이션 상태). 상세 점검은 인증 필요 |
| HTTPS | 앱은 HTTP만 받습니다. `compose.proxy.yaml`에 역방향 프록시 예시를 둡니다. Telegram webhook은 공개 HTTPS(포트 443/80/88/8443)가 필요합니다 [1차, PRD 11절]. |
| 복제본 | **1개만**. 스케줄러·Discord Gateway·Telegram 수신이 프로세스 안에 있습니다. 다중 복제본은 Gateway 소유 lease(Paperclip `chat_endpoint_leases` 패턴)와 스케줄러 리더 선출이 필요하며 범위 밖입니다(→ 02). 시작 시 PG advisory lock으로 두 번째 서버를 거부합니다. |
| 업그레이드 | 이미지 태그 교체 → 재기동 → 4.3절 게이트. 외부 PG의 업그레이드 전 백업은 `database.auto_migrate=false`로 운영자가 직접 할 수 있습니다. |

---

## 9. 웹 UI 화면 구성 (MVP-α)

### 9.1 공통 규칙

| 항목 | 규칙 |
|---|---|
| 범위 | MVP-α P0 화면: 작품 홈(FR-UI-01), 작업 보드(FR-UI-02), 인박스(FR-UI-03), 원고(FR-UI-04), 온톨로지 목록·상세(FR-UI-05a), 떡밥(FR-UI-06), 감사 타임라인(FR-UI-07), 설정(FR-UI-09). 관계도·타임라인(FR-UI-05b)과 미디어 스튜디오(FR-UI-10a·b)는 v1·v2 착수 전 개정에서 정합니다. |
| 경로 | 웹 경로 `/novels/:novelId/<화면>`, API 경로 `/api/novels/:novelId/...`(03 T-4). 다른 작품 ID는 404입니다. |
| 데이터 | 화면은 API DTO(`@ncs/shared/dto`)만 받습니다. 원시 JSON·내부 ID 문자열을 그대로 보이지 않고 `display_no`(`T-12`, `CI-3`, `S-01`)와 한국어 라벨(`labels.ko.ts`)로 표시합니다(FR-UI-03). |
| 무효화 | MVP-α: 인박스·작업 보드만 `refetchInterval`(`ui.poll_interval_seconds` 5초)로 주기 재조회하고, 모든 화면은 창 포커스 재조회와 자기 변경 후 무효화를 씁니다(→ 02 5.3.1). v1: WS `/api/live`의 `{seq, action, target_type, target_id}`(→ 02 5.3.2)를 받아 아래 표 "무효화 이벤트" 열의 `action` 접두사에 맞는 TanStack Query 키를 무효화합니다(FR-UI-08). 이벤트 이름은 03 6.3. |
| 상태 표시 | enum 값은 00 6절 이름 그대로 쓰고 라벨만 한국어로 바꿉니다. 색은 보조 수단이며 라벨·아이콘을 함께 둡니다(9.9절). |
| 장애 배너 | 모든 화면 상단: 서버·채널·예산·온톨로지 무결성 상태(`health_check_results` 최근 `fail`, `novels.pause_reason`, `budget_policies.status=hard_stopped`). 8.2절 "상태 표시"와 같은 영역입니다. |
| 목업 대응 | 목업 `mockups-src/screens/<id>.html`의 `data-screen` 값을 화면 ID로 씁니다: `home`, `board`, `inbox`, `manuscript`, `ontology`, `foreshadow`, `audit`, `settings`. 목업은 감사 타임라인을 `settings` 화면에 합쳐 두었으나 설계는 별도 경로로 둡니다(사이드바 항목이 따로 있음). |

### 9.2 작품 홈 (`home`, FR-UI-01)

경로 `/novels/:novelId`. API `GET /api/novels/:novelId/home`이 아래 묶음을 한 번에 돌려줍니다(가정: 화면당 요청 1개).

| 영역 | 표시 항목 | 데이터 출처 | 이동 | 무효화 이벤트 |
|---|---|---|---|---|
| 목표 진척 | 승인 완료 화수·공개 화수 / 목표 화수(`total_episodes_min`~`max`), 아크별 진행 | `goals`, `episodes.status` 집계(`approved`·`published`), `arcs.status` | 작업 보드 | `episode.*`, `arc.*`, `goal.updated` |
| 비축분 | 비축분(승인 대기 포함·제외) / `goals.reserve_target_episodes`(기본 `reserve.target_episodes` 5) | `episodes.status ∈ {awaiting_approval, approved}` 계산(03 3.2) | 작업 보드(화 필터) | `episode.*` |
| 다음 화 예정 | 다음 공개 예정 화와 시각, 진행 중 화와 예상 완료 시각(표본 5개 미만이면 숨김) | `episodes.scheduled_publish_at`, 04 3.4 예상 완료 시각 계산 | 원고 | `episode.*`, `task.*` |
| 대기 질문 | `question_status ∈ {open, pending}` 건수(차단형·비차단형 구분), 가장 이른 마감, 대기 승인 수(`approval_status=pending`) | `questions`, `approvals` | 인박스 | `question.*`, `approval.*` |
| 열린 연속성 이슈 | `continuity_issue_status ∈ {open, fixing}`을 `issue_severity`(`high`/`medium`/`low`)별 건수로 | `continuity_issues` | 원고(이슈 주석) | `continuity_issue.*` |
| 기한 임박 떡밥 | 미회수 떡밥 중 `due_episode_no − 현재 화 ≤ setup.due_warning_episodes`(5) 또는 초과 | 06 Q5(`findOpenSetups`) | 떡밥(임박 필터) | `setup.*` |
| 비용·예산 | 기간(`budget_window`) 사용액·한도·소진율, 화당 평균, `budget_status` | `cost_events` 합계, `budget_policies` | 설정(예산) | `budget.*`, `cost.*` |
| 장애·일시정지 | 9.1절 장애 배너, 작품 일시정지 사유와 재개 버튼(FR-HIL-03) | `novels.paused_at`·`pause_reason` | — | `novel.paused`, `novel.resumed`, `system.health_check_failed` |

### 9.3 작업 보드 (`board`, FR-UI-02)

경로 `/novels/:novelId/board`. API `GET /api/novels/:novelId/tasks?arc_id&episode_id&status&agent_role`.

| 항목 | 설계 |
|---|---|
| 보기 | (1) 트리: 아크 → 화 → 작업(`tasks.arc_id`·`episode_id`, `parent_task_id`). 화 노드에 `episode_status`와 `block_reasons`를 표시합니다. (2) 칸반: `task_status` 열(`pending`, `ready`, `running`, `blocked`, `failed`, `done`; `cancelled`는 필터로만). 보기 선택은 브라우저 저장소에 둡니다. |
| 작업 카드 | `display_no`, `task_kind` 라벨, 담당 `agent_role`, 대상(화·씬), 시도 `attempt_count`/`max_attempts`, 우선순위 |
| 실행 중 표시 | `status=running`이고 `lease_run_id`의 실행이 `run_status=running`(INV-TSK-02). 실행 시작 시각, 마지막 `heartbeat_at`, 누적 비용(`runs.cost_micros`). `lease_expires_at`이 지났는데 회수 전이면 "응답 없음"으로 표시 |
| 차단 사유 | `blocked` 작업: `block_reason`(`task_block_reason`) 라벨과 `blocked_ref`로 이동(질문 → 인박스, 승인 → 인박스, 예산 → 설정 예산, 연속성 이슈 → 원고). 선행 화 때문에 `pending`인 화는 선행 화 번호와 그 화의 차단 사유를 함께 보입니다(07 2.3 ED-4). |
| 사람 조치 필요 | `failed` 작업(재시도 상한 초과, 04 7.1)은 별도 묶음 "사람 조치 필요"로 맨 위에 둡니다. 마지막 `runs.error_family`·`error_message`와 조치(재시도, 취소, 직접 처리 FR-HIL-04)를 보입니다. |
| 일시정지·재개 | 작품·아크·화·작업 단위 버튼(FR-HIL-03). 진행 중 실행은 안전 지점에서 멈춘다는 안내를 확인 대화 상자에 표시합니다. 감사 `novel.paused`·`arc.paused`·`episode.paused`·`task.paused`와 대응 `*.resumed` |
| 무효화 이벤트 | `task.*`, `run.*`, `episode.*`, `arc.*` |

### 9.4 원고 (`manuscript`, FR-UI-04)

경로 `/novels/:novelId/episodes/:episodeNo`. API `GET .../episodes/:episodeNo/versions`, `GET .../versions/:versionId?with=spans,scenes,issues,beats`, `POST .../episodes/:episodeNo/versions`(사람 편집 저장).

| 요소 | 데이터 출처 | 표시 |
|---|---|---|
| 버전 선택 | `manuscript_versions`(`version_no`, `kind`, `stage`, `author_actor_*`, `is_human_edit`) | 버전 목록과 작성 주체·단계·글자 수(FR-MAN-02) |
| diff | 고른 두 버전(기본: `parent_version_id`와 현재) | 나란히·통합 보기, 문자 diff(07 6.2 위치 사상·7.2와 같은 diff 결과 재사용) |
| 작성 주체 | `attribution_spans`(07 7.2) | 구간 배경 + 줄 머리 표시(사람·에이전트 역할·혼합). 색만으로 구분하지 않고 줄 머리에 글자 표식을 둡니다(9.9절). |
| 연속성 이슈 주석 | `continuity_issues`(`scene_id`·`char_start`·`char_end`, 없으면 화 단위), `continuity_issue_evidence` | 위치 밑줄 + 옆 칸 목록(심각도·상태). 클릭하면 근거 사실·답변·이름 행과 원고 위치로 이동(FR-UI-04 수용 기준) |
| 떡밥 비트 주석 | `setup_beats`(`kind`, `status`, `scene_id`·`char_start`·`char_end`) | 위치 표식(설치·강화·회수), `missing` 비트는 화 머리에 목록 |
| 씬 경계 | `scenes`(`ord`, `char_start`·`char_end`, `status=active`, `summary`, `pov_entity_id`) | 경계선과 씬 머리(씬 번호, 시점 인물, 시간선) |
| 사람 편집 | `POST .../versions` → 새 `ManuscriptVersion(is_human_edit=true)` | 저장 후 07 7.3 표에 따라 진행 중 실행 정지·재검사로 재투입합니다. `published` 화는 편집기를 읽기 전용으로 두고 `retcon` 요청 버튼만 둡니다(INV-EP-04). |
| 무효화 이벤트 | `manuscript.*`, `scene.resegmented`, `continuity_issue.*`, `setup.beat_*`, `episode.*` | — |

에디터 라이브러리는 이 표의 장식 요구로 고릅니다(1.5절). 이슈·비트 위치는 버전마다 다르므로 현재 보이는 버전과 위치의 `manuscript_version_id`가 다르면 07 6.2 사상으로 옮겨 표시하고, 옮길 수 없으면 화 단위 목록에만 둡니다.

### 9.5 온톨로지 목록·상세 (`ontology`, FR-UI-05a)

경로 `/novels/:novelId/entities`, `/novels/:novelId/entities/:entityId`. 모든 읽기는 `ontology` 모듈 공개 API(`OntologyRepository`, 06 11.4)를 거칩니다(3.2절 `ontology-port`).

| 화면 부분 | 내용 | `OntologyRepository` 대응 |
|---|---|---|
| 목록 | 필터: `entity_type`(활성 스키마 유형), `entity_status`(기본 `active`·`candidate`). 검색: 대표명·별칭·호칭·변형(`entity_names.normalized_key`, `hidden_variant` 포함). 열: 대표명, `disambiguator`, 유형, 상태, 등장 화 수, 미확정 언급 수 | `listEntities(scope, filter)`(06 11.4). 이름 검색은 `findNameCandidates`의 정확·완화 경로 재사용 |
| 옛 ID 접근 | `merged` 엔티티 URL은 생존 엔티티로 이동하고 안내를 표시 | `resolveEntityId`(Q9) |
| 상세: 이름 사전 | `entity_names`: 표기, `name_kind`, 대표명 여부, `story_range`, `timeline_id`, `surface_visibility`·`surface_known_by_entity_ids`(표기 사용 범위), `identity_visibility`·`identity_known_by_entity_ids`(정체 연결 인지 범위), `reader_reveal_point`, 출처. 칭호 엔티티는 시점별 보유자 이력 | `getEntityDetail(scope, entity_id)`(06 11.4), `getTitleHolders`(Q6) |
| 상세: 사실 | 시점(`story_range`)·시간선별 사실과 `canon_status`(`candidate`는 구분 표시), 사실 버전 이력 | `getCanonAt(..., {include: 'canon' \| 'canon_and_safe_candidates'})`(Q1, 06 11.4), `getCanonAsRecorded` |
| 상세: 등장 | 등장 화·씬(`scene_participants`) | `getEntityDetail` |
| 상세: 언급 | 언급 목록과 `link_status`(`ambiguous`·`new_entity_candidate` 우선), 신뢰도, 화자, 원고 위치 링크. `ambiguous` 언급은 인박스 판별 질문으로 이동 | `listMentions(scope, {entity_id, link_status})`(06 11.4) |
| 상세: 떡밥 | `setup_links(ref_type=entity)`로 연결된 떡밥 | `findOpenSetups` 변형 또는 `foreshadow` 공개 API |
| 상세: 동일성 이력 | `identity_decisions`(병합·분리·`confirm_distinct`)와 옮긴 참조 수(`identity_decision_moves`), `entity_distinct_pairs` 상대, 되돌리기 버튼(`applied`만, 영향 범위 Q8 미리보기 후 실행) | `computeIdentityImpact`(Q8), `revertIdentityDecision` |
| 무효화 이벤트 | `entity.*`, `entity_name.*`, `fact.*`, `mention.*`, `identity.*` | — |

### 9.6 떡밥 (`foreshadow`, FR-UI-06)

경로 `/novels/:novelId/setups`, `/novels/:novelId/setups/:setupNo`.

| 화면 부분 | 내용 | 데이터 출처 |
|---|---|---|
| 목록 | `setup_narrative_status`와 `canon_status` 두 축 필터, 중요도(`setup_importance`), 기한(`due_kind`, `due_episode_no`/`due_arc_id`) | `setups` |
| 기한 표시 | 현재 화 기준 남은 화수. `≤ setup.due_warning_episodes`(5)면 "임박", 기한이 지난 미회수면 "초과". "기한 초과" 필터(FR-UI-06 수용 기준) | 06 Q5(`findOpenSetups`) |
| 비트 | 비트별 `kind`(설치·강화·회수), `status`, 계획 화(`planned_episode_no`), 실제 위치(`scene_id`·`char_start`·`char_end` → 9.4절 원고 위치 링크) | `setup_beats` |
| 기한 변경 이력 | 변경 전후 기한, 사유, 연결 질문·승인, 주체 | `setup_due_changes` |
| 연결 | 관련 엔티티·사실(엔티티 상세로 이동) | `setup_links` |
| 리포트·지표 | 떡밥 리포트(FR-FOR-05)와 지표(FR-FOR-07)를 표시합니다. 리포트는 `SetupReport` R1~R5(→ 06 8.1), 지표는 `computeSetupMetrics(scope, as_of_episode_no)`(→ 06 8.2)입니다. | 06 8.1·8.2 |
| 무효화 이벤트 | `setup.*` | — |

### 9.7 감사 타임라인 (`audit`, FR-UI-07)

경로 `/novels/:novelId/audit`.

| 항목 | 설계 |
|---|---|
| 조회 API | `GET /api/novels/:novelId/activity?actor_type&actor_id&target_type&target_id&action_prefix&after_seq&limit`. `seq` 내림차순, 커서는 `after_seq`(기본 `limit` 50, 가정). 응답은 `before`/`after`를 가림 처리된 값으로만 돌려줍니다(NFR-SEC-02). |
| 필터 | 주체(`actor_type`, `actor_id`: 사용자·에이전트 역할·시스템 주체), 대상(`target_type`, `target_id`), 동작 접두사(`episode.`, `fact.` 등) |
| 대상 전체 이력 | "특정 화의 전체 이력"(FR-UI-07 수용 기준)은 서버가 그 화의 `manuscript_version`·`scene`·`task`·`continuity_issue` ID를 모아 `target_id IN (...)`으로 함께 조회합니다. 사실은 `fact` 대상 행과 그 사실을 바꾼 `identity_decision` 행을 함께 보입니다. |
| 행 표시 | 시각, 주체 `display_name`(03 3.1), 동작 라벨, 대상 링크, 사유, 변경 전후 요약. 대량 이벤트(`mention.batch_linked`)는 `details` 건수만 표시하고 펼치면 ID 목록 |
| 색인 | `activity_log (novel_id, target_type, target_id, seq)`, `activity_log (novel_id, actor_type, actor_id, seq)`(→ 03 6.2 색인). |
| 무효화 이벤트 | 모든 이벤트(필터에 맞으면 맨 위에 추가) |

### 9.8 설정 (`settings`, FR-UI-09)

경로 `/settings`(설치 단위), `/novels/:novelId/settings`(작품 단위). 모든 변경은 감사 로그에 남습니다(FR-UI-09 수용 기준).

| 구분 | 항목 | 저장 위치 | 검증 | 감사 이벤트 |
|---|---|---|---|---|
| 설치 | LLM·미디어 공급자 키 | `secrets`(5.4절) | 저장 전 `llm_key` 점검 | `secret.set` |
| 설치 | 공급자 프로필(단가 포함) | `provider_profiles` | zod DTO | `provider_profile.changed` |
| 설치 | 메신저 봇 토큰·수신 방식 | `messenger_bots`, `secrets` | `bot_token` 점검, CFG-4·7 | `secret.set`, `settings.changed` |
| 설치 | 백업 주기·보관, 로그 보관 | `InstallConfig`(`backup.*`, `logging.*`) | 스키마 | `settings.changed` |
| 설치(읽기 전용) | `deployment_mode`, `exposure`, `server.*`, `database.*`, `secrets.*` | `InstallConfig` | 재시작이 필요해 웹에서 바꾸지 않고 `ncs config set` 안내만 표시(5.5절) | — |
| 작품 | 채널 연결·해제, 바인딩 코드 발급, 채널 우선순위 | `channels`, `channel_binding_tokens`, `notification_policies.channel_priority` | 바인딩 만료(`channel.binding_token_ttl_minutes`) | `channel.binding_issued`, `channel.bound`, `channel.unbound` |
| 작품 | 역할별 모델 | `role_model_bindings` | `max_output_tokens` 필수 | `model_binding.changed` |
| 작품 | 자율성 수준 | `novels.autonomy_level` | `full_auto`는 정책·저작권 경고 확인 필수(INV-NOV-04), INV-NOV-02 | `novel.autonomy_changed` |
| 작품 | 예산 | `budget_policies` | 하드 한도 ≥ 0, 경고 비율 0~1 | `budget.policy_changed` |
| 작품 | 방해금지·digest·마감·일일 질문 상한 | `notification_policies`(00 7.4 `novel` 범위 키) | 시간 형식, 상한 ≥ 0 | `novel.settings_changed` |
| 작품 | 분량 프로필 | `novels.length_profile_id`, `length_profiles` | `min_chars ≤ max_chars` | `novel.settings_changed` |
| 작품 | 그 밖의 00 7절 `novel` 범위 키(`setup.due_warning_episodes`, `episode.max_rejections` 등) | → 00 7절 | 키별 범위 | `novel.settings_changed` |

| 안내 문구 | 표시 위치 | 근거 |
|---|---|---|
| 절전·종료 중 질문 발송·수신이 멈춤, 복귀 후 자동 재개 | 설치 설정 머리, 채널 설정 칸, `onboard` | NFR-REL-06 |
| 외부 LLM·미디어 공급자로 보내는 데이터 범위(원고 발췌·기획서·온톨로지 사실) | 공급자 키·역할별 모델 칸, `onboard` | NFR-SEC-04 |
| 메신저로는 요약만, 전문은 인증 링크 | 채널 설정 칸 | NFR-SEC-04 |
| 이미 보낸 데이터는 공급자 정책을 따름 + 공급자별 보존 정책 링크(`provider_profiles.retention_policy_url`, → 03 3.8) | 공급자 칸, 작품 삭제 확인 대화 상자 | NFR-SEC-05 |
| 작품 삭제 시 백업 포함 여부 선택 | 작품 설정 맨 아래 위험 영역 | NFR-SEC-05, 02 9.2 |

### 9.9 접근성 (NFR-ACC-01)

| 항목 | 기준 |
|---|---|
| 키보드 흐름 | 인박스: `j`/`k` 항목 이동, `1`~`9` 선택지 고르기, `Enter` 답변 제출, `a` 승인, `r` 반려(포커스는 먼저 `rework_from` 선택(아웃라인부터 / 초고부터 / 문장만)으로 가고, 고른 뒤 사유 입력란으로 이동, → 05 10.2), `?` 단축키 도움말. 문자 입력란에 포커스가 있으면 단일 문자 단축키는 꺼집니다. 승인·반려·제출은 확인 단계를 한 번 거칩니다. 단축키 값은 가정이며 목업 검토 후 고정합니다. |
| 포커스 순서 | 인박스: 목록 → 질문 본문 → 추천안·근거 → 선택지 → 자유 입력 → 제출. 대화 상자는 포커스를 가두고 닫으면 연 요소로 되돌립니다. 포커스 표시는 숨기지 않습니다. |
| 색 대비 | WCAG 2.1 AA(가정, PRD NFR-ACC-01): 본문 4.5:1, 큰 글자 3:1, UI 구성 요소·상태 표식 3:1. 테마 토큰(1.5절 Tailwind 변수) 단계에서 전경·배경 쌍을 정의하고 라이트·다크 모두 `check-contrast`로 검사합니다(QG-19). 컴포넌트는 토큰 쌍만 씁니다. |
| 색 외 표시 | 작성 주체·심각도·상태는 색과 함께 라벨·아이콘·줄 머리 글자를 둡니다(WCAG 1.4.1). |
| 자동 검사 | Playwright + axe(6.1절 E2E, QG-19). 자동 검사가 못 잡는 항목(읽기 순서, 단축키 충돌)은 MVP-α 완료 전 수동 점검표로 확인합니다. |

---

## 10. 미결 사항

| 항목 | 내용 | 정하는 시점·경로 |
|---|---|---|
| embedded PG 바이너리 구성 | `btree_gist`·`pg_trgm`·`pgvector`·`pg_dump` 포함 여부, macOS arm64·Windows x64·Linux arm64 지원과 설치 크기 [미확인] | MVP-α 착수 전 스파이크 S-1, S-7(→ 09) |
| 클러스터 로케일 | `initdb` 로케일 공급자(libc/ICU)와 `pg_trgm` 한글 동작 | MVP-α 첫 릴리스 전, S-5 |
| PG 메이저 업그레이드 절차 | 옛 바이너리 확보와 dump/restore 자동화 | S-8, `embedded-postgres` 메이저를 처음 올리는 릴리스 전(09 S-8). 그때까지 메이저 고정 |
| 고아 postmaster 회수 | Paperclip 수명주기 코드 차용 범위 | S-9 |
| Chat SDK 버전·상태 저장 | 고정 버전(4.39.0 또는 4.43.0), polling dedupe·Gateway 상시 실행 변경 여부 [미확인], StateAdapter 필요 여부 | MVP-α 착수 시, 09 S-14·U-08, 05 미결 9 |
| Windows 상시 실행 | 작업 스케줄러 방식의 재시작·절전 복귀·정지 동작 | 09 S-17의 Windows 항목, MB-5(09 P-8) |
| pnpm 10 전환 | 설치 스크립트 기본 차단이 `embedded-postgres`에 주는 영향 | 착수 시 |
| 미확인 버전 고정 | TypeScript, drizzle-kit, pino, Vitest, Playwright, ESLint, dependency-cruiser, fast-check, Prettier | 저장소 생성 시 최신 안정판 고정 |
| 원고 에디터·diff 라이브러리 | 줄 단위 작성 주체 표시 가능 여부 | MVP-α UI 착수 전 시제품(→ 07 `attribution_spans`와 함께) |
| 트레이·설치 파일·단일 실행 파일 | 방식, 서명, 자동 업데이트 | v1 착수 시 |
| 기본 온톨로지 스키마 저장 형태 | 설치 단위 테이블 행 vs 번들 파일 직접 참조 | → 06 |
| 00·03 레지스트리 갱신 | 해소: CLI 명령은 00 4.1, `backup_trigger`는 00 6.12, `shutdown.grace_seconds`는 00 7절에 등록됐고, 설치 전용 키의 키·기본값 소유는 00 7.7이 이 문서 5.2절에 두었습니다(`backup.mode` 포함). 테이블(`app_migrations`, `chat_sdk_state`(조건부), `export_jobs`) 필드는 03 3.10에 정의됐습니다 | 해소 |
| 감사 로그 색인 | `activity_log (novel_id, target_type, target_id, seq)`, `(novel_id, actor_type, actor_id, seq)` 추가(9.7절) | 해소: → 03 6.2 색인 |
| 온톨로지 화면 읽기 메서드 | `listEntities`, `getEntityDetail`, `listMentions`를 `OntologyRepository`에 추가(9.5절) | 해소: → 06 11.4 |
| 떡밥 리포트·지표 화면 | 리포트 산출물(F-11)·지표 계산(F-12) 정의 후 9.6절 표시 확정 | 해소: → 06 8.1·8.2 |
| 공급자 보존 정책 링크 | `provider_profiles`에 보존 정책 URL 필드 추가 여부(9.8절, NFR-SEC-05) | 해소: → 03 3.8 `retention_policy_url` |
| UI 화면 문서 위치 | 9절을 별도 UI 문서로 옮길지(01 7절 미결) | 해소: 00 1절 문서 지도가 웹 UI 화면 설계 소유를 이 문서 9절로 정했습니다 |
| 작품 단위 백업·복원 | 설치 전체 백업 외에 작품 단위(`ncs backup --novel`)가 가능한지 | S-7, 09 U-06. 불가면 v1 작품 패키지(FR-MAN-06b) |
| 카세트 운영 데이터 재사용 | 사용자 원고가 든 `provider_calls`를 개발 평가에 쓰는 동의 절차 | MVP-β 전 |
| 골든셋 연속성 시드 작성 주체 | 30화·시드 50건 원고를 누가 만드는지(사람 작성 vs 생성 후 검수) | → 09 MVP-α 일정 |
| `self_hosted` 지원 시점과 외부 PG 최소 버전 | 지원 시점은 해소: 09 MB-5(MVP-β, MB-4와 병행). 외부 PG 최소 버전은 PG 17 이상 허용 가정 | 외부 PG 최소 버전 → 09 MB-5 |
