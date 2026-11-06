# module `messaging`

- **Status:** implemented (MVP-α, Telegram long polling)
- **Next-phase owner:** A6 hitl+messaging
- **Public API:** `index.ts` (the ONLY file other modules may import). Factory `createMessagingModule` in `module.ts`.

## Responsibilities
- Telegram Bot API via fetch: long polling getUpdates, sendMessage/editMessageText/answerCallbackQuery, rate-limit retry, error-burst breaker
- messenger_inbox (dedupe) → InboundAction → registered handlers; messenger_outbox dispatcher
- bots (token in secrets), binding tokens `/start <token>`, allowed users, channel health (`bot_token`, `channel_reach`)

## Owned tables (`@ncs/db/schema/messaging.ts`)
- channels
- messenger_bots
- channel_binding_tokens
- messenger_inbox
- messenger_outbox

## Depends on (via their `index.ts` only)
- audit, novel, system

## Registers into other modules
- N1 participant (order 20)
- loops telegram.poller, messaging.inbox, messaging.outbox
- health checks

## HTTP endpoints (`…` = `/api/novels/:novelId`)
- `GET|POST /api/messaging/bots`
- `GET …/channels`
- `POST …/channels/bindings`
- `POST …/channels/:channelId/unbind`

## Layout
- `domain/` transitions (CH, BT, IN, OB), render (QuestionView → RenderedMessage, callback codec `v1|a|qst|idx`)
- `application/messaging-service.ts` (bots, binding, outbox enqueue, poller TP1–TP8, inbox I1–I7 + routing chain answer_text → concept_message → unrelated_text, outbox worker with 429/backoff/breaker, health checks), `ports.ts`
- `adapters/telegram/` fetch transport (only place calling api.telegram.org) + client/parse; `adapters/db`, `adapters/http`
- Test seam: `service.setTelegramTransportFactory(stub)`; tests use the in-memory Bot API in `test/messaging/`. Base URL: config `messaging.telegram_api_base_url` / env `NCS_TELEGRAM_API_BASE_URL` (local Bot API server or a test mock).

## Design sections to implement
- docs/design/05 §2.1, §5.3–5.4, §6.1, §6.4, §9
- docs/design/ADR-011 (Chat SDK replaced by direct fetch)

See /CONVENTIONS.md for layering, transactions, audit, tests and copy rules.
