# SPEC — Stateless Chat Web UI

## What

A minimal, polished chat web UI for the existing `stateless-chat` backend (this repo). The backend is **already built and running** — you are ONLY building the frontend. Do not modify the backend architecture.

## Existing backend (facts, do not change)

- API Gateway at `http://localhost:3000` (currently running — infra, gateway and 2 workers are live).
- API surface:
  - `POST /conversations` body `{clientId}` → `{conversationId}`
  - `POST /conversations/:id/messages` body `{clientId, content}` → `{messageId, streamUrl}` (`:id` may be `new`)
  - `GET /conversations/:id/messages` → full history (array of `{id, role, content, ...}`, ordered by time)
  - `GET /conversations/:id/messages/:messageId/stream` → SSE: `event: token` (one per chunk, data `{content}`), `event: done` (final full content), `event: error`
- The gateway has NO CORS middleware. Your options: a Vite dev proxy (recommended — zero backend changes), or add permissive CORS to the gateway Express app (acceptable, it's the same repo).

## User experience

- A single-conversation chat page: message list + input box, chat-app look.
- On load: create (or reuse) a conversation and show its history.
- Send a message: POST it, then open the SSE stream and render the assistant reply **live, token by token** (the reply visibly streams in).
- The page must survive a reload: history reloads from the backend.
- Clean, modern styling. Simple, no user accounts.

## Technical constraints (user-specified, non-negotiable)

- Vite + React + TypeScript
- pnpm (use pnpm exclusively inside `web/`; do not touch the root npm workspaces)
- Tailwind CSS
- The app lives in `/home/ubuntu/stateless-chat/web` as a standalone package with its own `package.json` (no workspace coupling to the root).

## Acceptance criteria (self-verify, live)

- `pnpm install` and `pnpm dev` start cleanly in `web/`.
- With the backend running (it already is), the page loads, history renders, sending a message produces a visibly streamed reply, and a page refresh shows the persisted history.
- You verified this yourself in a browser or with the dev server + backend, and fixed anything that didn't work. Note: this is a headless server — if no browser is available, verify with curl against the dev server for the static page and exercise the proxy path, and state clearly what you could and couldn't verify.

## What NOT to specify

Component structure, state management, styling details, proxy path naming — your call. Keep it simple and clean.

## Definition of done

Working app, real streaming, verified as far as the environment allows, plus a short report: how to run it, what you verified, and any caveats.
