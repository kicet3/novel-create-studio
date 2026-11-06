# Amazon Neptune을 Docker로 로컬 연동하는 방안 조사

- 작성일·확인일: 2026-10-27 (아래 URL은 모두 이 날짜에 확인)
- 관련 요구: D-2(로컬 단일 사용자 → 자체 호스팅), NFR-EXT-01(Graph DB 어댑터 분리), NFR-REL-04(RPO 24h·RTO 1h), NFR-PERF-04, FR-ONT-01~19
- 등급: [1차] AWS 공식 문서·AWS 가격 API·Apache TinkerPop 공식 문서·Docker Hub 공식 이미지·LocalStack 공식 문서/가격, [2차] 제3자 글, [미확인] 확인 못 함, [추론] 근거로부터의 판단
- 범위: Neptune 한정. Graph DB 후보 전반 비교는 `research-graphdb.md`(같은 폴더)를 따른다. Obsidian 검토는 이 문서 범위 밖이다.

## 1. 결론 요약

| 항목 | 판단 |
|---|---|
| "Neptune을 Docker로 띄운다" | **불가능.** AWS는 Neptune Database·Neptune Analytics 어느 쪽도 로컬/Docker 이미지를 배포하지 않는다. AWS가 ECR Public에 올린 Neptune 관련 이미지는 시각화 도구 Graph Explorer뿐이다. |
| 대체 1: LocalStack | Neptune 에뮬레이션은 **유료 Ultimate 플랜 전용**($89/라이선스/월, 연간 결제). 내부 엔진은 **TinkerPop Gremlin Server**이고, 문서에 openCypher 지원 언급이 없으며 **영속성 미지원**이다. 개발자 테스트용이지, 사용자 PC에 배포할 수 없다. |
| 대체 2: TinkerPop Gremlin Server(Docker) | Apache 2.0, 공식 이미지 `tinkerpop/gremlin-server`(3.8.2, 2026-09-08). 하지만 TinkerGraph는 인메모리이며 디스크 저장은 `Graph.close()` 시 파일 덤프 방식이고, 트랜잭션은 READ COMMITTED 수준의 선택 기능이다. openCypher는 지원하지 않는다(Cypher 플러그인은 유지보수 중단). |
| 실제 Neptune 사용 | 클라우드 전용. 최소 비용은 서울 리전 상시 가동 기준 **월 약 $105(db.t4g.medium)** ~ **$142(Serverless 최소 1 NCU)**, Neptune Analytics는 최소 16 m-NCU로 **월 약 $424**. 오프라인 동작 불가. |
| 우리 제품 적합성 | **부적합.** 로컬 설치·오프라인·비용 최소·자체 호스팅 요구(D-2)와 정면으로 충돌한다. 또 FR-ONT-14(통제 스키마·정의역/치역·개수·시간 제약 검증)를 Neptune이 DB 수준에서 강제하지 않으므로 어차피 앱 코드로 구현해야 한다. |
| "로컬은 Gremlin Server, 운영은 Neptune" 이원화 | **비현실적.** ID 타입·속성 기본 cardinality·트랜잭션 의미·스크립트 문법·영속성이 다르고, openCypher는 로컬 대응 엔진이 없다. 두 엔진 모두에서 통과하는 Gremlin 부분집합으로 제한하고 이중 테스트를 해야 한다. |
| 권고 | `research-graphdb.md`의 1순위(PostgreSQL 사실 테이블 + 그래프 질의 계층, 어댑터 분리)를 유지한다. Neptune은 NFR-EXT-01 어댑터의 **향후 선택지**(클라우드 SaaS 단계에서 내보내기·분석 대상)로만 남긴다. |

## 2. 공식 로컬/Docker 이미지 여부와 대체 수단

### 2.1 AWS 공식 이미지

- Neptune Database, Neptune Analytics 모두 로컬 실행용 엔진 이미지나 다운로드 배포판이 공식 문서에 없다. [1차-부재 확인] Neptune 공식 문서(https://docs.aws.amazon.com/neptune/latest/userguide/intro.html)는 "fully managed" 서비스로만 설명하고, 학습·개발용으로는 비용 없는 Jupyter 노트북(graph-notebook) 사용을 안내한다.
- AWS가 ECR Public에 배포하는 Neptune 관련 Docker 이미지는 시각화 도구 **Graph Explorer**(`public.ecr.aws/neptune/graph-explorer`)다. DB가 아니라 웹 UI + 프록시다. [1차] https://aws.github.io/graph-explorer/guides/deploy-with-docker/
- Docker Hub의 `amothic/neptune` 같은 제3자 이미지는 AWS와 무관하며 Neptune 충실도를 확인할 수 없다. [2차/미확인]

### 2.2 LocalStack Neptune 에뮬레이션

| 항목 | 내용 | 등급·출처 |
|---|---|---|
| 요금제 | "Available from the Ultimate plan." Hobby(무료, 비상업 전용)·Base에는 Neptune 없음 | [1차] https://docs.localstack.cloud/aws/services/neptune/ , https://www.localstack.cloud/pricing |
| 가격 | Ultimate $89/라이선스/월(연간 결제). 월 결제는 AWS Marketplace에서 $107/월 | [1차] localstack.cloud/pricing, [2차] AWS Marketplace 리스팅 |
| 내부 엔진 | Apache TinkerPop **Gremlin Server**. Neptune 엔진 버전별로 TinkerPop 버전을 매핑 | [1차] LocalStack Neptune 문서 |
| 질의어 | Gremlin이 주 경로. RDF/SPARQL은 "지원" 언급만 있고 엔드포인트 동작은 명시 없음. **openCypher 언급 없음** | [1차] 같은 문서 / openCypher 지원은 [미확인 → 문서상 없음] |
| 영속성 | **Persistence: Not Supported** | [1차] 같은 문서 |
| 트랜잭션 | 미리보기(beta), `NEPTUNE_ENABLE_TRANSACTION=1`로 켜며 이때 요청 엔진 버전과 무관하게 TinkerPop 3.7.2 사용 | [1차] 같은 문서 |
| API 범위 | 관리 API 70개 중 56개 구현 | [1차] 같은 문서 |
| 우리 제품 관점 | 라이선스가 개발자 개인 단위로 할당되므로 최종 사용자 PC에 동봉·배포하는 런타임이 될 수 없다 | [1차] https://docs.localstack.cloud/aws/licensing/ + [추론] |

### 2.3 Apache TinkerPop Gremlin Server

| 항목 | 내용 | 등급·출처 |
|---|---|---|
| 이미지 | `tinkerpop/gremlin-server`, 최신 `3.8.2`(2026-09-08), `4.0.0-beta.3`(2026-07-27) | [1차] https://hub.docker.com/r/tinkerpop/gremlin-server (tags API) |
| 라이선스 | Apache License 2.0 | [1차] https://tinkerpop.apache.org/ |
| 기본 저장 | TinkerGraph는 인메모리. `gremlin.tinkergraph.graphLocation`/`graphFormat`을 주면 **`Graph.close()` 때 파일로 쓰고 시작 시 읽는다**(증분 저장·WAL 아님) | [1차] https://tinkerpop.apache.org/docs/current/reference/ (TinkerGraph 설정) |
| 트랜잭션 | 기본 비트랜잭션. `TinkerTransactionGraph`(3.7.0+)로 선택 가능, **READ COMMITTED**, ThreadLocal 트랜잭션만 | [1차] 같은 문서 |
| openCypher | Gremlin Server 자체 지원 없음. `opencypher/cypher-for-gremlin` 플러그인은 README에 "not maintained anymore" | [1차] https://github.com/opencypher/cypher-for-gremlin |
| 런타임 | JVM 필요 | [1차] TinkerPop 문서 |

→ 결론: 로컬 PC 배포용으로는 내구성(크래시 시 마지막 close 이후 손실 위험)과 JVM 동봉 부담이 크다. NFR-REL-04(RPO 24h)는 주기적 덤프로 맞출 수 있지만, 작업 중 크래시 손실은 별도 대책이 필요하다. [추론]

## 3. Neptune 기능 정리 (클라우드 실서비스 기준)

| 영역 | 내용 | 등급·출처 |
|---|---|---|
| 데이터 모델 | Property Graph(Gremlin·openCypher가 **같은 그래프**를 질의) 또는 RDF(SPARQL). 두 모델은 별개 선택 | [1차] https://docs.aws.amazon.com/neptune/latest/userguide/intro.html |
| openCypher 준수 | openCypher 9 기준. **`CALL ... YIELD` 미지원**, `shortestPath()`/`allShortestPaths()` 미지원, `MANDATORY MATCH`·사용자 정의 함수 미지원, 변경 질의의 `UNION` 미지원, ID는 문자열 | [1차] https://docs.aws.amazon.com/neptune/latest/userguide/feature-opencypher-compliance.html |
| Gremlin 차이 | ID는 **문자열만**, 속성 기본 cardinality는 **set**(list 미지원), meta-property·lambda·Groovy 변수/파라미터 바인딩 미지원, 텍스트 스크립트에서 `tx.commit()` 수동 트랜잭션 미지원, 세션 최대 10분, `null`/Map/UUID 속성값 불가, 다중 라벨 `::` | [1차] https://docs.aws.amazon.com/neptune/latest/userguide/access-graph-gremlin-differences.html |
| 트랜잭션 | 질의 1건 = 트랜잭션. 읽기 전용은 **SNAPSHOT**, 변경 질의는 READ COMMITTED + 범위 잠금으로 non-repeatable·phantom 방지. 잠금 대기 60초, gap lock으로 인한 false conflict(고부하 시 쓰기 3~4%) → 재시도 필요 | [1차] https://docs.aws.amazon.com/neptune/latest/userguide/transactions-neptune.html |
| 스키마·SHACL | 공식 문서에서 property graph 스키마 강제나 SHACL 내장 검증 기능을 찾지 못함. 강제되는 것은 ID 유일성 정도. RDF 쪽은 외부 SHACL 프로세서(pySHACL 등)를 클라이언트로 돌리는 방식이 일반적 | [미확인](공식 지원 표기 없음) / [2차] Stack Overflow 2023 답변 |
| 시간·버전 사실 | 전용 bitemporal 기능 없음. 사실을 노드(또는 RDF named graph/reification)로 만들고 `valid_from/valid_to/recorded_at` 속성을 두는 모델링으로 표현해야 함. openCypher datetime은 UTC 저장, 산술 연산은 1.3.2.0+ labmode에서 확장 | [1차] opencypher-compliance 문서(날짜 기능) + [추론](모델링 방식) |
| 전문 검색(Database) | 내장 없음. **Amazon OpenSearch Service**(또는 Serverless)로 Streams 복제 후 Gremlin/SPARQL에서 호출. openCypher 경로는 문서에 없음 | [1차] https://docs.aws.amazon.com/neptune/latest/userguide/full-text-search.html |
| 벡터 검색 | **Neptune Analytics 전용.** 그래프 생성 시에만 벡터 인덱스 1개(차원 1~65,535) 지정. 벡터 갱신은 **원자성·격리 없음** | [1차] https://docs.aws.amazon.com/neptune-analytics/latest/userguide/vector-index.html |
| Neptune Analytics 질의어 | **openCypher만** 지원 | [1차] https://docs.aws.amazon.com/neptune-analytics/latest/userguide/query.html |
| 백업 | 연속·증분 자동 백업, 보존 1~35일, PITR, 수동 스냅샷(복원은 Neptune 클러스터로). 자동 백업 비활성화 불가. 스냅샷을 로컬 파일로 받는 기능은 없음 → 로컬 이관은 내보내기 도구 필요 | [1차] https://docs.aws.amazon.com/neptune/latest/userguide/backup-restore.html / 로컬 파일 다운로드 불가는 [추론](문서에 해당 기능 없음) |
| 정지 | 클러스터 정지 시 인스턴스 요금 없음, 스토리지·백업만 과금. **7일 후 자동 재시작** | [1차] https://docs.aws.amazon.com/neptune/latest/userguide/manage-console-stop-start.html |

### FR-ONT 요구와의 대응 [추론]

| 요구 | Neptune에서의 처리 |
|---|---|
| FR-ONT-01 불변 ID | 사용자 지정 문자열 ID로 가능(○) |
| 이름 사전(시점·시간선·아는 인물 범위), 언급 연결·신뢰도 | 노드/엣지 속성 모델링으로 가능하나 범위 질의 인덱스는 앱 설계 몫(△) |
| 병합·분리 이력 | 이력 노드 모델링 + 앱 로직(△) |
| 통제 스키마·정의역/치역·개수·시간 제약(FR-ONT-14 계열) | **DB 강제 없음**, 앱 검증 계층 필수(×) |
| bitemporal 사실·인물 지식·공개 잠금 | 사실 노드 모델링 + 앱 로직(△), 시간 범위 겹침 금지 같은 배타 제약은 DB가 못 함(×) |

## 4. 비용 (AWS 공식 가격 API, 게시일 2026-09-11)

출처: [1차] https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonNeptune/current/ap-northeast-2/index.json , 같은 경로의 `us-east-1/index.json`, 가격 페이지 https://aws.amazon.com/neptune/pricing/ . 월 730시간, 온디맨드, Standard 스토리지 기준. 세금·데이터 전송 제외.

| 구성 | 서울 ap-northeast-2 | 버지니아 us-east-1 |
|---|---|---|
| db.t4g.medium(최소 프로비저닝) | $0.1424/h → **월 $103.95** | $0.093/h → 월 $67.89 |
| db.t3.medium | $0.15/h → 월 $109.50 | $0.098/h → 월 $71.54 |
| Serverless 최소 1 NCU(최소값 1.0, 0으로 축소 불가) | $0.1941/NCU-h → **월 $141.69** | $0.1608/NCU-h → 월 $117.38 |
| 스토리지 | $0.12/GB-월 | $0.10/GB-월 |
| I/O | $0.24/100만 건 | $0.20/100만 건 |
| 백업(무료분 초과) | $0.023/GB-월 | $0.021/GB-월 |
| Neptune Analytics 최소 16 m-NCU | $0.581/h → **월 $424.13** (정지 시 $0.0581/h) | $0.48/h → 월 $350.40 (정지 시 $0.048/h) |
| 프리 티어 | 첫 클러스터 생성 후 30일: t3/t4g.medium 750시간, I/O 1,000만, 스토리지 1GB, 백업 1GB | 같음 |

- Serverless 최소 1.0 NCU, 최대 128 NCU. [1차] https://docs.aws.amazon.com/neptune/latest/userguide/neptune-serverless-capacity-scaling.html
- 단일 사용자 상시 가동 추정(서울): t4g.medium + 데이터 수 GB + I/O 수백만 건 ≈ **월 $105~110**. 고가용성(리플리카 1개) 추가 시 약 2배. Neptune Analytics(벡터 검색) 병행 시 +$424. [추론, 위 단가 기반]
- 비교: 사용자 PC의 임베디드 DB는 인프라 비용 0원. [추론]

### 접근 제약 (로컬 PC에서 직접 접속)

- 기본은 VPC 내부 전용. 2025-09-04부터 **Public Endpoint** 지원: 엔진 1.4.6 이상, 기본 꺼짐, 인스턴스 단위 활성화, **IAM 인증 필수**, 보안 그룹으로 IP 제한, 추가 요금 없음. [1차] https://docs.aws.amazon.com/neptune/latest/userguide/neptune-public-endpoints.html , https://aws.amazon.com/about-aws/whats-new/2025/09/aws-neptune-database-public-endpoints
- 즉 로컬 PC 앱이 접속하려면 AWS 자격 증명으로 SigV4 서명을 해야 한다. 최종 사용자마다 AWS 계정·IAM 키를 요구하게 되거나, 우리가 중계 서버를 운영해야 한다. [추론]
- 인터넷이 없으면 동작하지 않는다(오프라인 요구 불충족). [추론]

## 5. 우리 제품에 맞는지 판단

### 장점
- 운영 부담 없는 관리형(패치·복제·6중 저장·PITR 자동). [1차 intro]
- Gremlin·openCypher·SPARQL 표준 질의어. 대규모 그래프에서 검증된 성능.
- Neptune Analytics의 그래프 알고리즘·벡터 검색(단, 별도 서비스·별도 요금).

### 단점
1. **로컬 실행 불가** → D-2(로컬 단일 사용자 앱으로 시작, 사용자 PC 설치)와 충돌. 오프라인 불가.
2. **고정비**: 쓰지 않아도 월 $100 이상(서울). 정지해도 7일 후 자동 재시작.
3. **자체 호스팅 불가**: 사용자가 자기 서버에 Neptune을 올릴 수 없다. 자체 호스팅 = 각자 AWS 계정.
4. **정합성 강제 부재**: FR-ONT-14 계열 제약, 시간 범위 배타 제약을 DB가 못 한다. 앱 검증 계층이 어차피 필요하다.
5. **기능 분산**: 전문 검색은 OpenSearch, 벡터는 Analytics(openCypher만, 벡터 갱신 비원자적)로 서비스가 쪼개진다.
6. **백업 이식성**: 스냅샷은 Neptune으로만 복원. 로컬 백업(NFR-REL-04)은 별도 내보내기 파이프라인 필요.

### 잠금(lock-in)
- 질의어는 표준이지만 Neptune 고유 차이(문자열 ID, set cardinality, `::` 다중 라벨, openCypher 미지원 절, 전문 검색 연동 문법, `neptune.algo.*` 벡터 프로시저)가 코드에 스며든다. 백업·IAM·OpenSearch 연동은 AWS 전용. [1차 차이 문서 + 추론]

### "로컬은 Gremlin Server, 운영은 Neptune" 이원화의 현실성

| 차이 | Gremlin Server(TinkerGraph) | Neptune | 영향 |
|---|---|---|---|
| ID | 기본 LONG(IdManager로 STRING/ANY 설정 가능) | 문자열만 | 설정으로 맞출 수 있음 |
| 속성 cardinality 기본값 | single(설정 가능) | **set** | 같은 `property()` 호출이 값을 덮어쓰기 vs 추가 → 조용한 데이터 차이. 모든 쓰기에 `single` 명시 필요 |
| 스크립트 | Groovy 엔진이면 변수·람다 허용 | ANTLR 문법만, 변수·바인딩·람다 불가 | 로컬에서 되는 질의가 운영에서 실패 |
| 트랜잭션 | 기본 없음 / TinkerTransactionGraph는 READ COMMITTED | 질의 단위, SNAPSHOT/범위 잠금 | 동시성 버그가 로컬에서 재현 안 됨 |
| 영속성 | close 시 파일 덤프 | 내구 저장 | 로컬 크래시 손실 |
| openCypher | 없음(플러그인 유지보수 중단) | 있음 | openCypher를 쓰면 로컬 대응 불가 |
| 전문·벡터 검색 | 없음 | OpenSearch / Analytics | 로컬 대체 구현 필요 |

→ Gremlin 바이트코드(GLV) + 공통 부분집합 + 양쪽 CI 테스트로 "가능은 하지만", 제품의 기본 실행 환경(로컬)이 열화된 에뮬레이터가 되는 구조라 비용 대비 이득이 없다. [추론]

## 6. 권고

1. Neptune(Docker 포함)은 1차 저장소로 채택하지 않는다.
2. `research-graphdb.md` 1순위(PostgreSQL 사실 테이블, 로컬 embedded-postgres → 자체 호스팅 외부 PG)를 유지하고 정합성 제약(시간 범위 배타·개수·정의역/치역)은 DB+앱 검증 계층에서 강제한다.
3. NFR-EXT-01 어댑터 인터페이스는 엔진 중립(도메인 질의 단위: "N화·시간선 T에서 유효한 사실" 등)으로 정의한다. Gremlin/openCypher 문자열을 어댑터 밖으로 노출하지 않는다.
4. 향후 클라우드 SaaS 단계에서 대규모 그래프 분석이 필요하면, PG를 원천으로 두고 Neptune Analytics(openCypher CSV 로드)를 **파생 읽기 모델**로 붙이는 선택지를 남긴다. 이 경우 월 $350~424 이상의 고정비를 감수해야 한다.

## 7. 미확인 항목

- Neptune의 property graph용 스키마/SHACL 내장 검증 공식 지원 여부(공식 문서에서 지원 표기를 찾지 못함).
- Neptune Database 최신 엔진(1.4.x/1.5.x)의 정확한 TinkerPop 버전 매핑.
- LocalStack Neptune의 SPARQL·openCypher 엔드포인트 실제 동작(문서 미기재, 유료라 직접 검증 안 함).
- Neptune Analytics 그래프 정지 가능 여부는 가격 API의 `StoppedGraphUsage` 단가(실행 단가의 10%)로만 확인. 정지 조건·기간 문서는 못 읽음.
