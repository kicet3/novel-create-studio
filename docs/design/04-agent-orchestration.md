# 04. 에이전트 오케스트레이션

| 항목 | 내용 |
|---|---|
| 문서 | novel-create-studio 상세 설계 04 |
| 버전 | v0.2 (2026-10-28, `concept_partner`·컨셉 작업 추가). v0.2.1(같은 날, 11 v0.2 교차 후속): 승인 요청 제출을 `concept_partner` 권한에서 빼고 사용자 행위 결정적 코드로, `ConceptTurnProposal` 새 필드(`user_intent`·`safety_flags`·`copy_request_detected`·`key_phrase`) |
| 기준 | PRD v0.4 초안, `00-foundation.md` v0.2, `03-domain-model.md` v0.3, `11-concept-development.md` v0.1 |
| 작성 | AI 초안. 사람 검토 필요 |

**목적**
에이전트 팀이 사람 없이 작업을 이어 가되, 같은 작업을 두 번 하지 않고, 프로세스가 죽어도 비용·상태가 어긋나지 않게 하는 실행 계층을 정합니다. 집필 컨텍스트가 이름 문자열이 아니라 엔티티 ID를 거쳐 구성되는 경로를 정합니다(D-27, R-18).

**범위**
| 포함 | 제외 (참조 문서) |
|---|---|
| 에이전트 역할과 `task_kind` 배정, 역할별 쓰기 권한 | 상태 전이 표 자체(E·T·R·Q·A·F 표) → 03 4절 |
| `Task` 생성·의존·우선순위·스케줄, 화 파이프라인 단계별 작업 | 단계별 입력·출력·검사 내용 → 07 |
| `WakeRequest`·`Run` 분리, dispatcher, CAS lease, 펜싱 | 프로세스 구성·이벤트 발행 → 02 |
| `ProviderCall` 저널, 응답 재사용, 안전 지점 | 질문 등급 판정·발송·답변 해석 → 05 |
| 재시도·재작성 상한, 오류 분류, 공급자 장애 차단기 | 링킹 L0~L8, 이름 사전 질의, 사실 시간 질의 → 06 |
| 비용 예약·정산의 실행 측 동작 | 예산·원장 테이블과 불변식 → 03 7절 |
| 컨텍스트 구성(FR-AGT-04)과 06에 요구하는 읽기 포트 | 공급자·모델 선정, SDK 버전 → 08 |
| LLM 어댑터 SPI (TypeScript 시그니처) | 이미지·영상 어댑터 상세 → 07 |
| 고아 실행 회수, 재시작 복구 | 백업·복원 → 02 |

**관련 요구**
- FR: FR-AGT-01~12, FR-BUD-01~06b, FR-HIL-03, FR-HIL-07(판정 주체), FR-MSG-09(b)(답변 ID를 컨텍스트에 넣고 재개), FR-ONT-12·14·17(컨텍스트의 ID 경유)
- NFR: NFR-COST-01~03, NFR-REL-01, NFR-REL-03, NFR-PERF-03·04, NFR-OBS-02, NFR-EXT-01
- D: D-3, D-9, D-15, D-21, D-24, D-27 / R: R-3, R-6, R-8, R-18
- ADR: ADR-008, ADR-009, ADR-010, ADR-016 (→ 00 3절)

**선행 문서**: 00(용어·enum·기본값), 03(엔티티·상태 기계·비용 원장). 02·06은 동시 작성 중이며 해당 내용은 참조만 합니다.

**표기**: enum 값·기본값 키는 00 6·7절 이름을 그대로 씁니다. 이 문서에서 처음 쓴 기본값 키는 17절에 모았고 모두 00 7절에 등록됐습니다(값은 가정).

---

## 1. 실행 모델 개요

```
 원인(답변·승인·의존 완료·스케줄·재개·재시도·회수)
   │  같은 트랜잭션에서 INSERT (idempotency_key 유일)
   ▼
 WakeRequest(pending) ──합치기──▶ coalesced
   │  dispatcher: 슬롯 확인 → claim (SKIP LOCKED)
   ▼
 Run(queued) ──예산 입장 예약──▶ Task CAS lease ──▶ Run(running)
   │
   │  AgentTaskHandler
   │   1) buildContext  ── OntologyRepository(엔티티 ID 기준 조회) ──▶ ContextSnapshot
   │   2) execute       ── ModelCallPort ── 예약 → ProviderCall(prepared→sent→responded) → CostEvent
   │                       (호출 사이마다 checkpoint: lease 갱신, 일시정지·취소 확인 = safe_point)
   │   3) commit        ── 결정적 쓰기 + Task done (lease 보유 확인 = 펜싱) ── 1 트랜잭션
   ▼
 Run(succeeded | failed | cancelled | interrupted)  →  다음 작업 WakeRequest
```

원칙
| # | 원칙 | 근거 |
|---|---|---|
| P-1 | 트리거와 실행을 분리합니다. 원인은 깨우기 요청만 남기고, 실행은 dispatcher가 시작합니다. | ADR-009 |
| P-2 | LLM은 제안하고 코드가 씁니다. 에이전트 출력은 구조화 제안(`proposal`)이고, 도메인 쓰기는 `commit`의 결정적 코드가 모듈 공개 API로 합니다. | FR-AGT-10, ADR-008 |
| P-3 | 에이전트끼리 직접 대화하지 않습니다. 협업은 작업·산출물·질문으로만 합니다(블랙보드 방식). | FR-AGT-01 |
| P-4 | 외부 호출 응답은 먼저 저장하고 그다음 반영합니다. 호출 1건 = `ProviderCall` 1행 = 원장 최대 1행. | FR-AGT-02, INV-PC-01~03 |
| P-5 | 비용은 호출 전에 상한으로 예약합니다. 상한을 모르는 호출은 하지 않습니다. | FR-BUD-03 |
| P-6 | 컨텍스트에 들어가는 모든 세계관 정보는 엔티티 ID·사실 버전 ID를 거칩니다. 이름 문자열 검색 결과를 그대로 넣지 않습니다. | FR-ONT-12·14, D-27 |
| P-7 | 모든 반복에는 상한이 있고, 상한 도달은 사람에게 드러냅니다. | NFR-COST-02, FR-AGT-10 |
| P-8 | 큐·잠금·원장을 PG 하나로 처리합니다. 외부 큐를 두지 않습니다. | ADR-004, ADR-009 |

---

## 2. 에이전트 역할

### 2.1 역할 정의

역할 이름은 `agent_role`(→ 00 6.3)입니다. 역할은 "프롬프트 템플릿 묶음 + 모델 지정(`RoleModelBinding`) + 쓰기 권한"이며 상주 프로세스가 아닙니다. 실행 단위는 항상 `Run`입니다.

| 역할 | 책임 (PRD 4.1) | 주 산출물 | 모델 등급 가정 (D-9) |
|---|---|---|---|
| `concept_partner` (기본 탑재, D-28) | 작품 생성 첫 단계 컨셉 대화: 씨앗 수용, 다음 슬롯 질문(코드가 고른 슬롯), 슬롯 갱신, 후보 제시, 수렴 단계 약점 지적, 로그라인 후보 3개(승인 요청 제출은 사용자 행위, 2.3). 상세 → 11 2절 | `ConceptMessage`, `working_brief` 갱신 | 상위(발상 품질·의도 해석이 결과를 좌우, 호출 수는 작품당 수십 회. 세션 비용 상한 `concept.session_budget_usd`로 제한) |
| `showrunner` | 목표 분해, 화 스케줄, 질문 등급 판정, `full_auto` 자동 확정 주체 | 작업 계획, 등급 판정 | 중위 |
| `planner` | 기획서, 아크 설계, 화 아웃라인(비트·훅·씬 계획) | `SeriesBible`, 아웃라인 버전 | 상위 |
| `world_keeper` | 사실·언급 추출, 링킹 판별(L4), 답변 해석·반영, 중복 엔티티 후보 | 사실 후보, `Mention`, `AnswerInterpretation` | 중위(L4 판별은 상위 후보, 골든셋으로 결정) |
| `writer` | 아웃라인과 컨텍스트로 본문 작성·재작성 | 초고 버전 | 상위 |
| `continuity_editor` | 캐논·제약·인물 지식 대조, 수정안 | `ContinuityIssue` | 상위 |
| `foreshadow_manager` | 떡밥 배치 계획, 떡밥 검사, 기한 추적 | `Setup`/`SetupBeat` 제안 | 중위 |
| `line_editor` | 문장·분량·훅 검수, 최종 후보 | 수정본 버전 | 중위 |
| `scene_director` [v1] | 샷 분할, `ScenePromptIR`, 안전 분류 | `Shot`, IR | 중위 |
| `visual_producer` [v1] | 이미지·영상 생성 실행, 결과 정리 | `MediaAsset` | (미디어 공급자) |

가정: 모델 등급은 화당 비용 목표(NFR-COST-01: 상위 위주 2 USD, 중위 위주 1 USD)에 맞춘 초기 배치입니다. 실제 모델은 → 08, 확정은 MVP 첫 5화 실측 후(D-9).

### 2.2 `task_kind` → 역할 배정

배정은 `task_kind`마다 고정입니다(코드 상수 `TASK_KIND_ROLE`). 작업 생성 시 `tasks.agent_role`에 복사해 기록합니다(FR-AGT-01). "LLM" 열이 `없음`인 작업은 결정적 코드만 실행하지만 감사·재시도 경로를 같게 하려고 같은 `Run` 모델을 씁니다.

| `task_kind` | 역할 | `target_type` | LLM | 생성 주체 | 릴리스 |
|---|---|---|---|---|---|
| `concept_turn` | `concept_partner` | `concept_session` | 있음 | 사용자 메시지 저장 트랜잭션, 세션 시작(첫 질문), 재개(→ 11 2.5) | MVP-α |
| `import_concept` | `concept_partner` | `concept_session` | 있음 | `import` 경로 텍스트 제출(→ 11 2.3) | MVP-α |
| `check_concept_brief` | `continuity_editor` | `concept_session` | 있음(+결정적 대조) | 사용자 [승인 요청] 클릭(11 CS3 선행). 비용은 세션 점검 예약분 `concept.check_reserve_usd`에서 씀 | MVP-α |
| `plan_series_bible` | `planner` | `novel` | 있음 | 목표 폼 저장으로 `novel_status` `onboarding → planning`(03 N3) 트랜잭션. 입력 `input.concept_brief_id`(승인 버전, 11 M-09). 컨셉 개정 승인 시 진행 중 작업은 T11 대체 후 재생성(11 3.10) | MVP-α |
| `build_initial_ontology` | `world_keeper` | `series_bible`→`novel` | 있음 | 기획서 승인 커밋 | MVP-α |
| `plan_arc` | `planner` | `arc` | 있음 | `showrunner`(`schedule_episodes`) | MVP-α |
| `plan_setups` | `foreshadow_manager` | `arc` | 있음 | `plan_arc` 커밋 | MVP-α |
| `schedule_episodes` | `showrunner` | `goal` | 선택(결정적 규칙 우선) | 스케줄 tick, 목표 변경(INV-GOL-02) | MVP-α |
| `outline_episode` | `planner` | `episode` | 있음 | 스케줄러, 검사 재작성(E5), `plan_rework` 커밋(`rework_from=outline`) | MVP-α |
| `draft_episode` | `writer` | `episode` | 있음 | `outline_episode` 커밋 | MVP-α |
| `split_scenes` | `world_keeper` (→ 07 2.1) | `episode` | 있음 | `draft_episode`·`revise_episode`·`polish_episode` 커밋 | MVP-α |
| `extract_facts` | `world_keeper` | `episode` | 있음 | `split_scenes` 커밋 | MVP-α |
| `link_mentions` | `world_keeper` | `episode` | 있음(L4) | `extract_facts` 커밋 | MVP-α |
| `check_continuity` | `continuity_editor` | `episode` | 있음 | `link_mentions` 커밋 | MVP-α |
| `check_setups` | `foreshadow_manager` | `episode` | 있음 | `link_mentions` 커밋 | MVP-α |
| `check_text_safety` (00 6.3) | `continuity_editor` | `episode` | 있음 | `link_mentions` 커밋(→ 07 5.6 P3g) | MVP-α |
| `polish_episode` | `line_editor` | `episode` | 있음 | 검사 게이트 통과(E6), `plan_rework` 커밋(`rework_from=polish`) | MVP-α |
| `plan_rework` (00 6.3) | `showrunner` | `episode` | 있음 | 반려·수정 요청(E10·E11) 결정 트랜잭션(→ 07 8.1) | MVP-α |
| `revise_episode` | `writer` | `episode` | 있음 | 검사 재작성(E4), `plan_rework` 커밋(`rework_from=draft`) | MVP-α |
| `interpret_answer` | `world_keeper` | `question` | 있음 | 서술형 답 수신(→ 05) | MVP-α |
| `apply_answer` | `world_keeper` | `question` | 선택 | 답 채택·해석 확정(→ 05) | MVP-α |
| `grade_question` | `showrunner` | `question` | 있음 | 규칙 판정으로 확정되지 않은 질문 초안(→ 05) | MVP-α |
| `review_setup_due` | `foreshadow_manager` | `setup` | 있음 | 기한 도래(FR-FOR-04) | MVP-α |
| `dedupe_entities` | `world_keeper` | `novel`/`entity` | 있음 | 신규 엔티티 후보 누적, 주기 실행(→ 06) | MVP-α |
| `split_shots`, `build_prompt_ir`, `classify_safety` | `scene_director` | `scene`/`shot` | 있음 | 미디어 대상 화 선택(→ 07) | v1 |
| `render_prompts` | `scene_director` (아래 주) | `shot` | 없음 | IR 확정 | v1 |
| `generate_character_sheet`, `generate_keyframes`, `generate_illustrations` | `visual_producer` | `entity`/`shot`/`episode` | 미디어 | 견적 승인(FR-BUD-06a) | v1 |
| `generate_clips`, `assemble_scene_video`, `edit_trailer` | `visual_producer` | `shot`/`scene` | 미디어/없음 | 견적 승인(FR-BUD-06b) | v2 |

**컨셉 작업 규칙**(→ 11 2.5): 위 세 컨셉 작업만 `goal_id` NULL을 허용합니다(03 INV-TSK-01 예외, 11 X-1). `cycle_key`는 처리할 마지막 사용자 메시지 ID(`cnm_…`)이고, 같은 세션의 `concept_turn`은 동시에 하나만 `running`입니다(5.3 부분 유일 인덱스와 같은 방식). 실행 중 새 사용자 메시지가 오면 commit은 사용자 발화 근거가 있는 슬롯 갱신만 반영하고 발화는 `is_superseded=true`로 저장만 한 뒤 새 `concept_turn`을 만듭니다(11 X-7). `task.max_attempts` 소진 시 차단형 질문을 만들지 않고 세션에 "다시 시도" 시스템 메시지를 남깁니다(11 X-8). 비용은 작품 원장(`cost_category=text`)과 세션 상한(INV-CON-09: 턴·추출은 상한 − `concept.check_reserve_usd`까지)을 함께 검사합니다(8.1). 세션 `llm_disabled=true`(비용 상한 뒤 폼 전환)면 `concept_turn`·`import_concept`를 만들지 않습니다.

**`concept_turn` 출력 계약 `ConceptTurnProposal`**(zod, 정본 → 11 2.7): `reply_text`, `questions[]`, `user_intent`(enum `concept_user_intent`: `delegate`/`answer`/`revise`/`other`. 버튼 입력은 분류하지 않고 코드가 정함. `delegate`는 [추천해 줘](idx 901)와 같게 처리), `slot_updates[]`(`{field_path, new_value, origin_claim, evidence_message_id, evidence_quote, key_phrase}`. `origin_claim=user_stated`는 `evidence_quote`가 사용자 메시지에 있고 `key_phrase`가 인용 안 부분 문자열일 때만 통과, 지시어 답은 직전 `options` 대조로 `agent_proposed_accepted`/`agent_proposed_modified`), `change_proposals[]`, `weakness_notes[]`, `safety_flags[]`(`{field_path?, message_id, kind: over_age_rating|minor_sexual|real_person, note}`. 걸린 값은 `proposed`로 저장), `copy_request_detected`(`{work_title, quote, message_id}` 또는 null. 감지 시 그 작품 고유명·고유 설정 슬롯 갱신은 버리고 트로프 수준 대안 질문이어야 함), `stage_signal`. commit 가드는 6.1 `commit`의 도메인 검증 단계에서 `concept.applySlotUpdates`가 실행합니다.

`target_type` 값 `series_bible`은 `target_type` enum에 없으므로 `build_initial_ontology`는 `target_type=novel`, `input.series_bible_id`로 둡니다.

`render_prompts` 담당: `scene_director`로 정합니다. 이유: (1) PRD 4.1에서 프롬프트 IR까지가 `scene_director` 산출물이고, `visual_producer`는 생성 실행 담당입니다. (2) 렌더링 프롬프트 미리보기·편집·내보내기(FR-SPX-08)는 생성 없이도 쓰는 산출물입니다. (3) LLM 없는 작업이라 역할은 감사 주체와 쓰기 권한에만 영향이 있습니다. 07 10.2 X4도 이 값(`scene_director`)입니다.

**작업 재배정 (FR-HIL-04 "작업 할당", MVP-α)**

| 방식 | 처리 |
|---|---|
| 사람이 직접 처리 | 사람이 산출물을 직접 넣으면 작업은 `cancelled`(T11, `superseded_by_task_id` 없음)되고 사람 버전이 다음 단계의 입력이 됩니다. |
| 역할 재배정 | `orchestration.reassignTask`(13절)로 `tasks.agent_role`을 바꿉니다. 아래 허용 표 안에서만 가능합니다. 같은 트랜잭션에서 `task.reassigned`(주체 `user`, 이전·새 역할)를 감사 로그에 남깁니다(03 6.3). |

| 가드 | 내용 |
|---|---|
| 허용 역할 | 새 역할이 그 `task_kind`의 `commit`이 부르는 쓰기 API를 2.3 표에서 모두 가지고 있고, `<agent_role>.<task_kind>` 프롬프트 템플릿(03 `prompt_template_version`)이 등록돼 있어야 합니다. MVP-α 등록 조합: `revise_episode`·`polish_episode` ↔ `writer`·`line_editor`(둘 다 `manuscript.createVersion(kind=revision)`). 그 밖 조합은 거부(가정: 템플릿을 늘릴 때 표에 추가) |
| 상태 | `pending`·`ready`·`blocked`: 즉시 적용. `running`: `tasks.input.reassign_to`에 기록하고 다음 checkpoint(6.4)에서 `stop_reason=superseded`로 실행을 끝낸 뒤 적용합니다. 작업은 일시정지 복귀와 같은 `running → ready`(03 4.2 하단 재배정)로 돌리고 `user_resume` 깨우기를 넣습니다. 종료 상태는 거부 |
| 모델 | 새 역할의 `RoleModelBinding`을 다음 실행부터 씁니다. `ContextSnapshot` 층은 새 역할 기준(9.4)으로 다시 구성합니다 |

### 2.3 역할별 쓰기 권한

`commit`이 호출할 수 있는 모듈 API를 역할별로 제한합니다. 핸들러 등록 시 허용 목록을 선언하고, 목록 밖 API 호출은 개발 단계 검사(→ 08 경계 검사)와 런타임 가드로 막습니다.

| 역할 | 허용 쓰기 (모듈 API) | 금지 |
|---|---|---|
| 공통 | `hitl.submitQuestionDraft`, `orchestration.createTask`(자기 파이프라인 후속 작업), `continuity.openIssue`(검사 역할) | `canon_status`를 `approved` 이상으로 바꾸는 모든 API(F2의 해석 확정 경로 제외). 승인 결정. 예산 정책 변경 |
| `concept_partner` | `concept.recordAgentMessage`, `concept.applySlotUpdates`(INV-CON-03 가드: `user_stated`는 인용·`key_phrase` 검증 통과 시만, `user_stated`·`user_edited` 필드의 근거 없는 변경은 `change_proposals`로 강등), `concept.recordSimilaritySignals` | `novel.*`, `goal.*`, `ontology.*`, `linking.*`, 승인 결정, **승인 요청 제출(`concept.submitBriefForApproval`)**, `orchestration.createTask` 중 컨셉 외 작업 |
| (사용자 행위, 결정적 코드) | `concept.submitBriefForApproval`: 사용자의 [승인 요청] 클릭으로 시작한 `check_concept_brief`가 통과하고 현재 `working_brief` 해시가 `checks.working_brief_hash`와 같을 때만 실행(11 CS3, INV-CON-13). 브리프 버전 + `Approval(concept_brief)` + 질문을 한 트랜잭션으로 만들고 `author_actor_type=user`. 에이전트 실행의 `commit`은 이 API를 호출할 수 없습니다(04 P-2) | — |
| `showrunner` | `orchestration.createTask`(아크·화 작업), `hitl.recordGrade` | 원고·사실 쓰기 |
| `planner` | `novel.createSeriesBibleVersion`, `novel.updateArcPlan`, `manuscript.createVersion(kind=outline)` | 본문 버전 |
| `world_keeper` | `manuscript.resegment`(`split_scenes`), `ontology.createCandidateFact`, `linking.recordMentions`, `ontology.proposeEntityName`, `ontology.proposeIdentityDecision`, `ontology.proposeSchemaChange`, `hitl.recordInterpretation`, `hitl.recordReflection`; 해석 `confirmed`·`corrected` 뒤 `ontology.createApprovedFactFromAnswer`(F2); 엔티티 판정(`resolve_entities`, 설계 추가 0015) `hitl.agentResolveQuestion`, `hitl.cancelQuestion`, `ontology.decideMention`, `ontology.addEntityName`, `ontology.setEntityStatus`, `ontology.applyIdentityDecision`(자기 질문의 '같음' 병합만) | 병합·분리 적용(위 판정 병합 제외), 스키마 발행 |
| `writer` | `manuscript.createVersion(kind=draft|revision)` | 사람 작성 구간 덮어쓰기 확정(INV-MV-03) |
| `continuity_editor` | `continuity.openIssue`, `continuity.recordRecheck`, `manuscript.createVersion(kind=revision)`(자동 수정, diff·근거 필수), `concept.recordBriefChecks`(`check_concept_brief`, 브리프 필드 변경 금지) | 이슈 `waived`(`high`) |
| `foreshadow_manager` | `foreshadow.planSetup`, `foreshadow.recordBeatDetection`, `foreshadow.proposePayoff` | `abandoned` 전이, 기한 변경 확정 |
| `line_editor` | `manuscript.createVersion(kind=revision)`, `manuscript.recordLengthWarning` | 사실 쓰기(사실이 바뀌면 E7로 재검사) |

캐논 승격(E9·E13의 일괄 승격, F3)은 에이전트 핸들러가 아니라 승인 결정 또는 `system:orchestrator`의 게이트 평가가 수행합니다. `full_auto`의 자동 확정도 같은 게이트 코드이고, 감사 주체만 `agent:showrunner`로 기록합니다(03 6.1).

---

## 3. 작업(`Task`) 수명주기

전이 표는 → 03 4.2(T1~T12). 이 절은 언제 어떤 작업을 만들고 어떤 순서로 실행하는지를 정합니다.

### 3.1 생성 규칙

| 규칙 | 내용 |
|---|---|
| TC-1 | 작업은 `orchestration.createTask`로만 만듭니다. `goal_id`와 대상(`target_type`, `target_id`)이 없으면 거부합니다(INV-TSK-01). 예외: 컨셉 작업 3종은 `goal_id` NULL, 대상 `concept_session`(INV-CON-08, 11 O-C1 확정 X-1). 대상이 화·씬이면 `arc_id`·`episode_id`를 채웁니다. |
| TC-2 | 같은 `(kind, target_id, input.cycle_key)`의 미종료 작업(`pending`/`ready`/`running`/`blocked`)이 있으면 새로 만들지 않고 기존 작업을 돌려줍니다. `cycle_key`는 화 파이프라인에서 `<원고 버전 ID>`, 답변 작업에서 `<answer_id>`입니다. |
| TC-3 | 작업 생성과 첫 `WakeRequest`(`task_created`)는 생성 원인과 같은 트랜잭션입니다. |
| TC-4 | `max_attempts`는 생성 시 `task.max_attempts`(00 7.2)로 채웁니다. |
| TC-5 | `input`에는 ID만 둡니다(원고 버전, `answer_ids`, `rework_from`, `rework_cause`). 본문·사실 내용은 넣지 않습니다. `rework_cause` 값은 `check`(검사 게이트 재작성, E4·E5)와 `rejection`(반려·수정 요청 뒤 `plan_rework`가 만든 후속 작업, → 07 8.1) 둘입니다. |

### 3.2 의존과 게이트

`pending → ready`(T2)는 두 조건이 모두 참일 때 스케줄러가 수행합니다.

| 조건 | 판정 |
|---|---|
| 선행 작업 | `task_dependencies`의 선행 작업이 모두 `done`. 선행 작업이 `cancelled`면 이 작업도 `cancelled`(T11)하고 대체 작업으로 다시 연결 |
| 대상 게이트 | `outline_episode`·`draft_episode`: 기획서 `approved`(INV-BIB-02), 아크 계획 승인(INV-ARC-02, `full_auto` 제외). 미디어 생성: `MediaQuote.status=approved`(FR-BUD-06a/b). 공통: 대상 범위가 일시정지 아님, 예산 `hard_stopped` 아님 |

의존 완료는 커밋 트랜잭션에서 후속 작업에 `dependency_done` 깨우기를 넣어 알립니다. 스케줄러가 주기적으로 다시 평가하므로 깨우기 누락은 지연만 만들고 정지를 만들지 않습니다.

### 3.3 화 파이프라인 단계별 작업

단계별 입력·출력·검사 내용은 → 07. 여기서는 상태 전이(03 4.1)와 작업의 연결만 둡니다.

| 화 상태 | 실행 작업 (역할) | 진입 전이 | 다음 단계로 가는 조건 |
|---|---|---|---|
| `planned` | — | — | `outline_episode` 임대 획득 → E1 |
| `outlining` | `outline_episode` (`planner`), 필요 시 `plan_setups` 결과 읽기 | E1, E5, E12 | 아웃라인 버전 커밋(떡밥 비트 배정 포함) → E2 |
| `drafting` | `draft_episode` / `revise_episode` (`writer`) | E2, E4, E12 | 초고 버전 커밋 → E3 |
| `checking` | `split_scenes` → `extract_facts` → `link_mentions` → (`check_continuity` ∥ `check_setups` ∥ `check_text_safety`) | E3, E7, E15, E16 | 세 검사 작업이 모두 `done`이면 게이트 평가(아래) |
| `polishing` | `polish_episode` (`line_editor`) | E6, E12 | 최종 후보 커밋. 사실 diff가 있으면 E7, 없으면 E8 |
| `awaiting_approval` | 승인 질문 대기(→ 05) | E8 | E9 / E10 |
| `revising` | `plan_rework` (`showrunner`, → 07 8.1) | E10, E11 | `plan_rework` 커밋(대상 씬, 후속 작업 1건) → E12(`rework_from`에 따라) |
| `approved`, `published` | 후속 미디어 작업만(v1) | E9, E13 | — |

**검사 게이트 평가** (`system:orchestrator`). 세 검사 작업(`check_continuity`, `check_setups`, `check_text_safety`, → 07 5.3) 중 나중에 커밋하는 쪽이 같은 트랜잭션에서 화 행을 잠그고(`SELECT … FOR UPDATE`) 평가합니다.
| 결과 | 조건 | 전이 | 후속 작업 |
|---|---|---|---|
| 통과 | 사실 추출·링킹 완료, 열린 `high` 이슈 0, `missing` 비트 0 | E6 | `polish_episode` |
| 초고 재작성 | `high` 이슈 또는 `missing` 비트, 이번 사이클 자동 재작성 수 < `continuity.max_auto_rewrites_per_episode` | E4 | `revise_episode`(`rework_cause=check`, 이슈 ID 목록) |
| 아웃라인 재작성 | `high` 이슈의 `fix_scope`(`span`/`scene`/`outline`)에 `outline`이 있음(→ 07 5.1·5.3 GC-5). 필드는 03 3.6 `ContinuityIssue.fix_scope`, enum은 `issue_fix_scope`(00 6.8)입니다 | E5 | `outline_episode`(`rework_cause=check`) |
| 상한 도달 | 위 재작성 조건이지만 상한에 도달 | 상태 유지, `block_reasons += rewrite_limit` | 차단형 질문(`topic=rewrite_limit`, FR-ONT-06). 화 작업만 정지 |

"이번 사이클 자동 재작성 수"는 03 3.2 `episodes.auto_rewrite_count`를 씁니다(정의 → 07 5.4: 마지막 사람 개입 이후 E4·E5·E7·자동 수정 검사 사이클 수). 증가는 03 4.1 E4·E5 가드, 0으로 되돌리는 시점(반려 E10·E11, 사람 편집 E16, `rewrite_limit` 질문 답변)은 03 3.2 필드 설명을 따릅니다. 판정 순서는 → 07 5.3(GC-1~GC-6)입니다.

**동시 실행 제약**: 같은 화의 원고를 쓰는 작업(`outline_episode`, `draft_episode`, `revise_episode`, `polish_episode`)은 동시에 `running`일 수 없습니다. 부분 유일 인덱스로 DB가 강제합니다(5.3절).

### 3.4 우선순위와 스케줄 (FR-AGT-06)

스케줄러(`system:scheduler`)는 `schedule` 깨우기(작업 없는 깨우기, 4.3절 W5)마다 다음을 결정적으로 수행합니다. 판단이 필요한 경우(아크 분해, 목표 변경 영향)만 `schedule_episodes` 작업을 만들어 `showrunner`에게 넘깁니다.

1. 비축분 계산(03 3.2: 승인 대기 포함·제외).
2. 진행 중 화 수 `in_flight = count(status ∈ {outlining, drafting, checking, polishing, revising})`.
3. `in_flight < schedule.max_episodes_in_flight`(제안, 기본 2)이고 `비축분(승인 대기 포함) + in_flight < reserve.target_episodes`이면, 계획이 승인된 아크에서 번호가 가장 작은 `planned` 화의 `outline_episode`를 만듭니다.
4. 활성 아크의 남은 `planned` 화가 `reserve.target_episodes`보다 적고 다음 아크가 없으면 `plan_arc` 작업을 만듭니다(`schedule_episodes` 경유).
5. 모든 `ready` 작업의 `priority`를 다시 계산합니다.

**우선순위 식** (값이 클수록 먼저, 동률은 `episode_no` 오름차순 → `created_at` 오름차순)

| 항 | 값 | 이유 |
|---|---|---|
| 기본값(`kind`) | 컨셉 대화(`concept_turn`, `import_concept`, `check_concept_brief`) 950(사용자가 화면 앞에서 대기, 11 X-4), 답변 처리(`interpret_answer`, `apply_answer`, `grade_question`) 900, `plan_rework`·`revise_episode` 800, 검사 작업 700, 그 밖의 화 파이프라인 500, 기획(`plan_*`) 400, 유지 작업(`dedupe_entities`, `review_setup_due`) 100 | 사람 응답 루프를 먼저 닫음(KPI 답변 반영 성공률), 진행 중 화를 새 화보다 먼저 끝냄 |
| 비축분 부족 | 화 파이프라인 작업에 `+50 × max(0, reserve.target_episodes − 비축분(승인 대기 포함))` | FR-AGT-06 "비축분이 목표보다 적으면 우선순위를 올림" |
| 대기 시간 | `+min(100, 대기 분 ÷ 10)` | 기아 방지 |

**예상 완료 시각**(FR-AGT-06 대시보드): 최근 20개 화의 단계별 소요 시간 중앙값(사람 대기 제외, `episode.status_changed` 감사 이벤트로 계산)을 남은 단계에 더합니다. 표본이 5개 미만이면 표시하지 않습니다. 가정: 표본 수 20·5는 초기값입니다.

### 3.5 차단과 독립 진행 (FR-AGT-07, NFR-PERF-03)

| 상황 | 작업 측 처리 | 다른 작업 |
|---|---|---|
| 핸들러가 차단형 질문·승인을 만듦 | `commit` 결과 `awaiting_human` → T7(`block_reason=question|approval`, `blocked_ref`), 실행 `stop_reason=awaiting_human` | 영향 없음. 차단된 작업은 실행 슬롯을 쥐지 않음 |
| 핸들러가 비차단형 질문을 만듦 | 추천안으로 진행(`commit` 결과 `done`), 질문은 05가 발송. 같은 `commit` 트랜잭션에서 그 질문 ID를 이 실행의 `context_snapshots.provisional_question_ids`에 더합니다(03 3.3, → 05 4.3). 늦게 다른 답이 오면 05의 늦은 답변 처리(FR-MSG-08)가 수정 작업을 만듦 | 영향 없음 |
| 답변·승인 도착 | 05가 반영 트랜잭션에서 `blocked_ref`가 그 질문·승인인 작업을 T9로 풀고 `question_answered`·`approval_decided` 깨우기를 넣음. `input.answer_ids`에 답변 ID 추가(FR-MSG-09) | — |
| 화 N이 `checking` 이전에서 차단 | N+1의 `outline_episode`는 N의 `link_mentions`에 의존하므로 대기 | 다른 아크 기획, 답변 처리, 유지 작업은 진행 |
| 화 N이 `checking` 이후에서 차단(승인 대기 포함) | N+1은 N의 사실을 "미확정"으로 넣고 진행(FR-AGT-04) | — |

화 사이 의존: `outline_episode(N+1)`은 `link_mentions(N)` 완료에 의존합니다. N의 후보 사실이 엔티티 ID로 연결된 뒤에야 N+1 컨텍스트에 넣을 수 있기 때문입니다(9.1절 C-5). N이 나중에 재작성되면 N+1이 쓴 사실과 어긋날 수 있으며, 그 검출·재작업 규칙은 → 07.

### 3.6 대체와 취소

| 경우 | 처리 |
|---|---|
| 반려·재작성으로 대상 원고 버전이 바뀜 | 이전 버전을 대상으로 한 미종료 작업은 T11(`superseded_by_task_id`). 실행 중이면 다음 checkpoint에서 `stop_reason=superseded` |
| 목표 변경(INV-GOL-02) | 계획 작업(`plan_arc`, `outline_episode`, `schedule_episodes`)에 깨우기. 이미 `done`인 계획은 `schedule_episodes`가 영향 판단 후 새 작업 생성 |
| 사용자 취소 | T11. 실행 중이면 checkpoint에서 `stop_reason=cancelled_by_user`. 연결된 `pending` 질문은 Q8 |
| 엔티티 분리(06 3.11) | 분리된 엔티티(`identity_decision_moves.from_entity_id`)를 참조하는 진행 중 실행은 `commit`에서 `ontology` 쓰기 API가 분리를 감지하면 트랜잭션을 롤백하고 `stop_reason=superseded`로 끝냅니다(06 3.11 "병합 중 쓰기", 02 4.2). 작업은 2.2 재배정과 같은 `running → ready`로 돌리고(`attempt_count` 유지) `reclaim` 깨우기를 넣습니다. 새 실행은 스냅숏을 복제하지 않고 새로 구성합니다(RU-3 예외). 병합은 자동 재지정되므로 대상이 아닙니다 |

---

## 4. 깨우기 요청과 실행 분리

### 4.1 깨우기 출처와 `idempotency_key`

형식 규칙은 → 00 5.4(`<출처>:<대상 ID>:<구분자>`). 키는 `(novel_id, idempotency_key)` 유일이고 `INSERT … ON CONFLICT DO NOTHING`으로 넣습니다.

| `wake_reason` | 넣는 곳 (같은 트랜잭션) | `idempotency_key` | `task_id` |
|---|---|---|---|
| `schedule` | 스케줄 tick(`schedule.tick_seconds`, 00 7.2, 가정 60초), 작품 재개 | `schedule:<novel_id>:<tick 시각 분 단위 UTC>` | NULL |
| `task_created` | 작업 생성(TC-3) | `task:<task_id>:created` | 작업 |
| `dependency_done` | 선행 작업 커밋 | `dep:<선행 task_id>:<task_id>` | 후속 작업 |
| `question_answered` | 답변 반영(→ 05) | `answer:<answer_id>:<task_id>` | 차단 작업 |
| `approval_decided` | 승인 결정(→ 05) | `approval:<approval_id>:<task_id>` | 차단 작업 |
| `budget_resumed` | `budget_resume` 승인 | `budget:<approval_id>:<task_id>` | 예산 차단 작업 |
| `budget_released` (00 6.3) | 다른 예약 `settled`·`released`·`unknown_closed`(8.3 (b)) | `budget_rel:<reservation_id>:<task_id>` | 예약 대기 작업 |
| `user_resume` | 사용자 재개(작품·아크·작업), 작업 재배정(2.2) | `resume:<activity_log.seq>:<task_id>` | 재개 범위의 작업 |
| `retry` | T5 | `retry:<task_id>:<attempt_count>` | 작업, `not_before_at` 설정 |
| `reclaim` | 고아 회수(11절) | `reclaim:<run_id>:<task_id>` | 작업 |

### 4.2 합치기 (coalescing)

| 규칙 | 내용 |
|---|---|
| WC-1 | 새 요청을 넣을 때 같은 `task_id`의 `pending` 요청이 있으면 새 요청을 `coalesced`(`coalesced_into_id`=기존)로 넣고 기존 요청을 유지합니다. |
| WC-2 | 합친 결과의 `not_before_at`: 새 요청이 `user_resume`이면 `NULL`(즉시), 아니면 둘 중 늦은 값(재시도 백오프 보존). |
| WC-3 | dispatcher는 생성 후 `wake.coalesce_window_seconds`(00 7.2, 10초)가 지나지 않은 요청을 claim하지 않습니다. 예외: `user_resume`, `question_answered`, `approval_decided`(사람이 기다리는 경로). |
| WC-4 | 작업 없는 `schedule` 요청끼리는 키가 분 단위라 tick당 1개만 생깁니다. |

### 4.3 `WakeRequest` 상태 기계 (`wake_status`)

03 4.11이 이 문서에 위임한 전이입니다. 깨우기 요청은 감사 로그에 남기지 않습니다(03 3.3).

| # | from | to | 트리거 | 주체 | 가드 |
|---|---|---|---|---|---|
| W1 | (생성) | `pending` | 4.1절 출처 | 원인 트랜잭션 | 키 유일 |
| W2 | (생성) | `coalesced` | 같은 작업의 `pending` 존재 | 원인 트랜잭션 | WC-1 |
| W3 | `pending` | `claimed` | dispatcher가 실행 생성 | `system:orchestrator` | 작업 `status=ready`, 일시정지 아님, `not_before_at ≤ now()`. 같은 트랜잭션에서 `Run(queued)`(R1), `claimed_run_id` 설정 |
| W4 | `pending` | `discarded` | claim 시 작업이 `ready`가 아님(`pending`·`blocked`·`done`·`cancelled`·`failed`) 또는 일시정지 | `system:orchestrator` | 상태가 풀리면 해당 경로가 새 요청을 넣음 |
| W5 | `pending` | `claimed` | `task_id IS NULL`(스케줄 요청)을 스케줄러가 처리 | `system:scheduler` | `claimed_run_id` NULL |

`claimed`, `coalesced`, `discarded`는 종료 상태입니다. 보존 기간은 → 02(운영 테이블 정리).

### 4.4 dispatcher

`orchestration` 모듈의 상시 루프입니다(프로세스 배치 → 02, 02의 `run_worker`). 깨어나는 조건: 커밋 후 프로세스 안 `WorkSignal(wake)` 힌트(02 5.1·5.2) 또는 `scheduler.poll_interval_seconds`(00 7.2, 가정 5초) 주기 조회. 힌트는 비내구이고, 잃어도 주기 조회가 복구합니다(02 A-4).

```
loop:
  free_global = run.max_concurrent_global − count(runs.status IN (queued, running))
  if free_global ≤ 0: sleep
  BEGIN
    SELECT w.* FROM wake_requests w
      JOIN tasks t ON t.novel_id = w.novel_id AND t.id = w.task_id
      LEFT JOIN episodes e ON e.novel_id = t.novel_id AND e.id = t.episode_id
     WHERE w.status = 'pending' AND (w.not_before_at IS NULL OR w.not_before_at <= now())
       AND (w.created_at <= now() - :coalesce_window OR w.reason IN ('user_resume','question_answered','approval_decided'))
       AND (SELECT count(*) FROM runs r WHERE r.novel_id = w.novel_id
              AND r.status IN ('queued','running')) < :max_per_novel
     ORDER BY t.priority DESC, e.episode_no ASC NULLS LAST, w.created_at ASC
     LIMIT 1
     FOR UPDATE OF w SKIP LOCKED;
    -- 작업 상태 확인 → W3(Run queued 생성) 또는 W4
  COMMIT
  start(run)   -- 5절 임대 → 8절 입장 예약 → R2
```

- 두 모드 모두 앱 프로세스는 1개입니다(02 2.3). `SKIP LOCKED`는 같은 프로세스 안 dispatcher와 회수 스캐너가 같은 행을 잡을 때 대기하지 않게 하고, 다중 인스턴스(02 10절)로 넓힐 때 같은 SQL을 그대로 쓰기 위한 것입니다.
- `start(run)`이 임대·예약에 실패하면 실행은 R3(`cancelled`)로 끝나고, 실패 원인이 예산이면 8.3절 표(실지출 초과는 T8 `budget`, 다른 실행 예약 때문이면 T8 `budget_reservation_wait`), 임대 경합이면 아무것도 하지 않습니다(다른 실행이 이미 진행 중).

---

## 5. 임대(lease)와 원자적 checkout

### 5.1 획득 (T3, INV-TSK-03)

조건부 UPDATE 한 문장입니다(Paperclip `issues.ts` checkout과 같은 모양 [1차, 커밋 0cb3fc7, `issues.ts:11906`]).

```sql
UPDATE tasks
   SET status = 'running',
       lease_run_id = :run_id,
       lease_expires_at = now() + make_interval(secs => :lease_ttl),   -- lease.ttl_seconds
       started_at = coalesce(started_at, now()),
       updated_at = now()
 WHERE novel_id = :novel_id AND id = :task_id
   AND status = 'ready'
   AND paused_at IS NULL
   AND (not_before_at IS NULL OR not_before_at <= now())
   AND (lease_run_id IS NULL OR lease_expires_at < now())
   AND NOT EXISTS (SELECT 1 FROM novels n   WHERE n.id = tasks.novel_id AND n.paused_at IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM arcs a     WHERE a.novel_id = tasks.novel_id AND a.id = tasks.arc_id     AND a.paused_at IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.novel_id = tasks.novel_id AND e.id = tasks.episode_id AND e.paused_at IS NOT NULL)
RETURNING id;
```

- 0행이면 획득 실패입니다. 실행은 R3로 끝냅니다.
- 같은 트랜잭션에서 `runs.status = running`(R2), 화 파이프라인 첫 작업이면 E1을 수행하고 `task.lease_acquired`, `run.started`를 감사 로그에 씁니다.
- `attempt_count`는 획득 때 올리지 않고 실패 전이(T5·T6) 때 올립니다. 프로세스 종료로 회수된 실행(T10)은 시도 횟수에 넣지 않습니다.

### 5.2 갱신과 펜싱

| 동작 | SQL·규칙 |
|---|---|
| 갱신 | 실행마다 타이머(`lease.renew_interval_seconds`, 30초)로 `UPDATE tasks SET lease_expires_at = now()+ttl WHERE id=:task AND lease_run_id=:run` 과 `UPDATE runs SET heartbeat_at = now() WHERE id=:run AND status='running'`을 한 트랜잭션에서 실행. LLM 호출 중에도 타이머는 돕니다. |
| 임대 상실 | 갱신이 0행이면 실행의 `AbortSignal`을 올리고, 다음 checkpoint에서 `stop_reason=lease_lost`로 끝냅니다. 진행 중인 외부 호출은 끊지 않고 응답만 저장합니다(비용 기록 보존). |
| 펜싱 | `commit` 트랜잭션은 맨 앞에서 `UPDATE tasks SET status='done', lease_run_id=NULL, lease_expires_at=NULL, completed_at=now(), output_refs=:refs WHERE id=:task AND lease_run_id=:run AND status='running'`을 실행합니다. 0행이면 롤백합니다. 임대를 잃은 실행은 도메인에 아무것도 쓰지 못합니다. |

**살아 있는 실행의 임대 만료** (PC 절전 복귀처럼 DB `now()`가 한꺼번에 뛰어 실행은 살아 있는데 임대만 만료된 경우)

| 규칙 | 내용 |
|---|---|
| LR-1 활성 실행 레지스트리 | 프로세스는 메모리에 지금 실행 중인 `run_id` 집합을 둡니다(실행 시작 시 추가, 종료 시 제거). 단일 프로세스(02 2.3)이므로 이 집합에 없는 `running` 실행만 죽은 실행입니다. |
| LR-2 주기 회수 제외 | 주기 회수(11.2, `:startup=false`)는 레지스트리에 있는 실행을 회수하지 않습니다. 임대가 만료된 활성 실행에는 즉시 갱신(LR-3)을 시도하고, 갱신이 0행이면 `AbortSignal`만 올립니다. |
| LR-3 절전 복귀 순서 | `Clock`이 절전 복귀를 감지하면(02 7.5) 회수보다 먼저 레지스트리의 모든 실행에 대해 임대 갱신을 한 번 실행합니다. 갱신은 `lease_run_id=:run` 조건이라 만료 여부와 관계없이 다른 실행이 가져가지 않은 임대는 되살아납니다. 그다음 회수를 돌립니다. |
| LR-4 상태 전이 CAS | `ProviderCall`·예약·실행 상태 변경은 모두 `WHERE status=<기대 상태>` 조건부 UPDATE입니다. 0행이면 현재 상태를 다시 읽어 분기합니다(6.2절 P3·P4·P5, 8.1절 연결). |

가정: `lease.ttl_seconds`(300) > `llm.call_timeout_seconds`(180) + 갱신 주기 여유. 이 관계가 깨지면 정상 호출 중 임대가 만료될 수 있으므로 설치 설정 검증(`doctor`, → 08)에서 `ttl ≥ call_timeout + 2 × renew_interval`을 검사합니다.

### 5.3 DB 제약 (03에 추가 제안)

```sql
-- 같은 화의 원고 작성 작업은 동시에 하나만 실행
CREATE UNIQUE INDEX tasks_one_manuscript_writer_per_episode
  ON tasks (novel_id, episode_id)
  WHERE status = 'running'
    AND kind IN ('outline_episode','draft_episode','revise_episode','polish_episode');
```
5.1절 UPDATE가 이 인덱스로 실패하면(유일 위반) 획득 실패로 처리합니다. 03 INV-TSK에 불변식으로 추가할지는 18절 미결입니다.

---

## 6. 실행(`Run`) 내부

### 6.1 핸들러 계약

`task_kind`마다 `AgentTaskHandler` 하나를 `agents` 모듈에 등록합니다. 실행 엔진은 세 단계를 순서대로 부릅니다.

| 단계 | 하는 일 | 쓰기 | 실패 시 |
|---|---|---|---|
| `buildContext` | 9절 규칙으로 `ContextPack` 구성, `ContextSnapshot` 저장 | `context_snapshots` 1행 | `context.build_timeout_seconds` 초과·조회 오류 → `error_family=internal` |
| `execute` | 프롬프트 렌더링, `ModelCallPort.call` 0회 이상, 출력 검증(zod + 도메인 규칙: 엔티티 핸들이 닫힌 목록 안, 술어가 스키마 안) | `provider_calls`, `cost_events`, `budget_reservations`만 | 7절 |
| `commit` | 제안을 모듈 API로 반영, 후속 작업·깨우기 생성, Task 종료 | 도메인 테이블, 1 트랜잭션, 펜싱(5.2) | 트랜잭션 롤백 → `error_family=internal`, T5 |

`commit` 결과 종류:
| 결과 | 작업 전이 | 실행 |
|---|---|---|
| `done` | T4 | R4, `stop_reason=completed` |
| `awaiting_human` (차단형 질문·승인 생성) | T7 | R6, `stop_reason=awaiting_human` |
| `retry` (재시도 가능한 도메인 사유: 예 대상 버전이 아직 준비 안 됨) | T5 | R5 |
| `failed` (상한 초과) | T6 | R5 |

### 6.2 `ProviderCall` 상태 기계 (`provider_call_status`)

03 4.11이 이 문서에 위임한 전이입니다. 예약·원장 처리는 03 7.4의 단계 번호를 따릅니다.

| # | from | to | 트리거 | 같은 트랜잭션의 비용 처리 (03 7.4) |
|---|---|---|---|---|
| P1 | (생성) | `prepared` | 예약 성공 | 1·2단계: `BudgetReservation(active)`, `reservation_id`, `max_cost_micros` |
| P2 | `prepared` | `sent` | 발송 직전 커밋 | 3단계. 커밋 후에만 외부 호출 |
| P3 | `sent` | `responded` | 응답 수신 | 4단계: 응답·`usage` 저장 → `CostEvent`(`measured`/`estimated`) → 예약 `settled` → `runs.safe_point_seq = seq` |
| P4 | `sent` | `failed` | 공급자 오류 응답 | 5단계: 과금 보고 있으면 `CostEvent`, 없으면 예약 `released` |
| P5 | `sent` | `unknown` | 호출 타임아웃, 또는 회수(11절) | 6단계: `CostEvent(cost_basis=unknown, amount=예약액)`, 예약 `unknown_closed`, `cost.unknown_recorded` |
| P6 | `prepared` | `abandoned` | 발송 전에 실행 종료(일시정지·취소·임대 상실) | 예약 `released`. 행은 미발송 기록으로 남음(00 6.3) |
| P7 | `unknown` | `responded_late` | `unknown`으로 닫힌 뒤 원래 실행이 응답을 받음 | 응답·`usage` 저장. 원장은 새 호출 행이 아니라 정정 행(`adjusts_cost_event_id`=unknown 행, `provider_call_id` 없음, `idempotency_key=pcl:<id>:late`, 금액 = 실측 − 예약액)으로 고칩니다(INV-COST-04, 행 형식 → 03 7.3 "정정 행" 표). `provider_call_status.responded_late`(00 6.3) |

P3·P4·P5는 `UPDATE provider_calls SET status=… WHERE id=:id AND status='sent'`(LR-4)입니다. 0행이면 현재 상태를 읽어 분기합니다: `unknown`이면 P7, 그 밖이면 이미 처리된 것으로 보고 아무것도 쓰지 않습니다. 그래서 회수와 늦은 응답이 겹쳐도 응답 저장 트랜잭션이 `cost_events.provider_call_id` 유일 위반으로 롤백되거나 원장이 2행이 되지 않습니다(INV-COST-01). `responded_late` 행은 RU-2 재사용 대상입니다.

재시도는 같은 행을 바꾸지 않고 새 행(`retry_of_call_id`)을 만듭니다.

### 6.3 응답 재사용 (FR-AGT-02 (2), INV-PC-02)

| 규칙 | 내용 |
|---|---|
| RU-1 | `request_hash = sha256(정규화 JSON{provider, model_id, system, messages, output 스키마 이름·해시, max_output_tokens, temperature, seed, sample_index})`. 비밀·메타데이터(`run_id`, 시각)는 넣지 않습니다. |
| RU-2 | 호출 전 같은 작업의 실행 사슬(`rerun_of_run_id`로 이어진 실행들)에서 `request_hash`가 같고 `status ∈ {responded, responded_late}`인 행을 찾으면 호출하지 않고 그 응답을 씁니다. 새 `ProviderCall` 행·예약·원장 행을 만들지 않습니다. |
| RU-3 | 재사용이 성립하려면 같은 요청이 다시 만들어져야 합니다. 회수 후 재실행은 원 실행의 `ContextSnapshot` 내용을 복제해 쓰고(새 행, 같은 ID 목록, `cloned_from_snapshot_id`=원 스냅숏, 03 3.3), 프롬프트를 스냅숏의 불변 사실 버전에서 다시 렌더링합니다. 템플릿 버전(`prompt_template_version`)이 같아야 합니다. |
| RU-4 | 출력 검증 실패 후 재시도는 검증 오류를 메시지에 덧붙이므로 해시가 달라 재사용되지 않습니다. 다회 샘플(L4 `prompt.self_consistency_samples`)은 `sample_index`로 구분합니다. |
| RU-5 | `failed`, `unknown` 행은 재사용하지 않습니다. 재호출 비용은 `CostEvent.is_rerun=true`로 표시합니다(FR-AGT-02 (4)). |

조회 인덱스: `provider_calls (novel_id, request_hash) WHERE status IN ('responded','responded_late')`(→ 08 마이그레이션).

### 6.4 안전 지점과 checkpoint (FR-HIL-03)

`RunHandle.checkpoint()`는 외부 호출 직전과 `commit` 직전에 호출합니다. 진행 중인 외부 호출은 끊지 않으므로 실행이 멈추는 곳은 항상 "직전 호출의 응답이 저장된 시점"(`safe_point`)입니다.

| 확인 | 참이면 |
|---|---|
| 임대 상실(5.2) | `stop_reason=lease_lost`, 작업 손대지 않음(회수 경로가 처리) |
| 작품·아크·화·작업 `paused_at` | `stop_reason=paused`, 작업 `running → ready`(03 4.2 하단, `paused_at` 유지) |
| 작업 `cancelled` 또는 대체됨, 재배정 대기(`input.reassign_to`, 2.2) | `stop_reason=cancelled_by_user` / `superseded` |
| 예산 `hard_stopped`(이 작품의 해당 범주) | `stop_reason=budget_blocked`, T7(`budget`) |
| 공급자 차단기 열림(7.3) | `stop_reason=error`, `error_family=provider_unavailable`, T7(`provider_unavailable`) |

멈춘 실행의 응답 저장분은 다음 실행이 RU-2로 재사용합니다.

---

## 7. 재시도·재작성 상한 (NFR-COST-02, R-8)

### 7.1 상한 계층

| 층 | 단위 | 상한 키 (00 7절) | 도달 시 | 사람에게 드러나는 방식 |
|---|---|---|---|---|
| 호출 | `ProviderCall` 재시도 | `llm.max_retries_per_call`(3), 백오프 `llm.retry_backoff_seconds` | 작업 층으로 실패 전달 | 실행 기록 |
| 작업 | `Task` 시도 | `task.max_attempts`(3) | T6 `failed` | 인박스·작업 보드 "사람 조치 필요"(FR-UI-02) |
| 추출 | 사실 추출 작업 | `extraction.max_retries`(2) | 화 `block_reasons += extraction_failure`, 차단형 질문(`topic=extraction_failure`, 5.7절) | 메신저 |
| 검사 루프 | 화 한 사이클의 자동 재작성 | `continuity.max_auto_rewrites_per_episode`(2) | `rewrite_limit` 표시 + 차단형 질문(3.3절) | 메신저 |
| 반려 | 화 반려 | `episode.max_rejections`(3) | E12 가드, 방향 결정 차단형 질문(INV-EP-05) | 메신저 |
| 품질 [v1] | 자가 평가 재작성 | `quality.max_rewrites`(2) | 차단형 질문(FR-AGT-09) | 메신저 |
| 미디어 [v1] | 생성 재시도 | `media.max_generation_retries`(2) | 질문(FR-IMG-05) | 메신저 |

`extract_facts` 작업은 `max_attempts`를 `extraction.max_retries + 1`로 만듭니다(TC-4의 예외).

### 7.2 `error_family`별 처리

| `error_family` | 호출 층 재시도 | 작업 층 | 범위 조치 |
|---|---|---|---|
| `rate_limited` | 공급자 `retry-after` 우선, 없으면 백오프. 횟수는 `llm.max_retries_per_call`과 별도로 세되 누적 대기 `llm.rate_limit_max_wait_seconds`(제안, 600초)까지 | 초과 시 T5(`not_before_at`) | 없음 |
| `timeout` | 재시도 안 함(P5 `unknown`으로 비용 기록 후) | T5 | 연속 3회면 차단기 계산에 포함 |
| `provider_unavailable` (5xx, 네트워크) | 백오프 재시도 | 상한 초과 시 T7(`provider_unavailable`) | 차단기(7.3) |
| `auth_failed` | 안 함 | T7(`provider_unavailable`) | 차단기 즉시 열림, 연결 점검 실행, 차단형 알림(`topic=provider_outage`, 5.7절) |
| `quota_exhausted` | 안 함 | T7(`provider_unavailable`) | 위와 같음 |
| `invalid_output` | 검증 오류를 붙여 재요청(RU-4). 같은 상한 | 상한 초과 시 T5, 작업 상한 초과 시 T6 | 없음 |
| `content_filtered` | 안전 지시를 강화한 프롬프트로 1회 | 실패 시 질문(`topic=creative_choice`: 수위 조정 / 해당 씬 생략 / 사람 작성). 작업 종류별 처리(추출 재시도, 검사 작업 T6, `check_text_safety`의 `safety_age_rating` 이슈)는 → 07 9절 | 없음 |
| `budget_blocked` | 안 함 | T7(`budget`) | 8.3절 |
| `internal` | 안 함 | T5 | 같은 작업 연속 `internal`은 T6 |

출력이 출력 토큰 상한에서 잘린 경우(`finishReason=length`)는 `invalid_output`으로 분류합니다. 상한은 `RoleModelBinding.max_output_tokens`를 넘겨 올리지 않습니다(FR-AGT-08).

### 7.3 공급자 장애 차단기

PRD 5.7절 "해당 공급자를 쓰는 작업만 일시정지"를 `pause_scope`(작품·아크·작업)가 아니라 작업 차단으로 구현합니다.

| 항목 | 내용 |
|---|---|
| 단위 | 설치 단위 `(provider_profile_id)`. 메모리 상태 + `health_check_results`(`kind=llm_key`) |
| 열림 조건 | `auth_failed`·`quota_exhausted` 1회, 또는 `provider_unavailable`·`timeout`이 5분 안에 5회(가정) |
| 열렸을 때 | 그 공급자를 `RoleModelBinding`으로 쓰는 역할의 `ready` 작업을 T8(`provider_unavailable`), 실행 중이면 checkpoint에서 정지. 작품별 차단형 알림 1건(같은 장애는 합침) |
| 닫힘 | 연결 점검(`llm_key`) `pass` 또는 사용자 "재개". T9 + `user_resume`/`retry` 깨우기 |
| 대체 모델 [v1] | `fallback_enabled=true`면 차단 대신 `fallback_model_id`로 실행하고 산출물에 `is_fallback_model=true`(FR-AGT-11, D-21) |

---

## 8. 비용 예약·정산 (실행 측)

테이블·불변식은 → 03 7절(INV-COST-01~05). 이 절은 실행 엔진이 언제 무엇을 부르는지 정합니다.

### 8.1 예약 시점

| 시점 | 예약 | 목적 |
|---|---|---|
| 실행 입장(R2 직전) | 첫 호출 상한만큼 `BudgetReservation(active, provider_call_id=NULL)`. 첫 `ProviderCall`이 생기면 연결 | INV-COST-02: 예약 상한을 포함해 한도를 넘는 상태로 실행을 시작하지 않음 |
| 각 호출 직전(P1) | 그 호출의 상한 | 호출 단위로 상한 보장 |
| 결정적 작업(LLM 없음) | 없음 | — |

모든 예약은 `budget` 모듈의 `reserve()` 한 함수로 하고, 함수 안에서 작품 단위 advisory lock(`pg_advisory_xact_lock(hashtextextended('budget:' || novel_id, 0))`)을 잡습니다(03 7.4 1단계).

입장 예약을 첫 호출에 연결하는 `attachToCall`은 `UPDATE budget_reservations SET provider_call_id=:pcl WHERE id=:rsv AND status='active' AND provider_call_id IS NULL`(LR-4)입니다. 0행이면(예: `budget.reservation_stale_after_minutes` 정리가 이미 `released`로 바꿈) 그 호출은 발송하지 않고 `reserve()`로 다시 예약한 뒤 진행합니다. 예약 없이 발송하는 경로는 없습니다. 오래된 예약 정리(02 7.2 `budget_reservations` 행)는 활성 실행 레지스트리(LR-1)에 있는 실행의 예약을 제외합니다.

### 8.2 상한 계산 (FR-BUD-03)

```
llm_max_cost = ceil(input_tokens_upper × input_price_per_token)
             + max_output_tokens × output_price_per_token
input_tokens_upper = adapter.countInputTokens(req)            // 공급자가 제공하면
                   | ceil(local_estimate × (1 + budget.input_token_margin_ratio))   // 제안, 0.10
```
- 단가는 `ProviderProfile`의 활성 버전(FR-BUD-04). 캐시 입력 할인은 예약에 반영하지 않습니다(상한이므로 정가).
- 추론(reasoning) 토큰이 `max_output_tokens`에 포함되는지는 공급자마다 다릅니다 [미확인]. 포함되지 않는 모델은 `ProviderProfile.models[].max_output_tokens`와 별도 추론 상한이 둘 다 있어야 상한을 계산할 수 있고, 없으면 8.4절로 갑니다.
- 미디어 상한은 공급자 최대 과금(장수·초·해상도) → 07.

### 8.3 한도 도달 시 실행 측 동작

| 상황 | 동작 |
|---|---|
| 입장 예약 실패 (a) 실지출 기준 초과: `원장 합 + 이번 예약 > hard_limit` | 실행 R3, 작업 T8(`budget`). 정책 상태가 `ok`였다면 이 시점에 `hard_stopped` 전이(03 7.4 7단계)와 `budget_resume` 승인 질문 |
| 입장 예약 실패 (b) 다른 실행 예약 때문: `원장 합 + 이번 예약 ≤ hard_limit < 원장 합 + active 예약 합 + 이번 예약` | 실행 R3, 작업 T8(`block_reason=budget_reservation_wait`). 정책 전이·일시정지·질문 없음. 다른 예약이 `settled`·`released`·`unknown_closed`가 되는 트랜잭션에서 그 작품의 대기 작업을 T9로 풀고 `budget_released` 깨우기(`idempotency_key=budget_rel:<reservation_id>:<task_id>`)를 넣습니다. 스케줄러 tick도 대기 작업을 다시 평가합니다(깨우기 누락 대비). enum 값 `task_block_reason.budget_reservation_wait`, `wake_reason.budget_released`는 00 6.3에 등록됐습니다. 입장 단계 (a)/(b) 구분은 → 03 7.4 1·7단계 |
| 실행 중 다음 호출 예약 실패 | 진행 중 호출은 이미 예약돼 있어 끝까지 받고 저장. 다음 checkpoint에서 `stop_reason=budget_blocked`, T7. 원인 구분은 입장 예약과 같음((a)면 `budget`, (b)면 `budget_reservation_wait`) |
| 다른 실행이 진행 중 | 각자 예약 범위 안에서 현재 호출을 끝냄. 예약이 상한이므로 원장 합은 한도를 넘지 않음. 넘는 금액은 실측이 예약을 초과한 경우뿐(`overrun_micros`, INV-COST-03) |
| 재개 | `budget_resume` 승인 → 정책 `ok`, `novels.paused_at` 해제(`pause_reason=budget_hard_limit`일 때), 예산 차단 작업 T9 + `budget_resumed` 깨우기 |

한 작품의 한도는 다른 작품을 막지 않습니다(T-5).

(b)를 (a)와 나누는 이유: 동시 실행 2개(`run.max_concurrent_per_novel`=2)에서 한 실행이 큰 상한 예약을 쥐고 있으면, 실제 지출이 한도에 닿지 않았는데도 작품 전체가 멈추고 승인 질문이 생깁니다. 정산된 실측은 보통 상한보다 작으므로 이 정지는 거짓 정지이고, 차단형 질문 수 KPI와 R-5를 악화시킵니다. `unknown` 원장(금액 = 예약액)이 쌓여 실제보다 이르게 (a)에 닿는 문제는 공급자 사용량 API로 정정하는 경로(18절 U-19, v1)로 다룹니다.

### 8.4 상한을 계산할 수 없는 호출

단가가 없는 모델, 출력 상한을 줄 수 없는 호출이 해당합니다. `BudgetPolicy.unpriced_usage_policy`를 따릅니다.
| 값 | 동작 |
|---|---|
| `block` (기본) | 예약 거부, 작업 T8(`budget`), 인박스에 "공급자 프로필 단가 등록 필요" 표시 |
| `require_approval` | 사람 승인 후 1회 실행. 승인 유형이 00에 없어 MVP는 `block`만 지원(18절 미결) |

### 8.5 미디어 견적 [v1/v2]

견적 승인(`MediaQuote.status=approved`)은 작업의 `pending → ready` 게이트입니다(3.2절). 견적이 승인돼도 호출마다 따로 예약합니다(INV-COST-05). 견적 계산식·초과 처리 → 07.

### 8.6 집계

- `CostEvent`의 `arc_id`·`episode_id`·`scene_id`·`shot_id`는 실행의 작업에서 복사합니다(FR-BUD-01 집계 차원).
- 화당 비용(NFR-COST-01, KPI): `episode_id`별 원장 합(재작성·`is_rerun` 포함) ÷ 승인 화 수. 재작성·재시도 비중은 `tasks.input.rework_cause`와 `is_rerun`으로 나눕니다(FR-BUD-05, v1 화면).
- 월말 예상 소진액(FR-BUD-05, v1): 이번 창 원장 합 ÷ 경과 일수 × 창 일수. 가정: 단순 선형 외삽으로 시작합니다.

---

## 9. 컨텍스트 구성 (FR-AGT-04, NFR-COST-03, FR-ONT-14·17)

`agents` 모듈의 `ContextBuilder`가 담당합니다. 온톨로지 조회는 모두 06이 소유한 `OntologyRepository` 읽기 메서드를 거칩니다.

### 9.1 ID 경유 규칙

R-18의 오병합·오분리가 집필 컨텍스트로 새지 않게 하는 규칙입니다.

| # | 규칙 | 막는 문제 |
|---|---|---|
| C-1 | 컨텍스트의 세계관 항목은 모두 `fact_version_id`, `entity_id`, `entity_name_id`, `setup_id` 중 하나를 가집니다. 이 ID 목록이 `ContextSnapshot`입니다. | 출처 없는 사실 주입 |
| C-2 | 조회 시드는 엔티티 ID입니다. 시드는 아웃라인의 씬 계획(`outline_data`의 등장 엔티티 ID), 씬 등장(`scene_participants`), 활성 떡밥의 연결 엔티티, 작업 입력의 답변 제약에서만 옵니다. | 이름 문자열 검색 결과의 동명이인 혼입 |
| C-3 | 자유 텍스트(사용자 답변 원문, 사람 메모, 아웃라인 서술) 속 표기는 `linking` 모듈의 L0~L8(→ 06)을 거친 `Mention.linked_entity_id`로만 시드가 됩니다. `buildContext`는 LLM을 호출하지 않고, 구성 전에 끝난 링킹 결과(앞 작업이 커밋한 `Mention`)만 씁니다. 링킹되지 않은 표기는 시드가 되지 않습니다. `ambiguous`·`new_entity_candidate` 언급은 시드에서 빼고 "미해결 표기" 섹션에 후보 카드로만 보여 줍니다. | 표기 일치만으로 연결 |
| C-4 | 칭호·호칭 표기("폐하", "형님")는 앵커 시점·시간선의 보유자·화자 조건으로 해석된 엔티티 ID만 씁니다. 해석은 06의 이름 사전 질의가 합니다. 선행 화가 승인 전이면 06 3.5 "선행 미승인 화 오버레이" 규칙을 따릅니다(캐논과 오버레이 보유자가 다르면 그 칭호는 시드로 확정하지 않고 두 보유자를 후보 카드로 넣음). | 칭호 보유자 혼동 |
| C-5 | `candidate` 사실은 "미확정" 표시와 함께 넣습니다(FR-AGT-04). 단, 엔티티 참조 중 하나라도 `ambiguous`·`new_entity_candidate` 언급에서 나온 후보 사실은 넣지 않고 건수만 표시합니다. | 잘못 연결된 후보 사실이 다음 화 근거가 됨 |
| C-6 | `merged` 엔티티 ID는 `merged_into_id`로 바꾼 뒤 시드로 씁니다. `retired` 엔티티는 제외합니다. | 병합 전 ID로 갈라진 조회 |
| C-7 | `hidden_variant` 이름은 넣지 않습니다(검색 전용, 00 6.10). | 오타·변형 표기가 본문에 재생산 |
| C-8 | 텍스트 유사도·벡터 검색은 링킹 후보 생성(L2)에만 씁니다. 컨텍스트 조회는 ID 조인·재귀 질의만 씁니다(ADR-005). 원문 단락을 임베딩 순위로 고르는 경로도 MVP에는 두지 않습니다(06 10.1과 같음, 18절 U-20) | 유사도 기반 사실 혼입 |
| C-9 | 자유 텍스트 요약·원문(엔티티 요약, 화 요약, 직전 화 원문)은 C-1~C-8을 우회합니다. 그래서 9.3절 규칙으로 층·시점을 맞춘 것만 넣습니다 | 미래 사실·정체·미해석 칭호가 요약 문장으로 혼입 |

### 9.2 앵커와 시드

| 항목 | 정하는 방법 |
|---|---|
| 앵커 `story_point` | 화 작업: 대상 씬 `story_point`(씬 단위 섹션) 또는 화 시작 `episode_no×1000`(화 전체). 기획 작업: `0` 또는 아크 시작 화 |
| 앵커 `timeline_id` | 씬 `timeline_id`, 없으면 화의 `primary_timeline_id`(FR-ONT-04) |
| `pov_entity_id` | 씬 계획의 시점 인물. 씬마다 다르면 씬 단위 섹션을 따로 만듦 |
| 시드 엔티티 | C-2·C-3 출처의 합집합. C-6 정규화 |
| 시드 떡밥 | 이번 화에 배정된 `SetupBeat`의 떡밥 + 기한 경고 범위(`setup.due_warning_episodes`) 안 떡밥 |
| 시드 답변 | `tasks.input.answer_ids` + 시드 엔티티에 걸린 `fact_kind=constraint` 사실의 출처 답변(FR-MSG-09) |

### 9.3 조회 경로 (그래프 RAG)

```
seed entity_ids ─┬─ 엔티티 카드: 앵커에서 쓸 수 있는 이름(9.4)·유형·카드 문장(아래 표)
                 ├─ 1홉: 앵커에서 유효한 relation/attribute/state 사실 (story_range @> anchor, timeline 일치)
                 ├─ 2홉: 역할별 허용 술어만 (예: writer = 관계·소속·위치, continuity_editor = 전부)
                 ├─ 인물 지식: pov_entity_id(와 대사 화자 후보)의 knowledge 사실 (knows/suspects/misbelieves/unaware)
                 └─ 제약: fact_kind=constraint, 시드 엔티티 또는 작품 전역
seed setups ────── 떡밥 카드: 서사 상태, 배정 비트, 설치 근거 사실 버전
glossary ───────── 시드 엔티티·스키마 항목에 연결된 용어와 표기 규칙(FR-ONT-19)
manuscript ─────── 직전 화 마지막 씬 원문 일부 + 최근 화 요약(원고 전체는 넣지 않음, NFR-COST-03). 조건은 아래 표
```

모든 사실 질의는 "앵커 시점·시간선에서 참인 현재 버전"을 기준으로 하고, 시간 질의 문법은 → 06(ADR-007).

**자유 텍스트 항목의 층 규칙** (C-9)

| 항목 | 캐논 층 역할(9.4) | `writer`·`line_editor` |
|---|---|---|
| 엔티티 카드 문장 | `entities.summary`(06 2.4, 사실 전체에서 다시 만든 요약) 사용 가능 | `entities.summary`를 넣지 않습니다. 06 10.2 C4(앵커 시점·시간선 캐논)·C5(시점 필터)를 거친 사실 버전으로 그 자리에서 카드 문장을 만듭니다. 그래서 앵커 이후 사실, 다른 시간선 사실, 시점 인물이 모르는 정체가 들어가지 않습니다. `summary`는 화면·캐논 층 역할 전용입니다 |
| 최근 화 요약 | `episode_recaps(layer=canon)` | `episode_recaps(layer=reader, pov_entity_id)`만. reader 층 요약은 생성 후 06 Q4(`findIdentityLeaks`)·CR-07a 사전 필터를 통과한 것만 씁니다. 통과하지 못하면 그 화 요약은 빼고 실행 기록에 남깁니다 |
| 직전 화 원문(끝 씬) | 그대로 | 그 씬의 `pov_entity_id`가 이번 씬 시점 인물과 같거나, 그 씬의 언급이 모두 `confirmed`·`auto_linked`이고 이번 시점 인물에게 `identityKnownBy`가 거짓인 이름의 언급이 없을 때만 넣습니다. 아니면 reader 층 요약으로 대체합니다 |

`episode_recaps`(화·층·시점 인물별 요약, 원천 아님, 승인 화의 최종 버전에서 생성)는 → 03 3.2 `EpisodeRecap`, `ContextSnapshot.episode_recap_ids`입니다. 넣은 요약·원문 구간은 `ContextSnapshot`에 버전 ID로 기록합니다(C-1).

### 9.4 이름 표시 규칙 (FR-ONT-17)

컨텍스트 층은 06 3.12·7절의 3층(캐논/독자/인물)이고, 역할별로 받는 층은 → 06 10.3을 따릅니다. 이 문서는 그 표를 적용하는 방법만 둡니다.

| 역할 | 캐논 층 (정체 포함, 대표명 + 핸들) | 독자 층 | 시점 인물 층 |
|---|---|---|---|
| `planner` | ○ | ○ | — |
| `continuity_editor`, `world_keeper`, `foreshadow_manager` | ○ | ○ | ○ |
| `writer`, `line_editor` | **넣지 않음** | ○ | ○ |
| `showrunner` | ○ (가정: 질문 등급 판정에 진실 필요, 06 10.3 `showrunner` 행) | ○ | — |
| `scene_director` [v1] | 넣지 않음 (가정: 프롬프트 산출물도 독자에게 보이는 결과물) | ○ | ○ |

| 규칙 | 내용 |
|---|---|
| 이름 판정 | `ContextBuilder`는 이름 사용 여부를 직접 판정하지 않고 06 3.3 함수를 그대로 호출합니다. 표시 이름(표기 사용)은 `nameUsableBy`, 정체 연결과 금지 표기 목록은 `identityKnownBy`입니다(06 3.3 `surfaceKnownBy`/`identityKnownBy`). 그래서 `surface_known_by_entity_ids`·`identity_known_by_entity_ids`, 캐논 지식 사실 `knows_identity`, 서술자(`narrator`)의 `reader_reveal_point`가 모두 같은 규칙으로 반영됩니다. |
| 시점 인물 층 | `viewer = pov_entity_id`(대사 화자 후보 포함)로 판정합니다. 카드 구성은 → 06 10.2 C6: 정체를 모르면(`identityKnownBy` 거짓) 위장명 카드와 본명 카드를 나누고, 둘이 같다는 정보는 프롬프트에 넣지 않습니다(`ContextSnapshot`에만 기록, 06 10.4). |
| 독자 층 | `viewer = narrator`로 판정합니다. 시점 인물은 알지만 독자가 아직 모르면(`p < reader_reveal_point`) 06 10.2 C6대로 카드를 합치고 "독자 공개 전: 동일성을 단정하는 서술·대사 금지" 제약을 붙입니다. 이것이 극적 아이러니의 허용 범위입니다. |
| 서술 방식별 이름 선택 | 3인칭 전지 서술은 독자 층, 1인칭·3인칭 제한 서술은 시점 인물 층을 기준으로 이름을 고릅니다. 서술 방식은 씬의 `narration_mode`(없으면 작품 기본값, 그것도 없으면 `pov_entity_id`가 있을 때 `third_limited`)로 정합니다(06 3.3). |
| 금지 표기 | `writer`·`line_editor` 컨텍스트에는 "서술·대사에 쓰면 안 되는 표기" 목록을 함께 넣습니다. 목록은 viewer에게 `identityKnownBy`가 거짓인 이름입니다(06 3.3 "판정에 쓰는 함수"). 이를 어긴 원고는 CR-07a·CR-08a·CR-08b(`identity_leak`·`character_knowledge`)로 검출됩니다(→ 06 9절, 07). |

### 9.5 섹션과 토큰 예산

| 순위 | 섹션 | 잘라 낼 수 있는가 |
|---|---|---|
| 1 | 작업 지시, 출력 스키마, 안전 지시(연령 등급, NFR-SAFE-01) | 아니오 |
| 2 | 답변 제약, 배정 떡밥 비트, 아웃라인(이번 화) | 아니오 |
| 3 | 시드 엔티티 카드(카드 분리·합침과 제약은 06 10.2 C6), 9.4절 층별 이름·금지 표기, 인물 지식 | 아니오 |
| 4 | 1홉 캐논 사실 | 오래된 `story_range` 시작부터 |
| 5 | 용어집 | 시드에 연결되지 않은 항목부터 |
| 6 | 2홉 사실, 미확정 사실 | 전부 가능 |
| 7 | 직전 화 원문 일부, 최근 화 요약 | 오래된 화부터 |

- 상한은 역할별 `context.max_input_tokens.<role>`(제안: `writer` 40,000, `concept_partner` 16,000, 그 밖 24,000)입니다.
- `concept_partner`는 위 섹션 표 대신 11 2.6의 구조화 상태 중심 섹션(S1 작업 중 브리프 → S2 미결 슬롯·다음 질문 후보 → S3 최근 메시지 `concept.recent_messages_in_context`(8)개 → S4 씨앗 원문 4,000자 → S5 해당 슬롯 `ConceptQuestionDef` → S6 금지 목록·연령 상한·`avoid_list`)을 씁니다. 대화 이력 전체를 넣지 않습니다(다중 턴 저하 완화). 온톨로지 조회는 없습니다(컨셉 단계에는 캐논이 없음). 스냅숏은 `ContextSnapshot.concept_message_ids`(03 3.3)에 남깁니다. 1~3순위만으로 상한을 넘으면 작업은 `invalid_output`이 아니라 `internal` 오류로 실패하고 인박스에 "컨텍스트 상한 초과"를 표시합니다(조용히 자르지 않음, FR-AGT-10).
- 안정적인 앞부분(작업 지시, 기획서 요약, 용어집)을 먼저 두어 공급자 프롬프트 캐시를 쓸 수 있게 합니다. 캐시 사용량은 `cached_tokens`로 원장에 남깁니다.
- 구성 시간 상한과 성능 목표를 나눕니다. 실패 타임아웃은 `context.build_timeout_seconds`(안전 상한, 00 7.2, 가정 60초)이고, 넘으면 `internal` 오류입니다. NFR-PERF-04의 p90 10초는 `ContextSnapshot.build_ms`로 집계하는 관측 목표 `context.build_p90_target_seconds`(제안, 10초)이고, 초과는 실패가 아니라 W 지표 경고입니다(→ 09). p90을 타임아웃으로 쓰면 목표를 달성한 상태에서도 약 10%의 구성이 실패하고 `task.max_attempts`를 소모하기 때문입니다. 00 7.2 `context.build_timeout_seconds` 행(현재 10)과 09 보정 일정 표를 이에 맞게 고쳐야 합니다.

### 9.6 엔티티 핸들

구조화 출력(아웃라인, 사실 추출, 판별)에서 에이전트는 엔티티를 이름이 아니라 핸들로 가리킵니다.

| 항목 | 규칙 |
|---|---|
| 형식 | `E<n>`. `n`은 `ContextSnapshot.entity_ids`의 1부터 시작하는 위치. 이름 핸들은 `N<n>`(`entity_name_ids` 위치) |
| 검증 | 출력의 핸들이 스냅숏 범위 밖이면 `invalid_output` |
| 신규 대상 | 핸들 대신 `{"new": "<표기>"}`로 내면 `linking`에 `new_entity_candidate` 언급으로 넘김(FR-ONT-15) |
| 본문(산문) | 핸들을 쓰지 않습니다. 본문 속 표기는 사실 추출·링킹 단계가 엔티티 ID로 연결합니다(→ 07) |

핸들은 프롬프트 토큰을 줄이고, LLM이 존재하지 않는 ID를 만들어 내는 것을 막습니다(닫힌 후보, 00 ADR-006 차용 항목).

### 9.7 스냅숏과 재현

- 실행당 `ContextSnapshot` 1행(03 3.3). 회수 후 재실행은 원 스냅숏 내용을 복제한 새 행을 씁니다(RU-3).
- 프롬프트 원문은 `request_hash`를 키로 파일 저장소에 한 번만 저장하고 `runs.log_storage_key`에서 참조합니다(ADR-015). 비밀은 프롬프트에 넣지 않습니다(NFR-SEC-02). 외부 공급자로 보내는 범위는 이 원문이 기준입니다(NFR-SEC-04).
- KPI "답변 반영 성공률" (1)은 `context_snapshots.answer_ids`로 판정합니다.

### 9.8 06에 요구하는 읽기 포트

메서드 이름은 06 11.4 `OntologyRepository`의 이름을 씁니다. 아래 표의 메서드는 모두 06 11.4에 같은 이름으로 들어 있습니다(18절 U-10 해소).

| 04가 필요한 기능 | 06 11.4 메서드 | 상태 |
|---|---|---|
| 병합 ID 정규화(C-6) | `resolveEntityId` (여러 ID 일괄 호출판 `resolveEntityIds`) | 있음 / 일괄판 추가 요청 |
| 앵커 시점 캐논·안전한 후보(C-5) | `getCanonAt(scope, entity_ids, p, T, {include: 'canon' \| 'canon_and_safe_candidates'})` | 있음. `canon_and_safe_candidates`가 C-5 후보 제외 옵션(06 11.4) |
| 인물·독자 지식 | `knowledgeOf(scope, viewer, p, T)` | 있음 |
| 이름 판정(9.4) | `nameValidAt` / `surfaceKnownBy` / `identityKnownBy` / `nameUsableBy` | 있음 |
| 엔티티 카드(10.2 C6 카드 분리·합침, 9.3 카드 문장) | `getEntityCards` | 06 추가 요청 |
| 제약 사실(답변 제약 포함) | `getConstraints` | 06 추가 요청 |
| 용어집 카드 | `getGlossary` | 06 추가 요청(MVP-β, 06 5절) |

```ts
// apps/server/src/modules/ontology/application/ports.ts (06 소유, 04가 사용)
export interface StoryAnchor { storyPoint: number; timelineId: string; povEntityId?: string }
type Viewer = string | 'narrator';                                                                // 06 3.3

export interface OntologyContextReader extends Pick<OntologyRepository,
  'resolveEntityId' | 'getCanonAt' | 'knowledgeOf' | 'nameValidAt' | 'surfaceKnownBy' | 'identityKnownBy' | 'nameKnownBy' | 'nameUsableBy'> {
  // 06 11.4
  resolveEntityIds(scope: NovelScope, ids: string[]): Promise<Map<string, string>>;               // C-6 일괄
  getEntityCards(scope: NovelScope, ids: string[], anchor: StoryAnchor,
    layer: 'canon' | 'reader' | 'pov'): Promise<EntityCard[]>;                                   // 9.4 층, 06 10.2 C6
  getConstraints(scope: NovelScope, q: { entityIds: string[]; answerIds: string[]; anchor: StoryAnchor }): Promise<FactAtAnchor[]>;
  getGlossary(scope: NovelScope, q: { entityIds: string[] }): Promise<GlossaryCard[]>;
}
// FactAtAnchor는 최소 { factId, factVersionId, canonStatus, text, subjectEntityId, objectEntityId? } 를 가져야 합니다.
```

---

## 10. LLM 어댑터 SPI (ADR-010, FR-AGT-08, NFR-EXT-01)

### 10.1 계층

| 계층 | 이름 | 모듈·위치 | 책임 |
|---|---|---|---|
| 포트(공급자) | `LlmAdapter` | `llm/application/ports.ts` | 공급자 API 호출 1회, 오류 분류, 사용량 보고. 상태 없음 |
| 구현 | `AiSdkLlmAdapter` | `llm/adapters/ai-sdk/` | Vercel AI SDK(`ai` + `@ai-sdk/*`) 위 구현. 공급자별 설정만 다름 |
| 가짜 | `FakeLlmAdapter` | `packages/test-kit` | 골든셋·재시작 테스트용 결정적 응답, 오류 주입 |
| 게이트웨이 | `LlmGateway` (`ModelCallPort` 구현) | `llm/application/` | 모델 지정 해석, 예약, `ProviderCall` 저널, 재사용, 재시도, 원장, 차단기 |
| 사용자 | `AgentTaskHandler` | `agents/` | `ModelCallPort.call`만 씀. `LlmAdapter`를 직접 부르지 않음 |

### 10.2 TypeScript 시그니처

```ts
// packages/shared/src/enums.ts 에서 파생 (ADR-013)
import type { AgentRole, ErrorFamily, TaskKind } from '@ncs/shared';
import type { z } from 'zod';

/* ───────── 공급자 포트 ───────── */

export interface LlmAdapter {
  /** ProviderProfile.provider 와 같은 값. 예: 'anthropic', 'openai', 'google' */
  readonly provider: string;

  /** 모델별 기능. ProviderProfile.models[] 값과 교차 검증합니다. */
  capabilities(modelId: string): LlmCapabilities;

  /** 연결 점검(FR-SET-03 llm_key). 과금이 없거나 최소인 호출만 씁니다. */
  testEnvironment(input: {
    apiKey: string;
    modelId?: string;
    signal: AbortSignal;
  }): Promise<LlmEnvironmentCheck>;

  /** 공급자가 입력 토큰 계산을 제공할 때만 구현합니다(8.2). */
  countInputTokens?(req: LlmRequest, opts: { apiKey: string; signal: AbortSignal }): Promise<number>;

  /** 호출 1회. 재시도·저장·비용 처리는 하지 않습니다(LlmGateway 책임). 예외를 던지지 않고 결과로 돌려줍니다. */
  invoke(req: LlmRequest, opts: LlmInvokeOptions): Promise<LlmResult>;
}

export interface LlmCapabilities {
  structuredOutput: 'json_schema' | 'tool_call' | 'none';
  maxContextTokens: number;
  maxOutputTokens: number;
  promptCaching: boolean;
  reportsUsage: boolean;          // false면 cost_basis=estimated 로만 기록
  reportsCost: boolean;           // true면 공급자 보고 비용을 measured 로 우선(FR-BUD-04)
  outputLimitCoversReasoning: boolean | 'unknown';   // 8.2. 'unknown'이면 상한 계산 불가
}

export interface LlmEnvironmentCheck {
  status: 'pass' | 'warn' | 'fail';          // health_status
  errorFamily?: ErrorFamily;
  remainingBalanceMicros?: bigint;           // 공급자가 제공할 때만
  message: string;                           // 사용자 표시용, 비밀 미포함
}

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 이 메시지까지를 프롬프트 캐시 경계로 표시(공급자가 지원할 때) */
  cacheBoundary?: boolean;
}

export type LlmOutputSpec =
  | { kind: 'text' }
  | { kind: 'object'; schemaName: string; jsonSchema: Record<string, unknown> };

export interface LlmRequest {
  modelId: string;
  system: string;
  messages: LlmMessage[];
  output: LlmOutputSpec;
  /** 필수. 없는 요청은 만들 수 없습니다(FR-AGT-08, FR-BUD-03). */
  maxOutputTokens: number;
  temperature?: number;
  seed?: number;
}

export interface LlmInvokeOptions {
  apiKey: string;                 // secrets 모듈이 해석. 로그·저장 금지(NFR-SEC-02)
  signal: AbortSignal;
  timeoutMs: number;              // llm.call_timeout_seconds
  /** 공급자 쪽 멱등 키를 지원하면 전달(ProviderCall.idempotency_key) */
  idempotencyKey?: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  reportedCostMicros?: bigint;    // 공급자가 비용을 줄 때
}

export type LlmResult =
  | {
      ok: true;
      text?: string;              // output.kind === 'text'
      object?: unknown;           // output.kind === 'object' (검증 전 값)
      finishReason: 'stop' | 'length' | 'content_filter' | 'other';
      usage: LlmUsage;
      modelVersion?: string;      // 응답에 실제 모델 버전이 있으면(FR-AGT-08)
      providerRequestId?: string;
      raw: unknown;               // 저장용 원응답(비밀 제거)
    }
  | {
      ok: false;
      errorFamily: ErrorFamily;
      message: string;
      httpStatus?: number;
      retryNotBefore?: Date;      // retry-after 등
      billed: 'yes' | 'no' | 'unknown';   // P4/P5 분기(6.2)
      usage?: LlmUsage;
      providerRequestId?: string;
    };

/* ───────── 에이전트가 쓰는 포트 ───────── */

export interface RunHandle {
  readonly novelId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly role: AgentRole;
  readonly signal: AbortSignal;   // 임대 상실·종료 시 abort
  /** safe_point 확인(6.4). 멈춰야 하면 RunStop 을 던집니다. */
  checkpoint(): Promise<void>;
}

export interface ModelCallInput<T> {
  run: RunHandle;
  /** 실행 안 호출 목적. 로그·KPI 분류용. 예: 'draft', 'repair', 'l4_sample' */
  purpose: string;
  sampleIndex?: number;           // RU-4
  system: string;
  messages: LlmMessage[];
  output: { kind: 'text' } | { kind: 'object'; schemaName: string; schema: z.ZodType<T> };
  /** RoleModelBinding.max_output_tokens 이하만 허용 */
  maxOutputTokens?: number;
  temperature?: number;
}

export interface ModelCallOutput<T> {
  providerCallId: string;
  reused: boolean;                // RU-2
  value: T | string;              // object 면 zod 검증을 통과한 값
  usage: LlmUsage;
  costMicros: bigint;             // 재사용이면 0n
  modelId: string;
  modelVersion?: string;
}

export interface ModelCallPort {
  /** 바인딩 해석 → checkpoint → 예약(P1) → sent(P2) → invoke → 저장(P3/P4/P5) → 검증 → 필요 시 재시도. */
  call<T>(input: ModelCallInput<T>): Promise<ModelCallOutput<T>>;
}

/** call 이 실패로 끝날 때 던집니다. 실행 엔진이 7.2 표로 작업 전이를 정합니다. */
export class ModelCallError extends Error {
  constructor(
    readonly errorFamily: ErrorFamily,
    readonly providerCallId: string | null,
    readonly retryNotBefore?: Date,
  ) { super(errorFamily); }
}

/* ───────── 작업 핸들러 ───────── */

export type CommitOutcome =
  | { kind: 'done'; outputRefs: Array<{ refType: string; refId: string }> }
  | { kind: 'awaiting_human'; blockReason: 'question' | 'approval'; blockedRef: { refType: 'question' | 'approval'; refId: string } }
  | { kind: 'retry'; reason: string; notBefore?: Date }
  | { kind: 'failed'; reason: string };

export interface AgentTaskHandler<I, P> {
  readonly kind: TaskKind;
  readonly role: AgentRole;
  /** `<agent_role>.<task_kind>@<semver>` (runs.prompt_template_version) */
  readonly promptTemplateVersion: string;
  readonly inputSchema: z.ZodType<I>;
  /** 2.3절 허용 쓰기 API 이름 목록(런타임 가드) */
  readonly allowedWrites: readonly string[];

  buildContext(run: RunHandle, input: I, builder: ContextBuilder): Promise<ContextPack>;
  /** 도메인 쓰기 금지. 제안만 돌려줍니다(P-2). */
  execute(run: RunHandle, input: I, context: ContextPack, llm: ModelCallPort): Promise<P>;
  /** 결정적 쓰기. 실행 엔진이 연 트랜잭션 안에서 호출되며 펜싱(5.2)이 먼저 수행됩니다. */
  commit(tx: Tx, run: RunHandle, input: I, proposal: P): Promise<CommitOutcome>;
}

export interface ContextBuilder {
  build(spec: ContextSpec): Promise<ContextPack>;
  /** RU-3: 회수 후 재실행 시 원 스냅숏 복제 */
  cloneFrom(snapshotId: string, run: RunHandle): Promise<ContextPack>;
}

export interface ContextSpec {
  anchor: StoryAnchor;
  seeds: { entityIds: string[]; setupIds: string[]; answerIds: string[]; mentionIds: string[] };
  sections: ContextSectionKind[];
  maxInputTokens: number;         // context.max_input_tokens.<role>
  hopPredicates: { hop2: string[] | 'all' };
}

export type ContextSectionKind =
  | 'instruction' | 'constraints' | 'assigned_beats' | 'outline'
  | 'entity_cards' | 'pov_names' | 'knowledge' | 'canon_1hop'
  | 'glossary' | 'canon_2hop' | 'candidates' | 'unresolved_surfaces' | 'recent_text';

export interface ContextPack {
  snapshotId: string;             // ctx_…
  system: string;                 // 안정 앞부분(캐시 대상)
  messages: LlmMessage[];
  handles: { entities: string[]; names: string[] };   // E<n>, N<n> 해석표(9.6)
  tokenEstimate: number;
  droppedSections: ContextSectionKind[];             // 잘라 낸 섹션(순위 4~7만)
}
```

`NovelScope`, `Tx`, `StoryAnchor`, `EntityCard`, `FactAtAnchor`, `GlossaryCard`는 → 03 T-3, 02, 06 타입을 씁니다.

### 10.3 오류 분류 기준 (구현 공통)

| 공급자 응답 | `error_family` |
|---|---|
| HTTP 401, 403 | `auth_failed` |
| 잔액·결제·쿼터 소진을 뜻하는 오류(HTTP 402 또는 공급자 오류 코드) | `quota_exhausted` |
| HTTP 429(쿼터 소진이 아닌 경우) | `rate_limited` |
| HTTP 5xx, 연결 실패, DNS | `provider_unavailable` |
| `timeoutMs` 초과, 스트림 중단 | `timeout` |
| `finishReason=content_filter`, 안전 거부 오류 | `content_filtered` |
| 스키마 파싱 실패, `finishReason=length`(object) | `invalid_output`(게이트웨이 판정) |

공급자별 오류 코드 표는 구현 시 각 공급자 1차 문서로 채웁니다(→ 08).

### 10.4 구현 메모

- Vercel AI SDK의 `generateText`/`generateObject`에 출력 토큰 상한·`abortSignal`을 넘깁니다. 매개변수 이름과 SDK 버전은 → 08에서 고정합니다 [미확인: 이 문서에서 SDK 문서를 다시 확인하지 않음].
- 스트리밍은 MVP에서 쓰지 않습니다. 응답 전체를 받은 뒤 저장(P3)하는 편이 "응답 선저장" 규칙과 맞습니다. 실시간 진행 표시는 실행 상태로 대신합니다.
- `modelVersion`을 응답에서 얻지 못하면 `ProviderProfile.models[].model_version`을 씁니다(FR-AGT-08 "모델 ID와 버전").
- Paperclip adapter SPI에서 가져온 아이디어: `testEnvironment`, `errorFamily`, `retryNotBefore`, 사용량 보고. 코딩 CLI 실행 계약(`execute(ctx)`, 세션, 스킬)은 쓰지 않습니다 [1차, `packages/adapter-utils/src/types.ts:506`].

### 10.5 모델 지정 해석

`LlmGateway`는 호출마다 `RoleModelBinding(novel_id, run.role)`을 읽습니다. 실행 시작 시점의 바인딩을 실행 동안 고정하고 `runs.models_used`에 기록합니다. 바인딩 변경은 다음 실행부터 적용됩니다(FR-AGT-08). `max_output_tokens`가 없는 바인딩은 저장 단계에서 거부합니다.

### 10.6 이미지·영상 어댑터 [v1/v2]

같은 `ProviderCall`·예약·원장 경로를 쓰고 `provider_kind=image|video`로 구분합니다. 결과물은 응답 저장 단계에서 즉시 내려받아 파일 저장소에 둡니다(FR-IMG-04). 인터페이스 → 07.

---

## 11. 고아 실행 회수와 재시작 (NFR-REL-01)

### 11.1 서버 시작 복구 순서

순서 전체는 → 02 7.1. 이 표는 실행 계층이 맡는 단계만 02 순서대로 적습니다.

| 순서 | 동작 | 근거 |
|---|---|---|
| 1 | 인스턴스 잠금 획득(→ 02 2.3): 파일 잠금(`local_trusted`) 후, 두 모드 모두 전용 연결로 세션 advisory lock `instance_lock`(`pg_try_advisory_lock`) 획득. 실패하면 다른 프로세스가 살아 있으므로 기동 중단 | ADR-002, 02 2.3 |
| 2 | 마이그레이션 게이트 통과(→ 02 7.1·8.5, 08). 잠금을 먼저 잡으므로 두 프로세스가 동시에 마이그레이션하지 않습니다 | NFR-REL-05 |
| 3 | 두 모드 모두 앱 프로세스는 1개(02 2.3)이고 1을 얻었으므로 `runs.status ∈ {queued, running}`인 모든 실행은 죽은 프로세스의 것입니다. 임대 만료를 기다리지 않고 11.2절 회수를 즉시 수행합니다(`:startup=true`) | FR-AGT-02 (1) |
| 4 | 미정산 예약 정리: 실행이 종료됐는데 `active`인 예약 → 연결 호출 상태에 따라 `released`/`unknown_closed` | INV-COST-02 |
| 5 | dispatcher, 임대 갱신 타이머, 회수 스캐너(`reclaim.scan_interval_seconds`), 스케줄러 시작 | — |
| 6 | 즉시 `schedule` 깨우기 1건 | 재개 |

### 11.2 회수 절차 (한 실행당 1 트랜잭션)

```sql
SELECT r.id, t.id FROM runs r
  JOIN tasks t ON t.novel_id = r.novel_id AND t.lease_run_id = r.id
 WHERE r.status = 'running'
   AND (:startup OR (t.lease_expires_at < now() AND r.id <> ALL(:active_run_ids)))   -- LR-1·LR-2
 FOR UPDATE OF r, t SKIP LOCKED;
```
주기 회수(`:startup=false`)는 활성 실행 레지스트리(LR-1)의 `run_id`를 제외합니다. 단일 프로세스이므로 주기 회수의 대상은 "레지스트리에 없는 `running` 실행"뿐입니다. 절전 복귀 시에는 LR-3(활성 실행 임대 즉시 갱신)을 먼저 실행한 뒤 이 회수를 돌립니다.

1. `provider_calls.status = sent` → `unknown`(P5, `WHERE status='sent'` CAS): `CostEvent(cost_basis=unknown)`, 예약 `unknown_closed`, `cost.unknown_recorded`.
2. `prepared` → `abandoned`, 예약 `released`(P6).
3. 실행 R7(`interrupted`, `stop_reason=lease_lost`), `run.interrupted`.
4. 작업 T10(`running → ready`, 임대 해제, `attempt_count` 유지), `task.lease_reclaimed`.
5. `reclaim` 깨우기. 새 실행은 `rerun_of_run_id`를 갖고(R1), 스냅숏을 복제하며(RU-3), 응답 저장분을 재사용합니다(RU-2).
6. `queued`로 남은 실행(임대 전 종료)은 R3(`cancelled`), 연결 깨우기는 이미 `claimed`이므로 같은 작업에 `reclaim` 깨우기를 새로 넣습니다.

Paperclip은 stale 회수에만 `FOR UPDATE`를 쓰고 기존 실행이 종료·부재일 때만 넘겨받습니다 [1차, `issues.ts:7599·7606`]. 이 설계는 같은 원칙을 따르되, 판정을 "인스턴스 잠금으로 증명된 이전 프로세스 부재(시작 시)" 또는 "임대 만료이고 활성 실행 레지스트리에 없음(주기)"으로 합니다.

### 11.3 FR-AGT-02 수용 기준 대응

| 수용 기준 | 보장 수단 | 검증 (→ 09 스파이크·테스트) |
|---|---|---|
| (1) 중단된 작업이 다시 큐에 들어감 | 11.2 4·5단계, 시작 복구 3단계 | 실행 중 `SIGKILL` 후 재시작 → 같은 작업이 `ready`·새 실행 |
| (2) 저장한 응답은 다시 호출하지 않음 | P3 선저장, RU-2·RU-3 | 가짜 어댑터 호출 횟수 계수 |
| (3) 원장 중복 0건 | `cost_events.provider_call_id` 유일, `idempotency_key` 유일(INV-COST-01), 재사용 시 원장 행 없음 | `provider_call_id`가 있는 원장 행 수 = `responded`+`failed(billed)`+`unknown`+`responded_late` 호출 수, 정정 행 수 = `responded_late` 호출 수 |
| 회수와 늦은 응답이 겹쳐도 응답·원장이 맞음 | LR-1~LR-4, P7 | 절전 주입(FakeClock 점프) 중 응답 도착: 응답 보존, 호출 원장 1행 + 정정 1행 이하, 활성 실행은 회수되지 않음 |
| (4) 미수신 호출은 `unknown_cost`/예약액, 재실행 비용 별도 | P5, `is_rerun=true` | 발송 후 강제 종료 시나리오 |
| 같은 작업을 두 실행이 동시에 수정하지 않음 | CAS 임대(5.1), 펜싱(5.2), 부분 유일 인덱스(5.3) | 동시 claim 경합 테스트 |

NFR-REL-01의 질문·승인 상태 유지는 해당 전이가 모두 PG 트랜잭션이라 별도 복구가 필요 없습니다. 발신함·수신함 재처리는 → 05.

---

## 12. 일시정지·재개 (FR-HIL-03)

| 범위 (`pause_scope`) | 설정 | 효과 | 재개 |
|---|---|---|---|
| `novel` | `novels.paused_at`, `pause_reason` | 새 임대 없음(5.1 조건), 실행 중은 checkpoint에서 정지. 질문 발송은 05 규칙(차단형 대기열 유지) | `paused_at` 해제 → `ready` 작업 전부에 `user_resume` 깨우기. `pause_reason=budget_hard_limit`·`ontology_integrity`는 각각 `budget_resume` 승인·무결성 점검 통과가 있어야 해제 |
| `arc` | `arcs.paused_at` | 그 아크 작업만 | 같은 방식, 아크 범위 |
| `task` | `tasks.paused_at` | 그 작업만 | 그 작업에 `user_resume` |

- 일시정지·재개는 `novel.paused`/`arc.paused`/`task.paused`(및 `*.resumed`)로 감사 로그에 남습니다.
- 공급자 장애는 일시정지가 아니라 작업 차단입니다(7.3절).
- 온톨로지 무결성 실패(PRD 5.7절 "온톨로지 저장소 손상")는 `pause_reason=ontology_integrity`로 작품 전체를 멈춥니다. 캐논 없이 집필하지 않습니다.

---

## 13. 모듈 공개 API

ADR-008에 따라 다른 모듈은 아래 `application` 공개 API로만 부릅니다. 모든 함수는 첫 인자로 `NovelScope`(T-3)를, 쓰기 함수는 호출자 트랜잭션 `Tx`를 받습니다.

```ts
// modules/orchestration/application/index.ts
export interface OrchestrationApi {
  createTask(tx: Tx, scope: NovelScope, input: {
    kind: TaskKind; targetType: TargetType; targetId: string;
    input: unknown; dependsOn?: string[]; createdBy: ActorRef; cycleKey?: string;
  }): Promise<{ taskId: string; created: boolean }>;                       // TC-1~3
  requestWake(tx: Tx, scope: NovelScope, w: {
    taskId: string | null; reason: WakeReason; idempotencyKey: string;
    notBefore?: Date; source?: { refType: RefType; refId: string };
  }): Promise<{ wakeId: string; status: 'pending' | 'coalesced' | 'duplicate' }>;
  unblockByRef(tx: Tx, scope: NovelScope, ref: { refType: 'question' | 'approval' | 'budget_policy'; refId: string },
    wake: { reason: WakeReason; keyPrefix: string }, addAnswerId?: string): Promise<string[]>;   // T9
  pause(tx: Tx, scope: NovelScope, target: { scope: PauseScope; id: string }, reason: PauseReason, actor: ActorRef): Promise<void>;
  resume(tx: Tx, scope: NovelScope, target: { scope: PauseScope; id: string }, actor: ActorRef): Promise<void>;
  cancelTask(tx: Tx, scope: NovelScope, taskId: string, actor: ActorRef, supersededBy?: string): Promise<void>;
  reassignTask(tx: Tx, scope: NovelScope, taskId: string, toRole: AgentRole, actor: ActorRef)
    : Promise<{ applied: 'now' | 'after_safe_point' } | { rejected: 'role_not_allowed' | 'terminal' }>;   // 2.2 재배정, task.reassigned
  blockTasksForProvider(tx: Tx, providerProfileId: string): Promise<number>;   // 7.3, 설치 단위
}

// modules/budget/application/index.ts
export interface BudgetApi {
  reserve(tx: Tx, scope: NovelScope, r: {
    runId: string; category: CostCategory; maxCostMicros: bigint | null;     // null = 상한 계산 불가(8.4)
  }): Promise<{ ok: true; reservationId: string }
    | { ok: false; reason: 'hard_limit' | 'reservation_wait' | 'unpriced' }>;   // 8.3 (a) / (b) / 8.4
  attachToCall(tx: Tx, scope: NovelScope, reservationId: string, providerCallId: string)
    : Promise<{ attached: boolean }>;                                           // WHERE status='active' CAS. false면 발송 금지, 다시 reserve (8.1)
  settle(tx: Tx, scope: NovelScope, s: {
    providerCallId: string; basis: CostBasis; amountMicros: bigint; usage: LlmUsage;
    providerProfileId: string; providerProfileVersion: number; isRerun: boolean;
  }): Promise<{ costEventId: string; overrunMicros: bigint }>;
  release(tx: Tx, scope: NovelScope, reservationId: string): Promise<void>;
  closeUnknown(tx: Tx, scope: NovelScope, providerCallId: string): Promise<{ costEventId: string }>;
  status(scope: NovelScope, category: CostCategory): Promise<BudgetStatus>;
}
```

`agents` 모듈은 `AgentTaskHandler` 등록부(`registerHandler`)와 `ContextBuilder`, `llm` 모듈은 `ModelCallPort`와 `LlmAdapter` 등록부를 공개합니다(10.2절).

---

## 14. 관측성 (NFR-OBS-02)

| 기록 | 위치 | 용도 |
|---|---|---|
| 실행 요약 | `runs`: 템플릿 버전, `models_used`, 토큰, `cost_micros`, 시작·종료, `stop_reason`, `error_family`, `output_summary` | 9절 KPI, 작업 보드 |
| 입력 컨텍스트 | `context_snapshots`(ID 목록, `token_estimate`, `build_ms`) + 프롬프트 원문 파일 | FR-AGT-04, 재현 |
| 호출 | `provider_calls`(요청 해시, 사용량, 상태, 응답) | FR-AGT-02, 비용 근거 |
| 상태 변경 | `activity_log`의 `task.*`, `run.*`, `budget.*`, `cost.*` (03 6.3) | FR-UI-07 |
| 화당 생성 시간 | `episode.status_changed` 이벤트로 `outlining` 진입~`awaiting_approval` 진입 시간에서 `block_reasons`가 `question`/`approval`인 구간을 뺌 | KPI G-2, NFR-PERF-01 |

실시간 표시(FR-UI-08)는 감사 로그 `seq` 기반 발행을 따릅니다(ADR-017, → 02).

---

## 15. 요구 추적

| 요구 | 이 문서 절 | 다른 문서 |
|---|---|---|
| FR-AGT-01 | 2.2, 3.1 | 03 INV-TSK-01 |
| FR-AGT-02 | 5, 6.2, 6.3, 11 | 03 INV-PC, INV-COST |
| FR-AGT-03 | 3.3 | 07 |
| FR-AGT-04 | 9 | 06 |
| FR-AGT-05 | 2.2(`split_scenes`) | 07 |
| FR-AGT-06 | 3.4 | — |
| FR-AGT-07 | 3.5 | 05 |
| FR-AGT-08 | 10.2, 10.5 | 03 `RoleModelBinding`, 08 |
| FR-AGT-09 [v1] | 7.1 | 07 |
| FR-AGT-10 | P-2, P-7, 9.5 | 06·07(자동 수정 기록) |
| FR-AGT-11 [v1] | 7.3 | — |
| FR-AGT-12 | 3.3, 7.1 | 03 E1~E16, 05 |
| FR-BUD-01 | 6.2, 8.6 | 03 7.3 |
| FR-BUD-02 | 8.3 | 03 7.1, 7.4 |
| FR-BUD-03 | 8.1, 8.2, 8.4 | 03 7.2 |
| FR-BUD-04 | 8.2, 10.2(`reportsCost`) | 03 `ProviderProfile` |
| FR-BUD-05 [v1] | 8.6 | UI |
| FR-BUD-06a/b [v1/v2] | 3.2, 8.5 | 07 |
| FR-HIL-03 | 6.4, 12 | 03 4.2 |
| FR-HIL-04 (작업 할당) | 2.2 작업 재배정, 13 `reassignTask` | 03 6.3 `task.reassigned`, 07 7.3 |
| NFR-COST-01 | 2.1(등급 가정), 8.6 | 09(실측) |
| NFR-COST-02 | 7 | — |
| NFR-COST-03 | 9.3, 9.5 | 06 |
| NFR-REL-01 | 11 | 02, 05 |
| NFR-REL-03 | 7.2, 7.3 | 05(메신저 rate limit) |
| NFR-PERF-04 | 9.5 | 09 스파이크 S-4 |
| 요구 A, FR-NOV-07~09·10a·11 (`concept_partner`) | 2.1, 2.2 컨셉 작업 규칙, 2.3, 3.4, 9.5 | 11 2절, 03 3.10 |

---

## 16. Paperclip 대응 요약

상세·라이선스 표기 → 10. 근거는 Paperclip main 커밋 `0cb3fc7`(2026-10-26) 소스 읽기 [1차] https://github.com/paperclipai/paperclip .

| Paperclip | 이 설계 | 판단 |
|---|---|---|
| issue checkout CAS UPDATE, stale run 채택(`FOR UPDATE`) | 5.1 임대 획득, 11.2 회수 | 패턴만 |
| `agent_wakeup_requests.idempotencyKey`(출처 접두어), heartbeat queue | 4절 `WakeRequest`, 합치기, dispatcher | 패턴만(코드는 heartbeat에 결합) |
| `budget_reservations`·`reserveRunBudget`, `unpricedUsagePolicy=block` | 8절 예약, 8.4 | 패턴만 |
| `cost_events.idempotencyKey` 유일 | `cost_events.idempotency_key = pcl:<id>` | 패턴만 |
| adapter SPI(`execute`, `testEnvironment`, `errorFamily`, `retryNotBefore`) | 10.2 `LlmAdapter` | 아이디어만, 계약은 따르지 않음 |
| heartbeat 실행 계층, 코딩 CLI 어댑터 | — | 따르지 않음(D-15) |

---

## 17. 00 기본값 레지스트리 추가 제안

아래 키는 모두 00 7절(7.1·7.2)에 등록됐습니다(값은 00이 단일 출처, `context.build_timeout_seconds`는 60으로 변경 완료). 이 표는 등록 이력으로 남깁니다(18절 U-2).

| 키 | 제안값 | 범위 | 근거 |
|---|---|---|---|
| `schedule.tick_seconds` | 60 | system | 스케줄러 주기. 가정 |
| `schedule.max_episodes_in_flight` | 2 | novel | 3.4절. `run.max_concurrent_per_novel`(2)와 맞춤. 가정 |
| `context.build_p90_target_seconds` | 10 | system | 9.5절 관측 목표(NFR-PERF-04). 초과는 경고. 기존 `context.build_timeout_seconds`는 안전 상한 60(가정)으로 값 변경 |
| `llm.rate_limit_max_wait_seconds` | 600 | system | 7.2절 `rate_limited` 누적 대기 상한. 가정 |
| `budget.input_token_margin_ratio` | 0.10 | system | 8.2절 입력 토큰 로컬 추정 여유. 가정, MVP 실측(추정 대비 실제) 후 보정 |
| `context.max_input_tokens.writer` | 40000 | novel | 9.5절. 가정, 첫 5화 비용·품질로 보정 |
| `context.max_input_tokens.default` | 24000 | novel | 9.5절. 가정 |
| `provider.breaker_failures` / `provider.breaker_window_seconds` | 5 / 300 | system | 7.3절 차단기. 가정 |

---

## 18. 미결 사항

| # | 항목 | 내용 | 정하는 시점·문서 |
|---|---|---|---|
| U-1 | `ProviderCall` 미발송 종료 값 | 해소: 00 6.3 `provider_call_status.abandoned` 등록, 6.2 P6 `prepared → abandoned` | — |
| U-2 | 새 기본값 키 | 해소: 17절 키 전부(`context.build_p90_target_seconds` 포함, `context.build_timeout_seconds`=60)가 00 7.2에 등록됐습니다. 큐 주기 키는 02의 `scheduler.poll_interval_seconds` 하나로 씀(`dispatcher.tick_seconds` 폐기). enum 값 `provider_call_status.responded_late`, `task_block_reason.budget_reservation_wait`, `wake_reason.budget_released`, `rework_cause`도 00 6.3에 등록됐습니다 | — |
| U-3 | 텍스트 필터 차단 질문 주제 | 해소: `question_topic=creative_choice`(00 6.4 기존 값, 07 3.2·9절). 7.2 표 반영 | — |
| U-4 | 상한 계산 불가 호출 승인 | `unpriced_usage_policy=require_approval`에 대응하는 `approval_type` 없음. MVP는 `block`만 지원 | 00 6.4, v1 전 |
| U-5 | 예산 창 경계의 재개 | 월이 바뀌어 한도 여유가 생겨도 `budget_resume` 승인을 요구할지(현재 설계: 요구, 6.3.1 표 "필수") | 사용자 확인, MVP-α 구현 전 |
| U-6 | 자동 재작성 사이클 카운터 | 해소: 03 3.2 `episodes.auto_rewrite_count`(정의 → 07 5.4). 3.3 반영 | — |
| U-7 | 원고 작성 작업 동시 실행 금지 | 5.3절 부분 유일 인덱스를 03 불변식(INV-TSK)으로 올릴지 | 03 개정 |
| U-8 | 스냅숏 복제 표시 | 해소: 03 3.3 `context_snapshots.cloned_from_snapshot_id`. RU-3 반영 | — |
| U-9 | `split_scenes` 담당 역할 | 해소: `world_keeper`(07 2.1). `render_prompts`는 `scene_director`로 정함(2.2 주). 07 10.2 X4 반영 완료 | — |
| U-10 | 06 읽기 포트 | 해소: `resolveEntityIds`, `getEntityCards`, `getConstraints`, `getGlossary`와 `getCanonAt` C-5 옵션(`include: 'canon_and_safe_candidates'`)이 06 11.4에 들어갔습니다 | — |
| U-11 | `ContextSectionKind` 등록 | 저장하지 않는 코드 내부 union으로 둠. 00 enum 레지스트리 대상인지 | 00 담당 검토 |
| U-12 | 추론 토큰과 출력 상한 | 모델별로 `max_output_tokens`가 추론 토큰을 포함하는지 [미확인]. 포함하지 않으면 상한 계산 불가 처리 | 08 공급자 선정 시 1차 문서 확인 |
| U-13 | 입력 토큰 계산 API | 공급자별 `countInputTokens` 제공 여부 [미확인] | 08 |
| U-14 | AI SDK 매개변수·버전 | 출력 상한 매개변수 이름, `abortSignal`, 구조화 출력 방식 [미확인] | 08 |
| U-15 | 역할별 모델 등급 | 2.1절 등급은 가정. 화당 비용 실측 후 조정 | MVP 첫 5화 후(D-9) |
| U-16 | 차단기·우선순위 상수 | 7.3 열림 조건, 3.4 우선순위 가중치, 예상 완료 시각 표본 수는 가정 | MVP-α 운영 1주 후 |
| U-17 | 다중 인스턴스 회수 | 두 모드 모두 단일 프로세스라 현재는 해당 없음(11.1). 다중 인스턴스를 지원하면 활성 실행 레지스트리(LR-1)가 프로세스별이 되므로 실행에 인스턴스 ID를 기록해 즉시 회수할지 | 다중 인스턴스 지원 시(02 10절) |
| U-18 | 화 N 재작성 후 N+1 영향 | N+1이 쓴 N의 사실이 바뀌었을 때 재작업 범위 | 07 |
| U-19 | `unknown_cost` 정정 | `unknown` 원장(금액 = 예약액)을 공급자 사용량 API로 확인해 정정 행(`adjusts_cost_event_id`)으로 고치는 경로. 쌓이면 실제보다 이르게 하드 한도(8.3 (a))에 닿음 | v1, 08 공급자 선정 시 사용량 API 확인 |
| U-20 | 원문 단락 임베딩 순위 | 해소: 06 10.1이 C-8과 같은 규칙(MVP 미사용, v1 조건부)으로 맞춰졌습니다 | — |
| U-22 | 컨셉 턴 즉시 깨우기 | 사용자 메시지 저장 뒤 `concept_turn`을 디스패처 주기(`scheduler.poll_interval_seconds` 5초)보다 빨리 시작할지(11 X-5, 관측 목표 `concept.turn_p90_target_seconds` 30초) | 02 개정, MVP-α K-C9 실측 |
| U-21 | `episode_recaps` | 해소: → 03 3.2 `EpisodeRecap`(`episode_recaps`), `ContextSnapshot.episode_recap_ids`, 00 5.1 `rcp`·6.2 `recap_layer` | — |
