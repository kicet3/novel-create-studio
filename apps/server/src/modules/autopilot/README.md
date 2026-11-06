# autopilot — 완전 자율 진행 (설계 추가 0014)

자율성 수준이 `full_auto`인 작품을 사람 손 없이 계속 진행합니다. 테이블은 없습니다.
설정·상태·킬 스위치는 `novels` 컬럼(module novel)에, 결정은 승인·답변 행(module hitl)에 남습니다.

## 루프 `autopilot.tick`

30초마다 돌고, `autopilot`·`question`·`task` 신호가 오면 바로 돕니다. 작품마다 아래 순서로 처리합니다.

1. **멈춤 확인**
   - 킬 스위치(`autopilot_halted_at`)가 켜져 있거나 작품이 일시정지 상태면 아무것도 하지 않습니다.
   - 예산 하드 한도에 닿았으면 아무것도 하지 않습니다.
   - 월 예산이 경고 비율에 닿았고 `haltOnBudgetWarning`이 켜져 있으면 킬 스위치를 겁니다(사유 `budget_warning`).
   - 하루 비용 상한(`dailyBudgetUsd`)을 넘으면 `throttle`을 겁니다. 다음 현지 자정에 풀리고, 상한을 올리면 바로 풀립니다.
2. **앞단계** (`domain/steps.ts`)
   - 컨셉 확정은 opt-in일 때만 합니다. `concept.autoSubmitForApproval`이 [모두 확정]을 누르고 점검을 시작합니다.
   - 세계관 후보를 생성분마다 한 번 일괄 승인합니다. 충돌하는 후보는 '미확정'으로 남깁니다.
   - 캐스트의 빈 필수 항목은 AI가 채웁니다(`draft_cast` fill, 최대 2회). 그 뒤 캐스트를 확정합니다.
   - 세계관 생성이 끝나면 컨셉 값으로 연재 목표를 저장합니다. 결말 방향이 비어 있으면 사람 게이트입니다.
   - 기획서를 승인한 뒤 전체 구성이 없으면 작성을 요청합니다(최대 3회).
   - 각 단계는 20분 간격으로 다시 시도합니다.
3. **대기 승인** (`domain/policy.ts`)
   - 판정 결과는 `auto`, `wait`, `human` 셋 중 하나입니다.
   - `auto`이면 `hitl.autoDecideApproval`을 호출합니다. hitl은 novel 행을 잠그고 레벨·멈춤·설정·throttle을 다시 확인한 뒤 결정합니다.
     - 답변 행: 응답자는 위임한 사람, `auto_answered=true`
     - 질문: `resolution_source=auto_answer`
     - 승인 행: `auto_decided=true`, `decided_by_user_id=null`
     - 처리기에는 `ctx.auto=true`를 넘깁니다.
   - 처리기가 거부하면 롤백하고 `payload.autopilot.heldReason`을 남겨 사람에게 넘깁니다.
   - `human`이면 같은 방식으로 held 표시를 남깁니다. 그다음 디스패처가 메신저로 보내고, 인박스 알림과 메신저 알림을 한 번 보내고, `autopilot.gate_hit`을 기록합니다.
4. **질문 자동 응답**
   - 대상: 민감도 `normal`인 선택형 질문, 생성 후 `autoAnswerAfterMinutes`분이 지난 것
   - 차단형은 `autoAnswerImportant`가 켜져 있을 때 `arc_goal`·`setup_due_high`만 답합니다.
   - 추천 선택지로 답하고 `resolution_source=auto_answer`를 남깁니다.
5. **예약 공개**
   - `publish_policy=scheduled`일 때만 합니다.
   - 승인된 화마다 다음 빈 슬롯을 배정합니다(`episode.publish_scheduled`). 슬롯은 주당 화수를 요일에 나누고 `publishTimeLocal`, 작품 시간대를 씁니다.
   - 시각이 된 화를 화 순서대로 공개합니다.
6. **상태 요약**
   - `autopilot_state`에 phase, next, waiting, scheduled, throttle, 시도 횟수, 알림 키를 저장합니다. `updated_at`은 건드리지 않습니다.

## 자동 결정 대상

| 승인 | 조건 |
|---|---|
| `episode` | 분량 3,000자 이상, 안전(`safety_*`) 이슈 이력 없음, 재작성 상한 없음, 열린 high 이슈 없음(옵션: medium도 없음). 화에 걸린 리트콘·캐논 변경 승인이 대기 중이면 기다림 |
| `arc_plan` (재계획 포함) | 구성 승인됨. 새 인물의 빈 항목은 AI가 채우고(최대 2회, 그다음은 사람), 완성된 제안은 출처를 바꾸지 않고 수락한 뒤 승인 |
| `series_bible` | 최신판이 승인 대기 중 |
| `story_structure` | opt-in. 완결성 사유 없음. 승인된 결말이 바뀐 재승인은 항상 사람 |
| `concept_brief` | opt-in. 첫 컨셉. 안전·유사성 신호 0건 |
| 나머지 | 항상 사람. DB 제약 `approvals_ck_auto`도 막음: retcon, canon_change, ending_change, budget_resume, setup_abandon, publish_batch, schema_change, identity_change, safety_review, media 계열, arc |

autopilot은 반려하지 않습니다. 품질 문제의 재작업은 검사 게이트의 루프가 맡습니다.

## 스케줄러와의 연결 (module manuscript)

- 스케줄러는 full_auto 작품의 novel 행을 읽어 다음을 지킵니다.
  - 멈춤이나 throttle이면 새 `outline_episode`와 `schedule_episodes`를 만들지 않습니다.
  - 하루 새 착수가 `maxEpisodesPerDay`에 닿으면 더 착수하지 않습니다(오늘 만든 첫 아웃라인 작업 수 기준).
- full_auto의 예외 경로 네 곳을 지웠습니다(바로 승인 E9(c), AR4, 재계획 즉시 적용, 계획 승인 없는 착수). 이제 모든 수준에서 승인 행을 거칩니다.

## 안전 규칙 (검토 반영)

- 컨셉 자동 확정은 LLM 유사성·안전 점검이 실제로 답했을 때만 합니다(`checks.llm_checked`). AI 연결이 없거나 점검이 비어 있으면 `concept_unchecked`로 작가에게 넘깁니다.
- 질문 자동 응답은 저장된 `sensitivity`와 함께 주제·차단 근거를 다시 봅니다(0014 이전 행 보호, 마이그레이션도 기존 행을 `high`로 채움). 앞 질문(`depends_on_question_id`)이 열려 있으면 답하지 않습니다.
- tick 중간에 멈춤·레벨 변경·일시정지가 들어오면, 앞단계 실행·캐스트 채움·제안 수락·자동 승인·예약 공개 직전에 작품 행을 다시 읽어 멈춥니다.
- 자동 승인 트랜잭션은 사람 답변과 같은 순서로 잠급니다(question → approval → novel).
- 소유 모듈이 거부한 경우(4xx)만 바로 사람 몫(`heldReason`)으로 넘깁니다. 타임아웃·잠금 충돌 같은 일시 오류는 다시 시도하고, 3번 연속 실패하면 넘깁니다.
- `wait` 판정이 60분을 넘으면 배너에 보이고 인박스·메신저로 한 번 알립니다(보류하지는 않음). 실패한 작업(작업 보드 "사람 조치 필요")도 배너의 사람 확인 대기에 들어갑니다.
- 게이트 알림 키는 알림과 같은 트랜잭션에서 저장합니다(중복·누락 없음).
- 월 예산 경고로 멈춘 뒤 [재개]하면 그달에는 같은 경고로 다시 멈추지 않습니다.
- 다시 켤 때 "컨셉 확정·구성·결말도 자동 승인" opt-in은 이전 값을 이어받지 않습니다(요청에 명시 + 경고 확인 필요).
- arc_approval에서 다른 수준으로 바꾸면 스케줄러가 묶음 대기 화의 화별 승인을 만들고(대기 중인 플롯 묶음은 취소, 플롯은 `active`), arc_approval로 바꾸면 이미 화별 요청이 있는 화는 묶음에서 뺍니다. 묶음 승인 뒤에도 승인 대기 화가 남으면 플롯은 완료하지 않고 `active`로 돌아갑니다(AR6).
