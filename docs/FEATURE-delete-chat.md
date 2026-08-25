# FEATURE — Delete Chat

## What

Let the user delete a conversation from the sidebar of `web/`. The conversation and all its messages are removed from the backend store (PostgreSQL). This complements the existing sidebar feature (list/select/continue).

## Current facts (verified)

- Repo `/home/ubuntu/stateless-chat`: npm workspaces (`packages/gateway`, `packages/worker`, `packages/shared`) + standalone pnpm app `web/` (Vite + React + TS + Tailwind).
- Backend live on :3000 (tsx watch hot-reloads), web dev on :4827 (Vite HMR). Don't touch `.env`, `docker-compose.yml`, or infra.
- Existing endpoints: `POST /conversations`, `GET /conversations` (list, `?clientId=`), `POST /conversations/:id/messages`, `GET /conversations/:id/messages`, `GET .../messages/:messageId/stream`, `GET /health`.
- Sidebar exists (`web/src/components/Sidebar.tsx`, wired in `App.tsx`); streaming disables sidebar interactions while a message is in flight.

## What to build

1. **Backend** — `DELETE /conversations/:id` (optionally scoped by `clientId` query/body param — your call, but deleting a conversation another client owns is bad even in a demo). Deletes the conversation and all its messages. Return a clear success status; a sensible 404 if the conversation doesn't exist.
2. **Frontend** — a delete control per conversation in the sidebar (small, unobtrusive — e.g. a trash icon appearing on hover):
   - Confirmation before deleting (lightweight — inline confirm or `confirm()` is fine; don't build a modal system).
   - After delete: the conversation disappears from the list. If it was the active conversation, switch to the next one in the list (or start a new chat when the list becomes empty).
   - Deleted conversations must not reappear on refresh (backend is the source of truth — no localStorage bookkeeping hacks).
   - Keep the existing streaming/list/select behaviour intact.

## Acceptance criteria (self-verify)

- `DELETE /conversations/:id` removes the conversation: list no longer shows it, its history endpoint returns 404/empty, and OTHER conversations (including their messages) are untouched.
- `pnpm build` + `pnpm lint` clean in `web/`; backend type-checks clean.
- Verify against the live system via curl, including through the Vite proxy (:4827 → `/api`): create two chats, delete one, confirm the survivor is intact and streaming still works.
- No browser on this box: state clearly what you could and couldn't verify visually.

## Do NOT

- Change the worker, LLM call, Redis/pubsub flow, or stream protocol.
- Touch `.env`, `docker-compose.yml`, or restart infra.
- Over-engineer (no soft-delete, no restore, no pagination, no auth system).

Report: files changed, verification results, caveats.
