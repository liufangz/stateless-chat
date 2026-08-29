# Stateless Chat

A minimal, real implementation of the classic stateless-chat architecture:

```
curl/browser --> API Gateway --> PostgreSQL (conversation history)
                      |
                      v
                 Redis PubSub  (new-message notifications + token streaming)
                      |
                 LLM Worker(s) --- stateless: any worker can pick up any message
```

- **Gateway** (`packages/gateway`) — Express HTTP API. Stores messages in Postgres, publishes a
  "new message" notification on Redis, returns `200` immediately. Also serves conversation
  history and a per-message SSE stream.
- **Worker** (`packages/worker`) — subscribes to Redis for wake-ups and also polls Postgres on an
  interval. Atomically claims pending messages with `UPDATE ... WHERE status = 'pending' ...
  FOR UPDATE SKIP LOCKED`, so with N workers running, each message is claimed by exactly one of
  them. Loads the full conversation history from Postgres, calls the LLM with streaming, publishes
  each token to a per-message Redis channel, then persists the full assistant reply to Postgres.
- **Gateway SSE endpoint** — subscribes to that same per-message Redis channel and relays tokens
  to the client in real time. Works even if the client connects *after* the message was sent
  (reconnect by message id): if the reply already finished, it's read back from Postgres and sent
  as a single chunk; otherwise the client is attached to the live token stream.
- **Postgres** — source of truth: `conversations` and `messages` tables (see
  `packages/shared/src/db.ts` for the schema, created automatically on gateway startup).
- **Redis** — pub/sub message bus decoupling the gateway from the worker(s).

## Requirements

- Node.js 20+
- Docker (docker-compose or the `docker compose` plugin)
- A working OpenAI-compatible API key in `.env` at the repo root:
  ```
  OPENAI_API_KEY=...
  OPENAI_BASE_URL=https://api.deepseek.com
  OPENAI_MODEL=deepseek-chat
  ```

## Run it

```bash
npm install
npm run infra:up      # starts postgres (localhost:5433) + redis (localhost:6380), waits for healthy
npm run dev           # starts gateway (:3000) + one worker
```

Run extra workers in separate terminals to demonstrate multi-worker dedup:

```bash
npm run dev:worker
```

Stop infra with `npm run infra:down` (data persists in a docker volume; add `-v` to wipe it).

## Run the worker tests

Some worker tests exercise real Postgres and `TRUNCATE` shared tables in `beforeAll`. Use the
disposable test database, never the dev/prod one at `DATABASE_URL`'s default:

```bash
docker exec stateless-chat-postgres psql -U chat -d chat -c "CREATE DATABASE chat_test;"  # once
npm run test:db -w packages/worker
```

`npm run test -w packages/worker` (no `DATABASE_URL` override) is safe to run too - each
Postgres-backed test file refuses to start unless `DATABASE_URL` points at a database whose name
contains `test`.

## Try it with curl

```bash
# 1. Create a conversation
CONV=$(curl -s -X POST localhost:3000/conversations -H 'Content-Type: application/json' \
  -d '{"clientId":"phone-1"}')
CONV_ID=$(node -e "console.log(JSON.parse(process.argv[1]).conversationId)" "$CONV")

# 2. Send a message - returns HTTP 200 immediately with a messageId
MSG=$(curl -s -X POST localhost:3000/conversations/$CONV_ID/messages \
  -H 'Content-Type: application/json' -d '{"clientId":"phone-1","content":"Hello there!"}')
MSG_ID=$(node -e "console.log(JSON.parse(process.argv[1]).messageId)" "$MSG")

# 3. Stream the reply (works whether you connect before, during, or after generation)
curl -N localhost:3000/conversations/$CONV_ID/messages/$MSG_ID/stream

# 4. Fetch full history any time (e.g. after restarting the gateway)
curl -s localhost:3000/conversations/$CONV_ID/messages | jq
```

You can also POST to `/conversations/new/messages` with a `clientId` in the body to create a
conversation and send the first message in one call.

## API

| Method | Path                                                        | Description                                   |
|--------|-------------------------------------------------------------|------------------------------------------------|
| POST   | `/conversations`                                             | `{clientId}` -> `{conversationId}`             |
| POST   | `/conversations/:conversationId/messages`                    | `{clientId, content}` -> `{messageId, streamUrl}` (`:conversationId` may be `new`) |
| GET    | `/conversations/:conversationId/messages`                    | Full history, ordered by time                  |
| GET    | `/conversations/:conversationId/messages/:messageId/stream`  | SSE stream of the assistant reply for that message |
| GET    | `/health`                                                     | Liveness check                                 |

SSE events: `event: token` (one per chunk), `event: done` (final full content), `event: error`.

## Why no duplicate replies with multiple workers

Redis PubSub alone broadcasts to *every* subscriber, so a naive "worker subscribes to pubsub and
replies" design would generate one reply per worker. Instead, pubsub is only used as a wake-up
notification. The actual claim happens in Postgres:

```sql
UPDATE messages SET status = 'processing'
WHERE id IN (
  SELECT id FROM messages WHERE status = 'pending' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` means concurrent workers never block each other and never see the same
row — each pending message is returned to exactly one worker. Workers also poll on a 1s interval
in addition to reacting to pubsub, so a message is never stranded if a notification is missed or
sent before any worker was connected.

## Durable, non-destructive compaction

Long conversations get periodically summarized ("compacted") to keep the context sent to the LLM
under a token budget. This is purely additive: raw `messages` rows are never deleted, edited, or
overwritten by compaction — a `compactions` row is extra metadata alongside them, and
`GET /conversations/:conversationId/messages` always returns the full, unabridged raw history
(including every tool call/result). Only the in-memory prompt built for the *next* LLM call
overlays a summary in place of older messages; what's durably stored on disk is untouched.

A `compactions` row records, atomically, in one INSERT: the summary text, the exact source span it
covers (`source_start_message_id` through `first_kept_message_id`, the latter being the boundary
row still sent in full), the turn that triggered the pass (`triggered_by_message_id`), token
metadata, and `created_at`. An empty or whitespace-only summary is never persisted as a usable
compaction — it's rejected in application code before any write, and backed by a
`compactions_summary_not_blank` CHECK constraint in the schema; the turn falls back to sending
uncompacted history to the LLM instead. `triggered_by_message_id` is also this pass's idempotency
key: a crash-and-retry of the same turn can't create a duplicate compaction row for it.
