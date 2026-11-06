# 엔티티 식별·온톨로지 설계 기법 조사 (06-story-ontology 근거)

- 작성일: 2026-10-27
- 대상 요구: D-27, FR-ONT-12~19, R-18, NFR-QUAL-01 (PRD v0.3)
- 등급 표기: [1차] 공식 문서·논문·소스 코드, [2차] 제3자 해설, [미확인] 이번 조사에서 원문을 확인하지 못함
- 이 문서는 조사 결과와 권고만 담습니다. 확정 설계는 → 06-story-ontology에 둡니다.

## 0. 결론 요약

| # | 결론 | 근거 절 |
|---|---|---|
| 1 | 조사한 GraphRAG 계열은 기본 동작에서 "이름 문자열(정규화)"을 엔티티 동일성의 1차 기준으로 씁니다. 동명이인·칭호는 합쳐지고, 별칭·위장명은 갈라집니다. 우리 우려(R-18)는 실제 구현에서 확인되는 동작입니다. | 1절 |
| 2 | 그대로 가져다 쓸 엔진은 없습니다. Graphiti의 bitemporal 엣지와 후보 검색 → LLM 판별 → 결정적 쓰기 구조, 엣지 중복 검사를 같은 엔티티 쌍으로 한정하는 방식은 차용할 만합니다. | 1.4절 |
| 3 | 표준은 직렬화 형식으로 쓰지 말고 개념만 차용합니다: SKOS의 이름 3분류와 무결성 조건, SHACL의 정의역·치역·개수 검증과 심각도, Wikidata의 시작·종료 qualifier와 rank. OWL `owl:sameAs`식 전이·추론 병합은 쓰지 않습니다. | 2절 |
| 4 | 링킹은 후보 생성 → 문맥 판별 → NIL 판정 → 신뢰도 보정 → 확정/질문의 5단계로 둡니다. LLM은 닫힌 후보 목록 중 하나 또는 `NIL`/`UNSURE`만 고르게 합니다. | 3절, 6.2절 |
| 5 | 한국어 웹소설은 영형 주어, 호칭·경어, 직함 승계, 회귀·빙의(한 몸에 다른 영혼) 때문에 "표기 → 엔티티" 대응이 시점·화자·인물 지식에 따라 달라집니다. 이름 사전은 반드시 시점·시간선·아는 인물 범위를 가져야 합니다(FR-ONT-13). | 4절, 5절 |
| 6 | 자동 병합은 하지 않습니다. 병합은 항상 제안 → 확인 → 이력 기록 순서로 하고, 되돌릴 수 있어야 합니다(FR-ONT-16). | 6.4절, 7절 |

## 1. GraphRAG 계열의 엔티티 해소

### 1.1 비교표

| 시스템 | 동일성 기준 | 별칭·변형 처리 | 시간 | 확인된 위험 | 등급·출처 |
|---|---|---|---|---|---|
| Microsoft GraphRAG | 텍스트 단위별로 LLM이 뽑은 엔티티를 `groupby(["title","type"])`로 합치고 설명 목록을 LLM 요약으로 하나로 만듭니다. | 기본 경로에 별칭 해소 단계가 없습니다. 표기가 다르면 다른 노드입니다. | 없음 | 같은 제목·유형이면 동명이인이 한 노드로 합쳐지고 설명이 섞여 요약됩니다. 별칭은 분리됩니다. | [1차] https://github.com/microsoft/graphrag/blob/main/packages/graphrag/graphrag/index/operations/extract_graph/extract_graph.py , [2차] https://www.mintlify.com/microsoft/graphrag/concepts/knowledge-graphs |
| LightRAG | 정확한 이름 일치로 병합합니다. | 이름이 다르면 같은 대상도 별도 노드로 남는다는 기능 요청이 있고, LLM 기반 중복 제거는 선택 기능 PR로 제안됐습니다. | 없음 | 이름 문자열 = 동일성. 변형 표기 분리, 동명 병합. | [2차·미러] https://tristarbruise.netlify.app/host-https-github.com/HKUDS/LightRAG/issues/1323 (원 이슈 HKUDS/LightRAG#1323), PR #2102. 원 저장소 페이지는 직접 열지 못했습니다 [미확인]. |
| Graphiti / Zep | 결정적 단계(이름 정규화 정확 일치, MinHash/LSH + Jaccard ≥ 0.9) 후 미해결분을 LLM에 넘깁니다. LLM은 임베딩·전문 검색으로 찾은 후보와 에피소드 문맥을 보고 중복 여부와 UUID를 답합니다. 그래프 쓰기는 미리 정의한 Cypher로 합니다. | 중복으로 판정되면 "더 완전한 이름"으로 이름과 요약을 갱신합니다. 별칭 목록을 따로 두지 않습니다 [1차, 논문 기준]. | 엣지에 4개 시각: `t_valid`·`t_invalid`(사실의 시간), `t'_created`·`t'_expired`(시스템 기록 시간). 모순 엣지는 새 정보 우선으로 `t_invalid`를 설정합니다. | (a) 정규화 결과가 하나에만 정확히 일치하면 바로 해소되므로 "폐하" 같은 같은 표기·다른 대상이 합쳐집니다. (b) 퍼지 정규화가 `a-z`, `0-9`, 아포스트로피 외 문자를 공백으로 바꾸므로 한글 이름에는 퍼지 단계가 사실상 동작하지 않고, 모두 LLM으로 넘어갑니다. (c) 이름 갱신 시 대표명이 바뀌어 위장명이 대표명을 덮을 수 있습니다. (d) `edge_type_map`에 없는 쌍은 추출된 술어를 그대로 엣지 이름으로 남겨 관계 어휘가 흩어집니다. (e) 새 정보 우선 무효화는 회상·거짓말·오해 서술에 맞지 않습니다. | [1차] https://arxiv.org/html/2501.13956 , https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/dedup_helpers.py , https://help.getzep.com/graphiti/core-concepts/custom-entity-and-edge-types . (b)는 소스 요약으로 확인했고, 실제 버전별 동작은 코드에서 다시 확인해야 합니다. |
| Cognee | OWL/RDF 온톨로지를 RDFLib로 읽고, 추출 엔티티를 정확 일치 → `difflib` 퍼지 일치(기본 cutoff 0.80)로 온톨로지의 정규 이름에 붙입니다. | 온톨로지 쪽 이름으로 바꿉니다. | 없음 | 퍼지 0.80은 짧은 한국어 이름(2~3음절)에서 다른 인물 간 오일치 위험이 큽니다. 문맥을 보지 않습니다. 온톨로지 작성·검증은 외부 도구에 맡깁니다. | [1차] https://docs.cognee.ai/core-concepts/further-concepts/ontologies , [2차] https://www.cognee.ai/blog/deep-dives/grounding-ai-memory |
| Neo4j (LlamaIndex 속성 그래프 예제) | 임베딩 유사도 ≥ 0.9 + 단어 편집거리 ≤ 5 + 포함 관계 + 라벨 일치로 후보를 찾아 병합합니다. | 같은 방식 | 없음 | 저자들이 직접 "June 14, 2023 vs June 15 2023", "1963 AFL Draft vs 1963 NFL Draft" 같은 오병합을 보고하고, 병합 전 수동 예외를 권합니다. | [1차] https://neo4j.com/blog/developer/property-graph-index-llamaindex . Neo4j LLM Graph Builder 자체의 후처리 방식은 확인하지 못했습니다 [미확인]. |

### 1.2 공통 실패 유형

| 유형 | 원인 | 우리 작품에서의 예 |
|---|---|---|
| 잘못된 병합(false merge) | 이름 문자열·임베딩 유사도를 동일성으로 취급 | 1화의 "폐하"(선왕)와 40화의 "폐하"(새 왕), 동명 가문 "이씨 세가" 두 곳 |
| 잘못된 분리(false split) | 별칭·호칭·위장명을 다른 노드로 생성 | "가면 기사"와 "레온 왕자", "사부"와 "청운검 진무" |
| 설명 오염 | 병합 후 설명을 LLM 요약으로 합침 | 동명이인 두 사람의 외형이 한 인물 설명에 섞임 → 연속성 검사가 틀린 근거 사용 |
| 관계 어휘 분산 | 스키마 밖 술어를 그대로 저장 | "부하"·"수하"·"휘하"가 서로 다른 관계로 저장(FR-ONT-18의 예) |
| 시간 무시 | 엣지에 유효 구간이 없거나 "최신이 참" 규칙 | 회귀 전 시간선의 사망 사실이 현재 시간선을 덮음 |
| 대표명 덮어쓰기 | 병합 시 이름을 갱신 | 위장명이 대표명이 되어 정체 은닉 전 화의 컨텍스트에 본명이 샘 |

### 1.3 우리에게 주는 시사점
- 이름 문자열은 "후보 생성 키"로만 쓰고 동일성 판단 근거로 쓰지 않습니다(FR-ONT-14의 "표기가 같다는 이유만으로 연결하지 않습니다"를 뒷받침).
- 같은 표기가 이름 사전에서 여러 엔티티에 걸리면 정확 일치라도 자동 확정하지 않습니다(Graphiti도 다중 정확 일치는 LLM으로 넘깁니다).
- 병합은 설명을 섞지 않습니다. 사실은 원 엔티티 ID·출처와 함께 옮기고, 요약은 다시 생성합니다.

### 1.4 차용할 것

| 차용 항목 | 원천 | 우리 쪽 형태 |
|---|---|---|
| 사실의 시간과 기록의 시간을 분리 | Graphiti `t_valid`/`t_invalid` + `t'_created`/`t'_expired` | 작중 유효 범위(화·씬 + 시간선, FR-ONT-02)와 시스템 기록 시각(버전, FR-ONT-09)을 별도 필드로 둠 |
| 후보 검색 → LLM 판별 → 결정적 쓰기 | Graphiti | LLM은 판정 JSON만 내고, 그래프 쓰기는 검증된 코드 경로만 사용 |
| 엣지 중복 검사를 같은 엔티티 쌍으로 한정 | Graphiti | 관계 중복·모순 검사 범위를 (주어 ID, 목적어 ID, 관계 유형)으로 한정 |
| 다중 정확 일치는 판별로 넘김 | Graphiti `dedup_helpers` | 이름 사전 다중 히트는 항상 문맥 판별 단계로 |
| 정의역·치역 쌍 제한 | Graphiti `edge_type_map` | 단, 맵 밖 쌍은 "자유 술어 저장"이 아니라 거부 + 스키마 변경 제안(FR-ONT-18) |

## 2. 온톨로지·어휘 표준

| 표준 | 핵심 내용 | 차용 | 쓰지 않을 것 | 등급·출처 |
|---|---|---|---|---|
| SKOS | `prefLabel`·`altLabel`·`hiddenLabel`은 모두 `rdfs:label`의 하위 속성입니다. 세 속성은 서로 배타적입니다(S13: 같은 리터럴을 두 종류에 동시에 쓰지 않음). 언어 태그당 `prefLabel`은 하나입니다(S14). `exactMatch`는 전이적이고 `closeMatch`는 전이적이 아닙니다. | 이름 유형 구분(대표명 1개 = prefLabel, 별칭 = altLabel, 검색 전용 오타·띄어쓰기 변형 = hiddenLabel), "대표명은 엔티티당 하나" 무결성, 동일성 강도 2단계(확정 동일 vs 유사) | 개념 체계(ConceptScheme) 간 매핑 어휘 전체, RDF 직렬화 | [1차] https://www.w3.org/TR/skos-reference/ |
| OWL `owl:sameAs` | Halpin·Hayes 외(ISWC 2010)는 Linked Data에서 `owl:sameAs`가 "유사", "관련" 의미로 남용되고, 추론이 붙으면 속성이 전파되어 오류가 퍼진다고 분석하고 약한 동일성 대안을 제안합니다. | "동일성은 강한 주장이므로 근거·출처·되돌리기가 있는 병합 이력으로만 표현" 원칙 | `sameAs` 전이 폐포로 자동 병합, OWL 추론기 | [1차·초록] https://link.springer.com/content/pdf/10.1007/978-3-642-17746-0_20.pdf (본문은 이번에 읽지 않음) |
| OWL 클래스·속성 | 클래스 계층, 속성의 정의역·치역, 함수형 속성, 대칭·역속성 | 개념만 차용: 관계 유형별 `domain`, `range`, `cardinality`, `symmetric`, `inverse_of` | 열린 세계 가정(OWL은 정의역 위반을 "그 개체도 그 클래스다"로 추론하지, 오류로 보지 않음) [가정: OWL 의미론 일반 지식, 이번에 원문 재확인 안 함] | — |
| SHACL | `sh:class`(값이 특정 클래스), `sh:minCount`/`sh:maxCount`(개수), `sh:targetSubjectsOf`/`targetObjectsOf`(술어 기준 검사 대상), 결과는 하나의 `sh:ValidationReport`, 심각도 `sh:Violation`/`sh:Warning`/`sh:Info` | 닫힌 세계 검증: 스키마 위반 = 연속성 이슈(FR-ONT-18). 검증 결과를 보고서 형태로(대상 노드, 경로, 위반 제약, 심각도, 메시지) | SHACL 엔진·RDF 저장소 의존 | [1차] https://www.w3.org/TR/shacl/ |
| Wikidata qualifier·rank | `position held(P39)`에 `start time(P580)`·`end time(P582)` qualifier를 붙여 직위 보유 기간을 표현합니다. 과거에 맞았던 값은 normal rank + 시작·종료로 남기고, 틀린 값만 deprecated로 둡니다. 현재 합의 값은 preferred. | 칭호를 "사람의 이름"이 아니라 직위 엔티티 + 보유 관계(시작·종료 화)로 표현. 사실 상태를 "과거에 참"과 "틀림(폐기)"으로 구분 | Wikidata 데이터 모델 전체 | [1차] https://www.wikidata.org/wiki/Help:Qualifiers , https://www.wikidata.org/wiki/Help:Ranking . `replaces(P1365)`/`replaced by(P1366)` 용법은 확인하지 못함 [미확인] |

판단: 저장 형식은 자체 스키마(PRD의 `Entity`·`EntityName`·`Mention`·`OntologySchema`)로 두고, 위 표준은 규칙 출처로만 인용합니다. 내보내기(FR-ONT-11)에서 SKOS/RDF 매핑을 선택 기능으로 둘 수 있습니다.

## 3. 엔티티 링킹 파이프라인

### 3.1 표준 구조

| 단계 | 내용 | 근거 |
|---|---|---|
| 후보 생성 | 별칭 사전·표기 변형·밀집 검색으로 후보 집합 생성. BLINK는 bi-encoder로 후보를 검색하고 cross-encoder로 재순위합니다. | [1차] https://arxiv.org/abs/1911.03814 |
| 문맥 판별 | 언급 문맥과 후보 설명을 함께 보고 점수화(cross-encoder 또는 LLM) | 같음 |
| NIL 판정 | 방법: (a) 후보 없음 (b) 최고 점수 임계값 미만 (c) 특수 NIL 후보를 순위에 포함 (d) 별도 이진 분류기. 대부분 임계값을 학습 데이터에서 정합니다. | [1차] https://arxiv.org/pdf/2006.00575 (생존 연구) |
| NIL 유형 | "없는 엔티티(Missing Entity)"와 "엔티티가 아닌 구(Non-Entity Phrase)"로 나뉘고, 학습 데이터의 NIL 사례가 NIL 예측 정확도에 크게 영향을 줍니다. | [1차] https://arxiv.org/abs/2305.15725 |
| LLM 링킹 | OneNet은 후보 설명이 1만 토큰을 넘기 쉬워 후보를 줄이고, 여러 추론 결과의 합의(consensus judger)로 환각을 줄입니다. | [1차] https://arxiv.org/abs/2410.07549 |

### 3.2 LLM 링킹 오류 유형과 완화

| 오류 | 완화 |
|---|---|
| 후보 밖 ID·이름 생성(환각) | 출력 스키마를 후보 ID enum + `NIL` + `UNSURE`로 제한(구조화 출력/제약 디코딩). 후보 밖 값은 거부 |
| 유명도·최근성 편향(가장 많이 나온 인물로 연결) | 후보 순서 섞기, 후보마다 "이 시점에 이 이름을 쓸 수 있는가" 필터를 LLM 전에 적용 |
| 과신(높은 자기보고 확신) | LLM 자기보고 확신을 그대로 쓰지 않고, 다회 샘플 일치율·규칙 특징과 결합해 골든셋으로 보정 |
| 문맥 누락(긴 화) | 씬 단위 창 + 씬 등장 인물 목록 + 직전 언급 체인만 입력 |
| 일관성 결여(같은 씬 같은 표기를 다르게 연결) | 씬 내 공지시 체인 단위로 한 번에 판정, 체인 내 충돌은 `ambiguous` |

[가정] 자기 일관성 다회 샘플(예: 3회)의 비용은 `continuity` 역할 모델 단가로 감당 가능한지 → 비용 설계에서 확인합니다(NFR-COST 계열).

### 3.3 사람 검토 큐
- 일반 엔티티 해소 도구(예: Splink, dedupe 등)는 "확정 일치 / 확정 불일치 / 사람 검토" 3구간 임계값을 쓰는 것이 일반적입니다 [가정: 이번 조사에서 1차 출처 미확인].
- 우리 제품에서 사람 검토 큐 = 판별 질문(FR-ONT-14, FR-MSG 계열). 질문 형식·상태는 → 질문 설계 문서. 이 문서는 "언제 넘기는가"만 6.3절에 둡니다.

## 4. 한국어 서사 특유 문제

| 문제 | 설명 | 링킹 영향 | 대응 |
|---|---|---|---|
| 영형 주어(주어 생략) | 한국어는 주어 생략이 잦습니다. 한 연구는 구어 대명사의 약 57%가 영형 주어라고 인용합니다. 동사 어미·경어 일치가 생략 주어 해석 단서가 됩니다. | 사실 추출 시 주어가 문면에 없음 → 언급 자체가 없음 | 사실 추출 단계가 "암시 주어" 언급(`surface` 빈 문자열, `mention_kind=zero`)을 만들고, 시점 인물·직전 주어·경어 단서로 판별. 신뢰도 상한을 낮게 둠 | 
| 호칭·경어 | "형님", "사부", "전하", "아가씨"는 화자와 청자 관계에 따라 대상이 정해집니다. | 같은 호칭이 화자마다 다른 대상 | `EntityName`에 `name_kind=address_term`과 `used_by`(화자 엔티티 또는 관계 조건) 필드. 대사 화자 판별이 먼저 필요 |
| 직함 승계 | "폐하", "단주", "가주"는 시점마다 보유자가 바뀝니다. | 시점 무시 시 선왕·새 왕 병합 | 칭호는 `Title` 엔티티 + `holds_title` 관계(시작·종료 화, 시간선). 언급 "폐하"는 그 시점 보유자 후보로 해석(Wikidata P39 방식) |
| 한자어·외래어 표기 변형 | "마나/마력", "아카데미/학원", "레온/레옹", 한자 병기 "천마(天魔)" | 같은 대상 분리 | 용어집 표기 규칙(FR-ONT-19)과 `variant` 이름. 변형 등록은 제안 → 승인 |
| 띄어쓰기 변형 | "청운검진무/청운검 진무", "흑룡 상단/흑룡상단" | 같은 대상 분리 | 후보 생성 키는 공백 제거 정규형. 단, 키 일치는 후보일 뿐 확정 아님 |
| 짧은 이름 | 2음절 이름·외자 이름은 문자 n-gram 유사도가 높게 나옴 | 퍼지 오병합 | 퍼지 매칭을 후보 생성에만 쓰고, 3음절 이하 이름은 퍼지 단독 확정 금지 |
| 회귀 | 같은 인물이 이전 시간선의 기억을 가짐. 회귀 후 이름을 바꾸기도 함 | 시간선별 사실 충돌, 이름 분리 | 엔티티는 시간선을 넘어 같은 ID. 사실·이름·지식에 `timeline_id`. 개명은 새 `EntityName`(시작 화) |
| 빙의·환생 | 한 몸에 다른 영혼. "몸"과 "인격"이 갈림 | 몸의 외형 사실과 인격의 기억·성격 사실이 섞임 | 설정 시 `Persona`(인격)와 `Body`(몸) 분리 옵션. 기본은 인물 단일 엔티티, 빙의 작품에서만 분리. 판단: 처음부터 모든 인물을 2층으로 두면 비용이 큼 |
| 가면·위장 | 위장명과 본명이 한 대상 | 정체 누설, 분리 | FR-ONT-17. 위장명에 `known_identity_by`(정체를 아는 인물·시점), `reader_reveal_at` |
| 쌍둥이·대역 | 외형 사실로는 구분 불가 | 외형 기반 링킹 오류 | 외형을 링킹 특징으로 쓰지 않고, 쌍둥이 쌍은 `confusable_with` 표시로 항상 판별 단계로 |
| 동명 가문·동명이인 | "남궁세가" 본가·분가, 같은 이름 인물 | 병합 | 이름 사전 다중 히트 → 판별. 엔티티 생성 시 동명 경고(FR-ONT-15) |

출처: [1차] Korean 영형 대명사 관련 — https://aclweb.org/anthology/Y15-1050.pdf (Hong 2000 인용 수치), https://s-space.snu.ac.kr/handle/10371/86243 (어미에 의한 인칭 해석), https://koreascience.or.kr/article/JAKO201015037856839.page . 웹소설 장르 관습(회귀·빙의·가면)은 도메인 지식이며 정량 근거는 없습니다 [가정].

## 5. 서사 특화: 정체·지식·동일성

| 주제 | 조사 내용 | 우리 쪽 함의 |
|---|---|---|
| 문학 텍스트 공지시 | LitBank/BookNLP는 "Tom", "Tom Sawyer", "Mr. Sawyer"를 한 인물로 묶습니다. 문학에서는 칭호·묘사로만 불리는 인물, "그녀의 남편" 같은 관계 표현이 흔해 어렵습니다. 성을 공유하는 인물이 많아 보수적 군집이 맞다는 비교 결과가 있습니다. | 보수적(분리 우선) 기본값이 맞습니다. 관계 표현("그의 사부")은 관계 그래프로 해석해 후보를 좁힙니다. [1차] https://github.com/booknlp/booknlp , https://arxiv.org/pdf/2307.03734 |
| 평가 현실성 | 정답 별칭 목록을 미리 주는 평가는 비현실적이라는 지적이 있습니다. | 골든셋은 "이름 사전이 불완전한 상태"를 포함해야 합니다. [1차] https://arxiv.org/pdf/2608.02359 (초록 요약 수준 확인) |
| 독자 지식 vs 인물 지식 | 표준 KG 연구에서 직접 대응하는 1차 자료는 찾지 못했습니다 [미확인]. | 지식을 3층으로: 캐논(작가 진실) / 독자 공개(`reader_reveal_at`) / 인물 지식(FR-ONT-03). 컨텍스트 구성 시 화자 인물이 아는 이름만 사용(FR-ONT-17) |
| 회귀 시간선 동일성 | 표준 없음. Graphiti의 "새 정보 우선 무효화"는 다중 시간선에 맞지 않습니다. | 동일성은 시간선을 넘는 엔티티 ID, 사실은 시간선별. 시간선 간 "이월" 관계(기억·물건)는 FR-ONT-04 |

## 6. 우리 제품 권고

### 6.1 데이터 모델 초안

식별자는 초안입니다. 확정은 → 06-story-ontology.

| 타입 | 주요 필드 | 메모 |
|---|---|---|
| `Entity` | `entity_id`(불변, ULID 등), `work_id`, `entity_type`(스키마 enum), `status`(`active`·`merged`·`split_source`·`retired`), `merged_into_id`, `confusable_with[]`, `created_from_mention_id` | 대표명은 `EntityName` 중 `is_preferred=true` 하나(SKOS S14 차용). 병합된 ID는 지우지 않고 `merged_into_id`로 안내(FR-ONT-16) |
| `EntityName` | `name_id`, `entity_id`, `surface`, `normalized_key`(공백·기호 제거), `name_kind`(`preferred`·`true_name`·`alias`·`title`·`address_term`·`disguise`·`variant`·`hidden_variant`), `valid_from`/`valid_to`(화·씬 위치), `timeline_id`(null=전 시간선), `known_by`(인물 ID 목록 또는 `all`·`reader`), `used_by_condition`(호칭용: 화자 조건), `reader_reveal_at`, `source_ref` | 같은 `surface`를 여러 엔티티가 가질 수 있음(FR-ONT-13). `hidden_variant`는 검색 전용, 집필 컨텍스트에 노출 안 함(SKOS hiddenLabel 차용) |
| `Title` (엔티티 유형) + `holds_title` (관계) | 관계에 `valid_from`·`valid_to`·`timeline_id` | "폐하" 언급은 `Title`의 대응 호칭을 거쳐 그 시점 보유자 후보로 해석 |
| `Mention` | `mention_id`, `source_ref`(화·씬·문자 오프셋 또는 답변 ID), `surface`, `mention_kind`(`named`·`title`·`address`·`pronoun`·`zero`·`descriptive`), `speaker_entity_id`, `pov_entity_id`, `candidates[]`(ID·점수·특징), `linked_entity_id`, `confidence`, `rationale`, `link_status`(`auto_linked`·`confirmed`·`ambiguous`·`new_entity_candidate`; PRD 정의), `linker_version`, `question_id` | 모든 사실의 엔티티 참조가 `mention_id`를 가짐(FR-ONT-14 수용 기준) |
| `Fact` (기존, FR-ONT-02) | `subject_id`, `relation_type`, `object_id`/`value`, `valid_from`/`valid_to`, `timeline_id`, `status`, `source_ref`, `mention_ids[]`, `recorded_at`, `superseded_at` | 작중 시간과 기록 시간 분리(Graphiti 차용). "과거엔 참"은 `valid_to`로 닫고, "틀림"은 별도 상태(Wikidata rank 차용) [가정: 상태 enum 추가는 FR-ONT-02와 조율 필요] |
| `IdentityDecision` | `decision_id`, `kind`(`merge`·`split`·`same_check_different`·`same_check_same`), `entity_ids`, `moved_refs[]`, `reason`, `decided_by`(user/agent), `question_id`, `reverted_by` | 병합·분리·"다름" 판정 이력. "다름"으로 판정한 쌍은 다시 중복 후보로 올리지 않음 |
| `OntologySchema` | `schema_version`, `entity_types[]`, `relation_types[]`(각각 `domain`, `range`, `max_per_subject`, `max_per_object`, `symmetric`, `inverse_of`, `temporal_rules[]`, `synonyms[]`), `extends`(공통 기본 스키마) | `synonyms`에 "부하·수하·휘하"를 같은 관계의 표기로 등록(FR-ONT-18). 위반 심각도는 SHACL 3단계 차용 → 연속성 이슈 심각도 설계와 매핑 |
| `GlossaryTerm` | `term_id`, `surface`, `definition`, `spelling_rules`, `linked_entity_id`/`linked_schema_item` | FR-ONT-19 |

### 6.2 링킹 파이프라인 단계

| # | 단계 | 입력 | 출력 | 규칙 |
|---|---|---|---|---|
| L0 | 언급 검출 | 원고 씬, 답변 | `Mention` 초안(named/title/address/pronoun/zero/descriptive) | 사실 추출(FR-ONT-05)과 같은 호출에서 함께 뽑되, 엔티티 ID는 이 단계에서 정하지 않음 |
| L1 | 화자·시점 인물 판별 | 대사 따옴표, 씬 메타 | `speaker_entity_id`, `pov_entity_id` | 호칭 해석의 전제. 화자 불확실하면 호칭 언급 신뢰도 상한을 낮춤 |
| L2 | 후보 생성 | `normalized_key`, 이름 사전, 용어집 | 후보 목록 | 이름 사전 조회는 (화 위치, 시간선) 시점 필터 적용. 정확 키 + 공백 제거 키 + 자모 단위 편집거리(후보 생성용) + 임베딩. 상위 K개(가정: K=8) |
| L3 | 규칙 필터 | 후보, 스키마, 사실 | 걸러진 후보 + 특징 | 그 시점 사망·미등장·다른 장소 인물 제외 표시(제외가 아니라 감점, 회상 장면 고려). `known_by`에 화자가 없으면 그 이름으로 그 대상을 부를 수 없음 → 감점 또는 정체 누설 이슈 후보 |
| L4 | 문맥 판별(LLM) | 씬 창, 씬 등장 인물, 직전 언급 체인, 후보 카드(대표명·관계·최근 사실) | 후보 ID / `NIL` / `UNSURE` + 근거 | 출력 enum 제한. 후보 순서 무작위화. 다회 샘플(가정: 3회) |
| L5 | NIL 판정 | L4 결과, 후보 점수 | 신규 후보 여부 | NIL이면 기존 엔티티와 이름·속성·관계 유사 검사 후 `new_entity_candidate`(FR-ONT-15) |
| L6 | 신뢰도 산정 | 샘플 일치율, 규칙 특징, 후보 간 점수 차, `mention_kind` | `confidence`(0~1) | 골든셋으로 보정한 결합 점수. `mention_kind`별 상한 |
| L7 | 확정 또는 질문 | `confidence`, 영향 범위 | `link_status`, 필요 시 질문 | 6.3절 |
| L8 | 씬 일관성 검사 | 씬 내 모든 언급 | 충돌 보고 | 같은 씬·같은 화자·같은 표기가 다른 엔티티로 연결되면 둘 다 `ambiguous` |

### 6.3 임계값 운용과 질문으로 넘기는 조건

임계값은 값이 아니라 운용 방식만 정합니다. 초기값은 가정이며 골든셋으로 보정합니다(NFR-QUAL-01).

| 구간 | 조건(가정 초기값) | 처리 |
|---|---|---|
| 자동 확정 | `confidence ≥ τ_auto`(가정 0.90) 그리고 2위와 점수 차 ≥ δ(가정 0.2) 그리고 다회 샘플 만장일치 | `auto_linked`, 사실은 게이트 규칙대로 진행 |
| 보류(검수 리포트) | `τ_ask ≤ confidence < τ_auto`(가정 τ_ask 0.6) | `ambiguous`, 사실은 `candidate`. 화 검수 리포트에 묶어 표시, 질문은 묶음 1건 |
| 판별 질문 | `confidence < τ_ask`, 또는 후보 경합(점수 차 < δ), 또는 샘플 불일치 | `ambiguous` + 비차단 질문(FR-ONT-14) |
| 신규 확인 | NIL이고 유사 기존 엔티티 존재 | `new_entity_candidate` + "같은 대상인가" 확인(FR-ONT-15) |

무조건 질문(신뢰도와 무관):
- 링킹 결과가 `published_locked` 사실이나 높음 심각도 이슈에 닿음 → 차단형(FR-ONT-14, FR-ONT-07).
- 병합·분리 제안(FR-ONT-16).
- 위장명·정체 관련 언급이 `known_by` 밖 인물의 시점·대사에서 정체를 드러내는 방향으로 연결됨(FR-ONT-17).
- `confusable_with` 쌍(쌍둥이 등)에 연결.
- 스키마 밖 관계·유형 제안(FR-ONT-18).

운용 규칙:
- 임계값은 `mention_kind`별로 따로 둡니다. `zero`·`pronoun`·`address`는 자동 확정 상한을 낮게(가정: `zero`는 자동 확정 금지, 영향 없는 사실에 한해 `auto_linked` 허용 여부는 골든셋 결과로 결정).
- 질문 폭주를 막기 위해 같은 표기·같은 후보 집합의 질문은 화 단위로 묶고, 답은 이름 사전 규칙(예: "이 작품에서 '형님'은 화자 A가 쓰면 B")으로 저장해 재질문을 줄입니다. 일일 질문 상한은 → 질문·예산 설계.
- 보정 지표: 자동 확정 구간 정밀도 목표(가정 ≥ 0.98)를 먼저 맞추고, 그 다음 자동 확정 비율을 올립니다. 잘못된 자동 연결 비용이 질문 비용보다 큽니다(R-18).

### 6.4 병합·분리 운용
- 자동 병합 없음. 에이전트는 `IdentityDecision` 제안만 만듭니다.
- 병합 시 사실·언급·떡밥·씬 참조를 옮기되 원 `entity_id`를 `origin_entity_id`로 보존해 분리 시 복원합니다.
- 병합 후 요약·대표 설명은 재생성하고, 원 사실은 합치지 않습니다(1.2절 설명 오염 방지).
- "다름" 판정 쌍은 차단 목록으로 저장해 중복 후보에서 제외합니다.

### 6.5 평가용 골든셋 시드 유형

NFR-QUAL-01 엔티티 연결 정확도 측정용. 유형마다 짧은 합성 씬 묶음을 만들고, 정답은 언급별 엔티티 ID와 기대 `link_status`입니다.

| # | 유형 | 기대 동작 |
|---|---|---|
| G01 | 칭호 승계: 선왕 사망 전후 "폐하" | 시점별 다른 엔티티 |
| G02 | 동명이인 2명 같은 화 등장 | 분리 유지, 경합 시 질문 |
| G03 | 동명 가문(본가·분가) | 분리 |
| G04 | 별칭·애칭("레온", "레오", "왕자") | 한 엔티티 |
| G05 | 띄어쓰기 변형 | 한 엔티티, 변형 등록 제안 |
| G06 | 외래어 표기 변형("레온/레옹") | 한 엔티티 또는 용어집 교정 제안 |
| G07 | 호칭 화자 의존("형님": 화자 A→B, 화자 C→D) | 화자별 다른 대상 |
| G08 | 영형 주어 연속 문장 | 시점 인물 연결, 낮은 신뢰도 |
| G09 | 가면·위장명, 정체 공개 전·후 | 같은 엔티티, 공개 전 누설은 이슈 |
| G10 | 별개로 생성 후 정체 판명 | 병합 제안 질문 |
| G11 | 쌍둥이 교대 | `confusable_with` → 항상 판별 |
| G12 | 회귀 후 개명 | 같은 ID, 새 이름 시작 화 |
| G13 | 빙의(몸·인격 분리 작품) | 외형 사실은 몸, 기억은 인격 |
| G14 | 회상 장면 속 사망 인물 | 사망 필터가 제외하지 않음 |
| G15 | 신규 인물 첫 등장(이름 사전에 없음) | `new_entity_candidate` |
| G16 | 엔티티가 아닌 구("하늘의 왕" 비유) | NIL(비엔티티) |
| G17 | 관계 동의어("부하/수하/휘하") | 같은 관계 유형 |
| G18 | 스키마 위반(생부 2명, 사망 후 혼인) | 이슈 보고 |
| G19 | 거짓말·오해 서술("그는 죽었다"고 인물이 믿음) | 캐논 사실이 아니라 인물 지식 |
| G20 | 짧은 이름 유사("민준/민중") | 퍼지 단독 병합 없음 |
| G21 | 사용자 답변 속 표기(Telegram 자유 문장) | 답변 링킹도 같은 파이프라인 |
| G22 | 이름 사전 불완전 상태 | 정답 별칭 미등록에서도 동작(5절 평가 현실성) |

## 7. 피해야 할 패턴

| 패턴 | 이유 | 출처 절 |
|---|---|---|
| 이름 문자열(또는 제목+유형)을 노드 키로 사용 | 동명 병합·별칭 분리 | 1.1 GraphRAG, LightRAG |
| 임베딩·퍼지 유사도 임계값만으로 자동 병합 | 짧은 한국어 이름, 날짜·유사 고유명 오병합 | 1.1 Neo4j, Cognee |
| 정규식이 한글을 지우는 정규화 사용 | 한글 이름이 빈 문자열이 되어 퍼지 단계 무력화 | 1.1 Graphiti `dedup_helpers` |
| 병합 시 대표명 자동 갱신("더 완전한 이름") | 위장명이 대표명을 덮어 정체 누설 | 1.1 Graphiti |
| 스키마 밖 술어를 자유 텍스트 엣지로 저장 | 관계 어휘 분산 | 1.1 Graphiti `edge_type_map` |
| `sameAs` 전이 폐포로 연쇄 병합 | 한 번의 오판이 전파 | 2절 OWL |
| "최신 정보가 참" 무효화 규칙 | 회상·거짓말·다중 시간선과 충돌 | 1.1 Graphiti, 5절 |
| 병합 시 설명을 LLM으로 합쳐 요약 | 동명이인 속성 오염, 되돌리기 불가 | 1.2 |
| LLM에 열린 질문("이 사람은 누구인가") | 후보 밖 환각 | 3.2 |
| LLM 자기보고 확신을 그대로 임계값에 사용 | 과신 | 3.2 |
| 외형 묘사를 링킹 근거로 사용 | 쌍둥이·변장·외형 변화 | 4절 |
| 모든 인물을 처음부터 몸·인격 2층으로 모델링 | 비용·복잡도. 빙의 작품에서만 켬 | 4절 |

## 8. 남은 확인 사항

| 항목 | 상태 |
|---|---|
| Neo4j LLM Graph Builder 자체 중복 처리 방식 | [미확인] |
| LightRAG 원 저장소 이슈·PR 원문 | 미러로만 확인 [2차] |
| Graphiti `dedup_helpers` 동작의 버전별 차이 | 현재 main 소스 요약 기준. 채택 전 코드 재확인 필요 |
| OWL 열린 세계 가정 관련 서술 | 일반 지식 기반 [가정] |
| 3구간 임계값(확정/검토/불일치) 일반 관행의 1차 출처 | [미확인] |
| Wikidata `replaces`/`replaced by` 용법 | [미확인] |
| 한국어 영형 대명사 해소 최신 LLM 성능 | 조사 안 함. 골든셋 G08로 직접 측정 권고 |
