# module `messaging`

- **Status:** implemented (MVP-α, Telegram long polling + Discord Gateway, DM only)
- **Next-phase owner:** A6 hitl+messaging
- **Public API:** `index.ts` (the ONLY file other modules may import). Factory `createMessagingModule` in `module.ts`.

## Responsibilities
- Telegram Bot API via fetch: long polling getUpdates, sendMessage/editMessageText/answerCallbackQuery, rate-limit retry, error-burst breaker
- Discord (DM only): REST v10 via fetch (token check `GET /users/@me`, invite URL from the application id, messages with button components, 2000-char split, 429 `retry_after`) + own minimal Gateway websocket client (`adapters/discord/gateway.ts`: heartbeat/zombie detection, resume on `resume_gateway_url`, Reconnect/Invalid Session, fatal close codes). Outbound connection only — no interactions endpoint. Intents: DIRECT_MESSAGES (+ MESSAGE_CONTENT if `messaging.discord_message_content_intent`). Button presses are ACKed (type 6) at once; the interaction token is never stored. A fresh session (not RESUMED) pulls missed DMs via `GET /channels/:id/messages?after=`. (paged, ≤ 10 × 50 per DM). Reconnect backoff is only reset after a session stayed up 30 s, and `session_start_limit` from `GET /gateway/bot` is honoured before each Identify. One row per Discord bot user (re-registering the same bot → 409 `bot_already_registered`). A 429/unsent failure in the middle of a split message resumes at that part (`message.resumeFromPart`); an unknown-outcome failure ends `delivery_unknown` with a short notice in the DM. The "not connected" reply to an unbound DM is sent at most once per 10 min per DM (Discord only). Module stop drains queued Gateway work before the DB closes.
- messenger_inbox (dedupe) → InboundAction → registered handlers; messenger_outbox dispatcher
- bots (token in secrets `telegram.bot.<id>` / `discord.bot.<id>`), binding tokens `/start <token>` (Discord also `!start` / `start <token>` in the DM), allowed users, channel health (`bot_token`, `channel_reach`)

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
- loops telegram.poller, messaging.inbox, messaging.outbox, discord.gateway (keeps one websocket per active Discord bot)
- health checks

## HTTP endpoints (`…` = `/api/novels/:novelId`)
- `GET|POST /api/messaging/bots`
- `GET …/channels`
- `POST …/channels/bindings`
- `POST …/channels/:channelId/unbind`

## Layout
- `domain/` transitions (CH, BT, IN, OB), render (QuestionView → RenderedMessage, callback codec `v1|a|qst|idx`)
- `application/messaging-service.ts` (bots, binding, outbox enqueue, poller TP1–TP8, inbox I1–I7 + routing chain answer_text → concept_message → unrelated_text, outbox worker with 429/backoff/breaker, health checks), `ports.ts`
- `adapters/telegram/` fetch transport (only place calling api.telegram.org) + client/parse; `adapters/discord/` REST transport + native WebSocket, client/parse/components, Gateway client; `adapters/db`, `adapters/http`
- Test seam: `service.setTelegramTransportFactory(stub)` / `service.setDiscordTransportFactory({ rest, socket, gatewayTiming })`; tests use the in-memory Bot API / Discord REST+Gateway in `test/messaging/`. Discord base URL: config `messaging.discord_api_base_url` / env `NCS_DISCORD_API_BASE_URL`. Base URL: config `messaging.telegram_api_base_url` / env `NCS_TELEGRAM_API_BASE_URL` (local Bot API server or a test mock).

## Design sections to implement
- docs/design/05 §2.1, §5.3–5.4, §6.1, §6.4, §9
- docs/design/ADR-011 (Chat SDK replaced by direct fetch)

See /CONVENTIONS.md for layering, transactions, audit, tests and copy rules.
