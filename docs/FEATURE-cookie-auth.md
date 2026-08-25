# FEATURE — Cookie-based login (replace HTTP Basic Auth)

## What

Replace the nginx `auth_basic` gate on `chat.liufangz.space` with proper cookie-based login in the app. The browser's native basic-auth dialog (which pops on every new browser session) must disappear entirely. Login persists like a normal website.

## Current facts (verified)

- Repo `/home/ubuntu/stateless-chat`: npm workspaces (`packages/gateway`, `packages/worker`, `packages/shared`) + standalone pnpm app `web/` (Vite + React + TS + Tailwind). Backend live on :3000 (tsx watch hot-reloads), web dev :4827 (Vite HMR). Don't touch `.env`, `docker-compose.yml`, or infra.
- Today nginx does `auth_basic` against `/etc/nginx/.htpasswd-chat` (this will be REMOVED from nginx as part of this change — done outside the repo by the operator after your build; you just build the app-side auth).
- `.env` already contains `AUTH_PASSWORD=<the shared chat password>` and `AUTH_SECRET=<random hex>` — read them via the existing env loader (`packages/shared/src/env.ts`).
- Frontend: `web/src/App.tsx` fetches `/api/conversations` on mount, streams via `/api/.../stream` (EventSource), renders Markdown. All calls same-origin through the Vite proxy.

## What to build

**Backend (packages/gateway):**
1. `POST /login` — body `{password}`. If it matches `AUTH_PASSWORD`, set an **HttpOnly, Secure, SameSite=Lax** cookie with a signed token (HMAC over payload with `AUTH_SECRET`; include expiry ~30 days; stateless — no DB/session store). Return 204/200. Wrong password → 401 JSON.
2. `POST /logout` — clears the cookie.
3. `GET /auth/status` — 200 `{authenticated:true}` with valid cookie, 401 otherwise. (Lets the frontend know login state on mount.)
4. **Auth middleware** for all `/api/*` routes: valid cookie → next; otherwise **401 JSON `{error:"unauthorized"}` with NO `WWW-Authenticate` header** (critical: that header is what triggers the native dialog). 401 responses must be consistent JSON so the frontend can detect "not logged in" vs other errors.
5. Token verification must be timing-safe; malformed/expired tokens → 401.

**Frontend (web/):**
1. On mount, check `/api/auth/status`; if unauthenticated, show a **small, clean login screen** (password field + submit) instead of the chat UI. On success, load the chat UI.
2. Any 401 from API calls → return to the login screen (session expired).
3. A small **logout** control (e.g. in the sidebar footer or header) → `POST /api/logout` → login screen.
4. Streaming, sidebar, markdown, delete — all existing behaviour must keep working.

## Acceptance criteria (self-verify, live)

- No `WWW-Authenticate` header appears in ANY response (curl `-D -` on `/api/...`, `/login`, `/auth/status`).
- `GET /api/conversations` without cookie → 401 JSON; with cookie → 200.
- `POST /api/login` wrong password → 401; right password → sets cookie (verify `Set-Cookie` flags: HttpOnly, Secure, SameSite=Lax, Expires ~30d).
- Cookie from login works across all routes including the SSE stream (curl with a cookie jar: login → create conversation → send message → stream SSE → done).
- Expired/tampered cookie → 401 (tamper test: flip a char in the token).
- `pnpm build` + `pnpm lint` clean in `web/`; backend type-checks clean.
- State clearly what you verified and what needs a visual browser check.

## Do NOT

- Change the worker, LLM call, Redis/pubsub flow, or stream protocol.
- Touch `.env` contents (read-only), `docker-compose.yml`, or restart infra.
- Build a user system/DB — a single shared password (as today) is the goal; no signup, no per-user accounts, no rate limiting beyond a trivial in-memory throttle if you want one.
- Change nginx yourself — the operator removes `auth_basic` after you're done.

Report: files changed, verification results, caveats.
