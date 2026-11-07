# revision — 화별 수정 대화 (설계 추가 0018)

원고가 있는 화(checking·polishing·awaiting_approval·approved·published)마다 대화 스레드 하나. 작가가 자유롭게 묻거나 본문 구간을 골라 [이 부분 묻기](anchor = version id + quote + offsets)로 묻고, 편집자 에이전트(`revision_chat_turn`, line_editor, 읽기 전용)가 대화 기록 전체를 보고 답합니다.

- 컨텍스트: 이번 화 원고(현재 버전), 화 계획·아웃라인, 관련 사실 `[F:id]`, 이번 화 떡밥 `[S:id]`, 이전 화 요약(씬 요약), 작가 확인 메모, 생성 기록(버전 목록 + 초고 run의 context snapshot = 실제 프롬프트 입력) + ContextBuilder 섹션(story_plan·cast·world·entity_cards…).
- 출력(zod, `callWithRepair`): `reply_text`, `diagnosis_kind`, `sources[]`, `question{text, options}`, `proposals[]`. 근거가 없으면 sources=`none`, 답에 "근거 없이 쓴 부분". 패치 quote는 원고에 정확히 한 번, 겹치지 않고 quote 합계·replacement 합계 모두 원고의 25% 이하 — 수정 대화 후에도 남은 문제 항목은 버립니다.
- 제안: text_patch → 작가가 [적용](일부 선택 가능) → `manuscript.applyHumanEditTx`(E16: 사람 편집 버전, 검사·추출 재실행, 승인 대기 중이면 승인 요청 닫힘, 승인된 화는 checking으로). 원고가 바뀌었으면 quote를 다시 찾고 못 찾으면 `stale`. setting_change → 후보 사실이면 바로 수정, 승인/공개 캐논이면 `canon_change`/`retcon` 승인(이 모듈이 처리기 등록) — 승인되면 옛 사실 철회 + 새 값 승인 사실(승인 시점에 옛 사실이 이미 바뀌었거나 같은 사실에 새 요청이 들어와 대체되면 `stale`, 아무것도 쓰지 않음; 새 값이 슬롯 충돌로 확정되지 못하면 롤백). impact_note → 현재 원고에 그 사실 자체(관계: 두 엔티티 함께, 값: 주어 + 값 문구)가 나오는 다른 화 목록(자동 수정 없음, 커밋 전 `execute`에서 계산).
- 다음 턴 기록에는 앞 턴의 질문·선택지, 제안 내용과 처리 결과(적용됨/거절/원고가 바뀜 …), 시스템 안내가 함께 들어갑니다.
- [고치지 않고 끝내기] + "작가 확인: 의도대로 둠" 메모(본문·설정을 바꾼 대화면 기본 꺼짐, 작가가 직접 쓴 문구가 있어야 저장) → `episode_author_notes` → 뒤 화 집필 컨텍스트 `constraints` 섹션. [전체 다시 쓰기] → requestRevision(승인됨) / 화 승인 반려(승인 대기).
- 한 번에 한 턴(409 `revision_turn_in_flight`), SSE `…/revision-chat/stream`(컨셉 대화와 같은 이벤트), 감사 `revision_chat.*`.

API (`…` = `/api/novels/:novelId`): `GET …/episodes/:no/revision-chat` · `POST …/messages` `{body, anchor?}` · `POST …/proposals/:id/decision` `{decision, patchIdx?}` · `POST …/close` `{saveNote, note?}` · `POST …/rewrite` `{decisionNote, reworkFrom}` · `POST …/stop-turn` · `GET …/stream`.
