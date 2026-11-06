# Obsidian을 온톨로지 저장·편집 수단으로 쓰는 방안 검토

- 작성일·확인일: 2026-10-27 (아래 출처는 별도 표기가 없으면 모두 이 날짜에 확인)
- 근거 요구: FR-ONT-01~19, FR-NOV-05, FR-HIL-01c(`co_writing`), NFR-PERF-04, NFR-REL-04, NFR-EXT-01, D-2, D-27, R-18
- 등급: [1차] 공식 문서·공식 GitHub·라이선스 페이지, [2차] 제3자, [추론] 문서에 근거한 판단, [미확인] 확인 못 함
- 참고: Graph DB 엔진 비교는 같은 폴더의 `research-graphdb.md`(1순위 PostgreSQL + 사실 테이블). 이 문서는 그 비교를 반복하지 않습니다.

## 1. 결론

| 질문 | 답 |
|---|---|
| Obsidian만으로 온톨로지 원본(source of truth)이 될 수 있나 | **아니요.** FR-ONT-12~18의 핵심(불변 ID 참조, 같은 표기·다른 대상, 이름의 시점·인물 범위, 관계 스키마 강제, bitemporal 질의, 원자적 병합·되돌리기)은 "파일 = 노트 = 이름" 모델로는 강제할 수 없습니다. 형식을 YAML로 흉내 낼 수는 있지만 검증·질의·트랜잭션은 결국 별도 코드가 맡게 되고, 그러면 그 코드가 사실상 DB입니다. |
| 그럼 Obsidian은 쓸모없나 | **아니요. 사람용 설정집 뷰·내보내기 대상·가져오기 원천으로는 잘 맞습니다.** 작가가 이미 쓰는 도구이고, 라이선스상 상업 이용도 무료입니다. |
| 권장 구조 | 원본은 DB(`research-graphdb.md` 1순위안). Obsidian vault는 **단방향 내보내기(DB → vault)** + **제한된 역반영**(정해진 YAML 필드만, `candidate`로 들어와 승인 후 캐논). 본문 자유 텍스트는 역반영하지 않고 FR-NOV-05 가져오기 경로(사실 후보 추출)로만 받습니다. |
| Neptune Docker와의 관계 | Obsidian은 Graph DB의 대체재가 아니라 Graph DB 위의 **보기·편집 표면**입니다. 엔진 선택(Neptune 여부)과 독립적으로 붙일 수 있습니다. |

## 2. Obsidian 기본 사실

| 항목 | 내용 | 출처 |
|---|---|---|
| 저장 구조 | 로컬 폴더(vault)의 Markdown 파일. 노트 상단 YAML 프론트매터가 속성(Properties). 위키링크 `[[노트]]`가 기본 링크 형식이고, 링크 대상은 **파일 이름(또는 vault 루트 기준 경로)**. [1차] | https://obsidian.md/help/links , https://obsidian.md/help/properties |
| 속성 타입 | Text, List, Number, Checkbox, Date, Date & time, Tags. 같은 이름의 속성은 vault 전체에서 같은 타입. **중첩 속성은 지원하지 않음**(소스 모드로만 보임). List 속성에 `"[[링크]]"`를 넣을 수 있음. [1차] | https://obsidian.md/help/properties |
| 별칭 | 기본 속성 `aliases`(List). 링크 제안에 별칭이 나오고 `[[원본|별칭]]` 형태로 삽입. 백링크 패널에서 별칭의 "연결 안 된 언급"을 보여줌. 두 노트가 같은 별칭을 가질 때의 처리는 문서에 없음. [1차] / [미확인] | https://obsidian.md/help/aliases |
| 이름 변경 | "Obsidian can automatically update internal links in your vault when you rename a file." 설정 `Files and links → Automatically update internal links`. **앱 안에서 바꿀 때만** 링크를 갱신하며, 외부 프로세스가 파일을 바꾸면 갱신이 일어나는지는 문서에 없음. [1차] / [미확인] | https://obsidian.md/help/links |
| 그래프 뷰 | 노트·링크를 시각화. 링크에는 **유형이 없음**(관계 유형은 속성 이름으로만 흉내). [1차 기능, 추론] | https://obsidian.md/help/links |
| 라이선스 | "Obsidian is free for all purposes, including personal, commercial, and non-profit use." 상업 라이선스는 **선택**(후원 성격). 페이지 최종 갱신 2025-02-20. 회사 업무 사용에 유료 라이선스가 필요하다는 2026년 정책 변경은 공식 페이지에서 확인되지 않음. 앱 자체는 오픈소스가 아님(독점 소프트웨어). [1차] / 소스 비공개는 [추론: 공개 저장소는 releases·API 정의뿐] | https://obsidian.md/license |
| 최신 버전 | v1.14.5 (2026-10-22). [1차] | https://github.com/obsidianmd/obsidian-releases/releases |
| 공식 CLI | 있음. 1.12 설치본 필요, 1.12.7 이상 권장. 설정 → General → "Command line interface" 켜기. 노트 읽기·생성·append·이동·이름 변경·삭제, 속성 set/read/remove, 검색, Bases 질의(JSON/CSV 등 출력), JS eval. **"Obsidian CLI requires the Obsidian app to be running"**(첫 명령이 앱을 띄움). 즉 헤드리스 서버용이 아님. [1차] | https://obsidian.md/help/cli |
| Bases(공식 코어 플러그인) | "database-like views of your notes". 행 = 파일, 열 = 속성. 필터·수식·정렬·그룹, Table/List/Cards/Kanban/Map 뷰. `.base` 파일은 YAML. 링크 함수: `file.links`, `file.backlinks`(성능 부담 경고), `file.hasLink()`, `link()`, `link.asFile()`, `linksTo()`, `file.properties`. **조인·집계 질의·시점 범위 질의 같은 관계형 기능은 문서에 없음.** 공개 버전 1.9.10(2025-08-18) 변경 기록에서 소개. 행 수·성능 한도는 문서에 없음. [1차] / 한도 [미확인] | https://obsidian.md/help/bases , https://obsidian.md/help/bases/syntax , https://obsidian.md/help/bases/functions , https://obsidian.md/changelog/2025-08-18-desktop-v1.9.10/ |
| Dataview(커뮤니티) | MIT, 별 9.4k. 최신 릴리스 0.5.70(2025-04-07), 마지막 push 2025-11-17. 1년 넘게 릴리스가 없어 의존 대상으로는 위험. [1차] | https://github.com/blacksmithgu/obsidian-dataview |
| Local REST API(커뮤니티) | MIT, 별 3.1k, 최신 5.5.2(2026-10-17). `https://127.0.0.1:27124` + Bearer 키. `/vault/{path}` GET/PUT/PATCH/POST/DELETE(PATCH로 헤딩·블록·프론트매터 필드 단위 수정), `/search/`(JsonLogic), `/events/`, 내장 MCP 서버. **앱이 켜져 있어야 동작.** 공식 제품 아님. [1차] | https://github.com/coddingtonbear/obsidian-local-rest-api |
| 동시 편집·충돌 | Obsidian Sync: Markdown은 diff-match-patch로 자동 병합("can create duplicate text or formatting problems"), 그 외 파일은 last-modified-wins, 1.9.7부터 "Create conflict file" 선택 가능. 다른 동기화 서비스와 겹쳐 쓰지 말라고 권고. 외부 프로세스가 같은 파일을 쓰는 경우의 보장은 문서에 없음. [1차] / [미확인] | https://obsidian.md/help/sync/troubleshoot |

## 3. FR-ONT 요구별 판정 (Obsidian만으로)

범례: ○ 기본 기능으로 충족, △ 관례·플러그인·외부 코드로 흉내(강제 불가), × 불가

| 요구 | 판정 | 이유 |
|---|---|---|
| 불변 ID (FR-ONT-12) | △ | 링크 대상이 파일 이름이라 대표명 변경 = 파일 이름 변경. 앱 안에서는 링크 자동 갱신이 되지만 외부 에이전트가 바꾸면 보장 없음[미확인]. 대안은 파일 이름을 ID(`ent_01J...md`)로 두고 대표명은 `title`·`aliases`로 두는 것인데, 그러면 사람이 링크를 손으로 쓰기 어려워 Obsidian의 장점이 줄어듭니다. 원고·사실이 ID만 참조하도록 강제하는 장치는 없음. |
| 같은 표기·다른 대상 (FR-ONT-13, 동명이인) | × ~ △ | 같은 폴더에 같은 파일 이름 불가. 폴더를 나누면 링크가 경로를 포함해야 하고, 같은 별칭을 두 노트가 가질 때 해석 규칙은 문서에 없음[미확인]. 링크를 걸 때 문맥 판별이 없어 R-18 위험을 그대로 가짐. |
| 이름의 유효 시점·시간선·아는 인물 범위 (FR-ONT-13·17) | × | `aliases`는 문자열 목록일 뿐이고 중첩 속성이 없어 이름마다 `{유형, 화 범위, 시간선, 아는 인물}`을 붙일 수 없음. 이름별 노트를 따로 만들면 표현은 되지만 "N화·시간선 T에서 표기 X의 후보" 질의는 Bases로 불가(범위 겹침·조인 없음). |
| 언급 연결과 신뢰도 (FR-ONT-14) | × | 위키링크는 확정 링크뿐. 원문 위치·신뢰도·상태(`ambiguous` 등)를 가진 언급 레코드를 본문 링크로 표현할 수 없음. 화당 수백 건이면 별도 노트로 두는 것도 비현실적[추론]. |
| 신규·중복 엔티티 확인 (FR-ONT-15) | × | 유사 엔티티 탐지·확인 흐름 없음. 백링크의 "unlinked mentions"는 문자열 일치뿐. |
| 병합·분리 이력과 되돌리기 (FR-ONT-16) | × | 병합 = 여러 파일 링크 일괄 치환. 원자적 처리·이력·옛 ID 리다이렉트·되돌리기가 없음. Git으로 vault를 버전 관리하면 파일 단위 되돌리기는 되지만 "이 병합만 되돌리기"는 안 됨[추론]. |
| 관계 유형 통제·정의역/치역·개수·시간 제약 (FR-ONT-18) | × | 속성 이름은 아무나 새로 만들 수 있고, 타입은 7종 원시 타입뿐. 링크 대상의 엔티티 유형, 개수(생부 1명), 시간 제약(사망 후 관계 불가) 검증 기능 없음. 외부 검증기를 따로 짜야 함. |
| bitemporal 사실 질의 "N화 시점, 시간선 T의 캐논" (FR-ONT-02·09) | × | 사실을 노트 하나씩으로 두고 `valid_from`·`valid_to`·`timeline` 속성을 주면 Bases 필터로 단순 조회는 가능[추론]. 그러나 기록 시간(버전) 축, 상태 전이(`candidate`→`approved`→`published_locked`), 출처 필수 규칙을 강제할 수 없음. |
| 인물 지식 (FR-ONT-03) | × | "누가 언제 무엇을 (잘못) 아는가"는 인물×사실×시점 3항 관계. 노트·링크 모델로는 3항 관계와 시점 범위를 함께 질의할 수 없음. |
| 공개 잠금 (FR-ONT-07) | × | 파일 잠금·쓰기 차단 기능 없음. 누구든(사람·플러그인·외부 프로세스) 수정 가능. |
| 성능 (엔티티 수천·사실 수만, NFR-PERF-04) | △ | 사실을 노트로 두면 파일 수만 개. Bases·Dataview 한도는 문서에 없음[미확인]. `file.backlinks`는 공식 문서가 무겁다고 경고. 컨텍스트 구성은 어차피 에이전트 쪽 코드가 하므로 Obsidian 질의를 경로에 넣을 이유가 없음[추론]. |
| 트랜잭션·원자성 | × | 파일 단위 쓰기. 여러 파일에 걸친 변경(병합, 사실+언급+이력)을 한 번에 커밋·롤백할 수단 없음. 쓰기 도중 크래시 시 부분 반영 가능[추론]. |
| 에이전트의 프로그램적 쓰기 | △ | 파일 직접 쓰기(앱 없이 가능, 링크 갱신·인덱스 보장 없음), 공식 CLI·Local REST API(**앱 실행 필요**). 자체 호스팅 서버(D-2 확장)에서 GUI 앱을 띄워야 하는 구조는 부적합. |
| 백업 (NFR-REL-04) | ○ | 폴더 복사·Git으로 단순. 단 이 장점은 DB 쪽에서도 `pg_dump`·파일 복사로 얻을 수 있음. |
| 사람이 읽고 고치기 (FR-ONT-08·09 일부) | ○ | Obsidian의 강점. 그래프 뷰·백링크·Bases 표·Canvas로 설정집 탐색이 쉬움. |

요약: P0 요구 중 Obsidian만으로 강제할 수 있는 것은 거의 없습니다. 형식을 YAML 관례로 정하고 외부 검증기·인덱서·트랜잭션 관리자를 짜면 흉내 낼 수 있지만, 그 외부 코드가 결국 DB 역할을 하고 저장 매체만 불리한 파일 묶음이 됩니다[추론].

## 4. Obsidian이 잘 맞는 역할

| 역할 | 요구 | 방식 |
|---|---|---|
| 사람용 설정집 뷰 | FR-ONT-08(보조), FR-ONT-11 | DB의 `approved`·`published_locked` 사실을 작품별 vault로 렌더링. 엔티티 노트 1개 = 대표명 파일 + 프론트매터 `entity_id`(불변), `type`, `aliases`(현재 시점 기준 이름들), 관계 속성(위키링크 목록). 본문은 생성된 요약·사실 표·등장 화. 인물 관계도는 그래프 뷰, 목록은 함께 내보낸 `.base` 파일로 제공. |
| 내보내기 대상 | FR-ONT-11 | "Obsidian vault(Markdown + YAML)"를 내보내기 형식 하나로 둠. 구조화 데이터(JSON-LD 등)와 별개. |
| 가져오기 원천 | FR-NOV-05, FR-HIL-01c(`co_writing`) | 작가의 기존 vault를 읽어 노트 이름·`aliases`·프론트매터·위키링크를 **엔티티·이름·관계 후보**로, 본문을 **사실 후보 추출 입력**으로 씀. 모두 `candidate`로 들어오고 승인 후 캐논(FR-NOV-05 수용 기준과 동일). 위키링크는 "작가가 이미 확정한 언급"이라 언급 연결의 신뢰도 근거로 쓸 수 있음[추론]. |
| 작가 메모 공간 | — | DB가 관리하지 않는 자유 메모 폴더(예: `_notes/`)를 vault 안에 둬서 작가가 자유롭게 씀. 내보내기는 이 폴더를 건드리지 않음. |

## 5. 양방향 동기화의 위험과 권장 방향

| 위험 | 내용 |
|---|---|
| 동시 수정 충돌 | 에이전트가 DB를 갱신해 vault를 다시 쓰는 사이 사람이 같은 노트를 편집하면 어느 쪽이 이기는지 정해야 함. 파일 감시는 이벤트 누락·중복이 있고, 앱의 미저장 버퍼·Obsidian Sync 자동 병합(diff-match-patch, 중복 텍스트 위험)까지 겹치면 결과를 예측하기 어려움. [1차: Sync 동작 / 추론: 조합 시 위험] |
| 자유 텍스트 파싱 오류 | 사람이 본문에 쓴 문장을 사실로 역파싱하면 추출 오류가 곧바로 캐논을 오염시킴. FR-ONT-05·14의 신뢰도·질문 흐름을 우회하게 됨. |
| 이름 변경 = ID 변경 착시 | 사람이 파일 이름을 바꾸면 Obsidian은 링크를 갱신하지만 DB 쪽에는 "새 파일"로 보일 수 있음. 프론트매터 `entity_id`가 없으면 새 엔티티로 오인(R-18 그대로 재현). |
| 스키마 우회 | 사람이 새 속성 이름(`수하`, `휘하`)을 만들면 FR-ONT-18 통제 어휘를 벗어남. |
| 잠금 우회 | vault에서 `published_locked` 사실을 고칠 수 있음. 역반영 시 막아야 함. |

권장(가정: 설계 초안):

1. **원본은 DB, vault는 파생물.** 내보내기는 멱등(같은 DB 상태 → 같은 파일)으로 만들고 생성 파일에 `generated: true`, `entity_id`, `export_revision`을 넣음.
2. **역반영은 화이트리스트 필드만.** 예: 대표명 변경, 별칭 추가, 통제 어휘 안의 관계 속성 추가·삭제, 사람 메모 필드. 각 변경은 `candidate` 사실(출처 = "vault 편집", FR-ONT-02)로 들어와 기존 승인 게이트를 탐. 스키마 밖 속성·`published_locked`에 닿는 변경은 거부하고 질문으로 돌림.
3. **본문 자유 텍스트는 역반영하지 않음.** 바꾸고 싶으면 FR-NOV-05 가져오기(사실 후보 추출)로 명시적으로 실행.
4. **충돌 판정은 `export_revision` 비교.** vault 파일의 리비전이 DB 최신보다 오래되면 덮어쓰지 않고 충돌 보고.
5. **실시간 감시보다 수동 "동기화" 버튼 또는 앱 종료 시점 배치**로 시작. 파일 감시 기반 실시간 양방향은 v1 이후 필요가 확인되면 검토.
6. 연동 방식은 **파일 직접 읽기·쓰기**를 기본으로(앱 실행 불필요, 자체 호스팅에서도 동작). Obsidian CLI·Local REST API는 앱이 켜져 있어야 하므로 선택적 편의 기능으로만.
7. 어댑터 위치: NFR-EXT-01의 Graph DB 어댑터와 별개인 **내보내기/가져오기 어댑터**(`ObsidianVaultExporter`, `ObsidianVaultImporter`)로 둠.

## 6. 미확인 항목

- 외부 프로세스가 파일 이름을 바꿀 때 Obsidian이 링크를 갱신하는지, 앱이 꺼진 동안 바뀐 파일을 다시 열 때 어떻게 처리하는지.
- 같은 별칭을 가진 노트가 둘일 때 링크 해석 규칙.
- Bases·Dataview의 행 수·성능 한도(파일 수만 개).
- Obsidian 약관(Terms of Service) 2026년 개정 여부. 라이선스 페이지(2025-02-20 갱신)에는 상업 이용 무료로 명시됨.
- Bases가 처음 들어간 버전(얼리 액세스 포함). 확인한 것은 공개판 1.9.10 변경 기록의 소개 문구.
