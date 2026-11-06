# 인수인계: novel-create-studio (2026-10-28 갱신)

이전 세션(rea 저장소)에서 PRD·목업을, 이어받은 세션에서 PRD v0.3과 상세 설계를 작성했습니다. 2026-10-28에 사용자 요구 A(컨셉 에이전트)·B(카테고리별 세계관 템플릿 계획서)를 반영해 PRD v0.4 초안, 설계 11, 계획서를 더했습니다. 이 프로젝트는 아직 **설계 단계이고 코드는 없습니다.** git 저장소도 아닙니다.

## 1. 제품 요구 (사용자 원문 요지)
1. AI 에이전트들이 자율적으로 동작해 정해진 목표의 웹소설을 만든다.
2. 필요한 질문은 연결된 메신저(Discord, Telegram 등)로 보내고, 사용자 답변을 받아 반영해서 계속 동작한다.
3. Graph DB로 작품별 세계관 온톨로지를 만들어 세계관 일관성과 떡밥(복선) 설치·회수에 쓴다.
4. 확장: 완성된 웹소설의 각 화를 씬 단위로 나눠 이미지·영상 프롬프트를 추출하고, 이미지와 영상으로 생성하는 플로우.
5. 아키텍처는 오픈소스 Paperclip(paperclipai/paperclip, MIT, AI 에이전트 회사 오케스트레이션)의 패턴을 참고한다. 포크가 아니라 새 코드베이스(사용자 선택: "아키텍처만 참고").
6. (요구 A, 2026-10-28) 소설의 컨셉을 처음 잡을 때 대화로 컨셉을 잡도록 돕는 에이전트가 기본으로 있어야 한다.
7. (요구 B, 2026-10-28) 웹소설 시장을 조사해 카테고리 단위로 세계관에 필요한 정보의 데이터 템플릿을 구축하는 계획서를 쓴다.

## 2. 산출물
| 파일 | 내용 |
|---|---|
| `docs/PRD.md` | PRD **v0.4 초안**(FR 148 + NFR 32). D-1~D-28 확정(D-8·12·19·23은 확정(방침), D-28은 확정(사용자 요구)), D-29~D-39 미정. v0.4에서 `concept_partner`(4.1), 용어 `ConceptSession`·`ConceptBrief`·`GenreTemplate`, 5.1·5.2 컨셉 흐름, FR-NOV-07~11, 컨셉 KPI, FR-NOV-03 계획서 링크·릴리스 조정 제안 추가 |
| `docs/PRD.html` | PRD + 화면 목업 10개 단일 HTML (v0.4 초안으로 재생성, `missingFrLinks` 0). 컨셉 화면 목업은 아직 없음 |
| `docs/PRD.v0.3.md`, `docs/PRD.v0.2.md`, `docs/PRD.v0.1.md` | 이전 판(참고용) |
| `docs/design/00~10-*.md` | **상세 설계 v0.1~0.3**. 00이 이름·enum·기본값 단일 출처, 03이 상태 전이, 06이 온톨로지·엔티티 식별, 01이 FR/NFR 추적 매트릭스와 PRD 수정 제안(6절 P-01~P-10, 6.1 컨셉·템플릿 제안 상태). 2026-10-28에 00·01·03·04·05·06·07·09를 11·계획서와 연동 |
| `docs/design/11-concept-development.md` | **컨셉 개발 v0.1**: 기본 탑재 `concept_partner`, 대화 단계·턴 규칙·상한, 웹 + 메신저 이어 하기와 `Question` 경계, `ConceptSession`·`ConceptMessage`·`ConceptBrief` 상태 기계, 매핑 M-01~M-21, 품질·안전, KPI K-C1~K-C11, 미결 O-C1~O-C16 |
| `docs/plans/genre-world-templates-plan.md` | **카테고리별 세계관 데이터 템플릿 구축 계획서**(초안): 카테고리 3층(L1 장르·L2 하위 장르·L3 트로프) + 패싯, `GenreTemplate` 데이터 모델·합성 규칙·빌드 검증 TV-01~TV-12, 구축 절차, 검증, 일정, 결정 후보 DG-01~DG-09(= PRD D-29~D-37) |
| `docs/research/` | 설계 근거 조사: Graph DB 후보, 엔티티 식별 기법, Paperclip 소스(커밋 0cb3fc7), Neptune, Obsidian, 저장소 추천안(`graph-store-recommendation.md`). 2026-10-28 추가: `research-concept-agent.md`(컨셉 대화 에이전트), `research-webnovel-market.md`(시장·플랫폼 분류), `research-genre-world-elements.md`(카테고리별 세계관 항목, `base@2` 후보 B-1~B-11) |
| `docs/mockups-src/` | 목업 원본: `base.css`, `SPEC.md`, `screens/*.html`, `tools/assemble-prd.mjs` |
| `/Users/snowfall/orca/docs/paperclip-architecture-map.md` (+ `.html`) | Paperclip 아키텍처 분석 보고서 |

### PRD.html 다시 만들기
```bash
cd /Users/snowfall/orca/projects/novel-create-studio/docs
npx -y marked@12.0.2 --gfm -i PRD.md -o <임시 폴더>/prd-body.html
node mockups-src/tools/assemble-prd.mjs mockups-src <임시 폴더>/prd-body.html PRD.html
```
조립 스크립트는 `<buildDir>/base.css`와 `<buildDir>/screens/*.html`을 읽습니다. 출력 JSON의 `missingFrLinks`가 비어 있어야 모든 FR 배지가 PRD 행으로 연결된 것입니다.
검증 팁: 헤드리스 Chrome은 창 너비가 최소 500px라서 `--window-size=390,...`은 실제로 500px로 렌더링됩니다. 390px 확인은 390px 폭 iframe에 페이지를 넣어 캡처하세요.

## 3. PRD 핵심 요약
- 릴리스: **MVP-α**(Telegram 1:1, 핵심 집필 루프) → **MVP-β**(Discord 스레드, 다중 시간선, 장르 2개 × 30화 검증) → **v1**(씬 프롬프트·씬 이미지·삽화, 관계도) → **v2**(씬 영상·트레일러).
- 핵심 개념: `Novel`(테넌트 루트) · `ConceptSession`/`ConceptBrief`(컨셉 대화·승인 요약) · `GenreTemplate`(카테고리별 세계관 데이터 묶음) · `Goal` · `SeriesBible` · `Arc`/`Episode`/`Scene`/`Shot` · `Task`/`Run` · `Question`(`blocking`/`non_blocking`/`informational`) · `AnswerReflection` · `Channel` · `Approval` · `AutonomyLevel`(`episode_approval` 기본/`arc_approval`/`full_auto`, `co_writing`은 v1) · `WorldOntology`/`Fact`(`candidate`/`approved`/`published_locked`) · `Setup`/`Payoff`(서사 상태 `planned → planted → reinforced → paid_off`/`abandoned`) · `ContinuityIssue` · `ScenePromptIR` · `MediaAsset` · `VisualReference`.
- 에이전트 역할: `concept_partner`(기본 탑재, 컨셉 대화), `showrunner`, `planner`, `world_keeper`, `writer`, `continuity_editor`, `foreshadow_manager`, `line_editor`, [확장] `scene_director`, `visual_producer`.
- 원칙: 차단형 질문은 마감이 지나도 자동 결정하지 않음(fail-closed). 서술형 답변은 해석 확인 후에만 캐논이 됨. 공개된 사실(`published_locked`) 변경은 리트콘 승인 필요. 미디어는 이미지 우선(키프레임 채택 → I2V).
- 화 상태(FR-AGT-12): `planned` → `outlining` → `drafting` → `checking` → `polishing` → `awaiting_approval` → `approved` → `published`, 반려 시 `revising`. `blocked`/`paused`는 상태가 아니라 표시.

## 4. 현재 상태와 다음 단계 (2026-10-28 갱신)
- 설계 문서 00~10 작성, 리뷰 4종(추적성·일관성·엔티티 식별 적대 검토·실현 가능성) 91건 반영, 교차 후속 92건 반영, 최종 일관성 점검 완료. MVP-α·β 미충족은 2건(01 5절 F-13 FR-MSG-05, F-17 NFR-SAFE-02).
- **2026-10-28 사용자 결정 확정(추천안 일괄 채택)** → PRD v0.5(백업 `PRD.v0.4.1.md`), PRD.html 재생성.
  - D-8 저장소: PostgreSQL 사실 테이블 + `OntologyRepository`(ADR-005 사용자 확인). AGE는 v1 미포함, 그래프 부하 재검토 조건 (1)·(2) 때만 확장 1. Neptune 미채택.
  - Obsidian: 원본 아님. v1에 단방향 설정집 내보내기 + 화이트리스트 가져오기(FR-ONT-20, P1).
  - FR-MSG-05: `local_trusted` 요약 승인 허용, 전문 첨부 옵트인(NFR-SEC-04 예외). F-13 해소.
  - NFR-SAFE-02: 이름 목록은 설치 데이터·릴리스 갱신·목록 일치 표시는 끌 수 없음(방침). 초기 데이터 출처 조사는 남음(F-17).
  - D-29~D-40 확정: 검증 장르 무협 + 현판 헌터 회귀(D-29, 50편 수동 라벨 후 재검토 조건부), FR-NOV-03 → 03b(MVP-β)·03c(v1) 분할 + MB-0 신설(MVP-β 13~17주), 키 체계 3층+패싯, `base@2` MVP-β 7 + v1 4, 실존 인물 방침 A(기준 연도는 D-12와 함께, 그때까지 해당 템플릿 배포 보류, `alt_history`·`professional`은 v1 2차), 수위 태그·BL MVP 미노출, 책빙의는 가상 원작만(실제 출간작은 승인 차단, INV-CON-15), 템플릿 고정 + 선택 업그레이드, 검수자 장르당 1인(MA-6 섭외), FR-SET-01은 컨셉 승인 후 30분, `novel_status=concept` 별도 상태, 복제 요청 예외 없이 차단.
  - 11 O-C1·C2·C5·C6·C7·C8·C13, 06 O-19(방침), 01 P-01~P-10·PT-01~06 반영.
- 다음: 09 스파이크 S-1~S-10부터 MVP-α 착수. 그 전에 남은 설계 연동(아래)과 50편 수동 라벨 비교.
- 남은 설계 미결: 각 문서 끝 "미결 사항", 01 7절. 2026-10-28 연동에서 00·01·03·04·05·06·07·09 머리 버전을 올렸고, 02·08·10은 그대로입니다(02 컨셉 턴 즉시 깨우기 U-22, 08 9절 `concept` 화면·`modules/concept`는 아직 미반영, 11 10절).
- (해소됨) 문서 간 확인: 계획서 3.4(j) `concept_questions`의 `phase` 값(`category`/`core`/`world_min`/…)과 11 3.6 `ConceptQuestionDef`의 `stage`(`diverging`/`converging`)·필드 이름(`required` vs `required_level`, `choices` vs `option_seeds`)이 다릅니다. 계획서 8.2 11행은 문서 이름을 `11-concept-partner.md`로 가정했습니다(실제 `11-concept-development.md`).

## 5. Paperclip 참고 요점
- 그대로 가져올 만한 범용 인프라: DB 런타임·마이그레이션 도구, config 로딩·`HttpError`, 사람/에이전트 주체 RBAC, `activity_log` + post-commit publish + realtime, plugin host(worker 프로세스, JSON-RPC, 스키마 단위 DB 격리), storage/secrets registry, CLI 골격(onboard/doctor/run), Docker.
- 패턴만: 테넌트 스코핑, 원자적 checkout(lease), 비용 원장 + 예산 하드 한도, approvals, wake queue와 run 분리, adapter SPI, MCP facade, 목표 계층.
- 따라 하지 말 것: 거대 파일(`heartbeat.ts` 4,143줄, `IssueDetail` 8.7k줄), 평면 `services/`. 새로 시작한다면 `server/src/modules/`의 `adapters → application → domain` 구조.
- 소스는 이전 세션 임시 폴더에 clone했던 것이라 지워졌을 수 있습니다. 필요하면 `git clone --depth 1 https://github.com/paperclipai/paperclip.git`로 다시 받으세요.
- REA로 Paperclip TS 소스를 정적 분석했지만 빌드 전 소스라 모듈 그래프가 비어 있었고(`modules: 0`), 구조 분석은 대부분 소스 정독으로 했습니다.
