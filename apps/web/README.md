# @ncs/web

Novel Create Studio 웹 UI. Vite 8 + React 19 + TypeScript(strict) + Tailwind 4 + TanStack Query 5 + react-router 7. 화면 문구는 한국어입니다.

## 명령

루트에서 실행합니다(pnpm 9.15.4, 루트 README 참고).

```sh
pnpm --filter @ncs/web dev         # http://127.0.0.1:5173, /api → http://127.0.0.1:3100
pnpm --filter @ncs/web typecheck
pnpm --filter @ncs/web build       # tsc --noEmit + vite build → apps/web/dist (서버가 프로덕션에서 정적 제공)
pnpm --filter @ncs/web preview     # dist 미리보기(:4173, /api 프록시 동일)
pnpm dev                           # 서버 + 웹 동시 실행
```

| 환경 변수 | 기본값 | 용도 |
|---|---|---|
| `NCS_WEB_HOST` | `127.0.0.1` | dev/preview 바인드 주소 (예: Tailscale IP. 와일드카드 `0.0.0.0`은 쓰지 마세요 — API 프록시가 LAN에 열립니다) |
| `NCS_WEB_PORT` | `5173` | dev 포트(`strictPort`) |
| `NCS_WEB_PREVIEW_PORT` | `4173` | preview 포트 |
| `NCS_API_URL` | `http://127.0.0.1:${NCS_PORT:-3100}` | `/api` 프록시 대상 |
| `NCS_ALLOWED_HOSTNAMES` | — | 쉼표 구분. Vite가 받아들일 Host 헤더(MagicDNS 이름 등). 서버의 같은 변수와 맞춥니다. |

`@ncs/shared`는 `@ncs/source` 조건으로 TS 소스를 직접 읽습니다(shared를 빌드하지 않아도 됩니다).

## 구조

```text
src/
├── main.tsx                 # QueryProvider + RouterProvider
├── app/
│   ├── router.tsx           # 라우트 표(기능 페이지는 route lazy로 코드 분할)
│   ├── layouts.tsx          # GlobalLayout(/novels, /onboarding, /settings), NovelLayout(/novels/:novelId/*)
│   ├── novel-context.ts     # useNovelId()
│   ├── RouteError.tsx       # errorElement, NotFoundPage
│   ├── theme.css            # base.css 토큰(light/dark) → Tailwind @theme, 기본 스타일, 포커스 링
│   └── theme-mode.ts        # 시스템/라이트/다크 수동 전환(localStorage `ncs.theme`, <html data-theme>)
├── api/
│   ├── client.ts            # apiFetch/api.get…, ApiRequestError, errorMessage
│   ├── query-client.ts      # QueryProvider, POLL_INTERVAL_MS(ui.poll_interval_seconds=5s)
│   ├── query-keys.ts        # queryKeys 팩토리(작품 단위 계층)
│   └── health.ts            # useHealth() — 장애 배너용
├── components/
│   ├── ui/                  # 디자인 시스템(아래 카탈로그). index.ts에서 모두 export
│   └── layout/              # AppShell, Sidebar, PageHeader, StatusBanner, ThemeToggle, PlaceholderPage, nav.ts
├── features/<name>/         # 화면별 코드(페이지·쿼리 훅·하위 컴포넌트)
└── lib/                     # cx(), useDocumentTitle()
```

## 라우트

| 경로 | 화면(목업 `data-screen`) | 파일 |
|---|---|---|
| `/` | `/novels`로 이동 | — |
| `/novels` | 작품 목록 + 새 작품 진입 | `features/novels/NovelsPage.tsx` |
| `/onboarding` | 작품 생성·목표 설정 (`onboarding`) | `features/onboarding/OnboardingPage.tsx` |
| `/settings` | 설치 설정 (`settings` 설치 부분) | `features/settings/InstallSettingsPage.tsx` |
| `/dev/ui` | 컴포넌트 카탈로그(개발용 표본) | `features/ui-catalog/UiCatalogPage.tsx` |
| `/novels/:novelId` | 작품 홈 (`home`) | `features/home/NovelHomePage.tsx` |
| `/novels/:novelId/concept` | 컨셉 (11 §4.1 `concept`) | `features/concept/ConceptPage.tsx` |
| `/novels/:novelId/board` | 작업 보드 (`board`) | `features/board/BoardPage.tsx` |
| `/novels/:novelId/inbox[/:questionId]` | 인박스 (`inbox`, 메신저 딥링크 05) | `features/inbox/InboxPage.tsx` |
| `/novels/:novelId/manuscript`, `/novels/:novelId/episodes/:episodeNo` | 원고 (`manuscript`, 08 §9.4) | `features/manuscript/ManuscriptPage.tsx` |
| `/novels/:novelId/ontology`, `/novels/:novelId/entities/:entityId` | 세계관 온톨로지 (`ontology`, 08 §9.5). `entities`는 `ontology`로 이동 | `features/ontology/OntologyPage.tsx` |
| `/novels/:novelId/setups[/:setupNo]` | 떡밥 (`foreshadow`) | `features/setups/SetupsPage.tsx` |
| `/novels/:novelId/audit` | 감사 타임라인 | `features/audit/AuditPage.tsx` |
| `/novels/:novelId/settings` | 작품 설정 | `features/settings/NovelSettingsPage.tsx` |

사이드바 항목은 `components/layout/nav.ts`의 `NOVEL_NAV`가 정합니다(목업 SPEC 순서 + 컨셉). 미디어 스튜디오(v1)는 MVP-α 범위 밖이라 뺐습니다.

## 기능 화면 만드는 법 (`features/<name>/`)

1. **페이지 파일 교체.** 지금 페이지는 `PlaceholderPage`만 렌더링합니다. 같은 파일·같은 export 이름을 유지하고 내용을 바꾸면 라우터를 고칠 필요가 없습니다. 페이지 맨 위에 `<PageHeader title=… subtitle=… actions=… />`를 둡니다(h1, `document.title` 처리). 새 경로가 필요하면 `app/router.tsx`에 `lazy: page(() => import(...), (m) => m.X)` 형태로 추가합니다.
2. **데이터는 `features/<name>/api.ts`에.** DTO zod 스키마는 `packages/shared/src/dto/<module>.ts`에 두고 `dto/index.ts`에서 re-export합니다(서버와 공유). 화면은 DTO만 받습니다(08 §9.1).
   ```ts
   // features/board/api.ts
   export function useTasks(novelId: string, filter: TaskFilter) {
     return useQuery({
       queryKey: queryKeys.novel(novelId).tasks(filter),
       queryFn: ({ signal }) => api.get(`/novels/${novelId}/tasks`, { query: filter, schema: taskListSchema, signal }),
       refetchInterval: POLL_INTERVAL_MS, // 인박스·보드만 주기 재조회(MVP-α, WS 없음)
     });
   }
   ```
   - 모든 쿼리는 창 포커스 시 재조회됩니다(기본값). 변경(mutation) 후에는 `queryClient.invalidateQueries({ queryKey: queryKeys.novel(id).all })` 또는 더 좁은 키를 무효화합니다.
   - 4xx는 재시도하지 않습니다. 다른 작품 ID는 404(T-4)이므로 `isApiRequestError(e) && e.isNotFound`로 처리합니다.
   - 오류 문구는 `errorMessage(e)`를 씁니다(서버 `{error:{code,message}}`의 message 또는 한국어 기본 문구).
3. **표시 규칙.** enum 값은 `StatusBadge`(또는 `labelKo`)로 한국어 라벨을 보입니다. 내부 ID 대신 `display_no`(`T-12`, `S-01`)를 보입니다. 색만으로 상태를 전달하지 않습니다(배지는 기호 포함).
4. **작품 범위 경로.** `useNovelId()`와 `novelPath(novelId, "board")`를 씁니다. API 경로는 `/novels/:novelId/...`(`api.*`가 `/api`를 붙임).
5. **사이드바 연동.** 인박스 건수·작품 제목은 `app/layouts.tsx`의 `NovelLayout`에서 해당 쿼리로 채웁니다(`SidebarNavItem count`, `Sidebar context`). 장애 배너 확장은 `components/layout/StatusBanner.tsx`.
6. **스타일.** Tailwind 유틸리티 + 토큰 색(`bg-surface`, `text-muted`, `border-border`, `text-accent`, `bg-ok-soft` …)만 씁니다. 색을 하드코딩하지 않습니다(라이트·다크 모두 맞아야 함). 360px~1200px에서 가로 스크롤이 생기지 않게 하고, 넓은 표는 `DataTable`/`TableWrap` 안에 둡니다. 반응형 기준은 목업과 같은 `max-[860px]`·`max-[520px]`입니다.
7. **접근성(NFR-ACC-01, 08 §9.9).** 클릭 가능한 것은 `<button>`/`<Link>`만 씁니다. 포커스 링(`:focus-visible`)을 숨기지 않습니다. 승인·반려·제출은 `ConfirmDialog`로 한 번 확인합니다. 단일 문자 단축키는 입력란에 포커스가 있을 때 끕니다. 폼 컨트롤은 `Field`로 감싸 라벨·오류를 연결합니다.

## 컴포넌트 카탈로그 (`components/ui`)

실제 렌더링은 `/dev/ui`에서 볼 수 있습니다. 모두 `import { … } from "../../components/ui/index.js"`.

| 컴포넌트 | 목업 클래스 | 설명 |
|---|---|---|
| `Badge` (`tone`, `glyph`) | `.badge.<tone>` | 상태 pill. tone: `neutral ok warn danger info accent violet` |
| `StatusBadge` (`enum`, `value`) | `.badge` | `@ncs/shared` enum 값 → 한국어 라벨 + tone + 기호. 원래 식별자는 title로 |
| `toneForStatus(enum, value)` | — | enum 값의 tone 계산(표·차트에서 재사용) |
| `Chip` | `.chip` | 테두리 태그(떡밥 번호, 필터) |
| `CountBadge` | `.app-nav .count` | 빨간 건수(스크린리더용 "n건") |
| `Button` (`variant`, `size`, `loading`, `icon`) | `.btn .primary .danger .ghost .sm` | 기본 `type="button"` |
| `ButtonLink` | `.btn` | 버튼 모양의 라우터 링크(이동은 링크로) |
| `Spinner` | — | 로딩 표시 |
| `Card` (`title`, `actions`, `headingLevel`) | `.card` | 제목이 있으면 `<section>` |
| `KpiCard` (`label`, `value`, `of`, `delta`) | `.card.kpi` | 지표 타일 |
| `Grid` (`cols` 2/3/4), `Split` | `.grid .g2/.g3/.g4`, `.split` | 목업과 같은 반응형 열 |
| `Callout` (`tone`, `title`, `actions`) | `.callout` | 배너. danger=`role=alert`, warn=`role=status` |
| `Progress` (`value`, `max`, `tone`, `label`) | `.progress` | `role=progressbar` |
| `TableWrap` (`label`), `Table`, `Th`, `Td` | `.tbl-wrap .tbl` | 가로 스크롤 영역(키보드 포커스 가능) |
| `DataTable<T>` (`columns`, `rows`, `rowKey`, `empty`) | `.tbl` | 열 정의형 표. `rowHeader` 열은 `<th scope=row>` |
| `Tabs` (`items`, `value`/`defaultValue`, `onChange`, `label`) | `.tabs` | WAI-ARIA 탭, ←/→/Home/End |
| `EmptyState` (`title`, `description`, `actions`) | — | 빈 목록·준비 중 화면 |
| `KeyValueList` (`items`) | — | `<dl>` 키·값(설정·상세) |
| `Dialog` (`open`, `onClose`, `title`, `footer`) | — | 네이티브 `<dialog>` 모달. 포커스 가둠·Esc·배경 클릭 닫기·여는 요소로 포커스 복귀 |
| `ConfirmDialog` (`onConfirm`, `onCancel`, `danger`, `busy`) | — | 승인·반려·제출 확인 단계 |
| `Field`, `Input`, `Select`, `Textarea` | `.field .input` | 라벨·힌트·오류 자동 연결(`aria-describedby`, `aria-invalid`) |
| `Avatar`, `List`/`ListItem`, `ReqTag`, `InlineStatus` | `.avatar .list .fr` | 에이전트 이니셜, 구분선 목록, 요구사항 태그, 로딩/오류 한 줄 |

레이아웃(`components/layout`): `AppShell`(건너뛰기 링크, `<main id="main">`, 장애 배너), `Sidebar`/`SidebarNavItem`(`<aside><nav>`, 활성 항목 `aria-current`), `PageHeader`, `StatusBanner`, `ThemeToggle`, `PlaceholderPage`.

## 테마

`app/theme.css`가 `docs/mockups-src/base.css`의 토큰을 그대로 옮겼습니다. 기본은 OS 설정(`prefers-color-scheme`)을 따르고, 사이드바의 테마 전환으로 라이트·다크를 고정할 수 있습니다(`<html data-theme>`, `index.html`의 인라인 스크립트가 첫 렌더 전에 적용). Tailwind 색 이름은 토큰 이름과 같습니다: `bg`, `surface`, `surface-2`, `text`, `muted`, `faint`, `border`, `accent(-soft/-text)`, `ok/warn/danger/info/violet(-soft)`, `code-bg`, 그림자 `shadow-card`.
