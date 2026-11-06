# 03. 도메인 모델

| 항목 | 내용 |
|---|---|
| 문서 | novel-create-studio 상세 설계 03 |
| 버전 | v0.2 (2026-10-27). v0.1 대비: 04·05·06·07이 제안한 필드·전이 반영(E16, Q2 주체 `user`, `setup_beat_status` `detected → planned`, `AnswerSession` 등), 해소된 미결 3건 종결. 같은 날 02·04·05·06·07·08 교차 후속 반영(F11 `range_close`, `episode_recaps`, INV-CI-05, INV-Q-06, 비용 정정 행 형식, 예약 실패 구분 등) |
| 버전 갱신 | v0.3 (2026-10-28): 컨셉 단계 추가(→ 11). 3.11 `ConceptSession`·`ConceptMessage`·`ConceptBrief`, `Novel`·`SeriesBible`·`Task`·`ContextSnapshot` 필드 보완, `GenreTemplate` 참조 필드, 4.12 `novel_status` 전이 N1~N3, 4.13 컨셉 상태 기계(사본, 소유 11), 6.3 감사 이벤트. v0.3.1(같은 날, 11 v0.2·계획서 교차 후속): 3.11 `turn_extension_count`·`llm_disabled`, 브리프 `source_documents`·`contribution_summary`·`checks.working_brief_hash`·`copy_requests`·인물 객체·`category.secondary_genre_key`, `template_overrides.path` 문법, INV-CON-10~14, 4.12 개정 문단 정정, 4.13 CB6~CB8·CS3 주체 `user`, 5절 `Entity.concept_character_key` |
| 버전 갱신 | v0.3.2 (2026-10-28): 사용자 결정 확정 반영. `novel_status.concept` 별도 상태 확정(PRD D-39), INV-TSK-01 `goal_id` NULL 예외 확정(11 O-C1), INV-BIB-03 적용 범위를 B2가 만든 사실로 넓힘(11 O-C13), 4.13 사본에 INV-CON-15(D-35, CS3 가드), 템플릿 시점 MVP-β(FR-NOV-03b)·v1(FR-NOV-03c)(D-30), 카테고리 키 체계(D-31) |
| 기준 | PRD v0.4 초안, `00-foundation.md` v0.2, `11-concept-development.md` v0.1, 계획서 `../plans/genre-world-templates-plan.md` |
| 역할 | 도메인 엔티티의 필드·관계·불변식, 상태 기계(전이 규칙의 단일 출처), 감사 로그 이벤트, 비용 원장, 버전 관리를 정합니다. enum 값은 → 00 6절, 기본값은 → 00 7절에서만 정의하고 여기서는 이름으로 참조합니다. |
| 작성 | AI 초안. 사람 검토 필요 |

**표기**
- 필드 타입: `id(<접두사>)` 주 키·외래 키(→ 00 5.1), `text`, `int`, `bigint`, `bool`, `ts`(timestamptz, UTC), `time`(벽시계 시각), `jsonb`(zod 스키마로 검증), `enum:<이름>`(→ 00 6절), `enum[]:<이름>`, `micros`(bigint micro-USD, ADR-016), `story_point`(int, → 00 5.5), `story_range`(int4range), `id[]`(ID 배열).
- **필수** 열: Y = NOT NULL, N = NULL 허용, C = 조건부(설명 참고).
- 공통 컬럼 `id`, `novel_id`, `created_at`, `updated_at`은 표에서 생략합니다. 작품 소속 테이블은 모두 `novel_id NOT NULL`입니다(2.2절).
- 불변식 ID: `INV-<영역>-<번호>`. 다른 문서는 이 ID로 참조합니다.
- 릴리스 표시가 없는 항목은 MVP-α입니다.

---

## 1. 모델 개요

```
User ─┐                                   (설치 단위)  ProviderProfile, MessengerBot, LengthProfile(프리셋)
      │
Novel ─┬─ ConceptSession ─ ConceptMessage        ConceptBrief (버전 N) ─ Approval(concept_brief)
       ├─ Goal (1:1)
       ├─ NotificationPolicy (1:1)        BudgetPolicy ─ BudgetReservation ─ CostEvent
       ├─ SeriesBible (버전 N)              RoleModelBinding (역할당 1)
       ├─ Arc ─ Episode ─┬─ ManuscriptVersion ─ Scene ─ SceneParticipant ──▶ Entity
       │                 └─ EpisodeRejection          └─ Shot[v1] ─ ScenePromptIR ─ RenderedPrompt
       ├─ Task ─ TaskDependency                                   └─ MediaAsset ─ VisualReference
       │   └─ WakeRequest ─ Run ─ ProviderCall, ContextSnapshot
       ├─ Question ─ QuestionOption, QuestionLink, QuestionDelivery, Answer ─ AnswerInterpretation
       │   └─ AnswerReflection ─ AnswerReflectionItem             Approval (Question과 1:1)
       ├─ Channel ─ MessengerOutbox                               MessengerInbox (봇 단위)
       ├─ ContinuityIssue ─ ContinuityIssueEvidence ──▶ FactVersion
       ├─ Setup ─ SetupBeat, SetupDueChange, SetupLink ──▶ Entity, Fact
       ├─ [온톨로지 → 06] Entity, EntityName, Mention, Fact, FactVersion, Timeline,
       │                  OntologySchemaVersion, SchemaChangeProposal, GlossaryTerm, IdentityDecision
       └─ ActivityLog (모든 상태 변경)
```

---

## 2. 집합체 경계와 테넌트 스코핑

### 2.1 집합체

집합체는 한 트랜잭션에서 불변식을 함께 지키는 단위입니다. 다른 집합체는 ID로만 참조하고, 여러 집합체를 바꾸는 유스케이스는 application 계층이 한 DB 트랜잭션으로 묶습니다(단일 PG, ADR-004·005).

| 집합체 | 루트 | 포함 엔티티 | 소유 모듈 | 주요 외부 참조 |
|---|---|---|---|---|
| 작품 | `Novel` | `Goal`, `NotificationPolicy`, `NovelCounter`, `RoleModelBinding` | `novel` (`RoleModelBinding`은 `llm`) | `LengthProfile`, `OntologySchemaVersion` |
| 컨셉 세션 | `ConceptSession` | `ConceptMessage`, `working_brief`(세션 행 안) | `concept` | `Channel`, `Task`, `ConceptBrief`, `Approval`, `MessengerInbox` |
| 컨셉 브리프 | `ConceptBrief` | (버전 행 자체) | `concept` | `ConceptSession`, `Approval`, `GenreTemplate`(키·버전만) |
| 기획서 | `SeriesBible` | (버전 행 자체) | `novel` | `Approval`, `ConceptBrief` |
| 아크 | `Arc` | — | `novel` | `Approval` |
| 화 | `Episode` | `ManuscriptVersion`, `EpisodeRejection`, `Scene`, `SceneParticipant` | `manuscript` | `Arc`, `Approval`, `Timeline`, `Entity` |
| 작업 | `Task` | `TaskDependency` | `orchestration` | 대상(`target_type`/`target_id`), `Goal` |
| 실행 | `Run` | `WakeRequest`, `ProviderCall`, `ContextSnapshot` | `orchestration` (`ProviderCall`은 `llm`, `ContextSnapshot`은 `agents`) | `Task`, `BudgetReservation` |
| 질문 | `Question` | `QuestionOption`, `QuestionLink`, `QuestionDelivery`, `Answer`, `AnswerInterpretation`, `AnswerReflection`, `AnswerReflectionItem`, `AnswerSession` | `hitl` | `Channel`, `Task`, 온톨로지 노드 |
| 승인 | `Approval` | — | `hitl` | `Question`(1:1), 대상 |
| 묶음 발송 | `DigestBatch` | — | `hitl` | `Question`, `MessengerOutbox` |
| 채널 | `Channel` | `ChannelBindingToken`, `MessengerOutbox` | `messaging` | `MessengerBot` |
| 예산 | `BudgetPolicy` | — | `budget` | — |
| 비용 원장 | `CostEvent` (append-only) | — | `budget` | `ProviderCall`, `BudgetReservation` |
| 예약 | `BudgetReservation` | — | `budget` | `BudgetPolicy`, `Run`, `ProviderCall` |
| 연속성 이슈 | `ContinuityIssue` | `ContinuityIssueEvidence` | `continuity` | `Episode`, `FactVersion`, `Question` |
| 떡밥 | `Setup` | `SetupBeat`, `SetupDueChange`, `SetupLink` | `foreshadow` | `Scene`, `Entity`, `Fact`, `Approval` |
| 온톨로지 | → 06 | `Entity`, `EntityName`, `Mention`, `Fact`, `FactVersion`, `Timeline`, `OntologySchemaVersion`, `SchemaChangeProposal`, `GlossaryTerm`, `IdentityDecision` | `ontology`, `linking` | `Scene`, `Answer`, `Question` |
| 감사 로그 | `ActivityLog` (append-only) | — | `audit` | 모든 대상 |
| 미디어 [v1] | `Shot` | `ScenePromptIR`, `RenderedPrompt` | `media` | `Scene` |
| 미디어 에셋 [v1] | `MediaAsset` | `VisualReference` | `media` | `Shot`, `Entity`, `CostEvent` |
| 미디어 견적 [v1] | `MediaQuote` | — | `media` | `Approval` |

### 2.2 테넌트 스코핑 (NFR-EXT-04a, FR-NOV-01)

| 규칙 | 내용 |
|---|---|
| T-1 테넌트 키 | 작품 소속 테이블은 모두 `novel_id NOT NULL`이고 `UNIQUE (novel_id, id)`를 가집니다. |
| T-2 복합 외래 키 | 작품 소속 테이블 사이의 외래 키는 `(novel_id, <x>_id) REFERENCES <x>s (novel_id, id)`로 겁니다. 다른 작품 행을 참조하는 행은 DB가 거부합니다. 온톨로지 테이블도 같습니다. |
| T-3 저장소 접근 | 작품 소속 테이블의 repository 메서드는 첫 인자로 `NovelScope { novel_id }`를 받습니다. `novel_id` 조건 없는 조회는 lint로 막습니다(→ 08). |
| T-4 API | 경로는 `/api/novels/:novelId/...`입니다. 다른 작품의 ID로 접근하면 403이 아니라 404를 돌려줍니다(Paperclip 패턴). |
| T-5 예산 격리 | 예산 정책·예약·원장은 작품 단위입니다. 한 작품의 하드 한도는 다른 작품의 실행을 막지 않습니다. 설치 단위 동시 실행 상한(`run.max_concurrent_global`)만 공유합니다. |
| T-6 설치 단위 테이블 | `users`, `provider_profiles`, `messenger_bots`, `length_profiles`(`novel_id IS NULL`인 프리셋), `secrets`, `backup_records`, `health_check_results`(`novel_id` 선택), `messenger_inbox`(`novel_id`는 바인딩 판별 후 채움), 기본 온톨로지 스키마(릴리스와 함께 배포되는 읽기 전용 데이터). 컨셉 공통 질문 세트(`common@1`)와 [MVP-β/v1] 장르 템플릿 컴파일 묶음(`genre-templates.bundle.json`)도 같은 층의 읽기 전용 데이터이고 DB 테이블이 아닙니다. 작품은 `key@version` + 컴파일 해시만 참조하고 내용은 첫 스키마 버전에 복사합니다(계획서 3.6). |
| T-7 작품 삭제 | 작품 삭제는 하드 삭제입니다. 참여 모듈이 정해진 순서로 지우고 파일 저장소의 작품 디렉터리를 지웁니다. 백업 포함 여부는 사용자가 고릅니다(NFR-SEC-05). 삭제 사실만 설치 단위 로그에 남습니다. |
| T-8 엔티티 ID | 엔티티 ID는 작품 사이에 공유하지 않습니다. 작품 패키지 가져오기(v1)는 ID를 유지합니다(ULID 충돌 없음, ADR-018). |

---

## 3. 엔티티 필드

### 3.1 작품·목표·기획

#### `User` (`users`, 설치 단위)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `display_name` | text | Y | 감사 로그·메신저 표시 이름 | FR-UI-07 |
| `role` | enum:user_role | Y | MVP는 `owner`만 | D-16 |
| `auth` | jsonb | C | `self_hosted`에서만 필수(→ 08) | NFR-SEC-03 |

불변식: `INV-USR-01` `local_trusted` 설치에는 `owner` 1명만 있습니다.

#### `Novel` (`novels`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `title` | text | Y | 작품명. 작품 생성 때 임시 제목, 컨셉 승인(11 M-01)에서 사용자가 고른 후보로 바뀔 수 있음 | FR-NOV-01 |
| `genre` | text | Y | 표시 문자열. `concept` 단계에는 빈 문자열 허용, 컨셉 승인(11 M-02)에서 "현대판타지 · 헌터, 회귀" 형식으로 씀 | FR-NOV-01, 03, 11 |
| `approved_concept_brief_id` | id(cbf) | C | 현재 승인된 `ConceptBrief`. `status ≠ concept`이면 필수 | FR-NOV-08 |
| `category` | jsonb | Y | 카테고리 선택 `{genre_key?, genre_label?, secondary_genre_key?, subgenre_keys[], subgenre_labels[], trope_keys[], trope_labels[], audience_facets[], audience_facet_labels[]}`. 승인된 브리프의 `category` 사본. MVP-α는 라벨만, 키는 D-31 확정 체계(3층 + 패싯, 계획서 2.2). 기본 빈 객체 | FR-NOV-11, 03 |
| `template_refs` | jsonb | Y | 사용 장르 템플릿 `[{template_key, version, compiled_hash}]`. 기본 빈 배열. MVP-α는 항상 빈 배열, MVP-β(FR-NOV-03b)·v1(FR-NOV-03c)부터 컨셉 승인 트랜잭션이 채움(D-30 확정) | FR-NOV-03 |
| `target_audience` | text | N | 타깃 독자 | FR-NOV-01 |
| `age_rating` | enum:age_rating | Y | MVP는 `age_15` 이하 | FR-NOV-01, D-13 |
| `status` | enum:novel_status | Y | | — |
| `autonomy_level` | enum:autonomy_level | Y | 기본 `episode_approval` | FR-HIL-01, D-3 |
| `question_threshold` | enum:question_threshold | Y | 기본 `normal` | FR-HIL-06 |
| `media_autonomy` | enum:media_autonomy | Y | 기본 `review_all` | FR-SPX-09, D-25 |
| `media_target_basis` | enum:media_target_basis | Y | 기본 `published` | FR-SPX-01, D-17 |
| `publish_policy` | enum:publish_policy | Y | `full_auto` 외에는 `manual` | D-24 |
| `multi_timeline_enabled` | bool | Y | 다중 시간선 사용(MVP-β) | FR-ONT-04 |
| `possession_mode_enabled` | bool | Y | 빙의 작품의 `persona`/`body` 분리(→ 06) | FR-ONT-01 |
| `default_narration_mode` | enum:narration_mode | Y | 씬 `narration_mode`가 NULL일 때 서술문 viewer를 정하는 작품 기본 서술 방식(→ 06 3.3). enum은 00 6.2, 생성 시 기본값은 00 7.3 `novel.default_narration_mode` | FR-ONT-17 |
| `timezone` | text | Y | IANA 이름, 기본 `Asia/Seoul` | FR-MSG-10 |
| `length_profile_id` | id(lpf) | Y | 분량 프로필 | FR-NOV-04a |
| `active_schema_version_id` | id(osv) | Y | 현재 온톨로지 스키마 버전 | FR-ONT-18 |
| `paused_at` | ts | N | 작품 일시정지 표시 | FR-HIL-03 |
| `pause_reason` | enum:pause_reason | C | `paused_at`이 있으면 필수 | FR-BUD-02, 5.7절 |
| `style_preset_asset_id` | id(ast) | N | 화풍 프리셋(v1) | FR-VIS-05 |

불변식:
- `INV-NOV-01` MVP 빌드에서 `age_rating ∈ {all, age_12, age_15}`.
- `INV-NOV-02` `autonomy_level ≠ full_auto`이면 `publish_policy = manual`.
- `INV-NOV-03` `paused_at`이 있으면 이 작품의 새 `Run`은 시작하지 않습니다(진행 중 실행은 안전 지점에서 정지).
- `INV-NOV-05` `status=concept`인 작품에는 `Goal` 행과 `plan_series_bible` 작업이 없습니다(11 INV-CON-07).
- `INV-NOV-06` 작품 생성 트랜잭션은 `ConceptSession`(11 CS1), 웹 채널(INV-CH-01), `BudgetPolicy` 기본값, `concept_partner`를 포함한 전 역할의 `RoleModelBinding`을 함께 만듭니다(4.12 N1). `concept_partner` 바인딩은 지울 수 없습니다(D-28).
- `INV-NOV-04` `autonomy_level` 변경은 감사 로그에 남고, `full_auto` 선택은 정책·저작권 경고 확인 기록이 있어야 합니다(FR-HIL-01b).

#### `Goal` (`goals`, 작품당 1행)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `revision` | int | Y | 변경마다 1 증가 | FR-NOV-02 |
| `total_episodes_min` | int | Y | 총 화수(범위 하한) | FR-NOV-02 |
| `total_episodes_max` | int | N | 범위 상한 | FR-NOV-02 |
| `cadence_episodes_per_week` | int | Y | 연재 주기(7 = 하루 1화) | FR-NOV-02, FR-AGT-06 |
| `reserve_target_episodes` | int | Y | 비축분 목표 | FR-AGT-06 |
| `ending_direction` | text | Y | 결말 방향. 변경은 `ending_change` 승인 | FR-HIL-07 |
| `notes` | text | N | 기타 목표 메모 | — |

`Goal`은 작품 생성 때가 아니라 첫 `ConceptBrief` 승인 뒤 목표 폼을 저장할 때 만들어집니다(4.12 N3). 목표 폼 초기값은 승인된 브리프의 `ending_direction`, `serial_plan.total_episodes_*`, `cadence_episodes_per_week`입니다(11 M-06·M-07). 예산은 `BudgetPolicy` 행으로 두고 목표 화면에서 함께 편집합니다. 불변식: `INV-GOL-01` 모든 `Task.goal_id`는 이 행을 가리킵니다(FR-AGT-01). `INV-GOL-02` 목표 변경 시 영향받는 계획 작업(`plan_arc`, `outline_episode`, `schedule_episodes`)에 깨우기 요청이 생깁니다.

#### `SeriesBible` (`series_bibles`, 버전 행)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `version_no` | int | Y | 작품 안 단조 증가 | FR-NOV-06 |
| `status` | enum:series_bible_status | Y | | |
| `logline` | text | Y | | |
| `synopsis` | text | Y | | |
| `content` | jsonb | Y | 인물, 세계 규칙, 회귀 규칙, 아크 구성(구조화) | |
| `content_md` | text | Y | 사람용 렌더링 | |
| `author_actor_type` / `author_actor_id` | enum:actor_type / text | Y | 작성 주체 | D-4 |
| `concept_brief_id` | id(cbf) | Y | 입력으로 쓴 승인된 `ConceptBrief` 버전(11 M-09). 승인 화면의 "컨셉 대비 변경" diff 기준 | FR-NOV-06, 08 |
| `approval_id` | id(apr) | N | `series_bible` 승인 | FR-HIL-02 |
| `approved_at` | ts | N | | |

불변식: `INV-BIB-01` `status=approved`인 행은 작품당 최대 1개. `INV-BIB-02` 승인된 기획서가 없으면 `outline_episode`·`draft_episode` 작업이 `ready`가 되지 않습니다(FR-NOV-06). `INV-BIB-03` 기획서 승인 트랜잭션에서 기획서 출처 사실(`fact_source_kind=series_bible`)과 B2(`build_initial_ontology`)가 만든 사실이 `approved`가 됩니다. B2 사실은 `fact_source_kind`(`user_input` 포함)와 무관하게 이 규칙을 따릅니다(07 B2 "기획서 승인에 포함", 11 O-C13 확정).

#### `Arc` (`arcs`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `ord` | int | Y | 작품 안 순서 | |
| `title` | text | Y | | |
| `goal_text` / `conflict_text` / `end_condition` | text | Y | 아크 목표·갈등·결말 조건 | PRD 4절 |
| `planned_episode_from` / `planned_episode_to` | int | Y | 계획 화 범위 | |
| `status` | enum:arc_status | Y | | |
| `plan_approval_id` | id(apr) | N | `arc_plan` 승인 | 6.3.1 표 |
| `arc_approval_id` | id(apr) | N | `arc` 승인(`arc_approval` 수준) | 6.3.1 표 |
| `paused_at` | ts | N | 아크 일시정지 | FR-HIL-03 |

불변식: `INV-ARC-01` 같은 작품의 아크 계획 화 범위는 겹치지 않습니다. `INV-ARC-02` `episode_approval`·`arc_approval`·`co_writing`에서는 `plan_approval_id`가 `approved`여야 그 아크의 `outline_episode` 작업이 시작됩니다.

#### `LengthProfile` (`length_profiles`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `novel_id` | id(nov) | N | NULL이면 설치 프리셋 | |
| `name` | text | Y | 예: "기본" | FR-NOV-04a |
| `min_chars` / `max_chars` | int | Y | 기본 5000 / 5500 | |
| `count_basis` | enum:count_basis | Y | 기본 `with_spaces` | |

#### `NotificationPolicy` (`notification_policies`, 작품당 1행)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `quiet_hours_start` / `quiet_hours_end` | time | N | 작품 `timezone` 기준 | FR-MSG-10 |
| `urgent_exception_enabled` | bool | Y | | D-14 |
| `daily_cap_non_blocking` | int | Y | | FR-MSG-10 |
| `digest_window_minutes` / `digest_max_items` | int | Y | | FR-MSG-06 |
| `deadline_hours_blocking` / `deadline_hours_non_blocking` | int | Y | | FR-MSG-07 |
| `reminder_offsets_minutes` | int[] | Y | 마감 기준 리마인더 시점, 기본 `{0, 1440}` | D-14 |
| `questions_paused` | bool | Y | 질문 일시정지(차단형은 대기열 유지) | FR-MSG-10 |
| `channel_priority` | id[] | Y | 채널 우선순위 | FR-MSG-10 |
| `daily_summary_time` | time | Y | | FR-MSG-06 |
| `absence_mode` | jsonb | N | v1 부재 모드 기간·위임 유형 | FR-HIL-08 |

#### `NovelCounter` (`novel_counters`)
`(novel_id, counter_kind, last_value)`. `counter_kind ∈ {question, setup, continuity_issue, task}`. 표시 번호 발급(→ 00 5.2).

### 3.2 원고

#### `Episode` (`episodes`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `arc_id` | id(arc) | Y | | FR-AGT-01 |
| `episode_no` | int | Y | 작품 안 유일 | |
| `title` | text | N | | |
| `status` | enum:episode_status | Y | 4.1절 | FR-AGT-12 |
| `block_reasons` | enum[]:episode_block_reason | Y | 기본 빈 배열. 상태가 아니라 표시 | FR-AGT-12 |
| `paused_at` | ts | N | 일시정지 표시 | FR-HIL-03 |
| `primary_timeline_id` | id(tln) | Y | 화의 기본 시간선. 씬이 덮어쓸 수 있음 | FR-ONT-04 |
| `outline_version_id` | id(mnv) | N | 현재 아웃라인 | FR-AGT-03 |
| `current_version_id` | id(mnv) | N | 최신 본문 버전 | FR-MAN-01 |
| `approved_version_id` | id(mnv) | N | 승인된 버전(`kind=final`) | |
| `published_version_id` | id(mnv) | N | 공개 처리한 버전 | FR-MAN-03 |
| `rejection_count` | int | Y | 반려 횟수 | FR-AGT-12 |
| `auto_rewrite_count` | int | Y | 기본 0. 마지막 사람 개입 이후 E4·E5·E7·자동 수정으로 만든 검사 사이클 수. 반려(E10·E11), 사람 편집(E16), `rewrite_limit` 질문 답변 시 0으로 되돌림(→ 07 5.4) | NFR-COST-02, FR-ONT-06 |
| `last_rework_from` | enum:rework_from | N | 마지막 반려의 되돌릴 단계 | FR-AGT-12 |
| `hook_note` | text | N | 회차 말 훅 메모 | PRD 4절 |
| `approved_at` / `approved_by_actor_type` / `approved_by_actor_id` | ts / enum / text | C | `approved` 이후 필수 | 6.3.1 표 |
| `published_at` / `published_by_actor_type` / `published_by_actor_id` | ts / enum / text | C | `published`면 필수 | FR-MAN-03 |
| `scheduled_publish_at` | ts | N | `publish_policy=scheduled`일 때 | D-24 |

비축분은 저장하지 않고 계산합니다: 승인 대기 포함 = `status ∈ {awaiting_approval, approved}`, 제외 = `status = approved` (FR-AGT-06).

불변식:
- `INV-EP-01` `(novel_id, episode_no)` 유일.
- `INV-EP-02` `status=awaiting_approval` 진입 시점에 그 화 현재 버전의 `severity=high`, `status ∈ {open, fixing}`인 연속성 이슈가 0건이고, 배정된 `SetupBeat` 중 `missing`이 0건입니다(FR-ONT-06, FR-FOR-08).
- `INV-EP-03` `status=published`이면 `published_version_id = approved_version_id`.
- `INV-EP-04` `published` 화의 원고 변경은 `retcon` 승인을 거친 새 버전으로만 합니다. 씬은 재분할하지 않습니다.
- `INV-EP-05` `rejection_count ≥ episode.max_rejections`이면 `block_reasons`에 `rewrite_limit`이 있고 방향 결정 차단형 질문이 열려 있습니다(FR-AGT-12).

#### `ManuscriptVersion` (`manuscript_versions`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `episode_id` | id(epi) | Y | | |
| `version_no` | int | Y | 화 안 단조 증가(아웃라인·본문 공통 순번) | FR-MAN-01 |
| `kind` | enum:manuscript_version_kind | Y | | FR-MAN-01 |
| `parent_version_id` | id(mnv) | N | diff 기준 | FR-MAN-01 |
| `stage` | enum:episode_status | Y | 만들어질 때 화 상태 | FR-AGT-03 |
| `content` | text | Y | Markdown 본문(아웃라인은 요약 텍스트) | |
| `outline_data` | jsonb | C | `kind=outline`이면 필수: 비트, 씬 계획, 떡밥 비트 배정, 훅 | FR-FOR-02 |
| `char_count_with_spaces` / `char_count_without_spaces` | int | Y | | FR-MAN-02 |
| `content_hash` | text | Y | SHA-256 | |
| `author_actor_type` / `author_actor_id` | enum:actor_type / text | Y | 작성 주체 | D-4, FR-MAN-01 |
| `agent_role` / `model_id` | enum:agent_role / text | C | 에이전트 작성이면 필수 | FR-AGT-08 |
| `run_id` | id(run) | C | 에이전트 작성이면 필수 | |
| `is_human_edit` | bool | Y | 사람이 고친 버전 | FR-HIL-04 |
| `is_fallback_model` | bool | Y | 대체 모델 산출물(v1) | FR-AGT-11 |
| `attribution_spans` | jsonb | Y | `[{start, end, actor_type, actor_id, origin_version_id}]`. 줄·구간 단위 작성 주체. 계산 → 07 7.2 | FR-MAN-01, FR-HIL-05 |
| `writer_annotations` | jsonb | N | `agent:writer` 버전의 자기 신고 주석(`WriterAnnotations`: 씬 경계, 엔티티 힌트, 답변·떡밥 비트 위치. → 07 3.2.1). 다른 버전은 NULL | FR-AGT-05, FR-MSG-09, FR-FOR-08 |

불변식: `INV-MV-01` 버전 행은 수정하지 않습니다(append-only). `INV-MV-02` `attribution_spans`는 본문 전체를 빈틈없이 덮습니다. `INV-MV-03` 사람 작성 구간(`actor_type=user`)을 에이전트 버전이 바꾸면 그 변경은 `human_edit_conflict` 이슈가 되고, 승인 없이 확정되지 않습니다(FR-HIL-04).

#### `EpisodeRejection` (`episode_rejections`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `episode_id` | id(epi) | Y | | |
| `rejection_no` | int | Y | 화 안 순번 | FR-AGT-12 |
| `approval_id` | id(apr) | Y | 반려한 `episode` 승인 | |
| `from_version_id` | id(mnv) | Y | 반려 대상 버전 | |
| `reason` | text | Y | 반려 사유 | FR-AGT-12 |
| `rework_from` | enum:rework_from | Y | | FR-AGT-12 |
| `rejected_by_user_id` | id(usr) | Y | | FR-HIL-02 |

#### `Scene` (`scenes`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `episode_id` | id(epi) | Y | | FR-AGT-05 |
| `ord` | int | Y | 화 안 순서(1~999) | |
| `status` | enum:scene_status | Y | | |
| `manuscript_version_id` | id(mnv) | Y | 경계를 계산한 원고 버전 | FR-AGT-05 |
| `char_start` / `char_end` | int | Y | 원문 위치(반열린 구간) | FR-AGT-05 |
| `story_point` | story_point | Y | `episode_no×1000+ord` | 00 5.5 |
| `timeline_id` | id(tln) | Y | 기본은 화의 `primary_timeline_id` | FR-ONT-04 |
| `location_entity_id` | id(ent) | N | 장소 엔티티 | FR-AGT-05, FR-ONT-12 |
| `pov_entity_id` | id(ent) | N | 시점 인물 | FR-AGT-04 |
| `narration_mode` | enum:narration_mode | N | 씬 서술 방식. NULL이면 `novels.default_narration_mode`. 07 씬 분할이 채움(→ 06 3.3) | FR-ONT-17 |
| `summary` | text | Y | | FR-AGT-05 |
| `boundary_revision` | int | Y | 경계 재계산마다 1 증가 | |

미디어 확장 필드는 이 테이블에 넣지 않고 `scene_id`를 외래 키로 하는 확장 테이블(`shots` 등)로 둡니다(NFR-EXT-02).

불변식: `INV-SC-01` 씬 ID는 재분할 후에도 겹침 기준(`scene.id_retention_overlap_min`) 이상인 새 구간에 유지됩니다. 유지되지 못한 씬은 `retired`(삭제하지 않음). `INV-SC-02` 같은 화의 `active` 씬 구간은 서로 겹치지 않고 현재 버전 전체를 덮습니다. `INV-SC-03` 씬 등장 정보는 `entity_id`만 씁니다(FR-ONT-12).

#### `SceneParticipant` (`scene_participants`)
`(scene_id, entity_id)` 유일. 필드: `participation` enum:scene_participation(Y), `mention_count` int(Y), `first_mention_id` id(mnt)(N). 링커 결과에서 만듭니다(→ 06).

#### `EpisodeRecap` (`episode_recaps`)
화·층·시점 인물별 화 요약입니다. 원천이 아니고 승인 화의 최종 버전에서 다시 만들 수 있습니다. 컨텍스트 "최근 화 요약"에 씁니다(→ 04 9.3).

| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `episode_id` | id(epi) | Y | 접두사 `rcp`(00 5.1) | FR-AGT-04 |
| `source_version_id` | id(mnv) | Y | 요약을 만든 원 버전(승인 화의 `approved_version_id`) | FR-AGT-04 |
| `layer` | enum:recap_layer | Y | `canon` 캐논 층(캐논 층 역할용) / `reader` 독자·시점 층(`writer`·`line_editor`용, → 04 9.3, 06 10.3). enum `recap_layer`(00 6.2) | FR-ONT-17 |
| `pov_entity_id` | id(ent) | N | `reader` 층의 시점 인물. NULL이면 서술자(독자 층). `canon`은 NULL | FR-ONT-17 |
| `summary` | text | Y | 요약 본문 | NFR-COST-03 |
| `prefilter_result` | jsonb | C | `reader`면 필수. 06 Q4(`findIdentityLeaks`)·CR-07a 사전 필터 결과 `{passed, leak_refs, run_id}` | FR-ONT-17 |
| `created_by_run_id` | id(run) | N | 생성 실행 | NFR-OBS-02 |

불변식: `INV-RC-01` `(episode_id, source_version_id, layer, pov_entity_id)` 유일(NULL은 같은 값으로 취급). `INV-RC-02` `layer=reader`이고 `prefilter_result.passed=false`인 요약은 컨텍스트에 넣지 않습니다(→ 04 9.3). `INV-RC-03` 화의 `approved_version_id`가 바뀌면 이전 버전 요약은 쓰지 않고 새 버전에서 다시 만듭니다. 넣은 요약 ID는 `ContextSnapshot.episode_recap_ids`에 기록합니다(→ 04 C-1).

### 3.3 작업·실행

#### `Task` (`tasks`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `display_no` | int | Y | `T-<n>` | |
| `kind` | enum:task_kind | Y | | |
| `agent_role` | enum:agent_role | Y | 담당 역할(1개) | FR-AGT-01, 02 |
| `target_type` / `target_id` | enum:target_type / text | Y | 대상 | FR-AGT-01 |
| `goal_id` | id(gol) | C | 상위 목표 링크. `kind ∈ {concept_turn, import_concept, check_concept_brief}`만 NULL 허용(컨셉 단계에는 `Goal`이 없음, 11 X-1, O-C1 확정) | FR-AGT-01 |
| `arc_id` / `episode_id` | id | N | 필터용 비정규화 | FR-UI-02 |
| `parent_task_id` | id(tsk) | N | | |
| `status` | enum:task_status | Y | 4.2절 | |
| `priority` | int | Y | 비축분 부족 시 상향 | FR-AGT-06 |
| `block_reason` | enum:task_block_reason | C | `status=blocked`면 필수 | FR-UI-02 |
| `blocked_ref_type` / `blocked_ref_id` | enum:ref_type / text | C | 차단 원인 객체(질문·승인·예산 정책) | FR-AGT-07 |
| `paused_at` | ts | N | 작업 단위 일시정지 표시 | FR-HIL-03 |
| `lease_run_id` | id(run) | N | 임대 보유 실행 | FR-AGT-02 |
| `lease_expires_at` | ts | C | `lease_run_id`가 있으면 필수 | ADR-009 |
| `attempt_count` / `max_attempts` | int | Y | | NFR-COST-02 |
| `not_before_at` | ts | N | 재시도 대기 | |
| `input` | jsonb | Y | 입력 참조(`answer_ids`, `rework_from`, 대상 버전 등) | FR-MSG-09 |
| `output_refs` | jsonb | N | 산출물 참조 | |
| `superseded_by_task_id` | id(tsk) | N | 대체한 작업 | |
| `created_by_actor_type` / `created_by_actor_id` | enum / text | Y | | NFR-OBS-01 |
| `started_at` / `completed_at` | ts | N | | FR-AGT-03 |

불변식: `INV-TSK-01` `goal_id`와 대상이 없는 작업은 만들지 않습니다(FR-AGT-01). 예외: 컨셉 작업 3종은 `goal_id` NULL, 대상 `target_type=concept_session`(11 INV-CON-08, CHECK 제약으로 강제, 11 O-C1 확정). `INV-TSK-02` `status=running` ⇔ `lease_run_id`가 있고 그 실행이 `running`. `INV-TSK-03` 임대 획득은 조건부 UPDATE 한 문장으로 하고, 조건은 `status=ready AND (lease_run_id IS NULL OR lease_expires_at < now())`입니다(→ 04). `INV-TSK-04` `attempt_count ≤ max_attempts`. `INV-TSK-05` 대상 화·아크·작품이 일시정지 상태면 새 임대를 주지 않습니다.

#### `TaskDependency` (`task_dependencies`)
`(task_id, depends_on_task_id)` 유일, 순환 금지. 선행 작업이 모두 `done`이면 `pending → ready`.

#### `WakeRequest` (`wake_requests`)
| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `task_id` | id(tsk) | N | 스케줄 깨우기는 NULL 가능 |
| `reason` | enum:wake_reason | Y | |
| `idempotency_key` | text | Y | `(novel_id, idempotency_key)` 유일(→ 00 5.4) |
| `status` | enum:wake_status | Y | |
| `not_before_at` | ts | N | |
| `coalesced_into_id` | id(wak) | N | |
| `claimed_run_id` | id(run) | N | |
| `source_ref_type` / `source_ref_id` | enum:ref_type / text | N | 깨운 원인(답변, 승인 등) |

깨우기 요청은 감사 로그에 남기지 않습니다(운영 내부 상태). 결과인 작업·실행 상태 변경은 남깁니다.

#### `Run` (`runs`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `task_id` | id(tsk) | Y | | |
| `wake_request_id` | id(wak) | Y | | ADR-009 |
| `agent_role` | enum:agent_role | Y | | |
| `status` | enum:run_status | Y | 4.3절 | |
| `stop_reason` | enum:run_stop_reason | C | 종료 상태면 필수 | |
| `error_family` / `error_message` | enum:error_family / text | N | | 5.7절 |
| `prompt_template_version` | text | Y | `<agent_role>.<task_kind>@<semver>` | NFR-OBS-02 |
| `models_used` | jsonb | Y | `[{provider, model_id, model_version}]` | FR-AGT-08 |
| `context_snapshot_id` | id(ctx) | N | | FR-AGT-04 |
| `started_at` / `heartbeat_at` / `finished_at` | ts | N | | NFR-OBS-02 |
| `input_tokens` / `output_tokens` | bigint | Y | 합계 | NFR-OBS-02 |
| `cost_micros` | micros | Y | 원장 합계 캐시 | FR-BUD-01 |
| `rerun_of_run_id` | id(run) | N | 회수 후 재실행이면 원 실행 | FR-AGT-02 (4) |
| `safe_point_seq` | int | Y | 응답 저장이 끝난 마지막 `ProviderCall.seq` | FR-HIL-03 |
| `log_storage_key` | text | N | 상세 로그 파일 | ADR-015 |
| `output_summary` | jsonb | N | | NFR-OBS-02 |

#### `ProviderCall` (`provider_calls`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `run_id` | id(run) | Y | | |
| `seq` | int | Y | 실행 안 순번 | |
| `provider_kind` | enum:provider_kind | Y | | |
| `provider` / `model_id` / `model_version` | text | Y/Y/N | | FR-AGT-08 |
| `idempotency_key` | text | Y | `(novel_id, idempotency_key)` 유일. `run_id + seq + request_hash` 기반 | FR-AGT-02 |
| `request_hash` | text | Y | 같은 요청 재사용 판단 | FR-AGT-02 (2) |
| `max_output_tokens` | int | C | LLM이면 필수 | FR-AGT-08 |
| `max_cost_micros` | micros | Y | 예약 기준 상한 | FR-BUD-03 |
| `reservation_id` | id(rsv) | Y | | FR-BUD-03 |
| `status` | enum:provider_call_status | Y | | |
| `response_storage_key` / `response` | text / jsonb | C | `responded`면 둘 중 하나 필수 | FR-AGT-02 |
| `usage` | jsonb | N | 토큰·장수·초 | FR-BUD-04 |
| `error_family` | enum:error_family | N | | |
| `retry_of_call_id` | id(pcl) | N | | |
| `sent_at` / `responded_at` | ts | N | | |

불변식: `INV-PC-01` 응답은 먼저 이 행에 저장(`responded`)한 뒤 도메인 결과에 반영합니다. `INV-PC-02` 재시작 후 같은 `request_hash`의 `responded` 행이 있으면 다시 호출하지 않고 재사용합니다. `INV-PC-03` 호출당 `CostEvent`는 최대 1행(7절).

#### `ContextSnapshot` (`context_snapshots`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `run_id` | id(run) | Y | | |
| `story_point` / `timeline_id` | story_point / id(tln) | C | 조회 기준 시점. 컨셉 작업(온톨로지 조회 없음)은 NULL | FR-AGT-04 |
| `concept_message_ids` | id[] | Y | 기본 빈 배열. 컨셉 턴에 넣은 최근 메시지(11 2.6 S3) | FR-NOV-07 |
| `pov_entity_id` | id(ent) | N | 시점 인물(아는 이름·지식 필터) | FR-ONT-17 |
| `fact_version_ids` | id[] | Y | 넣은 캐논 사실 버전 | FR-AGT-04 |
| `candidate_fact_version_ids` | id[] | Y | "미확정"으로 넣은 후보 | FR-AGT-04 |
| `constraint_fact_ids` / `setup_ids` / `answer_ids` / `entity_ids` / `entity_name_ids` | id[] | Y | | FR-AGT-04, FR-MSG-09 |
| `schema_version_id` | id(osv) | Y | | |
| `episode_recap_ids` | id[] | Y | 기본 빈 배열. 넣은 화 요약(`episode_recaps`, 3.2절, → 04 9.3) | FR-AGT-04 |
| `provisional_question_ids` | id[] | Y | 기본 빈 배열. 추천안으로 잠정 진행한 비차단형 질문(→ 05 4.3) | FR-MSG-06 |
| `cloned_from_snapshot_id` | id(ctx) | N | 회수 후 재실행이 복제한 원 스냅숏(→ 04 RU-3) | FR-AGT-02 (4) |
| `token_estimate` / `build_ms` | int | Y | | NFR-PERF-04 |

### 3.4 질문·답변·승인

#### `Question` (`questions`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `display_no` | int | Y | `Q-<n>` | |
| `grade` | enum:question_grade | Y | | FR-HIL-07 |
| `question_type` | enum:question_type | Y | | FR-MSG-01 |
| `topic` | enum:question_topic | Y | | |
| `status` | enum:question_status | Y | 4.4절 | |
| `title` / `body` | text | Y | 채널 중립 본문 | FR-MSG-01 |
| `recommendation` | jsonb | C | 추천안(선택지 인덱스 또는 텍스트). `informational` 외 필수 | FR-MSG-01 |
| `rationale` | text | Y | 근거 | FR-MSG-01 |
| `blocking_basis` | enum:blocking_basis | Y | 비차단·정보성은 `none` | FR-HIL-07 |
| `grade_reason` | text | Y | 등급 판정 근거 서술 | FR-HIL-07 |
| `deadline_at` | ts | C | `informational` 외 필수 | FR-MSG-07 |
| `reminder_count` / `last_reminded_at` | int / ts | Y/N | | D-14 |
| `asked_by_role` | enum:agent_role | N | | |
| `created_by_run_id` | id(run) | N | | |
| `approval_id` | id(apr) | C | `approve_reject` 승인 요청이면 필수 | ADR-014 |
| `parent_question_id` | id(qst) | N | 해석 확인·후속 질문의 원 질문 | FR-MSG-16 |
| `depends_on_question_id` | id(qst) | N | 순서 의존 | FR-MSG-06 |
| `digest_batch_id` | id(dgb) | N | | FR-MSG-06 |
| `accepted_answer_id` | id(ans) | N | | FR-MSG-18 |
| `resolution_source` | enum:resolution_source | C | `defaulted`·`resolved`면 필수 | |
| `sent_at` / `answered_at` / `resolved_at` | ts | N | | KPI 응답 시간 |
| `cancelled_reason` | text | C | `cancelled`면 필수 | |

불변식:
- `INV-Q-01` `blocking_basis ≠ none` ⇔ `grade = blocking`. FR-HIL-07의 다섯 기준에 해당하는 결정은 `non_blocking`으로 만들 수 없습니다(골든 시나리오 검사).
- `INV-Q-02` `grade=blocking`인 질문은 마감이 지나도 `defaulted`가 되지 않습니다(fail-closed, FR-MSG-07). 예외는 v1 부재 위임(`resolution_source=absence_delegated`)이고, 리트콘·결말 변경·예산 증액은 위임할 수 없습니다(FR-HIL-08).
- `INV-Q-03` `accepted_answer_id`는 한 번 정해지면 바뀌지 않습니다. 이후 답은 `late`입니다(FR-MSG-18).
- `INV-Q-04` `topic=setup_abandon`은 추천안 자동 적용 대상이 아닙니다(FR-FOR-04).
- `INV-Q-05` 모든 질문은 `QuestionLink`를 하나 이상 가집니다(FR-MSG-01).
- `INV-Q-06` `default_action=hold` 주제(`entity_disambiguation`, `duplicate_entity`, `identity_change`, `interpretation_confirm`, `late_answer_conflict`)도 추천안 자동 적용 대상이 아닙니다. 마감이 지나면 `resolution_source=deadline_hold`로 Q4가 되고 반영 기록은 `not_applied`(사유 "마감 경과, 보류")입니다(→ 05 4.3).

#### `QuestionOption` (`question_options`)
`(question_id, idx)` 유일. 필드: `idx` int, `label` text, `value` jsonb, `is_recommended` bool. 메신저 버튼 데이터에는 `question_id`와 `idx`만 담습니다(PRD 11절).

#### `QuestionLink` (`question_links`)
필드: `question_id`, `ref_type` enum:ref_type, `ref_id` text. 관련 작업·온톨로지 노드·떡밥·화 연결(FR-MSG-01).

#### `QuestionDelivery` (`question_deliveries`)
| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `question_id` | id(qst) | Y | |
| `channel_id` | id(chn) | Y | 웹 인박스 채널 포함 |
| `state` | enum:question_delivery_state | Y | |
| `outbox_id` | id(obx) | N | |
| `provider_message_ref` | text | N | 메시지 갱신용(답변 완료 표시) |
| `posted_at` / `closed_at` | ts | N | |

#### `Answer` (`answers`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `question_id` | id(qst) | Y | | |
| `channel_id` | id(chn) | Y | 웹이면 웹 채널 | FR-MSG-12 |
| `inbox_id` | id(inb) | N | 메신저 수신 원본 | NFR-REL-02 |
| `responder_user_id` | id(usr) | Y | 허용 목록 통과한 사용자 | FR-MSG-02 |
| `received_at` | ts | Y | 경합 판정 기준(서버 수신 시각) | FR-MSG-18 |
| `payload` | jsonb | Y | `selected_idx[]`, `text`, 첨부 판정 | |
| `disposition` | enum:answer_disposition | Y | | FR-MSG-18 |
| `late_resolution` | enum:late_answer_resolution | C | `late`면 필수 | FR-MSG-08 |
| `late_resolution_ref_type` / `late_resolution_ref_id` | enum / text | N | 만든 수정 작업·리트콘 질문 | FR-MSG-08 |

#### `AnswerInterpretation` (`answer_interpretations`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `answer_id` | id(ans) | Y | | FR-MSG-16 |
| `run_id` | id(run) | Y | `world_keeper` 실행 | |
| `status` | enum:interpretation_status | Y | | |
| `proposed_changes` | jsonb | Y | 사실·제약·작업 변경 후보. 엔티티는 `Mention`으로 연결된 ID | FR-MSG-16, FR-ONT-14 |
| `confirm_question_id` | id(qst) | N | 해석 확인 질문(원 질문과 같은 등급) | FR-MSG-16 |
| `final_changes` | jsonb | C | `confirmed`/`corrected`면 필수 | |

불변식: `INV-AI-01` 서술형 답(`free_text` 또는 선택지 밖 답)은 `confirmed`/`corrected` 전에 캐논 사실을 만들지 않습니다(FR-MSG-16). 선택지형 답은 해석 없이 반영합니다.

#### `AnswerReflection` (`answer_reflections`) / `AnswerReflectionItem` (`answer_reflection_items`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `question_id` | id(qst) | Y | | FR-MSG-09 |
| `answer_id` | id(ans) | N | 추천안 자동 적용이면 NULL | |
| `status` | enum:reflection_status | Y | | |
| `consumer_run_ids` | id[] | Y | 변경을 쓴 후속 실행 (b) | FR-MSG-09 |
| `locations` | jsonb | Y | 반영 위치 (c): `[{episode_id, scene_id, manuscript_version_id, char_start, char_end}]`, `{series_bible_id, section}`, 원고 밖 반영(떡밥·이름 사전·스키마)은 `{ref_type, ref_id}`(→ 05 8.1 F5) | FR-MSG-09 |
| `not_applied_reason` | text | C | `not_applied`면 필수 | FR-MSG-09 |
| `notified_at` / `notice_outbox_id` | ts / id(obx) | N | 반영 완료 통지 | FR-MSG-17 |
| `completed_at` | ts | N | | |

`answer_reflection_items`: `reflection_id`, `change_kind` enum:reflection_change_kind, `ref_type`, `ref_id`, `summary` text. 변경 목록 (a).

불변식: `INV-AR-01` 질문당 반영 기록은 1개. `INV-AR-02` 질문이 `resolved`가 되려면 반영 기록이 `applied` 또는 `not_applied`(사유 포함)입니다(FR-MSG-09). `INV-AR-03` `applied`면 `items`와 `locations`가 비어 있지 않습니다(`no_change`는 item 1개로 표현).

#### `AnswerSession` (`answer_sessions`)
메신저에서 여러 단계로 받는 답(반려 사유, 다중 선택, 서술형)의 중간 상태입니다. 중간 단계는 채택 경쟁에 참여하지 않고, 마지막 단계에서 `Answer` 1행으로 제출합니다. 전이(AS1~AS4)·단계 값 → 05 6.3.

| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `id` | id(ase) | Y | 접두사 `ase`는 00 5.1 미등록(9절) | |
| `channel_id` / `question_id` | id(chn) / id(qst) | Y | | FR-MSG-02 |
| `responder_external_ref` | text | Y | 세션 주인. 다른 사용자 입력은 쓰지 않음 | NFR-SEC-01 |
| `step` | text | Y | 현재 단계(값 → 05 6.3) | |
| `collected` | jsonb | Y | 지금까지 입력한 값 | |
| `prompt_message_ref` | text | N | Telegram ForceReply 답장 매칭용 메시지 ID | |
| `status` | enum:answer_session_status | Y | enum은 00 6.4 미등록(9절) | |
| `expires_at` | ts | Y | 시작 + `answer_session.ttl_minutes` | |

불변식: `INV-AS-01` `(channel_id, responder_external_ref)`당 `active` 세션은 1개입니다(→ 05 6.3).

#### `Approval` (`approvals`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `approval_type` | enum:approval_type | Y | | FR-HIL-02 |
| `status` | enum:approval_status | Y | 4.5절 | |
| `subject_type` / `subject_id` | enum:ref_type / text | Y | 대상 | |
| `question_id` | id(qst) | Y | 유일. `approve_reject` 차단형 질문 | ADR-014 |
| `payload` | jsonb | Y | 요약, 주요 변경점, 경고 수, diff·견적 참조 | FR-MSG-05 |
| `requested_by_actor_type` / `requested_by_actor_id` | enum / text | Y | | |
| `decided_by_user_id` / `decided_at` | id(usr) / ts | C | 결정되면 필수 | FR-HIL-02 |
| `decision_note` | text | C | 반려면 필수(사유) | FR-HIL-02 |
| `rework_from` | enum:rework_from | C | `episode` 반려면 필수 | FR-AGT-12 |
| `decided_via_channel_id` | id(chn) | N | | |
| `is_absence_delegated` | bool | Y | v1 부재 위임 | FR-HIL-08 |
| `superseded_by_id` | id(apr) | N | | |

불변식: `INV-APR-01` 같은 `(subject_type, subject_id, approval_type)`의 `pending` 승인은 1개. `INV-APR-02` 승인 결정과 질문 `answered` 전이, 대상 상태 전이는 한 트랜잭션입니다. `INV-APR-03` `retcon`, `ending_change`, `budget_resume`은 부재 위임할 수 없습니다(FR-HIL-08).

#### `DigestBatch` (`digest_batches`)
필드: `kind` enum:digest_kind, `status` enum:digest_status, `channel_id` id(chn)(N), `window_start_at`/`window_end_at` ts, `question_ids` id[], `outbox_id` id(obx)(N), `sent_at` ts(N). 상세 → 05.

### 3.5 채널·메신저

#### `MessengerBot` (`messenger_bots`, 설치 단위)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `kind` | enum:channel_kind | Y | `telegram`/`discord`/`slack` | |
| `label` | text | Y | | |
| `token_secret_id` | text | Y | 비밀 저장소 키(값은 암호화 저장) | NFR-SEC-02 |
| `receive_mode` | enum:telegram_receive_mode | C | Telegram이면 필수 | PRD 11절 |
| `webhook_secret_id` | text | C | `webhook` 모드면 필수 | NFR-SEC-01 |
| `telegram_update_offset` | bigint | N | 마지막 수신함 기록 완료 `update_id`+1(배치 안에서 앞에서부터 연속으로 기록에 성공한 분까지, 처리 완료를 기다리지 않음, DB 보관, → 05 9.2 TP2) | ADR-011 |
| `status` | enum:channel_status | Y | | |
| `last_connected_at` | ts | N | | FR-SET-03 |

#### `Channel` (`channels`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `kind` | enum:channel_kind | Y | | |
| `status` | enum:channel_status | Y | | |
| `bot_id` | id(bot) | C | `web` 외 필수 | |
| `label` | text | Y | 예: `@minjun`, `#회귀자의-흉터` | |
| `external_chat_ref` | jsonb | C | Telegram `chat_id`; Discord `guild_id`·`channel_id`·`thread_id` | FR-MSG-02, 03 |
| `allowed_user_refs` | text[] | C | 허용 사용자 외부 ID. `web` 외 필수 | NFR-SEC-01 |
| `bound_at` | ts | N | | |
| `last_health_at` / `last_health_status` | ts / enum:health_status | N | | FR-SET-03 |
| `disconnected_reason` | text | N | | 5.7절 |

불변식: `INV-CH-01` 작품마다 `kind=web` 채널이 1개 있고 해제할 수 없습니다(FR-MSG-12). `INV-CH-02` 허용 목록 밖 사용자의 입력은 답변·명령으로 반영하지 않고 수신함에 `ignored/unauthorized`로 남깁니다.

#### `ChannelBindingToken` (`channel_binding_tokens`)
필드: `channel_kind`, `token_hash` text(원문 저장 안 함), `status` enum:binding_token_status, `expires_at` ts, `consumed_at` ts(N), `consumed_external_ref` text(N), `channel_id` id(chn)(N, 소비 시 생성). 불변식: `INV-BT-01` 한 번만 소비되고 만료 후 소비 불가(FR-MSG-02).

#### `MessengerInbox` (`messenger_inbox`), `MessengerOutbox` (`messenger_outbox`)
| 테이블 | 핵심 필드 | 불변식 |
|---|---|---|
| `messenger_inbox` | `bot_id`, `novel_id`(N), `channel_id`(N), `event_kind`, `provider_event_id`, `dedupe_key`(유일), `status` enum:inbox_status, `ignore_reason`(N), `sender_external_ref`, `payload`, `received_at`, `processed_at`, `attempt_count`, `last_error` | `INV-IN-01` 같은 `dedupe_key`는 한 번만 처리(NFR-REL-02). 처리 전에 먼저 기록 |
| `messenger_outbox` | `channel_id`, `kind` enum:outbox_kind, `status` enum:outbox_status, `idempotency_key`(유일), `payload`(채널 중립 렌더링 결과), `question_id`(N), `digest_batch_id`(N), `attempt_count`, `next_attempt_at`, `provider_message_ref`(N), `sent_at`, `last_error` | `INV-OUT-01` `delivery_unknown`은 자동 재발송하지 않음 |

상세(수신 모드, 감독 루프, rate limit) → 05.

### 3.6 연속성 이슈

#### `ContinuityIssue` (`continuity_issues`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `display_no` | int | Y | `CI-<n>` | |
| `episode_id` | id(epi) | Y | | FR-ONT-06 |
| `manuscript_version_id` | id(mnv) | Y | 검출한 버전 | |
| `scene_id` / `char_start` / `char_end` | id(scn) / int | N | 원고 위치 | FR-ONT-06 |
| `kind` | enum:continuity_issue_kind | Y | | |
| `severity` | enum:issue_severity | Y | | |
| `status` | enum:continuity_issue_status | Y | 4.6절 | |
| `detector` / `detected_by_run_id` | enum:issue_detector / id(run) | Y/N | | |
| `message` | text | Y | | |
| `proposed_fix` | text | N | 수정안 | PRD 4.1 |
| `fix_scope` | enum:issue_fix_scope | N | 수정 범위 `span`/`scene`/`outline`. 재작성 범위·E4/E5 선택·자동 수정 조건에 씀(→ 07 5.1, 5.3, 5.4) | FR-AGT-10 |
| `auto_fix_diff` | jsonb | C | `resolution_kind=auto_fixed`면 필수(수정 전후 diff) | FR-AGT-10 |
| `resolution_kind` | enum:issue_resolution_kind | C | `resolved`면 필수 | FR-AGT-10 |
| `resolved_by_actor_type` / `resolved_by_actor_id` / `resolved_at` | enum / text / ts | C | 종결 상태면 필수 | |
| `question_id` / `approval_id` | id | N | 상한 도달 질문, 캐논 변경 승인 | FR-ONT-06 |
| `dedupe_key` | text | Y | `(episode_id, kind, 근거 해시)`. 재검사 때 같은 이슈 식별 | |
| `previous_issue_id` | id(cis) | N | 이전 버전에서 이어진 이슈 | |

`continuity_issue_evidence`: `issue_id`, `ref_type`(`fact`·`setup`·`setup_beat`·`answer`·`mention`·`entity_name`·`glossary_term`), `ref_id`, `fact_version_id`(N), `schema_rule_key`(N), `note`.

불변식: `INV-CI-01` 이슈마다 근거 1개 이상과 원고 위치(화 단위 이상)가 있습니다(FR-ONT-06). `INV-CI-02` 자동 수정한 이슈도 지우지 않고 `resolved/auto_fixed`로 남깁니다(FR-AGT-10). `INV-CI-03` `severity=high` 이슈를 `waived`/`false_positive`로 바꾸는 주체는 사용자뿐입니다. `INV-CI-04` `published_canon_conflict`는 `retcon` 승인 없이 `waived` 할 수 없습니다(FR-ONT-07). `INV-CI-05` 텍스트 안전 이슈(`kind ∈ {safety_age_rating, safety_minor_sexual, safety_real_person}`, 00 6.8)는 주체와 관계없이 `waived`·`false_positive`로 바꿀 수 없습니다. 재작성 또는 사람 편집 후 재검사로만 `resolved`가 됩니다(→ 07 5.6 SF-4, NFR-SAFE-01, 02).

### 3.7 떡밥

#### `Setup` (`setups`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `display_no` | int | Y | `S-<n:02>` | |
| `title` / `description` | text | Y | | FR-FOR-01 |
| `importance` | enum:setup_importance | Y | | FR-FOR-01, 04 |
| `narrative_status` | enum:setup_narrative_status | Y | 4.7절 | FR-FOR-01 |
| `canon_status` | enum:canon_status | Y | 4.7절 | FR-FOR-01 |
| `planned_arc_id` | id(arc) | N | 계획을 세운 아크 | FR-FOR-02 |
| `due_kind` | enum:setup_due_kind | Y | | FR-FOR-01 |
| `due_episode_no` / `due_arc_id` | int / id(arc) | C | `due_kind`에 맞는 쪽 필수 | |
| `abandoned_reason` / `abandon_approval_id` | text / id(apr) | C | `abandoned`면 필수 | FR-FOR-06 |
| `paid_off_beat_id` | id(sbt) | C | `paid_off`면 필수 | FR-FOR-08 |
| `created_by_actor_type` / `created_by_actor_id` | enum / text | Y | | |

`setup_links`: `setup_id`, `ref_type ∈ {entity, fact}`, `ref_id`, `pinned_fact_version_id` id(fcv)(N). 관련 엔티티·사실(엔티티 ID만, FR-ONT-12). `pinned_fact_version_id`는 `ref_type=fact`에서만 쓰고, `plant` 비트 확정(E9) 시 그 시점 사실 버전을 고정해 회수 대조 기준으로 씁니다(→ 06 8절).

#### `SetupBeat` (`setup_beats`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `setup_id` | id(stp) | Y | | |
| `kind` | enum:setup_beat_kind | Y | | FR-FOR-01 |
| `status` | enum:setup_beat_status | Y | | FR-FOR-08 |
| `canon_status` | enum:canon_status | Y | 근거가 확정되기 전 `candidate` | 6.3.1 표 |
| `planned_episode_no` | int | N | 아웃라인 배정 화. 계획 없이 검출된 비트는 NULL | FR-FOR-02 |
| `planned_note` | text | N | | |
| `episode_id` / `scene_id` / `manuscript_version_id` / `char_start` / `char_end` | id / int | C | `detected`·`confirmed`면 필수(근거 씬) | FR-FOR-01, 08 |
| `detected_by_run_id` | id(run) | N | 떡밥 검사 실행 | FR-FOR-08 |
| `confirmed_at` | ts | N | 화 확정 시점 | |

#### `SetupDueChange` (`setup_due_changes`)
필드: `setup_id`, `from_due_kind`/`from_due_episode_no`/`from_due_arc_id`, `to_due_kind`/`to_due_episode_no`/`to_due_arc_id`, `reason` text, `question_id`(N), `approval_id`(N), `changed_by_actor_type`/`changed_by_actor_id`. 기한 변경은 수정이 아니라 이 행 추가로만 합니다(FR-FOR-01).

불변식: `INV-SU-01` `planned` 이후의 서사 상태 전이마다 `confirmed` 비트(근거 씬)가 있습니다(FR-FOR-01). `INV-SU-02` `abandoned`는 `setup_abandon` 승인 없이 될 수 없습니다(FR-FOR-06). `INV-SU-03` `canon_status ∈ {approved, published_locked}`인 떡밥의 제목·기한·중요도 변경은 승인(`canon_change`)이 필요하고, 기한 연장은 질문(FR-FOR-04)으로 합니다.

### 3.8 설치 단위·공급자

#### `ProviderProfile` (`provider_profiles`, 설치 단위)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `provider_kind` | enum:provider_kind | Y | | |
| `provider` | text | Y | 예: `anthropic`, `openai`, `google` | |
| `version_no` | int | Y | 단가 변경마다 새 버전 | FR-BUD-04 |
| `models` | jsonb | Y | `[{model_id, model_version, pricing{…_micros}, max_output_tokens, reference_image_limit, duration_limits, content_limits, commercial_terms, retention_days, deprecation_date}]` | PRD 4절, FR-VID-06 |
| `price_source_url` / `verified_at` | text / ts | Y | 단가 출처·확인일 | FR-BUD-04 |
| `retention_policy_url` | text | N | 공급자 데이터 보존 정책 링크. 설정 화면 공급자 칸과 작품 삭제 확인 대화 상자에 표시합니다. 비어 있으면 "보존 정책 확인 필요"로 표시(→ 08 9.8) | NFR-SEC-05 |
| `is_active` | bool | Y | | |

데이터로 관리합니다(NFR-EXT-03). 불변식: `INV-PP-01` `CostEvent`는 계산에 쓴 `provider_profile_id`와 `version_no`를 기록합니다.

#### `RoleModelBinding` (`role_model_bindings`)
`(novel_id, agent_role)` 유일. 필드: `provider_profile_id`, `model_id`, `max_output_tokens`(Y, LLM 필수), `fallback_model_id`(N, v1), `fallback_enabled` bool(기본 false). 변경은 다음 실행부터 적용(FR-AGT-08).

### 3.9 미디어 [v1/v2]

| 엔티티 (테이블) | 핵심 필드 | 불변식 | 관련 |
|---|---|---|---|
| `Shot` (`shots`) | `scene_id`, `ord`, `label`(`SH<n>`), `status` enum:shot_status, `aspect_ratio`, `target_seconds`, `camera` jsonb, `current_ir_id`, `safety_risk`, `stale_since`(N), `skip_reason`(C), `blocked_question_id`(N) | `skipped`면 사유 필수. `safety_risk=review_required`면 사람 확인 전 생성 금지 | FR-SPX-01, 04, 07 |
| `ScenePromptIR` (`scene_prompt_irs`) | `shot_id`, `version_no`, `ir` jsonb(`ir_schema_version` 포함), `field_sources` jsonb(필드 경로 → `fact_version_id` 또는 `user_input`), `safety` jsonb, `created_by_run_id`, `stale_since` | append-only. 시각 속성 필드마다 출처가 있음 | FR-SPX-02, 03, ADR-012 |
| `RenderedPrompt` (`rendered_prompts`) | `ir_id`, `provider_profile_id`, `model_id`, `modality` enum:prompt_modality, `text`, `is_user_edited`, `edited_from_id`, `stale_since` | IR이 새 버전이 되면 편집본에 `stale_since` 설정 | FR-SPX-08 |
| `MediaQuote` (`media_quotes`) | `scope` jsonb(화·씬·샷), `modality`, `amount_micros`, `formula` jsonb, `retry_margin_ratio`, `status` enum:media_quote_status, `approval_id`, `provider_profile_version` | `approved` 견적 없이 대량 생성 금지 | FR-BUD-06a/b, FR-VID-04 |
| `MediaAsset` (`media_assets`) | `kind`, `status`, `quality_tier`, `episode_id`/`scene_id`/`shot_id`/`entity_id`(대상별), `story_range`(N), `storage_key`, `content_hash`, `mime_type`, `provider`, `model_id`, `model_version`, `params`, `rendered_prompt_id`, `ir_id`, `seed`, `reference_asset_ids`, `excluded_reference_ids`, `cost_event_id`, `quote_id`, `is_ai_metadata_embedded`(Y, 항상 true), `adopted_by_actor_type`/`_id`, `is_auto_adopted`, `filter_reason`, `failure_reason`, `source_segments` jsonb(씬 영상·트레일러 구간 → 원본 씬·클립), `generated_at`, `stale_since` | 생성 직후 내려받아 보관. 출처 기록 필수. `scene_video`·`trailer`의 모든 구간이 씬 ID로 역추적 | FR-IMG-04, 06, FR-VID-02, 07, 09 |
| `VisualReference` (`visual_references`) | `entity_id`, `asset_id`, `story_range`, `timeline_id`(N), `status` enum:visual_reference_status, `approval_id` | `approved`만 레퍼런스로 주입 | FR-VIS-01, 02 |

상태 전이는 4.9·4.10절, 파이프라인은 → 07.

### 3.10 내보내기·시스템 (→ 07 3.8, 08 2.3·4절)

#### `ExportJob` (`export_jobs`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `scope_kind` | text | Y | `episode` / `arc` / `novel`(가정: 값이 셋뿐이라 enum 등록 없이 CHECK로 둡니다) | FR-MAN-04a |
| `scope_target_id` | id(epi/arc) | C | `scope_kind`가 `episode`·`arc`면 필수, `novel`이면 NULL | FR-MAN-04a |
| `export_format` | enum:export_format | Y | MVP-α는 `txt`·`markdown`(00 6.12) | FR-MAN-04a |
| `version_selection` | text | Y | `default`(`published_version_id`, 없으면 `approved_version_id`) / `current`(`current_version_id`), → 07 3.8 | FR-MAN-04a |
| `items` | jsonb | Y | 화별 `[{episode_id, episode_no, manuscript_version_id, char_count_with_spaces, char_count_without_spaces}]`, `episode_no` 오름차순 | FR-MAN-02, 04a |
| `excluded` | jsonb | Y | 대상 버전이 없어 뺀 화 `[{episode_id, episode_no, reason}]`. 기본 빈 배열 | FR-MAN-04a |
| `storage_key` / `content_hash` | text / text | C | 완료 시 필수. 파일 위치(`$NCS_HOME/storage/novels/<novel_id>/exports/`, → 08 5.1)와 SHA-256 | FR-MAN-04a |
| `requested_by_actor_type` / `_id` | enum / text | Y | 요청 주체 | D-4 |
| `completed_at` / `failure_reason` | ts / text | N | 완료 시각, 실패 사유 | |

불변식: `INV-EX-01` 완료 행(`completed_at` 있음)은 수정하지 않습니다. 감사 이벤트 `export.created`(6.3절)는 완료 시 1회입니다.

#### `AppMigration` (`app_migrations`, 설치 단위)
필드: `id`(마이그레이션 번호, text, 접두사 ID가 아님), `name`, `checksum`, `applied_at`, `app_version`, `duration_ms`. 적용된 파일의 체크섬이 바뀌면 시작을 거부합니다(→ 08 4절). ADR-018 접두사 규칙의 예외입니다(마이그레이션 도구 관리 테이블).

#### `chat_sdk_state` (설치 단위, 조건부)
메신저 스파이크(09 S-14, 05 미결 9)에서 Chat SDK `StateAdapter`가 필요하다고 정해질 때만 만듭니다(→ 08 1.4). 필드: `key`(text, 주 키), `value`(jsonb), `version`(bigint, CAS용), `expires_at`(ts, N), `updated_at`. 도메인 데이터가 아니라 어댑터 내부 상태라 감사 로그를 남기지 않습니다.

### 3.11 컨셉 (→ 11 5절, 소유 모듈 `concept`)

필드의 의미·규칙 상세는 11 5.2~5.4가 근거입니다. 여기서는 관계형 필드와 불변식만 둡니다.

#### `ConceptSession` (`concept_sessions`)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `purpose` | enum:concept_session_purpose | Y | `initial` / `revision` | FR-NOV-10a·b |
| `entry_mode` | enum:concept_entry_mode | Y | 시작 경로. 전환 이력은 감사 `concept_session.entry_mode_changed` | FR-NOV-09 |
| `base_brief_id` | id(cbf) | C | `revision`이면 필수 | FR-NOV-10a |
| `status` | enum:concept_session_status | Y | 4.13 CS1~CS9 | |
| `stage` | enum:concept_stage | Y | | FR-NOV-07 |
| `pause_reason` | enum:concept_pause_reason | C | `paused`면 필수 | |
| `working_brief` | jsonb | Y | `ConceptBrief.content`와 같은 zod 스키마 + `field_provenance`. 턴마다 갱신 | |
| `field_flip_counts` | jsonb | Y | 필드별 값 변경 횟수 | |
| `agent_turn_count` / `user_message_count` / `turn_limit` | int | Y | `turn_limit` 초기값 `concept.max_turns`. superseded 턴은 세지 않음(11 X-7) | |
| `turn_extension_count` | int | Y | 턴 연장 횟수, 기본 0, 최대 `concept.max_turn_extensions` | 11 3.8 |
| `llm_disabled` | bool | Y | 기본 false. 비용 상한 뒤 [폼으로 마저 입력](CS7)을 고르면 true: `concept_turn`·`import_concept`를 만들지 않음(`check_concept_brief`는 점검 예약분으로 허용) | 11 3.8, CS7 |
| `budget_limit_micros` / `spent_micros` | micros | Y | 세션 상한(`concept.session_budget_usd`)과 누적 캐시(정본은 `cost_events`) | FR-BUD-01 |
| `active_channel_id` | id(chn) | Y | 마지막으로 사용자가 말한 채널. 기본 웹 채널 | FR-MSG-01 |
| `in_flight_task_id` | id(tsk) | N | 진행 중 `concept_turn` | |
| `question_set_version` | text | Y | 예: `common@1` | |
| `template_refs` | jsonb | Y | `[{template_key, version, compiled_hash}]`. 세션 시작 이후 고정(11 3.6 버전 고정). 기본 빈 배열 | FR-NOV-03, 11 |
| `pending_approval_id` / `approved_brief_id` | id(apr) / id(cbf) | C | `awaiting_approval` / `approved`면 필수 | |
| `last_user_message_at` / `reminded_at` | ts | N | | |
| `created_by_user_id` | id(usr) | Y | | D-4 |

#### `ConceptMessage` (`concept_messages`, append-only)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `session_id` | id(cns) | Y | | |
| `seq` | int | Y | 세션 안 수신 순 단조 증가. `UNIQUE (session_id, seq)` | |
| `author_kind` | enum:concept_message_author | Y | | D-4 |
| `author_user_id` / `run_id` | id(usr) / id(run) | C | `user`면 사용자, `agent`면 실행 필수 | NFR-OBS-01 |
| `channel_id` / `inbox_id` / `outbox_id` | id(chn) / id(inb) / id(obx) | Y / N / N | 수신 원본·발신 기록 | NFR-REL-02 |
| `kind` | enum:concept_message_kind | Y | | |
| `body` | text | Y | 원문·발화. 감사 로그에 넣지 않음 | NFR-SEC-04 |
| `options` / `picked_idx` / `asked_field_paths` | jsonb / int / text[] | C | 질문·선택 메시지 | |
| `slot_updates` | jsonb | Y | `[{field_path, before, after, origin, slot_state}]`. 슬롯 변경의 정본 | INV-CON-03 |
| `responds_to_seq` / `is_superseded` / `provider_message_ref` | int / bool / text | N / Y / N | 11 X-7, 메신저 답장 매칭 | |

#### `ConceptBrief` (`concept_briefs`, 버전 행)
| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `session_id` | id(cns) | Y | 만든 세션 | |
| `version_no` | int | Y | 작품 안 단조 증가 | |
| `status` | enum:concept_brief_status | Y | 4.13 CB1~CB8 | |
| `approval_id` / `approved_at` | id(apr) / ts | C | `approved`면 필수 | FR-NOV-08 |
| `supersedes_id` | id(cbf) | N | | |
| `author_actor_type` / `author_actor_id` | enum:actor_type / text | Y | 제출 주체 | D-4 |
| `entry_mode` / `question_set_version` | enum / text | Y | 세션 값 사본 | |
| `template_refs` | jsonb | Y | `[{template_key, version, compiled_hash}]`. 세션 값 사본. 승인 시 `novels.template_refs`와 첫 스키마 버전 `extension.template_refs`로 복사(MVP-β 03b·v1 03c, 11 M-15, 06 4.7) | FR-NOV-03 |
| `template_overrides` | jsonb | Y | [MVP-β/v1] 템플릿 기본값과 다른 사용자 답 `[{path, template_value, user_value, reason?, message_id}]`. `path`는 계획서 3.4 (j) `fills` 경로 문법(브리프 슬롯 `world_rules[item:…]`·`world_rules[note:…]`·`serial_plan.<field>`, 또는 템플릿 항목 `item:<template_key>/<component>/<key>[#<field>]`)을 그대로 씁니다. 런타임 조합 충돌 답(계획서 3.3)은 `item:<template_key>/schema_extension/<key>` 형식. 기본 빈 배열. 감시 지표 W-T3 입력(계획서 3.5 T3) | FR-NOV-03 "덮어쓰기" |
| `content` | jsonb | Y | 11 5.4 필드(`category`(`secondary_genre_key` 포함), `target`, `age_rating`, `logline`, `logline_options`, `premise`, `core_hook`, `differentiators`, `protagonist`, `opposition`, `stakes`, `main_characters`, `world_rules`, `tone`, `serial_plan`, `ending_direction`, `avoid_list`, `mood_references`, `title_candidates`, `keywords`, `seed_notes`, `source_documents`, `open_questions`, `field_provenance`, `contribution_summary`, `checks`). 인물(`protagonist`, `main_characters[]`)은 공통 인물 객체 `{character_key, name?, name_candidates[], aliases[], body_name?, persona_name?, age_band, age_note?}`(`character_key`는 브리프 안 유일·개정 버전 사이 유지, `age_band`는 enum `character_age_band`). `source_documents[]`=`{concept_message_id, chars, kind}`(붙여 넣기 원문 `import_text` 메시지 참조). `contribution_summary`=`{by_origin, filled_count}`(CS3 때 계산). `checks`=`{working_brief_hash, similarity: {blocklist_hits[], copy_requests[{work_title, quote, message_id, field_paths[]}], llm_overlap_signals[], trope_tags[]}, safety: {age_rating_flags[], minor_flags[], real_person_hits[]}, checked_by_run_id}` | FR-NOV-08 |
| `content_md` | text | Y | 사람용 렌더링 | |

불변식(정본 → 11 5.5, 여기서는 관계형 강제 방법만):

| ID | 내용 | 강제 |
|---|---|---|
| INV-CON-01 | 작품당 `status ∈ {active, awaiting_approval, paused}` 세션 최대 1개 | 부분 유일 인덱스 |
| INV-CON-02 | 작품당 `approved` 브리프 최대 1개 | 부분 유일 인덱스 |
| INV-CON-03·04 | 사용자 출처 필드는 사용자 근거로만 변경, `user_stated`는 근거 메시지 필수 | `concept.applySlotUpdates` 도메인 함수 |
| INV-CON-05 | 필수 필드가 모두 `confirmed`일 때만 CS3 | 전이 가드 |
| INV-CON-06 | `content.age_rating`은 INV-NOV-01을 따름 | zod + 전이 가드 |
| INV-CON-07 | 승인된 브리프 없으면 `planning` 진입·`plan_series_bible` 생성 없음 | 4.12 N3 가드, INV-NOV-05 |
| INV-CON-08 | `goal_id` NULL은 컨셉 작업 3종만 | `tasks` CHECK |
| INV-CON-09 | 세션 누적 비용(예약 포함) > 상한이면 실행 시작 안 함. 턴·추출은 상한 − `concept.check_reserve_usd`까지 | 04 8.1 예약 전 검사 |
| INV-CON-10 | `age_rating=age_15`(MVP 최대)이고 `checks.safety.age_rating_flags`가 있으면 CS3 거부(낮은 등급은 경고) | 전이 가드 |
| INV-CON-11 | `checks.similarity.copy_requests[]`의 고유명·고유 설정이 브리프에 남아 있으면 CS3 거부 | 전이 가드 |
| INV-CON-12 | 조건부 필수 (a) 브리프에 `age_band=unknown` 인물이 있거나, 미성년 인물 + 연애·성적 맥락(`minor_flags`)이면 CS3 거부 | 전이 가드 |
| INV-CON-13 | CS3 시점 `working_brief` 해시 = `checks.working_brief_hash` | 전이 가드(다르면 점검 재실행) |
| INV-CON-14 | 작품당 `approved_direction` 브리프 최대 1개 | 부분 유일 인덱스 |
| INV-CON-15 | 빙의 트로프 브리프에서 CQ-10b 원작 확인 답이 "실제 출간작"이면 CS3 거부(D-35). 해제는 원작을 작중 가상 소설로 고치는 것뿐 | 전이 가드 |

**`GenreTemplate` 참조 필드 요약**: 템플릿 자체는 설치 데이터(T-6)이고 테이블이 없습니다. 참조는 `concept_sessions.template_refs`, `concept_briefs.template_refs`·`template_overrides`, `novels.category`·`template_refs`, `ontology_schema_versions.extension.template_refs`·`compiled_hash`(→ 06 4.7), `glossary_terms.source_kind=template`(00 `glossary_source_kind` 등록, D-32 확정)뿐입니다. 키 형식은 `<key>@<semver>`(계획서 3.2), 컨셉 질문 기록은 `<template_key>@<ver>:<question_key>`(11 3.6)입니다.

---

## 4. 상태 기계

공통 규칙:
- 전이는 도메인 함수(`domain/<aggregate>.transition()`)로만 하고, 같은 트랜잭션에서 감사 로그를 씁니다(6절).
- **주체** 열: `user`, `agent:<role>`, `system:<component>`(→ 00 6.7).
- 표에 없는 전이는 거부합니다.
- `blocked`·`paused` 같은 표시는 상태가 아닙니다(화·작품·아크). 작업(`Task`)만 `blocked`를 상태로 둡니다(스케줄러가 직접 다루기 때문).

### 4.1 Episode (`episode_status`, FR-AGT-12)

| # | from | to | 트리거 | 주체 | 가드 | 감사 이벤트 |
|---|---|---|---|---|---|---|
| E1 | `planned` | `outlining` | `outline_episode` 작업 임대 획득 | `system:orchestrator` | 기획서 `approved`(INV-BIB-02); 아크 계획 승인(INV-ARC-02); 작품·아크·화 일시정지 아님; 예산 `hard_stopped` 아님 | `episode.status_changed` |
| E2 | `outlining` | `drafting` | 아웃라인 버전 저장 | `agent:planner` | 아웃라인에 떡밥 비트 배정 포함(`foreshadow_manager` 계획 반영) | `episode.status_changed`, `manuscript.version_created` |
| E3 | `drafting` | `checking` | 초고 버전 저장 | `agent:writer` | — | `episode.status_changed`, `manuscript.version_created` |
| E4 | `checking` | `drafting` | 검사 결과 재작성 필요(높음 이슈 또는 `missing` 비트). 검사 게이트 평가(→ 04 3.3, 07 5.3 GC-6) | `system:orchestrator` | `auto_rewrite_count < continuity.max_auto_rewrites_per_episode`; 전이 시 1 증가 | `episode.status_changed`, `continuity_issue.opened` |
| E5 | `checking` | `outlining` | 이슈가 아웃라인 수준 수정 필요(`fix_scope`에 `outline`, → 04 3.3, 07 5.3 GC-5) | `system:orchestrator` | E4와 같은 상한 | `episode.status_changed` |
| E6 | `checking` | `polishing` | 검사 통과 | `system:orchestrator` | 사실 추출·링킹 완료; 열린 `high` 이슈 0; `missing` 비트 0; 사실 추출 실패 아님 | `episode.status_changed` |
| E7 | `polishing` | `checking` | 다듬은 버전의 사실 diff가 비어 있지 않음 | `system:orchestrator` | `polish.recheck_on_fact_diff=true` | `episode.status_changed` |
| E8 | `polishing` | `awaiting_approval` | 최종 후보 버전 저장 | `agent:line_editor` | INV-EP-02; 분량 기준 이탈은 경고로 기록(차단 아님, FR-MAN-02) | `episode.status_changed`; `episode_approval`·`co_writing`이면 `approval.requested`, `question.created` |
| E9 | `awaiting_approval` | `approved` | (a) `episode` 승인 (b) 소속 아크의 `arc` 승인 (c) `full_auto`에서 자동 | (a)(b) `user` (c) `system:orchestrator`(주체는 에이전트로 기록, D-24) | (c)는 열린 `high` 이슈 0. 같은 트랜잭션에서 그 화 출처 `candidate` 사실·비트를 `approved`로(6.3.1 표) | `episode.approved`, `fact.status_changed`(일괄), `setup.beat_confirmed` |
| E10 | `awaiting_approval` | `revising` | `episode` 승인 반려 | `user` | `decision_note`와 `rework_from` 필수 | `episode.rejected` |
| E11 | `approved` | `revising` | 공개 전 사용자의 수정 요청(반려와 같은 입력) | `user` | `status=approved`(공개 전) | `episode.rejected` |
| E12 | `revising` | `outlining` / `drafting` / `polishing` | `plan_rework` 커밋(→ 04 3.3, 07 8.1), `rework_from`에 따라. 후속 작업은 `outline_episode` / `revise_episode` / `polish_episode` | `system:orchestrator` | `rejection_count < episode.max_rejections`. 상한이면 `rewrite_limit` 표시 + 방향 결정 차단형 질문(재기획 / 사람 직접 수정 / 보류) | `episode.status_changed` |
| E13 | `approved` | `published` | 공개 처리 | `user`, 또는 `publish_policy=scheduled`면 `system:publisher` | 같은 트랜잭션에서 그 화 출처 사실·비트 `approved → published_locked` | `episode.published`, `fact.status_changed`(일괄) |
| E14 | `published` | `approved` | 공개 취소(정정) | `user` | "외부 미공개" 확인과 사유 필수. 사실 `published_locked → approved` | `episode.unpublished` |
| E15 | `planned`/`outlining` | `checking` | [v1 `co_writing`] 사람 원고 제출 | `user` | `autonomy_level=co_writing` | `episode.status_changed`, `manuscript.version_created` |
| E16 | `outlining` / `drafting` / `polishing` / `awaiting_approval` / `approved` | `checking` | 사람 편집 저장(FR-MAN-07) | `user` | 사람 버전(`is_human_edit=true`) 저장; `approved`는 공개 전. 진행 중 실행은 안전 지점에서 정지(`run_stop_reason=superseded`)하고 작업 대체; `awaiting_approval`이면 열린 `episode` 승인을 A5로 닫음. `rejection_count` 유지, `auto_rewrite_count=0`. `checking` 중 편집은 상태 전이 없이 검사를 처음부터 다시 함(→ 07 7.3) | `episode.status_changed`, `manuscript.human_edited`, `manuscript.version_created`(`awaiting_approval`이면 `approval.superseded`) |

표시(상태 아님):
- `block_reasons` 추가·제거 → `episode.blocked` / `episode.unblocked`.
- 반려된 화는 재승인 전까지 비축분에서 빠집니다(`revising`은 비축분 계산 대상 아님).
- `arc_approval`에서 E9(b)는 그 아크의 모든 화가 `awaiting_approval`일 때 아크 승인 하나로 일괄 수행합니다. 그 전까지 후속 화 컨텍스트에는 해당 사실이 "미확정"으로 들어갑니다(6.3.1 표).

### 4.2 Task (`task_status`)

| # | from | to | 트리거 | 주체 | 가드 | 감사 이벤트 |
|---|---|---|---|---|---|---|
| T1 | (생성) | `pending` | 작업 생성 | `agent:showrunner` / `system:scheduler` / `user` | INV-TSK-01 | `task.created` |
| T2 | `pending` | `ready` | 선행 작업 모두 `done`, 대상 게이트 통과 | `system:scheduler` | — | `task.status_changed` |
| T3 | `ready` | `running` | 임대 획득(CAS) | `system:orchestrator` | INV-TSK-03, INV-TSK-05; 예산 예약 가능 | `task.lease_acquired` |
| T4 | `running` | `done` | 실행 성공 | `system:orchestrator` | 산출물 저장 완료 | `task.status_changed` |
| T5 | `running` | `ready` | 재시도 가능한 실패 | `system:orchestrator` | `attempt_count < max_attempts`; `not_before_at` 설정 | `task.status_changed` |
| T6 | `running` | `failed` | 재시도 상한 초과 | `system:orchestrator` | — (사람 조치 필요, 인박스 표시) | `task.status_changed` |
| T7 | `running` | `blocked` | 실행이 질문·승인을 만들고 종료, 또는 예산 차단, 공급자 장애 | `agent:<role>` / `system:budget_guard` | `block_reason`, `blocked_ref` 필수 | `task.blocked` |
| T8 | `ready` | `blocked` | 실행 전 예산 `hard_stopped`·예약 대기(`budget_reservation_wait`, 7.4절 1단계 (b))·공급자 장애 감지 | `system:budget_guard` / `system:health_check` | — | `task.blocked` |
| T9 | `blocked` | `ready` | 차단 원인 해소(답변 반영, 승인 결정, 예산 재개, 다른 예약 정산·해제, 연결 점검 통과) | `system:orchestrator` | 원인 객체 상태 확인 | `task.unblocked` |
| T10 | `running` | `ready` | 임대 만료 회수 | `system:orchestrator` | 이전 실행이 종료·부재임을 확인 후(`interrupted`) | `task.lease_reclaimed` |
| T11 | `pending`/`ready`/`blocked`/`failed` | `cancelled` | 사용자 취소, 대상 소멸, 다른 작업으로 대체 | `user` / `system:orchestrator` | 대체면 `superseded_by_task_id` | `task.cancelled` |
| T12 | `failed` | `ready` | 사용자 재시도 | `user` | `max_attempts` 1 증가 | `task.status_changed` |

일시정지는 상태가 아니라 `paused_at` 표시입니다. `running` 중 일시정지되면 실행은 안전 지점에서 멈추고(`run_stop_reason=paused`) 작업은 `ready`로 돌아가며 `paused_at`이 남아 있는 동안 임대를 주지 않습니다. 이벤트 `task.paused` / `task.resumed`.

같은 `running → ready` 복귀를 작업 재배정에도 씁니다. `running` 작업을 재배정하면(`tasks.input.reassign_to` 기록) 실행은 다음 안전 지점에서 `run_stop_reason=superseded`로 멈추고(R6), 작업은 새 `agent_role`로 바뀌어 `ready`로 돌아가며 `user_resume` 깨우기가 들어갑니다. 주체 `user`, 이벤트 `task.reassigned`(→ 04 2.2).

엔티티 분리로 실행이 대체될 때도 같은 `running → ready`를 씁니다. 분리된 엔티티를 참조하는 진행 중 실행은 `commit`에서 롤백하고 `run_stop_reason=superseded`로 끝나며(R6), 작업은 `attempt_count`를 유지한 채 `ready`로 돌아가고 `reclaim` 깨우기가 들어갑니다. 주체 `system:orchestrator`(→ 04 3.6 엔티티 분리 행, 06 3.11).

### 4.3 Run (`run_status`)

| # | from | to | 트리거 | 주체 | 가드 | 감사 이벤트 |
|---|---|---|---|---|---|---|
| R1 | (생성) | `queued` | 깨우기 요청 claim | `system:orchestrator` | `WakeRequest.status: pending → claimed` | `run.queued` |
| R2 | `queued` | `running` | 동시 실행 슬롯·예산 예약 확보, 작업 임대 획득(T3) | `system:orchestrator` | `run.max_concurrent_*` | `run.started` |
| R3 | `queued` | `cancelled` | 작업 취소·일시정지·임대 실패 | `system:orchestrator` | — | `run.finished` |
| R4 | `running` | `succeeded` | 정상 종료 | `system:orchestrator` | 미정산 예약 0 | `run.finished` |
| R5 | `running` | `failed` | 오류 종료 | `system:orchestrator` | `error_family` 필수 | `run.finished` |
| R6 | `running` | `cancelled` | 일시정지·사용자 취소(안전 지점) | `system:orchestrator` | `stop_reason ∈ {paused, cancelled_by_user, budget_blocked, awaiting_human, superseded}` | `run.finished` |
| R7 | `running` | `interrupted` | 임대 만료·프로세스 재시작 후 회수 | `system:orchestrator` | `heartbeat_at`이 `lease.ttl_seconds`보다 오래됨. `sent` 상태 호출은 `unknown`으로 닫음(7절) | `run.interrupted` |

종료 상태(`succeeded`, `failed`, `cancelled`, `interrupted`)는 바뀌지 않습니다. 회수 후 재실행은 새 `Run`이고 `rerun_of_run_id`로 연결합니다(FR-AGT-02 (4)).

### 4.4 Question (`question_status`)

| # | from | to | 트리거 | 주체 | 가드 | 감사 이벤트 |
|---|---|---|---|---|---|---|
| Q1 | (생성) | `pending` | 질문 생성과 등급 판정 | `agent:showrunner`(판정) | INV-Q-01, INV-Q-05; `grade_reason` 필수 | `question.created` |
| Q2 | `pending` | `open` | (a) 발송: 차단형 즉시, 비차단형 digest, 정보성 일일 요약. 웹 인박스 게시만 돼도 `open` (b) 사용자가 웹 인박스에서 "지금 답하기" | (a) `system:messenger` (b) `user` | (a) 방해금지(긴급 예외 제외)·일일 상한(비차단형만)·질문 일시정지 확인. 차단형은 상한 적용 안 함 (b) 방해금지·일일 상한·digest를 건너뛰고 바로 게시(→ 05 5.1) | `question.sent` |
| Q3 | `open` | `answered` | 첫 유효 답변 채택 | `user` | 허용 사용자; 질문이 `open`; 같은 트랜잭션에서 `accepted_answer_id` 설정, 다른 채널 발송은 `closed_elsewhere` 갱신 대상 | `question.answered` |
| Q4 | `open` | `defaulted` | 마감 경과 | `system:scheduler` | `grade=non_blocking`; INV-Q-04, INV-Q-06. `resolution_source`로 구분: `default_applied`(`default_action=apply`, 추천안 적용) / `deadline_hold`(`default_action=hold` 주제, 적용 없이 보류, 반영 기록 `not_applied`, → 05 4.3) | `question.defaulted` |
| Q5 | `open` | `answered` | [v1] 부재 위임 | `system:scheduler` | 부재 모드 위임 유형에 해당; INV-APR-03 | `question.answered`(`resolution_source=absence_delegated`) |
| Q6 | `answered` / `defaulted` | `resolved` | 반영 기록 완료 | `system:orchestrator` | INV-AR-02. 서술형이면 해석이 `confirmed`/`corrected`/`rejected` | `question.resolved`, `answer_reflection.recorded` |
| Q7 | `open` | `resolved` | 정보성 전달 완료 | `system:messenger` | `grade=informational`; `resolution_source=notice_only` | `question.resolved` |
| Q8 | `pending` / `open` | `cancelled` | 대상 작업 취소, 질문 무효, 같은 판별 질문 병합 | `system:orchestrator` / `user` | `cancelled_reason` 필수; 승인 질문이면 승인도 `cancelled` | `question.cancelled` |

- 차단형 질문이 마감을 넘기면 상태는 `open`으로 유지하고 리마인더만 보냅니다(`question.reminded`). 마감 경과 여부는 `deadline_at < now()`로 계산합니다.
- 닫힌 질문(`answered` 이후)에 온 답은 상태를 바꾸지 않고 `Answer.disposition=late`로 기록합니다(`question.late_answer_received`). 처리 → 05.

### 4.5 Approval (`approval_status`)

| # | from | to | 트리거 | 주체 | 가드 | 감사 이벤트 |
|---|---|---|---|---|---|---|
| A1 | (생성) | `pending` | 게이트 도달 | `agent:<role>` / `system:<component>` | INV-APR-01; 연결 질문을 같은 트랜잭션에서 생성 | `approval.requested` |
| A2 | `pending` | `approved` | 질문 답 "승인" | `user`(v1 위임은 `system:scheduler`) | INV-APR-03 | `approval.decided` |
| A3 | `pending` | `rejected` | 질문 답 "반려" | `user` | `decision_note` 필수; `episode`면 `rework_from` 필수 | `approval.decided` |
| A4 | `pending` | `cancelled` | 대상 소멸, 요청 취소 | `system:orchestrator` / `user` | 연결 질문 `cancelled` | `approval.cancelled` |
| A5 | `pending` | `superseded` | 같은 대상의 새 요청(예: 재작성 후 재승인 요청) | `system:orchestrator` | `superseded_by_id` 필수 | `approval.superseded` |

### 4.6 ContinuityIssue (`continuity_issue_status`)

| # | from | to | 트리거 | 주체 | 가드 | 감사 이벤트 |
|---|---|---|---|---|---|---|
| C1 | (생성) | `open` | 검사에서 검출 | `agent:continuity_editor` 등(`detector`) | INV-CI-01; `dedupe_key` 중복이면 새로 만들지 않고 기존 이슈에 연결 | `continuity_issue.opened` |
| C2 | `open` | `fixing` | 자동 수정 또는 재작성 작업 시작 | `system:orchestrator` | — | `continuity_issue.status_changed` |
| C3 | `fixing` | `resolved` | 새 버전 재검사에서 재현 안 됨 | `agent:continuity_editor` | `resolution_kind` 필수(`auto_fixed`면 `auto_fix_diff`) | `continuity_issue.resolved` |
| C4 | `fixing` | `open` | 재검사에서 재현 | `agent:continuity_editor` | 재작성 상한에 닿으면 차단형 질문 생성(`question_id`) | `continuity_issue.status_changed` |
| C5 | `open` | `resolved` | 사람 직접 수정 후 재검사 통과, 또는 캐논 변경·리트콘 승인 | `user` / `agent:continuity_editor` | `resolution_kind ∈ {human_edited, canon_updated, retconned}` | `continuity_issue.resolved` |
| C6 | `open` | `waived` | 의도된 설정으로 허용 | `user`(`medium`·`low`는 `agent:showrunner`도 가능, 기록) | INV-CI-03, INV-CI-04, INV-CI-05 | `continuity_issue.waived` |
| C7 | `open` | `false_positive` | 오탐 판정 | `user`(`medium`·`low`는 `agent:continuity_editor`도 가능) | INV-CI-03, INV-CI-05 | `continuity_issue.status_changed` |
| C8 | `open` / `fixing` | `superseded` | 대상 버전이 아웃라인부터 재작성돼 위치가 사라짐 | `system:orchestrator` | 새 버전 검사가 끝난 뒤 | `continuity_issue.status_changed` |

### 4.7 Setup: 서사 상태 × 캐논 상태

**서사 상태** (`setup_narrative_status`, FR-FOR-01)

| # | from | to | 트리거 | 주체 | 가드 | 감사 이벤트 |
|---|---|---|---|---|---|---|
| S1 | (생성) | `planned` | 아크 떡밥 배치 계획 | `agent:foreshadow_manager` | 비트 1개 이상 `planned` | `setup.created` |
| S2 | `planned` | `planted` | `plant` 비트 `confirmed` | `system:orchestrator`(화 확정 E9 트랜잭션) | 근거 씬 있음(INV-SU-01) | `setup.narrative_status_changed` |
| S3 | `planted` / `reinforced` | `reinforced` | `reinforce` 비트 `confirmed` | `system:orchestrator` | 같은 상태로의 전이도 비트 이력으로 기록 | `setup.narrative_status_changed` |
| S4 | `planted` / `reinforced` | `paid_off` | `payoff` 비트 `confirmed` | `system:orchestrator`(제안은 `agent:foreshadow_manager`) | 회수 씬이 설치 사실과 모순 없음(모순이면 `setup_contradiction` `high` 이슈). 확정 시점은 6.3.1 표 | `setup.narrative_status_changed`, `setup.beat_confirmed` |
| S5 | `planned` / `planted` / `reinforced` | `abandoned` | `setup_abandon` 승인 | `user` | INV-SU-02 | `setup.abandoned` |
| S6 | (기존 화 원고에서 검출) | `planted` | [v1] 의도하지 않은 떡밥 등록 승인 | `user` | FR-FOR-03 | `setup.created` |

`paid_off`, `abandoned`는 종료 상태입니다. 회수 화가 공개 취소(E14)돼도 서사 상태는 유지되고 비트의 캐논 상태만 `approved`로 돌아갑니다.

**캐논 상태** (`canon_status`, 떡밥 본체)

| # | from | to | 트리거 | 주체 | 가드 |
|---|---|---|---|---|---|
| SC1 | (생성) | `candidate` | 계획·검출 | `agent:foreshadow_manager` | — |
| SC2 | `candidate` | `approved` | `arc_plan` 승인(`full_auto`는 아크 계획 정보성 보고 시 자동) | `user` / `system:orchestrator` | 6.3.1 표 "아크 계획" |
| SC3 | `candidate` | `rejected` | 아크 계획에서 제외 | `user` / `agent:foreshadow_manager`(계획 수정) | — |
| SC4 | `approved` | `published_locked` | `plant` 비트가 있는 화 공개 처리(E13) | `user` / `system:publisher` | — |
| SC5 | `published_locked` | `approved` | 그 화 공개 취소(E14) | `user` | — |
| SC6 | `approved` / `published_locked` | `retracted` | 떡밥 자체를 철회(설정 변경) | `user` | `canon_change` 또는 `retcon` 승인 |

**두 축의 조합 제약**

| 서사 상태 | 허용 캐논 상태 |
|---|---|
| `planned` | `candidate`, `approved`, `rejected` |
| `planted`, `reinforced`, `paid_off` | `approved`, `published_locked` |
| `abandoned` | `approved`, `published_locked`, `retracted` |

`SetupBeat.canon_status`는 비트가 들어간 화를 따라갑니다: 검출 시 `candidate`, 화 확정(E9) 시 `approved`, 화 공개(E13) 시 `published_locked`.

### 4.8 Fact `canon_status`

내부 시간 축·질의는 → 06. 여기서는 상태 전이만 정합니다.

| # | from | to | 트리거 | 주체 | 가드 | 감사 이벤트 |
|---|---|---|---|---|---|---|
| F1 | (생성) | `candidate` | 사실 추출, 답변 해석, 링킹 판별 대기 | `agent:world_keeper` | 출처 필수; 엔티티 참조마다 `Mention` 연결(FR-ONT-14) | `fact.created` |
| F2 | (생성) | `approved` | 사람이 직접 추가, 확인된 답변 제약 | `user` / `agent:world_keeper`(해석 `confirmed` 후) | 출처 필수(FR-ONT-02); 서술형 답은 INV-AI-01 | `fact.created` |
| F3 | `candidate` | `approved` | 6.3.1 표 "신규 사실 추가" 시점(화 승인, 아크 승인, `full_auto` 검사 통과, 기획서 승인) | `user` / `system:orchestrator`(`full_auto`는 주체 에이전트로 기록) | 연결된 언급 중 `ambiguous`·`new_entity_candidate`가 없음(NFR-QUAL-01 "자동 캐논 0건"); 스키마 제약 위반 없음 | `fact.status_changed` |
| F4 | `candidate` | `rejected` | 사람 기각, 재작성으로 근거 소멸 | `user` / `agent:world_keeper` | — | `fact.status_changed` |
| F5 | `approved` | `published_locked` | 근거 화 공개 처리(E13) | `user` / `system:publisher` | — | `fact.status_changed` |
| F6 | `published_locked` | `approved` | 근거 화 공개 취소(E14) | `user` | — | `fact.status_changed` |
| F7 | `approved` | `approved` (새 버전) | 기존 캐논 내용 변경 | `user` | `canon_change` 승인. 예외: 동일성 결정이 주어·목적어 ID만 옮기는 새 버전(`change_reason ∈ {identity_merge, identity_split, identity_relink, identity_revert}`)은 판별·중복 답변으로 갈음하고 `canon_change`를 받지 않음(→ 06 3.11 승인 규칙). `published_locked` 영향은 `identity_change` 승인 | `fact.version_created` |
| F8 | `published_locked` | `published_locked` (새 버전) | 리트콘 | `user` | `retcon` 승인 | `fact.retconned` |
| F9 | `approved` / `published_locked` | `retracted` | 캐논 철회 | `user` | `canon_change`(`approved`) / `retcon`(`published_locked`) 승인 | `fact.status_changed` |
| F10 | 임의 | 이전 버전 내용 | 되돌리기(FR-ONT-09) | `user` | 새 버전으로 추가; `published_locked`는 `retcon` 승인 | `fact.reverted` |
| F11 | `approved` / `published_locked` | 같은 상태 (새 버전) | 범위 닫기 `range_close`: 단일값 슬롯의 새 사실(승계·사망·이동 등)이 승격될 때 이전 사실의 열린 상한 `[a,∞)`를 `[a,b)`로 닫음 | `system:orchestrator`(원인 사실과 같은 E9 승격 트랜잭션) | 승인 없음. 조건: 값·주어·목적어 불변 ∧ `b` > 그 사실 근거 중 공개 화 언급의 최대 `story_point` ∧ 원인 사실이 같은 단위에서 승격됨. 조건 밖(공개 구간을 잘라냄, 닫힌 상한 이동)은 F7(`approved`)·F8(`published_locked`). `change_reason=range_close`(→ 06 6.2) | `fact.version_created` |

`approved` 이상 사실을 에이전트가 승인 없이 바꾸는 경로는 없습니다(FR-HIL-04, 6.3.1 표). F11은 내용을 바꾸지 않고 승인된 화의 승격에 딸린 시간 경계 추가라서 예외로 둡니다.

### 4.9 Shot (`shot_status`) [v1/v2]

| # | from | to | 트리거 | 주체 | 가드 | 감사 이벤트 |
|---|---|---|---|---|---|---|
| SH1 | (생성) | `draft` | 씬 샷 분할 | `agent:scene_director` | 대상 화가 `media_target_basis` 충족 | `shot.created` |
| SH2 | `draft` | `ir_ready` | IR 생성·안전 분류 완료 | `agent:scene_director` | `safety_risk ≠ blocked`; 시각 속성 출처 100% | `shot.status_changed` |
| SH3 | `draft` / `ir_ready` | `blocked` | 안전 위험(`review_required`) 또는 필터 차단 반복 | `agent:scene_director` / `agent:visual_producer` | `blocked_question_id` 필수 | `shot.status_changed` |
| SH4 | `blocked` | `ir_ready` | 순화안·수위 조정 승인 | `user` | 새 IR 버전 | `shot.status_changed` |
| SH5 | `ir_ready` | `keyframe_adopted` | 최종(`final`) 키프레임 채택 | `user` / `agent:visual_producer`(`quote_only`의 자동 채택, 기록) | 견적 `approved` | `shot.status_changed`, `media_asset.adopted` |
| SH6 | `keyframe_adopted` | `clip_adopted` | [v2] 클립 채택 | `user` / `agent:visual_producer` | 영상 견적 `approved` | `shot.status_changed` |
| SH7 | 종료 전 임의 | `skipped` | 생략 결정 | `user` | `skip_reason` 필수 | `shot.status_changed` |
| SH8 | `keyframe_adopted` / `clip_adopted` | `ir_ready` | 원고·캐논 변경 후 사용자가 재생성 선택 | `user` | `stale_since` 있음 | `shot.status_changed` |

"갱신 필요"는 `stale_since` 표시입니다(FR-SPX-07). 설정만 하고 상태는 바꾸지 않습니다.

### 4.10 MediaAsset (`media_asset_status`) [v1/v2]

| # | from | to | 트리거 | 주체 | 가드 | 감사 이벤트 |
|---|---|---|---|---|---|---|
| M1 | (생성) | `requested` | 생성 작업 예약 | `agent:visual_producer` | 견적 `approved`(FR-BUD-06a/b); 고해상도는 초안 채택 후(FR-IMG-02) | `media_asset.requested` |
| M2 | `requested` | `generating` | 공급자 호출 발송 | `system:orchestrator` | 예산 예약 | `media_asset.status_changed` |
| M3 | `generating` | `generated` | 결과 내려받아 저장 완료 | `system:orchestrator` | 출처 기록·AI 메타데이터 삽입 완료(FR-IMG-04, 06) | `media_asset.generated` |
| M4 | `generating` | `filtered` | 공급자 필터 차단 | `system:orchestrator` | `filter_reason` 필수; 비용 기록 | `media_asset.filtered` |
| M5 | `generating` | `failed` | 오류 | `system:orchestrator` | `failure_reason` 필수 | `media_asset.status_changed` |
| M6 | `generated` | `adopted` | 채택 | `user` / `agent:visual_producer`(`quote_only` 초안 자동 채택, `is_auto_adopted=true`) | 캐릭터 시트는 항상 사람(FR-VIS-02) | `media_asset.adopted` |
| M7 | `generated` | `rejected` | 비채택 | `user` / `agent:visual_producer` | — | `media_asset.status_changed` |
| M8 | `adopted` | `retired` | 새 에셋으로 대체 | `user` / `system:orchestrator` | 대체 에셋 `adopted` | `media_asset.status_changed` |

`filtered`·`failed`가 `media.max_generation_retries`에 닿으면 순화·이미지 대체·생략 질문을 만듭니다(FR-IMG-05).

### 4.11 그 밖의 상태 (요약)

| 대상 | enum | 전이 소유 문서 |
|---|---|---|
| `SeriesBible` | `series_bible_status`: `draft → awaiting_approval → approved → superseded`, 반려 시 `awaiting_approval → draft`. 컨셉 개정 승인(11 3.10) 시 `draft`·`awaiting_approval` 행은 `superseded` | 이 문서(이벤트 `series_bible.*`) |
| `ConceptSession`, `ConceptBrief` | `concept_session_status`, `concept_brief_status` | → 11 5.2·5.4 (사본 4.13) |
| `Arc` | `arc_status`: `planned → plan_awaiting_approval → active → (awaiting_approval) → completed`, 어디서나 `cancelled` | 이 문서 |
| `Channel`, `MessengerInbox`, `MessengerOutbox`, `ChannelBindingToken`, `DigestBatch`, `QuestionDelivery` | 6.4·6.5절 enum | → 05 |
| `Answer.disposition`, `AnswerInterpretation`, `AnswerReflection` | 6.4절 enum | → 05 |
| `AnswerSession` | `answer_session_status`: `active → completed / expired / cancelled` | → 05 6.3 |
| `WakeRequest`, `ProviderCall` | 6.3절 enum | → 04 |
| `BudgetPolicy.status`, `BudgetReservation` | 6.6절 enum | 7절 |
| `Entity`, `EntityName`, `Mention.link_status`, `IdentityDecision`, `SchemaChangeProposal`, `GlossaryTerm` | 6.10절 enum | → 06 |
| `SetupBeat` | `setup_beat_status`: `planned → detected → confirmed`, `planned → missing → detected`(재작성 후), `detected → planned`(재작성으로 근거 씬이 바뀌어 재검사 대상, 근거 필드 비움), `planned / missing → cancelled` | → 07 5.2 (떡밥 검사) |
| `MediaQuote`, `VisualReference` | 6.11절 enum | → 07 |

### 4.12 Novel (`novel_status`) 컨셉 구간

이번 개정은 컨셉 구간(N1~N3)만 정합니다. `planning → serializing → completed`, `archived` 전이는 아직 표로 정의되지 않았습니다(9절 미결). 근거: 11 5.8. `concept`은 `onboarding` 앞의 별도 상태로 확정입니다(PRD D-39, 11 O-C2).

| # | from | to | 트리거 | 주체 | 가드·같은 트랜잭션 | 감사 이벤트 |
|---|---|---|---|---|---|---|
| N1 | (생성) | `concept` | 작품 생성 | `user` | `ConceptSession`(CS1, `entry_mode` = 사용자가 고른 경로), 웹 채널(INV-CH-01), `BudgetPolicy` 기본값, 전 역할 `RoleModelBinding`(INV-NOV-06). `Goal` 없음 | `novel.created` |
| N2 | `concept` | `onboarding` | 첫 `ConceptBrief` 승인(CS4, `purpose=initial`) | `user` | INV-CON-02. 같은 트랜잭션에서 11 M-01~M-05(`title`, `genre`, `age_rating`, `target_audience`, `default_narration_mode`), `approved_concept_brief_id`, `category` 사본. MVP-β(FR-NOV-03b)·v1(FR-NOV-03c): 장르 템플릿을 쓰면 첫 스키마 버전 발행(M-15, 06 4.7 TA-4) | `novel.status_changed`, `novel.settings_changed` |
| N3 | `onboarding` | `planning` | 목표 폼 저장(`Goal` 생성) | `user` | INV-CON-07. 같은 트랜잭션에서 `plan_series_bible`(`input.concept_brief_id`, 11 M-09) 생성. 기존 "작품 생성 시 `system:scheduler`가 만든다"(04 2.2)를 대체 | `novel.status_changed`, `goal.updated`, `task.created` |

컨셉 개정(`purpose=revision`) 승인은 `novel_status`를 바꾸지 않습니다. 처리는 기획서 승인 여부로 나뉩니다(11 3.10, 5.8). **기획서 승인 전 개정**(CB2): 같은 트랜잭션에서 이전 버전 CB5, `approved_concept_brief_id` 이동, M-01~M-05·M-01a를 다시 적용합니다(캐논이 아직 없고, 적용하지 않으면 장르를 바꾼 뒤에도 `novels.genre`가 옛 값으로 남음). 진행 중 기획서는 대체합니다. **기획서 승인 후 개정**(CB6, MVP-β): 브리프는 `approved_direction`이 되고, CB6 트랜잭션에서는 `novels`·`approved_concept_brief_id`·캐논에 아무것도 옮기지 않습니다. 기획서 개정 `series_bible` 승인 트랜잭션의 CB7에서 이전 버전 CB5, M-01~M-05, `approved_concept_brief_id` 이동을 합니다. 기획서 개정이 반려되거나 취소되면 CB8.

### 4.13 ConceptSession·ConceptBrief (사본, 전이 소유 → 11)

11 5.2·5.4 표의 사본입니다. 바꿀 때는 11을 먼저 고치고 이 표를 맞춥니다.

| # | 대상 | from | to | 트리거 | 주체 | 가드 |
|---|---|---|---|---|---|---|
| CS1 | 세션 | (생성) | `active` | 작품 생성(N1) 또는 "컨셉 고치기" | `user` | INV-CON-01, `revision`이면 `base_brief_id` = 승인 버전 |
| CS2 | 세션 | `active` | `active` | 단계 이동(`stage`) | `system:orchestrator` / `user` | 11 3.2 조건, `confirming` 진입은 사용자 선택만 |
| CS3 | 세션 | `active` | `awaiting_approval` | 사용자 "승인 요청" 뒤 점검 완료 | `user`(결정적 코드 `concept.submitBriefForApproval`, `author_actor_type=user`. LLM 출력은 이 경로에 들어가지 않음) | INV-CON-05, INV-CON-10~13·15(`check_concept_brief` 완료·차단 항목 없음·해시 일치). 같은 트랜잭션 CB1 + `Approval`(A1, `concept_brief`) + 질문 |
| CS4 | 세션 | `awaiting_approval` | `approved` | A2 승인 | `user` | INV-APR-02와 같은 트랜잭션. `initial`이면 N2 |
| CS5 | 세션 | `awaiting_approval` | `active` | A3 반려 | `user` | `decision_note`를 시스템 메시지로, `stage=converging` |
| CS6 | 세션 | `active` | `paused` | "나중에" / 휴면 / 세션 비용 상한 | `user` / `system:scheduler` / `system:budget_guard` | `pause_reason` 필수 |
| CS7 | 세션 | `paused` | `active` | `user`·`idle`: 사용자 메시지·이어 하기. `budget_limit`: 상한 상향(웹) 또는 [폼으로 마저 입력](메시지로는 재개 안 함) | `user` | `budget_limit`이면 상한 > 누적 + `concept.check_reserve_usd`, 또는 폼 전환(`llm_disabled=true`, `concept_session.entry_mode_changed`) |
| CS8 | 세션 | `active`·`paused`·`awaiting_approval` | `abandoned` | "처음부터 다시", 작품 보관 | `user` | `awaiting_approval`이면 A4 `cancelled` |
| CS9 | 세션 | `awaiting_approval` | `active` | 사용자가 대화를 이어 감 | `user` | A4 `cancelled`, CB4 |
| CB1 | 브리프 | (생성) | `awaiting_approval` | CS3 | — | 같은 작품 `awaiting_approval` 브리프 0개 |
| CB2 | 브리프 | `awaiting_approval` | `approved` | A2, 작품에 승인된 `SeriesBible` 없음 | `user` | 이전 `approved`는 같은 트랜잭션 CB5 |
| CB3 | 브리프 | `awaiting_approval` | `rejected` | A3 | `user` | — |
| CB4 | 브리프 | `awaiting_approval` | `rejected` | CS8·CS9 | `user` | `decision_note`="사용자가 대화를 이어 감" |
| CB5 | 브리프 | `approved` | `superseded` | 새 버전 CB2 또는 CB7 | `user` | — |
| CB6 | 브리프 | `awaiting_approval` | `approved_direction` | A2, 작품에 승인된 `SeriesBible` 있음(MVP-β) | `user` | INV-CON-14. 이전 `approved` 유지. 같은 트랜잭션에서 기획서 개정 작업 생성 |
| CB7 | 브리프 | `approved_direction` | `approved` | 기획서 개정 `series_bible` 승인(A2) | `user` | 같은 트랜잭션 이전 `approved` CB5, M-01~M-05, `approved_concept_brief_id` 이동 |
| CB8 | 브리프 | `approved_direction` | `rejected` | 기획서 개정 반려(A3)로 개정 종료 또는 사용자 개정 취소 | `user` | `decision_note`에 사유. 이전 `approved` 유지 |

---

## 5. 온톨로지 경계 (상세 → 06)

### 5.1 관계형 쪽에서 쓰는 온톨로지 ID

| 관계형 필드 | 참조 대상 | 규칙 |
|---|---|---|
| `scenes.location_entity_id`, `scenes.pov_entity_id`, `scene_participants.entity_id`, `episode_recaps.pov_entity_id` | `Entity` | 엔티티 ID만(FR-ONT-12) |
| `scenes.timeline_id`, `episodes.primary_timeline_id`, `context_snapshots.timeline_id` | `Timeline` | |
| `setup_links.ref_id`, `setup_links.pinned_fact_version_id` | `Entity`, `Fact` / `FactVersion` | 고정 버전은 회수 대조 기준(→ 06 8절) |
| `continuity_issue_evidence.fact_version_id` | `FactVersion` | 근거는 버전 단위(나중에 사실이 바뀌어도 당시 근거 보존) |
| `context_snapshots.fact_version_ids`, `entity_name_ids` | `FactVersion`, `EntityName` | |
| `question_links.ref_id` (`ref_type ∈ {entity, fact, mention, identity_decision, schema_proposal}`) | 온톨로지 노드 | FR-MSG-01 |
| `answer_reflection_items.ref_id` | `Fact`, `EntityName` 등 | FR-MSG-09 |
| `scene_prompt_irs.field_sources`, `visual_references.entity_id`, `media_assets.entity_id` | `FactVersion`, `Entity` | FR-SPX-03, FR-VIS-01 |
| `novels.active_schema_version_id` | `OntologySchemaVersion` | |

규칙:
- 관계형 모듈은 온톨로지 테이블에 직접 쓰지 않습니다. `ontology`·`linking` 모듈의 application API를 같은 트랜잭션 안에서 호출합니다(ADR-008).
- 엔티티가 병합되면(`entity_status=merged`) 관계형 쪽 참조는 병합 트랜잭션에서 새 ID로 옮기고, 옮긴 목록을 `IdentityDecision`에 남깁니다. 옛 ID로 조회하면 `merged_into_id`를 따라 안내합니다(FR-ONT-16).
- 화 상태 전이(E9, E13, E14)가 사실·비트의 캐논 상태를 함께 바꿉니다. 호출 API: `ontology.promoteEpisodeFacts(tx, scope, episode_id, to_status)`(→ 06 6.4). 같은 트랜잭션에서 F11 `range_close`를 슬롯 쓰기보다 먼저 실행합니다.

### 5.2 핵심 필드 (00 레지스트리와 일치시킬 부분만)

| 엔티티 | 핵심 필드 | enum | 불변식(요약) |
|---|---|---|---|
| `Entity` (`entities`) | `entity_type`(스키마 키), `status`, `preferred_name_id`, `merged_into_id`, `confusable_with_ids`, `disambiguator`, `created_from_mention_id`, `equivalence_check`(EN3(b) 동치 판정 결과), `is_real_person`(bool, 기본 false, `character`만, 실존 인물 표시, → 06 2.4·O-19, 07 5.6 SF-3), `concept_character_key`(text, N, `character`만. B2가 컨셉 브리프 인물 객체에서 만든 엔티티의 `character_key`. 작품 안 `active` 엔티티 사이 유일. 개정 때 같은 키의 이름이 바뀌면 새 엔티티가 아니라 `EntityName` 추가 또는 `identity_change`, → 06 3.14, 11 M-11), `summary`(재생성 가능) | `entity_status` | 대표명 1개(`is_preferred=true`); `merged`면 `merged_into_id` 필수; ID 불변·삭제 없음 |
| `EntityName` (`entity_names`) | `entity_id`, `surface`, `normalized_key`, `jamo_key`, `translit_key`, `name_kind`, `is_preferred`, `status`, `story_range`, `timeline_id`(NULL=전 시간선), `surface_visibility`·`surface_known_by_entity_ids`(표기를 쓸 수 있는 범위), `identity_visibility`·`identity_known_by_entity_ids`(표기와 정체의 연결을 아는 범위), `used_by_condition`, `reader_reveal_point`, `origin_entity_id`, `forbidden_by_glossary_term_id`, `merged_conflict_with_id`, 출처 | `name_kind`, `name_visibility`, `entity_name_status` | 같은 `surface`를 여러 엔티티가 가질 수 있음(FR-ONT-13); 한 엔티티의 `is_preferred` 1개 |
| `Mention` (`mentions`) | `source_kind`, 위치(`manuscript_version_id`·`scene_id`·`char_start`·`char_end` 또는 `answer_id`), `surface`(`zero`면 빈 문자열), `mention_kind`, `speaker_entity_id`, `pov_entity_id`, `candidates`, `linked_entity_id`, `redirected_from_entity_id`(병합 중 쓰기로 바뀐 원래 ID), `narrative_frame_id`, `chain_key`, `via_name_id`, `via_entity_id`, `confidence`, `rationale`, `link_status`, `linker_version`, `question_id`, `run_id` | `mention_kind`, `mention_source_kind`, `link_status` | `auto_linked`·`confirmed`면 `linked_entity_id` 필수; `ambiguous` 언급에서 나온 사실은 자동으로 캐논이 되지 않음(F3 가드) |
| `Fact` (`facts`) / `FactVersion` (`fact_versions`) | `fact_kind`, `subject_entity_id`, `predicate`(스키마 키), `object_entity_id`/`value`, `timeline_id`, `story_range`, `canon_status`, `current_version_no`, `source_kind`, 출처 참조, `source_scene_id`, `mention_ids`, `observed_as_name_id`(컨텍스트 카드 배정), `narrative_frame_id`, `slot_key`, `is_negation`, `is_secret`, `reader_reveal_point`, `schema_version_id` / 버전: `version_no`, 내용 스냅숏, `canon_status`, `recorded_at`, `superseded_at`, `recorded_by_actor_*`, `change_reason`, `approval_id` | `fact_kind`, `fact_source_kind`, `canon_status`, `knowledge_stance`(지식 사실) | 출처 없으면 `approved` 불가(FR-ONT-02); 스키마 밖 `predicate` 저장 불가(FR-ONT-18) |
| `Timeline` (`timelines`) | `kind`, `label`, `parent_timeline_id`, `branch_story_point`, `rewind_to_story_point`(`regression`·`loop`면 필수), `is_default` | `timeline_kind` | 작품당 `is_default` 1개 |
| `NarrativeFrame` (`narrative_frames`) | `scene_id`, `manuscript_version_id`, `char_start`/`char_end`, `frame_kind`, `target_story_point`, `target_timeline_id`, `source_kind`, `run_id` | `narrative_frame_kind`(00 6.10) | 프레임 안 언급·사실의 시점·시간선은 프레임 대상 값; `target_story_point` NULL이면 그 사실은 승격하지 않음; `dream`은 캐논 사실을 만들지 않음 |
| `OntologySchemaVersion`, `SchemaChangeProposal`, `GlossaryTerm`, `IdentityDecision`(`identity_decision_moves`, `entity_distinct_pairs` 포함), `FactCardinalitySlot` | → 06 | `schema_change_kind`, `schema_change_status`, `glossary_term_status`, `identity_decision_kind`(`relink` 포함, 00 6.10), `identity_decision_status` | → 06 |

---

## 6. 감사 로그와 주체 모델

### 6.1 주체 모델

| `actor_type` | `actor_id` 형식 | 예 | 비고 |
|---|---|---|---|
| `user` | `usr_<ULID>` | `usr_01J…` | 메신저 답변도 바인딩된 사용자로 기록하고 `channel_id`를 함께 남김 |
| `agent` | `<agent_role>` | `continuity_editor` | `run_id` 필수. 모델 ID는 실행 기록에서 조회 |
| `system` | `<system_component>` | `publisher` | 예약 공개, 일괄 승격 등 |

`full_auto`의 자동 확정(E9(c), F3)은 `actor_type=agent`, `actor_id=showrunner`로 기록합니다(6.3.1 표 "주체는 에이전트로 기록").

### 6.2 `ActivityLog` (`activity_log`)

| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `seq` | bigint | Y | 단조 증가, 실시간 이벤트 ID(ADR-017) | |
| `id` | id(act) | Y | | |
| `novel_id` | id(nov) | N | 설치 단위 이벤트는 NULL | |
| `occurred_at` | ts | Y | | |
| `actor_type` / `actor_id` | enum:actor_type / text | Y | | NFR-OBS-01 |
| `run_id` | id(run) | C | `agent`면 필수 | NFR-OBS-01 |
| `question_id` / `approval_id` / `answer_id` | id | N | 관련 질문·승인·답변 | NFR-OBS-01 |
| `action` | text | Y | 6.3절 이름 | |
| `target_type` / `target_id` | enum:ref_type / text | Y | 대상 | FR-UI-07 |
| `before` / `after` | jsonb | N | 변경 전후 값(redaction 후) | NFR-OBS-01 |
| `reason` | text | N | 근거 서술 | NFR-OBS-01 |
| `details` | jsonb | N | 추가 정보(일괄 변경 ID 목록 등) | |

규칙:
- 상태 변경 트랜잭션 안에서 씁니다. 커밋 후 실시간 발행합니다(ADR-017).
- 비밀(API 키, 봇 토큰, 바인딩 토큰 원문)은 `before`/`after`/`details`에서 가립니다(NFR-SEC-02).
- append-only입니다. 수정·삭제 경로가 없습니다(작품 삭제 T-7 제외).
- 대량 이벤트(언급 자동 연결, 사실 일괄 승격)는 실행·트랜잭션당 1행으로 묶고 `details`에 ID 목록과 건수를 둡니다.
- 사람 기여 리포트(FR-HIL-05, v1)는 이 표와 `manuscript_versions.attribution_spans`로 재현합니다(NFR-OBS-03).
- 색인: 기본 색인 외에 대상별 이력 `(novel_id, target_type, target_id, seq)`, 주체별 이력 `(novel_id, actor_type, actor_id, seq)`을 둡니다(FR-UI-07 활동 화면, → 08 9.7).

### 6.3 이벤트 이름 목록

주체 열은 일반적인 주체입니다(다른 주체도 가능하면 함께 적음).

| 영역 | `action` | 대상 | 주된 주체 |
|---|---|---|---|
| 작품 | `novel.created`, `novel.settings_changed`, `novel.autonomy_changed`, `novel.paused`, `novel.resumed`, `novel.status_changed`, `novel.deleted` | `novel` | user (`paused`는 system:budget_guard·health_check도) |
| 목표 | `goal.updated` | `goal` | user |
| 컨셉 세션 | `concept_session.created`, `concept_session.status_changed`, `concept_session.stage_changed`, `concept_session.paused`, `concept_session.resumed`, `concept_session.limit_extended`, `concept_session.entry_mode_changed` | `concept_session` | user, agent:concept_partner, system:scheduler·budget_guard |
| 컨셉 브리프 | `concept_brief.version_created`, `concept_brief.status_changed`, `concept_brief.field_edited`(필드 경로와 짧은 전후 값), `concept_brief.change_proposal_decided` | `concept_brief` | user, agent:concept_partner |
| 기획서 | `series_bible.version_created`, `series_bible.status_changed` | `series_bible` | agent:planner, user |
| 아크 | `arc.created`, `arc.status_changed`, `arc.paused`, `arc.resumed` | `arc` | agent:showrunner, user |
| 화 | `episode.created`, `episode.status_changed`, `episode.rejected`, `episode.approved`, `episode.published`, `episode.unpublished`, `episode.blocked`, `episode.unblocked`, `episode.paused`, `episode.resumed` | `episode` | agent, user, system |
| 원고 | `manuscript.version_created`, `manuscript.human_edited`, `scene.resegmented` | `manuscript_version`, `scene` | agent, user |
| 작업 | `task.created`, `task.status_changed`, `task.lease_acquired`, `task.lease_reclaimed`, `task.blocked`, `task.unblocked`, `task.paused`, `task.resumed`, `task.cancelled`, `task.reassigned` | `task` | system:orchestrator, user |
| 실행 | `run.queued`, `run.started`, `run.finished`, `run.interrupted` | `run` | system:orchestrator |
| 질문 | `question.created`, `question.sent`, `question.reminded`, `question.answered`, `question.defaulted`, `question.resolved`, `question.cancelled`, `question.late_answer_received`, `question.late_answer_resolved` | `question` | agent:showrunner, system:messenger, user |
| 답변 | `answer.interpreted`, `answer.interpretation_decided`, `answer_reflection.recorded`, `answer_reflection.notified` | `answer`, `question` | agent:world_keeper, system |
| 승인 | `approval.requested`, `approval.decided`, `approval.cancelled`, `approval.superseded` | `approval` | agent, user |
| 채널 | `channel.binding_issued`, `channel.bound`, `channel.unbound`, `channel.health_changed`, `channel.unauthorized_input`, `channel.command_received` | `channel` | user, system:messenger, system:health_check |
| 예산·비용 | `budget.policy_changed`, `budget.warning_reached`, `budget.hard_stop_reached`, `budget.resumed`, `cost.overrun_recorded`, `cost.unknown_recorded`, `cost.restored_carryover`(복원 이월 정정, 작품마다 이월 합계·원본 행 수, → 02 8.4) | `budget_policy`, `cost_event` | user, system:budget_guard |
| 사실 | `fact.created`, `fact.status_changed`, `fact.version_created`, `fact.retconned`, `fact.reverted` | `fact` | agent:world_keeper, user, system |
| 엔티티 | `entity.created`, `entity.status_changed`, `entity.preferred_name_changed`, `entity_name.added`, `entity_name.updated`, `entity_name.retired` | `entity`, `entity_name` | agent:world_keeper, user |
| 언급 | `mention.batch_linked`, `mention.link_decided`, `mention.relinked` | `mention` | agent(링커), user |
| 동일성 | `identity.proposed`, `identity.applied`, `identity.rejected`, `identity.reverted` | `identity_decision` | agent:world_keeper, user |
| 스키마·용어집 | `schema.change_proposed`, `schema.change_decided`, `schema.version_published`, `glossary.term_created`, `glossary.term_updated` | `schema_proposal`, `glossary_term` | agent, user |
| 시간선 | `timeline.created`, `timeline.updated` | `timeline` | agent:world_keeper, user |
| 떡밥 | `setup.created`, `setup.narrative_status_changed`, `setup.canon_status_changed`, `setup.due_changed`, `setup.beat_planned`, `setup.beat_detected`, `setup.beat_missing`, `setup.beat_confirmed`, `setup.abandoned` | `setup`, `setup_beat` | agent:foreshadow_manager, user, system |
| 연속성 | `continuity_issue.opened`, `continuity_issue.status_changed`, `continuity_issue.resolved`, `continuity_issue.waived` | `continuity_issue` | agent:continuity_editor, user |
| 설정·운영 | `settings.changed`, `secret.set`, `provider_profile.changed`, `model_binding.changed`, `backup.completed`, `backup.failed`, `backup.restored`, `system.migration_applied`, `system.health_check_failed`, `export.created` | `settings`, `novel` | user, system |
| 미디어 [v1/v2] | `shot.created`, `shot.status_changed`, `scene_prompt_ir.version_created`, `rendered_prompt.edited`, `media_quote.created`, `media_quote.decided`, `media_asset.requested`, `media_asset.status_changed`, `media_asset.generated`, `media_asset.filtered`, `media_asset.adopted`, `visual_reference.status_changed` | 미디어 대상 | agent:scene_director, agent:visual_producer, user |

### 6.4 작성 주체 기록 (D-4)

| 기록 | 위치 | 용도 |
|---|---|---|
| 버전 단위 작성 주체 | `manuscript_versions.author_actor_*`, `agent_role`, `model_id`, `run_id` | FR-MAN-01 |
| 구간 단위 작성 주체 | `manuscript_versions.attribution_spans` (이전 버전의 구간을 diff로 이어받고 바뀐 구간만 새 주체) | FR-MAN-01 줄 단위 구분, FR-HIL-05 |
| 사람 결정 | `approvals.decided_by_user_id`, `answers.responder_user_id`, `activity_log`(actor=user) | FR-HIL-05, G-7 |
| 사실·기획서 작성 주체 | `fact_versions.recorded_by_actor_*`, `series_bibles.author_actor_*` | FR-ONT-09 |
| 대체 모델 표시 | `manuscript_versions.is_fallback_model` | FR-AGT-11 |

MVP부터 모두 기록하고, 리포트 내보내기만 v1입니다(D-4, D-20).

---

## 7. 비용: 예산·예약·원장

### 7.1 `BudgetPolicy` (`budget_policies`)

| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `category` | enum:budget_category | Y | `all`은 기능 합계 | FR-BUD-02 |
| `budget_window` | enum:budget_window | Y | 컬럼명은 SQL 예약어 `window`를 피해 enum 이름과 같게 둠 | FR-BUD-02 |
| `hard_limit_micros` | micros | Y | 0이면 그 기능 실행 불가 | FR-BUD-02 |
| `soft_warn_ratio` | numeric(3,2) | Y | | FR-BUD-02 |
| `hard_stop_enabled` | bool | Y | 기본 true | FR-BUD-02 |
| `unpriced_usage_policy` | enum:unpriced_usage_policy | Y | | FR-BUD-03 |
| `status` | enum:budget_status | Y | 현재 창 기준 | |
| `window_started_at` | ts | Y | 현재 창 시작 | |
| `resume_approval_id` | id(apr) | N | `hard_stopped`에서 재개 승인 | 6.3.1 표 |

`(novel_id, category, budget_window)` 유일. 기본 행은 00 7.1절 값으로 작품 생성 시 만듭니다.

### 7.2 `BudgetReservation` (`budget_reservations`)

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `run_id` | id(run) | Y | |
| `provider_call_id` | id(pcl) | N | 호출 준비 시 연결 |
| `category` | enum:cost_category | Y | |
| `amount_micros` | micros | Y | 상한: LLM은 입력 토큰 × 단가 + `max_output_tokens` × 단가, 미디어는 공급자 최대 과금(FR-BUD-03) |
| `status` | enum:reservation_status | Y | |
| `settled_cost_event_id` | id(cst) | N | |
| `settled_at` | ts | N | |

### 7.3 `CostEvent` (`cost_events`, append-only)

| 필드 | 타입 | 필수 | 설명 | 관련 |
|---|---|---|---|---|
| `idempotency_key` | text | Y | `(novel_id, idempotency_key)` 유일. `pcl:<provider_call_id>` 또는 정정 키(아래 "정정 행") | FR-BUD-01 |
| `provider_call_id` | id(pcl) | C | 호출 비용 원 행이면 필수, 유일. 정정 행은 NULL | FR-AGT-02 (3) |
| `adjusts_cost_event_id` | id(cst) | N | 정정 행(예: `unknown` 뒤 공급자 청구 확인) | FR-BUD-04 |
| `run_id` / `task_id` / `agent_role` | id / id / enum | C | 실행 비용이면 필수. 복원 이월 정정 행은 NULL | FR-BUD-01 |
| `arc_id` / `episode_id` / `scene_id` / `shot_id` | id | N | 집계 차원 | FR-BUD-01 |
| `category` | enum:cost_category | Y | | FR-BUD-02 |
| `provider` / `model_id` | text | Y | | FR-BUD-01 |
| `provider_profile_id` / `provider_profile_version` | id(prv) / int | Y | 단가 출처 | FR-BUD-04 |
| `cost_basis` | enum:cost_basis | Y | | FR-BUD-04 |
| `amount_micros` | micros | Y | `unknown`이면 예약액. 음수는 늦은 응답 정정 행에서만 허용 | FR-AGT-02 (4) |
| `reserved_micros` | micros | Y | 연결 예약액 | FR-BUD-03 |
| `overrun_micros` | micros | Y | `max(0, amount - reserved)` | G-6 |
| `input_tokens` / `output_tokens` / `cached_tokens` | bigint | N | LLM | |
| `units` | jsonb | N | 이미지 장수, 영상 초 | |
| `is_rerun` | bool | Y | 회수 후 재실행 비용 | FR-AGT-02 (4) |
| `occurred_at` | ts | Y | | |

**정정 행** (`adjusts_cost_event_id` 또는 아래 키를 가진 행, INV-COST-04)

| 종류 | `idempotency_key` | `provider_call_id` / `run_id` | 금액 | 그 밖의 필드 |
|---|---|---|---|---|
| 늦은 응답 정정 (`unknown` 뒤 응답 도착, → 04 P7) | `pcl:<provider_call_id>:late` | NULL / 원 실행 | `amount_micros` = 실측 − 예약액(음수 가능), `reserved_micros`=0, `overrun_micros` = `max(0, 실측 − 예약액)` | `adjusts_cost_event_id`=`unknown` 원 행, `cost_basis=measured`, 토큰은 실측값 |
| [v1] 공급자 청구 확인 정정 | 형식은 → 04 18절 U-19 | NULL / 원 실행 | 확인액 − 원 행 금액 | `adjusts_cost_event_id`=원 행 |
| 복원 이월 정정 (→ 02 8.4 5단계) | `restore:<backup_id>:<novel_id>:<category>:<group_no>` | NULL / NULL(`task_id`·`agent_role`·`adjusts_cost_event_id`도 NULL) | 그룹 합계(`amount`·`reserved`·`overrun`·토큰) | `provider`·`model_id`·`provider_profile_id`/`provider_profile_version`·`cost_basis`는 그룹 값, `is_rerun=false`, `occurred_at`은 그룹 마지막 시각. 작품마다 `cost.restored_carryover` |

정정 행은 C 필드 규칙("호출·실행 비용이면 필수")의 예외입니다. 원장 합은 원 행과 정정 행을 모두 더한 값이고, 한 `ProviderCall`의 원 행은 여전히 1개입니다(INV-COST-01은 `provider_call_id`가 있는 행에만 걸림).

### 7.4 흐름과 불변식

| 단계 | 처리 | 트랜잭션 |
|---|---|---|
| 1. 예약 | 적용 정책(`all` + 해당 `category`)마다 `현재 창 원장 합 + active 예약 합 + 이번 예약 ≤ hard_limit`을 확인하고 `BudgetReservation(active)` 생성. 실패는 둘로 나눔: (a) 실지출 기준 초과 `원장 합 + 이번 예약 > hard_limit` → 거부, 7단계 정지 / (b) 다른 실행 예약 때문 `원장 합 + 이번 예약 ≤ hard_limit` → 거부, 작업 T8(`block_reason=budget_reservation_wait`)로 대기, 정책 전이·일시정지·질문 없음. (b) 대기 작업은 다른 예약이 `settled`·`released`·`unknown_closed`가 되는 트랜잭션에서 T9로 풀고 `budget_released` 깨우기를 넣음(→ 04 8.3). 상한 계산 불가면 `unpriced_usage_policy`에 따라 거부 또는 승인 질문 | 작품 단위 advisory lock 안 1 트랜잭션 |
| 2. 호출 준비 | `ProviderCall(prepared)`에 `reservation_id`, `max_cost_micros` 기록 | |
| 3. 발송 | `ProviderCall.status = sent` 커밋 후 외부 호출 | 발송 전 커밋 |
| 4. 응답 | 응답·사용량을 `ProviderCall(responded)`에 저장 → `CostEvent`(`measured` 또는 `estimated`) 1행 → 예약 `settled` | 1 트랜잭션 |
| 5. 실패 응답 | 공급자가 과금했다고 보고하면 `CostEvent`, 아니면 예약 `released` | 1 트랜잭션 |
| 6. 회수 | `sent`로 남은 호출은 `unknown` → `CostEvent(cost_basis=unknown, amount=예약액)` → 예약 `unknown_closed`. 재실행 비용은 `is_rerun=true` | 회수 트랜잭션 |
| 7. 한도 | 1단계 (a) 실패 또는 정산 후 원장 합 ≥ `hard_limit`이면 정책 `hard_stopped`(active 예약 합만으로는 정지하지 않음), 작품(또는 기능 범위) `paused_at`·`pause_reason=budget_hard_limit`, `budget_resume` 승인 질문 생성. 소프트 비율 이상이면 `warning` + 정보성 알림 | 1 트랜잭션 |

- `INV-COST-01` 같은 `ProviderCall`의 원장 행은 1개(유일 제약). 재시도·재시작 후에도 중복 0건(FR-AGT-02 (3)).
- `INV-COST-02` `active` 예약 합을 포함해 하드 한도를 넘는 상태로 새 실행을 시작하지 않습니다(G-6 예약 상한 기준 초과 0건).
- `INV-COST-03` 실집행 초과(`overrun_micros > 0`)는 기록하고 `cost.overrun_recorded`를 남깁니다. 진행 중 호출 1건 이내가 목표입니다(G-6).
- `INV-COST-04` 원장은 수정하지 않고 정정 행(`adjusts_cost_event_id`)으로만 고칩니다.
- `INV-COST-05` 미디어 견적 승인(`media_quote`)이 있어도 개별 호출 예약은 따로 합니다. 견적과 실제 차이는 `MediaQuote` 대비 원장 합으로 계산합니다(FR-BUD-06a/b).

---

## 8. ID와 버전 관리

### 8.1 ID
- 주 키 형식·접두사 → 00 5.1, 표시 번호 → 00 5.2.
- 불변 ID 원칙: 사실·엔티티·씬·질문·떡밥 ID는 내용이 바뀌어도 유지합니다. 엔티티 병합 후에도 옛 ID를 지우지 않습니다(FR-ONT-16). 씬은 겹침 기준을 넘으면 ID를 유지합니다(FR-AGT-05).

### 8.2 버전이 있는 객체

| 객체 | 버전 단위 | 저장 방식 | 현재 포인터 | 변경 규칙 | 관련 |
|---|---|---|---|---|---|
| 원고 | `ManuscriptVersion.version_no` (화 단위) | append-only 행, 본문 전체 저장 | `episodes.outline_version_id`, `current_version_id`, `approved_version_id`, `published_version_id` | 단계 산출물·사람 수정마다 새 버전. diff는 두 버전에서 계산 | FR-MAN-01, FR-AGT-03 |
| 씬 경계 | `scenes.boundary_revision` | 행 갱신 + `scene.resegmented` 감사 이벤트(전후 구간) | — | 원고 버전이 바뀌면 재계산 | FR-AGT-05 |
| 컨셉 브리프 | `ConceptBrief.version_no` (작품 단위) | append-only 행. 작업 중 값은 `concept_sessions.working_brief`(가변) | `novels.approved_concept_brief_id` | 승인 요청 때만 새 버전. 승인된 행은 수정하지 않음 | FR-NOV-08 |
| 기획서 | `SeriesBible.version_no` | append-only 행 | `status=approved` 행 | 승인된 행은 수정하지 않고 새 버전 | FR-NOV-06 |
| 목표 | `Goal.revision` | 행 갱신 + 감사 로그 전후 값 | — | 변경 시 계획 작업 재큐 | FR-NOV-02 |
| 사실 | `FactVersion.version_no` (사실 단위) | append-only, `recorded_at`/`superseded_at` (ADR-007) | `facts.current_version_no` | `approved` 이상은 승인 필요(4.8절). 되돌리기도 새 버전 | FR-ONT-09 |
| 온톨로지 스키마 | `OntologySchemaVersion.version_no` (작품 단위, 기본 스키마 버전 위에 확장) | append-only | `novels.active_schema_version_id` | 제안 승인 시 새 버전 발행. 사실은 검증에 쓴 `schema_version_id`를 기록 | FR-ONT-18 |
| 이름 사전 | 버전 없음. 행 단위 `status`와 감사 이벤트 | 행 갱신 + 감사 로그 | — | 작중 유효 범위는 `story_range`로 표현 | FR-ONT-13 |
| 링커 | `mentions.linker_version` (문자열) | 언급 행에 기록 | — | 링커·임계값 변경 시 올림. 재링킹 범위 판단에 사용 | FR-ONT-14 |
| 프롬프트 템플릿 | `runs.prompt_template_version` (`<role>.<task_kind>@<semver>`) | 코드 저장소에 버전 관리 | — | 릴리스로 변경 | NFR-OBS-02 |
| 공급자 단가 | `ProviderProfile.version_no` | 새 버전 행 | `is_active` | 원장은 계산에 쓴 버전을 기록 | FR-BUD-04 |
| 씬 프롬프트 IR [v1] | `ScenePromptIR.version_no` (샷 단위) | append-only | `shots.current_ir_id` | 새 버전 생성 시 렌더링·편집본·에셋에 `stale_since` | FR-SPX-07, 08 |
| 렌더링 프롬프트 [v1] | 편집마다 새 행(`edited_from_id`) | append-only | 최신 행 | 내보내기에 IR 버전·공급자 포함 | FR-SPX-08 |
| 컨텍스트 스냅숏 | 실행당 1개 | 불변 | — | — | FR-AGT-04 |

### 8.3 공통 버전 규칙
- 버전 행은 수정하지 않습니다. 현재 포인터만 옮깁니다.
- 버전 번호는 대상별 `MAX(version_no)+1`을 대상 행 잠금 안에서 발급합니다.
- 버전을 만든 주체(`*_actor_type`, `*_actor_id`, `run_id`)를 모든 버전 행에 남깁니다(D-4).
- 되돌리기는 과거 버전 내용을 복사한 새 버전입니다. 이력을 지우지 않습니다.

---

## 9. 미결 사항

| 항목 | 내용 | 해소 경로 |
|---|---|---|
| `attribution_spans` 계산 방식 | 문자 단위 diff 알고리즘과 줄 단위 표시 규칙 | 해소: → 07 7.2 |
| 사실 일괄 승격 API 이름 | `ontology.promoteEpisodeFacts`는 임시 이름 | 해소: → 06 6.4(`promoteEpisodeFacts(tx, scope, episode_id, to_status)`) |
| 예산 하위 범위 | 아크·화 단위 한도는 MVP에 두지 않음(작품·기능·월만) | 실사용 후 필요 시 추가 |
| `arc_approval`에서 아크 승인 반려 시 화별 `rework_from` | 아크 반려를 화별 반려로 펼치는 규칙 | 해소: → 05 10.3 |
| 정체 공개 시점(`reader_reveal_point`)과 화 상태 연동 | 공개 처리 시 독자 공개 범위 검사 | → 06 |
| 00 레지스트리 등록 대기 | 이 문서가 쓰는 미등록 이름: 접두사 `rcp`(`EpisodeRecap`), enum `recap_layer`(`canon`/`reader`), `narration_mode`(`first_person`/`third_limited`/`third_omniscient`)와 `novels.default_narration_mode` 기본값, `narrative_frame_kind`, `identity_decision_kind.relink`, `continuity_issue_kind`의 `safety_*` 3값 | 해소: 00 5.1(`rcp`), 6.2(`recap_layer`, `narration_mode`), 6.8(`safety_*`), 6.10(`narrative_frame_kind`, `relink`), 7.3(`novel.default_narration_mode`) |
| v0.3 컨셉 이름의 00 등록 | 접두사 `cns`·`cnm`·`cbf`, `concept_*` enum 10개, `novel_status.concept`, `task_kind` 3개, `target_type`·`ref_type`·`approval_type`·`question_topic`·`outbox_kind` 값 | 해소: 00 v0.2 5.1·6.1·6.3·6.4·6.5·6.7 |
| `novel_status` 나머지 전이 | `planning → serializing → completed`, `archived`의 전이 표가 없음(기존 공백) | 03 다음 개정 |
| 컨셉 미결 | O-C16(대화 보관 기간). O-C1(`goal_id` NULL 예외)·O-C13(컨셉 사용자 필드 유래 사실과 INV-BIB-03 관계)은 해소 | O-C1 해소: INV-TSK-01 예외 확정(X-1). O-C13 해소: INV-BIB-03 개정(B2 사실은 출처와 무관하게 기획서 승인 때 캐논). O-C16 → 11 11절 |
| v0.2 신규 이름의 00 등록 | `AnswerSession` 접두사 `ase`, enum `answer_session_status`(`active`/`completed`/`expired`/`cancelled`), enum `issue_fix_scope`(`span`/`scene`/`outline`). 이 문서는 이름만 참조 | 해소: 00 5.1·6.4·6.8 |
