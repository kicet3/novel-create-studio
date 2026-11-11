# snowpage — 공개 독자 사이트 (`apps/public-reader`)

글은 각자 PC의 스튜디오(내부망)에서 쓰고, **snowpage**는 공개된 화만 받아서 보여 주는 Next.js 앱입니다(Vercel 배포).
소설 목록을 공개하고, 독자는 **로그인 없이 익명으로** 좋아요·평점(1~5)·댓글(답글 1단계, 닉네임 선택 · 기본 `익명`)을 남깁니다.
회원가입·로그인·계정은 없습니다.

```
스튜디오(PC, module publication) ──공개된 화만 upsert──▶ Supabase 공개 스키마(ncs_public) ◀──읽기·익명 반응── snowpage(Vercel)
  초안·설정·비밀·스튜디오 DB는 PC 밖으로 나가지 않음        novels / episodes / visitors / *_likes / ratings / comments / rate_limits
```

- 데이터 접근은 서버에서만(Server Components · Route Handlers, `postgres` 드라이버, Supabase **Transaction pooler**용: `prepare: false`, 작은 풀).
  DB 주소는 클라이언트로 가지 않습니다.
- 페이지: `/`(작품 목록), `/novels/[slug]`(소개·평점 평균·좋아요·목차), `/novels/[slug]/[no]`(읽기), `/admin`(운영), `sitemap.xml`, `robots.txt`.
  요청마다 렌더(nonce CSP), DB 읽기는 Next 데이터 캐시(태그 `snowpage-content`). 스튜디오가 동기화 직후 `POST /api/admin/revalidate`
  (`Authorization: Bearer ADMIN_TOKEN`)로 캐시를 바로 비우고, 그 토큰이 없으면 30초 뒤 저절로 갱신됩니다. `next build`는 DB 없이 돌아갑니다.
- 읽기 화면: 모바일 우선, 글자 수 기준 페이지 넘김(기본)/스크롤, 탭 영역·스와이프·키보드, Galaxy Fold 펼친 화면 두 쪽 보기·Viewport Segments,
  끝 카드(좋아요·댓글·다음 화), 보기 설정, 이어 읽기 위치(localStorage).
- PC(폭 1024px 이상, 접힌 화면 제외 — `src/lib/layout.ts`): 읽기 화면은 스튜디오 읽기 뷰어와 같은 공유 컴포넌트
  (`packages/reader-ui`: 페이지 넘김·스크롤 보기, 상단/하단 바, 목차 서랍, 보기 설정, 끝 카드, `reader.css`)를 씁니다.
  댓글은 오른쪽 패널, 좋아요·평점 링크는 끝 카드에 있습니다. 목록은 3~4열, 작품 홈은 2단(소개 | 목차), `/admin`은 표 형태입니다.
  767px 이하·폴더블(두 쪽 보기) 동작은 그대로입니다.

## Vercel 배포 (사용자가 하는 단계)

1. Vercel → New Project → 이 저장소 → **Root Directory `apps/public-reader`**, Framework **Next.js**.
   설치·빌드 명령은 `vercel.json`에 있습니다(워크스페이스 패키지 `@ncs/reader-core`·`@ncs/public-schema`를 먼저 빌드).
2. Settings → Environment Variables:

   | 이름 | 필수 | 기본값 | 뜻 |
   |---|---|---|---|
   | `DATABASE_URL` (없으면 `POSTGRES_URL`) | 예 | — | 제한 역할 `ncs_public_reader`로 Supabase Transaction pooler(6543)에 접속하는 URL |
   | `DB_SCHEMA` | | `ncs_public` | 스튜디오가 동기화하는 공개 스키마 |
   | `PUBLIC_ORIGIN` | | `https://novel.snowlink.team` | canonical·og:url, 쓰기 요청 Origin 검사 |
   | `ADMIN_TOKEN` | | (없음 = `/admin`·`/api/admin/revalidate` 꺼짐) | 24자 이상. 스튜디오 설치 설정 → 공개 사이트의 "snowpage 운영 토큰"에 같은 값을 넣으면 공개 직후 캐시를 바로 비웁니다 |
   | `IP_HASH_SECRET` | 쓰기에 필요 | (없음 = 좋아요·평점·댓글 꺼짐) | 32자 이상, IP는 HMAC-SHA256 해시로만 저장 |
   | `COOKIE_SECURE` | | `true` | `false`는 http://localhost 개발용 |
   | `BANNED_WORDS` | | — | 쉼표 목록, 포함된 댓글은 숨김(작성자에게만 "검토 후 보입니다") |
   | `ALLOW_PREVIEW_ORIGINS` | | `false` | `true`면 `https://*.vercel.app` 미리보기 배포의 쓰기도 허용 |

   잘못된 값은 서버 로그에 **변수 이름만**으로 알립니다(값은 출력하지 않음).
3. 도메인: Vercel → Settings → Domains에 `novel.snowlink.team`을 추가하고, DNS에 Vercel이 안내하는 `CNAME`(예: `cname.vercel-dns.com`)을 넣습니다.
   **이 단계는 사용자가 직접 합니다.** 쿠키는 호스트 전용(`__Host-` 접두사, Domain 속성 없음)입니다.

## Supabase 준비 (사용자가 하는 단계)

1. 스튜디오 `설치 설정 → 공개 사이트(snowpage)`에 **쓰기용** 연결 문자열(postgres 사용자, Transaction pooler)을 넣고 [지금 동기화].
   스튜디오가 `CREATE SCHEMA IF NOT EXISTS ncs_public`과 그 안의 테이블·`schema_migrations`만 만듭니다(RLS 켬, anon/authenticated 정책 없음).
   역할·확장·다른 스키마는 건드리지 않습니다.
2. 같은 화면의 **독자 사이트용 제한 역할 SQL**을 복사해 `<직접 입력>`을 긴 무작위 비밀번호로 바꾸고 Supabase SQL Editor에서 직접 실행합니다.
   역할은 `novels`/`episodes` 읽기, 반응 테이블 읽기·쓰기만 가능합니다(스키마 버전이 오르면 다시 실행).
3. `ncs_public`을 Supabase Data API의 **Exposed schemas에 넣지 마세요.**
4. Vercel의 `DATABASE_URL`에는 이 제한 역할의 URL을 넣습니다(`postgresql://ncs_public_reader.<project-ref>:<비밀번호>@<pooler-host>:6543/postgres`).

## 스튜디오 동기화

작품 설정 → 공개 사이트에서 작품마다 노출을 켜고 공개 주소(slug)를 정하면, 그 작품의 `published` 화(`published_version_id` 원고)만
Supabase로 upsert합니다. 공개 취소·노출 끄기는 행을 지웁니다(댓글은 남지만 사이트에서는 보이지 않음). 화 공개·설정 변경 직후 + 60초 대조로
자동 동기화하며, 바뀐 것만 내용 해시로 골라 작품당 한 트랜잭션으로 씁니다. 바뀐 것이 있으면(또는 [지금 동기화]) 이어서
`POST https://novel.snowlink.team/api/admin/revalidate`를 불러 독자 페이지 캐시를 비웁니다(스튜디오에 저장한 `ADMIN_TOKEN`, 5초 제한, 실패해도 동기화는
성공으로 남고 "마지막 캐시 갱신"에만 표시). 연결 확인·마지막 동기화·오류(비밀 제거)는 설정 화면에 보입니다.

## 로컬 개발

```sh
cp apps/public-reader/.env.example apps/public-reader/.env.local   # 값 채우기: PUBLIC_ORIGIN=http://localhost:3000, COOKIE_SECURE=false
pnpm public:dev      # = pnpm --filter @ncs/public-reader dev (의존 패키지 빌드 후 next dev)
pnpm public:build    # 의존 패키지 + next build
```

## 보안 요약

- 쓰기: CSRF 이중 제출(httpOnly 쿠키 + `X-CSRF-Token`) + `Origin` = `PUBLIC_ORIGIN` 검사, JSON만, 8KB 제한.
- 익명 방문자 id: 첫 쓰기 때 발급하는 httpOnly·Secure·SameSite=Lax 쿠키(개인정보 없음). 방문자 id·IP 해시는 응답에 나오지 않습니다.
- 요청 제한: `rate_limits` 테이블의 고정 창(서버리스 인스턴스 간 공유), 방문자별 + IP 해시별. 허니팟 필드, 같은 댓글 반복 차단, 금칙어 보류.
- 댓글은 평문(React 텍스트)으로만 표시. 자기 댓글만 삭제(방문자 쿠키 기준), 운영자는 `/admin`에서 숨김·삭제.
- 헤더: 페이지별 nonce CSP(`script-src 'nonce-…' 'strict-dynamic'`, `frame-ancestors 'none'`), `nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, `X-Frame-Options: DENY`, `poweredByHeader: false`.

알려진 제약: 공개 주소(slug)를 바꾸면 기존 반응은 옛 주소에 남습니다. 쿠키를 지우면 같은 사람도 새 방문자가 됩니다(IP 해시 제한으로 남용만 막음).
