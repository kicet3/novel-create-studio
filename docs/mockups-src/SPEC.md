# Mockup fragment contract

You build ONE screen of a clickable-looking (static) product mockup for "novel-create-studio" (자율 AI 웹소설 스튜디오). All screens are assembled into one HTML page that already loads `base.css` (read it: tokens, components, messenger mocks). Mockups are illustrative wireframe-fidelity UI, written in Korean.

## Output file
Write exactly one file: `screens/<id>.html` (path given in your task). It must contain ONLY:

```html
<section class="screen" data-screen="<id>" data-title="<한국어 화면명>" data-release="MVP-α|MVP-β|v1|v2" data-fr="FR-UI-01, FR-...">
  <div class="app">
    <aside class="app-side"> ...shared sidebar (copy from below, mark your nav item is-active)... </aside>
    <div class="app-main"> ...your screen... </div>
  </div>
  <div class="annot"> <b>요구사항 대응</b> <ul><li><span class="fr">FR-..</span> 화면의 어느 부분이 이 요구를 충족하는지</li>...</ul></div>
</section>
<style> /* optional; EVERY selector must start with [data-screen="<id>"] */ </style>
```

Messenger screen (`messenger`) does not need the app shell; use `.tg` and `.dc` mocks side by side instead.

Rules:
- No external resources (no fonts, images, CDNs). Use inline SVG for graphs/thumbnails/placeholders. Image/video placeholders: SVG or CSS gradients with a label like "키프레임 초안".
- Use base.css tokens/classes. Never hardcode colors except inside the messenger mocks or SVG illustration fills that use `var(--...)`. Must look right in light AND dark.
- No `<script>` unless essential; if used, an IIFE scoped to `document.querySelector('[data-screen="<id>"]')`, no globals.
- Width: must work from 360px to 1200px wide without horizontal page scroll (tables go in `.tbl-wrap`).
- Keep it dense and realistic: real-looking Korean labels, numbers, statuses from the shared sample data below. Every status/state name must come from the PRD (quote exact enum identifiers where the PRD defines them, e.g. `candidate`, `approved`, `published_locked`, `planned → planted → reinforced → paid_off`, `blocking/non_blocking/informational`, autonomy levels `episode_approval/arc_approval/full_auto`).
- Size budget: ≤ 25 KB per fragment.

## Shared sidebar (copy verbatim, set `is-active` on your item)
```html
<aside class="app-side">
  <div class="app-brand"><span class="logo">N</span>Novel Studio</div>
  <div class="app-novel"><b>회귀자의 흉터</b><span class="muted">현대판타지 · 회귀물</span></div>
  <div class="app-nav" data-nav="home">작품 홈</div>
  <div class="app-nav" data-nav="board">작업 보드</div>
  <div class="app-nav" data-nav="inbox">인박스 <span class="count">3</span></div>
  <div class="app-nav" data-nav="manuscript">원고</div>
  <div class="app-nav" data-nav="ontology">세계관 온톨로지</div>
  <div class="app-nav" data-nav="foreshadow">떡밥</div>
  <div class="app-nav" data-nav="media">미디어 스튜디오 <span class="badge violet">v1</span></div>
  <div class="app-nav" data-nav="audit">감사 타임라인</div>
  <div class="app-nav" data-nav="settings">설정</div>
</aside>
```

## Shared sample data (use consistently)
- 작품: 「회귀자의 흉터」, 현대판타지 회귀물, 목표 120화, 분량 프로필 "기본(공백 포함 5,000~5,500자)", 하루 1화, 비축분 목표 5화, 연령 15세, 결말 방향 "주인공이 회귀 원인을 끊는다", 다중 시간선 사용 ON (시간선 T1 = 1회차, T2 = 회귀 후).
- 자율성 수준: `episode_approval` (화별 승인). 질문 민감도: 보통.
- 진행: 아크 4개 중 아크 1(1~30화) 진행 중. 승인 완료 11화, 공개 처리(`published_locked`) 8화, 비축분 3화(9~11화), 12화 집필 중(차단형 질문 대기), 13~14화 아웃라인.
- 인물: 강도현(주인공, 회귀자, 28세, 손목 흉터), 한서윤(여주인공, 길드 분석관 — 아크 2 끝까지 도현의 회귀 사실을 모름: 사용자 답변에서 온 인물 지식 제약), 최무진(조연 C, 도현의 옛 동료 — 12화 생사 질문 대상), 백하린(라이벌 길드장), 장소: 서울 마포 게이트 구역, 청람 길드 본부, 조직: 청람 길드, 흑월 결사.
- 떡밥: S-01 "도현 손목의 흉터" planted 5화 → 기한 40화, 중요도 높음; S-02 "흑월 결사의 은빛 문장" planted 3화 reinforced 9화 → 기한 30화; S-03 "서윤의 잃어버린 동생" planned 15화 설치 예정; S-04 "회귀 시계의 균열" planted 1화, 기한 120화(최종); S-05 "마포 게이트 붕괴 원인" planted 2화 기한 25화 (기한 임박).
- 연속성 이슈 예시: "12화 씬2: 서윤이 도현의 회귀를 암시하는 대사 — 인물 지식 제약 위반(심각도 높음)", "11화: 무진의 의수가 오른팔로 표기 — 캐논은 왼팔(중간)".
- 질문 예시: Q-128 차단형 `single_choice` "12화에서 최무진을 죽일까요?" 추천안: 살린다(근거: S-05 회수에 무진의 증언 필요), 마감 오늘 21:00. Q-129/130 비차단형 digest: 조연 이름, 지명. Q-131 `approve_reject` 11화 승인 요청.
- 비용: 이번 달 예산 상한 $80, 사용 $41.20 (52%), 화당 평균 $1.62, 소프트 경고 80%.
- 에이전트 역할: showrunner, planner, world_keeper, writer, continuity_editor, foreshadow_manager, line_editor, scene_director[확장], visual_producer[확장].
- 채널: Telegram 1:1 연결됨(@minjun), Discord 스레드 #회귀자의-흉터 (MVP-β).
- 미디어(확장): 대상 화 3화(공개 처리됨), 씬 4개, 샷 11개, 캐릭터 시트 강도현 승인/한서윤 검토 대기, 이미지 견적 $2.40, 영상 견적 $18.70.

## Verify
After writing, render it: create `preview-<id>.html` in the same build dir that links `base.css` and includes your fragment, then screenshot with
`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --window-size=1280,1800 --screenshot=<builddir>/shots/<id>-1280.png file://<builddir>/preview-<id>.html`
and also at `--window-size=390,2400` (→ `<id>-390.png`). Look at both screenshots (Read the PNG) and fix overflow, overlap, unreadable contrast. Also check dark mode by adding `data-theme="dark"` on `<html>` of the preview (→ `<id>-dark.png`). Delete nothing else.
