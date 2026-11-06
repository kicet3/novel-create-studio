# 온톨로지 저장소 추천안 (Neptune·대안·Obsidian)

- 작성일·확인일: 2026-10-27
- 기준 문서: PRD v0.3 6.5절(FR-ONT-01~19), 7절(NFR-PERF-04, NFR-REL-04·05, NFR-EXT-01·04a), 11절(Graph DB 행), D-2, D-8
- 근거 문서(같은 폴더): `research-neptune.md`, `research-obsidian.md`, `research-graphdb.md`. 검증 단계에서 틀린 것으로 판정된 주장은 고쳐 반영했습니다(6.2절).
- 등급: [1차] 공식 문서·저장소·레지스트리·라이선스, [2차] 제3자, [추론] 근거에서 이끈 판단, [미확인] 확인 못 함

## 1. 결론

| # | 결론 |
|---|---|
| 1 | **Neptune을 Docker로 띄우는 방안은 채택하지 않습니다.** AWS는 Neptune 엔진의 로컬/Docker 배포판을 내지 않습니다[1차]. 대체 수단인 LocalStack(유료, 영속성 없음)과 Gremlin Server(인메모리, `close()` 때만 파일 기록)는 사용자 PC에서 원본 저장소로 쓸 수 없습니다. |
| 2 | **1순위는 PostgreSQL 사실 테이블입니다.** 로컬에서는 `embedded-postgres`로, 자체 호스팅에서는 외부 PG(Docker 가능)로 같은 스키마를 씁니다. 그래프는 저장 엔진이 아니라 질의 계층(조인·재귀 CTE)으로 표현합니다. **2순위**는 다단계 탐색이 병목이 될 때 붙이는 LadybugDB 파생 읽기 모델이고, 설치 크기를 최우선으로 둘 때는 SQLite를 씁니다. |
| 3 | **Obsidian만으로는 부족합니다.** P0 FR-ONT 요구를 강제할 수 없기 때문입니다. 원본은 DB에 두고, Obsidian은 사람용 설정집 뷰·내보내기 대상·가져오기 원천으로 씁니다. 역반영은 화이트리스트 필드만 `candidate`로 받습니다. |

핵심 이유: R-18 대응(FR-ONT-12~18)은 그래프 탐색 성능보다 **불변 ID, 시간 범위, 개수 제약, 병합 이력, 트랜잭션 일관성**의 문제입니다. 이 제약을 DB가 직접 강제할 수 있는 후보는 PG(범위 타입 + `btree_gist` `EXCLUDE` 제약)뿐입니다[추론].

## 2. 비교표

범례: ○ 충족, △ 조건부, × 불충족

| 기준 | Neptune (로컬 대체: LocalStack / Gremlin Server) | **1순위: PostgreSQL 사실 테이블** (`embedded-postgres` → 외부 PG) | 2순위: LadybugDB (파생 읽기 모델) | Obsidian 단독 |
|---|---|---|---|---|
| 로컬·오프라인 | × Neptune은 클라우드 전용이고, 기본 VPC 내부에서만 접속됩니다. Public Endpoint를 쓰면 IAM(SigV4) 인증이 필수입니다. 로컬 대체 수단은 △입니다 | ○ 자식 프로세스로 PG를 실행합니다 | ○ 프로세스 안에서 동작합니다 | ○ 로컬 폴더에 저장합니다 |
| 설치 부담 | 높음. Docker(또는 JVM)가 필요하고, LocalStack은 라이선스가 있어야 합니다 | 중간. 바이너리를 내려받고 포트·프로세스 수명주기를 관리합니다(Paperclip 코드 차용 가능) | 낮음. 다만 vector·fts 확장은 런타임에 내려받습니다 | 낮음. 단, 사용자가 앱을 직접 설치해야 합니다 |
| 질의어 | Gremlin·openCypher·SPARQL. Gremlin Server에는 openCypher가 없습니다(플러그인 유지보수 중단) | SQL과 재귀 CTE. 필요하면 AGE로 openCypher를 추가합니다 | Cypher | 없음(Bases 필터·수식만 있고 조인이 없습니다) |
| 스키마·제약 검증(FR-ONT-18) | × DB가 강제하는 공식 기능을 찾지 못했습니다[미확인]. 앱 계층에서 구현해야 합니다 | ○ FK, CHECK, 부분 유니크, `EXCLUDE`(시간 범위가 겹치면 거부). 나머지 규칙은 앱 검증기가 맡습니다 | △ 정의역·치역은 스키마로 지정할 수 있지만 범위 겹침·개수 제약은 앱이 맡습니다 | × 속성 이름을 자유롭게 만들 수 있고 원시 타입 7종뿐입니다 |
| bitemporal(FR-ONT-02·09) | △ 사실 노드와 속성으로 모델링해야 하고 전용 기능은 없습니다 | ○ `int4range`(작중 시점)와 `tstzrange` 또는 이력 테이블(기록 시점)을 둡니다 | △ `valid_from`·`valid_to` 속성과 WHERE 조건으로 처리합니다 | × 기록 시점 축과 상태 전이를 강제할 수 없습니다 |
| 백업(NFR-REL-04) | △ PITR(1~35일)이 자동입니다. 스냅샷은 Neptune(·Analytics)으로만 복원되고, 이식 가능한 파일 형식은 없습니다[추론]. 로컬 대체 수단은 영속성이 없거나 덤프 방식입니다 | ○ `pg_dump`로 실행 중에 일관 스냅샷을 뜹니다. 바이너리 동봉 여부는 [미확인]입니다 | △ 닫은 상태에서 파일을 복사하거나 `EXPORT DATABASE`를 씁니다 | ○ 폴더 복사나 Git을 씁니다 |
| 비용 | 서울 기준 최소 월 $103.95(t4g.medium) 또는 $141.69(Serverless 1 NCU)이고, Analytics는 월 $424.13입니다. LocalStack Ultimate는 라이선스당 월 $89(연간 결제)입니다 | 인프라 비용 0원입니다(사용자 PC) | 0원입니다 | 0원입니다(상업 이용도 무료) |
| 라이선스 | 상용 관리형 서비스입니다. Gremlin Server는 Apache-2.0입니다 | PostgreSQL License, `embedded-postgres` MIT | MIT | 독점 소프트웨어이며 사용은 무료입니다 |
| 자체 호스팅 확장(D-2) | × 사용자 서버에 올릴 수 없습니다(사용자마다 AWS 계정이 필요합니다) | ○ 외부 PG나 Docker `postgres`를 같은 스키마로 씁니다 | △ READ_WRITE 프로세스를 하나만 열 수 있고, 마이너 버전 사이에 디스크 형식이 바뀝니다 | × GUI 앱이 실행 중이어야 CLI와 REST를 쓸 수 있습니다 |
| 잠금(lock-in) | 높음. 문자열 ID, set cardinality, 미지원 절, OpenSearch 연동, IAM, 스냅샷 형식이 모두 AWS 고유입니다 | 낮음. 표준 SQL을 쓰고 관리형 PG로 옮길 수 있습니다 | 중간. 포크 1년 차입니다 | 낮음. Markdown 파일입니다 |

참고: SQLite(`better-sqlite3`)는 설치 부담이 가장 낮고 `.backup()` 온라인 백업을 지원합니다. 다만 범위 겹침은 트리거로 구현해야 하고, 자체 호스팅에서 PG로 옮길 때 방언 차이 때문에 두 가지를 함께 유지해야 합니다. 그래서 2순위에서 제외했습니다(`research-graphdb.md` 4.3).

## 3. 추천 구성 상세

| 계층 | 구성 | 해당 요구 |
|---|---|---|
| 원본 저장소 | PG 하나에 `entity`, `entity_name`(유형, `valid_episodes int4range`, `timeline_id`, 아는 인물 범위), `relation_type`(통제 어휘), `fact`(유효 범위, 기록 시점, 출처, 상태), `mention`(원문 위치, 표기, 신뢰도, 근거), `entity_redirect`(병합 이력), `character_knowledge`를 둡니다. 모든 행에는 `work_id`가 있습니다 | FR-ONT-01~03, 12~17, NFR-EXT-04a |
| 실행 형태 | 로컬은 `embedded-postgres`(Paperclip `packages/db` 런타임 차용)로 띄우고, 테스트는 PGlite로 돌리고, 자체 호스팅은 `DATABASE_URL`로 지정한 외부 PG를 씁니다. 사용자 PC에 Docker를 요구하지 않습니다 | D-2, NFR-REL-06 |
| 그래프 질의 계층 | `OntologyRepository` 어댑터가 도메인 단위 질의를 제공합니다. 예: "N화·시간선 T에서 유효한 사실", "표기 X의 후보 엔티티(화자 P 기준)", "인물 P가 N화에 아는 것", "1~3홉 이웃". 1~3홉은 조인으로, 가변 깊이는 재귀 CTE로 처리합니다. **Gremlin·Cypher·SQL 문자열은 어댑터 밖으로 노출하지 않습니다** | NFR-EXT-01, NFR-PERF-04 |
| 스키마 검증 위치 | 두 층으로 나눕니다. ① DB가 FK(관계 유형은 통제 어휘), 개수(부분 유니크와 `EXCLUDE`), 칭호 보유자의 시간 범위 배타, 상태 전이 CHECK를 강제합니다. ② 앱의 `OntologyValidator`가 정의역·치역, 대칭·역관계, 시간 제약(사망 이후 관계 등)을 검사하고 위반을 연속성 이슈로 냅니다. 사실 저장, 병합, 사실과 언급, 이력을 묶은 변경은 한 트랜잭션으로 처리합니다 | FR-ONT-06·07·16·18 |
| 확장 1: 그래프 부하 | 다단계 경로나 군집 분석이 p90 10초를 위협하면, PG를 원천으로 두고 변경 이벤트를 LadybugDB(또는 PG 안의 AGE)에 다시 투영합니다. 투영된 쪽은 읽기 전용입니다 | NFR-PERF-04 |
| 확장 2: 관리형 클라우드 | PG 원천을 RDS나 Aurora 같은 관리형 PG로 옮깁니다. 같은 스키마를 쓰므로 어댑터 변경이 거의 없습니다[추론] | D-2(c) |
| 확장 3: Neptune으로 옮길 때 어댑터가 감당하는 범위 | **가능:** 도메인 질의 인터페이스 유지, 엔티티·관계·사실 노드 매핑(문자열 ID), 읽기 질의 번역. **어댑터 밖에서 다시 만들어야 함:** 범위 배타·개수 제약(Neptune은 DB가 강제하지 않으므로 앱 검증기로 이동), 다중 쓰기 트랜잭션(GLV `g.tx()`·세션 사용, 세션 최대 10분, false conflict 재시도), 전문 검색(OpenSearch), 벡터 검색(Analytics, 원자성 없음), 백업·로컬 내보내기 파이프라인. 현실적인 형태는 **원천을 옮기지 않고 Neptune Analytics를 파생 읽기 모델로 붙이는 것**입니다[추론] | NFR-EXT-01 |

PRD 영향: 11절 Graph DB 행의 "세계관 사실·관계·떡밥 연결의 원천은 Graph DB"를 "그래프 데이터 모델(엔티티·관계·사실)을 관계형 저장소에 표현하고 Graph DB는 어댑터 뒤 선택지"로 고쳐야 합니다. D-8 결과로 기록합니다.

채택 전 스파이크(`research-graphdb.md` 6절 요약): `btree_gist`·`pg_trgm`·`pgvector` 로드(S-1), 칭호 범위 배타 제약(S-2), 이름 후보 조회 p90 50ms(S-3), 컨텍스트 p90 10초(S-4), 한글 trigram(S-5), 병합 되돌리기(S-6), `pg_dump` 복원 RTO 1시간(S-7), PG 메이저 업그레이드(S-8), 고아 프로세스 회수(S-9).

## 4. Obsidian 활용안

| 구분 | 내용 |
|---|---|
| 할 것 | ① 작품별 vault로 **설정집 뷰를 내보냅니다**. 엔티티마다 노트를 하나 만들고, 프론트매터에 `entity_id`(불변), `type`, `aliases`, 관계 위키링크, `generated: true`, `export_revision`을 넣습니다. 목록은 `.base` 파일로 함께 제공합니다. ② 작가의 기존 vault를 **가져오기 원천**으로 씁니다. 노트 이름, 별칭, 링크, 프론트매터는 엔티티·이름·관계 후보가 되고, 본문은 사실 후보 추출의 입력이 됩니다. 모두 `candidate`로 들어옵니다. ③ DB가 건드리지 않는 자유 메모 폴더(`_notes/`)를 둡니다 |
| 하지 않을 것 | 원본 저장, 컨텍스트 구성 경로에서 Obsidian 질의, 본문 자유 텍스트 자동 역반영, `published_locked` 사실 수정 수용, 스키마 밖 속성 수용, 앱 실행(CLI·Local REST API)에 의존하는 핵심 기능, Dataview 의존(마지막 릴리스 2025-04-07) |
| 동기화 방향 | 기본은 **DB에서 vault로 가는 단방향이며 멱등**입니다. 역방향은 **화이트리스트 YAML 필드**(대표명, 별칭 추가, 통제 어휘 안의 관계, 메모)만 받고, 출처를 "vault 편집"으로 기록한 `candidate`로 넣어 승인 게이트를 거칩니다. `export_revision`이 DB보다 오래됐으면 덮어쓰지 않고 충돌로 보고합니다. 처음에는 수동 "동기화" 버튼이나 배치로 시작하고, 실시간 파일 감시는 v1 이후에 검토합니다. 연동은 **파일 직접 읽기·쓰기**를 기본으로 합니다(앱 없이 동작하고 자체 호스팅에서도 됩니다). 어댑터는 Graph DB 어댑터와 분리한 `ObsidianVaultExporter`·`ObsidianVaultImporter`로 둡니다 |
| 해당 FR | FR-ONT-08(보조 시각화), FR-ONT-09(제한된 사람 편집 경로), FR-ONT-11(내보내기 형식 하나 추가), FR-NOV-05(가져오기), FR-HIL-01c(`co_writing`) |
| Obsidian만으로 안 되는 이유 | 중첩 속성이 없고 `aliases`가 문자열 목록이라 이름별 시점·인물 범위를 붙일 수 없습니다. 링크 대상이 파일 이름이어서 동명이인과 대표명 변경에 취약합니다. Bases에는 조인·범위 질의가 없습니다. 트랜잭션, 잠금, 스키마 강제가 없습니다. Sync 병합은 텍스트를 중복시킬 수 있습니다[1차 종합, 추론] |
| 남은 위험 | 외부 프로세스가 이름을 바꿨을 때 링크가 갱신되는지, 별칭 중복 해석, 앱 실행 중 파일을 직접 쓸 때의 충돌 동작은 모두 [미확인]입니다. 그래서 역반영은 `entity_id`를 기준으로 맞추고 파일 이름은 무시합니다 |

## 5. 그래도 Neptune을 원할 때

| 항목 | 조건·비용 |
|---|---|
| 전제 | D-2를 바꿔야 합니다. 클라우드 운영(우리가 운영하는 SaaS, 또는 사용자 본인의 AWS 계정)을 받아들이고 오프라인 동작을 포기해야 합니다 |
| 접속 | VPC 내부(앱 서버를 같은 VPC에 둠), 또는 Public Endpoint(엔진 1.4.6 이상, IAM 인증 필수, 보안 그룹으로 IP 제한, 퍼블릭 서브넷과 IGW 필요, 데이터 전송 요금은 별도 발생 가능)로 접속합니다 |
| 최소 고정비(서울, 월 730시간, 세금·전송 제외) | db.t4g.medium $0.1424/h → **월 $103.95**. Serverless 최소 1 NCU $0.1941/h → **월 $141.69**(0으로 줄일 수 없음). 스토리지 $0.12/GB-월, I/O 100만 건당 $0.24. 고가용성(리플리카 1개)을 붙이면 약 2배[추론]. 벡터·알고리즘용 Analytics 16 m-NCU는 **월 $424.13**(정지 중에도 $0.0581/h). 클러스터를 정지해도 **7일 후 자동으로 다시 시작**됩니다. I/O-Optimized를 쓰면 t4g.medium $0.192/h, 스토리지 $0.27/GB-월이고 I/O 요금은 없습니다 |
| 추가 서비스 | 전문 검색은 OpenSearch 연동(Gremlin·SPARQL 경로)으로 하고 비용이 따로 듭니다. 금액은 [미확인]입니다. 벡터 검색은 Analytics에서 하고, 인덱스는 그래프를 만들 때 1개만 지정할 수 있으며 갱신은 비원자적입니다. Database 쪽 벡터 기능 여부는 [미확인]입니다 |
| 개발·테스트 | `tinkerpop/gremlin-server`(최신 안정 태그 3.8.2, Apache-2.0)를 **기능 테스트 대역**으로만 씁니다. ID 타입, cardinality(set과 single), 스크립트 문법, 트랜잭션, openCypher 지원이 달라 운영 동등성을 보장하지 않습니다. 성능 테스트에는 맞지 않습니다(AWS 블로그). LocalStack Ultimate(라이선스당 월 $89, 연간 결제)는 영속성이 없고 openCypher 언급도 없습니다. **로컬 Gremlin Server와 운영 Neptune을 둘 다 원천으로 두는 이원화는 위험합니다** |
| 그래도 앱에 필요한 것 | FR-ONT-18 제약 검증기, 범위 배타 검사, 병합 트랜잭션 재시도(false conflict는 고부하 시 쓰기의 3~4%), NFR-REL-04용 로컬 내보내기 파이프라인 |
| 권장 타협 | 1순위 PG 원천을 유지하고, SaaS 단계에서 그래프 분석이 실제로 필요해졌을 때 **Neptune Analytics를 파생 읽기 모델**로 붙입니다. 이때 월 약 $424(서울)를 감수합니다 |

## 6. 출처

### 6.1 출처 목록 (모두 2026-10-27 확인)

| 주제 | URL |
|---|---|
| Neptune 개요·모델 | https://docs.aws.amazon.com/neptune/latest/userguide/intro.html |
| Neptune 엔진 이미지 부재, 도구 이미지 | ECR Public 갤러리 API `searchRepositoryCatalogData`(searchTerm=neptune): `neptune/graph-explorer`, `neptune/graph-notebook`, `awslabs-mcp/awslabs/amazon-neptune-mcp-server` |
| openCypher 준수 | https://docs.aws.amazon.com/neptune/latest/userguide/feature-opencypher-compliance.html |
| Gremlin 차이 | https://docs.aws.amazon.com/neptune/latest/userguide/access-graph-gremlin-differences.html |
| 트랜잭션 | https://docs.aws.amazon.com/neptune/latest/userguide/transactions-neptune.html , https://docs.aws.amazon.com/neptune/latest/userguide/access-graph-gremlin-transactions.html |
| 전문 검색 | https://docs.aws.amazon.com/neptune/latest/userguide/full-text-search.html |
| Analytics 벡터·질의어 | https://docs.aws.amazon.com/neptune-analytics/latest/userguide/vector-index.html , https://docs.aws.amazon.com/neptune-analytics/latest/userguide/query.html |
| 백업·정지 | https://docs.aws.amazon.com/neptune/latest/userguide/backup-restore.html , https://docs.aws.amazon.com/neptune/latest/userguide/manage-console-stop-start.html |
| 가격(게시일 2026-09-11) | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonNeptune/current/ap-northeast-2/index.json , https://docs.aws.amazon.com/neptune/latest/userguide/neptune-serverless-capacity-scaling.html |
| Public Endpoint | https://docs.aws.amazon.com/neptune/latest/userguide/neptune-public-endpoints.html , https://aws.amazon.com/about-aws/whats-new/2025/09/aws-neptune-database-public-endpoints |
| SHACL은 Neptune 밖에서 수행 | https://docs.aws.amazon.com/prescriptive-guidance/latest/semantic-layer-agentic-ai-ontology-reasoning-virtual-knowledge-graph/knowledge-layer.html |
| Gremlin Server 테스트 대역 | https://aws.amazon.com/blogs/database/automated-testing-of-amazon-neptune-data-access-with-apache-tinkerpop-gremlin/ |
| LocalStack | https://docs.localstack.cloud/aws/services/neptune/ , https://www.localstack.cloud/pricing |
| TinkerPop | https://hub.docker.com/v2/repositories/tinkerpop/gremlin-server/tags , https://tinkerpop.apache.org/docs/current/reference/ , https://github.com/opencypher/cypher-for-gremlin |
| Obsidian | https://obsidian.md/license , https://obsidian.md/help/cli , https://obsidian.md/help/properties , https://obsidian.md/help/aliases , https://obsidian.md/help/links , https://obsidian.md/help/bases , https://obsidian.md/help/bases/syntax , https://obsidian.md/help/bases/functions , https://obsidian.md/changelog/2025-08-18-desktop-v1.9.10/ , https://obsidian.md/help/sync/troubleshoot |
| Obsidian 플러그인 | https://github.com/blacksmithgu/obsidian-dataview , https://github.com/coddingtonbear/obsidian-local-rest-api |
| PG·대안 엔진 | `research-graphdb.md` 4절 출처: https://www.npmjs.com/package/embedded-postgres , https://pglite.dev/docs/ , https://github.com/apache/age/releases , https://github.com/LadybugDB/ladybug/releases , https://docs.ladybugdb.com/ , https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md |

### 6.2 검증 단계에서 바로잡은 내용

| 원래 주장 | 수정 |
|---|---|
| ECR Public의 Neptune 관련 이미지는 Graph Explorer뿐이다 | 엔진 이미지는 없습니다. 공식 이미지는 Graph Explorer, graph-notebook, Neptune MCP 서버 같은 **도구**뿐입니다 |
| Neptune 트랜잭션은 질의 1건 단위다 | 세션 없는 요청에만 해당합니다. Gremlin 세션, GLV `g.tx()`, Bolt 세션은 여러 요청을 한 트랜잭션으로 묶고, 명시적 트랜잭션 안의 읽기는 SERIALIZABLE로 실행됩니다 |
| 로컬 Gremlin Server와 운영 Neptune 이원화는 비현실적이다 | 테스트 대역으로는 쓸 수 있습니다(AWS 블로그). 운영 원천을 둘로 두는 이원화가 위험한 것입니다 |
| LocalStack 트랜잭션은 3.7.2로 고정된다 | 트랜잭션을 켰을 때만 3.7.2이고, 평소에는 엔진 버전에 따라 3.4.11~3.7.2로 매핑됩니다 |

### 6.3 미확인으로 남긴 항목

- Neptune property graph에 스키마 강제·SHACL 내장 검증이 없다는 점. 부재 주장이고 정황 근거만 있습니다. `pg_schema()`는 조회용입니다.
- 벡터 검색이 Neptune Analytics 전용인지(Database 쪽 기능 미확인).
- Neptune 스냅샷을 AWS 밖으로 가져갈 형식이 없다는 점. 문서에 해당 기능이 없다는 데 근거한 추론입니다.
- OpenSearch 연동 비용.
- Obsidian에서 외부 프로세스가 이름을 바꿨을 때의 링크 갱신, 별칭 중복 해석, 파일 직접 쓰기와 앱 편집이 겹칠 때의 동작.
- Bases의 행 수·성능 한도.
- `embedded-postgres` 바이너리에 pgvector·`pg_dump`가 동봉되는지.
