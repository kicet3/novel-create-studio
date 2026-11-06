# 카테고리별 세계관 필수 정보 항목 조사 (장르 데이터 템플릿 근거)

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-10-28 |
| 대상 요구 | FR-NOV-03(장르 템플릿, P1 v1, 01 매트릭스 "누락"), NFR-EXT-03(템플릿은 데이터), FR-ONT-18·19(스키마 확장·용어집), NFR-SAFE-02(실존 인물), 새 요구 A(`concept_partner`)·B(카테고리별 세계관 데이터 템플릿) |
| 기준 문서 | 06-story-ontology 4절(OntologySchema `base@1`), 3.2·3.5·3.7·3.13절(이름 유형·칭호·호칭·회귀/빙의), 5절(용어집), 8절(떡밥), 9절(CR-01~CR-18). 이름·enum은 00 6.10 |
| 등급 표기 | [1차] 논문 원문·공식 문서, [2차] 위키·해설·기사, [미확인] 원문 미확인. 확인일은 모두 2026-10-28 |
| 범위 | 이 문서는 조사 결과와 **권고**만 담습니다. 스키마·enum 변경은 00·06을 먼저 고친 뒤 확정합니다. 개별 작품 설정은 옮기지 않고 장르 관습 수준으로만 적습니다 |

## 0. 결론 요약

| # | 결론 | 근거 절 |
|---|---|---|
| 1 | 카테고리는 한 축이 아닙니다. **장르(배경 세계)** 1개 + **트로프 오버레이**(회귀·빙의·환생, 시스템·상태창, 아카데미 등) 0~n개를 조합해야 합니다. 회빙환은 연구에서도 모티프가 아니라 장르를 가로지르는 "스토리 유형·마스터 플롯"으로 봅니다. | 1절, 5절 |
| 2 | 카테고리마다 어휘는 다르지만 **구조 패턴은 7개로 수렴**합니다: 서열형 능력 단계(경지·등급·서클·레벨), 신분·직위 서열(작위·항렬·직급), 조직 계층과 소속, 수치 자원·누적 장부(내공·마나·스탯·기록), 칭호와 승계, 화자 의존 호칭, 다층 지식(원작 지식·회귀 기억·비밀). | 2절 |
| 3 | 이 7개 패턴 중 `base@1`에 **없는 메커니즘**이 있습니다: 순서형 어휘(`OrdinalScaleDef`), 수치 단위·범위, 칭호의 소속 대상(`title_of`), 승계 규칙, 예외 사건이 있는 단조 규칙, 누적 수치 장부, 작위·관계 기반 호칭 조건, 원작 시간선. 이것은 **기본 스키마 메커니즘**으로 올리고, 어휘(경지 이름·등급 문자·작위 이름)는 **카테고리 확장 데이터**로 두기를 권고합니다. | 3절 |
| 4 | 템플릿 1개는 6개 묶음(스키마 확장, 서열·수치 어휘, 용어집 시드, 호칭 규칙, 연속성 규칙, 떡밥 패턴) + 컨셉 대화 질문 목록으로 구성하면 06 구조에 그대로 들어갑니다. 템플릿의 값은 모두 "기본값"이고, 작품 컨셉 확정 때 사용자가 고친 값이 첫 작품 스키마 버전이 됩니다. | 6절 |
| 5 | 기존 도구(World Anvil, Campfire, Scrivener, Notion/Obsidian)는 **서술형 프롬프트·필드** 위주이고, 서열 단조성·승계·개수·수치 합 같은 **검증 가능한 제약은 제공하지 않습니다**. 우리 템플릿의 차별점은 "질문 + 검증 규칙"을 같이 담는 데 있습니다. | 7절 |
| 6 | 대체역사·스포츠·연예계는 실존 인물·실존 단체가 핵심 재료라 NFR-SAFE-02·07 SF-3("단순 언급·역사 서술은 위반 아님")과 정면으로 만납니다. 역사 인물이 허구 행동을 하는 것이 장르의 본질이므로, **템플릿 구축 전에 정책 결정(06 O-19 범위)이 필요**합니다. | 4.6절, 4.11절, 9절 |
| 7 | 시장 장르 분류(플랫폼 메뉴)와 장르별 매출 비중은 이번에 1차로 확인하지 못했습니다. 카테고리 목록은 장르 관습과 연구 문헌 기준의 **가정**이며, 출시 전 플랫폼 분류 재확인이 필요합니다. | 1절, 9절 |

## 1. 시장 카테고리 축

### 1.1 확인한 시장 사실

| 사실 | 등급·출처 |
|---|---|
| 2024년 웹소설 시장 규모 추정 1조3,500억 원(2022년 1조390억 원). 조사 대상 CP 152개사·플랫폼 10개사·창작자 800명·이용자 811명. 이용자 79.0% 유료 결제 경험 | [2차] 이코노미스트 https://economist.co.kr/article/view/ecn202504160028 (원 보고서 미확인) |
| 정부 첫 웹소설 실태조사(2022 발표, 2021 기준), 2년 주기 계획 | [2차] https://newsseoul.co.kr/news/view/1065580809716098 |
| 선호 장르가 인구 집단별로 갈림(여성·가정주부 → 로맨스, 학생·직장인 → 판타지, 대졸자 → 무협) | [2차, 검색 요약] 한국출판학연구 실증 연구 https://scholar.kyobobook.co.kr/article/detail/4010035815388 |
| 회빙환은 한국 웹소설에서 "장르의 하나로 여겨질 정도의 마스터 플롯"이며 현실 로맨스에도 적용됨 | [1차] 김경애, 「회빙환과 시간 되감기 서사의 문화적 의미」, 한국산학기술학회논문지 25(1), 2024, https://doi.org/10.5762/KAIS.2024.25.1.734 |
| 시스템 모티프는 회빙환과 함께 쓰이며, 상태창이 세계를 분석하는 메타데이터로 기능하고 퀘스트가 목표·보상·패널티를 명시해 서사 동력이 됨 | [1차] 서재인, 「한국 웹소설에 나타난 시스템 모티프 분석」, 대중서사연구 31(2), 2025, https://doi.org/10.18856/jpn.2025.31.2.012 |
| 로판 책빙의물은 회귀·차원이동·대체역사물과 친연성이 있고, 주인공이 현실세계의 미래지식(원작 지식)으로 파멸이 예언된 세계에서 생존 투쟁함 | [1차] 안상원, 「한국 웹소설의 '책빙의물'의 특성 연구」, 대중서사연구 26(3), 2020, https://doi.org/10.18856/jpn.2020.26.3.003 |
| 일부 플랫폼은 "전쟁/대체역사"를 하나의 장르로 묶고 현대판타지·밀리터리는 태그로 붙임 | [2차, 검색 요약] 미스터블루 작품 페이지 https://m.mrblue.com/novel/detail/E000120932 |
| 네이버 시리즈·카카오페이지·문피아의 공식 장르 메뉴 | [미확인] 이 문서 작성 시 페이지 접근 실패(시리즈 차단, 카카오페이지·문피아는 동적 렌더링). 주석(2026-10-28 추가): 시장 조사 문서(research-webnovel-market.md 5.1)에서 서버 측 HTTP 요청으로 네이버 시리즈 TOP100을 수집해 `data/naver-series-top100-2026-10-28/`에 보존했고, 장르 메뉴(`genreCode` 201~209)도 같은 문서 3절에서 [1차]로 확인했습니다. 문피아 검색 필터 장르도 같은 문서 3절에서 공개 JS 번들로 [1차] 확인했습니다. 카카오페이지는 여전히 [2차]입니다. |

### 1.2 카테고리 축 제안

가정: 주요 플랫폼 장르 메뉴는 대체로 로맨스·로판·판타지·현판·무협·BL·드라마/일반 계열이고, 대체역사·게임·스포츠·SF는 태그 또는 하위 분류입니다(1.1의 미확인 항목을 확인하기 전까지의 가정).

| 축 | `template_kind` | 값(템플릿 키 후보) | 조합 규칙 |
|---|---|---|---|
| 장르(배경 세계) | `genre` | `murim`(무협), `high_fantasy`(정통 판타지), `modern_fantasy_hunter`(현판·헌터), `romance_fantasy`(로판), `contemporary_romance`(현대 로맨스), `alt_history`(대체역사), `sci_fi`(SF), `sports`, `entertainment`(연예계) | 작품당 1개(필수). "퓨전"은 장르 2개 조합이 아니라 1개 + 사용자 확장으로 시작(가정) |
| 트로프 오버레이 | `trope_overlay` | `regression`(회귀), `possession`(빙의, 책빙의 포함), `reincarnation`(환생) | 0~n개. 회귀+빙의 동시 가능 |
| 모티프 오버레이 | `motif_overlay` | `system`(상태창·시스템), `game_world`(게임판타지: 가상현실 게임 접속형 / 게임 세계 빙의형), `academy`(아카데미) | 0~n개. `game_world`는 `system`을 포함 |

`academy`를 장르가 아닌 오버레이로 두는 이유: 무협(무관·서원), 로판(아카데미), 현판(헌터 아카데미)에 모두 얹히고, 세계 규칙보다 "학제·학기·시험 순위" 구조만 더하기 때문입니다.

## 2. 카테고리를 가로지르는 구조 패턴

| 패턴 | 무협 | 판타지 | 헌터 | 로판 | 현대 로맨스 | 시스템 | 스포츠·연예 | 06 대응(`base@1`) | 부족한 것 |
|---|---|---|---|---|---|---|---|---|---|
| P1 서열형 능력 단계 | 경지 | 서클·기사 등급 | 헌터 등급·게이트 등급 | 신성력·마력 등급 | — | 레벨·스킬 랭크 | 선수 등급·리그 티어 | `ability` 엔티티 + 문자열 속성 | 순서형 어휘, 단조 규칙의 예외 사건 |
| P2 신분·직위 서열 | 항렬(배분) | 작위·기사 서열 | 협회 직급 | 작위 | 직급 | 칭호 | 팀 주장·센터 | `title` + `holds_title` | 칭호의 소속 대상(`title_of`), 칭호 서열, 승계 규칙 |
| P3 조직 계층·소속 | 문파·세가·분타 | 왕국·교단·기사단 | 협회·길드 | 가문·황실·교단 | 회사·재벌가 | 파티·클랜 | 구단·소속사 | `organization`, `part_of`, `member_of`, `leader_of` | 조직 하위 유형(문파·가문·길드), 조직 간 관계(동맹은 있음, 종속·적대 진영 축은 없음) |
| P4 수치 자원·누적 장부 | 내공(갑자) | 마나량 | 마력 수치 | — | — | 스탯·포인트·골드 | 기록·통계 | `age`(정수)만 | 단위·범위, 누적 합 검증 |
| P5 칭호와 승계 | 장문인·가주 | 왕위 | 길드장 | 작위 승계 | 회장직 | — | 주장 | `holds_title`, `max_holders`, CR-11 | 승계 규칙(장자·지명·결투 등) |
| P6 화자 의존 호칭 | 사형·사숙·사조 | 경칭 | 등급 존칭 | 전하·각하·영애 | 직급 호칭 | — | 선후배 | `address_term` + `used_by_condition`(relation, older) | 칭호 서열 조건, 관계 경로 조건(같은 사부 = 사형제) |
| P7 다층 지식 | 비전·정체 은닉 | 예언 | 회귀 미래 지식 | 원작 지식 | 비밀 과거 | 시스템만 아는 정보 | 내부 정보 | `knows_fact`, `believes`, `is_secret`, `retains_memory`, `reader_reveal_point` | 원작 줄거리(아직 일어나지 않은 "예정 사실")의 저장 위치 |

## 3. 기본 스키마와 카테고리 확장의 경계 (제안)

### 3.1 경계 기준

| 기준 | 기본 스키마(`base@n`, 릴리스로 변경) | 카테고리 확장(템플릿 데이터) |
|---|---|---|
| 의미 | 2개 이상 카테고리에서 **같은 의미**로 쓰는 개념·메커니즘 | 한 카테고리 고유 어휘·값 |
| 검증 | DB 제약·`schema_validator`·결정적 CR이 해석해야 하는 정의 형식 | 그 형식에 넣는 값(경지 이름 목록, 등급 문자, 작위 순서) |
| 예 | `OrdinalScaleDef` 형식, `title_of` 관계, `TemporalRule` 종류 | `murim:realm` 척도 값 "삼류 < 이류 < … ", `romance_fantasy:peerage` |
| 변경 | 00·06 수정 + 마이그레이션 | 템플릿 버전업. 작품에는 컨셉 확정 시 복사(이후 작품 확장 제안 흐름, 06 4.5) |

원칙: **템플릿은 06 4.1의 `extension` jsonb와 같은 zod 형식만 씁니다.** 템플릿만을 위한 별도 스키마 언어를 만들지 않습니다. 확장 유형은 `EntityTypeDef.parent`, 확장 관계는 `RelationTypeDef.parent_key`로 기본 키 아래에 두어, 기본 질의(10절 컨텍스트, CR)가 확장 유형을 놓치지 않게 합니다(예: `sect`의 parent는 `organization`). 의미가 다른 관계는 하위 관계로 두지 않습니다(예: 의형제 `sworn_sibling_of`는 혈연 `sibling_of`의 하위가 아니라 별도 키).

### 3.2 기본 스키마로 올릴 메커니즘 후보 (`base@2` 제안)

| ID | 제안 | 형식(초안) | 쓰는 카테고리 | 영향 문서 |
|---|---|---|---|---|
| B-1 | 순서형 어휘 | `OrdinalScaleDef { key, label_ko, levels: [{key, label_ko, rank: int, aliases[]}], allow_gaps: bool, open_top: bool }`. `AttributeDef.value_type = 'ordinal:<scale_key>'` | 무협 경지, 판타지 서클, 헌터 등급, 게이트 등급, 작위, 직급, 학년, 리그 티어 | 06 4.1, 00 6.10 |
| B-2 | 수치 속성의 단위·범위 | `AttributeDef.numeric = { unit, min?, max?, integer: bool }` | 내공(년·갑자), 마나, 스탯, 기록, 키·몸무게 | 06 4.1 |
| B-3 | 예외가 있는 단조 규칙 | `TemporalRule` 추가: `{ kind: 'monotonic_non_decreasing', exception_event_predicates: string[] }`(문자열 형식은 지금처럼 예외 없음). 예외 사건 사실이 그 구간에 있으면 하강 허용. 함께 `{ kind: 'change_requires_event', event_predicates: string[] }`(상승·하강 모두 사건 필요, 헌터 등급 재측정) | 경지(예외: 폐공·산공), 헌터 등급(예외: 재측정·강등), 레벨(예외: 레벨 다운 패널티), 작위(예외: 작위 박탈) | 06 4.1, 9절(CR-04 일반화 또는 새 CR) |
| B-4 | 칭호의 소속 대상 | 관계 `title_of(title → organization, place)` 주어당 1. "청운파 장문인", "OO 공작(영지)" | 무협·로판·헌터·현대 로맨스 | 06 4.3, 3.5 |
| B-5 | 칭호 서열·승계 규칙 | `title` 속성 `title_rank: ordinal:<scale>`, `succession_rule: enum`(`appointment` 지명, `primogeniture` 장자, `agnatic_primogeniture` 남계 장자, `election` 선출, `combat` 비무·결투, `inheritance_custom` 작품 규칙 문장) + `succession_note` | 로판 작위, 무협 장문인·가주, 왕위 | 06 4.3, 9절 |
| B-6 | 호칭 조건 확장 | `used_by_condition` 추가 형식: `{ "target_title_rank_at_least": "<scale>:<level>" }`, `{ "relation_path": ["master_of^-1","master_of"], "older": true }`(같은 사부의 제자 = 사형제), `{ "speaker_rank_below_target": "<scale>" }` | 무협 사문 호칭, 로판 경칭, 직급 호칭, 헌터 존칭 | 06 3.7 |
| B-7 | 누적 수치 장부 | `QuantityLedgerDef { key, subject_types, components: [{key, source_predicate}], invariant: 'sum' | 'non_negative' | 'max' }`. 예: 스탯 총합 = 기본 + 레벨업 지급 + 보상 − 소모 | 시스템·겜판, 스포츠 기록, 내공 증감(영약) | 06 4.1, 9절(새 CR) |
| B-8 | 원작 시간선 | `timeline_kind`에 `source_work` 추가. 원작 줄거리 사실을 이 시간선에 두고, 현재 세계(`main`)와의 차이를 Q 질의로 비교. 빙의자의 원작 지식 = `source_work` 사실에 대한 `knows_fact` | 책빙의(로판·아카데미·겜판) | 00 6.10, 06 3.13·6.3 |
| B-9 | 작중 달력 | `rule` 엔티티 속성 `calendar = {era_name, months, days_per_month, seasons[]}` + 씬 메타 `in_world_date`(선택). 사교 시즌·학기·시즌 일정·게이트 마감 계산에 씀 | 로판(사교 시즌), 아카데미(학기), 스포츠(시즌), 헌터(게이트 폐쇄 기한) | 03 씬 메타, 06 9절 CR-02 |
| B-10 | 선언형 연속성 규칙 | `ContinuityRuleDef { key, applies_to, prefilter: 'ordinal_regression' | 'ledger_mismatch' | 'succession_check' | 'calendar_conflict' | 'llm_rule', statement_ko, severity }`. 템플릿 규칙이 기존 CR(CR-06·CR-11)이나 새 결정적 검사로 컴파일됨 | 전 카테고리 | 06 9절 |
| B-11 | 떡밥 패턴 | `SetupPatternDef { key, label_ko, plant_hint, reinforce_hint, payoff_hint, typical_due: 'arc' | 'episodes:<n>', links_entity_types[] }` → planner가 03 3.7 `setups` 초안으로 씀 | 전 카테고리 | 03 3.7, 04 planner |

카테고리 확장으로만 두는 것: 경지·등급·작위·직급 어휘, 하위 엔티티 유형(`sect`, `noble_house`, `gate`, `guild`, `skill`, `quest`, `species` 등), 장르 고유 관계(`sworn_sibling_of`, `betrothed_to`, `contracted_to` 등), 용어집 시드, 컨셉 질문.

### 3.3 새 연속성 규칙 ID 후보

00·06의 CR 번호는 확정 전이라 키 이름만 제안합니다.

| 키 후보 | 규칙 | 사전 필터 | 기본 심각도 |
|---|---|---|---|
| `ordinal_regression` | 순서형 속성이 예외 사건 없이 하강 | B-1·B-3 | high |
| `ordinal_skip` | `allow_gaps=false` 척도에서 단계를 건너뜀(예: 이류→절정 직행이 작품 규칙상 불가) | B-1 | medium |
| `ledger_mismatch` | 원고에 나온 수치 스냅숏(상태창 등)이 장부 합과 다름 | B-7 | high (시스템 작품) / medium |
| `succession_violation` | 새 `holds_title`이 `succession_rule`에 맞지 않음(정당 승계자 생존 중 차순위 즉위 등, 찬탈 사건 사실이 없음) | B-5 + LLM 확인 | medium |
| `address_mismatch` | 화자-대상 관계·서열에 맞지 않는 호칭(제자가 사부를 "사형") | B-6 | low (대사 실수) / medium |
| `calendar_conflict` | 시즌·학기·기한 밖 사건(방학 중 수업, 시즌 종료 후 정규 경기) | B-9 | medium |
| `source_divergence_unacknowledged` | 원작 대비 바뀐 사건을 빙의자가 "원작대로"라고 믿고 행동(지식 갱신 누락) | B-8 + `believes` | medium |

## 4. 카테고리별 세계관 정보 항목

표기: **엔티티** = `EntityTypeDef`(괄호는 `parent`), **관계** = `RelationTypeDef`(정의역 → 치역, 개수, 시간 제약), **속성** = `AttributeDef`(값, 단위·범위), **서열** = `OrdinalScaleDef`, **규칙** = 연속성 규칙 후보, **호칭** = `title`/`address_term`, **떡밥** = `SetupPatternDef`. 서열 값 예시는 장르 관습의 대표형이고 작품마다 다르므로 템플릿 기본값으로만 씁니다.

### 4.1 무협 (`murim`)

근거: 경지 단계 순서(삼류→이류→일류→절정→초절정→화경→현경→생사경)와 "초절정 이후는 한국 무협 창작"이라는 설명, 작품마다 정점이 다름 [2차] https://thewiki.kr/w/경지 (나무위키 미러). 정사마 구도·문파 구조는 장르 관습 [2차, 나무위키 계열 미확인].

| 정보 항목 | 06 매핑 | 비고 |
|---|---|---|
| 문파·세가·방회·마교 | 엔티티 `sect`(organization), `clan`(organization). 속성 `faction_alignment: ordinal`이 아닌 enum(`orthodox` 정파, `unorthodox` 사파, `demonic` 마도, `neutral`) | 소속 진영은 단일값·시간 변화 가능(전향) |
| 문파 계층(본산·분타·외당/내당) | `part_of`(기본), 속성 `disciple_tier: enum(outer, inner, direct)`(외문·내문·직전) | 직전제자는 사부 관계와 함께 검사 |
| 사제 관계·항렬(배분) | 관계 `master_of`(기본). 속성 `generation: int`(문파 내 대수, 단위 "대") | 규칙: 제자의 `generation` = 사부 + 1 |
| 사형제·의형제 | 사형제는 저장하지 않고 `master_of` 경로로 유도(B-6). 의형제는 관계 `sworn_sibling_of`(대칭, `older` 값) | 의형제는 `sibling_of`와 다름(혈연 아님) |
| 무공(심법·검법·보법·장법) | 엔티티 `martial_art`(ability). 속성 `art_kind: enum(inner_method, sword, saber, fist, footwork, hidden_weapon, other)`, `grade: ordinal`(삼류무공~절세무공, 작품별) | 무공의 소속 문파 `belongs_to_sect`(martial_art → sect, 주어당 1) |
| 초식 | 엔티티 `technique`(ability). 관계 `technique_of`(technique → martial_art, 주어당 1), 속성 `order_in_art: int` | 초식명은 용어집 시드(한자 병기 정책) |
| 경지 | 속성 `realm: ordinal:murim_realm`(character). 서열 기본값 위 8단계 | 규칙: 하강 금지(예외 사건 `cultivation_crippled` 폐공·산공, `realm_sealed`) |
| 내공 | 속성 `inner_energy: numeric`(단위 `year` 년, "1갑자 = 60년"을 용어집 정의로) | 장부(B-7): 영약 복용·흡성·전수로 증감 |
| 무공 전수·비급 | 관계 `learned_from`(character → character, 값: martial_art), `owns`(비급 item) | 규칙: 문파 비전 무공 사용 시 소속 또는 습득 경로 사실 필요 |
| 강호 지리(성·현, 관도, 객잔) | `place` + `located_in`, `travel_time_days`(기본) | 경공 이동 시간은 작품 규칙 문장(`rule_statement`) |
| 무림맹·사도련 등 연합 | `organization` + `member_of`(조직 → 조직은 기본 정의역 밖 → 확장 `allied_member_of`(organization → organization)) | 기본 `member_of` 정의역은 character만 |
| 원한·은원 | `enemy_of`(기본), 관계 `owes_debt_to`(은혜, 비대칭) | 떡밥 원천 |

| 호칭 | 형식 |
|---|---|
| 직위 칭호: 장문인·방주·가주·맹주·교주·장로·당주 | `title` 엔티티 + `title_of`(B-4) + `max_holders`(장로는 n) |
| 사문 호칭: 사부·사형·사제·사매·사저·사숙·사백·사조 | `address_term` + `relation_path`(B-6). 사숙/사백 구분은 사부와의 나이 비교(`older`) |
| 별호(검성·독왕 등) | `alias`(한 사람 고정) 또는 `title`(대를 잇는 별호면). 06 3.2 유형 판정 규칙 그대로 |
| 존칭: 대협·소협·선배·노선배 | `address_term` + `speaker_rank_below_target`(경지 기준) 또는 나이 |

| 규칙 후보 | 연결 |
|---|---|
| 경지는 하강하지 않는다(예외: 폐공·산공·봉인) | `ordinal_regression` |
| 제자의 항렬 = 사부 항렬 + 1 | 확장 제약(LLM 불필요, 결정적) |
| 한 문파의 장문인은 동시에 1명 | `holds_title` + `max_holders=1`(기존 INV-ONT-05) |
| 같은 경지 내에서 압도적 승패는 원인(무공 상성·영약·기연) 사실이 필요 | `llm_rule`(CR-06 근거 묶음) |
| 정파↔마도 소속 동시 성립 금지(위장 잠입은 `disguise`·`cover_story`) | `disjoint_with` |

| 떡밥 패턴 | 설명 |
|---|---|
| `lost_manual` 실전 비급 | 설치: 비급 단서 / 강화: 다른 세력도 추적 / 회수: 습득·정체 |
| `hidden_lineage` 숨은 사문·혈통 | 무공 초식이 특정 실전 문파와 같음 → 출신 공개 |
| `sect_massacre_truth` 멸문 진상 | 은원 구도의 근원 |
| `masked_master` 정체불명 고수 | 06 3.12 정체 은닉 경로 A/B |

컨셉 질문(`concept_partner`): 경지 체계의 정점과 단계 수 / 주인공 소속 진영과 문파 위상 / 내공 단위(갑자 사용 여부) / 한자 병기 정책 / 시대 배경이 실제 왕조인지(대체역사 오버랩 시 4.6 정책).

### 4.2 정통 판타지 (`high_fantasy`)

근거: 마법 체계는 "할 수 있는 것"보다 한계·약점·대가가 서사적으로 중요하다(Sanderson's Second Law: Limitations > Powers) [1차] https://www.brandonsanderson.com/sandersons-second-law/ . Campfire Magic 모듈이 규칙·한계·메커니즘을 필드로 둠 [2차] https://selfpublishing.com/?p=4969 .

| 정보 항목 | 06 매핑 | 비고 |
|---|---|---|
| 마법 체계(원천·발동·대가·한계) | `rule` 엔티티(체계) + `ability` 엔티티(주문·계통). 기본 속성 `ability_cost`·`ability_limit`, 확장 `mana_source: enum`, `casting_requirement` | Sanderson 2법칙에 맞춰 컨셉 단계에서 한계·대가 입력을 필수로 둠 |
| 마법 등급(서클·클래스) | 속성 `magic_rank: ordinal:<scale>`(character), 주문 `spell_rank` | 규칙: 시전자 등급 ≥ 주문 등급(예외: 증폭 아이템·의식) |
| 마나량 | 속성 `mana_capacity: numeric`(단위 작품 정의) | 소모·회복은 장면 단위 상태라 `story_range` 짧은 사실 |
| 종족 | 엔티티 `species`. 관계 `is_species`(character → species, 주어당 1). 속성 `lifespan_years`, `traits` | 혼혈은 다중값 또는 별도 종족 엔티티 |
| 국가·왕국·제국 | `organization` 하위 `realm_state`. `headquartered_in`(수도), 영토는 `controls_territory`(realm_state → place, 시간 변화) | 전쟁으로 영토 변동 |
| 신·교단·성직 | 엔티티 `deity`(character 아님, 별도), `church`(organization). 관계 `worships`, `blessed_by` | 신성력은 로판과 공유 |
| 기사단·기사 서열 | `organization` + 칭호. 서열 `knight_rank` | |
| 마물·몬스터 | 엔티티 `creature_kind`(종 단위) / 개별 개체는 `character` | |
| 역사 연표·달력 | B-9 달력 + `event` | |
| 유물·성검 | `item` + 속성 `artifact_grade: ordinal`, 관계 `bound_to`(item → character, 주인 인정) | `owns`와 다름(소유 ≠ 계약) |

| 규칙 후보 | 연결 |
|---|---|
| 주문 사용은 시전자 등급·마나·조건을 만족해야 한다 | `llm_rule` + 등급 비교 결정적 사전 필터 |
| 마법 등급은 하강하지 않는다(예외: 마나 심장 파괴 등 작품 사건) | `ordinal_regression` |
| 종족 수명 밖 나이 금지 | `age` ≤ `lifespan_years` |
| 대가가 있는 마법은 사용 후 대가 사실이 따라와야 한다 | `llm_rule` |

떡밥: `prophecy` 예언(설치: 예언문 / 회수: 해석 반전), `ancient_war_truth` 고대 전쟁 진상, `chosen_one_doubt` 선택받은 자 오인. 호칭: 폐하·전하·경(卿)·성하 → 로판과 공유(4.4 경칭 표).

### 4.3 현대판타지·헌터 (`modern_fantasy_hunter`)

근거: 게이트·던전 출현과 각성의 동시 발생, F~S 등급, 협회가 면허·등급 판정, 길드가 대형 게이트·자원 경제 담당, 무소속 헌터 존재 [2차] https://payhip.com/thekhaoticauthorzone/blog/ramblings-of-a-confused-author/what-is-the-hunterverse , https://deltiasgaming.com/?p=126513 (특정 작품 해설이므로 관습 수준만 차용). 한국어 1차·2차 장르 문서 확인 못함 [미확인].

| 정보 항목 | 06 매핑 | 비고 |
|---|---|---|
| 게이트·던전 | 엔티티 `gate`(place). 속성 `gate_grade: ordinal:gate_grade`, `opened_at`(story_point), `close_deadline_days: numeric`, `gate_status: enum(open, cleared, broken, closed)` | 단일값 시간 변화 상태 |
| 던전 브레이크 | `event`(속성 `event_kind=dungeon_break`) + `occurred_at` gate | 규칙: 브레이크는 기한 초과 후에만 |
| 헌터 등급·각성 | 속성 `hunter_rank: ordinal:hunter_rank`(F<E<D<C<B<A<S, 작품별 SS·EX), `awakened_at`, `awakening_type: enum(combat, support, production, …)` | 예외 사건: `re_awakening` 재각성, `re_evaluation` 재측정 |
| 협회 | `organization` 하위 `association`. 관계 `licensed_by`(character → association) | 등급 판정 사건 `rank_assessment` |
| 길드·공대 | `organization` 하위 `guild`, `party`(일시). `member_of`, `leader_of` | 길드 순위 `guild_rank: int` |
| 스킬 | 엔티티 `skill`(ability). 속성 `skill_grade`, `cooldown`, `cost` | `system` 오버레이와 공유 |
| 몬스터·마석·부산물 | `creature_kind`, `item`(속성 `material_grade`) | 경제 수치(가격)는 선택 |
| 국가·정부와 헌터 관계 | `organization`(정부) + `ally_of`/`enemy_of` | 현실 국가명 사용 시 4.6 정책 |
| 일상 현대 사회 | 실제 지명 `place`(`is_real_place` 표시 권고) | 이동 시간은 현실 기반 |

| 규칙 후보 | 연결 |
|---|---|
| 헌터 등급은 재측정 사건 없이 바뀌지 않는다 | `ordinal_regression` + 상승도 사건 필요(`monotonic`가 아닌 `change_requires_event`) |
| 게이트 등급보다 낮은 등급 단독 공략은 근거(스킬·아이템) 필요 | `llm_rule` |
| 게이트는 `cleared`·`closed` 이후 다시 `open` 불가 | 상태 전이 제약(확장) |
| 각성 전 스킬 사용 금지 | `has_ability.story_range` ≥ `awakened_at` |

떡밥: `gate_origin` 게이트의 기원, `hidden_rank` 등급 은폐(측정 오류·위장), `regressor_future_gate` 회귀자가 아는 미래 게이트(회귀 오버레이와 결합). 호칭: "S급님", 길드장·협회장(`title_of`).

### 4.4 로맨스판타지 (`romance_fantasy`)

근거: 책빙의물의 원작 지식·파멸 예언 구조 [1차] 안상원 2020(1.1). 작위 서열(공·후·백·자·남)과 경칭은 유럽 귀족제를 차용한 장르 관습 [미확인: 1차·2차 문서 확인 못함, 가정].

| 정보 항목 | 06 매핑 | 비고 |
|---|---|---|
| 작위 | `title` 엔티티 + `title_rank: ordinal:peerage`(기본값 대공 > 공작 > 후작 > 백작 > 자작 > 남작 > 준남작·기사), `title_of`(→ 가문 또는 영지), `succession_rule` | 같은 이름 작위가 가문마다 별개 엔티티("A 공작", "B 공작") |
| 가문·문장 | 엔티티 `noble_house`(organization). 속성 `coat_of_arms`(시각 속성, `visual_attribute=true`), `house_color`, `motto` | 문장은 삽화 일관성(FR-SPX-03)에 바로 쓰임 |
| 황실·왕실 계보 | `father_of`·`mother_of`·`spouse_of`(기본) + `holds_title` | 서자·사생아 표시 `legitimacy: enum` |
| 영지 | 엔티티 `fief`(place). `controls_territory`(noble_house → fief) | |
| 약혼·파혼·계약 결혼 | 관계 `betrothed_to`(대칭, 주어당 1(동시), `disjoint_with: [spouse_of]` 같은 쌍 동시 금지), `contract_marriage` 값 `{term_end, clauses[]}` | 계약 조항은 `constraint` 사실로도 활용 |
| 사교 시즌·데뷔탕트 | B-9 달력 + `event`(`event_kind=debutante_ball`, `social_season`) | 규칙: 데뷔 전 사교계 공식 참석 금지(작품 규칙) |
| 성인·데뷔 연령, 혼인 가능 연령 | `rule` 속성 `age_of_majority`, `debut_age` | `age`와 대조 |
| 마법·신성력·성녀 | `ability` + 서열 `divine_power_rank`, 칭호 `saint`(성녀·성자, `max_holders` 작품별) | |
| 원작 소설 속 위치 | 빙의 오버레이(5.2): `source_work` 시간선, 원작 내 역할 속성 `source_role: enum(protagonist, villainess, extra, male_lead, sub_male_lead, …)` | 원작 결말(파멸)은 `source_work` 사실 |
| 시녀·기사 등 수행원 | `subordinate_of`(기본), 하위 관계 `sworn_knight_of`(전속 기사, parent_key `subordinate_of`) | |

| 경칭·호칭 기본값(가정) | 형식 |
|---|---|
| 폐하(황제·국왕), 전하(왕족·대공), 각하(공작 등 고위 작위, 작품별), 영애·영식(귀족 자녀), 경(기사·관료), 부인(작위 배우자) | `address_term` + `target_title_rank_at_least`(B-6). 작품마다 경계가 달라 컨셉 대화에서 확정 |
| 혼인 후 호칭 변화("OO 공작 부인") | `title`(배우자 칭호) 또는 `address_term`(`spouse_of` 조건) + `story_range` |

| 규칙 후보 | 연결 |
|---|---|
| 작위 승계는 `succession_rule`을 따른다(찬탈·하사·박탈은 사건 필요) | `succession_violation` |
| 하위 작위자가 상위 작위자에게 하대 금지(관계 예외: 친족·연인 사적 대화) | `address_mismatch`(low) |
| 약혼자가 동시에 다른 사람과 약혼 금지 | `betrothed_to` 개수 1 |
| 원작에서 확정된 사건이 현재 세계에서 바뀌면 빙의자 지식 갱신 필요 | `source_divergence_unacknowledged` |

떡밥: `ruin_flag` 원작 파멸 플래그(설치: 원작 결말 / 회수: 회피·변형), `true_heir` 진짜 후계자, `contract_end` 계약 결혼 만료, `male_lead_obsession_origin` 남주 집착의 기원. 로맨스 진척 단계는 사실이 아니라 아웃라인 지표(FR-NOV-03 "로맨스 진척")로 두는 것을 권고(서열화하면 단조 규칙과 맞지 않음).

### 4.5 현대 로맨스 (`contemporary_romance`)

근거: 회귀 플롯이 현실 로맨스에도 적용됨 [1차] 김경애 2024. 그 밖은 장르 관습 [미확인].

| 정보 항목 | 06 매핑 | 비고 |
|---|---|---|
| 직장·직급 | `organization`(company) + `title`(직급) + 서열 `corporate_rank`(사원<대리<과장<차장<부장<이사<…, 작품별) | 직급 호칭은 `title`. 승진은 상승만(예외: 강등) |
| 재벌가·가계 | 기본 가족 관계 + `noble_house` 대신 `family_group`(organization) | 지분 등 수치는 선택 |
| 계약 연애·결혼 | `contract_relationship` 값 `{kind, term_end, clauses[]}` | 로판과 같은 형식 재사용 |
| 학번·입사 연도·나이 | `age` + 속성 `enrollment_year`, `joined_year` | 규칙: 나이·학번·학년 정합(현실 학제, 가정: 한국 학제) |
| 실제 지명·브랜드 | `place`(`is_real_place`), 브랜드는 용어집 | 실명 브랜드 노출 정책은 플랫폼 정책 프로필(FR-NOV-04b) |
| 과거 인연·첫사랑 | `event` + `participated_in`, `is_secret` 사실 | 떡밥 원천 |

규칙: 현실 시간 경과(계절·연도)와 나이 정합, 직급 하강은 사건 필요, 동시 연애 관계 개수(작품 규칙). 떡밥: `past_connection` 과거 인연, `misunderstanding` 오해(설치 = 한쪽 `misbelieves`, 회수 = `knows`로 전환. 06 7절 지식 모델로 바로 검사 가능), `hidden_identity` 신분 은닉(재벌 2세 위장 등, 06 3.12). 호칭: 직급+님, 오빠·선배(관계·나이 조건 `address_term`).

### 4.6 대체역사 (`alt_history`)

근거: 결정적 순간(전투·선거·전쟁)에서 알려진 역사와 갈라지는 "만약에" 구조 [2차] https://www.ebsco.com/research-starters/literature-and-writing/alternate-history-fiction . 대체역사는 SF에서 출발해 한국의 대표 장르소설이 됨 [2차, 초록] https://scholar.kyobobook.co.kr/article/detail/4010028657487 . 대체역사 빙의물의 역사 왜곡 논란 [2차, 초록] 같은 검색 결과.

| 정보 항목 | 06 매핑 | 비고 |
|---|---|---|
| 실제 역사 기준선 | 시간선 `kind=main`이 아닌 **기준 시간선**(가정: `parallel`의 부모로 두는 `historical_reference`, B-8과 같은 방식의 `timeline_kind` 추가 필요) | 기준 사실 출처 `source_kind=import`(사료·연표). 출처 URL 필수 |
| 분기점 | `branch_story_point` + `event`(`event_kind=divergence_point`) | 규칙: 분기 이전 사건은 기준선과 같아야 함 |
| 바뀐 사건 목록 | 기준선과 작품 시간선의 같은 슬롯 비교 질의(06 6.3 상속 + `is_negation`) | 회귀의 "바뀐 사건 목록"과 같은 질의 |
| 실존 인물 | `character` + `is_real_person=true`(06 2.4) | **NFR-SAFE-02 충돌 지점** — 아래 |
| 관직·품계 | `title` + 서열 `official_rank`(정1품~종9품 등, 시대별) | 시대별 척도를 따로 둠 |
| 기술 수준·연도 | `rule` 속성 `tech_baseline_year`, 확장 `introduced_tech`(event) | 규칙: 시대 밖 기술은 도입 사건 필요(주인공의 미래 지식) |
| 주인공의 미래 지식 | 회귀·빙의·환생 오버레이와 같음(`knows_fact` on 기준선 사실) | |

**정책 충돌(결정 필요)**: 07 SF-3은 실존 인물에 대해 "지어낸 발언·행동을 사실처럼 서술"하면 `safety_real_person` `high`, "단순 언급·역사 서술"은 위반 아님입니다. 대체역사는 실존 역사 인물이 허구의 대사·행동을 하는 것이 장르의 본질입니다. 선택지(제안, 결정은 사용자):

| 안 | 내용 | 장단 |
|---|---|---|
| A | 사후 일정 기간이 지난 역사 인물(가정: 생존 인물·최근 사망 인물 제외)은 `alt_history` 템플릿이 켜진 작품에서 "허구임이 명백한 작중 행동"을 허용. 명예훼손 성격(범죄·추문 날조)은 계속 차단 | 장르 성립. 기준 연도·목록 출처 필요(06 O-19) |
| B | 실존 인물은 가명화(가상 인물 대체)만 허용 | 안전. 장르 매력 크게 감소 |
| C | 현행 SF-3 유지 + 매 화 사람 확인 | 질문 폭주 위험 |

컨셉 질문: 분기점과 분기 원인 / 실존 인물 등장 범위(A·B 중) / 기준 사료 범위 / 주인공 개입 방식(빙의·회귀·전생 지식).

### 4.7 SF (`sci_fi`)

근거: 장르 관습 [미확인]. Campfire Systems·Species 모듈의 항목 구조 [2차] https://selfpublishing.com/?p=4969 .

| 정보 항목 | 06 매핑 | 비고 |
|---|---|---|
| 기술 수준·물리 규칙(FTL 여부, 통신 지연) | `rule` 엔티티 + `rule_statement`. 확장 `comm_delay_rule` | 규칙: FTL 없음이면 행성 간 이동 시간 하한(`travel_time_days`) |
| 행성·성계·함선 내부 | `place` 계층(`located_in`), 함선은 `vessel`(item) + 내부 구역 `place` | 함선은 이동하므로 `located_at` 대상 |
| 종족·외계 생명 | `species`(판타지와 공유) | |
| 기업·연방·군 | `organization` + 군 계급 서열 `military_rank` | |
| AI·사이보그·클론·업로드 | `character` + 속성 `substrate: enum(biological, synthetic, uploaded, clone)`. 복제·업로드는 빙의 모델(`persona`/`body`) 재사용 검토 | 같은 인격의 복수 몸 = `counterpart_of` 또는 빙의 모델 |
| 작중 연도·시간 단위 | B-9 달력 | 상대론적 시간 지연은 `rule` 문장 |

규칙: 정해진 기술 한계 위반(CR-06 근거), 이동·통신 시간 위반(CR-02 확장). 떡밥: `first_contact`, `ai_awakening`, `colony_secret`.

### 4.8 게임판타지·상태창 (`system`, `game_world` 오버레이)

근거: 상태창이 메타데이터로 세계 분석, 퀘스트가 목표·보상·패널티를 명시 [1차] 서재인 2025(1.1). 게임판타지 장르관습(레벨업과 대리만족) [2차, 초록] https://accesson.kr/daejung/assets/pdf/45349/journal-30-3-183.pdf (원문 미확인).

| 정보 항목 | 06 매핑 | 비고 |
|---|---|---|
| 시스템 주체(시스템 창, 성좌·관리자 등 작품별) | `rule` 엔티티 `system` + 선택적 `character`(의인화된 시스템) | 시스템 메시지는 원고 서식(대괄호 등)으로 추출 |
| 레벨 | 속성 `level: numeric(integer, min 1)` | 규칙: 하강 금지(예외: 패널티 사건) |
| 스탯 | 속성 묶음 `stat.<key>: numeric`(STR, AGI, INT 등 키는 작품 정의) + 장부(B-7) | **수치 일관성의 핵심**. 원고 상태창 스냅숏을 `attribute` 사실로 추출해 장부와 대조 |
| 스탯 포인트·경험치·재화 | 장부 구성요소(`stat_points`, `exp`, `gold`) | 지급(레벨업·보상) − 사용 = 잔액 ≥ 0 |
| 스킬 | `skill`(ability) + `skill_level`, `skill_grade: ordinal`, `cooldown`, `cost`, `acquired_at` | 쿨타임 중 재사용 금지(씬 경과 필요) |
| 칭호(시스템 칭호) | `title`이 아니라 시스템 업적 → 확장 엔티티 `system_title`(ability)로 분리 권고 | 06 `title`은 직위(보유자 승계) 의미라 충돌 방지 |
| 퀘스트 | 엔티티 `quest`(event). 속성 `objective`, `reward`(장부 증분), `penalty`, `deadline`, `quest_status: enum(offered, accepted, completed, failed)` | 퀘스트는 떡밥(03 setups)과 1:1 연결 가능 |
| 아이템·등급·옵션 | `item` + `item_grade: ordinal`(일반<고급<희귀<영웅<전설<신화, 작품별), 속성 `item_stats` | 착용 효과는 장부 구성요소 |
| 직업·클래스 | `ability` 하위 `job_class` + `has_ability` | 전직은 사건 |
| 게임 세계 vs 현실(가상현실 접속형) | `place` 계층을 `world_layer: enum(real, virtual)`로 구분 | 접속 중 현실 몸 상태는 별도 `located_at` |

| 규칙 후보 | 연결 |
|---|---|
| 상태창 수치는 직전 상태 + 장부 증감과 같아야 한다 | `ledger_mismatch` |
| 레벨은 하강하지 않는다(예외: 패널티·초기화 사건) | `ordinal_regression`(수치형에도 같은 규칙) |
| 퀘스트 보상은 완료 사건 뒤에만 지급 | 장부 증분의 근거 사건 필수 |
| 스킬 사용은 습득 이후, 비용(마나·쿨타임) 충족 | `llm_rule` + 결정적 사전 필터 |

떡밥: `hidden_quest` 숨은 퀘스트, `system_origin` 시스템의 정체, `unique_skill_cost` 고유 스킬의 숨은 대가.

### 4.9 아카데미 (`academy` 오버레이)

근거: 장르 관습 [미확인]. 아카데미물이 게임·소설 속 빙의와 자주 결합(가정).

| 정보 항목 | 06 매핑 | 비고 |
|---|---|---|
| 학교·학과·반·기숙사 | `organization` 계층(`part_of`) + `member_of` | 반 배정은 학기 단위 `story_range` |
| 학년 | 속성 `school_year: ordinal:school_year` | 규칙: 학년은 학년도 경계에서만 +1(예외: 유급·월반 사건) |
| 학기·시험·방학 | B-9 달력 + `event`(`event_kind=exam`, `term_start`) | `calendar_conflict` |
| 성적·순위 | 속성 `class_rank: numeric(integer, min 1)`(시험 사건별) | 같은 시험에서 순위 중복 금지(동점 규칙) |
| 교수·조교 | `title`(교수) + 관계 `teaches`(character → organization 수업) | 사제(`master_of`)와 구분 |
| 동기·선후배 | 유도: 같은 입학 연도 = 동기 | 호칭 `address_term`(선배, 입학 연도 비교) |

떡밥: `ranking_exam_upset`, `academy_incident`(원작 사건), `hidden_bloodline_student`.

### 4.10 스포츠 (`sports`)

근거: 장르 관습 [미확인].

| 정보 항목 | 06 매핑 | 비고 |
|---|---|---|
| 리그·구단·시즌 | `organization`(league, team) + B-9 달력(시즌) | 실제 리그 사용 시 4.6 정책과 같은 문제 |
| 선수 계약·이적 | `member_of` + 값 `{contract_end, salary?}` | 규칙: 동시에 두 팀 소속 금지(임대는 예외 사건) |
| 경기 결과 | `event`(match) + 속성 `score`, `participated_in`(값: 포지션·출전 시간) | |
| 개인 기록 통계 | 장부(B-7): 경기별 기록 합 = 시즌 누적 | `ledger_mismatch` |
| 포지션·등번호 | 속성 `position`, `jersey_number`(팀 내 단일, 시간 변화) | 규칙: 같은 팀·시점 등번호 중복 금지 |
| 신체·나이·부상 | 기본 `age`, `injury`(06 4.3) | 부상 중 출전은 사건 필요 |

떡밥: `rival_rematch`, `injury_comeback`, `hidden_talent_scout`. 회귀 오버레이와 결합 시 "미래 경기 결과 지식".

### 4.11 연예계 (`entertainment`)

근거: 장르 관습 [미확인].

| 정보 항목 | 06 매핑 | 비고 |
|---|---|---|
| 소속사·그룹·유닛 | `organization` + `member_of`, 그룹 내 역할 속성(`group_role`) | |
| 데뷔·연습생 기간 | 속성 `debut_at`, `trainee_since` | 규칙: 데뷔 전 공식 활동 금지 |
| 작품·음반·방송 | `event` 또는 확장 `work`(item 하위: 앨범·드라마) | |
| 차트·순위·시청률 | 속성 `chart_rank`(사건별), 수치 | |
| 팬덤·스캔들 | `organization`(팬덤), `event` + `is_secret` | 실존 연예인 차용은 SF-3 대상 |

떡밥: `scandal_truth`, `past_life_star`(환생·회귀 결합), `rival_agency_scheme`. 실존 연예인·실존 기획사 실명은 기본 차단 권고(NFR-SAFE-02).

## 5. 트로프 오버레이 (장르와 조합)

### 5.1 회귀 (`regression`)

06 3.13이 이미 대부분을 덮습니다. 템플릿은 기본값과 질문만 더합니다.

| 정보 항목 | 06 매핑 | 템플릿이 더할 것 |
|---|---|---|
| 회차별 시간선 | `timelines(kind=regression|loop)`, `rewind_to_story_point` | 회귀 횟수 상한·회귀 조건(사망 시·특정 사건) `rule_statement` |
| 이월되는 기억 | `retains_memory` | 기억 범위 기본값(전체 / 사망 직전까지 / 일부 손실) 질문 |
| 이월되는 물건·능력 | `owns`·`has_ability` 명시 사실(자동 상속 아님) | 이월 허용 목록(능력 숙련도는 몸이 아니라 기억에 귀속인지) |
| 바뀐 사건 목록 | 부모 시간선 vs 현재 시간선 같은 슬롯 비교 | `changed_events` 뷰(질의 추가) |
| 다른 회귀자·회귀 인지자 | `retains_memory`를 가진 다른 인물 | 떡밥 패턴 `other_regressor` |
| 미래 지식 사용 | CR-17 | 미래 지식이 틀리는 지점(나비효과) 떡밥 `butterfly_effect` |

떡밥: `regression_cause` 회귀 원인, `first_life_betrayer` 전생 배신자, `other_regressor`, `butterfly_effect`.

### 5.2 빙의 (`possession`, 책빙의 포함)

| 정보 항목 | 06 매핑 | 템플릿이 더할 것 |
|---|---|---|
| 몸과 영혼 | `persona`/`body`, `inhabits`, `possession_side`(3.13) | 빙의 모델 켜기 기본값 |
| 원작 줄거리·원작 지식 | (없음) → B-8 `source_work` 시간선 + 원작 내 역할 `source_role` | 원작 요약 입력 단계(컨셉 대화에서 받음). 원작 결말 = `source_work`의 마지막 사건 사실 |
| 원작 vs 현재 세계 차이 | `source_work` vs `main` 슬롯 비교 | `source_divergence_unacknowledged` 규칙 |
| 원래 영혼의 행방 | 원래 영혼 `persona`의 `inhabits` 종료 후 상태 | 떡밥 `original_soul_fate` |
| 빙의 사실을 아는 인물 | `knows_fact`(`inhabits` 사실 대상) | |

주의: 원작은 작중 가상의 소설이어야 합니다. 실제 출간작을 원작으로 지정하면 저작권 문제가 생기므로 컨셉 단계에서 "가상의 원작"임을 확인하는 질문을 둡니다(가정: 정책은 PRD 확인 필요).

### 5.3 환생 (`reincarnation`)

| 정보 항목 | 06 매핑(제안) | 비고 |
|---|---|---|
| 전생 인물 | 별도 `character`(전생) + 관계 `reincarnation_of`(character → character, 주어당 1) | 빙의와 달리 출생부터 한 몸·한 인격이라 `persona`/`body` 불필요 |
| 전생 기억 | `retains_memory` 값 `{from_entity_id: 전생 인물, scope}` | `retains_memory`는 현재 `from_timeline_id` 기준이라 값 형식 확장 필요 |
| 전생 세계 | 같은 세계면 시간선 상 과거 사실, 다른 세계면 별도 `place` 계층(`world_layer`) | |
| 기억 각성 시점 | `retains_memory.story_range` 시작 | 유아기 서술의 지식 검사 |

### 5.4 오버레이 조합 충돌 규칙

| 조합 | 처리 |
|---|---|
| 같은 키를 두 템플릿이 다르게 정의 | 템플릿 빌드 시 오류(설치 데이터 검증). 공유 키(`skill`, `species`, `contract_relationship`)는 공통 라이브러리 1곳에서만 정의 |
| 헌터 + 시스템 | `hunter_rank`(협회 측정)와 `level`(시스템)은 별개 척도로 공존 |
| 로판 + 빙의 + 회귀 | `source_work`, `regression` 시간선이 동시에 존재. 원작 지식과 회귀 기억을 `knows_fact`의 대상 시간선으로 구분 |

## 6. 템플릿 데이터 형식 (제안 초안)

```yaml
key: murim@1                     # 템플릿 키@버전
template_kind: genre             # genre | trope_overlay | motif_overlay
label_ko: 무협
requires_base: base@2            # B-1~B-11 반영 후
compatible_overlays: [regression, possession, reincarnation, system, academy]
schema_extension:                # 06 4.1 extension과 같은 zod 형식
  entity_types: [{key: sect, parent: organization, ...}, {key: martial_art, parent: ability, ...}]
  relation_types: [{key: sworn_sibling_of, symmetric: true, ...}, {key: technique_of, ...}]
  attributes: [{key: realm, domain: [character], value_type: "ordinal:murim_realm",
                temporal: [{kind: monotonic_non_decreasing,
                            exception_event_predicates: [cultivation_crippled, realm_sealed]}]}]
  ordinal_scales: [{key: murim_realm, levels: [{key: third_rate, label_ko: 삼류, rank: 1}, ...], open_top: true}]
  ledgers: [{key: inner_energy_ledger, ...}]
glossary_seed: [{surface: 갑자, definition: "내공 60년", category: term}]
address_rules: [{surface: 사형, condition: {relation_path: ["master_of^-1","master_of"], older: true}}]
continuity_rules: [{key: realm_no_regression, prefilter: ordinal_regression, severity: high,
                    statement_ko: "경지는 하강하지 않는다(예외: 폐공·봉인)"}]
setup_patterns: [{key: lost_manual, label_ko: 실전 비급, ...}]
concept_questions:               # concept_partner가 쓰는 질문 목록
  - {key: realm_peak, ask_ko: "경지의 정점은 어디까지 두나요?", fills: "ordinal_scales.murim_realm", default: 생사경}
sources: [{url: "https://thewiki.kr/w/경지", grade: "2차", checked_at: 2026-10-28}]
```

| 단계 | 동작 | 연결 |
|---|---|---|
| T1 템플릿 선택 | `concept_partner` 대화 중 장르·오버레이 추정 → 사용자 확인 | 요구 A |
| T2 질문 진행 | `concept_questions`를 대화에 녹여 묻고, 답으로 기본값을 덮어씀(FR-NOV-03 "사용자가 덮어쓸 수 있음") | 05 질문 형식은 버튼이 아닌 자유 대화 |
| T3 ConceptBrief 승인 | 확정 값으로 작품 첫 `ontology_schema_versions` 행 생성(템플릿 키·버전 기록) + 용어집 시드 + 떡밥 패턴 후보 | 06 4.1, 5절, 03 3.7 |
| T4 이후 변경 | 06 4.5 스키마 변경 제안 흐름 그대로 | — |

## 7. 기존 세계관 도구의 템플릿 구조 비교

| 도구 | 템플릿 구조 | 칭호·서열 | 규칙·검증 | 우리에게 주는 것 | 등급·출처 |
|---|---|---|---|---|---|
| World Anvil | 28개 문서 템플릿(article type). Character(가계도·관계 패널), Organization(외교 관계망), Title(직위: 획득 방법·직무·역사), Condition(질병·변이·초능력·RPG 상태) 등 | Title 템플릿이 "사람이 보유하는 직위"로 Profession과 분리 — 06 `title` 엔티티 방식과 같은 판단 | 서술형 프롬프트. 제약 검증 없음. 군 계급 전용 템플릿 부족이 사용자 요청으로 올라옴 | 직위/직업 분리, Condition 같은 "상태" 템플릿 | [1차, 검색 요약으로만 확인; 페이지 403] https://www.worldanvil.com/learn/article-templates/title , https://www.worldanvil.com/learn/article-guides/article-templates , [2차] https://www.worldanvil.com/community/voting/suggestion/81f93f36-3836-4d5c-961c-563d2e3d92c0/view |
| Campfire | 17~18개 모듈: Characters(100+ 속성), Timeline(복수 타임라인), Relationships, Magic(규칙·한계·메커니즘), Species, Cultures, Items, Systems(정부·법·위계), Languages, Religions, Calendar | Systems 모듈의 위계 | Magic 모듈이 "일관성 확인"을 표방하나 수동 | 모듈 목록 = 우리 엔티티 유형 후보의 교차 확인. 복수 타임라인·달력 | [2차] https://selfpublishing.com/?p=4969 , https://blog.reedsy.com/campfire-write-review/ |
| Scrivener | 장르별 템플릿을 제공하지 않고 범용 도구 + 사용자 정의 시트(캐릭터·장소 스케치) | 없음 | 없음 | 장르 지식을 도구가 아닌 템플릿 데이터로 두는 접근(NFR-EXT-03과 같은 방향) | [2차] https://forum.literatureandlatte.com/t/world-building-and-character-building-tools/51328 , https://www.literatureandlatte.com/blog/how-to-use-scrivener-for-worldbuilding |
| Notion 설정집 템플릿 | Characters·Locations·Factions·Magic Systems DB를 서로 relation으로 연결. "규칙·한계·원천" 가이드 프롬프트 | 사용자 정의 | 없음 | DB 간 관계 연결 패턴 | [2차, 판매 페이지] https://quillandsteel.gumroad.com/l/fantasy-story-planner-notion-template , https://bluemoondragon.gumroad.com/l/story-wiki-notion-template |
| Obsidian | frontmatter 속성 + 링크 그래프 | 사용자 정의 | 없음(플러그인 의존) | 이 저장소 기존 조사 참고 | → research-obsidian.md |

공통 한계: 모두 **필드를 채우게** 할 뿐 "경지 하강 금지", "장문인 동시 1명", "상태창 합계" 같은 **제약을 실행하지 않습니다**. 한국 웹소설 고유 축(경지·항렬·헌터 등급·원작 지식·회귀 시간선)을 내장한 도구는 확인하지 못했습니다([미확인]: 국내 웹소설 작가용 도구 미조사).

## 8. 계획서에 넘길 작업 항목

| # | 작업 | 산출물 | 선행 |
|---|---|---|---|
| W1 | 정책 결정: 실존 인물(대체역사·스포츠·연예계) 허용 범위 | 06 O-19 확정, 07 SF-3 예외 규칙 | 사용자 결정 |
| W2 | `base@2` 메커니즘(B-1~B-11) 중 채택분을 00·06에 반영 | 00 6.10 enum(`timeline_kind` 추가 등), 06 4.1 정의 형식, 9절 새 CR | 사용자 확인(ADR-005 확정과 함께) |
| W3 | 공통 라이브러리(공유 키: `skill`, `species`, `contract_relationship`, 경칭 표) | `packages/shared` 템플릿 데이터 | W2 |
| W4 | 카테고리 템플릿 작성 순서(제안): 회귀·빙의(MVP-β 시간선과 겹침) → 무협 → 로판 → 헌터+시스템 → 판타지 → 현대 로맨스 → 아카데미 → 대체역사(W1 후) → SF·스포츠·연예 | 템플릿 YAML + 출처 목록 | W3 |
| W5 | 템플릿별 골든 테스트(06 12절 형식): 규칙마다 위반 1·정상 1 시드(예: 폐공 없는 경지 하강, 사부를 "사형"으로 부름, 상태창 합계 불일치) | 골든셋 확장 | W4 |
| W6 | 플랫폼 장르 분류·장르별 비중 1차 확인(실태조사 원문, 플랫폼 메뉴) | 1.2 축 확정 | — |
| W7 | 장르 전문가·작가 검수(관습 수준 확인, 개별 작품 설정 복제 여부 점검) | 검수 기록 | W4 |

## 9. 미확인·남은 질문

| # | 항목 | 현재 처리 |
|---|---|---|
| U-1 | 플랫폼 공식 장르 메뉴, 장르별 매출·작품 수 비중 | 가정(1.2). 2024 실태조사 원문 확인 필요 |
| U-2 | 로판 작위·경칭 체계, 무협 정사마·항렬 호칭, 헌터물 한국어 장르 문서 | 장르 관습 가정 + [2차] 일부. 작법서(예: 장르 작법 강의 교재) 원문 미확인 |
| U-3 | World Anvil 템플릿 전체 목록·필드 | 403으로 원문 미확인. 검색 요약만 |
| U-4 | 게임판타지 장르관습 논문(대중서사연구 30(3)) 원문 | 다운로드 실패, 초록 수준 |
| U-5 | 대체역사·스포츠·연예계의 실존 인물 정책 | W1 결정 필요 |
| U-6 | 책빙의 "원작"이 실제 출간작일 때의 저작권 처리 | 가상 원작만 허용 가정, PRD 확인 필요 |
| U-7 | 환생의 `retains_memory` 값 형식 확장, 원작·기준 시간선 `timeline_kind` 추가 | 00·06 변경 필요(B-8, 5.3) |

## 10. 출처 (확인일 2026-10-28)

| 등급 | 출처 |
|---|---|
| [1차] | 김경애, 「회빙환과 시간 되감기 서사의 문화적 의미」, 한국산학기술학회논문지 25(1), 2024. https://doi.org/10.5762/KAIS.2024.25.1.734 (PDF https://www.kais99.org/jkais/journal/Vol25No01/vol25no01p82.pdf) |
| [1차] | 서재인, 「한국 웹소설에 나타난 시스템 모티프 분석」, 대중서사연구 31(2), 2025. https://doi.org/10.18856/jpn.2025.31.2.012 |
| [1차] | 안상원, 「한국 웹소설의 '책빙의물'의 특성 연구 — 로맨스판타지 장르를 중심으로」, 대중서사연구 26(3), 2020. https://doi.org/10.18856/jpn.2020.26.3.003 |
| [1차] | Brandon Sanderson, "Sanderson's Second Law". https://www.brandonsanderson.com/sandersons-second-law/ |
| [1차, 검색 요약] | World Anvil Learn — Title template, article templates. https://www.worldanvil.com/learn/article-templates/title , https://www.worldanvil.com/learn/article-guides/article-templates |
| [2차] | 이코노미스트(웹소설 실태조사 보도). https://economist.co.kr/article/view/ecn202504160028 |
| [2차] | 뉴스서울(2022 웹소설 실태조사 보도). https://newsseoul.co.kr/news/view/1065580809716098 |
| [2차] | 경지 문서(나무위키 미러). https://thewiki.kr/w/경지 |
| [2차] | 헌터물 관습 해설. https://payhip.com/thekhaoticauthorzone/blog/ramblings-of-a-confused-author/what-is-the-hunterverse , https://deltiasgaming.com/?p=126513 |
| [2차] | EBSCO Research Starters, Alternate history fiction. https://www.ebsco.com/research-starters/literature-and-writing/alternate-history-fiction |
| [2차] | 대체역사 장르 논문 초록. https://scholar.kyobobook.co.kr/article/detail/4010028657487 |
| [2차] | Campfire 모듈 해설. https://selfpublishing.com/?p=4969 , https://blog.reedsy.com/campfire-write-review/ |
| [2차] | Scrivener 포럼·블로그. https://forum.literatureandlatte.com/t/world-building-and-character-building-tools/51328 , https://www.literatureandlatte.com/blog/how-to-use-scrivener-for-worldbuilding |
| [2차] | Notion 설정집 템플릿 판매 페이지. https://quillandsteel.gumroad.com/l/fantasy-story-planner-notion-template , https://bluemoondragon.gumroad.com/l/story-wiki-notion-template |
| [2차] | World Anvil 군 계급 템플릿 개선 요청. https://www.worldanvil.com/community/voting/suggestion/81f93f36-3836-4d5c-961c-563d2e3d92c0/view |
| [미확인] | 네이버 시리즈·카카오페이지·문피아 장르 메뉴(이 문서에서는 접근 실패. 네이버 시리즈·문피아는 research-webnovel-market.md 3·5.1절에서 수집·확인, 원본 `data/naver-series-top100-2026-10-28/`. 카카오페이지는 [2차]), 게임판타지 장르관습 논문 원문 https://accesson.kr/daejung/assets/pdf/45349/journal-30-3-183.pdf (다운로드 실패) |
