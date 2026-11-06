# 05. 메신저 HITL

| 항목 | 내용 |
|---|---|
| 문서 | novel-create-studio 상세 설계 05 |
| 버전 | v0.2 (2026-10-28, 컨셉 대화 경계·메신저 이어 하기 추가). v0.2.1(같은 날, 11 v0.2 교차 후속): 컨셉 고정 버튼 6종·예약 `idx` 900~907, 오래된 버튼 판정(provider 메시지 ID + 이후 사용자 메시지 없음), `paused(budget_limit)` 안내 버튼, MVP-α 연재 중 "컨셉 고치기" 요청 안내, `concept_confirm` 생성 주체. v0.2.2(2026-10-28, 사용자 결정 확정 반영): 9.7 FR-MSG-05 요약 승인 기본·화 전문 첨부 옵트인 확정(PRD v0.5 FR-MSG-05·NFR-SEC-04) |
| 기준 | PRD v0.4 초안, `00-foundation.md` v0.2, `03-domain-model.md` v0.3, `11-concept-development.md` v0.1 |
| 목적 | 에이전트가 사람에게 묻고, 답을 받아, 반영하고, 반영 사실을 알리는 경로를 정합니다. 질문은 채널과 무관한 하나의 모델이고, Telegram·Discord·웹은 그 모델을 그리는 어댑터입니다. |
| 범위 | 채널 중립 질문 모델과 질문 주제별 규칙, 등급 판정, 발송 스케줄(digest·방해금지·상한), 마감·리마인더, 답변 수신·경합·늦은 답변, 답변 해석·확인·반영 기록, 엔티티 판별 질문, 승인 게이트(자율성 × 게이트), 메신저 어댑터(Telegram·Discord·웹), 수신함·발신함, 연결 설정·점검. 이 문서가 전이를 소유하는 상태: `Channel`, `ChannelBindingToken`, `MessengerInbox`, `MessengerOutbox`, `QuestionDelivery`, `DigestBatch`, `Answer.late_resolution`, `AnswerInterpretation`, `AnswerReflection`, `AnswerSession`(03 4.11 위임). |
| 범위 밖 | `Question`·`Approval` 상태 전이(→ 03 4.4, 4.5), 링커 단계와 임계값 알고리즘(→ 06), 작업 차단·재개와 wake(→ 04), 화 파이프라인 단계(→ 07), 프로세스 배치(→ 02), 패키지 버전 고정(→ 08) |
| 작성 | AI 초안. 사람 검토 필요 |

**관련 요구**

| 구분 | ID |
|---|---|
| FR | FR-MSG-01~18, FR-HIL-01a~c, FR-HIL-02~08, FR-SET-01~03, FR-ONT-14~18(질문 부분), FR-FOR-04·06, FR-BUD-02·03, FR-AGT-07·12, FR-UI-03, FR-SPX-09(v1) |
| NFR | NFR-PERF-02·03, NFR-REL-01·02·03·06, NFR-SEC-01·02·03·04, NFR-OBS-01, NFR-QUAL-01(엔티티 판별) |
| D | D-3, D-7, D-14, D-15, D-21, D-24, D-25, D-27 |
| R | R-5, R-6, R-7, R-12, R-13, R-18 |
| 11절 | Discord·Telegram·Slack 행(채널 한도) |

**선행 문서**: 00(용어, ADR-011·014, enum 6.4·6.5, 기본값 7.4·7.5), 03(3.4·3.5 필드, 4.4·4.5 상태 기계, 6절 감사 이벤트). 04는 동시 작성 중이라 이 문서는 04에 둘 내용을 "→ 04"로만 참조합니다.

**표기**: 00·03 표기를 따릅니다. 이 문서에서 새로 정한 이름은 각 절에 **(신규)** 로 표시하고 부록 B에 모읍니다. 00·03 레지스트리에 추가가 필요한 항목은 바꾸지 않고 11절 미결 사항에 올렸습니다.

---

## 1. 설계 원칙

| # | 원칙 | 근거 |
|---|---|---|
| P1 | 질문의 상태는 서버 DB가 소유합니다. 메신저 메시지는 그 상태의 그림일 뿐이고, 버튼 데이터에는 질문 ID와 선택지 인덱스만 담습니다. | PRD 11절, 00 `QuestionOption` |
| P2 | 첫 유효 답변 하나만 채택합니다. 채택은 조건부 UPDATE 한 문장(CAS)으로 합니다. 이후 답은 상태를 바꾸지 않고 `late`/`duplicate`로 기록합니다. | FR-MSG-18, INV-Q-03 |
| P3 | 차단형은 마감 뒤에도 자동 결정하지 않습니다(fail-closed). 비차단형도 캐논을 조용히 바꾸는 선택지는 기본 적용하지 않습니다(4.3절 `default_action=hold`). | FR-MSG-07, FR-ONT-14, D-14 |
| P4 | 수신은 "먼저 기록, 그다음 처리"입니다. 메신저 업데이트는 수신함에 유일 키로 넣은 뒤에만 처리합니다. 발신은 발신함을 거칩니다. | NFR-REL-01·02, ADR-011 |
| P5 | 메신저로는 요약과 짧은 발췌만 보냅니다. 전문은 인증이 필요한 웹 링크로 줍니다. 예외는 사용자가 설정 화면에서 명시적으로 켠 화 전문 첨부 하나입니다(9.7절). | NFR-SEC-04, FR-MSG-05 |
| P6 | 사람에게 보여 주는 대상은 이름이 아니라 엔티티 ID로 고정합니다. 선택지 라벨의 이름은 표시용이고 값은 `entity_id`입니다. | FR-ONT-12, D-27 |
| P7 | 웹 인박스는 항상 있는 채널입니다. 메신저가 모두 끊겨도 모든 질문에 웹에서 답할 수 있습니다. | FR-MSG-12, INV-CH-01 |

---

## 2. 모듈 경계와 흐름

### 2.1 모듈

| 모듈 | 소유 | 공개 API(application, 이름은 가정) | 쓰지 않는 것 |
|---|---|---|---|
| `hitl` | `Question`, `QuestionOption`, `QuestionLink`, `QuestionDelivery`, `Answer`, `AnswerInterpretation`, `AnswerReflection`, `Approval`, `DigestBatch`, `AnswerSession`(신규) | `createQuestion(draft)`, `requestApproval(spec)`, `acceptAnswer(input)`, `openFromWeb(question_id)`, `recordReflection(...)`, `cancelQuestion(...)` | 메신저 API, 메시지 포맷 |
| `messaging` | `Channel`, `MessengerBot`, `ChannelBindingToken`, `MessengerInbox`, `MessengerOutbox`, `ChannelAdapter` 구현 | `deliver(question_view, channel_id)`, `updateDelivery(...)`, `sendNotice(...)`, `issueBindingToken(...)` | 질문 등급·마감 판단 |
| `orchestration` | 작업 차단·재개 | `hitl`이 내는 도메인 이벤트 `QuestionAnswered`, `QuestionDefaulted`, `ApprovalDecided`를 받아 wake | → 04 |
| `ontology`·`linking` | 엔티티·언급·동일성 결정 | 판별 질문 답의 적용(`linking.confirmMention`, `ontology.applyIdentityDecision`, 이름은 → 06) | → 06 |

`hitl`과 `messaging` 사이는 채널 중립 표현 `QuestionView`(3.2절)와 수신 결과 `InboundAction`(6.1절)으로만 주고받습니다(ADR-008).

### 2.2 전체 흐름

```
agent run ──QuestionDraft──▶ hitl.createQuestion ─(grade, Q1 pending)─┐
                                                                      ▼
                       dispatcher (5절: 의존·일시정지·방해금지·상한·digest)
                                                                      │ Q2 open
              ┌──────────── QuestionDelivery(web) ◀───────────────────┤
              │             QuestionDelivery(telegram/discord) ──▶ messenger_outbox ──▶ ChannelAdapter ──▶ 메신저
              ▼                                                                                            │
         웹 인박스 답변 ──┐                         메신저 클릭·답장 ──▶ messenger_inbox(유일 키) ──▶ 처리 worker
                          ▼                                                                                │
                    hitl.acceptAnswer (CAS: Q3 answered | late | duplicate) ◀──────────────────────────────┘
                          │
            선택지형 ─────┼───── 서술형·선택지 밖 ──▶ interpret_answer(world_keeper) ──▶ 해석 확인 질문 (7절)
                          ▼
                 apply_answer / 대상 작업 wake(→ 04) ──▶ AnswerReflection(applied|not_applied) ──▶ Q6 resolved
                                                                      │
                                                     반영 통지(FR-MSG-17) ──▶ 답이 온 채널
```

### 2.3 에이전트가 질문을 만드는 계약

에이전트 실행은 구조화 출력의 `QuestionDraft`(신규, zod 스키마)로 질문을 제안하고, `hitl.createQuestion`이 검증·등급 판정·저장을 합니다. 에이전트가 `grade`를 직접 정하지 않습니다(4절).

| `QuestionDraft` 필드 | 설명 |
|---|---|
| `topic` | enum `question_topic` |
| `question_type` | enum `question_type` |
| `title`, `body` | 채널 중립 본문(Markdown 부분집합: 굵게, 목록, 인용) |
| `options[]` | `{label, value, is_recommended}`. `value`는 주제별 zod 스키마(3.4절) |
| `recommendation` | `QuestionRecommendation`(4.3절) |
| `rationale` | 추천 근거 |
| `links[]` | `{ref_type, ref_id}`. 1개 이상(INV-Q-05) |
| `preview` | `PreviewExcerpt[]`(3.5절), 선택 |
| `depends_on_question_id` | 순서 의존(FR-MSG-06) |
| `proposed_blocking_basis` | 에이전트가 판단한 기준. 판정기가 올릴 수만 있고 내릴 수 없습니다(4.2절). |

질문을 만든 실행은 질문이 `blocking`이면 `run_stop_reason=awaiting_human`으로 끝나고 대상 작업은 T7(`blocked`, `block_reason=question`)로 갑니다. `non_blocking`이면 추천안으로 잠정 진행합니다(FR-MSG-06). 잠정 진행 기록은 컨텍스트 스냅숏의 `provisional_question_ids`(03 3.3)에 남기고, 채우는 절차는 → 04입니다.

---

## 3. 채널 중립 질문 모델

필드 정의는 → 03 3.4. 이 절은 필드를 사람에게 보여 줄 구조와 주제별 규칙을 정합니다.

### 3.1 유형별 답 형태

| `question_type` | 답 `payload` | 해석 필요 | Telegram | Discord(MVP-β) | 웹 |
|---|---|---|---|---|---|
| `single_choice` | `{selected_idx:[i]}` 또는 `{text}`(선택지 밖) | 선택지형: 없음. `text`: 있음(FR-MSG-16) | 인라인 버튼(5.3절 상한), "직접 입력" 버튼 → 답장 입력 | 버튼 ≤5개, 초과는 셀렉트(≤25), "직접 입력" → 모달 | 라디오 + 자유 입력 |
| `multi_choice` | `{selected_idx:[i…]}` | 없음 | 토글 버튼 + "완료" 버튼(`AnswerSession`) | 다중 셀렉트 | 체크박스 |
| `free_text` | `{text}` | 있음 | 답장(ForceReply) | 모달 Text Input(≤4,000자) | 텍스트 영역 |
| `approve_reject` | `{selected_idx:[i]}` + 반려 시 `{rework_from, note}` | `note`는 해석하지 않음(사유로 저장) | 승인/반려 버튼 → 반려면 단계 선택 버튼 → 사유 답장 | 버튼 → 반려면 모달(셀렉트 + 사유) | 폼 |
| `attachment_review` [v1] | `approve_reject`와 같음 | 같음 | 사진 + 캡션(≤1,024자) + 버튼 | 첨부 또는 링크 + 버튼 | 이미지 뷰어 |

`approve_reject` 선택지 규약(신규): `idx=0` 승인(`approved`), `idx=1` 반려(`rejected`), `idx≥2`는 대안 결정입니다. 대안 결정은 `value.maps_to ∈ {approved, rejected}`와 `value.variant`를 가지며, 승인 객체의 `payload.decision_variant`에 남습니다. 예: 스키마 변경 승인의 "기존 `subordinate_of`의 동의어로 등록"은 `maps_to=rejected`, `variant=map_to_existing`입니다(3.6절).

### 3.2 `QuestionView` (신규)

어댑터에 넘기는 채널 중립 표현입니다. 저장하지 않고 질문 행에서 매번 만듭니다.

블록은 아래 순서로 그립니다. 웹 인박스의 키보드 포커스 순서(본문 → 추천안·근거 → 선택지 → 자유 입력 → 제출)와 단축키는 이 순서를 따르며 정의는 → 08 9.9입니다.

| 블록 | 내용 | 채널 한도를 넘을 때 |
|---|---|---|
| 머리 | `Q-<n>`, 등급 라벨(차단형/비차단형/정보성), 주제 라벨, 대상(예: "12화 씬3") | — |
| 본문 | `title`, `body` | 본문을 자르고 "전문은 웹" 링크 |
| 미리보기 | `PreviewExcerpt[]`(3.5절) | 발췌 1개만 두고 나머지는 웹 |
| 추천안·근거 | "추천: …", `rationale` | 근거를 200자(가정)로 줄임 |
| 등급 근거 | `blocking_basis` 라벨 + `grade_reason` 한 줄 | — |
| 선택지 | `QuestionOption` 라벨, 추천 표시 | 5.3절 규칙으로 버튼·셀렉트·링크 |
| 마감 | 작품 `timezone` 벽시계(00 5.5), 마감 뒤 동작("지나면 추천안 적용" / "지나도 자동 결정 안 함" / "지나면 보류") | — |
| 링크 | 웹 인박스 질문 주소 `/novels/:novelId/inbox/:questionId`, 전문 링크 | — |

### 3.3 주제 카탈로그

`question_topic`마다 기본 형태와 마감 동작을 정합니다. **기본 등급**은 4절 판정 전의 시작값입니다. 승인 질문은 모두 `approve_reject`·`blocking`·`blocking_basis=approval_gate`(또는 더 구체적인 기준)이고 승인 객체와 1:1입니다(ADR-014).

| `topic` | 만드는 주체 | 유형 | 기본 등급 / `blocking_basis` | 선택지 예 | 마감 동작 | 근거 |
|---|---|---|---|---|---|---|
| `direction` | `showrunner` | `single_choice` | `blocking` / `ending_direction`·`arc_goal` | 방향안 2~4개 | 자동 결정 안 함 | FR-HIL-07 |
| `concept_confirm` | 사용자 행위 결정적 코드(`concept.submitBriefForApproval`, 사용자 [승인 요청] 뒤 점검 통과 시. 04 2.3) | `approve_reject` (승인 `concept_brief`) | `blocking` / `approval_gate` | 승인 / 반려(사유) | 자동 결정 안 함. 마감·리마인더는 차단형 기본값(11 O-C14) | FR-NOV-08, 11 4.3 |
| `bible_confirm` | `planner` | `approve_reject` | `blocking` / `approval_gate` (승인 `series_bible`) | 승인 / 반려 | 자동 결정 안 함 | FR-NOV-06 |
| `character_fate` | `writer`·`planner` | `single_choice` | 주요 인물이면 `blocking` / `major_character_fate`, 아니면 `non_blocking` | 살린다 / 죽인다 / 중상 | 차단형: 안 함, 비차단형: 추천안 | FR-HIL-07, 5.4절 시나리오 |
| `creative_choice` | 모든 역할 | `single_choice`·`free_text` | `non_blocking` / `none`. 캐논에 닿으면 `blocking` / `canon_change` | 조연 이름 후보 3개 | 추천안 | FR-MSG-06 |
| `setup_due` | `foreshadow_manager` | `single_choice` | 중요도 `high` 또는 아크 마지막 화 계획 전이면 `blocking` / `setup_due_high`, 아니면 `non_blocking` | 기한 N화 연장 / 회수 위치 지정 / 폐기 | 비차단형: "N화 연장" 적용. 폐기는 기본 적용 대상 아님(INV-Q-04) | FR-FOR-04 |
| `setup_abandon` | `foreshadow_manager` | `approve_reject` (승인 `setup_abandon`) | `blocking` / `approval_gate` | 폐기 승인 / 반려 | 자동 결정 안 함 | FR-FOR-06, INV-SU-02 |
| `entity_disambiguation` | `linking`(링커 L7) | `single_choice` | `non_blocking` / `none`. `published_locked` 사실·`high` 이슈에 닿으면 `blocking` / `published_canon` | 후보 엔티티들 / 칭호 자체 / 새 인물 / 엔티티 아님 | `hold`(연결 보류, 사실은 `candidate` 유지) | FR-ONT-14, 7.5 `linking.disambiguation_question_grade` |
| `duplicate_entity` | `world_keeper`(`dedupe_entities`) | `single_choice` | `non_blocking` / `none` | 같은 대상 / 다른 대상 / 보류 | `hold` | FR-ONT-15 |
| `identity_change` | `world_keeper` | 캐논 영향 없음·`approved`(미공개) 사실 영향: `single_choice`(`canon_change` 승인을 따로 받지 않음, 06 3.11 승인 규칙); `published_locked` 영향: `approve_reject`(승인 `identity_change`) | 순서대로 `non_blocking` / `blocking`·`published_canon` | 병합 적용 / 적용 안 함 | `hold` | FR-ONT-16·17, ADR-006 |
| `schema_change` | `world_keeper` | `approve_reject` (승인 `schema_change`) | `blocking` / `approval_gate` | 새 항목 추가 / 반려 / 기존 항목의 동의어로(대안 결정) | 자동 결정 안 함 | FR-ONT-18 |
| `interpretation_confirm` | `world_keeper` | `single_choice` | 원 질문과 같은 등급·기준 | 맞습니다 / 고칠게요(직접 입력) / 취소 | 비차단형도 `hold`(서술형은 확인 없이 캐논 불가, INV-AI-01) | FR-MSG-16 |
| `followup` | `world_keeper` | 원 질문 유형 | 원 질문과 같은 등급 | 주제별 | 원 질문 주제의 마감 동작 | FR-MSG-16 |
| `approval_gate` | 게이트 소유 모듈 | `approve_reject` | `blocking` / `approval_gate` | 10절 표 | 자동 결정 안 함(v1 부재 위임 예외) | FR-HIL-02 |
| `rewrite_limit` | `showrunner` | `single_choice` | `blocking` / `rewrite_limit` | 원인에 따라 다릅니다. 검사 상한(07 5.3 GC-3): 사람 직접 수정 / 이슈 허용(사람만) / 아웃라인부터 재작성(상한 1회 추가) / 보류. 반려 상한(INV-EP-05, 03 E12): 재기획 / 사람 직접 수정 / 보류 | 자동 결정 안 함 | FR-AGT-12, FR-ONT-06 |
| `extraction_failure` | `world_keeper` | `single_choice` | `blocking` / `system_failure` | 다시 시도 / 웹에서 사실 직접 입력 / 보류 | 자동 결정 안 함 | 5.7절 |
| `budget` | `budget_guard` | `approve_reject` (승인 `budget_resume`), 상한 계산 불가 호출은 `single_choice` | `blocking` / `budget` | 재개 승인(한도 상향 입력) / 정지 유지 | 자동 결정 안 함, 위임 불가(INV-APR-03) | FR-BUD-02·03 |
| `provider_outage` | `health_check` | `single_choice` | `blocking` / `system_failure` | 연결 점검 다시 실행 / 정지 유지 | 자동 결정 안 함 | 5.7절, FR-SET-03 |
| `retcon` | `continuity_editor`·`hitl`(늦은 답변) | `approve_reject` (승인 `retcon`) | `blocking` / `published_canon` | 리트콘 승인 / 반려 | 자동 결정 안 함, 위임 불가 | FR-ONT-07, FR-MSG-08 |
| `late_answer_conflict` | `hitl` | `single_choice` | `non_blocking` / `none` | 수정 요청 만들기 / 무시 | `hold`(`pending_user_choice` 유지) | FR-MSG-08 (MVP-α) |
| `publish_batch` | `publisher` | `approve_reject` (승인 `publish_batch`) | `blocking` / `approval_gate`. 발송은 주 1회 `publish_batch` digest(5.2절 예외) | 모두 공개 처리 / 화별 선택(웹) / 보류 | 자동 결정 안 함 | D-24 |
| `media_gate` [v1] | `visual_producer` | `attachment_review`·`approve_reject`(승인 `character_sheet`·`media_quote`·`draft_adoption`) | `blocking` / `approval_gate` | 채택 / 반려 | 자동 결정 안 함 | FR-SPX-09, D-25 |
| `safety_review` [v1] | `scene_director` | `approve_reject` (승인 `safety_review`) | `blocking` / `safety_review` | 생성 허용 / 순화 / 생략 | 자동 결정 안 함 | FR-SPX-04·09 |

정보성 알림(예산 소프트 경고, 공급자 대체 사용 알림, 반영 완료 요약)은 `grade=informational`로 만들고 주제는 원인 영역의 주제를 씁니다(예: 소프트 경고는 `budget`). 정보성은 선택지가 없고 Q7로 종결합니다.

### 3.4 선택지 값 스키마

`QuestionOption.value`(jsonb)는 주제별 zod 스키마로 검증합니다. 모든 값은 ID를 담고, 라벨 문자열을 값으로 쓰지 않습니다(P6).

| 주제 | `value` 형태 (신규 스키마 이름) |
|---|---|
| `entity_disambiguation` | `EntityCandidateValue`: `{kind:"entity", entity_id, matched_name_id, holder_basis?}` / `{kind:"title_itself", entity_id}` / `{kind:"new_entity"}` / `{kind:"not_entity"}` / `{kind:"hold"}` |
| `duplicate_entity` | `{kind:"same"}` / `{kind:"distinct"}` / `{kind:"hold"}` + 질문 링크에 두 `entity_id` |
| `identity_change` | `{kind:"apply", identity_decision_id}` / `{kind:"reject", identity_decision_id}` |
| `setup_due` | `{kind:"extend", to_due_episode_no}` / `{kind:"assign", episode_no}` / `{kind:"abandon"}` |
| `rewrite_limit` | 공통: `{kind:"human_edit"}` / `{kind:"hold"}`. 검사 상한(GC-3)만: `{kind:"waive_issue", continuity_issue_ids}`(사람만, INV-CI-03. `published_canon_conflict` 이슈는 선택지에 넣지 않음, INV-CI-04) / `{kind:"replan_from_outline"}`(아웃라인부터 재작성, 자동 재작성 상한 1회 추가). 반려 상한(INV-EP-05)만: `{kind:"replan"}`. 원인은 질문 링크(`ref_type=continuity_issue` 있으면 GC-3, 없으면 반려 상한)로 구분합니다(→ 07 5.3 GC-3, 8.1) |
| 그 밖 | `{kind:"choice", key}`(주제별 키) |

### 3.5 미리보기 `PreviewExcerpt` (신규)

원고 속 위치를 근거로 묻는 질문(판별, 연속성, 화 승인)은 발췌를 붙입니다.

| 필드 | 설명 |
|---|---|
| `manuscript_version_id`, `scene_id`, `char_start`, `char_end` | 원문 위치. 발췌 생성 시점 버전으로 고정 |
| `text` | 발췌문. 언급이 든 문장 하나를 기본으로 앞뒤 문장을 더해 `question.preview_max_chars`(160자, 00 7.4) 이내 |
| `highlight` | 발췌 안의 언급 구간(`[start,end)`). Telegram은 굵게, Discord는 `**`, 웹은 형광 표시 |
| `speaker_entity_id`, `pov_entity_id` | 화자·시점 인물(링커 L1 결과). 표시는 대표명 |
| `story_point`, `timeline_id` | "40화 씬2, T1" 표기용 |

발췌는 메신저 서버에 원고 일부가 남는다는 뜻이므로 길이를 제한하고, 설정 화면의 외부 전송 범위 안내(NFR-SEC-04, FR-SET-01)에 "판별 질문의 원고 발췌(최대 N자)"를 포함합니다.

### 3.6 엔티티 판별 질문 (FR-ONT-14·15·16·17, D-27)

링커가 자동 확정하지 못한 언급을 사람에게 묻는 질문입니다. 언제 넘기는지(임계값·무조건 질문 조건)는 → 06, 이 절은 질문의 모양과 답의 효과를 정합니다.

#### 3.6.1 넘기는 방식

| 링커 결과(→ 06) | 질문 | 묶음 |
|---|---|---|
| `confidence < linking.tau_ask`, 경합(1·2위 차 < `linking.margin_delta`), 샘플 불일치 | `entity_disambiguation` 개별 질문 | 묶음 키 (`scene_id`, `chain_key`, `normalized_key`, 후보 집합)가 같은 언급들을 질문 1건으로 묶습니다(06 3.10 묶기 규칙). `zero`·`pronoun`·`descriptive` 언급은 `chain_key`가 같을 때만 묶고, 씬을 넘는 묶음은 06 3.10 조건일 때만 만들며 후보 집합에 `confusable_with` 쌍이 있으면 씬을 넘지 않습니다. 질문 링크(`ref_type=mention`)를 모두 겁니다. |
| `tau_ask ≤ confidence < tau_auto`(리포트 보류) | 질문 없음 | 화 검수 리포트(웹)와 화 승인 질문 `payload`의 미확정 언급 수(10.2절)로만 표시합니다(→ 06 3.9·3.10). 질문 수(R-5)와 일일 상한 집계에 들어가지 않습니다. |
| `new_entity_candidate`이고 유사 엔티티 있음(`dedup.similar_entity_min_score`) | `duplicate_entity` | 후보 쌍마다 1건 |
| 병합·분리 제안, 정체 공개 방향 연결, `confusable_with` 쌍 | `identity_change` 또는 `entity_disambiguation`(자동 확정 금지). 등급은 `non_blocking`이고, 아래 행 조건일 때만 `blocking`입니다(06 3.9) | 제안 1건당 1건 |
| `published_locked` 사실 또는 `high` 이슈에 닿음 | 위 질문을 `blocking` / `published_canon`으로 | 묶지 않음 |

#### 3.6.2 선택지 구성

| 순서 | 선택지 | 라벨 규칙 | 값 |
|---|---|---|---|
| 1~k | 후보 엔티티(추천을 첫째로, 나머지는 점수 순) | `대표명 (판별 정보)`. 판별 정보는 그 `story_point`·시간선 기준으로 (a) 맞은 이름의 유형과 유효 범위("폐하 칭호 보유 40화~") (b) 핵심 사실 1개("39화 사망", "청람 길드 분석관") (c) `candidate` 사실이면 "(미확정)" 표시. 작중 비공개 이름(`visibility=secret`)은 "(작중 비공개)"를 붙입니다. | `{kind:"entity", entity_id, matched_name_id}` |
| k+1 | 칭호 자체 | 표기가 `title` 유형 엔티티의 이름이고 특정 보유자가 아닐 때("폐하의 자리는 비어 있었다") | `{kind:"title_itself", entity_id}` |
| k+2 | 새 인물·대상 | 이름 사전에 없는 대상 | `{kind:"new_entity"}` |
| k+3 | 엔티티 아님 | 비유·일반 명사(G16) | `{kind:"not_entity"}` |
| — | 직접 입력 | 자유 문장("둘 다 아니고 섭정 윤씨야") → 7절 해석. 답변 속 표기도 같은 링커로 연결합니다(G21). | `{text}` |
| — | 다른 후보(웹) | 메신저 선택지 상한(`question.messenger_max_entity_options`, 4, 00 7.4) 초과분 | 웹 링크 |
| — | 묶음 나누기(웹) | 언급 2개 이상을 묶은 질문에만 둡니다. 웹에서 묶인 언급의 씬·화자·인용 목록을 보고 언급마다 다른 답을 고릅니다(06 3.10) | 웹 링크 |

#### 3.6.3 예: "이 '폐하'는 누구입니까?"

가정: 왕정 판타지 예시 작품. 선왕 이헌이 39화에 죽고 이준이 40화 씬1에 즉위합니다. 40화 씬2 대사의 "폐하"를 링커가 후보 경합으로 넘겼습니다.

```
Q-141 · 비차단형 · 언급 판별 · 40화 씬2 (T1)
화자 한서윤 / 시점 인물 강도현

"그날 밤 **폐하**께서 이미 알고 계셨다는 말입니까?"

이 '폐하'는 누구입니까?
추천: 이헌 (선왕) — 대사가 과거 사건(38화)을 가리킴. 신뢰도 0.52, 1·2위 차 0.08
판정: 비차단형 (공개 사실 영향 없음)
마감 10/28 21:00 · 지나면 연결을 보류합니다(캐논에 넣지 않음)

[1. 이헌 (선왕, 폐하 ~39화, 39화 사망)]
[2. 이준 (새 왕, 폐하 40화~)]
[3. 칭호 자체]  [4. 새 인물]  [5. 엔티티 아님]
[직접 입력]  [웹에서 보기]
```

이 질문은 "폐하" 문자열이 아니라 `holds_title` 사실(→ 06)에서 40화 씬2 시점 전후 보유자를 후보로 뽑았기 때문에 선왕과 새 왕이 따로 나옵니다. 사용자가 1을 고르면 그 언급은 `ent_…(이헌)`에 연결되고, 대사에서 나온 사실 후보는 이헌을 주어로 갖습니다.

#### 3.6.4 답의 효과

| 답 | 언급(`Mention`) | 사실 | 그 밖 | `reflection_change_kind` |
|---|---|---|---|---|
| 후보 엔티티 | 묶음의 모든 언급 `confirmed`, `linked_entity_id` 설정 | 그 언급에서 나온 `candidate` 사실이 게이트 규칙을 다시 탑니다. 화가 이미 승인·공개된 뒤면 판별 후 늦은 승격(→ 06 6.4, 07 4.6 LB-3) | 같은 (표기, 화자) → 같은 엔티티 확정이 `linking.rule_proposal_min_confirmations`(2, 00 7.5)회 쌓이면 이름 사전 규칙 등록 제안 질문(비차단형, 기본 "등록 안 함"). 그 `normalized_key`를 가진 `active` 엔티티가 2개 이상이면 제안하지 않습니다(06 3.7) | `fact_changed` 또는 `no_change`, 규칙 등록 시 `entity_name_rule` |
| 칭호 자체 | `confirmed`, `linked_entity_id`=칭호 엔티티 | 보유자 사실이 아니라 칭호 엔티티의 사실로 | — | `fact_changed` |
| 새 인물 | `new_entity_candidate` | `candidate` 유지 | `Entity(status=candidate)` 생성 후 중복 검사 → 필요하면 `duplicate_entity` 질문 | `fact_created` |
| 엔티티 아님 | `rejected` | 그 언급에서 나온 엔티티 참조 사실 `rejected` | — | `no_change` |
| 보류·마감 | `ambiguous` 유지 | `candidate` 유지, 캐논 승격 대상에서 제외(F3 가드, → 06) | 인박스 "보류된 판별" 목록에 남음 | `no_change`(사유 "보류") |
| 직접 입력 | 7절 해석 → 확인 후 위 행 중 하나 | 같음 | — | 같음 |

`duplicate_entity`의 "같은 대상"은 `IdentityDecision(kind=merge, status=proposed)`을 만들고, 영향 범위에 따라 `identity_change` 질문으로 이어집니다(같은 대상이라는 판단과 병합 적용을 나눕니다. 병합은 참조를 옮기므로 영향 목록을 보여 준 뒤 적용). "다른 대상"은 `confirm_distinct`로 기록해 이후 중복 후보에서 뺍니다(→ 06).

#### 3.6.5 질문 수 통제 (R-5)

- 묶음 규칙(3.6.1)과 규칙 등록 제안으로 같은 질문을 반복하지 않습니다.
- 판별 질문은 `non_blocking`이라 일일 상한(`question.daily_cap_non_blocking`)에 포함됩니다. 상한 초과와 적체는 06 3.10 "상한 초과와 적체"와 한 규칙입니다. 그날 만들 판별 질문 후보를 우선순위 점수 순으로 상한까지만 질문으로 만들고, 나머지는 질문을 만들지 않고 리포트 보류(3.6.1절 둘째 행)로 보냅니다. 그 사실은 그동안 `candidate`로 남습니다(진행은 막지 않음).
- 리포트 보류 항목이 `linking.report_hold_digest_days`(가정 3일) 동안 처리되지 않으면 비차단형 digest(5.2절)에 "추천 연결 n건 일괄 수락 / 웹에서 검토" 항목 1건(표본 3건)을 넣습니다. 일괄 수락은 사용자 행동이므로 언급은 `confirmed`(주체 `user`)입니다.
- 적체 지표 `linking.pending_backlog`가 `linking.backlog_alert`(가정 50)를 넘으면 다음 화 아웃라인 전에 정보성 알림을 보냅니다(지표 정의 → 06 3.10).
- KPI "화당 전체 질문 수"(PRD 9절)에 판별 질문을 포함할지는 11절 미결 13.

### 3.7 컨셉 대화와 질문 모델의 경계 (→ 11 4절)

컨셉 대화 턴(`concept_partner`가 묻는 슬롯 질문)은 **`Question`이 아닙니다**. `ConceptSession`의 `ConceptMessage`로 둡니다. 컨셉 턴을 `Question`으로 만들면 인박스·일일 상한(`question.daily_cap_non_blocking`)을 바로 소진하고 질문마다 반영 기록·통지가 붙어 대화가 끊기기 때문입니다. 최종 승인만 `Approval(concept_brief)` + `approve_reject` 질문(ADR-014)입니다.

| 구분 | 컨셉 대화 턴 | 컨셉 승인 |
|---|---|---|
| 객체 | `ConceptSession` + `ConceptMessage` | `Approval(approval_type=concept_brief)` + `Question` 1:1 |
| 등급·digest·일일 상한·방해금지·마감 | 해당 없음. 사용자가 먼저 말한 턴의 응답은 방해금지 시간에도 보냄. 휴면 리마인더 1회(`concept.idle_reminder_hours`)만 방해금지를 따름 | `blocking`, `blocking_basis=approval_gate`, `topic=concept_confirm`. 5.5 마감·리마인더 그대로, 자동 결정 없음 |
| 인박스(FR-UI-03) | 표시하지 않음. 작품 홈에 "컨셉 대화 진행 중" 카드 | 표시 |
| 답 채택 | 경합 없음. 웹·메신저 입력을 서버 수신 순(`seq`)으로 모두 기록하고 다음 턴이 함께 처리 | 6.2 첫 유효 답 채택 |
| 반영 기록 | `ConceptMessage.slot_updates`(`AnswerReflection` 아님) | `approval.decided`. 반영 기록은 `answer_reflection_items`에 `ref_type=concept_brief`(가정, 11 O-C15) |
| 발신 | `outbox_kind=concept_message`(9.4) | `question`(5.4 차단형 팬아웃: 웹 + 모든 `active` 메신저) |
| 반려 사유 입력 | — | 기존 `AnswerSession(enter_reason)`(6.3) |

**메신저에서 이어 하기**(Telegram MVP-α, Discord MVP-β): 웹 "Telegram에서 이어 하기"를 누르면 현재 에이전트 질문을 그 채널로 보내고 세션 `active_channel_id`를 바꿉니다. 메신저에서는 에이전트 턴 1개 = 메시지 1통 = 질문 1개이고(`concept.reply_max_chars` 1,200 이내), 고정 버튼 [직접 입력] [추천해 줘] [나중에](선택 슬롯만) [이대로 정리] [전부 맡기기] [요약 보기](예약 `idx` 900~905, 5.3)를 붙입니다. [요약 보기]는 `local_trusted`에서 휴대폰이 웹을 열 수 없으므로(9.7) 필수 필드 요약을 메시지(`concept.messenger_summary_max_chars` 3,500)로 보냅니다. 에이전트 응답은 웹(항상) + `active_channel_id`가 메신저면 그 채널에만 보냅니다. 버튼 형식은 5.3, 일반 문장 라우팅은 6.4, 수신 기록은 6.1 파이프라인(수신함 먼저, `ConceptMessage.inbox_id`, `dedupe_key`로 1회 반영)을 따릅니다.

---

## 4. 등급 판정 (FR-HIL-07, FR-HIL-06)

### 4.1 절차

`showrunner`가 판정 주체입니다(Q1 주체). 구현은 결정적 규칙과 LLM 판단의 조합이며, 판정은 올리기만 합니다.

| 단계 | 내용 | 결과 |
|---|---|---|
| G1 주제 기본값 | 3.3절 표의 기본 등급·기준 | 시작값 |
| G2 결정적 상향 규칙 | 질문 링크와 선택지 효과를 보고 FR-HIL-07 기준에 닿는지 검사(4.2절) | 해당하면 `blocking` + 기준 |
| G3 LLM 판단 | `grade_question` 작업. 결정 내용이 결말 방향·아크 목표·주요 인물 생사에 닿는지 구조화 출력으로 판단 | 상향만 반영 |
| G4 에이전트 제안 | `QuestionDraft.proposed_blocking_basis` | 상향만 반영 |
| G5 기록 | 가장 높은 결과를 `grade`, `blocking_basis`로, 단계별 근거를 `grade_reason`에 한 줄로 | INV-Q-01 |

G2~G4 중 하나라도 `blocking`이면 `blocking`입니다. G3이 실패하면 G1·G2·G4 결과로 판정하고 `grade_reason`에 "LLM 판정 실패"를 남깁니다(판정 실패로 질문이 막히지 않게 합니다).

### 4.2 결정적 상향 규칙

| 규칙 | 조건 | `blocking_basis` |
|---|---|---|
| U1 캐논 변경 | 선택지 효과가 `canon_status ∈ {approved, published_locked}` 사실·떡밥을 바꿈. 동일성 결정(병합·분리·재연결)이 `approved`(미공개) 사실의 주어·목적어 ID만 옮기는 경우는 제외합니다(06 3.11 승인 규칙) | `canon_change` (공개 사실이면 `published_canon`) |
| U2 공개 사실 영향 | 질문 링크(언급·사실)가 `published_locked` 사실에 닿거나 `high` 연속성 이슈의 근거 | `published_canon` |
| U3 주요 인물 생사 | 링크된 인물 엔티티가 주요 인물이고 선택지에 `state`(생사) 사실 변경이 있음. 주요 인물 판정 근거는 11절 미결 8 | `major_character_fate` |
| U4 결말·아크 목표 | 링크가 `Goal.ending_direction`, `Arc` 목표 필드 | `ending_direction` / `arc_goal` |
| U5 예산 | 선택지가 한도·예약 정책을 바꿈 | `budget` |
| U6 승인 | 승인 객체와 연결된 질문 | `approval_gate`(또는 승인 유형별 기준) |
| U7 떡밥 기한 | `setup_due`이고 중요도 `high` 또는 아크 마지막 화 계획 전 | `setup_due_high` |

골든 시나리오: FR-HIL-07 다섯 기준마다 비차단형으로 만들려는 초안을 넣고 결과가 `blocking`인지 검사합니다(`packages/test-kit`, → 09).

### 4.3 추천안과 마감 동작 `QuestionRecommendation` (신규 jsonb 스키마)

`questions.recommendation`의 구조입니다.

| 필드 | 설명 |
|---|---|
| `option_idx` / `text` | 추천 선택지 또는 추천 문장 |
| `default_action` | 비차단형 마감 때 할 일. `apply` 추천안 적용(Q4 `defaulted`), `hold` 아무것도 확정하지 않고 보류 |
| `provisional` | 추천안으로 잠정 진행했는지(FR-MSG-06). 진행한 실행 ID는 → 04 |

`default_action=hold`인 주제: `entity_disambiguation`, `duplicate_entity`, `identity_change`, `interpretation_confirm`, `late_answer_conflict`. 이 주제의 비차단형 질문이 마감을 넘기면 Q4 `defaulted` + `resolution_source=deadline_hold`(00 6.4) + 반영 기록 `not_applied`(사유 "마감 경과, 보류")로 처리하고 질문은 Q6 `resolved`가 됩니다. 보류된 언급·제안은 웹 인박스 "보류 목록"에서 다시 결정할 수 있고, 그 결정은 새 질문 없이 웹 편집(FR-HIL-04)으로 기록합니다. 이 규칙은 → 03 4.4 INV-Q-06, Q4 `resolution_source` 구분입니다(11절 미결 5 해소).

### 4.4 질문 민감도 (FR-HIL-06, v1)

MVP는 `question_threshold=normal` 고정입니다(00 6.1). v1 규칙:

| 값 | 비차단형 `creative_choice` | 비차단형 `setup_due` | 판별·중복 질문 | 차단형 |
|---|---|---|---|---|
| `minimal` | 묻지 않고 추천안 적용 + 정보성 요약 | 묻기 | 묻기(링킹 정확도 우선, R-18) | 변화 없음 |
| `normal` | 묻기 | 묻기 | 묻기 | 변화 없음 |
| `detailed` | 묻기 + 신뢰도 낮은 결정도 질문화(→ 04 기준) | 묻기 | 묻기 + 검수 구간 언급도 개별 질문 | 변화 없음 |

---

## 5. 발송 스케줄

### 5.1 디스패처

스케줄러(`system:scheduler`)가 `pending` 질문을 `question.dispatch_interval_seconds`(30초, 00 7.4) 주기로 검사하고, 질문 생성 이벤트에서도 즉시 한 번 실행합니다.

| 순서 | 검사 | 통과 못 하면 |
|---|---|---|
| D1 의존 | `depends_on_question_id`가 `resolved`가 아니면 대기 | `pending` 유지 |
| D2 질문 일시정지 | `NotificationPolicy.questions_paused=true`면 모든 등급 대기(차단형 포함, 03 3.1 "대기열 유지") | `pending` 유지, 웹 인박스에는 "발송 대기"로 표시 |
| D3 등급별 경로 | 차단형: 즉시. 비차단형: `DigestBatch(kind=non_blocking_digest)`에 넣음(5.2절). 정보성: `daily_summary`에 넣음 | — |
| D4 방해금지 | 작품 `timezone`의 방해금지 구간이면 메신저 발송 대기. 긴급 예외(`urgent_exception_enabled`)가 켜져 있고 주제가 `budget`(하드 한도) 또는 보안 이벤트면 발송 | 메신저 대기 |
| D5 일일 상한 | 비차단형만. 당일(작품 `timezone`) 발송한 비차단형 수가 `daily_cap_non_blocking` 이상이면 다음 날 첫 digest로 넘김 | 다음 digest |
| D6 채널 선택 | 5.4절 | — |
| D7 게시 | 웹 `QuestionDelivery`를 `posted`로, 메신저 `QuestionDelivery(pending)` + `messenger_outbox(kind=question 또는 digest)` 생성. 같은 트랜잭션에서 Q2(`open`), `sent_at`, 마감 재계산(5.5절) | — |

웹 인박스는 `pending` 질문도 "발송 대기"로 보여 줍니다. 사용자가 웹에서 "지금 답하기"를 누르면 D2~D5를 건너뛰고 D7을 바로 수행한 뒤 답을 받습니다(사용자가 먼저 연 것이므로 방해가 아님). 이 경로는 03 4.4 Q2 (b)(주체 `user`)입니다.

### 5.2 Digest (FR-MSG-06)

| 항목 | 규칙 |
|---|---|
| 열기 | 채널에 `collecting` 묶음이 없을 때 비차단형 질문이 들어오면 `DigestBatch(non_blocking_digest)`를 열고 `window_end_at = now + digest_window_minutes` |
| 닫기 | `window_end_at` 도달 또는 항목 수가 `digest_max_items`에 닿으면 발송. 방해금지 중이면 종료 시각까지 `collecting` 유지 |
| 넘침 | 방해금지 동안 쌓여 `digest_max_items`를 넘으면 여러 묶음으로 나눠 순서대로 발송(채널 rate limit 준수) |
| 의존 | 서로 의존하는 질문은 같은 묶음에 넣지 않습니다. 선행 질문이 `resolved`가 된 뒤 다음 묶음에 들어갑니다(D1). |
| 반영 통지 | 비차단형 답의 반영 통지(FR-MSG-17)는 다음 digest 머리에 "반영 완료 n건"으로 붙습니다. 24시간 안에 digest가 없으면 일일 요약에 넣습니다. |
| 메시지 모양 | 묶음 1통에 질문마다 번호·제목·추천안·버튼 행. Telegram은 메시지 1통에 질문별 버튼 행, 한도를 넘으면 질문당 1통으로 나눕니다(같은 `DigestBatch`). |
| 취소 | 발송 전에 묶음의 질문이 모두 닫히면 `cancelled` |
| `publish_batch` | `full_auto`·`publish_policy=batch_question`일 때 `question.publish_batch_weekday`에 공개 처리 승인 질문 1건을 `digest_kind=publish_batch`로 보냅니다. 승인 질문이라 `blocking`이지만 즉시 발송 규칙의 예외입니다(기다리는 작업이 없음). |

`daily_summary`(정보성 요약)는 `question.daily_summary_time`에 1통: 전날 진행(승인·공개 화, 비축분), 정보성 알림, 마감 경과로 적용된 추천안 목록, 보류된 판별 건수, 예산 소진율.

`DigestBatch` 상태 전이(신규 ID):

| # | from | to | 트리거 | 주체 |
|---|---|---|---|---|
| DG1 | (생성) | `collecting` | 첫 항목 | `system:scheduler` |
| DG2 | `collecting` | `sent` | 닫기 조건 + D4·D5 통과, 발신함 행 생성 | `system:messenger` |
| DG3 | `collecting` | `cancelled` | 항목이 모두 닫힘 | `system:scheduler` |

### 5.3 채널 UI 변환 (FR-MSG-04)

| 상황 | Telegram | Discord | 웹 |
|---|---|---|---|
| 선택지 ≤ 5 | 인라인 버튼(한 행 1~2개) | 버튼 행 1개(행당 5개) | 라디오 |
| 선택지 6~8 | 인라인 버튼 여러 행 | 셀렉트(≤25) | 라디오 |
| 선택지 > 8 또는 라벨 > 40자(가정) | 상위 4개 + "웹에서 보기" | 셀렉트(≤25), 초과면 웹 링크 | 전체 |
| 본문 > 한도 | 4,096자(사진 캡션 1,024자) 안으로 자르고 링크 | 2,000자 [2차] 안으로 자르고 링크 | 전체 |
| 서술형 입력 | ForceReply 답장 | 모달 Text Input(≤4,000자) | 텍스트 영역 |
| 첨부 | 50MB 이하 업로드, 초과는 링크 | 봇 첨부 한도 [미확인] → 기본 링크 | 뷰어 |

상한 값(8개, 40자)은 `question.buttons_max_options`, `question.option_label_max_chars`(00 7.4, 가정)입니다.

**버튼 데이터 `callback_payload`** (신규 형식): `v1|<action>|<question_id>|<idx>`. `action`은 `a`(선택지 답), `t`(직접 입력 시작), `r`(반려 단계 진행), `m`(다중 선택 토글), `d`(다중 선택 완료), `c`(컨셉 대화 선택지, 3.7절). `c`일 때 세 번째 칸은 질문 ID가 아니라 `concept_session_id`(`cns_…`)이고 `idx`는 그 세션 **마지막 에이전트 메시지**의 선택지 번호입니다. 예약 `idx`: 900 직접 입력(ForceReply), 901 추천해 줘, 902 나중에, 903 요약 보기, 904 이대로 정리, 905 전부 맡기기, 906 상한 올리기(웹 안내만), 907 폼으로 마저 입력. 906·907·902는 `paused(budget_limit)` 안내 메시지(6.4)에도 붙습니다. **오래된 버튼 판정**(`c`): 다음 두 조건을 모두 만족할 때만 유효합니다. (1) 눌린 메시지의 provider 메시지 ID(Telegram `callback_query.message.message_id`, Discord interaction `message.id`)가 그 세션 마지막 에이전트 메시지(`is_superseded=false`)의 `provider_message_ref`와 같음. 상한 안내 버튼(906·907·902)은 마지막 `kind=notice` 상한 안내 메시지와 대조하고 세션이 아직 `paused(budget_limit)`여야 함 (2) 그 메시지 `seq` 뒤에 사용자 메시지가 없음(웹에서 먼저 답했으면 무효). 어긋나면 "지난 질문의 버튼입니다(이미 답했거나 새 질문이 있습니다)"로 답하고 `ignored/unsupported`로 둡니다(11 4.2). `callback_data`에는 메시지 ID를 넣지 않습니다. 최대 길이: `v1|a|qst_` + 26자 ULID + `|` + 최대 3자리 = 40바이트로 Telegram 64바이트, Discord `custom_id` 100자 안에 듭니다. 서명은 넣지 않습니다(허용 사용자 검사와 서버 상태 검사로 충분, 6.1절). 형식 버전 `v1`은 바뀌면 이전 버튼을 "만료된 버튼"으로 안내합니다.

### 5.4 채널 선택 (FR-MSG-10 채널 우선순위)

| 대상 | 보낼 채널 |
|---|---|
| 차단형 질문 | 웹 + `active`인 모든 메신저 채널(팬아웃). 어느 쪽 답이든 같은 질문 ID(FR-MSG-01) |
| 비차단형 digest, 일일 요약, 리마인더 | 웹 + `channel_priority`에서 `active`인 첫 메신저 채널 1개 |
| 반영 통지 | 답이 온 채널(웹 답이면 웹만, FR-MSG-17) |
| 장애 알림(5.7절) | `active` 채널 전부 + 작품 홈 배너. 메신저가 모두 끊겼으면 웹만 |

채널이 `degraded`·`disconnected`가 되면 그 채널의 미발송 발신함 행은 `cancelled`하고, 열린 질문은 다음 우선순위 채널로 다시 냅니다(이미 다른 채널에 게시된 질문은 다시 내지 않음). 재연결되면 열린 질문을 그 채널에 일괄 게시합니다(5.7절 "재연결 후 대기 질문 일괄 발송").

### 5.5 마감과 리마인더 (FR-MSG-07, D-14)

| 항목 | 규칙 |
|---|---|
| 마감 계산 | 생성 때 `deadline_at = created_at + deadline_hours_<grade>`로 임시 저장(03 필수 필드), D7 게시 때 `max(기존, sent_at + deadline_hours_<grade>)`로 다시 계산. 방해금지·상한으로 늦게 나간 질문이 짧은 마감을 받지 않게 합니다. |
| 비차단형 마감 | 스케줄러가 `deadline_at < now()`인 `open` 비차단형을 찾아 Q4. `default_action=apply`면 추천안을 답처럼 반영(`resolution_source=default_applied`), `hold`면 `resolution_source=deadline_hold` + 반영 기록 `not_applied`(4.3절) |
| 차단형 마감 | 상태는 `open` 유지(fail-closed, INV-Q-02). `reminder_offsets_minutes`(기본 `{0, 1440}`) 시점마다 리마인더. 방해금지 중이면 종료 직후로 미룸 |
| 리마인더 모양 | 원 메시지에 답장(Telegram `reply_to_message_id`, Discord 메시지 참조)으로 "Q-128 답변 대기 중, 마감 지남(12시간 전). 12화 작업만 정지, 다른 작업은 진행 중" + 같은 버튼 |
| 리마인더 후 | 정해진 횟수를 다 보내면 더 보내지 않고, 일일 요약에 "답변 대기 차단형 n건"으로 계속 표시 |
| 부재 모드 [v1] | 위임 유형에 해당하는 차단형은 마감 때 Q5(`absence_delegated`). 리트콘·결말 변경·예산 증액은 제외(INV-APR-03). 복귀 시 `absence_summary` digest |

### 5.6 질문 취소

대상 작업이 취소되거나(T11) 다른 질문으로 대체되면 Q8. 게시된 메신저 메시지는 "취소됨: 사유"로 고치고 버튼을 지웁니다. 이때 `QuestionDelivery.state`는 `withdrawn`(00 6.4, QD6)입니다.

---

## 6. 답변 수신과 경합

### 6.1 수신 파이프라인 (NFR-REL-02, INV-IN-01)

| 단계 | 내용 | 실패 시 |
|---|---|---|
| I1 수신 기록 | 공급자 이벤트를 `messenger_inbox`에 `dedupe_key=<channel_kind>:<bot_id>:<provider_event_id>`(00 5.4)로 `INSERT … ON CONFLICT DO NOTHING`. 충돌이면 이미 받은 것이므로 끝 | 기록 실패면 공급자에 실패 응답(webhook) 또는 offset을 넘기지 않음(polling) |
| I2 즉시 응답 | 버튼 클릭이면 공급자 ACK(Telegram `answerCallbackQuery`, Discord `deferUpdate`)를 I1 직후 보냅니다. 처리는 비동기(NFR-PERF-02) | ACK 실패는 기록만 |
| I3 바인딩 확인 | `external_chat_ref`로 `Channel`을 찾고 `novel_id`·`channel_id`를 채움. 없으면 `/start` 바인딩 경로(9.1절) 외에는 `ignored/unbound_chat` | — |
| I4 허용 사용자 | `sender_external_ref ∈ allowed_user_refs`가 아니면 `ignored/unauthorized` + `channel.unauthorized_input` 감사 이벤트(INV-CH-02, NFR-SEC-01) | — |
| I5 해석 | `InboundAction`(신규)으로 정규화: `answer_option`, `answer_text`, `start_text_input`, `session_step`, `command`, `unrelated_text` | 형식 오류는 `ignored/unsupported` |
| I6 적용 | `answer_*`는 `hitl.acceptAnswer`(6.2절). `command`는 6.4절. 버튼·답장이 가리키는 질문 ID가 DB에 없으면(백업 복원 뒤) `ignored/unknown_question`으로 기록하고 "이 질문은 복원으로 취소됐습니다" 토스트(또는 답장)로 응답합니다(02 8.4 6단계 (3)) | 일시 오류는 `retry`(백오프), 상한(`inbox.max_attempts`, 5) 초과면 `failed` + 정보성 알림 |
| I7 UI 갱신 | 채택이면 버튼 메시지를 "선택: 살린다 (Telegram, 08:03)"로 고치고, 다른 채널 발송은 "답변 완료(Telegram, 08:03)"로 고치는 발신함 행 생성(`question_update`) | 발신함 재시도 |

`MessengerInbox` 상태 전이(신규 ID):

| # | from | to | 트리거 |
|---|---|---|---|
| IN1 | (삽입) | `received` | I1 |
| IN2 | `received`/`retry` | `processing` | worker가 CAS로 집음 |
| IN3 | `processing` | `processed` | I6 완료 |
| IN4 | `received`/`processing` | `ignored` | I3~I5 거부, I6 `unknown_question`(`ignore_reason` 필수) |
| IN5 | `processing` | `retry` | 일시 오류, `attempt_count` 증가 |
| IN6 | `processing` | `failed` | 상한 초과 |
| IN7 | `processing` | `retry` | 처리 중 프로세스 종료 후 재시작 회수(처리 시작 후 `processing`이 오래된 행). `attempt_count`는 늘리지 않습니다. 처리는 멱등입니다(질문 CAS·답변 유일 키, 02 7.2) |

백업 복원 뒤 메신저 정합(Telegram offset 유지, 복원으로 되돌아간 답변의 목록화와 열린 질문 재발송, 모르는 질문 처리, 중복 발송 방지, Discord)은 02 8.4 6단계 (1)~(5)를 따릅니다. 되돌아간 답변의 대상 질문이 새 DB에서 `open`이면 웹 인박스와 메신저로 다시 보내고(새 발신함 행), 새 DB에 없는 질문은 목록에만 남깁니다.

### 6.2 채택 규칙 (FR-MSG-18)

`hitl.acceptAnswer`는 한 트랜잭션에서:

1. `Answer` 행을 만듭니다(`received_at`=서버 수신 시각, 웹이면 요청 시각).
2. `UPDATE questions SET status='answered', accepted_answer_id=:ans, answered_at=now() WHERE id=:q AND status='open'` (CAS).
3. 갱신 1행이면 `disposition=accepted`. 승인 질문이면 같은 트랜잭션에서 A2/A3과 대상 상태 전이(INV-APR-02). 작업 재개 이벤트 발행(→ 04).
4. 갱신 0행이면 질문이 이미 닫힌 것입니다. 채택 답과 `payload`가 같고 같은 응답자면 `duplicate`, 아니면 `late`(6.5절).

웹과 메신저, 두 메신저 사이의 경합 모두 이 CAS 하나로 정합니다. 판정 기준은 DB 커밋 순서이며, `received_at`은 기록용입니다.

| 경우 | 결과 |
|---|---|
| Telegram 버튼 두 번 클릭(콜백 ID 다름) | 둘째는 `duplicate`, 사용자에게 "이미 반영된 답입니다" 토스트 |
| Telegram "살린다", 3분 뒤 Discord "죽인다" | 첫째 `accepted`, 둘째 `late` → 6.5절. Discord 메시지에는 "답변 완료(Telegram, 08:03)" |
| 반려 다단계 입력 중 웹에서 승인 | 웹 승인 채택. 메신저 세션은 AS4로 취소되고 "이미 웹에서 승인됨" 안내 |
| 마감 경과로 `defaulted`된 질문에 답(`resolution_source=default_applied`) | `late`(추천안이 이미 적용됨) → 6.5절 |
| 마감 경과로 보류된 질문에 답(`resolution_source=deadline_hold`) | `late`. 적용된 추천안이 없으므로 6.5절 영향 계산을 하지 않습니다. 인박스 "보류 목록"의 그 항목에 늦은 답을 채워 보여 주고, 사용자가 웹에서 확정하면 4.3절 보류 결정(웹 편집, FR-HIL-04)으로 기록합니다. 이때 `late_resolution=applied_to_hold`(00 6.4)입니다 |

### 6.3 다단계 입력 `AnswerSession` (신규)

반려 사유, 다중 선택, 서술형 입력처럼 한 번의 클릭으로 끝나지 않는 답을 메신저에서 받을 때 씁니다. 답은 마지막 단계에서 6.2절로 한 번에 제출합니다(중간 단계는 채택 경쟁에 참여하지 않음).

| 필드 | 설명 |
|---|---|
| `id` | 접두사 `ase`(00 5.1). 테이블 `answer_sessions`(03 3.4) |
| `novel_id`, `channel_id`, `question_id` | |
| `responder_external_ref` | 세션 주인. 다른 사용자의 입력은 세션에 쓰지 않음 |
| `step` | `choose_rework_from`, `enter_reason`, `toggle_options`, `enter_text` |
| `collected` | jsonb, 지금까지 고른 값 |
| `prompt_message_ref` | ForceReply 메시지 ID(Telegram 답장 매칭) |
| `status` | `active`, `completed`, `expired`, `cancelled`(enum `answer_session_status`, 00 6.4) |
| `expires_at` | 시작 + `answer_session.ttl_minutes`(30, 00 7.4) |

| # | from | to | 트리거 |
|---|---|---|---|
| AS1 | (생성) | `active` | "반려", "직접 입력", 다중 선택 첫 토글 |
| AS2 | `active` | `completed` | 마지막 단계 입력 → `acceptAnswer` 호출(결과가 `late`여도 세션은 완료) |
| AS3 | `active` | `expired` | `expires_at` 경과. 메시지 "입력 시간이 지났습니다. 다시 누르세요" |
| AS4 | `active` | `cancelled` | 질문이 다른 경로로 닫힘, 사용자가 "취소" |

채널·응답자당 `active` 세션은 1개입니다. 새 세션이 시작되면 이전 세션은 AS4입니다.

### 6.4 질문과 무관한 메시지·명령

| 입력 | MVP-α 처리 |
|---|---|
| Telegram `/start <token>` | 바인딩(9.1절) |
| Telegram `/help` | 사용법과 웹 인박스 주소 |
| 컨셉 메시지에 대한 답장, 컨셉 ForceReply | `AnswerSession` ForceReply 답장 다음 순위로 확인. 해당 `ConceptSession`의 상태에 따라 아래 "컨셉 세션 상태별 처리"를 적용합니다(3.7절) |
| 답장이 아닌 일반 문장 | 순서(v0.2): (1) `active` `AnswerSession`이 있으면 그 세션 입력. (2) 없고 이 채널이 묶인 작품에 `status ∈ {active, awaiting_approval, paused}` 컨셉 세션이 있으면 아래 "컨셉 세션 상태별 처리". (3) 그 밖에는 기존 규칙: 열린 `free_text` 질문이 이 채널에 정확히 1개면 그 답으로 받기 전에 "Q-n에 대한 답으로 받을까요? [예] [아니오]"를 묻습니다. 그 밖에는 "어느 질문의 답인지 알 수 없습니다" + 열린 질문 목록 버튼 |
| 메시지 수정(`edited_message`) | 답으로 쓰지 않고 `ignored/unsupported` |
| 상태·일시정지·대기 목록·요약 명령 | v1(FR-MSG-11). Discord는 슬래시 명령으로 구현해 메시지 본문 읽기 권한이 필요 없게 합니다(9.3절) |

**컨셉 세션 상태별 처리** (위 두 행 공통, 11 5.2 CS 전이):

| 세션 상태 | 처리 | 전이 |
|---|---|---|
| `active` | `ConceptMessage`로 저장하고 에이전트 턴을 만듭니다 | — |
| `awaiting_approval` | 메시지는 수신함에 두고 "승인 요청을 취소하고 대화를 이어 갈까요? [예] [아니오]". [예]면 그 메시지를 `ConceptMessage`로 넣고 턴을 만듭니다 | 예 → 11 CS9 |
| `paused`(`pause_reason ∈ {user, idle}`) | 세션을 재개한 뒤 `ConceptMessage`로 저장하고 턴을 만듭니다 | 11 CS7(`concept_session.resumed`) |
| `paused`(`budget_limit`) | 메시지는 `ConceptMessage`로 저장하되 에이전트 턴은 만들지 않습니다(INV-CON-09, 메시지로는 재개하지 않음). 상한 안내를 다시 보냅니다: "세션 비용 상한에 닿았습니다. [상한 올리기] [폼으로 마저 입력] [나중에]"(`outbox_kind=concept_message`, 메시지 `kind=notice`, 버튼 `v1|c|<cns>|906·907·902`). 906 → "PC 웹 설정에서 올려 주세요"(설정 변경은 웹 전용, 감사). 907 → CS7(`llm_disabled=true`, `concept_session.entry_mode_changed`) 실행 후 "PC 웹 폼에서 마저 입력해 주세요". 902 → 상태 변화 없이 확인 답장 | 상한 상향(웹) 또는 907 → 11 CS7 |

`approved`·`abandoned` 세션은 라우팅 대상이 아니므로 (3) 기존 규칙으로 넘어갑니다.

**비용 상한 도달 시 최초 안내**: 11 3.8에서 세션이 `paused(budget_limit)`가 되는 트랜잭션에서 위 안내 메시지를 웹과 `active_channel_id`(메신저면)로 한 번 보냅니다. 방해금지 시간에는 웹만 보내고 메신저 발신은 방해금지가 끝난 뒤로 미룹니다(사용자가 먼저 말한 턴의 응답이 아니므로).

**MVP-α 연재 중 "컨셉 고치기" 요청**: 기획서가 승인된 작품(`planning` 이후 기획서 `approved`, `serializing` 포함)에서 메신저로 "컨셉 고치기"·"컨셉 바꾸고 싶어" 같은 요청이 오면(MVP-α는 명령이 없으므로 일반 문장이 위 (3) 규칙에서 열린 질문의 답으로 잡히지 않은 경우의 안내 문구에 포함), 개정 세션을 열지 않고 11 3.10 릴리스 행의 안내를 보냅니다: "연재 중 컨셉 개정은 MVP-β 기능입니다. 지금은 기획서 수정·캐논 변경·결말 변경으로 바꿀 수 있습니다" + 웹 해당 화면 링크(휴대폰에서 열 수 없으면 경로 이름만). 가정: 요청 문장 식별은 결정적 키워드("컨셉" + "고치"·"바꾸"·"수정")로 하고, 오탐이어도 안내만 보내므로 상태를 바꾸지 않습니다. 기획서 승인 전 작품이면 웹 "컨셉 고치기"(11 3.10 FR-NOV-10a)로 안내합니다.

### 6.5 늦은 답변 (FR-MSG-08, R-7)

`late` 답은 질문 상태를 바꾸지 않고 `question.late_answer_received`를 남깁니다. 처리 상태는 `Answer.late_resolution`입니다.

| 단계 | MVP-α | MVP-β |
|---|---|---|
| 기록 | `late_resolution=pending_user_choice`, 인박스에 "늦은 답변" 표시 | 같음 |
| 같은 결과 | — | 늦은 답의 효과가 채택 답·적용 추천안과 같으면 `no_change` |
| 영향 계산 | 사용자가 고름: `late_answer_conflict` 질문(비차단형, `hold`) "수정 요청 만들기 / 무시" | 채택 답의 `AnswerReflection` 항목(사실·작업·위치)에서 영향받은 화를 모아 공개 여부 판정 |
| 공개 전 화만 | "수정 요청" → `revise_episode` 작업(`revision_task_created`) | 자동으로 `revise_episode` 작업 생성(`revision_task_created`). 승인된 화면 E11과 같은 입력으로 `revising` |
| 공개 화 포함 | "수정 요청" → `retcon` 승인 질문(`retcon_question_created`) | 자동으로 `retcon` 승인 질문 생성. 공개 캐논은 승인 전까지 바뀌지 않음 |
| 무시 | `dismissed` | 사용자가 인박스에서 `dismissed` 가능 |

모든 결과는 `late_resolution_ref_*`로 만든 작업·질문에 연결하고 `question.late_answer_resolved`를 남깁니다.

비차단형에서 추천안으로 잠정 진행한 뒤(4.3절 `provisional`) 마감 전에 다른 답이 채택된 경우도 같은 영향 계산을 씁니다. 이 경우 답은 `accepted`이고, 차이는 반영 단계(8절)가 처리합니다.

`late_resolution` 전이(신규 ID): AN1 (생성) → `pending_user_choice`; AN2 `pending_user_choice` → `revision_task_created` / `retcon_question_created` / `dismissed`(사용자); AN3 (생성, β 자동) → `no_change` / `revision_task_created` / `retcon_question_created`.

---

## 7. 답변 해석과 확인 (FR-MSG-16)

### 7.1 흐름

| 단계 | 내용 |
|---|---|
| T1 대상 | `free_text` 답, 선택지형 질문에 온 `text` 답, `approve_reject`의 반려 사유는 제외(사유는 그대로 저장) |
| T2 해석 | `interpret_answer` 작업(`world_keeper`). 답 문장의 표기를 링커로 연결(언급 `source_kind=answer`, G21)한 뒤, 변경 후보를 `proposed_changes`에 넣습니다: 사실(`fact_kind`, 엔티티 ID, `story_range`), 제약(`fact_kind=constraint`), 작업 변경, 이름 사전 규칙 |
| T3 모호 판정 | 링킹 `ambiguous`가 남거나 후보가 서로 배타적이면 `needs_followup` → `followup` 질문(원 질문과 같은 등급, `parent_question_id`) |
| T4 확인 질문 | 아니면 `interpretation_confirm` 질문(원 질문과 같은 등급). 본문은 변경 후보를 사람 말로 풀어 씁니다: "다음 3가지로 반영합니다: (1) 한서윤(청람 길드 분석관, 최근 12화)은 아크 2 끝(60화)까지 강도현(회귀자, 최근 12화)의 회귀를 모릅니다 [인물 지식 제약] (2) … 맞습니까?" 엔티티는 항상 `대표명(판별 정보)`과 최근 등장 화로 적습니다(판별 정보 규칙은 3.6.2절) |
| T5 확인 | "맞습니다" → `confirmed`, `final_changes = proposed_changes`. 확인된 사실·제약은 출처가 답변인 `approved` 캐논(FR-MSG-16) |
| T6 정정 | "고칠게요" + 문장 → 새 해석 행 `proposed`(이전 행 `rejected`)와 새 확인 질문. 메신저 정정은 `interpretation.max_correction_rounds`(2회, 00 7.4)까지, 넘으면 웹 편집 폼으로 안내. 웹 폼에서 사용자가 구조화 변경을 직접 고쳐 저장하면 `corrected` |
| T7 취소 | "취소" → `rejected`. 원 질문은 반영 기록 `not_applied`(사유 "해석 기각")로 `resolved`, 같은 내용을 다시 묻는 `followup` 질문을 만듭니다(사용자 의도가 사라지지 않게) |

원 질문이 차단형이면 대상 작업은 T5(또는 `corrected`)까지 `blocked`로 남습니다. 선택지형 답은 해석 없이 바로 8절로 갑니다(INV-AI-01).

**답변 속 지칭 표현의 연결 규칙** (G21, R-18). 예: 사용자가 "걔는 그냥 죽이자"라고 답한 경우입니다.

| 규칙 | 내용 |
|---|---|
| L4 입력 창 | 답변 출처 언급(`source_kind=answer`)의 문맥 창은 씬 창 대신 "원 질문 본문(미리보기 발췌 포함) + 원 질문의 후보 카드·질문 링크 엔티티 + 같은 `AnswerSession`(없으면 같은 채널·응답자)의 최근 N개 메시지"입니다. N은 `interpretation.answer_context_messages`(가정 5, 11절 미결 4) |
| 자동 확정 금지 | 답변 출처 언급 중 `mention_kind ∈ {pronoun, zero, address, descriptive}`는 신뢰도와 무관하게 `auto_linked`로 두지 않습니다. 후보가 1개면 T4 확인문에서, 2개 이상이면 T3 후속 질문에서 명시적으로 확인합니다 |
| 되돌리기 어려운 변경 | 변경 후보가 사망·퇴장(`state` 사실 중 생사·퇴장), 정체 공개, 병합·분리에 닿으면 T4는 자유 문장 확인을 받지 않습니다. 대상 엔티티를 엔티티 카드 버튼(`대표명(판별 정보)`, 최근 등장 화)으로 고르게 하고, 값은 `entity_id`입니다(P6). "응"·"맞아" 같은 자유 답장은 이 확인 질문의 답으로 쓰지 않고 버튼을 다시 안내합니다(6.4절) |

이 규칙의 링커 쪽 반영은 → 06 3.8 L4 입력(답변 출처 문맥 창, `interpretation.answer_context_messages`), 3.9 자동 확정 금지 표(답변 출처 예외)입니다.

### 7.2 `AnswerInterpretation` 상태 전이(신규 ID)

| # | from | to | 트리거 | 주체 |
|---|---|---|---|---|
| IT1 | (생성) | `proposed` | T2 완료 | `agent:world_keeper` |
| IT2 | `proposed` | `confirmed` | T5 | `user` |
| IT3 | `proposed` | `corrected` | 웹 폼 정정 저장 | `user` |
| IT4 | `proposed` | `rejected` | T6(새 해석으로 대체), T7 | `user` |
| IT5 | (생성) | `needs_followup` | T3 | `agent:world_keeper` |
| IT6 | `needs_followup` | `rejected` | 후속 질문 답으로 새 해석 행을 만든 뒤 | `agent:world_keeper` |

확인 질문이 비차단형이고 마감이 지나면 `hold`입니다(3.3절). 해석은 `proposed`로 남고 캐논을 만들지 않습니다.

---

## 8. 반영과 반영 기록 (FR-MSG-09, FR-MSG-17)

### 8.1 반영 단계

| 단계 | 내용 | 기록 |
|---|---|---|
| F1 기록 생성 | Q3 또는 Q4 트랜잭션에서 `AnswerReflection(status=pending)` 생성(INV-AR-01) | — |
| F2 즉시 변경 | 선택지·확정 해석의 직접 효과를 같은 트랜잭션 또는 `apply_answer` 작업에서 적용: 사실·제약 생성, 떡밥 기한 변경(`SetupDueChange`), 언급 확정, 동일성 결정, 작업 생성·변경 | `answer_reflection_items`에 (a) 변경 목록 |
| F3 작업 재개 | 영향받는 작업을 wake. `idempotency_key=answer:<ans_id>:<tsk_id>`(00 5.4). 작업 컨텍스트에 답변 ID를 넣음(→ 04) | — |
| F4 소비 실행 | 답변 ID를 컨텍스트 스냅숏에 넣은 실행이 끝날 때 `consumer_run_ids`에 추가 | (b) |
| F5 위치 | 그 실행이 만든 원고 버전에서 답의 효과가 들어간 위치를 찾아 `locations`에 기록(씬·문자 범위). 원고가 아닌 반영(떡밥 기한, 이름 사전, 스키마)은 대상 ID를 `{ref_type, ref_id}` 위치로 씁니다(03 3.4 `locations`) | (c) |
| F6 종결 | (a)(c)가 채워지면 `applied`. 반영 대상 작업이 취소·대체되거나 해석이 기각되면 `not_applied` + 사유. 그다음 Q6 `resolved` | `answer_reflection.recorded` |
| F7 통지 | 차단형: 답이 온 채널로 즉시 `reflection_notice`. 비차단형: 다음 digest. 예: "C 생존 반영: 12화 씬3, 사실 2건 추가. [보기]" | `answer_reflection.notified` |

### 8.2 위치를 찾는 방법

| 효과 | 위치 판정 |
|---|---|
| 사실·제약 생성 | 그 사실을 근거로 갖는 첫 원고 버전의 씬(`source_scene_id`) 또는 그 사실을 컨텍스트로 쓴 실행이 만든 씬 중 사실 추출에서 같은 사실이 다시 나온 씬 |
| 작업 변경(예: 아웃라인 재작성) | 그 작업이 만든 원고 버전의 변경 구간(diff) |
| 기획서 반영 | `{series_bible_id, section}` |
| 떡밥·엔티티·스키마 | 대상 행 ID |

`world_keeper`가 위치를 찾지 못하면 `not_applied`로 닫지 않고 `pending`으로 남겨 인박스 "반영 확인 필요"에 올립니다. 독립 검토(D-26)가 KPI "답변 반영 성공률"의 (3)을 확인합니다.

### 8.3 `AnswerReflection` 상태 전이(신규 ID)

| # | from | to | 트리거 | 주체 |
|---|---|---|---|---|
| RF1 | (생성) | `pending` | Q3, Q4 | `system:orchestrator` |
| RF2 | `pending` | `applied` | F6 조건 충족 | `system:orchestrator` |
| RF3 | `pending` | `not_applied` | 대상 소멸·해석 기각·`hold` 마감 | `system:orchestrator` / `user` |

---

## 9. 메신저 어댑터

### 9.1 구성과 Chat SDK 사용 범위 (ADR-011, D-15)

| 층 | 판단 | 근거 |
|---|---|---|
| 공급자 접속 | Vercel Chat SDK(`chat`, `@chat-adapter/telegram`, `@chat-adapter/discord`, MIT)를 npm으로 직접 의존. 메시지 정규화, 버튼·셀렉트·모달, 공급자 오류 분류에 씁니다. | [1차] https://registry.npmjs.org/chat , 조사 파일 4.1절 |
| Paperclip chat 서비스(81k줄)·패치 | 쓰지 않음 | issue·run·agent에 결합, Discord 패치 3,518줄 [1차, 커밋 0cb3fc7] |
| 내구성 | 자체 `messenger_inbox`·`messenger_outbox`. Paperclip `chat_deliveries`·`chat_publications` 패턴만 차용 | 조사 파일 4.1절 |
| Telegram 수신(polling) | upstream polling 루프를 쓰지 않고 자체 `TelegramPoller`(신규)가 `getUpdates`를 호출합니다. 업데이트를 받으면 6.1절 I1로 수신함에 넣고, 수신함 기록 커밋 뒤(처리 완료를 기다리지 않음) `messenger_bots.telegram_update_offset`을 "배치에서 앞에서부터 연속으로 기록에 성공한 마지막 `update_id`+1"로 저장한 다음 다음 호출에 씁니다. 동작 사양은 9.2절 `TelegramPoller` 표. 정규화는 SDK 파서를 씁니다. | upstream polling은 `update_id` 중복 검사가 없고 offset을 메모리에만 두며 처리 완료 전에 넘깁니다 [1차, `@chat-adapter/telegram` 4.39.0 `dist/index.js`] |
| Telegram 수신(webhook) | `self_hosted` + `exposure=public`(08 5.3 CFG-4)에서 SDK webhook 모드 + `secret_token` 헤더 검증. 검증 실패는 401로 버리고 기록 | NFR-SEC-01, PRD 11절 |
| Discord 수신 | Gateway만 씁니다(로컬은 공개 HTTPS가 없음). upstream `startGatewayListener`의 기간 제한(기본 180초)을 감독 루프 `DiscordGatewaySupervisor`(신규)가 재시작으로 감쌉니다. MVP는 두 모드 모두 앱 프로세스 1개(02 2.3 인스턴스 잠금)라 Gateway 연결도 1개입니다. 다중 프로세스의 Gateway 소유 lease는 이후(02 10절) | [1차, `@chat-adapter/discord` 4.39.0], Paperclip `chat-sdk-runtime.ts:2320-2345` 패턴 |
| 발신 | SDK의 send/edit 호출을 발신함 worker에서만 부릅니다. 429는 SDK가 Telegram은 `AdapterRateLimitError(retry_after)`로, Discord는 일반 오류로 던지므로, worker가 HTTP 상태와 `retry_after`를 읽어 재시도 시각을 정합니다. | [1차, 조사 파일 1.12] |
| SDK StateAdapter | SDK `Chat` 코어의 이벤트 루프·구독을 쓰지 않고 어댑터를 직접 부르는 방식이면 StateAdapter 의존을 줄일 수 있습니다. 필요하면 `@chat-adapter/state-pg` 또는 PG CAS 구현. 결정은 메신저 스파이크(→ 09, 11절 미결 9) | 가정: 메모리 StateAdapter는 재시작 시 상태 유실 |
| SDK 버전 | Paperclip 고정 4.39.0, latest 4.43.0. 4.40~4.43 변경 내역(polling 중복 검사, Gateway 상시 실행 추가 여부) [미확인] | → 09 스파이크, 08 버전 고정 |

포트 `ChannelAdapter`(신규, `messaging/application`):

| 메서드 | 설명 |
|---|---|
| `capabilities()` | `ChannelCapabilities`(신규): 최대 본문 길이, 버튼 수, 셀렉트 수, 모달 지원, 버튼 데이터 최대 길이, 첨부 한도, rate limit 정책 |
| `render(view: QuestionView) → RenderedMessage` | 5.3절 규칙 적용. 순수 함수 |
| `send(channel, rendered) → provider_message_ref` | 발신함 worker 전용 |
| `edit(channel, provider_message_ref, rendered)` | "답변 완료", "취소됨" 갱신 |
| `ack(inbound)` | 버튼 ACK |
| `parse(raw) → InboundAction` | 6.1절 I5 |
| `checkHealth(channel) → health_status` | 9.5절 |

구현은 `telegram`, `discord`, `web` 세 개입니다. `web`은 발신함을 거치지 않고 `QuestionDelivery`를 바로 `posted`로 두고 실시간 이벤트(ADR-017)로 화면을 갱신합니다. `slack`(v1)은 같은 포트로 추가합니다(FR-MSG-13).

### 9.2 Telegram (MVP-α)

| 항목 | 설계 | 근거 |
|---|---|---|
| 채팅 형태 | 1:1 채팅만. 그룹 초대는 거부(`ignored/unsupported`) | FR-MSG-02, PRD 11절 privacy mode |
| 바인딩 | 설정 화면이 `ChannelBindingToken`을 발급(원문은 화면에만, DB에는 해시)하고 딥 링크 `https://t.me/<bot>?start=<token>`을 보여 줍니다. 사용자가 Start를 누르면 `/start <token>`이 오고, 토큰 해시 일치·`issued`·미만료면 같은 트랜잭션에서 토큰 `consumed`, `Channel(active)` 생성, `allowed_user_refs=[from.id]`, `external_chat_ref={chat_id}`. 확인 메시지 "「회귀자의 흉터」와 연결됐습니다" 발송(FR-SET-02) | FR-MSG-02, INV-BT-01. 딥 링크 시작 파라미터 길이·문자 제한 [미확인] → 토큰은 URL-safe 32자(가정) |
| 봇과 작품 | 봇 1개(설치 단위 `MessengerBot`)가 여러 작품 채팅을 가질 수 있습니다. 같은 사용자 채팅 하나를 여러 작품에 바인딩하면 메시지 머리에 작품 이름을 붙입니다. 가정: MVP-α는 작품 1개 | NFR-EXT-04b(v1) |
| 버튼 | 인라인 키보드, `callback_data`=5.3절 형식(≤64바이트) | PRD 11절 [1차] |
| 서술형 | ForceReply 메시지를 보내고 `AnswerSession.prompt_message_ref`로 답장 매칭 | — |
| 갱신 | `editMessageText`/`editMessageReplyMarkup`으로 "답변 완료(채널, 시각)" | FR-MSG-18 |
| rate limit | 채팅당 초당 1건, 전체 초당 약 30건을 발신함 worker의 토큰 버킷으로 지킴. 429 `retry_after` 우선 | PRD 11절 [1차] |
| 오프라인 공백 | 미수신 업데이트는 24시간 보관됩니다. 앱이 24시간 넘게 꺼져 있었으면 재시작 때 "꺼져 있는 동안 보낸 답이 사라졌을 수 있습니다. 웹 인박스를 확인하세요"를 보냅니다(마지막 polling 시각으로 판정) | NFR-REL-02, NFR-REL-06 |
| 차단됨 | 사용자가 봇을 차단해 403이 오면 채널 `disconnected`, 다른 채널·웹으로 알림 | 5.7절 |
| 봇 토큰 | Telegram 봇 토큰 1개는 설치 1곳 전용입니다. 같은 토큰을 다른 PC·개발 환경에서 polling하면 수신을 서로 빼앗습니다(아래 409) | 아래 TP4 |

**`TelegramPoller` 사양** (`local_trusted`의 유일한 Telegram 수신 경로, 02 6.1)

| # | 항목 | 규칙 | 근거 |
|---|---|---|---|
| TP1 | 요청 | `getUpdates(offset=telegram_update_offset, timeout=telegram.poll_timeout_seconds, allowed_updates=["message","callback_query"])`. `timeout`은 25초(가정). HTTP 클라이언트 abort는 `timeout`+10초. 다음 요청은 응답 처리 직후 바로 보냅니다 | `getUpdates`의 `offset`·`timeout`·`allowed_updates` [1차] https://core.telegram.org/bots/api#getupdates |
| TP2 | offset | 배치의 업데이트를 `update_id` 순서로 I1 기록합니다. offset은 앞에서부터 연속으로 기록(신규 INSERT 또는 `dedupe_key` 충돌)에 성공한 마지막 `update_id`+1까지만 올립니다. 중간 하나가 실패하면 그 뒤는 기록했어도 offset을 넘기지 않고 다음 요청에서 다시 받습니다(이미 기록한 것은 `dedupe_key` 충돌로 끝). `max(update_id)+1`을 쓰지 않습니다 | NFR-REL-02, INV-IN-01 |
| TP3 | 처리와 분리 | offset 저장은 수신함 기록 커밋 뒤이고 처리(I2~I7) 완료를 기다리지 않습니다. 처리 실패·재시작은 수신함 상태(IN5·IN7)로 복구합니다 | 6.1절 |
| TP4 | 409 Conflict | 다른 곳에서 같은 봇을 polling 중이거나 webhook이 설정된 상태입니다. 채널 `degraded`(CH3)로 두고 원인 "다른 곳에서 같은 봇을 수신 중이거나 webhook이 설정됨"을 설정 화면·작품 홈 배너에 표시합니다. 첫 409에서 `getWebhookInfo`로 webhook URL이 있으면 `deleteWebhook` 1회 시도(08 5.3 CFG-7과 같은 처리). 그 뒤 409가 계속되면 1초부터 2배씩 `telegram.poll_backoff_max_seconds`까지 지수 백오프로 재시도하고, 성공하면 CH4 | webhook이 켜져 있으면 `getUpdates`가 동작하지 않음 [1차] https://core.telegram.org/bots/api#getupdates . 동시 `getUpdates` 요청의 409 응답 문구 [미확인] |
| TP5 | 401 | 토큰 폐기. 채널 `disconnected`(CH5), polling 정지. 토큰 재설정 후 점검 `pass`면 재개(CH6) | 9.6절 |
| TP6 | 429·5xx·네트워크 오류 | 429는 `retry_after`만큼 대기. 5xx·연결 오류·abort는 1초부터 2배씩 `telegram.poll_backoff_max_seconds`(가정 60초)까지 백오프. 연속 실패가 `channel.degraded_after_consecutive_failures`에 닿으면 CH3 | NFR-REL-03 |
| TP7 | 절전 복귀 | 02 7.5 절전 감지(`system.sleep_detect_gap_seconds`) 이벤트를 받으면 진행 중 요청을 abort하고 백오프 없이 즉시 다시 요청합니다(반쯤 열린 TCP 연결 대기 방지) | 02 7.5 |
| TP8 | 단일 실행 | 한 설치에서 봇당 poller는 1개입니다(02 2.3 인스턴스 잠금). 성공 응답마다 `messenger_bots.last_connected_at`을 갱신하고 "오프라인 공백" 판정에 씁니다 | 03 3.5 `MessengerBot` |

키 `telegram.poll_timeout_seconds`, `telegram.poll_backoff_max_seconds`는 00 7.4에 등록됐습니다.

### 9.3 Discord (MVP-β)

| 항목 | 설계 | 근거 |
|---|---|---|
| 구조 | 사용자 전용 서버(guild)의 부모 텍스트 채널 아래 작품별 스레드 1개. 설정 화면에서 봇 초대 링크·부모 채널을 고르면 봇이 스레드를 만들고 `external_chat_ref={guild_id, channel_id, thread_id}` | FR-MSG-03, D-7 |
| 바인딩 | 설정 화면에서 허용 사용자 Discord ID 입력 대신, 스레드에 "연결 확인" 버튼 메시지를 보내고 그 버튼을 누른 사용자를 `allowed_user_refs`에 넣습니다(토큰 만료 `channel.binding_token_ttl_minutes`). 서버 소유자 외 클릭 허용 여부는 설정 | FR-MSG-03, NFR-SEC-01 |
| 상호작용 | 버튼·셀렉트는 3초 안에 `deferUpdate`(I2). 후속 메시지·수정은 interaction token(15분)이 아니라 봇 토큰 REST로 | PRD 11절 [1차] |
| 서술형·반려 사유 | 모달(Text Input ≤4,000자, 컴포넌트 ≤5개). 모달은 상호작용 응답으로만 열 수 있으므로 "직접 입력" 버튼 클릭 응답으로 엽니다 | PRD 11절 [1차] |
| 메시지 본문 읽기 | 자유 입력을 모달과 슬래시 명령으로만 받아 Message Content 특권 intent 없이 동작하게 합니다. intent 요구 조건은 [미확인] | → 09 스파이크 |
| 보관된 스레드 | 새 질문을 보내기 전에 스레드 보관 상태를 확인하고, 보관됐으면 보관 해제 후 발송. 메시지 전송만으로 재활성화되는지는 [미확인]이라 명시적 해제를 기본으로 둡니다 | FR-MSG-03, PRD 11절 |
| rate limit | 전역 초당 50요청, 경로별 버킷 헤더 준수. 401/403/429 합계가 10분에 10,000건을 넘으면 IP 차단 [1차]이므로, 봇 단위 차단기: 401/403은 즉시 채널 `disconnected`, 429가 10분에 100건(가정)을 넘으면 그 봇 발신을 10분 정지 | NFR-REL-03, PRD 11절 |
| 셀렉트 | 옵션 ≤25, 옵션 설명에 판별 정보(3.6.2절). 설명 길이 한도 [미확인] → 라벨 규칙의 40자(가정) 적용 | — |

### 9.4 발신함 (`messenger_outbox`)

| 항목 | 규칙 |
|---|---|
| 멱등 키 | `<outbox_kind>:<ref_id>:<channel_id>:<n>`. 예: `question:qst_…:chn_…:1`, 리마인더는 `reminder:qst_…:chn_…:<reminder_count>` |
| 순서 | 채널 단위로 `created_at` 순서 발송. 앞 행이 `retry`면 같은 질문의 갱신(`question_update`)은 기다립니다. 다른 질문은 추월 가능 |
| 재시도 | 공급자 rate limit은 횟수에서 빼고 `retry_after`까지 대기. 그 밖 일시 오류는 `outbox.max_attempts`(5)까지 백오프 |
| 미상 | 요청을 보낸 뒤 응답 전에 시간 초과·프로세스 종료면 `delivery_unknown`. 자동 재발송하지 않습니다(INV-OUT-01). 질문 발송이면 웹 인박스에 "메신저 전달 미확인"을 표시하고, 차단형은 리마인더가 새 메시지로 나가므로 결국 도달합니다. 사용자는 "다시 보내기"로 새 행을 만들 수 있습니다 |
| 오래된 질문 | 발송 직전에 질문이 이미 닫혔으면 `question` 행은 `cancelled` |
| 컨셉 메시지 | `outbox_kind=concept_message`, 멱등 키 `concept_message:<cnm_id>:<channel_id>:1`. rate limit·재시도는 위와 같음. `is_superseded=true` 메시지는 발신하지 않음(11 X-7) |

| # | from | to | 트리거 |
|---|---|---|---|
| OB1 | (생성) | `pending` | 디스패처·통지 |
| OB2 | `pending`/`retry` | `sending` | worker CAS 집기, `next_attempt_at ≤ now`, 채널 토큰 버킷 통과 |
| OB3 | `sending` | `sent` | 공급자 성공, `provider_message_ref` 저장, 연결 `QuestionDelivery` QD2 |
| OB4 | `sending` | `retry` | 429(횟수 제외) 또는 일시 오류(횟수 포함) |
| OB5 | `sending` | `delivery_unknown` | 요청 후 결과 미확인 |
| OB6 | `sending` | `failed` | 영구 오류(400 형식, 403 차단) 또는 횟수 초과 |
| OB7 | `pending`/`retry` | `cancelled` | 대상 질문 닫힘, 채널 해제·`disconnected` |

### 9.5 `QuestionDelivery` 상태 전이(신규 ID)

| # | from | to | 트리거 |
|---|---|---|---|
| QD1 | (생성) | `pending` | D7 |
| QD2 | `pending` | `posted` | 웹: 즉시. 메신저: OB3 |
| QD3 | `posted` | `answered_here` | 이 채널 답이 채택됨 |
| QD4 | `posted` | `closed_elsewhere` | 다른 채널 답 채택, 마감 적용 후 메시지 갱신 완료 |
| QD5 | `pending` | `failed` | OB6, OB7(채널 장애) |
| QD6 | `pending`/`posted` | `withdrawn` | 질문 취소(Q8, 5.6절). `posted`면 "취소됨" 메시지 갱신 완료, `pending`이면 발신함 행 OB7 |

### 9.6 채널 상태와 연결 점검 (FR-SET-03)

| # | from | to | 트리거 | 주체 |
|---|---|---|---|---|
| CH1 | (생성) | `pending_binding` | 바인딩 토큰 발급(Telegram), 스레드 생성 후 확인 대기(Discord) | `user` |
| CH2 | `pending_binding` | `active` | 바인딩 완료 + 확인 메시지 발송 성공 | `system:messenger` |
| CH3 | `active` | `degraded` | 점검 `fail` 또는 연속 발송 실패 `channel.degraded_after_consecutive_failures`(3회, 00 7.4) | `system:health_check` / `system:messenger` |
| CH4 | `degraded` | `active` | 점검 `pass` | `system:health_check` |
| CH5 | `active`/`degraded` | `disconnected` | 401(토큰 폐기), 403(봇 차단·추방) | `system:messenger` |
| CH6 | `disconnected` | `active` | 토큰 재설정 또는 사용자 차단 해제 후 점검 `pass` | `system:health_check` |
| CH7 | `web` 외 모든 상태 | `revoked` | 사용자가 연결 해제 | `user` |

`ChannelBindingToken`: BT1 (생성) → `issued`; BT2 `issued` → `consumed`; BT3 `issued` → `expired`(TTL 경과, 스케줄러); BT4 `issued` → `revoked`(새 토큰 발급·사용자 취소).

연결 점검(`channel.health_check_interval_minutes` 주기 + 설정 화면 수동 실행):

| `health_check_kind` | Telegram | Discord | 실패 시 |
|---|---|---|---|
| `bot_token` | `getMe` | 현재 봇 사용자 조회 | 채널 전부 `disconnected` 후보, 설정 화면 원인·조치("토큰 재발급 후 다시 입력") |
| `channel_reach` | `getChat(chat_id)` (메시지는 보내지 않음). `local_trusted`면 `getWebhookInfo`의 URL이 비어 있는지와 최근 `TelegramPoller` 409 여부(9.2절 TP4)도 봅니다 | 스레드 조회, 보관 여부, 봇 권한 | `degraded`. 409·webhook이면 원인 "다른 곳에서 같은 봇을 수신 중이거나 webhook이 설정됨"과 조치("다른 기기의 앱을 끄거나 봇 토큰을 새로 발급") |

점검 결과는 `health_check_results`에 남고, 상태가 바뀔 때만 `channel.health_changed`를 기록합니다. 메신저가 모두 `degraded` 이하가 되면 작품 홈 배너와 웹 인박스로 알립니다(5.7절).

### 9.7 웹 링크와 배포 모드

| 배포 모드 | 메신저 속 링크 | 제약 |
|---|---|---|
| `self_hosted` | `https://<host>/novels/:novelId/inbox/:questionId`. 인증 필수(NFR-SEC-03·04) | — |
| `local_trusted` | `http://127.0.0.1:<port>/…` | 루프백에만 바인딩하므로(ADR-002) 휴대폰에서 열 수 없습니다. 그래서 MVP-α의 모든 질문 주제는 메신저 안에서 답이 끝나야 합니다(웹 링크는 PC에서 전문 보기용). 한도 초과로 웹이 필요한 질문은 Telegram 메시지에 "PC의 웹 인박스에서 답하세요"를 함께 적습니다. 휴대폰에서 화 전문을 읽는 방법은 아래 결정 |

**`local_trusted`의 휴대폰 화 전문 열람 (FR-MSG-05, 11절 미결 11 해소)**

결정(확정, 2026-10-28 사용자 확인, PRD v0.5 FR-MSG-05·NFR-SEC-04, 01 P-08): (c) 요약 승인을 기본으로 하고, (a) 화 전문 첨부를 사용자 옵트인으로 둡니다. 전문 첨부는 NFR-SEC-04의 예외입니다.

| 선택지 | 판단 | 이유 |
|---|---|---|
| (a) 화 전문 문서 첨부(`.txt`) | 채택, 옵트인(기본 꺼짐) | 휴대폰에서 전문을 읽고 승인할 수 있는 유일한 MVP-α 경로입니다. 원고 전문이 메신저 서버에 남으므로 NFR-SEC-04 "메신저로는 요약만"의 예외이고, 사용자 동의가 필요합니다. |
| (b) LAN 노출 모드(인증 강제) | 채택하지 않음 | `local_trusted`는 `exposure=private`·루프백 바인딩을 강제합니다(ADR-002, 08 5.3 CFG-1). LAN 노출은 인증을 갖춘 `self_hosted` 경로입니다(NFR-SEC-03). |
| (c) 요약만으로 승인, 전문은 PC 열람 권고 | 채택, 기본 | FR-MSG-05는 메신저에 요약을, 전문은 링크로 줍니다. 승인 판단에 필요한 항목은 10.2절 요약에 담습니다. |
| (d) Telegram Mini App | 이후 | FR-MSG-15 범위 |

| 항목 | 규칙 |
|---|---|
| 설정 | 작품 설정 `messenger.episode_full_text_attachment`(bool, 기본 `false`, 11절 미결 4). 웹 설정 화면에서만 켭니다(메신저 명령으로 켜지 않음). 켤 때 "화 전문이 Telegram 서버에 파일로 남고, 끄더라도 이미 보낸 파일은 지워지지 않습니다"를 보여 주고 확인을 받습니다. 외부 전송 범위 안내(NFR-SEC-04, FR-SET-01)에 "화 승인 질문의 화 전문 첨부(켠 경우)"를 넣습니다. |
| 대상 | `approval_type=episode` 승인 질문만. 승인 대상 원고 버전 1개를 `.txt`(UTF-8, 파일명 `<화번호>화_v<버전>.txt`)로 만듭니다. 다른 질문·아크 승인은 첨부하지 않습니다(아크 승인은 화 목록과 링크). |
| 발송 | 질문 메시지 바로 뒤에 문서 메시지 1통. 같은 발신함 행의 `RenderedMessage.attachments`로 보냅니다. 문서 크기가 채널 첨부 한도(Telegram 50MB)를 넘으면 첨부하지 않고 "PC에서 열기"만 둡니다. |
| 꺼져 있을 때 | 화 승인 질문 끝에 "전문: PC 웹 인박스에서 보기. 휴대폰에서 읽으려면 설정에서 '화 전문 첨부'를 켜세요"를 적습니다. 승인은 요약만으로 할 수 있습니다. |
| `self_hosted` | 링크가 휴대폰에서 열리므로 첨부를 권하지 않습니다. 설정은 같은 키로 동작합니다. |

---

## 10. 승인 게이트 (FR-HIL-01·02, 6.3.1 표)

### 10.1 자율성 × 게이트 → 승인 유형

| 이벤트 | `episode_approval` | `arc_approval` | `full_auto` | `co_writing`(v1) | `approval_type` | 질문 |
|---|---|---|---|---|---|---|
| 컨셉 브리프 확정(FR-NOV-08) | 승인 | 승인 | 승인 | 승인 | `concept_brief` | `concept_confirm` |
| 기획서 확정 | 승인 | 승인 | 승인 | 승인 | `series_bible` | `bible_confirm` |
| 아크 계획(떡밥 배치) | 승인 | 승인 | 정보성 보고 | 승인 | `arc_plan` | `approval_gate` |
| 화 승인 | 매 화 승인 | 없음 | 없음(E9(c)) | 사람 원고 확정 | `episode` | `approval_gate` |
| 아크 승인 | 없음 | 승인 | 없음 | 없음 | `arc` | `approval_gate` |
| 기존 `approved` 사실 변경 | 승인 | 승인 | 승인 | 승인 | `canon_change` | `approval_gate` |
| 리트콘 | 승인 | 승인 | 승인 | 승인 | `retcon` | `retcon` |
| 결말 방향 변경 | 승인 | 승인 | 승인 | 승인 | `ending_change` | `approval_gate`(방향안 선택은 앞선 `direction` 질문) |
| 하드 한도 후 재개 | 승인 | 승인 | 승인 | 승인 | `budget_resume` | `budget` |
| 떡밥 폐기 | 승인 | 승인 | 승인 | 승인 | `setup_abandon` | `setup_abandon` |
| 떡밥 기한 연장 | 질문 | 질문 | 질문 | 질문 | — | `setup_due` |
| 공개 처리 | 사람(웹) | 사람 | `publish_policy`: `batch_question`이면 승인, `scheduled`면 자동 | 사람 | `publish_batch` | `publish_batch` |
| 스키마 변경 | 승인 | 승인 | 승인 | 승인 | `schema_change` | `schema_change` |
| 공개 사실에 닿는 병합·분리 | 승인 | 승인 | 승인 | 승인 | `identity_change` | `identity_change` |

`full_auto`를 고를 때 정책·저작권 경고와 확인을 받습니다(FR-HIL-01b, 웹 설정 화면). 자율성 변경은 `novel.autonomy_changed`로 남고, 진행 중인 `pending` 승인은 바꾸지 않습니다(새 수준은 다음 게이트부터).

### 10.2 화 승인 질문 내용 (FR-MSG-05)

`approvals.payload`와 질문 본문에 넣는 항목:

| 항목 | 출처 |
|---|---|
| 요약(5문장 이내), 회차 말 훅 한 줄 | `line_editor` 산출 |
| 주요 변경점(직전 승인 버전 또는 아웃라인 대비) | 버전 diff 요약(→ 07) |
| 연속성 경고 수(`medium`), 자동 수정 건수 | `continuity_issues` |
| 떡밥 비트(설치·강화·회수) | `setup_beats` |
| 미확정 언급 수(보류·검수 구간), 새 엔티티 후보 수 | `mentions`, `entities` |
| 이 화에서 승격될 신규 사실 수 | `facts` |
| 분량(공백 포함 n자, 프로필 이탈 경고) | 07 |
| 전문 링크, 전문 첨부(`messenger.episode_full_text_attachment=true`일 때 `.txt` 문서 1통) | 9.7절 |

`local_trusted`에서 첨부가 꺼져 있으면 사용자는 요약만으로 승인할 수 있습니다(9.7절 결정 (c)). 그래서 요약은 링크 없이도 승인 판단이 되도록 위 항목을 모두 메신저 본문에 담고, 본문 한도를 넘을 때는 "주요 변경점"보다 "연속성 경고 수"·"미확정 언급 수"를 먼저 남깁니다. 본문 끝에 "전문은 PC에서 확인하거나 첨부를 켜세요" 안내를 적습니다.

선택지: `0` 승인, `1` 반려. 반려 입력: `rework_from`(아웃라인부터 / 초고부터 / 문장만) → 사유(필수). Telegram은 `AnswerSession` 2단계, Discord는 모달 1개. 반려 상한(E12) 도달 시 `rewrite_limit` 질문.

### 10.3 아크 승인 반려 (`arc_approval`, 03 9절 미결 해소)

| 경로 | 규칙 |
|---|---|
| 메신저 | 반려 → "모든 화 같은 단계로"(`rework_from` 선택 + 사유) 또는 "화별로 지정(웹)" |
| 웹 | 아크의 화마다 승인 유지 / 반려(`rework_from`, 사유) 선택 |
| 효과 | 반려로 고른 화마다 `EpisodeRejection` 1행과 E10. 고르지 않은 화는 `awaiting_approval` 유지 |
| 재요청 | 반려된 화가 모두 다시 `awaiting_approval`이 되면 새 `arc` 승인 요청, 이전 요청은 A5 `superseded` |
| 반려 상한 | 화별 `rejection_count`로 E12 규칙을 그대로 적용 |

### 10.4 v1 미디어 게이트

`media_autonomy=review_all`(기본, D-25)은 `character_sheet`, `draft_adoption`, `media_quote`, `safety_review`를 모두 질문으로 보냅니다. `quote_only`는 `draft_adoption`을 `visual_producer`가 자동 선택하고 "자동 채택"으로 기록합니다. `safety_review`는 어느 설정에서도 사람입니다(FR-SPX-09). 이미지 미리보기는 `attachment_review`(9.2절 첨부 규칙).

### 10.5 중요 결정의 웹 재확인 (R-12)

`retcon`, `budget_resume`(한도 상향), `ending_change`에 대해 "웹에서 다시 확인" 옵션을 둡니다. 켜면 메신저 답이 채택된 뒤 승인 결정을 바로 하지 않고 웹 인박스에 확인 버튼을 띄우며, 웹 확인 시점에 A2가 일어납니다. 기본값은 꺼짐(`question.web_confirm_approval_types` 빈 목록, 00 7.4, 가정). `local_trusted`에서는 9.7절 제약 때문에 PC에서만 확인할 수 있다는 점을 설정 화면에 표시합니다.

---

## 11. 미결 사항

| # | 항목 | 내용 | 정하는 시점 |
|---|---|---|---|
| 1 | (해소) Q2 주체에 `user` 추가 | 03 v0.2 4.4 Q2 (b)에 반영 | — |
| 2 | (해소) `question_delivery_state` 취소 값 | 00 6.4에 `withdrawn` 등록. 5.6절·QD6에 반영 | — |
| 3 | (해소) 신규 enum·ID 접두사 등록 | `answer_session_status`(00 6.4), 접두사 `ase`(00 5.1), 테이블 `answer_sessions`(03 v0.2 3.4) 등록. `callback_payload`의 `action` 코드는 형식으로만 두고 enum 등록은 하지 않음 | — |
| 4 | 신규 기본값 키 | 12개(`question.preview_max_chars`, `question.messenger_max_entity_options`, `question.buttons_max_options`, `question.option_label_max_chars`, `answer_session.ttl_minutes`, `interpretation.max_correction_rounds`, `inbox.max_attempts`, `channel.degraded_after_consecutive_failures`, `discord.rate_limit_breaker_429_per_10min`, `linking.rule_proposal_min_confirmations`, `question.web_confirm_approval_types`, `question.dispatch_interval_seconds`)와 추가 4개(`messenger.episode_full_text_attachment`, `interpretation.answer_context_messages`, `telegram.poll_timeout_seconds`, `telegram.poll_backoff_max_seconds`) 모두 00 7.4·7.5에 등록됐습니다(해소). 값은 가정 | 값은 MVP-α 실측 후 |
| 5 | (해소) `default_action=hold` 불변식 | → 03 4.4 INV-Q-06, Q4 `resolution_source`(`default_applied`/`deadline_hold`) 구분. `QuestionRecommendation` 스키마는 4.3절 | — |
| 6 | (해소) `AnswerReflection.locations` 형태 | 03 v0.2 3.4 `locations`에 `{ref_type, ref_id}` 반영 | — |
| 7 | (해소) 비차단형 잠정 진행 기록 | 03 v0.2 3.3 `context_snapshots.provisional_question_ids` 반영. 채우는 절차는 → 04 | — |
| 8 | 주요 인물 판정 | U3(`major_character_fate`)의 근거: 기획서 승인된 주요 인물 목록인지, 엔티티 속성인지 | 06·03 |
| 9 | Chat SDK 사용 방식 | `Chat` 코어 없이 어댑터 직접 호출 가능 여부, StateAdapter 필요성, 4.43.0 고정 시 polling·Gateway 동작 변화 [미확인] | 메신저 스파이크(→ 09), MVP-α 착수 전 |
| 10 | (해소) 승인·공개 뒤 판별 확정의 사실 승격 | → 06 6.4 "판별 후 늦은 승격", 07 4.6 LB-3 | — |
| 11 | (해소) `local_trusted`에서 휴대폰의 화 전문 열람 | 9.7절에서 결정: 요약 승인 기본 + 화 전문 `.txt` 첨부 옵트인(NFR-SEC-04 예외). LAN 노출은 ADR-002와 충돌해 채택하지 않음. 2026-10-28 사용자 확정(PRD v0.5 FR-MSG-05·NFR-SEC-04, 01 P-08 반영, 01 F-13 해소) | — |
| 12 | 미확인 외부 사실 | Telegram 딥 링크 시작 파라미터 길이·문자, Discord Message Content intent 조건, 스레드 보관 해제 동작, 봇 첨부 한도, 셀렉트 옵션 설명 길이, Discord 메시지 2,000자(현재 [2차]) | 메신저 스파이크(→ 09) |
| 13 | 판별 질문의 KPI 집계 | "화당 전체 질문 3건 이하"(PRD 9절)에 판별·중복 질문을 넣을지, 별도 지표로 둘지. `publish_batch` 승인(차단형)을 "화당 차단형" 집계에서 뺄지 | 01 KPI 정의, MVP-α 첫 10화 실측 후 |
| 14 | 반영 위치 판정 정확도 | 8.2절 규칙으로 위치를 못 찾는 비율. 높으면 `writer` 출력에 답변 ID 주석을 요구하는 방식 검토 | MVP-α 실측 후(→ 07) |
| 15 | (해소) 답변 출처 링킹 규칙의 06 반영 | 7.1절 "답변 속 지칭 표현의 연결 규칙": 06 3.8 L4 입력에 답변 출처 문맥 창 추가, 3.9 자동 확정 조건에 `source_kind=answer` ∧ `mention_kind ∈ {pronoun, zero, address, descriptive}` 예외 추가. → 06 3.8 L4 입력, 3.9 자동 확정 금지 표에 반영됨 | — |
| 17 | 컨셉 승인 질문의 마감·리마인더 | 차단형 기본(12시간 + 2회)이 컨셉 단계에 맞는지(11 O-C14) | MVP-α 사용성 |
| 18 | 컨셉 승인 반영 기록 방식 | `answer_reflection_items`에 `ref_type=concept_brief`로 남기는 가정(11 O-C15) | 05 다음 개정 |
| 19 | 컨셉 대화 스트리밍 | Telegram `sendMessageDraft`(30초 임시 미리보기 [1차])·웹 SSE 사용 여부(11 O-C11) | v1, K-C9 결과 |
| 16 | (해소) 보류 마감 뒤 늦은 답의 `late_resolution` 값 | `deadline_hold`로 닫힌 질문에 온 늦은 답(6.2절)은 영향 계산 대상이 아니라 보류 결정의 입력입니다. 사용자가 웹에서 확정했을 때 남길 `late_answer_resolution` 값이 없습니다(`no_change`는 "같은 결과", `dismissed`는 "무시"). 00 6.4에 `applied_to_hold`를 추가해 해소했습니다 | — |

---

## 부록 A. 요구 → 절 대응

| 요구 | 절 |
|---|---|
| FR-NOV-07~09 (컨셉 대화·승인) | 3.3 `concept_confirm`, 3.7, 5.3 action `c`, 6.4, 9.4, 10.1 |
| FR-MSG-01 | 3.1~3.3, 5.4 |
| FR-MSG-02 | 9.2, 9.6 |
| FR-MSG-03 | 9.3 |
| FR-MSG-04 | 5.3, 9.1 `render` |
| FR-MSG-05 | 3.2, 9.7, 10.2 |
| FR-MSG-06 | 2.3, 5.1, 5.2 |
| FR-MSG-07 | 4.3, 5.5 |
| FR-MSG-08 | 6.5 |
| FR-MSG-09 | 8 |
| FR-MSG-10 | 5.1, 5.4, 5.5 |
| FR-MSG-11 (v1) | 6.4 |
| FR-MSG-12 | 1 P7, 5.1, 9.1 `web` |
| FR-MSG-13 (v1) | 9.1 |
| FR-MSG-14, 15 (이후) | 범위 밖(9.7 선택지 (d)) |
| FR-MSG-16 | 7 |
| FR-MSG-17 | 8.1 F7, 5.2 |
| FR-MSG-18 | 6.2, 9.5 |
| FR-HIL-01a~c, 02 | 10.1 |
| FR-HIL-03 | → 04 (일시정지), 5.1 D2(질문 일시정지) |
| FR-HIL-04 | 4.3(보류 항목 웹 편집) |
| FR-HIL-05 (v1) | 03 6.4(원천 기록) |
| FR-HIL-06 | 4.4 |
| FR-HIL-07 | 4.1, 4.2 |
| FR-HIL-08 (v1) | 5.5 |
| FR-SET-01 | 9.2 바인딩, 3.5(외부 전송 범위 안내) |
| FR-SET-02 | 9.2, 9.3 |
| FR-SET-03 | 9.6 |
| FR-ONT-14~17 (질문) | 3.6 |
| FR-ONT-18 (질문) | 3.1 대안 결정, 3.3 `schema_change` |
| FR-FOR-04, 06 | 3.3 |
| FR-BUD-02, 03 | 3.3 `budget` |
| NFR-REL-02 | 6.1, 9.2 |
| NFR-REL-03 | 9.2, 9.3, 9.4 |
| NFR-SEC-01 | 6.1 I4, 9.2, 9.3 |
| NFR-SEC-04 | 1 P5, 3.5, 9.7 |
| R-5 | 3.6.5, 5.2 |
| R-12 | 10.5 |
| R-18 | 3.6 |

## 부록 B. 이 문서가 새로 정한 이름

| 종류 | 이름 |
|---|---|
| 타입·스키마 | `QuestionDraft`, `QuestionView`, `QuestionRecommendation`(`option_idx`, `text`, `default_action ∈ {apply, hold}`, `provisional`), `PreviewExcerpt`, `EntityCandidateValue`, `InboundAction`, `ChannelCapabilities`, `RenderedMessage`(`attachments` 포함) |
| 엔티티·테이블 | `AnswerSession` (`answer_sessions`, 접두사 `ase`, 상태 enum `answer_session_status`. 00·03 등록) |
| 포트·구성 요소 | `ChannelAdapter`, `TelegramPoller`, `DiscordGatewaySupervisor` |
| 형식 | `callback_payload` = `v1\|<action>\|<question_id>\|<idx>`, `action ∈ {a, t, r, m, d, c}`(`c`는 `concept_session_id`, 예약 `idx` 900~904); 발신함 멱등 키 `<outbox_kind>:<ref_id>:<channel_id>:<n>`; `approve_reject` 선택지 규약(`idx 0/1`, 대안 결정 `maps_to`·`variant`, 승인 `payload.decision_variant`) |
| 절차 ID | `TelegramPoller` TP1~TP8, 디스패처 D1~D7, 등급 판정 G1~G5, 상향 규칙 U1~U7, 수신 I1~I7, 해석 T1~T7, 반영 F1~F7 |
| 상태 전이 ID | DG1~DG3, IN1~IN7, AS1~AS4, AN1~AN3, IT1~IT6, RF1~RF3, OB1~OB7, QD1~QD6, CH1~CH7, BT1~BT4 |
| 기본값 키 | 11절 미결 4 목록(12개 00 등록, 4개 미등록) |
