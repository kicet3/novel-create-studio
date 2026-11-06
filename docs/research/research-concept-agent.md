# 대화형 컨셉 개발 에이전트 조사 (`concept_partner` 근거)

- 작성일: 2026-10-28
- 대상 요구: 사용자 새 요구 A(2026-10-28, 기본 탑재 컨셉 대화 에이전트), PRD v0.3 5.1·5.2, FR-NOV-01~03, FR-NOV-05, NFR-SAFE-02, 연관 요구 B(카테고리별 세계관 데이터 템플릿, 별도 계획서)
- 등급 표기: [1차] 공식 문서·논문·원저자 글, [2차] 제3자 해설·기사·리뷰, [미확인] 이번 조사에서 원문을 확인하지 못함. 출처 확인일은 모두 2026-10-28입니다.
- 이 문서는 조사 결과와 권고만 담습니다. 확정 설계는 → 03(상태)·04(에이전트)·05(메신저)·07(파이프라인)에 반영할 때 정합니다. 이름·enum·기본값 제안은 00 등록 전까지 "제안"입니다.

## 0. 결론 요약

| # | 결론 | 근거 절 |
|---|---|---|
| 1 | 작법 틀(로그라인, 스노우플레이크 1~2단계, Save the Cat 로그라인 요건)이 공통으로 요구하는 "초기 컨셉 최소 항목"은 **주인공 · 욕망/목표 · 대립(장애) · 걸린 것(stakes) · 아이러니/훅 · 결말 방향 · 톤/타깃**입니다. 웹소설은 여기에 **장르·트로프 키워드, 1화 훅, 사이다 주기, 장기 연재 갈등 엔진, 제목 관습, 타깃 플랫폼**이 더해집니다. | 1절, 2절 |
| 2 | LLM 대화형 발상의 핵심 위험은 (a) 다중 턴에서 이른 가정 후 회복 실패(Laban 외 2025, 평균 39% 성능 저하), (b) 동조 편향(Sharma 외 2024), (c) 발상 균질화(Doshi·Hauser 2024 외), (d) 사건·인물 수준의 비문자적 복제(CopyBench 2024), (e) 긴 컨텍스트 중간 정보 누락(Liu 외 2023)입니다. 모두 공개 연구로 확인됩니다. | 3절 |
| 3 | 따라서 `concept_partner`는 "자유 대화 + 끝에 요약"이 아니라 **슬롯 채우기형 단계 대화**로 둡니다. 매 턴 질문 1개, 컨셉 상태(`ConceptBrief` 초안)를 턴마다 갱신하고 각 필드에 출처(사용자 발화/에이전트 제안 채택/기본값)와 근거 턴을 붙입니다. | 6.1절, 6.3절 |
| 4 | 메신저는 Telegram 4,096자·버튼 데이터 64바이트, Discord 본문 2,000자·모달 4,000자 제약이 있어 긴 비교·요약 표시에 약합니다. **주 무대는 웹 채팅(온보딩 화면), 메신저는 같은 세션을 이어 가는 "1문 1답 경량 모드"**로 둡니다. 최종 승인 카드만 메신저 버튼으로도 받습니다. | 4절, 6.5절 |
| 5 | 유명 작품과의 유사성 자동 판정은 **신뢰할 만한 범용 방법이 없습니다**. 트로프는 보호 대상이 아니고(아이디어·표현 이분법), 위험은 "고유명·고유 설정 + 사건 전개 조합"에 있습니다. 현실적 범위는 (i) 고유명 금지 목록 대조, (ii) LLM의 "닮은 작품·겹치는 요소" 자기 점검을 참고 신호로 표시, (iii) 트로프 태그 공개, (iv) 사용자 확인입니다. 법적 판정은 하지 않습니다. | 5절 |
| 6 | 수렴 조건은 "필수 슬롯 전부 `confirmed` + 사용자 승인"이고, 턴 상한·같은 슬롯 반복 변경 감지·"이대로 진행" 명령으로 끝없는 대화를 막습니다. | 6.2절 |

## 1. 작법 기반 컨셉 개발 틀

### 1.1 틀별 초기 컨셉 항목

| 틀 | 초기 단계에서 요구하는 것 | 질문 순서 시사점 | 등급·출처 |
|---|---|---|---|
| 스노우플레이크(Ingermanson) | 1단계: 15단어 미만 한 문장 요약. 2단계: 약 5문장 문단(설정 1 + 재앙 3 + 결말 1). 3단계: 주요 인물별 동기·목표·갈등·깨달음과 한 문장·한 문단 줄거리 | 한 문장 → 문단 → 인물 순으로 넓혀 갑니다. 결말을 2단계에서 이미 요구합니다. | [1차] https://www.advancedfictionwriting.com/articles/snowflake-method/ |
| Save the Cat 로그라인(Snyder) | 로그라인 요건 4가지: 아이러니(감정적으로 끌리는 의외성), 작품 전체가 떠오르는 그림, 타깃 독자·비용 감각(톤 포함), 제목. 친구·낯선 사람에게 시험해 지루해하면 고침 | 훅(아이러니)과 제목을 기획 초기에 함께 다룹니다. | [2차] https://en.wikipedia.org/wiki/Save_the_Cat!:_The_Last_Book_on_Screenwriting_You%27ll_Ever_Need , https://gyford.com/phil/writing/2018/02/25/save-cat-blake-snyder . 원서 문구는 [미확인] |
| 로그라인·프리미스(일반 작법) | 주인공 + 목표 + 대립/장애 + 걸린 것. 프리미스는 "만약 ~라면" 형태의 상황 가정 | "만약 ~라면"(상황) → 누가(주인공) → 무엇을 원하나 → 무엇이 막나 → 실패하면 무엇을 잃나 | [2차] 작법서 공통 관행. 단일 1차 출처는 이번에 확인하지 않음 [미확인] |
| Dramatron(DeepMind) | 로그라인 1개에서 제목 → 인물 → 플롯 비트 → 장소 → 대사를 계층적으로 생성. 장문 일관성 부족을 계층 생성으로 보완. 업계 전문가 15명 사용자 연구 | 로그라인이 상위 생성의 단일 입력이므로, 컨셉 단계 산출물이 이후 모든 단계의 품질을 좌우합니다. | [1차] https://arxiv.org/abs/2209.14958 (게재 학회 연도는 출처마다 CHI 2022/2023으로 다름 [미확인]) |
| Sudowrite Story Bible | Braindump(수기 입력) → Synopsis(Braindump·Genre에서 생성) → Characters·Worldbuilding(Synopsis 기반) → Outline → Scenes → Draft. Synopsis가 비면 하위 필드는 Braindump를 대신 씀 | "자유 덤프 → 구조화 요약 → 하위 설정" 흐름. 자유 발화 수집 단계를 맨 앞에 둡니다. | [1차] https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/what-is-story-bible/jmWepHcQdJetNrE991fjJC |
| NovelCrafter Workshop Chat | 브레인스토밍 채팅에서 Codex(설정집) 항목을 문맥으로 붙이고, 대화에서 구조화 항목을 추출(Extract)해 새 Codex 항목을 만듦 | 대화와 구조화 저장소를 분리하고 "추출" 단계를 명시적으로 둡니다. | [1차] https://www.novelcrafter.com/help/docs , https://www.novelcrafter.com/courses/ultimate-beginners-guide/codex-and-chat . 추출 동작 세부는 [미확인] |
| NovelAI Lorebook | 항목별 활성화 키가 최근 본문에 나오면 항목 텍스트를 컨텍스트에 삽입. 제목은 AI에 보이지 않음 | 컨셉 단계 산출물이 이후 컨텍스트 주입 단위(용어집·엔티티)로 이어져야 합니다(06 `GlossaryTerm`). | [1차] https://docs.novelai.net/en/text/lorebook |

### 1.2 공통 최소 항목 (권고 질문 순서)

| 순서 | 항목 | 왜 이 순서인가 |
|---|---|---|
| 0 | 씨앗(사용자가 이미 가진 것: 장면·인물·제목·"이런 느낌") 자유 수집 | Sudowrite Braindump와 같습니다. 사용자의 의도를 먼저 받아 에이전트 제안이 덮어쓰지 않게 합니다(3절 위험 b). |
| 1 | 장르·하위 장르·핵심 트로프 | 웹소설은 독자가 키워드로 작품을 고르므로(2절) 이후 질문 목록(요구 B 템플릿)을 이 값으로 고릅니다. |
| 2 | 주인공과 출발 조건(회귀·빙의 여부, 결핍, 우위) | 로그라인의 "누가" |
| 3 | 욕망/목표와 대립(장애·적대자) | 로그라인의 "무엇을 원하고 무엇이 막나" |
| 4 | 걸린 것과 아이러니(훅) | Save the Cat의 아이러니, 1화 훅으로 연결 |
| 5 | 세계 핵심 규칙(장르 템플릿의 필수 규칙만) | 상세 세계관은 기획서(`SeriesBible`)·온톨로지 단계로 넘깁니다. |
| 6 | 연재 엔진(장기 갈등 구조, 사이다 주기, 1화 훅, 아크 수 감) | 웹소설 고유. 120화를 버틸 갈등이 있는지 확인 |
| 7 | 결말 방향 | 스노우플레이크 2단계와 FR-NOV-02의 결말 방향 |
| 8 | 톤·수위·타깃 독자·플랫폼, 제목 후보 | 연령 등급(FR-NOV-01, D-13)과 제목 관습 |

## 2. 웹소설 특화 요소

| 요소 | 조사 내용 | 컨셉 단계에서 물을 것 | 등급·출처 |
|---|---|---|---|
| 1화 훅 | 회빙환은 주인공의 동기와 정보 우위를 1화 안에 세팅할 수 있어 "첫 3화 안에 승부가 나는" 시장에서 효율적이라는 분석. 화 끝을 긴장이 가장 높은 순간에 끊는 관행 | "1화 마지막 장면은 무엇인가", "독자가 1화에서 얻는 약속은 무엇인가" | [2차] https://www.youngju.dev/blog/storytelling/web-novel-grammar |
| 사이다·고구마 주기 | 독자 감정 변화(답답함 누적 → 해소)로 장르를 체감한다는 분석 | 사이다 주기(몇 화마다 해소), 허용 고구마 길이 | [2차] https://seoulalien.substack.com/p/181 , 위 youngju.dev |
| 제목·키워드 관습 | 플랫폼 안에서 제목·표지로 선택받으므로 제목이 시대 배경·주인공 특성·전개를 드러내는 문장형이 많음 | 제목 후보 2~3개와 키워드 태그 | [2차] https://www.careet.net/896 , youngju.dev |
| 하위 패턴 | 회빙환 안에서도 헌터물·악역 영애물·먼치킨·게임 판타지 등으로 갈라지며 갈등 배치 방식이 다름 | 하위 장르 선택이 질문 목록을 바꿈(요구 B) | [2차] youngju.dev |
| 연재 지속성 | 120화 규모는 반복 가능한 갈등 엔진(성장 단계, 적 계층, 미스터리 층위)이 필요 | "아크마다 새로 등장하는 것은 무엇인가" | 가정: 작법 관행. 1차 근거 미조사 |
| 타깃 플랫폼 독자층 | 2024년 2월 카카오페이지 월간 웹툰 상위 50개 중 36개가 로판이라는 분석(웹툰 기준). 2024 웹소설 시장 1조 3,500억 원 추정, 이용자 79.0% 유료 결제 경험 보도. 콘진원 장르별 이용자 조사 원문은 확인하지 못함 | 타깃 플랫폼(문피아·카카오페이지·네이버 시리즈·노벨피아 등)과 주 독자층. 값은 요구 B 시장 조사로 채움 | [2차] https://www.webtoonguide.com/ko/board/news-column/19916 , https://economist.co.kr/article/view/ecn202504160028 . 플랫폼별 독자층 수치 [미확인] |
| 플랫폼 AI 정책 | 리디·네이버 시리즈 공모전·노벨피아 공모전의 AI 제한(PRD 10절) | 타깃 플랫폼 선택 시 FR-NOV-04b 정책 프로필 경고 연결 | PRD 10절 [1차·2차 혼재] |

## 3. LLM 대화형 발상 에이전트의 위험과 근거

| 위험 | 확인된 현상 | 등급·출처 | 설계 시사점 |
|---|---|---|---|
| a. 다중 턴 이탈·수렴 실패 | 정보가 여러 턴에 나뉘어 주어지면 단일 턴 대비 평균 39% 성능 저하. 저하의 대부분은 신뢰도(불안정성) 증가이며, 모델이 이른 턴에 빠진 정보를 추측해 답을 확정하고 잘못 들어선 뒤 회복하지 못함 | [1차] https://arxiv.org/abs/2505.06120 | 대화 이력 전체가 아니라 **구조화 상태(ConceptBrief 초안)**를 매 턴 입력의 중심에 둡니다. 미확정 슬롯은 추측으로 채우지 않고 `empty`로 둡니다. |
| b. 동조 편향·의도 덮어쓰기 | RLHF 어시스턴트 5종이 4개 과제에서 모두 동조 행동을 보임. 사람·선호 모델이 그럴듯한 동조 답을 정답보다 선호하는 경우가 있음 | [1차] https://arxiv.org/abs/2310.13548 | (1) 사용자 발화 필드는 에이전트가 고쳐 쓰지 못하고 "수정 제안"만 가능. (2) 약점 지적 단계(연재 지속성 점검)를 별도로 두어 무조건 칭찬을 막음 |
| c. 질문 회피·과잉 가정 | 최신 LLM은 모호한 요청에 명확화 질문을 하지 않고 한 해석으로 답하는 경향. 이후 턴을 시뮬레이션해 선호 라벨을 주면 개선 | [1차] https://arxiv.org/abs/2410.13788 | 질문을 "하느냐"가 아니라 "어느 슬롯을 묻느냐"를 상태에서 결정하게 합니다. |
| d. 질문 과다·한 번에 여러 질문 | 후속 질문을 받은 뒤 만든 문서를 사용자가 더 선호(문서 생성 과제). 질문 개수·묶음 방식 비교 연구는 이번에 찾지 못함 | [1차] https://arxiv.org/abs/2407.12017 , 질문 1개 vs 여러 개 비교 [미확인] | 가정: 메신저에서는 질문 1개/메시지가 답 매칭에 유리합니다(05의 답장 매칭과 같음). 턴당 질문 1개를 규칙으로 두고, 선택지 2~4개 + "직접 입력" + "추천해 줘"를 제공합니다. |
| e. 발상 균질화 | 생성형 AI 사용 시 개인 창의성 평가는 오르지만 집단 다양성은 줄어듦(단편 소설 실험). 서로 다른 LLM들의 응답끼리가 사람 응답끼리보다 훨씬 유사. 다양한 페르소나로 완화 가능하다는 보고(검정력 제한) | [1차] Doshi·Hauser 2024(Science Advances, 원문 수치 [미확인]), https://arxiv.org/abs/2501.19361 , https://arxiv.org/abs/2504.13868 | 후보 제안 시 서로 다른 축(트로프 비틀기·톤·주인공 유형)을 강제하고, "흔한 선택"임을 표시합니다. |
| f. 기존 작품 표절성 제안 | 문자 그대로의 복제는 드물지만 **사건 복제·인물 복제**(비문자적 복제)는 7B 모델에서도 발생. Llama3 8B→70B에서 비문자적 복제 2.3%→5.9%(판본에 따라 6.9%). 추론 시점 완화는 주로 문자적 복제만 줄임 | [1차] https://arxiv.org/abs/2407.07087 | 5절 유사성 점검. 고유명·고유 설정을 그대로 제안하지 않도록 생성 지시 + 사후 대조 |
| g. 구조화 요약의 누락·왜곡 | 긴 입력의 중간 정보 활용이 시작·끝보다 크게 떨어짐 | [1차] https://arxiv.org/abs/2307.03172 | 끝에서 한 번에 요약하지 않고 **턴마다 증분 갱신**. 각 필드에 근거 턴 ID를 붙이고, 승인 화면에서 필드별 근거를 보여 줍니다. |
| h. 장기 대화 컨텍스트 | 위 a·g와 같은 원인. 세션이 며칠에 걸치면 이력이 길어짐 | 위 출처 | 입력 = ConceptBrief 초안 + 최근 N턴 + 미결 슬롯 목록. 오래된 턴은 근거 참조용으로만 저장 |
| i. 제품 사례의 공통 패턴 | Sudowrite는 자유 덤프 → 생성 요약 → 하위 필드 연쇄, NovelCrafter는 채팅과 Codex 추출을 분리 | 1.1절 출처 | 대화(발상)와 저장(구조)을 분리하고 추출을 사용자 확인 대상으로 둡니다. 두 제품 모두 대화형 "질문 주도" 컨셉 에이전트를 공개 문서로 확인하지는 못함 [미확인] |

## 4. 메신저 vs 웹 채팅

### 4.1 메신저 제약

| 항목 | Telegram | Discord | 등급·출처 |
|---|---|---|---|
| 본문 길이 | `sendMessage` 1~4,096자(엔티티 파싱 후) | `content` 최대 2,000자. 임베드 설명 4,096자, 메시지당 임베드 문자 합 6,000자, 임베드 ≤10개 | [1차] https://core.telegram.org/bots/api , https://docs.discord.com/developers/resources/message |
| 버튼 | 인라인 버튼 `callback_data` 1~64바이트 | 버튼 행당 5개, 셀렉트 ≤25(05 5.3절) | [1차] Telegram API, 05 5.3절 |
| 자유 입력 | `ForceReply`로 답장 UI를 띄움. 답장 인용 `quote` 0~1,024자 | 모달 Text Input ≤4,000자, 모달은 상호작용 응답으로만 열림. 스레드 일반 메시지 본문을 읽으려면 `MESSAGE_CONTENT` 특권 인텐트 필요(없으면 `content` 빈 값) | [1차] 위 두 문서. 멘션·DM 예외 여부는 [미확인] |
| 답장·스레드 | 개인 채팅에서도 토픽(`message_thread_id`, `has_topics_enabled`) 지원 | `message_reference`로 답장, 작품별 스레드(05 9절) | [1차] Telegram API(최신판 기능, 도입 버전 [미확인]), Discord 문서 |
| 생성 중 표시 | `sendMessageDraft`: 생성 중 부분 메시지를 스트리밍. 임시 30초 미리보기이며 완료 후 `sendMessage`로 확정 필요 | 타이핑 표시 정도 | [1차] Telegram API |

### 4.2 장단 비교

| 기준 | 메신저(Telegram/Discord) | 웹 채팅(온보딩 화면) |
|---|---|---|
| 접근성 | 이동 중 답하기 좋음, 알림 강함 | PC 앞에서 집중 세션 |
| 긴 후보 비교(로그라인 3개 + 근거) | 길이 제한으로 여러 통 분할, 가독성 낮음 | 카드·표로 나란히 비교 |
| 진행 중 ConceptBrief 표시 | 별도 메시지로만 가능, 갱신 시 스팸 | 옆 패널에 실시간 표시 |
| 과거 턴 수정·분기 | 사실상 불가(메시지 편집은 의미 없음) | "이 답 고치기", 분기 비교 가능 |
| 답 매칭 | 질문 1개/메시지 + ForceReply면 명확 | 문제 없음 |
| 기존 설계 재사용 | 05의 `Question`/`AnswerSession` 경로와 충돌 가능(질문 인박스 범람) | 독립 화면 |

## 5. 유사성 점검의 현실성

| 방법 | 가능 범위 | 한계 | 판정 |
|---|---|---|---|
| 법적 기준 이해 | 한국 실무는 아이디어(회귀·빙의 등 장르 전형 설정, 줄거리 유형, 캐릭터 유형)는 보호하지 않고 표현을 보호. 실질적 유사성은 전체 구성·사건 전개·인물 관계를 종합 판단. 서울중앙지법 2023. 4. 21. 2019가합588425가 웹소설의 아이디어·표현 구분 기준을 제시했다고 소개됨 | 판결문 원문 [미확인]. 시스템이 법적 판정을 대신할 수 없음 | 안내 문구 근거로만 사용 [2차] https://www.lawtalk.co.kr/posts/13356 , https://www.nepla.ai/wiki/지식재산/저작권/-일문일답-웹소설-표절-저작권-침해-판단-기준은-무엇일까-zxk9e60r3n7m |
| 트로프 태그 | 컨셉을 트로프 집합으로 표현하고 "흔한 조합"을 알려 줌 | 트로프 사전은 요구 B 템플릿에서 구축 필요 | **채택**. 위험 신호가 아니라 정보로 표시 |
| 고유명 금지 목록 대조 | 유명 작품의 인물명·고유 기술명·고유 지명·고유 조직명과 정확·정규화 일치 검사. NFR-SAFE-02 실존 인물 목록과 같은 장치 | 목록 출처·갱신이 미결(06 O-19와 같은 문제). 한국 웹소설 고유명 공개 데이터셋은 이번에 찾지 못함 [미확인] | **채택(목록은 사용자·운영자가 채움)** |
| LLM 자기 점검 | "이 컨셉과 닮은 알려진 작품과 겹치는 요소"를 LLM에 물어 참고 신호로 표시 | 모델이 작품을 모르거나 지어낼 수 있음(환각). 국내 최신 연재작은 학습 데이터에 없을 수 있음. CopyBench가 보인 대로 모델 자신이 사건·인물 복제를 생성할 수 있음 | **채택(참고용, "검증 안 됨" 표시)**. 차단 근거로 쓰지 않음 |
| 웹 검색 대조 | 로그라인 키워드로 플랫폼 작품 검색 | 플랫폼 약관·크롤링 제한, 검색 품질 편차, 비용 | 미채택(MVP). v1 이후 선택 기능 검토 |
| 임베딩 유사도 | 줄거리 요약끼리 벡터 유사도 | 비교 코퍼스(유명 작품 줄거리)가 필요하고 저작권·수집 문제. 같은 장르는 모두 유사하게 나옴 | 미채택 |

결론: 유사성 점검은 "막기"가 아니라 **고유명 차단 + 겹침 신호 표시 + 사용자 확인**으로 둡니다. 제품 문구는 "법적 판단이 아님"을 명시합니다.

## 6. 권고

### 6.1 대화 단계 구조 (`concept_partner`)

| 단계 `concept_phase`(제안) | 목적 | 채우는 슬롯 | 질문 방식 | 종료 조건 |
|---|---|---|---|---|
| `seed` | 사용자가 가진 씨앗을 그대로 받음 | `seed_notes`(원문 보존), 가져오기 텍스트(FR-NOV-05와 연결) | 열린 질문 1개("떠오른 장면·인물·제목·느낌을 자유롭게") | 사용자 발화 1회 이상 또는 "아직 없음" |
| `category` | 장르·하위 장르·트로프 확정 | `genre`, `subgenre`, `tropes[]`, `target_platforms[]` | 선택지 버튼(요구 B 템플릿 카테고리) + 직접 입력 | `genre` 확정 |
| `core` | 로그라인 축 | `protagonist`, `starting_condition`, `desire`, `opposition`, `stakes`, `irony_hook` | 슬롯당 질문 1개. 사용자가 막히면 후보 2~3개(서로 다른 축) | 6개 슬롯 `confirmed` 또는 `deferred` |
| `world_min` | 카테고리 필수 세계 규칙만 | `world_rules[]`(템플릿의 필수 항목, 예: 회귀 시점·횟수·대가, 상태창 규칙) | 템플릿 질문 목록 순서 | 템플릿 필수 항목 처리 |
| `serial` | 연재 지속성 점검 | `episode1_hook`, `cider_cycle`, `long_conflict_engine`, `arc_sketch`, `ending_direction` | 에이전트가 약점 1~2개를 먼저 지적하고 질문(동조 방지) | 슬롯 처리 |
| `packaging` | 톤·수위·제목 | `tone`, `age_rating`, `title_candidates[]`, `keywords[]` | 선택지 + 직접 입력 | 처리 |
| `review` | 로그라인 후보 생성·유사성 점검·승인 | `logline_options[]`, `selected_logline`, `similarity_report` | 로그라인 3개 카드(현 PRD 5.2의 로그라인 버튼 질문을 여기로 흡수) → ConceptBrief 승인 | `Approval(approval_type=concept_brief)` 승인 |

턴 규칙(모든 단계):

| 규칙 | 내용 |
|---|---|
| R1 질문 1개 | 한 턴에 질문 1개. 확인("A로 이해했습니다")은 질문과 같은 턴에 둘 수 있음 |
| R2 탈출구 | 매 질문에 "추천해 줘", "나중에", "이대로 진행" 선택지 |
| R3 비추측 | 사용자가 말하지 않은 슬롯은 `empty`. 추천안 채택은 사용자가 고른 경우만 |
| R4 원문 보존 | 사용자 발화 필드는 원문 + 해석을 분리 저장. 해석 변경은 확인 질문(05의 해석 확인과 같은 원리) |
| R5 단계 이동 자유 | 사용자가 순서를 벗어나 말하면 해당 슬롯을 채우고 다음 미결 슬롯으로 |

### 6.2 수렴 조건

| 조건 | 기본값(가정) | 동작 |
|---|---|---|
| 정상 수렴 | 필수 슬롯 전부 `confirmed` | `review` 단계로 이동 |
| 턴 상한 | `concept.max_turns` 40 (2026-11-06 구현에서 200 안전 상한으로 변경, 대화 종료는 브리프 완성 기준 — 설계 11 3.8) | 상한 도달 시 현재 상태로 ConceptBrief 초안을 만들고 미결 슬롯을 표시해 승인/계속 선택 |
| 반복 변경 | 같은 슬롯 `concept.slot_flip_limit` 3회 변경 | 변경 이력 비교 카드("A ↔ B, 어느 쪽?")로 고정 요청 |
| 사용자 종료 | "이대로 진행" | 미결 슬롯은 `deferred`로 넘기고 `planner`가 기획서 단계에서 추천안 + 질문으로 처리 |
| 세션 휴면 | `concept.session_idle_days` 14일 | 리마인더 1회. 자동 결정 없음(fail-closed 원칙과 같음) |
| 필수 슬롯 | `genre`, `protagonist`, `desire`, `opposition`, `irony_hook`, `ending_direction`, `age_rating` | 나머지는 `deferred` 허용 |

### 6.3 `ConceptBrief` 필드 초안 (ID 접두사 제안 `cbf`)

| 필드 | 타입 | 필수 | 설명 | 이후 사용처 |
|---|---|---|---|---|
| `id`, `novel_id`, `version`, `status` | — | 예 | `status`: `draft`/`awaiting_approval`/`approved`/`superseded`(`series_bible_status`와 같은 모양) | — |
| `seed_notes` | text | 아니오 | 사용자 원문 그대로 | 근거 보존 |
| `genre`, `subgenre`, `tropes[]` | 템플릿 키 | `genre` 예 | 요구 B 카테고리 템플릿 ID 참조 | `OntologySchema` 확장 선택, FR-NOV-03 |
| `target_platforms[]`, `target_readers` | text | 아니오 | | FR-NOV-04b 정책 프로필 경고 |
| `logline` | text | 예 | 1문장(스노우플레이크 1단계 길이 감) | `Goal`, `SeriesBible` |
| `premise_paragraph` | text | 아니오 | 약 5문장(설정·재앙 3·결말) | `SeriesBible` 아크 초안 |
| `protagonist` | {이름 후보, 출발 조건, 결핍, 우위} | 예 | | 초기 `Entity` 후보(`candidate`) |
| `desire`, `opposition`, `stakes` | text | `desire`·`opposition` 예 | | 아크 설계 |
| `irony_hook`, `episode1_hook` | text | `irony_hook` 예 | | 1화 아웃라인 |
| `world_rules[]` | {템플릿 항목 키, 값} | 템플릿 필수 항목 | | 초기 `Fact` 후보(`candidate`, 승인 전 캐논 아님) |
| `long_conflict_engine`, `cider_cycle`, `arc_sketch[]` | text | 아니오 | | `planner` 아크 계획 |
| `ending_direction` | text | 예 | | FR-NOV-02 결말 방향 |
| `tone`, `age_rating`, `title_candidates[]`, `keywords[]` | | `age_rating` 예 | `age_rating`은 MVP `age_15` 이하 | FR-NOV-01 |
| `similarity_report` | {고유명 일치[], LLM 겹침 신호[], 트로프 태그[]} | 예(빈 값 허용) | "법적 판단 아님" 표시 | 승인 화면 |
| `field_provenance` | map 필드 → {`origin`: `user_stated`/`agent_proposed_accepted`/`template_default`, `evidence_turn_ids[]`, `slot_state`: `empty`/`proposed`/`confirmed`/`deferred`} | 예 | 위험 b·g 완화의 핵심 | 승인 화면 근거 표시, 감사 |

관련 객체 제안: `ConceptSession`(`cns`, 단계·턴 수·채널), `ConceptTurn`(`cnt`, 발화·슬롯 변경 diff). 승인은 기존 `Approval`에 `approval_type=concept_brief` 추가.

### 6.4 위험별 완화

| 위험(3절) | 완화 | 검증 방법(가정) |
|---|---|---|
| a 수렴 실패 | 상태 중심 입력, 6.2절 수렴 조건 | 시뮬레이션 사용자 20세션에서 평균 턴 수·미수렴률 |
| b 동조·덮어쓰기 | 원문/해석 분리, `field_provenance`, `serial` 단계 약점 지적 | 승인 화면에서 `user_stated` 필드가 바뀐 비율 0 |
| c·d 질문 과다/과소 | R1·R2, 슬롯 기반 다음 질문 선택, `question_threshold`(00 6.1)를 질문 밀도에 재사용 | 세션당 질문 수, "추천해 줘" 비율 |
| e 균질화 | 후보 생성 시 축 다양화 지시, "흔한 선택" 표시 | 후보 간 유사도 측정(내부) |
| f 표절성 제안 | 생성 지시에 기존 작품 고유명·고유 설정 금지, 5절 점검 | 금지 목록 일치 0건 |
| g·h 요약 누락 | 턴마다 증분 갱신, 필드별 근거 턴, 승인 전 필드 diff 확인 | 사람 검토 표본에서 누락·왜곡 필드 수 |
| 안전 | 실존 인물 사칭 차단(NFR-SAFE-02), 연령 등급 제한(NFR-SAFE-01)을 컨셉 단계부터 적용 | 기존 안전 테스트 재사용 |

### 6.5 채널 배치와 기존 흐름 변경

| 항목 | 권고 |
|---|---|
| 주 채널 | 웹 온보딩 화면의 채팅 + 옆 패널 ConceptBrief 실시간 표시 |
| 메신저 | 같은 `ConceptSession`을 이어 가는 경량 모드: 메시지 1통 = 질문 1개, 선택지 버튼(`callback_data` 05 5.3 형식 재사용), 자유 입력은 ForceReply/모달. 긴 후보 비교·최종 승인 상세는 웹 링크. 승인 버튼은 메신저에도 둠 |
| 질문 인박스와 분리 | 컨셉 대화 턴은 `Question`으로 만들지 않음(인박스 범람 방지). 최종 승인만 `Question`(`approve_reject`) + `Approval`(`concept_brief`) |
| 상태 | `novel_status`에 `concept` 추가(`concept` → `onboarding` → `planning`) 또는 `onboarding` 하위 단계로 둘지 03에서 결정. 가정: 별도 값이 상태 전이 표현에 명확 |
| PRD 흐름 | 5.1 "장르·규칙 직접 입력"과 5.2-1 "로그라인 3개 버튼 질문"을 `concept_partner` 대화로 대체. 목표 수치(화수·분량·주기·예산)는 ConceptBrief 승인 후 목표 폼에서 입력하되, `ending_direction`·`age_rating`은 미리 채움 |
| 에이전트 | `agent_role`에 `concept_partner` 추가. 컨셉 승인 후에는 비활성(재기획·대형 변경 시 재호출 가능). `planner`는 ConceptBrief를 입력으로 `SeriesBible` 작성 |
| 요구 B 연결 | 카테고리 템플릿이 `category`·`world_min` 단계의 선택지와 질문 목록, `world_rules[]` 키를 공급. 템플릿이 없는 MVP에서는 공통 질문 목록(1.2절)만 사용 |

## 7. 미결·가정

| # | 내용 |
|---|---|
| U-1 | 질문 1개/턴이 여러 질문 묶음보다 낫다는 직접 비교 연구를 찾지 못했습니다. 메신저 답 매칭 근거와 가정으로 둡니다. MVP 사용성 시험으로 확인합니다. |
| U-2 | 기본값 `concept.max_turns`(40), `concept.slot_flip_limit`(3), `concept.session_idle_days`(14)는 가정입니다. 00 7.4 등록 후 MVP-α 실측으로 조정합니다. |
| U-3 | 한국 웹소설 고유명 공개 데이터셋이 확인되지 않았습니다. 금지 목록의 출처·갱신은 06 O-19(실존 인물 목록)와 함께 결정이 필요합니다. |
| U-4 | 플랫폼별 독자층 수치(콘진원·문체부 실태조사 원문)는 요구 B 시장 조사에서 확인합니다. |
| U-5 | Discord `MESSAGE_CONTENT` 인텐트의 멘션·DM 예외, Telegram 개인 채팅 토픽 도입 버전은 메신저 스파이크(09)에서 확인합니다. |
| U-6 | Doshi·Hauser 2024의 정확한 수치, Save the Cat 원서 문구, 서울중앙지법 2019가합588425 판결문은 원문을 확인하지 못했습니다. |
| U-7 | 컨셉 단계 비용(LLM 호출)은 예산 원장(FR-BUD)에 작품 단위로 잡히는지, 온보딩 무료 한도를 둘지 결정이 필요합니다. |

## 8. 출처 (확인일 2026-10-28)

| 등급 | 출처 |
|---|---|
| [1차] | Telegram Bot API https://core.telegram.org/bots/api |
| [1차] | Discord Message 리소스 https://docs.discord.com/developers/resources/message |
| [1차] | Ingermanson, Snowflake Method https://www.advancedfictionwriting.com/articles/snowflake-method/ |
| [1차] | Sudowrite Story Bible https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/what-is-story-bible/jmWepHcQdJetNrE991fjJC |
| [1차] | NovelCrafter 문서·강좌 https://www.novelcrafter.com/help/docs , https://www.novelcrafter.com/courses/ultimate-beginners-guide/codex-and-chat |
| [1차] | NovelAI Lorebook https://docs.novelai.net/en/text/lorebook |
| [1차] | Mirowski 외, Dramatron https://arxiv.org/abs/2209.14958 |
| [1차] | Laban 외, LLMs Get Lost In Multi-Turn Conversation https://arxiv.org/abs/2505.06120 |
| [1차] | Sharma 외, Towards Understanding Sycophancy https://arxiv.org/abs/2310.13548 |
| [1차] | Zhang 외, Modeling Future Conversation Turns to Teach LLMs to Ask Clarifying Questions https://arxiv.org/abs/2410.13788 |
| [1차] | Tix 등 질문 기반 문서 생성 사용자 연구 https://arxiv.org/abs/2407.12017 |
| [1차] | We're Different, We're the Same https://arxiv.org/abs/2501.19361 ; Diverse AI Personas https://arxiv.org/abs/2504.13868 |
| [1차] | Chen 외, CopyBench https://arxiv.org/abs/2407.07087 |
| [1차] | Liu 외, Lost in the Middle https://arxiv.org/abs/2307.03172 |
| [2차] | Doshi·Hauser 2024 주석 https://empirical-economics-of-ai.vercel.app/papers/DoshiHauser_2024_GenerativeAIEnhances |
| [2차] | Save the Cat 해설 https://en.wikipedia.org/wiki/Save_the_Cat!:_The_Last_Book_on_Screenwriting_You%27ll_Ever_Need , https://gyford.com/phil/writing/2018/02/25/save-cat-blake-snyder |
| [2차] | 웹소설 문법 https://www.youngju.dev/blog/storytelling/web-novel-grammar ; 사이다·고구마 https://seoulalien.substack.com/p/181 ; 제목 카피 https://www.careet.net/896 |
| [2차] | 시장 기사 https://www.webtoonguide.com/ko/board/news-column/19916 , https://economist.co.kr/article/view/ecn202504160028 |
| [2차] | 표절 판단 기준 https://www.lawtalk.co.kr/posts/13356 , https://www.nepla.ai/wiki/지식재산/저작권/-일문일답-웹소설-표절-저작권-침해-판단-기준은-무엇일까-zxk9e60r3n7m |
