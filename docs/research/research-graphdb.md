# Graph DB 엔진 후보 조사 (D-8)

- 작성일·확인일: 2026-10-27 (아래 출처는 모두 이 날짜에 확인했습니다)
- 근거 요구: D-8(확정(방침)), D-2, D-27, FR-ONT-01~19, NFR-PERF-04, NFR-REL-04·05, NFR-EXT-01·04a, R-18
- 등급: [1차] 공식 문서·저장소·라이선스 파일·패키지 레지스트리, [2차] 제3자 글, [미확인] 확인 못 함

## 1. 요약

| 항목 | 내용 |
|---|---|
| 1순위 | **PostgreSQL에 온톨로지 사실 테이블을 두고 그래프는 질의 계층으로 표현**합니다. 로컬은 `embedded-postgres`(자식 프로세스로 PG를 띄움), 자체 호스팅은 외부 PG로 같은 스키마를 씁니다. Paperclip `packages/db` 런타임 차용 경로와 같습니다(→ paperclip-architecture-map 8절). |
| 대안 A | **LadybugDB**(Kuzu 후속 포크, MIT, 프로세스 내 임베디드, Cypher, 벡터·FTS 확장). 다단계 경로 탐색·그래프 알고리즘이 핵심 부하가 되면 PG를 원천으로 두고 **파생 읽기 모델**로 붙입니다. |
| 대안 B | **SQLite**(`better-sqlite3`) + FTS5 + `sqlite-vec`. 파일 하나로 백업이 가장 단순하지만 시간 범위 제약 강제와 자체 호스팅 확장에서 PG보다 불리합니다. |
| 제외 | Neo4j Community(JVM·서버·GPLv3·온라인 백업은 Enterprise), Memgraph(BSL이 제3자 배포·임베드 금지), FalkorDB(SSPLv1, Redis 자식 프로세스), Kuzu(2025-10-10 아카이브), CozoDB(2023-12 이후 릴리스 없음), SurrealDB(BSL, 비표준 질의어), Oxigraph(Node 패키지는 메모리 전용), DuckPGQ(연구 프로토타입) |
| 핵심 이유 | R-18 대응(FR-ONT-12~18)은 그래프 탐색보다 **불변 ID·시간 범위·개수 제약·병합 이력·트랜잭션 일관성** 문제입니다. 이 제약을 DB가 강제할 수 있는 쪽은 PG(범위 타입 + `btree_gist` 배타 제약)입니다. Cypher 계열 임베디드 엔진은 이를 앱 코드로 구현해야 합니다. |

## 2. 전제와 부하 추정

| 항목 | 값 | 근거 |
|---|---|---|
| 규모 | 500화, 엔티티 수천 개 | NFR-PERF-04 (가정) |
| 사실·언급 수 | 사실 수만 건, 언급(`Mention`) 10만 건 안팎 | 가정: 화당 언급 200건 × 500화 |
| 질의 형태 | "N화·시간선 T에서 유효한 사실", "표기 X의 후보 엔티티(시점·아는 인물 범위)", "인물 P가 N화에 아는 것", 1~3홉 관계 | FR-ONT-02·03·13·14, FR-AGT-04 |
| 성능 목표 | 컨텍스트 구성 p90 10초 이하 | NFR-PERF-04 (가정) |
| 운영 | 로컬 단일 사용자, 상시 실행, 이후 자체 호스팅 | D-2, NFR-REL-06 |
| 동시 작품 | 3개, 작품 간 격리 | NFR-EXT-04a·04b |

이 규모에서는 어느 후보도 처리량이 병목이 아닙니다(가정). 엔진 선택은 정합성 강제, 배포·라이선스, 백업·업그레이드 부담으로 갈립니다.

## 3. 비교표

범례: ○ 충족, △ 조건부, × 불충족

| 후보 | (1) 임베디드·Node | (2) 시간 사실 표현 | (3) 라이선스 | (4) 백업·복원 | (5) 운영 부담 | (6) 질의어 | (7) 유지보수(2026-10) | (8) 벡터·FTS |
|---|---|---|---|---|---|---|---|---|
| **PostgreSQL + 사실 테이블** (`embedded-postgres`) | △ 자식 프로세스로 PG 실행, JVM 없음, macOS·Windows·Linux 바이너리 | ○ `int4range`·`tstzrange` + GiST 인덱스 + `EXCLUDE` 제약으로 겹침 금지를 DB가 강제 | ○ PostgreSQL License, `embedded-postgres` MIT | ○ `pg_dump` 온라인 일관 스냅샷, 정지 후 데이터 디렉터리 복사 | 중 (포트·프로세스 수명주기 관리, Paperclip 코드 차용 가능) | SQL, 재귀 CTE, SQL/PGQ는 PG 18 기준 미지원 [미확인] | ○ `embedded-postgres` 18.4.0-beta.17 (2026-06-05) | ○ `pgvector`(바이너리 동봉 여부 [미확인]), `pg_trgm`, `tsvector`(한국어 파서 없음) |
| PGlite (+ `pglite-age`, `pglite-pgvector`) | ○ WASM, 프로세스 내 | ○ PG와 동일 | ○ Apache-2.0 | △ `dumpDataDir()` tarball(같은 PGlite에만 복원 보장) | 낮음, 단 단일 연결 | SQL + openCypher(AGE) | ○ 0.5.12 (2026-10-26), AGE 패키지 0.0.13 | ○ pgvector, pg_trgm |
| Apache AGE (PG 확장) | × 단독으로는 PG 서버 필요(PGlite에서는 가능) | △ 속성(agtype)에 범위를 직접 표현, 제약은 앱 | ○ Apache-2.0 | ○ PG와 동일 | 중 | openCypher + SQL | ○ PG18/v1.8.0-rc0 (2026-07-09), PG15/v1.8.0-rc0 (2026-09-19) | △ PG 확장 조합 |
| **LadybugDB** (Kuzu 포크) | ○ 프로세스 내, `@ladybugdb/core` | △ `valid_from`/`valid_to` 속성 + WHERE, 겹침 제약 없음 | ○ MIT | △ 파일 복사(닫은 상태), `EXPORT/IMPORT DATABASE`. 온라인 백업 [미확인] | 낮음, 단 READ_WRITE 프로세스 1개 | Cypher | ○ v0.22.0 (2026-10-25), 한 달에 1~3회 릴리스 | ○ `vector`, `fts` 확장(INSTALL 필요) |
| Kuzu | ○ 프로세스 내 | △ Ladybug와 같음 | ○ MIT | △ | 낮음 | Cypher | × 2025-10-10 아카이브, 마지막 0.11.3 | △ 확장 서버 종료 [2차] |
| SQLite (`better-sqlite3`) | ○ 프로세스 내 | △ 정수 두 열 + 트리거로 겹침 검사 | ○ Public Domain, `better-sqlite3` MIT | ○ `.backup()` 온라인 백업 API | 가장 낮음 | SQL, 재귀 CTE | ○ `better-sqlite3` 13.0.3 (2026-08-05) | △ FTS5 내장, `sqlite-vec` 0.1.9 (2026-03-31, 0.x) |
| FalkorDB / falkordblite | △ `falkordblite`(npm 0.3.0)가 redis-server + 모듈을 띄우고 Unix 소켓으로 연결 | △ 속성 + 범위 인덱스 | × 서버 SSPLv1 (클라이언트·lite 래퍼는 MIT) | ○ Redis RDB 스냅샷 | 중 | openCypher | ○ v4.22.2 (2026-10-20), v6.0.3 (2026-10-22) | ○ 벡터·전문 인덱스 |
| Neo4j Community | × 서버, Java 21/25 | △ 속성 + 인덱스 | △ GPLv3 | × 온라인 백업은 Enterprise | 높음 | Cypher(GQL 부분) | ○ | ○ 벡터·전문 인덱스 [1차 미재확인] |
| Memgraph | × 서버, Docker·Linux 패키지 | △ 속성 | × BSL 1.1: 제3자 배포·임베드 금지 | ○ 스냅샷 [미확인] | 높음 | Cypher | ○ v3.14.0 (2026-10-21) | ○ [미확인] |
| SurrealDB | ○ `@surrealdb/node` 3.1.0 임베디드 | △ `VERSION` 시점 조회 [미확인] | △ BSL 1.1: Database Service 금지 | △ export/import [미확인] | 중 | SurrealQL(비표준) | ○ v3.3.4 (2026-10-19) | ○ [미확인] |
| CozoDB | ○ `cozo-node` | ○ 관계별 time travel 내장 | ○ MPL-2.0 | △ | 낮음 | Datalog | × 마지막 릴리스 v0.7.6 (2023-12-11), 마지막 push 2024-12-04 | ○ HNSW, FTS |
| Oxigraph (+ SHACL) | △ npm `oxigraph`는 메모리 저장소만 | △ RDF-star 주석으로 표현 가능 | ○ MIT/Apache-2.0 | △ Node에서는 직렬화 덤프 | 중 | SPARQL 1.1 | ○ v0.5.13 (2026-10-22) | × |
| DuckDB + DuckPGQ | ○ `@duckdb/node-api` | △ SQL 범위 + PGQ | ○ MIT | ○ 파일 | 낮음 | SQL/PGQ | △ README가 "research project, work in progress" | △ `vss`·`fts` 확장 [미확인] |

## 4. 후보별 근거

### 4.1 PostgreSQL + 사실 테이블 (1순위)

| 근거 | 출처 |
|---|---|
| `embedded-postgres`는 Node에서 PG 클러스터를 생성·시작·정지하는 패키지이고 MIT입니다. 최신 18.4.0-beta.17(2026-06-05). Darwin x64/arm64, Windows x64, Linux를 지원합니다. 바이너리는 zonky `embedded-postgres-binaries`에서 옵니다. [1차] | https://www.npmjs.com/package/embedded-postgres , https://github.com/leinelissen/embedded-postgres |
| Paperclip은 로컬에 `embedded-postgres`(PG 18), 운영에 외부 PG(`DATABASE_URL`)를 씁니다. PGlite 설정은 `embedded-postgres`로 바꿔 처리합니다. 재사용 판단표에서 `packages/db` 런타임은 "차용"입니다. [1차, 저장소 분석] | /Users/snowfall/orca/docs/paperclip-architecture-map.md 10·261·300행 |
| zonky 바이너리가 pgvector·AGE를 포함하는지 확인하지 못했습니다. 검색 결과 README에는 확장 목록이 없습니다. [미확인] | https://github.com/zonkyio/embedded-postgres-binaries |
| 범위 타입, GiST, `EXCLUDE` 제약, `btree_gist`는 PG 표준 기능입니다. [1차, 미재확인: 공식 문서 기억] | https://www.postgresql.org/docs/current/rangetypes.html , https://www.postgresql.org/docs/current/btree-gist.html |

시간 사실 표현 방식(가정: 설계 초안):

| 요구 | 표현 |
|---|---|
| 유효 시간(작중 시점, FR-ONT-02) | `valid_episodes int4range` + `timeline_id`. 씬 단위가 필요하면 `(episode_no, scene_no)`를 정렬 가능한 정수로 인코딩 |
| 기록 시간(버전, FR-ONT-09) | `recorded tstzrange` 또는 append-only 이력 테이블 + `superseded_by` |
| 칭호 보유자 1명(FR-ONT-13·18 개수 제약) | `EXCLUDE USING gist (work_id WITH =, timeline_id WITH =, name_id WITH =, valid_episodes WITH &&) WHERE (name_kind = 'title')` |
| 생부 1명, 사망 후 새 관계 불가(FR-ONT-18) | 개수는 배타 제약 또는 부분 유니크 인덱스, 시간 제약은 검증 질의 → 연속성 이슈(FR-ONT-06) |
| 병합·분리(FR-ONT-16) | `entity_redirect(old_id → new_id, merge_event_id)`, 참조 갱신을 한 트랜잭션으로 처리 |
| 작품 격리(NFR-EXT-04a) | `work_id` 열 + 복합 키, 또는 작품별 schema |
| 그래프 탐색 | 1~3홉은 조인, 가변 깊이는 재귀 CTE. AGE는 필요해질 때 검토 |

### 4.2 LadybugDB (대안 A)

| 근거 | 출처 |
|---|---|
| Kuzu 저장소는 2025-10-10 아카이브됐고 README가 마지막 릴리스로 v0.11.3을 안내합니다. MIT. npm `kuzu` 0.11.3(2025-10-10)이 마지막입니다. [1차] | https://github.com/kuzudb/kuzu , https://registry.npmjs.org/kuzu |
| Apple 인수 후 아카이브됐다는 보도. [2차] | https://oneuptime.com/blog/post/2026-08-12-kuzu-archived-pin-0-11-3-fork-or-migrate/view |
| LadybugDB는 커뮤니티 포크이고 MIT, 별 1,886개, 2026-10-27에도 push가 있습니다. v0.22.0(2026-10-25), v0.21.2(2026-10-01), v0.21.1(2026-09-30). npm `@ladybugdb/core` 0.22.0. [1차] | https://github.com/LadybugDB/ladybug/releases |
| v0.22.0 변경 다수가 저장소 계층 수정입니다(체크포인트 복구 강화, "stale pre-0.21 string hash indexes" 감지, `STORAGE_VERSION_48`). 마이너 버전 사이에 디스크 형식이 바뀝니다. [1차] | https://github.com/LadybugDB/ladybug/releases/tag/v0.22.0 |
| 프로세스 내 임베디드, Cypher, 직렬화 가능 ACID. READ_WRITE `Database`는 하나만 열 수 있고 여러 프로세스는 READ_ONLY로만 공유합니다. [1차] | https://docs.ladybugdb.com/ , https://docs.ladybugdb.com/concurrency/ |
| `vector`·`fts`(BM25)는 공식 확장이고 `INSTALL` 후 세션마다 `LOAD`합니다. 확장 서버에서 내려받습니다. [1차] | https://docs.ladybugdb.com/extensions/ |
| 버전 간 이동은 `EXPORT DATABASE` → `IMPORT DATABASE`(빈 DB 필요, 실패 시 자동 롤백 없음). [1차] | https://docs.ladybugdb.com/migrate/ |

판단: 기능은 맞지만 (a) 포크 1년 차이고 저장소 형식이 계속 바뀌어 NFR-REL-05(업그레이드 자동 이전·실패 시 복귀)를 export/import로 매번 구현해야 하고 (b) 시간 범위 겹침·개수 제약을 DB가 강제하지 못하며 (c) 확장이 런타임 다운로드라 오프라인 설치 경로를 따로 만들어야 합니다. 원천 저장소보다 파생 읽기 모델로 적합합니다.

### 4.3 SQLite (대안 B)

| 근거 | 출처 |
|---|---|
| `better-sqlite3` 13.0.3(2026-08-05), MIT. `.backup(destination)`이 온라인 백업을 하고 결과는 일반 SQLite 파일입니다. [1차] | https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md |
| `sqlite-vec` 0.1.9(2026-03-31), MIT OR Apache-2.0. 0.x입니다. [1차] | https://registry.npmjs.org/sqlite-vec |
| Turso(SQLite Rust 재작성, MIT, 별 25k)는 관찰 대상입니다. 성숙도 [미확인]. | https://github.com/tursodatabase/turso |

판단: 로컬 단계만 보면 가장 단순합니다. 범위 겹침 금지는 트리거로 구현해야 하고, D-2(b) 자체 호스팅에서 PG로 옮기면 방언 차이로 이중 유지가 생깁니다.

### 4.4 PGlite / Apache AGE

| 근거 | 출처 |
|---|---|
| PGlite는 WASM PG이고 Node에서 경로를 주면 파일시스템에 저장합니다. "single exclusive connection"입니다. `dumpDataDir()`은 gzip tarball을 만들고 다른 PG 버전과 호환되지 않을 수 있습니다. [1차] | https://pglite.dev/docs/ , https://pglite.dev/docs/api |
| 확장: contrib 33개(`btree_gist`, `pg_trgm`, `fuzzystrmatch`, `unaccent` 포함), 외부 패키지 `@electric-sql/pglite-pgvector`, `@electric-sql/pglite-age`(둘 다 0.0.13, 2026-10-26, Apache-2.0). [1차] | https://pglite.dev/extensions/ , https://registry.npmjs.org/@electric-sql/pglite-age |
| Apache AGE: Apache-2.0, 최근 태그 PG18/v1.8.0-rc0(2026-07-09), PG15/v1.8.0-rc0(2026-09-19). [1차] | https://github.com/apache/age/releases |

판단: PGlite는 같은 PG 스키마로 테스트·개발용 인메모리 DB로 쓰기 좋습니다. Paperclip이 PGlite를 운영 경로에서 뺀 이유는 확인하지 못했습니다 [미확인]. AGE는 Cypher가 필요할 때 PG 안에서 추가할 수 있는 선택지로 남깁니다.

### 4.5 제외 후보

| 후보 | 제외 이유 | 출처 |
|---|---|---|
| FalkorDB | 서버 LICENSE가 SSPLv1입니다. `falkordblite`(npm 0.3.0, 2026-05-02)는 redis-server + FalkorDB 모듈 바이너리를 내려받아 Unix 소켓으로 연결합니다(Windows 지원 [미확인]). Python판 `falkordblite`는 v0.11.0(2026-10-19). 범위·전문·벡터 인덱스는 지원합니다. SSPL은 D-2(c) 호스팅 SaaS로 갈 때 서비스 전체 소스 공개 조건이 걸립니다. [1차] | https://github.com/FalkorDB/FalkorDB (LICENSE), https://registry.npmjs.org/falkordblite , https://docs.falkordb.com/cypher/indexing/ |
| Neo4j Community | GPLv3, Neo4j 2025.10은 Java SE 21 또는 25 필요, 최소 메모리 8GB(서버 기준), 온라인 백업은 Enterprise입니다. [1차] | https://neo4j.com/docs/operations-manual/current/installation/requirements/ , https://neo4j.com/docs/operations-manual/current/introduction/ |
| Memgraph | Community Edition BSL 1.1(2026-01-01 개정)의 Additional Use Grant가 "embed or otherwise distribute the Licensed Work to third parties"를 금지합니다. 로컬 앱에 넣어 배포할 수 없습니다. 설치는 Docker·Linux 패키지 중심. v3.14.0(2026-10-21). [1차] | https://github.com/memgraph/memgraph/blob/master/licenses/BSL.txt , https://memgraph.com/docs/getting-started/install-memgraph |
| SurrealDB | BSL 1.1, "Database Service" 제공 금지. `@surrealdb/node` 3.1.0(2026-10-08)으로 임베디드 가능. SurrealQL은 비표준이고 시점 조회(`VERSION`)의 저장 엔진 조건은 확인 못 함 [미확인]. [1차] | https://github.com/surrealdb/surrealdb (LICENSE), https://surrealdb.com/docs/surrealdb/models/graph |
| CozoDB | MPL-2.0, 관계별 time travel·HNSW·FTS가 있어 요구에 가장 가깝지만 마지막 릴리스 v0.7.6(2023-12-11), 마지막 push 2024-12-04로 사실상 정지 상태입니다. [1차] | https://github.com/cozodb/cozo/releases |
| Oxigraph (+ SHACL) | MIT/Apache-2.0, v0.5.13(2026-10-22). npm 패키지는 "simple in-memory store"만 제공합니다. SHACL 검증기는 Oxigraph에 포함되지 않습니다 [미확인]. 시간 사실마다 RDF-star 주석이 필요해 질의가 길어집니다. [1차] | https://github.com/oxigraph/oxigraph/tree/main/js |
| DuckDB + DuckPGQ | README가 연구 프로젝트·진행 중이라고 밝힙니다. 연결마다 `SET active_grammar_extensions`가 필요합니다. 분석용 엔진이라 잦은 소량 쓰기에 맞지 않습니다(가정). [1차] | https://github.com/cwida/duckpgq-extension |

## 5. 추천과 조건

| 조건 | 추천 |
|---|---|
| 기본(500화·엔티티 수천 개, 로컬 단일 사용자 → 자체 호스팅, D-2) | **1순위: PG 사실 테이블.** 로컬 `embedded-postgres`, 자체 호스팅 외부 PG, 테스트 PGlite. 온톨로지 접근은 `OntologyRepository` 어댑터 뒤에 둡니다(NFR-EXT-01). |
| 다단계 경로·그래프 알고리즘(관계도 군집, 영향 전파)이 컨텍스트 구성의 핵심 부하가 됨 | PG를 원천으로 두고 **LadybugDB를 파생 읽기 모델**로 추가(변경 이벤트로 재투영). 또는 PG 안에서 AGE. |
| 설치 크기·프로세스 수를 최소화해야 하고 자체 호스팅을 포기 | **SQLite** |
| 호스팅 SaaS(D-2 c)로 감 | SSPL·BSL 엔진(FalkorDB, Memgraph, SurrealDB)은 계속 제외 |

PRD 영향: PRD 588행은 "세계관 사실·관계·떡밥 연결의 원천은 Graph DB"라고 씁니다. 1순위를 채택하면 이를 "그래프 데이터 모델(엔티티·관계·사실)을 관계형 저장소에 표현"으로 고쳐야 합니다(D-8 결과 기록).

## 6. 채택 시 스파이크 항목

| # | 항목 | 통과 기준 |
|---|---|---|
| S-1 | `embedded-postgres`에 `btree_gist`·`pg_trgm`·`pgvector` 로드 | macOS arm64·Windows x64·Linux x64에서 `CREATE EXTENSION` 성공. pgvector가 없으면 직접 빌드 동봉 또는 앱 메모리 내 벡터 검색으로 대체 |
| S-2 | 시간 범위 배타 제약 | "폐하" 보유자 겹침 INSERT가 거부되고, 보유자 교체(10화까지 A, 11화부터 B)는 허용 |
| S-3 | 이름 후보 조회 성능 | 엔티티 5,000개·이름 2만 개·언급 10만 건 합성 데이터에서 "N화·시간선 T·화자 P 기준 표기 X 후보" p90 50ms 이하(가정) |
| S-4 | 컨텍스트 구성 | 같은 데이터에서 한 화 컨텍스트 조회 전체 p90 10초 이하(NFR-PERF-04) |
| S-5 | 한국어 부분 일치 | `pg_trgm`이 데이터베이스 locale·인코딩 설정에서 한글 trigram을 만드는지 확인. 실패 시 이름 사전 정규화 + 접두 인덱스로 대체 |
| S-6 | 병합·분리 트랜잭션 | 병합 후 되돌리기에서 사실·언급·떡밥·씬 참조가 원상복구(FR-ONT-16), 동시 집필 실행 중에도 일관 |
| S-7 | 백업·복원 | 실행 중 `pg_dump`(바이너리 동봉 여부 [미확인]) → 새 클러스터 복원이 RTO 1시간 안에 끝남(NFR-REL-04). 작품 단위 백업·복원 가능 여부 |
| S-8 | PG 메이저 업그레이드 | 앱 업그레이드로 PG 메이저 버전이 바뀔 때 dump/restore 자동 이전과 실패 시 복귀(NFR-REL-05) |
| S-9 | 프로세스 수명주기 | 절전·강제 종료 후 재시작 시 고아 postmaster·포트 충돌 회수(NFR-REL-01·06). Paperclip `embedded-postgres-{owner,supervisor}.ts` 차용 범위 확인 |
| S-10 | (대안 A 대비) LadybugDB 투영 | 같은 합성 데이터를 Ladybug로 투영해 3홉 이상 질의 속도 비교, 확장 오프라인 동봉 가능 여부 |
