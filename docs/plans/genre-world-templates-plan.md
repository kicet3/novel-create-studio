# 카테고리별 세계관 데이터 템플릿 구축 계획서

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-10-28 |
| 상태 | 초안. 2026-10-28 교차 후속: 시장 조사 재집계 수치(재현 자료) 재대조, D-29 선행 조건(표본 50편 수동 라벨), 8.2절 연결점 반영 상태. 2026-10-28: 사용자 결정 확정 반영(8.3절 D-29~D-37 확정, D-29는 확정(조건부), D-33은 확정(방침)) |
| 대상 요구 | 사용자 새 요구 B(2026-10-28, 카테고리별 세계관 데이터 템플릿), 연관 요구 A(`concept_partner` 컨셉 대화), PRD v0.4 초안 FR-NOV-03(장르 템플릿, D-30 확정: FR-NOV-03b MVP-β·FR-NOV-03c v1로 분할), FR-NOV-11(카테고리 키 선택, P0 MVP-α), NFR-EXT-03(템플릿은 데이터), FR-ONT-18·19(스키마 확장·용어집), NFR-SAFE-01·02, PRD 8절 MVP-β (1)(장르 2개 × 30화) |
| 기준 문서 | PRD v0.4 초안, design 00(이름·enum·기본값 단일 출처), 03(`novels.category`·`template_refs`, `concept_briefs.template_overrides`), 04(에이전트), 06(3.2 `name_kind`, 3.5 칭호, 3.7 호칭, 3.13 회귀·빙의, 3.14 브리프 → 온톨로지, 4절 `OntologySchema`·4.7 템플릿 적용, 5절 용어집, 6.3 시간선 해석, 8절 떡밥, 9절 CR-01~CR-18, 12절 골든셋), 07(1.3 기획 단계, 3.1 아웃라인, 3.4 다듬기), 09(로드맵·스파이크·3.5 템플릿 배치), 11(3.6 `ConceptQuestionDef` 계약, 5.4 `ConceptBrief`, 5.7 매핑) |
| 결정 번호 | 8.3절 DG-01~DG-09는 PRD 13절 D-29~D-37입니다(DG-01=D-29 … DG-09=D-37). 본문은 D 번호를 쓰고 DG 번호는 괄호로 병기합니다. |
| 조사 근거 | `docs/research/research-webnovel-market.md`(시장·플랫폼 분류), `docs/research/research-genre-world-elements.md`(카테고리별 세계관 항목, `base@2` 후보 B-1~B-11), `docs/research/research-concept-agent.md`(컨셉 대화 단계·`ConceptBrief`) |
| 등급 표기 | [1차] 공식 문서·플랫폼 실제 페이지·논문, [2차] 기사·위키·해설, [추론] 근거에서 이끈 판단, [미확인] 원문 미확인. 조사하지 않은 전제는 "가정:" |
| 범위 | 무엇을, 왜, 어떤 순서로, 어떤 산출물·검증으로 만드는지 정합니다. 템플릿 전체는 만들지 않고 9절에 구조 견본 일부만 둡니다. 스키마·enum 변경은 00·06을 먼저 고친 뒤 확정합니다(ADR-013). |

## 0. 요약

| # | 내용 |
|---|---|
| 1 | 장르 템플릿은 **세계관 데이터 묶음**입니다. 한 묶음이 ① `concept_partner`의 질문 목록, ② 작품 첫 `OntologySchema` 확장, ③ 연속성 규칙, ④ 떡밥 패턴, ⑤ 용어집·표기 기본값, ⑥ 독자 기대 요소(사이다 주기·로맨스 진척·회차 말 훅)를 함께 공급합니다. |
| 2 | 카테고리 체계는 **L1 세계 장르 – L2 하위 장르 – L3 트로프 태그** 3층에 **패싯**(BL·라이트노벨 등)을 직교 축으로 둡니다. 템플릿 단위는 L1 장르 템플릿, L2 하위 장르 템플릿(L1 상속), L3 트로프 믹스인(회귀·빙의·상태창 등)입니다. "개념 1개 = 키 1개" 원칙으로 층 간 중복을 없앱니다(2.2절). 근거: 확인한 국내 플랫폼(네이버 시리즈·네이버 웹소설·문피아·노벨피아·리디)에서 회귀·빙의·헌터·아카데미는 1단 장르가 아니고 태그 층에 있습니다[1차, 확인 범위 한정. 카카오페이지 [2차], 조아라 하위 분류 [미확인]]. 해외 Wattpad는 "Isekai and Reincarnation"을 하위 장르로 둡니다[1차, S18]. |
| 3 | 1차 구축 대상은 시장 비중, 세계관 규칙 밀도, MVP-β 검증 장르 정합으로 고릅니다. 확정안(D-29·D-30)은 **MVP-β: 무협(`wuxia`, `full`) + 회귀 믹스인(`rebirth.regression`, `full`) + 현판 헌터(`modern_fantasy` + `.hunter_gate`, 질문 수준 `questions_only`)**, **v1: L1 5개(`alt_history`는 v1 2차, D-33) + 믹스인 `full`·`light` 11개 + 헌터 규칙**입니다. 공수가 09 용량을 넘으므로 MB-0 템플릿 준비 구간(2~3주)을 신설합니다(D-30 확정, 6절). |
| 4 | 템플릿 형식은 06 4.1의 `extension` zod 형식을 그대로 씁니다. 별도 스키마 언어를 만들지 않습니다. 저장은 저장소 안 YAML 원본을 빌드 때 검증·컴파일한 JSON 묶음이고, 앱 설치 데이터(03 T-6, 읽기 전용)로 배포합니다(NFR-EXT-03). |
| 5 | 작품은 컨셉 승인 시점의 템플릿 값을 **복사**해 첫 스키마 버전을 만듭니다. 이후 템플릿이 바뀌어도 기존 작품은 바뀌지 않고, 업그레이드는 06 4.5 스키마 변경 제안으로만 들어갑니다. |
| 6 | PRD 영향: 카테고리 키 선택은 FR-NOV-11(MVP-α)이 이미 다루므로, FR-NOV-03은 03b(MVP-β 검증 장르 템플릿) / 03c(v1 정식 라이브러리)로 나눠 일부를 앞당깁니다(D-30 확정). 결정 9건(D-29~D-37)은 2026-10-28 모두 확정했습니다(8.3절). |

---

## 1. 배경과 목표

### 1.1 왜 카테고리 템플릿이 필요한가

| 용도 | 템플릿이 없을 때의 문제 | 템플릿이 공급하는 것 | 받는 곳 |
|---|---|---|---|
| 컨셉 대화 질문 | `concept_partner`가 장르와 무관한 공통 질문만 합니다. 무협의 경지 정점, 회귀 시점·기억 범위, 로판 작위 체계처럼 **나중에 연속성 규칙이 되는 값**을 묻지 않고 지나갑니다(조사: 다중 턴 대화에서 모델이 빠진 정보를 추측해 확정하는 경향, Laban 외 2025[1차]) | 카테고리별 `template_required`·`optional` 질문(11 3.6 `ConceptQuestionDef`), 선택지 씨앗, 기본값 | 요구 A `concept_partner`, `ConceptBrief.world_rules[]` |
| 초기 온톨로지 스키마 확장 | `base@1`에는 경지·등급·작위 같은 **순서형 속성**, 칭호의 소속 대상, 승계 규칙이 없습니다. 작품마다 `world_keeper`가 `SchemaChangeProposal`을 수십 건 올리고 사람이 하나씩 승인해야 합니다(06 O-10) | 엔티티·관계 유형 확장, 속성 묶음, 순서형 어휘 | 06 4.1 `ontology_schema_versions.extension`, 07 B2 |
| 연속성 규칙 | CR-01~CR-18은 장르 무관 규칙입니다. 경지 역행, 장문인 2명, 상태창 합계 불일치 같은 **장르 특화 모순**은 CR-06(LLM 판정)에만 기대게 됩니다 | 결정적 사전 필터가 붙은 선언형 규칙 | 06 9절, 07 5.1 P3d |
| 떡밥 패턴 | `foreshadow_manager`가 장르 관습(실전 비급, 원작 파멸 플래그, 회귀 원인)을 매번 새로 떠올립니다 | 설치·강화·회수 힌트가 붙은 패턴 | 03 3.7 `setups`, 07 B4 |
| 용어 표기 | 한자 병기, 외래어 표기, "갑자" 같은 장르 용어의 정의가 작품마다 비어 있습니다 | 용어집 시드와 표기 규칙 기본값 | 06 5절 `glossary_terms`, CR-16 |
| 독자 기대 요소 | FR-NOV-03이 요구하는 사이다 주기, 로맨스 진척, 회차 말 훅 규칙이 아웃라인 입력에 없습니다 | 아웃라인·다듬기 단계의 기본 지표 | 07 B3·P1 `OutlineData.hook`, P4 훅 평가 |

차별점: 확인 범위 내에서 World Anvil·Campfire·Scrivener·Notion 설정집 템플릿은 서술형 필드를 채우게 하고, 서열 단조성·승계·개수·수치 합 같은 **제약을 실행하는 기능은 찾지 못했습니다**[Campfire 해설 G2 [2차], World Anvil G3 [미확인, 페이지 403·검색 요약만], research-genre-world-elements 7절]. 부재 주장이므로 v1 전 재확인 대상입니다. 이 템플릿은 "질문 + 스키마 + 검증 규칙"을 한 묶음으로 둡니다.

### 1.2 목표

| ID | 목표 |
|---|---|
| GT-G1 | 사용자가 컨셉 대화에서 장르·트로프를 고르면, 그 카테고리의 세계관 필수 항목을 빠짐없이 묻고 답을 작품 첫 스키마·용어집·떡밥 후보로 바로 넘깁니다. |
| GT-G2 | 장르 특화 모순을 결정적 사전 필터로 잡아 LLM 판정 의존과 사람 질문을 줄입니다. |
| GT-G3 | 템플릿 추가·수정은 코드가 아니라 데이터 변경(YAML + 시험 시드)으로 끝납니다(NFR-EXT-03). |
| GT-G4 | 템플릿은 기본값일 뿐 사용자가 모든 값을 덮어쓸 수 있고, 덮어쓴 기록이 남습니다(FR-NOV-03 수용 기준). |

### 1.3 성공 기준 (측정 가능)

| ID | 기준 | 목표 | 측정 방법 | 시점 |
|---|---|---|---|---|
| SC-1 커버리지 | 기준일 TOP100 작품 중 L2 템플릿 또는 L3 `full`·`light` 믹스인이 **하나 이상** 붙는 작품 비율(L1만 붙는 작품은 세지 않음. TOP100 100편이 이미 5개 L1에 속하므로 L1 기준은 동어반복) | v1 ≥ 70%(가정). 표본별로 따로 보고 | 작품 소개문 수동 라벨(2인 독립, 불일치는 합의). **전제 조건**: 남성향 표본(네이버 시리즈 주간 TOP100)과 여성향 표본(카카오페이지·리디 랭킹 각 TOP100)을 함께 수집. 여성향 표본이 없으면 SC-1은 "남성향 한정"으로 표기하고 v1 완료 기준에서 뺍니다 | v1, 이후 분기 |
| SC-2 트로프 커버리지 | 장르별 TOP100 상위 키워드 5개 중 L2 템플릿 또는 L3 `full`·`light` 믹스인이 있는 비율. **장르별 값과 그 최소값**을 보고. 분모에서 인물 특성(천재·먼치킨)은 빼고, 복합 키워드("전문직·천재")는 세계관 대상 부분("전문직")만 셉니다. 분모 키 목록은 부록 A L3 목록과 2.2절 L2 목록 | 장르별 최소값 ≥ 60%(가정) | research-webnovel-market 5.1절 표 대조. 참고(2026-10-28 재집계 값으로 재대조): 현판 상위 5개(전문직·천재 21, 연예계 16, 회귀 14, 육아·가족 11, 계약·결혼 8) 중 v1 목록이 덮는 것은 회귀(`full`)·육아(`light`)·계약결혼(`light`) 3개(60%)이고, `modern_fantasy.professional`을 v1에 넣으면 80%입니다(D-33 묶음 결정, 8.3절). 다른 장르 값은 수동 라벨 비교(D-29 선행 조건) 뒤 계산합니다 | v1 |
| SC-3 필수 질문 누락률 | `entry_mode=conversation` 세션에서 승인된 `ConceptBrief`의 `template_required` 질문 대상 슬롯이 `empty`(질문 자체를 하지 않음)인 비율. 사용자가 명시적으로 미뤘거나 "이대로 정리"로 넘긴 슬롯은 `deferred`로 기록되어 `empty`와 따로 셈 | 0% | `field_provenance.slot_state` 집계 | MVP-β부터 |
| SC-3b 빈 슬롯 표시율 | `entry_mode ∈ {import, direct_input}` 세션에서 승인 확인 화면에 "빈 `template_required` 슬롯 목록"이 표시된 비율(이 경로는 질문을 하지 않으므로 SC-3에서 뺌) | 100% | 승인 화면 단위 테스트 | MVP-β부터 |
| SC-4 스키마 적합도 | 검증 작품 30화 동안 나온 `add_entity_type`·`add_relation_type`·`add_attribute` 제안 중 "템플릿에 있어야 했던 장르 관습 항목"으로 분류된 건수 | **측정만**(표본 2작품이라 목표 없음). 참고치 작품당 ≤ 3건(가정) | 분류 기준표(4.4절 관습 인정 기준 + "다른 작품에도 같은 구조가 필요한가")로 2인 독립 분류, 일치도 Cohen's κ 함께 보고 | MVP-β 검증(MB-4) |
| SC-5 규칙 재현율 | 템플릿 규칙별 골든 시드(위반 시드) 중 기대 결과가 난 비율. 시드마다 기대 결과는 **하나**(규칙 키 + 00 `issue_kind` + 심각도, 또는 "이슈 없음") | `high` 규칙 ≥ 0.90, `medium` ≥ 0.80 | 5.1절 시험 세트. 정답 표는 **규칙 작성자와 다른 사람**이 씀(순환 측정 방지) | 템플릿 릴리스마다 |
| SC-6 규칙 오탐률 | 정상 시드에서 이슈가 난 비율 / 실작품에서 사람이 오탐으로 닫은 템플릿 규칙 이슈 비율 | 시드 ≤ 5%, 실작품 ≤ 20%(가정) | 시드 실행(정답 표 작성자 조건은 SC-5와 같음), `continuity_issues` 종결 사유 | 릴리스마다 / MB-4 |
| SC-7 데이터 관리 | (a) 기존 사전 필터만 쓰는 템플릿 추가·수정 PR의 `apps/`·`packages/*/src` 코드 변경 줄 수 (b) 사전 필터 종류를 추가한 PR 수와 줄 수 | (a) 0줄 (b) 목표 없음, 둘 다 보고 | PR diff 검사 | v1 |
| SC-8 빌드 검증 | 릴리스 템플릿의 검증 항목 TV-01~TV-13(3.6절) 통과율, 출처 누락 항목 수, 고유명 금지 목록 일치 수 | 100% / 0 / 0. 금지 목록이 비어 있으면 일치 수는 "측정 불가"로 표기하고 통과로 세지 않음 | 빌드 리포트 | 릴리스마다 |

덮어쓰기 비율은 목표가 아니라 **감시 지표**로 둡니다(5.3절). 기본값이 맞지 않으면 높아지고, 창의적 항목에서 지나치게 낮으면 클리셰 고착 신호입니다.

---

## 2. 시장 조사 요약과 카테고리 체계

### 2.1 시장 조사 요약

| 항목 | 내용 | 등급 |
|---|---|---|
| 시장 규모 | 2020년 6,400억 원 → 1조 390억 원(2021 매출 기준) → 2024년 1조 3,500억 원. 조사 주관은 문체부·한국출판문화산업진흥원, 2년 주기. 2026년판은 아직 미발표 | [2차] S1·S2, 2026년판 [미확인] |
| 이용자·플랫폼 | 이용자 약 587만 명, 2022 조사에서 네이버·카카오페이지 매출이 약 80% | [2차] S2·S3 |
| 플랫폼 1단 장르 | 공통 핵심은 로맨스·로판·판타지·현판·무협. 플랫폼에 따라 BL·라이트노벨·미스터리·대체역사·스포츠·SF·드라마·전쟁밀리터리·게임·퓨전·공포 추가 | [1차] 네이버 시리즈·네이버 웹소설·문피아·리디·노벨피아·조아라. 카카오페이지 [2차] |
| 트로프의 위치 | 확인한 국내 플랫폼에서 회귀·빙의·헌터·아카데미는 1단 장르가 아니고 태그·키워드 층. 해외 Wattpad는 "Isekai and Reincarnation"을 하위 장르로 둠 | [1차, 네이버 시리즈·네이버 웹소설·문피아·노벨피아·리디 한정. 카카오페이지 [2차], 조아라 하위 분류 [미확인]]. Wattpad [1차] S18 |
| 랭킹 구성 | 2026-10-28 네이버 시리즈 주간 TOP100: 현판 46, 무협 22, 판타지 20, 로판 8, 로맨스 4 | [1차 데이터, 직접 집계, 재수집으로 같은 값 재현]. 재현 자료: `docs/research/data/naver-series-top100-2026-10-28/`(원본 HTML 45·`top100.csv`·스크립트·`SHA256SUMS`, research-webnovel-market 5.1) |
| 장르별 상위 트로프 | 현판: 전문직·천재 21, 연예계 16, 회귀 14, 육아·가족 11, 계약·결혼 8 / 판타지: 시대(황제·전쟁) 21, 헌터·게이트·던전 13, 빙의·회귀·귀족·황실 각 11 / 무협: 문파·세력 50, 전문직·천재 20, 육아·가족 18, 환생 11, 회귀 10 / 로판: 귀족·황실 48, 계약·결혼 45, 육아·가족 34, 빙의 17, 악녀 15 / 로맨스: 계약·결혼 42, 육아·가족 35, 재벌·기업 26 | [1차 데이터, 정규식 휴리스틱 재집계(`keyword_counts.csv`), 수동 라벨 검증 전]. 같은 재현 자료. 최초 집계와 차이(판타지 헌터 17→13, 로맨스 1위 육아→계약·결혼 등)는 정규식 범위 차이[추론] |
| 성장 신호 | 2026 지상최대 공모전 무협특별상 신설·접수 약 35% 증가, 현판 단독 공모전, 무협·선협 단독 공모전 | [2차] S11~S13 |
| 연구 근거 | 회빙환은 장르를 가로지르는 마스터 플롯(김경애 2024), 시스템 모티프는 상태창·퀘스트가 메타데이터·서사 동력(서재인 2025), 책빙의물은 원작 지식으로 파멸 예언 세계에서 생존(안상원 2020) | [1차] |

해석상 주의[추론]: 네이버 시리즈는 남성향 비중이 큰 랭킹이라 로판·로맨스 비중이 낮게 나옵니다. 여성향 비중이 큰 카카오페이지·리디 랭킹은 이번에 수집하지 못했습니다(research-webnovel-market 9절). 그래서 로판의 우선순위는 랭킹 수치만으로 낮추지 않습니다.

### 2.2 3층 + 패싯 체계

| 층 | 식별자 형식 | 개수(초안) | 작품당 | 템플릿 단위 | 06 연결 |
|---|---|---|---|---|---|
| L1 세계 장르 `genre` | `wuxia` | 11(`light_novel_world` 제외, 아래 해소표) | 1개(필수) + 보조 L1 0~1개(`secondary_genre`) | **장르 템플릿**(묶음의 기본 단위) | 엔티티·관계·서열 어휘의 기본 묶음 |
| L2 하위 장르 `subgenre` | `modern_fantasy.hunter_gate` | L1당 2~6(research-webnovel-market 7.2절) | 0~2개 | **하위 장르 템플릿**(L1 상속 + 차이분) | 속성 묶음(등급 체계, 작위 서열 등) |
| L3 트로프 태그 `trope` | `rebirth.regression` | 25(부록 A 전체 목록) | 여러 개 | **트로프 믹스인**(3단계 깊이, 아래 표) | 제약·연속성 규칙·떡밥 패턴·질문 |
| 패싯 `audience_format` | `bl`, `gl`, `light_novel`, `male_oriented`, `female_oriented` | 5 | 0~n | 패싯 템플릿(v1 이후) | 연령 등급·문체 기본값, 관계 어휘 |

**개념 1개 = 키 1개 원칙**: 같은 개념이 두 층에 있으면 사용자 선택이 갈리고, 척도 "소유 템플릿 1곳" 규칙(TV-04)과 충돌합니다. 그래서 층을 다음처럼 나눕니다.

| 축 | 층 | 예외 |
|---|---|---|
| 무대·직업(한 L1 안에서 쓰임) | L2만 | 여러 L1을 가로지르는 무대(아카데미, 제국·궁중)는 L3 `stage.*`로 두고 같은 개념의 L2를 만들지 않습니다 |
| 장치·능력 체계·관계·서사 장치 | L3만 | L1 자체가 그 능력 체계인 경우(무협 = 내공·경지)는 L1이 소유하고 L3 키를 두지 않습니다 |
| 같은 개념의 다른 이름 | 정식 키 하나 + `aliases[]` | 별칭은 선택지·키워드 검색에만 쓰고 템플릿을 갖지 않습니다 |

**중복 해소표** (research-webnovel-market 7.2·7.3 키에서 상속한 중복)

| 중복 쌍 | 정식 키 | 처리 |
|---|---|---|
| 패싯 `light_novel` ↔ L1 `light_novel_world` | 패싯 `light_novel` + L1(`fantasy` 등) | `light_novel_world`를 L1에서 뺍니다. 그 L2 `isekai`는 `rebirth.possession`·`rebirth.reincarnation` 별칭, `school`은 `stage.academy` 별칭 |
| `stage.gate_dungeon` ↔ `modern_fantasy.hunter_gate` | L2 `modern_fantasy.hunter_gate` | 판타지 작품의 게이트·던전은 `fantasy.dungeon_tower`. `stage.gate_dungeon`은 두 L2의 별칭(주 L1로 해석) |
| `stage.tower` ↔ `fantasy.dungeon_tower` | L2 `fantasy.dungeon_tower` | 별칭 |
| `stage.apocalypse` ↔ `sf.apocalypse` | L2 `sf.apocalypse` | 별칭. 현판 아포칼립스는 주 L1 `modern_fantasy` + 보조 L1 `sf`로 표현 |
| `stage.occult` ↔ `modern_fantasy.occult` | L2 `modern_fantasy.occult` | 별칭 |
| `stage.estate` ↔ `fantasy.estate` | L2 `fantasy.estate` | 별칭 |
| `profession.*`(L3) ↔ `modern_fantasy.professional`·`.entertainment`·`.sports`·`.chaebol_business`, `romance.office` | L2 | `profession.medical`·`.legal`·`.chef` → `modern_fantasy.professional`(로맨스면 `romance.office`), `.idol_actor` → `.entertainment`, `.athlete` → `.sports`, `.chaebol` → `.chaebol_business`. 모두 별칭 |
| `ability_system.cultivation`·`stage.murim_factions` ↔ L1 `wuxia` | L1 `wuxia` | 별칭. 무협이 아닌 L1 작품에서 고르면 보조 L1 `wuxia`로 해석하고 컨셉 대화에서 확인 |
| `era.real_history` ↔ L1 `alt_history` | L1 `alt_history` | 별칭. 다른 L1이면 보조 L1 `alt_history`(D-33 정책 적용) |
| `romance.historical` ↔ `romance_fantasy.eastern_court` | 둘 다 유지 | 중복이 아니라 경계 규칙으로 나눕니다. `romance.historical` = 실제 시대 배경(조선 등, 실존 인물 정책 적용), `romance_fantasy.eastern_court` = 가상 동양풍 궁중. 궁중 서열·계승 정의는 둘 다 L3 `stage.imperial_court`를 씁니다 |
| `ability_system.awakening_rank` ↔ `modern_fantasy.hunter_gate`의 `hunter_rank` | 척도 소유 = `modern_fantasy.hunter_gate` | `awakening_rank`는 `label`(템플릿 내용 없음)로 낮춥니다 |

L3 태그는 세계관 규칙을 얼마나 담는지에 따라 믹스인 깊이를 나눕니다. 태그 25개 전부에 규칙을 만들지 않습니다.

| `mixin_level` | 담는 것 | 예 |
|---|---|---|
| `full` | 스키마 확장 + 연속성 규칙 + 떡밥 패턴 + 질문 + 독자 기대 | `rebirth.regression`, `rebirth.possession`, `rebirth.book_possession`, `rebirth.reincarnation`, `ability_system.status_window`, `stage.academy`, `stage.imperial_court` |
| `light` | 질문 + 떡밥 패턴 + 독자 기대(스키마·규칙은 기존 키 재사용 또는 소량) | `relation.contract_marriage`, `relation.villainess`, `relation.childcare_family`, `plot.revenge`, `plot.misunderstanding` |
| `label` | 태그만(해외 매핑·키워드 표시용). 템플릿 내용 없음 | `plot.munchkin`, `plot.healing`, `relation.regret`, `ability_system.awakening_rank` |

장르·하위 장르 템플릿에는 내용 수준 `content_level`을 둡니다. `questions_only` = 질문·용어집 시드·떡밥 패턴·독자 기대만(스키마 확장·연속성 규칙 없음, `base@1`에서도 로드 가능), `full` = 전체 구성 요소. 믹스인의 `light`와 같은 수준입니다.

**식별자 통일**: 두 조사 문서의 키가 다릅니다(시장 조사 `wuxia`·`modern_fantasy`, 세계관 조사 `murim`·`modern_fantasy_hunter`). 플랫폼 메뉴와 대응이 쉬운 시장 조사 키를 기준으로 통일하고 위 중복 해소표를 적용합니다(D-31(DG-03) 확정).

| 세계관 조사 키 | 통일 키(제안) | 층 |
|---|---|---|
| `murim` | `wuxia` | L1 |
| `high_fantasy` | `fantasy.high_fantasy` | L2 |
| `modern_fantasy_hunter` | `modern_fantasy.hunter_gate` | L2 |
| `romance_fantasy` | `romance_fantasy` | L1 |
| `contemporary_romance` | `romance.contemporary` | L2 |
| `alt_history` | `alt_history` | L1 |
| `sci_fi` | `sf` | L1 |
| `sports`, `entertainment` | `modern_fantasy.sports`, `modern_fantasy.entertainment` | L2 |
| `regression`, `possession`, `reincarnation` | `rebirth.regression`, `rebirth.possession`(`rebirth.book_possession` 별도), `rebirth.reincarnation` | L3 `full` |
| `system`, `game_world` | `ability_system.status_window`(L3 `full`), `fantasy.game`(L2) | L3 / L2 |
| `academy` | `stage.academy` | L3 `full` |

### 2.3 플랫폼 대응표 요약

○ 독립 1단 장르, △ 하위 분류·다른 장르에 포함, — 없음, ? 미확인. 전체 표는 research-webnovel-market 4절입니다.

| 통일 키 | 네이버 시리즈 | 카카오페이지 | 문피아 | 리디 | 노벨피아 | 해외(Wattpad 2026 분류, S18) |
|---|---|---|---|---|---|---|
| `romance` | ○ | ○ | ○ | ○ 현대물·역사/시대물 | ○ | Romance |
| `romance_fantasy` | ○ 로판 | ○ | — | ○ 동양풍·서양풍·가상 세계 | △ | Romance + Fantasy |
| `fantasy` | ○ | ○ | ○ | ○ 정통·퓨전 | ○ | Fantasy |
| `fantasy.fusion` | △ 판타지 | ? | **○ 퓨전(1단)** | △ 판타지 > 퓨전 | △ | Fantasy |
| `fantasy.game` | △ 판타지 | ? | **○ 게임(1단)** | △ e북 게임 판타지 | △ 태그 | Science Fiction > LitRPG |
| `modern_fantasy` | ○ 현판 | ○ | ○ 현대판타지 | △ 판타지 > 현대 판타지 | ○ | Fantasy / Paranormal |
| `wuxia` | ○ | ○ | ○ | △ 판타지 > 무협 소설 | ○ | Fantasy > Wuxia and Cultivation |
| `alt_history` | △ | ? | ○ | △ e북 | ○ | Historical > Alternate Reality |
| `sf` | — | ? | ○ | — | ○ | Science Fiction |
| `drama` | — | ? | ○ 드라마(1단) | — | △ 현대 | — |
| `mystery_horror.mystery` | ○ 미스터리(1단) | ? | △ 기타 | — | — | Mystery |
| `mystery_horror.horror` | — | ? | △ 기타 | — | ○ 공포(1단) | Horror |
| 패싯 `bl` | ○ | ? | △ | ○ | △ 태그 | LGBTQ+ |

문피아 1단 장르와의 차이: 문피아는 퓨전·게임·드라마를 1단(○)으로 둡니다. 템플릿은 `drama`를 L1로 두지만, 퓨전·게임은 L2 `fantasy.fusion`·`fantasy.game`으로 둡니다. 이유: 다른 플랫폼(네이버·리디·노벨피아)에서는 판타지 하위 분류이고, 세계관 구조가 판타지 L1의 엔티티·관계를 그대로 상속하고 차이분(게임 시스템·현실 결합)만 더하면 표현되기 때문입니다[추론]. 문피아로 내보낼 때는 `platform_mapping`이 1단 장르로 되돌립니다. `mystery_horror`는 L1 하나로 두되, 네이버 "미스터리"와 노벨피아 "공포"가 서로 다른 1단 장르이므로 L2 `mystery`·`horror`로 나눠 대응합니다.

해외 분류는 다중 라벨 구조입니다(Wattpad 장르 최대 3개 × 하위 장르 3개[1차] S17, 하위 장르 이름은 S18). 템플릿 헤더에 `platform_mapping`·`overseas_mapping`을 두어 내보내기·키워드 추천에 씁니다(D-1(b)).

### 2.4 1차 구축 대상 선정 기준

| 기준 | 정의 | 가중치(가정) | 데이터 |
|---|---|---|---|
| C1 시장 비중 | 네이버 시리즈 TOP100 장르 비중 + 플랫폼 공통 1단 장르 여부. 여성향 랭킹 미수집을 보정하려고 리디·카카오 1단 장르 여부를 함께 봄 | 0.30 | 2.1절 |
| C2 성장 신호 | 2025~2026 공모전 신설·단독 공모전, 트렌드 분석 | 0.10 | 2.1절 |
| C3 세계관 규칙 밀도 | 구조 패턴 P1~P7(서열 능력, 신분 서열, 조직 계층, 수치 장부, 칭호 승계, 화자 의존 호칭, 다층 지식) 중 해당 수. 많을수록 템플릿의 연속성 효과가 큼 | 0.30 | research-genre-world-elements 2절 |
| C4 MVP-β 정합 | PRD 8절 MVP-β (1) "장르 2개, 그중 1개는 다중 시간선 회귀물"에 바로 쓰이는가. 06 MVP-β 기능(다중 시간선·용어집·빙의 모델)과 맞는가 | 0.25 | PRD 8절, 09 MB-2 |
| C5 정책 위험(감점) | 실존 인물·단체 의존(NFR-SAFE-02, 06 O-19), MVP `age_15` 이하 제한(D-13)과 충돌하는 태그 의존 | −0.05~−0.15 | research-genre-world-elements 4.6절, research-webnovel-market 1절 6번 |

### 2.5 우선순위

점수는 위 가중치로 낸 상대값(5점 척도 환산)이고, 판단은 [추론]입니다.

| 순위 | 대상 | 층 | C1 | C2 | C3 | C4 | C5 | 단계 | 이유 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `rebirth.regression` | L3 `full` | 5 | 3 | 4 | 5 | 0 | **MVP-β** | 검증 작품 B(회귀물) 필수. 현판(14)·판타지(11)·무협(10) 상위 키워드(재집계). 06 3.13 시간선 모델을 그대로 씀 |
| 2 | `wuxia` | L1 | 4 | 5 | 5 | 4 | 0 | **MVP-β** | TOP100 22편, 무협특별상 신설. P1~P6 모두 해당(경지·항렬·문파·내공·장문인·사문 호칭). 단일 시간선으로 검증 작품 A에 적합 |
| 3 | `modern_fantasy` + `.hunter_gate` | L1 + L2 | 3 | 4 | 4 | 5 | −1 | **MVP-β**(`questions_only`), 규칙은 v1 | C1은 L1 점유율이 아니라 L2 키워드 출현으로 봅니다: 현판 TOP100 헌터·게이트 4 + 판타지 TOP100 헌터·게이트·던전 13[1차 데이터, 휴리스틱 재집계. 최초 집계 7 + 17에서 감소]. C1 점수 3은 재집계 값으로도 유지합니다[추론: 판타지 2위 묶음]. C4는 PRD 5.1 시나리오(회귀 헌터 복수)와 같고, 구조 패턴 P1(등급 서열)·P3(협회·길드 조직)·P5(길드장 칭호)에 해당해 규칙 밀도가 높습니다. 실제 국가·지명 사용은 감점 |
| 3-대안 | `modern_fantasy` + `.professional` | L1 + L2 | 5 | 4 | 2 | 4 | −2 | 비교용(D-29 선택지 (d)) | 현판 TOP100 상위 키워드 1위(전문직·천재 21, 그중 세계관 대상은 "전문직"). 규칙 밀도는 직급·소속·경력 연표(P3 일부) 정도로 낮고, 실존 단체(병원·로펌·방송사) 의존이 커서 D-33 정책 감점 |
| 4 | `romance_fantasy` + `.western_court` | L1 + L2 | 3(보정 4) | 3 | 5 | 2 | 0 | v1 1차 | 여성향 핵심 축. 작위 서열·승계·경칭이 P2·P5·P6에 해당 |
| 5 | `rebirth.book_possession`, `rebirth.possession` | L3 `full` | 4 | 3 | 4 | 3 | 0 | v1 1차 | 로판·판타지에서 상위. `source_work` 시간선(B-8)이 필요해 MVP-β 범위 밖 |
| 6 | `ability_system.status_window` | L3 `full` | 4 | 3 | 5 | 2 | 0 | v1 1차 | 수치 장부(B-7)의 대표 사례, 판타지·현판 공통 |
| 7 | `fantasy` (+`.high_fantasy`, `.estate`, `.dungeon_tower`) | L1 + L2 | 4 | 2 | 4 | 2 | 0 | v1 1차 | TOP100 20편 |
| 8 | `romance` (+`.contemporary`, `.office`) | L1 + L2 | 3(보정 4) | 2 | 2 | 2 | 0 | v1 1차 | 이용자 선호 1위(현실 로맨스 장르 47.4%, 2022 실태조사(2021 기준)[2차] S2). 규칙 밀도는 낮음 |
| 9 | `stage.academy`, `rebirth.reincarnation`, `stage.imperial_court` | L3 `full` | 3 | 2 | 3 | 1 | 0 | v1 1차 | 여러 L1에 얹힘. 아카데미는 포화 우려[2차]라 변형 질문 필수 |
| 10 | `relation.contract_marriage`, `relation.villainess`, `relation.childcare_family`, `plot.revenge`, `plot.misunderstanding` | L3 `light` | 4 | 2 | 2 | 1 | 0 | v1 1차 | 로판·로맨스 상위 키워드. 질문·떡밥 패턴 위주 |
| 11 | `alt_history`, `modern_fantasy.sports`, `modern_fantasy.entertainment`, `modern_fantasy.professional` | L1 / L2 | 3~5 | 4 | 2~3 | 1 | −3 | v1 2차(D-33 확정(방침)) | 실존 인물·단체가 장르 핵심 재료. D-33 방침 A 확정, 기준 연도·목록 출처는 법률 검토(D-12)와 함께 정하고 그때까지 배포 보류. `professional`은 v1 2차 유지(1차 미포함, D-33)(SC-2 현판 값 60% 기준) |
| 12 | `sf`, `mystery_horror`, `drama`, `war_military` | L1 | 1~2 | 1 | 2~3 | 0 | 0 | 이후 | 1단 장르인 플랫폼이 적음. 라이트노벨은 L1이 아니라 패싯(2.2절) |
| — | 하렘·TS·피폐 등 수위 연동 태그, 패싯 `bl` | L3 / 패싯 | — | — | — | — | −5 | 보류 | MVP `age_15` 이하(D-13). D-34(DG-06) 확정: MVP 미노출, 성인 등급 결정 때 재검토 |

**MVP-β 검증 장르 2개(확정(조건부), D-29(DG-01))**: 작품 A = `wuxia`(단일 시간선), 작품 B = `modern_fantasy` + `.hunter_gate` + `rebirth.regression`(다중 시간선 회귀물). 두 작품이 서로 다른 L1이라 템플릿 합성 규칙(L1 + L2 + L3)을 모두 시험할 수 있습니다. "남성향 상위 2개 장르(68편)"는 **L1 기준**(무협 22 + 현판 46)이고, 작품 B가 대표하는 헌터·게이트 하위 장르의 비중은 그보다 훨씬 작습니다(현판 4 + 판타지 13 키워드 출현, 재집계). **재검토 조건**: research-webnovel-market 9절의 표본 50편(장르별 10편) 수동 라벨과 정규식 결과를 비교해 상위 5개 묶음 순위가 바뀌면 이 선택을 다시 봅니다. 작품 B 선택 근거는 비중보다 PRD 5.1 시나리오 일치와 규칙 밀도입니다. 대안: (b) 작품 B를 `romance_fantasy` + `rebirth.regression`(여성향 검증 장점, 빙의 결합 시 `source_work`(B-8) 필요 위험), (d) `modern_fantasy.professional` + `rebirth.regression`(시장 비중 최대, 규칙 밀도 낮음·실존 단체 감점).

MVP-β 템플릿 수준(6절 공수 대조 결과): `wuxia`·`rebirth.regression`은 `full`, `modern_fantasy`·`.hunter_gate`는 `questions_only`(질문·용어집·떡밥 패턴)로 두고 헌터 규칙(GT-H)은 v1로 미룹니다.

---

## 3. 템플릿 데이터 모델

### 3.1 구성 개요

```
base@2 (06 기본 스키마, 릴리스로만 변경)
  └ shared.* 공통 라이브러리 (공유 키: skill, species, contract_relationship, 경칭 표, 사문·선후배 호칭)
      └ L1 장르 템플릿 (wuxia, romance_fantasy, ...)
          └ L2 하위 장르 템플릿 (extends L1)
              └ L3 트로프 믹스인 0~n개 (rebirth.regression, ability_system.status_window, ...)
                  └ 사용자 덮어쓰기 (컨셉 대화, 기록 남김)
                      └ 작품 첫 OntologySchema 버전 (복사본) → 이후 06 4.5 변경 제안
```

| `template_kind` | 설명 | 예 |
|---|---|---|
| `shared` | 둘 이상 템플릿이 쓰는 정의의 유일한 출처. 같은 키를 다른 템플릿이 다시 정의할 수 없음 | `shared.honorifics_court`(경칭: 폐하·전하·각하·영애), `shared.honorifics_common`(의형제·혈연 형제 등 장르 공통 관계 호칭. 사문 호칭은 `wuxia` 소유), `shared.contract_relationship`, `shared.species`, `shared.skill`(시스템 스킬·능력 공통 유형) |
| `genre` | L1. `content_level` 필수 | `wuxia` |
| `subgenre` | L2. `extends`로 L1 하나를 상속. `content_level` 필수 | `modern_fantasy.hunter_gate` |
| `trope_mixin` | L3. 여러 L1에 얹힘. `mixin_level` 필수 | `rebirth.regression` |
| `facet` | 패싯(v1 이후) | `bl` |

### 3.2 헤더 필드 (`GenreTemplate`)

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `key` | text | Y | 카테고리 식별자(2.2절 통일 키). 영어 소문자·점 구분 |
| `version` | semver | Y | 3.6절 버전 규칙. 작품은 `key@version`과 컴파일 해시를 기록 |
| `template_kind` | enum | Y | 3.1절 표 |
| `mixin_level` | enum | `trope_mixin`이면 Y | `full` / `light` / `label` |
| `content_level` | enum | `genre`·`subgenre`면 Y | `questions_only` / `full`(2.2절). `questions_only`에 `schema_extension`·`ordinal_scales`·`continuity_rules`가 있으면 TV-01 오류 |
| `priority` | int | 믹스인이면 Y | 합성 순서(작을수록 먼저, 3.3절) |
| `aliases[]` | text[] | N | 별칭 키(2.2절 중복 해소표). 선택지·검색에만 쓰임 |
| `label_ko`, `description_ko` | text | Y | 표시 이름과 한 문단 설명 |
| `status` | enum | Y | `draft` → `reviewed` → `released` → `deprecated`. 앱에는 `released`만 노출(개발 빌드는 `reviewed` 포함) |
| `requires_base` | text | Y | 필요한 기본 스키마(예: `base@2`). 앱의 기본 스키마가 낮으면 로드 거부 |
| `requires_features` | text[] | N | 작품 기능 전제(예: `multi_timeline`(MVP-β), `possession_model`, `source_work_timeline`) |
| `extends` | text | `subgenre`면 Y | 상속할 L1 키 |
| `uses_shared` | text[] | N | 가져올 공통 라이브러리 `key@major` |
| `conflicts_with` | text[] | N | 합성 금지 목록. 조합 허용은 `applies_to_genres`와 이 목록만으로 정합니다(`compatible_with`는 두지 않음, 3.3절) |
| `applies_to_genres` | text[] | 믹스인이면 Y | `"*"` 또는 L1 키 목록 |
| `variants[]` | object[] | N | `{when: {all_of: [키...]}, patch}`. 함께 선택된 L1·L2·믹스인 키가 `all_of`를 모두 포함할 때만 `patch`(구성 요소 차이분)를 합칩니다. 믹스인 × L1, 믹스인 × 믹스인 조건을 모두 표현(예: 회귀 × 무협 = 전생 무공 숙련 질문, 회귀 × 상태창 = 레벨·스탯 이월 규칙) |
| `platform_mapping`, `overseas_mapping` | map | N | 2.3절 대응. 키워드 추천·내보내기용 |
| `safety_profile` | object | Y | `real_person_check`(`default`/`strict`), `age_rating_max_default`, `requires_policy`(예: D-33) |
| `sources[]` | object[] | Y | 4.3절 출처 기록 형식 |
| `reviewers[]`, `changelog[]` | object[] | `released`면 Y | 검수 기록(4.2절 S5), 버전별 변경 요약 |

본문 구성 요소(모두 선택, 3.4절): `schema_extension`, `ordinal_scales`, `attribute_bundles`, `ledgers`, `title_defs`, `address_rules`, `continuity_rules`, `setup_patterns`, `glossary_seed`, `concept_questions`, `reader_expectations`.

### 3.3 합성 규칙과 충돌 해결

**합성 순서**(결정적): `base` → `shared`(이름순) → L1 → 보조 L1(있으면, 아래 별도 규칙) → L2(최대 2개, 이름순) → L3 믹스인(`priority` 오름차순, 같으면 이름순) → 사용자 덮어쓰기 → 작품 확장.

구성 요소마다 "정의"와 "값"을 다르게 다룹니다. 정의(유형·관계·척도)는 덮어쓰지 않고, 값(기본값·심각도·수치 범위)은 뒤 층이 이깁니다.

| 구성 요소 | 합성 방식 | 같은 키 충돌 | 허용되는 수정 연산 |
|---|---|---|---|
| 엔티티 유형 | 합집합 | 정의가 완전히 같으면 하나로, 다르면 **빌드 오류**. 공유 키는 `shared`에서만 정의 | `add_attributes_allowed` |
| 관계 유형 | 합집합 | 같음 | `add_synonyms`, `tighten`(개수 1로 좁히기, `disjoint_with` 추가). 제약 완화는 템플릿에서 금지하고 사용자 덮어쓰기에서만(기록 필수) |
| 속성 | 합집합 | 같음 | `add_exception_events`(B-3 예외 사건 추가) |
| 순서형 척도 | 소유 템플릿 1곳 | 다른 템플릿이 같은 키 정의 시 빌드 오류 | `add_levels`(척도가 `open_top`일 때 위쪽만), `rename_label`(표시 이름만) |
| 칭호·호칭 | 합집합 | 같은 표기·같은 조건이면 하나로, 표기만 같고 조건이 다르면 둘 다 둠(06 3.7 화자 조건으로 해석) | `override_condition`(뒤 층이 이김, 기록) |
| 연속성 규칙 | 합집합(키 `<template>.<rule>`) | 키가 템플릿 접두사라 충돌 없음 | `severity_override`, `disable`(뒤 층이 이김, 이유 필수) |
| 떡밥 패턴 | 합집합 | 같은 키는 빌드 오류 | — |
| 용어집 시드 | 합집합 | 같은 표제어·다른 정의 → 빌드 오류(허용 조합일 때). 표기 규칙만 다르면 뒤 층이 이김 | `override_spelling` |
| 컨셉 질문 | **11 3.6 조합 규칙을 그대로 따릅니다**(순서: 공통 → 장르 → 하위 장르 → 트로프, 같은 `fills`는 먼저 오는 하나만 묻기, 상한 `concept.max_template_questions`). 이 계획서는 같은 층 안 순서(= YAML 배열 순서)만 정합니다 | 11 3.6 | `override_ask`, `override_default_value` |
| 독자 기대 | 키별 합성 연산(아래 표) | 아래 표 | `override_value` |
| 안전 프로필 | 더 엄격한 쪽 | — | 완화 불가(사용자 덮어쓰기로도 불가) |

**독자 기대 키별 합성 연산** (표에 없는 키를 쓰면 TV-01 오류)

| 키 | 형식 | 연산 | 결과가 비거나 충돌할 때 |
|---|---|---|---|
| `cider_cycle_episodes` | 범위 | 교집합 | 빈 교집합 → 빌드 시험 조합이면 TV-09 오류, 런타임 조합이면 컨셉 대화에서 값 질문 |
| `future_knowledge_payoff_every_episodes` | 범위 | 교집합 | 같음 |
| `max_frustration_run` | 정수 | 최솟값 | — |
| `episode_end_hook.required` | bool | OR | — |
| `episode_end_hook.preferred_kinds` | 배열 | 합집합(층 순서 유지, 중복 제거) | — |
| `episode_end_hook.forbid_repeat_kind_run` | 정수 | 최솟값 | — |
| `episode1_promise` | 텍스트 | 층 순서대로 이어 붙인 뒤 사용자 확인 | 컨셉 대화 `converging`에서 `serial_plan.episode1_hook` 후보로 보여 주고 사용자가 고침 |
| `romance_progress` | 객체 | 단일 소유(정의한 템플릿 1곳) | 둘 이상 정의 → 빌드 시험 조합이면 TV-09 오류, 런타임 조합이면 주 L1 값 사용 + 질문 |
| `growth_milestone.kinds` / `.per` | 배열 / enum | 합집합 / 주 L1 값 | — |

**보조 L1**(`secondary_genre`, 예: 현판 + 대체역사): 보조 L1은 `schema_extension`·`ordinal_scales`·`title_defs`만 가져오고 질문은 `template_required` 질문만 가져옵니다. 독자 기대는 주 L1 값을 씁니다. 가정: 크로스 장르는 이 정도면 표현됩니다(research-webnovel-market 7.1절).

**조합 허용 규칙**

| 경우 | 처리 |
|---|---|
| 믹스인의 `applies_to_genres`에 주 L1이 없음, 또는 어느 쪽 `conflicts_with`에 상대가 있음 | 금지. 컨셉 대화 선택지에서 숨김 |
| 위에 해당하지 않음 | 허용. 빌드 시험 범위(TV-09)에 없으면 "허용, 미시험" 경고를 컨셉 세션에 표시 |
| 런타임 조합(보조 L1·사용자 선택 믹스인)에서 엔티티·관계 정의가 충돌(같은 키, 다른 정의) | 빌드 오류로 두지 않습니다. 컨셉 대화가 "주 장르 정의 채택 / 보조 장르(또는 해당 믹스인) 제외"를 묻고, 답을 `template_overrides`에 남깁니다 |

**사전 필터 평가 범위 규칙** (다중 시간선 작품)

| 규칙 | 내용 |
|---|---|
| E-1 계보 위에서 평가 | 모든 템플릿 `prefilter`는 06 Q1 계보 해석 결과(같은 `timeline_id`의 사실 + 06 6.3 상속분, 부모는 `rewind_to_story_point`에서 평가) 위에서 평가합니다 |
| E-2 시간선을 넘는 비교 금지 | `story_point`를 시간선을 넘어 비교하지 않습니다. 부모 시간선에서 `rewind_to_story_point` 이후에 생긴 상태(예: `cleared`된 게이트, 상승한 등급)는 자식 시간선에 상속되지 않으므로 자식에서 "다시 열림"·"등급 하락"으로 보지 않습니다 |
| E-3 회귀 분기 예외 | 회귀 시간선 첫 지점에서 상속값과 다른 값이 처음 나타나면 `regression_branch` 예외 사건으로 취급합니다(단조·변경 사건 규칙의 예외 사건 목록에 자동 포함) |
| E-4 이월 | 회귀자가 각성 전에 능력을 쓰는 경우처럼 이전 시간선 능력을 쓰면, `timeline_carry_check`가 이월 사실을 찾고, 이월 사실이 있으면 `ability_before_event` 계열 규칙의 예외로 둡니다 |

**알려진 조합 처리**(빌드 시험 대상, TV-09)

| 조합 | 기준 척도 | 무공·스킬 유형 매핑 | 장부·수치 리셋·이월 | 비활성화·조정 규칙 |
|---|---|---|---|---|
| 헌터 + 상태창 | 세계 서열·호칭 기준 = `hunter_rank`(협회 측정). `level`은 시스템 내부 척도로 공존 | 시스템 스킬 = `shared.skill` | 단일 시간선이라 리셋 없음 | 없음 |
| **헌터 + 회귀**(작품 B) | `hunter_rank` | 각성 능력 = `shared.skill` | 회귀 시 등급·각성은 E-3으로 새로 시작, 이월은 E-4 | `modern_fantasy.hunter_gate.gate_no_reopen`·`.rank_change_requires_event`·`.skill_before_awakening`은 E-1~E-4로 평가(규칙 끄지 않음). GT-HR01 정상 시드로 오탐 없음 확인 |
| **무협 + 회귀 + 상태창** | 호칭·서열 조건(`target_title_rank_*` 등)의 기준 = `murim_realm`. `level`은 시스템 내부 척도 | 같은 대상이면 `martial_art` 하나로 두고 시스템 표시는 속성 `system_listed: true`. `skill` 엔티티를 따로 만들지 않음 | 회귀 시 `level`·스탯 장부는 새 시간선에서 E-3으로 재시작. `sum` 불변식은 시간선별로 다시 계산. 이월 항목은 이월 사실 + 장부 `carry_over` 성분 | `ability_system.status_window.level_no_regression`은 E-3 예외로 평가. 끄는 규칙 없음 |
| **무협 + 상태창** | `murim_realm`(서열·호칭), `level`(시스템) 공존 | 위와 같음(`martial_art` + `system_listed`) | 단일 시간선 | 없음 |
| 로판 + 책빙의 + 회귀 | `peerage` | — | `source_work`와 `regression` 시간선이 동시에 존재. 원작 지식과 회귀 기억은 `knows_fact` 대상 시간선으로 구분 | 없음(v1) |
| 시스템 칭호 vs 직위 칭호 | — | 시스템 업적은 `system_title`(ability 하위)로 분리. 06 `title`은 보유자 승계 의미 | — | — |
| 무협 + 환생 | `murim_realm` | 전생 인물은 별도 `character` + `reincarnation_of`. `persona`/`body` 불필요 | 전생 능력은 `reincarnation_of` 경로의 이월 사실로만 | 없음 |

`variants`로 표현하는 예: 회귀 믹스인의 `{when: {all_of: [rebirth.regression, ability_system.status_window]}, patch: {ledgers: [...carry_over 성분]}}`, 상태창 믹스인의 `{when: {all_of: [ability_system.status_window, wuxia]}, patch: {schema_extension: {attributes_allowed_add: {martial_art: [system_listed]}}}}`.

### 3.4 구성 요소별 스키마

#### (a) 엔티티 유형 확장 `schema_extension.entity_types`

06 4.1 `EntityTypeDef`를 그대로 씁니다. 추가 규칙: `parent`는 필수이고 `base` 유형 또는 `shared` 유형이어야 합니다(기본 질의·CR이 확장 유형을 놓치지 않게, 06 4.1 하위 관계 폐포와 같은 원리).

#### (b) 관계 유형 확장 `schema_extension.relation_types`

06 4.1 `RelationTypeDef` 그대로. 템플릿이 반드시 채울 항목:

| 항목 | 규칙 |
|---|---|
| 정의역·치역 `domain`/`range` | 기본 유형 또는 확장 유형 키. 조직 → 조직 소속처럼 기본 정의역 밖은 새 키(예: `allied_member_of`) |
| 개수 `max_per_subject`/`max_per_object` | 장르 관습상 1이면 명시(예: `betrothed_to` 동시 1) |
| 시간 제약 `temporal` | 06 `TemporalRule` + B-3 예외 사건 형식 |
| `parent_key` | 의미가 같은 하위 관계만(예: 전속 기사 `sworn_knight_of` → `subordinate_of`). 의미가 다르면 별도 키(의형제 `sworn_sibling_of`는 `sibling_of` 하위 아님) |
| `synonyms`, `inverse_synonyms` | 장르 어휘. 4.6 같은 의미 검사에 쓰임 |
| `default_severity` | 위반 시 기본 심각도 |

#### (c) 속성 묶음 `attribute_bundles`

| 필드 | 설명 |
|---|---|
| `key`, `label_ko` | 묶음 이름(예: `wuxia.cultivation`) |
| `attributes[]` | `AttributeDef` + B-1 `value_type: "ordinal:<scale>"` 또는 `enum: [...]` 또는 정수·문자열. B-2 `numeric: {unit, min, max, integer}`는 v1(D-32)이므로 MVP-β 템플릿은 쓰지 않고 `value_type: integer` + 단위는 용어집 정의로 둡니다. 템플릿의 속성 정의는 **모두 이 묶음에만** 둡니다(`schema_extension.attributes` 금지, TV-01). 속성 키는 합성 결과 안에서 유일해야 합니다(TV-02) |
| `visual_attribute` | 시각 속성이면 `true`(06 4.3, FR-SPX-03 묶음에 합류. 예: 가문 문장) |

#### (d) 순서형 어휘 `ordinal_scales` (B-1)

| 필드 | 설명 |
|---|---|
| `key`, `label_ko` | 예: `murim_realm` 경지 |
| `levels[]` | `{key, label_ko, rank: int, aliases[]}`. 별칭은 이름 사전이 아니라 값 정규화에 씀(예: "화경"="조화경", 작품별) |
| `allow_gaps` | `false`면 단계 건너뛰기를 `ordinal_skip` 규칙으로 검사 |
| `open_top` | 위쪽 단계 추가 허용(작품마다 정점이 다름) |
| `concept_question` | 이 척도를 확정하는 질문 참조 `<template_key>:<question_key>`(정점·단계 수) |

경지·등급·작위 이름은 **템플릿 데이터**이고, `OrdinalScaleDef` 형식은 **기본 스키마**입니다(research-genre-world-elements 3.1절 경계).

#### (e) 칭호·호칭 체계 `title_defs`, `address_rules`

06 3.2 `name_kind` 판정 규칙과 연결합니다.

| 장르 표기 유형 | `name_kind` | 템플릿 필드 | 예 |
|---|---|---|---|
| 보유자가 바뀌는 직위 | `title`(칭호 엔티티의 이름) | `title_defs[]`: `{key, label_ko, title_rank?: "ordinal:<scale>", title_of: [organization/place 유형], max_holders, succession_rule, succession_note}` (B-4·B-5) | 장문인, 가주, 공작, 길드장 |
| 한 사람에게 고정된 이명 | `alias` | 템플릿은 판정 힌트만(`epithet_hint`): "대를 잇는 별호면 `title`" | 검성, 독왕 |
| 화자 의존 호칭 | `address_term` + `used_by_condition` | `address_rules[]`: `{surface, condition, group?, priority?}`(`group`은 서로 배타적인 호칭 묶음, 예: 경칭). 조건 키는 06 3.7(`relation`, `target_role`, `older`) + B-6(`relation_path`, `target_title_rank_at_least`, `target_title_rank_below`, `target_member_of_type`) | 사형, 사부, 전하, 영애 |
| 위장명 | `disguise` | 떡밥 패턴 `masked_master` 등과 연결 | 가면 고수 |
| 한자 병기·띄어쓰기 변형 | `hidden_variant` | 용어집 `spelling_rules.hanja`, `hanja_policy` | 천마(天魔) |

`succession_rule` 값(B-5 제안): `appointment` 지명, `primogeniture` 장자, `agnatic_primogeniture` 남계 장자, `election` 선출, `combat` 비무·결투, `inheritance_custom` 작품 규칙 문장.

**칭호 인스턴스화 규칙** (`title_defs`는 유형 수준 정의, 06의 `title`은 개별 엔티티)

| # | 규칙 |
|---|---|
| TI-1 | 07 B2(`build_initial_ontology`)에서 `title_of` 대상 유형의 조직·영지 엔티티가 생기면, `world_keeper`가 그 엔티티마다 `title_defs` 항목별 칭호 엔티티(`entity_type=title`)를 만듭니다. 이후 화에서 새 조직이 생길 때도 같은 규칙입니다 |
| TI-2 | 대표명은 "<조직 대표명> <label_ko>"(예: "청운파 장문인")이고, `label_ko`("장문인")는 그 칭호 엔티티의 `title` 이름 행으로 둡니다. 같은 표기 칭호가 여럿이면 06 3.5 보유자 조회 + 소속(`member_of`)으로 후보를 좁힙니다 |
| TI-3 | `max_holders`는 칭호 엔티티 속성으로 복사합니다. 기본 1(06 3.5). 장로처럼 인원 제한이 없는 칭호는 `max_holders: unbounded` — 06 3.5에 "무제한" 값 정의를 요청합니다(현재 06은 정수, 기본 1) |
| TI-4 | `title_rank`(예: `ordinal:peerage`)와 `succession_rule`도 칭호 엔티티 속성으로 복사합니다. 사용자가 컨셉 대화에서 바꾼 값(`template_overrides`)이 있으면 그 값을 씁니다 |
| TI-5 | 칭호 엔티티와 칭호 사실의 출처는 `series_bible`(B2) + 근거 `template_key@version`입니다. 06·07에 B2 자동 생성 단계 추가를 요청합니다 |

**호칭 규칙 층** (`address_rules`): 06 3.7의 `address_term`은 특정 엔티티의 이름 행 + `used_by_condition`입니다. 템플릿 `address_rules`는 특정 엔티티에 묶이지 않는 **유형 수준 해석 규칙**이라 이름 행으로 바로 옮길 수 없습니다. 06 3.7에 "유형 수준 호칭 규칙" 층을 새로 정의해 달라고 요청합니다(`base@2` B-6 범위): L2 후보 생성에서 표기가 이 규칙에 걸리면, 화자(L1 판별 결과)를 기준으로 조건을 만족하는 엔티티를 후보로 넣습니다. 이름 행으로 저장된 작품별 규칙(`speakers` 형식 등)이 있으면 그쪽이 먼저입니다.

| 호칭 규칙 작성 규칙 | 내용 |
|---|---|
| 조건 키 | 06 이름을 씁니다(`older`, 그 외 `target_older` 같은 새 이름 금지) |
| 겹침 금지 | 한 대상에 두 표기가 동시에 성립하지 않게 상한 조건(`target_title_rank_below`)이나 `priority`를 둡니다. TV-13(3.6절)이 견본 엔티티 조합으로 검사 |
| 장르 관습과 맞추기 | 관습이 서열이 아니라 관계(입문 순서·같은 문파)로 정해지는 호칭은 서열 조건으로 쓰지 않습니다. 예: "선배"를 `murim_realm` 서열로 정하는 규칙은 두지 않습니다(입문·연배 기준이 관습). 입문 순서 관계가 `base@2`에 생기기 전까지는 작품별 이름 규칙으로 둡니다 |

#### (f) 누적 수치 장부 `ledgers` (B-7)

`{key, subject_types, components: [{key, source_predicate}], invariant: sum | non_negative | max}`. 예: 스탯 총합 = 기본 + 레벨업 지급 + 보상 − 소모. MVP-β 템플릿에서는 쓰지 않고(B-7 v1), 무협 내공은 단조 규칙만 둡니다.

#### (g) 연속성 규칙 `continuity_rules` (B-10)

| 필드 | 설명 |
|---|---|
| `key` | `<template_key>.<rule>`. `<template_key>`는 **전체 템플릿 키**(예: `rebirth.regression.carry_over_missing`, `modern_fantasy.hunter_gate.gate_no_reopen`). 감사·이슈 근거에 그대로 남음 |
| `kind` | `check`(기본) / `documentation_only`. `documentation_only`는 기존 CR이 이미 잡는 규칙을 문서화만 하며 `covered_by`가 필수이고 `prefilter`·`issue_kind`·`severity`를 면제합니다 |
| `statement_ko` | 사람이 읽는 규칙 문장(LLM 확인 프롬프트에도 들어감) |
| `applies_to` | 대상 속성·관계·유형 키 |
| `prefilter` | 결정적 사전 필터 종류. **모두 research-genre-world-elements B-10 제안이고 06 9절에는 아직 없습니다(06 미등록)**. 00 등록과 06 개정이 선행입니다. 릴리스별 구현 목록은 아래 표 |
| `params` | 필터 인자(예외 사건 술어, 척도 키, 허용 전이) |
| `issue_kind` | **00 `continuity_issue_kind` 값만**(`ability_rule`, `relationship`, `schema_violation`, `character_knowledge`, `age`, `location_travel` 등). 새 enum을 만들지 않고 근거의 `continuity_issue_evidence.schema_rule_key`에 규칙 키를 남깁니다. 이유: 장르마다 enum이 늘면 00·대시보드·질문 분류가 함께 바뀜. 06 4.7 TA-6은 이 원칙과 사전 필터별 매핑으로 닫혔습니다(06 v0.2.1) |
| `severity` | `high`/`medium`/`low`. 06 9절 심각도 조정 규칙이 뒤에 적용 |
| `llm_check` | `true`면 사전 필터 후보를 `continuity_editor`가 닫힌 판정 |
| `covered_by` | 기존 CR이 이미 잡는 경우 그 ID(예: 장문인 동시 1명 → CR-09). `kind: documentation_only`와 함께 씀 |
| `default_enabled` | 오탐 위험이 큰 규칙은 `false`로 두고 컨셉 대화나 설정에서 켬(7절 R-5) |
| `golden_seed_ids[]` | 5.1절 위반·정상 시드. `high` 규칙은 필수(TV-10) |

**사전 필터 종류와 릴리스** (B-10 제안, 06 미등록. 공수는 6절)

| 필터 | 검사 | 필요 `base@2` | 릴리스 |
|---|---|---|---|
| `ordinal_regression` | 순서형 값 감소(예외 사건 없을 때) | B-1, B-3 | MVP-β |
| `ordinal_skip` | 순서형 값 단계 건너뛰기(`allow_gaps=false`) | B-1 | MVP-β |
| `attribute_delta` | 관계 양끝 속성 차이(예: 항렬 +1) | B-10 | MVP-β |
| `state_transition` | 금지 상태 전이(예: 게이트 `cleared → open`) | B-10 | MVP-β |
| `timeline_carry_check` | 다른 시간선 물건·능력을 이월 사실 없이 사용 | B-10, 06 3.13 | MVP-β |
| `llm_rule` 연결 | 결정적 후보 없이 `statement_ko`를 `continuity_editor` 확인 프롬프트에 넣음(CR-06과 같은 방식) | B-10 | MVP-β |
| `change_requires_event` | 단일값 속성이 변경 사건 없이 다른 값(B-3) | B-3 | v1 |
| `ability_before_event` | 지정 사건(예: 각성) 이전 지점에서 능력 사용 | B-10 | v1 |
| `attribute_disjoint` | 같은 기간 한 엔티티가 속성값이 충돌하는 두 대상에 동시 소속(예: 정파·마교) | B-10 | v1 |
| `succession_check` | 승계 규칙 위반 | B-5 | v1 |
| `ledger_mismatch` | 장부 불변식 위반 | B-7 | v1 |
| `calendar_conflict` | 작중 달력 충돌 | B-9 | v1 |

#### (h) 떡밥 패턴 `setup_patterns` (B-11)

`{key, label_ko, plant_hint, reinforce_hint, payoff_hint, typical_due: arc | episodes:<n>, links_entity_types[], pairs_with_rules[]}`. `foreshadow_manager`가 07 B4에서 `Setup(narrative_status=planned, canon_status=candidate)` 초안을 만들 때 후보 목록으로 씁니다. 패턴은 "이런 떡밥을 둘 수 있다"는 제안이고 자동으로 넣지 않습니다.

#### (i) 용어집 시드와 표기 규칙 `glossary_seed`

06 5절 `glossary_terms` 필드 그대로(`surface`, `category`, `definition`, `preferred_surface`, `spelling_rules`). 추가 필드 `default_hanja_policy`(템플릿 전체 기본값, 예: 무협 "첫 등장만"). 시드는 **장르 일반 용어**만 둡니다(내공, 경공, 갑자, 게이트, 각성). 고유명(특정 작품의 무공 이름·조직 이름)은 두지 않습니다(4.4절). 작품 생성 시 `glossary_terms(status=active, source_kind=template)`로 복사됩니다(가정: `source_kind`에 `template` 추가 필요, D-32 묶음). 블록 단위 `basis`(전체 시드에 적용)를 허용합니다.

#### (j) 컨셉 대화 질문 `concept_questions`

**계약의 단일 출처는 11 3.6 `ConceptQuestionDef`입니다.** 필드 이름·의미·조합 규칙(순서·중복·상한·버전 고정)은 11을 따르고, 이 계획서는 템플릿 작성 규칙과 `fills` 경로 문법만 더합니다. 11에 없는 필드는 아래 "계획서 추가" 두 개뿐이고, 11 3.6에 등록을 요청합니다.

| 필드 | 출처 | 템플릿 작성 규칙 |
|---|---|---|
| `key` | 11 | 템플릿 안 유일 키(`q_<name>`). 기록은 `<template_key>@<ver>:<key>`(11). 다른 구성 요소가 참조할 때는 `<template_key>:<key>`(예: `ordinal_scales[].concept_question: wuxia:q_realm`) |
| `fills` | 11 | 아래 경로 문법. TV-06 검사 |
| `required_level` | 11 | 템플릿 질문은 `template_required` 또는 `optional`만 씁니다(`core`는 공통 세트 전용). `template_required`도 "추천해 줘"·"나중에" 허용 → `deferred`(SC-3 측정 대상) |
| `stage` | 11 | `diverging`(세계 핵심 규칙, CQ-10과 같은 단계) / `converging`(연재 엔진·문체·표기). 템플릿 질문 대부분은 `diverging` |
| `ask_when` | 11 | 조건식. 결합 조건(다른 믹스인 선택 등)은 `variants[]`(3.2절)로 질문 자체를 넣고 빼며, `ask_when`은 다른 슬롯 값 조건에만 씁니다 |
| `ask_ko` | 11 | 질문 씨앗 문장(메신저 1통 기준 짧게) |
| `option_seeds[]` | 11 | `{label, value, note}` 2~4개. "직접 입력"·"추천해 줘"·"나중에"는 `concept_partner`가 자동 추가(11 R2) |
| `default_value` | 11 | "추천해 줘" 선택 시 먼저 제시. 채택 시 출처 `template_default`, 사용자가 확인해야 `confirmed` |
| `min_age_rating` | 11 | 수위 연동 질문에만 |
| `safety_flags[]` | 11 | `real_person_risk`, `copyright_risk`. 실제 왕조·실존 단체 질문은 `real_person_risk`, 책빙의 원작 질문은 `copyright_risk` 필수 |
| `saturation_variant` | 계획서 추가 | `true`면 포화 트로프 변형 질문(예: "단순 회귀와 무엇이 다른가요?"). 포화 우려 트로프(단순 회귀·아카데미, [2차] S14)에 붙임 |
| `why_ko` | 계획서 추가 | 왜 묻는지 한 줄(사용자에게 "이 값은 연속성 검사에 쓰입니다" 표시) |

**`fills` 경로 문법** (두 종류)

| 종류 | 형식 | 예 | 저장 경로 | TV-06 검사 대상 |
|---|---|---|---|---|
| (a) 브리프 슬롯 | 11 5.4 `ConceptBrief.content` 경로. 세계 규칙은 `world_rules[<item_key>]`, 연재 엔진은 `serial_plan.<field>` | `world_rules[item:rebirth.regression/attributes/regression_trigger]`, `serial_plan.cider_cycle` | 브리프 필드 → 11 M-12(B2 `rule` 엔티티 + 사실). `item_key`가 속성을 가리키면 B2가 그 속성 사실로 저장 | 11 브리프 스키마에 경로가 있는가 + `<item_key>`가 (b) 형식이고 합성 결과에 있는가 |
| (a′) 항목 없는 세계 규칙 | `world_rules[note:<name>]` | `world_rules[note:gate_lifecycle]` | 11 5.4 `world_rules[]`의 `item_key` 없는 행(`statement`, `value`) → B2 `rule` 엔티티 + `rule_statement` 사실. `questions_only` 템플릿이 씀 | `<name>`이 합성 결과 질문 사이에서 유일한가 |
| (b) 템플릿 항목 | `item:<template_key>/<component>/<key>[#<field>]` | `item:wuxia/ordinal_scales/murim_realm#levels`, `item:romance_fantasy/title_defs/peer_title#succession_rule`, `item:wuxia/glossary_seed/default_hanja_policy`, `item:wuxia/continuity_rules/wuxia.realm_skip#default_enabled` | 컨셉 승인 때 작품 첫 스키마 버전 값(06 4.7 TA-4, 3.14 `item_key`). 기본값과 다르면 `template_overrides` | 합성 결과에 그 항목·필드가 있는가 |

`<component>` 허용 목록: `ordinal_scales`, `attributes`(묶음과 무관하게 속성 키로 찾음), `title_defs`, `address_rules`, `ledgers`, `continuity_rules`, `glossary_seed`, `reader_expectations`. 키에 점이 들어가므로 필드 구분자는 `#`입니다.

**원천 하나 원칙**: 같은 값을 스키마 속성과 브리프 슬롯 양쪽에 정의하지 않습니다. 회귀 트리거·기억 범위·회귀 횟수 같은 값은 `attribute_bundles`의 속성 정의 하나만 두고, 질문은 `world_rules[item:.../attributes/<key>]`로 그 속성을 가리킵니다.

상한: 템플릿 질문 상한은 00 기본값 `concept.max_template_questions`(8, 11 3.6) 하나만 씁니다. 합성 결과의 `template_required` 질문이 이 값을 넘으면 빌드 경고(TV-11). 정렬·중복·상한 동작은 11 3.6이 소유하고 이 문서는 다시 정의하지 않습니다.

#### (k) 독자 기대 요소 `reader_expectations` (FR-NOV-03)

| 키 | 형식 | 쓰는 곳 | 비고 |
|---|---|---|---|
| `cider_cycle_episodes` | `{min, max}` 화 | 07 B3 아크 계획, P1 아웃라인 비트 점검 | 해소(사이다) 비트 사이 간격. 값은 가정이고 근거는 [2차] |
| `max_frustration_run` | 정수(화) | P1 | 답답함(고구마) 연속 허용 화 수 |
| `episode_end_hook` | `{required: bool, preferred_kinds[], forbid_repeat_kind_run: n}` | P1 `OutlineData.hook`, P4 훅 평가, FR-AGT-09(v1) | 훅 종류: `reveal`, `confrontation`, `cliff_danger`, `power_up_tease`, `relationship_turn`, `mystery_question` |
| `episode1_promise` | text | 1화 아웃라인 | 예: 회귀 = "1화 안에 회귀 사실과 정보 우위 제시"[2차] |
| `romance_progress` | `{stages[], target_by_arc_ratio[]}` | B3 아크 계획 지표 | **사실이 아니라 아웃라인 지표**. 서열화하면 단조 규칙과 맞지 않음(research-genre-world-elements 4.4절) |
| `growth_milestone` | `{per: arc, kinds[]}` | B3 | 경지 상승·등급 재측정·스킬 획득 같은 성장 비트 배치 기준 |
| `future_knowledge_payoff_every_episodes` | `{min, max}` 화 | B3, P1 | 회귀·빙의의 미래 지식 회수 간격. 값은 가정 |

이 표에 없는 키는 쓸 수 없습니다(TV-01). 예외는 메타 키 `basis`·`source_ids`(블록 전체의 출처, TV-08)뿐입니다. 키별 합성 연산은 3.3절 표입니다.

검사 강도: 독자 기대는 **경고(리포트)만** 냅니다. 연속성 이슈(`continuity_issues`)를 만들지 않습니다. 이유: 창작 판단 영역이고, 차단하면 클리셰 고착을 강제합니다(7절 R-1).

#### (l) 안전 프로필 `safety_profile`

| 필드 | 값 | 연결 |
|---|---|---|
| `real_person_check` | `default` / `strict`(실존 인물·단체·지명 언급마다 `safety_real_person` 사전 필터 강화) | NFR-SAFE-02, 07 5.6 SF-3 |
| `age_rating_max_default` | `age_15` 등 | D-13, FR-NOV-01 |
| `requires_policy` | 정책 결정 ID(예: D-33) | 결정 전에는 `status=released` 불가 |

### 3.5 사용자 덮어쓰기와 작품별 확장

| 단계 | 동작 | 기록 | 연결 |
|---|---|---|---|
| T1 선택 | `concept_partner`가 대화에서 L1·L2·L3를 추정해 사용자 확인(FR-NOV-11) | `ConceptBrief.content.category.genre_key`, `subgenre_keys[]`, `trope_keys[]`, `audience_facets[]`(11 5.4). 보조 L1 필드는 11 5.4에 없으므로 추가 요청 | 요구 A |
| T2 합성 | 확인 즉시 템플릿을 합성해 질문 목록과 기본값을 세션에 올림. 이후 트로프가 바뀌면 다시 합성하고 이미 `confirmed`된 답은 유지. 런타임 조합 정의 충돌은 3.3절 질문 | `concept_sessions.template_refs`(`key@version`, 컴파일 해시) | 3.3절 |
| T3 덮어쓰기 | 답이 기본값과 다르면 덮어쓰기 기록 | `concept_briefs.template_overrides`: `[{path, template_value, user_value, reason?, message_id}]`(03 형식) | 감시 지표 W-T3 |
| T4 승인 | `Approval(approval_type=concept_brief)` 승인 트랜잭션에서 합성 결과 + 덮어쓰기를 **복사**해 작품 첫 `ontology_schema_versions` 행 생성. `extension`에 `template_refs`·`compiled_hash`를 기록. 용어집 시드 복사, 떡밥 패턴은 `planner`·`foreshadow_manager` 입력 목록으로만 둠 | `schema.version_published`, `glossary.term_created`(`source_kind=template`) | 06 4.1·5절, 07 B1·B2 |
| T5 이후 변경 | 06 4.5 스키마 변경 제안 흐름 그대로. 규칙 켜기·끄기, 심각도 변경은 `change_constraint` 제안 | `schema_change_proposals` | 06 4.5 |
| T6 템플릿 업그레이드 | 새 템플릿 버전이 나와도 자동 반영하지 않음. 사용자가 원하면 차이를 `change_constraint`·`add_*` 제안 묶음으로 만들어 승인. 업그레이드 UI는 v1이고, MVP-β에서는 시험 작품에서 CLI로 경로만 실증합니다(검증 작품 A·B는 업그레이드하지 않음, 6절) | 영향 사실 수·새 위반 수 미리 계산(06 4.5) | 3.6절, D-36(DG-08) |

가정: MVP-α에는 템플릿 본문이 없으므로 T2~T4 중 카테고리 키 저장만 동작합니다(FR-NOV-11, 6절).

템플릿으로 첫 스키마 발행 시점: D-30 확정에 따라 **MVP-β**(03b 검증 장르)와 **v1**(03c 정식 라이브러리)입니다. 11 M-15는 2026-10-28 이 시점으로 맞췄고(11 v0.2.2), 06 3.14 CO-1은 06 개정에서 맞춥니다(8.2절).

### 3.6 저장 형식과 배포 (NFR-EXT-03)

| 항목 | 결정(제안) |
|---|---|
| 원본 | 저장소 `packages/shared/genre-templates/<template_kind>/<key>.yaml`. 사람이 리뷰하기 쉬운 YAML. 시험 시드는 `packages/test-kit/golden/templates/<key>/` |
| 형식 정의 | zod 스키마 `GenreTemplateSchema`(`packages/shared`). 06 4.1 `EntityTypeDef`·`RelationTypeDef`·`AttributeDef`를 import해 재사용. JSON Schema를 함께 내보내 편집기 자동 완성에 씀 |
| 빌드 | `genre-templates:build`가 YAML 파싱 → zod 검증 → TV-01~TV-13 → 조합 합성 시험(TV-09 범위) → `genre-templates.bundle.json` + 템플릿별 컴파일 해시 생성 |
| 배포 | 컴파일 묶음을 앱 설치 데이터(03 T-6 "기본 온톨로지 스키마"와 같은 층, 읽기 전용)로 릴리스에 포함. DB 테이블에 넣지 않음. 작품은 `key@version` + 해시만 참조하고 내용은 첫 스키마 버전에 복사본으로 가짐 |
| 버전 규칙 | major: 정의 삭제·제약 강화·척도 단계 변경(기존 작품에 새 위반이 생길 수 있음). minor: 질문·떡밥 패턴·용어 추가, 선택 규칙 추가(`default_enabled=false`). patch: 문구·출처·오타 |
| 이전(migration) | 기존 작품은 고정(복사본이라 영향 없음). 템플릿 major 변경 시 `changelog`에 "업그레이드 제안 변환 규칙"을 적어 T6 제안 생성에 씀. `deprecated` 템플릿은 새 작품에서 숨기고 기존 작품은 계속 동작 |
| 사용자 템플릿 | 사용자가 자기 템플릿을 YAML로 가져오기(v1 이후 후보). 같은 빌드 검증을 앱 안에서 실행 |

**빌드 검증 항목 TV**

| ID | 검사 | 실패 시 |
|---|---|---|
| TV-01 | zod 스키마 통과(독자 기대 키 목록, `content_level`별 허용 구성 요소, 속성은 `attribute_bundles`에만 포함) | 오류 |
| TV-02 | 키 형식·중복 없음. 규칙 키 접두사 = 전체 템플릿 키(`<template_key>.<rule>`). 속성 키는 합성 결과 안에서 유일 | 오류 |
| TV-03 | `parent`·`parent_key`·`extends`·`uses_shared`·`conflicts_with`·`variants[].when` 대상 존재. 대상의 `status`가 같은 릴리스 단계 이상(MVP-β 빌드에서 v1 템플릿 참조 금지) | 오류 |
| TV-04 | `ordinal:<scale>` 참조 척도 존재, 척도 소유자 1곳 | 오류 |
| TV-05 | 규칙 `prefilter`가 해당 릴리스에 구현된 종류(3.4 (g) 표), `issue_kind`가 00 enum 값. `kind: documentation_only`는 `covered_by`만 검사 | 오류 |
| TV-06 | 질문 `fills`: (a) 브리프 슬롯은 11 5.4 브리프 스키마에 경로가 있고 `item_key`가 합성 결과에 있음, (b) 템플릿 항목은 합성 결과에 항목·필드가 있음(3.4 (j)) | 오류 |
| TV-07 | 용어집 같은 표제어·다른 정의 없음(TV-09 범위 조합 기준) | 오류 |
| TV-08 | 정의 구성 요소(`schema_extension`·`ordinal_scales`·`attribute_bundles`·`ledgers`·`title_defs`·`address_rules`·`continuity_rules`·`setup_patterns`·`glossary_seed`·`reader_expectations`)의 모든 원소에 `source_ids` 또는 `basis`(`source`/`convention_assumption`). 묶음·척도·용어집·독자 기대의 하위 원소는 상위 값을 상속. `concept_questions`는 사실 주장이 아니라 대상에서 뺌. `source_ids`는 헤더 `sources[].id`(10절 ID)에 있어야 함. `llm_draft`는 `released` 불가 | 오류 |
| TV-09 | 시험 범위 = (L1 × L2 0~1개 × 믹스인 0~2개의 허용 조합 전부) + 3.3절 알려진 조합 표 전부. 합성 성공, 독자 기대 연산 결과가 비지 않음 | 오류 |
| TV-10 | `high` 규칙마다 위반·정상 골든 시드 1개 이상 | 오류 |
| TV-11 | 합성 결과 `template_required` 질문 수 ≤ `concept.max_template_questions`(8), 켜진 규칙 수 ≤ `template.max_enabled_rules`(20, 가정, 00 등록 요청) | 경고 |
| TV-12 | 고유명 금지 목록(4.4절)과 정규화 일치 0건. 목록이 비어 있으면 "경고: 목록 없음"(오류 아님, SC-8에서 측정 불가로 표기) | 오류 / 경고 |
| TV-13 | 호칭 규칙 겹침: 견본 엔티티 조합(템플릿별 시험 시드의 인물·칭호)에서 한 (화자, 대상)에 같은 `group`(예: `court_honorific`)의 표기가 둘 이상 동시에 성립하면서 `priority`가 같음 | 오류 |

---

## 4. 구축 절차

### 4.1 단계

| 단계 | 내용 | 담당 | 입력 | 산출물 | 완료 기준 |
|---|---|---|---|---|---|
| S1 조사 | 카테고리별 장르 관습, 플랫폼 분류, 랭킹 트로프 빈도 확인 | LLM 보조(검색·요약) + 사람(출처 등급 판정) | 조사 문서 3개, 플랫폼 페이지, 논문 | 카테고리 조사 메모(출처 표 포함) | 항목마다 등급·출처·확인일. [미확인]은 "가정"으로 표시 |
| S2 항목 초안 | 세계관 필수 정보 항목, 질문, 떡밥 패턴, 용어 목록 초안 | LLM 초안 + 사람 정리 | S1 메모, research-genre-world-elements 4·5절 | YAML 초안(`status=draft`) | 구조 패턴 P1~P7 점검표 통과(해당 패턴마다 항목 있음) |
| S3 온톨로지 매핑 | 항목을 기본 유형·관계·속성에 붙이고, 없으면 확장 정의. `base@2` 메커니즘 필요 여부 표시 | 사람(설계 담당) + LLM 보조(같은 의미 키 찾기) | S2 초안, 06 4절 | 매핑 표, `schema_extension`, 규칙 정의 | TV-01~TV-09·TV-13 통과. 기본 스키마 변경이 필요하면 00·06 개정 요청으로 분리 |
| S4 견본 원고 검증 | 합성 견본 원고(5~10화 분량)에 모순 시드를 넣고 규칙·추출·링킹을 돌림. 컨셉 대화 시뮬레이션 5세션 | LLM(원고·시뮬레이션 사용자 생성) + 사람(정답 표 작성·판정. **정답 표 작성자는 그 규칙 작성자가 아닌 사람**) | S3 결과 | 골든 시드, 측정 리포트(SC-3·SC-5·SC-6) | SC-5·SC-6 시드 목표 충족, 필수 질문 누락 0 |
| S5 리뷰 | 장르 관습 적합성(4.4절 관습 인정 기준), 개별 작품 설정 복제 여부(사건 전개 조합 점검 포함), 정책(안전·연령) 점검 | 사람: 장르 독자·작가 검수자 1인 이상(가정) + 설계 담당 1인 | S4 결과 | 검수 기록(`reviewers[]`), 수정 목록 | 복제 의심 0건, 정책 위반 0건, `basis: convention_assumption` 항목 전부 검수자 확인, `status=reviewed` |
| S6 배포 | 버전 지정, 변경 이력, 묶음 컴파일, 릴리스 노트 | 개발 담당 | S5 결과 | `status=released` 템플릿, 묶음, 릴리스 노트 | TV-01~TV-13 통과, 골든 회귀 통과(09 DoD-4) |

LLM 보조 원칙: LLM은 초안·검색·시뮬레이션만 합니다. 출처 등급 판정, 정답 표, 검수 판정은 사람이 합니다. LLM이 제안한 항목은 `basis: llm_draft`로 표시하고 S5 전에 출처나 `convention_assumption`으로 바꿔야 합니다.

### 4.2 역할과 공수 단위

| 역할 | 하는 일 | 가정 |
|---|---|---|
| 템플릿 작성자 | S1~S3 | 개발자 겸임 가능 |
| 장르 검수자 | S5 관습 적합성·복제 점검 | 해당 장르 독자·작가 1인. 검증 작품 A·B가 MB-1·MB-2에 시작하므로 **섭외를 MA-6으로 당깁니다**(09 MB-3의 D-26 평가자 섭외보다 앞, D-37(DG-09) 확정). 섭외가 늦으면 MVP-β 템플릿에 한해 내부 검수(설계 담당 + 작성자가 아닌 1인)로 `reviewed`를 허용하고, 외부 검수는 v1 `released` 전에 받습니다(D-37 확정) |
| 설계 담당 | S3 매핑, 기본 스키마 변경 판단 | 06 소유자 |
| 개발 담당 | 빌드 도구, 사전 필터 구현, S6 | — |

가정: 09는 "개발 주체 1명 + 코딩 에이전트"를 전제로 하므로 템플릿 작성자·설계 담당·개발 담당은 같은 1명입니다. 그래서 템플릿 공수는 제품 개발 공수와 같은 용량을 나눠 씁니다(6절 용량 대조).

### 4.3 출처 기록 방식

| 필드 | 내용 |
|---|---|
| `sources[]` (헤더) | `{id, url, title, grade: 1차|2차|미확인, checked_at, supports[]}` |
| 항목별 `source_ids[]` | 그 항목을 뒷받침하는 출처 ID |
| 항목별 `basis` | `source`(출처 있음) / `convention_assumption`(장르 관습 가정, 검수자 확인 필요) / `llm_draft`(배포 불가) |
| 재확인 | 플랫폼 분류 출처는 확인일 90일 경과 시 "재확인 필요" 표시(FR-NOV-04b와 같은 기준, 가정) |

### 4.4 저작권 원칙

| 원칙 | 내용 | 검사 |
|---|---|---|
| 장르 관습만 | 여러 작품에 공통인 체계(경지 단계, 작위 서열, 헌터 등급 문자, 회귀 구조)만 담습니다. 아이디어·장르 전형은 보호 대상이 아니고 표현이 보호된다는 국내 실무 설명이 근거입니다[2차, research-concept-agent 5절] | S5 검수 |
| 개별 작품 고유 설정 금지 | 특정 작품의 인물명, 고유 무공·스킬명, 고유 조직·지명, 고유 시스템 메시지 문구, 사건 전개 조합을 넣지 않습니다 | TV-12 고유명 금지 목록 대조 + S5 |
| 원문 인용 금지 | 작품 문장을 예시로 옮기지 않습니다. 질문·정의 문구는 새로 씁니다 | S5 |
| 해설 출처의 한계 | 특정 작품 해설 글을 근거로 쓸 때는 관습 수준만 차용(research-genre-world-elements 4.3절 방식) | `basis` 표시 |
| 책빙의 원작 | 템플릿 질문에서 "원작은 작중 가상의 소설"임을 필수 확인합니다(`safety_flags: [copyright_risk]`). 실제 출간작 지정은 막습니다(D-35(DG-07)) | 질문 `template_required` |
| 금지 목록 | 고유명 금지 목록은 06 O-19(실존 인물 목록)와 같은 방식으로 운영자·사용자가 채우는 설치 데이터입니다(2026-10-28 확정, 비면 LLM 신호만). 초기 목록 데이터 출처는 MVP-α 구현 전 조사 과제입니다. **MVP-β 최소본**: 기준일 네이버 시리즈·문피아 상위 랭킹 작품의 고유 무공·스킬·조직명을 수동 수집(MVP-β 준비 산출물, 6절). 목록이 비어 있으면 TV-12는 경고만 내고 SC-8 일치 수는 "측정 불가" | TV-12 |

**관습 인정 기준** (항목을 "장르 관습"으로 템플릿에 넣는 조건)

| 조건 | 내용 |
|---|---|
| K-1 작품 수 | 서로 다른 작가의 작품 3편 이상에서 같은 구조를 확인(작품명·확인 위치를 검수 기록에 남김. 템플릿 본문에는 넣지 않음) |
| K-2 해설 수 | 또는 1·2차 해설 2건 이상, 그중 1건 이상은 특정 작품 해설이 아닌 장르 일반 해설 |
| 미충족 | `basis: convention_assumption` + 검수자 확인 필수(S5 완료 기준). 검수자가 확인하지 못하면 `default_enabled=false` 또는 질문 선택지로만 둡니다 |
| 현재 상태 (S1 추가 조사 반영, 2026-10-28) | **무협 경지 척도**: 장르 일반 해설 국내 글 2건이 같은 순서(삼류 → 이류 → 일류 → 절정 → 초절정 → 화경 → 현경 → 생사경 이상)를 제시하고, 둘 다 "작품마다 용어·순서가 다르다"고 밝힙니다[2차, G4·G5]. 위키 미러 G1까지 3건이므로 **K-2 충족**(장르 일반 해설 2건 이상). 다만 모두 개인 블로그·위키라 `basis`는 `source`로 올리되 검수자 확인(S5)은 유지하고, 척도는 `open_top: true`·작품별 이름 덮어쓰기를 기본으로 둡니다. **헌터물**: 국내 장르 일반 해설은 찾지 못했습니다(검색 결과는 특정 작품 리뷰 G6과 작품 소개문). 대신 재현 자료 `naver-series-top100-2026-10-28/top100.csv` 소개문에서 서로 다른 작가 3편(`product_no` 14872072·14144715·14796642)이 "게이트 출현 → 각성자(헌터) 발생" 구조를 공유해 **이 핵심 구조만 K-1 충족**입니다. 헌터 등급(F~S)은 1편(소개문)과 리뷰 1건, 협회·던전 브레이크는 국내 출처 0건이라 **K-1·K-2 미충족**으로 `convention_assumption` 유지, 질문 선택지·기본값으로만 둡니다(헌터 규칙은 v1, 2.5절). 작품명은 검수 기록에만 남기고 템플릿 본문에 넣지 않습니다 |

**비문자적 복제 점검** (CopyBench C2가 지적한 사건·인물 비문자적 복제는 고유명 대조로 잡히지 않음): `setup_patterns`의 조합(트로프 2개 이상을 결합하는 패턴)과 `variants` 패치는 S5 점검표에 "특정 작품 전개와 3요소 이상(설정·사건 순서·인물 배역) 일치 여부" 항목을 둡니다. 일치하면 패턴을 일반화하거나 뺍니다.

---

## 5. 검증

### 5.1 템플릿별 시험 세트 (06 12절 골든셋 확장)

위치: `packages/test-kit/golden/templates/<key>/`. 형식은 06 12.1 장편 시드와 같고, 시드마다 위반 버전과 정상 버전을 쌍으로 둡니다(오탐률 측정용). 초기 온톨로지는 템플릿 합성 결과 + 견본 컨셉 답으로 만듭니다.

기대 결과는 시드마다 **하나**입니다. 이슈가 기대되면 "규칙 키 + 00 `issue_kind` + 심각도", 링킹 결과가 기대되면 그 상태 하나, 정상 쌍은 "이슈 없음"입니다. 필터 열은 3.4 (g) 표의 릴리스를 따르며, 필터가 v1이면 시드도 v1입니다.

| 시드 ID | 템플릿 | 모순 유형 | 위반 예(합성 원고) | 정상 쌍 | 규칙 키 | 00 `issue_kind` | 심각도 | 필터 | 단계 |
|---|---|---|---|---|---|---|---|---|---|
| GT-W01 | `wuxia` | 경지 역행 | 절정 인물이 폐공 사건 없이 다음 화에 일류로 서술 | 폐공 사건 사실 뒤 일류 | `wuxia.realm_no_regression` | `ability_rule` | high | `ordinal_regression` | MVP-β |
| GT-W02 | `wuxia` | 경지 건너뛰기(`allow_gaps=false`) | 이류에서 바로 절정 | 일류를 거쳐 절정 | `wuxia.realm_skip` | `ability_rule` | medium | `ordinal_skip` | MVP-β |
| GT-W03 | `wuxia` | 항렬 불일치 | 사부 3대, 제자 5대 | 제자 4대 | `wuxia.generation_step` | `relationship` | medium | `attribute_delta` | MVP-β |
| GT-W04 | `wuxia` | 사문 호칭 오용 | 제자가 사부를 "사형" | 같은 사부 아래 연장자를 "사형" | (이슈 아님) 기대 결과 = 그 언급의 링킹 상태 `ambiguous`(질문 또는 리포트, 자동 확정 안 됨) | — | — | 유형 수준 호칭 규칙(3.4 (e)) | MVP-β |
| GT-W05 | `wuxia` | 장문인 동시 2명 | 선대 장문인 생존·재임 중 새 장문인 취임 | 선대 은퇴 사실 뒤 취임 | CR-09(`wuxia.sect_leader_single`은 `documentation_only`) | `schema_violation` | 관계 정의 | 기존 CR | MVP-β |
| GT-W06 | `wuxia` | 정파·마교 동시 소속 | 위장 사실 없이 양쪽 `member_of` | `disguise`·`cover_story` 있음 | `wuxia.faction_disjoint` | `relationship` | medium | `attribute_disjoint` | v1 |
| GT-H01 | `modern_fantasy.hunter_gate` | 헌터 등급 무사건 변경 | 재측정 사건 없이 C급 → A급 | `rank_assessment` 사건 뒤 A급 | `modern_fantasy.hunter_gate.rank_change_requires_event` | `ability_rule` | high | `change_requires_event` | v1 |
| GT-H02 | `modern_fantasy.hunter_gate` | 게이트 등급 무사건 변경 | 같은 게이트를 앞 화 B급, 뒤 화 A급으로 서술(재평가 사건 없음) | 등급 재평가 사건 있음 | `modern_fantasy.hunter_gate.gate_grade_stable` | `ability_rule` | medium | `change_requires_event` | v1 |
| GT-H03 | `modern_fantasy.hunter_gate` | 닫힌 게이트 재개방 | `cleared` 게이트가 다시 `open` | 새 게이트 엔티티로 등장 | `modern_fantasy.hunter_gate.gate_no_reopen` | `ability_rule` | high | `state_transition` | v1 |
| GT-H04 | `modern_fantasy.hunter_gate` | 각성 전 스킬 사용 | `awakened_at` 이전 씬에서 스킬 | 각성 이후 | `modern_fantasy.hunter_gate.skill_before_awakening` | `ability_rule` | high | `ability_before_event` | v1 |
| GT-HR01 | `hunter_gate` + `rebirth.regression` | 오탐 방지(정상만) | — | 부모 시간선에서 `rewind_to_story_point` 이후 `cleared`된 게이트가 회귀 시간선에서 열림, 회귀자가 각성 전에 이월 스킬 사용 | 이슈 없음(3.3절 E-1~E-4) | — | — | `state_transition`, `ability_before_event` | v1 |
| GT-R01 | `rebirth.regression` | 이월 없는 기억 사용 | `retains_memory` 없는 조연이 이전 회차 사건 언급 | 회귀자 본인의 언급 | CR-17(`rebirth.regression.memory_without_carry`는 `documentation_only`) | `character_knowledge` | high | 기존 CR | MVP-β |
| GT-R02 | `rebirth.regression` | 이월 안 된 물건 사용 | 이전 회차 아이템을 이월 사실 없이 사용 | 이월 목록에 있는 능력 | `rebirth.regression.carry_over_missing` | `ability_rule` | high | `timeline_carry_check` | MVP-β |
| GT-R03 | `rebirth.regression` | 바뀐 사건을 미래 지식대로 믿음 | 이미 바뀐 사건을 회귀자가 원래대로 일어난다고 행동, 서술은 갱신 언급 없음 | 회귀자가 변화를 인지 | `rebirth.regression.stale_future_knowledge` | `character_knowledge` | medium | `llm_rule` | MVP-β |
| GT-RF01 | `romance_fantasy` | 작위 승계 위반 | 장자 승계 작위인데 생존 장자를 두고 차남 계승, 찬탈·박탈 사건 없음 | 장자 사망 사실 뒤 차남 계승 | `romance_fantasy.succession_violation` | `relationship` | medium | `succession_check` | v1 |
| GT-RF02 | `romance_fantasy` | 약혼 중복 | 파혼 사실 없이 다른 인물과 약혼 | 파혼 뒤 새 약혼 | CR-09(`betrothed_to` 개수) | `schema_violation` | 관계 정의 | 기존 CR | v1 |
| GT-RF03 | `romance_fantasy` | 경칭 위반 | 남작 영애가 공적 자리에서 공작을 하대 | 친족 간 사적 대화 | `romance_fantasy.honorific_misuse` | `relationship` | low | `llm_rule` | v1 |
| GT-BP01 | `rebirth.book_possession` | 원작 괴리 미인지 | 원작과 이미 달라진 사건을 빙의자가 원작대로 예측 | 빙의자가 괴리를 인지 | `rebirth.book_possession.source_divergence_unacknowledged` | `character_knowledge` | medium | `llm_rule` | v1 |
| GT-S01 | `ability_system.status_window` | 스탯 수치 불일치 | 상태창 STR이 직전 + 지급 포인트 합과 다름 | 합이 맞음 | `ability_system.status_window.stat_ledger_sum` | `ability_rule` | high | `ledger_mismatch` | v1 |
| GT-S02 | `ability_system.status_window` | 레벨 하강 | 패널티 사건 없이 레벨 감소 | 패널티 사건 있음 | `ability_system.status_window.level_no_regression`(레벨 = `ordinal:level`, `open_top`) | `ability_rule` | high | `ordinal_regression` | v1 |
| GT-A01 | `stage.academy` | 학사 달력 충돌 | 방학 중 정규 수업 | 보충 수업 사건 | `stage.academy.term_calendar` | `ability_rule` | medium | `calendar_conflict` | v1 |

규모(가정): 규칙당 위반·정상 각 2개 + 견본 원고 5~10화. MVP-β 템플릿(`wuxia`·`rebirth.regression` `full`) 합계 시드 약 30개. 헌터 시드는 v1.

### 5.2 컨셉 대화 검증

| 지표 | 정의 | 목표 | 방법 |
|---|---|---|---|
| 필수 질문 누락률(SC-3) | `entry_mode=conversation` 세션에서 합성 결과 `template_required` 질문 중 질문하지 않고 승인까지 간 비율(`deferred`는 제외하고 따로 셈) | 0% | 시뮬레이션 사용자 세션(템플릿 조합당 5세션, 가정) + 실사용 기록 |
| 빈 슬롯 표시율(SC-3b) | `import`·`direct_input` 세션의 승인 확인 화면에 빈 `template_required` 슬롯 목록이 표시된 비율 | 100% | 승인 화면 단위 테스트 |
| 보류율 | 필수 질문 중 `deferred` 비율 | 측정 후 설정 | 같음. 높으면 질문 문구·순서 개선 |
| 질문 턴 비용 | 템플릿 질문이 늘린 평균 턴 수 | ≤ 8턴(가정) | 세션 기록 |
| 기본값 반영 정확도 | 승인된 `ConceptBrief`의 템플릿 항목이 첫 스키마 버전에 그대로 반영된 비율 | 100% | 승인 트랜잭션 단위 테스트(결정적) |

### 5.3 운영 지표 (감시)

09 6.1 감시 지표에 추가를 제안합니다(번호는 W-24부터 후보).

| 후보 ID | 지표 | 계산 | 경고 기준(가정) | 조치 |
|---|---|---|---|---|
| W-T1 | 규칙별 오탐률 | 템플릿 규칙 이슈 중 사람이 "오탐"·"의도된 표현"으로 닫은 비율 | 규칙별 > 20% (이슈 10건 이상일 때) | 심각도 낮춤 → `default_enabled=false` → 규칙 재설계 |
| W-T2 | 규칙별 발생량 | 화당 템플릿 규칙 이슈 수 | 화당 > 3건 | 사전 필터 조건 좁히기 |
| W-T3 | 덮어쓰기 비율 | 항목별 `template_overrides` 수 ÷ 그 항목을 쓴 작품 수 | > 50%면 기본값 부적합, 창작 항목(훅·사이다 주기)에서 < 5%면 클리셰 고착 신호 | 기본값 변경 / 질문을 "열린 질문 + 추천" 방식으로 |
| W-T4 | 템플릿 밖 스키마 제안 | 작품 30화당 `add_*` 제안 중 장르 관습 항목 | 작품당 > 3건(SC-4) | 다음 minor 버전에 추가 |
| W-T5 | 컨셉 필수 질문 보류율 | 5.2절 | > 30% | 질문 재설계 |

---

## 6. 일정·단계

09 로드맵에 맞춥니다. 공수는 1인일(person-day) 기준 가정입니다. 09는 "개발 주체 1명 + 코딩 에이전트, 2주 구간"을 전제로 하므로(09 1절), 2주 구간 = 약 10인일이고 템플릿 작업은 제품 개발과 같은 용량을 나눠 씁니다.

**용량 대조** (가정. 가용 여유는 09가 그 구간에 이미 배정한 범위를 뺀 값)

| 09 구간 | 구간 용량 | 09 배정 | 템플릿 작업에 쓸 수 있는 여유 | 원안 요구 | 축소안 요구(D-30 확정안) | 차이(축소안) |
|---|---|---|---|---|---|---|
| MA-6~MA-7 (4주) | 약 20 | 운영·설치·UI, MVP-α 검증. MA-7 버퍼는 컨셉 에이전트가 이미 씀(09 2절) | 0 | MVP-β 준비 14~18 | — (MB-0으로 옮김) | — |
| MB-0 템플릿 준비 (신설 확정, D-30, 2~3주) | 10~15 | 없음 | 10~15 | — | MVP-β 준비 10~13 | −3 ~ +5 |
| MB-1~MB-4 (10~12주) | 50~60 | Discord·경합, 다중 시간선·용어집, `arc_approval`·`full_auto`, 검증 | 0~5 | MVP-β 24~30 | MVP-β 12~16 | −7 ~ −16 → MVP-β 1~2주 연장 필요 |
| V1-1 (3주) | 약 15 | FR 10여 개(정책 프로필, 자가 평가, 부재 모드 등) | 0~3 | v1 70~90 | v1 75~95(헌터 규칙 포함) | −72 ~ −95 → 별도 트랙 필요 |

판단: 원안은 어느 구간에도 들어가지 않습니다. D-30은 2026-10-28 (ii)로 확정했습니다. 선택지 기록:

| 선택지 | 내용 | 일정 영향 |
|---|---|---|
| (i) 전부 v1 | FR-NOV-03을 나누지 않음. MVP-β 검증 작품은 공통 질문(`common@1`)만 씀 | 없음. 단 SC-4·SC-6 실데이터 측정은 v1로 밀림 |
| **(ii) 축소 + MB-0 신설(확정)** | MVP-β 템플릿을 `wuxia`(`full`) + `rebirth.regression`(`full`) + `modern_fantasy`·`.hunter_gate`(`questions_only`)로 줄이고 헌터 규칙은 v1로. MB-0 2~3주를 MA-7과 MB-1 사이에 신설하고 MVP-β를 1~2주 연장 | MVP-β 전체 +3~5주 |
| (iii) 원안 유지 | 3개 템플릿 `full` + 헌터 규칙 | MVP-β +5~6주 |

v1 70~95인일은 V1-1·V1-2 안에 들어가지 않으므로, 09에 v1 별도 트랙(템플릿 트랙, 약 14~19주 1인)으로 반영해 달라고 요청합니다. 트랙 B(V1-3·V1-4)처럼 병행 가능 트랙으로 두되 개발 용량이 1명이면 v1 기간이 그만큼 늘어납니다.

**선행 조건**: MVP-β 준비는 `base@2` 채택(D-32)과 ADR-005 확정에 걸려 있습니다. 둘 다 2026-10-28 확정했습니다(D-32 MVP-β 7개 + v1 4개, ADR-005는 스파이크 조건부). MB-0 시작까지 00·06 개정이 끝나지 않으면 `wuxia`·`rebirth.regression`도 `questions_only`로 내려 MVP-β를 진행하고 규칙은 v1로 옮깁니다(R-7).

| 단계 | 09 구간 | 범위 | 산출물 | 완료 기준 | 공수(가정) |
|---|---|---|---|---|---|
| **MVP-α** | MA-0(키 등록), MA-4~MA-5(컨셉 대화와 함께) | (1) 카테고리 키 레지스트리: L1 11개·L2·L3 25개, 패싯 5개, 별칭, 플랫폼·해외 매핑 표(내용 없는 키 목록). (2) `concept_partner` 공통 질문 세트는 11 8.2 `common@1`이 소유하고 이 계획서는 만들지 않음. (3) `GenreTemplateSchema` zod 초안과 빈 빌드 명령 | `packages/shared/category-keys`(00 6.1 등록, ADR-013), zod 초안 | `ConceptBrief`가 L1·L2·L3 키를 저장(FR-NOV-11)하고 `novels.category`·`novels.genre`(표시 문자열)에 남음. 키 목록이 00에 등록됨 | 4~6 |
| **MVP-β 준비** | MB-0(신설, D-30 확정) | (1) `base@2` 부분 채택(B-1·B-3·B-4·B-5·B-6·B-10·B-11, D-32)을 00·06에 반영(유형 수준 호칭 규칙 층, `max_holders: unbounded`, 칭호 인스턴스화 TI-1~TI-5 포함). (2) 빌드·검증 도구(TV-01~TV-13), 합성기(3.3절 평가 범위 규칙 E-1~E-4 포함). (3) 사전 필터 6종(3.4 (g) MVP-β 행: `ordinal_regression`·`ordinal_skip`·`attribute_delta`·`state_transition`·`timeline_carry_check`·`llm_rule` 연결). (4) 고유명 금지 목록 MVP-β 최소본(4.4절). (5) 경지 척도 국내 출처 추가 조사(4.4절 K-1·K-2) | 00·06 개정, 빌드 도구, 사전 필터, 금지 목록 | 스파이크 S-21(아래) 통과 | 10~13 |
| **MVP-β** | MB-0 말~MB-4 | 템플릿 고정 버전 릴리스: `wuxia@1.0.0`(`full`, **MB-1 시작 전**), `modern_fantasy@1.0.0`·`modern_fantasy.hunter_gate@1.0.0`(`questions_only`)과 `rebirth.regression@1.0.0`(`full`, **MB-2 다중 시간선 골든 G12 통과 뒤, 작품 B 시작 전**). 골든 시드 GT-W·GT-R(약 30개). 컨셉 대화 템플릿 질문 연결 | 템플릿 4개(`released`), 시드, 측정 리포트 | (1) 검증 작품 A·B가 **처음부터 고정 버전**으로 컨셉 승인·첫 스키마를 만들고 30화 동안 템플릿을 바꾸지 않음(G-1·SC-6 측정 오염 방지). (2) SC-3 0%, SC-3b 100%, SC-5·SC-6 시드 목표 충족. (3) MB-4에서 SC-4(측정만)·SC-6(실작품) 보고. (4) 업그레이드 경로는 검증 작품이 아닌 **시험 작품에서 CLI로 실증**(v1.0.0 → 1.1.0 차이 → 06 4.5 제안 묶음 생성·승인) | 12~16 |
| **v1** | 별도 템플릿 트랙(09 반영 요청) | FR-NOV-03 정식: L1 5개(`wuxia`, `modern_fantasy`, `fantasy`, `romance_fantasy`, `romance`). `alt_history`는 2.5 표 11번대로 v1 2차(D-33 기준 연도·목록 출처 확정 뒤 배포) + 주요 L2 + 믹스인 `full` 6개(`rebirth.possession`, `rebirth.book_possession`, `rebirth.reincarnation`, `ability_system.status_window`, `stage.academy`, `stage.imperial_court`) + `light` 5개 + 헌터 규칙(`modern_fantasy.hunter_gate@2.0.0`). `base@2` 나머지(B-2 수치 단위, B-7 장부, B-8 `source_work`, B-9 작중 달력)와 v1 사전 필터 6종. 덮어쓰기·템플릿 업그레이드 UI, 해외 매핑 내보내기. 여성향 랭킹 표본 수집(SC-1 전제) | 템플릿 약 20개, 시드 약 200개(가정), 플랫폼 대응표 갱신 | SC-1 ≥ 70%, SC-2 장르별 최소 ≥ 60%, SC-7 (a) 0줄, SC-8 100% | 75~95 |
| **유지보수** | v1 이후 상시 | 시장 재조사, 템플릿 patch·minor 릴리스, 오탐 규칙 정리 | 재조사 리포트, 릴리스 노트 | 아래 주기 준수 | 분기당 3~5 |

작품 B 시작 시점: 09 MB-2는 "검증 작품 B 생성 시작"을 다중 시간선 구현과 같은 구간에 둡니다. 회귀 템플릿을 고정 버전으로 쓰려면 작품 B 시작을 MB-2 말(G12·G13 통과 뒤)로 늦춰야 합니다. 30화를 하루 1화로 승인해도 MB-3·MB-4(4~7주) 안에 들어갑니다[추론]. 09 조정을 요청합니다.

**스파이크 후보**(09 5.2 추가 제안, 번호는 S-21부터)

| ID | 질문 | 방법 | 통과 기준 |
|---|---|---|---|
| S-21 | 템플릿 합성 결과를 06 `extension` zod로 검증하고 첫 스키마 버전 행으로 저장할 수 있는가. 합성 시간은. 9절 견본이 실제 빌드 검증을 통과하는가 | 9.1 `wuxia` 단독, 9.2 `rebirth.regression` + 9.3 `modern_fantasy.hunter_gate`(작품 B 조합) 견본을 합성해 저장, 06 결정적 검증기 실행, TV-01~TV-13 실행 | 검증 통과, 합성 p90 < 1초(가정), **견본 TV-01~TV-13 결과 리포트(오류 0)** |
| S-22 | 순서형 사전 필터가 실제 초고에서 오탐을 얼마나 내는가 | 무협 견본 원고 10화(LLM 생성, 시드 없음)에 `ordinal_regression`·`attribute_delta` 실행 | 화당 오탐 < 0.5건(가정) |

**유지보수 주기**(가정)

| 대상 | 주기 | 방법 |
|---|---|---|
| 랭킹 장르 구성·트로프 빈도 | 분기 1회(트로프 추이가 필요하면 월 1회) | research-webnovel-market 5.1절과 같은 방법으로 네이버 시리즈 TOP100 집계. 카카오페이지·리디·문피아 수집 경로 확보 후 추가 |
| 플랫폼 장르 메뉴 | 90일(FR-NOV-04b 확인일 기준과 같음) | 1단 장르·하위 분류 변경 확인 → `platform_mapping` patch |
| 정부 실태조사 | 2년(다음 2026 조사 발표 시, 2027 전후 [추론]) | 장르별 비중 원문 확인 → 우선순위 재평가 |
| 오탐 규칙 정리 | 릴리스마다 | W-T1·W-T2 |
| 해외 분류 | 반기 | Wattpad·Royal Road·Webnovel 태그(현재 일부 403, [미확인]) |

---

## 7. 위험과 완화

| ID | 위험 | 가능성 | 영향 | 완화 | 감시 |
|---|---|---|---|---|---|
| R-1 | 클리셰 고착: 템플릿 기본값이 모든 작품을 같은 경지 체계·같은 훅으로 몰아 발상 균질화(LLM 사용 시 집단 다양성 감소 보고[1차] research-concept-agent 3절 e) | 높음 | 중간 | 모든 값은 기본값이고 덮어쓸 수 있음. 창작 항목(훅·사이다 주기·떡밥 패턴)은 강제하지 않고 경고만. 포화 트로프에 `saturation_variant` 질문 필수. `concept_partner`가 기본값을 제시할 때 "흔한 선택" 표시 + 서로 다른 축의 대안 2개 | W-T3 하한 |
| R-2 | 카테고리 경계 모호: 퓨전·크로스 장르, 플랫폼마다 다른 분류(로판이 문피아에 없음 등) | 중간 | 중간 | 주 L1 1개 + 보조 L1 1개 + L3 다중. 경계가 애매하면 `concept_partner`가 사용자에게 주 장르를 묻고, 보조 L1은 정의만 가져옴(3.3절). 대응표에 △로 표시 | 컨셉 대화에서 L1 재선택 횟수 |
| R-3 | 시장 변화: 트로프 유행이 빠르게 바뀜(다회귀·역빙의 등[2차]) | 높음 | 낮음 | 템플릿은 구조 패턴(P1~P7) 중심이라 유행 변화의 영향이 작음. 트로프는 L3 `light`로 빠르게 추가. 분기 재조사 | 6절 주기 |
| R-4 | 저작권: 템플릿이나 LLM 초안에 특정 작품 고유 설정이 섞임(CopyBench: 사건·인물 비문자적 복제[1차]) | 중간 | 높음 | 4.4절 원칙·관습 인정 기준, TV-12 금지 목록(MVP-β 최소본), `basis: llm_draft` 배포 금지, S5 사람 검수와 비문자적 복제 점검표(3요소 일치). 한계: 고유명 대조는 전개 복제를 잡지 못하고 S5는 사람 판단에 기댐 | 검수 지적 건수 |
| R-5 | 규칙 과다로 오탐 폭증: 장르 규칙이 많아지면 화당 이슈·재작성·질문이 늘어 G-2(화당 60분)·G-5(차단형 1건 이하)를 해침 | 중간 | 높음 | 규칙 수 상한(TV-11), 오탐 위험 규칙은 `default_enabled=false`, 독자 기대는 이슈가 아니라 리포트, 템플릿 규칙은 `high`를 최소화하고 `covered_by`로 기존 CR 중복 제거, 오탐률 경고 시 단계적 강등 | W-T1, W-T2 |
| R-6 | 템플릿 버전 변경이 기존 작품에 영향 | 낮음(복사 방식) | 높음 | 작품은 복사본을 가지므로 자동 변경 없음. 업그레이드는 T6 제안·승인. major 변경 시 영향 사실·새 위반 수 미리 계산. `deprecated` 템플릿도 기존 작품은 동작 | 업그레이드 제안 거절률 |
| R-7 | `base@2` 반영 지연: ADR-005·D-32는 2026-10-28 확정했지만 00·06 개정이 늦으면 MVP-β 템플릿이 규칙 없이 질문·용어만 남음. 일정·공수가 09 용량을 넘음(6절 용량 대조) | 높음 | 중간 | MVP-β 필수 메커니즘을 B-1·B-3·B-4·B-5·B-6·B-10·B-11로 한정. MB-0 시작까지 00·06 개정이 끝나지 않으면 모든 MVP-β 템플릿을 `questions_only`로 내리고 규칙은 v1로(연재 중 업그레이드로 규칙을 소급하지 않음. G-1·SC-6 측정 오염 방지). 공수는 D-30 확정안 (ii) 축소안 | MB-0 시작일의 00·06 `base@2` 반영 상태, MVP-β 준비 완료일 |
| R-8 | 정책 충돌: 대체역사·스포츠·연예계의 실존 인물, 수위 연동 태그 | 높음 | 높음 | 해당 템플릿은 `requires_policy`로 배포 차단: D-33은 방침 A 확정, 기준 연도·목록 출처를 D-12와 함께 정하기 전까지 보류. D-34는 MVP 미노출 확정. MVP-β 대상에서 제외 | D-33 기준 연도·목록 출처 결정 일정 |
| R-9 | 시장 데이터 편향: 네이버 시리즈 랭킹만 직접 집계, 정규식 휴리스틱 | 높음 | 중간 | 우선순위에 리디·카카오 1단 장르 보정 반영. 표본 50편 수동 라벨과 비교(research-webnovel-market 9절) | 재조사 시 오차 보고 |
| R-10 | 컨셉 대화 길어짐: 템플릿 필수 질문이 턴 상한을 압박 | 중간 | 중간 | 템플릿 질문 ≤ `concept.max_template_questions`(8, 11 3.6), 나머지는 `optional`로 "자세히" 선택 시만. 미룬 항목은 `planner` 기획서 단계로 넘김(`deferred`). "이대로 정리" 허용(11 3.7) | 5.2절 질문 턴 비용 |

---

## 8. PRD·설계 영향

### 8.1 PRD 수정 제안 (01 6절 P-01~P-10 다음 번호 후보)

2026-10-28 D-30 확정에 따라 PT-01·PT-03~PT-06은 PRD 반영 대상으로 확정했습니다(PRD 반영은 PRD 담당, 상태 "반영 완료").

| 후보 ID | 대상 | 제안 |
|---|---|---|
| PT-01 | FR-NOV-03 | **반영 완료(D-30 확정)**. 카테고리 키 선택은 **FR-NOV-11**(P0, MVP-α)로 이미 충족되므로 FR-NOV-03a는 만들지 않습니다. 두 줄로 나눕니다. **FR-NOV-03b**(P1, MVP-β): 검증 장르의 템플릿(`wuxia`·`rebirth.regression` `full`, 헌터 `questions_only`)이 질문·첫 스키마·연속성 규칙·떡밥 패턴·용어집을 채웁니다. 수용 기준: SC-3 0%, SC-3b 100%, 시드 SC-5 충족. **FR-NOV-03c**(P1, v1): 정식 템플릿 라이브러리(L1 5개 + 믹스인, `alt_history`는 v1 2차), 덮어쓰기·업그레이드, 독자 기대 요소. 수용 기준: 현 FR-NOV-03 기준 + SC-1·SC-2 |
| PT-02 | PRD 5.1 2단계 | **반영됨**(PRD v0.4 초안 5.1이 `concept_partner` 대화 흐름으로 바뀜). 추가 제안 없음 |
| PT-03 | NFR-EXT-03 수용 기준 | **반영 완료(D-30 확정)**. "장르 템플릿 추가·수정은 데이터 파일과 시험 시드 변경만으로 끝나며 빌드 검증(TV)을 통과해야 배포됩니다" 추가 |
| PT-04 | 9절 KPI | **반영 완료(D-30 확정)**. SC-3(필수 질문 누락률), SC-6(템플릿 규칙 오탐률) 추가(MVP-β 측정) |
| PT-05 | 12절 위험 | **반영 완료(D-30 확정)**. R-1(클리셰 고착), R-5(규칙 과다 오탐) 추가 |
| PT-06 | 8절 MVP-β 범위 | **반영 완료(D-30 확정)**. "검증 장르 2개의 템플릿" 추가(PT-01 03b) |

### 8.2 설계 문서 연결점

| 문서 | 연결 | 바뀌는 것(제안) |
|---|---|---|
| 00 | enum·기본값 단일 출처 | 카테고리 키 목록(별칭 포함), `template_kind`, `mixin_level`, `content_level`, `continuity_rule_kind`(`check`/`documentation_only`), `glossary_source_kind`에 `template`, 사전 필터 키(3.4 (g) 표, 릴리스 표시), `timeline_kind`에 `source_work`(v1, B-8), 기본값 `template.max_enabled_rules`(20). 질문 상한은 기존 `concept.max_template_questions`(8)을 씀 |
| 03 | 작품·컨셉 데이터 | 03의 실제 필드 `novels.category`·`template_refs`(현 `genre`는 표시 문자열 유지), `concept_briefs.template_overrides`(`message_id`), `ontology_schema_versions.extension.template_refs`. 보조 L1 필드(`category.secondary_genre_key`) 추가 요청 |
| 04 | 에이전트 | `concept_partner`가 템플릿 질문을 소비, `planner`가 `reader_expectations`, `foreshadow_manager`가 `setup_patterns`, `continuity_editor`가 템플릿 `llm_rule` 문장을 입력으로 받음 |
| 05 | 메신저 | 템플릿 질문은 컨셉 대화 턴이라 `Question`을 만들지 않음(research-concept-agent 6.5). 템플릿 업그레이드 승인만 `schema_change` 질문 |
| 06 | 온톨로지 | 4.1 `base@2`(B-1·B-3·B-4·B-5·B-6·B-10·B-11 MVP-β, 나머지 v1), 3.5 `max_holders: unbounded` 정의, 3.7 유형 수준 호칭 규칙 층, 칭호 인스턴스화(TI-1~TI-5), 4.5 템플릿 업그레이드 제안, 4.7 TA-1(속성은 `attribute_bundles`), TA-6(`issue_kind`는 00 기존 값 매핑으로 닫음), 5절 용어집 템플릿 시드, 9절 사전 필터 등록, 12절 템플릿 골든셋, O-10 해소 경로 |
| 07 | 파이프라인 | B1 입력에 `ConceptBrief`·템플릿 합성 결과, B2가 템플릿 확장 포함 스키마로 초기 온톨로지 구축하고 칭호 엔티티 자동 생성(TI-1), B3·P1이 `reader_expectations` 점검(경고만), P3d가 템플릿 규칙 실행(3.3절 평가 범위 E-1~E-4), P4 훅 평가가 `episode_end_hook` 사용 |
| 09 | 로드맵 | MA-0 키 등록, MB-0 템플릿 준비 구간 신설, MVP-β 1~2주 연장, 작품 B 시작을 MB-2 말로, 장르 검수자 섭외 MA-6, v1 템플릿 별도 트랙. 스파이크 S-21·S-22, 감시 지표 W-T1~W-T5 |
| 11 | 컨셉 대화 설계(`design/11-concept-development.md`) | 3.6 `ConceptQuestionDef`가 질문 계약의 단일 출처. 요청: `saturation_variant`·`why_ko` 필드 등록, `fills` 경로 문법(3.4 (j)) 반영, 5.4 보조 L1 필드. 3.6 "어느 플랫폼에서도 … [1차]" 문장을 확인 범위로 좁힘 |
| 표기 차이(D-30 확정) | 06 3.14 CO-1, 11 M-15 | 템플릿 첫 스키마 발행 시점을 MVP-β(03b)/v1(03c)로 맞춥니다. 반영 완료: 11 M-15~M-17(v0.2.2), 06 3.14 CO-1·4.7(v0.2.2) |

**반영 상태 (2026-10-28 교차 후속)**: 00(v0.2.1: `content_level`·`continuity_rule_kind`·사전 필터 키·카테고리 키 레지스트리와 별칭·`glossary_source_kind`. `template.max_enabled_rules`는 이미 등록), 03(v0.3.1: 보조 L1, `template_overrides.path` 문법), 06(v0.2.1: `unbounded`, 유형 수준 호칭 규칙 층, TI-1~TI-5, TA-1·TA-6, 9절 사전 필터, E-1~E-4·`regression_branch`), 07(v0.2.1: B2 TI-1, P3d E-1~E-4), 09(v0.2.1: MB-0, MVP-β 연장, 작품 B MB-2 말, 검수자 MA-6, V1-T 트랙, 3.5 표), 11(v0.2.1: `saturation_variant`·`why_ko`, `fills` 문법, 중복 `fills`의 `required_level` 승격, 보조 L1, 3.6 문장), PRD(13절 D-29~D-37, FR-NOV-03 03a 삭제)에 반영했습니다. 남은 것: 표기 차이는 해소(D-30 확정으로 11 M-15~M-17·06 CO-1 반영 완료), `timeline_kind.source_work`(v1, D-32 후), 04·05 행(설계 개정 요청 없음).

### 8.3 결정 사항 (2026-10-28 사용자 확정)

PRD v0.4 초안 13절에 D-29~D-37로 들어가 있습니다. 아래 표는 그 원본이고, 이 리뷰에서 바뀐 선택지·추천은 PRD 13절에 함께 반영해야 합니다(변경 표시 "개정"). 2026-10-28 사용자가 추천안대로 확정했습니다.

| 후보 ID | PRD D | 질문 | 선택지 | 확정안과 이유 | 상태 |
|---|---|---|---|---|---|
| DG-01 | D-29 | MVP-β 검증 장르 2개는? | (a) 무협 + 현판 헌터 회귀 (b) 무협 + 로판 회귀 (c) 현판 + 로판 빙의 (d) 무협 + 현판 전문직 회귀(개정: 추가) | **(a)**. 무협·현판은 L1 기준 남성향 상위 2개 장르(TOP100 68편, 장르 구성은 재현 확인)입니다. 다만 작품 B가 대표하는 헌터·게이트 하위 장르 비중은 작고(현판 4 + 판타지 13 키워드 출현, 재집계), 선택 근거는 PRD 5.1 시나리오 일치와 규칙 밀도(P1·P3·P5)입니다(개정). 재검토 조건: 표본 50편 수동 라벨 비교(research-webnovel-market 9절)에서 상위 5개 묶음 순위가 바뀌면 다시 봅니다. (b)는 여성향 검증 장점이 있으나 빙의 결합 시 `source_work`가 필요해질 수 있습니다. (c)는 회귀물 조건을 못 채웁니다. (d)는 시장 비중이 가장 크지만 규칙 밀도가 낮고 실존 단체 정책(D-33) 감점이 있습니다 | 확정(조건부): 표본 50편 수동 라벨 비교에서 상위 5개 묶음 순위가 바뀌면 재검토 |
| DG-02 | D-30 | FR-NOV-03 일부를 앞당깁니까? | (i) 그대로 v1 (ii) 03b(MVP-β 축소: `wuxia`·회귀 `full`, 헌터 `questions_only`) + MB-0 2~3주 신설·MVP-β 1~2주 연장 + 03c(v1 별도 트랙) (iii) 원안(3개 `full`) + MVP-β 5~6주 연장(개정: 선택지와 일정 영향 명시) | **(ii)**. 카테고리 키는 FR-NOV-11이 MVP-α에서 다루므로 03a는 필요 없습니다. 검증 작품 2개가 템플릿을 쓰면 SC-4·SC-6을 실데이터로 측정합니다. 원안 공수는 09 용량에 들어가지 않습니다(6절 용량 대조) | 확정 |
| DG-03 | D-31 | 카테고리 식별자 체계 | 3층 + 패싯, 2.2절 통일 키 / 세계관 조사 키 / 플랫폼별 키 | **3층 + 패싯, 시장 조사 키 기준 통일 + 중복 해소표(개념 1개 = 키 1개)**. 플랫폼 1단 메뉴와 대응이 쉽습니다 | 확정 |
| DG-04 | D-32 | `base@2` 메커니즘 채택 범위와 시점 | 전부 MVP-β / MVP-β 7개 + v1 4개 / v1 일괄 | **MVP-β 7개(B-1·B-3·B-4·B-5·B-6·B-10·B-11) + v1 4개(B-2·B-7·B-8·B-9)**. 검증 장르에 필요한 것만 먼저 넣습니다. ADR-005 확정 뒤 06 개정 | 확정 |
| DG-05 | D-33 | 대체역사·스포츠·연예계·전문직의 실존 인물·단체 허용 범위(06 O-19, 07 SF-3) | A 사후 일정 기간 지난 역사 인물의 명백한 허구 행동 허용 / B 가명화만 / C 현행 + 매 화 확인 | **A(장르 성립)**. 기준 연도·목록 출처는 법률 검토(D-12)와 함께 정하고, 그때까지 해당 템플릿 배포를 보류합니다. 명예훼손 성격은 계속 차단합니다. `modern_fantasy.professional`은 v1 1차 목록에 넣지 않고 v1 2차로 둡니다(포함했다면 SC-2 현판 값 60% → 80%, 2026-10-28 재집계로 재대조) | 확정(방침): A. 기준 연도·목록 출처는 D-12와 함께 정하고 그때까지 해당 템플릿 배포 보류. `modern_fantasy.professional`은 v1 2차 유지(1차 미포함) |
| DG-06 | D-34 | 수위 연동 태그(하렘·TS·피폐 등)와 BL 패싯 노출 | MVP 미노출 / 태그만 노출 / 템플릿 제공 | **MVP 미노출, 성인 등급 결정(D-13 후속) 때 재검토** | 확정 |
| DG-07 | D-35 | 책빙의 "원작" 범위 | 작중 가상 원작만 / 실제 출간작 허용 | **가상 원작만**. 실제 출간작은 저작권 위험이 큽니다. 컨셉 필수 질문으로 확인 | 확정. 실제 출간작이면 승인 요청 차단(11 CQ-10b, INV-CON-15) |
| DG-08 | D-36 | 템플릿 업그레이드 정책 | 기존 작품 고정 + 선택 업그레이드 / 자동 반영 | **고정 + 선택 업그레이드(06 4.5 제안 경로)**. 공개된 사실(`published_locked`)과 충돌을 막습니다 | 확정 |
| DG-09 | D-37 | 장르 검수자 섭외와 재조사 주기 | 검수자 1인/장르, 분기 재조사 / 내부만, 반기 / (개정: 추가) MVP-β 템플릿만 내부 검수로 `reviewed` 허용, v1 `released` 전 외부 검수 | **장르당 검수자 1인, 섭외는 MA-6(D-26 평가자 섭외 MB-3보다 앞, 개정)**. 섭외가 늦으면 MVP-β에 한해 내부 검수 예외. 재조사는 랭킹 분기·플랫폼 메뉴 90일·실태조사 2년 | 확정 |

참고: 회귀물 "이전 회차" 표현(시간선 vs 인물 지식, research-webnovel-market 1절 6번)은 06 3.13이 이미 `timelines(kind=regression)` + `retains_memory`로 정했으므로 새 결정으로 올리지 않습니다. 템플릿은 그 모델을 따릅니다.

---

## 9. 견본 (구조 예시, 일부)

아래는 형식을 보여 주는 **일부**입니다. 값은 장르 관습 수준의 기본값이고, 수치 기본값은 가정입니다. 출처 ID는 10절 ID를 씁니다. `base@2` 필드(B-1·B-3·B-4·B-5·B-6·B-10·B-11)와 `max_holders: unbounded`, 유형 수준 호칭 규칙은 06 개정 전 제안 형식입니다. 견본은 S-21에서 TV-01~TV-13으로 실제 검사하고, 작성 시점의 수동 점검 결과는 9.5절에 둡니다.

| 견본 | 릴리스 | 쓰임 |
|---|---|---|
| 9.1 `wuxia` | MVP-β (`full`) | 검증 작품 A |
| 9.2 `rebirth.regression` | MVP-β (`full`) | 검증 작품 B |
| 9.3 `modern_fantasy` + `.hunter_gate` | MVP-β (`questions_only`), v1 2.0.0에서 `full` | 검증 작품 B. 합성 예는 작품 B 조합 |
| 9.4 `romance_fantasy`, `rebirth.book_possession` | v1 | 경칭·책빙의 형식 예시 |

### 9.1 무협 L1 템플릿 `wuxia` (일부)

```yaml
# packages/shared/genre-templates/genre/wuxia.yaml
key: wuxia
version: 1.0.0
template_kind: genre
content_level: full
label_ko: 무협
description_ko: 문파·세가와 정파·사파·마도 세력, 경지와 내공으로 무력을 서열화하는 동양풍 무림 세계.
status: draft
requires_base: base@2
uses_shared: [shared.honorifics_common@1]      # 의형제 등 장르 공통 관계 호칭(3.1절)
aliases: [ability_system.cultivation, stage.murim_factions]
platform_mapping: { naver_series: 무협, munpia: 무협, ridi: "판타지 > 무협 소설", novelpia: 무협 }
overseas_mapping: { wattpad: "Fantasy > Wuxia and Cultivation", webnovel: Wuxia }
safety_profile: { real_person_check: default, age_rating_max_default: age_15 }

schema_extension:
  entity_types:
    - { key: sect, parent: organization, label_ko: 문파, attributes_allowed: [faction_alignment], basis: convention_assumption }
    - { key: clan, parent: organization, label_ko: 세가, attributes_allowed: [faction_alignment], basis: convention_assumption }
    - { key: martial_art, parent: ability, label_ko: 무공, attributes_allowed: [art_kind, system_listed], basis: convention_assumption }
    - { key: technique, parent: ability, label_ko: 초식, attributes_allowed: [order_in_art], basis: convention_assumption }
  relation_types:
    - key: sworn_sibling_of            # 의형제. 혈연 sibling_of의 하위 관계가 아님
      label_ko: 의형제
      synonyms: [결의형제, 의형, 의제]
      domain: [character]
      range: [character]
      symmetric: true
      fact_kind: relation
      temporal: [no_new_after_subject_death, no_new_after_object_death]
      default_severity: medium
      basis: convention_assumption
    - key: technique_of
      label_ko: 초식 소속
      domain: [technique]
      range: [martial_art]
      max_per_subject: 1
      fact_kind: relation
      default_severity: medium
      basis: convention_assumption

ordinal_scales:
  - key: murim_realm
    label_ko: 경지
    allow_gaps: false                  # 질문 wuxia:q_realm_gaps 로 바꿀 수 있음
    open_top: true                     # 작품마다 정점이 다름
    concept_question: "wuxia:q_realm_peak"
    levels:
      - { key: third_rate,   label_ko: 삼류,   rank: 1 }
      - { key: second_rate,  label_ko: 이류,   rank: 2 }
      - { key: first_rate,   label_ko: 일류,   rank: 3 }
      - { key: peak,         label_ko: 절정,   rank: 4 }
      - { key: super_peak,   label_ko: 초절정, rank: 5 }
      - { key: hwagyeong,    label_ko: 화경,   rank: 6 }
      - { key: hyeongyeong,  label_ko: 현경,   rank: 7 }
      - { key: saengsagyeong, label_ko: 생사경, rank: 8 }
    source_ids: [G1, G4, G5]
    basis: source                      # 4.4절 K-2 충족(장르 일반 해설 2건 + 위키 미러, 모두 [2차]). 작품마다 이름·단계가 달라 open_top·덮어쓰기 기본, 검수자 확인(S5) 유지

attribute_bundles:                     # 하위 속성은 묶음의 basis를 상속(TV-08)
  - key: wuxia.cultivation
    label_ko: 무공 수위
    basis: convention_assumption
    attributes:
      - key: realm
        domain: [character]
        value_type: "ordinal:murim_realm"
        single_valued: true
        temporal:
          - { kind: monotonic_non_decreasing, exception_event_predicates: [cultivation_crippled, realm_sealed] }
      - key: inner_energy
        domain: [character]
        value_type: integer            # 단위 "년"은 용어집 '갑자' 정의(1갑자 = 60년). B-2 numeric은 v1
        single_valued: true
      - key: generation                # 항렬(문파 내 대수)
        domain: [character]
        value_type: integer
        single_valued: true
      - key: art_kind
        domain: [martial_art]
        value_type: enum
        enum: [mind_method, sword, saber, fist, footwork, hidden_weapon, other]
        single_valued: true
      - key: order_in_art
        domain: [technique]
        value_type: integer
        single_valued: true
      - key: system_listed             # 무협 + 상태창 조합에서 시스템이 표시하는 무공(3.3절)
        domain: [martial_art]
        value_type: boolean
        single_valued: true
  - key: wuxia.world_settings
    label_ko: 무림 세력·시대
    basis: convention_assumption
    attributes:
      - key: faction_alignment
        domain: [sect, clan, character]
        value_type: enum
        enum: [orthodox, unorthodox, demonic, neutral]   # 정파, 사파, 마도, 중립
        single_valued: true
      - key: era_basis
        domain: [rule]
        value_type: enum
        enum: [fictional_era, real_dynasty]
        single_valued: true

title_defs:                            # B2에서 문파·세가마다 칭호 엔티티 생성(3.4 (e) TI-1~TI-5)
  - { key: sect_leader, label_ko: 장문인, title_of: [sect], max_holders: 1, succession_rule: appointment, basis: convention_assumption }
  - { key: clan_head,   label_ko: 가주,   title_of: [clan], max_holders: 1, succession_rule: appointment,
      succession_note: "장자 승계 여부는 작품마다 다름", basis: convention_assumption }
  - { key: elder,       label_ko: 장로,   title_of: [sect, clan], max_holders: unbounded, succession_rule: appointment,
      basis: convention_assumption }   # unbounded 값은 06 3.5 정의 요청(TI-3)

address_rules:                         # 유형 수준 호칭 규칙(06 3.7 새 층 요청). 조건 키는 06 이름(older)
  - { surface: 사부, group: sect_kinship, condition: { relation: master_of, target_role: subject }, basis: convention_assumption }
  - { surface: 사형, group: sect_kinship, condition: { relation_path: ["master_of^-1", "master_of"], older: true }, basis: convention_assumption }
  - { surface: 사제, group: sect_kinship, condition: { relation_path: ["master_of^-1", "master_of"], older: false }, basis: convention_assumption }
  # '선배'는 두지 않음: 관습상 입문·연배 기준이고 경지 서열 기준이 아님(3.4 (e))

continuity_rules:
  - key: wuxia.realm_no_regression
    statement_ko: "경지는 폐공·봉인 같은 사건 없이 내려가지 않는다."
    applies_to: [realm]
    prefilter: ordinal_regression
    params: { exception_event_predicates: [cultivation_crippled, realm_sealed] }
    issue_kind: ability_rule
    severity: high
    llm_check: false
    default_enabled: true
    golden_seed_ids: [GT-W01]
    basis: convention_assumption
  - key: wuxia.realm_skip
    statement_ko: "경지는 단계를 건너뛰지 않는다(작품이 허용하면 끔)."
    applies_to: [realm]
    prefilter: ordinal_skip
    params: { enabled_when: "item:wuxia/ordinal_scales/murim_realm#allow_gaps == false" }
    issue_kind: ability_rule
    severity: medium
    default_enabled: true
    golden_seed_ids: [GT-W02]
    basis: convention_assumption
  - key: wuxia.generation_step
    statement_ko: "제자의 항렬은 사부 항렬 + 1이다."
    applies_to: [master_of, generation]
    prefilter: attribute_delta
    params: { relation: master_of, attribute: generation, expected_delta: 1 }
    issue_kind: relationship
    severity: medium
    golden_seed_ids: [GT-W03]
    basis: convention_assumption
  - key: wuxia.sect_leader_single
    kind: documentation_only           # prefilter·issue_kind·severity 면제
    statement_ko: "한 문파의 장문인은 동시에 1명이다."
    covered_by: CR-09                  # holds_title + max_holders=1 로 이미 검사
    golden_seed_ids: [GT-W05]
    basis: convention_assumption
  - key: wuxia.upset_needs_cause
    statement_ko: "같은 경지에서 압도적 승패에는 무공 상성·영약·기연 같은 원인 사실이 있어야 한다."
    prefilter: llm_rule
    issue_kind: ability_rule
    severity: low
    llm_check: true
    default_enabled: false             # 오탐 위험(R-5). 사용자가 켬
    basis: convention_assumption
  # wuxia.faction_disjoint(GT-W06)는 attribute_disjoint 필터가 v1이라 1.1.0(v1)에서 추가

setup_patterns:
  - { key: lost_manual, label_ko: 실전 비급, plant_hint: "비급의 단서가 처음 등장", reinforce_hint: "다른 세력도 비급을 추적",
      payoff_hint: "습득 또는 비급의 정체 공개", typical_due: arc, links_entity_types: [martial_art, item], basis: convention_assumption }
  - { key: hidden_lineage, label_ko: 숨은 사문·혈통, plant_hint: "주인공 초식이 실전된 문파와 닮음",
      payoff_hint: "출신 공개", typical_due: "episodes:60", links_entity_types: [sect, character], basis: convention_assumption }

glossary_seed:
  default_hanja_policy: 첫 등장만
  basis: convention_assumption
  terms:
    - { surface: 갑자, category: term, definition: "내공을 세는 단위. 1갑자는 60년 수련 분량.",
        preferred_surface: 갑자, spelling_rules: { hanja: "갑자(甲子)", hanja_policy: 첫 등장만 } }
    - { surface: 내공, category: term, definition: "수련으로 쌓은 체내 기운의 양.", preferred_surface: 내공 }
    - { surface: 경공, category: term, definition: "몸을 가볍게 해 빠르게 이동하는 무공.", preferred_surface: 경공 }

concept_questions:                     # 계약 = 11 3.6 ConceptQuestionDef. 같은 층 안 순서 = 배열 순서
  - key: q_faction
    stage: diverging
    required_level: template_required
    ask_ko: "주인공은 어느 세력에서 출발하나요?"
    option_seeds:
      - { label: 정파 명문, value: orthodox, note: "명문 대파 소속" }
      - { label: 정파 군소 문파, value: orthodox, note: "몰락·약소 문파" }
      - { label: 사파·마교, value: demonic }
      - { label: 무소속, value: neutral }
    fills: "world_rules[item:wuxia/attributes/faction_alignment]"
    why_ko: "소속·적대 관계와 호칭 규칙의 기준이 됩니다."
  - key: q_realm_peak
    stage: diverging
    required_level: template_required
    ask_ko: "경지는 어디까지 두나요? (기본: 삼류~생사경 8단계)"
    default_value: saengsagyeong
    fills: "item:wuxia/ordinal_scales/murim_realm#levels"
    why_ko: "경지 역행 검사에 쓰입니다."
  - key: q_realm_gaps
    stage: diverging
    required_level: optional
    ask_ko: "경지를 한 번에 두 단계 이상 뛰어오를 수 있나요?"
    option_seeds: [{ label: 아니요, value: false }, { label: 예, value: true }]
    default_value: false
    fills: "item:wuxia/ordinal_scales/murim_realm#allow_gaps"
    why_ko: "'예'면 경지 건너뛰기 검사를 끕니다."
  - key: q_real_dynasty
    stage: diverging
    required_level: optional
    ask_ko: "배경이 실제 왕조인가요, 가상의 시대인가요?"
    option_seeds: [{ label: 가상의 시대, value: fictional_era }, { label: 실제 왕조, value: real_dynasty }]
    safety_flags: [real_person_risk]
    fills: "world_rules[item:wuxia/attributes/era_basis]"
    why_ko: "실제 왕조면 실존 인물 정책(D-33)이 적용됩니다."
  - key: q_hanja
    stage: converging
    required_level: optional
    ask_ko: "무공·문파 이름에 한자를 병기할까요?"
    option_seeds: [{ label: 첫 등장만, value: 첫 등장만 }, { label: 쓰지 않음, value: 쓰지 않음 }, { label: 매번, value: 매번 }]
    default_value: 첫 등장만
    fills: "item:wuxia/glossary_seed/default_hanja_policy"

reader_expectations:                   # 수치는 가정
  basis: convention_assumption
  cider_cycle_episodes: { min: 3, max: 5 }
  max_frustration_run: 3
  episode_end_hook: { required: true, preferred_kinds: [confrontation, reveal, power_up_tease], forbid_repeat_kind_run: 3 }
  growth_milestone: { per: arc, kinds: [realm_up, art_acquired] }

sources:
  - { id: G1, url: "https://thewiki.kr/w/경지", grade: 2차, checked_at: 2026-10-28, supports: ["item:wuxia/ordinal_scales/murim_realm"] }
  - { id: G4, url: "https://yellowit.co.kr/직장인-연말정산-국민내일배움카드-노동법/무협-경지-비교-총정리-삼류-이류-일류-절정-화경-현경/", grade: 2차, checked_at: 2026-10-28, supports: ["item:wuxia/ordinal_scales/murim_realm"] }
  - { id: G5, url: "https://jab-guyver.co.kr/6782", grade: 2차, checked_at: 2026-10-28, supports: ["item:wuxia/ordinal_scales/murim_realm"] }
  - { id: S4, url: "https://series.naver.com/novel/top100List.series?rankingTypeCode=WEEKLY&categoryCode=ALL", grade: 1차, checked_at: 2026-10-28, supports: [platform_mapping] }
  - { id: S18, url: "https://creators.wattpad.com/writing-resources/get-started-on-wattpad/categorizing-your-story-on-wattpad/", grade: 1차, checked_at: 2026-10-28, supports: [overseas_mapping] }
```

### 9.2 회귀 트로프 믹스인 `rebirth.regression` (일부)

```yaml
# packages/shared/genre-templates/trope_mixin/rebirth.regression.yaml
key: rebirth.regression
version: 1.0.0
template_kind: trope_mixin
mixin_level: full
label_ko: 회귀
status: draft
requires_base: base@2
requires_features: [multi_timeline]    # MVP-β (06 3.13, 09 MB-2)
applies_to_genres: ["*"]
priority: 10

attribute_bundles:                     # 회귀 설정값의 유일한 원천. 질문은 item_key로 이 속성을 가리킴
  - key: rebirth.regression.rule_settings
    label_ko: 회귀 규칙
    source_ids: [A1]
    basis: convention_assumption
    attributes:
      - { key: regression_trigger, domain: [rule], value_type: enum,
          enum: [death, specific_event, voluntary, unknown], single_valued: true }
      - { key: rewind_span, domain: [rule], value_type: string, single_valued: true }      # 예: "10년 전, 각성 직전"
      - { key: memory_scope, domain: [rule], value_type: enum,
          enum: [full, until_death, partial], single_valued: true }
      - { key: carry_over_scope, domain: [rule], value_type: enum,
          enum: [memory_only, skills_partial, skills_and_items], single_valued: true }
      - { key: regression_limit, domain: [rule], value_type: integer, single_valued: true }  # 없으면 무제한

continuity_rules:
  - key: rebirth.regression.memory_without_carry
    kind: documentation_only
    statement_ko: "이전 회차 기억은 retains_memory가 있는 인물만 쓴다."
    covered_by: CR-17
    golden_seed_ids: [GT-R01]
    basis: convention_assumption
  - key: rebirth.regression.carry_over_missing
    statement_ko: "이전 회차의 물건·능력은 이월 사실이 있어야 새 회차에서 쓴다."
    prefilter: timeline_carry_check
    params: { predicates: [owns, has_ability] }
    issue_kind: ability_rule
    severity: high
    golden_seed_ids: [GT-R02]
    basis: convention_assumption
  - key: rebirth.regression.stale_future_knowledge
    statement_ko: "이미 바뀐 사건을 회귀자가 원래대로 일어난다고 믿고 행동하면, 서술이 그 착오를 인지해야 한다."
    prefilter: llm_rule
    params: { compare: parent_timeline_slots }   # 06 6.3 계보 해석(3.3절 E-1·E-2)
    issue_kind: character_knowledge
    severity: medium
    llm_check: true
    golden_seed_ids: [GT-R03]
    basis: convention_assumption

setup_patterns:
  - { key: regression_cause, label_ko: 회귀 원인, plant_hint: "회귀 직후 원인에 대한 의문", payoff_hint: "원인 공개·단절", typical_due: arc, basis: convention_assumption }
  - { key: first_life_betrayer, label_ko: 전생 배신자, plant_hint: "이전 회차 배신 장면 회상", payoff_hint: "이번 회차 대면·응징", typical_due: arc, basis: convention_assumption }
  - { key: other_regressor, label_ko: 또 다른 회귀자, plant_hint: "미래를 아는 듯한 다른 인물", payoff_hint: "정체 공개", typical_due: "episodes:80", basis: convention_assumption }
  - { key: butterfly_effect, label_ko: 나비효과, plant_hint: "회귀자의 개입으로 작은 사건이 바뀜", payoff_hint: "미래 지식이 크게 틀림", typical_due: arc, basis: convention_assumption }

concept_questions:
  - { key: q_trigger, stage: diverging, required_level: template_required, ask_ko: "무엇이 회귀를 일으키나요?",
      option_seeds: [{ label: 사망, value: death }, { label: 특정 사건, value: specific_event }, { label: 스스로 선택, value: voluntary }, { label: 아직 비밀, value: unknown }],
      fills: "world_rules[item:rebirth.regression/attributes/regression_trigger]" }
  - { key: q_rewind_span, stage: diverging, required_level: template_required, ask_ko: "몇 년 전 어느 시점으로 돌아가나요?",
      fills: "world_rules[item:rebirth.regression/attributes/rewind_span]" }
  - { key: q_memory, stage: diverging, required_level: template_required, ask_ko: "무엇을 기억하고 무엇을 잃나요?",
      option_seeds: [{ label: 전부 기억, value: full }, { label: 죽기 직전까지, value: until_death }, { label: 일부 손실, value: partial }],
      fills: "world_rules[item:rebirth.regression/attributes/memory_scope]" }
  - { key: q_carry, stage: diverging, required_level: optional, ask_ko: "기억 말고도 넘어오는 것(능력 숙련·물건)이 있나요?",
      option_seeds: [{ label: 기억만, value: memory_only }, { label: 능력 일부, value: skills_partial }, { label: 능력과 물건, value: skills_and_items }],
      fills: "world_rules[item:rebirth.regression/attributes/carry_over_scope]" }
  - { key: q_twist, stage: diverging, required_level: optional, saturation_variant: true,
      ask_ko: "흔한 회귀물과 다른 점은 무엇인가요? (다회귀, 부분 회귀, 회귀의 대가 등)", fills: "differentiators" }

reader_expectations:
  basis: convention_assumption
  source_ids: [C4]
  episode1_promise: "1화 안에 회귀 사실과 주인공의 정보 우위를 보여 준다."
  future_knowledge_payoff_every_episodes: { min: 3, max: 6 }                # 가정

variants:
  - when: { all_of: [rebirth.regression, wuxia] }
    patch:
      attribute_bundles:
        - key: rebirth.regression.wuxia_carry
          basis: convention_assumption
          attributes:
            - { key: martial_mastery_carry, domain: [rule], value_type: enum, enum: [memory_only, partial, full], single_valued: true }
      concept_questions:
        - { key: q_wuxia_skill_memory, stage: diverging, required_level: template_required,
            ask_ko: "전생 무공은 기억만 남나요, 몸의 숙련도도 이어지나요?",
            option_seeds: [{ label: 기억만, value: memory_only }, { label: 숙련도 일부, value: partial }, { label: 전부, value: full }],
            fills: "world_rules[item:rebirth.regression/attributes/martial_mastery_carry]" }
  - when: { all_of: [rebirth.regression, modern_fantasy.hunter_gate] }
    patch:
      setup_patterns:
        - { key: regressor_future_gate, label_ko: 회귀자가 아는 미래 게이트, plant_hint: "아직 열리지 않은 게이트를 주인공만 앎",
            payoff_hint: "게이트 출현과 선점", typical_due: arc, basis: convention_assumption }
  # 회귀 × 상태창(레벨·스탯 이월, 장부 리셋)은 상태창이 v1이라 1.1.0(v1)에서 추가(TV-03 릴리스 단계 규칙)
```

**검증 작품 A 합성 결과 (`wuxia` 단독)**: 템플릿 질문 `template_required` 2개(`q_faction`, `q_realm_peak`), 켜진 규칙 3개 + `documentation_only` 1건(CR-09), 떡밥 패턴 2개.

### 9.3 현판 L1 `modern_fantasy`과 헌터 L2 `modern_fantasy.hunter_gate` (MVP-β `questions_only`)

```yaml
# packages/shared/genre-templates/genre/modern_fantasy.yaml (일부)
key: modern_fantasy
version: 1.0.0
template_kind: genre
content_level: questions_only           # 스키마 확장·규칙 없음. base@1에서도 로드
label_ko: 현대판타지
status: draft
requires_base: base@1
platform_mapping: { naver_series: 현판, munpia: 현대판타지, novelpia: 현대판타지 }
overseas_mapping: { wattpad: "Fantasy" }
safety_profile: { real_person_check: strict, age_rating_max_default: age_15 }   # 실제 국가·지명·단체 의존(2.5절 C5)

concept_questions:
  - { key: q_world_basis, stage: diverging, required_level: template_required,
      ask_ko: "배경 도시·국가는 실제 지명인가요, 가상의 지명인가요?",
      option_seeds: [{ label: 실제 지명(단체·인물은 가상), value: real_place }, { label: 가상 지명, value: fictional_place }],
      safety_flags: [real_person_risk], fills: "world_rules[note:world_basis]",
      why_ko: "실제 지명이면 실존 단체·인물 검사가 강해집니다." }

reader_expectations:
  basis: convention_assumption
  cider_cycle_episodes: { min: 2, max: 5 }
  episode_end_hook: { required: true, preferred_kinds: [power_up_tease, confrontation, reveal] }
```

```yaml
# packages/shared/genre-templates/subgenre/modern_fantasy.hunter_gate.yaml
key: modern_fantasy.hunter_gate
version: 1.0.0
template_kind: subgenre
content_level: questions_only
extends: modern_fantasy
aliases: [stage.gate_dungeon]
label_ko: 헌터·게이트
description_ko: 현대에 게이트·던전이 열리고 각성자(헌터)가 등급별로 공략하는 세계.
status: draft
requires_base: base@1
platform_mapping: { naver_series: "현판(키워드)", munpia: "현대판타지(키워드)" }
safety_profile: { real_person_check: strict, age_rating_max_default: age_15 }

setup_patterns:
  - { key: gate_origin, label_ko: 게이트의 기원, plant_hint: "첫 게이트 출현의 이상한 정황", payoff_hint: "게이트를 연 주체·이유 공개", typical_due: arc, basis: convention_assumption }
  - { key: hidden_rank, label_ko: 숨긴 등급, plant_hint: "측정 결과와 다른 실제 힘의 단서", reinforce_hint: "측정 장치의 오작동·조작 정황", payoff_hint: "실제 등급 공개", typical_due: arc, basis: convention_assumption }
  - { key: dungeon_break, label_ko: 던전 브레이크 예고, plant_hint: "방치된 게이트의 징후", payoff_hint: "브레이크 발생과 대응", typical_due: "episodes:30", basis: convention_assumption }

glossary_seed:
  default_hanja_policy: 쓰지 않음
  basis: convention_assumption
  terms:
    - { surface: 게이트, category: term, definition: "몬스터가 사는 공간으로 이어지는 균열.", preferred_surface: 게이트 }
    - { surface: 각성, category: term, definition: "일반인이 능력을 얻어 헌터가 되는 일.", preferred_surface: 각성 }
    - { surface: 던전 브레이크, category: term, definition: "공략하지 않은 게이트에서 몬스터가 밖으로 나오는 일.", preferred_surface: 던전 브레이크,
        spelling_rules: { spacing: 띄움 } }

concept_questions:
  - { key: q_rank_scale, stage: diverging, required_level: template_required,
      ask_ko: "헌터 등급은 몇 단계이고 맨 위는 무엇인가요?",
      option_seeds: [{ label: "F~S 7단계", value: "F,E,D,C,B,A,S" }, { label: "1~10급", value: "10..1" }],
      default_value: "F,E,D,C,B,A,S", fills: "world_rules[note:hunter_rank_scale]",
      why_ko: "v1에서는 등급 변화 검사의 기준이 됩니다." }
  - { key: q_awakening, stage: diverging, required_level: template_required,
      ask_ko: "각성은 언제·어떻게 일어나고, 등급을 다시 잴 수 있나요?", fills: "world_rules[note:awakening_rule]" }
  - { key: q_gate_lifecycle, stage: diverging, required_level: template_required,
      ask_ko: "공략한 게이트는 다시 열리나요? 방치하면 어떻게 되나요?", fills: "world_rules[note:gate_lifecycle]" }
  - { key: q_hunter_org, stage: diverging, required_level: optional,
      ask_ko: "헌터를 관리하는 조직(협회·길드)은 국가 기관인가요, 민간인가요?", fills: "world_rules[note:hunter_org]" }

reader_expectations:
  basis: convention_assumption
  growth_milestone: { per: arc, kinds: [rank_reassessed, skill_acquired] }
```

**v1 2.0.0 추가분(요약)**: `content_level: full`, `requires_base: base@2`. 척도 `hunter_rank`(F~S, `open_top: false`), 속성 묶음 `modern_fantasy.hunter_gate.status`(`hunter_rank`, `gate_grade` 순서형, `gate_state` enum `open`/`cleared`/`broken`), 이벤트 술어 `rank_assessment`·`awakening`·`gate_regraded`, 규칙 4개(`rank_change_requires_event`·`gate_grade_stable`(`change_requires_event`), `gate_no_reopen`(`state_transition`), `skill_before_awakening`(`ability_before_event`), 시드 GT-H01~H04·GT-HR01). 1.0.0의 `world_rules[note:*]` 답을 2.0.0 항목으로 옮기는 변환은 `changelog`에 적지만, 검증 작품 B는 업그레이드하지 않습니다(6절).

**합성 결과 예 (검증 작품 B: `modern_fantasy` + `.hunter_gate` + `rebirth.regression`, MVP-β)**

| 구성 요소 | 결과 |
|---|---|
| 템플릿 질문(11 3.6 순서: 장르 → 하위 장르 → 트로프) | `modern_fantasy:q_world_basis` → `hunter_gate:q_rank_scale` → `q_awakening` → `q_gate_lifecycle` → `rebirth.regression:q_trigger` → `q_rewind_span` → `q_memory`. `template_required` 7개 ≤ `concept.max_template_questions`(8). `optional` 3개(`q_hunter_org`, `q_carry`, `q_twist`)는 "자세히" 선택 시만. `fills` 중복 없음 |
| 스키마 확장 | `rebirth.regression.rule_settings`(속성 5개)만. 헌터는 `questions_only`라 확장 없음 |
| 연속성 규칙(켜짐) | `rebirth.regression.carry_over_missing`, `rebirth.regression.stale_future_knowledge` + `documentation_only` 1건(CR-17). 평가 범위는 3.3절 E-1~E-4 |
| 떡밥 패턴 | `gate_origin`, `hidden_rank`, `dungeon_break`, `regression_cause`, `first_life_betrayer`, `other_regressor`, `butterfly_effect` + `variants`의 `regressor_future_gate` |
| 독자 기대(3.3절 연산) | 사이다 주기 2~5화(현판만 정의), 1화 약속(회귀 문장, 사용자 확인), 미래 지식 회수 3~6화, 훅 종류 합집합(`power_up_tease`, `confrontation`, `reveal`), 성장 비트(`rank_reassessed`, `skill_acquired`) |
| 알려진 조합 | 3.3절 "헌터 + 회귀". MVP-β에는 헌터 규칙이 없어 오탐 위험 규칙 없음. v1에서 GT-HR01로 확인 |

### 9.4 v1 견본: 로판 `romance_fantasy`과 책빙의 `rebirth.book_possession` (일부)

```yaml
# packages/shared/genre-templates/shared/shared.honorifics_court.yaml (일부)
key: shared.honorifics_court
version: 1.0.0
template_kind: shared
address_rules:                         # 같은 group은 한 대상에 동시에 하나만(priority 작은 쪽 우선, TV-13)
  - { surface: 전하, group: court_honorific, priority: 1, condition: { target_member_of_type: royal_house }, basis: convention_assumption }
  - { surface: 전하, group: court_honorific, priority: 1, condition: { target_title_rank_at_least: "peerage:grand_duke" }, basis: convention_assumption }
  - { surface: 각하, group: court_honorific, priority: 2,
      condition: { target_title_rank_at_least: "peerage:duke", target_title_rank_below: "peerage:grand_duke" }, basis: convention_assumption }
  # 전하 = 왕족·대공, 각하 = 공작 등 고위 작위(research-genre-world-elements 4.4). 경계는 작품마다 달라 컨셉 질문으로 확정
```

```yaml
# packages/shared/genre-templates/genre/romance_fantasy.yaml (일부)
key: romance_fantasy
version: 1.0.0
template_kind: genre
content_level: full
label_ko: 로맨스판타지
status: draft
requires_base: base@2
uses_shared: [shared.honorifics_court@1, shared.contract_relationship@1]

schema_extension:
  entity_types:
    - { key: noble_house, parent: organization, label_ko: 가문, attributes_allowed: [coat_of_arms, house_color], basis: convention_assumption }
    - { key: royal_house, parent: organization, label_ko: 왕가·황가, attributes_allowed: [coat_of_arms, house_color], basis: convention_assumption }
    - { key: fief, parent: place, label_ko: 영지, basis: convention_assumption }
  relation_types:
    - key: betrothed_to
      label_ko: 약혼
      synonyms: [정혼, 혼약]
      domain: [character]
      range: [character]
      symmetric: true
      max_per_subject: 1               # 동시 1
      disjoint_with: [spouse_of]       # 같은 쌍의 약혼·혼인 동시 성립 금지
      fact_kind: relation
      default_severity: high
      basis: convention_assumption

attribute_bundles:
  - key: romance_fantasy.house
    label_ko: 가문 표지
    basis: convention_assumption
    attributes:
      - { key: coat_of_arms, domain: [noble_house, royal_house], value_type: string, visual_attribute: true }  # FR-SPX-03
      - { key: house_color, domain: [noble_house, royal_house], value_type: string, visual_attribute: true }

ordinal_scales:
  - key: peerage
    label_ko: 작위
    allow_gaps: true
    open_top: false
    levels:
      - { key: baronet,  label_ko: 준남작, rank: 1 }
      - { key: baron,    label_ko: 남작,   rank: 2 }
      - { key: viscount, label_ko: 자작,   rank: 3 }
      - { key: count,    label_ko: 백작,   rank: 4 }
      - { key: marquess, label_ko: 후작,   rank: 5 }
      - { key: duke,     label_ko: 공작,   rank: 6 }
      - { key: grand_duke, label_ko: 대공, rank: 7 }
    basis: convention_assumption       # 1·2차 문서 미확인(research-genre-world-elements 4.4, U-3)

title_defs:
  - { key: peer_title, label_ko: 작위, title_rank: "ordinal:peerage", title_of: [noble_house, fief], max_holders: 1,
      succession_rule: primogeniture, basis: convention_assumption }

continuity_rules:
  - key: romance_fantasy.succession_violation
    statement_ko: "작위 승계는 succession_rule을 따른다. 찬탈·하사·박탈은 사건 사실이 필요하다."
    prefilter: succession_check        # v1(B-5)
    issue_kind: relationship
    severity: medium
    llm_check: true
    golden_seed_ids: [GT-RF01]
    basis: convention_assumption
  - key: romance_fantasy.honorific_misuse
    statement_ko: "공적 자리에서 낮은 신분이 높은 신분에게 경칭 없이 말하면 서술이 그 무례를 다뤄야 한다."
    prefilter: llm_rule
    issue_kind: relationship
    severity: low
    llm_check: true
    default_enabled: false
    golden_seed_ids: [GT-RF03]
    basis: convention_assumption

concept_questions:
  - { key: q_court, stage: diverging, required_level: template_required,
      ask_ko: "제국·왕국 중 어느 쪽이고, 작위 서열은 기본(공·후·백·자·남)대로 둘까요?", fills: "item:romance_fantasy/ordinal_scales/peerage#levels" }
  - { key: q_succession, stage: diverging, required_level: template_required, ask_ko: "작위·왕위는 누가 잇나요?",
      option_seeds: [{ label: 장자, value: primogeniture }, { label: 남계 장자, value: agnatic_primogeniture }, { label: 지명, value: appointment }, { label: 작품 고유 규칙, value: inheritance_custom }],
      fills: "item:romance_fantasy/title_defs/peer_title#succession_rule" }

reader_expectations:
  basis: convention_assumption
  romance_progress:                    # 사실이 아니라 아크 계획 지표(가정)
    stages: [first_meeting, friction, alliance_or_contract, emotional_turn, confession, commitment]
    target_by_arc_ratio: [0.05, 0.15, 0.3, 0.55, 0.8, 1.0]
  episode_end_hook: { required: true, preferred_kinds: [relationship_turn, reveal, confrontation] }
```

```yaml
# packages/shared/genre-templates/trope_mixin/rebirth.book_possession.yaml (일부)
key: rebirth.book_possession
version: 1.0.0
template_kind: trope_mixin
mixin_level: full
label_ko: 책빙의
status: draft
requires_base: base@2
requires_features: [possession_model, source_work_timeline]   # 06 3.13 persona/body, B-8 (v1)
applies_to_genres: [romance_fantasy, fantasy, modern_fantasy]
priority: 20

attribute_bundles:
  - key: rebirth.book_possession.source_settings
    label_ko: 원작 설정
    basis: convention_assumption       # 배역 enum은 관습 가정(A3가 뒷받침하지 않음)
    attributes:
      - { key: source_work_fictional, domain: [rule], value_type: boolean, single_valued: true }
      - { key: source_role, domain: [character, persona], value_type: enum, single_valued: true,
          enum: [protagonist, villainess, extra, male_lead, sub_male_lead, other] }   # 원작 속 배역

continuity_rules:
  - key: rebirth.book_possession.source_divergence_unacknowledged
    statement_ko: "원작과 달라진 사건을 빙의자가 원작대로라고 믿고 행동하면, 서술이 지식 갱신을 보여야 한다."
    prefilter: llm_rule
    params: { compare: [source_work, main] }
    issue_kind: character_knowledge
    severity: medium
    llm_check: true
    golden_seed_ids: [GT-BP01]
    basis: convention_assumption

setup_patterns:
  - { key: ruin_flag, label_ko: 원작 파멸 플래그, plant_hint: "원작 결말의 파멸 예정 사건 제시",
      reinforce_hint: "플래그가 다가오는 징후", payoff_hint: "회피 또는 변형된 형태로 도래", typical_due: arc, source_ids: [A3] }
  - { key: original_soul_fate, label_ko: 원래 영혼의 행방, plant_hint: "몸의 원래 주인 흔적", payoff_hint: "원래 영혼의 상태 공개",
      typical_due: "episodes:100", basis: convention_assumption }

concept_questions:
  - { key: q_fictional_source, stage: diverging, required_level: template_required,
      ask_ko: "빙의한 원작은 작중에만 있는 가상의 소설인가요? (실제 출간작은 쓸 수 없습니다)",
      option_seeds: [{ label: 가상의 소설로 새로 정함, value: true }],
      safety_flags: [copyright_risk],                                  # D-35(DG-07), 11 3.6
      fills: "world_rules[item:rebirth.book_possession/attributes/source_work_fictional]" }
  - { key: q_role, stage: diverging, required_level: template_required, ask_ko: "원작에서 주인공이 빙의한 인물의 배역은?",
      option_seeds: [{ label: 악녀·악역, value: villainess }, { label: 엑스트라, value: extra }, { label: 원작 주인공, value: protagonist }, { label: 조연, value: other }],
      fills: "world_rules[item:rebirth.book_possession/attributes/source_role]" }
  - { key: q_source_ending, stage: diverging, required_level: template_required,
      ask_ko: "원작 결말에서 그 인물은 어떻게 되나요?", fills: "world_rules[note:source_ending]" }

reader_expectations:
  basis: convention_assumption
  episode1_promise: "1화 안에 빙의 사실과 원작 속 예정된 위기를 보여 준다."   # 가정

sources:
  - { id: A3, url: "https://doi.org/10.18856/jpn.2020.26.3.003", grade: 1차, checked_at: 2026-10-28,
      supports: ["item:rebirth.book_possession/setup_patterns/ruin_flag"] }
```

책빙의 믹스인은 `source_work_timeline`(B-8, v1)이 필요해서 MVP-β에서는 배포하지 않습니다. MVP-β에서 로판 빙의 작품을 만들면 `rebirth.possession`(몸·인격 분리, 06 3.13)만 쓰고 원작 지식은 인물 지식 사실로 둡니다(가정).

### 9.5 견본 수동 점검 (2026-10-28, 작성자 점검, 빌드 실행 아님)

| TV | 결과 | 남은 조건 |
|---|---|---|
| TV-01 | 형식상 통과 예상 | `max_holders: unbounded`, 호칭 조건 `relation_path`·`target_title_rank_below`·`target_member_of_type`, `variants`, `kind: documentation_only`가 06·00·zod에 정의되어야 통과 |
| TV-02 | 통과 | 규칙 키 전체 접두사, 속성 키 유일(`faction_alignment` 등 확인) |
| TV-03 | 통과(MVP-β 빌드 기준) | v1 대상(`ability_system.status_window`, `stage.academy`) 참조를 견본에서 뺌. 9.4는 v1 빌드에서 검사 |
| TV-04 | 통과 | `murim_realm`·`peerage` 소유 1곳 |
| TV-05 | 9.1~9.3 통과, 9.4는 v1 빌드에서 통과 | `succession_check`는 v1 필터 |
| TV-06 | 통과 예상 | `world_rules[note:*]`·`differentiators` 경로는 11 5.4에 있음. `item:` 경로는 견본 안에 모두 존재 |
| TV-08 | 통과 | 모든 정의 원소에 `basis` 또는 `source_ids`. `sources[].id`는 10절 ID(G1·S4·S18·A1·A3·C4) |
| TV-11 | 통과 | 작품 B 조합 `template_required` 7 ≤ 8, 켜진 규칙 2 ≤ 20 |
| TV-12 | 경고 예상 | MVP-β 최소본 금지 목록이 아직 없음 |
| TV-13 | 통과 | `court_honorific`에서 왕족 공작은 전하(1)·각하(2) 둘 다 성립하지만 `priority`가 달라 전하로 결정 |

9.2 견본에는 `sources` 블록을 생략했습니다. 실제 파일에서는 `A1`·`C4`를 헤더 `sources[]`에 10절 행 그대로 넣어야 TV-08을 통과합니다.

---

## 10. 출처 (확인일 2026-10-28)

| ID | 출처 | 등급 |
|---|---|---|
| S1 | 이코노미스트, 2024 웹소설 산업 현황 실태조사 보도(2025-04-16) https://economist.co.kr/article/view/ecn202504160028 | [2차] |
| S2 | 뉴스서울, 2022 웹소설 실태조사 보도(2023-09-07) https://newsseoul.co.kr/news/view/1065580809716098. 장르 선호 "현실 로맨스 장르(47.4%)"는 2022 실태조사(2021 기준) 값 | [2차] |
| S3 | 위픽레터, 2022 실태조사 플랫폼 매출 인용(2023-09-12) https://letter.wepick.kr/post/3776 | [2차] |
| S4 | 네이버 시리즈 카테고리·주간 TOP100 https://series.naver.com/novel/categoryProductList.series , https://series.naver.com/novel/top100List.series?rankingTypeCode=WEEKLY&categoryCode=ALL | [1차] |
| S5 | 네이버 웹소설 장르·베스트 https://novel.naver.com/webnovel/genre?genre=101 | [1차] |
| S6 | 카카오페이지 웹소설 메뉴(검색 색인 요약) https://page.kakao.com/menu/10011/screen/76 | [2차] |
| S7 | 문피아 홈·공개 JS 번들 https://www.munpia.com/ | [1차] |
| S8 | 리디 전체 카테고리 https://ridibooks.com/category/list | [1차] |
| S9 | 노벨피아 PLUS https://novelpia.com/plus | [1차] |
| S10 | 조아라 홈·공개 JS 번들 https://www.joara.com/ | [1차] |
| S11 | 이투데이(다음뉴스), 2026 지상최대 웹소설 공모전 수상작(2026-07-22) https://v.daum.net/v/20260722103305369 | [2차] |
| S12 | JC미디어 웹소설 공모전 https://www.theteams.kr/activities/page/338997/lc | [2차] |
| S13 | STUDIO JHS 2026 무협·선협 공모전 https://thinkyou.co.kr/contest/60950/ | [2차] |
| S14 | StoryBench, 2026 장르 트렌드(2026-01-25) https://storybench.kr/blog/2026-%EC%9B%B9%EC%86%8C%EC%84%A4-%EC%9E%A5%EB%A5%B4-%ED%8A%B8%EB%A0%8C%EB%93%9C | [2차] |
| S17 | Wattpad 분류 개편 공지(2026-04-16) https://www.wattpad.com/1622584296-news-updates-stories-don%27t-fit-into-one-box-so-we. 장르·하위 장르 개수 구조만 근거(하위 장르 이름은 없음) | [1차] |
| S18 | Wattpad Creators, Categorizing your story https://creators.wattpad.com/writing-resources/get-started-on-wattpad/categorizing-your-story-on-wattpad/. 하위 장르 이름(Isekai and Reincarnation, Wuxia and Cultivation, Historical > Alternate Reality, LitRPG 등) | [1차] |
| A1 | 김경애, 「회빙환과 시간 되감기 서사의 문화적 의미」, 한국산학기술학회논문지 25(1), 2024 https://doi.org/10.5762/KAIS.2024.25.1.734 | [1차] |
| A2 | 서재인, 「한국 웹소설에 나타난 시스템 모티프 분석」, 대중서사연구 31(2), 2025 https://doi.org/10.18856/jpn.2025.31.2.012 | [1차] |
| A3 | 안상원, 「한국 웹소설의 '책빙의물'의 특성 연구」, 대중서사연구 26(3), 2020 https://doi.org/10.18856/jpn.2020.26.3.003. 원작 지식·파멸 예언 구조(`ruin_flag`)만 근거. 배역 enum(`source_role`)의 근거 아님 | [1차] |
| A4 | Brandon Sanderson, "Sanderson's Second Law" https://www.brandonsanderson.com/sandersons-second-law/ | [1차] |
| G1 | 경지 문서(나무위키 미러) https://thewiki.kr/w/경지. `murim_realm` 척도만 근거(`sect` 등 엔티티 유형의 근거 아님). 리뷰 재확인 시 403 | [2차] |
| G2 | Campfire 모듈 해설 https://selfpublishing.com/?p=4969 | [2차] |
| G3 | World Anvil Title 템플릿 https://www.worldanvil.com/learn/article-templates/title. 페이지 403, 검색 요약만 확인 | [미확인] |
| G4 | 노랗IT월드, 무협 경지 순서 총정리(2026-06-10) https://yellowit.co.kr/직장인-연말정산-국민내일배움카드-노동법/무협-경지-비교-총정리-삼류-이류-일류-절정-화경-현경/ . 장르 일반 해설(특정 작품 체계를 틀로 씀을 밝힘), 확인일 2026-10-28 | [2차] |
| G5 | 무협 경지 정리 블로그(2026-06-29) https://jab-guyver.co.kr/6782 . 장르 일반 해설, "작품마다 용어가 다름" 명시, 확인일 2026-10-28 | [2차] |
| G6 | 웹툰가이드 리뷰(2025-07-04, 특정 작품) https://www.webtoonguide.com/ko/board/totalreview/20167 . 게이트·헌터 협회 언급만, 장르 일반 해설 아님, 확인일 2026-10-28 | [2차] |
| C1 | Laban 외, LLMs Get Lost In Multi-Turn Conversation https://arxiv.org/abs/2505.06120 | [1차] |
| C2 | Chen 외, CopyBench https://arxiv.org/abs/2407.07087 | [1차] |
| C3 | We're Different, We're the Same(LLM 응답 균질화) https://arxiv.org/abs/2501.19361 | [1차] |
| C4 | 웹소설 문법(1화 훅·회빙환 효율) https://www.youngju.dev/blog/storytelling/web-novel-grammar | [2차] |
| C5 | 웹소설 표절 판단 기준 해설 https://www.lawtalk.co.kr/posts/13356 | [2차] |
| 내부 | `docs/research/research-webnovel-market.md`, `research-genre-world-elements.md`, `research-concept-agent.md`, PRD v0.4 초안, design 00·03·04·06·07·09·11 | — |

### 미확인·가정 목록

| # | 항목 | 처리 |
|---|---|---|
| U-1 | 2024 실태조사 원문(장르별 매출·플랫폼 점유) | [미확인]. 우선순위 C1은 랭킹·플랫폼 메뉴로 대신함 |
| U-2 | 카카오페이지·리디·문피아 랭킹 | 미수집. 여성향 보정은 [추론] |
| U-3 | 로판 작위·경칭, 헌터물 등급 체계, 무협 경지 척도의 1·2차 문서 | 무협 경지 척도는 K-2 충족(4.4절, G4·G5). 헌터는 게이트·각성 핵심 구조만 K-1 충족, 등급·협회·던전 브레이크는 미충족. 로판 작위·경칭은 미조사. S5 검수로 확인 |
| U-4 | 독자 기대 수치(사이다 주기, 미래 지식 회수 간격, 로맨스 진척 비율) | 가정. MVP-β 검증 작품 블라인드 평가(G-0)와 함께 조정 |
| U-5 | 공수 추정과 09 용량 대조, 규칙 상한 20개, 오탐 기준, SC-1·SC-2 목표치 | 가정. S-21·S-22와 MVP-β 실측으로 조정. 질문 상한은 00 `concept.max_template_questions`(8, 11 소유) |
| U-6 | `design/11` 컨셉 대화 설계 문서 | 해소: `design/11-concept-development.md` v0.2.1. 질문 계약은 11 3.6이 소유 |
| U-7 | 설정집 도구(World Anvil·Campfire 등)의 제약 실행 기능 부재 | 확인 범위 내 부재 주장(1.1절). v1 전 재확인 |
| U-8 | 여성향 랭킹(카카오페이지·리디) | 리디 로맨스·로판 웹소설 주간 TOP100 수집(research-webnovel-market 5.4, 재현 자료 `data/ridi-bestsellers-weekly-2026-10-28/`). 소개문이 없어 SC-1 라벨에는 아직 못 씀. 카카오페이지 미수집. SC-1 전제 조건(1.3절)은 부분 충족 |

---

## 부록 A. L3 트로프 태그 전체 목록 (초안 25개, SC-2 분모)

research-webnovel-market 7.3절 키에 2.2절 중복 해소표를 적용한 결과입니다. 무대·직업 키(`stage.gate_dungeon`, `stage.tower`, `stage.apocalypse`, `stage.occult`, `stage.estate`, `profession.*`)와 L1이 소유하는 키(`ability_system.cultivation`, `stage.murim_factions`, `era.real_history`)는 L3에서 빼고 L1·L2 별칭으로 옮겼습니다.

| # | 키 | 한국어 | `mixin_level` | 주 L1 | 릴리스 |
|---|---|---|---|---|---|
| 1 | `rebirth.regression` | 회귀 | `full` | 전체 | MVP-β |
| 2 | `rebirth.multi_regression` | 다회귀 | `label`(회귀 `variants` 후보) | 전체 | v1 이후 |
| 3 | `rebirth.possession` | 빙의 | `full` | 로판·판타지·현판 | v1 |
| 4 | `rebirth.book_possession` | 책·게임 빙의 | `full` | 로판·판타지·현판 | v1 |
| 5 | `rebirth.reverse_possession` | 역빙의 | `label` | 로판 | v1 이후 |
| 6 | `rebirth.reincarnation` | 환생 | `full` | 무협·판타지 | v1 |
| 7 | `ability_system.status_window` | 상태창·시스템 | `full` | 판타지·현판 | v1 |
| 8 | `ability_system.awakening_rank` | 각성·등급 | `label`(척도 소유 = `modern_fantasy.hunter_gate`) | 현판 | v1 |
| 9 | `ability_system.mana_magic` | 마법·마나 | `label` | 판타지·로판 | v1 이후 |
| 10 | `stage.academy` | 아카데미 | `full` | 판타지·현판(라노벨 패싯) | v1 |
| 11 | `stage.imperial_court` | 제국·궁중 | `full` | 로판·로맨스·대체역사 | v1 |
| 12 | `relation.contract_marriage` | 계약·정략결혼 | `light` | 로판·로맨스 | v1 |
| 13 | `relation.villainess` | 악녀·악역 | `light` | 로판 | v1 |
| 14 | `relation.childcare_family` | 육아·가족 | `light` | 로판·로맨스·무협·현판 | v1 |
| 15 | `relation.regret` | 후회 | `label` | 로판·로맨스 | v1 |
| 16 | `relation.obsession` | 집착 | `label` | 로판·로맨스 | v1 |
| 17 | `relation.omegaverse` | 오메가버스 | 보류(D-34) | BL 패싯 | 보류 |
| 18 | `relation.harem` | 하렘 | 보류(D-34) | 남성향 | 보류 |
| 19 | `relation.gender_swap` | TS | 보류(D-34) | 남성향 | 보류 |
| 20 | `plot.revenge` | 복수 | `light` | 전체 | v1 |
| 21 | `plot.misunderstanding` | 착각 | `light` | 전체 | v1 |
| 22 | `plot.munchkin` | 먼치킨 | `label`(인물 특성, SC-2 분모에서 제외) | 전체 | v1 |
| 23 | `plot.healing` | 힐링·일상 | `label` | 전체 | v1 |
| 24 | `plot.growth` | 성장 | `label` | 전체 | v1 |
| 25 | `plot.dark_tragedy` | 피폐 | 보류(D-34) | 전체 | 보류 |

SC-2 분모 규칙: 장르별 TOP100 상위 키워드를 이 표 또는 2.2절 L2 목록의 키에 대응시키고, 대응 키가 `full`·`light`(L3) 또는 L2 템플릿이면 "덮음"으로 셉니다. 인물 특성(`plot.munchkin`, 천재)은 분모에서 뺍니다.
