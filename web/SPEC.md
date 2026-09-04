# SPEC — Stateless Chat: Multi-Conversation Chatbot & Customizable Agent Harness

## What

A chatbot product built on the existing `stateless-chat` backend (this repo): a
frontend where a logged-in user can have **multiple different conversations
generating replies in parallel**, backed by a **customizable agent harness** — a
durable, recoverable, tool-using agent runtime — rather than a single linear
request/reply loop bolted onto a chat UI. Multiple worker processes provide
cross-conversation throughput.

This supersedes the original single-conversation MVP framing of this document. It is
a **product-level WHAT/WHY specification** — implementation choices (source layout,
function signatures, specific libraries) are deliberately out of scope; see
`docs/FEATURE-multi-conversation-harness-analysis.md` for the current architecture,
verified facts, and the implementation-level design analysis this spec is grounded in.

### Trusted host-agent mode

The harness runs in a trusted operator configuration. Its file tools can read, create, overwrite,
and edit any path under `/home/ubuntu`, including hidden files, credentials, Git metadata,
dependencies, and other projects. The `bash` tool runs arbitrary host commands as `ubuntu` with
`HOME=/home/ubuntu`; because that account has passwordless sudo and Docker access on the reference
machine, bash can modify the entire machine, including paths outside the home directory. The file
tools retain only traversal and symlink-containment checks; this is not an OS sandbox. Destructive
or security-sensitive changes remain subject to explicit user-request guidance, not technical
containment.

## Why

The single-conversation MVP proved the core streaming/persistence loop works. The
product now needs to behave like a modern chat application (several ongoing
conversations, each independently live) while giving the agent itself real
capabilities (tools that can read/write files) — which introduces genuine
concurrency and coordination problems (two conversations generating at once, two
workers touching the same file) that a single-conversation design never had to
solve. This spec defines the product behavior those problems require, without
prescribing how the code is organized to deliver it.

## Product requirements

### Parallel conversations

- A user may have any number of conversations, and any number of them may have a
  reply actively generating at the same time. Viewing, switching between, sending
  into, and deleting conversations must never be blocked by another conversation's
  activity.
- Switching away from a conversation with an active reply and back must not lose any
  part of that reply — the conversation continues generating in the background and
  the full result (including anything generated while unviewed) is visible on
  return, whether the user was watching live or not.
- A reload or a fresh device/session must recover the true current state of every
  conversation, including one whose reply was still generating at the moment of
  reload — the user is never shown stale or missing state for a turn that actually
  completed (or actually failed) while they weren't connected.
- Deleting a conversation that has a reply actively generating is prevented
  with a clear, actionable conflict response - not silently raced against the
  still-in-flight backend work, and not left to produce an unhandled backend
  error. The conversation and its data are untouched until that reply
  finishes, at which point deletion succeeds normally.

### No steering (current scope)

- Steering an in-progress reply (interrupting it with new instructions mid-generation)
  is explicitly out of scope for this phase.
- **Sending a second message into a conversation that already has a reply in
  progress is blocked, not queued**, for as long as this phase lasts: the user
  cannot start a second turn in the same conversation until the first has finished.
  This is a deliberate, temporary choice, not an oversight — accepting a second
  message before the backend can guarantee that both turns will run against
  correct, non-overlapping conversation history risks two replies being generated
  from inconsistent state for the same conversation. Queueing (accepting the second
  message and running it automatically once the first finishes) may be introduced
  later, once that guarantee exists, without this being a breaking change.

### File/tool conflict semantics

- The agent's tools may read, write, and edit files as part of generating a reply.
  When two agent runs — whether from the same conversation's tools acting in
  parallel, or from two different conversations' turns running on two different
  workers — attempt to mutate the same file at the same time, the product must
  guarantee that neither mutation is silently lost and neither run observes a
  half-written file.
- The expected behavior when a second run requests a file another run is actively
  editing: the second run waits briefly for the first to finish, and if the first
  hasn't finished within a bounded time, the second run receives a clear,
  actionable failure it can react to (retry, tell the user, or try something else)
  rather than hanging indefinitely or silently overwriting.
- A file edit that targets specific existing content must fail clearly, rather than
  silently apply against a mismatched result, if that content has changed since the
  agent last read it.
- This conflict-avoidance guarantee is about protecting shared files from
  simultaneous mutation. It is a separate guarantee from — and does not by itself
  ensure — that two turns in the same conversation were generated from consistent,
  correctly-ordered conversation history; the latter is the "no steering" /
  same-conversation blocking requirement above, not a file-locking concern.

### Architecture components (what must exist, not how)

- A **frontend** capable of tracking and rendering more than one conversation's live
  state at once, independently of which conversation is currently in view.
- A **stateless job-queue backend** that durably records every message and turn, so
  that any of several interchangeable worker processes can pick up any pending
  turn, and so that a turn already in progress is never silently duplicated by a
  second worker picking up the same work.
- A **worker pool**: any number of interchangeable worker processes, each capable of
  independently generating replies (including running tools) for whichever
  conversation's turn it claims, providing throughput that scales with the number
  of workers.
- A **customizable agent harness**, not a single hard-coded request/reply function:
  the system that actually drives one turn's generation must expose, as durable,
  inspectable pieces:
  - **Lifecycle events** — a complete, ordered account of everything one turn did
    (started, streamed text, called a tool, finished), sufficient to drive a live UI
    and to reconstruct what happened after the fact.
  - **A tool registry with permissions** — which tools are available is a
    controllable property of a given run, not a single global list baked into the
    whole system.
  - **Per-run durable state** — enough is persisted after each step that a turn
    interrupted by a crash or restart can resume from where it left off, without
    guessing at, re-running, or silently skipping a step whose real-world effect
    (e.g., a file write) is unknown.
  - **Recovery** — every plausible crash point (before generation starts, mid-tool-call,
    after the final answer but before it's marked complete) has a defined, safe
    recovery behavior; a step whose real-world side effect cannot be safely guessed
    at is surfaced for manual resolution rather than silently retried or skipped.
  - **Support for parallel runs at two distinct levels** — different conversations'
    turns running concurrently across the worker pool, and independent steps
    (e.g., independent tool calls) running concurrently within a single turn — and
    neither level of parallelism may be constrained by mechanisms introduced to
    solve the other (e.g., a fix for cross-conversation file safety must not reduce
    intra-turn tool-call concurrency).
  - **Extensibility** — a sanctioned way to intercept and adjust a run's behavior
    (e.g., vetoing or patching a tool call, injecting extra context, deciding to stop
    early) without requiring bespoke changes to the core generation loop for each new
    behavior.
  - **Observability** — a live view of what a run is doing while it's happening, at
    minimum; whether the product additionally requires a durable, replayable record
    of that same detail after the run has finished is an open product decision (see
    `docs/FEATURE-multi-conversation-harness-analysis.md`, Open decisions).

## Acceptance criteria (testable)

- With two conversations each having a reply in progress at the same time, a user
  can freely view either one, and both replies complete correctly and are fully
  visible, with no dropped or duplicated content in either.
- Switching away from a conversation mid-reply and switching back shows the reply as
  it actually progressed the whole time, not just from the moment of return.
- Reloading the page during an in-progress reply recovers that reply's true current
  state (still generating, or the completed answer, or a clear failure reason) for
  every conversation that had one outstanding, not only the conversation last
  viewed.
- Attempting to send a second message into a conversation that already has a reply
  in progress is rejected or disabled at the point of send, with no way to trigger
  two concurrent replies for one conversation through the UI.
- Two agent runs that both attempt to mutate the same file at overlapping times: the
  second either waits and then succeeds against the first run's completed change,
  or fails clearly and promptly — never a silently corrupted or partially-written
  file, and never an indefinite hang.
- An edit targeting content that has changed since it was last read fails with a
  clear error rather than applying incorrectly.
- Running additional worker processes increases the number of different
  conversations that can generate replies at the same time, with no code change
  required to achieve that scaling.
- A worker process crashing mid-turn never results in a duplicated final reply for
  that turn, and never silently loses or fabricates the outcome of a tool call whose
  real-world effect at the moment of the crash is ambiguous.

## Non-goals (this phase)

- Steering / interrupting a reply that is already generating.
- Queued (as opposed to blocked) handling of a second same-conversation send.
- Any UI or backend behavior that requires guessing at, rather than durably
  determining, the outcome of an interrupted mutating tool call.
- A centralized tool-execution service, or any other large new architectural
  component beyond what's needed for cross-conversation file-conflict safety.
- Multi-host worker deployment where workers do not share a common filesystem/DB/Redis
  view — the file/tool conflict guarantees above assume the coordination mechanism
  chosen for them accounts for this if it becomes true later, but a multi-host
  deployment itself is not part of this phase.

## Verification caveats

This is a headless environment: UI acceptance criteria involving live browser
interaction (parallel streams rendering correctly, switching mid-reply, reload
recovery) should be verified with a real browser where available; where no browser is
available, verify what's verifiable via the dev server + backend and curl/EventSource
clients against the relevant endpoints, and state clearly what could and couldn't be
visually confirmed — the same caveat the original MVP spec carried, unchanged by this
revision. As implemented, the frontend's per-conversation state machine (isolation,
switching mid-stream, cleanup, same-conversation blocking) is covered by unit tests
against the actual reducer rather than a rendered browser; the backend guarantees
(conversation-ordering claim gate, cross-process file lock) are additionally verified
against a real Postgres instance, including real concurrent OS processes for the file
lock - see `docs/FEATURE-multi-conversation-harness-analysis.md`'s verification
checklist for exactly what ran.
