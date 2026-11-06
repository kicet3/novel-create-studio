# 한국 웹소설 시장과 카테고리 체계 조사

- 작성일·확인일: 2026-10-28
- 목적: 사용자 요구 B(카테고리별 세계관 데이터 템플릿 구축 계획서)와 요구 A(`concept_partner` 컨셉 대화의 질문 목록)의 입력 자료입니다. FR-NOV-03(장르 템플릿, P1 v1)과 06 `OntologySchema` 작품 확장으로 이어집니다.
- 기준 문서: PRD v0.3 FR-NOV-01·03, D-1(b), D-13(MVP `age_15` 이하), 00 `age_rating`·`continuity_issue_kind`, 03 `novels.genre`(자유 입력, 템플릿은 v1), 06 4.1~4.3절(`base@1`).
- 등급: [1차] 플랫폼 실제 페이지·공식 기관 발표·공식 공지, [2차] 언론 기사·제3자 분석, [추론] 근거에서 이끈 판단, [미확인] 확인하지 못함. 조사하지 않은 전제는 "가정:"으로 표시합니다.
- 저작권: 개별 작품의 설정·문장은 옮기지 않았습니다. 작품명은 공모전 수상 장르 근거로 한 건만 적었고, 트로프는 장르 관습 수준으로만 정리했습니다.

## 1. 결론

| # | 결론 |
|---|---|
| 1 | 공식 통계상 국내 웹소설 시장은 **2020년 6,400억 원 → 1조 390억 원 → 2024년 1조 3,500억 원**으로 성장했습니다[2차, 문체부·한국출판문화산업진흥원 실태조사 보도]. 실태조사 주관 기관은 한국콘텐츠진흥원이 아니라 **문화체육관광부·한국출판문화산업진흥원(KPIPA)** 입니다. 2년 주기라서 2026년판은 아직 발표되지 않았습니다[미확인]. |
| 2 | 플랫폼마다 1단 장르 메뉴가 다릅니다. 다만 공통 핵심은 **로맨스·로판·판타지·현판·무협** 5개이고, 플랫폼에 따라 BL·라이트노벨·미스터리·대체역사·스포츠·SF·드라마·전쟁밀리터리·게임·퓨전·공포가 붙습니다[1차]. **회귀·빙의·헌터·아카데미 같은 트로프는 확인한 플랫폼(네이버 시리즈·네이버 웹소설·문피아·노벨피아·리디)에서 1단 장르가 아니고 태그·키워드 층에 있습니다**[1차, 확인 범위 한정. 카카오페이지는 검색 색인 요약만 [2차], 조아라 하위 분류 [미확인]]. |
| 3 | 따라서 분류는 **L1 세계 장르 – L2 하위 장르(무대·직업 축) – L3 트로프 태그(전생 장치·능력 체계·관계·서사 장치)** 3층에, 직교 축 **독자층·형식 패싯(BL·GL·라이트노벨·남성향/여성향)** 을 따로 두는 구조를 제안합니다(7절). BL·라이트노벨은 리디에서 "BL 현대물/판타지물/역사시대물"처럼 다시 세계 장르로 나뉘므로 L1이 아니라 패싯이 맞습니다[1차, 추론]. |
| 4 | 2026-10-28 네이버 시리즈 주간 TOP100(전체)의 장르 구성은 **현판 46, 무협 22, 판타지 20, 로판 8, 로맨스 4**입니다[1차, 직접 집계, 원본 HTML·CSV·스크립트·해시 보존 후 재집계로 같은 값 확인]. 장르별 TOP100 제목·소개문 키워드에서는 현판=전문직·연예계·회귀, 판타지=시대·헌터·게이트·회귀·빙의·귀족, 무협=문파·정파/사파 세력·환생, 로판=귀족·황실·계약결혼·빙의·악녀, 로맨스=계약결혼·육아·재벌이 상위였습니다[1차 데이터, 휴리스틱 집계, 수동 라벨 검증 전]. 자료 위치는 5.1절입니다. |
| 5 | 2026 공모전 신호: 네이버웹툰·문피아 "2026 지상최대 웹소설 공모전"에 **무협특별상 신설**, 1만 편 이상 접수(전년 대비 약 35% 증가)[2차]. 현판 단독 공모전(JC미디어×네이버시리즈), 무협·선협 단독 공모전(STUDIO JHS)이 열렸습니다[2차]. |
| 6 | 템플릿 설계에 바로 영향을 주는 발견: ① 회귀물은 "이전 회차"를 다루므로 06의 MVP 단일 시간선과 충돌할 수 있습니다(회차 기억을 `character_knowledge`로 볼지 별도 시간선으로 볼지 결정 필요). ② 대체역사·연예계·스포츠는 실존 인물·단체를 끌어오기 쉬워 `safety_real_person` 검사 기본값을 강화해야 합니다. ③ 노벨피아 상위 태그의 상당수(하렘·TS·피폐 등)는 연령 등급·수위와 얽혀 있어 MVP `age_15` 이하에서 템플릿 노출 여부를 따로 정해야 합니다[추론]. |

## 2. 시장 규모·추이

| 항목 | 값 | 기준 연도 | 출처·등급 |
|---|---|---|---|
| 시장 규모 | 6,400억 원 | 2020 | 2022 실태조사 보도[2차] (S2) |
| 시장 규모 | 1조 390억 원(2020 대비 62% 증가) | 2021 매출 기준. 보도마다 "2022년 시장"으로도 표기 | 문체부·KPIPA "2022 웹소설 분야 산업 현황 실태조사", 2023-09-07 보도[2차] (S2, S3) |
| 시장 규모 | **1조 3,500억 원**(2년 전 대비 3,110억 원 증가). 주요 플랫폼 매출 기반 추정 | 2024 | 문체부·KPIPA "2024 웹소설 산업 현황 실태조사", 2025-04-16 보도[2차] (S1) |
| 이용자 수 | 약 587만 명 | 2022 조사 | (S2)[2차] |
| 플랫폼 매출 | 네이버 4,266억 원, 카카오페이지 4,145억 원. **두 곳이 약 80%** | 2022 조사(11개 플랫폼 기준) | (S3)[2차] |
| 유료 결제 | 이용자 79.0% 유료 결제 경험, 1회 평균 8,032원 | 2024 조사 | (S1)[2차] |
| 가장 많이 읽는 장르(이용자) | 현대 로맨스 47.4% | 2022 조사 | (S2)[2차] |
| 작가 수입 | 70.8%가 편당 500만 원 미만, 연재 수입이 전체 수입의 60.3% | 2024 조사 | (S1)[2차] |
| 조사 표본 | CP사 152, 플랫폼 10, 창작자 800, 이용자 811 | 2024 조사 | (S1)[2차] |
| 다음 조사 | 2년 주기라서 2026년판은 2027년 전후 발표로 보입니다 | — | [추론]. 보고서 원문 PDF는 확보하지 못했습니다[미확인] |

참고: 2024 실태조사의 장르별 매출 비중·플랫폼별 점유율은 보도에 없고, 원문 보고서에서 확인해야 합니다[미확인].

## 3. 플랫폼별 장르 분류 체계 (실제 페이지 확인)

| 플랫폼 | 1단 장르(표기 그대로) | 하위 분류·태그 | 확인 방법·등급 |
|---|---|---|---|
| 네이버 시리즈(소설) | 로맨스, 로판, 판타지, 현판, 무협, 미스터리, 라이트노벨, BL (`genreCode` 201~209) | 작품 단위 하위 장르 없음. 랭킹은 같은 8개 장르 필터 | `series.naver.com/novel/categoryProductList.series`, `top100List.series` HTML[1차] (S4). 랭킹 쪽 원본은 `data/naver-series-top100-2026-10-28/raw/`에 보존. 같은 날 research-genre-world-elements.md 1.1은 "접근 실패"로 적었으나, 이 문서는 서버 측 HTTP 요청(curl, HTTP 200)으로 수집했습니다 |
| 네이버 웹소설(연재) | 로맨스, 로판, 판타지, 현판, 무협, 미스터리, 라이트노벨 (`genre` 101~110). 선호 장르 설정은 로맨스·로판·판타지·현판·무협 5개 | — | `novel.naver.com/webnovel/genre`, `/best/genre` HTML[1차] (S5) |
| 카카오페이지(웹소설) | 판타지, 현판, 무협, 로판, 로맨스(웹소설 메뉴 탭). BL·드라마 탭 여부는 [미확인] | 키워드 태그 검색 방식 [미확인] | 클라이언트 렌더링이라 직접 읽지 못했고 검색 색인 요약으로만 확인했습니다[2차] (S6) |
| 문피아 | 현대판타지, 판타지, 무협, 대체역사, 스포츠, 퓨전, 드라마, 전쟁·밀리터리, 로맨스, 게임, SF, 기타 | 메타 키워드에 19금·BL 표기 | 공개 JS 번들의 검색 필터 정의(`NEWFANTASY`, `HEROISM`, `HISTORY`, `MILIWAR` 등)[1차] (S7) |
| 리디(웹소설) | 로맨스, 로판, 판타지, BL | 로맨스: 현대물, 역사/시대물 / 로판: 동양풍, 서양풍, 가상 세계 / 판타지: 정통, 퓨전, 현대 판타지, 무협 소설(e북은 게임 판타지, 대체 역사물, 스포츠물, 신무협, 전통 무협 추가) / BL: 현대물, 판타지물, 역사/시대물 | `ridibooks.com/category/list` HTML[1차] (S8) |
| 노벨피아 | 판타지, 무협, 현대, 로맨스, 현대판타지, 라이트노벨, 공포, SF, 스포츠, 대체역사, 기타 | 자유 해시태그(9절 상위 태그) | `novelpia.com/plus` HTML, 2026-10-28 기준 PLUS 11,353개 작품[1차] (S9) |
| 조아라 | 로맨스, BL, 판타지(메인 바로가기 필터) | 하위 분류 [미확인] | 공개 JS 번들의 바로가기 필터 정의[1차] (S10) |

관찰[추론]:
- 남성향 플랫폼(문피아·노벨피아)은 판타지를 **현대판타지·대체역사·스포츠·게임·전쟁밀리터리**로 잘게 나누고, 로판 탭이 없거나 약합니다.
- 여성향 비중이 큰 리디는 **로판을 동양풍·서양풍·가상 세계**로 나눕니다. 무대의 문화권이 1차 분류 축입니다.
- 카카오페이지·네이버는 5대 장르 탭을 중심으로 두고 트로프는 키워드·기획전으로 노출합니다.

## 4. 플랫폼 간 대응표

행은 7절에서 제안하는 식별자입니다. ○ 독립 1단 장르, △ 하위 분류·다른 장르에 포함, — 해당 메뉴 없음, ? 미확인.

| 제안 L1/L2 | 네이버 시리즈 | 네이버 웹소설 | 카카오페이지 | 문피아 | 리디 | 노벨피아 | 조아라 |
|---|---|---|---|---|---|---|---|
| `romance` 로맨스 | ○ 로맨스 | ○ | ○ | ○ 로맨스 | ○ (현대물·역사/시대물) | ○ | ○ |
| `romance_fantasy` 로판 | ○ 로판 | ○ | ○ | — (로맨스·판타지에 흡수) | ○ (동양풍·서양풍·가상 세계) | △ 로맨스·판타지 | ? |
| `fantasy` 판타지 | ○ | ○ | ○ | ○ 판타지, ○ 퓨전 | ○ (정통·퓨전) | ○ | ○ |
| `modern_fantasy` 현판 | ○ 현판 | ○ | ○ | ○ 현대판타지 | △ 판타지 > 현대 판타지 | ○ 현대판타지 (+ 현대) | ? |
| `wuxia` 무협 | ○ | ○ | ○ | ○ 무협 | △ 판타지 > 무협 소설 (e북: 신무협·전통 무협) | ○ | ? |
| `alt_history` 대체역사 | △ 판타지·현판 | △ | ? | ○ 대체역사 | △ e북 대체 역사물 | ○ 대체역사 | ? |
| `modern_fantasy.sports` 스포츠 | △ 현판 | △ | ? | ○ 스포츠 | △ e북 스포츠물 | ○ 스포츠 | ? |
| `fantasy.game` 게임 판타지 | △ 판타지 | △ | ? | ○ 게임 | △ e북 게임 판타지 | △ 태그 | ? |
| `war_military` 전쟁·밀리터리 | — | — | ? | ○ 전쟁·밀리터리 | — | — | ? |
| `sf` SF | — | — | ? | ○ SF | — | ○ SF | ? |
| `mystery_horror` 미스터리·공포 | ○ 미스터리 | ○ 미스터리 | ? | △ 기타 | — (웹소설 기준) | ○ 공포 | ? |
| `drama` 드라마·일반 | — | — | ? | ○ 드라마 | — | △ 현대 | ? |
| 패싯 `bl` | ○ BL | — | ? | △ (19금·BL 별도 영역) | ○ BL (현대물·판타지물·역사/시대물) | △ 태그 | ○ BL |
| 패싯 `light_novel` | ○ 라이트노벨 | ○ | ? | — | — (웹소설 기준) | ○ 라이트노벨 | ? |

## 5. 인기·성장 카테고리와 트로프 근거

### 5.1 네이버 시리즈 주간 TOP100 (2026-10-28 수집, 직접 집계)

방법: `top100List.series?rankingTypeCode=WEEKLY&categoryCode=<장르>`(ALL, 201~209) 1~5쪽을 받아, 작품 번호(`productNo`)로 전체 TOP100의 장르를 맞추고, 제목·소개문(`p.dsc`)에서 트로프 정규식이 한 번 이상 맞는 작품 수를 셌습니다. 키워드 일치는 휴리스틱이라 과대·과소 집계가 있습니다(예: "황제"는 시대·귀족 양쪽에 걸림, "결혼"·"아이"는 넓게 걸림). 미스터리(4편)·라이트노벨(6편)·BL(36편)은 수집된 항목 수가 적어 비교에서 뺐습니다. [1차 데이터, 키워드 집계는 휴리스틱]

재현 자료(리뷰 지적 반영, 2026-10-28):

| 항목 | 내용 |
|---|---|
| 위치 | `docs/research/data/naver-series-top100-2026-10-28/` |
| 원본 | `raw/<ALL·201~209>-p<1~5>.html` 45개. 2026-10-28 02:42 KST(2026-10-27 17:42 UTC) 재수집 |
| 정규화 | `top100.csv`(646행: rank, category_code, category, product_no, title, author, dsc) ← `scripts/parse.py` |
| 키워드 | `keyword_counts.csv`(장르·키워드 묶음·작품 수·정규식) ← `scripts/keywords.py`. 정규식은 CSV `regex` 열과 스크립트에 그대로 있습니다 |
| 무결성 | `SHA256SUMS`(원본 HTML 45 + CSV 2 + 스크립트 2 = 49개 파일). `top100.csv` = `a3eaea7d…f775c378` |
| 재실행 | `python3 -I scripts/parse.py <폴더>` → `python3 -I scripts/keywords.py <폴더>` |
| 장르 구성 재현 | 최초 집계(01:08 KST 전)와 **같은 값**(현판 46, 무협 22, 판타지 20, 로판 8, 로맨스 4). 같은 주간 랭킹 주기 안의 재수집입니다 |
| 키워드 재현 | 최초 집계의 정규식은 남기지 않아 그대로 재현할 수 없었습니다. 아래 표는 **재수집 원본 + 보존한 정규식으로 다시 센 값**으로 바꿨습니다. 최초 값과 상위 묶음은 대체로 같고, 판타지(헌터 17→13, 빙의 6→11)·로맨스(1위가 육아→계약·결혼)·로판(계약·결혼 28→45)에서 차이가 납니다. 차이는 정규식 범위 차이로 봅니다[추론] |

| 범위 | 결과(작품 수, `keyword_counts.csv`) |
|---|---|
| 전체 TOP100 장르 구성 | 현판 46, 무협 22, 판타지 20, 로판 8, 로맨스 4 [1차, 재현됨] |
| 현판 TOP100 상위 키워드 | 전문직·천재 21, 연예계 16, 회귀 14, 육아·가족 11, 계약·결혼 8, 재벌·기업 7, 스포츠 6, 헌터·게이트 4 |
| 판타지 TOP100 | 시대(황제·전쟁) 21, 헌터·게이트·던전 13, 빙의 11, 회귀 11, 귀족·황실 11, 육아·가족 10, 상태창·시스템 6, 탑 5 |
| 무협 TOP100 | 문파·세력(무림·마교·천마·정파·사파 등) 50, 전문직·천재 20, 육아·가족 18, 환생 11, 회귀 10 |
| 로판 TOP100 | 귀족·황실 48, 계약·정략결혼·이혼 45, 육아·가족 34, 빙의 17, 악녀·악역 15, 회귀 9, 복수 7 |
| 로맨스 TOP100 | 계약·정략결혼·이혼 42, 육아·가족 35, 재벌·기업 26, 전문직 14, 회귀 6, 연예계 6, 복수 5 |

주의: 키워드 수치는 수동 라벨 검증 전입니다. 템플릿 우선순위 확정(D-29·DG-01) 전에 9절의 "표본 50편 수동 라벨 비교"를 먼저 끝내야 합니다. 장르 구성 수치는 사이트 분류값이라 이 주의에서 제외합니다.

### 5.2 노벨피아 PLUS 첫 화면 태그 빈도 (2026-10-28 스냅샷)

HTML에 노출된 해시태그 빈도입니다. 랭킹이 아니라 첫 화면 노출 기준입니다[1차 데이터, 추론 해석].

| 순위대 | 태그(빈도) |
|---|---|
| 상위 | 판타지 40, TS 32, 현대 28, 현대판타지 22, 하렘 20, 라이트노벨 18, 집착 18, 일상 18, 아카데미 14, 먼치킨 12 |
| 중위 | 로맨스 10, 착각 10, 헌터 8, 약피폐·암타·중세·탑등반·후회·피폐 각 6 |
| 하위 | 아포칼립스·노맨스·괴이·괴담·코미디·순애·빙의·인터넷방송·게이트·제작·소꿉친구·대체역사 각 4, 좀비·데스게임·가상현실·소환사·연예계·백합 각 2 |

해석: 남성향 무료·유료 연재 플랫폼에서는 **아카데미·탑등반·헌터·게이트·아포칼립스·괴담**이 무대 축이고, **TS·하렘·집착·후회·피폐·순애·착각·먼치킨**이 관계·서사 장치 축입니다. 이 가운데 하렘·TS·피폐류는 연령 등급·수위와 겹칩니다(D-13).

### 5.3 공모전·업계 신호 (2025~2026)

| 신호 | 내용 | 출처·등급 |
|---|---|---|
| 2026 지상최대 웹소설 공모전(네이버웹툰·문피아) | 접수 2026-05-13~06-21, 1만 편 이상(전년 대비 약 35% 증가), 작가 7,400명, 수상 37편, **무협특별상 신설**. 대상작 장르는 "현대판타지·대체역사", 소재는 빙의 | 이투데이 2026-07-22[2차] (S11) |
| JC미디어×네이버시리즈 공모전 | 주제 현대판타지 단일, 접수 2026-08-05~09-06 | 공모전 안내[2차] (S12) |
| STUDIO JHS 공모전 | 무협·선협 단일. 판타지·현판·로맨스·로판 참여 불가 명시, 접수 마감 2026-02-20 | 공모전 안내[2차] (S13) |
| 장르 트렌드 분석(블로그) | 남성향: 다회귀·부분 회귀·역회귀, 헌터물 변형(던전 경영·육성·길드 운영), 퇴마·도시 전설. 여성향: 역빙의·시스템 로판·성장형 여주, 궁중 정치·여제, 힐링·일상. BL: 오메가버스·현대·직장. 크로스 장르 증가. 포화 우려: 단순 회귀, 아카데미, 오해 기반 로맨스 | StoryBench 2026-01-25. 방법론 불명[2차] (S14) |
| 키워드 랭킹(제3자 사이트) | TOP100 기준 회귀 13, 천재 11, 황제 8, 천마 7, 게임 7, 복수 6, 환생 5, 탑 5, 영지 5 등 | NovelPick. 기간·플랫폼 미표기[2차] (S15) |
| 회·빙·환 정착 | "회귀·빙의·환생"이 장르 공통 요소로 자리 잡았다는 분석 | 경향신문 2022-02-06[2차] (S16) |

요약 판단[추론]:
- 회귀·빙의·환생은 **독립 장르가 아니라 거의 모든 L1에 붙는 전생 장치 패싯**입니다. 템플릿은 L1마다 이 패싯의 기본 질문·제약을 다르게 둬야 합니다(예: 로판 빙의=원작 줄거리 지식, 무협 환생=전생 무공 기억).
- 2026년 상위권의 실제 무게는 **현판(전문직·연예계·스포츠·재벌)과 무협**에 있고, 헌터·게이트는 판타지·현판 양쪽에 걸친 무대 패싯으로 남았습니다.
- 여성향은 **귀족·황실 + 계약·정략결혼 + 육아·가족 + 빙의·악녀**가 고정 축입니다.
- 아카데미·단순 회귀는 노출량은 많지만 포화 우려가 제기됩니다[2차]. 템플릿 우선순위는 그대로 두고 컨셉 대화에서 변형 질문을 더 묻도록 하는 편이 낫습니다[추론].

### 5.4 여성향 랭킹 추가 수집: 리디 웹소설 주간 베스트셀러 (2026-10-28, S1 추가 조사)

방법: 리디 웹 페이지가 쓰는 공개 API `https://api.ridibooks.com/v2/views/categories/<id>/bestsellers?adult_option=none&period=weekly&platform=web`을 서버 측 HTTP 요청(curl, HTTP 200)으로 받았습니다. 대상은 로맨스 웹소설(1650)과 로판 웹소설(6050) 상위 100편입니다. 응답에는 소개문(`introduction`)이 비어 있어 트로프 키워드는 세지 않았고, 하위 분류와 성인 표시만 셌습니다. [1차 데이터, 직접 집계]

| 항목 | 내용 |
|---|---|
| 위치 | `docs/research/data/ridi-bestsellers-weekly-2026-10-28/` (`raw/*.json` 2개, `top100.csv`, `scripts/parse.py`, `SHA256SUMS`). 재실행: `python3 -I scripts/parse.py <폴더>` |
| 로맨스 웹소설 TOP100 하위 분류 | 현대물 96, 역사/시대물 4 |
| 로판 웹소설 TOP100 하위 분류 | 서양풍 85, 가상 세계 16, 동양풍 2(한 작품이 둘 이상에 속할 수 있음) |
| 성인 표시(`adults_only=true`) | 로맨스 94/100, 로판 85/100. `adult_option=none`을 줘도 포함됐습니다. 이 표시가 "성인 전용 판본이 있음"인지 "작품 전체가 성인 등급"인지는 [미확인] |

해석[추론]: (1) 여성향 상위권의 무대 축은 로맨스=현대물, 로판=서양풍(제국·귀족)이 압도적이라 계획서의 `romance.contemporary`·`romance_fantasy.western_court` 우선순위와 맞습니다. (2) 성인 표시 비율이 높아, MVP `age_15` 이하(D-13)에서 여성향 상위권을 그대로 대표하기 어렵습니다. D-34(수위 연동 태그 노출) 판단 자료로 넘깁니다. (3) 소개문이 없어 SC-1(L2·L3 커버리지) 수동 라벨 표본으로는 아직 쓸 수 없습니다. 작품 상세 페이지 소개문 수집이 추가로 필요합니다. 카카오페이지 랭킹은 이번에도 수집하지 못했습니다(클라이언트 렌더링, 시도하지 않음).

## 6. 해외 장르 분류 대응 (D-1(b))

| 채널 | 확인한 분류 | 등급 |
|---|---|---|
| Wattpad | 2026-04-16 공지로 2026-05부터 새 분류 시행. 작품당 장르 최대 3개, 장르당 하위 장르 최대 3개, 팬픽은 팬덤 필드. Fiction 장르: Action and Thriller, Culture and Identity, Fantasy, Historical, Horror, LGBTQ+, Mystery, Paranormal, Romance, Science Fiction, Social Themes. 하위 장르 예: Fantasy > Isekai and Reincarnation, Wuxia and Cultivation, Dark Academia, Magical Kingdoms / Romance > Billionaires and CEOs, Contract Relationship, Marriage and Divorce, Enemies to Lovers, Second Chance, Secret/Surprise Baby / Science Fiction > LitRPG, Apocalyptic and Dystopian / Paranormal > Omegaverse, Werewolves | [1차] (S17, S18) |
| Webnovel | 앱스토어 소개의 주요 장르: Mystery, Eastern Fantasy, Western Fantasy, Sci-fi, Fan-fic, Xianxia, Xuanhuan, Wuxia, Romance. 남성향·여성향 구분은 [미확인] | [1차, 앱스토어 소개] (S19). 사이트는 403으로 직접 확인하지 못했습니다 |
| Royal Road | 사이트가 403이라 장르·태그 목록을 직접 확인하지 못했습니다. 영미권 웹연재의 핵심 하위 장르로 LitRPG, Progression Fantasy, Isekai/Portal Fantasy, Time Loop, Dungeon이 거론됩니다 | [2차] (S20, S21). 공식 태그 이름은 [미확인] |

대응표[추론]:

| 제안 식별자 | Wattpad | Webnovel | Royal Road(관용 명칭, 미확인) |
|---|---|---|---|
| `romance_fantasy` | Romance + Fantasy(Magical Kingdoms), Historical > Royalty | Romance / Western Fantasy | — |
| `romance` | Romance(Billionaires and CEOs, Contract Relationship, Workplace) | Romance(Urban) | — |
| `fantasy` | Fantasy(High Fantasy, Dark Fantasy) | Western Fantasy | Fantasy |
| `fantasy.game`, `ability_system.status_window` | Science Fiction > LitRPG | Games(제3자 분류) | LitRPG, GameLit |
| `modern_fantasy.hunter_gate`, `stage.dungeon_tower` | Fantasy / Paranormal | Urban, System | Dungeon, Progression |
| `wuxia` | Fantasy > Wuxia and Cultivation | Wuxia, Xianxia, Xuanhuan | Wuxia, Xianxia |
| `rebirth.*`(회귀·빙의·환생) | Fantasy > Isekai and Reincarnation, Romance > Second Chance | Reincarnation(관용) | Isekai/Portal Fantasy, Reincarnation, Time Loop |
| `alt_history` | Historical > Alternate Reality | — | Historical |
| 패싯 `bl` | LGBTQ+ > Gay, Paranormal > Omegaverse | — | — |
| `stage.academy` | Fantasy > Dark Academia, Paranormal > Supernatural High School | — | (School Life, 미확인) |

시사점[추론]: 해외 분류는 장르를 여러 개 붙이는 다중 라벨 구조입니다(Wattpad 3×3). 내보내기 시 L1 하나 + L3 태그 여러 개를 해외 장르·하위 장르로 사상하는 매핑 표를 템플릿 데이터에 같이 두면 됩니다. 회귀(시간 역행)는 영미권에서 Time Loop·Second Chance·Reincarnation으로 쪼개져 1:1 대응하지 않습니다.

## 7. 카테고리 분류 체계 제안 (3층 + 패싯)

### 7.1 구조

| 층 | 식별자 형식 | 개수(초안) | 역할 | 06 연결 |
|---|---|---|---|---|
| L1 세계 장르 `genre` | `fantasy` | 12 | 작품당 1개(주 장르). 플랫폼 1단 메뉴에 대응. 템플릿 묶음의 기본 단위 | 장르별 기본 확장 엔티티·관계 묶음 |
| L2 하위 장르 `subgenre` | `fantasy.estate` | L1당 2~6 | 무대·직업 축. 작품당 0~2개 | 속성 묶음(작위 서열, 랭크 체계 등) |
| L3 트로프 태그 `trope` | `rebirth.regression` | 약 60 | 장치·관계·서사 축. 작품당 여러 개 | 제약·연속성 규칙·떡밥 패턴·컨셉 질문 |
| 패싯 `audience_format` | `bl`, `gl`, `light_novel`, `male_oriented`, `female_oriented` | 5 | L1과 직교. 플랫폼 노출·문체·수위 기본값 | 연령 등급 기본값, 관계 어휘(오메가버스 등) |

**중복 해소 주의(2026-10-28 추가)**: 아래 7.2·7.3 표는 조사 시점 초안이라 같은 개념이 두 층에 있습니다(예: `light_novel_world` ↔ 패싯 `light_novel`, `stage.gate_dungeon` ↔ `modern_fantasy.hunter_gate`, `profession.*` ↔ 현판 L2, `ability_system.cultivation`·`stage.murim_factions` ↔ L1 `wuxia`). 템플릿에 쓰는 정식 키와 별칭은 계획서 `../plans/genre-world-templates-plan.md` 2.2절 중복 해소표(개념 1개 = 키 1개, L1 11개·L3 25개)와 00 6.13 카테고리 키 레지스트리가 정본이고, 이 표의 키 개수(L1 12, L3 약 60)는 참고값입니다.

가정: L1 하나 + L2 최대 2개 + L3 여러 개 구조가 작품 대부분을 표현합니다. 크로스 장르(예: 현판+대체역사)는 L1 하나와 보조 L1 하나(`secondary_genre`)로 표현합니다. 2026 지상최대 공모전 대상작처럼 "현판·대체역사"로 소개되는 작품이 있기 때문입니다[2차 근거, 추론].

### 7.2 L1·L2 초안

| L1 | 한국어 | L2 (식별자: 한국어) | 근거 플랫폼 |
|---|---|---|---|
| `romance` | 로맨스 | `contemporary`: 현대물, `historical`: 역사·시대물, `office`: 직장·전문직, `campus`: 학원·캠퍼스 | 리디·네이버·카카오 |
| `romance_fantasy` | 로맨스판타지 | `western_court`: 서양풍(제국·귀족), `eastern_court`: 동양풍(궁중), `virtual_world`: 가상 세계(게임·소설 속) | 리디 하위 분류, 네이버·카카오 |
| `fantasy` | 판타지 | `high_fantasy`: 정통, `fusion`: 퓨전, `game`: 게임 판타지, `estate`: 영지·경영, `dungeon_tower`: 탑·던전 | 리디·문피아·노벨피아 |
| `modern_fantasy` | 현대판타지 | `hunter_gate`: 헌터·게이트, `professional`: 전문직(의사·법조·요리 등), `entertainment`: 연예계·방송, `sports`: 스포츠, `chaebol_business`: 재벌·기업, `occult`: 퇴마·괴담 | 네이버 TOP100, 문피아, 노벨피아 |
| `wuxia` | 무협 | `traditional`: 전통 무협, `new_wuxia`: 신무협, `xianxia`: 선협 | 리디 e북, STUDIO JHS 공모전 |
| `alt_history` | 대체역사 | `korean_dynasty`: 한국 왕조, `modern_history`: 근현대, `foreign_history`: 외국사 | 문피아·노벨피아 |
| `war_military` | 전쟁·밀리터리 | `modern_war`, `historical_war` | 문피아 |
| `sf` | SF | `apocalypse`: 아포칼립스, `space`: 우주, `vr`: 가상현실 | 문피아·노벨피아 |
| `mystery_horror` | 미스터리·공포 | `mystery`: 추리, `horror`: 공포·괴이, `thriller`: 스릴러 | 네이버·노벨피아 |
| `drama` | 드라마·일반 | `slice_of_life`: 일상, `family`: 가족 | 문피아·노벨피아(현대) |
| `light_novel_world` | 라노벨식 이세계·학원 | `isekai`, `school` | 네이버·노벨피아 (패싯과 함께 검토). **계획서 2.2에서 L1 제외**: 패싯 `light_novel`로, `isekai` → `rebirth.possession`·`rebirth.reincarnation` 별칭, `school` → `stage.academy` 별칭 |
| `other` | 기타 | — | 문피아·노벨피아 |

### 7.3 L3 트로프 태그 초안과 세계관 정보 요구

"필요 정보"는 템플릿 계획서가 데이터 템플릿으로 만들 항목입니다. 06 기본 유형(`character`, `place`, `organization`, `item`, `event`, `rule`, `ability`, `title`, `persona`, `body`)으로 받을 수 있는지와 확장이 필요한지를 함께 적었습니다[추론].

| 축 | 태그 (식별자: 한국어) | 주 L1 | 세계관 필요 정보 | 06 영향 |
|---|---|---|---|---|
| 전생 장치 | `rebirth.regression`: 회귀, `rebirth.multi_regression`: 다회귀 | 전체 | 회귀 시점·횟수·트리거, 이전 회차 기억 범위, 이전 회차에서 일어난 사건 목록, 바뀐 사건 | **단일 시간선과 충돌 가능**. 이전 회차를 `character_knowledge`(미래 지식)로 둘지 시간선 분기로 둘지 결정 필요 |
| 전생 장치 | `rebirth.possession`: 빙의, `rebirth.book_possession`: 책·게임 빙의, `rebirth.reverse_possession`: 역빙의 | 로판·판타지·현판 | 원래 몸 주인과 빙의자의 구분, 원작 줄거리 지식(작중 미래), 원작과 달라진 지점 | `persona`·`body` 기본 지원. 원작 지식은 인물 지식으로 |
| 전생 장치 | `rebirth.reincarnation`: 환생 | 무협·판타지 | 전생 정체·사망 시점, 전생 능력 계승 범위 | `persona` 확장 또는 속성 |
| 능력 체계 | `ability_system.status_window`: 상태창·시스템 | 판타지·현판 | 수치 항목, 레벨·스킬 규칙, 메시지 형식, 보상 규칙 | `ability`·`rule`, `monotonic_non_decreasing` 속성 |
| 능력 체계 | `ability_system.awakening_rank`: 각성·등급 | 현판 | 등급 단계 순서, 재각성 규칙 | 순서형 속성(등급 enum) |
| 능력 체계 | `ability_system.cultivation`: 내공·경지 | 무협 | 경지 단계 순서, 무공 계보, 심법·초식 | 순서형 속성, `master_of` 계보 |
| 능력 체계 | `ability_system.mana_magic`: 마법·마나 | 판타지·로판 | 마법 체계·서클·속성, 금기 | `rule` |
| 무대 | `stage.gate_dungeon`: 게이트·던전, `stage.tower`: 탑 등반 (별칭 → `modern_fantasy.hunter_gate`·`fantasy.dungeon_tower`, 계획서 2.2) | 판타지·현판 | 게이트 등급·출현 규칙, 층 구조, 보상 | `place` 계층, `event` |
| 무대 | `stage.academy`: 아카데미 | 판타지·라노벨 | 학년·반·석차, 교수·학생 조직, 학사 일정 | `organization`, 시간 속성 |
| 무대 | `stage.murim_factions`: 정파·사파·마교 세력 | 무협 | 세력 목록·관계, 문파 서열·직위 | `organization`, `title`, 세력 관계 확장 |
| 무대 | `stage.imperial_court`: 제국·궁중 | 로판·대체역사 | 작위 서열, 계승 순위, 궁 구조 | `title`(`max_holders`), 순위 속성 |
| 무대 | `stage.estate`: 영지 경영 | 판타지 | 영지 자원·인구·재정 수치 | 수치 속성, 시간 변화 |
| 무대 | `stage.apocalypse`: 아포칼립스, `stage.occult`: 괴담·괴이 | SF·현판·공포 | 붕괴 시점, 생존 규칙, 괴이 규칙 | `rule` |
| 직업 | `profession.medical`, `.legal`, `.chef`, `.idol_actor`, `.athlete`, `.chaebol` | 현판·로맨스 | 직급·소속, 경력 연표, 경기·작품 기록 | `organization`, `event`. **실존 단체·인물 안전 검사** |
| 관계 | `relation.contract_marriage`: 계약·정략결혼 | 로판·로맨스 | 계약 조건·기한·해지 조건 | `spouse_of` + 계약 사실(기한) 확장 |
| 관계 | `relation.villainess`: 악녀·악역 | 로판 | 원작 속 배역, 파멸 예정 사건 | 인물 지식, 떡밥 |
| 관계 | `relation.childcare_family`: 육아·가족 | 로판·로맨스·무협·현판 | 나이 연표, 보호자 관계 | `age` 연속성 검사 강화 |
| 관계 | `relation.regret`: 후회, `relation.obsession`: 집착 | 로판·로맨스 | 감정 상태 변화 연표 | `state` 사실 |
| 관계 | `relation.omegaverse`: 오메가버스 | BL 패싯 | 형질 규칙, 주기 | `rule`, 인물 속성. 수위 등급 연동 |
| 관계 | `relation.harem`: 하렘 | 라노벨·남성향 | — | MVP 노출 여부 결정 필요(D-13) |
| 서사 장치 | `plot.revenge`: 복수, `plot.munchkin`: 먼치킨, `plot.misunderstanding`: 착각, `plot.healing`: 힐링·일상, `plot.growth`: 성장 | 전체 | 복수 대상·사건, 힘의 상한, 오해 정보 비대칭 | 떡밥 패턴(설치·회수), 독자 지식 vs 인물 지식 |
| 시대 | `era.real_history`: 실존 역사 기준선 | 대체역사 | 실제 사건 기준 연표, 분기점 | 기준 연표 사실 + `safety_real_person` 강화 |

## 8. 템플릿·컨셉 대화로 넘길 입력 (요구 A·B 연결)

| 산출 | 이 조사에서 넘기는 것 |
|---|---|
| 데이터 템플릿 계획서(B) | 7절 3층+패싯 식별자, L1별 L2·L3 기본 묶음, 7.3절 "필요 정보" 열, 4·6절 국내외 매핑 표 |
| `concept_partner` 질문 목록(A) | L1 선택 → L2 무대 → 전생 장치(있는지·무엇) → 능력 체계 → 핵심 관계 → 서사 장치 → 연령 등급·패싯 순서. 포화 우려 트로프(단순 회귀·아카데미)는 변형 질문을 추가합니다[2차 근거, 추론] |
| 연속성 규칙 | 회귀(회차 기억), 육아(나이), 무협 경지·현판 등급(단조 증가), 궁중 계승 순위·칭호 보유자, 계약결혼 기한 |
| 떡밥 패턴 | 회귀=이전 회차 사건 재발/회피, 빙의=원작 예정 사건, 악녀=파멸 예정 사건, 복수=대상별 회수 |
| 안전 기본값 | 대체역사·연예계·스포츠·재벌 → 실존 인물·단체 검사, 하렘·TS·피폐·오메가버스 → 연령 등급 기본값 |

## 9. 한계와 후속 조사

| 항목 | 상태 | 후속 |
|---|---|---|
| 실태조사 원문 PDF(장르별 매출·플랫폼 점유) | [미확인] 보도 기사로만 확인 | KPIPA 자료실에서 2024 보고서 원문 확보 |
| 카카오페이지 장르 탭·키워드 태그 | 클라이언트 렌더링이라 직접 확인하지 못함[2차] | 브라우저 도구로 웹소설 메뉴·키워드 검색 화면 확인 |
| Royal Road·Webnovel 공식 태그 | 사이트가 403. 우회 수단은 쓰지 않았습니다 | 사용자 브라우저로 태그 목록 확인 |
| 문피아·카카오·리디 랭킹 | 리디 로맨스·로판 웹소설 주간 TOP100은 수집(5.4절, 하위 분류·성인 표시만, 소개문 없음). 문피아·카카오페이지는 미수집 | 리디 작품 상세 소개문 수집 후 SC-1 수동 라벨, 카카오페이지·문피아는 브라우저 도구로 수집 |
| 트로프 시계열(2025→2026 변화) | 단일 시점 스냅샷만 있음 | 월 1회 같은 방법으로 집계해 추이 확보 |
| 리디 공식 트렌드 글(ridicorp) | 403 | 다른 경로로 원문 확인 |
| 키워드 집계 정확도 | 정규식 휴리스틱(`data/naver-series-top100-2026-10-28/scripts/keywords.py`). 최초 정규식은 유실되어 재수집 원본으로 다시 셈 | **필수, D-29·DG-01 확정 전**: `top100.csv`에서 장르별 10편씩 표본 50편을 뽑아 사람이 트로프를 라벨하고, 정규식 결과와 묶음별 정밀도·재현율을 비교합니다. 상위 5개 묶음 순위가 바뀌면 7절·템플릿 우선순위를 다시 봅니다 |
| 재현 자료 보존 | 2026-10-28 TOP100 원본·CSV·스크립트·SHA256 보존 | 이후 집계도 `data/naver-series-top100-<날짜>/` 같은 구조로 남깁니다 |

## 10. 출처 (확인일 모두 2026-10-28)

| ID | 출처 | 등급 |
|---|---|---|
| S1 | 이코노미스트, 2024 웹소설 산업 현황 실태조사 보도(2025-04-16) https://economist.co.kr/article/view/ecn202504160028 | [2차] |
| S2 | 뉴스서울, 문체부 2022 웹소설 실태조사 보도(2023-09-07) https://newsseoul.co.kr/news/view/1065580809716098 | [2차] |
| S3 | 위픽레터 2023-09-12(2022 실태조사 플랫폼 매출 인용) https://letter.wepick.kr/post/3776 | [2차] |
| S4 | 네이버 시리즈 소설 카테고리·주간 TOP100 https://series.naver.com/novel/categoryProductList.series , https://series.naver.com/novel/top100List.series?rankingTypeCode=WEEKLY&categoryCode=ALL | [1차] |
| S5 | 네이버 웹소설 장르·베스트 https://novel.naver.com/webnovel/genre?genre=101 , https://novel.naver.com/best/genre?genre=101 | [1차] |
| S6 | 카카오페이지 웹소설 메뉴(검색 색인 요약) https://page.kakao.com/menu/10011/screen/76 | [2차] |
| S7 | 문피아 홈 메타·공개 JS 번들(검색 필터 장르 정의) https://www.munpia.com/ | [1차] |
| S8 | 리디 전체 카테고리 https://ridibooks.com/category/list | [1차] |
| S9 | 노벨피아 PLUS https://novelpia.com/plus | [1차] |
| S10 | 조아라 홈·공개 JS 번들 https://www.joara.com/ | [1차] |
| S11 | 이투데이(다음뉴스), 2026 지상최대 웹소설 공모전 수상작 발표(2026-07-22) https://v.daum.net/v/20260722103305369 | [2차] |
| S12 | JC미디어 웹소설 공모전(현대판타지) https://www.theteams.kr/activities/page/338997/lc | [2차] |
| S13 | STUDIO JHS 2026 무협·선협 공모전 https://thinkyou.co.kr/contest/60950/ | [2차] |
| S14 | StoryBench, 장르별 트렌드 분석 2026(2026-01-25) https://storybench.kr/blog/2026-%EC%9B%B9%EC%86%8C%EC%84%A4-%EC%9E%A5%EB%A5%B4-%ED%8A%B8%EB%A0%8C%EB%93%9C | [2차] |
| S15 | NovelPick 통계 https://www.nvlpick.com/stats | [2차] |
| S16 | 경향신문, 회귀물 분석(2022-02-06) https://www.khan.co.kr/article/202202060923001 | [2차] |
| S17 | Wattpad 분류 개편 공지(2026-04-16) https://www.wattpad.com/1622584296-news-updates-stories-don%27t-fit-into-one-box-so-we | [1차] |
| S18 | Wattpad Creators, Categorizing your story https://creators.wattpad.com/writing-resources/get-started-on-wattpad/categorizing-your-story-on-wattpad/ | [1차] |
| S19 | WebNovel 앱스토어 소개 https://apps.apple.com/app/1234939196 | [1차] |
| S20 | Progression fantasy(위키백과) https://en.wikipedia.org/wiki/Progression_fantasy | [2차] |
| S21 | Ream Stories 발견 시스템 가이드(장르 정의) https://help.reamstories.com/article/26-a-guide-to-reams-discovery-system | [2차] |
