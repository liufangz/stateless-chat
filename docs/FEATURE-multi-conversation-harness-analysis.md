# FEATURE — Multi-Conversation Chatbot, Conversation-Ordering Gate, Cross-Process File Locking

**Status: implemented.**

## Decisions

1. Frontend: per-conversation state, keyed by conversation id, separate from
   the selected/viewed conversation. Conversations stream, switch, send, and
   delete independently; only the selected conversation's own outstanding
   turn disables its own composer.
2. Same-conversation second send: **blocked, not queued** — per conversation
   only, never a global/account lock.
3. Worker turn ordering: a conversation-scoped claim guard on top of the
   existing row-level `FOR UPDATE SKIP LOCKED` claim — at most one `user` row
   per conversation may be genuinely `processing` at a time. Cross-conversation
   throughput is unaffected.
4. Cross-process file mutation coordination: a shared PostgreSQL lease table
   (`file_locks`), not a process-local in-memory `Map`. No new service.
5. Deleting a conversation with a genuinely-processing turn is refused with a
   `409` conflict, not raced against the worker.

## Frontend contract

`web/src/lib/conversationStore.ts` — pure reducer over
`Record<conversationId, ConversationEntry>`:

```
ConversationEntry = {
  messages, compactions, historyLoaded, historyLoading,
  error, submitting, sendingMessageId, closeStream,
}
```

- `App.tsx` holds this via `useReducer` plus `dispatchSync` (advances a
  `convStateRef` mirror synchronously through the same reducer, then calls
  `dispatch`) and a `resumingRef: Set` guard against duplicate background
  resumes.
- Send guard: `submitting` is set synchronously on send start (before the
  network call) and checked alongside `sendingMessageId` before every send;
  cleared on success (`turn/started`) or `send/failed`.
- `beginStream(conversationId, replyToMessageId, streamUrl, userMessage?)`
  streams are closed on `done`/error, conversation delete, logout, and unmount.
- `ensureLoaded(id)` loads history once. `ensureOutstandingAttached(id,
  outstandingMessageId)` re-attaches whenever `sendingMessageId` doesn't
  match the server-reported outstanding message, even if history was already
  loaded — used by `refreshConversations`'s background scan and by
  `handleSelectConversation`, backed by a 20s periodic refresh poll.
- `api.ts`: `isServerSentErrorEvent(event)` distinguishes a real server-sent
  `error` SSE message (`MessageEvent`, has `.data`) from the browser's native
  EventSource connection-failure event (plain `Event`, no `.data`); only the
  latter, once `readyState === CLOSED`, is reported as terminal.
- `GET /conversations` returns `outstanding_message_id` /
  `outstanding_status` / `outstanding_last_error` per conversation.
- `Sidebar.tsx`: no `disabled` prop; a per-row dot marks an outstanding
  (pulsing) or failed (red) turn. A `409` delete conflict surfaces via the
  existing per-conversation `error/set` path.

## Worker claim-ordering contract

`claimPendingMessages` (`packages/shared/src/db.ts`) adds two conjuncts to its
`FOR UPDATE SKIP LOCKED` claim query's `WHERE` clause:

- `pg_try_advisory_xact_lock(hashtext(conversation_id::text)::bigint)` —
  non-blocking, transaction-scoped; a concurrent claimer racing for the same
  conversation fails this and skips that candidate.
- `NOT EXISTS (another 'user' row in the same conversation with
  status='processing' AND a live lease)`.

**Limitation:** advisory locks are re-entrant within one transaction, so a
single call with `limit > 1` could still claim two pending rows of the same
conversation in one pass. Not reachable today — the worker always calls with
`limit=1` (`packages/worker/src/index.ts`). Verified against real spawned
processes (`limit=1`), not just `Promise.all` in one process; existing
lease/recovery/idempotency tests pass unmodified.

## PostgreSQL file lock contract

`file_locks (lock_key PK, owner_token, acquired_at, expires_at)` in
`packages/shared/src/db.ts`, with `acquireFileLock` / `renewFileLock` /
`releaseFileLock`. Acquire is one atomic `INSERT ... ON CONFLICT (lock_key)
DO UPDATE ... WHERE expires_at < now()`. Fencing: renew/release require a
matching `owner_token`.

`packages/worker/src/tools/file-lock.ts`:

- `FileLock` interface (`acquire`/`renew`/`release`) and
  `createPostgresFileLock(pool?)` (lazy singleton default pool). Test-only
  fake in `test/support/fake-file-lock.ts`.
- `withFileLock(lockKey, fn, { lock, leaseDurationMs, acquireTimeoutMs })`:
  bounded-wait-with-backoff acquisition (default 20s), a renewal heartbeat
  while `fn` runs, release in a `finally`. Timeout throws a plain `Error`
  routed through `executeToolCall`'s catch-all.
- Lease loss: `fn` receives `FileLockContext.isLeaseLost()` to check before
  its mutating step. `withFileLock` refuses to resolve successfully if lease
  loss was observed at any point during the hold, regardless of `fn`'s own
  outcome. A rejected `renew()` call (transient error) is not treated as
  loss — only an explicit `false` is.
- Lock identity: `canonicalLockKey` (`file-path-jail.ts`) — realpath of an
  existing target, or realpath of the nearest existing ancestor plus the
  remaining not-yet-existing suffix.

`write-file.ts` / `edit-file.ts` wrap their full read/validate/write/rename
sequence inside `withFileLock`. `edit_file` re-reads the file after acquiring
the lock, so a stale `old_string` fails clearly instead of applying
incorrectly. `write_file` gained an optional `expected_hash` (sha256)
argument: a mismatch against an existing file's current content is rejected
before writing; omitted = unconditional overwrite (backward compatible), and
creating a new file is unaffected either way. **Boundary:** `bash` writes are
not covered by this lock — no existing safe interception point in `bash.ts`.

## Conversation delete contract

`deleteConversation` (`packages/shared/src/db.ts`) returns
`"deleted" | "not_found" | "in_progress"`. `"in_progress"`: a genuinely
processing (live-leased) turn exists — delete refused, nothing touched;
gateway `DELETE /conversations/:id` returns `409`. Candidate rows are locked
(`FOR UPDATE`) for the delete transaction so a concurrent claim is serialized
against it. Liveness is computed in SQL against `now()`, never fetched and
compared in JS. An abandoned/crashed turn (expired lease) does not block
deletion.

## Touched files (includes all new/extended tests)

- Backend: `packages/shared/src/{db,types}.ts`, `packages/gateway/src/index.ts`.
- Worker tools: `packages/worker/src/tools/file-lock.ts` (new),
  `file-path-jail.ts`, `write-file.ts`, `edit-file.ts`, `index.ts`.
- Frontend: `web/src/App.tsx`, `web/src/lib/conversationStore.ts` (new),
  `web/src/lib/api.ts`, `web/src/components/Sidebar.tsx`, `web/src/types.ts`.
- New worker tests (`packages/worker/test/`): `db-file-lock`, `file-lock`,
  `db-conversation-claim`, `db-conversation-claim-cross-process`,
  `file-lock-cross-process`, `db-delete-conversation`,
  `support/{fake-file-lock,file-lock-cli,claim-cli}.ts`. Extended:
  `write-file-tool.test.ts`, `edit-file-tool.test.ts`.
- New web tests (`web/test/`): `conversationStore.test.ts`, `api.test.ts`.
- Docs: this file, `web/SPEC.md`.

## Acceptance criteria

- Different conversations send/stream concurrently with no cross-contamination;
  switching away and back preserves in-background progress.
- A second send into the same conversation is blocked at the UI, robust to a
  rapid double-click (synchronous guard, not dependent on a server round trip).
- A conversation's live stream survives a transient network blip; one whose
  stream did die (browser gave up) is re-attached on the next refresh or
  selection, not left dead indefinitely.
- Two workers never both mark a row in the same conversation `processing`;
  different conversations still claim fully in parallel, including across
  real separate OS processes.
- Two workers/processes editing the same file path never interleave writes; a
  lock holder whose lease is reclaimed never has its result reported as a
  trustworthy success.
- Deleting a conversation with an active turn returns a clear `409` and
  touches nothing; it succeeds once the turn finishes.

## Verification

- `npx tsc --noEmit -p packages/{shared,worker,gateway}/tsconfig.json` — clean.
- `packages/worker`, `DATABASE_URL=.../chat_test npx vitest run` — **240/240
  passing** across 20 files, stable across repeated runs.
- `packages/gateway`, `npx vitest run` — 6/6 passing.
- `web`: `npx tsc -b`, `npm run build`, `npm run lint` (oxlint), `npx vitest
  run` — all clean, **39/39 tests** across 3 files.
- Live smoke test against the running dev gateway/worker (`tsx watch`,
  hot-reloaded with no crash): concurrent conversations replied independently;
  a second same-conversation send stayed `pending` until the first completed;
  a real two-writer race on one file path via the default (non-test-injected)
  lock wiring produced a uniform, non-interleaved file with no lock rows left
  behind; a mid-turn delete returned `409`, then `204` once the turn finished.

## Limitations

1. Queueing (instead of blocking) a second same-conversation send is
   deferred until the conversation-ordering gate has held up under real load.
2. `expected_hash` is opt-in, not required, for overwriting an existing file.
3. `bash`-issued writes remain outside the file-lock guarantee.
4. No HTTP-level test harness exists for `packages/gateway` (no
   supertest-equivalent) — the `DELETE → 409` route is covered by the DB
   layer's tests and a live smoke test, not an automated HTTP test.
