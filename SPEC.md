# SPEC — Stateless Chat Bot

## What

A simple chat bot backend that implements the classic stateless chat architecture:

```
Phone ---\
          \--> API Gateway --> PostgreSQL (conversation history)
PC ------/           |
                     v
                  Redis PubSub
                     |
                  LLM Worker(s)
                     |
              SSE/WebSocket Gateway --> clients
```

Users send messages from a client (curl, browser, anything), and the bot streams back an LLM-generated response in real time. The system is **stateless for the worker**: any worker can pick up any message, because all conversation state lives in PostgreSQL.

## Architecture components (each must be real, working code)

1. **API Gateway** — HTTP entry point. Accepts a message from a client, stores it in PostgreSQL, publishes it to Redis, returns immediately. Also exposes conversation history retrieval (all messages for a conversation).
2. **PostgreSQL** — the source of truth for conversation history (users, conversations, messages). Schema is your choice, keep it minimal.
3. **Redis PubSub** — the message bus that decouples the gateway from the LLM work.
4. **LLM Worker** — subscribes to Redis, reads full conversation history from PostgreSQL, calls the LLM, streams the reply back through the streaming gateway, then persists the assistant message to PostgreSQL. Multiple workers must be able to run concurrently against the same Redis/PostgreSQL.
5. **SSE/WebSocket Gateway** — delivers the streamed tokens to the connected client in real time. SSE is preferred (simpler), but WebSocket is acceptable. Must handle the client connecting AFTER the message is sent (e.g. message-id based reconnect) so a page reload can resume the stream or poll history.

## Technical constraints

- Node.js + TypeScript, single repo.
- PostgreSQL and Redis run as docker containers (docker-compose is fine).
- LLM access via OpenAI-compatible API: read `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` from `.env` (already provided in repo root — real working key, use it). Use streaming completions so tokens flow in real time.
- A minimal `docker-compose.yml` for postgres + redis, plus a root `package.json` with scripts: `dev` (run all), `dev:gateway`, `dev:worker`, `infra:up` / `infra:down`, and a README with run instructions.
- No authentication complexity needed (a simple client-id header or query param is fine).

## Acceptance criteria

- `npm run infra:up` starts postgres + redis; migrations/schema init run automatically on gateway start.
- Sending a message via curl returns HTTP 200 immediately, and the LLM reply streams to the client via SSE with visible token-by-token chunks.
- Conversation history persists in PostgreSQL: restart the gateway, fetch history, all prior messages are there.
- Two LLM workers can run simultaneously; a burst of messages is processed without duplication (each message answered exactly once).
- A plain `curl` client can exercise the whole flow without any browser.

## What NOT to specify

File structure, class/function signatures, library choices, SQL schema, and protocol details are YOUR decisions. Use whatever you judge best. Keep it simple — this is a demonstration of the architecture, not a production system.

## Definition of done

You have verified yourself (by running it) that the flow works end-to-end: message in via curl → streamed LLM reply out via SSE → history persisted across restart. Fix anything that doesn't work before finishing. Report what you built and how to run it.
