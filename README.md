# Novel Create Studio (자율 AI 웹소설 스튜디오)

설계 문서: `docs/` (PRD v0.4, `docs/design/00`~`11`). 이 저장소는 MVP-α 범위(PRD §8, design/09 §3.1)를 구현합니다.

## 구현된 것 (MVP-α)

한 사람이 자기 컴퓨터에서 돌리는 단일 사용자 스튜디오입니다. 실제 모델은 Claude·GPT·Grok·Gemini 중 연결한 공급자를 씁니다
([AI 공급자 연결](#ai-공급자-연결)). 테스트용 대체 모델은 없습니다. 테스트는 실제 Claude 어댑터를 로컬 mock
Claude API(`apps/server/test/support/scripted-claude.ts`)에 연결하고, 테스트마다 필요한 모델 응답을 직접 적습니다.
아래 루프 전체는 `apps/server/test/integration/pipeline-e2e.test.ts`가 이렇게 검증합니다.

작품 흐름: **컨셉(스토리라인) → 캐릭터 → 연재 목표 → 기획서(시리즈 바이블) → 아크·회차 집필**. 왼쪽 메뉴와 작품 홈의 "설정 마무리"가
이 순서를 따르고, 앞 단계를 마쳐야 다음 단계가 열립니다(컨셉 승인 전 캐릭터 편집 422 `concept_not_approved`, 캐스트 확정 전 첫 목표 저장
422 `cast_not_confirmed` — 웹은 확정 전까지 [목표 저장하고 기획 시작] 버튼을 막고 캐릭터 화면으로 안내합니다).

1. **컨셉 대화(N2)** — 웹 또는 Telegram에서 대화로 장르·등급·주인공·대립·핵심 훅·세계 규칙·결말 방향·로그라인을 채우고
   컨셉 브리프를 승인합니다. 필드마다 출처(`user_stated` 등)·근거 메시지를 기록하고, 사용자가 정한 값은 모델이 덮어쓰지 못합니다.
2. **캐릭터 설정** — 컨셉 승인 뒤 왼쪽 메뉴 **캐릭터**에서 주인공 1명, 서브 주인공 0..N명, 적대자·조연을 정합니다.
   승인된 브리프의 주인공·주요 인물이 먼저 채워지고, [AI 초안 받기]로 제안을 받을 수 있습니다(직접 정한 칸은 AI가 바꾸지 않음).
   캐릭터마다 디자인 시트(외형 스펙 + 정면·측면·후면·표정 시트 이미지 생성, 시점별 대표 이미지)를 둡니다.
   [캐스트 확정]을 해야 연재 목표를 저장할 수 있고, 확정한 캐스트는 온톨로지 인물·사실로 등록되어 기획서·아웃라인·본문의 입력이 됩니다
   (`apps/server/src/modules/cast/README.md`). 예전 설치에서 이미 `onboarding` 상태인 작품도 목표를 저장하기 전에 이 단계를 거칩니다.
   확정 뒤 캐릭터를 고치면 그 캐릭터는 다시 확정할 때까지 "확정하지 않은 변경"으로 표시되고, 그동안 기획·집필에는 마지막으로 확정한
   프로필이 쓰입니다. 다시 확정하면 바뀐 나이·성별·성격·관계의 예전 사실은 철회(retracted)되고 새 값이 승인된 사실이 되며, 이름을 바꾸면
   새 이름이 온톨로지 인물의 대표명이 됩니다.
3. **목표 → 시리즈 바이블 → 온톨로지 → 아크 계획 → 떡밥 → 회차 1..N** — 백그라운드 작업(작업 큐·리스·회수)이
   기획·집필·퇴고·연속성 검사를 돌리고, 바이블·아크·회차마다 승인을 받습니다. 반려하면 재작업, 승인하면 게시·내보내기.
4. **질문·승인 인박스(HITL)** — 차단/비차단 질문, 자유 답변 → 해석 확인 → 반영, 늦은 답변 처리. 웹 인박스와 Telegram 양쪽.
5. **예산** — 호출 단위 예약·정산(micro-USD), 소프트 경고, 하드 스톱 시 작품 일시정지와 재개 승인.
6. **신뢰성** — `kill -9` 뒤 재시작해도 작업 회수·응답 재사용·비용 중복 없음, graceful stop(진행 중 LLM 호출은 끝까지 받고 저장).
7. **Telegram** — 봇 등록, `/start <토큰>` 1:1 바인딩, 질문 전달, 버튼 콜백 멱등 처리, outbox 재시도.
8. **운영** — `ncs` CLI(onboard·run·doctor·backup·restore·migrate·secrets·config·service), 단일 인스턴스 잠금,
   비밀 암호화 저장, Host·교차 사이트 요청 차단, 감사 로그, 상태 점검.

## 요구 사항

- Node.js **22** (`.nvmrc`, `engines: >=22`).
- pnpm **9.15.4** — corepack으로 씁니다(전역 설치 불필요):

```sh
corepack enable --install-directory ~/.local/bin pnpm   # 한 번만; ~/.local/bin 이 PATH에 있어야 함
pnpm --version                                         # packageManager 필드 덕분에 9.15.4
# 또는 shim 없이: corepack pnpm@9.15.4 <command>   /   npx -y pnpm@9.15.4 <command>
```

## 설치·검증

```sh
pnpm install            # 의존성 설치 (embedded-postgres 바이너리 포함)
pnpm typecheck          # tsc -b (shared → db → test-kit → server/cli) + 각 패키지 test tsconfig + web
pnpm test               # vitest (root vitest.config.ts 의 projects: shared, db, test-kit, server, cli, web)
pnpm build              # tsc 빌드 + vite build (apps/web/dist) + 마이그레이션 SQL 복사
pnpm db:check-embedded  # embedded PostgreSQL을 임시 디렉터리에서 기동·마이그레이션·정지(스파이크 S-1 점검)
```

## 실행

### 개발 모드

```sh
pnpm dev                # server(tsx watch, :3100) + web(vite, :5173, /api → :3100 프록시)
NCS_HOME=/tmp/ncs-dev pnpm dev   # 데이터·키를 임시 홈에 분리
```

브라우저에서 `http://127.0.0.1:5173`을 엽니다. 서버는 embedded PostgreSQL(`$NCS_HOME/data/pg`, 포트 54329)을 직접 띄웁니다.

`pnpm dev`(서버 `dev` 스크립트)는 **개발 모드**(`NCS_DEV_MODE=1`, 설정 `dev_mode`)로 서버를 띄웁니다. 구독·OAuth 연결 방식
(Claude 구독(Claude Code CLI), ChatGPT 로그인·기기 코드·Codex 가져오기, xAI 기기 코드 로그인)은 **개발 모드에서만** 쓸 수 있습니다.
`node apps/server/dist/main.js`·`ncs run`처럼 환경 변수 없이 띄우면 운영 모드이고 각 공급자 API를 **API 키로만** 부릅니다(아래 "AI 계정 연결").

### 프로덕션 (빌드 결과 실행)

```sh
pnpm build
node apps/server/dist/main.js    # http://127.0.0.1:3100 — API(/api/*)와 apps/web/dist(SPA)를 함께 제공
curl http://127.0.0.1:3100/api/health
```

`SIGINT`/`SIGTERM`이면 새 작업을 멈추고 진행 중인 LLM 호출을 기다린 뒤(최대 `shutdown.grace_seconds`, 기본 60초) 종료합니다.
같은 `NCS_HOME`이나 같은 DB로 두 번째 서버를 띄우면 "이미 실행 중"으로 바로 종료합니다.

### CLI (`ncs`)

빌드 후 `node apps/cli/dist/main.js <명령>`(또는 개발 중 `pnpm ncs <명령>`). 아래에서는 `ncs`로 줄여 씁니다.

```sh
ncs onboard             # 대화형 초기 설정: 홈·저장소·바인드 주소(루프백/Tailscale)·포트·LLM 공급자·API 키·Telegram 토큰·자동 시작
ncs onboard -y                  # 묻지 않고 기본값으로 (키는 NCS_ONBOARD_ANTHROPIC_KEY / NCS_ONBOARD_TELEGRAM_TOKEN)
ncs run                 # 서버를 포그라운드로 실행 (--host, --port, --allowed-hostname)
ncs doctor              # 설정·DB·비밀·LLM 키·봇 토큰·백업 위치 점검 (--offline, --json)
ncs secrets set|list|delete <id> # 비밀 관리 (값은 표준 입력/숨김 입력, 화면에 표시 안 함)
ncs backup [run|list|verify]     # 설치 전체 백업 (마스터 키 제외)
ncs restore <backup>             # 서버가 꺼져 있을 때만
ncs migrate status|apply         # 마이그레이션 게이트
ncs config get|set|unset|validate|path
ncs service install|uninstall|status   # macOS launchd 사용자 서비스 (Linux는 최소 지원)
```

## AI 공급자 연결

웹 **설치 설정**(`/settings`, 온보딩 1단계에도 있음)의 **AI 계정 연결** 카드에서 공급자마다 연결합니다. 카드는 공급자별로
가능한 연결 방식, 공식/실험적 여부, "해당 공급자와 맺은 내 약정(이용약관·요금제)이 적용됨" 안내를 보여 줍니다.

> **구독·OAuth 로그인은 개발 모드 전용입니다.** Claude 구독(Claude Code CLI)·ChatGPT 로그인·xAI 로그인은 `pnpm dev` 또는
> `NCS_DEV_MODE=1`로 띄운 서버에서만 동작합니다. 운영 모드(기본)에서는 카드에 "개발 모드 전용"으로 비활성 표시되고, 로그인·가져오기·
> 구독 켜기·해당 방식 시험 API는 422 `oauth_dev_only`로 거부됩니다. 저장해 둔 로그인 세션은 지우지 않지만 호출에는 쓰지 않으며(API 키만
> 연결로 셈), Claude 구독 자동 기본값·`claude auth status` 확인·`llm.claude_code` 점검도 돌지 않습니다. 이런 연결에 묶여 있던 역할은 서버
> 시작 때 설정된 기본 공급자(기본 `anthropic`)로 옮겨집니다. 개발 모드로 다시 띄우면 저장된 세션이 그대로 다시 동작합니다.

| 공급자 | 연결 방식 | 비밀 이름 / 환경 변수 |
|---|---|---|
| Claude (Anthropic) | **Claude 구독 (Claude Code CLI)** 또는 **Console API 키** | 구독: 저장하는 비밀 없음(Claude Code가 자체 로그인 보관) · 키: `llm.anthropic.api_key` / `ANTHROPIC_API_KEY` |
| GPT (OpenAI) | ChatGPT 로그인(브라우저·기기 코드·Codex CLI 로그인 1회 복사, **비공식·실험적**) 또는 API 키 | `llm.openai.oauth_session`, `llm.openai.api_key` / `OPENAI_API_KEY` |
| Grok (xAI) | API 키(권장) 또는 xAI 기기 코드 로그인(실험적) | `llm.xai.api_key` / `XAI_API_KEY`, `llm.xai.oauth_session` |
| Gemini (Google) | API 키(Google AI Studio)만. Google 계정 로그인은 미지원 | `llm.google.api_key` / `GEMINI_API_KEY` 또는 `GOOGLE_API_KEY` |

**Claude 구독 (Claude Code CLI)**: 내 PC에 설치·로그인된 Claude Code를 그대로 실행합니다. 앱은 로그인 정보를 읽거나 저장하지
않습니다. 구독 사용 한도는 개인적인 일반 사용 기준이라 자동 연재처럼 호출이 많으면 한도에 빨리 닿을 수 있습니다.
- Anthropic 안내(code.claude.com/docs/en/legal-and-compliance, 2026-11-06 확인)에 따라, 사용자가 직접 로그인한 **수정하지 않은**
  Claude Code(`claude -p`)를 실행하는 방식만 씁니다. 앱은 Claude.ai 로그인 화면을 열지 않고, 토큰을 만들거나(setup-token)
  자격 증명 파일을 읽지 않습니다. `claude auth status`(설치·로그인 여부·로그인 방식)만 확인합니다.
- 연결: 터미널에서 `claude auth login` 실행 후 카드의 **[상태 새로고침]**. **사용 중지**는 이 앱에서만 끄며 Claude Code 로그인은 그대로입니다.
- 호출은 공급자 `claude_code`(역할별 모델의 "Claude 구독 (Claude Code CLI)")로 갑니다. 도구·MCP·설정 파일·세션 저장 없이 빈 작업
  폴더에서 실행하고, 자식 프로세스 환경에서 `ANTHROPIC_API_KEY`를 지워 구독 로그인을 쓰게 합니다.
- 비용: 구독은 호출마다 청구되지 않으므로 단가 프로필은 0이고 예산 장부에는 0으로 기록됩니다. Claude Code가 알려 주는 정가 환산
  추정치(`total_cost_usd`)는 호출 기록(`provider_calls.usage.reportedCostMicros`)에 추정치로만 남습니다.
- 동시 실행: `claude -p` 프로세스는 기본 2개까지(`llm.claude_code.max_concurrent`, `NCS_CLAUDE_MAX_CONCURRENT`), 나머지 호출은
  차례를 기다립니다. 호출 제한 시간은 기본 1200초(`llm.claude_code.call_timeout_seconds`). 실행 파일은 `llm.claude_code.bin` 또는 `NCS_CLAUDE_PATH`.
- 이 규칙은 `apps/server/test/llm/provider-policy.test.ts`가 소스 전체를 검사해 지킵니다(Claude 구독 토큰·자격 증명 저장소·Claude OAuth
  주소·앱에서 로그인 시작 금지).

**Console API 키**: [Claude Console](https://console.anthropic.com)에서 발급한 키로 연결하며 사용량은 API 요금으로 청구됩니다.
구독과 API 키는 함께 연결해 둘 수 있고, 역할마다 어느 쪽으로 부를지 **역할별 모델**에서 고릅니다.

연결 방법:
- **API 키**: 카드의 키 칸에 붙여 넣거나 `ncs secrets set llm.<공급자>.api_key`(숨김 입력). 환경 변수는 저장된 키가 없을 때만 씁니다.
  환경 변수 키는 웹에서 해제할 수 없습니다(409 `api_key_from_env`) — 서버 환경에서 변수를 지우고 다시 시작하세요.
- **ChatGPT 브라우저 로그인**: 서버와 **같은 컴퓨터**의 브라우저에서 진행합니다(콜백 `127.0.0.1:1455`, `codex login`과 포트 충돌 주의).
  다른 기기에서는 **기기 코드**(코드를 `/codex/device`에 입력; ChatGPT 계정 보안 설정에서 기기 코드 로그인이 켜져 있어야 함)를 씁니다.
  **Codex 가져오기**는 `~/.codex/auth.json`(또는 `$CODEX_HOME`)을 한 번 복사합니다 — NCS가 토큰을 갱신하면 Codex CLI 쪽 로그인은 풀립니다.
- **xAI 로그인**: 카드에 표시된 코드와 주소로 xAI 계정에서 승인합니다. 계정 등급에 따라 거부될 수 있어 API 키를 권장합니다.
- 로그인 세션·키는 `local_encrypted` 비밀 저장소에 암호화되고, 응답·로그·감사 기록에는 남지 않습니다(이메일·계정 ID는 가려서 표시).
  갱신이 복구 불가능하게 실패하면(`invalid_grant` 등) 카드에 "다시 로그인 필요"가 뜨고, 같은 refresh 토큰은 다시 보내지 않습니다.
- 여러 방식이 연결돼 있으면 카드에서 **사용 방식**을 고릅니다. **연결 시험**은 실제 공급자에 가벼운 요청을 보냅니다.

기본 공급자 자동 선택(**개발 모드만**): `llm.provider`(config.json 또는 `NCS_LLM_PROVIDER`)를 직접 정하지 않았고, Anthropic API 키가 없고,
Claude Code가 Claude 구독으로 로그인돼 있으면(`claude auth status`의 로그인 방식 `claude.ai`, 앱에서 사용 중지하지 않음) 서버 시작 때,
그리고 서버가 떠 있는 동안 카드의 **[연결]**·**[상태 새로고침]**으로 구독이 쓸 수 있게 확인되는 순간(재시작 불필요)
기본 공급자가 `claude_code`가 됩니다. 이때 연결이 없는 공급자에 묶여 있던 역할은 Claude 구독(역할 기본 모델)으로 옮겨집니다(단가 프로필은
그대로 둡니다). 직접 정한 값은 항상 우선하며, `ncs onboard`는 이 값을 더 이상 써 넣지 않습니다(이전에 써 넣은 `"anthropic"`이 있으면
`ncs config unset llm.provider` 후 재시작해야 자동 선택이 동작합니다).

모델 지정: 새 작품의 역할은 `llm.provider`(기본 `anthropic`, 위 자동 선택 시 `claude_code`) 공급자의 단가 프로필에 묶입니다. 작품 설정의 **역할별 모델**에서
역할마다 연결된 어느 공급자·모델로든 바꿀 수 있습니다(`PATCH /api/novels/:id/model-bindings/:role`). 단가 프로필은 설정의
**모델 단가 프로필** 표에 있고, 단가가 없는 모델은 호출 전에 예산 확인을 요청합니다. **예산 한도를 먼저 정하세요** — 하드 스톱에
걸리면 작품이 멈추고 재개 승인을 요청합니다. 상태 점검은 기본 공급자(`llm.<provider>`)를 항상, 나머지는 연결돼 있을 때만 확인합니다.

API: `GET /api/providers`(`?refresh=1`: `claude auth status` 다시 확인), `PUT /api/providers/:p/api-key`, `PUT /api/providers/:p/active-method`,
`POST /api/providers/anthropic/claude-cli`(Claude 구독 사용 켜기 + 상태 확인), `DELETE /api/providers/:p/connection?method=`(`claude_cli`: 앱에서만 끔),
`POST /api/providers/:p/test`(`{modelId?, method?}`), `POST /api/providers/:p/oauth`(`{flow}`) →
`GET|DELETE /api/providers/:p/oauth/:sessionId`, `POST /api/providers/openai/import-codex`.

## 이미지 생성 (`/images` 탭)

왼쪽 메뉴의 **이미지 생성** 탭입니다. 작품 밖에서는 공용 탭(`/images`), 작품 안에서는 그 작품 전용(`/novels/:id/images`)이며,
작품 전용 요청은 작품 예산의 이미지 범주로 한도를 먼저 확인하고(넘으면 409, 공급자에 보내지 않음) 완료 후 비용 원장에 기록합니다.
자격 증명은 위 **AI 공급자 연결**을 그대로 씁니다.

| 공급자 | 연결 방식 | 모델 |
|---|---|---|
| GPT | API 키(Images API) | `gpt-image-2.6-flare`(기본), `gpt-image-2.6-sunburst`, `gpt-image-1-mini` |
| GPT | ChatGPT 로그인(Codex 백엔드, 비공식, 요금제로 청구) | `gpt-image-2`만 |
| Grok | API 키, xAI 로그인(실험적) | `grok-imagine-image-2.0`(기본), `grok-imagine-image` |
| Gemini | API 키 | `gemini-nano-banana-2.1`(기본), `gemini-3-pro-image`, `gemini-3.1-flash-lite-image` (SynthID 워터마크) |
| Claude | — | 이미지 생성 API가 없어 "미지원" |

- 요청은 202(대기)로 받고 서버 안에서 2개씩 처리합니다(건당 300초 제한). 화면은 2초마다 상태를 확인하고, 이미지 격자에서
  크게 보기·내려받기·취소·삭제를 합니다. 부정 프롬프트·스타일 메모는 공식 항목이 없어 프롬프트 뒤에 덧붙여 보냅니다.
- 파일은 `$NCS_HOME/files/images/<작품ID 또는 install>/<생성ID>/`에 저장됩니다. 비용은 실측·추정·요금제 중 하나로 기록합니다.
- 서버를 정상 종료하거나 재시작하면 생성 중이던 건은 "서버가 다시 시작되어 생성이 중단되었습니다. 공급자에서 비용이 청구되었을 수
  있습니다."로 실패 처리하고, 대기 중이던 건은 다시 돌립니다. 생성 결과를 원고에 연결하는 기능과 참조 이미지 편집은 아직 없습니다.

API: `GET /api/images/providers`, `POST /api/images/generations` → 202, `GET /api/images/generations?novelId&scope&status&limit&before`,
`GET|DELETE /api/images/generations/:id`, `POST /api/images/generations/:id/cancel`(최종 상태를 돌려줌), `GET /api/images/assets/:assetId/file?download=1`.

비밀은 `$NCS_HOME/secrets/master.key`(또는 `NCS_SECRETS_MASTER_KEY`)로 암호화됩니다. 이 키는 백업에 들어가지 않으니 따로 보관하세요.
키를 잃으면 저장한 비밀을 풀 수 없고(`secrets` 점검 실패) 다시 입력해야 합니다.

## 실제 Telegram 봇 쓰기

1. Telegram에서 `@BotFather` → `/newbot`으로 봇을 만들고 토큰을 받습니다.
2. 봇 등록(셋 중 하나): `ncs onboard`의 토큰 입력, 웹 **설치 설정**의 봇 카드,
   또는 `POST /api/messaging/bots` `{"kind":"telegram","label":"내 봇","token":"<토큰>"}`. 토큰은 비밀 저장소에 들어갑니다.
3. 작품 **설정 → 채널 연결**에서 바인딩 링크를 발급하고, 휴대폰에서 링크를 열어 봇에게 `/start <토큰>`을 보냅니다(1:1 채팅).
   그 Telegram 사용자만 허용 목록에 들어갑니다.
4. 서버는 long polling으로 메시지를 받으므로 공개 주소·웹훅이 필요 없습니다. 메신저에는 요약만 가고, 전문은 웹 링크로 엽니다.

`NCS_TELEGRAM_API_BASE_URL`로 Bot API 주소를 바꿀 수 있습니다(로컬 Bot API 서버·mock).
실제 봇 토큰으로는 아직 시험하지 않았습니다.

## Tailscale로 휴대폰에서 접속하기

인증 모드는 `local_trusted`(로그인 없음)뿐이라 **공개 인터넷에 노출하면 안 됩니다**. `0.0.0.0`·`::`·공인 IP 바인드는 거부합니다.

```sh
tailscale ip -4                     # 예: 100.101.102.103
tailscale status --json | jq -r .Self.DNSName   # 예: studio.tailnet-1234.ts.net.

# 방법 1: onboard에서 "Tailscale (100.x)"를 고르면 host와 MagicDNS 전체·짧은 이름이 config.json에 저장됨
ncs onboard
ncs run

# 방법 2: 직접 지정
ncs run --host 100.101.102.103 --allowed-hostname studio.tailnet-1234.ts.net,studio
# 또는 환경 변수
NCS_HOST=100.101.102.103 NCS_ALLOWED_HOSTNAMES=studio.tailnet-1234.ts.net,studio node apps/server/dist/main.js
```

휴대폰(같은 tailnet)에서 `http://studio.tailnet-1234.ts.net:3100` 또는 `http://100.101.102.103:3100`으로 엽니다.
Host 헤더가 바인드 IP·루프백·허용 이름이 아니면 거부합니다(DNS rebinding 방지). 다른 사이트에서 오는 상태 변경 요청은
`Origin`/`Sec-Fetch-Site`로 막습니다(403). 허용 이름 없이 루프백이 아닌 주소에 바인드하면 `ncs doctor`가 경고합니다.

## PRD 대비 알려진 빈 곳

MVP-β 이후로 미룬 것(설계상 범위 밖):
- 카테고리 템플릿, 바이블 승인 뒤 컨셉 수정(CB6~CB8 — 지금은 "컨셉 고치기"가 바이블 승인 전까지만), Discord, 용어집 섹션.
- 로그인·다중 사용자 인증(`local_trusted`만).

MVP-α 안에서 아직 덜 된 것:
- **오케스트레이션·LLM**: 공급자 circuit breaker 카운터(04 §7.3), `fallback_model_id`, 예약 대기 backlog·우선순위 상승(04 §3.4),
  `schedule` 웨이크 소비, 단가 없는 호출의 `require_approval`(지금은 `block`만). Anthropic 입력 토큰은 추정치+10%로 예약.
- **원고**: GC-4 자동 수정, ED-3 이후 회차 재검사, 아크 반려 시 회차별 선택, 바이블 승인 화면의 "컨셉 대비 변경점",
  내보내기는 동기 실행이고 실패 작업을 기록하지 않음.
- **안전 이슈 종결**: `human_edited`는 이슈 버전보다 새 사람 수정본이 있는지만 보고, 재검사 통과를 명시적으로 확인하지 않음.
  게시된 사실을 줄이는 변경은 `retcon_required`로 보류하지만 retcon 질문은 아직 자동 생성하지 않음.
- **HITL·메신저**: 일일 요약 다이제스트, 해석 수정 웹 폼, 늦은 답의 "수정 요청 만들기"(웹 안내만), 반영이 원고 어디에
  쓰였는지 추적, 채널 장애 시 다른 채널로 재라우팅, 중복 버튼 토스트. 실제 Telegram 토큰으로 미검증.
- **운영**: restore 5·6단계(비용 이월, 메신저 offset·답변 대조)는 경고만, `pg_dump` 경로 미검증(JSON 엔진 사용),
  `ncs config set`의 감사 기록 없음, 서버가 DB 잠금 연결을 잃어도 멈추지 않음(02 §2.3), 파일 잠금은 OS 잠금이 아닌 PID 생존 확인,
  `NCS_PG_PORT`를 환경 변수로만 준 경우 `ncs doctor`가 DB를 못 찾음(잠금 파일에 PG 포트 미기록). Linux·Windows 서비스 지원 최소.
- **웹**: 컴포넌트·브라우저(axe/Playwright) 테스트 없음, 보드의 아크→회차 트리·재배정, 로그라인 후보 나란히 비교,
  질문 본문 Markdown 렌더링.
- **AI 공급자·이미지**: 실제 OpenAI·xAI·Google 계정으로 미검증(로컬 mock만). ChatGPT 로그인 호출도 API 단가로 예산을 예약·정산(보수적),
  Gemini Vertex 서비스 계정·`countTokens` 미구현, 진행 중인 OAuth 로그인은 메모리에만 있어 재시작하면 사라짐,
  CLI 온보딩(`ncs onboard`)은 아직 Anthropic 키만 안내. 이미지 단가는 리서치 기준 추정치.
- **E2E**: 빌드된 서버를 HTTP로만 구동하는 실서버 E2E 스크립트는 없습니다(통합 테스트가 in-process로 루프를 검증).


## 설정 (`InstallConfig`, `packages/shared/src/config-schema.ts`)

우선순위: CLI 플래그 > 환경 변수 > `$NCS_HOME/config.json` > 기본값.

| 환경 변수 | 의미 | 기본값 |
|---|---|---|
| `NCS_HOME` | 설치 홈 | `~/.ncs` |
| `NCS_HOST` / `NCS_PORT` | HTTP 바인드 주소 (루프백·Tailscale·사설 IP. `local_trusted`는 `0.0.0.0`·`::`·공인 IP 불가, CFG-1) | `127.0.0.1` / `3100` |
| `NCS_ALLOWED_HOSTNAMES` | Host 헤더 허용 이름(쉼표 구분, 예: MagicDNS 짧은 이름과 전체 이름). `ncs onboard`·`ncs run`은 Tailscale IP 바인드면 둘 다 자동 추가 | — |
| `DATABASE_URL` | 외부 PostgreSQL (설정 시 embedded 대신 사용) | — |
| `NCS_PG_PORT` / `NCS_PG_DATA_DIR` | embedded PG 포트 / 데이터 디렉터리 | `54329` / `$NCS_HOME/data/pg` |
| `NCS_DEV_MODE` | `1`/`true`면 개발 모드(설정 `dev_mode`): 구독·OAuth 연결 방식 사용 가능. `pnpm dev`가 자동 설정 | 꺼짐(운영 모드, API 키만) |
| `NCS_LLM_PROVIDER` | 새 작품 역할의 기본 공급자: `anthropic`·`claude_code`(Claude 구독, 개발 모드만 — 운영 모드에서는 `anthropic`)·`openai`·`xai`·`google` (알 수 없는 값·미설정은 자동 선택, 위 참고) | 자동(`anthropic`, 개발 모드에서는 `claude_code`일 수 있음) |
| `NCS_CLAUDE_PATH` / `NCS_CLAUDE_MAX_CONCURRENT` | Claude Code 실행 파일 / 동시 `claude -p` 수 | `claude` / `2` |
| `NCS_ANTHROPIC_BASE_URL` | Claude API 주소 (프록시·테스트 mock. 설정 `llm.endpoints.anthropic_api_base_url`) | `https://api.anthropic.com` |
| `NCS_WEB_DIST` | 정적 제공할 web 빌드 디렉터리 | `apps/web/dist` 자동 탐지 |
| `NCS_SECRETS_MASTER_KEY` | 비밀 암호화 마스터 키(base64 32바이트). 없으면 `$NCS_HOME/secrets/master.key` | — |
| `NCS_LOG_LEVEL` | pino 로그 레벨 | `info` |

## 서버 모듈과 작업 규칙

서버 구조(`apps/server/src/{platform,http,runtime,composition,modules}`), 모듈 계약(`modules/<m>/index.ts`),
트랜잭션·감사·작업 종류 등록·테스트 헬퍼(`apps/server/test/support/test-core.ts`)·API 목록·담당 표는
[`CONVENTIONS.md`](./CONVENTIONS.md)에 있습니다. 각 모듈 디렉터리의 `README.md`에 책임·소유 테이블·구현할 설계 절이 있습니다.

## 저장소 구성 (design/08 §2)

```
apps/server      @ncs/server   Express 5 API, 조립 지점(src/main.ts), 이후 modules/<module>
apps/web         @ncs/web      Vite + React 19 + TanStack Query + react-router 7 + Tailwind 4 (목업 토큰 → src/app/theme.css)
apps/cli         @ncs/cli      ncs 명령 (commander, @clack/prompts)
packages/shared  @ncs/shared   enum 레지스트리, 한국어 라벨, ID(접두사+ULID), 기본값, InstallConfig, DTO
packages/db      @ncs/db       SQL 마이그레이션 + runner, drizzle 스키마, embedded/external PG 런타임, PGlite 테스트 DB
packages/test-kit @ncs/test-kit FakeClock, 결정적 ID, 픽스처 빌더
```

### 패키지 해석 규칙

워크스페이스 패키지는 `exports`에 사용자 조건 `@ncs/source`(→ `src/*.ts`)와 기본(→ `dist/*.js`)을 둡니다.
개발(tsx `--conditions=@ncs/source`), vitest, vite, 테스트용 tsconfig(`customConditions`)는 소스를 직접 쓰고,
`tsc -b` 빌드와 프로덕션 `node`는 `dist`를 씁니다. drizzle 연산자는 `@ncs/db/orm`에서 가져오면 인스턴스가 하나로 유지됩니다.

## 데이터베이스 규칙 (packages/db)

- 마이그레이션: `packages/db/src/migrations/NNNN_<slug>.sql` 손으로 작성, 4자리 연번, 파일 하나 = 트랜잭션 하나,
  `app_migrations`에 체크섬 기록(적용 뒤 파일이 바뀌면 시작 거부). `DROP TABLE/COLUMN`, 타입 변경, `RENAME`은
  파일 머리에 `-- ncs:destructive <사유>` 필요. down 마이그레이션 없음.
- enum: `text` + `CHECK (col IN (...))` 그리고 `COMMENT ON COLUMN t.c IS 'enum:<enum_name>'`.
  값의 단일 출처는 `packages/shared/src/enum-registry.ts`이고, `packages/db/test/migrations.test.ts`가
  카탈로그의 CHECK 목록과 레지스트리를 비교합니다(enum 값 변경 = 레지스트리 수정 + 새 마이그레이션).
- 테넌트(T-1/T-2): 작품 소속 테이블은 `novel_id NOT NULL`, `UNIQUE (novel_id, id)`, 작품 소속 테이블 사이 FK는
  `(novel_id, x_id) → x(novel_id, id)` 복합 FK. 모든 FK는 `DEFERRABLE`(기본 IMMEDIATE).
- drizzle 스키마(`src/schema/<module>.ts`)는 열만 미러링합니다. 제약·인덱스·FK는 SQL에만 있습니다.
- 금액은 micro-USD `bigint`(ADR-016), 작중 범위는 `int4range`(`storyRange()` 도우미).
- 테스트: `createTestDb()`(`@ncs/db/testing`)가 마이그레이션된 PGlite를 복제해 돌려줍니다(btree_gist·pg_trgm contrib 로드).
  `seedNovel()`은 N1 생성 묶음(작품·스키마 버전·기본 시간선·웹 채널·컨셉 세션·예산 정책)을 만듭니다.
