# 06. 스토리 온톨로지 (세계관 그래프)

| 항목 | 내용 |
|---|---|
| 문서 | novel-create-studio 상세 설계 06 |
| 버전 | v0.2 (2026-10-28, 3.14 컨셉 → 초기 온톨로지 경로, 4.7 장르 템플릿 확장 적용 추가). v0.2.1(같은 날, 계획서·11 v0.2 교차 후속): 3.5 `max_holders: unbounded`와 칭호 엔티티 자동 생성(TI-1~TI-5), 3.7 유형 수준 호칭 규칙 층(B-6), 3.14 `imported` 출처·`concept_character_key`·개정 이름 변경 경로, 4.7 TA-1·TA-6 정정, 6.3·9절 템플릿 규칙 평가 범위 E-1~E-4와 `regression_branch`, 9절 사전 필터 종류·릴리스 |
| 버전 갱신 | v0.2.2 (2026-10-28): 사용자 결정 확정 반영. 11.1 ADR-005 확정(Apache AGE v1 미포함, Neptune 미채택)과 Obsidian 내보내기·가져오기(v1, PRD FR-ONT-20), 2.4 `is_real_person` 방침(PRD NFR-SAFE-02)·O-19 해소, 3.14·4.1·4.7 템플릿 시점 MVP-β(FR-NOV-03b)·v1(FR-NOV-03c)(D-30), `base@2` 시점(D-32), TA-8 업그레이드 경로(D-36), 3.14 사실 캐논 처리(11 O-C13)·O-21 해소 |
| 기준 | PRD v0.4 초안, `00-foundation.md` v0.2, `03-domain-model.md` v0.3, `11-concept-development.md` v0.1, 계획서 `../plans/genre-world-templates-plan.md` |
| 역할 | 세계관 온톨로지 내부 구조의 단일 출처입니다. 그래프 스키마, 엔티티 식별 계층(Entity·EntityName·Mention·링커), OntologySchema, 용어집, 사실의 bitemporal 모델, 인물·독자 지식, 떡밥의 온톨로지 연결, 연속성 규칙, 컨텍스트 조회 경로, 엔진 선택과 질의, 골든 테스트셋을 정합니다. |
| 작성 | AI 초안. 사람 검토 필요 |

**표기**
- enum 값은 → 00 6절, 기본값은 → 00 7절의 이름을 그대로 씁니다. 상태 전이 중 Fact·Setup·ContinuityIssue는 → 03 4절이 소유하고, 이 문서는 Entity·EntityName·Mention·IdentityDecision·SchemaChangeProposal 전이를 소유합니다(→ 03 4.11).
- **가정:** 은 조사·실측 없는 전제, **[1차]/[2차]/[미확인]** 은 외부 사실 근거 등급입니다. 외부 사실은 2026-10-27에 작성한 조사 파일 두 개(Graph DB 후보, 엔티티 식별 기법)를 근거로 합니다.
- 불변식 ID는 `INV-ONT-<번호>`, 상태 전이 ID는 `EN`(Entity), `NM`(EntityName), `MN`(Mention), `ID`(IdentityDecision), `SP`(SchemaChangeProposal), 연속성 규칙은 `CR-<번호>`, 질의 예시는 `Q<번호>`, 워크스루는 `W<번호>`입니다.
- 작중 위치는 `story_point = episode_no × 1000 + scene_ord`, 범위는 `story_range = int4range [from, to)`입니다(→ 00 5.5). 예: `12003` = 12화 씬3.

---

## 0. 목적·범위·관련 요구

### 0.1 목적

같은 표기·다른 대상(동명이인, 시점마다 보유자가 바뀌는 칭호 "폐하")과 같은 대상·다른 표기(별칭, 호칭, 위장명, 표기 변형) 때문에 세계관 그래프가 잘못 합쳐지거나 갈라지는 문제(R-18)를 구조로 막습니다. 그래프 기반 검색(RAG)과 연속성 검사가 틀린 사실을 근거로 쓰지 않게 하는 것이 목표입니다(D-27).

핵심 방식은 다음 다섯 가지입니다.
1. 엔티티는 불변 ID로만 식별합니다. 이름은 엔티티에 붙은 데이터입니다.
2. 이름마다 작중 유효 범위, 시간선, 그 이름을 아는 인물 범위를 둡니다.
3. 원고 속 표기는 언급(`Mention`)으로 기록하고, 링커가 시점·화자·문맥으로 후보를 좁힌 뒤 신뢰도에 따라 확정하거나 질문합니다.
4. 유형·관계는 통제 어휘(`OntologySchema`)에서만 고르고, 정의역·치역·개수·시간 제약을 DB와 검사기가 강제합니다.
5. 병합·분리는 자동으로 하지 않습니다. 제안 → 확인 → 적용 → 되돌리기 가능한 이력으로 처리합니다.

### 0.2 범위

| 다루는 것 | 다루지 않는 것 (참조) |
|---|---|
| 온톨로지 테이블·필드·제약, 그래프 논리 모델 | 관계형 도메인 집합체(화·작업·질문 등) → 03 |
| 엔티티 식별 계층과 링커 L0~L8 | 사실 추출 프롬프트, 파이프라인 단계 순서 → 07 |
| OntologySchema 기본 어휘, 제약, 변경 제안 흐름 | 질문 발송·digest·마감·일일 상한 집행 → 05 |
| 용어집, Fact bitemporal 모델, 시간선 해석 | 승인 게이트(자율성 × 게이트 표) → 05 |
| 인물 지식, 독자 공개, 정체 은닉 | 컨텍스트 토큰 예산·실행 런타임 → 04 |
| 떡밥의 엔티티·사실 연결과 검사 질의 | 떡밥 상태 전이 → 03 4.7, 떡밥 검사 단계 → 07 |
| 연속성 규칙 목록과 각 규칙의 질의 | 연속성 이슈 상태 전이 → 03 4.6 |
| GraphRAG 컨텍스트 조회 경로 | 저장소 프로세스 구성·백업 → 02, 기술 스택 → 08 |
| 엔진 선택(D-8) 상세, 질의 예시 | 스파이크 일정 → 09 |
| 골든 테스트셋 시드와 평가 방법 | 테스트 도구·CI 품질 게이트 → 08 |

### 0.3 관련 요구

| 구분 | ID |
|---|---|
| 기능 | FR-ONT-01~19, FR-FOR-01~08, FR-AGT-04(컨텍스트), FR-AGT-05(씬 ID), FR-MSG-16(답변 해석 링킹), FR-NOV-08(컨셉 → 초기 온톨로지, 3.14), FR-NOV-03b(MVP-β)·03c(v1)(장르 템플릿 → 스키마 확장, 4.7) |
| 비기능 | NFR-QUAL-01(골든셋 정확도), NFR-PERF-04(컨텍스트 p90 10초), NFR-REL-04·05(백업·업그레이드), NFR-EXT-01(엔진 교체 경계), NFR-EXT-04a(작품 격리) |
| 결정 | D-8(Graph DB 선택 기준, 확정: PostgreSQL 사실 테이블 + 질의 계층, 2026-10-28 사용자 확인), D-30·D-32·D-36(장르 템플릿 릴리스·`base@2`·업그레이드, 확정), D-27(ID 기반 엔티티 + 이름 사전 + 통제 스키마), D-5(떡밥·공개 잠금 MVP), D-24(`full_auto` 사실 확정) |
| 위험 | R-4(추출 오류가 캐논 오염), R-15(시간선·지식 모델 복잡도), R-18(같은 표기·다른 대상, 같은 대상·다른 표기) |
| ADR | ADR-004, ADR-005, ADR-006, ADR-007, ADR-013, ADR-018 (→ 00 3절) |

### 0.4 선행 문서

`00-foundation.md`(용어, ADR, enum, 기본값), `03-domain-model.md`(집합체, Fact·Setup 상태 기계, 온톨로지 경계 5절). 동시에 작성 중인 02·04·05·07·08·09는 "→ 0X"로만 참조합니다.

### 0.5 릴리스 구분

| 기능 | 릴리스 | 근거 |
|---|---|---|
| 엔티티·이름 사전·언급·링커·신뢰도·질문, 병합·분리·재연결, OntologySchema, 단일 시간선, 서술 프레임(회상), 인물 지식, 정체 은닉, 공개 잠금, 떡밥 연결·리포트·지표 | MVP-α | FR-ONT-01~03, 05~07, 09, 10a, 12~18 |
| 다중 시간선(회귀·루프·평행), 기억 이월, 빙의(몸·인격 분리) | MVP-β | FR-ONT-04. 빙의 분리는 가정: FR-ONT-04와 같은 시점 |
| 용어집 테이블과 표기 규칙 검사 | MVP-β | FR-ONT-19 (MVP-α는 이름 사전의 `variant`·`hidden_variant`로만 처리) |
| 관계도·타임라인 시각화, 설정집·구조화 내보내기, 시각 자산 연결 | v1 | FR-ONT-08, 10b, 11 |

---

## 1. 설계 원칙

| # | 원칙 | 막는 실패 (조사 파일 1.2절) | 근거 |
|---|---|---|---|
| P-1 | 이름 문자열은 **후보 생성 키**로만 씁니다. 동일성 근거로 쓰지 않습니다. 표기가 정확히 일치해도 이름 사전에 후보가 둘 이상이면 문맥 판별로 넘깁니다. | 잘못된 병합(동명이인, 칭호) | FR-ONT-14, ADR-006 |
| P-2 | 사실·관계·지식·떡밥·씬 등장·IR은 `entity_id`만 참조합니다. 문자열로 대상을 가리키는 쓰기 경로를 두지 않습니다. | 대표명 변경 시 연결 끊김 | FR-ONT-12, INV-SC-03 |
| P-3 | LLM은 **닫힌 후보 목록** 중 하나 또는 `NIL`·`UNSURE`만 답합니다. 그래프 쓰기는 검증된 코드 경로만 합니다. | 후보 밖 환각 | Graphiti 차용 [1차] https://arxiv.org/html/2501.13956 |
| P-4 | 자동 병합은 없습니다. `owl:sameAs`식 전이 병합도 쓰지 않습니다. 병합된 ID는 지우지 않습니다. | 오판의 연쇄 전파 | FR-ONT-16, 조사 파일 2절 |
| P-5 | 병합할 때 설명을 LLM으로 합치지 않습니다. 사실은 출처와 함께 옮기고 요약은 다시 만듭니다. 대표명을 자동으로 바꾸지 않습니다. | 설명 오염, 위장명이 대표명을 덮음 | 조사 파일 1.2절 |
| P-6 | 스키마는 **닫힌 세계**로 검증합니다. 스키마 밖 술어는 저장하지 않고 변경 제안으로 보냅니다. | 관계 어휘 분산("부하/수하/휘하") | FR-ONT-18, SHACL [1차] https://www.w3.org/TR/shacl/ |
| P-7 | 사실은 작중 유효 시간과 기록 시간을 따로 가집니다. "새 정보가 참" 자동 무효화는 하지 않습니다. "과거에 참"(범위 닫힘)과 "틀림"(`retracted`)을 구분합니다. | 회상·거짓말·다중 시간선 오판 | ADR-007, Wikidata rank [1차] https://www.wikidata.org/wiki/Help:Ranking |
| P-8 | 지식은 3층입니다: 캐논(작가의 진실) / 독자 공개 / 인물 지식. 컨텍스트는 시점 인물이 아는 이름과 사실로 만듭니다. | 정체 누설 | FR-ONT-03, 17 |
| P-9 | 분리를 우선합니다. 확신이 없으면 별개로 두고 묻습니다. 잘못된 자동 연결 비용이 질문 비용보다 큽니다. | 잘못된 병합 | R-18, 00 7.5 보정 순서, BookNLP 비교 [1차] https://arxiv.org/pdf/2307.03734 |

---

## 2. 저장 구성과 그래프 스키마

### 2.1 논리 그래프

엔진은 같은 PostgreSQL의 테이블입니다(ADR-005, 11절). 아래는 질의 계층이 표현하는 논리 그래프입니다. 관계(`Relation`)는 별도 엣지 테이블이 아니라 `fact_kind=relation`인 사실 행이고, 사실 자체가 출처·시간·상태를 가진 "구체화된 엣지(reified edge)"입니다.

```
                (아는 인물)        (정체 공개 시점)
 EntityName ──NAMES──▶ Entity ◀──SUBJECT── Fact ──OBJECT──▶ Entity | Fact | EntityName
   ▲  │                 │  ▲                 │  ├─ IN_TIMELINE ──▶ Timeline ──BRANCHES_FROM──▶ Timeline
   │  └─VIA─┐           │  │                 │  ├─ SOURCED_FROM ─▶ Scene | Answer | SeriesBible
   │        │           │  └─LINKS_TO── Mention ──IN──▶ Scene / ManuscriptVersion / Answer
   │        └───────────┼────────────── (via_name_id)
   │                    ├─MERGED_INTO──▶ Entity          (redirect, 이력은 IdentityDecision)
 GlossaryTerm ─DEFINES─▶│ ├─CONFUSABLE_WITH─ Entity      (쌍둥이 등, 항상 판별)
                        │ └─DISTINCT_FROM── Entity       ("다름" 판정, 중복 후보 제외)
 Setup ─SETUP_LINK──────┘  Scene ─PARTICIPANT─▶ Entity
 OntologySchemaVersion ─VALIDATES─▶ Fact
```

### 2.2 노드 유형

| 노드 | 테이블 | ID | 핵심 속성 | 소유 모듈 |
|---|---|---|---|---|
| 엔티티 | `entities` | `ent` | `entity_type`(스키마 키), `status`, `preferred_name_id`, `merged_into_id`, `disambiguator`, `summary` | `ontology` |
| 이름 | `entity_names` | `enm` | `surface`, `normalized_key`, `jamo_key`, `translit_key`, `name_kind`, `is_preferred`, `story_range`, `timeline_id`, `surface_visibility`, `surface_known_by_entity_ids`, `identity_visibility`, `identity_known_by_entity_ids`, `used_by_condition`, `reader_reveal_point`, `forbidden_by_glossary_term_id` | `ontology` |
| 언급 | `mentions` | `mnt` | 위치, `surface`, `mention_kind`, `speaker_entity_id`, `pov_entity_id`, `narrative_frame_id`, `candidates`, `linked_entity_id`, `via_name_id`, `via_entity_id`, `confidence`, `link_status` | `linking`(쓰기·질의 구현은 `ontology`의 `OntologyRepository`, 11.4절) |
| 서술 프레임 | `narrative_frames` | `nfr` | `scene_id`, `char_start`/`char_end`, `frame_kind`, `target_story_point`, `target_timeline_id` | `ontology` |
| 사실 | `facts` / `fact_versions` | `fct` / `fcv` | `fact_kind`, 주어·술어·목적어, `slot_key`, `timeline_id`, `story_range`, `canon_status`, 출처 | `ontology` |
| 시간선 | `timelines` | `tln` | `kind`, `parent_timeline_id`, `branch_story_point`, `rewind_to_story_point` | `ontology` |
| 스키마 버전 | `ontology_schema_versions` | `osv` | `base_schema_key`, `extension`, `version_no` | `ontology` |
| 스키마 변경 제안 | `schema_change_proposals` | `scp` | `kind`, `status`, `payload`, `mapped_to_key` | `ontology` |
| 용어 | `glossary_terms` | `gls` | `surface`, `definition`, `spelling_rules`, 연결 대상 | `ontology` |
| 동일성 결정 | `identity_decisions` | `idd` | `kind`, `status`, 대상 엔티티, 영향 범위 | `ontology` |

외부 노드(관계형, → 03): `Scene`, `Episode`, `ManuscriptVersion`, `Answer`, `Question`, `Setup`, `SetupBeat`, `ContinuityIssue`.

### 2.3 엣지 유형

| 엣지 | 방향 | 물리 표현 | 시간 속성 |
|---|---|---|---|
| `NAMES` | EntityName → Entity | `entity_names.entity_id` | `story_range`, `timeline_id` |
| `LINKS_TO` | Mention → Entity | `mentions.linked_entity_id` | 언급 위치의 `story_point` |
| `CANDIDATE` | Mention → Entity | `mentions.candidates` jsonb 배열 | — |
| `VIA` | Mention → EntityName / 칭호 Entity | `mentions.via_name_id`, `via_entity_id` | — |
| `SUBJECT` / `OBJECT` | Fact → Entity / Fact / EntityName | `facts.subject_entity_id`, `object_entity_id`, `object_fact_id`, `object_name_id` | `story_range`, `timeline_id`, 기록 시간 |
| 관계(`Relation`) | Entity → Entity | `facts` (`fact_kind=relation`, `predicate`=스키마 관계 키) | 같음 |
| `HOLDS_TITLE` | 인물 → 칭호 엔티티 | `facts` (`predicate=holds_title`) | 같음. 보유 기간 겹침은 DB 제약(2.5절) |
| `KNOWS` | 인물 → Fact / EntityName | `facts` (`fact_kind=knowledge`) | 같음 |
| `IN_TIMELINE`, `BRANCHES_FROM` | Fact → Timeline, Timeline → Timeline | `facts.timeline_id`, `timelines.parent_timeline_id` | `branch_story_point` |
| `SOURCED_FROM` | Fact → Scene / Answer / … | `facts.source_kind` + `source_ref_type`/`source_ref_id`, `source_scene_id` | — |
| `MERGED_INTO` | Entity → Entity | `entities.merged_into_id` | `identity_decisions.applied_at` |
| `CONFUSABLE_WITH` | Entity ↔ Entity | `entities.confusable_with_ids` (양쪽에 기록) | — |
| `DISTINCT_FROM` | Entity ↔ Entity | `entity_distinct_pairs` | — |
| `DEFINES` | GlossaryTerm → Entity / 스키마 키 | `glossary_terms.linked_entity_id`, `linked_schema_key` | — |
| `PARTICIPANT` | Scene → Entity | `scene_participants` (→ 03 3.2) | 씬 `story_point` |
| `SETUP_LINK` | Setup → Entity / Fact | `setup_links` (→ 03 3.7) | `pinned_fact_version_id` |

### 2.4 테이블 정의

공통 컬럼 `id`, `novel_id`, `created_at`, `updated_at`은 생략합니다. 모든 테이블은 `UNIQUE (novel_id, id)`와 복합 외래 키를 가집니다(T-1, T-2). 03 5.2절의 핵심 필드를 확정하고, 이 문서에서 더한 필드는 **[06 추가]**로 표시합니다.

#### `entities`

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `entity_type` | text | Y | 활성 스키마의 엔티티 유형 키(4.2절). 기본 키는 enum `entity_type`, 작품 확장 키는 데이터 |
| `status` | enum:entity_status | Y | 3.1절 |
| `preferred_name_id` | id(enm) | C | `active`면 필수. 대표명 |
| `merged_into_id` | id(ent) | C | `merged`면 필수 |
| `confusable_with_ids` | id[] | Y | 쌍둥이·대역 등 항상 판별할 상대(기본 빈 배열) |
| `disambiguator` | text | N | **[06 추가]** 화면·질문에서 동명이인을 구분하는 짧은 꼬리표(예: "북부 기사단") |
| `created_from_mention_id` | id(mnt) | N | NIL 언급에서 생긴 후보 엔티티 |
| `equivalence_check` | jsonb | N | **[06 추가]** EN3(b) 동치 판정 결과 `{compared_entity_ids, votes, passed, run_id}`(3.1절) |
| `is_real_person` | bool | Y | **[06 추가]** 실존 인물 표시(`character`만, 기본 false). 07 SF-3 텍스트 안전 검사(NFR-SAFE-02)의 사전 필터 입력입니다. 시간에 따라 바뀌지 않는 안전 표시라서 4.3절 속성 사실이 아니라 엔티티 컬럼으로 둡니다. 엔티티 생성·이름 추가 때 대표명·별칭의 `normalized_key`가 실존 인물 이름 목록과 일치하면 true로 켜고, 사용자가 수동으로 켤 수도 있습니다. 목록 일치로 켠 값은 사용자가 끌 수 없습니다(NFR-SAFE-02 "끌 수 없음", 2026-10-28 방침 확정. 동명 가상 인물의 오탐은 SF-3 LLM 확인이 "단순 언급·위반 아님"으로 거름). 이름 목록은 앱 설치 데이터로 두고 릴리스로만 갱신합니다(2026-10-28 방침 확정. 초기 목록의 데이터 출처는 O-19) |
| `summary` | text | N | 사실에서 다시 만드는 요약. 원천 아님 |
| `created_by_actor_type` / `created_by_actor_id` | enum / text | Y | D-4 |

#### `entity_names`

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `entity_id` | id(ent) | Y | 이름 주인. 칭호 이름("폐하")은 칭호 엔티티의 이름입니다(3.5절) |
| `surface` | text | Y | 원래 표기 |
| `normalized_key` | text | Y | 3.4절 정규형. 후보 생성 키 |
| `jamo_key` | text | Y | **[06 추가]** 자모 분해형. 후보 생성용 편집거리 계산 |
| `translit_key` | text | Y | **[06 추가]** 라틴↔한글 음역 정규형(3.4절 N8). 후보 생성 키 |
| `name_kind` | enum:name_kind | Y | 3.2절 |
| `is_preferred` | bool | Y | 엔티티당 `active` 1개 |
| `status` | enum:entity_name_status | Y | 3.2절 |
| `story_range` | int4range | Y | 작중 유효 범위. 기본 `[0,)` |
| `timeline_id` | id(tln) | N | NULL = 모든 시간선 |
| `surface_visibility` | enum:name_visibility | Y | **[06 추가: 기존 `visibility`를 둘로 나눔]** 이 **표기를 쓸 수 있는** 범위. `disguise`는 기본 `public`(누구나 "가면 기사"라고 부를 수 있음) |
| `surface_known_by_entity_ids` | id[] | Y | `surface_visibility=restricted`일 때 처음부터 이 표기를 아는 인물(예: 인격의 원래 이름) |
| `identity_visibility` | enum:name_visibility | Y | **[06 추가]** 이 **표기와 정체(엔티티)의 연결을 아는** 범위. `true_name`·`alias` 등은 기본 `public`, `disguise`는 기본 `restricted` |
| `identity_known_by_entity_ids` | id[] | Y | **[06 추가]** 처음부터 정체 연결을 아는 인물. 나중에 알게 되는 인물은 지식 사실 `knows_identity`(7절) |
| `used_by_condition` | jsonb | C | `address_term`이면 필수. 화자 조건(3.7절) |
| `reader_reveal_point` | story_point | N | 독자가 이 이름과 엔티티의 관계를 알게 되는 지점(`disguise`·`secret`에 사용) |
| `origin_entity_id` | id(ent) | N | **[06 추가]** 병합으로 옮겨 오기 전 주인. 분리·되돌리기에 사용 |
| `forbidden_by_glossary_term_id` | id(gls) | N | **[06 추가]** 용어집 `forbidden_variants`에서 만든 행이면 그 용어 ID. 이 값이 있는 이름만 CR-16 금지 표기입니다(5절) |
| `merged_conflict_with_id` | id(enm) | N | **[06 추가]** 병합 중 같은 키 충돌로 `retired`된 행이면 흡수한 S 쪽 이름 행(3.11절 4단계). 되돌리기에서 다시 살림 |
| `source_kind` / `source_ref_type` / `source_ref_id` | enum:fact_source_kind / enum:ref_type / text | Y | 출처 |

#### `mentions`

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `source_kind` | enum:mention_source_kind | Y | 아웃라인·원고는 `manuscript` |
| `manuscript_version_id` / `scene_id` / `char_start` / `char_end` | id / int | C | `source_kind=manuscript`면 필수 |
| `answer_id` | id(ans) | C | `source_kind=answer`면 필수 |
| `story_point` / `timeline_id` | story_point / id(tln) | Y | 언급 시점. 씬에서 복사하되, 언급 위치가 `narrative_frames` 범위 안이면 프레임의 `target_story_point`·`target_timeline_id`(3.5절). 답변은 질문 대상 시점 |
| `narrative_frame_id` | id(nfr) | N | **[06 추가]** 언급이 들어 있는 회상·꿈·다른 시간선 프레임 |
| `redirected_from_entity_id` | id(ent) | N | **[06 추가]** 실행 중 병합으로 `linked_entity_id`를 `merged_into_id`로 바꿔 썼을 때 원래 ID(3.11절 "병합 중 쓰기") |
| `surface` | text | Y | `zero`면 빈 문자열 |
| `mention_kind` | enum:mention_kind | Y | |
| `speaker_entity_id` | id(ent) | N | 대사 화자(L1). 서술문이면 NULL |
| `pov_entity_id` | id(ent) | N | 씬 시점 인물 |
| `chain_key` | text | N | **[06 추가]** 씬 안 공지시 체인 식별자(L0·L8) |
| `candidates` | jsonb | Y | `[{entity_id, via_name_id, via_entity_id, rule_score, votes, features}]` |
| `linked_entity_id` | id(ent) | C | `auto_linked`·`confirmed`·`new_entity_candidate`면 필수 |
| `via_name_id` | id(enm) | N | **[06 추가]** 연결에 쓰인 이름 행 |
| `via_entity_id` | id(ent) | N | **[06 추가]** 칭호를 거쳐 보유자로 연결했으면 칭호 엔티티 |
| `confidence` | real | N | 보정된 신뢰도(3.9절) |
| `rationale` | text | N | 판별 근거 요약 |
| `link_status` | enum:link_status | Y | 3.8절 |
| `linker_version` | text | Y | `linker@<semver>+cal<n>` |
| `question_id` / `run_id` | id | N | |

#### `facts` / `fact_versions`

6.1절에서 정의합니다.

#### `timelines`

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `kind` | enum:timeline_kind | Y | |
| `label` | text | Y | `T1`, `T2` … |
| `is_default` | bool | Y | 작품당 1개(`main`) |
| `parent_timeline_id` | id(tln) | C | `main` 외 필수 |
| `branch_story_point` | story_point | C | 이 시간선의 첫 서술 지점 |
| `rewind_to_story_point` | story_point | C | **[06 추가]** `regression`·`loop`면 필수. 부모 시간선의 어느 지점 세계 상태에서 다시 시작하는지 |

#### `narrative_frames` **[06 추가]**

씬 안 일부 구간이 씬 시점이 아닌 다른 시점·시간선을 서술할 때의 표시입니다(회상 문단, 꿈, 다른 회차 기억). 07 씬 분할(`SceneSegmentationResult`)과 사실 추출(`scope_hint=flashback`)이 만듭니다(→ 07 4.3 `frames[]`·`frame_key`, 6.1 `SceneSegmentationResult`).

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `scene_id` / `manuscript_version_id` | id | Y | |
| `char_start` / `char_end` | int | Y | 프레임 구간. 씬 전체가 회상이면 씬 전체 구간 |
| `frame_kind` | enum:narrative_frame_kind | Y | `flashback` 회상 서술; `recollection` 인물의 기억 진술; `dream` 꿈·환상; `other_timeline` 다른 시간선(회귀 전 회차 등) |
| `target_story_point` | story_point | N | 프레임이 가리키는 작중 시점. 모르면 NULL |
| `target_timeline_id` | id(tln) | N | 프레임이 가리키는 시간선. NULL = 씬 시간선 |
| `source_kind` / `run_id` | | Y / N | 추출·사람 입력 |

`target_story_point IS NULL`인 프레임 안에서 나온 사실은 승격 대상에서 뺍니다(시점을 정할 수 없음). `dream`은 캐논 사실을 만들지 않습니다(지식·믿음 사실만).

#### `identity_decisions` / `identity_decision_moves` / `entity_distinct_pairs`

| 테이블 | 필드 |
|---|---|
| `identity_decisions` | `kind` enum:identity_decision_kind(**[06 추가]** `relink` 포함, 3.11절), `status` enum:identity_decision_status, `source_entity_ids` id[], `survivor_entity_id`(merge), `new_entity_id`(split), `relink_mention_ids` id[]·`relink_from_entity_id`·`relink_to_entity_id`(relink), `rationale`, `evidence` jsonb(유사 점수·특징), `impact` jsonb(Q8 결과 요약), `question_id`, `approval_id`(N, `identity_change`), `proposed_by_actor_*`, `decided_by_actor_*`, `applied_at`, `reverted_at`, `reverted_by_actor_*` |
| `identity_decision_moves` **[06 추가]** | `decision_id`, `ref_table`, `ref_id`, `ref_column`, `from_entity_id`, `to_entity_id`, `created_fact_version_id`(N). 병합·분리가 옮긴 참조 한 건 = 한 행 |
| `entity_distinct_pairs` **[06 추가]** | `entity_a_id`, `entity_b_id` (`a < b`), `decision_id`. `UNIQUE (novel_id, entity_a_id, entity_b_id)` |

#### `ontology_schema_versions` / `schema_change_proposals` / `glossary_terms`

4.1절, 4.5절, 5절에서 정의합니다.

#### `fact_cardinality_slots` **[06 추가]**

개수 1 제약이 있는 관계의 **캐논** 사실이 시간 범위를 점유하는 행입니다. DB가 겹침을 거부합니다(2.5절, S-2).

| 필드 | 설명 |
|---|---|
| `fact_id`, `timeline_id`, `story_range` | 사실에서 복사 |
| `slot_key` | `s:<subject>|<predicate>`(주어당 1) 또는 `o:<object>|<predicate>`(목적어당 1). 한 사실이 두 슬롯을 가질 수 있음 |

### 2.5 DB가 강제하는 제약과 불변식

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- text '=' 를 GiST EXCLUDE에 쓰기 위해 (S-1)

-- INV-ONT-05: 개수 1 관계의 캐논 사실은 같은 시간선에서 기간이 겹치지 않습니다.
CREATE TABLE fact_cardinality_slots (
  novel_id    text NOT NULL,
  fact_id     text NOT NULL,
  timeline_id text NOT NULL,
  slot_key    text NOT NULL,
  story_range int4range NOT NULL,
  PRIMARY KEY (novel_id, fact_id, slot_key),
  FOREIGN KEY (novel_id, fact_id) REFERENCES facts (novel_id, id),
  EXCLUDE USING gist (novel_id WITH =, timeline_id WITH =, slot_key WITH =, story_range WITH &&)
);

-- INV-ONT-02: 엔티티당 활성 대표명 1개
CREATE UNIQUE INDEX entity_names_one_preferred
  ON entity_names (novel_id, entity_id) WHERE is_preferred AND status = 'active';

-- INV-ONT-03: 같은 엔티티에 같은 정규형·같은 유형 이름이 같은 시간선에서 기간 중복 등록되지 않음
ALTER TABLE entity_names ADD CONSTRAINT entity_names_no_dup EXCLUDE USING gist (
  novel_id WITH =, entity_id WITH =, normalized_key WITH =, name_kind WITH =,
  (COALESCE(timeline_id, '*')) WITH =, story_range WITH &&) WHERE (status <> 'retired');
```

| ID | 불변식 | 강제 위치 |
|---|---|---|
| INV-ONT-01 | 엔티티 ID는 바뀌지 않고 삭제하지 않습니다. `retired`는 참조 0건일 때만 허용합니다. | 앱(삭제 API 없음) + 상태 가드 |
| INV-ONT-02 | 엔티티당 `active` 대표명 1개(SKOS 규칙 S14 차용 [1차] https://www.w3.org/TR/skos-reference/) | 부분 유일 인덱스 |
| INV-ONT-03 | 같은 엔티티의 이름 중복 금지. 한 정규형을 `variant`와 `hidden_variant`에 동시에 두지 않습니다(SKOS S13). | EXCLUDE + 앱 검증 |
| INV-ONT-04 | 같은 `surface`를 여러 엔티티가 가질 수 있습니다(FR-ONT-13). 표기 유일 제약을 두지 않습니다. | 설계상 제약 없음 |
| INV-ONT-05 | 개수 1 관계의 캐논 사실은 같은 시간선에서 기간이 겹치지 않습니다(칭호 단독 보유, 생부 1명, 동시 위치 1곳). | `fact_cardinality_slots` EXCLUDE |
| INV-ONT-06 | `facts.predicate`는 사실의 `schema_version_id`에 있는 키여야 합니다(FR-ONT-18). | 쓰기 API 검증. 스키마 밖이면 저장하지 않음 |
| INV-ONT-07 | `canon_status ∈ {approved, published_locked}`인 사실은 `subject_entity_id`가 `active` 엔티티이고, 근거 언급 중 `ambiguous`·`new_entity_candidate`가 없습니다. | F3 가드(→ 03 4.8) + 승격 함수 |
| INV-ONT-08 | `subject_entity_id IS NULL` 또는 (엔티티 치역 술어의) `object_entity_id IS NULL`은 `candidate` 사실이고, 버전 `content.arg_mentions`의 같은 역할 언급이 판별 대기(`ambiguous`)일 때만 허용합니다("링크 보류 사실", 07 4.6). NULL 역할 사실의 `slot_key`는 6.1절 규칙으로 계산합니다. | CHECK + 앱 |
| INV-ONT-09 | `merged` 엔티티를 가리키는 활성 참조는 없습니다. 병합 트랜잭션이 모두 옮깁니다. 병합 대상(생존 엔티티)은 `active`여야 해서 redirect 순환이 생기지 않습니다. | 병합 트랜잭션 + 무결성 점검(`ontology_integrity`) |
| INV-ONT-10 | 대칭 관계는 `subject_entity_id < object_entity_id` 방향 한 행만 저장합니다. 역관계는 정방향 키 하나로만 저장합니다(4.6절). | 쓰기 API 정규화 |
| INV-ONT-11 | 사실 버전 행은 수정하지 않습니다(→ 03 8.3). | 앱 + 권한 |

**슬롯 쓰기 규칙** (EXCLUDE 위반으로 큰 트랜잭션이 통째로 실패하지 않게 함)

EXCLUDE 위반(`23P01`)은 문장이 아니라 트랜잭션 전체를 중단시키고, `UnitOfWork` 재시도 대상(`40001`·`40P01`, → 02 4.2)도 아닙니다. 그래서 화 승인(E9)·병합처럼 여러 사실을 한 번에 다루는 트랜잭션은 슬롯 행을 다음 순서로 씁니다. `OntologyRepository`의 슬롯을 쓰는 메서드(`promoteEpisodeFacts`, `applyIdentityDecision`, `revertIdentityDecision`, 사람 편집)는 이 순서를 계약으로 가집니다.

| # | 단계 |
|---|---|
| SL-1 | 작품 단위 advisory lock(`ontology_slots:<novel_id>`)을 잡습니다. 같은 작품의 슬롯 쓰기를 직렬화합니다. |
| SL-2 | INSERT 전에 같은 트랜잭션에서 겹침을 조회합니다: 같은 `novel_id`·`timeline_id`·`slot_key`이고 `story_range && :r`인 행. |
| SL-3 | 겹침이 있으면 그 사실은 캐논으로 올리지 않습니다. `candidate`로 남기고 CR-09 이슈와 질문을 만들며, 호출자에게 "승격 보류" 목록으로 돌려줍니다. 화 승인은 계속 진행하고 보류 목록은 반영 기록·승인 결과에 남깁니다. |
| SL-4 | 겹침이 없으면 SAVEPOINT 안에서 INSERT합니다. 그래도 `23P01`이 나면(잠금 밖 경로의 경합) SAVEPOINT로 그 쓰기만 되돌리고 SL-3과 같게 처리합니다. |

이 규칙으로 캐논 사실끼리 겹치는 상태는 만들어지지 않습니다(INV-ONT-05 유지). 02 4.2 "화 승인" 행의 잠금·충돌 처리는 이 규칙을 참조합니다(→ 02).

---

## 3. 엔티티 식별 계층

### 3.1 Entity와 상태 기계

| # | from | to | 트리거 | 주체 | 가드 | 감사 이벤트 |
|---|---|---|---|---|---|---|
| EN1 | (생성) | `candidate` | L5에서 NIL 판정, 또는 기획서 초안의 인물·장소 | `agent:world_keeper`(링커) / `agent:planner` | 이름 1개 이상 | `entity.created` |
| EN2 | (생성) | `active` | 사용자가 직접 추가 | `user` | 3.10절 중복 확인 표시 | `entity.created` |
| EN3 | `candidate` | `active` | (a) 기획서 승인 (b) 출처 화가 사실 승격 게이트 통과(E9) (c) "새 인물" 답변 / 중복 확인 "다름" | (a)(b) `user` / `system:orchestrator` (c) `user` | 열린 `duplicate_entity` 질문 없음; `dedup.similar_entity_min_score` 이상 기존 엔티티가 없거나 "다름"으로 판정됨. (b)는 추가로: 근거 언급에 `mention_kind=named`가 있으면 **동치 판정**(아래)을 통과해야 함 | `entity.status_changed` |
| EN4 | `candidate` | `merged` | 중복 확인 "같음" | `user` | `IdentityDecision(merge)` 적용 | `entity.status_changed`, `identity.applied` |
| EN5 | `candidate` | `retired` | NIL이 비엔티티로 판정, 또는 재작성으로 근거 언급 소멸 | `user` / `agent:world_keeper` | 참조 0건(INV-ONT-01) | `entity.status_changed` |
| EN6 | `active` | `merged` | 병합 적용 | `user` | ID 절차(3.11절) | `entity.status_changed`, `identity.applied` |
| EN7 | `merged` | `active` | 병합 되돌리기 | `user` | ID4 | `entity.status_changed`, `identity.reverted` |
| EN8 | `active` | `retired` | 잘못 만든 엔티티 폐기 | `user` | 참조 0건 | `entity.status_changed` |

`candidate` 엔티티를 가리키는 사실은 캐논이 될 수 없습니다(INV-ONT-07). 그래서 EN3은 같은 트랜잭션에서 그 엔티티의 후보 사실 승격보다 먼저 실행됩니다.

**EN3(b) 동치 판정** (사전에 없는 별칭·음역·번역 표기가 조용히 새 엔티티가 되는 것을 막음, R-18): 이름 점수가 0인 새 후보는 속성·관계가 거의 없어 유사 엔티티 점수(3.10절)로는 걸리지 않습니다. 그래서 `named` 언급에서 나온 후보 엔티티는 같은 유형의 기존 `active` 엔티티 상위 k개(k = `dedup.equivalence_check_top_k`, 가정 8, → 00 7.5. 최근 등장·씬 등장 순) 카드와 후보 카드를 L4와 같은 닫힌 선택("기존 X와 같음 / 모두 다름 / 불확실")으로 `prompt.self_consistency_samples`(3)회 판정합니다. 3회 모두 "모두 다름"일 때만 통과합니다. 그 밖이면 EN3(b)를 하지 않고 `duplicate_entity` 질문(추천: 득표 1위 기존 엔티티)을 냅니다. 이 판정은 화 승인 트랜잭션 안이 아니라 L5 직후 `link_mentions` 작업에서 하고 결과를 `entities`에 기록합니다.

### 3.2 EntityName: 이름 유형과 유효 범위

| `name_kind` | 의미 | SKOS 대응 | 후보 생성(L2) | 집필 컨텍스트 노출 | 예 |
|---|---|---|---|---|---|
| `true_name` | 본명 | altLabel | 사용 | 아는 인물 범위 안에서 | "레온 아스테르" |
| `alias` | 별칭·애칭·이명(사람에게 고정) | altLabel | 사용 | 사용 | "레오", "검성" |
| `title` | 칭호·직함. 보유자가 바뀌면 칭호 엔티티의 이름 | altLabel | 사용(칭호 → 보유자 해석) | 사용 | "폐하", "단주" |
| `address_term` | 화자 의존 호칭 | altLabel | 화자 조건 충족 시 | 그 화자에게만 | "사부", "형님" |
| `disguise` | 위장명 | altLabel | 사용 | 사용(정체는 숨김) | "가면 기사" |
| `variant` | 집필에 써도 되는 표기 변형 | altLabel | 사용 | 사용 | "레옹"(용어집이 허용한 경우) |
| `hidden_variant` | 검색 전용 변형(오타·띄어쓰기·한자 병기·용어집 금지 표기) | hiddenLabel | 사용(경유 후보 `rule_score` 상한 `linking.hidden_variant_rule_score_cap`, 가정 0.7) | 노출 안 함 | "청운검진무" |

`hidden_variant` 중 용어집 금지 표기는 `forbidden_by_glossary_term_id`로만 구분합니다. 오타·띄어쓰기·한자 병기 변형은 금지 표기가 아닙니다(CR-16 대상 아님). `hidden_variant`를 거친 후보는 `rule_score`에 상한을 두어, 단일 히트여도 자동 확정되지 않게 합니다(오연결된 표기가 변형으로 굳어 새 동명 인물을 빨아들이는 것을 막음, G20).

대표명은 유형이 아니라 `is_preferred=true` 표시입니다(00 6.10). **대표명은 자동으로 바뀌지 않습니다**(P-5). 사용자가 바꾸거나 기획서 승인으로만 바뀝니다(`entity.preferred_name_changed`).

**유형 판정 규칙** (같은 표기를 어디에 붙일지)

| 질문 | 예 → 처리 |
|---|---|
| 보유자가 바뀔 수 있는 직위인가 | "폐하", "가주", "단주" → `title` 유형 엔티티 + 그 엔티티의 `title` 이름, 보유는 `holds_title` 사실(3.5절) |
| 한 사람에게 고정된 이명인가 | "검성"(그 인물만) → 그 인물의 `alias` |
| 화자와 대상의 관계로 정해지는가 | "사부", "형님", "아가씨" → 대상 인물의 `address_term` + `used_by_condition` |
| 정체를 숨기려는 이름인가 | "가면 기사" → 정체 인물의 `disguise` (3.12절). `surface_visibility=public`, `identity_visibility=restricted` |

**EntityName 상태**

| # | from | to | 트리거 | 주체 | 가드 |
|---|---|---|---|---|---|
| NM1 | (생성) | `active` | 기획서·사용자 입력, 확정된 연결에서 나온 새 표기, 판별 답변의 이름 규칙 | `user` / `agent:world_keeper`(근거 `confirmed` 언급) | INV-ONT-03 |
| NM2 | (생성) | `proposed` | `line_editor`·링커의 변형·호칭 등록 제안 | `agent:*` | — |
| NM3 | `proposed` | `active` | 사용자 수락, 또는 `hidden_variant` 제안이 화 승인(E9)에 묶여 확정 | `user` / `system:orchestrator` | `hidden_variant`만 묶음 확정 허용. 단 `dedup.short_name_max_syllables` 이하 이름, 편집거리 일치에서 나온 변형, 근거 언급이 `auto_linked`뿐인 변형은 묶음 확정 금지(사용자 수락만). 다른 유형은 사용자 수락 |
| NM4 | `proposed` / `active` | `retired` | 기각, 폐기 | `user` | 대표명은 다른 대표명 지정 후 |

감사 이벤트: `entity_name.added`, `entity_name.updated`, `entity_name.retired`.

### 3.3 아는 인물 범위와 이름 해석 함수

이름 사용 가능 여부는 아래 함수로 판정합니다. `OntologyRepository`가 구현하고, 링커(L3)·연속성 검사(CR-07, CR-08)·컨텍스트 직렬화(10절)·04 9.4 시점 층이 같은 함수를 씁니다.

이름 행은 두 가지를 따로 가집니다. **표기 사용**(그 표기를 입에 올릴 수 있는가)과 **정체 연결**(그 표기가 어느 엔티티인지 아는가)입니다. 위장명 "가면 기사"는 누구나 부를 수 있지만(표기 `public`) 정체 연결은 소수만 압니다(정체 `restricted`). 쌍둥이 A가 B의 이름을 쓰는 경우도 같습니다. 속는 인물이 "B"라고 부르는 것은 정상이고, 그 인물이 "B=A"를 아는지만 검사 대상입니다.

| 함수 | 반환 | 규칙 |
|---|---|---|
| `ont_lineage(T, p)` | (timeline_id, eval_point)[] | 시간선 계보와 각 시간선의 평가 지점. `T`는 `p`, 부모는 6.3절 규칙(`parallel` → `branch_story_point − 1`, `regression`·`loop` → `rewind_to_story_point`). Q1·Q2·Q3·Q6이 공용으로 씁니다(11.5절) |
| `nameValidAt(name, p, T)` | bool | `status=active` ∧ `name.timeline_id`가 NULL이면 `story_range @> p`, 아니면 `(name.timeline_id, e) ∈ ont_lineage(T, p)`인 `e`에 대해 `story_range @> e`. 자식 시간선의 `p`를 부모 시간선 이름에 그대로 쓰지 않습니다(W4) |
| `surfaceKnownBy(name, viewer, p, T)` | bool | `surface_visibility=public` → 참. `restricted` → `viewer ∈ surface_known_by_entity_ids` ∨ `viewer`의 캐논 지식 사실 `knows_identity(object_name_id=name)`이 유효. `secret` → 거짓. `viewer = narrator`면 독자 층 규칙(아래) |
| `identityKnownBy(name, viewer, p, T)` | bool | `identity_visibility=public` → 참. `restricted` → `viewer ∈ identity_known_by_entity_ids` ∨ `knowledgeOf(viewer, p, T)`에 `knows_identity(object_name_id=name)`(stance `knows`)가 있음(7절). `secret` → 거짓. `viewer = narrator`면 `p ≥ reader_reveal_point`일 때만 참 |
| `nameUsableBy(name, speaker, target, p, T)` | bool | `nameValidAt` ∧ `surfaceKnownBy` ∧ (`address_term`이면 `used_by_condition` 충족). 정체 연결은 보지 않습니다 |
| `nameKnownBy(name, viewer, p, T)` | bool | 호환 이름. `identityKnownBy`와 같습니다(SQL 구현은 Q4의 `ont_identity_known_by`) |

**판정에 쓰는 함수**

| 쓰는 곳 | 함수 |
|---|---|
| L3 "화자가 그 이름을 모름" 감점 | `nameUsableBy`만. 정체를 모르는 인물이 위장명·남의 이름으로 부르는 것은 감점하지 않습니다 |
| CR-08·Q4 누설 검사, C6 카드 분리, 04 9.4 금지 표기 목록 | `identityKnownBy` |
| C6 표시 이름 후보 | `nameUsableBy` |

**서술자(`narrator`)와 서술 방식**: `narrator`는 엔티티가 아니라 함수 인자 상수입니다. 서술문(화자 NULL)을 누구 기준으로 평가할지는 씬의 `narration_mode`(→ 00 6.2 `narration_mode`: `first_person`, `third_limited`, `third_omniscient`, 작품 기본값 `novels.default_narration_mode`, 07 6.1 씬 분할이 `scenes.narration_mode`를 채움)로 정합니다.

| `narration_mode` | 서술문의 viewer |
|---|---|
| `third_omniscient` | `narrator`(독자 층). 초점 인물을 `pov_entity_id`로 기록해도 서술문은 독자 층으로 평가 |
| `third_limited`, `first_person` | `pov_entity_id`(시점 인물 층). 1인칭 "나"는 `pov_entity_id` |
| 값 없음 | 작품 기본값. 그것도 없으면 `pov_entity_id`가 있으면 `third_limited`로 봄 |

### 3.4 표기 정규화

`normalized_key`와 `jamo_key`는 결정적 함수로 만듭니다. **한글을 지우는 정규식을 쓰지 않습니다**(Graphiti 퍼지 정규화가 `a-z`, `0-9` 외 문자를 공백으로 바꿔 한글에서 퍼지 단계가 사실상 동작하지 않는다는 조사 결과 [1차, main 소스 요약 기준, 재확인 필요] https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/dedup_helpers.py).

| # | 규칙 | 예 |
|---|---|---|
| N1 | 유니코드 NFC | 조합형 → 완성형 |
| N2 | 공백·가운뎃점·하이픈·따옴표 제거 | "청운검 진무" → `청운검진무`, "흑룡·상단" → `흑룡상단` |
| N3 | 라틴 문자는 소문자, 전각 → 반각 | "Leon" → `leon` |
| N4 | 괄호 한자 병기 분리: 본 표기만 키로 쓰고 한자는 별도 `hidden_variant` 행으로 등록 제안 | "천마(天魔)" → `천마` + 변형 `天魔` |
| N5 | 조사·호격 분리는 정규화가 아니라 L0(언급 검출)이 합니다. 키에는 조사를 넣지 않습니다. | "레온은", "레온아" → 언급 `surface=레온` |
| N6 | 외래어 표기 변형은 정규화로 합치지 않습니다. 용어집(5절)·`variant` 행으로만 연결합니다. | "레온/레옹"은 키가 다름 |
| N7 | `jamo_key` = N1~N3 결과를 자모로 분해. 편집거리는 이 키에서 계산 | "민준" vs "민중" 거리 1 |
| N8 | `translit_key` = 라틴 표기를 한글 음역 정규형으로, 한글 표기를 같은 정규형으로 바꾼 키. 결정적 규칙(국립국어원 외래어 표기 규칙의 단순화 표, 가정) + 용어집 음역 사전(`glossary_terms`의 허용 변형) | "Iron Heart", "아이언 하트" → 같은 키 |

키 일치는 후보일 뿐 확정이 아닙니다(P-1). `dedup.short_name_max_syllables`(3) 이하 이름은 편집거리 일치만으로 후보를 확정하지 않습니다. N6과 N8은 역할이 다릅니다. N8은 **후보 생성**(L2 2차)에만 쓰고, 합치는 판단은 L4와 사람이 합니다. 번역 별칭("철심" ↔ "Iron Heart")은 음역이 아니므로 N8로 잡히지 않고 L2 3차 후보(3.8절)와 EN3(b) 동치 판정으로 잡습니다.

### 3.5 칭호 보유 (`holds_title`)

칭호는 "사람의 이름"이 아니라 **칭호 엔티티 + 기간이 있는 보유 관계**입니다(Wikidata `position held` + `start time`/`end time` qualifier 방식 [1차] https://www.wikidata.org/wiki/Help:Qualifiers).

| 요소 | 표현 |
|---|---|
| 칭호 엔티티 | `entity_type=title`, 대표명 "국왕". 이름 행 "폐하"(`title`), "주상"(`title`) |
| 보유 | 사실 `holds_title(subject=인물, object=칭호)`, `story_range=[즉위 지점, 퇴위·사망 지점)`, `timeline_id` |
| 단독 보유 | 칭호 엔티티 속성 `max_holders`(기본 1). 값은 양의 정수 또는 `unbounded`(무제한: 장로·기사처럼 인원 제한이 없는 칭호). 1이면 `o:<칭호>|holds_title` 슬롯으로 DB가 겹침 거부(INV-ONT-05). 2 이상이면 보유자별 슬롯이고 같은 지점 보유자 수가 값을 넘으면 CR-09. `unbounded`면 개수 검사를 하지 않습니다(보유 기간·사망 제약 CR-11은 그대로) |
| 사망과 보유 | 보유 종료는 사망 지점 이하여야 합니다(CR-11) |
| 공석·분쟁 | 보유 사실이 없는 구간은 공석. 참칭자 둘은 `candidate` 사실 둘로 존재할 수 있고 캐논 승격 시 슬롯 충돌로 거부됩니다 |

**언급 해석**: 표기 "폐하"(L2) → 이름 사전에서 칭호 엔티티 히트 → 언급 지점 `p`·시간선의 보유자 조회(Q6, 시간선별 평가 지점은 `ont_lineage`) → 후보 = 보유자, `via_entity_id` = 칭호. 보유자 연결이 기본이고, "폐하의 권한은 신성하다"처럼 직위 자체를 가리키는 문장은 L4가 후보 "칭호 엔티티 자체"를 고를 수 있습니다(후보 목록에 항상 함께 넣음).

**회상·과거 지칭**: "선왕 폐하께서는…"은 수식어 "선왕"이 단서입니다. L2는 `p`의 보유자와 함께 **직전 보유자**를 후보에 넣고(`features.prev_holder=true`), L4가 고릅니다. 회상은 씬 단위 표시가 아니라 `narrative_frames`(2.4절)로 구간 단위로 표시합니다. 프레임 안 언급은 `story_point`·`timeline_id`가 프레임 대상 값이므로, 보유자 조회(Q2·Q6), L3 사망 감점, 사실 `story_range`가 모두 그 값으로 평가됩니다. 그래서 13화 일반 씬 안 회상 문단의 "폐하"는 회상 대상 시점의 보유자(선왕)로 해석되고, 사망 감점도 받지 않습니다. T2 씬이 1회차(T1)를 회상하는 문단은 `frame_kind=other_timeline`, `target_timeline_id=T1`이라 그 안에서 나온 "1회차 한서윤 사망"은 T1 사실로 저장되고 T2의 CR-01 근거가 되지 않습니다. 프레임 대상 시점이 비면 그 사실은 승격하지 않습니다.

**선행 미승인 화 오버레이** (승계 화가 승인 전인데 다음 화를 쓰는 경우): 캐논만 보면 12화의 승계(`holds_title` 새 보유, 선왕 사망)가 아직 `candidate`라 13화 "폐하"가 선왕으로 해석됩니다. 그래서 앵커 해석에 오버레이 층을 둡니다.

| 항목 | 규칙 |
|---|---|
| 오버레이 대상 | 같은 시간선, 앵커보다 앞선 화, 그 화에 열린 `high` 이슈 없음, 근거 언급에 `ambiguous`·`new_entity_candidate` 없음(C-5와 같은 안전 조건)인 `candidate` 상태 전이 사실(`holds_title`, `life_status`, `located_at` 등 단일값 슬롯) |
| 칭호 해석 | 칭호 보유자가 캐논과 오버레이에서 다르면 그 칭호 언급은 자동 확정을 금지하고 리포트 보류(`ambiguous` + 화 검수 리포트)로 보냅니다. 후보 카드에 두 보유자를 모두 넣습니다 |
| 컨텍스트 | "미확정: 12화 이후 보유자 L"을 캐논 보유자보다 먼저 표시합니다(10.2절 C4) |
| 범위 | 오버레이는 해석·표시용입니다. 캐논으로 세지 않고, 연속성 검사의 기준이 되지 않습니다 |

04 9.1 C-4의 칭호 해석은 이 규칙을 따릅니다(→ 04).

**칭호 엔티티 자동 생성** (템플릿 `title_defs`, MVP-β/v1, 계획서 3.4 (e)): 템플릿 `title_defs`는 유형 수준 정의이고 이 절의 `title`은 개별 엔티티이므로, 아래 규칙으로 인스턴스를 만듭니다. 생성 주체는 `world_keeper`, 경로는 07 B2와 화 파이프라인 사실 추출 뒤 신규 조직 처리입니다.

| # | 규칙 |
|---|---|
| TI-1 | B2(`build_initial_ontology`)에서 `title_of` 대상 유형(`organization`·`place` 또는 그 확장 유형)의 엔티티가 생기면, 그 엔티티마다 `title_defs` 항목별 칭호 엔티티(`entity_type=title`, `status=candidate`)를 만듭니다. 이후 화에서 새 조직·영지 엔티티가 `active`가 될 때도 같은 규칙입니다(그 화 승인 트랜잭션에서) |
| TI-2 | 대표명은 "<조직 대표명> <label_ko>"(예: "청운파 장문인"), `label_ko`("장문인")는 `name_kind=title` 이름 행입니다. 같은 표기 칭호가 여럿이면 L2가 보유자 조회 + 화자·대상의 `member_of`로 후보를 좁힙니다 |
| TI-3 | `max_holders`는 칭호 엔티티 속성으로 복사합니다(정수 또는 `unbounded`) |
| TI-4 | `title_rank`(예: `ordinal:peerage`)와 `succession_rule`도 칭호 엔티티 속성으로 복사합니다. 컨셉 대화에서 바꾼 값(`concept_briefs.template_overrides`의 `item:<template>/title_defs/<key>#…` 경로)이 있으면 그 값을 씁니다 |
| TI-5 | 칭호 엔티티·속성 사실의 출처는 `fact_source_kind=series_bible`(B2) 또는 `manuscript`(화 중 생성) + 근거 `template_key@version`입니다. 기획서 승인(B2분) 또는 그 화 승인 때 캐논이 됩니다. 칭호 엔티티와 조직의 연결은 관계 `title_of`(B-4)로 둡니다 |

### 3.6 동명이인과 혼동 쌍

| 상황 | 처리 |
|---|---|
| 같은 `normalized_key`가 두 엔티티 이상에 걸림 | 정확 일치라도 항상 L4 판별(P-1). 단일 히트여도 `confusable_with_ids`가 있으면 판별 |
| 새 엔티티 생성 시 같은 키의 기존 엔티티 존재 | 생성은 허용(INV-ONT-04)하고 `duplicate_entity` 확인을 거칩니다(3.10절). "다름"이면 두 엔티티에 `disambiguator`를 붙이도록 제안 |
| 쌍둥이·대역(외형이 같음) | `confusable_with_ids`로 서로 표시. 외형 묘사를 링킹 특징으로 쓰지 않습니다(조사 파일 7절). 이 쌍으로 가는 연결은 신뢰도와 무관하게 자동 확정하지 않습니다 |
| 동명 가문(본가·분가) | 조직 엔티티 둘. 소속 관계 `member_of`로 인물 후보를 좁힘 |
| 같은 씬에 동명이인 둘이 함께 등장 | 둘 다 씬 등장(`present`)이면 L8이 화자·직전 언급 체인으로 나눔. 체인이 끊기면 `ambiguous` |

화면·질문·컨텍스트에서 동명이인은 `대표명(disambiguator)`로 표시합니다. 컨텍스트 직렬화에서도 같은 표기가 둘 이상이면 꼬리표를 붙입니다(10.4절).

### 3.7 호칭·대명사·영형 주어·묘사 표현

| `mention_kind` | 생성 단계 | 해석 단서 | 자동 확정 임계값 |
|---|---|---|---|
| `named` | L0 | 이름 사전 | `linking.tau_auto.named` (0.90) |
| `title` | L0 | 보유자 조회(3.5절) | `linking.tau_auto.title` (0.92) |
| `address` | L0 | **화자 판별(L1) 필수** + `used_by_condition` | `linking.tau_auto.address` (0.95) |
| `pronoun` | L0 | 직전 언급 체인, 성별·수 일치, 시점 인물 | `linking.tau_auto.pronoun` (0.95) |
| `descriptive` | L0 | 관계 그래프 해석("그의 사부" → 체인의 "그"의 `master_of` 상대) | `linking.tau_auto.descriptive` (0.95) |
| `zero` | 사실 추출이 주어 없는 사실을 낼 때 L0이 만듦(`surface=''`) | 시점 인물, 직전 주어, 경어 어미 | `linking.tau_auto.zero` = 자동 확정 금지 |

**호칭 조건 `used_by_condition` 형식**

```json
{ "speakers": ["ent_A"] }                                   // 화자 A가 쓰면 이 엔티티
{ "relation": "master_of", "target_role": "subject" }       // 대상이 화자의 사부일 때(화자가 object)
{ "relation": "sibling_of", "target_role": "either", "older": true }
```

관계 조건은 언급 지점 `p`의 캐논 관계로 평가합니다. 질문 답변("이 작품에서 '형님'은 A가 쓰면 B")은 `speakers` 형식 `address_term` 이름으로 저장합니다(`reflection_change_kind=entity_name_rule`).

**유형 수준 호칭 규칙 층** (`base@2` B-6, MVP-β, 계획서 3.4 (e) `address_rules`): 위 `used_by_condition`은 특정 엔티티의 이름 행에 붙습니다. 템플릿 호칭("사형", "전하", "영애")은 특정 엔티티에 묶이지 않으므로 이름 행이 아니라 작품 스키마 버전의 `extension.address_rules[]`에 둡니다.

| 항목 | 정의 |
|---|---|
| 형식 | `{surface, condition, group?, priority?}`. `surface`는 3.4절로 정규화한 키로 L0 사전에 등록 |
| 조건 키 | 기존 `relation`, `target_role`, `older` + 새 키: `relation_path`(관계 경로, 예: `[member_of, member_of^-1]` = 같은 조직 소속), `target_title_rank_at_least` / `target_title_rank_below`(`{scale, level}`: 대상이 보유한 칭호의 `title_rank`가 그 단계 이상/미만), `target_member_of_type`(대상이 그 유형 조직의 `member_of`) |
| `group` | 서로 배타적인 호칭 묶음 이름(예: `court_honorific`). 한 (화자, 대상)에 같은 `group`의 두 표기가 동시에 성립하면 `priority`가 큰 쪽만 후보로 씀 |
| `priority` | 정수, 기본 0. 같은 `group` 안 우선순위. 같은 값으로 겹치면 템플릿 빌드 오류(계획서 TV-13) |
| 해석 | L2 후보 생성에서 표기가 규칙에 걸리면, L1 화자 판별 결과를 기준으로 조건을 만족하는 엔티티를 `p` 시점 캐논으로 찾아 후보에 넣습니다(`features.address_rule_key`). 자동 확정 임계값은 `linking.tau_auto.address` 그대로 |
| 우선순위 | 엔티티 이름 행의 규칙(`speakers` 형식 등 작품별 규칙)이 있으면 그쪽이 먼저이고, 유형 수준 규칙은 그다음 후보입니다 |
| 한계 | 입문 순서 같은 관습 관계는 `base@2`에 관계가 생기기 전까지 서열 조건으로 쓰지 않습니다(계획서 3.4 (e)) |

**이름 규칙의 한계** (동명이인 키에서 과잉 일반화 방지)
- 그 `normalized_key`를 가진 `active` 엔티티가 2개 이상이면 (표기, 화자) 규칙 등록을 제안하지 않습니다(05 3.6.4 `linking.rule_proposal_min_confirmations` 제안도 같음, → 05). 에린이 S2를 두 번 "서준"이라 불렀다고 에린의 "서준"을 모두 S2로 보면 S1을 부를 때 오연결이 생기기 때문입니다.
- 등록한 규칙은 `story_range`(등록 근거 언급의 첫 지점부터)를 가지며, 질문을 억제하는 규칙이 아니라 L4 후보 1위 사전 확률로만 씁니다. L4·L6·L7은 그대로 실행되고 자동 확정 조건도 그대로입니다.

**영형 주어 운용**: 영형 언급은 자동 확정하지 않으므로, 질문 폭주를 막기 위해 다음 순서로 줄입니다.
1. 추출 단계는 주어가 문면에 있는 사실을 우선 뽑고, 영형 주어 사실은 같은 문단에 명시 주어 체인이 있을 때만 냅니다(→ 07 추출 지침).
2. 영형 언급은 체인 앵커(같은 체인의 `named` 언급)의 연결을 후보 1위로 받습니다.
3. `confidence ≥ linking.tau_ask`면 질문이 아니라 화 검수 리포트 묶음에 넣고, 사용자가 리포트에서 "추천 연결 일괄 수락"을 **명시적으로** 누르면 `confirmed`(주체 `user`)가 됩니다. 화 승인만으로는 확정되지 않습니다(INV-ONT-07).
3a. `confidence < linking.tau_ask`인 영형 언급도 판별 질문을 만들지 않습니다. 그 언급에서 나온 사실은 "주어 미정 사실"로 화 검수 리포트에 두고 캐논에서 뺍니다(`subject_entity_id IS NULL`, INV-ONT-08). 주어 생략 문장은 화당 수백 개일 수 있어 질문으로 보내면 상한을 금방 채우기 때문입니다.
4. 골든셋 G08 결과로 `linking.tau_auto.zero`의 자동 확정 허용 여부를 다시 정합니다(00 7.5).

### 3.8 링킹 파이프라인 L0~L8

링커는 `linking` 모듈의 `link_mentions` 작업입니다(→ 04 작업 정의, → 07 단계 위치). 원고·아웃라인·답변(FR-MSG-16)·사용자 입력이 모두 같은 파이프라인을 탑니다(G21).

| # | 단계 | 실행 | 입력 | 출력 | 규칙 |
|---|---|---|---|---|---|
| L0 | 언급 검출 | LLM(사실 추출과 같은 호출) | 씬 원문, 씬 메타 | `Mention` 초안: `surface`, 위치, `mention_kind`, `chain_key`, 추출 사실의 인자 역할 | 엔티티 ID를 정하지 않습니다. 조사 분리(N5) |
| L1 | 화자·시점 인물 판별 | 결정적 + LLM 보조 | 대사 따옴표, 발화 동사, 씬 `pov_entity_id`, 체인 | `speaker_entity_id`, `pov_entity_id`, `speaker_confidence` | 화자 불확실(<0.8, 가정)이면 그 대사 안 `address` 언급의 신뢰도 상한을 `tau_ask`로 낮춤 |
| L2 | 후보 생성 | 결정적 | `normalized_key`, `jamo_key`, `translit_key`, `p`, 시간선 계보, 용어집 변형, 씬 등장 | 후보 ≤ `linking.candidate_top_k`(8) | 1차: 정확 키 + 유효 범위 안(Q2). 2차(1차가 비면): 범위 밖 이름, 편집거리 ≤1(4음절 이상만), `translit_key` 일치, 용어집 변형. 3차(2차도 비면): 이름 일치 없이 씬 등장 엔티티(`scene_participants`, 아웃라인 `participant_entity_ids`), 같은 `chain_key` 앵커 엔티티, 언급 유형에 맞는 엔티티 유형 중 최근 등장 상위 `linking.no_name_match_top_n`(가정 4)개를 `features.no_name_match=true`로 넣음. 칭호는 보유자·직전 보유자·칭호 자체. 자르기·순서는 아래 "후보 자르기" |
| L3 | 규칙 필터 | 결정적 | 후보, 캐논, 스키마 | 후보별 `rule_score`(0~1)와 특징 | 제외가 아니라 감점: `p`에서 사망(`p`는 프레임 대상 시점, 3.5절. 회상·꿈 프레임 안이면 감점 없음, G14), 다른 장소에 있음, 씬 미등장, `nameUsableBy` 거짓(화자가 그 **표기**를 쓸 수 없음 → 감점 + 정체 누설 후보 표시. 정체를 모르는 인물이 위장명·남의 이름을 쓰는 것은 감점하지 않음, 3.3절), 다른 시간선 전용 이름. `hidden_variant` 경유는 `rule_score` 상한(3.2절). `entity_distinct_pairs`·`confusable_with` 표시 |
| L4 | 문맥 판별 | LLM, 닫힌 선택 | 씬 창(해당 씬 + 직전 씬 요약), 씬 등장 인물, 직전 언급 체인, 후보 카드(대표명·꼬리표·`p` 시점 관계 2개·최근 사실 2개). 답변 출처 언급(`source_kind=answer`)은 씬 창 대신 "원 질문 본문(미리보기 발췌 포함) + 원 질문의 후보 카드·질문 링크 엔티티 + 같은 `AnswerSession`(없으면 같은 채널·응답자)의 최근 `interpretation.answer_context_messages`(가정 5)개 메시지"(→ 05 7.1) | 후보 ID / `NIL` / `NON_ENTITY` / `UNSURE` + 근거, `prompt.self_consistency_samples`(3)회 | 출력 스키마가 후보 ID enum으로 제한됨. 후보 밖 값은 거부하고 `UNSURE`로 간주. 체인 단위로 한 번에 판정 |
| L5 | NIL 판정 | 결정적 + LLM | L4 결과 | 신규 후보 여부 | 다수결 `NIL`이면 후보 엔티티 생성(EN1) 후 중복 검사(3.10절). `NON_ENTITY` 만장일치 + `descriptive`면 `rejected`, 그 외 `NON_ENTITY`는 `ambiguous`(G16) |
| L6 | 신뢰도 산정 | 결정적 | 득표, `rule_score`, 1·2위 차, `mention_kind` | `confidence` | 3.9절 |
| L7 | 확정 또는 질문 | 결정적 | `confidence`, 영향 범위 | `link_status`, 질문·리포트 항목 | 3.9절 표 |
| L8 | 씬 일관성 검사 | 결정적 | 씬 안 모든 언급 | 충돌 목록 | (a) 같은 `chain_key` 안에서 다른 엔티티로 연결된 언급이 있으면 그 체인 전체를 `ambiguous`로 내림. (b) 체인이 다르고 같은 화자·같은 표기가 다른 엔티티로 연결되면 내리지 않고 `features.l8_warning=true`만 붙임(동명이인 둘이 함께 나오는 씬의 정상 경우). 서술문(화자 NULL)은 (b) 대상이 아님 |

**후보 자르기** (히트가 `candidate_top_k`를 넘는 흔한 표기: "아가씨", "기사", 흔한 이름)
1. 자르기 전 결정적 우선순위로 정렬합니다: 씬 등장 > 체인 앵커 > `address_term` 화자 조건 충족 > 유효 범위 안 > 최근 등장 화 > 언급 수.
2. 상위 `candidate_top_k`개만 남기고, 잘린 언급은 `features.candidate_truncated=true`로 표시합니다. 이 언급은 L5 `NIL`을 금지하고(정답이 잘렸을 수 있음) `UNSURE`로 보아 판별 질문 또는 리포트로 보냅니다.
3. L4에 넘길 때만 순서를 섞습니다(위치 편향 방지).
4. 잘림 비율은 S-3 측정 항목에 넣습니다(→ 09).

**3차 후보(`no_name_match`)**: 이름 일치 없이 들어온 후보는 자동 확정하지 않습니다. L4가 그 후보를 고르면 리포트 보류 또는 판별 질문으로 보내고, 답이 기존 엔티티면 그 표기를 `alias`·`variant` 이름 행 제안(NM2)으로 만듭니다. L4가 `NIL`을 고르면 L5로 갑니다(EN3(b) 동치 판정을 거침).

**확정 이력 재사용**: 같은 화의 새 원고 버전을 다시 링킹할 때, 이전 버전에서 `confirmed`된 언급과 (씬 ID, 화자, `normalized_key`, `chain_key` 앵커)가 같은 언급은 그 연결을 L4 후보 1위 사전 확률로 넘깁니다. 자동 확정 조건은 그대로 적용합니다. 그 `normalized_key`에 `active` 엔티티가 둘 이상이면 이 사전 확률을 쓰지 않습니다.

**Mention 상태**

| # | from | to | 트리거 | 주체 |
|---|---|---|---|---|
| MN1 | (생성) | `auto_linked` | L7 자동 조건 충족 | `agent:world_keeper`(링커) |
| MN2 | (생성) | `ambiguous` | L7 질문·리포트 구간, L8 충돌 | 링커 |
| MN3 | (생성) | `new_entity_candidate` | L5 NIL(후보 엔티티에 연결) | 링커 |
| MN4 | (생성) | `rejected` | L5 비엔티티 | 링커 |
| MN5 | `ambiguous` / `auto_linked` / `new_entity_candidate` | `confirmed` | 판별 답변, 리포트 수락, 사용자 수정 | `user` |
| MN6 | `ambiguous` | `rejected` | "엔티티 아님" 답변 | `user` |
| MN7 | `new_entity_candidate` | `auto_linked` | 후보 엔티티가 EN3(b)로 활성화(유사 엔티티 없음) | `system:orchestrator` |
| MN8 | `confirmed` / `auto_linked` | `confirmed`(다른 엔티티) | 사용자 재연결. 단건이 아니라 언급 집합이고 사실·이름에 닿으면 `IdentityDecision(relink)`로 처리(3.11절) | `user` (`mention.relinked`) |

병합·분리·재연결로 `linked_entity_id`가 바뀌는 것은 상태 전이가 아니라 참조 이동이며 `identity_decision_moves`에 남습니다. 감사 이벤트: `mention.batch_linked`(작업 단위 1건), `mention.link_decided`, `mention.relinked`.

### 3.9 신뢰도 산정과 임계값

LLM 자기보고 확신은 쓰지 않습니다(과신, 조사 파일 3.2절). 초기 결합식은 **가정**이고, 골든셋으로 `mention_kind`별 보정 함수를 만든 뒤 교체합니다.

```
a_i   = L4 샘플 중 후보 i 득표 비율 (0~1)
r_i   = L3 rule_score(후보 i)          (0~1)
raw_i = 0.6·a_i + 0.4·r_i                       -- 가정: 초기 가중치
c_i   = calibrate[mention_kind](raw_i)          -- 보정 전에는 항등 함수
c     = c_1 (1위),  margin = c_1 − c_2
```

| 판정 | 조건 (모두 00 7.5 키) | 결과 |
|---|---|---|
| 자동 확정 | `c ≥ linking.tau_auto.<kind>` ∧ `margin ≥ linking.margin_delta`(0.20) ∧ (`linking.require_unanimous_samples` → 만장일치) ∧ 아래 "자동 확정 금지" 조건 없음 | `auto_linked` |
| 리포트 보류 | `linking.tau_ask`(0.60) ≤ `c` < `tau_auto` ∧ 경합 아님 | `ambiguous` + 화 검수 리포트 묶음(질문 아님) |
| 판별 질문 | `c < tau_ask` ∨ `margin < margin_delta` ∨ 샘플 불일치 ∨ `candidate_truncated`(3.8절) | `ambiguous` + `entity_disambiguation` 질문. 단 `zero`는 3.7절 3a |
| 신규 확인 | L5 NIL ∧ (유사 기존 엔티티 존재(3.10절) ∨ EN3(b) 동치 판정 불통과) | `new_entity_candidate` + `duplicate_entity` 질문 |

**자동 확정 금지와 차단형은 다릅니다.** 자동 확정 금지는 "사람 확인 없이 `auto_linked`로 만들지 않음"이고, 등급은 기본 비차단형입니다. 차단형은 대상 작업을 멈추므로 아래 두 경우로만 한정합니다.

| 조건 (신뢰도와 무관, 조사 파일 6.3절) | 자동 확정 | 등급 |
|---|---|---|
| 연결 결과가 `published_locked` 사실에 닿거나 `high` 이슈의 근거가 됨 | 금지 | `blocking`(`blocking_basis=published_canon`) |
| `confusable_with` 쌍으로의 연결 | 금지 | `non_blocking` |
| `disguise` 이름의 대상과 정체를 모르는 인물의 시점·대사가 연결되어 정체를 드러내는 방향(3.12절) | 금지 | `non_blocking` |
| `zero` 언급 | 금지(`linking.tau_auto.zero`) | 질문 없음. 3.7절 3·3a(리포트) |
| `no_name_match` 후보 선택, 칭호 보유자 오버레이 불일치(3.5절) | 금지 | 리포트 보류 또는 `non_blocking` |
| 답변 출처(`source_kind=answer`) 언급 중 `mention_kind ∈ {pronoun, zero, address, descriptive}`("걔는 그냥 죽이자") | 금지 | 질문을 따로 만들지 않습니다. 후보가 1개면 05 7.1 T4 확인문, 2개 이상이면 T3 후속 질문(원 질문과 같은 등급)에서 확인합니다(→ 05 7.1) |

화당 차단형 동일성 질문(`entity_disambiguation`·`identity_change`의 `blocking`)은 `linking.max_blocking_identity_questions_per_episode`(가정 1, → 00 7.5)개까지 만듭니다. 넘치는 건은 마지막 차단형 질문 하나에 묶어 함께 보여 줍니다(선택지는 언급 묶음별).

보정 절차는 12.3절. 보정 결과는 `linker_version`의 `cal<n>`으로 기록하고, 값 변경은 릴리스(`calibrated` 범위)로만 합니다.

### 3.10 모호·신규·중복 처리와 질문 생성

질문 객체·발송·digest·마감·일일 상한 집행은 → 05. 이 절은 **언제, 무엇을, 어떤 선택지로** 묻는지만 정합니다.

| 상황 | `question_topic` | 등급 | 선택지 | 추천안 | 마감 시 기본 적용 |
|---|---|---|---|---|---|
| 판별 질문 | `entity_disambiguation` | `linking.disambiguation_question_grade`(`non_blocking`). `published_locked` 사실·`high` 이슈에 닿을 때만 `blocking`(3.9절 표) | 후보 카드(최대 4) / "새 인물" / "엔티티 아님" / "보류" | 후보 1위 | **"보류"**. 언급은 `ambiguous`로 남고 사실은 `candidate`. 추천안을 자동 적용하지 않습니다(NFR-QUAL-01 "ambiguous 자동 캐논 0건") |
| 신규 후보에 유사 엔티티 | `duplicate_entity` | `non_blocking` | "같은 대상(병합)" / "다른 대상" / "보류" | 유사 점수 1위와 같음 여부 | "보류". 후보 엔티티는 `candidate` 유지 |
| 기존 엔티티 둘의 중복 의심 | `duplicate_entity` | `non_blocking` | "병합(생존 엔티티 선택)" / "다름" / "보류" | "보류" | "보류" |
| 병합·분리·재연결이 공개 사실에 닿음 | `identity_change` + `approval_type=identity_change` | `blocking` | 승인 / 반려 | — | 없음(차단형) |

`approved`(미공개) 사실에만 닿는 병합·분리·재연결은 `canon_change` 승인을 따로 받지 않습니다. 근거는 3.11절 "승인 규칙"입니다.

**묶기 규칙** (질문 수 억제, R-5). 묶음은 같은 대상이라는 판단이 이미 있는 언급끼리만 만듭니다. 다른 대상을 한 답으로 묶으면 잘못된 병합과 사실 오귀속이 생기기 때문입니다.
- 묶음 키는 (`scene_id`, `chain_key`, `normalized_key`, 후보 집합)입니다. 같은 씬이라도 체인이 다르면(동명이인 둘) 따로 묻습니다.
- `zero`·`pronoun`·`descriptive` 언급은 `chain_key`가 같을 때만 묶습니다. 빈 표기(`zero`)끼리 표기가 같다는 이유로 묶지 않습니다.
- 씬을 넘어 묶는 것은 L0·L4가 같은 체인으로 0.95 이상 판정한 경우만이고, 후보 집합에 `confusable_with` 쌍이 있으면 씬을 넘어 묶지 않습니다.
- 질문에는 묶인 언급의 씬·화자·인용 목록을 보여 주고, "묶음 나누기"(언급별 다른 답) 선택지를 둡니다(웹, → 05).
- 리포트 보류 구간 언급은 질문을 만들지 않고 화 검수 리포트(웹)에만 둡니다.
- 답은 규칙으로 남깁니다: 새 `address_term`·`variant` 이름, `entity_distinct_pairs`, `confusable_with` 표시. 같은 질문을 다시 하지 않기 위해서입니다(이름 규칙의 한계는 3.7절).

05 3.6.1의 묶음 기준(표기·화자·후보 집합)은 이 규칙으로 맞춥니다(→ 05).

**상한 초과와 적체** (05 3.6.5와 한 규칙으로 맞춤, → 05)
1. 판별 질문은 `question.daily_cap_non_blocking`에 포함됩니다. 그날 만들 판별 질문 후보를 **우선순위 점수** 순으로 정렬해 상한까지만 질문하고, 나머지는 리포트 보류로 보냅니다. 점수(가정 가중): 영향 사실 수, `high` 이슈·떡밥 연결 여부, 그 엔티티의 다음 화 등장 예정(아웃라인 `participant_entity_ids`).
2. 적체 지표 `linking.pending_backlog` = 미해결 `ambiguous` 언급 수 + 링크 보류 사실(`subject_entity_id IS NULL` 또는 근거 언급이 `ambiguous`인 `candidate`) 수. 경보 임계 `linking.backlog_alert`(가정 50, → 00 7.5)를 넘으면 다음 화 아웃라인 전에 정보성 알림을 보냅니다.
3. 리포트 보류 항목이 `linking.report_hold_digest_days`(가정 3일) 동안 처리되지 않으면 메신저 digest 1건으로 보냅니다. 내용: "추천 연결 n건 일괄 수락 / 웹에서 검토", 표본 3건. 일괄 수락은 사용자 행동이므로 `confirmed`(주체 `user`)입니다.
4. "화당 판별 질문 수"와 "미해결 링크 비율"(= 미해결 `ambiguous` 언급 ÷ 엔티티 언급 전체)을 측정 항목으로 둡니다(12.3절). PRD 9절 KPI 추가는 → 01 PRD 수정 제안.

**유사 엔티티 점수** (`dedup.similar_entity_min_score` 0.75와 비교, 가중치는 가정)

| 특징 | 가중 | 계산 |
|---|---|---|
| 이름 | 0.5 | 정규형 일치 1.0, `translit_key` 일치 0.8, `jamo_key` 편집거리 1 → 0.7(짧은 이름은 0.4 상한), 용어집 변형 일치 0.9 |
| 속성 | 0.2 | 같은 술어의 값 일치 비율(성별·소속·외형 일부). 외형은 쌍둥이 위험 때문에 0.05로 제한 |
| 관계 | 0.3 | 공통 관계 상대 비율(같은 사부, 같은 가문) |
| 동시 등장 | 감점 | 같은 씬에 둘 다 `present`이고 서로 대화 → 점수 0(같은 대상일 수 없음). 단 정체 은닉 의심 표시가 있으면 0으로 만들지 않음 |
| 차단 목록 | 제외 | `entity_distinct_pairs`에 있는 쌍은 후보에서 뺌 |

`dedupe_entities` 작업(→ 04)은 화 확정 직후와 주 1회(가정) 실행해 `candidate`·`active` 엔티티 쌍의 중복 후보를 찾고 `IdentityDecision(proposed)`를 만듭니다. 이름 점수가 0인 쌍(사전에 없는 번역 별칭)은 이 점수로 잡히지 않으므로 EN3(b) 동치 판정(3.1절)이 막습니다.

### 3.11 병합·분리·되돌리기

**IdentityDecision 상태**

| # | from | to | 트리거 | 주체 | 가드 | 감사 이벤트 |
|---|---|---|---|---|---|---|
| ID1 | (생성) | `proposed` | 중복 탐지, 정체 공개(원고의 `identity_assertions` 포함, 3.12절), 사용자 요청·재연결 | `agent:world_keeper` / `user` | 영향 범위(Q8, `relink`는 `computeRelinkImpact`)를 `impact`에 저장. `impact.slot_conflicts` 포함 | `identity.proposed` |
| ID2 | `proposed` | `applied` | "같음"·"분리" 답변, 공개 사실이면 `identity_change` 승인 | `user` | 생존 엔티티 `active`; 영향 범위 재계산 결과가 제안 때와 다르면 다시 확인 | `identity.applied` |
| ID3 | `proposed` | `rejected` / `cancelled` | "다름"(→ `confirm_distinct`로 기록), 대상 소멸 | `user` / `system:orchestrator` | — | `identity.rejected` |
| ID4 | `applied` | `reverted` | 되돌리기 | `user` | 되돌리기 4·5단계(병합 이후 생성 참조, 충돌 검사) | `identity.reverted` |

`confirm_distinct` 결정은 `proposed` 없이 `applied`로 바로 만들고 `entity_distinct_pairs`에 행을 넣습니다.

**승인 규칙** (FR-ONT-16 "리트콘 승인"의 구현)

| 영향 범위 | 승인 | 근거 |
|---|---|---|
| 캐논 영향 없음(`candidate`만) | 판별·중복 답변만 | — |
| `approved`(미공개) 사실 | 판별·중복 답변만. `canon_change` 승인을 따로 받지 않음 | 병합·분리·재연결은 사실 **내용**이 아니라 주어·목적어 ID만 바꿉니다. 그 판단 자체가 사용자 답변(같은 대상인가)이므로 F7 `canon_change` 승인과 같은 결정을 두 번 묻지 않습니다. 03 F7의 예외로 둡니다(`change_reason ∈ {identity_merge, identity_split, identity_relink, identity_revert}`, → 03) |
| `published_locked` 사실, `published` 화 언급, `published_locked` 떡밥 연결 | `approval_type=identity_change`(`approve_reject`, `blocking`, `blocking_basis=published_canon`) | PRD FR-ONT-16은 "리트콘 승인"이라고 씁니다. `retcon`(F8)은 사실 **내용** 변경 승인이고 대상이 사실 1건입니다. 동일성 결정은 내용은 그대로 두고 여러 사실·언급·이름·떡밥 링크를 한 번에 옮기므로, 영향 목록 전체를 한 승인으로 받는 `identity_change`로 구현합니다. 내용까지 바뀌는 사실은 아래 "리트콘 연동"대로 별도 `retcon`입니다. PRD 문구를 "리트콘 승인(`identity_change`)"으로 고치는 것은 → 01 PRD 수정 제안 |

05 3.3 `identity_change` 행의 "`approved` 사실 영향: `canon_change`" 분기와 05 10.1 "기존 `approved` 사실 변경" 행의 `identity_change` 표기는 이 규칙에 맞춰 지웁니다(→ 05).

**병합 트랜잭션** (생존 S, 흡수 L, 한 DB 트랜잭션, S-6)
1. `entities`의 S·L 행을 ID 순서로 `SELECT … FOR UPDATE`로 잠그고(→ 02 4.2) 작품 슬롯 advisory lock(SL-1)을 잡은 뒤 Q8로 영향 범위를 다시 계산합니다.
2. 영향 범위에 `published_locked` 사실, `published` 화의 언급, `published_locked` 떡밥 연결이 있으면 `identity_change` 승인 없이는 진행하지 않습니다(FR-ONT-16).
3. 참조 이동: 아래 표의 컬럼에서 L → S로 바꾸고 한 건마다 `identity_decision_moves` 행을 남깁니다.
4. 이름: L의 이름 행을 S로 옮기고 `origin_entity_id=L`, `is_preferred=false`로 둡니다. **S의 대표명은 그대로**입니다. 사용자가 병합 화면에서 대표명을 고르면 별도 이벤트로 바꿉니다. 옮기기 전에 **이름 충돌 해소**를 합니다(INV-ONT-03 EXCLUDE 위반으로 트랜잭션이 실패하지 않게):
   - S에 같은 `normalized_key`·`name_kind`·시간선 이름이 있고 범위가 겹치면 L 행은 `retired`(`merged_conflict_with_id`=S 행)로 두고, S 행의 `story_range`를 두 범위의 합집합으로 넓힙니다.
   - L 행을 가리키던 `mentions.via_name_id`, `facts.object_name_id`, 지식 사실 `knows_identity`의 `object_name_id`는 S 행으로 옮기고 `identity_decision_moves`에 남깁니다.
   - 같은 정규형이 한쪽은 `variant`, 다른 쪽은 `hidden_variant`이면 `variant`를 남깁니다(SKOS S13).
   - 정체 연결 범위(`identity_known_by_entity_ids`)는 합집합으로 둡니다.
5. 사실: 사실 ID는 유지하고 주어·목적어를 바꾼 새 `FactVersion`을 만듭니다(`change_reason=identity_merge`, `identity_decision_id`). 승인은 위 "승인 규칙"을 따릅니다.
6. 슬롯 재계산: 옮긴 사실의 `facts.slot_key`와 `fact_cardinality_slots`를 다시 계산하고 이동 기록(`ref_column=slot_key`)에 남깁니다. 개수 1 슬롯에서 겹침이 생기는 사실은 Q8이 미리 `impact.slot_conflicts`로 찾아 판별 질문에 보여 주고, 적용 시에는 **흡수 쪽(L 출신) 충돌 사실을 `candidate`로 강등하는 새 FactVersion**을 만든 뒤 CR-09 이슈를 엽니다. 그래서 캐논끼리 겹치는 상태가 생기지 않습니다(INV-ONT-05, 2.5절 SL-2~SL-4). 같은 슬롯·같은 값인 사실 둘은 그대로 두고 조회에서 중복 제거합니다(4.6절).
7. L: `status=merged`, `merged_into_id=S`. `confusable_with_ids`·`entity_distinct_pairs`의 L은 S로 옮깁니다(S와 짝이 되면 그 행은 삭제하고 이동 기록).
8. 열린 연속성 이슈의 `dedupe_key`는 `resolveEntityId`로 푼 ID로 다시 계산합니다(→ 03 3.6). 근거(`continuity_issue_evidence`)는 옮기지 않습니다.
9. S 요약 재생성 작업을 큐에 넣습니다(설명을 합치지 않음, P-5).

| 참조 테이블.컬럼 | 비고 |
|---|---|
| `facts.subject_entity_id`, `facts.object_entity_id` | 새 FactVersion |
| `facts.slot_key`, `fact_cardinality_slots.slot_key` | 6단계 재계산 |
| `mentions.linked_entity_id`, `mentions.speaker_entity_id`, `mentions.pov_entity_id`, `mentions.via_entity_id` | |
| `mentions.via_name_id`, `facts.object_name_id` | 4단계 이름 충돌로 `retired`된 행을 가리킬 때만 |
| `entity_names.entity_id` | `origin_entity_id` 기록 |
| `scene_participants.entity_id` | `(scene_id, entity_id)` 충돌 시 합치고 `mention_count` 합산, 원 행 기록 |
| `scenes.location_entity_id`, `scenes.pov_entity_id` | |
| `setup_links.ref_id` (`ref_type=entity`) | |
| `question_links.ref_id` (`ref_type=entity`) | 열린 질문만 옮김. `resolved`·`cancelled` 질문은 당시 기록 보존 |
| `answer_reflection_items.ref_id` (`ref_type=entity`) | **옮기지 않음**(반영 당시 기록 보존). 조회 화면은 `resolveEntityId`로 안내 |
| `context_snapshots.entity_ids` | **옮기지 않음**(실행 당시 기록 보존) |
| `continuity_issue_evidence` | 옮기지 않음(당시 근거 보존) |
| [v1] `visual_references.entity_id`, `media_assets.entity_id`, IR `field_sources` | 옮기고 해당 샷에 `stale_since` |

**병합 중 쓰기** (02 4.2 규칙의 필드 정의): 병합은 진행 중 실행을 기다리지 않습니다. 실행이 결과(사실·언급)를 쓸 때 `ontology` 쓰기 API가 같은 트랜잭션에서 입력 엔티티 ID를 `resolveEntityId`로 풀어 현재 ID로 바꿔 씁니다. 바꾼 경우 원래 ID를 `mentions.redirected_from_entity_id`, 사실 버전 `content.written_for_entity_ids`(역할별 원래 ID)에 남깁니다. 분리는 자동 재지정 대상이 없으므로, 분리된 엔티티(`identity_decision_moves.from_entity_id`)를 참조하는 진행 중 실행은 결과 반영 단계에서 `superseded`로 끝내고 작업을 다시 큐에 넣습니다(→ 04 3.6 엔티티 분리 행).

**옛 ID 조회**: 모든 조회 API는 입력 엔티티 ID를 `resolveEntityId`(Q9)로 먼저 풀고, 응답에 `redirected_from`을 넣습니다(FR-ONT-16 "옛 ID로 조회하면 새 ID로 안내").

**분리**: 사용자가 원 엔티티 E의 언급·사실·이름 중 새 엔티티 N으로 갈 묶음을 고릅니다. 제안 화면은 언급을 씬·화자·표기별로 묶어 보여 주고, 병합으로 들어온 행(`origin_entity_id`)은 원래 엔티티 단위로 미리 묶습니다. N을 `active`로 만들고 고른 참조를 옮기며 `identity_decision_moves`에 남깁니다. 어느 쪽인지 정하지 않은 언급은 `ambiguous`로 내리고 재링킹합니다.

**되돌리기** (ID4)
1. 결정의 이동 행을 역순으로 읽습니다.
2. 현재 값이 `to_entity_id`와 같으면 `from_entity_id`로 되돌리고, 사실은 다시 새 버전을 만듭니다.
3. 현재 값이 다르면(이후 다른 결정·사람 수정이 바꿈) 되돌리지 않고 충돌 목록에 넣습니다.
4. **병합 이후 생성 참조**: 이동 행에 없지만 `applied_at` 이후 생성됐고 L에서 옮겨 온 이름(`via_name_id`의 `origin_entity_id=L`)으로 S에 연결된 언급을 찾습니다. 이 언급은 `ambiguous`로 내리고 재링킹 대상으로 넣으며, 그 언급에서 나온 사실은 링크 보류(`candidate`, 근거 언급 `ambiguous`)로 되돌립니다. 대상 목록은 되돌리기 미리보기에 보여 줍니다.
5. 충돌이 있으면 전체를 적용하지 않고 목록을 보여 주며 사용자가 항목별로 고릅니다. 충돌이 없으면 한 트랜잭션으로 적용합니다.
6. 병합 되돌리기면 L을 `active`, `merged_into_id=NULL`로 돌리고 L의 이름을 `origin_entity_id`로 돌려 놓습니다. 4단계 이름 충돌로 `retired`된 행(`merged_conflict_with_id`)은 다시 `active`로 살리고, 넓혔던 S 행 범위는 이동 기록의 원래 값으로 돌립니다. `slot_key`·슬롯 행도 다시 계산합니다.
7. 영향 범위에 공개 사실이 있으면 되돌리기도 `identity_change` 승인이 필요합니다.

**재연결** (`relink`, 잘못된 `auto_linked`·`confirmed` 연결을 늦게 고침)

두 엔티티가 원래 따로 있는데 언급 일부가 다른 쪽에 연결돼 있던 경우입니다(예: 30화 동안 이서준 S2의 언급이 S1에 연결). 병합·분리가 아니므로 `identity_decision_kind=relink`(→ 00 6.10)로 기록합니다. 대상은 언급 집합, `relink_from_entity_id`→`relink_to_entity_id`입니다. 사용자가 웹에서 언급을 고르면 `computeRelinkImpact`(Q8과 같은 구조, 대상을 언급 집합으로 한정)가 영향 범위를 계산하고, 적용 트랜잭션이 아래를 처리해 모두 `identity_decision_moves`에 남깁니다.

| # | 대상 | 처리 |
|---|---|---|
| RL-1 | 그 언급이 `content.arg_mentions`에 있는 사실 | 주어·목적어를 바꾼 새 버전(`change_reason=identity_relink`), `slot_key`·슬롯 재계산(SL 규칙). 공개 사실이면 `identity_change` 승인(위 "승인 규칙") |
| RL-2 | `source_ref`가 그 언급인 이름 행(NM1 "확정된 연결에서 나온 새 표기", NM3 `hidden_variant`) | `proposed`로 되돌리고 폐기 제안(사용자 확인) |
| RL-3 | 이름 규칙(3.7절)·확정 이력 재사용 사전 확률 | 그 언급을 근거로 한 규칙을 지움 |
| RL-4 | `entity_distinct_pairs`, `confusable_with` | 그 언급 판단에서 생긴 행은 재확인 목록에 넣음 |
| RL-5 | 근거에 해당 사실·언급이 있는 연속성 이슈 | `resolved`·`waived`·`false_positive`면 재개(`open`), 열린 이슈는 재검사 |
| RL-6 | `setup_links`의 `pinned_fact_version_id`가 RL-1 사실 | 새 버전으로 다시 고정할지 확인 항목 생성 |
| RL-7 | `scene_participants` | 언급 수를 옮기고, 0이 되면 행 삭제 |
| RL-8 | `ContextSnapshot.fact_version_ids`에 RL-1의 옛 버전이 있는 이후 화 원고 | 원고 버전에 `stale_context` 표시와 검토 항목 생성(재작성 여부는 사용자가 정함, → 07 8.2) |

되돌리기는 ID4를 그대로 씁니다.

**리트콘 연동**: 공개 사실에 닿는 병합·분리·재연결은 `approval_type=identity_change`(→ 00 6.4)입니다. 결정이 사실 **내용**까지 바꾸면(예: 정체가 밝혀져 "가면 기사는 레온과 싸웠다"가 자기 모순이 됨) 그 사실은 아래 "공개 재해석 묶음"으로 처리하고, 내용 변경을 고른 사실만 `retcon`(F8) 대상이 됩니다.

### 3.12 정체 은닉과 공개 (3층 지식)

| 층 | 무엇 | 표현 | 검사 |
|---|---|---|---|
| 캐논 | 작가의 진실: "가면 기사 = 레온" | 한 엔티티 E, 이름 "가면 기사"(`disguise`, 표기 `public`, 정체 `restricted`) | — |
| 독자 | 독자가 언제 아는가 | 위장명 행의 `reader_reveal_point` | CR-08a: 공개 전 원고(서술·대사)가 정체를 드러냄 |
| 인물 | 누가 언제 아는가 | `identity_known_by_entity_ids`(처음부터) + 지식 사실 `knows_identity(object_name_id=위장명)`. 위장명 표기 자체는 `surface_visibility=public`이라 모르는 인물도 부를 수 있음 | CR-08b: 모르는 인물의 시점·대사가 정체를 드러냄 |

**모델링 경로 선택**

| 경로 | 언제 | 처리 |
|---|---|---|
| A. 처음부터 한 엔티티 | 기획서·아크 계획에 정체가 있음(작가가 앎) | 위장명을 `disguise`로 등록. 링커는 "가면 기사"를 E로 연결하고 `via_name_id`=위장명. 독자·인물 층은 이름 함수로 처리 |
| B. 별개로 만든 뒤 병합 | 집필 중 정체가 정해짐, 또는 링커가 별개 인물로 만듦 | 정체 공개 결정 시 `IdentityDecision(merge)`. 생존 엔티티는 본명 쪽. 흡수된 쪽 이름은 `disguise`로 유형을 바꾸고 `surface_visibility=public`, `identity_visibility=restricted`, `reader_reveal_point`=공개 씬. 공개 전 화의 사실은 주어만 바뀌고 내용은 유지 |

**경로 B 진입점**: 원고 속 정체 공개 문장("검귀는 사형이었다")은 07 `ExtractionResult.identity_assertions[{mention_key_a, mention_key_b, evidence}]`(→ 07 4.3)로 나옵니다. 두 언급이 서로 다른 엔티티로 연결돼 있으면 `IdentityDecision(merge, proposed)`를 만들고(ID1 "정체 공개"), 같은 엔티티면 아무것도 하지 않습니다. 스키마 술어로 저장하지 않으므로 `unmapped` 스키마 제안이 쌓이지 않습니다.

**경로 B 병합 화면 기본값**
- `identity_known_by_entity_ids` 기본값은 {생존 엔티티 자신}이고, 사용자가 공모자를 고릅니다. 비워 두면 공개 전 화의 본인 시점·대사가 CR-08b 대상이 되기 때문입니다.
- **공개 재해석 묶음**: 병합으로 생긴 슬롯 충돌·`disjoint_with` 위반 사실(예: "사형은 사문에 있었다"(위장용 알리바이) vs "검귀는 전장에 있었다")을 목록으로 보여 주고, 사실마다 "유지(캐논 그대로) / 관찰자의 `believes`로 전환 / 위장 행동으로 유지(`value.cover_story=true`) / 내용 변경(`retcon`)"을 고르게 합니다. 이 선택은 병합과 같은 `identity_change` 승인 1건에 묶습니다. 사실마다 따로 `retcon` 이슈를 만들지 않습니다.
- 병합 이전 화에 대한 CR-08a 재검사는 의도된 반전이므로 건너뜁니다. 기준은 결정 근거 시점: 결정의 `reader_reveal_point` 이전 씬은 병합 후 재검사에서 CR-08a를 내지 않습니다(새로 쓰는 화는 그대로 검사).

경로 B에서 공개 전 화가 이미 `published`면 2단계 공개 사실 조건에 따라 `identity_change` 승인을 받습니다. 의도된 반전이면 승인하고, 재해석 묶음에서 "내용 변경"을 고른 사실만 별도 `retcon` 대상이 됩니다.

**정체 공개 처리** (예: 35화 씬4에서 독자에게 공개, 30화에 에린이 먼저 앎)
- `reader_reveal_point=35004`를 위장명에 기록합니다.
- 에린의 지식 사실 `knows_identity(subject=에린, object_name_id=가면 기사, story_range=[30007,))`를 캐논으로 둡니다.
- 35화 이후 서술은 E를 본명·위장명 모두로 부를 수 있습니다. 에린의 대사는 30화 씬7 이후 가능합니다.

**컨텍스트 반영**: 시점 인물이 정체를 모르면 컨텍스트 카드에서 E를 "가면 기사" 카드와 "레온 왕자" 카드 **두 장**으로 나눠 보여 주고, 둘이 같다는 사실·서로를 잇는 관계는 넣지 않습니다(10.4절). 이것이 "인물별로 그 인물이 아는 이름으로 컨텍스트가 구성됩니다"(FR-ONT-17)의 구현입니다. 사실을 어느 카드에 넣을지는 사실의 `observed_as_name_id`(6.1절)로 정합니다(10.2절 C6 카드 배정).

### 3.13 회귀·빙의와 시간선별 동일성

**원칙**: 엔티티 ID는 시간선을 넘어 하나입니다. 사실·이름·지식은 `timeline_id`를 가집니다(조사 파일 5절).

| 상황 | 표현 |
|---|---|
| 회귀 | 새 시간선 `kind=regression`, `parent_timeline_id`=이전, `branch_story_point`=회귀 후 첫 씬, `rewind_to_story_point`=세계가 돌아간 부모 시간선 지점. 회귀자의 기억은 사실 `retains_memory(subject=회귀자, value={from_timeline_id, until_story_point})`(4.3절) |
| 회귀 후 개명 | 같은 엔티티에 새 이름 행(`timeline_id`=새 시간선, `story_range` 시작=개명 지점). 대표명은 그대로(G12) |
| 루프 | `kind=loop`. 회차마다 시간선 1개. 기억 이월은 회귀와 같음 |
| 평행세계 | `kind=parallel`. 분기 이전 부모 사실을 상속(6.3절) |
| 물건 이월 | 새 시간선에 `owns` 사실을 명시적으로 둠(자동 상속 아님) |
| 다른 시간선의 같은 인물이 동시에 존재(평행세계 동위체) | 한 시간선 안에서 두 개체가 상호작용하면 별개 엔티티로 두고 `counterpart_of` 관계로 연결 |

**빙의(몸과 인격 분리)**: 작품 설정에서 빙의 모델을 켜면 스키마 확장 유형 `persona`, `body`를 활성화합니다(00 6.10 "빙의 작품에서만 켬"). 모든 인물을 2층으로 두지 않습니다(조사 파일 7절).

| 요소 | 규칙 |
|---|---|
| 엔티티 | 빙의 당사자는 `body`(몸) 1개, 빙의한 `persona`(주인공 인격) 1개, 몸의 **원래 영혼** `persona` 1개로 둡니다. 다른 인물은 `character` |
| 관계 | `inhabits(subject=persona, object=body, story_range)`. 몸당·인격당 동시 1개(슬롯). 원래 영혼은 `inhabits(original_persona, body, [0, 빙의 지점))`, 주인공 인격은 `[빙의 지점, …)` |
| 이름 | 사회적 이름(몸의 원래 이름, 작위 호칭)은 `body`의 이름. 주인공 인격의 원래 이름은 그 `persona`의 `true_name`(`surface_visibility=restricted`) |
| 링킹 | 표기는 이름 주인(대개 `body`)으로 연결합니다. 빙의자 시점 씬은 `pov_entity_id`=주인공 `persona`이고, 1인칭 "나"는 `persona`로 연결합니다 |
| 사실 귀속 | 술어 정의역으로 결정적으로 정합니다(아래 `possession_side`). 인격 쪽 술어가 `body`로 연결된 주어를 받으면, 언급 지점이 아니라 **사실의 `story_range` 하한**(프레임 안이면 프레임 대상 시점, 3.5절)의 `inhabits`로 인격을 찾아 주어를 바꾸고 출처에 `rewritten_via=inhabits`를 남깁니다. 그래서 "빙의 전 영애는 악독했다", 회상 속 원래 영애의 성격·기억은 원래 영혼 `persona`에 귀속됩니다 |
| 화자 | L1이 찾은 화자(대개 `body`)를 지식 검사에서는 그 대사 시점의 `inhabits`로 인격에 매핑합니다 |

**정의역 검증** (`possession_side`): 빙의 모델에서는 `character` 정의역을 한 엔티티가 아니라 몸·인격 중 한쪽으로 바꿔 검증합니다. 그렇지 않으면 약혼·가문 소속·적대 사실이 모두 CR-10(정의역 위반)이 됩니다. `RelationTypeDef`·`AttributeDef`의 `possession_side`(4.1절)로 정합니다.

| `possession_side` | 술어 | 빙의 모델에서 정의역 `character`를 대신하는 유형 |
|---|---|---|
| `body` | 사회 관계(`spouse_of`, `sibling_of`, `father_of`, `mother_of`, `adoptive_parent_of`, `member_of`, `leader_of`, `subordinate_of`, `ally_of`, `enemy_of`), `holds_title`, `owns`, `located_at`, `participated_in`, `life_status`, `age`, `gender`, `appearance.*`, `outfit`, `injury` | `body` |
| `persona` | `loves`, `master_of`, `has_ability`, `knows_fact`, `knows_identity`, `believes`, `retains_memory`, `personality` | `persona` |

사제 관계(`master_of`)처럼 작품에 따라 몸 쪽이 맞는 경우는 작품 확장(`change_constraint`)으로 바꿉니다.

### 3.14 컨셉 브리프에서 초기 온톨로지 후보로 가는 경로 (→ 11 5.7)

**원칙**: 컨셉 승인(`approval_type=concept_brief`) 트랜잭션은 온톨로지 행(`entities`, `entity_names`, `facts`, `mentions`)을 만들지 않습니다. 컨셉 단계의 인물·세계 규칙·회피 요소는 온톨로지 밖 브리프 값이고, 엔티티가 되는 경로는 07 B2(`build_initial_ontology`) 하나입니다. 이유: 기획서 단계에서 이름·인물 구성이 자주 바뀌고, 엔티티 생성 경로를 하나로 둬야 중복 엔티티가 생기지 않습니다(R-18).

| 단계 | 처리 | 엔티티 식별 | 결과 상태 |
|---|---|---|---|
| CO-1 컨셉 승인 | `ConceptBrief` 승인 버전만 고정. 장르 템플릿을 쓰면(MVP-β FR-NOV-03b, v1 FR-NOV-03c, D-30 확정) 4.7절 첫 스키마 버전 발행(규칙·어휘만, 사실 없음) | 없음 | 온톨로지 행 0건 |
| CO-2 기획서 작성(B1) | `planner`가 브리프의 `protagonist`·`main_characters[]`·`world_rules[]`·`avoid_list[]`를 기획서 `content`로 옮김(11 M-10~M-13) | 없음 | 기획서 버전 |
| CO-3 초기 온톨로지(B2) | `world_keeper`가 기획서에서 언급·사실을 추출하고 링커 L0~L8을 거쳐 엔티티 후보를 만듦. `mention_source_kind=series_bible`. 동명·유사는 3.10절 `duplicate_entity` 질문 | 3.8~3.10절 그대로 | 엔티티 `candidate`, 사실 `candidate` |
| CO-4 기획서 승인 | INV-BIB-03에 따라 기획서 출처 사실과 B2가 만든 사실(`user_input` 포함)이 `approved` | — | 캐논 |

**사실 출처**(11 O-C13, 확정): 브리프 필드 출처(`field_provenance.origin`)가 `user_stated`·`user_edited`·`imported`인 필드에서 온 사실은 `fact_source_kind=user_input`, `source_ref`=`{concept_brief_id, evidence_message_ids}`로 남겨 사람 기여(FR-ONT-09, D-4)를 사실 단위로 추적합니다. `imported`의 근거 메시지는 붙여 넣기 원문(`concept_messages.kind=import_text`)입니다(사용자가 쓴 원문이므로). 그 밖(`agent_proposed_accepted`, `agent_proposed_modified`, `agent_delegated`, `template_default`)은 `series_bible`입니다. 판정은 B1 출력 항목의 `source_field_path`로 그 필드의 origin을 찾아서 합니다(07 B1).

**인물 키와 개정** (11 5.4 인물 객체, M-11): B2는 브리프 인물 객체에서 만든 `character` 엔티티에 `entities.concept_character_key`(= 브리프 `character_key`)를 기록합니다. `age_band`·`age_note`는 나이 사실(`age`, `child`·`teen`이면 미성년 표지 사실)로, 빙의 인물의 `body_name`·`persona_name`은 3.13 빙의 모델의 `body`·`persona` 이름으로 옮깁니다. 이후 컨셉 개정(11 3.10)과 기획서 재작성에서 같은 `character_key`의 이름이 바뀌면 새 엔티티를 만들지 않습니다: (a) 그 엔티티에 공개 사실(`published_locked`)이 없으면 새 이름을 `true_name` 이름 행으로 추가하고 대표명을 옮깁니다(`ontology.proposeEntityName`, 기획서 승인에 포함) (b) 공개 사실이 있으면 3.11 `identity_change` 경로(`approval_type=identity_change`)로 보냅니다. 같은 `character_key`가 서로 다른 두 엔티티에 붙으면 무결성 오류입니다. 출처가 `user_input`이어도 B2가 만든 사실은 기획서 승인 때 함께 캐논이 되도록 07 B2 규칙을 따릅니다(03 INV-BIB-03 적용 범위를 "B2가 만든 사실"로 넓힘, 11 O-C13 확정).

**`avoid_list`·`world_rules`**: `avoid_list[]`는 `fact_kind=constraint`(집필 제약), `world_rules[]`는 `rule` 엔티티 + `fact_kind=rule` 사실입니다. 템플릿 항목 키(`item_key`, MVP-β/v1)가 있으면 그 키가 가리키는 스키마 확장 항목(4.7절, 예: 순서형 척도 정점)의 값으로 저장합니다.

---

## 4. OntologySchema

### 4.1 구조와 버전

| 층 | 저장 | 변경 |
|---|---|---|
| 기본 스키마 `base@<n>` | `packages/shared`의 읽기 전용 데이터(설치 단위, T-6). 릴리스로만 변경 | 릴리스 노트 + 마이그레이션 |
| 작품 확장 | `ontology_schema_versions` 행: `version_no`, `base_schema_key`, `extension` jsonb, `published_at`, `approval_id`, `proposal_ids` | 제안 승인으로 새 버전(4.5절). `novels.active_schema_version_id`가 현재. 작품 첫 버전: MVP-α는 `base@1` 그대로, MVP-β(FR-NOV-03b)·v1(FR-NOV-03c)에서 장르 템플릿을 쓰면 컨셉 승인 트랜잭션에서 템플릿 합성 결과로 발행(4.7절, `approval_id`=컨셉 승인) |

사실·`ContextSnapshot`은 검증에 쓴 `schema_version_id`를 기록합니다.

**정의 형식** (`extension`과 기본 스키마가 같은 zod 스키마)

```ts
EntityTypeDef   { key, label_ko, parent?, description, enabled, attributes_allowed: string[] }
RelationTypeDef { key, label_ko, description, synonyms: string[],
                  parent_key?: string,                 // 하위 관계(subPropertyOf). 예: 심복 → subordinate_of
                  domain: string[], range: string[] | 'fact' | 'entity_name' | 'value',
                  max_per_subject?: 1, max_per_object?: 1 | 'title.max_holders',
                  symmetric: bool, asymmetric: bool, irreflexive: bool,
                  inverse_label_ko?: string, inverse_synonyms: string[],
                  fact_kind: 'relation' | 'knowledge' | 'state' | 'event',
                  temporal: TemporalRule[], disjoint_with: string[],
                  possession_side?: 'body' | 'persona',  // 빙의 모델 정의역 치환(3.13절)
                  posthumous_allowed: bool, default_severity: 'high' | 'medium' | 'low' }
AttributeDef    { key, label_ko, domain: string[], value_type, single_valued: bool, temporal: TemporalRule[],
                  visual_attribute: bool,              // 시각 속성 키 묶음(4.3절)
                  possession_side?: 'body' | 'persona' }
TemporalRule    'no_new_after_subject_death' | 'no_new_after_object_death'
              | 'end_at_or_before_subject_death' | 'range_within_subject_life'
              | 'monotonic_non_decreasing'          // 나이 등
```

**하위 관계 폐포**: 질의·컨텍스트·CR은 술어 조건을 `parent_key` 폐포로 넓혀 평가합니다. `subordinate_of` 조회는 `parent_key=subordinate_of`인 하위 키 사실도 함께 가져옵니다. 개수·`disjoint_with`·비대칭 검사도 폐포 기준입니다. 하위 관계 사실은 자기 키로 저장하므로 의미 차이("심복"은 "부하" 중 신임하는 쪽)를 잃지 않습니다.

### 4.2 기본 엔티티 유형 (`base@1`, enum `entity_type`)

| 키 | 한국어 | 예 | 비고 |
|---|---|---|---|
| `character` | 인물 | 레온, 이서준 | 동물·영물 포함(가정) |
| `place` | 장소 | 왕도, 북부 성채 | 계층은 `located_in` |
| `organization` | 조직 | 청운파, 남궁세가 본가 | 가문 포함 |
| `item` | 사물 | 성검 | |
| `event` | 사건 | 왕위 계승전 | |
| `rule` | 규칙·설정 | 마나 순환 법칙 | |
| `ability` | 능력·시스템 | 검기, 상태창 | |
| `title` | 칭호·직위 | 국왕, 단주 | 속성 `max_holders`(기본 1) |
| `persona` | 인격 (선택) | 빙의자 영혼 | 빙의 모델에서만 |
| `body` | 몸 (선택) | 빙의 대상 몸 | 빙의 모델에서만 |

### 4.3 기본 관계·속성 어휘 (`base@1`)

정방향 키 하나만 저장합니다(INV-ONT-10). 역방향 표현("제자", "자식")은 `inverse_synonyms`로 같은 키에 매핑합니다. 대칭(Y)이 아닌 관계는 기본 `asymmetric=true`, `irreflexive=true`입니다(`subordinate_of(A,B)`와 `(B,A)`가 같은 기간에 함께 성립하거나 `(A,A)`이면 위반). 예외: `loves`, `knows_fact`·`believes`류는 `asymmetric=false`.

| 키 | 한국어 / 동의어 / 역표현 | 정의역 → 치역 | 개수 | 대칭 | 시간 제약 | 위반 심각도 |
|---|---|---|---|---|---|---|
| `father_of` | 생부 / 아버지 / 역: 아들·딸 | character → character | 목적어당 1 | N | 사후 신규 허용(`posthumous_allowed`) | high |
| `mother_of` | 생모 / 어머니 | character → character | 목적어당 1 | N | 같음 | high |
| `adoptive_parent_of` | 양부모 / 의부·의모 | character → character | — | N | `no_new_after_subject_death` | medium |
| `sibling_of` | 형제자매 / 형·누나·동생 | character ↔ character | — | Y | — | medium |
| `spouse_of` | 배우자 / 남편·아내·혼인 | character ↔ character | 주어당 1, 목적어당 1(동시) | Y | `no_new_after_subject_death`, `no_new_after_object_death` | high |
| `master_of` | 사부 / 스승 / 역: 제자 | character → character | — | N | `no_new_after_subject_death` | medium |
| `subordinate_of` | 부하 / 수하·휘하·수족 / 역: 상관 | character → character, organization | — | N | `no_new_after_subject_death` | medium |
| `member_of` | 소속 / 단원·문도 | character → organization | — | N | `range_within_subject_life` | medium |
| `leader_of` | 수장 / 우두머리 | character → organization | 목적어당 1 | N | `end_at_or_before_subject_death` | high |
| `ally_of` | 동맹 / 협력 | character, organization ↔ 같음 | — | Y | — | low |
| `enemy_of` | 적대 / 원수 | character, organization ↔ 같음 | — | Y | `disjoint_with: [ally_of]`(같은 기간) | medium |
| `loves` | 연모 / 짝사랑 | character → character | — | N | — | low |
| `holds_title` | 칭호 보유 / 즉위·취임 | character → title | 목적어당 `max_holders` | N | `end_at_or_before_subject_death` | high |
| `located_in` | 위치(장소 계층) | place → place | 주어당 1 | N | — | medium |
| `located_at` | 현재 위치 | character, item → place | 주어당 1(동시) | N | — | high (CR-02) |
| `headquartered_in` | 본거지 | organization → place | 주어당 1 | N | — | low |
| `part_of` | 하위 조직 / 분가·지부 | organization → organization | 주어당 1 | N | — | medium |
| `owns` | 소유 / 보유 | character, organization → item | 목적어당 1(동시) | N | `end_at_or_before_subject_death` | medium |
| `has_ability` | 능력 보유 / 습득 | character, persona → ability | — | N | — | medium |
| `participated_in` | 참여 / 가담 (값: 역할) | character, organization → event | — | N | `range_within_subject_life` | medium |
| `occurred_at` | 사건 장소 | event → place | 주어당 1 | N | — | medium |
| `inhabits` | 빙의 (선택) | persona → body | 주어당 1, 목적어당 1 | N | — | high |
| `counterpart_of` | 동위체 (MVP-β) | character ↔ character | — | Y | — | low |
| `knows_fact` | 앎 (`knowledge_stance`) | character, persona → fact | — | N | — | high (CR-07) |
| `knows_identity` | 정체를 앎 | character, persona → entity_name | — | N | — | high (CR-08) |
| `believes` | 믿음·의심·오해 (`knowledge_stance`, 값: 명제) | character, persona → value | — | N | — | high (CR-07) |
| `retains_memory` | 이전 시간선 기억 유지 (MVP-β) | character, persona → value | 주어당 1 | N | — | high |

| 속성 키 | 정의역 | 값 | 단일값 | 시간 제약 | 시각 속성 |
|---|---|---|---|---|---|
| `life_status` | character, body | `alive` / `dead` / `unknown` | Y | `dead` 이후 `alive`는 부활 사건 사실이 있어야 함(CR-01) | N |
| `age` | character, body | 정수 | Y | `monotonic_non_decreasing`(같은 시간선) | Y (나이 변화) |
| `gender` | character, body, persona | 문자열 | Y | — | N |
| `appearance.<부위>` | character, body | 문자열 (머리색·눈색·체격·흉터 등) | 부위별 Y | — | Y |
| `outfit` | character, body | 문자열(의상·장신구 한 벌) | N (다중값) | `story_range` 상한 필수(그 씬·구간에서만 입음. 열린 범위 금지) | Y |
| `injury` | character, body | `{part, state, since_episode_no}` (부위, 상태: `fresh`·`healing`·`scarred`, 발생 화) | N (부위별 다중값) | 회복 시 범위를 닫음(`range_close`, 6.2절). 흉터로 남으면 `appearance.<부위>` 사실로 이어 둠 | Y |
| `personality` | character, persona | 문자열 | N | — | N |
| `rule_statement` | rule | 문자열 | Y | — | N |
| `ability_cost` / `ability_limit` | ability | 문자열 | N | — | N |
| `max_holders` | title | 양의 정수 또는 `unbounded`(3.5절) | Y | — | N |
| `travel_time_days` | place (쌍 값: `{to_place_id, days}`) | jsonb | N | — | N |

**시각 속성 키 묶음**: `AttributeDef.visual_attribute=true`인 키(`appearance.*`, `outfit`, `injury`, `age`)가 FR-ONT-10a의 "외형, 의상, 상처, 나이 변화"입니다. FR-SPX-03 시각 속성 조회(07 X2 입력, v1)와 CR-03 외형 모순 검사가 이 묶음을 같은 키 집합으로 씁니다. 작품 확장 속성도 `visual_attribute=true`로 등록하면 같은 묶음에 들어갑니다.

### 4.4 제약 종류와 검증 계층

| 제약 | 쓰기 시점 (사실 저장) | DB | 검사 시점 (`schema_validator`, CR) |
|---|---|---|---|
| 스키마 밖 유형·술어 | **저장 거부**. 원 진술을 `SchemaChangeProposal(proposed)`의 예시로 보관 | — | — |
| 정의역·치역 위반 | `candidate`로 저장 + `schema_violation` 이슈 | — | CR-10 |
| 개수 1 (캐논) | — | `fact_cardinality_slots` EXCLUDE | 승격 시 사전 검사(2.5절 SL-2)에서 충돌이면 그 사실만 `candidate`로 남기고 CR-09 이슈. 화 승인 트랜잭션은 계속 진행 |
| 개수 1 (후보 간·후보 vs 캐논) | 저장 허용 | — | CR-09 |
| 시간 제약 | 저장 허용 | — | CR-11 |
| `disjoint_with` | 저장 허용 | — | CR-05 |
| 비대칭·비반사(`asymmetric`, `irreflexive`) | 저장 허용 | — | CR-10 확장(`medium`): 같은 시간선·겹치는 기간에 (A,B)와 (B,A)가 함께 있거나 (A,A) |

검증 결과는 SHACL `ValidationReport` 형태(대상 노드, 경로, 위반 제약, 심각도, 메시지)를 따라 `continuity_issues`(`kind=schema_violation`, `detector=schema_validator`)와 `continuity_issue_evidence.schema_rule_key`(예: `base@1:spouse_of:max_per_subject`)로 저장합니다. 심각도는 관계 정의의 `default_severity`이고, SHACL Violation/Warning/Info ↔ `high/medium/low`입니다(00 6.8). 위반이 남은 사실은 승격되지 않습니다(F3 가드 "스키마 제약 위반 없음").

### 4.5 작품별 확장과 스키마 변경 제안

| 테이블 `schema_change_proposals` 필드 | 설명 |
|---|---|
| `kind` | enum:schema_change_kind |
| `status` | enum:schema_change_status |
| `payload` | 제안 항목 정의(RelationTypeDef 등) |
| `examples` | 원 진술 예시(언급·원고 위치·추출 문장) 최대 5개 |
| `similar_keys` | 기존 항목 유사 판정 결과 `[{key, score, reason}]` |
| `mapped_to_key` | `mapped_to_existing`이면 필수 |
| `question_id` / `approval_id` | |
| `resulting_schema_version_id` | `approved`·`mapped_to_existing`이면 필수 |
| `proposed_by_actor_*`, `decided_by_actor_*` | |

**흐름**
1. 추출·답변 해석이 스키마 밖 술어를 내면 쓰기 API가 거부하고, 에이전트(`world_keeper`)가 제안을 만듭니다. 같은 정규화 라벨의 열린 제안이 있으면 예시만 더합니다.
2. **같은 의미 검사**(결정적 → LLM): (a) 라벨 정규형이 기존 `label_ko`·`synonyms`·`inverse_synonyms`에 있으면 바로 그 키로 매핑하고 사실은 그 키로 저장합니다(제안을 만들지 않음). (b) 없으면 LLM에 기존 관계 정의 목록을 주고 "기존 키 X와 같음 / 역방향 X / 새 개념"을 닫힌 선택으로 3회 판정합니다.
3. 판정이 "같음"(만장일치)이면 `add_synonym` 제안, 아니면 원래 `kind` 제안으로 사람에게 갑니다. LLM 판정이 "기존 키 X의 하위 개념"(예: "심복", "직속 부하" → `subordinate_of`)이면 `add_relation_type`에 `payload.parent_key=X`를 채워 냅니다.
4. 승인 게이트:

| `kind` | 승인 | 비고 |
|---|---|---|
| `add_synonym` | 화 검수 리포트에서 사용자 수락(묶음 가능) | 수락 시 `mapped_to_existing` + 새 스키마 버전. 대기 중 사실은 `candidate` 유지 |
| `add_relation_type`, `add_entity_type`, `add_attribute` | `approval_type=schema_change`. 질문은 `question_topic=schema_change`, `approve_reject`, `blocking`, `blocking_basis=approval_gate`(ADR-014, → 05 3.3) | 관계 제안의 선택지는 "기존 키로 매핑 / 기존 키의 하위 관계로 추가(`parent_key`) / 새 관계"로 고정하고 유사 키를 함께 보여 줌. 차단 대상 작업은 없습니다: 대기 중 사실은 `candidate`로 남고 화 파이프라인은 계속 진행합니다(그 사실만 승격되지 않음) |
| `change_constraint`, `deprecate_item` | `schema_change` 승인(위와 같은 질문 형식) | 영향 사실 수와 새로 생길 위반 수를 미리 계산해 보여 줌 |

5. 승인되면 새 `OntologySchemaVersion`을 발행하고(`schema.version_published`), 보류된 예시를 다시 추출·저장하는 작업을 큐에 넣습니다.
6. `deprecate_item`: 기존 사실은 유효로 두고 새 쓰기만 막습니다. 다른 키로 옮기려면 사람이 매핑을 정하고 사실마다 새 버전을 만듭니다.

**SchemaChangeProposal 상태**: SP1 (생성)→`proposed`; SP2 `proposed`→`mapped_to_existing`(동의어 수락); SP3 `proposed`→`approved`(승인, 새 버전); SP4 `proposed`→`rejected`; SP5 `proposed`→`withdrawn`(예시 소멸·에이전트 철회). 감사: `schema.change_proposed`, `schema.change_decided`.

### 4.6 같은 의미 관계·사실 중복 방지

| 층 | 규칙 |
|---|---|
| 어휘 | 동의어·역표현은 키 하나에 매핑("부하·수하·휘하" → `subordinate_of`, "제자" → `master_of` 역방향). 목록에 없는 좁은 표현("심복")은 하위 관계(`parent_key`)로 등록해 상위 키 조회에서 빠지지 않게 함 |
| 방향 | 역관계는 정방향으로 뒤집어 저장. 대칭 관계는 `subject < object`로 정렬(INV-ONT-10) |
| 사실 | 새 사실 저장 전 **같은 엔티티 쌍으로 한정**해 중복 검사합니다(Graphiti 차용). 키 `slot_key`(6.1절)가 같고 같은 시간선에서 범위가 겹치거나 맞닿으면: 값이 같으면 새 사실을 만들지 않고 기존 사실의 범위 연장 후보로 처리, 값이 다르면 "변경" 또는 "충돌"로 분류(6.6절) |
| 조회 | 병합 등으로 같은 슬롯·같은 값 사실이 둘 이상이면 컨텍스트 조회는 하나만 내보냅니다(`DISTINCT ON (slot_key, value_hash)`) |

### 4.7 장르 템플릿 확장 적용 (MVP-β/v1, → 계획서 3절)

장르 템플릿(`GenreTemplate`)의 내용·키·합성 규칙·빌드 검증은 계획서(`../plans/genre-world-templates-plan.md`) 3절이 소유합니다. 이 절은 작품 스키마에 들어오는 경로만 정합니다. 릴리스는 D-30(FR-NOV-03 분할, 확정)에 따릅니다. MVP-β는 FR-NOV-03b(검증 장르 D-29: `wuxia`·`rebirth.regression` `full`, 현판 헌터 `questions_only`), v1은 FR-NOV-03c(별도 템플릿 트랙)입니다.

| 단계 | 처리 | 기록 |
|---|---|---|
| TA-1 형식 | 템플릿의 `schema_extension.entity_types`·`relation_types`는 4.1절 `EntityTypeDef`·`RelationTypeDef` zod를 그대로 쓰고, 속성은 `schema_extension.attributes`가 아니라 **`attribute_bundles[].attributes`에만** 두며 `AttributeDef` zod를 씁니다(계획서 3.4 (c), TV-01). 속성 키는 합성 결과 안에서 유일해야 합니다(TV-02). 확장 유형의 `parent`는 `base` 또는 `shared` 유형이어야 합니다(하위 관계 폐포로 기본 질의·CR이 확장 유형을 놓치지 않게) | 계획서 3.4 (a)~(c) |
| TA-2 합성 | `base` → `shared` → L1 → 보조 L1 → L2 → L3 믹스인 → 사용자 덮어쓰기. 정의(유형·관계·척도)는 덮어쓰지 않고 값(기본값·심각도·범위)은 뒤 층이 이깁니다. 안전 프로필은 더 엄격한 쪽 | 계획서 3.3 |
| TA-3 세션 고정 | 컨셉 세션은 처음 합성한 `template_refs`(`key@version` + `compiled_hash`)를 고정해 씁니다 | `concept_sessions.template_refs`(03 3.11) |
| TA-4 발행 | 컨셉 승인(11 CS4) 트랜잭션에서 합성 결과 + 사용자 답(`template_overrides`)을 **복사**해 작품 첫 `ontology_schema_versions` 행을 만듭니다. `extension.template_refs`·`compiled_hash` 기록, `approval_id`=컨셉 승인. 별도 `schema_change` 승인을 요구하지 않습니다(컨셉 승인 화면에 활성 확장·규칙 수를 보여 주는 것으로 대신함, 가정) | `schema.version_published` |
| TA-5 용어집 시드 | 템플릿 `glossary_seed`를 `glossary_terms`로 복사(`source_kind=template`, D-32 확정, 00 `glossary_source_kind` 등록됨). 용어집 릴리스(MVP-β)와 맞춤 | `glossary.term_created` |
| TA-6 규칙 | 템플릿 `continuity_rules`는 키 `<template>.<rule>`로 9절 CR 옆에 등록되고, 결정적 사전 필터(`prefilter`) 통과분만 LLM 판정으로 갑니다. 이슈 종류는 **00 `continuity_issue_kind` 기존 값만** 씁니다(계획서 3.4 (g)·TV-05). 새 이슈 종류를 만들지 않고, 규칙 키는 근거 `continuity_issue_evidence.schema_rule_key`에 남깁니다. 매핑: 순서형 역행·건너뛰기·등급 변화(`ordinal_regression`·`ordinal_skip`·`change_requires_event`) → `ability_rule`, 관계 양끝 속성 차이·동시 소속(`attribute_delta`·`attribute_disjoint`) → `relationship`, 승계 규칙(`succession_check`)·상태 전이(`state_transition`) → `schema_violation`, 이월 없는 다른 시간선 물건·능력(`timeline_carry_check`)·각성 전 능력(`ability_before_event`) → `ability_rule`(기억이면 `character_knowledge`), 유형 수준 호칭 규칙 불일치 → `relationship`, 장부 불일치(`ledger_mismatch`, v1) → `ability_rule`, 달력 충돌(`calendar_conflict`, v1) → `schema_violation`. (닫힘: v0.2.1. 이전 미결 "새 값 등록 여부"는 등록하지 않는 쪽으로 정함) | 9절, 07 P3d |
| TA-7 떡밥 패턴 | `setup_patterns`는 온톨로지에 쓰지 않고 07 B4 `plan_setups` 입력 후보로만 둡니다(11 M-17) | — |
| TA-8 이후 변경 | 템플릿 새 버전은 자동 반영하지 않습니다. 사용자가 원하면 차이를 4.5절 `change_constraint`·`add_*` 제안 묶음으로 만들어 승인합니다(영향 사실 수·새 위반 수 미리 계산). D-36 확정: 기존 작품은 고정하고 업그레이드는 이 선택 경로로만 합니다(업그레이드 UI는 v1, 계획서 T6) | 4.5절 |

**`base@2` 의존**: 템플릿의 순서형 어휘(B-1), 예외 있는 단조 규칙(B-3), 칭호 소속(B-4), 승계(B-5), 호칭 조건(B-6), 선언형 규칙(B-10), 떡밥 패턴(B-11) 등은 `base@1`에 없는 메커니즘입니다. 채택 범위·시점은 D-32로 확정입니다: MVP-β 7개(B-1·B-3·B-4·B-5·B-6·B-10·B-11), v1 4개(B-2·B-7·B-8·B-9). 메커니즘별 정의를 이 문서 4.1~4.4에 넣는 개정은 남았습니다. 그 개정 전까지 템플릿은 `requires_base: base@2`로 선언하고 앱은 로드를 거부합니다(계획서 3.2).

---

## 5. 작품 용어집 (MVP-β, FR-ONT-19)

#### `glossary_terms`

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `surface` / `normalized_key` | text | Y | 표제어 |
| `category` | text | Y | 엔티티 유형 키 또는 `term`(엔티티가 아닌 용어: "검기", "내공") |
| `definition` | text | Y | 정의 |
| `preferred_surface` | text | Y | 집필에 쓸 표기 |
| `spelling_rules` | jsonb | Y | `{spacing: "붙임"|"띄움", loanword_variants_allowed: [], forbidden_variants: [], hanja: "천마(天魔)", hanja_policy: "첫 등장만"|"쓰지 않음"}` |
| `linked_entity_id` / `linked_schema_key` | id(ent) / text | N | 연결 대상(FR-ONT-19) |
| `status` | enum:glossary_term_status | Y | |
| `source_kind` / `source_ref_*` | | Y | 장르 템플릿 시드는 `source_kind=template`, `source_ref`=`template_key@version`(후보, 4.7 TA-5) |

**이름 사전과 나누는 기준**: 용어집은 "표기 규칙과 정의"의 원천이고, 이름 사전은 "표기 → 엔티티" 대응의 원천입니다. 엔티티에 연결된 용어는 다음처럼 동기화합니다.
- `preferred_surface` = 그 엔티티 대표명과 같아야 합니다(다르면 무결성 경고).
- `loanword_variants_allowed` → `variant` 이름 행, `forbidden_variants` → `hidden_variant` 이름 행(`forbidden_by_glossary_term_id`=그 용어). 그래서 금지 표기로 써도 링킹은 되고, 교정은 `line_editor`가 합니다. 오타·띄어쓰기·한자 병기에서 나온 `hidden_variant`는 이 표시가 없으므로 금지 표기로 세지 않습니다.

**사용처**: L2 후보 생성(변형 키), `writer`·`line_editor` 컨텍스트의 표기 규칙 블록(10절), CR-16 표기 규칙 검사(`glossary_spelling`, 기본 `low`, 화당 같은 용어 3회 이상이면 `medium`), `line_editor`의 변형 등록 제안(NM2). 감사: `glossary.term_created`, `glossary.term_updated`.

---

## 6. Fact 모델

### 6.1 필드

`facts` (사실 ID 불변, 현재 상태 포인터)

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `fact_kind` | enum:fact_kind | Y | |
| `subject_entity_id` | id(ent) | C | INV-ONT-08: `candidate` + 판별 대기일 때만 NULL(목적어 `object_entity_id`도 같음) |
| `predicate` | text | Y | 스키마 관계·속성 키(INV-ONT-06) |
| `object_entity_id` / `object_fact_id` / `object_name_id` / `value` | id / id / id / jsonb | C | 치역에 맞는 하나. `object_fact_id`·`object_name_id`는 **[06 추가]**(지식 사실용) |
| `knowledge_stance` | enum:knowledge_stance | C | `fact_kind=knowledge`면 필수 |
| `slot_key` | text | Y | **[06 추가]** 단일값 술어 `s:<subject>|<predicate>`, 다중값 `s:<subject>|<predicate>|<object 또는 value_hash>`. 링크 보류 사실(INV-ONT-08)은 NULL 역할 자리에 그 역할 언급 ID를 `?<mention_id>`로 넣습니다(예: `s:?mnt_…|located_at`). 이 키는 어떤 엔티티 키와도 같지 않으므로 6.6절 분류·`fact_cardinality_slots`에 들어가지 않습니다(링크 보류 사실은 캐논이 아니고 슬롯 행도 쓰지 않음). 판별 확정 후 `resolution_filled` 버전에서 실제 엔티티 ID로 다시 계산합니다 |
| `is_negation` | bool | Y | **[06 추가]** 자식 시간선에서 상속된 같은 슬롯 사실을 이 범위에서 부정(6.3절). 기본 false |
| `is_secret` | bool | Y | **[06 추가]** 인물 지식 검사 대상 비밀 사실(7절). 기본 false |
| `reader_reveal_point` | story_point | N | **[06 추가]** `is_secret` 사실을 독자가 아는 지점 |
| `timeline_id` | id(tln) | Y | |
| `story_range` | int4range | Y | 작중 유효 범위 |
| `from_scene_id` / `to_scene_id` | id(scn) | N | **[06 추가]** 범위의 앵커. 씬 재분할 때 `story_range` 재계산(00 5.5) |
| `canon_status` | enum:canon_status | Y | 전이 → 03 4.8 |
| `current_version_no` | int | Y | |
| `source_kind` / `source_ref_type` / `source_ref_id` / `source_scene_id` | | Y/Y/Y/N | FR-ONT-02 |
| `mention_ids` | id[] | C | `source_kind ∈ {manuscript, answer}`면 필수. 역할별 대응은 버전 `content.arg_mentions` |
| `observed_as_name_id` | id(enm) | N | **[06 추가]** 주어가 어떤 이름으로 관찰·서술됐는지. 추출 사실은 `arg_mentions.subject` 언급의 `via_name_id`, 기획서·답변 사실은 대표명. 컨텍스트 카드 배정에 씀(10.2절 C6) |
| `narrative_frame_id` | id(nfr) | N | **[06 추가]** 회상·꿈·다른 시간선 프레임에서 나온 사실. `story_range`·`timeline_id`는 프레임 대상 값(3.5절) |
| `schema_version_id` | id(osv) | Y | |

`fact_versions` (append-only, 기록 시간 축)

| 필드 | 설명 |
|---|---|
| `fact_id`, `version_no` | |
| `content` | 위 의미 필드 전체 스냅숏 + `arg_mentions: {subject: mnt_…, object: mnt_…}` + `written_for_entity_ids`(N, 병합 중 쓰기로 바꾼 원래 ID, 3.11절) |
| `canon_status` | 이 버전 기록 당시 상태 |
| `recorded_at` / `superseded_at` | 기록 시간(UTC). 현재 버전은 `superseded_at IS NULL` |
| `recorded_by_actor_type` / `recorded_by_actor_id` / `run_id` | D-4 |
| `change_reason` | `extracted`, `user_edit`, `canon_change`, `retcon`, `identity_merge`, `identity_split`, `identity_relink`, `identity_revert`, `revert`, `range_recalc`, `range_close`, `resolution_filled`, `reinterpretation`(공개 재해석 묶음, 3.12절) |
| `approval_id` / `identity_decision_id` | 근거 승인·동일성 결정 |

### 6.2 bitemporal (ADR-007)

| 축 | 필드 | 질문 |
|---|---|---|
| 작중 유효 시간 | `timeline_id` + `story_range` | "12화 씬3, T1에서 참인가" |
| 기록 시간 | `fact_versions.recorded_at` / `superseded_at` | "2026-11-03 10:00에 시스템은 무엇을 캐논으로 알았는가" (실행 재현, 감사) |

| 표현할 것 | 방법 |
|---|---|
| 과거에 참(선왕은 40화까지 왕) | `story_range` 상한을 닫음 `[0, 40003)`. 상태는 그대로 캐논 |
| 틀림(추출 오류, 설정 철회) | `canon_status=retracted` (승인 필요, F9) 또는 후보면 `rejected` |
| 인물이 틀리게 믿음 | 캐논 사실을 바꾸지 않고 `believes`(`misbelieves`) 지식 사실 |
| 서술자가 거짓말(신뢰할 수 없는 화자) | 같음: 시점 인물의 `believes` 사실로 저장. 캐논 사실은 작가 확인 후에만 |
| 새 정보와 기존 캐논이 다름 | 자동 무효화하지 않고 "충돌" 분류 → 연속성 이슈(6.6절) |

기록 시간 조회는 실행 재현(`ContextSnapshot`의 `fact_version_ids`)과 사실 이력 화면에 씁니다. 집필·검사는 현재 버전만 씁니다.

**범위 닫기 `range_close`** (상태 전이의 이전 사실 상한 닫기, 07 12절 미결 해소)

승계·이동·소속 변경처럼 단일값 슬롯의 값이 바뀌면 이전 사실의 열린 상한 `[a,∞)`를 `[a,b)`로 닫아야 새 사실이 슬롯 EXCLUDE를 통과합니다. 이전 사실이 이미 `published_locked`인 경우가 흔하므로(1화 공개된 선왕 보유), 이를 내용 변경과 구분합니다.

| 조건 | 분류 | 승인 |
|---|---|---|
| 열린 상한을 닫음 ∧ `b` > 그 사실의 근거 중 공개(`published`) 화 언급의 최대 `story_point` ∧ 값·주어·목적어 불변 | 시간 경계 추가(`change_reason=range_close`) | 없음. 원인 사실(새 보유·사망 등)과 같은 승격 단위(E9)에서 적용. 원인 사실이 승격되지 않으면 닫지 않음 |
| `b` ≤ 공개 근거의 최대 지점(이미 공개된 서술 구간을 잘라냄), 또는 닫힌 상한을 옮김 | 내용 변경 | `approved`면 F7 `canon_change`, `published_locked`면 F8 `retcon` |

- 상태는 그대로 유지합니다(`published_locked`는 `published_locked`인 새 버전). → 03 4.8 F11.
- `promoteEpisodeFacts`는 같은 트랜잭션에서 `range_close`를 슬롯 쓰기보다 먼저 실행합니다(6.4절). 닫힌 범위로 이전 사실의 슬롯 행도 갱신합니다.
- `injury` 회복, `outfit` 갈아입기, `located_at` 이동도 같은 규칙입니다.

### 6.3 시간선 해석

시간선 `T`, 지점 `p`에서 보이는 사실 = `T`의 사실 ∪ 계보를 따라 올라간 부모 시간선의 상속 사실. 가까운 시간선이 먼 시간선을 덮습니다(같은 `slot_key`).

| 자식 `kind` | 부모를 평가하는 지점 |
|---|---|
| `parallel` | `branch_story_point − 1` (분기 직전 상태가 이어짐) |
| `regression`, `loop` | `rewind_to_story_point` (세계가 돌아간 지점의 상태에서 시작) |

- 상속된 사실을 자식에서 끝내려면 자식 시간선에 같은 슬롯의 `is_negation=true` 사실을 둡니다.
- 지식 사실도 같은 상속 규칙을 따릅니다. 비회귀자가 `rewind_to_story_point` 이전에 이미 알던 지식은 자식 시간선에서도 유효합니다(Q3). 회귀자가 **그 이후**에 알게 된 기억은 상속이 아니라 `retains_memory`로만 넘어갑니다(7절).
- 이름(`entity_names.timeline_id`)과 칭호 보유(`holds_title`)도 시간선마다 그 시간선의 평가 지점으로 평가합니다(`ont_lineage`, 3.3절). 자식 시간선의 `p`를 부모 시간선 사실에 그대로 쓰지 않습니다.
- 질의는 Q1(11.5절). 단일 시간선(MVP-α)에서는 계보가 `main` 하나입니다.
- **템플릿 규칙 평가 범위**(계획서 3.3 E-1~E-4, MVP-β): E-1 모든 템플릿 사전 필터는 이 절의 계보 해석 결과(같은 `timeline_id` 사실 + 상속분, 부모는 `rewind_to_story_point`에서 평가) 위에서 평가합니다. E-2 `story_point`를 시간선을 넘어 비교하지 않습니다(부모에서 `rewind_to_story_point` 이후 생긴 상태는 자식에 상속되지 않으므로 자식에서 "다시 열림"·"등급 하락"으로 보지 않음). E-3 회귀 시간선 첫 지점에서 상속값과 다른 값이 처음 나타나면 **`regression_branch` 예외 사건**으로 보고 단조·변경 사건 규칙의 예외 사건 목록에 자동으로 넣습니다(사실로 저장하지 않는 평가용 가상 사건). E-4 이전 시간선 능력·물건 사용은 `timeline_carry_check`가 이월 사실(`retains_memory`·이월 사실)을 찾고, 있으면 `ability_before_event` 계열 규칙의 예외로 둡니다.

### 6.4 canon_status와 승격

상태 전이는 → 03 4.8(F1~F11). 이 문서가 정하는 것:

| 항목 | 규칙 |
|---|---|
| 캐논 | `canon_status ∈ {approved, published_locked}` ∧ 현재 버전 ∧ `is_negation=false` |
| 화 단위 승격 API | **`ontology.promoteEpisodeFacts(tx, scope, episode_id, to_status)`로 확정**합니다(03 9절 미결 해소, 03 5.1의 `(episode_id, to_status)`도 이 시그니처로 맞춤 → 03). E9에서 `candidate → approved`, E13에서 `approved → published_locked`, E14에서 역방향. 같은 트랜잭션에서 (1) 후보 엔티티 활성화(EN3 b) (2) `range_close`(6.2절) (3) 슬롯 사전 검사(2.5절 SL-1~SL-2) (4) 사실 승격 (5) `fact_cardinality_slots` 쓰기(SL-4)를 이 순서로 합니다. 승격 불가 사실(판별 대기, 스키마 위반, 슬롯 충돌, 프레임 대상 시점 없음)은 `candidate`로 남기고 "승격 보류" 목록으로 반환합니다. 화 승인은 실패하지 않습니다 |
| 판별 후 늦은 승격 | 출처 화가 이미 `approved`/`published`인데 나중에 판별이 확정되면, 그 답변(사용자 확인)을 근거로 화 상태에 맞춰 `approved` 또는 `published_locked`로 승격합니다 |
| 컨텍스트 표시 | 04 9.1 C-5와 같은 규칙입니다. `candidate`는 "미확정" 표시로 넣되(FR-AGT-04), 근거 언급(`mention_ids`) 중 하나라도 `ambiguous`·`new_entity_candidate`이면 넣지 않고 건수만 반환합니다(주어·목적어 어느 쪽이든). `subject_entity_id IS NULL`인 사실은 이 조건에 항상 걸립니다. 조회 옵션은 `include: 'canon' \| 'canon_and_safe_candidates'`(04 9.8)입니다 |

### 6.5 출처·버전·되돌리기

- `approved` 이상은 출처(`source_kind` + 참조)가 있어야 합니다(FR-ONT-02). `system_derived`는 유도 근거 사실 ID를 `source_ref`로 가집니다.
- 사람이 사실을 추가·수정·잠금하면 새 버전이고(FR-ONT-09), 되돌리기도 과거 내용을 복사한 새 버전입니다(F10).
- 근거 원고 버전이 아웃라인부터 재작성되면 그 버전에서만 나온 `candidate` 사실은 `rejected`(F4)로 바뀌고, 새 버전 추출에서 다시 생깁니다(→ 07).

### 6.6 추출 결과 분류 (FR-ONT-05)

추출 사실을 `slot_key` 기준으로 같은 시간선·겹치는 범위의 캐논과 비교합니다(→ 07이 단계에서 호출).

| 분류 | 조건 | 처리 |
|---|---|---|
| 신규 | 같은 슬롯 캐논 없음 | `candidate` 사실 |
| 동일 | 같은 슬롯·같은 값 | 새 사실 없음. 근거 언급만 기존 사실의 증거로 기록(범위 연장이 필요하면 후보 버전) |
| 변경 | 단일값 슬롯·다른 값, 새 값의 시작이 기존 범위 끝 이후로 해석 가능(성장, 이동, 즉위) | `candidate` 사실 + 기존 사실 `range_close` 제안(같은 승격 단위, 6.2절). 기존 사실이 `published_locked`여도 6.2절 조건이면 승인 없이 닫음 |
| 충돌 | 단일값 슬롯·다른 값·같은 지점 | 연속성 이슈(해당 CR). 사실은 `candidate`로 저장하되 승격 대상에서 뺌 |

---

## 7. 인물 지식과 독자 지식

| 표현 | 사실 |
|---|---|
| A가 비밀 사실 F를 안다 | `knows_fact(subject=A, object_fact_id=F, stance=knows)` |
| A가 F를 의심한다 | `knows_fact(..., stance=suspects)` |
| A가 F를 모른다(명시) | `knows_fact(..., stance=unaware)` — 기본값이므로 필요한 경우만 기록 |
| A가 틀리게 믿는다 | `believes(subject=A, value={predicate, subject_entity_id, object_entity_id|value}, stance=misbelieves, contradicts_fact_id=F)` |
| A가 위장명 D의 정체를 안다 | `knows_identity(subject=A, object_name_id=D)` |

**검사 대상 한정**: 모든 사실에 대해 "누가 아는가"를 기록하지 않습니다. `is_secret=true` 사실과 `restricted`·`secret` 이름만 인물 지식 검사(CR-07, CR-08) 대상입니다. 그 밖의 사실은 작중 공지 사실로 봅니다. 기획서·아크 계획에서 비밀로 표시하거나, 추출 단계가 "숨김·비밀·정체" 단서로 `is_secret` 후보를 냅니다(사람이 확인).

**지식 획득 제안**: 비밀 사실이 드러나는 씬에 `present`로 등장한 인물에 대해 추출 단계가 `knows_fact` 후보를 제안합니다. 자동으로 캐논이 되지 않고 화 승격 게이트를 따릅니다.

**시점 필터 함수** `knowledgeOf(viewer, p, T)`: 계보 상속을 포함한 캐논 지식 사실(Q3) + 회귀 기억 이월분(`retains_memory`) + `identity_known_by_entity_ids`. 독자 층은 `viewer=narrator`이고 `reader_reveal_point ≤ p`인 비밀 사실·이름만 앎으로 봅니다.

| 규칙 | 내용 |
|---|---|
| 상속 | 부모 시간선 지식을 `ont_lineage`의 평가 지점에서 평가해 가져옵니다(비회귀자가 회귀 지점 이전에 알던 것). 가까운 시간선이 같은 `slot_key`를 덮습니다 |
| 이월 | 그 위에 `retains_memory` 이월분(부모 시간선에서 `until_story_point`까지의 지식)을 더합니다 |
| 중복 제거 | (`object_fact_id`, `object_name_id`, `predicate`, `value` 해시)로 하나만 남깁니다 |
| 충돌 | 같은 대상에 상속분과 이월분의 `knowledge_stance`가 다르면 이월분을 우선합니다(회귀자는 나중 기억을 가짐) |

| 층 | 집필 컨텍스트 | 검사 |
|---|---|---|
| 캐논 | `planner`, `continuity_editor`, `foreshadow_manager`, `world_keeper` | 기준 |
| 독자 | 원고 전체(서술·대사). 서술자 이름 선택 기준 | CR-08a, CR-07a |
| 인물 | `writer`의 시점 인물 섹션, 대사 | CR-07b, CR-08b |

---

## 8. 떡밥 모델 (온톨로지 연결)

떡밥 본체·비트·기한 변경과 상태 전이는 → 03 3.7, 4.7. 떡밥 검사 단계 순서는 → 07. 이 절은 온톨로지 쪽 연결과 질의만 정합니다.

| 연결 | 표현 | 용도 |
|---|---|---|
| 떡밥 ↔ 엔티티 | `setup_links(ref_type=entity)` | 엔티티 상세의 떡밥 목록(FR-ONT-08), 컨텍스트 선택(그 엔티티가 등장하면 활성 떡밥 포함) |
| 떡밥 ↔ 설치 사실 | `setup_links(ref_type=fact, pinned_fact_version_id)` | `pinned_fact_version_id`(→ 03 3.7): `plant` 비트 확정(E9) 시 그 시점 사실 버전을 고정. 회수 대조 기준 |
| 떡밥의 숨은 진실 | 설치 사실 중 `is_secret=true` 사실 | 회수 전 누설 검사(CR-08a 확장), 인물 지식 |
| 비트 근거 | `setup_beats.scene_id`·`char_start`·`char_end` | FR-FOR-08 위치 근거 |

| 검사 | 질의·규칙 | 이슈 |
|---|---|---|
| 배정 누락 | 이번 화 `planned` 비트 중 검사 후 `detected`가 아닌 것 | `setup_missing` `high` |
| 회수 모순 | 회수 비트 씬에서 추출된 사실 vs `pinned_fact_version_id` 사실(같은 슬롯 다른 값) + LLM 대조 | `setup_contradiction` `high` |
| 미회수·기한 임박 | Q5 | 아웃라인 작업에 회수 제안(`setup.due_warning_episodes`) |
| 기한 초과 | Q5 변형(`due_episode_no < 현재 화`) | `setup_due` 질문(FR-FOR-04, → 05) |
| 강화 없이 회수 | `paid_off`인데 `reinforce` `confirmed` 비트 0 | 리포트(FR-FOR-05) |
| 회수 전 진실 누설 | 회수 화 이전 씬의 서술이 숨은 진실 사실을 드러냄 | `identity_leak` 또는 `character_knowledge`(CR-08a) |

회수 모순 대조(CR-15)는 `pinned_fact_version_id`의 엔티티 ID를 `resolveEntityId`로 푼 뒤 슬롯을 비교합니다. 병합·재연결로 주어 ID가 바뀌어도 같은 슬롯으로 봅니다.

### 8.1 떡밥 리포트 `SetupReport` (FR-FOR-05)

작품 단위 산출물입니다. 질의 구현은 `setups`를 소유한 `foreshadow` 모듈이고(11.4절), 저장하지 않고 조회 시점에 계산하며, 내보내기(FR-FOR-05 "조회하고 내보낼 수 있음")는 같은 결과를 Markdown·JSON으로 씁니다.

| 항목 | 내용 |
|---|---|
| 생성 시점 | 화 승인(E9) 직후 갱신 알림, 일일 요약(`question.daily_summary_time`)에 건수, 웹 조회 시 즉시 계산 |
| 기준 화 `:current_episode_no` | 승인된 화 중 최대 `episode_no` |
| 범위 | `canon_status ∈ {approved, published_locked}`인 떡밥 |

| 섹션 | 질의 | 행 필드 |
|---|---|---|
| R1 미회수 | `narrative_status ∈ {planted, reinforced}` (Q5에서 기한 조건을 뺀 형태) | 떡밥 번호·제목·중요도, 기한, 남은 화 수(`due − current`), 강화 비트 수, 설치 근거 씬 |
| R2 기한 초과 | R1 중 `due_episode_no < :current_episode_no`(아크 기한은 아크 마지막 화). 열린 `setup_due` 질문 ID 포함 | 초과 화 수, 질문 상태 |
| R3 강화 없이 회수 | `narrative_status=paid_off` ∧ `reinforce`·`confirmed` 비트 0 | 설치·회수 근거 씬 |
| R4 모순 후보 | 열린 `setup_contradiction` 이슈(CR-15) + 회수 대조에서 LLM이 "불확실"로 낸 항목 | 이슈 ID, 심각도, 설치 사실 버전·회수 씬 |
| R5 지표 | 8.2절 세 지표 | 값, 분자·분모 |

모든 행은 근거 씬 링크(`setup_beats.scene_id`·`char_start`·`char_end`, FR-FOR-08)를 가집니다.

```sql
-- R2 기한 초과 / R3 강화 없이 회수 (R1은 Q5에서 due 조건 제거)
SELECT s.id, s.display_no, s.title, s.narrative_status,
       COALESCE(s.due_episode_no, a_last.last_episode_no) AS due_no,
       COUNT(b.*) FILTER (WHERE b.kind = 'reinforce' AND b.status = 'confirmed') AS reinforce_count
FROM setups s
LEFT JOIN LATERAL (SELECT MAX(e.episode_no) AS last_episode_no FROM episodes e
                   WHERE e.novel_id = s.novel_id AND e.arc_id = s.due_arc_id) a_last ON s.due_kind = 'arc'
LEFT JOIN setup_beats b ON b.novel_id = s.novel_id AND b.setup_id = s.id
WHERE s.novel_id = :novel_id AND s.canon_status IN ('approved','published_locked')
GROUP BY s.id, a_last.last_episode_no
HAVING (s.narrative_status IN ('planted','reinforced')
        AND COALESCE(s.due_episode_no, a_last.last_episode_no) < :current_episode_no)        -- R2
    OR (s.narrative_status = 'paid_off'
        AND COUNT(b.*) FILTER (WHERE b.kind = 'reinforce' AND b.status = 'confirmed') = 0);   -- R3
```

### 8.2 떡밥 지표 (FR-FOR-07)

정의는 PRD 9절 KPI 표(회수율·폐기율 = "기한이 도래한 떡밥" 기준, 기한 초과 처리율 = 3화 안 처리)를 따릅니다. 09 3.2.1의 MVP-β 검증은 이 정의로 계산합니다.

| 지표 | 분자 | 분모 | 조건 |
|---|---|---|---|
| 회수율 | 분모 중 `narrative_status=paid_off` | **기한 도래 떡밥**: `canon_status ∈ {approved, published_locked}`, `narrative_status ≠ planned`(설치된 적 있음), 현재 기한 `due_no ≤ :current_episode_no` | `abandoned`는 분모에 포함합니다(PRD 정의가 "기한 도래 떡밥 중"이므로). 기한 연장된 떡밥은 **현재** 기한으로 판정 |
| 폐기율 | 분모 중 `narrative_status=abandoned` | 회수율과 같은 분모 | 회수율 + 폐기율 + (미처리 비율) = 1 |
| 기한 초과 처리율 | 분모 중 **처리된** 것 | 기한 초과 사건 수: 떡밥별로 "어느 기한 `d`에 대해 `d`화가 승인된 뒤 `d+1`화가 승인될 때까지 회수되지 않음"이 생긴 횟수. 기한마다 1건(연장 후 다시 초과하면 새 건) | 처리 = 초과 시점부터 `d + setup.overdue_handling_window_episodes`(3)화가 승인되기 전에 (a) `paid_off` 비트 확정 (b) `setup_due_changes` 행 추가(기한 변경) (c) `abandoned` 중 하나가 일어남. 아직 창이 끝나지 않은 건은 분모에서 뺌 |

| 항목 | 규칙 |
|---|---|
| 집계 시점 | 화 승인(E9) 트랜잭션 커밋 후 재계산. 대시보드(FR-FOR-07)와 리포트 R5는 같은 함수 `computeSetupMetrics(scope, as_of_episode_no)` |
| 시간 판정 | "`n`화 승인 시각" = `episodes.approved_at`(n). 사건 시각은 비트 `confirmed_at`, `setup_due_changes.created_at`, 폐기 승인 결정 시각 |
| 분모 0 | 값 없음(NULL)으로 표시 |

```sql
-- 기한 초과 처리율: 기한별 초과 사건과 처리 여부
WITH due_history AS (                         -- 떡밥별 기한 이력(최초 기한 + 변경 이력)
  SELECT s.id AS setup_id, d.to_due_episode_no AS due_no, d.created_at AS valid_from
  FROM setups s JOIN setup_due_changes d ON d.novel_id = s.novel_id AND d.setup_id = s.id
  WHERE s.novel_id = :novel_id AND d.to_due_kind = 'episode'
  -- 최초 기한 행은 생성 시점 기한(앱이 첫 setup_due_changes 행의 from_due_* 또는 setups 값으로 보충)
), overdue AS (
  SELECT h.setup_id, h.due_no,
         (SELECT approved_at FROM episodes e WHERE e.novel_id = :novel_id AND e.episode_no = h.due_no + 1) AS overdue_at,
         (SELECT approved_at FROM episodes e WHERE e.novel_id = :novel_id
                                              AND e.episode_no = h.due_no + :window) AS window_end_at
  FROM due_history h
)
SELECT COUNT(*) FILTER (WHERE handled) AS handled,
       COUNT(*) FILTER (WHERE handled OR window_end_at IS NOT NULL) AS total   -- 창이 끝났거나 이미 처리된 건만 분모
FROM (
  SELECT o.*, EXISTS (
           SELECT 1 FROM setup_beats b WHERE b.novel_id = :novel_id AND b.setup_id = o.setup_id
             AND b.kind = 'payoff' AND b.status = 'confirmed' AND b.confirmed_at < COALESCE(o.window_end_at, 'infinity'))
         OR EXISTS (
           SELECT 1 FROM setup_due_changes c WHERE c.novel_id = :novel_id AND c.setup_id = o.setup_id
             AND c.created_at >= o.overdue_at AND c.created_at < COALESCE(o.window_end_at, 'infinity'))
         OR EXISTS (
           SELECT 1 FROM setups s JOIN approvals ap ON ap.novel_id = s.novel_id AND ap.id = s.abandon_approval_id
           WHERE s.novel_id = :novel_id AND s.id = o.setup_id AND s.narrative_status = 'abandoned'
             AND ap.decided_at < COALESCE(o.window_end_at, 'infinity')) AS handled
  FROM overdue o
  WHERE o.overdue_at IS NOT NULL                                   -- 초과가 실제로 발생
) x;
-- 초과 시점(overdue_at) 이전에 이미 다른 기한으로 바뀐 기한은 초과 사건이 아닙니다.
-- 이 구간 판정(due_history.valid_from과 다음 변경 시각)은 앱이 걸러 냅니다.
```

---

## 9. 연속성 검사 규칙

검사는 두 단계입니다. (1) **결정적 사전 필터**가 캐논·언급 질의로 후보를 찾고, (2) 필요한 규칙만 `continuity_editor` LLM이 해당 문장과 근거 사실을 보고 닫힌 판정(위반 / 아님 / 불확실)을 합니다. 이슈 생성·상태는 → 03 4.6, 재작성 루프는 → 07.

| ID | 규칙 | `kind` | 기본 심각도 | 사전 필터 질의 | LLM 확인 |
|---|---|---|---|---|---|
| CR-01 | 사망 인물이 회상·환상이 아닌 씬에서 등장·발화·행동 | `death_state` | high | 씬 `present` 참여자 × `life_status=dead` 캐논(`p` 기준). 부활 사건 사실이 있으면 제외. `narrative_frames` 안(회상·꿈·다른 시간선)의 등장·행동은 프레임 대상 시점·시간선으로 평가 | 등장 형태(시체 언급·회상 대사는 위반 아님) |
| CR-02 | 같은 지점에 두 장소, 또는 이동 시간 부족 | `location_travel` | high | `located_at` 후보 vs 캐논 슬롯 충돌; 인접 씬 장소가 다르고 `travel_time_days` 정의가 있으면 작중 경과(가정: 씬 메타의 경과 표시)와 비교 | 경과 시간 해석 |
| CR-03 | 외형 모순 | `appearance` | medium (주요 인물 high, 가정) | 시각 속성 키 묶음(`visual_attribute=true`: `appearance.*`, `outfit`, `injury`, 4.3절) 슬롯 충돌(6.6 "충돌"), `injury` 부위가 회복 전인데 반대 묘사 | 변장·조명·변화 사건 여부 |
| CR-04 | 나이 모순 | `age` | medium | `age` 단조 증가 위반, 같은 지점 다른 값 | — |
| CR-05 | 관계 모순 | `relationship` | medium | `disjoint_with` 쌍 동시 성립, 관계 슬롯 충돌 | 관계 변화 사건 여부 |
| CR-06 | 능력·세계 규칙 위반 | `ability_rule` | high | 씬 언급된 `ability`·`rule` 엔티티의 `rule_statement`·`ability_limit` 사실을 근거로 모음 | 규칙 위반 판정(LLM 필수) |
| CR-07a | 원고(서술·대사)가 독자에게 아직 공개되지 않은 비밀 사실을 진술 | `character_knowledge` | high | 씬 `p < reader_reveal_point`인 `is_secret` 사실의 주어·목적어가 씬에 함께 언급됨 | 진술 여부 |
| CR-07b | 시점 인물·화자가 모르는 비밀을 알고 행동·발화, 또는 잘못 믿는 것과 반대로 앎 | `character_knowledge` | high | 화자·시점 인물의 `knowledgeOf`에 없는 `is_secret` 사실의 대상이 그 인물 대사·내면 서술에 언급됨 | 앎을 전제한 서술인지 |
| CR-08a | 독자 공개 전 정체 누설(서술·대사 모두, 독자는 둘 다 읽음) | `identity_leak` | high | Q4 `reader_leak` (위장 중 씬에서 위장명과 비위장명이 같은 엔티티로 함께 쓰임) | 동일성 암시 여부 |
| CR-08b | 정체를 모르는 인물이 위장 대상을 본명으로 부름 | `identity_leak` | high | Q4 `character_leak`(대사는 화자, 서술문은 `narration_mode`에 따른 viewer가 `identityKnownBy` 거짓, 3.3절) | — (결정적) |
| CR-09 | 개수 제약 위반 | `schema_violation` | 관계 정의 | 슬롯 충돌(후보 포함), 승격 실패 | — |
| CR-10 | 정의역·치역 위반(빙의 모델은 `possession_side` 치환 후 검사, 3.13절). 확장: 비대칭·비반사 위반(`medium`) | `schema_violation` | high (비대칭·비반사 `medium`) | 쓰기 시 표시. 비대칭·비반사는 `parent_key` 폐포로 (A,B)·(B,A) 겹침, (A,A) 조회 | — |
| CR-11 | 시간 제약 위반(사망 후 새 관계, 보유가 사망 뒤까지) | `schema_violation` | 관계 정의 | Q7 | — |
| CR-12 | 공개 사실과 충돌 | `published_canon_conflict` | high | 6.6 "충돌" 중 상대가 `published_locked` | — |
| CR-13 | 답변 제약 위반 | `answer_constraint` | high | `fact_kind=constraint` 캐논 중 이번 화 범위에 걸린 것 | 위반 판정 |
| CR-14 | 배정 떡밥 누락 | `setup_missing` | high | 8절 | 비트 검출 |
| CR-15 | 회수 모순 | `setup_contradiction` | high | 8절. `pinned_fact_version_id`의 엔티티 ID는 `resolveEntityId`로 푼 뒤 슬롯 비교 | 대조 |
| CR-16 | 표기 규칙 위반 | `glossary_spelling` | low/medium | `forbidden_by_glossary_term_id`가 있는 이름 행으로 연결된 언급(`via_name_id`). 오타·띄어쓰기·한자 병기 `hidden_variant`는 제외 | — |
| CR-17 | 다른 시간선 기억 사용(이월 없이) | `character_knowledge` | high | 인물 대사가 다른 시간선 전용 사실 대상을 언급하고 `retains_memory` 없음 (MVP-β) | 앎 전제 여부 |
| CR-18 | 사람 수정 충돌 | `human_edit_conflict` | high | 사람이 고친 범위의 사실이 재작성에서 바뀜(→ 07) | — |

**템플릿 규칙** (MVP-β/v1, 4.7 TA-6, 계획서 3.4 (g)): 작품 스키마 버전의 `extension.continuity_rules[]`(키 `<template_key>.<rule>`)도 이 절의 2단계 구조로 돕니다. `kind=documentation_only`는 실행하지 않고 `covered_by`의 CR이 대신합니다. 사전 필터 종류(00 6.13 `template_prefilter_kind`)와 릴리스:

| 사전 필터 | 검사 | 필요 `base@2` | 릴리스 |
|---|---|---|---|
| `ordinal_regression` | 순서형 값 감소(예외 사건 없을 때) | B-1, B-3 | MVP-β |
| `ordinal_skip` | 순서형 값 단계 건너뛰기(`allow_gaps=false`) | B-1 | MVP-β |
| `attribute_delta` | 관계 양끝 속성 차이(예: 항렬 +1) | B-10 | MVP-β |
| `state_transition` | 금지 상태 전이(예: 게이트 `cleared → open`) | B-10 | MVP-β |
| `timeline_carry_check` | 다른 시간선 물건·능력을 이월 사실 없이 사용 | B-10, 3.13 | MVP-β |
| `llm_rule` | 결정적 후보 없이 규칙 문장을 `continuity_editor` 확인에 넣음(CR-06과 같은 방식) | B-10 | MVP-β |
| `change_requires_event` | 단일값 속성이 변경 사건 없이 다른 값 | B-3 | v1 |
| `ability_before_event` | 지정 사건(예: 각성) 이전 지점에서 능력 사용 | B-10 | v1 |
| `attribute_disjoint` | 같은 기간 충돌하는 두 대상에 동시 소속 | B-10 | v1 |
| `succession_check` | 승계 규칙 위반 | B-5 | v1 |
| `ledger_mismatch` | 장부 불변식 위반 | B-7 | v1 |
| `calendar_conflict` | 작중 달력 충돌 | B-9 | v1 |

평가 범위는 6.3절 "템플릿 규칙 평가 범위"(E-1~E-4)를 따르고, E-3의 `regression_branch` 예외 사건은 `ordinal_regression`·`change_requires_event`·`state_transition`의 예외 사건 목록에 자동으로 들어갑니다. 이슈 종류는 4.7 TA-6 매핑, 심각도는 규칙 `severity` 뒤에 아래 조정 규칙을 적용합니다. 규칙 수 상한은 `template.max_enabled_rules`(20).

**심각도 조정 규칙**: 위 기본 심각도(관계 정의의 `default_severity` 포함) 뒤에 아래 순서로 적용합니다. 파이프라인 쪽 입력 상태에서 나오는 규칙이지만 심각도의 단일 출처를 이 절로 두기 위해 여기에 둡니다(07 5.1에서 옮김).

| 조정 | 결과 심각도 | 근거 |
|---|---|---|
| 링크 보류 사실(INV-ONT-08)이 NULL 역할 언급의 `candidates` 중 일부 후보에서만 충돌(07 4.6 LB-2). 근거에 해당 `mention`을 붙임 | `medium` | 모든 후보에서 충돌하면 조정하지 않고 기본 심각도 |
| 충돌 근거가 앞 화의 `candidate` 사실뿐(캐논 근거 없음) | `low` | 가정: 앞 화가 재작성되면 근거가 사라질 수 있음. `safety_*`·`human_edit_conflict`·`answer_constraint`에는 적용하지 않음 |

임계값·재검사 상한: `continuity.max_auto_rewrites_per_episode`(→ 00 7.3). 같은 이슈 식별은 `dedupe_key`(→ 03 3.6)이고, 근거 해시는 (규칙 ID, 근거 사실 ID 정렬 목록, 언급 엔티티)입니다. 언급 엔티티 ID는 해시 계산 전에 `resolveEntityId`로 풉니다(병합 전후 같은 이슈가 둘로 갈리지 않게).

---

## 10. 컨텍스트 조회 (GraphRAG) 경로

컨텍스트 구성 런타임(토큰 예산 배분, 캐시, 실행 연결)은 → 04. 이 절은 **노드를 고르는 경로**를 정합니다.

### 10.1 왜 문자열·임베딩 유사도로 노드를 고르지 않는가

| 이유 | 예 |
|---|---|
| 같은 표기의 다른 대상이 한 벡터 근처에 모임 | "폐하"로 검색하면 선왕·새 왕 사실이 섞임(R-18) |
| 같은 대상의 다른 표기가 멀리 떨어짐 | "가면 기사"와 "레온 왕자"는 임베딩이 가깝지 않음 → 반쪽 컨텍스트 |
| 시점·시간선·인물 지식을 유사도가 모름 | 40화 이후 사실, 다른 시간선 사실, 시점 인물이 모르는 비밀이 들어감 |
| 짧은 한국어 이름은 n-gram 유사도가 높음 | "민준/민중" 오연결(조사 파일 1.1 Cognee 0.80 cutoff) |
| 근거를 감사할 수 없음 | 왜 그 사실이 들어갔는지 ID로 추적되지 않음(NFR-OBS-02) |

임베딩은 L2 후보 생성의 보조 신호(v1, 가정)에만 씁니다. 컨텍스트 조회는 ID 조인·재귀 질의만 쓰고(04 9.1 C-8), 원문 단락을 임베딩 순위로 고르는 경로는 MVP에 두지 않습니다. v1에서 쓰려면 고른 단락 ID를 `ContextSnapshot`에 기록하고, 단락 안 모든 언급이 `confirmed`·`auto_linked`이며 C5 시점 필터를 통과한 단락만 허용합니다(04 U-20). 노드 선택은 항상 엔티티 ID를 거칩니다.

### 10.2 단계

| # | 단계 | 입력 | 출력 | 규칙 |
|---|---|---|---|---|
| C1 | 기준 정하기 | 작업(대상 화·씬), 아웃라인, 씬 계획 | `p`, `T`, `pov_entity_id`, 역할 | 씬 단위 작업은 씬 `story_point`, 화 단위는 그 화 시작(`scene_ord=0`) |
| C2 | 표기 → 엔티티 ID | 아웃라인·씬 계획·답변 제약 | 시드 엔티티 ID | **이미 저장된 `mentions`만 읽습니다. 이 단계에서 링커(LLM)를 실행하지 않습니다.** 아웃라인은 구조화 출력으로 엔티티 핸들을 직접 씁니다(주 경로, → 07). 자유 텍스트는 저장 시점에 링킹합니다: 답변은 FR-MSG-16 해석 작업, 사람 메모·기획서 수정은 저장 트랜잭션이 만든 `link_mentions` 작업. 아직 링킹되지 않은 텍스트와 `ambiguous`·`new_entity_candidate` 언급은 시드에서 빼고 "미해결 표기" 섹션으로만 넣음(04 9.1 C-3) |
| C3 | 그래프 확장 | 시드 ID | 관련 엔티티 ID | 1홉: 시드의 캐논 관계 상대(`parent_key` 폐포 포함). 2홉: 시드가 시점 인물이면 그 인물의 `master_of`·`member_of`·가족 관계 상대만. 활성 떡밥 연결 엔티티, 이번 화 배정 비트 엔티티 추가. 칭호 보유자 해석 포함(3.5절 오버레이) |
| C4 | 시점·시간선 캐논 | 엔티티 ID, `p`, `T` | 사실 버전 목록 | Q1. 슬롯별 하나, 중복 제거. 후보는 `include='canon_and_safe_candidates'`일 때 6.4절 "컨텍스트 표시" 규칙(04 C-5)으로 "미확정" 표시해 별도로 넣고, 제외한 후보는 건수만. 선행 미승인 화 오버레이(3.5절)의 상태 전이는 "미확정: n화 이후 …"로 캐논 값보다 먼저 표시 |
| C5 | 인물 시점 필터 | 사실, `pov_entity_id`, 역할 | 층별 사실 | 7절 표의 역할별 층. `writer`는 시점 인물 층 + 서술 층. 비밀 사실은 시점 인물이 모르면 뺌 |
| C6 | 이름 선택·카드 배정 | 엔티티 ID, 시점 인물, `p` | 엔티티별 카드와 표시 이름 | 표시 이름: `nameUsableBy`가 참인 이름 중 대표명 → 그 인물이 쓰는 `address_term` → `alias` 순. 위장 중이고 시점 인물이 정체를 모르면(`identityKnownBy` 거짓) 위장명 카드와 본명 카드를 분리(3.12절, 배정은 아래 표). 시점 인물은 알지만 독자가 아직 모르면(`p < reader_reveal_point`) 카드는 합치되 "독자 공개 전: 동일성을 단정하는 서술·대사 금지" 제약을 붙임. `hidden_variant`는 쓰지 않음. 동명이인은 꼬리표 |
| C7 | 직렬화·기록 | 위 결과 | 프롬프트 블록, `ContextSnapshot` | 엔티티 카드 + 제약 + 떡밥 지시 + 표기 규칙. 넣은 `fact_version_ids`, `candidate_fact_version_ids`, `entity_ids`, `entity_name_ids`, `schema_version_id` 기록(→ 03 3.3) |

**C6 카드 배정** (사실은 이름이 아니라 `entity_id`에 붙으므로 규칙이 필요함)

| 경우 | 위장 카드 | 본명 카드 |
|---|---|---|
| 일반 사실 | `observed_as_name_id`가 위장명인 사실 | 그 밖의 사실 |
| 몸에 붙는 사실(시각 속성 묶음, `life_status`) | 시점 인물이 그 이름으로 관찰한 근거가 있을 때만: 시점 인물의 지식 사실이 있거나, 사실의 근거 씬에 시점 인물이 `present`이고 `observed_as`가 위장명 | 같은 규칙으로 본명 쪽 근거가 있을 때만. 근거가 양쪽에 다 없으면 어느 카드에도 넣지 않음 |
| 비밀 사실(`is_secret`) | C5에서 이미 걸러짐 | 같음 |

**다른 실존 엔티티의 표기를 쓰는 위장**(쌍둥이 A가 B로 행세): 별도 카드를 만들지 않습니다. 속는 시점 인물의 `believes` 층으로 "시점 인물이 B라고 믿는 대상의 행동"(`observed_as_name_id`=B의 이름인 A의 사실)을 B 카드에 "(시점 인물의 인식)" 표시로 합칩니다. 같은 표기 카드 두 장이 생겨 대역 사실을 드러내지 않게 합니다.

**`buildContext` 경계**: 이 단계들은 결정적 조회만 합니다. LLM 호출·예산 예약·`ProviderCall`을 만들지 않아 NFR-PERF-04(p90 10초)와 RU-3 재현을 지킵니다(04 9.1 C-3, → 04).

### 10.3 역할별 컨텍스트 층

| 역할 | 캐논 전체 | 독자 층 | 시점 인물 층 | 비고 |
|---|---|---|---|---|
| `planner` | ○ | ○ | — | 아웃라인은 진실을 알아야 함 |
| `showrunner` | ○ | ○ | — | 가정: 질문 등급 판정(공개 사실·정체 영향)에 진실이 필요함(04 9.4) |
| `scene_director` [v1] | — | ○ | ○ | 가정: 샷·프롬프트 산출물도 독자에게 보이는 결과물이라 캐논 층을 넣지 않음(04 9.4) |
| `writer` | — | ○ | ○ | 이번 화 떡밥 비트는 "독자에게 드러낼 범위" 지시문으로만(숨은 진실 원문은 넣지 않음, 가정: 누설 감소) |
| `continuity_editor`, `world_keeper`, `foreshadow_manager` | ○ | ○ | ○ | 검사·추출은 3층을 모두 봄 |
| `line_editor` | — | ○ | ○ | + 용어집 표기 규칙 |

### 10.4 직렬화 예 (writer, 32화 씬2, 시점 인물 에린, 정체 공개 전)

```yaml
기준: 32화 씬2 / 시간선 T1 / 시점 인물: 에린
인물:
  - 이름: 가면 기사          # ent_L 의 disguise 이름, 에린은 정체를 모름 → 별도 카드
    아는 것: 북부 전선에서 에린을 구함(28화), 왼팔 부상(31화)   # observed_as=가면 기사, 31화 씬에 에린 present
  - 이름: 레온 왕자          # 같은 ent_L, 본명 카드
    부르는 말: 전하
    아는 것: 제2왕자, 북부 순찰 중                              # 왼팔 부상은 넣지 않음: 에린이 "레온 왕자"로 관찰한 근거 없음
  - 이름: 이서준(북부 기사단) # 동명이인 꼬리표
미확정: 레온 왕자의 검술 스승은 진무(31화 추출, 승인 전)
미해결 표기: 31화 "그 사내" 1건(판별 대기)
제약: 가면 기사와 레온 왕자를 같은 인물로 서술하지 않습니다(정체 공개 35화).
표기: 청운검 진무(띄어 씀), 마나(마력 X)
```

`가면 기사`와 `레온 왕자` 카드가 같은 `entity_id`라는 정보는 `ContextSnapshot`에만 남고 프롬프트에는 들어가지 않습니다.

**쌍둥이 위장 예** (20화 씬3, 시점 인물 에린. 쌍둥이 A(`ent_A`)가 B(`ent_B`)로 행세, 에린은 모름)

```yaml
인물:
  - 이름: B                  # ent_B 카드 하나만. A용 "B" 카드를 따로 만들지 않음
    아는 것: 기사단 부단장
    에린의 인식: 어제 밤 서고에서 에린에게 편지를 건넴(19화)   # 실제 주어 ent_A, observed_as=B 이름, 에린의 believes 층
제약: B의 행동 중 "에린의 인식" 표시 항목은 에린 시점에서 B가 한 일로 서술합니다. 대역 사실을 서술하지 않습니다.
```

---

## 11. 엔진 선택과 OntologyRepository

### 11.1 결정 (D-8, ADR-005)

세계관 그래프의 원천은 **같은 PostgreSQL 데이터베이스의 온톨로지 테이블**이고, 그래프 탐색은 조인·재귀 CTE로 하는 질의 계층입니다. 로컬은 `embedded-postgres`, 자체 호스팅은 외부 PG, 테스트는 PGlite입니다(ADR-004). 모든 접근은 `OntologyRepository` 포트를 거칩니다(NFR-EXT-01).

**이유**: R-18 대응은 그래프 탐색보다 불변 ID·시간 범위·개수 제약·병합 이력·트랜잭션 일관성 문제입니다. PG는 범위 타입과 `btree_gist` `EXCLUDE`로 칭호 보유 겹침 금지 같은 제약을 DB가 직접 강제하고(2.5절), 답변 반영·사실 쓰기·병합 참조 이동을 한 트랜잭션으로 묶습니다. 규모(500화, 엔티티 수천 개, 언급 10만 건 안팎)에서는 처리량이 병목이 아닙니다(가정).

**확정 범위** (2026-10-28 사용자 확인, PRD D-8): Apache AGE는 v1에 넣지 않습니다. 그래프 부하가 NFR-PERF-04를 위협할 때만(11.2절 재검토 조건) 확장 1(LadybugDB 또는 AGE 파생 읽기 모델)로 검토합니다. Neptune은 채택하지 않습니다.

**Obsidian 연동** (v1, PRD FR-ONT-20·D-8 확정, → `../research/graph-store-recommendation.md` 4절): Obsidian은 원본 저장소로 쓰지 않습니다. (a) 내보내기: DB → vault 단방향·멱등 설정집 뷰(엔티티마다 노트, 프론트매터에 불변 `entity_id`·`export_revision`). (b) 가져오기: 화이트리스트 YAML 필드(대표명, 별칭 추가, 통제 어휘 안의 관계, 메모)만 출처 "vault 편집"의 `candidate`로 넣고 승인 게이트를 거칩니다. `export_revision`이 DB보다 오래됐으면 덮어쓰지 않고 충돌로 보고합니다. 대조는 `entity_id` 기준이고 파일 이름은 무시합니다. 수동 동기화 버튼·배치로 하고, 연동은 파일 직접 읽기·쓰기입니다. 어댑터는 `OntologyRepository`와 분리한 `ObsidianVaultExporter`·`ObsidianVaultImporter`입니다. 컨텍스트 구성 경로에서 vault를 질의하지 않습니다. 실시간 파일 감시는 v1 이후입니다.

**PRD 영향**: PRD 1.3절 "단일 원천은 Graph DB", 11절 "원천은 Graph DB"를 "그래프 데이터 모델을 관계형 저장소에 표현하고 `OntologyRepository` 뒤에 둠"으로 고쳤습니다(01 6절 P-01, PRD v0.5 반영).

### 11.2 후보 비교 요약 (D-8 기준: 임베디드, 시간 사실, 라이선스, 백업, 운영 부담)

| 후보 | 임베디드 | 시간·개수 제약 강제 | 라이선스 | 백업 | 판단 | 근거 |
|---|---|---|---|---|---|---|
| **PostgreSQL + 사실 테이블** | △ 자식 프로세스(`embedded-postgres` 18.4.0-beta.17, MIT) | ○ 범위 타입 + EXCLUDE | ○ PostgreSQL License | ○ `pg_dump` | **채택** | [1차] https://www.npmjs.com/package/embedded-postgres , https://www.postgresql.org/docs/current/rangetypes.html |
| LadybugDB (Kuzu 포크) | ○ 프로세스 내, Cypher | △ 속성 + WHERE, 겹침 제약 없음 | ○ MIT | △ 닫은 상태 파일 복사, 버전 간 EXPORT/IMPORT | 파생 읽기 모델 후보(v0.22.0, 2026-10-25). 마이너마다 저장 형식 변경, READ_WRITE 프로세스 1개, 확장 런타임 다운로드 | [1차] https://github.com/LadybugDB/ladybug/releases , https://docs.ladybugdb.com/migrate/ |
| SQLite + FTS5 + `sqlite-vec` | ○ | △ 트리거 | ○ | ○ `.backup()` | 대안 B. 자체 호스팅 시 방언 이중 유지 | [1차] https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md |
| Apache AGE (PG 확장) | × 단독 서버 필요 | △ | ○ Apache-2.0 | ○ PG와 같음 | v1 미포함(11.1절). 재검토 조건 시 확장 1 후보(파생 읽기 모델) | [1차] https://github.com/apache/age/releases |
| Kuzu | ○ | △ | ○ MIT | △ | 제외: 2025-10-10 아카이브 | [1차] https://github.com/kuzudb/kuzu |
| Neo4j Community | × JVM 서버 | △ | GPLv3 | × 온라인 백업은 Enterprise | 제외 | [1차] https://neo4j.com/docs/operations-manual/current/introduction/ |
| Memgraph | × 서버 | △ | BSL 1.1: 제3자 배포·임베드 금지 | — | 제외 | [1차] https://github.com/memgraph/memgraph/blob/master/licenses/BSL.txt |
| FalkorDB | △ redis 자식 프로세스 | △ | SSPLv1 | ○ | 제외 | [1차] https://github.com/FalkorDB/FalkorDB |
| CozoDB | ○ | ○ time travel | MPL-2.0 | △ | 제외: 2023-12 이후 릴리스 없음 | [1차] https://github.com/cozodb/cozo/releases |
| SurrealDB | ○ | △ | BSL 1.1 | △ | 제외: 비표준 질의어 | [1차] https://github.com/surrealdb/surrealdb |
| Oxigraph | △ Node판 메모리 전용 | △ RDF-star | MIT/Apache-2.0 | △ | 제외 | [1차] https://github.com/oxigraph/oxigraph/tree/main/js |
| DuckDB + DuckPGQ | ○ | △ | MIT | ○ | 제외: 연구 단계 | [1차] https://github.com/cwida/duckpgq-extension |

**재검토 조건**은 ADR-005와 같습니다: (1) S-4(S-4a: MA-2 말 합성 데이터, S-4b: MB-3 실제 작품)에서 컨텍스트 구성 p90 10초 초과가 인덱스로 해결되지 않음 (2) v1 관계도에서 3홉 이상 탐색이 p90 2초(가정) 초과 (3) S-2·S-6 실패. (1)(2)면 PG를 원천으로 두고 확장 1(LadybugDB 또는 AGE 파생 읽기 모델)을 더하고, (3)이면 ADR-005를 다시 엽니다.

### 11.3 필요 확장과 스파이크

| 확장·기능 | 쓰는 곳 | 필수 | 없을 때 대체 | 스파이크 (→ 09) |
|---|---|---|---|---|
| `btree_gist` | INV-ONT-03, 05 EXCLUDE | MVP-α 필수 | 트리거 + 직렬화 격리(성능·정합성 열위) | S-1, S-2 |
| `pg_trgm` | Q10 유사 이름 후보(선택) | 선택 | 앱 메모리에서 `jamo_key` 편집거리(작품당 이름 수천 개, 가정) | S-5 ([미확인] 한글 trigram) |
| `pgvector` | v1 임베딩 보조 신호 | 선택 | 앱 메모리 벡터 검색 | S-1 ([미확인] 바이너리 동봉) |
| `pg_dump` | 백업 | 필수(→ 02) | 정지 후 데이터 디렉터리 복사 | S-7 ([미확인]) |

인덱스(초안): `entity_names (novel_id, normalized_key)`, `entity_names USING gist (novel_id, story_range)`, `facts (novel_id, subject_entity_id, predicate)`, `facts (novel_id, object_entity_id, predicate)`, `facts USING gist (novel_id, timeline_id, story_range)`, `facts (novel_id, slot_key)`, `mentions (novel_id, manuscript_version_id, scene_id)`, `mentions (novel_id, linked_entity_id)`, `facts USING gin (mention_ids)`.

### 11.4 OntologyRepository 포트

첫 인자는 항상 `NovelScope`(T-3)이고, 쓰기 메서드는 그 앞에 호출자 트랜잭션 `tx`를 받습니다(ADR-008). **모든 메서드의 질의 구현은 `ontology` 모듈의 `PgOntologyRepository`가 소유합니다.** `linking`·`continuity`·`foreshadow`는 온톨로지 테이블을 직접 질의하지 않고 이 포트(공개 API)를 같은 트랜잭션 핸들로 부릅니다(02 M-1, 08 `no-foreign-tables`·`ontology-port`). `setups`·`setup_beats`는 `foreshadow` 소유이므로 Q5는 `foreshadow` 모듈 구현이고, 온톨로지 쪽 연결(엔티티·사실)이 필요하면 이 포트를 부릅니다.

| 메서드 | 호출 모듈 | 설명 | 질의 |
|---|---|---|---|
| `resolveEntityId(scope, id)` / `resolveEntityIds(scope, ids)` | 전체 | redirect 해소. 일괄판은 `Map<원래 ID, 해소 ID>` 반환(04 C-6) | Q9 |
| `findNameCandidates(scope, key, p, T, {relaxed})` | linking | L2 후보 | Q2 |
| `getTitleHolders(scope, title_id, T, p?)` | linking, agents(컨텍스트) | 칭호 보유자 | Q6 |
| `getCanonAt(scope, entity_ids, p, T, {include: 'canon' \| 'canon_and_safe_candidates'})` | agents(컨텍스트), continuity | 시점 캐논(04 9.8의 구현). `canon_and_safe_candidates`가 04 C-5 후보 제외 옵션입니다: 근거 언급 중 `ambiguous`·`new_entity_candidate`가 있는 후보 사실은 빼고 건수만 반환(6.4절 "컨텍스트 표시") | Q1 |
| `knowledgeOf(scope, viewer, p, T)` | agents, continuity | 인물·독자 지식 | Q3 |
| `nameValidAt` / `surfaceKnownBy` / `identityKnownBy` / `nameUsableBy` | linking, continuity, agents | 3.3절 | — |
| `getEntityCards(scope, entity_ids, anchor, layer: 'canon' \| 'reader' \| 'pov')` | agents(컨텍스트) | 10.2절 C6 카드 구성(층별 표시 이름, 위장·본명 카드 분리·합침, 독자 공개 전 제약, 동명이인 꼬리표). 카드와 `entity_id` 대응은 반환값에만 두고 프롬프트에는 넣지 않음(10.4절) | Q1, Q3 조합 |
| `getConstraints(scope, {entity_ids, answer_ids, anchor})` | agents(컨텍스트), continuity | `fact_kind=constraint` 캐논 중 앵커 범위에 걸린 것(답변 제약 포함, CR-13과 같은 집합) | Q1 변형 |
| `getGlossary(scope, {entity_ids})` | agents(컨텍스트) | 용어집 카드(5절, MVP-β). 시드 엔티티에 연결된 용어를 앞에 둠 | — |
| `listEntities(scope, filter)` | 웹 화면(`ontology` 공개 API, FR-UI-05a) | 엔티티 목록: `entity_type`·`entity_status` 필터, 이름 검색(`findNameCandidates` 정확·완화 경로 재사용, `hidden_variant` 포함), 등장 화 수·미확정 언급 수(08 9.5) | Q2 변형 |
| `getEntityDetail(scope, entity_id)` | 웹 화면(`ontology` 공개 API, FR-UI-05a) | 엔티티 상세: 이름 사전(표기·정체 가시성 분리 필드 포함), 등장 화·씬, 칭호 보유 이력(Q6), 관계·사실 요약(08 9.5) | Q1, Q6 |
| `listMentions(scope, {entity_id, link_status})` | 웹 화면(`ontology` 공개 API, FR-UI-05a) | 언급 목록. `ambiguous`·`new_entity_candidate` 우선 정렬, 신뢰도·화자·원고 위치(08 9.5) | — |
| `writeCandidateFacts(tx, scope, drafts)` | agents(추출 결과 기록), hitl(답변 반영) | 스키마 검증·슬롯 키·분류. 병합 중 쓰기 재지정(3.11절) | — |
| `promoteEpisodeFacts(tx, scope, episode_id, to_status)` | manuscript(화 상태 전이) | 6.4절. 반환: 승격 수, 승격 보류 목록 | — |
| `computeIdentityImpact(scope, entity_ids)` / `computeRelinkImpact(scope, mention_ids, to_entity_id)` | linking, hitl | 영향 범위(`slot_conflicts` 포함) | Q8 |
| `applyIdentityDecision(tx, scope, decision_id)` / `revertIdentityDecision(tx, scope, decision_id)` | linking, hitl(답변 반영) | 3.11절. 슬롯 쓰기 규칙(2.5절) | — |
| `findDuplicateCandidates(scope, entity_id?)` | linking | 3.10절 | Q10 |
| `writeMentions(tx, scope, mentions)` | linking | 링커 결과 기록. L2~L8 로직은 `linking` 모듈, 저장·질의는 이 포트(L4는 `llm` 모듈 호출) | — |
| `findSchemaViolations(scope, fact_ids?)` | continuity | CR-09~11 사전 필터 | Q7 |
| `findIdentityLeaks(scope, manuscript_version_id)` | continuity | CR-08 사전 필터 | Q4 |
| `getSetupLinkedFacts(scope, setup_ids)` | foreshadow | 8절 회수 대조용 설치 사실(pinned 버전, ID 해소 포함) | — |
| `getCanonAsRecorded(scope, entity_ids, p, T, recorded_at)` | agents(재현) | 기록 시간 조회 | Q1 변형 |

### 11.5 질의 예시

변수는 `:name` 형식입니다. 모든 질의는 `novel_id` 조건을 가집니다(T-3).

**Q0. 시간선 계보 함수 `ont_lineage`** (Q1·Q2·Q3·Q6·`nameValidAt` 공용, 3.3절)

```sql
CREATE FUNCTION ont_lineage(p_novel_id text, p_timeline_id text, p_point int)
RETURNS TABLE (timeline_id text, depth int, eval_point int) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE lineage AS (
    SELECT t.id, t.parent_timeline_id, t.kind, t.branch_story_point, t.rewind_to_story_point,
           0 AS depth, p_point AS eval_point
    FROM timelines t WHERE t.novel_id = p_novel_id AND t.id = p_timeline_id
    UNION ALL
    SELECT p.id, p.parent_timeline_id, p.kind, p.branch_story_point, p.rewind_to_story_point,
           c.depth + 1,
           CASE WHEN c.kind IN ('regression','loop') THEN c.rewind_to_story_point
                ELSE c.branch_story_point - 1 END
    FROM timelines p JOIN lineage c ON p.novel_id = p_novel_id AND p.id = c.parent_timeline_id
  )
  SELECT id, depth, eval_point FROM lineage
$$;
```

**Q1. 시점·시간선 캐논** (시간선 상속 포함)

```sql
WITH lineage AS (
  SELECT * FROM ont_lineage(:novel_id, :timeline_id, :p)
), visible AS (
  SELECT DISTINCT ON (f.slot_key) f.*, l.depth
  FROM lineage l
  JOIN facts f ON f.novel_id = :novel_id AND f.timeline_id = l.timeline_id
              AND f.story_range @> l.eval_point
  WHERE f.canon_status IN ('approved','published_locked')
    AND (f.subject_entity_id = ANY(:entity_ids) OR f.object_entity_id = ANY(:entity_ids))
  ORDER BY f.slot_key, l.depth                     -- 가까운 시간선 우선
)
SELECT v.id AS fact_id, fv.id AS fact_version_id, v.predicate, fv.content
FROM visible v
JOIN fact_versions fv ON fv.novel_id = v.novel_id AND fv.fact_id = v.id
                     AND fv.version_no = v.current_version_no
WHERE NOT v.is_negation;
-- 기록 시간 조회(getCanonAsRecorded): current_version_no 대신
--   fv.recorded_at <= :t AND (fv.superseded_at IS NULL OR fv.superseded_at > :t), 상태는 fv.canon_status
```

**Q2. 표기 후보 해소** (L2 1차, 칭호 → 보유자 포함)

```sql
WITH lineage AS (SELECT * FROM ont_lineage(:novel_id, :timeline_id, :p))   -- :p는 프레임 대상 시점(3.5절)
SELECT n.id AS via_name_id, n.name_kind, n.surface_visibility, n.surface_known_by_entity_ids,
       n.used_by_condition,
       COALESCE(h.subject_entity_id, n.entity_id)         AS candidate_entity_id,
       CASE WHEN e.entity_type = 'title' THEN e.id END    AS via_entity_id,
       h.is_canon                                         AS holder_is_canon,
       n.story_range @> nl.eval_point                     AS in_range
FROM entity_names n
JOIN entities e ON e.novel_id = n.novel_id AND e.id = n.entity_id
               AND e.status IN ('active','candidate')
-- 이름 행의 시간선에 대응하는 평가 지점. timeline_id IS NULL이면 :p
JOIN LATERAL (
  SELECT COALESCE((SELECT l.eval_point FROM lineage l WHERE l.timeline_id = n.timeline_id), :p) AS eval_point
) nl ON n.timeline_id IS NULL OR n.timeline_id IN (SELECT timeline_id FROM lineage)
LEFT JOIN LATERAL (
  -- 보유 사실도 각 행의 시간선 평가 지점으로 봅니다. 가까운 시간선이 우선(DISTINCT ON slot)
  SELECT DISTINCT ON (f.slot_key) f.subject_entity_id,
         f.canon_status IN ('approved','published_locked') AS is_canon
  FROM facts f JOIN lineage l ON l.timeline_id = f.timeline_id
  WHERE f.novel_id = n.novel_id AND e.entity_type = 'title'
    AND f.predicate = 'holds_title' AND f.object_entity_id = e.id
    AND f.story_range @> l.eval_point
    AND f.canon_status IN ('candidate','approved','published_locked')
  ORDER BY f.slot_key, l.depth
) h ON TRUE
WHERE n.novel_id = :novel_id AND n.status = 'active'
  AND (n.normalized_key = :key OR (:relaxed AND n.translit_key = :translit_key))
  AND (:relaxed OR n.story_range @> nl.eval_point);
-- 칭호 엔티티 자체와 직전 보유자 후보는 앱이 추가합니다(3.5절).
-- 다중 보유(max_holders>1)면 slot_key가 보유자별이라 여러 행이 나옵니다.
```

**Q3. 인물 지식** (계보 상속 + 회귀 기억 이월, 7절)

```sql
WITH lineage AS (SELECT * FROM ont_lineage(:novel_id, :timeline_id, :p)),
inherited AS (                                     -- 계보 상속: 가까운 시간선이 같은 slot_key를 덮음
  SELECT DISTINCT ON (k.slot_key) k.id, k.predicate, k.knowledge_stance, k.object_fact_id,
         k.object_name_id, k.value, 2 AS prio
  FROM lineage l
  JOIN facts k ON k.novel_id = :novel_id AND k.timeline_id = l.timeline_id
              AND k.story_range @> l.eval_point
  WHERE k.fact_kind = 'knowledge' AND k.subject_entity_id = :viewer
    AND k.canon_status IN ('approved','published_locked') AND NOT k.is_negation
  ORDER BY k.slot_key, l.depth
),
carried AS (                                       -- retains_memory 이월분
  SELECT k.id, k.predicate, k.knowledge_stance, k.object_fact_id, k.object_name_id, k.value, 1 AS prio
  FROM lineage l
  JOIN facts r ON r.novel_id = :novel_id AND r.timeline_id = l.timeline_id
              AND r.story_range @> l.eval_point
  JOIN facts k ON k.novel_id = r.novel_id AND k.fact_kind = 'knowledge'
              AND k.subject_entity_id = r.subject_entity_id
              AND k.timeline_id = r.value->>'from_timeline_id'
              AND k.story_range @> (r.value->>'until_story_point')::int
              AND k.canon_status IN ('approved','published_locked')
  WHERE r.predicate = 'retains_memory' AND r.subject_entity_id = :viewer
    AND r.canon_status IN ('approved','published_locked')
)
SELECT DISTINCT ON (object_fact_id, object_name_id, predicate, md5(COALESCE(value::text,'')))
       id, predicate, knowledge_stance, object_fact_id, object_name_id, value
FROM (SELECT * FROM carried UNION ALL SELECT * FROM inherited) u
ORDER BY object_fact_id, object_name_id, predicate, md5(COALESCE(value::text,'')), prio;  -- 이월분 우선
```

**Q4. 정체 노출 검사** (CR-08a 서술 누설 / CR-08b 인물 누설 사전 필터)

```sql
-- viewer: 대사면 화자, 서술문이면 narration_mode가 third_omniscient일 때 NULL(독자 층만), 그 밖이면 pov
WITH mv AS (
  SELECT m.*, CASE WHEN m.speaker_entity_id IS NOT NULL THEN m.speaker_entity_id
                   WHEN COALESCE(s.narration_mode, nv.default_narration_mode) = 'third_omniscient' THEN NULL
                   ELSE s.pov_entity_id END AS viewer_id
  FROM mentions m
  JOIN scenes s  ON s.novel_id = m.novel_id AND s.id = m.scene_id
  JOIN novels nv ON nv.id = m.novel_id
  WHERE m.novel_id = :novel_id AND m.manuscript_version_id = :mnv_id
)
SELECT m.id AS mention_id, m.scene_id, m.surface, m.speaker_entity_id, m.viewer_id,
       d.id AS disguise_name_id, d.reader_reveal_point,
       (m.story_point < COALESCE(d.reader_reveal_point, 2147483647))      AS reader_leak,
       (m.viewer_id IS NOT NULL
        AND NOT ont_identity_known_by(m.novel_id, d.id, m.viewer_id,
                                      m.story_point, m.timeline_id))     AS character_leak
FROM mv m
JOIN scenes s       ON s.novel_id = m.novel_id AND s.id = m.scene_id
JOIN entity_names d ON d.novel_id = m.novel_id AND d.entity_id = m.linked_entity_id
                   AND d.name_kind = 'disguise' AND d.status = 'active'
                   AND d.story_range @> m.story_point
WHERE m.link_status IN ('auto_linked','confirmed')
  AND m.mention_kind IN ('named','title','address')
  AND m.via_name_id IS DISTINCT FROM d.id                       -- 위장명이 아닌 이름으로 불림
  AND EXISTS (SELECT 1 FROM mentions m2                          -- 같은 씬에서 위장 중
              WHERE m2.novel_id = m.novel_id AND m2.manuscript_version_id = m.manuscript_version_id
                AND m2.scene_id = m.scene_id AND m2.via_name_id = d.id)
  AND (
        m.story_point < COALESCE(d.reader_reveal_point, 2147483647)     -- 독자 층: 서술·대사 모두 독자가 읽음
     OR (m.viewer_id IS NOT NULL
         AND NOT ont_identity_known_by(m.novel_id, d.id, m.viewer_id, m.story_point, m.timeline_id))
  );
-- ont_identity_known_by: 3.3절 identityKnownBy의 SQL 함수 구현
--   (identity_known_by_entity_ids ∪ knowledgeOf의 knows_identity 캐논 사실, 계보 상속 포함)
-- 위장명 표기 사용 자체(via_name_id = d.id)는 누설이 아닙니다(surface_visibility=public).
-- m.story_point·m.timeline_id는 프레임 대상 값이라 회상 속 과거 장면은 그 시점으로 평가합니다.
-- reader_leak → CR-08a, character_leak → CR-08b. 둘 다 참이면 이슈 2건.
```

**Q5. 떡밥 미회수·기한 임박** (`setups`는 `foreshadow` 소유 테이블이라 `foreshadow` 모듈 구현. 11.4절)

```sql
SELECT s.display_no, s.title, s.importance, s.narrative_status, s.due_episode_no,
       s.due_episode_no - :current_episode_no AS episodes_left,
       COUNT(b.*) FILTER (WHERE b.kind = 'reinforce' AND b.status = 'confirmed') AS reinforce_count
FROM setups s
LEFT JOIN setup_beats b ON b.novel_id = s.novel_id AND b.setup_id = s.id
WHERE s.novel_id = :novel_id
  AND s.narrative_status IN ('planted','reinforced')
  AND s.canon_status IN ('approved','published_locked')
  AND s.due_kind = 'episode'
  AND s.due_episode_no <= :current_episode_no + :due_warning_episodes   -- setup.due_warning_episodes
GROUP BY s.id
ORDER BY episodes_left, s.importance DESC;
-- due_kind='arc'는 arcs의 마지막 화 번호로 바꿔 같은 비교를 합니다.
```

**Q6. 칭호 보유자 이력과 시점 보유자**

```sql
-- 계보의 모든 시간선 보유 사실. holds_at_p는 각 사실 시간선의 평가 지점으로 판정(W4: T2의 "폐하")
SELECT f.subject_entity_id AS holder_id, pn.surface AS holder_name, e.disambiguator,
       f.timeline_id, l.depth,
       lower(f.story_range) AS from_point, upper(f.story_range) AS to_point, f.canon_status,
       f.story_range @> l.eval_point AS holds_at_p
FROM ont_lineage(:novel_id, :timeline_id, :p) l
JOIN facts f         ON f.novel_id = :novel_id AND f.timeline_id = l.timeline_id
JOIN entities e      ON e.novel_id = f.novel_id AND e.id = f.subject_entity_id
JOIN entity_names pn ON pn.novel_id = e.novel_id AND pn.id = e.preferred_name_id
WHERE f.predicate = 'holds_title' AND f.object_entity_id = :title_entity_id
  AND f.canon_status IN ('approved','published_locked') AND NOT f.is_negation
ORDER BY l.depth, lower(f.story_range);
-- 시점 보유자 = holds_at_p가 참인 행 중 depth가 가장 작은 시간선의 행(가까운 시간선 우선, 6.3절)
```

**Q7. 스키마 제약 위반** (사망 후 새 관계 + 후보 포함 개수 충돌)

```sql
-- (a) CR-11: 사망 지점 이후 시작하는 관계
SELECT f.id AS fact_id, f.predicate, d.id AS death_fact_id, lower(d.story_range) AS death_point
FROM facts d
JOIN facts f ON f.novel_id = d.novel_id AND f.timeline_id = d.timeline_id
            AND f.fact_kind = 'relation'
            AND (f.subject_entity_id = d.subject_entity_id OR f.object_entity_id = d.subject_entity_id)
            AND lower(f.story_range) > lower(d.story_range)
            AND f.canon_status IN ('candidate','approved','published_locked')
WHERE d.novel_id = :novel_id AND d.predicate = 'life_status' AND d.value->>'state' = 'dead'
  AND d.canon_status IN ('approved','published_locked')
  AND NOT (f.predicate = ANY(:posthumous_allowed_keys));      -- 스키마에서 계산

-- (b) CR-09: 단일값 슬롯에서 값이 다른 사실의 기간 겹침(후보 포함)
SELECT a.slot_key, a.id AS fact_a, b.id AS fact_b, a.canon_status, b.canon_status
FROM facts a
JOIN facts b ON b.novel_id = a.novel_id AND b.slot_key = a.slot_key AND b.id > a.id
            AND b.timeline_id = a.timeline_id AND b.story_range && a.story_range
WHERE a.novel_id = :novel_id AND a.slot_key = ANY(:single_valued_slot_keys)
  AND a.canon_status NOT IN ('rejected','retracted') AND b.canon_status NOT IN ('rejected','retracted')
  AND (a.object_entity_id, a.value) IS DISTINCT FROM (b.object_entity_id, b.value);

-- (c) CR-10 확장: 비대칭·비반사 위반. :asym_keys는 asymmetric=true 키의 parent_key 폐포
SELECT a.id AS fact_a, b.id AS fact_b, a.predicate
FROM facts a
LEFT JOIN facts b ON b.novel_id = a.novel_id AND b.timeline_id = a.timeline_id
                 AND b.predicate = ANY(:asym_keys)
                 AND b.subject_entity_id = a.object_entity_id AND b.object_entity_id = a.subject_entity_id
                 AND b.story_range && a.story_range AND b.canon_status NOT IN ('rejected','retracted')
WHERE a.novel_id = :novel_id AND a.predicate = ANY(:asym_keys)
  AND a.canon_status NOT IN ('rejected','retracted')
  AND (b.id IS NOT NULL OR a.subject_entity_id = a.object_entity_id);
```

**Q8. 병합 영향 범위**

```sql
WITH refs AS (
  SELECT 'fact' AS ref, f.id, f.canon_status AS state FROM facts f
   WHERE f.novel_id = :novel_id AND :eid IN (f.subject_entity_id, f.object_entity_id)
  UNION ALL
  SELECT 'mention', m.id, m.link_status FROM mentions m
   WHERE m.novel_id = :novel_id AND :eid IN (m.linked_entity_id, m.speaker_entity_id, m.pov_entity_id, m.via_entity_id)
  UNION ALL
  SELECT 'entity_name', n.id, n.status FROM entity_names n
   WHERE n.novel_id = :novel_id AND n.entity_id = :eid
  UNION ALL
  SELECT 'setup_link', sl.setup_id, st.canon_status FROM setup_links sl
   JOIN setups st ON st.novel_id = sl.novel_id AND st.id = sl.setup_id
   WHERE sl.novel_id = :novel_id AND sl.ref_type = 'entity' AND sl.ref_id = :eid
  UNION ALL
  SELECT 'question_link', ql.question_id, q.status FROM question_links ql
   JOIN questions q ON q.novel_id = ql.novel_id AND q.id = ql.question_id
   WHERE ql.novel_id = :novel_id AND ql.ref_type = 'entity' AND ql.ref_id = :eid
  UNION ALL
  SELECT 'scene_participant', sp.scene_id, ep.status FROM scene_participants sp
   JOIN scenes sc ON sc.novel_id = sp.novel_id AND sc.id = sp.scene_id
   JOIN episodes ep ON ep.novel_id = sc.novel_id AND ep.id = sc.episode_id
   WHERE sp.novel_id = :novel_id AND sp.entity_id = :eid
)
SELECT ref, COUNT(*) AS total,
       COUNT(*) FILTER (WHERE state IN ('published_locked','published')) AS published
FROM refs GROUP BY ref;
-- published > 0 이면 approval_type = identity_change 필요(3.11절 2단계).
-- 언급의 공개 여부는 manuscript_version → episode.status로 별도 집계합니다.
-- impact.slot_conflicts: 두 엔티티의 개수 1 슬롯 사실을 병합 후 slot_key로 다시 계산해
--   같은 슬롯·같은 시간선·겹치는 범위·다른 값인 캐논 쌍을 Q7(b)와 같은 방식으로 찾습니다(3.11절 6단계).
-- 병합 질의는 S·L 두 ID로 실행해 합칩니다. computeRelinkImpact는 :eid 대신 언급 집합으로 한정합니다.
```

**Q9. 옛 ID → 현재 ID (redirect)**

```sql
WITH RECURSIVE r AS (
  SELECT id, merged_into_id, 0 AS hop FROM entities WHERE novel_id = :novel_id AND id = :eid
  UNION ALL
  SELECT e.id, e.merged_into_id, r.hop + 1
  FROM entities e JOIN r ON e.novel_id = :novel_id AND e.id = r.merged_into_id
  WHERE r.hop < 10                                      -- INV-ONT-09로 순환은 없지만 안전 상한
)
SELECT id AS current_id, hop FROM r WHERE merged_into_id IS NULL;
```

**Q10. 중복 엔티티 후보** (이름 신호만, 속성·관계 점수는 앱이 더함)

```sql
SELECT c.id AS candidate_id, x.id AS existing_id, n1.surface, n2.surface AS existing_surface,
       (n1.normalized_key = n2.normalized_key) AS exact_key
FROM entities c
JOIN entity_names n1 ON n1.novel_id = c.novel_id AND n1.entity_id = c.id AND n1.status = 'active'
JOIN entity_names n2 ON n2.novel_id = c.novel_id AND n2.entity_id <> c.id AND n2.status = 'active'
                    AND (n2.normalized_key = n1.normalized_key
                         OR (char_length(n1.normalized_key) > :short_name_max_syllables
                             AND similarity(n2.jamo_key, n1.jamo_key) >= 0.6))   -- pg_trgm, S-5
JOIN entities x ON x.novel_id = c.novel_id AND x.id = n2.entity_id AND x.status IN ('active','candidate')
WHERE c.novel_id = :novel_id AND c.status = 'candidate'
  AND NOT EXISTS (SELECT 1 FROM entity_distinct_pairs p
                  WHERE p.novel_id = c.novel_id
                    AND p.entity_a_id = LEAST(c.id, x.id) AND p.entity_b_id = GREATEST(c.id, x.id));
```

---

## 12. 골든 테스트셋과 평가 (NFR-QUAL-01)

### 12.1 구성

| 묶음 | 내용 | 규모 (가정) | 위치 |
|---|---|---|---|
| 링킹 시드 G01~G23 | 유형별 짧은 합성 씬 묶음 + 초기 온톨로지 + 정답 언급 표 | 유형당 씬 5~10개, 언급 약 600건 | `packages/test-kit/golden/linking/` |
| 장편 시드 원고 | 30화 분량 합성 원고에 모순·떡밥 누락·지식 위반·정체 누설 시드 50건 이상(NFR-QUAL-01) | 30화 | `packages/test-kit/golden/serial/` |
| 이름 사전 불완전 변형 | 같은 원고에 별칭 일부를 지운 초기 온톨로지(G22) | — | 같은 위치 |
| 텍스트 안전 시드 TS01~TS04 | 07 5.6 SF-1~SF-3 판정용 합성 씬 + 정답 이슈 표(`safety_*` 종류, 위반 여부) | 유형당 씬 10개 이상(가정), 위반·비위반 반반 | `packages/test-kit/golden/safety/` |

**텍스트 안전 시드** (NFR-SAFE-01·02, 07 5.6. MVP-α)

| # | 유형 | 기대 동작 | 주 지표 |
|---|---|---|---|
| TS01 | 연령 등급 수위 초과(같은 장면을 `age_rating`별 경계 위·아래로 쓴 쌍) | 경계 위만 `safety_age_rating` `high` | 재현율, 오탐률 |
| TS02 | 미성년 인물 성적 묘사(시점 `age` < 19, `age` 미상 + 학생 등 미성년 표지, 링크 보류 언급의 후보 중 일부만 미성년) | `safety_minor_sexual` `high`. 등급과 무관 | 재현율(목표 1.0, 가정) |
| TS03 | 실존 인물 사칭·명예훼손(`is_real_person=true` 엔티티 또는 이름 목록 일치 표기로 지어낸 발언·행동을 사실처럼 서술) | `safety_real_person` `high` | 재현율 |
| TS04 | 실존 인물 단순 언급·역사 서술, 실존 인물과 동명인 가상 인물 | 이슈 없음(TS03과 구분) | 오탐률 |

정답 형식(언급 단위): `{scene_ref, char_start, char_end, surface, mention_kind, gold_entity_id | NIL | NON_ENTITY, expected_class: auto_ok | must_ask | must_new}`. `must_ask`는 사람도 문맥만으로 정하기 어려워 질문이 정답인 경우입니다.

### 12.2 링킹 시드 유형

| # | 유형 | 기대 동작 | 주 지표 | 릴리스 |
|---|---|---|---|---|
| G01 | 칭호 승계: 선왕 사망 전후 "폐하" | 시점별 다른 보유자, `via_entity_id`=칭호 | 연결 정밀도 | MVP-α |
| G02 | 동명이인 2명 같은 화 등장 | 분리 유지, 경합이면 질문 | 잘못된 병합 0 | MVP-α |
| G03 | 동명 가문(본가·분가) | 분리 | 같음 | MVP-α |
| G04 | 별칭·애칭("레온", "레오", "왕자") | 한 엔티티 | 재현율 | MVP-α |
| G05 | 띄어쓰기 변형 | 한 엔티티, `hidden_variant` 제안 | 재현율 | MVP-α |
| G06 | 외래어 표기 변형("레온/레옹") | 한 엔티티 또는 교정 제안 | 재현율 | MVP-β(용어집) |
| G07 | 호칭 화자 의존("형님": A→B, C→D) | 화자별 다른 대상 | 정밀도 | MVP-α |
| G08 | 영형 주어 연속 문장 | 시점 인물 후보, 자동 확정 없음 | 후보 포함률, 리포트 수락률 | MVP-α |
| G09 | 가면·위장명, 공개 전·후 | 같은 엔티티, 공개 전 누설은 CR-08 | 누설 재현율 | MVP-α |
| G10 | 별개 생성 후 정체 판명 | 병합 제안 질문 | 제안 재현율 | MVP-α |
| G11 | 쌍둥이 교대 | 항상 판별 | 자동 확정 0 | MVP-α |
| G12 | 회귀 후 개명, 자식 시간선의 칭호·이름 평가 | 같은 ID, 새 이름 시작 지점. T2 `p=51003`의 "폐하" → T1을 `rewind_to_story_point`에서 평가한 보유자(W4) | 정밀도 | MVP-β |
| G13 | 빙의(몸·인격 분리) | 외형·사회 관계 → 몸, 기억·연모 → 인격. 빙의 전 성격·회상 속 원래 영애 → 원래 영혼 `persona`. 1인칭 "나" → 주인공 `persona`. 약혼·소속 사실이 CR-10을 내지 않음 | 귀속 정확도 | MVP-β |
| G14 | 회상 속 사망 인물, 일반 씬 안 회상 문단의 칭호 | 사망 감점 없음. 회상 문단 "폐하" → 프레임 대상 시점 보유자. 다른 회차 회상 사실은 그 시간선에 저장 | 재현율 | MVP-α |
| G15 | 신규 인물 첫 등장 | `new_entity_candidate` | NIL 재현율 | MVP-α |
| G16 | 비엔티티 구("하늘의 왕" 비유) | `NON_ENTITY` | NIL 정밀도 | MVP-α |
| G17 | 관계 동의어("부하/수하/휘하"), 목록 밖 하위 표현("심복", "직속 부하"), 방향 반전 | 같은 관계 키 또는 `parent_key` 하위 관계 제안. `subordinate_of(A,B)`·`(B,A)` 동시 성립은 CR-10 | 스키마 매핑 정확도 | MVP-α |
| G18 | 스키마 위반(생부 2명, 사망 후 혼인) | CR-09·CR-11 이슈 | 이슈 재현율 | MVP-α |
| G19 | 거짓말·오해 서술 | 캐논이 아니라 `believes` | 분류 정확도 | MVP-α |
| G20 | 짧은 이름 유사("민준/민중") | 퍼지 단독 병합 없음 | 잘못된 병합 0 | MVP-α |
| G21 | Telegram 자유 답변 속 표기 | 같은 파이프라인 | 연결 정밀도 | MVP-α |
| G22 | 이름 사전 불완전 | 미등록 별칭에서도 질문·신규 판단 | 재현율 하락 폭 | MVP-α |
| G23 | 교차 문자·번역 별칭("Iron Heart"/"아이언하트"/"철심", 처음 쓰인 이명 "검귀") | L2 2·3차 후보 또는 EN3(b) 동치 판정으로 기존 엔티티 질문. 조용한 신규 `active` 0 | 잘못된 분리 0 | MVP-α |

### 12.3 지표와 계산

| 지표 | 정의 | 목표 | 출처 |
|---|---|---|---|
| 엔티티 연결 정밀도 | `auto_linked` 중 정답 ÷ `auto_linked` 전체 | ≥ 0.95 (내부 목표 `linking.auto_precision_target` 0.98) | NFR-QUAL-01, 00 7.5 |
| 엔티티 연결 재현율 | 정답 엔티티가 `auto_linked` 결과이거나 `ambiguous` 후보 목록 상위 `candidate_top_k`에 있는 비율 (정답을 잃지 않은 비율) | ≥ 0.90 | NFR-QUAL-01 |
| 자동 확정 비율 | `auto_linked` ÷ 정답이 엔티티인 언급 | 측정 후 설정(질문 비용 지표) | — |
| `ambiguous` 자동 캐논 | `ambiguous` 언급에서 나온 사실이 사람 확인 없이 캐논이 된 건수 | 0 (구조 테스트: 승격 함수 단위 테스트 + 전체 시나리오 감사 로그 검사) | NFR-QUAL-01 |
| 잘못된 병합 | 제안 없이 두 정답 엔티티가 한 ID로 합쳐진 건수 | 0 | R-18 |
| 잘못된 분리 | 정답 엔티티 1개가 사람 확인 없이 `active` ID 2개 이상으로 갈라진 건수 | 0 | R-18 |
| 화당 판별 질문 수 | `entity_disambiguation`·`duplicate_entity` 질문 수 ÷ 화 수(차단형 따로) | 측정 후 설정 | R-5, 3.10절 |
| 미해결 링크 비율 | 미해결 `ambiguous` 언급 ÷ 엔티티 언급 전체(`linking.pending_backlog` 추이 포함) | 측정 후 설정 | 3.10절 |
| 후보 잘림 비율 | `candidate_truncated` 언급 ÷ 언급 전체 | 측정(S-3) | 3.8절 |
| 높음 심각도 모순 재현율·정밀도 | 장편 시드 기준 | ≥ 0.90 / ≥ 0.70 | NFR-QUAL-01 |
| 인물 지식 위반 재현율 | CR-07·08 시드 | ≥ 0.80 | NFR-QUAL-01 |
| 떡밥 배정 누락 재현율 | CR-14 시드 | ≥ 0.90 | NFR-QUAL-01 |
| 텍스트 안전 재현율·오탐률 | TS01~TS04 시드 기준. 위반 시드 중 해당 `safety_*` 이슈가 난 비율 / 비위반 시드 중 이슈가 난 비율 | 측정 후 설정(TS02는 재현율 1.0, 가정) | NFR-SAFE-01, 02 |

**실행 모드**
- CI(결정적): L4·추출 응답을 녹화한 가짜 LLM 어댑터로 결정적 단계(L2·L3·L6~L8, 승격, 병합·되돌리기, 제약)를 매 커밋 검사합니다(→ 08 품질 게이트).
- 보정(실 LLM): 릴리스 전과 역할 모델 변경 시 실행합니다. 비용은 작품 예산과 분리된 개발 예산으로 기록합니다(가정).

**보정 절차** (00 7.5 순서)
1. 시드를 dev/test로 나눕니다(유형별 층화, 7:3, 가정).
2. dev에서 `mention_kind`별로 `raw` → 정답 여부의 단조 보정(isotonic, 가정)을 맞춥니다.
3. 자동 확정 구간 정밀도 ≥ 0.98이 되는 최소 `tau_auto.<kind>`를 고르고, 그다음 `tau_ask`·`margin_delta`로 질문 수를 줄입니다.
4. test에서 최종 지표를 보고하고 `linker_version`의 `cal<n>`을 올립니다. 값은 00 7.5 레지스트리를 고쳐 반영합니다.

---

## 13. 시나리오 워크스루

### W1. 동명이인 "서준"

배경: 북부 기사 이서준(`ent_S1`, 꼬리표 "북부 기사단")과 상인 한서준(`ent_S2`, "은월 상단")이 기획서에 있습니다. 두 사람 모두 이름 행 "서준"(`alias`)을 가집니다. 14화 씬2에 둘이 함께 등장합니다.

| 단계 | 처리 | 결과 |
|---|---|---|
| L0 | 대사 "서준, 물건은?"(화자 에린), 서술 "서준은 고개를 저었다" 등 언급 6건 | `named` 6건, 체인 2개 |
| L1 | 첫 대사 화자 에린, 둘째 대사 화자 미상 | `named` 언급이라 상한은 걸리지 않음(상한은 `address`만). 화자 미상은 L4 입력에 표시 |
| L2 | `서준` 키 → `ent_S1`, `ent_S2` (다중 히트 → 판별 필수, P-1) | 후보 2 |
| L3 | 둘 다 씬 `present`; "물건"과 S2의 `member_of 은월 상단` 관계 특징 | `rule_score` S2 0.8, S1 0.5 |
| L4 | 3회 샘플: 체인1 → S2·S2·S2, 체인2 → S1·S2·S1 | 체인1 만장일치, 체인2 불일치 |
| L6·L7 | 체인1 `c₁=0.6·1+0.4·0.8=0.92`, `c₂=0.6·0+0.4·0.5=0.20`, margin 0.72 → `auto_linked`(S2). 체인2 샘플 불일치 → `ambiguous` | |
| L8 | 같은 화자·같은 표기 충돌 없음 | 유지 |
| 질문 | `entity_disambiguation` 1건(체인2 언급 3건 묶음), 선택지 "이서준(북부 기사단) / 한서준(은월 상단) / 새 인물 / 엔티티 아님 / 보류" | 비차단형 |
| 마감 경과 | 기본 "보류" → 체인2에서 나온 사실 2건은 `candidate` 유지, 화 승인 후에도 캐논 아님 | NFR-QUAL-01 "자동 캐논 0" 충족 |
| 답변 "이서준" | MN5 `confirmed`, 사실 2건에 주어 채움(새 버전 `resolution_filled`), 화가 `approved`면 바로 `approved`로 승격 | `mention.link_decided`, `fact.status_changed` |

### W2. 칭호 승계 "폐하"

배경: 국왕 칭호 `ent_K`(이름 "폐하", "주상"), 선왕 `ent_O`, 왕자 레온 `ent_L`. 캐논: `holds_title(O, K, [0, 40003))`, `life_status(O)=dead [40003,)`.

| 시점 | 원고 | 처리 | 결과 |
|---|---|---|---|
| 12화 씬1 | "폐하께서 북부 출병을 명하셨다" | Q2: "폐하" → 칭호 K → `p=12001` 보유자 O | `auto_linked` O, `via_entity_id=K` |
| 40화 씬3 | 선왕 승하 서술 | 추출: `life_status(O)=dead`, 보유 사실 `range_close` 제안 `[0,∞)` → `[0,40003)`. 보유 사실은 1화 공개로 `published_locked`지만 `40003`이 공개 근거 최대 지점보다 뒤라 승인 없이 닫힘(6.2절) | 화 승인 시 캐논(`published_locked` 새 버전, `change_reason=range_close`) |
| 40화 씬5 | 레온 즉위 | 추출 후보 `holds_title(L, K, [40005,))`. 승격 시 `range_close`가 먼저 실행되어 슬롯 `o:K|holds_title` 기존 범위가 `[0,40003)`이 되고, 사전 검사(SL-2)에서 겹침 없음 → 성공(S-2) | 캐논 |
| 41화 씬2 | "폐하, 북부 소식입니다" | 보유자 L | `auto_linked` L |
| 41화 씬2 (40화 승인 전에 집필) | 같은 대사 | 캐논 보유자 O, 오버레이(40화 `candidate` 전이) 보유자 L → 불일치라 자동 확정 금지, 리포트 보류. 컨텍스트에 "미확정: 40화 이후 보유자 L" 먼저 표시(3.5절) | `ambiguous`(리포트) |
| 43화 씬2 회상 문단 | "그날 폐하께서 웃으셨다"(`narrative_frames`: `flashback`, 대상 `30002`) | 언급 `story_point=30002` → 보유자 O. 사망 감점 없음. 사실 범위도 `30002` | O, CR-01 없음 |
| 45화 씬1 | "선왕 폐하께서는 늘 말씀하셨지" | L2가 현재 보유자 L + 직전 보유자 O(`prev_holder`) + 칭호 K를 후보로. L4가 수식어 "선왕"으로 O 선택 | O |
| 오류 시드 | 42화 추출이 `holds_title(O, K, [42000,))` 후보를 냄 | CR-11(O 사망 후 보유) + 승격 시 EXCLUDE 충돌(L 보유와 겹침) | `schema_violation` high, 승격 거부 |

MS GraphRAG처럼 `title` 문자열로 노드를 만들었다면 "폐하" 노드 하나에 O와 L의 사실이 섞여 41화 컨텍스트에 "폐하는 승하했다"가 들어갔을 것입니다(조사 파일 1.1).

### W3. 가면 기사 정체 반전

배경(경로 A): 기획서에 "가면 기사 = 레온 왕자", 독자 공개 35화 씬4. 엔티티 `ent_L` 하나에 이름 "레온"(`true_name`, 표기·정체 `public`, 대표명), "가면 기사"(`disguise`, `surface_visibility=public`, `identity_visibility=restricted`, `identity_known_by=[ent_L, ent_집사]`, `reader_reveal_point=35004`). 에린은 30화 씬7에서 정체를 알게 됩니다.

| 시점 | 사건 | 처리 |
|---|---|---|
| 28화 씬2 (시점 에린) | "가면 기사가 에린을 구했다", 에린 대사 "가면 기사님!" | 언급 → L, `via_name_id`=가면 기사. 에린이 위장명을 쓰는 것은 `nameUsableBy` 참이라 L3 감점 없음. 사실 `observed_as_name_id`=가면 기사. 컨텍스트: 에린 시점 카드 둘(10.4절) |
| 29화 씬3 초고 (시점 에린) | "에린은 가면 기사의 검술이 레온 왕자와 같다는 것을 깨달았다… 역시 왕자였다" | Q4: 위장 중 씬에서 비위장명 "레온 왕자" + 에린은 `identityKnownBy` 거짓 → CR-08b. 서술이 동일성 단정 → CR-08a(`p=29003 < 35004`). `identity_leak` high 2건 → 재작성(E4) |
| 30화 씬7 | 에린이 가면 아래 얼굴을 봄 | 추출: `knows_identity(에린, 가면 기사, [30007,))` 후보 → 화 승인 시 캐논 |
| 31화 씬1 (시점 에린) | 에린 대사 "레온 전하, 오늘도 가면을 쓰시겠습니까?" | 에린은 알게 됨 → CR-08b 없음. 그러나 독자는 아직 모름(`31001 < 35004`) → Q4 `reader_leak` 참, LLM 확인 "동일성 단정" → CR-08a high. 재작성에서 에린의 앎은 "독자가 정체를 단정할 수 없는 표현"으로 바뀜. 작가가 공개를 앞당기려면 `reader_reveal_point` 변경(기획 변경 → `canon_change` 승인) |
| 35화 씬4 | 독자 공개 | 이후 서술 제약 해제 |

경로 B(별개 엔티티 `ent_M` "가면 기사"로 시작): 33화 아웃라인에서 정체가 정해지면 `world_keeper`가 `IdentityDecision(merge, S=L, L=M)`을 제안합니다. Q8 결과 `published_locked` 사실 12건 → `identity_change` 승인 질문(차단형, 해당 아크 아웃라인만 정지). 승인 후 병합 트랜잭션: M의 이름 "가면 기사"는 L로 옮겨 `disguise`·`reader_reveal_point=35004`로 바꾸고 `origin_entity_id=M`, 사실 12건은 주어만 바꾼 새 버전, M은 `merged`. 이후 옛 ID `ent_M` 조회는 L로 안내됩니다. 사용자가 반전을 취소하면 ID4 되돌리기로 이동 행을 역순 적용합니다.

### W4. 회귀와 기억 이월 (MVP-β)

배경: 주인공 `ent_H`가 T1 50화 씬9에서 죽고 T1 3화 시점으로 회귀합니다. T1 캐논에 W2의 칭호 보유(`holds_title(O, K, [0,40003))`, `holds_title(L, K, [40005,))`)가 있습니다. 새 시간선 T2: `kind=regression`, `parent=T1`, `branch_story_point=51001`, `rewind_to_story_point=3000`. 사실 `retains_memory(H, {from_timeline_id: T1, until_story_point: 50009}, T2, [51001,))`.

| 질의 | 결과 |
|---|---|
| T2, `p=51003`의 캐논(Q1) | T2 사실 + T1을 `p=3000`에서 평가한 사실. T1 50화의 "H 사망"은 `p=3000`에 유효하지 않으므로 들어오지 않음 |
| H의 지식(Q3) | T2 지식 + T1을 `3000`에서 평가한 지식(상속) + T1에서 `50009`까지의 지식(이월, 상속분과 겹치면 이월분 우선). 다른 인물은 상속분만 |
| 비회귀자 한서윤의 지식(Q3) | T1 2화에 알게 된 집안 비밀(`[2004,)`)은 `3000`에서 유효하므로 T2에서도 앎. T1 20화에 알게 된 것은 모름 → CR-07b 오탐 없음 |
| T2 `p=51003`에서 "폐하"(Q2·Q6) | T1 보유 사실을 `3000`에서 평가 → 선왕 O(`[0,40003)`). T1의 `51003` 보유자 L이 아님 |
| T1 20화에 얻은 H의 별칭(`timeline_id=T1`, `[20001,)`) | T2 `51003`에서 `nameValidAt` 거짓(T1은 `3000`으로 평가) |
| T2 52화 대사에서 조연 R이 T1 40화의 배신 사건을 언급 | CR-17: R에게 `retains_memory` 없음 → `character_knowledge` high |
| T2에서 H가 개명("한") | `entity_names` 행 추가(`timeline_id=T2`, `[51004,)`), 대표명 유지(G12) |

---

## 14. 감사 이벤트 매핑

이벤트 이름은 → 03 6.3을 그대로 씁니다.

| 동작 | `action` |
|---|---|
| 엔티티 생성·상태·대표명 변경 | `entity.created`, `entity.status_changed`, `entity.preferred_name_changed` |
| 이름 추가·수정·폐기 | `entity_name.added`, `entity_name.updated`, `entity_name.retired` |
| 링킹 작업 1회 / 판별 확정 / 재연결 | `mention.batch_linked`, `mention.link_decided`, `mention.relinked` |
| 병합·분리·다름 | `identity.proposed`, `identity.applied`, `identity.rejected`, `identity.reverted` |
| 스키마 | `schema.change_proposed`, `schema.change_decided`, `schema.version_published` |
| 용어집 | `glossary.term_created`, `glossary.term_updated` |
| 사실 | `fact.created`, `fact.status_changed`, `fact.version_created`, `fact.retconned`, `fact.reverted` |
| 시간선 | `timeline.created`, `timeline.updated` |

`fact.status_changed`는 화 승격처럼 다건이면 한 이벤트에 `fact_ids` 배열과 건수를 담습니다(감사 로그 폭증 방지, 가정).

---

## 15. 미결 사항

| # | 항목 | 현재 처리 | 정하는 시점·경로 |
|---|---|---|---|
| O-1 | 링킹 임계값·신뢰도 결합 가중치(0.6/0.4)·유사 엔티티 점수 가중치 | 가정 초기값 | MVP-α 골든셋 보정(12.3절) |
| O-2 | `linking.tau_auto.zero` 자동 확정 허용 여부와 영형 주어 리포트 일괄 수락 UX | 자동 확정 금지 + 명시적 일괄 수락 | G08 결과, 05 웹 인박스 설계 |
| O-3 | `embedded-postgres`의 `btree_gist`·`pg_trgm`·`pgvector`·`pg_dump` 포함 여부, `pg_trgm` 한글 trigram | [미확인]. 대체 경로 정의(11.3절) | 스파이크 S-1, S-5, S-7 (→ 09) |
| O-4 | 이름 후보 조회 p90 50ms, 컨텍스트 구성 p90 10초 | 가정 | 스파이크 S-3, S-4a(MA-2 말), S-4b(MB-3) |
| O-5 | 작중 경과 시간(달력) 모델. CR-02 이동 시간, CR-04 나이 검사가 의존 | MVP-α는 같은 지점 충돌과 단조 증가만 검사 | MVP-α 첫 10화 이슈 분석 후 MVP-β에서 결정 |
| O-6 | ~~회상 씬의 대상 시점 기록 방식~~ **닫음** | `narrative_frames` 테이블(2.4절)로 구간 단위 기록. 07 씬 분할·추출이 채움 | 반영: 07 4.3 `frames[]`·`frame_key`·`identity_assertions`, 6.1 `SceneSegmentationResult`·`scenes.narration_mode` |
| O-7 | 빙의 모델(`persona`/`body`)의 릴리스와 켜는 시점(기획서 확정 후 변경 가능 여부) | MVP-β 가정 | 09 로드맵 |
| O-8 | `writer`에게 떡밥 숨은 진실을 주지 않는 방침의 품질 영향 | 가정: 누설 감소 우선 | MVP-α 첫 5화 블라인드 평가(G-0)와 누설 이슈 수 비교 |
| O-9 | `is_secret` 후보 자동 제안의 정확도와 사람 확인 부담 | 추출 단서 + 사람 확인 | MVP-α 실측 |
| O-10 | 기본 스키마 `base@1` 관계 목록의 충분성(무협·판타지·현대 장르별) | 4.3절 목록. 장르별 부족분은 장르 템플릿(4.7절)으로 해소하는 계획 | 계획서 SC-4(작품 30화당 템플릿 밖 스키마 제안 ≤ 3건), D-32 |
| O-11 | 동시 등장 감점(같은 씬 대화 → 같은 대상 아님)과 정체 은닉 의심의 우선순위 | 은닉 의심 표시가 있으면 감점 안 함 | G09·G10 결과 |
| O-12 | 대규모 병합(참조 수천 건) 트랜잭션 시간 | 진행 중 실행과의 경합은 02 4.2 규칙으로 정함: 병합은 기다리지 않고, 실행 결과 쓰기를 `resolveEntityId`로 재지정(원래 ID는 `mentions.redirected_from_entity_id`, `content.written_for_entity_ids`), 분리 대상 참조 실행은 `superseded`(3.11절). 남은 것은 트랜잭션 시간 | 스파이크 S-6 |
| O-13 | 00·03에 반영할 이 문서의 추가 필드·테이블(**[06 추가]** 표시분: `narrative_frames`, `entity_names`의 표기·정체 가시성 분리, `translit_key`, `forbidden_by_glossary_term_id`, `facts.observed_as_name_id`, enum `narrative_frame_kind`·`narration_mode`, `identity_decision_kind`의 `relink`, F11 `range_close`)와 `continuity_issue_evidence.ref_type`에 `identity_decision` 추가 여부 | 필드·테이블·F11은 반영 완료(03 4.8 F11, 5.2; 00 6.2 `narration_mode`, 6.10 `narrative_frame_kind`·`relink`). 남은 것: `continuity_issue_evidence.ref_type`에 `identity_decision` 추가 여부 | 03 다음 개정 |
| O-14 | PRD 1.3절·11절 "Graph DB가 원천" 문구 | 해소: PRD v0.5 반영(01 6절 P-01, D-8 확정) | — |
| O-15 | Graphiti 퍼지 정규화 동작 버전별 차이 | 개념만 차용하므로 설계 영향 작음 | 차용 전 재확인 |
| O-16 | 화 승격 다건 감사 이벤트 묶음 형식 | 배열 1건(가정) | → 03 6.2 개정 시 |
| O-17 | 그래프 투영 수위(watermark) 추적 방식(02 4.5 P-3, 02 10절) | MVP에 투영 없음. 후보: (a) 온톨로지 변경 기록 테이블(`ontology_changes`, 커밋 순 `bigserial`, 트랜잭션 ID 포함) (b) 전체 재투영만 | ADR-005 재검토 조건 충족 시 |
| O-18 | 새 기본값 키: `linking.max_blocking_identity_questions_per_episode`(1), `linking.backlog_alert`(50), `linking.report_hold_digest_days`(3), `linking.no_name_match_top_n`(4), `linking.hidden_variant_rule_score_cap`(0.7), EN3(b) 동치 판정 비교 수 `dedup.equivalence_check_top_k`(8). 모두 가정 | 00 7.5 등록 완료 | 골든셋 보정 |
| O-20 | 템플릿 확장의 첫 스키마 발행을 컨셉 승인 하나로 받을지(4.7 TA-4) | 별도 `schema_change` 승인 없음(가정) | D-30 확정(MVP-β FR-NOV-03b부터 해당). 11·05 개정 |
| O-21 | ~~컨셉 사용자 필드 유래 사실의 출처·캐논 처리(3.14, 11 O-C13)~~ **닫음** | `user_input` + 기획서 승인 시 캐논(11 O-C13 확정) | 반영: 03 INV-BIB-03, 07 B2 |
| O-19 | `entities.is_real_person`의 실존 인물 이름 목록 출처·범위(국내외 공인, 역사 인물 포함 여부)·갱신 주기와 03 5.2 반영 | 방침 확정(PRD NFR-SAFE-02, 2026-10-28): 앱 설치 데이터, 릴리스로만 갱신. 목록 일치로 켠 값은 끌 수 없고 사용자 수동 켜기는 가능. 컨셉 단계 실존 인물 대조(11 6.5)와 유사성 고유명 금지 목록(11 O-C5, 계획서 TV-12)도 같은 방식(운영자·사용자가 채우는 설치 데이터, 비면 LLM 신호만). 역사 인물은 D-33 A 방침(기준 연도·목록 출처는 D-12 법률 검토와 함께). 남은 것: 초기 목록의 구체 데이터 출처 선정 | MVP-α 구현 전 조사(07 12절 `is_real_person` 행). 03 5.2 필드 반영 완료 |
