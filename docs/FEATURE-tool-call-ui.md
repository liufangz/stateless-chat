# FEATURE — Tool-Call UI (Phase 3 of the tool-call loop)

**Status: implemented.**

## What

Phase 3 of `docs/FEATURE-tool-call-loop.md`'s rollout plan: persist a turn's full
tool exchange (calls + results) to Postgres, expose it over REST, and render it
in the web UI — live "using `<tool>`…" chips while streaming, expandable to full
arguments/result once a call finishes. The SSE wire contract
(`token`/`done`/`error`/`tool_start`/`tool_end`) is unchanged; this phase is
additive on top of it.

## Schema

`messages` gained four nullable columns (idempotent `ALTER TABLE ... ADD COLUMN
IF NOT EXISTS`, applied automatically by `initSchema()` on gateway boot):

```sql
tool_calls     JSONB    -- assistant tool-call rows only: [{ id, name, arguments }]
tool_call_id   TEXT     -- role='tool' rows only
tool_name      TEXT     -- role='tool' rows only
tool_is_error  BOOLEAN  -- role='tool' rows only
```

The `role` CHECK constraint was widened from `('user','assistant')` to
`('user','assistant','tool')` (drop + recreate `messages_role_check`, also
idempotent). `tool_calls.arguments` is the raw JSON string the model produced
(the OpenAI wire shape), not a parsed object - this is what lets the persisted
row round-trip directly back into a `ChatMessage` on the next turn.

**Persisted row order per turn** (one tool-using iteration = one LLM round-trip
that requested tool calls): user row, then for each iteration one assistant row
carrying `tool_calls` immediately followed by one `tool` row per call result,
then finally the existing plain-text assistant row. `insertToolExchange`
(`packages/shared/src/db.ts`) groups the worker's flat `ToolExchangeRecord[]` by
its `iteration` field and inserts sequentially so `created_at` ordering matches
execution order.

`listConversations`' sidebar snippet and `getReply` (used for SSE-reconnect
replay) both explicitly exclude/filter tool-call rows - a client never sees raw
tool output as a "last message" or as a reconnect payload.

## Worker changes

- `runToolLoop` now returns `Promise<{ content: string; toolExchange:
  ToolExchangeRecord[] }>` instead of `Promise<string>`. Each `ToolExchangeRecord`
  = `{ iteration, toolCallId, toolName, arguments, args, result, isError }`, one
  per executed (or auto-failed) tool call, in execution order. `ToolEvent` (the
  SSE payload shape) is unchanged.
- History reconstruction (`sliceHistoryAtTurnBoundaries` +
  `rowToChatMessage` in `packages/worker/src/tool-loop.ts`) replaced the old
  `history.slice(-HISTORY_LIMIT)` + `{role, content}` mapping. It now: takes the
  last `HISTORY_LIMIT` rows, walks the start backward to the nearest preceding
  `user` row (so a tool exchange is never entered mid-way), and walks the end
  forward to include every `tool` row belonging to the last included exchange
  group. Covered by unit tests in `packages/worker/test/tool-loop.test.ts`
  (`sliceHistoryAtTurnBoundaries` describe block) using a fixture where the raw
  cut lands exactly on a `tool` row.
- `processMessage` (`packages/worker/src/index.ts`) calls `insertToolExchange`
  before the existing `insertAssistantMessage` call, inside the same try block.

## REST contract

`GET /conversations/:id/messages` - unchanged path, response shape now grouped:
tool rows are consumed into the preceding assistant row's `tool_calls` array and
never appear standalone.

```jsonc
{
  "conversationId": "...",
  "messages": [
    { "id": "...", "role": "user", "content": "...", ... },
    {
      "id": "...", "role": "assistant", "content": "", "reply_to_message_id": "<user msg id>",
      "tool_calls": [
        { "id": "call_...", "name": "get_current_datetime", "arguments": "{}", "isError": false }
      ]
    },
    { "id": "...", "role": "assistant", "content": "final text", "reply_to_message_id": "<user msg id>" }
  ]
}
```

New endpoint, keyed by the **user** message id (matches `done.messageId` from the
SSE stream and `reply_to_message_id` on grouped assistant rows):

```
GET /conversations/:conversationId/messages/:messageId/tools
```

```jsonc
{
  "conversationId": "...",
  "messageId": "...",
  "toolCalls": [
    { "id": "call_...", "name": "get_current_datetime", "arguments": "{}", "result": "2026-...Z", "isError": false }
  ]
}
```

`toolCalls: []` (200) when the turn had no tool calls; 404 for an unknown
conversation or message id, same as sibling routes.

## Frontend

- `web/src/types.ts`: `Message` gained `tool_calls?: ToolCallSummary[]` and
  `reply_to_message_id`; new `ToolCallSummary` (`id, name, arguments?, isError?,
  running?`) and `ToolCallDetail` (`id, name, arguments, result, isError`).
- `web/src/lib/api.ts`: `streamReply` dispatches `tool_start`/`tool_end` to new
  optional `StreamHandlers.onToolStart`/`onToolEnd` callbacks; new
  `fetchToolCalls(conversationId, userMessageId)` hits the REST endpoint above.
- `web/src/App.tsx` `handleSend`: `onToolStart` pushes a `{id, name, arguments,
  running:true}` entry onto the optimistic assistant message's `tool_calls`;
  `onToolEnd` flips `running:false` and sets `isError`. On `done`, instead of
  patching the placeholder in place, it re-fetches `getHistory` and replaces
  `messages` wholesale with the canonical persisted rows (real ids, grouped
  `tool_calls` summaries) - the placeholder id is not kept around.
- `web/src/components/ToolCalls.tsx` (new): renders one chip per tool call
  (spinner while `running`, ✓/✗ once done, name + truncated inline args).
  Clicking a finished chip expands it inline and lazily fetches
  `fetchToolCalls` (cached per message so repeat expands don't re-fetch),
  rendering arguments (pretty-printed JSON) and result in `<pre>` blocks, with
  loading/error states. Chips are `disabled` while `running`.
- `MessageBubble`/`MessageList` thread a `conversationId` prop down so
  `ToolCalls` can build the REST URL; wired in only for non-user messages with a
  non-empty `tool_calls` array, so plain text-only turns render exactly as
  before.

## Verification performed

- `npm test -w packages/worker`: 69/69 passing, including new
  `sliceHistoryAtTurnBoundaries` tests and updated exchange-record assertions.
- `npm run build` in `web/` (tsc -b + vite build): clean.
- Live stack: schema migration applied and confirmed idempotent (`initSchema`
  run twice, `\d messages` inspected via `docker exec stateless-chat-postgres
  psql`). Sent real tool-triggering prompts through the running gateway/worker;
  confirmed `tool_start`/`tool_end` SSE payloads are byte-identical to the old
  shape, confirmed persisted row order (assistant-tool_calls -> tool -> tool ->
  assistant-final-text), confirmed grouped history has no standalone `role:
  'tool'` rows, confirmed the `/tools` endpoint returns full results, confirmed
  404s for unknown conversation/message ids, and confirmed the sidebar snippet
  never surfaces raw tool output. Frontend chip/expansion behavior was verified
  via the web build's type-checked contract only - not exercised in an actual
  browser (headless environment, no browser automation available in this
  session).
