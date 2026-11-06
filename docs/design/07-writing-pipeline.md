# 07. 집필 파이프라인

| 항목 | 내용 |
|---|---|
| 문서 | novel-create-studio 상세 설계 07 |
| 버전 | v0.2 (2026-10-28, 파이프라인 맨 앞 컨셉 단계 B0와 게이트 추가). v0.2.1(같은 날, 11 v0.2·계획서 교차 후속): B1 입력 `source_documents` 원문 보존·"원문 대비 변경" diff·원문 분할 실행, B1 출력 `source_field_path`·`character_key`, B2 `age_band` → 나이 사실·`concept_character_key`·칭호 엔티티 자동 생성(TI-1), 기획서 개정 승인·반려의 CB7·CB8 트리거, P3d 템플릿 규칙 평가 범위 E-1~E-4, PR-10 등급 키워드 목록을 11 X-9와 공유 |
| 버전 갱신 | v0.2.2 (2026-10-28): 사용자 결정 확정 반영. B0 차단 항목에 명시적 복제 요청(D-40)·실제 출간작 원작(D-35) 확정, B1·B2 사실 캐논 처리(11 O-C13), 템플릿 시점 MVP-β(FR-NOV-03b)·v1(FR-NOV-03c)(D-30), P3g·SF-3 실존 인물 이름 목록 방침(NFR-SAFE-02)·역사 인물 방침(D-33), 12절 해당 행 갱신 |
| 기준 | PRD v0.4 초안, `00-foundation.md` v0.2, `03-domain-model.md` v0.3, `11-concept-development.md` v0.1, 계획서 `../plans/genre-world-templates-plan.md` |
| 역할 | 화 단위 집필 파이프라인과 확장(씬→샷→IR→이미지→영상) 파이프라인의 **단계별 입력·출력·검사·실패 처리·게이트**를 정합니다. 상태 전이 규칙(E1~E16, SH1~SH8, M1~M8)은 → 03 4절이 소유하고, 이 문서는 전이를 다시 정의하지 않고 어느 단계가 어느 전이를 일으키는지만 적습니다. |
| 작성 | AI 초안. 사람 검토 필요 |

**목적**
- 화 하나가 `planned`에서 `published`까지 가는 동안 어느 역할이 어떤 입력으로 무엇을 만들고, 무엇을 검사하고, 실패하면 어떻게 멈추는지를 구현자가 그대로 옮길 수 있게 정합니다.
- 사실 추출이 언제나 언급 연결(→ 06)을 거쳐 엔티티 ID로 저장되는 경로를 고정합니다(R-18, D-27).

**범위**
- 포함: 컨셉 단계와 게이트(B0, 대화 내부 규칙은 → 11), 기획 단계(기획서 → 초기 온톨로지 → 아크 계획·떡밥 배치), 화 파이프라인 단계, 화 사이 의존, 사실 추출 → 링킹 → 후보 → 승격, 연속성·떡밥·텍스트 안전 검사와 재작성 루프, 씬 분할과 씬 ID 유지, 원고 버전·작성 주체, 반려·사람 편집, 원고 내보내기, 확장 파이프라인의 단계와 게이트.
- 제외(참조만): 작업·실행·임대·재시도·비용 예약 메커니즘(→ 04), 질문 등급 판정·digest·승인 질문 표시(→ 05), 링커 L0~L8 내부·임계값 운용·연속성 규칙 목록·컨텍스트 조회 질의(→ 06), 프로세스·이벤트 흐름(→ 02), diff 라이브러리·도구 선택(→ 08), 구현 순서(→ 09).

**관련 요구**

| 구분 | ID |
|---|---|
| 시나리오 | PRD 5.2, 5.3, 5.4, 5.5, 5.6, 5.7(사실 추출 실패, 재작성 미수렴) |
| 집필 | FR-AGT-01, 03, 04, 05, 06, 07, 09(v1), 10, 12 |
| 사람 개입 | FR-HIL-01a~c, FR-HIL-02, 03, 04, 05(원천 기록), 6.3.1 게이트 표 |
| 온톨로지·검사 | FR-ONT-02, 05, 06, 07, 12, 14, 15, 17, 18, 19 |
| 떡밥 | FR-FOR-02, 03(v1), 04, 08 |
| 원고 | FR-MAN-01, 02, 03, 04a, 07 |
| 기획 | FR-NOV-06, FR-NOV-07~09·10a·10b·11(컨셉 단계), FR-NOV-03b(템플릿 입력, MVP-β)·03c(v1), FR-HIL-02 |
| 메신저 | FR-MSG-05, 09, 16 |
| 확장 | FR-SPX-01~09, FR-IMG-01~08, FR-VID-01~10, FR-VIS-01~07, FR-BUD-06a/b |
| NFR | NFR-COST-02, 03, NFR-QUAL-01, NFR-OBS-01, 02, NFR-EXT-02, NFR-SAFE-01~03, NFR-PERF-01 |
| 결정·위험 | D-3, D-4, D-10, D-17, D-18, D-20, D-24, D-25, D-27 / R-4, R-10, R-11, R-17, R-18 |

**선행 문서**: `00-foundation.md`(용어, enum, 기본값), `03-domain-model.md`(엔티티, 상태 기계, 불변식). 함께 읽을 문서: 04, 05, 06(동시 작성 중).

**표기**: enum 값·기본값 키는 → 00 6·7절 이름을 그대로 씁니다. 전이 ID(E1 등)와 불변식 ID(INV-EP-02 등)는 → 03. **가정:** 은 실측 전 전제입니다.

---

## 1. 개요

### 1.1 흐름

```
 [planned] ─E1─▶ [outlining] ─E2─▶ [drafting] ─E3─▶ [checking] ─E6─▶ [polishing] ─E8─▶ [awaiting_approval] ─E9─▶ [approved] ─E13─▶ [published]
                  planner           writer            │  ▲                line_editor         │         │                     │
                  (+foreshadow)     초고+WriterAnn.   │  │E7(사실 diff)◀─────┘                 │E10      │E11                  │E14(정정)
                                                      │  │                                     ▼         ▼                     ▼
                                                      │  └─ 자동 수정(같은 단계, 새 버전)   [revising] ─E12─▶ outlining / drafting / polishing
                                                      ├─E4─▶ drafting (씬 단위 재작성)
                                                      └─E5─▶ outlining

 checking 내부:  split_scenes ─▶ extract_facts(L0) ─▶ link_mentions(L1~L8) ─▶ ┬─ check_continuity ──┬─▶ 게이트 판정(5.3절)
                                                                                ├─ check_setups ──────┤
                                                                                └─ check_text_safety ─┘
```

### 1.2 원칙

| ID | 원칙 | 근거 |
|---|---|---|
| PR-01 | 단계마다 산출물을 새 `ManuscriptVersion`(append-only)으로 남기고, 단계 이름은 `episode_status` 값과 같습니다. | FR-AGT-03, FR-MAN-01, INV-MV-01 |
| PR-02 | 원고에서 나온 모든 사실은 **언급 연결을 거친 엔티티 ID**로만 저장합니다. 이름 문자열로 사실을 쓰는 경로가 없습니다. writer가 낸 엔티티 ID 주석은 링커의 **힌트**일 뿐 연결 결과가 아닙니다(4.2절). | FR-ONT-12, 14, D-27, R-18 |
| PR-03 | 추출된 사실은 `candidate`로 시작하고, 6.3.1 게이트 표의 시점에만 캐논이 됩니다. `ambiguous`·`new_entity_candidate` 언급에 기대는 사실은 어느 자율성 수준에서도 자동 승격하지 않습니다. | FR-ONT-05, 14, F3 가드, NFR-QUAL-01 |
| PR-04 | 검사 통과 조건은 결정적입니다: 열린 `high` 이슈 0, `missing` 비트 0, 추출·링킹 완료. LLM 판정은 이슈를 만들 뿐 게이트를 직접 열지 않습니다. | FR-ONT-06, FR-FOR-08, INV-EP-02 |
| PR-10 | 텍스트 안전 검사(연령 등급 수위, 미성년 인물 성적 묘사, 실존 인물 사칭·명예훼손)는 모든 원고 버전에 돌고, 작품 설정·자율성 수준으로 끌 수 없습니다. | NFR-SAFE-01, 02 |
| PR-05 | 문제는 고치더라도 기록합니다. 자동 수정도 이슈·diff·근거가 남습니다. | FR-AGT-10, INV-CI-02 |
| PR-06 | 모든 반복(호출 재시도, 자동 재작성, 반려)에 상한이 있고, 상한은 해당 화만 멈추는 차단형 질문으로 넘깁니다. | NFR-COST-02, FR-AGT-12, FR-ONT-06 |
| PR-07 | 차단은 화 단위입니다. 한 화가 질문·이슈로 멈춰도 의존하지 않는 다른 화·아크는 진행합니다. | FR-AGT-07, NFR-PERF-03 |
| PR-08 | 사람이 쓴 구간은 에이전트가 승인 없이 바꾸지 못합니다. | FR-HIL-04, INV-MV-03 |
| PR-09 | 컨텍스트는 해당 화 시점·시간선의 필요한 캐논만 조회해 만듭니다. 작품 전체 원고를 넣지 않습니다. 조회 경로는 엔티티 ID를 거칩니다(→ 06 GraphRAG 절). | FR-AGT-04, NFR-COST-03 |

### 1.3 기획 단계 파이프라인 (FR-NOV-06~11, FR-FOR-02)

화 파이프라인(2절 이후)이 시작되려면 컨셉 브리프·기획서·아크 계획이 승인돼 있어야 합니다(INV-CON-07, E1 가드, INV-BIB-02, INV-ARC-02). `task_kind`·역할·생성 주체는 → 04 2.2를 따릅니다.

```
작품 생성(N1, novel_status=concept)
  └ B0 컨셉 ─ G0 concept_brief 승인(N2 → onboarding) ─ 목표 폼 저장(N3 → planning)
      └ B1 기획서 ─ B2 초기 온톨로지 ─ G1 series_bible 승인 ─ B3 아크 계획 + B4 떡밥 배치 ─ G2 arc_plan 승인 ─ 화 파이프라인
```

| 단계 | `task_kind` / 역할 | 입력 | 출력 | 결정적 검사 | 게이트 |
|---|---|---|---|---|---|
| B0 컨셉 (→ 11) | `concept_turn`·`import_concept` / `concept_partner`, `check_concept_brief` / `continuity_editor` | 사용자 씨앗·대화·붙여 넣기·폼 입력, 공통 질문 세트 `common@1`, [MVP-β/v1] 장르 템플릿 합성 결과(`template_refs`) | `ConceptMessage`, `working_brief`, 승인 요청 시 `ConceptBrief` 버전 | 다음 질문 슬롯 선택(11 3.5), 슬롯 갱신 가드 INV-CON-03, 필수 8필드 `confirmed`(INV-CON-05), 턴·세션 비용 상한(11 3.8), 점검 차단 항목(미성년 성적 맥락·`age_band` 미확인, 실존 인물 사칭, MVP 최대 등급 `age_15` 초과, 명시적 복제 요청(D-40: MVP는 예외 없이 차단, `mood_references`로 안내), 책빙의 원작이 실제 출간작(D-35: 경고가 아니라 승인 요청 차단, 컨셉 필수 질문 CQ-10b로 확인), 11 INV-CON-10~12) 0 | **G0** 승인 `concept_brief`(모든 자율성 수준에서 사람, 05 10.1). 승인 트랜잭션에서 `Novel` 반영(11 M-01~M-05), 장르 템플릿을 쓰면(MVP-β FR-NOV-03b, v1 FR-NOV-03c) 첫 스키마 버전 발행(06 4.7). 온톨로지 행은 만들지 않음(06 3.14) |
| (목표) | — (사용자 웹 폼) | 승인된 브리프의 결말·화수·주기 초기값(11 M-06·M-07) | `Goal` | INV-CON-07 | 목표 저장이 N3과 B1 작업 생성을 함께 함(04 2.2) |
| B1 기획서 | `plan_series_bible` / `planner` | **승인된 `ConceptBrief`**(`input.concept_brief_id`, 11 M-09~M-14·M-18·M-20), 브리프 `source_documents[]`가 가리키는 붙여 넣기 원문 전문(`input.source_message_ids`, 자르지 않음), `Goal`, 작품 설정(장르·`age_rating`·분량 프로필), 반려 사유(재작성 시). [v1] 템플릿 `reader_expectations` | `SeriesBible(draft → awaiting_approval)`: 세계관·인물·결말 방향·아크 개요. `concept_brief_id` 기록. 인물·세계 규칙·회피 요소 항목마다 `source_field_path`(그 항목이 온 브리프 필드 경로, 예: `main_characters[chr_2]`, 브리프에 없는 새 항목은 null)와 인물이면 `character_key`(브리프 인물 객체 키, 새 인물은 null)를 붙임 | 스키마 검증. `logline`은 브리프 값을 그대로 쓰고, `user_stated` 필드와 다른 내용은 승인 payload에 "컨셉 대비 변경" 목록으로 표시(11 6.2). 원문이 있으면 원문의 인물·규칙·아크를 보존하고, 원문과 다른 곳은 승인 payload에 **"원문 대비 변경"** diff(항목, 원문 인용, 기획서 값, 바꾼 이유)로 표시합니다. 원문 + 브리프 + 컨텍스트가 `context.max_input_tokens.planner`를 넘으면 원문을 자르지 않고 B1을 나눠 실행합니다: 같은 실행 안에서 원문을 문단 경계로 나눈 조각(조각당 상한의 50%, 가정)마다 "보존 항목 목록"(인물·규칙·아크·고유 설정과 원문 위치) 추출 호출을 하고, 마지막 호출이 목록 전체 + 브리프로 기획서를 씁니다. 조각 합은 원문 전체여야 합니다(누락 검사: 조각 경계 오프셋이 원문 길이를 빈틈없이 덮는지). 비용 예약은 호출마다 따로(04 8.1). 브리프 `open_questions[]`는 추천안 + 질문 초안(등급은 `showrunner`). 인물·장소 등 엔티티 후보는 이름 문자열로 사실을 쓰지 않고 B2 입력 목록으로만 둠. [v1] 독자 기대 범위 벗어남은 경고만 | 승인 `series_bible`(6.3.1 표). 승인 트랜잭션에서 기획서 출처 사실과 B2가 만든 사실 `approved`(INV-BIB-03, 11 O-C13 확정) |
| B2 초기 온톨로지 | `build_initial_ontology` / `world_keeper` | 승인된 기획서(항목별 `source_field_path`·`character_key` 포함), 승인 브리프, 활성 스키마(`base@1`, 장르 템플릿을 쓰면(MVP-β FR-NOV-03b, v1 FR-NOV-03c) 템플릿 확장 포함 첫 버전) | `Entity`·`EntityName`·`Fact`(`fact_source_kind=series_bible`. `source_field_path`의 origin이 `user_stated`·`user_edited`·`imported`면 `user_input`, 06 3.14), 인물 엔티티의 `concept_character_key`, 스키마 변경 제안. [MVP-β/v1] 템플릿 `title_defs`가 있으면 칭호 엔티티(06 3.5 TI-1~TI-5) | 4절과 같은 언급 연결 경로(`mention_source_kind=series_bible`). 동명·유사 이름은 `duplicate_entity` 질문(→ 06 3.10). 브리프 `avoid_list`는 `constraint` 사실. 인물 객체 `age_band`·`age_note`는 그 인물의 `age` 사실로 옮김(`child`·`teen`이면 미성년 표지 사실도 둠, 5.6 SF-2 사전 필터 입력. `unknown`은 사실을 만들지 않음). 빙의 인물 `body_name`·`persona_name`은 06 3.13 `body`·`persona` 이름. 같은 `character_key`의 기존 엔티티가 있으면(재작성·개정) 새 엔티티를 만들지 않고 06 3.14 이름 변경 경로. 칭호 생성(TI-1): `title_of` 대상 유형 엔티티마다 `title_defs` 항목별 `title` 엔티티 | 기획서 승인에 포함(별도 승인 없음). B2가 만든 사실은 `fact_source_kind`(`user_input` 포함)와 무관하게 기획서 승인 트랜잭션에서 캐논(INV-BIB-03, 11 O-C13 확정) |
| B3 아크 계획 | `plan_arc` / `planner` | 기획서, 캐논, 이전 아크 결과, 미회수 떡밥(Q5, → 06) | `Arc`(`planned_episode_from`~`to`, 목표·갈등·결말 조건), 화별 개요 | 화 범위가 다른 아크와 겹치지 않음(INV-ARC-01) | B4와 함께 승인 |
| B4 떡밥 배치 | `plan_setups` / `foreshadow_manager` | B3 출력, 기존 `Setup`, 캐논 | `Setup(narrative_status=planned, canon_status=candidate)`, `SetupBeat(plant/reinforce/payoff, status=planned, planned_episode_no)`, 기존 떡밥의 회수 비트 | 아래 SP-1~SP-4 | 승인 `arc_plan`(6.3.1 표, SC2). `full_auto`는 정보성 보고 후 자동 |

| ID | 떡밥 배치 검사 |
|---|---|
| SP-1 | 모든 비트의 `planned_episode_no`가 이 아크 화 범위 안에 있습니다(다른 아크에 이어지는 떡밥은 그 아크 계획 때 비트를 더합니다). |
| SP-2 | 회수(`payoff`) 비트의 화가 떡밥 기한 이하입니다: `due_kind=episode`면 `≤ due_episode_no`, `due_kind=arc`면 그 아크 끝 화 이하. |
| SP-3 | 이번 아크에서 만든 떡밥은 `plant` 비트가 있어야 하고, `plant` 화 < `reinforce` 화 ≤ `payoff` 화 순서입니다. 설치 없이 회수만 있는 떡밥은 거부합니다(이미 설치가 `confirmed`인 기존 떡밥의 회수 비트는 허용). |
| SP-4 | 비트가 가리키는 엔티티·사실은 ID입니다(`setup_links`, FR-ONT-12). |

**컨셉 개정과 기획 단계**(11 3.10): 기획서 승인 전에 새 `ConceptBrief`가 승인되면 진행 중 `plan_series_bible`은 T11(`superseded_by_task_id`)로 대체하고 새 브리프로 다시 만들며, `draft`·`awaiting_approval` 기획서는 `superseded`가 됩니다(MVP-α). 기획서 승인 뒤 개정은 새 브리프 승인(CB6, 브리프 `approved_direction`) 트랜잭션에서 `planner`의 기획서 개정 작업을 만들고, 결과는 기존 게이트(`series_bible`, `canon_change`, `retcon`, `ending_change`)를 그대로 거칩니다(MVP-β, 작업 종류 이름은 미정, 12절). 트리거: 기획서 개정본의 `series_bible` **승인(A2) 트랜잭션**에서 11 CB7(`approved_direction → approved`)·이전 브리프 CB5·M-01~M-05·`approved_concept_brief_id` 이동을 함께 하고, **반려(A3)로 개정 작업이 종료**되거나 사용자가 개정을 취소하면 같은 트랜잭션에서 CB8(`approved_direction → rejected`)을 합니다. 반려 뒤 재작성으로 이어지면 CB8을 하지 않고 다음 승인·종료까지 `approved_direction`을 유지합니다. 두 트랜잭션 모두 `outline_episode` 보류(11 3.10 "개정 중 집필")를 풉니다.

**B4 떡밥 패턴 입력**([MVP-β/v1], `base@2` B-11, D-32·D-30 확정, 06 4.7 TA-7): 템플릿 `setup_patterns`와 브리프 `core_hook`·미스터리 슬롯을 `plan_setups` 입력 후보로 넣습니다. 강제하지 않습니다.

검사 실패는 같은 실행 안에서 1회 보정 요청, 그래도 실패하면 작업 `failed`(3.1 P1과 같음). 승인된 계획의 비트는 P1 아웃라인에서 `OutlineData.scenes[].setup_beat_ids`로 씬에 배정되고(3.1절 결정적 검사 (3)), 그 화 검사(5.2절)에서 `detected`/`missing`이 정해집니다. 아크 계획 반려는 B3부터 다시 만듭니다.

---

## 2. 단계·상태·작업 대응

### 2.1 단계 표

| 단계 ID | 화 상태 | `task_kind` | 담당 `agent_role` | 산출물 | 일으키는 전이 |
|---|---|---|---|---|---|
| P0 계획 | `planned` | — (스케줄러), 판단이 필요할 때만 `schedule_episodes` | `system:scheduler` / `showrunner` | 화 행, 첫 `outline_episode` 작업(2.2절, → 04 3.4) | (생성) |
| P1 아웃라인 | `outlining` | `outline_episode` | `planner` | `ManuscriptVersion(kind=outline)` + `OutlineData` | E1(시작), E2 |
| P2 초고 | `drafting` | `draft_episode` | `writer` | `ManuscriptVersion(kind=draft)` + `WriterAnnotations` | E3 |
| P3a 씬 분할 | `checking` | `split_scenes` | `world_keeper` | `Scene` 행 갱신 | — |
| P3b 사실 추출 | `checking` | `extract_facts` | `world_keeper` | `ExtractionResult`, `Mention` 초안 | — |
| P3c 언급 연결 | `checking` | `link_mentions` | `world_keeper`(L4 판별 호출) | `Mention` 확정·보류, `SceneParticipant`, 후보 `Fact`·`Entity` | — |
| P3d 연속성 검사 | `checking` | `check_continuity` | `continuity_editor` | `ContinuityReport`, `ContinuityIssue` | E4·E6 판단 입력 |
| P3e 떡밥 검사 | `checking` | `check_setups` | `foreshadow_manager` | `SetupCheckReport`, `SetupBeat` 상태 | E4·E6 판단 입력 |
| P3g 텍스트 안전 검사 | `checking` | `check_text_safety`(00 6.3) | `continuity_editor` | `ContinuityIssue(kind=safety_*)`(5.6절) | E4·E6 판단 입력 |
| P3f 재작성 범위 결정 | `checking` | — (게이트 판정 일부) | `system:orchestrator` | `fix_scope`로 정한 E4/E5, 대상 씬, 후속 `revise_episode`(`writer`) 또는 `outline_episode`(`planner`) | E4, E5 |
| P4 다듬기 | `polishing` | `polish_episode` | `line_editor` | `ManuscriptVersion(kind=revision)` + `PolishReport` | E7, E8 |
| P5 승인 대기 | `awaiting_approval` | — (승인 질문, → 05) | — | `Approval(episode)` | E9, E10 |
| P6 재작성 계획 | `revising` | `plan_rework`(00 6.3) | `showrunner` | 대상 씬 목록, 후속 작업 1건(`outline_episode` / `revise_episode` / `polish_episode`) | E12 |
| P6 본문 재작성 | `drafting` | `revise_episode` | `writer` | `ManuscriptVersion(kind=revision)` | E3 |
| P7 공개 | `approved` → `published` | — | `user` / `system:publisher` | `published_version_id` | E13, E14 |

`split_scenes`를 `world_keeper`에 둔 이유: 씬의 장소·시점 인물·등장 엔티티·`story_point`는 온톨로지 쪽 데이터이고, 분할 자체는 대부분 결정적 처리입니다(6절). LLM은 경계 재추정과 요약에만 씁니다.

### 2.2 화 하나의 작업 DAG

작업을 미리 한꺼번에 만들지 않습니다. 스케줄러가 첫 `outline_episode`만 만들고(→ 04 3.4), 이후 작업은 앞 작업의 커밋 트랜잭션이 만듭니다(→ 04 2.2 "생성 주체" 열). 후속 작업의 `input.cycle_key`는 앞 작업이 만든 원고 버전 ID이고, 같은 키의 미종료 작업이 있으면 새로 만들지 않습니다(04 TC-2). 실행·임대·재시도는 → 04.

| 작업 | 생성 시점(앞 작업 커밋) | `cycle_key` | 비고 |
|---|---|---|---|
| `outline_episode` | 스케줄러(첫 회), E5(게이트 판정), `plan_rework`(E12 `outline`) | 직전 아웃라인 버전 ID 또는 화 ID(첫 회, 가정) | E1 가드: 기획서 `approved`, 아크 계획 승인. 화 사이 의존은 2.3절 ED-1 |
| `draft_episode` | `outline_episode` 커밋(아웃라인 버전 저장) | 아웃라인 버전 ID | |
| `split_scenes` | `draft_episode`·`revise_episode`·`polish_episode`(사실 diff 시)·자동 수정·사람 편집 버전 저장 | 본문 버전 ID | |
| `extract_facts` | `split_scenes` 커밋 | 본문 버전 ID | |
| `link_mentions` | `extract_facts` 커밋 | 본문 버전 ID | |
| `check_continuity`, `check_setups`, `check_text_safety` | `link_mentions` 커밋 | 본문 버전 ID | 셋 병렬 |
| `polish_episode` | 게이트 판정 통과(E6) | 본문 버전 ID | |
| `revise_episode` | 게이트 판정 E4, `plan_rework`(E12 `draft`) | 본문 버전 ID | |

`TaskDependency`는 화 사이 의존(ED-1)에만 씁니다. 스케줄러는 N-1화의 현재 본문 버전 `link_mentions` 작업이 생긴 뒤에 N화 `outline_episode`를 만들고 그 작업에 잇습니다. N-1화가 재작성돼 선행 작업이 대체되면 04 3.2 규칙대로 대체 작업에 다시 잇습니다. 재작성(E4·E5·E12)은 기존 작업을 고치지 않고 새 원고 버전 기준 작업을 만들며, 이전 버전을 대상으로 한 미종료 작업은 `cancelled` + `superseded_by_task_id`입니다(T11, → 04 3.6).

### 2.3 화 사이 의존

| 규칙 | 내용 | 근거 |
|---|---|---|
| ED-1 | N화 `outline_episode`는 N-1화가 P3c(언급 연결)를 끝낸 뒤에 시작합니다. N-1화의 사실은 아직 `candidate`면 "미확정"으로 컨텍스트에 들어갑니다. | FR-AGT-04, 6.3.1 표 |
| ED-2 | 같은 작품의 동시 실행은 `run.max_concurrent_per_novel`을 따릅니다. 화 단계는 ED-1 안에서 겹쳐 진행할 수 있습니다(N화 다듬기와 N+1화 아웃라인). | → 04 |
| ED-3 | 앞 화의 사실 집합이 바뀌면(재작성·반려·답변 반영) 그 사실 버전을 `ContextSnapshot.candidate_fact_version_ids`·`fact_version_ids`로 쓴 뒷 화 가운데 `drafting` 이후 상태인 화에 `check_continuity`를 다시 겁니다(재작성이 아니라 재검사). 뒷 화가 `published`면 재검사 대신 연속성 이슈만 만듭니다. | FR-AGT-04, FR-ONT-07 |
| ED-4 | 차단형 질문으로 멈춘 화가 있어도 ED-1에 걸리지 않는 화는 진행합니다. ED-1에 걸린 뒷 화는 `pending`으로 남고 화면에 선행 화의 차단 사유를 보여 줍니다. | FR-AGT-07 |
| ED-5 | 비축분이 `reserve.target_episodes`보다 적으면 `showrunner`가 다음 화 작업의 `priority`를 올립니다. | FR-AGT-06 |

---

## 3. 단계별 명세

공통 사항
- 모든 LLM 출력은 zod 스키마(`packages/shared`)로 검증합니다. 검증 실패는 `error_family=invalid_output`이고 호출 재시도(`llm.max_retries_per_call`) → 작업 재시도(`task.max_attempts`) 순서로 다룹니다(→ 04).
- 단계 안에서 사람 결정이 필요하면 질문을 만들고 작업은 `blocked`(T7), 화는 `block_reasons`에 `question`을 더합니다. 등급 판정은 → 05.
- 모든 단계는 시작·종료 시각과 비용을 작업·원장에 남기고, 단계별 지표는 7.4절 뷰로 계산합니다(FR-AGT-03).

### 3.1 P1 아웃라인 (`outlining`)

| 항목 | 내용 |
|---|---|
| 담당 | `planner`. 떡밥 배정은 아크 계획 때 `foreshadow_manager`가 만든 `SetupBeat(planned_episode_no=N)`을 받습니다. 기한 `setup.due_warning_episodes` 이내 떡밥이 있으면 `review_setup_due` 결과의 회수 후보 씬 제안이 입력에 붙습니다(FR-FOR-04). |
| 입력 | `Goal`, `Arc`, 승인된 `SeriesBible`, 이전 화 씬 요약(전문 아님), `ContextSnapshot`(시점 `story_point = N×1000`, 화의 `primary_timeline_id`), 이번 화 배정 비트, 답변 제약(`fact_kind=constraint`), 반려 사유·`answer_ids`(재작성 시), `LengthProfile` |
| 출력 | `ManuscriptVersion(kind=outline, stage=outlining)`. `content`는 사람이 읽는 요약, `outline_data`는 `OutlineData`(3.1.1) |
| 결정적 검사 | (1) 스키마 검증 (2) 참조한 `entity_id`가 이 작품에 있고 `merged`면 `merged_into_id`로 바꿔 저장 (3) 이번 화 `planned` 비트가 모두 씬 하나 이상에 배정됨(E2 가드) (4) 씬 수 ≤ `scene.max_per_episode` (5) 신규 인물 제안은 이름만으로 엔티티를 만들지 않고 4.5절 경로로 넘김 |
| 실패 처리 | 검증 실패 → 재시도 → `failed`(인박스 표시). 배정 비트 누락 → 같은 실행 안에서 1회 보정 요청, 그래도 누락이면 작업 실패. 방향 결정이 필요하면(예: 주요 인물 생사) 질문 생성 후 `blocked` |
| 게이트 | E1: 기획서 `approved`, 아크 계획 승인, 일시정지·`hard_stopped` 아님. E2: 위 검사 통과 |

#### 3.1.1 `OutlineData` (zod, `manuscript_versions.outline_data`)

| 필드 | 내용 |
|---|---|
| `beats[]` | 비트 순서와 목적 |
| `scenes[]` | `key`(아웃라인 안 씬 키, 예 `s1`), `summary`, `pov_entity_id`, `location_entity_id`, `participant_entity_ids[]`, `timeline_id`(기본 화 시간선), `setup_beat_ids[]`, `answer_ids[]`(이 씬에 반영할 답변) |
| `new_entity_proposals[]` | `{local_key, entity_type, proposed_name, rationale}`. 엔티티 ID 대신 지역 키. 4.5절 |
| `hook` | 회차 말 훅 |
| `target_chars` | 분량 프로필에서 온 목표 |

모든 엔티티 참조는 ID입니다(FR-ONT-12). 이름은 `proposed_name`처럼 제안 필드에만 둡니다.

### 3.2 P2 초고 (`drafting`)

| 항목 | 내용 |
|---|---|
| 담당 | `writer` |
| 입력 | 현재 아웃라인 버전, `ContextSnapshot`(아래), 용어집 표기 규칙(FR-ONT-19, MVP-β), 직전 화 끝부분(가정: 마지막 씬 1개), 분량 프로필, 작품 `age_rating`(NFR-SAFE-01), 재작성이면 이슈 목록·근거·수정안과 재작성 대상 씬 |
| 컨텍스트 | 시점은 `N×1000`. 씬 블록마다 `pov_entity_id`의 인물 지식과 **그 인물이 아는 이름**만 넣습니다(FR-ONT-17). `hidden_variant` 이름은 넣지 않습니다. `candidate` 사실은 "미확정" 표시. 구성 방법·크기 제한은 → 04, 조회 질의는 → 06 |
| 출력 | `ManuscriptVersion(kind=draft, stage=drafting)`(재작성이면 `kind=revision`). 본문과 함께 `WriterAnnotations`(3.2.1) |
| 결정적 검사 | (1) 스키마 검증 (2) `scene_breaks`가 아웃라인 씬 키를 순서대로 모두 덮음 (3) 글자 수 두 기준 계산(FR-MAN-02, 차단 아님) (4) 재작성이면 대상 밖 씬의 본문이 바뀌지 않음(씬 단위 재작성) (5) 사람 작성 구간 변경 감지 → `human_edit_conflict` `high` 이슈(INV-MV-03) |
| 실패 처리 | 검증 실패 → 재시도. `content_filtered` → 안전 지시를 강화한 프롬프트로 1회 재시도(→ 04 7.2) 후 질문(`topic=creative_choice`, 수위 조정 / 해당 씬 생략 / 사람 작성). 이 주제 지정은 04 U-3(텍스트 필터 차단 질문 주제 미정)의 해소 제안입니다. 공급자 장애 → 작업 차단(T8, `task_block_reason=provider_unavailable`, → 04 7.3) |
| 게이트 | E3: 초고 버전 저장 |

#### 3.2.1 `WriterAnnotations` (zod)

writer는 초고와 함께 아래 주석을 냅니다. 저장 위치는 `manuscript_versions.writer_annotations`(jsonb, → 03 v0.2)입니다. `agent:writer` 버전만 채우고 다른 버전은 NULL입니다.

| 필드 | 내용 | 쓰는 곳 |
|---|---|---|
| `scene_breaks[]` | `{outline_scene_key, char_start}` | P3a 초기 경계(6절) |
| `entity_hints[]` | `{char_start, char_end, surface, entity_id, mention_kind}`. 이 표기가 어느 엔티티를 뜻하려 했는지 | P3c 힌트(4.2절) |
| `new_entity_refs[]` | `{char_start, char_end, surface, outline_local_key}`. 아웃라인 신규 제안을 처음 쓴 위치 | 4.5절 |
| `answer_spans[]` | `{answer_id, char_start, char_end}`. 답변을 반영한 위치 | `AnswerReflection.locations`(FR-MSG-09 (c)) |
| `setup_beat_spans[]` | `{setup_beat_id, char_start, char_end}`. 배정 비트를 넣은 위치(자기 신고) | P3e 힌트 |

주석은 모두 **자기 신고**입니다. 위치가 본문과 맞지 않으면(`content.slice(start, end) ≠ surface`) 그 항목만 버리고 실행 기록에 버린 수를 남깁니다.

### 3.3 P3 검사 (`checking`)

검사 단계는 하위 작업 여섯 개와 게이트 판정(P3f)으로 이루어집니다. 각 하위 작업의 입력·출력·실패는 아래와 같고, 상세는 4·5·6절입니다.

| 하위 단계 | 입력 | 출력 | 실패 처리 |
|---|---|---|---|
| P3a 씬 분할 | 새 버전 본문, `scene_breaks`, 이전 버전과 씬 | `Scene` 행(ID 유지·`retired`), `story_point` 재계산 | 경계 추정 실패 → 재시도 → 작업 `failed`, 화 `block_reasons += extraction_failure` |
| P3b 사실 추출 | 씬별 본문 창, 씬 메타, 후보 엔티티 카드, 활성 스키마 버전 | `ExtractionResult`(4.3절): 언급 초안(L0) + 사실 초안 | `extraction.max_retries` 후 차단형 질문(4.7절) |
| P3c 언급 연결 | 언급 초안, 이름 사전(시점 필터), `entity_hints`(힌트), 씬 등장·화자 정보 | `Mention`(`link_status`), `SceneParticipant`, 후보 `Fact`·`Entity`, 판별·중복 질문 | L4 호출 실패 → 재시도. 상한 후 4.7절과 같음 |
| P3d 연속성 검사 | 이번 화 후보 사실, 시점 캐논, 답변 제약, 스키마 제약, 인물 지식, 이름 `known_by` | `ContinuityReport`, `ContinuityIssue` | 재시도 → `failed`, 화 진행 불가(검사 없이 통과 금지) |
| P3e 떡밥 검사 | 이번 화 배정 비트, 설치 사실, `setup_beat_spans`(힌트), 씬 본문 | `SetupCheckReport`, 비트 `detected`/`missing`, 이슈 | 위와 같음 |
| P3g 텍스트 안전 검사 | 씬 본문, 작품 `age_rating`, 씬 등장 인물의 시점 `age` 사실(→ 06 4.3), 06 2.4 `entities.is_real_person`, 실존 인물 이름 목록(앱 설치 데이터, 릴리스로만 갱신, NFR-SAFE-02 방침 확정. 데이터 출처 → 06 O-19) | `safety_*` 이슈(5.6절) | 재시도 → `failed`, 화 진행 불가(검사 없이 통과 금지). `content_filtered`로 판정 호출이 막히면 해당 씬을 `safety_age_rating` `high` 이슈로 둡니다(가정: 공급자가 거부한 본문은 수위 초과로 간주) |
| P3f 재작성 범위 | 열린 `high` 이슈 목록과 `fix_scope` | E4/E5 선택, 대상 씬 목록(5.3절, 결정적) | — |

게이트 판정은 5.3절, 재작성 루프는 5.4절입니다.

### 3.4 P4 다듬기 (`polishing`)

| 항목 | 내용 |
|---|---|
| 담당 | `line_editor` |
| 입력 | 검사를 통과한 버전, `medium`·`low` 이슈, 분량 프로필, 용어집 표기 규칙, 훅 규칙, 이름 사전의 집필용 표기(`variant`까지, `hidden_variant` 제외) |
| 출력 | `ManuscriptVersion(kind=revision, stage=polishing)`, `PolishReport`: 글자 수 두 기준, 표기 교정 목록, 표기 변형 등록 제안(`EntityName(status=proposed)`, FR-ONT-19), 훅 평가, (v1) 품질 점수(FR-AGT-09) |
| 결정적 검사 | (1) 사람 작성 구간 불변(INV-MV-03) (2) 바뀐 씬만 골라 P3b·P3c를 다시 돌리고 사실 집합을 비교 → 차이가 있으면 E7(`polish.recheck_on_fact_diff=true`) (3) 분량 이탈은 경고만(FR-MAN-02) (4) 표기 규칙 위반 잔여 → `glossary_spelling` `low`/`medium` 이슈(MVP-β) |
| 실패 처리 | 검증 실패 → 재시도. E7 반복은 5.4절 자동 재작성 상한에 함께 셉니다(가정: 다듬기가 사실을 바꾸는 일은 드뭅니다). |
| 게이트 | E8: INV-EP-02(열린 `high` 0, `missing` 비트 0). `episode_approval`·`co_writing`이면 승인 요청 생성 |

#### 3.4.1 화 승인 요청 내용 (FR-MSG-05)

`Approval(approval_type=episode).payload`에 넣는 항목입니다. 표시 형식은 → 05.

| 항목 | 출처 |
|---|---|
| 요약, 주요 변경점(이전 승인 요청 대비) | `line_editor` 출력, 버전 diff |
| 연속성 경고 수(`medium`), 낮음 이슈 수 | `continuity_issues` |
| 이번 화 후보 사실 수, 그중 보류(링크 미확정) 수 | 4.6절 |
| 신규 엔티티 후보 수, 미답 판별·중복 질문 수 | `mentions`, `questions` |
| 떡밥 비트 결과(설치·강화·회수, `paid_off` 제안) | `SetupCheckReport` |
| 글자 수 두 기준과 분량 이탈 여부 | FR-MAN-02 |
| 전문 링크(인증 필요) | NFR-SEC-04 |

### 3.5 P5 승인 대기 (`awaiting_approval`)

| 자율성 | 동작 | 전이 |
|---|---|---|
| `episode_approval` | 승인 질문(`approve_reject`, 차단형, `blocking_basis=approval_gate`). 승인 → E9(a), 반려 → E10 | → 05 승인 게이트 |
| `arc_approval` (MVP-β) | 질문 없음. 아크의 모든 화가 `awaiting_approval`이면 아크 승인 하나로 E9(b) 일괄 | → 03 4.1 |
| `full_auto` (MVP-β) | 열린 `high` 0이면 즉시 E9(c), 주체 `agent:showrunner` | D-24 |
| `co_writing` (v1) | 사람 원고 확정 질문 | FR-HIL-01c |

E9 트랜잭션에서 하는 일(→ 03 E9, 5.1):
1. 승인 대상 버전 내용을 그대로 복사한 `ManuscriptVersion(kind=final)`을 만들고 `approved_version_id`로 지정합니다(`content_hash` 같음, `attribution_spans` 상속, 작성 주체 `system:orchestrator`).
2. 그 화 출처 `candidate` 사실 중 F3 가드를 통과한 것만 `approved`로 올립니다(4.6절). 통과하지 못한 사실은 `candidate`로 남습니다.
3. 그 화 `detected` 비트를 `confirmed`로, 서사 상태 전이(S2~S4)를 수행합니다.
4. 이번 화에서 만든 `Entity(status=candidate)` 중 중복 질문이 열려 있지 않은 것을 `active`로 올립니다(→ 06).

### 3.6 P6 반려·재작성 (`revising`)

8절에서 다룹니다.

### 3.7 P7 공개 (`approved` → `published`)

| 항목 | 내용 |
|---|---|
| 주체 | `publish_policy=manual`: 사람. `batch_question`: 주 1회 일괄 공개 질문(`question.publish_batch_weekday`). `scheduled`: `system:publisher` |
| 처리 | E13 트랜잭션: `published_version_id = approved_version_id`(INV-EP-03), 사실·비트 `approved → published_locked`, 떡밥 `SC4` |
| 이후 | 씬 재분할 금지(INV-EP-04). 원고 변경은 `retcon` 승인 후 새 버전만. 링크 보류 사실이 나중에 판별되면 `published_locked`로 들어가고, 이 판별 질문은 차단형입니다(FR-ONT-14) |
| 정정 | E14(공개 취소)는 "외부 미공개" 확인과 사유가 필요합니다(FR-MAN-03) |

### 3.8 원고 내보내기 (FR-MAN-04a)

파이프라인 단계가 아니라 사용자가 요청하는 작업이며 화 상태를 바꾸지 않습니다. 작업 기록은 `export_jobs`(→ 08 2.3), 파일은 `$NCS_HOME/storage/novels/<novel_id>/exports/`(→ 08 5.1, 02 4.1)에 둡니다.

| 항목 | 규칙 |
|---|---|
| 범위 | 화 하나, 아크 하나, 작품 전체. 아크·전체는 `episode_no` 오름차순 |
| 대상 버전 | 기본: 화마다 `published_version_id`, 없으면 `approved_version_id`. 사용자가 "현재 버전"(`current_version_id`)을 고를 수 있습니다. 대상 버전이 없는 화(`approved` 이전, "현재 버전" 미선택)는 빼고 결과에 제외 목록을 남깁니다 |
| 형식 | `export_format ∈ {txt, markdown}`(MVP-α). 인코딩 UTF-8(NFC), 줄바꿈 LF(가정) |
| `txt` 구조 | 화마다 `<episode_no>화 <title>` 한 줄(`title`이 NULL이면 `<episode_no>화`), 빈 줄, 본문. 씬 구분은 본문에 들어 있는 구분 표기 그대로 두고 별도 표기를 더하지 않습니다. 화 사이 빈 줄 2개 |
| `markdown` 구조 | 화 제목 `## <episode_no>화 <title>`(아크·전체면 아크 제목 `#`), 본문 문단. 씬 구분 표기 추가 여부는 옵션(기본 없음, 가정) |
| 파일 이름 | `<작품 이름>_<범위>_<YYYYMMDD-HHmm>.<txt|md>`. 범위: `ep<NNN>`, `arc<NN>`, `all`. 파일 시스템 금지 문자는 `_`로 바꿈(가정) |
| 제외 | 이 문서의 주석·내부 데이터는 넣지 않습니다: `WriterAnnotations`, 작성 주체 표시, 이슈·후보 사실·언급, 사람 편집 표시, 비밀 사실(`is_secret`)과 이름 사전 `hidden_variant` 목록. 본문만 내보냅니다 |
| 글자 수 | 화별 두 수치를 FR-MAN-02와 같은 함수(`manuscript` 모듈 단일 구현)로 계산해 `export_jobs` 결과에 남깁니다. 제목·씬 구분 표기·Markdown 기호는 세지 않습니다. 수용 기준 "앱 표시와 일치"는 내보낸 파일에서 제목 줄을 뺀 본문을 같은 함수로 다시 세어 대상 버전의 `char_count_*`와 비교하는 시험으로 확인합니다(정의 미결은 12절 "글자 수 정의") |
| 감사 | 완료 시 `export.created`(→ 03 감사 이벤트 표): 범위, 형식, 화별 버전 ID, 파일 해시 |

---

## 4. 사실 추출 → 언급 연결 → 후보 → 승격

### 4.1 흐름

```
 본문(씬 단위) ──P3b──▶ ExtractionResult
                          ├─ mentions[]: 표기·위치·mention_kind (엔티티 ID 없음, L0)
                          └─ facts[]:   주어·목적어는 mention 지역 키로만 참조, predicate는 스키마 키
                 ──P3c──▶ 링커 L1~L8 (→ 06)  ◀── entity_hints(힌트), 이름 사전(시점·시간선 필터)
                          ├─ Mention 행: auto_linked / ambiguous / new_entity_candidate / rejected
                          ├─ 사실 물질화: mention → entity_id 치환(ambiguous는 NULL, 4.6절) → Fact(candidate) + mention_ids
                          ├─ 분류: new / duplicate / transition / conflict (4.4절)
                          └─ 질문: 판별(entity_disambiguation), 중복(duplicate_entity), 스키마(schema_change)
                 ──게이트(6.3.1 표)──▶ approved ──공개──▶ published_locked
```

이 경로 밖에서 원고 유래 사실을 쓰는 API는 없습니다. `ontology` 모듈의 사실 쓰기 API는 원고 출처(`fact_source_kind=manuscript`)일 때 `mention_ids`가 비어 있으면 거부합니다(FR-ONT-14 수용 기준 "모든 사실의 엔티티 참조에 언급 기록").

같은 경로를 쓰는 다른 입력:

| 입력 | `mention_source_kind` | 진입 작업 | 차이 |
|---|---|---|---|
| 원고 | `manuscript` | `extract_facts` | 이 절 |
| 서술형 답변 | `answer` | `interpret_answer` | 결과가 `AnswerInterpretation.proposed_changes`가 되고 확인 전에는 캐논이 아님(INV-AI-01, → 05) |
| 사람 편집 원고 | `manuscript` | `extract_facts` | writer 힌트 없음(4.2절 H-5) |
| 가져오기(v1) | `import` | `extract_facts` | FR-NOV-05 |
| `co_writing` 원고(v1) | `manuscript` | `extract_facts` | E15 진입, 힌트 없음 |

### 4.2 writer 엔티티 주석의 힌트 규칙

writer는 자기가 쓴 표기가 누구를 뜻하는지 알고 있으므로 그 정보를 버리지 않습니다. 다만 writer도 틀릴 수 있고(엉뚱한 인물 이름, 정체를 모르는 인물의 시점에서 본명 사용), 본문은 이후 다듬기·사람 편집으로 바뀝니다. 그래서 주석은 **링커 입력 특징 하나**로만 씁니다.

| ID | 규칙 |
|---|---|
| H-1 | 힌트는 `Mention.linked_entity_id`를 직접 정하지 않습니다. 링커 L2(후보 생성)에서 힌트 엔티티를 후보에 넣고 특징 `writer_hint_match`를 붙일 뿐입니다. |
| H-2 | L4(LLM 판별)에는 힌트를 보여 주지 않습니다. 판별은 후보 카드와 문맥만으로 하고, 힌트와 판별 결과의 일치 여부는 L6 신뢰도 결합에서만 씁니다. 근거: 판별 LLM이 힌트를 그대로 따르면 writer의 오류가 검증 없이 캐논으로 넘어갑니다. |
| H-3 | 힌트와 L4 결과가 다르면 1·2위 점수 차가 줄어든 것으로 계산해 `ambiguous`로 보내는 쪽으로 기울입니다. 힌트가 L4의 `UNSURE`를 `auto_linked`로 바꾸지 못합니다. 결합 가중치는 골든셋으로 보정합니다(→ 06, `linking.*` 기본값). |
| H-4 | 힌트 엔티티가 이 작품에 없거나 `retired`면 버립니다. `merged`면 `merged_into_id`로 바꿔 씁니다. 실행의 `ContextSnapshot.entity_ids`에 없던 엔티티를 가리키면 특징 가중치를 0으로 둡니다(writer가 컨텍스트 밖 엔티티를 지어낸 경우). |
| H-5 | 힌트가 없는 버전(사람 편집, `co_writing`, 가져오기)도 같은 파이프라인으로 연결합니다. 힌트는 필수가 아닙니다(골든셋 G22 "이름 사전 불완전"과 같은 조건). |
| H-6 | 다듬기 이후 버전에서는 이전 버전 힌트를 문자 diff로 옮겨 씁니다(6.2절 위치 사상). 옮길 수 없는 힌트는 버립니다. |
| H-7 | 힌트 일치율(힌트가 있는 언급 중 최종 연결과 같은 비율)을 실행 `output_summary`에 남깁니다. writer 프롬프트·모델 평가 지표로 씁니다(NFR-OBS-02). |

### 4.3 `ExtractionResult` (zod)

| 필드 | 내용 |
|---|---|
| `mentions[]` | `local_key`, `scene_ord`, `char_start`, `char_end`, `surface`(`zero`면 빈 문자열, 위치는 서술어 구간), `mention_kind`, `speaker_hint`(대사면 화자 언급의 `local_key`) |
| `facts[]` | `local_key`, `fact_kind`, `subject_mention_key`, `predicate`(활성 스키마 키), `object_mention_key` 또는 `value`, `knowledge_stance`(`knowledge`면), `holder_mention_key`(지식 보유 인물), `evidence`(`char_start`, `char_end`), `scope_hint`(`point` 그 씬 시점 / `from_here` 이후 계속 / `flashback` 회상), `frame_key`(`scope_hint=flashback`이면 필수, `frames[]`의 `local_key`) |
| `frames[]` | 회상·꿈·다른 시간선 구간 `{local_key, scene_ord, char_start, char_end, frame_kind, target_story_point, target_timeline_id}`. `frame_kind`는 `narrative_frame_kind`, 대상 시점·시간선을 모르면 NULL. 커밋에서 `narrative_frames` 행이 됩니다(→ 06 2.4). P3a가 같은 구간 프레임을 이미 만들었으면 그 행을 씁니다 |
| `identity_assertions[]` | 원고 속 정체 공개 서술 `{mention_key_a, mention_key_b, evidence}`(예: "검귀는 사형이었다"). 사실로 저장하지 않고, 링킹 후 두 언급이 서로 다른 엔티티면 `IdentityDecision(merge, proposed)`로 넘깁니다(→ 06 3.12 경로 B) |
| `unmapped_predicates[]` | 스키마에 없는 관계·속성 후보 `{surface_predicate, example_fact_key}`. 사실로 저장하지 않고 `SchemaChangeProposal` 입력으로 씁니다(FR-ONT-18) |
| `non_entity_spans[]` | 엔티티처럼 보이나 아닌 표현(비유 등, G16) |

결정적 검증: `content.slice(char_start, char_end) = surface`(정규화 NFC 기준). 어긋나면 같은 씬 안에서 같은 표기를 찾아 한 곳뿐이면 위치를 고치고, 아니면 그 언급과 그 언급을 쓰는 사실을 버립니다. 버린 비율이 높으면(가정: 10% 초과) `invalid_output`으로 재시도합니다. 같은 씬 묶음에서 언급(L0)과 사실을 한 호출로 뽑되 엔티티 ID는 이 단계에서 정하지 않습니다(조사 파일 6.2절 L0).

### 4.4 사실 분류 (FR-ONT-05)

물질화한 후보 사실(링크 보류 사실 제외, 4.6절 LB-2)을 시점 캐논과 비교해 넷으로 나눕니다. 비교 키는 `(subject_entity_id, predicate, object_entity_id?, timeline_id)`이고 `story_range` 겹침과 스키마의 개수·시간 제약을 함께 봅니다. 값 이름은 00 6.10 `fact_diff_kind`이고, 저장 컬럼 없이 실행 출력 안에서만 씁니다.

| 분류 (`fact_diff_kind`) | 조건 | 처리 |
|---|---|---|
| `new` | 같은 키의 캐논·후보가 없음 | `Fact(candidate)` 생성 |
| `duplicate` | 같은 키·같은 값의 캐논이 그 시점에 유효 | 새 사실을 만들지 않고 기존 사실에 근거 언급만 추가(→ 06) |
| `transition` | 스키마상 시간에 따라 바뀔 수 있는 술어(위치, 소속, 칭호 보유 등)이고 이번 씬부터 값이 바뀜 | 새 `candidate` 사실(`story_range` 하한 = 이번 씬). 이전 사실의 열린 상한은 06 6.2 `range_close`로 닫습니다: 닫는 지점이 공개 근거의 최대 지점보다 뒤면 승인 없이 새 사실과 같은 승격 단위(E9)에서 닫고, 아니면 내용 변경(F7 `canon_change` / F8 `retcon`)입니다 |
| `conflict` | 같은 시점에 양립 불가(개수 제약, 사망 후 행동, 다른 값 고정 속성) | 사실은 `candidate`로 저장하고 연속성 이슈 생성(P3d) |

회상(`scope_hint=flashback`) 사실은 회상하는 과거 시점으로 범위를 잡고, 사망 인물 필터로 버리지 않습니다(G14). 인물이 믿거나 말한 내용은 캐논 사실이 아니라 `knowledge` 사실로 저장합니다(G19).

### 4.5 신규 엔티티 경로 (FR-ONT-15)

| 단계 | 처리 |
|---|---|
| 아웃라인 제안 | `OutlineData.new_entity_proposals`는 엔티티를 만들지 않습니다. 이름이 비슷한 기존 엔티티가 있으면(`dedup.similar_entity_min_score`) P1에서 `duplicate_entity` 비차단형 질문을 미리 만듭니다. |
| 원고 첫 등장 | 링커 L5에서 `NIL`이면 유사 엔티티 검사 → 없으면 `Entity(status=candidate)` + `EntityName(status=proposed)` + 언급 `new_entity_candidate`. 있으면 같은 처리 + `duplicate_entity` 질문. `new_entity_refs`는 이 판정의 힌트일 뿐입니다(H-1과 같음). |
| 사실 | 신규 후보 엔티티를 가리키는 사실도 `candidate`이고, 그 언급이 `new_entity_candidate`인 동안 F3 가드로 승격되지 않습니다. |
| 확정 | 중복 질문이 "다름"으로 답해지거나 질문이 없으면 화 게이트(E9)에서 `active`와 언급 `confirmed`로 바꿉니다. "같음"이면 `IdentityDecision(merge)`(→ 06). |

### 4.6 링크 보류 사실과 승격 시점

`ambiguous` 언급을 주어·목적어로 쓰는 사실은 그 역할을 NULL로 둔 `candidate`로 저장합니다("링크 보류 사실"). 1위 후보를 임시로 채우지 않습니다. 언급과의 연결은 `mention_ids`와 버전 `content.arg_mentions`(`{subject: mnt_…, object: mnt_…}`)로 남기고, 후보 목록은 그 언급의 `mentions.candidates`에서 읽습니다(사실에 후보 목록을 복제하지 않습니다). 근거: INV-ONT-08(판별 대기일 때만 `subject_entity_id IS NULL` 허용), 06 6.1. 이유: 임시 주어를 넣으면 잘못된 1위 후보가 "미확정" 사실로 다음 화 컨텍스트, 06 6.6 "동일" 분류(엉뚱한 캐논 사실에 근거 언급이 붙음), 유사 엔티티 점수(06 3.10)에 섞입니다(R-18).

| 규칙 | 내용 |
|---|---|
| LB-1 | 링크 보류 사실은 어느 게이트에서도 승격하지 않습니다(F3 가드, INV-ONT-07). 화 승인은 막지 않고, 승인 요청에 보류 수를 표시합니다. |
| LB-2 | 링크 보류 사실은 4.4절 분류, 컨텍스트 조회(06 6.4 "컨텍스트 표시"), 유사 엔티티 점수, CR 사전 필터의 캐논·후보 집합에서 뺍니다. 연속성 검사만 NULL 역할을 해당 언급의 `candidates` 목록 각 엔티티로 바꿔 넣어 평가합니다. 모든 후보에서 충돌하면 보통 규칙대로 이슈를 만들고, 일부 후보에서만 충돌하면 `medium` 이슈로 만들고 근거에 해당 `mention`을 붙입니다. 판별 질문 답이 오면 재평가합니다. |
| LB-3 | 판별이 확정되면 NULL 역할을 채운 새 `FactVersion`(`change_reason=resolution_filled`)을 만들고(→ 06 W1), 이때 4.4절 분류를 처음 수행합니다. 그 뒤 그 화의 현재 단계에 맞는 캐논 상태로 둡니다: 화가 `awaiting_approval` 이전이면 `candidate` 유지, `approved`면 `approved`, `published`면 `published_locked`. 이 승격은 화 게이트가 이미 지난 뒤의 지연 승격이고, 감사 로그 `fact.status_changed`에 판별 질문 ID를 남깁니다. 답이 "새 인물"이면 4.5절 경로, "엔티티 아님"이면 그 사실을 `rejected`(F4)로 닫습니다. |
| LB-4 | 판별 질문 등급은 `linking.disambiguation_question_grade`(기본 `non_blocking`)이고, 링크 결과가 `published_locked` 사실이나 `high` 이슈에 닿으면 차단형입니다(`blocking_basis=published_canon`). 같은 표기·같은 후보 집합의 질문은 화 단위로 묶습니다(→ 05, 06). |

자율성별 승격 시점(6.3.1 표 구현):

| 자율성 | 신규 사실 `candidate → approved` | 떡밥 `paid_off` 확정 | 그 전 후속 화 컨텍스트 |
|---|---|---|---|
| `episode_approval` | E9(a) 화 승인 | E9(a) | "미확정"으로 사용 |
| `arc_approval` | E9(b) 아크 승인 | E9(b) | "미확정"으로 사용 |
| `full_auto` | E9(c) 검사·검수 통과(열린 `high` 0), 주체 에이전트 기록 | E9(c), 근거 씬 기록 | 짧게 "미확정" |
| `co_writing` (v1) | 화 확정 | 화 확정 | "미확정"으로 사용 |

### 4.7 추출 실패 (PRD 5.7절)

| 조건 | 처리 |
|---|---|
| P3a~P3c 작업이 `extraction.max_retries`를 넘김 | 작업 `failed`, 화 `block_reasons += extraction_failure`, 차단형 질문(`topic=extraction_failure`, `blocking_basis=system_failure`). 선택지: 다시 시도(모델 변경 후) / 사실 직접 입력 / 보류 |
| 사용자가 사실을 직접 입력 | `fact_source_kind=user_input`, 언급은 `mention_source_kind=user_input`. 화는 P3d부터 이어서 진행 |
| 금지 | 추출 없이 검사를 통과시키는 선택지는 두지 않습니다. 화는 `checking`에 머뭅니다(FR-ONT-05). |

---

## 5. 검사 단계

### 5.1 연속성 검사 (P3d, FR-ONT-06)

| 항목 | 내용 |
|---|---|
| 담당 | `continuity_editor`(LLM 판정) + `schema_validator`(결정적, FR-ONT-18) + `linker`(정체 누설·`known_by` 위반 후보) |
| 입력 | 이번 화 후보 사실(분류 포함), 시점·시간선 캐논, 답변 제약, 활성 스키마 제약, 인물 지식, 이름의 `visibility`·`known_by`·`reader_reveal_point` |
| 검사 종류 | `continuity_issue_kind` 중 `safety_*`(5.6절)를 뺀 전체. 규칙 목록·판정식·기본 심각도는 → 06 9절 |
| 출력 | `ContinuityReport`: 이슈마다 `kind`, `severity`, 원고 위치, 근거(`continuity_issue_evidence`), `proposed_fix`, `fix_scope`(`span` / `scene` / `outline`), 자동 수정 가능 여부 |
| 중복 | 재검사는 `dedupe_key`로 기존 이슈에 이어 붙입니다(C1). 이전 버전 이슈와의 연결은 `previous_issue_id` |

**템플릿 규칙**(MVP-β/v1): 작품 스키마의 템플릿 `continuity_rules`(`kind=check`)도 P3d에서 실행합니다. 사전 필터는 06 9절 "템플릿 규칙" 표의 해당 릴리스 종류만 쓰고, 평가 범위는 계획서 3.3·06 6.3의 E-1~E-4(계보 위에서 평가, 시간선을 넘는 `story_point` 비교 금지, 회귀 첫 지점의 `regression_branch` 예외 사건, 이월 사실이 있으면 `ability_before_event` 계열 예외)를 따릅니다. 이슈 종류는 06 4.7 TA-6 매핑(00 기존 값), 근거에 `schema_rule_key`.

심각도 기본값의 단일 출처는 → 06 9절(규칙별 기본 심각도, 관계 정의의 `default_severity`)입니다. 이 문서는 표를 따로 두지 않습니다. 조정 규칙(LB-2 `medium`, 앞 화 `candidate` 근거만이면 `low`)은 → 06 9절 심각도 조정 규칙입니다.

`published_canon_conflict`는 재작성으로 고치거나 `retcon` 승인을 받아야 하고, 그 밖의 방법으로 `waived` 할 수 없습니다(INV-CI-04, FR-ONT-07).

### 5.2 떡밥 검사 (P3e, FR-FOR-08)

| 항목 | 내용 |
|---|---|
| 담당 | `foreshadow_manager` |
| 입력 | `planned_episode_no = N`이고 `status ∈ {planned, missing}`인 비트, 떡밥 설명과 연결 사실(`setup_links`), 설치 비트의 근거 씬 사실, `setup_beat_spans`(힌트), 씬 본문·언급 |
| 처리 | 비트마다 원고에서 위치를 찾아 `planned → detected`(근거 씬·구간 기록) 또는 `planned → missing`. 회수 비트는 설치 사실과 대조해 모순이면 `setup_contradiction` `high` 이슈. 회수가 맞으면 `paid_off` 제안을 보고서에 넣고 확정은 4.6절 표의 시점 |
| `missing` | `setup_missing` `high` 이슈 → E4 재작성(대상: 배정 씬) |
| 계획 밖 검출 | 배정되지 않은 설치·강화·회수 흔적은 MVP-α에서 보고서에만 남기고, v1에서 등록 제안(FR-FOR-03, S6) |
| 출력 | `SetupCheckReport`: 비트별 결과·근거 위치·`paid_off` 제안·계획 밖 후보 |

`setup_beat_status` 전이(03 4.11 요약표의 상세):

| from | to | 트리거 |
|---|---|---|
| `planned` | `detected` | 떡밥 검사가 근거 위치를 찾음 |
| `planned` | `missing` | 떡밥 검사가 찾지 못함 |
| `missing` | `detected` | 재작성 후 재검사에서 찾음 |
| `detected` | `planned` | 재작성으로 근거 씬이 바뀌어 재검사 대상이 됨(근거 필드 비움) |
| `detected` | `confirmed` | 화 확정(E9) |
| `planned` / `missing` | `cancelled` | 아웃라인 재작성(E5, E12 `outline`)에서 배정 해제, 또는 기한 변경 |

`detected → planned`는 03 v0.2 4.11 요약표에 반영됐습니다.

### 5.3 게이트 판정

`check_continuity`, `check_setups`, `check_text_safety`가 모두 `done`이면 `system:orchestrator`가 아래 순서로 판정합니다(같은 트랜잭션에서 `episode.status_changed`). 이 판정이 P3f이고 별도 작업이 아닙니다.

| 순서 | 조건 | 결과 |
|---|---|---|
| GC-1 | 추출·링킹 작업이 `done`이 아님 | 판정 보류(화 `checking`) |
| GC-2 | 열린 `high` 이슈 0 그리고 `missing` 비트 0 | E6 → `polishing` |
| GC-3 | 자동 재작성 수 ≥ `continuity.max_auto_rewrites_per_episode` | 화 정지: `block_reasons += rewrite_limit`, 차단형 질문(`topic=rewrite_limit`, `blocking_basis=rewrite_limit`). 선택지는 → 05 3.3·3.4 `rewrite_limit`(검사 상한): `human_edit` / `waive_issue`(사람만, INV-CI-03. `safety_*` 이슈가 남아 있으면 이 선택지를 빼고 5.6절 SF-4) / `replan_from_outline`(아웃라인부터 재작성, 상한 1회 추가) / `hold`. 질문에는 남은 열린 `high` 이슈를 모두 `ref_type=continuity_issue`로 링크합니다(`missing` 비트도 `setup_missing` 이슈라 1건 이상). 반려 상한 질문(8.1절)은 이슈를 링크하지 않으므로, 05는 이 링크 유무로 원인을 구분합니다 |
| GC-4 | 모든 `high` 이슈가 자동 수정 가능(5.4절 AF 조건) | 자동 수정 적용 후 같은 `checking`에서 재검사 |
| GC-5 | `high` 이슈의 `fix_scope`에 `outline`이 있음 | E5 → `outlining`, 후속 `outline_episode`(`planner`, `rework_cause=check`, → 04 3.3) |
| GC-6 | 그 밖 | E4 → `drafting`, 후속 `revise_episode`(`writer`, `rework_cause=check`), 대상 씬 = `high` 이슈가 있는 씬 |

`medium`·`low` 이슈는 게이트를 막지 않고 다듬기 입력과 승인 요청 경고 수로 갑니다.

### 5.4 재작성 루프와 자동 수정

**자동 재작성 수**: 마지막 사람 개입(반려, 사람 편집, `rewrite_limit` 질문 답변) 이후 이 화에서 E4·E5·E7·자동 수정으로 만든 검사 사이클 수입니다. 저장은 `episodes.auto_rewrite_count`(int, 기본 0, → 03 v0.2)이고, 반려(E10·E11)·사람 편집(E16)·`rewrite_limit` 질문 답변 때 0으로 되돌립니다.

자동 수정 조건(AF, 모두 만족):

| ID | 조건 |
|---|---|
| AF-1 | 수정이 씬 하나 안의 구간 치환입니다(`fix_scope=span`). |
| AF-2 | 사람 작성 구간을 건드리지 않습니다. |
| AF-3 | 수정 후 재추출한 사실 집합에서 해당 이슈의 충돌 사실만 사라지고 다른 사실이 늘거나 줄지 않습니다. |
| AF-4 | `published_canon_conflict`, `answer_constraint`, `setup_missing`, `safety_*`가 아닙니다(의도 판단이 필요한 종류). |

자동 수정 처리:
1. `continuity_editor` 실행 출력의 패치를 새 `ManuscriptVersion(kind=revision, stage=checking)`으로 저장합니다(작성 주체 `agent:continuity_editor`, 그 실행 ID).
2. 이슈 `open → fixing`(C2), `auto_fix_diff`에 수정 전후를 남깁니다(FR-AGT-10).
3. 바뀐 씬만 P3a~P3e를 다시 돌립니다. 재현되지 않으면 `resolved/auto_fixed`(C3), 재현되면 `open`(C4).

재작성(E4·E5) 처리:
- writer 입력에 이슈·근거 사실·수정안·대상 씬을 넣고, 대상 밖 씬은 그대로 둡니다(씬 ID·작성 주체 보존, NFR-COST-03).
- E5(아웃라인부터)면 이전 버전 이슈 중 위치가 사라진 것을 새 버전 검사 후 `superseded`로 닫습니다(C8). 배정 비트는 새 아웃라인 기준으로 다시 맞춥니다.
- 재작성으로 근거가 사라진 후보 사실은 `rejected`(F4, 주체 `agent:world_keeper`)로 닫습니다. 이력은 남습니다.

### 5.5 상한 정리

| 상한 키 | 세는 대상 | 도달 시 |
|---|---|---|
| `llm.max_retries_per_call` | 호출 하나의 재시도 | 작업 재시도로 넘김(→ 04) |
| `task.max_attempts` | 작업 하나의 실행 횟수 | 작업 `failed`(T6), 인박스 표시 |
| `extraction.max_retries` | P3a~P3c 재시도 | 4.7절 차단형 질문 |
| `continuity.max_auto_rewrites_per_episode` | 5.4절 자동 재작성 수 | GC-3 차단형 질문 |
| `episode.max_rejections` | 사람 반려 수(`rejection_count`) | INV-EP-05 방향 결정 질문 |
| `quality.max_rewrites` (v1) | 품질 점수 미달 재작성 | 차단형 질문(FR-AGT-09) |

### 5.6 텍스트 안전 검사 (P3g, NFR-SAFE-01, 02)

미디어 안전 분류(X3, 10.2절)와 별개로 원고 텍스트에 적용합니다. 프롬프트 지시(→ 04 9.5)와 초고 입력 `age_rating`(3.2절)은 생성 전 예방이고, 이 검사는 생성 후 차단입니다.

| 항목 | 내용 |
|---|---|
| 담당 | `continuity_editor`(LLM 판정) + 결정적 사전 필터 |
| 대상 | 새 본문 버전의 모든 씬(재검사는 바뀐 씬만). 사람 편집·`co_writing`·가져오기 버전도 같음 |
| 끌 수 없음 | 작품 설정·자율성·`full_auto`와 무관하게 돕니다. 설정 키를 두지 않습니다(NFR-SAFE-02 "사용자가 끌 수 없음") |

| ID | 검사 | 사전 필터(결정적) | LLM 판정 | 이슈 `kind`(00 6.8) | 심각도 |
|---|---|---|---|---|---|
| SF-1 | 연령 등급 수위 | 없음(모든 씬을 LLM 판정). 등급 키워드 목록 `safety.age_rating_keywords`(등급별 키워드, 설치 데이터, 가정)의 일치는 판정 입력의 참고 신호로만 넣음. 같은 목록을 컨셉 단계 매 턴 결정적 검사(11 X-9 (b), 6.4)가 씀(목록 하나, 버전은 앱 릴리스) | 씬 본문의 성적·폭력·언어 수위가 작품 `age_rating` 기준을 넘는지. 기준표는 가정(12절) | `safety_age_rating` | `high` |
| SF-2 | 미성년 인물 성적 묘사 | 씬 `present` 참여자 중 그 씬 시점 `age` 사실 < 19(가정: 성년 기준 만 19세) 또는 `age` 미상이면서 미성년 표지(학생 등) 사실·서술이 있는 인물 | 그 인물이 등장하는 성적 묘사가 있는지. 등급과 무관 | `safety_minor_sexual` | `high` |
| SF-3 | 실존 인물 사칭·명예훼손 | 언급이 `is_real_person=true` 엔티티(06 2.4 `entities.is_real_person`)에 연결됐거나 실존 인물 이름 목록(앱 설치 데이터, 릴리스로만 갱신, NFR-SAFE-02 방침 확정. 데이터 출처 → 06 O-19)과 표기가 일치 | 실존 인물을 사칭하거나(그 인물인 것처럼 발언·행동을 지어내 사실처럼 제시) 명예를 훼손하는 서술인지. 실존 인물의 단순 언급·역사 서술은 위반 아님. 사후 일정 기간이 지난 역사 인물의 명백한 허구 행동은 허용하고 명예훼손 성격은 차단(D-33 A 방침. 기준 연도·목록 출처는 D-12 법률 검토와 함께 정함) | `safety_real_person` | `high` |

| ID | 처리 규칙 |
|---|---|
| SF-4 | `safety_*` 이슈는 `waived`·`false_positive`로 바꿀 수 없습니다(가정: 오탐은 재작성 또는 사람 편집 후 재검사로만 닫힘). GC-3 상한 질문에서도 "이슈 허용"을 제시하지 않습니다. → 03 INV-CI-05. |
| SF-5 | 위반은 E6·E8 게이트를 막고(INV-EP-02) 5.4절 재작성 루프(E4, 대상 씬)로 보냅니다. 자동 수정 대상이 아닙니다(AF-4). |
| SF-6 | `full_auto` E9(c)도 같은 이슈가 열려 있으면 진행하지 않습니다(INV-EP-02의 결과). |
| SF-7 | 판정 근거는 이슈 근거(`continuity_issue_evidence`)에 `ref_type=mention`(SF-2·SF-3 인물 언급)·`fact`(`age` 사실)로 남깁니다. 본문 인용은 감사 로그에 넣지 않습니다. |

`age` 사실이 링크 보류(4.6절) 언급에만 기대면 후보마다 평가하고 하나라도 미성년이면 SF-2 사전 필터에 포함합니다.

---

## 6. 씬 분할과 씬 ID 유지 (FR-AGT-05)

### 6.1 경계 결정

| 버전 출처 | 초기 경계 | 보정 |
|---|---|---|
| writer 초고·재작성 | `WriterAnnotations.scene_breaks` | 검증 실패(순서 어긋남, 누락)면 LLM 경계 추정 |
| 다듬기·자동 수정·사람 편집 | 이전 버전 경계를 문자 diff로 옮김(6.2절) | 경계가 삭제 구간에 떨어지거나 씬 길이가 0이 되거나 삽입 구간이 크면(가정: 삽입이 씬 평균 길이의 50% 초과) LLM 경계 추정 |
| `co_writing`·가져오기 | 없음 | LLM 경계 추정(장소·시간·시점 인물 전환) |

LLM 경계 추정은 `world_keeper`가 하고 출력은 `SceneSegmentationResult`(`[{char_start, summary, location_hint, pov_hint, narration_mode, frames[]}]`)입니다. `frames[]`는 씬 안 회상·꿈·다른 시간선 구간 `{char_start, char_end, frame_kind, target_story_point, target_timeline_id}`이고 `narrative_frames` 행이 됩니다(→ 06 2.4, 4.3절 `frames[]`와 같은 형식). 씬 요약·장소·시점 인물은 링커 결과(엔티티 ID)로 채우고, 힌트는 이름이 아니라 언급 위치로 넘깁니다.

`scenes.narration_mode`(→ 06 3.3)는 P3a가 채웁니다. LLM 경계 추정을 하면 그 출력 값, 하지 않으면 ID를 유지한 씬은 이전 값을 이어받고 새 씬은 NULL(작품 `default_narration_mode` 적용)입니다.

### 6.2 위치 사상

- 두 버전 본문(NFC 정규화)의 문자 단위 diff를 구하고, 바뀌지 않은 구간으로 옛 위치 → 새 위치 사상을 만듭니다. diff 알고리즘·라이브러리 선택은 → 08.
- 같은 사상을 `attribution_spans`(7.2절), 힌트 이동(H-6), 이슈·비트 위치 갱신에 함께 씁니다.

### 6.3 ID 유지 알고리즘

```
입력: 옛 active 씬 O = {o}, 새 구간 N = {n}
overlap(o, n) = |사상(o) ∩ n| / |o|          # 옛 씬 글자 수 기준, 바뀌지 않은 글자만 셈
후보 쌍 = {(o, n) | overlap(o, n) ≥ scene.id_retention_overlap_min}
후보 쌍을 overlap 내림차순, 같으면 n.ord 오름차순으로 정렬
for (o, n) in 후보 쌍:
    if o와 n이 아직 배정되지 않음: n.id = o.id   # ID 유지, ord·구간·boundary_revision 갱신
배정 안 된 o → status=retired (삭제 안 함)
배정 안 된 n → 새 scn_ ID
```

| 경우 | 결과 |
|---|---|
| 씬 안 문장 수정 | ID 유지 |
| 씬 둘로 분할 | 옛 글자를 더 많이 가진 쪽이 기준 이상이면 ID 유지, 다른 쪽은 새 ID |
| 두 씬 병합 | 겹침이 큰 쪽 ID 유지, 다른 쪽 `retired` |
| 씬 대부분 재작성 | 기준 미만이면 `retired` + 새 ID |
| 씬 순서 교환 | 두 씬 모두 ID 유지, `ord`·`story_point`만 바뀜 |

### 6.4 같은 트랜잭션에서 할 일

1. `scenes` 갱신(INV-SC-01, INV-SC-02), `scene.resegmented` 감사 이벤트(전후 구간·유지·소멸 ID 목록).
2. 새 `ord`로 `story_point` 재계산, 근거 `source_scene_id`를 가진 사실의 `story_range` 재계산을 `ontology` API로 호출(00 5.5).
3. 이슈·비트·`AnswerReflection.locations`의 `scene_id`·구간을 사상으로 갱신. `retired` 씬을 가리키던 것은 겹침이 가장 큰 새 씬으로 옮기고 감사 로그에 남깁니다.
4. [v1] `retired` 씬이나 본문이 바뀐 씬의 샷·IR·에셋에 `stale_since`(FR-SPX-07).

`published` 화는 재분할하지 않습니다(INV-EP-04). 리트콘 버전은 씬 경계를 사람이 확인합니다(가정).

---

## 7. 버전과 작성 주체

### 7.1 단계별 버전 생성

| 단계 | `kind` | `stage` | 작성 주체 | `is_human_edit` |
|---|---|---|---|---|
| P1 | `outline` | `outlining` | `agent:planner` | false |
| P2 | `draft`(첫 초고) / `revision`(재작성) | `drafting` | `agent:writer` | false |
| 자동 수정 | `revision` | `checking` | `agent:continuity_editor` | false |
| P4 | `revision` | `polishing` | `agent:line_editor` | false |
| 사람 편집 | `revision` | 편집 시점 상태 | `user` | true |
| E9 | `final` | `approved` | `system:orchestrator`(내용 복사) | false |
| `co_writing` (v1) | `draft` | `checking` | `user` | true |

화 포인터: `outline_version_id`는 P1, `current_version_id`는 본문 버전마다, `approved_version_id`는 E9, `published_version_id`는 E13에서 옮깁니다. 버전 번호 발급·되돌리기 규칙은 → 03 8.3.

### 7.2 `attribution_spans` 계산 (03 미결 해소)

| 단계 | 처리 |
|---|---|
| 1 | 새 버전과 부모 버전(`parent_version_id`)의 문자 diff를 구합니다(6.2절). |
| 2 | 바뀌지 않은 구간은 부모의 span(`actor_type`, `actor_id`, `origin_version_id`)을 그대로 이어받습니다. |
| 3 | 삽입·치환 구간은 이번 버전 작성 주체와 `origin_version_id = 새 버전 ID`를 받습니다. 삭제는 span이 없습니다. |
| 4 | 이웃한 같은 주체·같은 출처 span을 합칩니다. INV-MV-02(빈틈 없이 덮음)를 검사합니다. |
| 5 | 줄 단위 표시: 한 줄에 주체가 하나면 그 주체, 둘 이상이면 "혼합"과 각 비율을 표시합니다(FR-MAN-01 "줄 단위 구분"). |
| 6 | 에이전트 버전에서 부모의 `actor_type=user` span이 바뀌었으면 `human_edit_conflict` `high` 이슈를 만들고 그 변경은 승인 없이 확정되지 않습니다(INV-MV-03). |

이 기록과 감사 로그로 사람 기여 리포트(FR-HIL-05, v1)를 재현합니다(NFR-OBS-03).

### 7.3 사람 편집 (FR-MAN-07, FR-HIL-04)

| 편집 시점 화 상태 | 처리 |
|---|---|
| `outlining`·`drafting`·`checking`·`polishing` | 진행 중 실행은 안전 지점에서 멈추고(`run_stop_reason=superseded`) 해당 작업은 대체됩니다. 사람 버전 저장 후 P3a부터 다시 검사합니다(E16. `checking` 중 편집은 전이 없이 검사를 처음부터). |
| `awaiting_approval` | E16. 열린 `episode` 승인을 `superseded`(A5)로 닫고 P3a부터 다시 검사합니다. 반려가 아니므로 `rejection_count`를 올리지 않습니다. |
| `approved` | 공개 전이므로 같은 처리(E16). 화는 다시 승인 대기를 거칩니다. |
| `published` | 직접 편집 불가. `retcon` 승인 질문으로만 진행합니다(FR-ONT-07, INV-EP-04). |

사람 편집 재진입은 03 v0.2 4.1 E16(`outlining`·`drafting`·`polishing`·`awaiting_approval`·`approved` → `checking`, 주체 `user`, 가드: 사람 버전 저장)입니다. E15는 `co_writing` 전용입니다. E16은 `rejection_count`를 유지하고 `auto_rewrite_count`를 0으로 되돌립니다(5.4절).

### 7.4 단계 지표 (FR-AGT-03, NFR-OBS-02)

파생 뷰 `episode_stage_metrics`(읽기 전용)를 둡니다.

| 열 | 계산 |
|---|---|
| `episode_id`, `stage` | `tasks.kind` → 2.1절 표로 단계 대응 |
| `cycle_no` | 같은 단계의 반복 순번(재작성·재검사) |
| `started_at`, `completed_at`, `duration_ms` | 작업 시작·종료 |
| `cost_micros` | `cost_events.task_id` 합(`is_rerun` 분리) |
| `input_tokens`, `output_tokens` | 원장 합 |
| `waiting_human_ms` | 같은 단계에서 `blocked`(`question`·`approval`)로 머문 시간 |

화당 생성 시간 KPI(NFR-PERF-01)는 `waiting_human_ms`를 뺀 값과 포함한 값을 함께 냅니다(가정: 9절 KPI 정의가 사람 대기 제외, → 01 3.1 I-08).

---

## 8. 반려·재작성·사람 개입

### 8.1 반려 (FR-AGT-12)

| 단계 | 처리 |
|---|---|
| 반려 입력 | 사유(필수), `rework_from` ∈ {`outline`, `draft`, `polish`}. 부분 수정 요청은 `polish` |
| 기록 | `EpisodeRejection`, `rejection_count += 1`, 비축분에서 제외 |
| 전이 | E10(`awaiting_approval`) 또는 E11(`approved`, 공개 전) → `revising` |
| 재작성 계획 | 반려 결정 트랜잭션이 `plan_rework`(`showrunner`, 00 6.3)를 만듭니다. 입력에 반려 사유·`rework_from`·`from_version_id`·관련 답변 ID. 출력은 대상 씬 목록과 후속 작업 1건이고, 커밋에서 E12를 일으킵니다. `showrunner`는 원고를 쓰지 않습니다(04 2.3) |
| `outline` | 후속 `outline_episode`(`planner`). 새 아웃라인부터. 이전 본문 버전의 이슈는 C8 대상, 후보 사실은 새 검사 후 근거가 없으면 `rejected` |
| `draft` | 후속 `revise_episode`(`writer`, `rework_cause=rejection`). 아웃라인 유지, 초고 전체 재작성. 사유가 특정 씬을 가리키면 `plan_rework`가 그 씬만 대상으로 정합니다 |
| `polish` | 후속 `polish_episode`(`line_editor`). 다듬기만. 사실 diff가 생기면 E7로 검사를 다시 거칩니다 |
| 상한 | `rejection_count ≥ episode.max_rejections`면 E12를 하지 않고 방향 결정 차단형 질문(`topic=rewrite_limit`, 선택지 `replan` / `human_edit` / `hold`, → 05 3.4, INV-EP-05). 이 질문에는 `continuity_issue` 링크를 달지 않습니다(5.3절 GC-3과 구분) |
| 재승인 | 재작성 결과가 E8을 지나면 새 승인 요청. 이전 요청은 이미 `rejected` |

### 8.2 답변 반영과 파이프라인

| 상황 | 처리 | 근거 |
|---|---|---|
| 차단형 질문 답변 | 작업 `blocked → ready`(T9), 입력 `answer_ids`에 추가, 컨텍스트에 답변·확인된 제약 포함 | FR-MSG-09 |
| 반영 위치 | writer의 `answer_spans`, planner의 `OutlineData.scenes[].answer_ids`로 `AnswerReflection.locations`를 채웁니다. 위치가 없으면 반영 실행이 끝날 때 `not_applied` + 사유 | FR-MSG-09 (c) |
| 비차단형 추천안 적용 후 다른 답(늦은 답) | 공개 전이면 수정 작업(화 `revising`, `rework_from`은 영향 범위로 결정), 공개 후면 리트콘 질문. MVP-α는 기록·표시만 | FR-MSG-08, → 05 |
| 판별 질문 답변 | LB-3 지연 승격, 이름 사전 규칙 등록(`reflection_change_kind=entity_name_rule`)으로 같은 질문 재발 방지 | FR-ONT-14, → 06 |
| 재연결로 컨텍스트 사실이 옛 버전이 됨(06 3.11 RL-8) | 원고 버전의 `stale_context` 표시와 검토 항목은 06이 만듭니다. 파이프라인은 자동 재작성하지 않고, 공개 전 화는 ED-3대로 `check_continuity`만 다시 겁니다. 사용자가 검토 항목에서 재작성을 고르면 공개 전 화는 사람 편집(E16) 또는 반려(8.1절, `rework_from`은 사용자 선택), 공개 화는 `retcon` 승인 질문으로 진행합니다 | FR-ONT-07, → 06 |

---

## 9. 실패 처리 요약

| `error_family` | 아웃라인·초고·다듬기 | 추출·링킹 | 연속성·떡밥 검사 | 화 표시 |
|---|---|---|---|---|
| `invalid_output` | 재시도 → `failed` | 재시도 → 4.7절 질문 | 재시도 → `failed` | `extraction_failure`(추출·링킹만) |
| `content_filtered` | 1회 재시도 → `creative_choice` 질문(04 U-3) | 해당 씬 추출 재시도 → 4.7절 | 연속성·떡밥: 재시도 → `failed`. 텍스트 안전: 3.3절 P3g | `question` |
| `rate_limited`, `timeout` | 백오프 재시도(→ 04) | 같음 | 같음 | — |
| `provider_unavailable`, `auth_failed`, `quota_exhausted` | 그 공급자를 쓰는 작업 차단(T8, `task_block_reason=provider_unavailable`, → 04 7.3), 작품별 차단형 알림 1건. v1 대체 모델 설정 시 대체하고 `is_fallback_model` | 같음 | 같음 | `provider_unavailable` |
| `budget_blocked` | 작업 `blocked`(`budget`), 재개 승인 대기 | 같음 | 같음 | `budget` |
| `internal` | 재시도 → `failed` | 같음 | 같음 | — |

온톨로지 무결성 실패(`pause_reason=ontology_integrity`)면 작품 전체를 멈춥니다. 캐논 없이 집필하지 않습니다(PRD 5.7절).

---

## 10. 확장 파이프라인 [v1/v2]

### 10.1 흐름

```
 대상 화 선택(media_target_basis) ─▶ X1 split_shots ─▶ X2 build_prompt_ir ─▶ X3 classify_safety ─▶ X4 render_prompts(미리보기·편집·내보내기)
                                                                                    │
       X5 generate_character_sheet ─▶ 시트 승인(사람) ──────────────────────────────┤
                                                                                    ▼
                       X6 이미지 견적 승인(씬 범위 축소 가능) ─▶ X7 generate_keyframes(draft) ─▶ 채택 ─▶ final 재생성 ─▶ X8 generate_illustrations
                                                                                    │
                 [v2] X9 영상 견적 승인 ─▶ X10 generate_clips(I2V) ─▶ X11 assemble_scene_video ─▶ X12 edit_trailer
```

### 10.2 단계 표

| 단계 | `task_kind` / 역할 | 입력 | 출력 | 검사·게이트 | 실패 처리 | 근거 |
|---|---|---|---|---|---|---|
| X0 대상 선택 | 사용자 | 화, 작품 `media_target_basis`(기본 `published`) | 대상 씬 목록(기본 전체) | 기준에 맞지 않는 화는 선택 불가 | — | FR-SPX-01, D-17, D-18 |
| X1 샷 분할 | `split_shots` / `scene_director` | 씬 본문·`SceneParticipant`·장소, 공급자 길이 범위(`media.clip_seconds_range`, 프로필 우선), `media.default_aspect_ratio` | `Shot(draft)`: `ord`, `target_seconds`, `aspect_ratio`, `camera` | 컷당 주요 인물 수 > `media.max_main_characters_per_shot`이면 경고 + 분할안(FR-SPX-05). 사람이 고칠 수 있음 | 재시도 → `failed` | FR-SPX-01, 05 |
| X2 IR 생성 | `build_prompt_ir` / `scene_director` | 샷, 씬 시점의 외형·의상·부상·장소 사실(시점·시간선 조회, → 06), 승인된 `VisualReference`, 작품 화풍 프리셋(v1) | `ScenePromptIR`: 등장 엔티티 ID, 장소, 소품, 구도, 분위기·조명, 행동, 대사, 시점 외형, 영상 필드(모션, 카메라 움직임, 길이, 시작·끝 프레임, 전환), `field_sources` | 시각 속성 필드마다 출처(`fact_version_id` 또는 `user_input`) 100%(SH2 가드). 모델 문법 금지(ADR-012). 원고에 없는 시각 정보는 온톨로지 기본값, 없으면 비차단형 질문(`topic=creative_choice`. `media_gate`는 05 3.3에서 차단형 승인 질문 전용) | 재시도 → `failed` | FR-SPX-02, 03 |
| X3 안전 분류 | `classify_safety` / `scene_director` | IR, 인물 나이 사실, 작품 `age_rating` | `safety_risk`, 분류 근거(IR `safety`) | `review_required` → 샷 `blocked`(SH3), 안전 확인 질문(`topic=safety_review`, 차단형, 항상 사람, D-25). `blocked` → 생성 금지, 순화안 또는 생략만 | — | FR-SPX-04, NFR-SAFE-01, 02 |
| X4 프롬프트 렌더링 | `render_prompts` / `scene_director`(→ 04 2.2) | IR, 이미지·영상 공급자 프로필 | `RenderedPrompt`(공급자·`modality`별), 내보내기(JSON, Markdown: 씬 ID, 샷 ID, IR 버전, 공급자) | 영상 필드가 비면 영상 렌더링 경고. 영상 공급자 프로필이 없으면 영상 프롬프트 생략. 공급자 제약 위반 샷 표시(FR-VID-06) | — | FR-SPX-08, FR-VID-06 |
| X5 캐릭터 시트 | `generate_character_sheet` / `visual_producer` | 인물 엔티티, 시점 외형 사실, 화풍 | `MediaAsset(character_sheet)`, `VisualReference(pending_review)` | `attachment_review` 질문, 승인(`character_sheet`)은 항상 사람(FR-VIS-02). 승인된 시트만 레퍼런스 | 생성 실패 → X7과 같은 재시도 | FR-VIS-01, 02 |
| X6 이미지 견적 | `visual_producer` | 대상 샷 수, `media.keyframe_drafts_per_shot`, 공급자 단가, `budget.media_quote_retry_margin_ratio` | `MediaQuote(awaiting_approval)`, 계산식 | `media_quote` 승인 전 대량 생성 금지. 승인 단계에서 씬을 골라 범위를 줄일 수 있음(D-18) | 단가 변경 → `expired` 후 재견적 | FR-BUD-06a |
| X7 키프레임 | `generate_keyframes` / `visual_producer` | 렌더링 프롬프트, 레퍼런스 자동 선택(IR 등장 엔티티·시점, 공급자 장수 한도 순위) | `MediaAsset(keyframe, draft)` 샷당 N장 → 채택 → `final` 재생성 → SH5 | 채택: `review_all`은 `attachment_review` 질문, `quote_only`는 `visual_producer` 자동 채택(`is_auto_adopted`). `final`은 초안 채택 후에만(FR-IMG-02). 제외된 레퍼런스 기록(FR-VIS-03) | `filtered`·`failed` → `media.max_generation_retries` 후 질문(순화 / 이미지 대체 / 생략) | FR-IMG-02~05, FR-VIS-03 |
| X8 삽화·표지 | `generate_illustrations` / `visual_producer` | 화, 채택 키프레임 또는 신규 생성 | `MediaAsset(illustration / cover)` 화당 `media.illustrations_per_episode` | X7과 같은 채택 규칙 | X7과 같음 | FR-IMG-03b |
| X9 영상 견적 [v2] | `visual_producer` | 샷 길이 합, 공급자 단가 | `MediaQuote(video)` | 승인 전 생성 금지. `budget.video_monthly_hard_limit_usd` 기본 0이므로 첫 승인에서 한도를 함께 정함 | — | FR-VID-04, FR-BUD-06b |
| X10 클립 [v2] | `generate_clips` / `visual_producer` | 채택 키프레임(I2V, T2V는 옵션), 이전 클립 끝 프레임(지원 공급자) | `MediaAsset(clip)` → SH6 | 키프레임 채택 없이 시작 금지(FR-VID-01). 공급자 제약 위반 샷은 생성 전 대안 제시 | X7과 같음 | FR-VID-01, 06, 10 |
| X11 씬 영상 [v2] | `assemble_scene_video` / `visual_producer` | 씬의 채택 클립(샷 순서 편집 가능) | `MediaAsset(scene_video)`, `source_segments` | 만들지 못한 샷(필터·생략)은 사유와 함께 목록. 저비용 대안은 키프레임 + 모션 효과(`motion_video`, FR-VID-05) | — | FR-VID-02, 03, 05 |
| X12 트레일러 [v2] | `edit_trailer` / `visual_producer` | 씬 영상·클립, 템플릿(길이·비율·샷 수) | `MediaAsset(trailer)` | 모든 구간이 씬 ID로 역추적(`source_segments`) | — | FR-VID-09 |

공통: 생성 직후 내려받아 보관하고 출처 기록·AI 메타데이터를 넣습니다(M3 가드, FR-IMG-04, 06, FR-VID-07). 실존 인물 사진 레퍼런스 업로드는 막습니다(FR-IMG-07, 감지 방식은 → 06 또는 별도 스파이크, 12절). 호출별 비용 예약은 견적 승인과 별개로 합니다(INV-COST-05).

### 10.3 미디어 게이트 × `media_autonomy`

| 게이트 | `question_type` / `approval_type` | `review_all`(기본, D-25) | `quote_only` |
|---|---|---|---|
| 캐릭터 시트 승인 | `attachment_review` / `character_sheet` | 사람 | 사람 |
| 이미지·영상 견적 | `approve_reject` / `media_quote` | 사람 | 사람 |
| 안전 위험 확인 | `approve_reject` / `safety_review`(승인=생성 허용, 대안 결정 순화·생략은 `maps_to=rejected`, → 05 3.1 선택지 규약) | 사람 | 사람 |
| 초안 채택 | `attachment_review` / `draft_adoption` | 사람 | `visual_producer` 자동("자동 채택" 기록) |
| 필터 차단 처리 | `single_choice` | 사람 | 사람 |

### 10.4 "갱신 필요" 전파 (FR-SPX-07)

| 원인 | 표시 대상 (`stale_since`) |
|---|---|
| 원고 새 버전에서 씬 본문 변경 또는 씬 `retired`(6.4절) | 그 씬의 샷, 현재 IR, 렌더링 프롬프트, 에셋 |
| `field_sources`의 사실이 새 버전·`retracted`가 됨 | 그 IR과 하위 렌더링 프롬프트·에셋 |
| 엔티티 병합·분리(`IdentityDecision` 적용) | 그 엔티티가 등장하는 IR과 하위 |
| `VisualReference` 교체 | 그 레퍼런스를 주입한 에셋 |
| IR 새 버전 | 사용자 편집 렌더링 프롬프트(FR-SPX-08), 에셋 |

표시만 하고 자동 재생성하지 않습니다. 재생성은 사용자가 고르고(SH8), 새 견적이 필요하면 X6/X9를 다시 거칩니다. 외형 사실 승인 시 새 시점 레퍼런스 생성을 제안합니다(FR-VIS-04).

---

## 11. 시험 시나리오 (파이프라인)

엔티티 링킹 골든셋(G01~G22)은 → 06. 아래는 파이프라인 동작을 확인하는 통합 시나리오이며 `packages/test-kit`의 가짜 LLM 어댑터로 결정적으로 재현합니다(→ 08).

| ID | 시나리오 | 기대 결과 | 근거 |
|---|---|---|---|
| PL01 | writer 힌트가 틀린 인물을 가리킴 | 힌트와 L4 불일치 → `ambiguous`, 사실 승격 안 됨 | H-2, H-3 |
| PL02 | 힌트 없는 사람 편집 버전 | 같은 파이프라인으로 연결, 누락 없음 | H-5 |
| PL03 | 배정 회수 비트 누락 | `missing` → E4 → 재작성 후 `detected` | FR-FOR-08 |
| PL04 | 재작성해도 `high` 이슈 재현 | 상한 후 GC-3 차단형 질문, 다른 화 진행 계속 | FR-ONT-06, FR-AGT-07 |
| PL05 | 다듬기가 사실 하나를 바꿈 | E7 → 재검사 | `polish.recheck_on_fact_diff` |
| PL06 | 씬 분할·병합·순서 교환 | 6.3절 표대로 ID 유지·`retired` | FR-AGT-05 |
| PL07 | 에이전트가 사람 작성 구간을 바꿈 | `human_edit_conflict` `high` | INV-MV-03 |
| PL08 | `full_auto`에서 `ambiguous` 언급이 있는 화 | 화는 E9(c), 해당 사실은 `candidate` 유지 | NFR-QUAL-01 |
| PL09 | 공개된 화의 보류 언급 판별 | 차단형 질문, 답 후 `published_locked` 지연 승격 | LB-3, LB-4 |
| PL10 | 추출 반복 실패 | 화 `checking` 정지, `extraction_failure` 질문, 직접 입력 후 P3d부터 | PRD 5.7 |
| PL11 | 반려 3회 | 방향 결정 질문, E12 미실행 | INV-EP-05 |
| PL12 | 앞 화 재작성으로 뒷 화 근거 사실 소멸 | 뒷 화 재검사(ED-3) | FR-AGT-04 |
| PL13 | [v1] 외형 사실 변경 | IR·에셋 `stale_since` | FR-SPX-07 |
| PL14 | [v1] `review_required` 샷 | 사람 확인 전 생성 없음(`quote_only` 포함) | FR-SPX-04, 09 |
| PL15 | `ambiguous` 주어 언급에서 나온 사실 | `subject_entity_id` NULL, 컨텍스트·4.4절 분류에서 제외, 답 후 `resolution_filled` 버전 | 4.6절, INV-ONT-08 |
| PL16 | `age_15` 작품에서 수위 초과 씬 | `safety_age_rating` `high` → E4, `full_auto`도 E9(c) 없음 | SF-1, SF-6, NFR-SAFE-01 |
| PL17 | 시점 `age`가 16인 인물이 등장하는 성적 묘사 | `safety_minor_sexual` `high`, 상한 질문에 "이슈 허용" 없음 | SF-2, SF-4 |
| PL18 | 실존 인물 이름으로 지어낸 발언을 사실처럼 서술 / 역사 인물 단순 언급 | 전자 `safety_real_person` `high`, 후자 이슈 없음 | SF-3, NFR-SAFE-02 |
| PL19 | 아크 계획에 설치 없는 회수 비트, 기한 넘는 회수 비트 | B4 검사 실패(SP-2, SP-3) | 1.3절, FR-FOR-02 |
| PL20 | 아크 전체 Markdown 내보내기 | 화별 `published_version_id` 사용, 비밀·주석 없음, 본문 글자 수가 앱 표시와 같음 | 3.8절, FR-MAN-04a |

---

## 12. 미결 사항

| 항목 | 내용 | 정하는 시점 |
|---|---|---|
| 심각도 기본 매핑 | 해소: 조정 규칙 2개는 06 9절 심각도 조정 규칙으로 옮겨졌습니다. 값 보정만 남음 | MVP-α 골든셋 측정(→ 09) |
| 텍스트 안전 이슈 종류·작업 | `continuity_issue_kind`에 `safety_age_rating`, `safety_minor_sexual`, `safety_real_person` 추가, `task_kind`에 `check_text_safety` 추가(00 6.8, 6.3), 04 2.2·3.3 게이트 조건에 세 번째 검사 작업 추가, `safety_*` 허용 불가 불변식 | 해소: 00 6.8(`safety_*`)·6.3(`check_text_safety`), 03 INV-CI-05, 04 2.2·3.3 |
| `is_real_person` 표시 | 필드는 06 2.4 `entities.is_real_person`, 03 5.2에 반영됐습니다. 방침 확정(NFR-SAFE-02): 이름 목록은 앱 설치 데이터, 릴리스로만 갱신, 목록 일치로 켠 값은 끌 수 없음, 사용자 수동 켜기 가능. 역사 인물은 D-33 A 방침(기준 연도·목록 출처는 D-12와 함께). 남은 것: 초기 목록의 구체 데이터 출처 선정 | → 06 O-19, MVP-α 구현 전 조사 |
| 연령 등급 수위 기준표 | SF-1 판정에 쓸 `age_rating`별 성적·폭력·언어 기준과 미성년 판정 기준(가정: 만 19세 미만, 나이 미상 처리) | MVP-α 구현 전, 텍스트 안전 골든셋(06 12.1 TS01~TS04) |
| `plan_rework` 작업과 `rework_cause` 값 | 해소: `task_kind` `plan_rework`(00 6.3, 04 2.2), enum `rework_cause`(`check`/`rejection`, 00 6.3, 04 TC-5) | — |
| 링크 보류 목적어 | 해소: 06 INV-ONT-08(목적어 NULL 포함)과 6.1 `slot_key` 규칙 | — |
| 내보내기 세부 | 파일 이름 규칙, Markdown 씬 구분 옵션, 줄바꿈 표기(3.8절 가정) | MVP-α 구현 전 |
| 자동 수정 조건 AF-3 판정 비용 | 수정마다 재추출하는 비용이 화당 비용 목표(NFR-COST-01)에 맞는지 | MVP-α 첫 5화 실측 |
| 힌트 결합 가중치 | H-3 가중치와 힌트가 없는 경우의 임계값 차이 | 골든셋 보정(→ 06) |
| 글자 수 정의 | 공백 포함 수에 줄바꿈을 넣는지, Markdown 기호 제외 방식. 내보내기와 일치해야 함(FR-MAN-04a). 가정: 줄바꿈 제외, 기호 제외 | MVP-α 구현 전, 플랫폼 표기 확인 |
| 직전 화 본문 포함 범위 | 초고 컨텍스트에 직전 화 끝 씬 1개(가정) | → 04 컨텍스트 구성, 첫 10화 품질 검토 |
| LLM 경계 추정 기준 | 6.1절 "삽입 50% 초과" 등 재추정 조건 | 재분할 골든 케이스(PL06) |
| 리트콘 버전의 씬 경계 | `published` 화 리트콘 시 경계를 사람이 확인하는 방식 | MVP-β 리트콘 흐름 설계(→ 05) |
| 실존 인물 레퍼런스 감지 방식 | FR-IMG-07 "감지 방식은 설계 문서". 이 문서는 차단만 정함 | v1 착수 전 스파이크(→ 09) |
| 기획서 승인 후 컨셉 개정 작업 | 기획서 개정 `task_kind` 이름·입력(새 `ConceptBrief` + 현 기획서)과 영향 사실 계산(11 3.10, FR-NOV-10b) | MVP-β 착수 전 |
| 컨셉 유래 사실의 캐논 처리 | 해소: B2가 만든 사실은 출처와 무관하게 기획서 승인 때 `approved`(03 INV-BIB-03 개정, B2 게이트, 11 O-C13 확정, 06 O-21 닫음) | — |
| [v1] 템플릿 독자 기대 점검 | B1·B3·P1에서 `reader_expectations`(사이다 주기·로맨스 진척·회차 말 훅)를 경고로 점검하는 방식, P4 훅 평가의 `episode_end_hook` 사용(계획서 8.2). P3d 템플릿 규칙 실행은 MVP-β(FR-NOV-03b)로 반영됨(5.1절 템플릿 규칙) | D-30 확정 후속. 방식은 v1(FR-NOV-03c) 착수 전 |
| NFR-PERF-01 측정 정의 | 사람 대기 시간 제외 여부(7.4절 가정) | → 01 3.1 I-08 |
