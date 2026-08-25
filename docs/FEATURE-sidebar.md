# FEATURE — Conversation Sidebar

## What

Add a sidebar to the existing chat web UI (`web/`) that lists all conversations. Clicking one loads its history so the user can pick up where they left off. A "New chat" control starts a fresh conversation. This is the multi-conversation UI the current single-conversation app is missing.

## Current facts (verified, do not re-derive)

- Repo `/home/ubuntu/stateless-chat`: npm workspaces monorepo (`packages/gateway`, `packages/worker`, `packages/shared`) + standalone pnpm app in `web/` (Vite + React + TS + Tailwind v4).
- Backend running on :3000 (tsx watch — edits hot-restart it). Web dev on :4827 (Vite HMR). Do NOT touch `docker-compose.yml`, `.env`, or infra — it's all live.
- API today: `POST /conversations` {clientId}, `POST /conversations/:id/messages`, `GET /conversations/:id/messages`, `GET .../messages/:messageId/stream`, `GET /health`.
- There is NO list-conversations endpoint — the backend must grow one.
- `web/src/lib/storage.ts` keeps a single `clientId` + `conversationId` in localStorage. `web/src/App.tsx` wires one conversation.

## What to build

1. **Backend** — `GET /conversations` (optionally filtered by `clientId` query param). Return conversations with metadata that makes a sidebar useful: id, created/updated timestamps, and the last message snippet if cheap to add. Order by most recent activity first.
2. **Frontend** — a left sidebar in `web/src/App.tsx`:
   - Lists conversations (fetch on mount, refresh after each message).
   - Click a conversation → load its history, continue chatting in it.
   - "New chat" button → starts a fresh conversation.
   - Current conversation highlighted; empty state when there are none.
   - Keep the existing streaming behaviour untouched (token-by-token SSE rendering, persistence across reload).
   - Existing single-conversation localStorage data should migrate gracefully (e.g. the saved conversation shows up in the list) — don't strand old chats.

## Acceptance criteria (self-verify)

- `GET /conversations` returns the existing conversations, most recent first, with usable metadata.
- `pnpm build` and `pnpm lint` clean in `web/`; root `npm run build` (or `tsc -b`) clean.
- With the live backend: create conversation A, send a message, create conversation B, send a different message → the list endpoint shows both, and loading A's history returns A's messages only (isolation).
- The proxy path (`web` → `/api` → gateway) still works end-to-end including SSE streaming.
- No browser on this box: verify what's verifiable with curl against :4827 (page serves, proxy works, list endpoint returns data through the proxy) and state clearly what you couldn't visually confirm.

## Do NOT

- Change the worker, the LLM call, the Redis/pubsub flow, or the stream protocol.
- Touch `.env`, `docker-compose.yml`, or restart infra.
- Over-engineer: no auth, no pagination, no DB migrations beyond what's needed (schema changes to add a column are fine if done idempotently in the existing schema-init).

Report: what you changed (files), how you verified, and any caveats.
