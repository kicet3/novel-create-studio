# 00. 설계 기반 (Foundation)

| 항목 | 내용 |
|---|---|
| 문서 | novel-create-studio 상세 설계 00 |
| 버전 | v0.2 (2026-10-28, 컨셉 개발 11·장르 템플릿 계획서 등록). v0.2.1(같은 날, 교차 후속): 11 v0.2 값(`concept_brief_status.approved_direction`, `concept_field_origin` 2값, `concept_user_intent`, `character_age_band`, 7.8 기본값 2개·`concept.session_budget_usd` 3→6), 계획서 값(6.13 `content_level`·`continuity_rule_kind`·사전 필터 키·카테고리 키·별칭, 6.10 `glossary_source_kind`) |
| 버전 갱신 | v0.2.2 (2026-10-28): 사용자 결정 확정 반영. ADR-005 사용자 확인(D-8 확정, Apache AGE v1 미포함·확장 1에서만 검토, Neptune 미채택, Obsidian 연동 범위), `novel_status=concept`(D-39) 확정, 6.13·7.9·카테고리 키 레지스트리 "후보" → 확정(D-30·D-31), D-32~D-34 표기, 8절 미결 정리(PRD v0.5 반영분 해소) |
| 기준 | PRD v0.5 (`docs/PRD.md`, D-1~D-40 확정. D-29는 확정(조건부), D-33은 확정(방침)). v0.2.1까지는 PRD v0.4 초안, v0.1은 PRD v0.3 기준 |
| 역할 | 설계 문서 11개와 계획서가 함께 쓰는 **단일 출처**입니다. 용어, ADR, 모듈 이름, 명명 규칙, 전역 enum, 기본값은 여기서만 정의합니다. 다른 문서는 이 이름을 그대로 쓰고, 바꿀 때는 이 문서를 먼저 고칩니다. |
| 작성 | AI 초안. 사람 검토 필요 |

**표기 규칙**
- PRD 표기 규칙을 따릅니다. **가정:** 은 조사나 실측을 거치지 않은 전제, **[1차]/[2차]/[미확인]** 은 외부 사실의 근거 등급입니다.
- 외부 사실은 2026-10-27에 작성한 조사 파일 3개(Graph DB 후보, 엔티티 식별 기법, Paperclip 소스 재확인)를 근거로 합니다. 이 문서에서 원문을 다시 열어 보지는 않았습니다.
- 식별자(타입·필드·enum·테이블·모듈)는 영어, 설명은 한국어입니다.
- "→ 0X n절"은 해당 설계 문서의 절을 가리킵니다.

---

## 1. 문서 지도와 읽는 순서

| 순서 | 문서 | 다루는 것 | 먼저 읽을 문서 |
|---|---|---|---|
| 1 | `00-foundation.md` | 용어, ADR, 모듈, 명명 규칙, enum·기본값 레지스트리 | — |
| 2 | `01-product-requirements.md` | FR/NFR → 설계 추적 매트릭스, 해석·보완한 요구, 미충족 항목, PRD 수정 제안 | 00 |
| 3 | `03-domain-model.md` | 집합체, 필드, 불변식, 상태 기계, 감사 로그 이벤트, 비용 원장, 버전 관리 | 00 |
| 4 | `02-system-architecture.md` | 프로세스, 계층, 저장소, 이벤트·실시간, 배포 모드, 장애·백업 | 00, 03 |
| 5 | `06-story-ontology.md` | 그래프 스키마, 엔티티 식별 계층, OntologySchema, 용어집, bitemporal 사실, 인물 지식, 떡밥 모델, 연속성 규칙, GraphRAG 조회, 엔진 선택 상세 | 00, 03 |
| 6 | `04-agent-orchestration.md` | 에이전트 역할, Task/Run 수명주기, wake queue, lease, 재시도, 비용 예약, 컨텍스트, LLM 어댑터 | 00, 03, 02 |
| 7 | `05-messenger-hitl.md` | 질문 모델, 등급 판정, digest, 마감, 답변 해석·반영, 경합, 메신저 어댑터, 승인 게이트 | 00, 03, 04 |
| 8 | `07-writing-pipeline.md` | 화 파이프라인 단계별 입출력·검사·게이트, 사실 추출→링킹, 씬 분할, 확장 파이프라인 | 03, 04, 05, 06 |
| 9 | `11-concept-development.md` | 기본 탑재 컨셉 에이전트 `concept_partner`, 컨셉 대화 단계·턴 규칙·상한, 웹·메신저 이어 하기와 `Question` 경계, `ConceptSession`·`ConceptMessage`·`ConceptBrief` 데이터·상태 기계, `ConceptBrief` → 목표·기획서·온톨로지 매핑, 품질·안전, KPI | 00, 03, 04, 05, 06, 07 |
| 10 | `08-tech-stack-and-repo.md` | 기술 선택 상세, 저장소 구조, 마이그레이션, 설정·비밀, CLI, 빌드·배포, 품질 게이트, 웹 UI 화면 설계(9절) | 00, 02 |
| 11 | `09-roadmap-and-risks.md` | 마일스톤별 구현 순서·완료 기준, 기술 스파이크, 설계 위험 | 전체 |
| 12 | `10-paperclip-mapping.md` | Paperclip 대응표, 라이선스 표기, chat 어댑터 판단 | 00, 08 |
| 13 | `../plans/genre-world-templates-plan.md` (계획서) | 카테고리(장르·하위 장르·트로프·패싯)별 세계관 데이터 템플릿 `GenreTemplate`의 체계·데이터 모델·합성 규칙·구축 절차·검증·일정. 결정 DG-01~DG-09(PRD D-29~D-37, 2026-10-28 확정) | 00, 06, 11 |

문서 사이 소유권:
- 상태 enum 값은 00 6절, 상태 전이 규칙은 03 4절이 소유합니다. 다른 문서는 전이를 다시 정의하지 않고 참조합니다.
- 온톨로지 내부(이름 사전 조회, 링킹 단계, 스키마 제약 문법, 사실 시간 질의)는 06이 소유합니다. 03은 관계형 쪽에서 참조하는 ID와 경계만 둡니다.
- 기본값의 값은 00 7절, 그 값을 쓰는 알고리즘은 각 문서가 소유합니다.
- 웹 UI 화면 설계(화면 목록, 화면별 데이터·조작, 단축키)는 08 9절이 소유합니다.
- `ConceptSession`·`ConceptBrief` 상태 전이와 컨셉 대화 규칙은 11이 소유합니다(03 4.11 소유 표에 등록). `novel_status` 전이 N1~N3(`concept` → `onboarding` → `planning`)은 03이 소유하고 11 5.8을 근거로 둡니다.
- 장르 템플릿의 내용·카테고리 키 체계·구축 절차는 계획서가 소유합니다. 템플릿을 소비하는 계약(`ConceptQuestionDef`)은 11 3.6, 작품 스키마 확장 적용은 06 4.7이 소유합니다. 계획서의 enum·기본값은 이 문서 6.13·7.9에 둡니다. D-29~D-37 확정(2026-10-28)으로 "후보" 표기를 뗐고, 기본값은 7절 규칙대로 가정입니다.

---

## 2. 용어 사전

### 2.1 PRD 4절 용어

PRD 4절 정의를 그대로 따릅니다. 아래 "설계 대응" 열은 이 용어가 설계에서 어떤 타입·테이블로 구현되는지 보여 줍니다.

| 한국어 | 식별자 | 설계 대응 (테이블) | 상세 |
|---|---|---|---|
| 작품 | `Novel` | `novels`. 테넌트 루트 | → 03 2절 |
| 목표 | `Goal` | `goals` | → 03 3.1 |
| 기획서 | `SeriesBible` | `series_bibles` (버전 행) | → 03 3.1 |
| 아크 | `Arc` | `arcs` | → 03 3.1 |
| 화 | `Episode` | `episodes` | → 03 3.2 |
| 씬 | `Scene` | `scenes`, `scene_participants` | → 03 3.2, 07 |
| 샷 [확장] | `Shot` | `shots` | → 03 3.9 |
| 씬 영상 [확장] | `SceneVideo` | `media_assets` (`kind=scene_video`) | → 03 3.9 |
| 에이전트 역할 | `AgentRole` | enum `agent_role` | → 6절, 04 |
| 작업 | `Task` | `tasks`, `task_dependencies` | → 03 3.3 |
| 실행 | `Run` | `runs` | → 03 3.3 |
| 질문 | `Question` | `questions`, `question_options`, `question_links` | → 03 3.4, 05 |
| 답변 반영 기록 | `AnswerReflection` | `answer_reflections`, `answer_reflection_items` | → 03 3.4 |
| 채널 | `Channel` | `channels` | → 03 3.5, 05 |
| 승인 | `Approval` | `approvals` | → 03 3.4 |
| 자율성 수준 | `AutonomyLevel` | enum `autonomy_level` | → 6절 |
| 질문 민감도 | `QuestionThreshold` | enum `question_threshold` | → 6절 |
| 세계관 온톨로지 | `WorldOntology` | 온톨로지 테이블 묶음(관계형 저장소 안, ADR-005) | → 06 |
| 사실 | `Fact` | `facts`, `fact_versions` | → 03 5절, 06 |
| 엔티티 | `Entity` | `entities` | → 03 5절, 06 |
| 이름 | `EntityName` | `entity_names` | → 03 5절, 06 |
| 언급 | `Mention` | `mentions` | → 03 5절, 06 |
| 온톨로지 스키마 | `OntologySchema` | `ontology_schema_versions`, `schema_change_proposals` | → 06 |
| 작품 용어집 | `Glossary` | `glossary_terms` | → 06 |
| 캐논 | `Canon` | 질의 개념: `canon_status IN (approved, published_locked)`인 현재 사실 버전 | → 06 |
| 시간선 | `Timeline` | `timelines` | → 06 |
| 떡밥 / 회수 | `Setup` / `Payoff` | `setups`, `setup_beats` (`kind=payoff`가 회수) | → 03 3.7, 06 |
| 연속성 이슈 | `ContinuityIssue` | `continuity_issues`, `continuity_issue_evidence` | → 03 3.6 |
| 플랫폼 프로필 | `PlatformProfile` | MVP: `length_profiles`, v1: `platform_profiles` | → 03 3.1 |
| 예산 / 비용 이벤트 | `Budget` / `CostEvent` | `budget_policies`, `budget_reservations`, `cost_events` | → 03 7절 |
| 감사 로그 | `ActivityLog` | `activity_log` | → 03 6절 |
| 미디어 대상 화 [확장] | — | 작품 설정 `media_target_basis` | → 6절 |
| 미디어 에셋 [확장] | `MediaAsset` | `media_assets` | → 03 3.9 |
| 씬 프롬프트 [확장] | `ScenePromptIR` | `scene_prompt_irs` (버전 행) | → 03 3.9 |
| 렌더링 프롬프트 [확장] | `RenderedPrompt` | `rendered_prompts` | → 03 3.9 |
| 시각 자산 [확장] | `VisualReference` | `visual_references` | → 03 3.9 |
| 공급자 프로필 | `ProviderProfile` | `provider_profiles` (설치 단위) | → 03 3.8 |

### 2.2 설계에서 새로 쓰는 용어

| 한국어 | 식별자 | 정의 | 상세 |
|---|---|---|---|
| 사용자 | `User` | 앱을 쓰는 사람. MVP는 설치당 1명(`role=owner`). 주체 모델은 다중 사용자로 확장 가능하게 둡니다(D-16). | → 03 3.1 |
| 주체 | `Actor` | 상태를 바꾼 쪽. `user`, `agent`, `system` 중 하나와 식별자 | → 03 6절 |
| 원고 버전 | `ManuscriptVersion` | 화의 아웃라인·초고·수정본·최종본 한 벌. 작성 주체를 가집니다(FR-MAN-01, D-4). | → 03 3.2 |
| 화 반려 기록 | `EpisodeRejection` | 반려 사유와 되돌릴 단계(`rework_from`) | → 03 3.2 |
| 씬 등장 | `SceneParticipant` | 씬과 엔티티의 등장 관계 | → 03 3.2 |
| 작업 의존 | `TaskDependency` | 작업 사이 선후 관계 | → 03 3.3 |
| 깨우기 요청 | `WakeRequest` | 실행을 시작시키는 트리거 기록. 실행(`Run`)과 분리합니다(ADR-009). | → 04 |
| 임대 | `lease` | 작업 하나를 실행 하나가 독점하는 기한 있는 잠금. `tasks.lease_run_id` + `lease_expires_at` | → 04 |
| 외부 호출 | `ProviderCall` | LLM·이미지·영상 공급자 호출 1건. 응답을 먼저 저장하는 단위(FR-AGT-02) | → 03 3.3, 04 |
| 컨텍스트 스냅숏 | `ContextSnapshot` | 실행에 넣은 사실·제약·떡밥·답변 ID 목록(FR-AGT-04, NFR-OBS-02) | → 03 3.3, 04 |
| 역할별 모델 지정 | `RoleModelBinding` | 작품의 역할마다 쓰는 공급자·모델·출력 토큰 상한(FR-AGT-08, D-9) | → 03 3.8 |
| 질문 선택지 | `QuestionOption` | 질문의 선택지 하나. 버튼 데이터에는 질문 ID와 선택지 인덱스만 담습니다. | → 03 3.4 |
| 질문 링크 | `QuestionLink` | 질문과 작업·온톨로지 노드·떡밥의 연결(FR-MSG-01) | → 03 3.4 |
| 질문 발송 | `QuestionDelivery` | 질문 하나가 채널 하나에 게시된 기록 | → 03 3.4 |
| 답변 | `Answer` | 질문에 온 답 하나. 채택·늦은 답변·중복을 구분합니다(FR-MSG-18). | → 03 3.4 |
| 답변 세션 | `AnswerSession` | 메신저에서 여러 단계로 받는 답(복수 선택, 엔티티 선택 등)의 진행 상태. `answer_sessions` | → 05 6.3 |
| 답변 해석 | `AnswerInterpretation` | 서술형 답을 사실·제약·작업 변경 후보로 바꾼 결과와 확인 상태(FR-MSG-16) | → 03 3.4 |
| 묶음 발송 | `DigestBatch` | 비차단형 digest, 일일 요약, 일괄 공개 질문의 묶음 | → 05 |
| 알림 정책 | `NotificationPolicy` | 방해금지 시간, 일일 질문 상한, 리마인더, digest 창(FR-MSG-10, D-14) | → 03 3.5 |
| 메신저 봇 | `MessengerBot` | 설치 단위 봇 자격 증명과 수신 상태(Telegram offset 등) | → 03 3.5 |
| 채널 바인딩 토큰 | `ChannelBindingToken` | 일회용·만료 연결 코드(FR-MSG-02, NFR-SEC-01) | → 03 3.5 |
| 수신함 | `MessengerInbox` | 메신저에서 받은 업데이트·클릭의 내구 기록. 공급자 이벤트 ID로 중복을 막습니다(NFR-REL-02). | → 05 |
| 발신함 | `MessengerOutbox` | 메신저로 보낼 메시지의 내구 대기열(rate limit 재시도, `delivery_unknown`) | → 05 |
| 예산 정책 | `BudgetPolicy` | 작품·기간·기능별 한도 한 줄(FR-BUD-02) | → 03 7절 |
| 예산 예약 | `BudgetReservation` | 호출 전에 잡아 두는 비용 상한(FR-BUD-03) | → 03 7절 |
| 미상 비용 | `unknown_cost` | 응답을 받지 못한 호출의 원장 기록. `cost_basis=unknown`, 금액은 예약액(FR-AGT-02, FR-BUD-01) | → 03 7절 |
| 떡밥 비트 | `SetupBeat` | 떡밥의 설치·강화·회수 한 건(`kind=plant/reinforce/payoff`). 계획 화와 실제 근거 씬을 가집니다. | → 03 3.7 |
| 기한 변경 | `SetupDueChange` | 떡밥 회수 기한 변경 이력(FR-FOR-01) | → 03 3.7 |
| 사실 버전 | `FactVersion` | 사실 하나의 기록 시점별 내용. 기록 시간 축(ADR-007) | → 06 |
| 작중 시점 | `story_point` | 작품 안의 위치를 나타내는 정수(5.5절) | → 5.5절 |
| 작중 범위 | `story_range` | `story_point` 반열린 구간 `[from, to)`. 사실·이름의 유효 범위 | → 5.5절, 06 |
| 동일성 결정 | `IdentityDecision` | 엔티티 병합·분리·"다름" 판정의 제안과 적용 이력(FR-ONT-15, 16) | → 06 |
| 스키마 변경 제안 | `SchemaChangeProposal` | 에이전트가 낸 유형·관계 추가·동의어 제안(FR-ONT-18) | → 06 |
| 인물 지식 | `CharacterKnowledge` | 인물이 어느 시점에 무엇을 알거나 잘못 아는지. `fact_kind=knowledge`인 사실로 저장 | → 06 |
| 관계 | `Relation` | 두 엔티티 사이의 사실. `fact_kind=relation`인 사실로 저장(별도 테이블 없음) | → 06 |
| 칭호 | `title` (엔티티 유형) | 시점마다 보유자가 바뀌는 직위·칭호. 보유자는 `holds_title` 관계 사실로 표현 | → 06 |
| 링커 | `linker` | 언급 → 엔티티 연결 파이프라인 L0~L8 | → 06 |
| 그래프 저장소 포트 | `OntologyRepository` | 온톨로지 읽기·쓰기 인터페이스. 엔진 교체 경계(NFR-EXT-01) | → 02, 06 |
| 미디어 견적 | `MediaQuote` | 이미지·영상 작업의 실행 전 견적과 승인 상태(FR-BUD-06a/b) | → 03 3.9 |
| 컨셉 세션 | `ConceptSession` | 작품 컨셉을 사용자와 함께 잡는 대화 한 벌과 작업 중 브리프. `concept_sessions` | → 11 5.2 |
| 컨셉 메시지 | `ConceptMessage` | 컨셉 세션 안 발화 1건(사용자·에이전트·시스템). `concept_messages` | → 11 5.3 |
| 컨셉 브리프 | `ConceptBrief` | 승인 대상 컨셉 요약의 불변 버전. 목표·기획서의 입력. `concept_briefs` | → 11 5.4 |
| 작업 중 브리프 | `working_brief` | 세션 행 안의 가변 브리프(jsonb). 턴마다 갱신하고 승인 요청 때 `ConceptBrief` 버전으로 고정 | → 11 5.1 |
| 컨셉 질문 정의 | `ConceptQuestionDef` | 공통 질문 세트(`common@1`)·장르 템플릿이 제공하는 질문 씨앗과 채울 필드(`fills`) | → 11 3.6, 8.2 |
| 턴 출력 계약 | `ConceptTurnProposal` | `concept_turn` 실행의 구조화 출력(발화, 질문, 슬롯 갱신, 수정 제안, 약점). commit이 INV-CON-03으로 검증 | → 11 2.7 |
| 장르 템플릿 | `GenreTemplate` | 카테고리별 세계관 데이터 묶음(컨셉 질문, 스키마 확장, 연속성 규칙, 떡밥 패턴, 용어집 시드, 독자 기대). 앱 설치 데이터(읽기 전용), `key@version` + 컴파일 해시로 참조. MVP-β(FR-NOV-03b)·v1(FR-NOV-03c)(D-30 확정) | → 계획서 3절, 06 4.7 |
| 표시 번호 | `display_no` | 작품 안에서 사람이 부르는 순번(`Q-128`, `S-01`) | → 5.2절 |
| 안전 지점 | `safe_point` | 진행 중 외부 호출이 끝나 응답이 저장된 시점. 일시정지가 실행을 멈추는 지점(FR-HIL-03) | → 04 |
| 신뢰 로컬 모드 | `local_trusted` | 로컬 단일 사용자, 외부 비노출 배포 모드 | → ADR-002 |
| 자체 호스팅 모드 | `self_hosted` | 인증을 강제하는 서버 배포 모드 | → ADR-002 |

---

## 3. ADR 목록

상태: **채택**(이 설계의 기준), **제안**(스파이크 결과에 따라 확정), **보류**.

| ADR | 제목 | 상태 | 관련 |
|---|---|---|---|
| ADR-001 | 새 코드베이스, Paperclip은 패턴·범용 인프라만 차용 | 채택 | D-15 |
| ADR-002 | 로컬 우선 단일 사용자 → 자체 호스팅 | 채택 | D-2, NFR-SEC-03 |
| ADR-003 | Node 24 + TypeScript, pnpm workspace 모노레포 | 채택 | NFR-EXT-01 |
| ADR-004 | 관계형 저장소: PostgreSQL (embedded-postgres / 외부 PG) | 채택 | D-2, NFR-REL-04·05 |
| ADR-005 | 그래프 저장소: 같은 PostgreSQL의 사실 테이블 + 질의 계층 | 채택(스파이크 S-1~S-9 조건부, 사용자 확인 완료 2026-10-28) | D-8, R-18 |
| ADR-006 | 엔티티 ID 기반 식별 계층 | 채택 | D-27, FR-ONT-12~19 |
| ADR-007 | 사실의 bitemporal 표현 | 채택 | FR-ONT-02, 04, 09 |
| ADR-008 | 모듈 계층 `adapters → application → domain` | 채택 | D-15 |
| ADR-009 | 실행 모델: wake queue·run 분리·CAS lease | 채택 | FR-AGT-02, NFR-REL-01 |
| ADR-010 | LLM 어댑터 SPI와 역할별 모델 혼합 | 채택 | D-9, FR-AGT-08 |
| ADR-011 | 메신저: Telegram → Discord, Vercel Chat SDK + 자체 내구성 계층 | 채택 | D-7, D-15 |
| ADR-012 | 미디어 모델 중립 IR | 채택 | D-10, FR-SPX-02 |
| ADR-013 | enum은 text + CHECK, 정의는 `packages/shared` 한 곳 | 채택 | — |
| ADR-014 | 질문과 승인을 별도 객체로 두고 1:1 연결 | 채택 | FR-MSG-01, FR-HIL-02 |
| ADR-015 | 원고 본문은 DB, 바이너리는 파일 저장소 | 채택 | FR-IMG-04, FR-MAN-06a |
| ADR-016 | 금액은 micro-USD 정수 | 채택 | FR-BUD-01~04 |
| ADR-017 | 감사 로그 순번을 실시간 이벤트 ID로 사용 | 채택 | NFR-OBS-01, FR-UI-08 |
| ADR-018 | ID 형식: 접두사 + ULID | 채택 | FR-ONT-12 |

### ADR-001 새 코드베이스, Paperclip은 패턴·범용 인프라만 차용
| 항목 | 내용 |
|---|---|
| 결정 | Paperclip을 포크하거나 의존성으로 걸지 않습니다. 범용 인프라 파일은 MIT 고지와 함께 복사하고, 나머지는 설계 패턴만 가져옵니다. |
| 대안 | (a) 포크 (b) Paperclip 플러그인으로 구축 |
| 이유 | Paperclip 도메인(AI 회사, heartbeat, 코딩 CLI 어댑터)이 교체 대상이고(D-15), wake queue·run-dispatch 모듈은 `heartbeat.ts`가 유일 호출자라 독립 차용 단위가 아닙니다 [1차, 커밋 0cb3fc7]. 라이선스는 저장소·전 패키지 MIT이고 루트 NOTICE가 없습니다 [1차] https://github.com/paperclipai/paperclip (LICENSE). |
| 결과 | 차용 범위 표는 → 10. 복사한 파일 머리에 원 저작권 문구를 두고 배포물에 서드파티 고지 파일을 만듭니다(→ 08). |

### ADR-002 로컬 우선 단일 사용자 → 자체 호스팅
| 항목 | 내용 |
|---|---|
| 결정 | 배포 모드 `deployment_mode`는 `local_trusted`(기본)와 `self_hosted` 두 가지입니다. `local_trusted`는 `exposure=private`를 강제하고 루프백에만 바인딩합니다. `self_hosted`는 인증을 강제합니다. 호스팅 SaaS는 범위 밖입니다. |
| 대안 | 처음부터 서버 배포, 호스팅 SaaS |
| 이유 | D-2 확정. 메신저 수신을 위해 상시 실행 프로세스가 필요합니다(NFR-REL-06). Paperclip의 `deploymentMode × exposure` 교차 검증 규칙이 NFR-SEC-03과 같습니다 [1차, `config-schema.ts`]. |
| 결과 | 단일 프로세스 안에서 HTTP·스케줄러·worker·메신저 수신을 돌립니다(→ 02). 데이터 모델은 처음부터 `novel_id` 격리와 `actor` 구분을 둡니다(D-16, NFR-EXT-04a). |

### ADR-003 Node 24 + TypeScript, pnpm workspace 모노레포
| 항목 | 내용 |
|---|---|
| 결정 | 서버·UI·CLI를 TypeScript 하나로 작성합니다. 런타임 Node 24 LTS, 패키지 매니저 pnpm workspace(Turbo·Nx 없음). |
| 대안 | Python(LLM·ML 생태계), Go(단일 바이너리) |
| 이유 | 메신저 SDK(Vercel Chat SDK), LLM SDK(Vercel AI SDK), Paperclip 차용 코드가 모두 TypeScript입니다 [1차]. UI(React)와 타입·enum·zod 스키마를 공유합니다. Paperclip은 `node>=24.11`, pnpm 9.15를 씁니다 [1차]. |
| 결과 | 버전 고정·스택 상세는 → 08. |

### ADR-004 관계형 저장소: PostgreSQL
| 항목 | 내용 |
|---|---|
| 결정 | 작업·질문·승인·비용·감사·원고·온톨로지를 PostgreSQL 데이터베이스 하나에 둡니다. 로컬은 `embedded-postgres`로 자식 프로세스 PG를 띄우고, `self_hosted`는 외부 PG(`DATABASE_URL`)를 씁니다. 테스트는 PGlite를 씁니다. ORM은 drizzle-orm + postgres.js, 마이그레이션 SQL은 drizzle-kit으로 만들고 적용은 자체 runner(Paperclip 차용)로 합니다. |
| 대안 | SQLite(`better-sqlite3`), PGlite 운영 사용 |
| 이유 | `embedded-postgres`는 MIT, 최신 18.4.0-beta.17(2026-06-05) [1차] https://www.npmjs.com/package/embedded-postgres . Paperclip이 같은 경로(로컬 embedded → 외부 PG)를 운영합니다 [1차]. SQLite는 범위 겹침 제약을 트리거로 만들어야 하고 자체 호스팅 시 방언 이중 유지가 생깁니다. PGlite는 단일 연결이고 `dumpDataDir()` 복원 호환이 보장되지 않습니다 [1차] https://pglite.dev/docs/api . drizzle-orm은 Apache-2.0 [1차] https://registry.npmjs.org/drizzle-orm/latest . |
| 위험 | `embedded-postgres`가 beta 버전입니다. 바이너리에 `pgvector`·`pg_dump`가 들어 있는지 [미확인]입니다(스파이크 S-1, S-7 → 09). |

### ADR-005 그래프 저장소: 같은 PostgreSQL의 사실 테이블 + 질의 계층
| 항목 | 내용 |
|---|---|
| 결정 | 세계관 온톨로지(엔티티, 이름, 언급, 사실, 스키마, 용어집, 시간선, 동일성 결정)를 ADR-004와 같은 PG 데이터베이스의 테이블로 둡니다. 그래프 탐색은 1~3홉 조인과 재귀 CTE로 하고, 모든 접근은 `OntologyRepository` 포트를 거칩니다. 시간 범위·개수 제약은 범위 타입(`int4range`)과 `btree_gist` `EXCLUDE` 제약으로 DB가 강제합니다(예: 같은 칭호의 보유 기간 겹침 금지). |
| 대안 A | LadybugDB(Kuzu 포크, MIT, 임베디드 Cypher, v0.22.0 2026-10-25) [1차] https://github.com/LadybugDB/ladybug/releases . 마이너 버전마다 저장소 형식이 바뀌어 export/import 이전이 필요하고, READ_WRITE 프로세스가 하나이며, 벡터·FTS 확장을 런타임에 내려받습니다 [1차] https://docs.ladybugdb.com/migrate/ . **원천이 아니라 파생 읽기 모델 후보**로 둡니다. |
| 대안 B | SQLite + FTS5 + `sqlite-vec`. 백업은 가장 단순하지만 범위 제약을 트리거로 구현해야 하고 자체 호스팅에 불리합니다. |
| 제외 | Kuzu(2025-10-10 아카이브) [1차] https://github.com/kuzudb/kuzu , Memgraph(BSL이 제3자 배포·임베드 금지) [1차] https://github.com/memgraph/memgraph/blob/master/licenses/BSL.txt , FalkorDB(SSPLv1, redis 자식 프로세스) [1차] https://github.com/FalkorDB/FalkorDB , Neo4j Community(JVM 서버, GPLv3, 온라인 백업은 Enterprise) [1차] https://neo4j.com/docs/operations-manual/current/introduction/ , CozoDB(2023-12 이후 릴리스 없음) [1차], SurrealDB(BSL, 비표준 질의어) [1차], Oxigraph(Node판 메모리 전용) [1차], DuckPGQ(연구 단계) [1차]. 출처 상세는 → 06 엔진 선택 절. |
| 이유 | R-18(FR-ONT-12~18)의 핵심은 그래프 탐색이 아니라 불변 ID, 시간 범위, 개수 제약, 병합 이력, 트랜잭션 일관성입니다. 답변 반영(질문·반영 기록)과 사실 쓰기, 병합·분리의 참조 이동을 한 트랜잭션으로 처리할 수 있습니다. 백업·업그레이드 경로가 하나입니다(NFR-REL-04·05). 규모(500화, 엔티티 수천 개, 언급 10만 건 안팎, 가정)에서는 처리량이 병목이 아닙니다(가정). |
| 재검토 조건 | (1) 스파이크 S-4a(MA-2 말, 합성 데이터) 또는 S-4b(MB-3, 실제 작품 데이터)에서 한 화 컨텍스트 구성 p90이 10초를 넘고 인덱스 조정으로 해결되지 않음(NFR-PERF-04). (2) v1 관계도(FR-ONT-08, FR-UI-05b)에서 3홉 이상 탐색·그래프 알고리즘이 p90 2초(가정)를 넘음. (3) S-2(범위 배타 제약)·S-6(병합 트랜잭션)이 실패. (1)(2)면 PG를 원천으로 두고 확장 1(LadybugDB 또는 Apache AGE 파생 읽기 모델, `research/graph-store-recommendation.md` 3절)을 검토합니다. Apache AGE는 v1에 넣지 않고, 그래프 부하가 NFR-PERF-04를 위협할 때만 확장 1에서 검토합니다. (3)이면 이 ADR을 다시 엽니다. |
| 사용자 확인 | 2026-10-28 사용자 확인 완료(D-8 확정). 로컬은 `embedded-postgres`, 자체 호스팅은 외부 PG, 테스트는 PGlite(ADR-004). Neptune은 채택하지 않습니다. Obsidian은 원본 저장소로 쓰지 않습니다. v1 범위에 DB → vault 단방향 멱등 설정집 내보내기와 vault 가져오기(화이트리스트 YAML 필드만 `candidate`, 출처 "vault 편집", 승인 게이트)를 둡니다. 수동 동기화 버튼·배치, 파일 직접 읽기·쓰기, 어댑터 `ObsidianVaultExporter`·`ObsidianVaultImporter`(그래프 저장소 어댑터와 분리). 실시간 파일 감시는 v1 이후입니다(→ `research/graph-store-recommendation.md` 4절). 스파이크 S-1~S-9 조건은 그대로 둡니다 |
| PRD 영향 | PRD 1.3절 "단일 원천은 Graph DB", 11절 Graph DB 행 "원천은 Graph DB"를 "그래프 데이터 모델(엔티티·관계·사실)을 관계형 저장소에 표현하고 `OntologyRepository` 뒤에 둠"으로 고쳤습니다(PRD v0.5). 제품 문구 "Graph DB"는 "세계관 그래프"로 읽습니다(→ 01 6절 P-01, 해석 → 01 3.1 I-01). FR-SET-03의 "Graph DB 상태" 점검은 온톨로지 무결성 점검(`health_check_kind=ontology_integrity`)으로 구현합니다(→ 01 6절 P-02, PRD v0.5 반영). PRD 5.7절 "Graph DB 손상" 행은 `pause_reason=ontology_integrity`로 읽습니다. |

### ADR-006 엔티티 ID 기반 식별 계층
| 항목 | 내용 |
|---|---|
| 결정 | 엔티티는 불변 ID(`ent_…`)로만 식별합니다. 이름은 `EntityName` 행이고, 행마다 이름 유형·작중 유효 범위·시간선·아는 인물 범위를 가집니다. 원고·답변 속 표기는 `Mention`으로 기록하고 링커(L0~L8)가 후보 생성 → 문맥 판별 → 신뢰도 → 확정/질문 순서로 연결합니다. 사실·관계·떡밥·씬 등장·IR은 `entity_id`만 참조합니다. 자동 병합은 하지 않고, 병합·분리는 `IdentityDecision` 제안 → 확인 → 적용 → 되돌리기 가능 이력으로 처리합니다. 유형·관계는 `OntologySchema` 통제 어휘에서만 고르고, 새 유형은 `SchemaChangeProposal`로 승인받습니다. |
| 대안 | 이름 문자열 노드 + 임베딩 유사도(D-27 (a)) |
| 이유 | 조사한 GraphRAG 구현은 이름 문자열로 동일성을 정합니다. MS GraphRAG는 `groupby(title, type)` [1차] https://github.com/microsoft/graphrag , LightRAG는 이름 정확 일치 [2차]입니다. 이 방식은 동명이인·칭호를 합치고 별칭·위장명을 가릅니다. Graphiti는 정확 일치 후보가 하나면 바로 해소하고 퍼지 정규화가 영문·숫자 외 문자를 지워 한글에는 퍼지 단계가 사실상 동작하지 않습니다 [1차, main 소스 요약 기준, 채택 전 재확인 필요] https://github.com/getzep/graphiti . |
| 차용 | Graphiti: 작중 시간/기록 시간 분리, 후보 검색 → LLM 판별(닫힌 후보 + `NIL`/`UNSURE`) → 결정적 쓰기, 엣지 중복 검사를 같은 엔티티 쌍으로 한정 [1차] https://arxiv.org/html/2501.13956 . SKOS: 대표명 1개 규칙, 이름 분류(prefLabel/altLabel/hiddenLabel) [1차] https://www.w3.org/TR/skos-reference/ . SHACL: 정의역·치역·개수 검증과 3단계 심각도 [1차] https://www.w3.org/TR/shacl/ . Wikidata: 칭호 보유 기간(P580/P582), "과거에 참"과 "틀림"의 구분 [1차] https://www.wikidata.org/wiki/Help:Ranking . 표준은 개념만 차용하고 RDF 직렬화·OWL 추론·`owl:sameAs` 전이 병합은 쓰지 않습니다. |
| 결과 | 상세 → 06. 임계값 초기값은 7절(가정, 골든셋 보정). |

### ADR-007 사실의 bitemporal 표현
| 항목 | 내용 |
|---|---|
| 결정 | 사실은 두 시간 축을 가집니다. **작중 유효 시간**: `timeline_id` + `story_range`(`int4range`, 5.5절). **기록 시간**: `fact_versions.recorded_at` / `superseded_at`(UTC). 사실 ID(`fct_…`)는 불변이고 내용 변경은 새 `FactVersion`을 추가합니다(append-only). "과거에 참이던 사실"은 `story_range` 상한을 닫아 표현하고, "틀린 사실"은 `canon_status=retracted`로 표현합니다. "새 정보가 참" 자동 무효화는 하지 않습니다. |
| 대안 | 단일 시간 축(최신 값 덮어쓰기), Graphiti식 새 정보 우선 무효화 |
| 이유 | FR-ONT-02(작중 시점·시간선), FR-ONT-09(변경 이력·되돌리기), FR-ONT-04(다중 시간선)를 함께 만족합니다. 회상·거짓말·오해 서술과 다중 시간선은 "최신이 참" 규칙과 충돌합니다(조사 파일 1.2절). |
| 결과 | 질의 "N화·시간선 T에서 참인 캐논"과 "기록 시각 t에 시스템이 알던 캐논"을 모두 지원합니다. 상세 → 06. |

### ADR-008 모듈 계층 `adapters → application → domain`
| 항목 | 내용 |
|---|---|
| 결정 | 서버 기능은 `apps/server/src/modules/<module>/{domain,application,adapters}`로 나눕니다. `domain`은 I/O 없는 타입·불변식·상태 전이 함수, `application`은 유스케이스와 포트(인터페이스), `adapters`는 DB·HTTP·메신저·LLM 구현입니다. 의존은 바깥에서 안쪽으로만 갑니다. 모듈 사이 호출은 상대 모듈의 `application` 공개 API(`index.ts`)나 도메인 이벤트로만 하고, 다른 모듈 테이블을 직접 조회하지 않습니다. 경계는 검사 스크립트로 CI에서 강제합니다. |
| 대안 | 평면 `services/` (Paperclip 현재 구조) |
| 이유 | Paperclip의 거대 파일(`heartbeat.ts` 4,171줄, `issues.ts` 13,875줄)과 평면 services가 경계를 흐립니다 [1차]. 지도 보고서가 새 제품은 `modules/` 육각형 구조로 시작하라고 권합니다. |
| 결과 | 모듈 목록은 4절, 경계 검사·디렉터리 상세는 → 08. |

### ADR-009 실행 모델: wake queue·run 분리·CAS lease
| 항목 | 내용 |
|---|---|
| 결정 | 트리거(`WakeRequest`)와 실행(`Run`)을 분리합니다. 깨우기 요청은 `idempotency_key`로 중복을 막고 같은 작업의 대기 요청을 합칩니다(coalescing). 작업 잠금은 조건부 UPDATE 한 문장(CAS)으로 `tasks.lease_run_id`·`lease_expires_at`을 잡습니다. 실행은 주기적으로 임대를 갱신하고, 만료된 임대는 실행 종료를 확인한 뒤 회수합니다. 외부 호출 응답은 `provider_calls`에 먼저 저장하고 그다음 결과에 반영합니다. |
| 대안 | `SELECT … FOR UPDATE` 장기 잠금, 외부 큐(Redis·BullMQ) |
| 이유 | Paperclip checkout은 CAS UPDATE로 획득하고 `FOR UPDATE`는 stale 회수에만 씁니다 [1차, `issues.ts:11906`, 7606]. 단일 PG로 큐까지 처리하면 로컬 설치에 프로세스를 늘리지 않습니다(ADR-002). FR-AGT-02의 재시작 조건(재큐, 응답 재사용, 원장 중복 0건, `unknown_cost`)을 DB 트랜잭션으로 보장합니다. |
| 결과 | 상세 → 04. 상태 enum은 6절, 전이는 → 03 4절. |

### ADR-010 LLM 어댑터 SPI와 역할별 모델 혼합
| 항목 | 내용 |
|---|---|
| 결정 | 자체 `LlmAdapter` 포트(호출 1회 = 요청·구조화 출력 스키마·출력 토큰 상한 → 응답·사용량·오류 분류)를 정의하고, 구현은 Vercel AI SDK(`ai` + `@ai-sdk/*`) 위에 둡니다. 작품마다 `RoleModelBinding`으로 역할별 공급자·모델·`max_output_tokens`를 정합니다. 출력 토큰 상한이 없는 호출은 만들 수 없습니다(FR-BUD-03). 대체 모델은 v1, 기본 끔(D-21). |
| 대안 | Paperclip adapter SPI 재사용, 공급자 1개 고정 |
| 이유 | Paperclip adapter SPI는 외부 코딩 CLI 프로세스를 한 번 실행하는 계약이라 LLM API 호출 계약으로 맞지 않습니다 [1차, `adapter-utils/src/types.ts`]. Paperclip도 직접 호출에는 AI SDK를 씁니다 [1차]. D-9 확정. `testEnvironment`, `errorFamily`, `retryNotBefore`, `usageBasis` 아이디어만 차용합니다. |
| 결과 | SPI 상세 → 04, 공급자 선택 → 08. |

### ADR-011 메신저: Telegram → Discord, Vercel Chat SDK + 자체 내구성 계층
| 항목 | 내용 |
|---|---|
| 결정 | MVP-α는 Telegram 1:1, MVP-β는 Discord 스레드(D-7). 공급자 접속은 Vercel Chat SDK(`chat`, `@chat-adapter/telegram`, `@chat-adapter/discord`, MIT)를 npm으로 직접 의존합니다. 내구성(수신함·발신함·중복 방지·rate limit 재시도·Gateway 감독)은 자체 테이블(`messenger_inbox`, `messenger_outbox`)로 구현합니다. Telegram은 `local_trusted`에서 long polling, `self_hosted`에서 webhook + `secret_token`. 웹 인박스는 `channel_kind=web`인 상시 채널입니다(FR-MSG-12). |
| 대안 | Paperclip chat 서비스(81k줄) 차용, 메신저 API 직접 구현 |
| 이유 | `@chat-adapter/*`는 Vercel Chat SDK이고 MIT, Paperclip 고정 4.39.0, latest 4.43.0 [1차] https://registry.npmjs.org/chat . Paperclip chat 서비스는 issue·run·agent에 결합돼 있습니다 [1차]. 업스트림 Telegram polling은 `update_id` 중복 검사가 없고 offset을 메모리에만 두며 처리 전에 offset을 넘기고, Discord Gateway는 180초 제한이 있고 REST 429를 따로 처리하지 않습니다 [1차, `dist/index.js`]. 이 빈틈을 자체 계층이 메웁니다. |
| 결과 | 상세 → 05. SDK 4.40~4.43 변경 내역은 [미확인](→ 09 스파이크). |

### ADR-012 미디어 모델 중립 IR
| 항목 | 내용 |
|---|---|
| 결정 | 샷마다 `ScenePromptIR`(버전 행, 구조화 JSON)을 만들고, 공급자별 텍스트는 `RenderedPrompt`로 따로 저장합니다. IR의 시각 속성은 사실 버전 ID를 출처로 가집니다(FR-SPX-03). 이미지·영상 공급자는 어댑터로 교체합니다. |
| 대안 | 공급자별 프롬프트를 직접 저장 |
| 이유 | 이미지·영상 모델 교체 주기가 몇 개월 단위이고 Veo 3.1 Preview·Sora 2가 이미 종료됐습니다(PRD 11절, R-9). D-10 확정. |
| 결과 | 상세 → 07 확장 파이프라인. v1부터 구현, MVP는 씬 데이터의 확장 가능성만 보장(NFR-EXT-02). |

### ADR-013 enum은 text + CHECK, 정의는 `packages/shared` 한 곳
| 항목 | 내용 |
|---|---|
| 결정 | 모든 enum은 `packages/shared/src/enums.ts`에 `as const` 배열로 정의하고, 여기서 TypeScript 타입·zod 스키마·한국어 표시 라벨을 파생합니다. DB에는 PG `ENUM` 타입이 아니라 `text` + `CHECK (col IN (…))`로 저장합니다. 값의 추가·삭제는 이 문서 6절을 먼저 고친 뒤 마이그레이션으로 CHECK를 바꿉니다. |
| 대안 | PG `CREATE TYPE … AS ENUM` |
| 이유 | PG enum은 값 삭제·순서 변경이 어렵습니다. Paperclip의 const-array enum → 타입/zod/label 패턴을 따릅니다(지도 8절). |

### ADR-014 질문과 승인을 별도 객체로 두고 1:1 연결
| 항목 | 내용 |
|---|---|
| 결정 | `Approval`은 게이트와 결정 기록(결정자, 시각, 사유, 반려 시 `rework_from`)을 소유하고, 사람에게 묻는 일은 `question_type=approve_reject`, `grade=blocking`인 `Question` 하나가 맡습니다. `approvals.question_id`는 유일합니다. 질문에 답하면 같은 트랜잭션에서 승인이 결정됩니다. |
| 대안 | 승인을 질문의 한 유형으로만 표현, Paperclip `approvals`만 사용 |
| 이유 | PRD 4절 정의(승인 요청은 질문으로 전달, 결정 기록은 승인 객체)와 FR-HIL-02를 그대로 구현합니다. 질문 쪽 상태(발송·리마인더·경합)와 게이트 쪽 상태(결정)를 분리합니다. |

### ADR-015 원고 본문은 DB, 바이너리는 파일 저장소
| 항목 | 내용 |
|---|---|
| 결정 | 원고 버전 본문, IR, 프롬프트는 PG `text`/`jsonb`. 이미지·영상·내보내기 파일·실행 로그 원문·백업은 `StorageProvider`(MVP `local_disk`, 이후 S3 호환) 아래 파일로 두고 DB에는 저장 키와 해시만 둡니다. |
| 이유 | 원고는 diff·검색·트랜잭션 대상이고 화당 수십 KB입니다. 미디어는 즉시 내려받아 보관해야 합니다(FR-IMG-04, FR-VID-07). Paperclip storage provider 패턴을 차용합니다. |

### ADR-016 금액은 micro-USD 정수
| 항목 | 내용 |
|---|---|
| 결정 | 모든 금액 컬럼은 `bigint`, 단위 micro-USD(1 USD = 1,000,000), 컬럼 접미사 `_micros`입니다. 통화는 USD 하나입니다. 표시할 때만 소수로 바꿉니다. |
| 대안 | `numeric(24,7)` cents(Paperclip), 부동소수 |
| 이유 | 이미지 1장 0.006 USD 수준 단가(PRD 11절)를 반올림 없이 더하고, JS에서 정수로 비교합니다. |

### ADR-017 감사 로그 순번을 실시간 이벤트 ID로 사용
| 항목 | 내용 |
|---|---|
| 결정 | `activity_log.seq`(bigint, 단조 증가)를 실시간 이벤트 ID로 씁니다. 상태 변경 트랜잭션 안에서 감사 로그를 쓰고, 커밋 후 발행합니다. UI·웹소켓은 마지막 `seq` 이후를 다시 받아(replay) 재연결 공백을 메웁니다. |
| 대안 | 프로세스 메모리 카운터(Paperclip) |
| 이유 | Paperclip 실시간 이벤트 ID는 메모리 카운터라 재시작 시 0부터 시작하고 replay가 없습니다 [1차, `live-events.ts`]. 메신저·UI를 함께 쓰는 FR-UI-08(p95 5초)에 replay가 필요합니다. |
| 결과 | 상세 → 02. |

### ADR-018 ID 형식: 접두사 + ULID
| 항목 | 내용 |
|---|---|
| 결정 | 모든 주 키는 `<접두사>_<ULID>` 텍스트입니다(5.1절). 앱이 생성하고 DB는 형식만 검사합니다. 사람용 번호(`Q-128`)는 별도 `display_no`입니다. |
| 대안 | `bigserial`, UUIDv4, UUIDv7 |
| 이유 | 로그·메신저 버튼 데이터·감사 로그에서 ID만 보고 종류를 알 수 있습니다. ULID는 시간 정렬됩니다. 작품 패키지 이동(FR-MAN-06b) 때 키 충돌이 없습니다. |

---

## 4. 패키지·모듈 구성 개요

상세(디렉터리 트리, 빌드, 경계 검사)는 → 08.

### 4.1 패키지

| 패키지 | 책임 |
|---|---|
| `apps/server` | HTTP API, 웹소켓, 스케줄러, 실행 worker, 메신저 수신. `local_trusted`에서 단일 프로세스 |
| `apps/web` | 웹 대시보드·인박스·에디터(React) |
| `apps/cli` | `onboard`, `doctor`, `run`, `service`, `backup`, `restore`, `migrate`, `config`, `secrets`, `eval` 명령. [v1] `export`, `import`(명령 상세 → 08 5.5) |
| `packages/shared` | enum 레지스트리(6절), ID 유틸(5.1절), zod DTO, 한국어 라벨 |
| `packages/db` | drizzle 스키마, 마이그레이션, embedded/external PG 런타임, 백업 라이브러리 |
| `packages/test-kit` | 골든 테스트셋(시드 유형 G01~G22, → 06), 픽스처, 가짜 LLM·메신저 어댑터 |

### 4.2 서버 모듈 (`apps/server/src/modules/`)

| 모듈 | 책임 | 주 문서 |
|---|---|---|
| `novel` | `Novel`, `Goal`, `SeriesBible`, `Arc`, 작품 설정, 분량 프로필 | 03 |
| `concept` | `ConceptSession`, `ConceptMessage`, `ConceptBrief`, 슬롯 갱신 가드(INV-CON-03), 다음 질문 선택, 승인 트랜잭션 반영(M-01~M-05), 공통 질문 세트·[MVP-β/v1] 장르 템플릿 합성기 | 11 |
| `manuscript` | `Episode`, `ManuscriptVersion`, `Scene`, 반려, 글자 수, 공개 처리 | 03, 07 |
| `ontology` | `Entity`, `EntityName`, `Fact`/`FactVersion`, `Timeline`, `OntologySchema`, `Glossary`, `IdentityDecision`, `OntologyRepository` | 06 |
| `linking` | `Mention`, 링커 L0~L8, 중복 후보 탐지. `mentions` 쓰기·질의 구현은 `ontology`의 `OntologyRepository`(`writeMentions`)를 거칩니다(→ 06 2.2, 11.4) | 06 |
| `continuity` | `ContinuityIssue`, 연속성·스키마 제약·인물 지식 검사 실행 | 06, 07 |
| `foreshadow` | `Setup`, `SetupBeat`, `SetupDueChange`, 떡밥 검사, 기한 추적 | 06, 07 |
| `orchestration` | `Task`, `Run`, `WakeRequest`, lease, 스케줄러, 고아 회수, 일시정지 | 04 |
| `agents` | 역할 정의, 프롬프트 템플릿 버전, `ContextSnapshot` 구성, 출력 검증 | 04 |
| `llm` | `LlmAdapter` 포트와 구현, `ProviderCall`, `RoleModelBinding` | 04 |
| `hitl` | `Question`, `Answer`, `AnswerInterpretation`, `AnswerReflection`, `Approval`, 등급 판정, digest, 마감·리마인더 | 05 |
| `messaging` | `Channel`, `MessengerBot`, 바인딩, 수신함·발신함, Telegram·Discord·web 어댑터 | 05 |
| `budget` | `BudgetPolicy`, `BudgetReservation`, `CostEvent`, 하드 한도 일시정지 | 03, 04 |
| `audit` | `ActivityLog` 기록, redaction, 커밋 후 발행, 실시간 replay | 02, 03 |
| `media` [v1] | `Shot`, `ScenePromptIR`, `RenderedPrompt`, `MediaQuote`, `MediaAsset`, `VisualReference`, 이미지·영상 어댑터 | 07 |
| `export` | TXT/MD 내보내기(MVP), DOCX/EPUB·작품 패키지(v1) | 07 |
| `system` | 설정 로딩, 비밀, 저장소, 백업·복원, 연결 점검, 마이그레이션 게이트 | 02, 08 |

---

## 5. 명명 규칙

### 5.1 ID 형식

- 형식: `<prefix>_<ULID>`. ULID는 26자 Crockford Base32 대문자. 예: `epi_01JCXZ8Q4M7R2V5K9T3B6N1H0D`.
- DB 타입 `text`, `CHECK (id ~ '^<prefix>_[0-9A-HJKMNP-TV-Z]{26}$')`.
- 바뀌지 않습니다. 병합된 엔티티 ID도 지우지 않습니다(FR-ONT-16).

| 접두사 | 타입 | 접두사 | 타입 | 접두사 | 타입 |
|---|---|---|---|---|---|
| `usr` | `User` | `qst` | `Question` | `ent` | `Entity` |
| `nov` | `Novel` | `qdl` | `QuestionDelivery` | `enm` | `EntityName` |
| `gol` | `Goal` | `ans` | `Answer` | `mnt` | `Mention` |
| `bib` | `SeriesBible` | `itp` | `AnswerInterpretation` | `fct` | `Fact` |
| `arc` | `Arc` | `arf` | `AnswerReflection` | `fcv` | `FactVersion` |
| `epi` | `Episode` | `apr` | `Approval` | `tln` | `Timeline` |
| `mnv` | `ManuscriptVersion` | `dgb` | `DigestBatch` | `osv` | `OntologySchemaVersion` |
| `erj` | `EpisodeRejection` | `chn` | `Channel` | `scp` | `SchemaChangeProposal` |
| `scn` | `Scene` | `bot` | `MessengerBot` | `gls` | `GlossaryTerm` |
| `tsk` | `Task` | `bnd` | `ChannelBindingToken` | `idd` | `IdentityDecision` |
| `run` | `Run` | `inb` | `MessengerInbox` | `sht` | `Shot` |
| `wak` | `WakeRequest` | `obx` | `MessengerOutbox` | `pir` | `ScenePromptIR` |
| `pcl` | `ProviderCall` | `bgp` | `BudgetPolicy` | `rpr` | `RenderedPrompt` |
| `ctx` | `ContextSnapshot` | `rsv` | `BudgetReservation` | `mqt` | `MediaQuote` |
| `cis` | `ContinuityIssue` | `cst` | `CostEvent` | `ast` | `MediaAsset` |
| `stp` | `Setup` | `act` | `ActivityLog` | `vrf` | `VisualReference` |
| `sbt` | `SetupBeat` | `prv` | `ProviderProfile` | `lpf` | `LengthProfile` |
| `sdc` | `SetupDueChange` | `rmb` | `RoleModelBinding` | `exp` | `ExportJob` |
| `ntp` | `NotificationPolicy` | `bkp` | `BackupRecord` | `hck` | `HealthCheckResult` |
| `ase` | `AnswerSession` | `rcp` | `EpisodeRecap` | `nfr` | `NarrativeFrame` |
| `cns` | `ConceptSession` | `cnm` | `ConceptMessage` | `cbf` | `ConceptBrief` |

### 5.2 표시 번호 (`display_no`)

사람이 부르는 번호는 작품 안 순번이고 ID와 별개입니다. `novel_counters(novel_id, counter_kind, last_value)`에서 발급합니다.

| 대상 | 형식 | 예 |
|---|---|---|
| 질문 | `Q-<n>` | `Q-128` |
| 떡밥 | `S-<n:02>` | `S-01` |
| 연속성 이슈 | `CI-<n>` | `CI-17` |
| 작업 | `T-<n>` | `T-203` |
| 화 | `<episode_no>화` (번호 자체가 표시 번호) | `12화` |
| 씬 | `<episode_no>화 씬<ord>` / `E12.S3` | `12화 씬3` |
| 샷 | 씬 안 `SH<ord>` | `SH2` |

### 5.3 테이블·컬럼

| 대상 | 규칙 | 예 |
|---|---|---|
| 테이블 | 복수형 snake_case. 예외: `activity_log`(Paperclip 차용 이름) | `episodes`, `entity_names` |
| 주 키 | `id` | — |
| 외래 키 | `<단수형>_id` | `episode_id`, `linked_entity_id` |
| 테넌트 키 | 작품 소속 테이블은 모두 `novel_id NOT NULL` | → 03 2절 |
| 불리언 | `is_`/`has_` 접두사 | `is_preferred` |
| 시각 | `<동사 과거분사>_at`, `timestamptz` | `approved_at` |
| 작중 위치 | `story_point`(정수), 범위는 `story_range`(`int4range`) | 5.5절 |
| 금액 | `<의미>_micros`, `bigint` | `amount_micros` |
| 개수 | `<대상>_count` | `rejection_count` |
| enum 컬럼 | enum 이름과 같은 컬럼명 또는 `status`/`kind` | `status`, `link_status` |
| JSON | `jsonb`, 이름에 접미사 없음. 구조는 zod 스키마로 검증 | `payload` |
| 버전 번호 | `version_no` (1부터, 대상별 단조 증가) | — |
| 공통 컬럼 | `created_at`, `updated_at`(변경 가능한 행만) | — |

### 5.4 이벤트·로그

| 대상 | 규칙 | 예 |
|---|---|---|
| 감사 로그 `action` | `<집합체>.<동작>` 소문자 snake_case, 동작은 과거형 | `episode.status_changed`, `question.answered` |
| 실시간 이벤트 | 감사 로그 `action`을 그대로 쓰고 `seq`를 ID로 사용(ADR-017) | — |
| 깨우기 `idempotency_key` | `<출처>:<대상 ID>:<구분자>` | `answer:ans_01…:tsk_01…` |
| 비용 `idempotency_key` | `pcl:<provider_call_id>` (호출당 원장 1행) | — |
| 메신저 수신 키 | `<channel_kind>:<bot_id>:<provider_event_id>` | `telegram:bot_01…:829331` |

이벤트 목록 → 03 6절.

### 5.5 시간 표기

| 대상 | 규칙 |
|---|---|
| 시스템 시각 | DB는 `timestamptz`로 UTC 저장. API는 ISO 8601 `Z` 표기. 화면·메신저는 작품의 `timezone`(기본 `Asia/Seoul`)으로 표시 |
| 방해금지·마감 | 작품 `timezone` 기준 벽시계로 설정하고 UTC로 계산해 저장 |
| 작중 시점 `story_point` | `episode_no × 1000 + scene_ord`. `scene_ord`는 화 안 씬 순서(1~999). `scene_ord=0`은 "그 화 시작 시점". `story_point=0`은 "1화 이전"(기획서 배경 설정) |
| 작중 범위 `story_range` | `int4range` 반열린 `[from, to)`. 상한 없음(`NULL`)은 "이후 계속". 예: 10화 끝까지 유효 = `[0, 11000)` |
| 시간선 | `timeline_id`로 표기. 작품마다 기본 시간선 1개(`timeline_kind=main`, 표시 `T1`) |
| 씬 재분할 | 씬 순서가 바뀌면 그 화의 `story_point`를 같은 트랜잭션에서 다시 계산합니다. 사실은 근거 `scene_id`를 함께 저장해 재계산할 수 있습니다(→ 06, 07). `published` 화는 재분할하지 않습니다. |

표기 예: "12화 씬3, 시간선 T2" = `story_point=12003`, `timeline_id=tln_…(T2)`.

---

## 6. 전역 enum 레지스트리

이 절이 모든 상태·유형 enum의 단일 출처입니다(ADR-013). **출처** 열: `PRD`=PRD가 값까지 정함, `설계`=이 문서에서 정함, `PRD+설계`=PRD 값에 설계가 값을 더함. **목업 차이** 열은 목업(`mockups-src/SPEC.md`, `screens/*.html`)의 임시 표기와 다를 때만 적습니다. 목업은 한국어 라벨만 썼으므로 라벨 대응을 함께 적습니다.

### 6.1 작품·목표

| enum | 값 (순서대로) — 의미 | 출처 | 목업 차이 |
|---|---|---|---|
| `novel_status` | `concept` 컨셉 합의 중(작품 생성 직후, `ConceptBrief` 승인 전. 맨 앞, D-39 확정, → 11 5.8); `onboarding` 목표·채널 설정 중; `planning` 기획서 작성·승인 대기; `serializing` 연재 중; `completed` 목표 화수 완결; `archived` 보관(실행 없음) | 설계 | — |
| `age_rating` | `all` 전체; `age_12`; `age_15`; `age_19`. MVP는 `age_15` 이하만 선택 가능 | 설계(D-13) | — |
| `autonomy_level` | `episode_approval` 화별 승인(기본); `arc_approval` 아크별 승인(MVP-β); `full_auto` 완전 자율(MVP-β); `co_writing` 공동 집필(v1) | PRD(FR-HIL-01a~c, D-3) | — |
| `question_threshold` | `minimal` 적게 묻고 추천안 우선; `normal` 보통(기본); `detailed` 자주 묻기. MVP는 `normal` 고정, 설정은 v1 | 설계(FR-HIL-06) | 목업 "보통" = `normal` |
| `media_autonomy` | `review_all` 모든 게이트 사람(기본); `quote_only` 견적·캐릭터 시트·안전 확인만 사람 | PRD(FR-SPX-09, D-25) | — |
| `media_target_basis` | `published` 공개 처리된 화(기본); `approved` 승인된 화; `arc_completed` 아크 완결 | 설계(FR-SPX-01, D-17) | — |
| `publish_policy` | `manual` 사람이 공개 처리; `batch_question` 주 1회 일괄 공개 질문; `scheduled` 연재 주기에 따른 예약 공개. `full_auto` 외 수준은 `manual`만 허용, `full_auto` 기본은 `batch_question` | 설계(6.3.1 표, D-24) | — |
| `count_basis` | `with_spaces` 공백 포함; `without_spaces` 공백 제외 | 설계(FR-NOV-04a) | — |
| `series_bible_status` | `draft`; `awaiting_approval`; `approved`; `superseded` 새 버전 승인으로 대체 | 설계 | — |
| `arc_status` | `planned` 생성됨; `plan_awaiting_approval` 아크 계획(떡밥 배치 포함) 승인 대기; `active` 집필 중; `awaiting_approval` 아크 승인 대기(`arc_approval`); `completed`; `cancelled` | 설계 | — |
| `pause_scope` | `novel`; `arc`; `task` | 설계(FR-HIL-03) | — |
| `concept_session_status` | `active` 대화 중; `awaiting_approval` 브리프 승인 대기; `paused` 보류; `approved` 종료(승인); `abandoned` 종료(폐기). 전이 CS1~CS9(→ 11 5.2) | 설계(11) | — |
| `concept_session_purpose` | `initial` 첫 컨셉; `revision` 개정 | 설계(11) | — |
| `concept_entry_mode` | `conversation` 대화(기본); `import` 붙여 넣기; `direct_input` 폼 직접 입력 | 설계(11, FR-NOV-09) | — |
| `concept_stage` | `opening` 시작 질문; `diverging` 발산; `converging` 수렴; `confirming` 요약 확인 | 설계(11) | — |
| `concept_pause_reason` | `user`; `idle` 휴면; `budget_limit` 세션 비용 상한 | 설계(11) | — |
| `concept_message_author` | `user`; `agent`; `system` 반려 사유·한도 안내·오류 | 설계(11, D-4) | — |
| `concept_message_kind` | `text` 자유 발화; `option_pick` 선택지 클릭; `form_edit` 폼 수정; `import_text` 붙여 넣기 원문; `question` 에이전트 질문; `notice` 시스템 안내 | 설계(11) | — |
| `concept_brief_status` | `awaiting_approval`; `approved`; `approved_direction` 기획서 승인 후 개정의 방향 합의(캐논·작품 설정은 아직 그대로, 기획서 개정 승인 때 `approved`, MVP-β); `rejected`; `superseded` 새 버전 승인으로 대체. 전이 CB1~CB8(→ 11 5.4) | 설계(11) | — |
| `concept_field_origin` | `user_stated` 사용자 발화(핵심 명사구가 인용 안에 있음); `user_edited` 사용자가 폼·패널에서 직접 수정; `agent_proposed_accepted` 에이전트 제안을 사용자가 그대로 고름; `agent_proposed_modified` 에이전트 제안을 사용자가 고쳐 받음; `agent_delegated` 사용자가 위임해 에이전트가 정함(확인 단계에서 확정); `template_default` 템플릿 기본값을 사용자가 받아들임; `imported` 붙여 넣기에서 추출 | 설계(11, D-4) | — |
| `concept_slot_state` | `empty`; `proposed` 확인 필요; `confirmed`; `deferred` 나중에(필수 슬롯은 불가) | 설계(11) | — |
| `concept_user_intent` | `delegate` 위임("알아서 해 줘" 류, [추천해 줘]와 같게 처리); `answer` 답; `revise` 앞서 정한 값 변경; `other`. `ConceptTurnProposal.user_intent`(→ 11 2.7) | 설계(11) | — |
| `character_age_band` | `child` 아동; `teen` 청소년; `adult` 성인; `unknown` 미확인(기본). 컨셉 브리프 인물 객체의 나이대. `child`·`teen`은 미성년(→ 11 5.4, 6.4) | 설계(11, NFR-SAFE-01) | — |
| `pause_reason` | `user` 사용자 일시정지; `budget_hard_limit` 하드 한도; `ontology_integrity` 온톨로지 무결성 실패(PRD 5.7절 "온톨로지 저장소 손상"); `maintenance` 업그레이드·복원·디스크 부족. 공급자 장애·키 만료는 일시정지 사유가 아니라 작업 차단입니다(`task_block_reason=provider_unavailable`, → 04 7.3) | 설계 | — |

### 6.2 원고

| enum | 값 — 의미 | 출처 | 목업 차이 |
|---|---|---|---|
| `episode_status` | `planned`; `outlining`; `drafting`; `checking`; `polishing`; `awaiting_approval`; `revising`; `approved`; `published` | PRD(FR-AGT-12) | 목업 "승인 대기" = `awaiting_approval` |
| `episode_block_reason` | `question` 차단형 질문 대기; `approval` 승인 대기 외 게이트; `budget` 하드 한도; `continuity_issue` 열린 높음 이슈; `setup_check` 떡밥 배정 누락; `extraction_failure` 사실 추출 실패; `rewrite_limit` 재작성 상한 도달; `provider_unavailable` 공급자 장애. 상태가 아니라 표시(복수 가능) | PRD+설계(FR-AGT-12 "blocked: 질문·예산·이슈") | 목업 "12화 작업 정지" = `question` |
| `rework_from` | `outline` 아웃라인부터; `draft` 초고부터; `polish` 문장만 | PRD(FR-AGT-12) 값 이름은 설계 | — |
| `manuscript_version_kind` | `outline`; `draft`; `revision`; `final` 승인된 버전 | PRD(FR-MAN-01) 값 이름은 설계 | — |
| `scene_status` | `active`; `retired` 재분할로 소멸(ID는 보존, 이력 조회용) | 설계 | — |
| `scene_participation` | `present` 등장; `mentioned` 언급만; `flashback` 회상 속 등장 | 설계 | — |
| `narration_mode` | `first_person` 1인칭; `third_limited` 3인칭 제한 시점; `third_omniscient` 3인칭 전지 시점. 씬 필드 `scenes.narration_mode`(07 씬 분할이 채움)와 작품 기본값 `novels.default_narration_mode`가 씁니다. 둘 다 없으면 `pov_entity_id`가 있을 때 `third_limited`로 봅니다(→ 06 3.3). `novels.default_narration_mode`의 생성 시 기본값은 7.3 `novel.default_narration_mode`입니다 | 설계 | — |
| `recap_layer` | `canon` 캐논 층(캐논 층 역할용); `reader` 독자·시점 층(`writer`·`line_editor`용). `episode_recaps.layer`(→ 03 3.2, 04 9.3) | 설계(FR-AGT-04, FR-ONT-17) | — |

### 6.3 에이전트·작업·실행

| enum | 값 — 의미 | 출처 | 목업 차이 |
|---|---|---|---|
| `agent_role` | `concept_partner` 컨셉 대화(기본 탑재, 끌 수 없음, D-28, → 11); `showrunner`; `planner`; `world_keeper`; `writer`; `continuity_editor`; `foreshadow_manager`; `line_editor`; `scene_director`(확장); `visual_producer`(확장) | PRD(4.1절, v0.4 `concept_partner` 추가) | — |
| `task_kind` | `concept_turn` 컨셉 대화 턴(`concept_partner`, → 11 2.5); `import_concept` 붙여 넣기 추출(`concept_partner`); `check_concept_brief` 승인 요청 전 점검(`continuity_editor`); `plan_series_bible`; `build_initial_ontology`; `plan_arc`; `plan_setups`; `outline_episode`; `draft_episode`; `extract_facts`; `link_mentions`; `check_continuity`; `check_setups`; `polish_episode`; `split_scenes`; `revise_episode`; `check_text_safety` 텍스트 안전 검사(`continuity_editor`, → 07 5.6); `plan_rework` 반려 후 재작성 계획(`showrunner`, → 07 8.1); `interpret_answer`; `apply_answer`; `review_setup_due`; `schedule_episodes`; `grade_question`; `dedupe_entities`; [v1] `split_shots`; `build_prompt_ir`; `classify_safety`; `render_prompts`; `generate_character_sheet`; `generate_keyframes`; `generate_illustrations`; [v2] `generate_clips`; `assemble_scene_video`; `edit_trailer` | 설계 | — |
| `target_type` | `novel`; `goal`; `arc`; `episode`; `scene`; `shot`; `setup`; `entity`; `question`; `concept_session` (`ref_type`의 부분집합) | 설계(FR-AGT-01) | — |
| `task_status` | `pending` 선행 작업·게이트 대기; `ready` 실행 가능; `running` 임대 보유 실행 중; `blocked` 사람·예산·장애 대기; `done`; `failed` 재시도 상한 초과(사람 조치 필요); `cancelled` | 설계 | 목업 "완료"=`done`, "실행 중"=`running`, "답변 대기"=`blocked`(`question`) |
| `task_block_reason` | `question`; `approval`; `budget` 실지출 기준 하드 한도 초과; `budget_reservation_wait` 다른 실행의 활성 예약 때문에 예약 대기(정지·질문 없음, → 04 8.3); `provider_unavailable`; `rewrite_limit`; `continuity_issue` | 설계 | — |
| `run_status` | `queued` 깨우기를 받아 슬롯·예약 대기; `running`; `succeeded`; `failed`; `cancelled`; `interrupted` 프로세스 종료·임대 만료로 회수됨 | 설계 | — |
| `run_stop_reason` | `completed`; `paused` 안전 지점 정지; `cancelled_by_user`; `budget_blocked`; `awaiting_human` 질문·승인 생성 후 종료; `lease_lost`; `error`; `superseded` 대상 작업이 대체됨 | 설계 | — |
| `error_family` | `provider_unavailable`; `auth_failed`; `quota_exhausted` 잔액·쿼터 부족; `rate_limited`; `content_filtered`; `invalid_output` 형식 검증 실패; `timeout`; `budget_blocked`; `internal` | 설계(5.7절 오류 유형 분류) | — |
| `wake_reason` | `schedule`; `task_created`; `dependency_done`; `question_answered`; `approval_decided`; `budget_resumed`; `budget_released` 다른 예약 정산·해제로 예약 대기 작업 재개(→ 04 8.3); `user_resume`; `retry`; `reclaim` | 설계 | — |
| `rework_cause` | `check` 검사 게이트 재작성(E4·E5); `rejection` 반려·수정 요청 뒤 `plan_rework`가 만든 후속 작업(→ 07 8.1). `tasks.input.rework_cause`에 저장하고 비용 집계 차원으로 씁니다(→ 04 TC-5, 8.6) | 설계(FR-BUD-05) | — |
| `wake_status` | `pending`; `claimed`; `coalesced` 다른 요청에 합쳐짐; `discarded` 대상 취소·무효 | 설계 | — |
| `provider_kind` | `llm`; `image`; `video` | 설계 | — |
| `provider_call_status` | `prepared` 예약 완료·미발송; `sent` 발송됨·응답 대기; `responded` 응답 저장됨; `failed` 공급자 오류 응답; `unknown` 발송 후 응답 미수신(재시작 등); `responded_late` `unknown`으로 닫힌 뒤 응답 도착·저장(원장은 정정 행, 응답 재사용 대상, → 04 6.2 P7); `abandoned` 발송 전에 실행이 끝남(일시정지·취소·임대 상실), 예약 `released`, 행은 미발송 기록으로 보존 | 설계(FR-AGT-02) | — |

### 6.4 질문·답변·승인

| enum | 값 — 의미 | 출처 | 목업 차이 |
|---|---|---|---|
| `question_grade` | `blocking`; `non_blocking`; `informational` | PRD | — |
| `question_type` | `single_choice`; `multi_choice`; `free_text`; `approve_reject`; `attachment_review` | PRD(FR-MSG-01) | — |
| `question_status` | `pending` 생성됨·발송 대기(digest·방해금지·상한·채널 장애); `open` 하나 이상 채널(웹 포함)에 게시됨·답변 대기; `answered` 첫 유효 답변 채택·반영 진행 중; `defaulted` 비차단형 마감 경과로 사람 답 없이 종결 처리 중. 추천안 적용(`resolution_source=default_applied`)과 적용 없는 보류(`resolution_source=deadline_hold`)를 `resolution_source`로 구분; `resolved` 반영 기록 완료(`applied` 또는 `not_applied`+사유); `cancelled` 대상 작업 취소·질문 무효 | 설계 | 목업 "답변 대기"=`open`, "발송됨"은 `question_delivery_state=posted`, "답변 완료(채널, 시각)"는 다른 채널의 `closed_elsewhere`, "늦은 답변"은 `answer_disposition=late` |
| `question_topic` | `direction` 작품·아크 방향; `bible_confirm`; `character_fate`; `creative_choice` 이름·지명 등 일반 창작 결정; `setup_due`; `setup_abandon`; `entity_disambiguation` 언급 판별; `duplicate_entity` 같은 대상 확인; `identity_change` 병합·분리; `schema_change`; `interpretation_confirm` 해석 확인; `followup` 후속 질문; `approval_gate` 승인 요청; `rewrite_limit`; `extraction_failure`; `budget`; `provider_outage`; `retcon`; `late_answer_conflict`; `publish_batch`; `concept_confirm` 컨셉 브리프 승인(→ 11 4.3); [v1] `media_gate`; `safety_review` | 설계 | — |
| `blocking_basis` | FR-HIL-07: `ending_direction`; `arc_goal`; `canon_change`; `major_character_fate`; `budget`. 설계 추가: `published_canon` 공개 사실 영향(FR-ONT-07, 14); `approval_gate`(FR-MSG-01); `rewrite_limit`(FR-AGT-12, FR-ONT-06); `setup_due_high`(FR-FOR-04); `safety_review`(FR-SPX-09); `system_failure` 추출 실패·장애 상한(5.7절); `none` 비차단·정보성 | PRD+설계 | 목업 "판정 기준 '주요 인물의 생사'" = `major_character_fate` |
| `resolution_source` | `user_answer`; `default_applied` 마감 경과, 추천안 자동 적용(`default_action=apply`); `deadline_hold` 마감 경과, 추천안을 적용하지 않고 보류(`default_action=hold` 주제, 반영 기록 `not_applied`, → 05 4.3); `absence_delegated` 부재 위임(v1); `notice_only` 정보성 전달로 종결 | 설계 | — |
| `question_delivery_state` | `pending`; `posted`; `answered_here` 이 채널에서 채택 답변 수신; `closed_elsewhere` 다른 채널 답변으로 "답변 완료" 갱신; `withdrawn` 질문 취소·무효로 메시지를 "취소됨"으로 갱신; `failed` | 설계(FR-MSG-18) | 목업 "발송됨"=`posted` |
| `answer_session_status` | `active` 다단계 입력 진행 중; `completed`; `expired` `answer_session.ttl_minutes` 경과; `cancelled` | 설계(→ 05 6.3) | — |
| `answer_disposition` | `accepted` 첫 유효 답변; `late` 닫힌 질문·이미 채택된 질문에 온 다른 답; `duplicate` 같은 답의 중복 수신 | 설계(FR-MSG-18) | 목업 "늦은 답변"=`late` |
| `late_answer_resolution` | `pending_user_choice` 인박스 표시, 사용자 선택 대기(MVP-α); `revision_task_created`; `retcon_question_created`; `no_change` 같은 결과; `dismissed` 사용자가 무시; `applied_to_hold` `deadline_hold`로 닫힌 질문의 늦은 답을 사용자가 보류 결정으로 확정(→ 05 6.2) | 설계(FR-MSG-08) | — |
| `interpretation_status` | `proposed` 해석안 생성; `confirmed` 사용자 확인; `corrected` 사용자 정정 후 확정; `rejected` 해석 기각; `needs_followup` 모호해 후속 질문 | 설계(FR-MSG-16) | — |
| `reflection_status` | `pending`; `applied`; `not_applied` 반영 대상 소멸 등, 사유 필수 | 설계(FR-MSG-09) | — |
| `reflection_change_kind` | `fact_created`; `fact_changed`; `constraint_created`; `task_created`; `task_changed`; `bible_changed`; `setup_changed`; `entity_name_rule` 이름 사전 규칙 등록; `schema_changed`; `no_change` | 설계(FR-MSG-09 (a)) | — |
| `approval_type` | `concept_brief` 컨셉 브리프 승인(모든 자율성 수준에서 사람, → 11 4.3); `series_bible`; `arc_plan`; `episode`; `arc`; `canon_change` 기존 `approved` 사실 변경; `retcon` `published_locked` 변경; `ending_change`; `budget_resume`; `setup_abandon`; `publish_batch`; `schema_change`; `identity_change` 공개 사실에 닿는 병합·분리; [v1] `character_sheet`; `media_quote`; `safety_review`; `draft_adoption` | 설계(6.3.1 표, FR-SPX-09) | — |
| `approval_status` | `pending`; `approved`; `rejected`; `cancelled`; `superseded` 같은 대상의 새 승인 요청으로 대체 | 설계 | 목업 "승인 대기"=`pending` |
| `digest_kind` | `non_blocking_digest`; `daily_summary`; `publish_batch`; [v1] `absence_summary` | 설계(FR-MSG-06) | — |
| `digest_status` | `collecting`; `sent`; `cancelled` | 설계 | — |

### 6.5 메신저

| enum | 값 — 의미 | 출처 | 목업 차이 |
|---|---|---|---|
| `channel_kind` | `telegram`(MVP-α); `discord`(MVP-β); `slack`(v1); `kakao`(이후); `web` 웹 인박스 | PRD(D-7) 값 이름은 설계 | — |
| `channel_status` | `pending_binding`; `active`; `degraded` 연결 점검 실패·발송 오류 누적; `disconnected` 봇 토큰 폐기·차단; `revoked` 사용자가 해제 | 설계 | — |
| `binding_token_status` | `issued`; `consumed`; `expired`; `revoked` | 설계(FR-MSG-02) | — |
| `telegram_receive_mode` | `polling`(`local_trusted` 고정, `self_hosted` + `private`); `webhook`(`self_hosted` + `exposure=public`, → 08 5.3 CFG-4) | 설계(PRD 11절) | — |
| `inbox_event_kind` | `message`; `callback`; `command`; `interaction`; `system` | 설계 | — |
| `inbox_status` | `received`; `processing`; `processed`; `ignored`; `retry`; `failed` | 설계(Paperclip `chat_deliveries` 패턴) | — |
| `inbox_ignore_reason` | `duplicate`; `unauthorized` 허용 목록 밖 사용자; `unbound_chat`; `unsupported`; `unknown_question` DB에 없는 질문 ID를 가리킴(복원 뒤 등, → 02 8.4) | 설계(FR-MSG-02, NFR-SEC-01) | — |
| `outbox_kind` | `question`; `question_update`; `digest`; `reminder`; `reflection_notice`; `daily_summary`; `alert`; `binding_confirmation`; `command_reply`; `concept_message` 컨셉 대화 에이전트 발화(→ 11 4.2) | 설계 | — |
| `outbox_status` | `pending`; `sending`; `sent`; `retry`; `delivery_unknown` 공급자 수신 여부 미확인(재발송 안 함); `failed`; `cancelled` | 설계(Paperclip `chat_publications` 패턴) | — |

### 6.6 예산·비용

| enum | 값 — 의미 | 출처 | 목업 차이 |
|---|---|---|---|
| `cost_category` | `text`; `image`; `video` | PRD(FR-BUD-02) 값 이름은 설계 | — |
| `budget_category` | `all` 기능 합계; `text`; `image`; `video` | 설계 | 목업은 `all` 하나($80)만 표시 |
| `budget_window` | `calendar_month` 작품 `timezone` 기준 월; `lifetime` | 설계 | — |
| `budget_status` | `ok`; `warning` 소프트 경고 비율 이상; `hard_stopped` 하드 한도 도달·재개 승인 대기 | 설계 | — |
| `reservation_status` | `active`; `settled` 실제 비용으로 정산; `released` 호출 없이 해제; `unknown_closed` 응답 미상으로 예약액 그대로 원장 기록 | 설계(FR-BUD-03) | — |
| `cost_basis` | `measured` 공급자 보고값; `estimated` 단가×사용량 계산; `unknown` 응답 미수신(`unknown_cost`) | PRD(FR-BUD-04 "실측·추정·미상") 값 이름은 설계 | 목업 `unknown_cost` 표기 = `cost_basis=unknown`인 원장 행 |
| `unpriced_usage_policy` | `block`(기본); `require_approval` | 설계(FR-BUD-03, Paperclip 패턴) | — |

### 6.7 감사·공통 참조

| enum | 값 — 의미 | 출처 |
|---|---|---|
| `actor_type` | `user`; `agent`; `system` | PRD(4절 감사 로그) |
| `system_component` | `scheduler` 시각 기반 tick(예약 공개·digest·리마인더 도래); `orchestrator` 깨우기 디스패처·회수(`dispatcher`, `reclaimer`, → 02 2.2); `messenger`; `budget_guard`; `publisher` 예약 공개; `backup`; `migrator`; `health_check`; `importer` | 설계 |
| `ref_type` | `novel`; `goal`; `series_bible`; `arc`; `episode`; `manuscript_version`; `scene`; `shot`; `task`; `run`; `question`; `answer`; `approval`; `channel`; `budget_policy`; `cost_event`; `continuity_issue`; `setup`; `setup_beat`; `entity`; `entity_name`; `mention`; `fact`; `timeline`; `schema_proposal`; `glossary_term`; `identity_decision`; `media_asset`; `scene_prompt_ir`; `media_quote`; `settings`; `concept_session`; `concept_brief`; `concept_message` | 설계 |
| `user_role` | `owner`(MVP 유일 값) | 설계(D-16) |

### 6.8 연속성 이슈

| enum | 값 — 의미 | 출처 | 목업 차이 |
|---|---|---|---|
| `continuity_issue_kind` | FR-ONT-06: `appearance`; `age`; `relationship`; `ability_rule`; `location_travel`; `death_state`; `character_knowledge`. 설계 추가: `identity_leak` 정체 누설(FR-ONT-17); `schema_violation`(FR-ONT-18); `published_canon_conflict`(FR-ONT-07); `answer_constraint` 답변 제약 위반(FR-MSG-16); `human_edit_conflict`(FR-HIL-04); `setup_missing` 배정 떡밥 누락(FR-FOR-08); `setup_contradiction` 모순 회수; `glossary_spelling` 표기 규칙 위반(FR-ONT-19); `safety_age_rating` 작품 연령 등급 수위 초과; `safety_minor_sexual` 미성년 인물 성적 묘사; `safety_real_person` 실존 인물 사칭·명예훼손(이상 NFR-SAFE-01·02, → 07 5.6) | PRD+설계 | — |
| `issue_severity` | `high` 승인 대기 진입 차단; `medium` 승인 요청에 경고 수로 표시, 차단 안 함; `low` 리포트만 | 설계(SHACL Violation/Warning/Info 대응) | 목업 "높음"=`high`, "중간"=`medium`. `low` 추가 |
| `continuity_issue_status` | `open`; `fixing` 자동 수정·재작성 진행 중; `resolved` 재검사에서 재현 안 됨; `waived` 사람이 의도·허용으로 판정; `false_positive` 오탐; `superseded` 대상 원고 버전이 아웃라인부터 재작성돼 무효 | 설계 | — |
| `issue_resolution_kind` | `auto_fixed`; `rewritten`; `human_edited`; `canon_updated` 사실 변경 승인; `retconned` | 설계(FR-AGT-10) | — |
| `issue_detector` | `continuity_editor`; `foreshadow_manager`; `line_editor`; `world_keeper`; `schema_validator` 결정적 제약 검사; `linker` | 설계 | — |
| `issue_fix_scope` | `span` 씬 하나 안의 구간 치환; `scene` 씬 단위 재작성; `outline` 아웃라인부터 재작성. 필드 이름은 `fix_scope` | 설계(→ 07 5.1, 5.3, 5.4) | — |

### 6.9 떡밥

| enum | 값 — 의미 | 출처 |
|---|---|---|
| `setup_narrative_status` | `planned`; `planted`; `reinforced`; `paid_off`; `abandoned` | PRD(FR-FOR-01) |
| `canon_status` | `candidate`; `approved`; `published_locked`; 설계 추가 `rejected` 후보 기각(캐논 아님); `retracted` 승인 이후 틀린 것으로 철회(캐논 아님, 이력 보존). 사실(`Fact`)과 떡밥(`Setup`, `SetupBeat`)이 같은 enum을 씁니다. 캐논 = `approved` ∪ `published_locked` | PRD+설계 |
| `setup_importance` | `low`; `medium`; `high` | 설계(FR-FOR-01 "중요도") |
| `setup_beat_kind` | `plant` 설치; `reinforce` 강화; `payoff` 회수 | 설계 |
| `setup_beat_status` | `planned` 아웃라인에 배정; `detected` 떡밥 검사가 원고에서 찾음; `missing` 배정됐으나 원고에 없음; `confirmed` 화 확정 시점에 확정; `cancelled` 계획 취소 | 설계(FR-FOR-08) |
| `setup_due_kind` | `episode` 화 번호; `arc` 아크 끝 | 설계(FR-FOR-01 "화 번호 또는 아크") |

### 6.10 온톨로지 (핵심 enum, 상세 → 06)

| enum | 값 — 의미 | 출처 |
|---|---|---|
| `entity_type` (기본 스키마 v1 키) | `character` 인물; `place` 장소; `organization` 조직(가문 포함); `item` 사물; `event` 사건; `rule` 규칙·설정; `ability` 능력·시스템; `title` 칭호·직위; 선택: `persona` 인격·`body` 몸(빙의 작품에서만 켬). 작품 확장 유형은 `SchemaChangeProposal` 승인으로 추가되는 **데이터**이며 이 enum을 바꾸지 않습니다. | PRD(FR-ONT-01)+설계 |
| `entity_status` | `candidate` 신규 후보(확인 전); `active`; `merged` 다른 엔티티로 병합됨(`merged_into_id`로 안내); `retired` 잘못 생성돼 폐기(참조 없음 확인 후) | 설계 |
| `name_kind` | `true_name` 본명; `alias` 별칭·애칭·이명; `title` 칭호·직함(주로 `title` 유형 엔티티의 이름); `address_term` 호칭(화자 의존); `disguise` 위장명; `variant` 표기 변형(집필에 사용 가능); `hidden_variant` 검색 전용 변형(오타·띄어쓰기, 집필 컨텍스트에 노출 안 함. 용어집 금지 표기는 `forbidden_by_glossary_term_id`로 구분). 대표명은 유형이 아니라 `is_preferred=true` 표시(엔티티당 1개) | PRD(FR-ONT-13)+설계 |
| `name_visibility` | `public` 작중 모두 앎; `restricted` `known_by` 목록 인물만 앎; `secret` 작중 아무도 모름(작가·독자 공개 시점만 관리). `entity_names`의 두 필드가 씁니다: `surface_visibility` 이 표기를 쓸 수 있는 범위, `identity_visibility` 표기와 정체(엔티티)의 연결을 아는 범위(→ 06 2.4, 3.3) | 설계(FR-ONT-13, 17) |
| `entity_name_status` | `proposed` 변형·호칭 등록 제안; `active`; `retired` | 설계 |
| `mention_kind` | `named` 이름; `title` 칭호; `address` 호칭; `pronoun` 대명사; `zero` 생략된 주어(표기 없음); `descriptive` 묘사 표현("그의 사부") | 설계 |
| `mention_source_kind` | `manuscript`; `answer`; `user_input`; `series_bible`; `import` | 설계(FR-ONT-14) |
| `link_status` | `auto_linked`; `confirmed` 사람 확인 또는 질문 답변으로 확정; `ambiguous` 자동 확정 불가(질문·검수 리포트 대상); `new_entity_candidate`; 설계 추가 `rejected` 연결 기각(엔티티가 아닌 구, 또는 사람이 연결 거부) | PRD+설계 |
| `fact_kind` | `attribute` 속성(외형·나이 등); `relation` 두 엔티티 관계(`Relation`); `event` 사건 참여·발생; `state` 상태(생사·위치); `knowledge` 인물 지식(`CharacterKnowledge`); `rule` 세계 규칙; `constraint` 답변·사용자에서 온 집필 제약 | 설계 |
| `fact_source_kind` | `manuscript`; `answer`; `user_input`; `series_bible`; `import`; `system_derived` 다른 사실에서 결정적으로 유도 | PRD(FR-ONT-02)+설계 |
| `glossary_source_kind` | `user` 사람이 직접 등록; `agent` 에이전트 제안을 사람이 수락(`line_editor`·`world_keeper`); `template` 장르 템플릿 시드(`source_ref`=`template_key@version`, MVP-β/v1, → 06 4.7 TA-5). `glossary_terms.source_kind`(→ 06 5절) | 설계(FR-ONT-19, 계획서 3.4 (i)) |
| `knowledge_stance` | `knows`; `suspects`; `misbelieves` 잘못 앎; `unaware` 모름 | 설계(FR-ONT-03) |
| `timeline_kind` | `main`; `regression` 회귀; `loop`; `parallel` | 설계(FR-ONT-04) |
| `narrative_frame_kind` | `flashback` 회상 서술; `recollection` 인물의 기억 진술; `dream` 꿈·환상; `other_timeline` 다른 시간선(회귀 전 회차 등). `narrative_frames.frame_kind`(→ 06 2.4) | 설계 |
| `identity_decision_kind` | `merge`; `split`; `confirm_distinct` "다름" 판정(이후 중복 후보에서 제외); `relink` 잘못 연결된 언급 집합을 다른 기존 엔티티로 재연결(→ 06 3.11) | 설계(FR-ONT-15, 16) |
| `identity_decision_status` | `proposed`; `applied`; `rejected`; `reverted`; `cancelled` | 설계 |
| `schema_change_kind` | `add_entity_type`; `add_relation_type`; `add_attribute`; `add_synonym`; `change_constraint`; `deprecate_item` | 설계(FR-ONT-18) |
| `schema_change_status` | `proposed`; `mapped_to_existing` 기존 항목과 같은 의미로 판정, 동의어로 등록; `approved` 새 스키마 버전에 반영; `rejected`; `withdrawn` | 설계 |
| `glossary_term_status` | `active`; `deprecated` | 설계(FR-ONT-19) |
| `fact_diff_kind` | `new`; `duplicate` 같은 시점 같은 값의 캐논 있음; `transition` 시간에 따라 바뀌는 술어의 값 변경; `conflict` 같은 시점 양립 불가. 저장 컬럼이 없는 실행 출력 내부 값입니다(추출 실행 출력·감사 payload에서만 사용) | 설계(FR-ONT-05, → 07 4.4) |

### 6.11 미디어 (v1/v2)

| enum | 값 — 의미 | 출처 | 목업 차이 |
|---|---|---|---|
| `shot_status` | `draft` 분할 직후; `ir_ready` IR·안전 분류 완료; `keyframe_adopted` 최종 키프레임 채택; `clip_adopted` 클립 채택(v2); `blocked` 안전 위험·필터 차단으로 사람 결정 대기; `skipped` 생략(사유 필수). "갱신 필요"는 상태가 아니라 `stale_since` 표시(FR-SPX-07) | 설계 | 목업 "필터 차단"=`blocked`(+에셋 `filtered`) |
| `aspect_ratio` | `vertical_9_16`; `horizontal_16_9` | PRD(FR-SPX-01) 값 이름은 설계 | — |
| `media_asset_kind` | `character_sheet`; `reference_image`; `keyframe`; `illustration`; `cover`; `clip`(v2); `scene_video`(v2); `trailer`(v2); `motion_video`(v2, FR-VID-05) | 설계 | — |
| `quality_tier` | `draft` 저가·저해상도; `final` 고해상도 | 설계(FR-IMG-02) | 목업 "키프레임 초안"=`keyframe`+`draft` |
| `media_asset_status` | `requested`; `generating`; `generated` 보관 완료·검토 대기; `adopted`; `rejected` 비채택; `filtered` 공급자 필터 차단(정상 결과 유형); `failed`; `retired` 갱신으로 대체 | 설계(FR-IMG-05, NFR-SAFE-03) | 목업 "검토 대기"·"채택 대기"=`generated`, "채택"=`adopted`, "필터 차단"=`filtered` |
| `media_quote_status` | `draft`; `awaiting_approval`; `approved`; `rejected`; `consumed` 실행 완료; `expired` 단가 변경 등으로 무효 | 설계(FR-BUD-06a/b) | — |
| `visual_reference_status` | `pending_review`; `approved`; `rejected`; `retired` | 설계(FR-VIS-02) | 목업 "검토 대기"=`pending_review` |
| `safety_risk` | `safe`; `review_required` 사람 확인 필요; `blocked` 생성 금지(해제 불가 항목) | 설계(FR-SPX-04, NFR-SAFE-02) | — |
| `prompt_modality` | `image`; `video` | 설계 | — |

### 6.12 시스템

| enum | 값 — 의미 | 출처 |
|---|---|---|
| `deployment_mode` | `local_trusted`; `self_hosted` | 설계(ADR-002) |
| `exposure` | `private`; `public` | 설계(NFR-SEC-03) |
| `secret_provider` | `local_encrypted` | 설계 |
| `health_check_kind` | `llm_key`; `bot_token`; `channel_reach`; `database`; `ontology_integrity`; `backup_location`; `storage` | 설계(FR-SET-03) |
| `health_status` | `pass`; `warn`; `fail` | 설계 |
| `backup_status` | `running`; `succeeded`; `failed` | 설계 |
| `backup_trigger` | `scheduled` 주기 백업; `pre_migration` 마이그레이션 전; `pre_restore` 복원 전 현재 상태 보존; `manual` 사용자 실행 | 설계(NFR-REL-04·05, → 02 8.2) |
| `export_format` | `txt`; `markdown`; [v1] `docx`; `epub`; `json`; `novel_package` | 설계(FR-MAN-04a/b, 06b) |

### 6.13 장르 템플릿 (MVP-β/v1)

계획서(`../plans/genre-world-templates-plan.md`) 3절이 정한 값입니다. **D-30·D-31 확정(2026-10-28)**. 템플릿은 MVP-β(FR-NOV-03b: `wuxia`·회귀 템플릿 `full`, 현판 헌터 `questions_only`)와 v1(FR-NOV-03c)로 나눠 냅니다. DB enum이 아니라 템플릿 데이터(`packages/shared` zod `GenreTemplateSchema`)의 값입니다. 카테고리 키 자체(L1 11개, L2, L3 25개, 패싯 5개, 아래 레지스트리 표)는 enum이 아니라 카테고리 키 레지스트리(`packages/shared/category-keys`, 계획서 6절 MVP-α)가 소유합니다.

| enum | 값 — 의미 | 출처 |
|---|---|---|
| `template_kind` | `shared` 공통 라이브러리; `genre` L1 세계 장르; `subgenre` L2 하위 장르(`extends` L1); `trope_mixin` L3 트로프 믹스인; `facet` 패싯(v1 이후) | 계획서 3.1 |
| `mixin_level` | `full` 스키마 확장·규칙·떡밥·질문·독자 기대; `light` 질문·떡밥·독자 기대; `label` 태그만 | 계획서 2.2 |
| `content_level` | `questions_only` 질문·용어집 시드·떡밥 패턴·독자 기대만(스키마 확장·규칙 없음, `base@1`에서도 로드); `full` 전체 구성 요소. `genre`·`subgenre` 템플릿 필수 | 계획서 2.2, 3.2 |
| `continuity_rule_kind` | `check` 결정적 사전 필터 + 선택적 LLM 확인(기본); `documentation_only` 기존 CR이 이미 잡는 규칙의 문서화(`covered_by` 필수, `prefilter`·`issue_kind`·`severity` 면제) | 계획서 3.4 (g) |
| `template_prefilter_kind` (사전 필터 키) | MVP-β: `ordinal_regression` 순서형 값 감소; `ordinal_skip` 단계 건너뛰기; `attribute_delta` 관계 양끝 속성 차이; `state_transition` 금지 상태 전이; `timeline_carry_check` 이월 사실 없는 다른 시간선 물건·능력 사용; `llm_rule` 결정적 후보 없이 규칙 문장을 LLM 확인에 넣음. v1: `change_requires_event`; `ability_before_event`; `attribute_disjoint`; `succession_check`; `ledger_mismatch`; `calendar_conflict`. 릴리스에 구현되지 않은 키를 쓴 템플릿은 빌드 오류(계획서 TV-05). 등록 위치는 06 9절 | 계획서 3.4 (g) |
| `genre_template_status` | `draft`; `reviewed`; `released`(앱 노출); `deprecated` 새 작품에 숨김, 기존 작품은 동작 | 계획서 3.2 |
| `template_item_basis` | `source` 출처 있음; `convention_assumption` 장르 관습 가정(검수 필요); `llm_draft` LLM 초안(배포 불가) | 계획서 4.3 |
| `concept_question_required_level` | `core` 공통 필수; `template_required` 템플릿 선택 시 필수; `optional` | 11 3.6 |

`glossary_source_kind`(`template` 포함, 6.10)와 사전 필터 키(위 표)는 v0.2.1에서 등록했습니다. `timeline_kind`의 `source_work`(B-8)는 D-32 확정(`base@2` MVP-β 7개 B-1·B-3·B-4·B-5·B-6·B-10·B-11, v1 4개 B-2·B-7·B-8·B-9)에 따라 v1 `base@2` 개정(06 4.7) 때 등록합니다.

**카테고리 키 레지스트리 (D-31 확정, 3층 + 패싯, 시장 조사 키 기준)**: enum이 아니라 `packages/shared/category-keys` 데이터입니다. 아래는 계획서 2.2절 중복 해소표(개념 1개 = 키 1개)를 적용한 정식 키와 별칭입니다. 별칭은 선택지·키워드 검색에만 쓰고 템플릿을 갖지 않습니다.

| 층 | 정식 키 (개수) |
|---|---|
| L1 `genre` (11) | `romance`, `romance_fantasy`, `fantasy`, `modern_fantasy`, `wuxia`, `alt_history`, `war_military`, `sf`, `mystery_horror`, `drama`, `other`. 시장 조사 7.2의 `light_novel_world`는 L1에서 빼고 패싯 `light_novel`로 둠 |
| L2 `subgenre` | `<L1>.<name>` 형식. 목록은 research-webnovel-market 7.2(계획서 2.2). 예: `modern_fantasy.hunter_gate`, `fantasy.dungeon_tower`, `fantasy.estate`, `sf.apocalypse`, `modern_fantasy.occult`, `modern_fantasy.professional`(템플릿 v1 2차, D-33), `romance.office` |
| L3 `trope` (25) | `rebirth.regression`, `rebirth.multi_regression`, `rebirth.possession`, `rebirth.book_possession`, `rebirth.reverse_possession`, `rebirth.reincarnation`, `ability_system.status_window`, `ability_system.awakening_rank`, `ability_system.mana_magic`, `stage.academy`, `stage.imperial_court`, `relation.contract_marriage`, `relation.villainess`, `relation.childcare_family`, `relation.regret`, `relation.obsession`, `relation.omegaverse`(보류), `relation.harem`(보류), `relation.gender_swap`(보류), `plot.revenge`, `plot.misunderstanding`, `plot.munchkin`, `plot.healing`, `plot.growth`, `plot.dark_tragedy`(보류). `mixin_level`·릴리스는 계획서 부록 A |
| 패싯 `audience_format` (5) | `bl`, `gl`, `light_novel`, `male_oriented`, `female_oriented`. 수위 연동 태그·BL 패싯은 MVP 미노출(D-34, 성인 등급 결정 때 재검토) |

| 별칭 | 정식 키 |
|---|---|
| `light_novel_world.isekai` | `rebirth.possession`·`rebirth.reincarnation`(문맥으로 선택) |
| `light_novel_world.school` | `stage.academy` |
| `stage.gate_dungeon` | `modern_fantasy.hunter_gate`(주 L1 현판) / `fantasy.dungeon_tower`(주 L1 판타지) |
| `stage.tower` | `fantasy.dungeon_tower` |
| `stage.apocalypse` | `sf.apocalypse`(현판이면 보조 L1 `sf`) |
| `stage.occult` | `modern_fantasy.occult` |
| `stage.estate` | `fantasy.estate` |
| `profession.medical`·`.legal`·`.chef` | `modern_fantasy.professional`(로맨스면 `romance.office`) |
| `profession.idol_actor` / `.athlete` / `.chaebol` | `modern_fantasy.entertainment` / `.sports` / `.chaebol_business` |
| `ability_system.cultivation`, `stage.murim_factions` | L1 `wuxia`(다른 L1이면 보조 L1) |
| `era.real_history` | L1 `alt_history`(다른 L1이면 보조 L1) |
| 세계관 조사 키 `murim`·`high_fantasy`·`modern_fantasy_hunter`·`contemporary_romance`·`sci_fi`·`system`·`game_world`·`academy` | `wuxia`·`fantasy.high_fantasy`·`modern_fantasy.hunter_gate`·`romance.contemporary`·`sf`·`ability_system.status_window`·`fantasy.game`·`stage.academy` |

---

## 7. 기본값 레지스트리

- 모든 값은 **가정**입니다. 근거가 PRD 값이면 그 ID를 적고, PRD가 값을 정하지 않았으면 설계 가정 근거를 적습니다.
- **범위**: `install`(설치 설정 파일·환경 변수), `novel`(작품 설정 화면, 감사 로그 기록), `system`(코드 상수, 릴리스로만 변경), `calibrated`(골든셋·실측으로 보정 후 릴리스).
- **조정 경로**: 값을 바꾸는 방법과 다시 정할 시점.
- 키 이름은 설정 파일·코드 상수에서 그대로 씁니다.

### 7.1 예산·비용

| 키 | 기본값 | 범위 | 근거 | 조정 경로 |
|---|---|---|---|---|
| `budget.novel_monthly_hard_limit_usd` (`budget_category=all`) | 80 | novel | 목업 예시값. 가정: 하루 1화 × 30화 × 화당 2 USD(NFR-COST-01 상위 등급) = 60 USD + 재작성 여유 | 작품 설정. MVP 첫 5화 실측 후 재설정(D-9) |
| `budget.soft_warn_ratio` | 0.80 | novel | 목업, Paperclip `warnPercent=80` [1차] | 작품 설정 |
| `budget.text_monthly_hard_limit_usd` | 없음(`all` 한도만 적용) | novel | 텍스트가 주 비용원이라 별도 한도를 두지 않음 | 작품 설정에서 추가 가능 |
| `budget.image_monthly_hard_limit_usd` | 20 | novel | 가정: G-8(채택 1장 0.5 USD) × 화당 1장 × 30화 = 15 + 재시도 여유. v1부터 적용 | 작품 설정. v1 첫 3화 실측 후 |
| `budget.video_monthly_hard_limit_usd` | 0 (영상 비활성) | novel | R-8·R-17: 영상 비용 단가 [미확인](D-19). 첫 영상 견적 승인 질문에서 한도를 함께 정하게 합니다. | 견적 승인 질문, 작품 설정. v2 착수 시 재정 |
| `budget.window` | `calendar_month` | novel | FR-BUD-02 | 작품 설정 |
| `budget.unpriced_usage_policy` | `block` | install | FR-BUD-03 "상한을 계산할 수 없는 호출은 실행하지 않거나 승인" | 설치 설정 |
| `budget.media_quote_retry_margin_ratio` | 0.25 | novel | FR-BUD-06a "견적에 재시도 여유분". 가정 | 작품 설정. v1 견적 초과율 KPI(10% 이하)로 보정 |
| `budget.reservation_stale_after_minutes` | 30 | system | 실행이 끝났거나 연결 호출이 없는 `active` 예약을 정리하기 전 대기. 연결 호출이 `sent`면 `unknown_closed`, 없거나 `prepared`면 `released`(→ 04 11.1). 가정: 가장 긴 LLM 호출 타임아웃(`llm.call_timeout_seconds`)의 10배 | 릴리스 |
| `budget.input_token_margin_ratio` | 0.10 | system | 입력 토큰 로컬 추정 여유(→ 04 8.2). 가정 | MVP 실측(추정 대비 실제) 후 릴리스 |

목업과 차이: 목업은 영상 견적($18.70)을 월 $80 안에서 계산했습니다. 이 설계는 영상 한도 기본값을 0으로 두고, 영상 견적 승인 때 한도를 정하게 합니다.

### 7.2 LLM·실행

| 키 | 기본값 | 범위 | 근거 | 조정 경로 |
|---|---|---|---|---|
| `llm.max_output_tokens.writer` | 16000 | novel | 1화 5,500자(공백 포함). 가정: 한국어 1자당 약 1.5~2 토큰 + 여유 | 역할별 모델 설정. 첫 5화 실측 |
| `llm.max_output_tokens.default` | 6000 | novel | 그 밖 역할(구조화 출력). 가정 | 역할별 모델 설정 |
| `llm.call_timeout_seconds` | 180 | install | 가정 | 설치 설정 |
| `llm.max_retries_per_call` | 3 | system | NFR-REL-03 백오프. 가정 | 릴리스 |
| `llm.retry_backoff_seconds` | 5, 30, 120 | system | 가정. 공급자 `retry-after`가 있으면 우선 | 릴리스 |
| `llm.fallback_model_enabled` | false | novel | FR-AGT-11, D-21 (v1) | 역할별 모델 설정 |
| `run.max_concurrent_per_novel` | 2 | install | 가정: 로컬 PC 부하와 공급자 rate limit | 설치 설정 |
| `run.max_concurrent_global` | 4 | install | NFR-EXT-04b(작품 3개 동시, v1). 가정 | 설치 설정 |
| `task.max_attempts` | 3 | system | NFR-COST-02 무한 재시도 금지. 가정 | 릴리스 |
| `lease.ttl_seconds` | 300 | system | 가정: 갱신 주기의 10배 | 릴리스 |
| `lease.renew_interval_seconds` | 30 | system | 가정 | 릴리스 |
| `reclaim.scan_interval_seconds` | 60 | system | NFR-REL-01 고아 실행 회수. 가정 | 릴리스 |
| `wake.coalesce_window_seconds` | 10 | system | 같은 작업 깨우기 합치기. 가정 | 릴리스 |
| `context.build_timeout_seconds` | 60 | system | 컨텍스트 구성 실패 판정 안전 상한. 넘으면 `error_family=internal`(→ 04 9.5). p90 목표를 타임아웃으로 쓰지 않습니다. 가정 | MVP-α 실측 후 |
| `context.build_p90_target_seconds` | 10 | system | NFR-PERF-04 p90 10초(D-22) 관측 목표. `ContextSnapshot.build_ms`로 집계하고 초과는 실패가 아니라 경고(→ 04 9.5, 09) | MVP-α 실측 후 |
| `context.max_input_tokens.writer` | 40000 | novel | → 04 9.5. 가정 | 역할별 모델 설정. 첫 5화 비용·품질로 보정 |
| `context.max_input_tokens.default` | 24000 | novel | → 04 9.5. 가정 | 역할별 모델 설정 |
| `llm.rate_limit_max_wait_seconds` | 600 | system | `rate_limited` 누적 대기 상한(→ 04 7.2). 가정 | 릴리스 |
| `provider.breaker_failures` | 5 | system | 공급자 차단기 열림 횟수(→ 04 7.3). 가정 | MVP-α 운영 1주 후 릴리스 |
| `provider.breaker_window_seconds` | 300 | system | 위 횟수를 세는 창(→ 04 7.3). 가정 | MVP-α 운영 1주 후 릴리스 |
| `schedule.tick_seconds` | 60 | system | 작품 스케줄 tick(→ 04 3절). 가정 | 릴리스 |
| `schedule.max_episodes_in_flight` | 2 | novel | 동시에 진행하는 화 수(→ 04 3절). `run.max_concurrent_per_novel`과 맞춤. 가정 | 작품 설정 |
| `scheduler.poll_interval_seconds` | 5 | system | 내구 큐 소비자(깨우기 디스패처·수신함·발신함·회수 등)의 공통 주기 조회. 소비자별 키가 있으면 그 값이 우선(→ 02 5.1). 디스패처 전용 키는 두지 않습니다(→ 04 4절). 가정 | 릴리스 |
| `db.tx_retry_max` | 3 | system | 직렬화 실패·교착 시 트랜잭션 재실행 상한(→ 02 4.2). 가정 | 릴리스 |
| `db.statement_timeout_ms` | 30000 | system | 트랜잭션 안 문장 시간 제한(→ 02 4.2). 가정 | 릴리스 |
| `shutdown.grace_seconds` | 60 | system | 종료 시 안전 지점 대기(→ 02 7.3). 가정 | 릴리스 |
| `prompt.self_consistency_samples` | 3 | calibrated | 링킹 L4 다회 샘플(조사 파일 6.2절). 가정 | 골든셋 비용·정확도로 보정 |

### 7.3 원고 파이프라인

| 키 | 기본값 | 범위 | 근거 | 조정 경로 |
|---|---|---|---|---|
| `length.default_profile` | 공백 포함 5,000~5,500자 | novel | FR-NOV-04a | 분량 프로필 |
| `episode.max_rejections` | 3 | novel | FR-AGT-12 (기본 3회, 가정) | 작품 설정 |
| `continuity.max_auto_rewrites_per_episode` | 2 | novel | NFR-COST-02, FR-ONT-06. 가정: 검사→재작성 루프 2회 후 차단형 질문 | 작품 설정. 첫 10화 수렴률 실측 |
| `extraction.max_retries` | 2 | system | 5.7절 "재시도 상한 후 차단형 질문". 가정 | 릴리스 |
| `quality.max_rewrites` (v1) | 2 | novel | FR-AGT-09. 가정 | 작품 설정 |
| `scene.id_retention_overlap_min` | 0.5 | calibrated | FR-AGT-05 "절반 이상(가정)". 정의: 새 씬과 옛 씬의 원문 겹침 글자 수 ÷ 옛 씬 글자 수. 후보가 여럿이면 겹침이 가장 큰 쪽 하나만 ID 유지(→ 07) | 재분할 골든 케이스로 보정 |
| `scene.max_per_episode` | 999 | system | `story_point` 인코딩 한계(5.5절) | 변경 시 인코딩 마이그레이션 필요 |
| `polish.recheck_on_fact_diff` | true | system | 문장 다듬기가 사실을 바꾸면 검사 재실행(→ 03 4.1) | 릴리스 |
| `reserve.target_episodes` | 5 | novel | 목업·5.1절 시나리오 | 목표 설정 |
| `novel.default_narration_mode` | `third_limited` | novel | 작품 생성 시 `novels.default_narration_mode` 값(→ 03 2절, 06 3.3). 가정: 웹소설 다수가 3인칭 제한 시점 또는 1인칭 | 작품 설정 |

### 7.4 질문·메신저

| 키 | 기본값 | 범위 | 근거 | 조정 경로 |
|---|---|---|---|---|
| `question.daily_cap_non_blocking` | 10 | novel | 목업 설정 화면 값. KPI "화당 전체 3건 이하"(가정) × 하루 1화 + 링킹 판별 여유 | 알림 설정 |
| `question.digest_window_minutes` | 15 | novel | FR-MSG-06 | 알림 설정 |
| `question.digest_max_items` | 3 | novel | FR-MSG-06 | 알림 설정 |
| `question.deadline_hours.blocking` | 12 | novel | 가정: KPI 차단형 응답 중앙값 4시간 이하의 3배 | 알림 설정 |
| `question.deadline_hours.non_blocking` | 24 | novel | 가정 | 알림 설정 |
| `question.reminders.blocking` | 2회: 마감 직후, 마감 24시간 후 | novel | D-14 | 알림 설정 |
| `question.quiet_hours` | 23:00–08:00 (작품 `timezone`) | novel | 목업, 5.4절 시나리오 | 알림 설정 |
| `question.urgent_exception_enabled` | false | novel | D-14: 켜면 보안 이벤트·예산 하드 한도만 발송 | 알림 설정 |
| `question.daily_summary_time` | 08:00 | novel | 가정: 방해금지 종료 직후 | 알림 설정 |
| `question.publish_batch_weekday` | 월요일 08:00 | novel | D-24 주 1회 digest. 가정 | 작품 설정 |
| `channel.binding_token_ttl_minutes` | 15 | install | FR-MSG-02 만료. 가정 | 설치 설정 |
| `channel.health_check_interval_minutes` | 15 | install | FR-SET-03 주기 점검. 가정 | 설치 설정 |
| `outbox.max_attempts` | 5 (공급자 rate limit 재시도는 횟수에서 제외) | system | Paperclip publications 패턴 [1차] | 릴리스 |
| `inbox.dedupe_retention_hours` | 72 | system | Telegram 미수신 업데이트 24시간 보관(PRD 11절 [1차])의 3배 | 릴리스 |
| `setup.due_warning_episodes` | 5 | novel | FR-FOR-04 (기본 5화) | 작품 설정 |
| `setup.overdue_handling_window_episodes` | 3 | novel | 9절 KPI 기한 초과 처리율(3화, 가정) | 측정 정의 변경 시 |
| `question.dispatch_interval_seconds` | 30 | system | 발송 대기 질문(`pending`) 처리 주기(→ 05). 가정 | MVP-α 실측 후 릴리스 |
| `question.preview_max_chars` | 160 | system | 판별 질문 발췌문 길이(→ 05 3.5). 가정 | MVP-α 실측 후 릴리스 |
| `question.messenger_max_entity_options` | 4 | system | 메신저 판별 질문의 후보 선택지 상한, 초과분은 웹(→ 05 3.6.2). 가정 | MVP-α 실측 후 릴리스 |
| `question.buttons_max_options` | 8 | system | 버튼으로 보이는 선택지 상한(→ 05). 가정 | 메신저 스파이크(→ 09) 후 |
| `question.option_label_max_chars` | 40 | system | 버튼 라벨 길이 상한(→ 05). 가정 | 메신저 스파이크(→ 09) 후 |
| `question.web_confirm_approval_types` | 빈 목록 | novel | 메신저 답 채택 뒤 웹 재확인을 요구할 `approval_type` 목록(`retcon`, `budget_resume`, `ending_change`만 허용, → 05 10.5). 가정 | 알림 설정 |
| `answer_session.ttl_minutes` | 30 | system | 다단계 입력 세션 만료(→ 05 6.3). 가정 | MVP-α 실측 후 릴리스 |
| `interpretation.max_correction_rounds` | 2 | system | 메신저 해석 정정 횟수 상한, 초과 시 웹 편집(→ 05 7.1). 가정 | MVP-α 실측 후 릴리스 |
| `inbox.max_attempts` | 5 | system | 수신함 처리 재시도 상한(→ 05). 가정 | 릴리스 |
| `channel.degraded_after_consecutive_failures` | 3 | system | 연속 발송 실패가 이 횟수면 채널 `degraded`(→ 05 9.6 CH3). 가정 | 릴리스 |
| `discord.rate_limit_breaker_429_per_10min` | 100 | system | 10분 안 429 응답이 이 수를 넘으면 Discord 발송 중단(→ 05). 가정 | MVP-β 실측 후 릴리스 |
| `messenger.episode_full_text_attachment` | false | novel | 화 승인 질문에 화 전문 `.txt` 첨부(옵트인, 웹 설정 화면에서만 켬, → 05 9.7). NFR-SEC-04 | 작품 설정 |
| `interpretation.answer_context_messages` | 5 | system | 답변 출처 언급의 L4 문맥 창에 넣는 같은 세션(없으면 같은 채널·응답자) 최근 메시지 수(→ 05 7.1). 가정 | MVP-α 실측 후 릴리스 |
| `telegram.poll_timeout_seconds` | 25 | system | `getUpdates` long polling `timeout`. HTTP abort는 이 값 + 10초(→ 05 9.2 TP1). 가정 | 메신저 스파이크(→ 09) 후 |
| `telegram.poll_backoff_max_seconds` | 60 | system | polling 409·5xx·연결 오류 지수 백오프 상한(→ 05 9.2 TP4·TP6). 가정 | 메신저 스파이크(→ 09) 후 |

### 7.5 엔티티 링킹·식별 (calibrated)

조사 파일 6.3절의 초기값입니다. 모두 가정이며 골든셋(NFR-QUAL-01, G01~G22)으로 보정합니다. 보정 순서: 자동 확정 구간 정밀도 0.98 이상을 먼저 맞추고, 그다음 자동 확정 비율을 올립니다(R-18).

| 키 | 기본값 | 의미 |
|---|---|---|
| `linking.candidate_top_k` | 8 | 후보 생성(L2) 상한 |
| `linking.tau_auto.named` | 0.90 | 이 이상이고 아래 조건을 모두 만족하면 `auto_linked` |
| `linking.tau_auto.title` | 0.92 | 칭호 언급 |
| `linking.tau_auto.address` | 0.95 | 호칭 언급(화자 판별 필요) |
| `linking.tau_auto.pronoun` | 0.95 | 대명사 |
| `linking.tau_auto.descriptive` | 0.95 | 묘사 표현 |
| `linking.tau_auto.zero` | 자동 확정 금지 | 영형 주어. 골든셋 G08 결과로 허용 여부 결정 |
| `linking.tau_ask` | 0.60 | `tau_ask ≤ c < tau_auto`면 `ambiguous` + 검수 리포트 묶음, 미만이면 `ambiguous` + 판별 질문 |
| `linking.margin_delta` | 0.20 | 1·2위 점수 차가 이보다 작으면 경합으로 보고 질문 |
| `linking.require_unanimous_samples` | true | 다회 샘플 불일치면 자동 확정 금지 |
| `linking.auto_precision_target` | 0.98 | 자동 확정 구간 정밀도 목표 |
| `dedup.similar_entity_min_score` | 0.75 | 신규 후보와 기존 엔티티의 이름·속성·관계 유사 점수가 이 이상이면 "같은 대상인가" 확인(FR-ONT-15) |
| `dedup.short_name_max_syllables` | 3 | 이 이하 이름은 퍼지 일치만으로 후보 확정 금지 |
| `linking.disambiguation_question_grade` | `non_blocking` | FR-ONT-14 기본. `published_locked` 사실·높음 이슈에 닿으면 `blocking` |
| `linking.rule_proposal_min_confirmations` | 2 | 같은 (표기, 화자) → 같은 엔티티 확정이 이 횟수 쌓이면 이름 사전 규칙 등록 제안 질문(→ 05 3.6.4) |
| `linking.max_blocking_identity_questions_per_episode` | 1 | 화당 차단형 동일성 질문(`entity_disambiguation`·`identity_change`의 `blocking`) 상한. 넘치는 건은 마지막 차단형 질문에 묶음(→ 06 3.9) |
| `linking.backlog_alert` | 50 | 적체 지표 `linking.pending_backlog`(미해결 `ambiguous` 언급 + 링크 보류 사실)의 정보성 알림 임계(→ 06 3.10) |
| `linking.report_hold_digest_days` | 3 | 리포트 보류 항목이 이 일수 동안 처리되지 않으면 일괄 수락 digest 1건 발송(→ 06 3.10) |
| `linking.no_name_match_top_n` | 4 | L2 3차 후보(이름 일치 없음)로 넣는 최근 등장 엔티티 수(→ 06 3.8) |
| `linking.hidden_variant_rule_score_cap` | 0.7 | `hidden_variant` 경유 후보의 `rule_score` 상한. 단일 히트 자동 확정 방지(→ 06 3.2) |
| `dedup.equivalence_check_top_k` | 8 | EN3(b) 동치 판정에서 후보 엔티티와 비교하는 같은 유형 기존 `active` 엔티티 수(→ 06 3.1) |

### 7.6 미디어 (v1/v2)

| 키 | 기본값 | 범위 | 근거 | 조정 경로 |
|---|---|---|---|---|
| `media.max_main_characters_per_shot` | 2 | novel | FR-SPX-05 | 작품 설정 |
| `media.illustrations_per_episode` | 1 (허용 1~3) | novel | FR-IMG-03b | 작품 설정 |
| `media.keyframe_drafts_per_shot` | 2 | novel | 가정. 목업 "초안 44장"(11샷×4)보다 낮게 시작해 비용 우선 | 작품 설정. 채택률 KPI(30%)로 보정 |
| `media.max_generation_retries` | 2 | novel | FR-IMG-05, 목업 "재시도 2/2" | 작품 설정 |
| `media.clip_seconds_range` | 4~15 | system | PRD 4절 샷 [2차] | 공급자 프로필 값이 우선 |
| `media.default_aspect_ratio` | `vertical_9_16` | novel | 트레일러 9:16(FR-VID-09) | 작품 설정 |

### 7.7 운영·백업

| 키 | 기본값 | 범위 | 근거 | 조정 경로 |
|---|---|---|---|---|
| `backup.interval_hours` | 24 | install | NFR-REL-04 RPO 24시간 | 설치 설정 |
| `backup.retention` | 일간 7개 + 주간 4개 | install | 가정 | 설치 설정 |
| `backup.restore_rto_minutes` | 60 | system | NFR-REL-04 RTO 1시간(목표, 스파이크 S-7로 검증) | D-22 실측 |
| `platform_profile.recheck_days` (v1) | 90 | install | FR-NOV-04b, D-6 | 설치 설정 |
| `ui.realtime_p95_seconds` | 5 | system | FR-UI-08, D-22 | 실측 |
| `ui.poll_interval_seconds` | 5 | system | MVP-α 인박스·작업 보드 주기 재조회(`refetchInterval`). 그 밖의 화면은 포커스 재조회만(→ 02 5.3.1). 가정 | `ui.realtime_p95_seconds` 실측 후 |
| `onboarding.first_question_target_minutes` | 30 | system | FR-SET-01 | 실측 |
| `realtime.gap_wait_ms` (v1) | 2000 | system | 실시간 이벤트 순번 공백 보류 시간(→ 02 5.3.2). 가정 | `ui.realtime_p95_seconds` 실측 후 |
| `realtime.replay_max_events` (v1) | 1000 | system | 재연결 replay 상한, 넘으면 전체 새로고침(→ 02 5.3.2). 가정 | 릴리스 |
| `storage.orphan_gc_grace_hours` | 48 | system | 고아 파일 삭제 유예. `backup.interval_hours`보다 길어야 함(→ 02 4.4). 가정 | 릴리스 |
| `system.sleep_detect_gap_seconds` | 120 | system | 단조 시계·벽시계 차이로 절전 복귀 감지(→ 02 7.5). 가정 | 스파이크 S-9와 함께 확인 |

설치 설정 파일(`InstallConfig`)에만 있는 키(`deployment_mode`, `exposure`, `server.*`, `database.*`, `storage.provider`·`storage.root`, `secrets.*`, `messaging.telegram_receive_mode`, `auth.session_secret_id`, `logging.*`, `backup.mode`(`full`(가정)/`files_only`))는 범위가 모두 `install`이고, 키·기본값은 → 08 5.2가 소유합니다. 기본값이 가정인 키: `server.port` 3210, `database.embedded_port` 54339, `logging.retention_days` 14.

### 7.8 컨셉 (→ 11, 모두 가정)

| 키 | 기본값 | 범위 | 근거 | 조정 경로 |
|---|---|---|---|---|
| `concept.max_turns` | 200 (40에서 변경) | novel | 11 3.8. 2026-11-06 설계 변경: 대화는 브리프 필수 항목이 모두 확정될 때까지 이어지고 이 값은 숨은 안전 상한. 조사 `research-concept-agent.md` 6.2 | MVP-α K-C2 실측 |
| `concept.turn_soft_warning_remaining` | 20 | system | 11 3.8. 안전 상한까지 남은 턴이 이 값 이하이고 필수 항목이 남았을 때만 경고(`concept.turn_soft_warning` 30 대체). 가정 | 같음 |
| `concept.turn_extension` | 50 | system | 11 3.8. 연장 시 감사 `concept_session.limit_extended`. 가정 | 같음 |
| `concept.max_turn_extensions` | 4 | system | 11 3.8. 세션당 연장 횟수 상한(연장만 반복하는 출구 없는 루프 방지). 가정 | 같음 |
| `concept.check_reserve_usd` | 0.3 | novel | 11 3.8. 세션 비용 상한 안에 따로 두는 `check_concept_brief` 예약분. 턴·추출은 (상한 − 이 값)까지만. 가정 | MVP-α 실측 |
| `concept.slot_flip_limit` | 3 | system | 11 3.7 반복 변경 비교 카드. 가정 | 시뮬레이션(11 7.3) |
| `concept.idle_reminder_hours` | 48 | novel | 11 3.9. 가정 | 실사용 후 |
| `concept.session_idle_days` | 14 | system | 11 3.9 `paused(idle)`. 가정 | 실사용 후 |
| `concept.session_budget_usd` | 6 (v0.2의 3에서 변경) | novel | 11 9.4: 40턴 × 턴당 입력 16k·출력 2.5k 토큰 상한 × 상위 등급 단가(입력 5·출력 25 USD/100만 토큰) = 5.7 + 점검 예약 0.3. 2026-10-28 Anthropic 공개 단가로 대조(Opus 5 계열 5/25 일치, Opus 5.5 4/20은 여유) [1차]. 가정 | MVP-α K-C8 실측 |
| `concept.max_questions_per_turn` | 2 (메신저 1) | system | 11 3.3 R1. 가정 | 11 7.3 A/B |
| `concept.max_options_per_question` | 3 | system | 11 3.3 R6. 가정 | 같음 |
| `concept.max_template_questions` | 8 | system | 11 3.6 템플릿 질문 기본 상한(`template_required` 포함). 가정 | MVP-β 템플릿(03b) 적용 후 |
| `concept.recent_messages_in_context` | 8 | system | 11 2.6. 가정 | 시뮬레이션 |
| `concept.reply_max_chars` | 1200 | system | Telegram 4,096자·Discord 2,000자 [1차] 안. 가정 | 메신저 스파이크 |
| `concept.messenger_summary_max_chars` | 3500 | system | Telegram 4,096자 [1차] 안 | 같음 |
| `concept.import_max_chars` | 20000 | system | 11 2.3 붙여 넣기 상한. 가정 | MVP-α |
| `concept.turn_p90_target_seconds` | 30 | system | 관측 목표(초과는 경고). 가정 | MVP-α K-C9 |
| `llm.max_output_tokens.concept_partner` | 2500 | novel | 11 3.8. 가정 | 역할별 모델 설정 |
| `context.max_input_tokens.concept_partner` | 16000 | novel | 11 2.6. 가정 | 같음 |

### 7.9 장르 템플릿 (→ 계획서)

| 키 | 기본값 | 범위 | 근거 | 조정 경로 |
|---|---|---|---|---|
| `template.max_required_questions` | 6 | system | 계획서 TV-11(합성 결과 필수 질문 수 경고 기준). 가정 | MVP-β 검증 장르 실측 |
| `template.max_enabled_rules` | 20 | system | 계획서 TV-11(`default_enabled=true` 규칙 수). 가정 | 같음 |
| `template.source_recheck_days` | 90 | system | 계획서 4.3(플랫폼 분류 출처 재확인, FR-NOV-04b와 같은 기준). 가정 | 유지보수 주기 |

---

## 8. 미결 사항

| 항목 | 상태 | 해소 경로 |
|---|---|---|
| `embedded-postgres` 바이너리의 `btree_gist`·`pg_trgm`·`pgvector`·`pg_dump` 포함 여부 | [미확인] | 스파이크 S-1, S-7 (→ 09) |
| `pg_trgm`이 한글 trigram을 만드는지 | [미확인] | 스파이크 S-5 |
| Chat SDK 4.40~4.43 변경 내역 | [미확인] | → 09 스파이크 |
| Graphiti 퍼지 정규화 동작의 버전별 차이 | main 요약 기준 | 차용 전 재확인(차용 범위는 개념뿐이라 설계 영향 작음) |
| 링킹 임계값·씬 ID 유지 기준 | 가정 | 골든셋 보정(NFR-QUAL-01) |
| 예산 기본값 | 가정 | MVP 첫 5화 실측(D-9) |
| PRD 1.3절·11절 "Graph DB가 원천" 문구, FR-SET-03 "Graph DB 상태" | 해소: PRD v0.5 반영(ADR-005 사용자 확인, D-8 확정) | → 01 6절 P-01·P-02, 01 3.1 I-01 |
| PRD 4절 사실 상태·언급 연결 상태에 설계가 더한 값(`rejected`, `retracted`) | 해소: PRD v0.5 반영 | → 01 3.2 S-06, 01 6절 P-04 |
| FR-ONT-16 "`published_locked` 사실에 영향이 있으면 리트콘 승인" | 해소: PRD v0.5에 `approval_type=identity_change` 문구 반영 | → 01 6절 P-09 |
| 11 컨셉 개발의 미결(O-C1 `goal_id` NULL 예외, O-C2 `novel_status=concept`, O-C8 FR-SET-01 측정 기준 등) | 해소(2026-10-28): O-C1 X-1 채택, O-C2 = D-39 확정, O-C8 = D-38 확정("컨셉 승인 후 30분 안 첫 메신저 질문"). 나머지는 11 11절 | → 11 11절 |
| 장르 템플릿 enum·기본값(6.13, 7.9)과 카테고리 키 레지스트리 | 확정(D-29~D-37, 2026-10-28). D-29는 표본 50편 수동 라벨 비교에서 상위 5개 묶음 순위가 바뀌면 재검토. D-33 기준 연도·목록 출처는 법률 검토(D-12)와 함께 정하고, 그때까지 대체역사·스포츠·연예계·전문직 템플릿 배포 보류. 기본값(7.9)은 가정 | → 계획서 8.3 |
| Obsidian vault 가져오기의 출처 "vault 편집"을 어느 enum 값으로 기록할지(`fact_source_kind` 등) | 미정(D-8 확정으로 v1 범위 확정, 값은 미등록) | v1 착수 전 06 개정 |
| 다른 문서가 제안한 기본값·enum | 이 문서 v0.1 개정에서 6·7절에 등록함. 값은 모두 가정 | 각 문서의 "(제안)" 표기 정리 |
