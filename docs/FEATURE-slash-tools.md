# FEATURE — Slash-invoked tools: pick a bound tool, fill args, run once (no follow-up)

**Status: design / plan. Not implemented.**

**Revision note:** a review pass found the original crash-recovery paragraph
in §4.3 too vague to implement safely (it could leave a recovered direct-tool
turn re-invoking the LLM, which the whole feature exists to avoid), a
manifest/type gap around the `subagent` tool's real argument list, and a race
in the proposed web-side reconcile fix. §2, §4.1, §4.3, §4.4, and §6 below
have been rewritten to close those; nothing else changed.

**One plan document** for adding a slash-command tool picker to the Stateless Chat
front end, where the chosen tool is executed *exactly like a normal LLM tool call*
(persisted rows, SSE chips, expandable transcript) but with **no LLM follow-up**: the
single tool result is the entire turn.

## 1. What (user-visible spec)

1. The only tools a user can invoke in a chat are the **tools bound to that chat**
   (definition in §4.2).
2. Typing `/` in the composer opens a **list of all bound tools**; each entry shows
   the tool name, **its arguments**, and a **very short description**.
3. The user picks from the list (mouse/arrow-keys/Enter/Tab), **or types the tool
   name after the `/`** and lets filtering select it.
4. After a tool is chosen, **argument fields appear with placeholders** (one per
   argument, required ones marked).
5. Pressing **Enter calls the tool** whether the arguments are complete or not:
   - complete/malformed/missing args are all accepted;
   - a missing/extra-required-arg call simply produces the tool's own error
     result, rendered like any failed tool call (✗ chip), not a failed turn.
6. The call is persisted **just like a normal tool call** (same rows, same grouping,
   same REST/SSE shapes — see §4.4), and **the one result is the whole turn**: no
   model text follows, no LLM round-trip happens after the tool result.

## 2. Current facts (verified in tree, do not re-derive)

**Worker (packages/worker)**
- Tool registry: `packages/worker/src/tools/index.ts` exports `DEFAULT_TOOLS`.
  Each `Tool` (`tool-loop.ts:104`) = `{ name, description, readOnly?, parallelSafe?,
  parameters (JSON Schema object), execute(args) }`. Fixed set: `get_current_datetime`,
  `calculator` (always on); `bash`, `read_file`, `write_file`, `edit_file` (gated by
  env flags); `subagent` (always on).
- Execution + persistence of a normal LLM tool call:
  - `insertToolCallRequest(pool, conversationId, replyToMessageId, iteration, calls[])`
    (`packages/shared/src/db.ts:718`) inserts the **assistant row carrying
    `tool_calls`** (`[{id,name,arguments}]`) whose `reply_to_message_id` = user row.
  - `executeToolCall(tc, toolsByName)` (`tool-loop.ts:299`, exported) runs one call and
    normalizes unknown-tool / bad-JSON / thrown errors into `{content, isError}`.
  - `insertToolResult(pool, conversationId, replyToMessageId, {toolCallId, toolName,
    result, isError})` (`db.ts:754`) inserts the **role='tool' row**.
  - `processMessage` (`packages/worker/src/index.ts`) wraps these in lease checks
    (`stillOwnsLease`) and, per turn: claims → `runToolLoop` → `insertAssistantMessage`
    (final text row) → `markMessageDone` → publish `done`.
- Turn recovery (`packages/worker/src/turn-recovery.ts`) reconciles interrupted turns
  from those same rows; it re-runs pending read-only calls via `executeToolCall`.
- Tool env gates live in shared env (`packages/shared/src/env.ts`):
  `toolBashEnabled`, `toolReadFileEnabled`, `toolWriteFileEnabled`,
  `toolEditFileEnabled`. `env` is loaded by gateway and worker from the same root
  `.env`, so both processes see the same enabled set.
- `subagent`'s real parameters (`packages/worker/src/tools/subagent.ts:102-125`)
  are **three** args, not two: `task` (string, required), `context` (string,
  optional), `tools` (array of strings, optional — an allowlist of tool names).
  An earlier draft of this doc said "task, optional tools" and dropped
  `context`; corrected throughout §4.1 below.
- `bash` runs as the full host user with passwordless sudo/docker access, not
  a sandboxed identity (`packages/worker/src/tools/bash.ts:8-10`, `EXEC_USER =
  "ubuntu"`). Relevant to §6: direct invocation reaches this same tool with no
  extra confirmation step.

**Gateway (packages/gateway/src/index.ts)** — REST surface today:
- `POST /conversations/:id/messages` `{clientId, content}` → 200 + `streamUrl`
  (content is arbitrary text; no command handling anywhere).
- `GET /conversations/:id/messages` — grouped history; standalone `tool` rows are
  consumed into the preceding assistant row's `tool_calls` (`group-history.ts`).
- `GET /conversations/:id/messages/:userId/tools` — full args + result for a turn,
  fetched on demand when a chip is expanded.
- SSE stream endpoint relays named events: `token`, `tool_start`, `tool_end`,
  `done`, `error` (Redis pub/sub → SSE, reconnect replays from Postgres).
- No `/tools` listing endpoint; gateway does not know the worker's tool set.

**Web (web/)**
- Send path: `Composer` → `App.handleSend` (`web/src/App.tsx:472`) → `sendMessage`
  POST → `streamReply` (`web/src/lib/api.ts`) → reducer actions
  (`turn/toolStart`, `turn/toolEnd`, `turn/done`, … in
  `web/src/lib/conversationStore.ts`).
- Rendering already handles assistant rows with **empty content + `tool_calls`**
  (`MessageBubble.tsx`: chips render, no empty bubble when content is empty and
  chips exist) — so a tool-only turn needs no new message rendering.
- `Composer.tsx` is a plain `<input>`; no slash handling, no autocomplete.

## 3. Design decisions (summary)

| Decision | Choice | Why |
|---|---|---|
| Trigger wire format | Message content `/<toolName> <argsText>` through the **existing** `POST /messages` | Zero schema change; rides the whole existing turn pipeline (SSE, history, reconnect, /tools detail) |
| Who detects the command | The **worker** (in `processMessage`, before `runToolLoop`) | Tools + host access live there; no new gateway executor |
| Args encoding | Trailing text: JSON object if it parses as one; else raw string iff the tool has exactly one declared arg; else `{}` | Deterministic; palette builds JSON, keyboard fast-path works for single-arg tools |
| No follow-up | Dedicated direct-tool branch; no LLM call, no title, no compaction pass | "One result is the whole turn" |
| Tool list source | New **shared manifest module** (UI metadata) + gateway endpoint filtered by the same env flags the worker uses | Gateway can serve the list without importing worker-only tool code; single env = consistent bound set |
| Per-chat binding | Bound set = deployment-enabled manifests (env-filtered), served per conversation id | Matches "only the tools bound within this chat"; a `conversation_tools` table is a later extension, contract is already per-conversation |

## 4. Changes by package

### 4.1 `packages/shared` — tool manifests

New `packages/shared/src/tools.ts` exporting a pure, dependency-free manifest list
(no `execute`, no host imports):

```ts
export interface ToolArgManifest {
  name: string;        // must match the worker parameter property name
  type: "string" | "number" | "boolean" | "object" | "array";
  required: boolean;
  description: string; // very short (< ~60 chars)
  placeholder: string; // explicit short hint shown in the arg field
}
export interface ToolManifest {
  name: string;
  description: string;       // very short, one line
  args: ToolArgManifest[];
}
export const TOOL_MANIFESTS: ToolManifest[]; // datetime, calculator, bash,
                                             // read_file, write_file, edit_file,
                                             // subagent
export function toolEnabled(name: string, envLike: { [k: string]: boolean }): boolean;
```

- `type` gained `"array"` — needed for exactly one arg today, `subagent.tools`
  (`{type: "array", items: {type: "string"}}` in the real tool). `number` /
  `boolean` / `object` currently have **no** matching arg on any of the 7
  tools; they're kept in the union for forward-compat but nothing in this
  plan exercises them. Don't let that stop the array case — it's real and
  ships in v1.
- `args` order = worker JSON-Schema `properties` order; `required` comes from
  `parameters.required`.
- **Placeholders** (examples to use):
  - `calculator.expression` → `(2 + 3) * 4`
  - `get_current_datetime.timezone` → `America/New_York`
  - `bash.command` → `ls -la /home/ubuntu`
  - `read_file.path` → `/home/ubuntu/README.md`
  - `write_file.path` / `.content` → `/home/ubuntu/notes.txt` / `hello world`
  - `edit_file.path` / `.old_string` / `.new_string` → … `old text` / `new text`
  - `subagent.task` → `Summarize this repo's README in 3 bullets`
  - `subagent.context` (optional string) → `File excerpts or prior findings to hand the subagent`
  - `subagent.tools` (optional array) → `read_file, bash`
- Worker tool files import their manifest entry so `parameters`/`description` and
  the manifest cannot drift (`calculator.ts` builds `parameters.properties` from
  `TOOL_MANIFESTS` args; same for the others, including all three of
  `subagent`'s args — `task`, `context`, `tools`).
- Export a helper the worker reuses: `enabledToolNames()` reads the shared `env`
  flags (same expression `DEFAULT_TOOLS` uses today).
- **Mandatory** (not optional) worker-side unit test asserting `DEFAULT_TOOLS`
  names ∪ params == `TOOL_MANIFESTS`. This is the only thing standing between
  "tool files import from the manifest" (true today, by construction) and a
  future edit that adds/renames a tool arg in one place and not the other —
  drop it and that drift is silent until a user hits it in the picker. Since
  the earlier draft of this doc itself had the manifest and the real
  `subagent` signature out of sync (missing `context`), treat that as the
  test's first regression case, not a hypothetical one.
- **Arg-value serialization for `type: "array"`:** the composer's arg-entry
  UI is one plain text input per arg (§4.4); an array-typed input is entered
  as a comma-separated list and split/trimmed into a JSON array of strings on
  submit (empty input → `[]`, omitted from the built args object if empty and
  not required — see `buildArgsJson` in §4.4). `type` does not drive any
  other coercion: every other arg type is passed through as the raw string
  the user typed, matching what the 6 non-array args actually need today. If
  a future tool adds a real `number`/`boolean`/`object` arg, extend
  `buildArgsJson`'s switch then — don't build unused coercion paths now.

### 4.2 Gateway — `GET /conversations/:id/tools`

New route behind the existing `requireAuth` gate + conversation-exists check:

```
GET /conversations/:id/tools
→ 200 { tools: ToolManifest[] }        // manifests whose env flag is on
→ 404 { error }                        // unknown conversation
```

- Filtering uses **the same shared `env` flags the worker uses** (§2), so "bound to
  this chat" == "this deployment's enabled tools", which is what this worker can
  actually execute. Document in the route comment that a future per-conversation
  subset (a `conversation_tools` join table + a bind/unbind admin surface) plugs in
  here without changing the response contract or the front end.
- No DB change, no cache needed server-side (static list per request).

### 4.3 Worker — direct-tool turn branch

New module `packages/worker/src/direct-tool.ts` exporting
`runDirectToolTurn(pool, message, channel, publisher, log)`; called from
`processMessage` **before** `runToolLoop`, after the existing lease/claim handling.

Detection (pure helper, exported for tests):

```ts
export function parseDirectInvocation(content: string): { toolName: string; argsText: string } | null
// "/calculator (2 + 3) * 4"        -> { toolName: "calculator", argsText: "(2 + 3) * 4" }
// "/write_file {json...}"          -> { toolName: "write_file", argsText: "{json...}" }
// "/not_a_tool hello"              -> null            (falls through to the LLM)
// "text" / "2 + 3"                 -> null
```

Flow (mirrors one iteration of `runToolLoop`'s persistence, including lease guards):

1. Parse content. If it is not a `/boundToolName …` invocation **whose name is an
   enabled, bound tool**, return `null` → `processMessage` continues into the normal
   LLM loop unchanged (so `/cheese` or `/bin/bash` questions still reach the model).
2. Resolve args deterministically:
   `argsText` trimmed empty → `{}`;
   starts with `{` and `JSON.parse` succeeds → the object;
   else if the tool's manifest has exactly one arg → `{ [argName]: argsText }`;
   else `{}` (a multi-arg tool missing args errors inside the tool → ✗ chip, not a
   failed turn).
3. Lease check (`stillOwnsLease`); `toolCallId = randomUUID()`; `iteration = 0`.
4. Publish `tool_start { toolCallId, toolName, args }` on the message channel
   (same `ToolEvent` shape as the loop).
5. `insertToolCallRequest(pool, convId, message.id, 0,
   [{ toolCallId, toolName, arguments: JSON.stringify(args) }])` — lease check just
   before, matching checkpoint #1 of the loop.
6. `executeToolCall({ id: toolCallId, name: toolName, arguments }, toolsByName)`
   where `toolsByName` comes from the existing `buildRunTools`/`DEFAULT_TOOLS`.
7. Lease check, then `insertToolResult(pool, convId, message.id, { toolCallId,
   toolName, result: content, isError })` — checkpoint #2 equivalent.
8. Publish `tool_end { toolCallId, toolName, isError }`.
9. **Skip** `insertAssistantMessage`, `maybeGenerateTitle`, compaction and any LLM
   call. `markMessageDone(pool, message.id)` then publish
   `done { messageId, content: "", usage: null, speedTps: null, durationMs: null }`.

Resulting rows are byte-identical in shape to one tool iteration of an LLM turn
minus the final text assistant row:

```
(user row: "/calculator (2+3)*4")
(assistant row: content "", tool_calls=[{id,name,arguments}], reply_to_message_id=user)
(tool row:     result, tool_is_error, tool_call_id, reply_to_message_id=user)
```

`groupMessagesForClient` already groups these and the UI already renders an
assistant row with empty content + tool_calls as just the chip block (§2), so
history, reconnect, and the expandable `/tools` detail endpoint all work with no
front-end message-shape changes.

**Crash-recovery interplay — this needs a real mechanism, not a policy
statement.** The naive version ("just make turn-recovery finish direct turns
instead of continuing the LLM") doesn't work, because `reconcileTurnState`'s
existing "already-final" detection (`turn-recovery.ts:63-66`) is:

```ts
const finalReply = rows.find((r) => r.role === "assistant" && !isToolCallAssistantRow(r));
if (finalReply) return { kind: "already-final", reply: finalReply };
```

— it looks for a plain (non-tool-calls) assistant row. A direct-tool turn
**never writes one** (step 9 above skips `insertAssistantMessage` on
purpose). So if a worker crashes after the tool result commits but before
`markMessageDone` runs — the exact window this paragraph exists to cover —
a reclaiming worker's reconcile pass sees a fully-resolved dangling request
row (no plain assistant row, no pending calls) and falls through to
`{kind: "ready", startIteration: N+1}`, the same outcome a genuinely
unfinished multi-round LLM turn produces. `processMessage`
(`packages/worker/src/index.ts:202-204`) treats every "ready" outcome
identically: fetch history, call `runToolLoop`. That calls the LLM — the one
thing this feature promises never happens for a direct-tool turn.

Fix: give `reconcileTurnState` a **fourth outcome** and the extra input it
needs to produce it.

```ts
export type ReconcileOutcome =
  | { kind: "ready"; startIteration: number }
  | { kind: "already-final"; reply: Message }
  // New: a direct-tool turn whose (only) tool-call request row is fully
  // resolved (no pending calls) - the turn is done, just never got to
  // markMessageDone/publish before the crash. Distinct from "already-final"
  // because there is no assistant text row to read a reply from.
  | { kind: "already-final-direct" }
  | { kind: "blocked-mutation"; reason: string };

export async function reconcileTurnState(
  pool: pg.Pool,
  tools: Tool[],
  conversationId: string,
  userMessageId: string,
  userContent: string,          // new: needed to re-derive "was this a direct invocation"
  isDirectInvocation: (content: string) => boolean, // parseDirectInvocation(content) !== null, bound-tool-checked
): Promise<ReconcileOutcome> { ... }
```

Rule: **after** the existing pending-calls resolution (including the current
read-only auto-retry loop at the bottom of the function, which itself can be
what makes `pending.length === 0` true), if `pending.length === 0` for the
last request row **and** `isDirectInvocation(userContent)` is true, return
`already-final-direct` instead of `ready`. This one rule covers both crash
windows a direct-tool turn can land in:

1. crash after `insertToolResult`, before `markMessageDone` (mutating or
   read-only tool — the result row is already there, so `pending` is already
   empty without any auto-retry needed);
2. crash after `insertToolCallRequest` but before `insertToolResult`, for a
   **read-only** direct tool — the existing auto-retry loop (lines 105-118)
   re-executes it and commits the result, `pending` becomes empty, same rule
   applies.

Mutating direct calls caught mid-flight (request row exists, no result, tool
not `readOnly`) still hit the existing `blocked-mutation` branch unchanged —
`reconcileTurnState`'s unsafe-call logic is already tool-agnostic, nothing
about it needs to know "direct vs LLM-issued" to do the right thing there.

`processMessage` gets a new branch parallel to the `already-final` one,
*before* the fresh-turn dispatch to `runDirectToolTurn`/`runToolLoop`:

```ts
if (reconciled.kind === "already-final-direct") {
  if (!(await stillOwnsLease(pool, message.id, env.workerId))) return;
  await markMessageDone(pool, message.id);
  await publisher.publish(channel, JSON.stringify({
    type: "done", messageId: message.id, content: "",
    usage: null, speedTps: null, durationMs: null,
  }));
  return; // no insertAssistantMessage, no maybeGenerateTitle, no runToolLoop
}
```

matching the actual `done` shape a first-attempt direct-tool turn publishes
(step 9 above) rather than the text-reply shape `already-final` publishes.

**Dispatch ordering**, made explicit (the original draft left this
unstated, and the two readings behave very differently): `processMessage`
must call `reconcileTurnState` **first, unconditionally** — exactly as it
does today — and only *after* getting back `{kind: "ready", startIteration:
0}` (a genuinely fresh turn, nothing persisted yet for it) does it call
`parseDirectInvocation(message.content)` to decide between
`runDirectToolTurn` and the normal LLM path. Direct-tool detection must
**never** run ahead of / instead of `reconcileTurnState` — doing so would
mean every *reclaimed* direct-tool turn re-executes the tool from scratch
without ever consulting its already-persisted request/result rows,
reintroducing the double-execution-of-a-mutating-call bug Phase 3 recovery
exists to prevent. `startIteration > 0` reaching this point can only mean
the turn already went through the reconcile branches above, so it's never a
fresh direct-tool dispatch by construction.

### 4.4 Web — palette, arg fields, dispatch

**Types (`web/src/types.ts`)** — add `ToolArgManifest` / `ToolManifest` (mirror of
the gateway JSON).

**API (`web/src/lib/api.ts`)**

```ts
export function getBoundTools(conversationId: string): Promise<ToolManifest[]>
```

Module-level in-memory cache `Map<conversationId, ToolManifest[]>` (per-chat only;
tools change only on worker restart / env change). No localStorage, no refetch per
keystroke; refresh on conversation switch or explicit error.

**New pure helper `web/src/lib/slashTools.ts`** (unit-testable, no React):
- `matchTools(token, tools)` — prefix/substring filter for the dropdown;
- `buildArgsJson(tool, values: Record<string,string>)` — raw strings for every
  arg except `type: "array"` args (currently only `subagent.tools`), which
  split the input on commas/trim/drop-empty into a JSON array (see §4.1's
  "Arg-value serialization" note);
- `buildCommand(tool, args)` → `/name {json}` (JSON when any arg present, else
  `/name`);
- `resolveFreehand(text, tools)` — when the user typed `/bash ls -la` directly:
  single-arg tool → raw; multiple-arg tool → require JSON text or submit `{}` on
  Enter (missing args are an accepted call per spec §1.5).

**Composer (`web/src/components/Composer.tsx`) — the bulk of the work.** New props:
`tools: ToolManifest[] | null` and reuse `onSend`. Behavior state machine:

- `idle` → typing. When the value starts with `/` (and no space yet after a name, or
  always while text starts with `/`), switch to `slashing`: render a dropdown of
  **bound tools** — each row: `name`, the arg list (`args` names with required
  markers), and `description` (one line).
- Dropdown keyboard nav: `↑`/`↓` move highlight, `Tab`/`Enter` picks the highlighted
  tool, `Esc` closes back to plain input. Filtering as the user types
  (`matchTools`), so typing the tool name by keyboard is just filtering + Enter.
- Picking a tool switches to `argEntry`: composer shows `/name` (fixed prefix), one
  input per manifest arg with its **placeholder** and a `*` for required; empty
  values are allowed. Enter submits regardless of completeness.
- Keyboard-only path: if the user typed `/name rest` and it is a bound
  **read-only** tool (`tool.readOnly === true` in the manifest — calculator,
  get_current_datetime, read_file), Enter builds the command via
  `resolveFreehand` with no popup (single-arg tools only). For a **mutating**
  bound tool (bash, write_file, edit_file, subagent — anything without
  `readOnly: true`), typing `/name rest` and hitting Enter does **not**
  freehand-submit even for single-arg tools like `bash`: it opens the
  dropdown/arg-entry UI pre-filtered to that tool instead, same as picking it
  from the list, so the user has to see the argument in its own labeled
  field and take a second explicit action before it runs. This exists
  because the wire format (§3, §6) can't otherwise tell "the user is talking
  about bash" from "the user is invoking bash" — see §6's expanded note.
  Read-only tools carry no side effect, so the fast path stays fast for them.
- Enter on `/not_a_tool …` (or a non-tool slash text like `/cheese`) sends the text
  as a **normal message** — never hangs, never 404s.
- Submitting a command calls the same `onSend(commandText)`; the composer then
  clears and re-disables exactly like a normal send (the direct turn occupies the
  conversation while the tool runs — `sending` guard unchanged).

**App (`web/src/App.tsx`)**
- When `conversationId` is ready (init load, `handleSelectConversation`,
  `handleNewChat`), `getBoundTools(id)` (cached) → pass `tools` to `Composer`.
- No change to `handleSend`: command strings flow through the same
  `sendMessage` + `beginStream` path, so tool chips, `done`, error, and reconnect
  all already work.
- **Reconcile on `done`** (correctness fix, revised — the original version
  raced): the direct turn is fast, so `tool_start`/`tool_end` can race ahead
  of the EventSource attach; a stale `running` chip would otherwise linger.
  The original draft proposed extending `beginStream.onDone`'s existing
  `getHistory` call (currently used only for `compactions/refreshed`,
  `App.tsx:161-167`) to also dispatch `history/loaded`. Don't do that:
  `history/loaded` (`conversationStore.ts:136-146`) **unconditionally
  replaces the whole `messages` array** for the conversation, and the
  `getHistory` fetch it would ride is async with no ordering guarantee
  against what the user does next. Given this section's own premise — the
  turn resolves faster than a round trip — it's entirely plausible the user
  starts a *second* turn (`turn/started`, which optimistically appends new
  messages) before the first turn's `getHistory` promise resolves; when it
  does resolve, a full `history/loaded` replace would wipe out that second
  turn's optimistic messages with a stale snapshot. This race does not exist
  today because `history/loaded` is currently only dispatched before any
  turn has started (`loadConversation`).
  Instead: reuse the already-existing per-turn detail endpoint
  (`GET /conversations/:id/messages/:userId/tools`, the same one `ToolCalls`
  calls on expand) and add a narrow reducer action, e.g.
  `{ type: 'turn/toolsReconciled'; id; assistantId; toolCalls: ToolCallSummary[] }`,
  that merges the fetched tool-call list into *that one* assistant message
  (same `updateMessage` helper the other `turn/*` cases already use) instead
  of replacing `messages`. Dispatch it from `onDone` keyed to `assistantId`,
  same as every other `turn/*` action in `beginStream` — no race, because it
  only ever touches the message it was fetched for, never the whole array.

**Rendering of the result** — unchanged: `ToolCalls` chip (✓/✗ + spinner while
running), expand to load `GET …/messages/:userId/tools` for args + result. The user
message bubble shows `/calculator (2+3)*4` as plain text (fine, self-documenting).

## 5. REST / SSE contract summary

- **New:** `GET /conversations/:id/tools` → `{ tools: ToolManifest[] }` (auth +
  conversation-exists checks). Static; no DB, no server cache.
- **Unchanged:** `POST /conversations/:id/messages` (`content` now may carry a
  `/toolName …` command), history, `/tools` detail, and every SSE event
  (`tool_start`, `tool_end`, `done` with `content:""`).

## 6. Edge cases / do-nots

- Missing / malformed args: run anyway → tool's own `Error:` result as an
  `isError` ✗ chip, never a failed turn.
- Unknown tool name after `/` or any other slash text: normal LLM message.
- While a turn is sending (`sending`), composer disabled — direct tool calls obey
  the same per-conversation serialization as normal sends (no double-run).
- Do **not** add a gateway HTTP endpoint that executes tools on demand: tool
  execution stays in the worker where host access, file locks and lease checks
  live.
- Do **not** feed the tool result back to the LLM, generate a title, or run
  compaction for a direct tool turn ("one result, no following behaviors").
- Do not silently re-execute a mutating direct call after a crash — reuse the
  existing mutating-call policy (block + manual resolution), which the row shape
  already inherits.
- `write_file`/`edit_file` remain path-jailed; `bash` remains env-gated — direct
  invocation is just a new way to reach the **same** trusted tool surface the model
  already has, for an already-authenticated chat user.
- **The wire format itself can't distinguish "a command" from "chat text that
  happens to start with a bound tool's name."** Because the trigger is
  `/toolName …` inside ordinary message `content` on the existing
  `POST /messages` (§3) rather than a separate field, any request to that
  endpoint whose content starts with, say, `/bash ` executes `bash` — which
  runs as the full host user with passwordless sudo/docker access
  (`bash.ts:8-10`) — with no confirmation, whether it came from the picker,
  from freehand typing, or from a raw API call. Accepted mitigations, not a
  full fix (a full fix would mean a separate structured field, which §3
  explicitly trades away to avoid a schema change):
  - The composer never lets a mutating tool submit via the no-popup freehand
    fast path (§4.4's revised "Keyboard-only path" bullet) — reaching a
    mutating tool through the UI always requires the explicit picker/arg-entry
    step, not just typing and hitting Enter.
  - This does **not** protect a direct `POST /messages` call from another
    client/script — that path is unchanged from what already exists today
    (an authenticated user's messages already reach `bash` via the LLM), so
    it's accepted as-is per the "same trusted tool surface" bullet above, not
    silently assumed away.

## 7. Acceptance criteria

1. `/` in the composer lists **only bound tools** for the current chat, each with
   name, args (required marked), and a one-line description.
2. Keyboard: type `/` + letters filters the list; `↑`/`↓`/`Tab`/`Enter` selects;
   `Esc` backs out. Typing a full tool name by hand selects it too.
3. Selecting a tool shows **one arg input per manifest arg with a placeholder**;
   Enter submits with any subset of args filled.
4. `/calculator 1+1` and `/calculator` both produce exactly one tool execution
   persisted as assistant(tool_calls) + tool rows; the ✗/✓ chip and expandable
   result appear; **no model text, no LLM call** follows.
5. `/not_a_tool hi` is answered by the model (normal message), not executed.
6. After a page reload, the direct-tool turn's chips + result render identically
   from history and from the `/tools` detail endpoint.
7. `GET /conversations/:id/tools` returns only env-enabled manifests; disabling
   `TOOL_BASH_ENABLED` removes `bash` from the picker and `/bash …` falls back to
   the LLM.
8. No regressions: normal LLM tool-call turns stream and persist exactly as before
   (existing tests green).

## 8. Implementation checklist (order)

1. `packages/shared/src/tools.ts` manifests + `toolEnabled`; worker tool files
   import them (name/description/parameters); drift test.
2. Gateway `GET /conversations/:id/tools` (+ route test).
3. Worker `direct-tool.ts` (`parseDirectInvocation`, args resolution, direct turn
   flow) wired into `processMessage`; unit + integration tests (calculator,
   read-only file tool, malformed args, unknown tool fall-through); extend
   `turn-recovery.ts` for direct turns.
4. Web `types.ts` + `getBoundTools` (cached) + `slashTools.ts` helpers + tests.
5. `Composer.tsx` palette/arg-fields state machine; `App.tsx` tools fetch +
   history reconcile on `done`; component test.
6. `docs/` update + manual acceptance pass.
