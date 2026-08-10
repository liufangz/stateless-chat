# Stateless Chat — Web UI

Minimal React + TypeScript chat frontend for the `stateless-chat` backend. Single conversation,
persisted across reloads via `localStorage`, assistant replies stream token-by-token over SSE.

## Run it

The backend (gateway on `http://localhost:3000`, workers, postgres, redis) must already be
running — see the repo root README.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:5173`. The Vite dev server proxies `/api/*` to `http://localhost:3000/*`
(see `vite.config.ts`), so the browser never talks cross-origin to the gateway.

## How it works

- `src/lib/storage.ts` — generates/persists a random `clientId` and the active `conversationId` in
  `localStorage`.
- On load, `src/App.tsx` reuses the stored conversation (reloading its history) or creates a new
  one, then renders the message list.
- Sending a message POSTs it, then opens an `EventSource` on the returned `streamUrl` and appends
  each `token` event to the assistant bubble live; the `done` event finalizes it.
- A page reload re-fetches history from the backend, so persisted messages survive.

## Build

```bash
pnpm build     # tsc -b && vite build -> dist/
pnpm preview   # serve the production build
```
