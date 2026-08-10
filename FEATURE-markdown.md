# FEATURE — Markdown rendering for chat replies

## What

Render LLM assistant replies as Markdown in the chat UI (`web/`). Today assistant messages render as plain text; after this change, headings, bold/italic, lists, links, blockquotes, and especially **code blocks** display properly.

## Current facts (verified)

- Repo `/home/ubuntu/stateless-chat`: npm workspaces backend + standalone pnpm app `web/` (Vite + React + TS + Tailwind v4). Backend live on :3000 (hot reload), web dev on :4827 (Vite HMR). Don't touch `.env`, `docker-compose.yml`, infra, or the backend/worker/stream protocol.
- `web/src/components/MessageBubble.tsx` renders each message's `content` as plain text (and shows a streaming cursor while the assistant reply is in flight).
- Streaming: tokens arrive via SSE `event: token` and are appended to React state in real time; a `done` event finalizes content.

## What to build

1. Add a Markdown renderer to `web/` (a well-maintained React markdown library — e.g. react-markdown; your choice of ecosystem pieces, but keep it minimal).
2. Render assistant message content through it in `MessageBubble.tsx` (user messages can stay plain text — only the assistant replies need Markdown).
3. Code blocks must be legible: monospace, basic padding/background, and (if cheap) syntax highlighting. Links should open safely (target=_blank + rel=noopener). Long output should not blow up layout (overflow handling).
4. Streaming behaviour must survive: while tokens are still arriving, the partial content should still render (render the current partial text through the renderer — it must not crash on half-finished Markdown like an unclosed code fence), and the streaming cursor indicator must keep working. Avoid heavy re-render churn on every token if reasonable (a simple memo or accepting per-token render is both fine for this scale — your call).
5. Keep the look consistent with the existing Tailwind styling of the bubbles.

## Acceptance criteria (self-verify)

- New dependency installed via pnpm, `pnpm build` + `pnpm lint` clean.
- The renderer demonstrably converts Markdown: as a headless box there's no browser, so verify at least by a small node/tsx script (or equivalent) that the renderer produces expected HTML for a sample (headings, list, code block, link), and state exactly what you verified and what still needs a visual check.
- Full send→SSE-stream→done cycle still works through the live backend (curl through :4827 proxy), and the app compiles/serves.
- No changes to the backend, worker, or stream protocol.

## Do NOT

- Touch the backend at all (this is frontend-only).
- Add a heavy editor/chat framework; a renderer component is all that's needed.
- Over-engineer (no custom syntax-highlighting server, no plugin zoo — a couple of small deps max).

Report: files changed, deps added, verification results, caveats.
