import pg from "pg";
import { env } from "./env.js";
import type {
  Compaction,
  Conversation,
  ConversationSummary,
  Message,
  ToolExchangeRecord,
} from "./types.js";

const { Pool } = pg;

export function createPool(): pg.Pool {
  return new Pool({ connectionString: env.databaseUrl });
}

const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  reply_to_message_id UUID REFERENCES messages(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_message_id);

-- Tool-call persistence (Phase 3): nullable, additive - existing rows are
-- unaffected. tool_calls holds the assistant's issued calls for one loop
-- iteration ({id, name, arguments}[]); tool_call_id/tool_name/tool_is_error
-- are set only on role='tool' result rows.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_calls JSONB;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_call_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_name TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_is_error BOOLEAN;

-- Widen the role check to allow 'tool' rows. Postgres auto-named the
-- original constraint messages_role_check; drop/recreate is idempotent since
-- both statements no-op (IF EXISTS) or replace on every schema init.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_role_check;
ALTER TABLE messages ADD CONSTRAINT messages_role_check CHECK (role IN ('user', 'assistant', 'tool'));

-- Token usage + stream timing: nullable, additive - set only on a turn's
-- final text assistant row (tool-call/tool rows and legacy rows stay NULL).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS completion_tokens INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

-- pi-style token-budgeted auto-compaction: one row per compaction pass, most
-- recent first via the index below. first_kept_message_id is the id of the
-- first 'user' row still sent to the LLM after this compaction - the next
-- compaction's summarization span starts there, not at this row.
CREATE TABLE IF NOT EXISTS compactions (
  id TEXT PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  first_kept_message_id TEXT NOT NULL,
  tokens_before INTEGER NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS compactions_conversation_created ON compactions (conversation_id, created_at DESC);

-- Phase 4 durable compaction: record exactly what a pass summarized (the
-- source span's start, alongside the pre-existing first_kept_message_id as
-- its end/retained boundary) and which turn triggered it. Nullable/additive
-- - pre-Phase-4 rows simply lack this metadata. triggered_by_message_id
-- doubles as this pass's idempotency key (see insertCompaction): unique, so
-- a crash-and-retry of the same turn can't create a second compaction row
-- for it. Postgres treats every NULL as distinct under a unique index, so
-- legacy rows without this field don't collide with each other or with it.
ALTER TABLE compactions ADD COLUMN IF NOT EXISTS source_start_message_id TEXT;
ALTER TABLE compactions ADD COLUMN IF NOT EXISTS triggered_by_message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_compactions_triggered_by_unique
  ON compactions (triggered_by_message_id);

-- Belt-and-suspenders against ever persisting an empty/whitespace-only
-- summary as a usable compaction (insertCompaction also rejects this in
-- application code, before this constraint would ever fire) - drop/recreate
-- is idempotent, same pattern as messages_role_check above.
--
-- Added NOT VALID: a validated CHECK scans and rejects the whole table
-- if any existing row already violates it, which would make this
-- migration (and therefore every future startup) fail permanently on a
-- database that already has a legacy blank-summary row. NOT VALID skips
-- that scan and is still enforced for every new INSERT/UPDATE from the
-- moment it's added - Postgres only skips validating rows that predate
-- the constraint. We deliberately never run VALIDATE CONSTRAINT: doing so
-- would fail the same way on a legacy violator, and the point here is to
-- tolerate that row's continued existence, not to force it to be fixed
-- or removed.
ALTER TABLE compactions DROP CONSTRAINT IF EXISTS compactions_summary_not_blank;
ALTER TABLE compactions ADD CONSTRAINT compactions_summary_not_blank CHECK (btrim(summary) <> '') NOT VALID;

-- Phase 1 reliability: durable processing ownership/lease + retry metadata.
-- Nullable/additive - existing rows are unaffected. Only meaningful on
-- role='user' rows (the claimable job rows). worker_id/lease_expires_at
-- identify the current claim owner and when that claim expires if not
-- renewed; attempt_count counts every claim (fresh or reclaimed) so a row
-- that keeps expiring (crash loop) can be capped instead of reclaimed
-- forever; last_error carries the most recent failure reason so a 'failed'
-- row stays diagnosable after an SSE disconnect or full page reload.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS worker_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_processing_lease
  ON messages (lease_expires_at) WHERE status = 'processing';

-- Phase 3 reliability: durable per-step tool execution + idempotent
-- replies. iteration identifies which tool-loop round produced an
-- assistant tool-call-request row (nullable - only meaningful on those
-- rows), so a resumed turn can find the next free iteration number and
-- detect a "dangling" row (request persisted, results missing/partial)
-- left by a crash.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS iteration INTEGER;

-- Idempotency keys, enforced in Postgres rather than trusted to
-- application logic: a resumed worker re-persisting a step it (or a prior
-- attempt) already committed must be a no-op, not a duplicate row.
--
-- One tool result per (turn, tool_call_id) - tool_call_id is the stable id
-- the model itself assigned, so this also protects against a duplicate
-- delivery of the same result from two overlapping executions.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_tool_result_unique
  ON messages (reply_to_message_id, tool_call_id)
  WHERE role = 'tool';

-- One tool-call-request row per (turn, iteration) - re-issuing the same
-- iteration's request (e.g. after a resumed loop recomputes it) can't
-- create a second row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_tool_request_unique
  ON messages (reply_to_message_id, iteration)
  WHERE role = 'assistant' AND tool_calls IS NOT NULL;

-- At most one final-text assistant reply per turn - the load-bearing
-- constraint that makes insertAssistantMessage's upsert safe, and what
-- ultimately prevents a client from ever seeing a duplicated final answer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_final_reply_unique
  ON messages (reply_to_message_id)
  WHERE role = 'assistant' AND tool_calls IS NULL;
`;

export async function initSchema(pool: pg.Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
}

export async function createConversation(
  pool: pg.Pool,
  clientId: string
): Promise<Conversation> {
  const { rows } = await pool.query<Conversation>(
    `INSERT INTO conversations (client_id) VALUES ($1) RETURNING *`,
    [clientId]
  );
  return rows[0];
}

export async function getConversation(
  pool: pg.Pool,
  conversationId: string
): Promise<Conversation | null> {
  const { rows } = await pool.query<Conversation>(
    `SELECT * FROM conversations WHERE id = $1`,
    [conversationId]
  );
  return rows[0] ?? null;
}

/**
 * Lists conversations most-recently-active first. "Active" means the most
 * recent message in the conversation, falling back to the conversation's
 * own created_at when it has no messages yet. The last message's content
 * comes along for free via the lateral join so the sidebar has a snippet
 * without a second round trip per conversation.
 */
export async function listConversations(
  pool: pg.Pool,
  clientId?: string
): Promise<ConversationSummary[]> {
  const { rows } = await pool.query<ConversationSummary>(
    `SELECT
       c.id,
       c.client_id,
       c.created_at,
       COALESCE(m.created_at, c.created_at) AS updated_at,
       m.content AS last_message,
       m.role AS last_message_role
     FROM conversations c
     LEFT JOIN LATERAL (
       SELECT content, role, created_at
       FROM messages
       WHERE messages.conversation_id = c.id AND messages.role != 'tool'
       ORDER BY created_at DESC
       LIMIT 1
     ) m ON true
     WHERE $1::text IS NULL OR c.client_id = $1
     ORDER BY updated_at DESC`,
    [clientId ?? null]
  );
  return rows;
}

export async function insertUserMessage(
  pool: pg.Pool,
  conversationId: string,
  content: string
): Promise<Message> {
  const { rows } = await pool.query<Message>(
    `INSERT INTO messages (conversation_id, role, content, status)
     VALUES ($1, 'user', $2, 'pending')
     RETURNING *`,
    [conversationId, content]
  );
  return rows[0];
}

export async function getMessage(
  pool: pg.Pool,
  messageId: string
): Promise<Message | null> {
  const { rows } = await pool.query<Message>(
    `SELECT * FROM messages WHERE id = $1`,
    [messageId]
  );
  return rows[0] ?? null;
}

/**
 * Returns the final-text assistant reply to a user message - i.e. the
 * assistant row without a `tool_calls` payload, not one of the intermediate
 * tool-call rows a turn may also have produced. There is at most one such
 * row per user message.
 */
export async function getReply(
  pool: pg.Pool,
  userMessageId: string
): Promise<Message | null> {
  const { rows } = await pool.query<Message>(
    `SELECT * FROM messages
     WHERE reply_to_message_id = $1 AND role = 'assistant' AND tool_calls IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [userMessageId]
  );
  return rows[0] ?? null;
}

/**
 * All rows produced in reply to a single user message - the tool-call
 * assistant row(s), their tool result rows, and the final-text assistant
 * row, in created_at order. Used to reconstruct a turn's full tool exchange
 * for the REST tool-detail endpoint.
 */
export async function getMessagesByReplyTo(
  pool: pg.Pool,
  userMessageId: string
): Promise<Message[]> {
  const { rows } = await pool.query<Message>(
    `SELECT * FROM messages WHERE reply_to_message_id = $1 ORDER BY created_at ASC`,
    [userMessageId]
  );
  return rows;
}

export async function getConversationHistory(
  pool: pg.Pool,
  conversationId: string
): Promise<Message[]> {
  const { rows } = await pool.query<Message>(
    `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [conversationId]
  );
  return rows;
}

/**
 * Marks 'processing' rows whose lease has expired AND that have already
 * been claimed maxAttempts times as permanently failed, so
 * claimPendingMessages never reclaims the same crashing row forever. Must
 * run before claimPendingMessages in the same poll cycle. Doesn't itself
 * claim anything (no FOR UPDATE) - safe to call from any number of workers
 * concurrently, each UPDATE just no-ops on rows another worker already
 * flipped to 'failed'.
 */
export async function sweepExhaustedLeases(
  pool: pg.Pool,
  maxAttempts: number
): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE messages
     SET status = 'failed',
         lease_expires_at = NULL,
         last_error = 'gave up after ' || attempt_count || ' attempt(s): worker did not ' ||
                      'complete this turn before its lease expired (likely a crash or restart)'
     WHERE role = 'user'
       AND status = 'processing'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at < now()
       AND attempt_count >= $1`,
    [maxAttempts]
  );
  return rowCount ?? 0;
}

/**
 * Atomically claims pending messages, plus 'processing' messages whose
 * lease expired without the owning worker finishing or renewing it (e.g. it
 * crashed, was killed, or was restarted mid-turn by tsx watch). The
 * UPDATE's WHERE clause is re-evaluated under the row lock, so when two
 * workers race on the same row only one UPDATE affects it and the other
 * gets back nothing - this is what guarantees exactly-once processing
 * across workers, for both fresh claims and reclaims. Call
 * sweepExhaustedLeases first so rows that already exceeded maxAttempts are
 * failed out instead of reclaimed indefinitely.
 */
export async function claimPendingMessages(
  pool: pg.Pool,
  workerId: string,
  leaseDurationMs: number,
  limit = 5
): Promise<Message[]> {
  const { rows } = await pool.query<Message>(
    `UPDATE messages
     SET status = 'processing',
         worker_id = $2,
         lease_expires_at = now() + make_interval(secs => $3::double precision / 1000),
         attempt_count = attempt_count + 1,
         last_error = NULL
     WHERE id IN (
       SELECT id FROM messages
       WHERE role = 'user' AND (
         status = 'pending'
         OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
       )
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [limit, workerId, leaseDurationMs]
  );
  return rows;
}

/**
 * Extends a claimed row's lease so a long-running turn isn't reclaimed out
 * from under the worker still processing it. Guarded by worker_id + status
 * so a worker that stalled past its own lease (and had the row reclaimed by
 * someone else) can't resurrect a claim it no longer owns. Returns false
 * when the guard fails - callers must treat that as "another worker may now
 * own this row" and stop short of persisting results.
 */
export async function renewLease(
  pool: pg.Pool,
  messageId: string,
  workerId: string,
  leaseDurationMs: number
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE messages
     SET lease_expires_at = now() + make_interval(secs => $3::double precision / 1000)
     WHERE id = $1 AND worker_id = $2 AND status = 'processing'`,
    [messageId, workerId, leaseDurationMs]
  );
  return (rowCount ?? 0) > 0;
}

/** Same ownership guard as renewLease, without touching the lease - used as
 * a final check immediately before persisting a turn's results. */
export async function stillOwnsLease(
  pool: pg.Pool,
  messageId: string,
  workerId: string
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM messages WHERE id = $1 AND worker_id = $2 AND status = 'processing'`,
    [messageId, workerId]
  );
  return (rowCount ?? 0) > 0;
}

export async function markMessageDone(
  pool: pg.Pool,
  messageId: string
): Promise<void> {
  await pool.query(
    `UPDATE messages
     SET status = 'done', lease_expires_at = NULL, last_error = NULL
     WHERE id = $1`,
    [messageId]
  );
}

// Defensive cap only - the worker only ever passes err.message here (never
// a raw stack trace or request/response body), so this shouldn't contain
// secrets in practice, but a length cap keeps a pathological error from
// bloating the row regardless.
const MAX_ERROR_LENGTH = 2000;

/**
 * Persists a turn's failure reason so it stays diagnosable after an SSE
 * disconnect or full page reload, instead of existing only as a transient
 * stream event.
 */
export async function markMessageFailed(
  pool: pg.Pool,
  messageId: string,
  errorMessage: string
): Promise<void> {
  await pool.query(
    `UPDATE messages
     SET status = 'failed', lease_expires_at = NULL, last_error = $2
     WHERE id = $1`,
    [messageId, errorMessage.slice(0, MAX_ERROR_LENGTH)]
  );
}

/**
 * Operator recovery path (Phase 1): resets a stuck/failed message back to
 * 'pending' so the normal claim loop picks it up again, clearing its
 * lease/owner but preserving attempt_count and last_error as history. Will
 * not touch a 'processing' row with a live (non-expired) lease, so an
 * operator can't accidentally cause duplicate execution against a worker
 * that's actively working on it. Returns false if the row wasn't in a
 * requeue-eligible state (not found, not a user row, or actively leased).
 */
export async function requeueMessageForRetry(
  pool: pg.Pool,
  messageId: string
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE messages
     SET status = 'pending', worker_id = NULL, lease_expires_at = NULL
     WHERE id = $1
       AND role = 'user'
       AND status IN ('failed', 'processing')
       AND (status != 'processing' OR lease_expires_at IS NULL OR lease_expires_at < now())`,
    [messageId]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Deletes a conversation and all of its messages. Scoped by clientId when
 * provided so a client can't delete a conversation it doesn't own. Returns
 * true if a conversation was actually deleted.
 */
export async function deleteConversation(
  pool: pg.Pool,
  conversationId: string,
  clientId?: string
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Conversation>(
      `SELECT * FROM conversations
       WHERE id = $1 AND ($2::text IS NULL OR client_id = $2)`,
      [conversationId, clientId ?? null]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(`DELETE FROM messages WHERE conversation_id = $1`, [
      conversationId,
    ]);
    await client.query(`DELETE FROM conversations WHERE id = $1`, [
      conversationId,
    ]);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface AssistantMessageUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number | null;
}

/**
 * Idempotent upsert of a turn's final-text reply: if a previous attempt at
 * this turn already committed a final reply row (e.g. the worker crashed
 * between this insert and markMessageDone), the unique
 * idx_messages_final_reply_unique index turns the INSERT into a no-op and
 * the existing row is returned instead - the caller can't ever create a
 * second final reply for the same turn, so a client can't be shown a
 * duplicate answer.
 */
export async function insertAssistantMessage(
  pool: pg.Pool,
  conversationId: string,
  replyToMessageId: string,
  content: string,
  usage: AssistantMessageUsage | null = null
): Promise<Message> {
  const { rows } = await pool.query<Message>(
    `INSERT INTO messages
       (conversation_id, role, content, status, reply_to_message_id, prompt_tokens, completion_tokens, duration_ms)
     VALUES ($1, 'assistant', $2, 'done', $3, $4, $5, $6)
     ON CONFLICT (reply_to_message_id) WHERE role = 'assistant' AND tool_calls IS NULL
     DO NOTHING
     RETURNING *`,
    [
      conversationId,
      content,
      replyToMessageId,
      usage?.promptTokens ?? null,
      usage?.completionTokens ?? null,
      usage?.durationMs ?? null,
    ]
  );
  if (rows[0]) return rows[0];
  const existing = await getReply(pool, replyToMessageId);
  if (!existing) {
    throw new Error(
      `insertAssistantMessage: unique-index conflict but no existing final reply found for turn ${replyToMessageId}`
    );
  }
  return existing;
}

/**
 * Idempotent persist of one LLM round-trip's tool-call request (Phase 3):
 * one assistant row carrying the `tool_calls` JSONB array, tagged with the
 * iteration it belongs to. Must be called BEFORE any of the calls in it are
 * executed - this is the durable record of "the model asked for these
 * tools" that survives a crash between the request and its results.
 * idx_messages_tool_request_unique makes re-persisting the same iteration
 * (e.g. a resumed turn recomputing it) a no-op; returns the existing row in
 * that case.
 */
export async function insertToolCallRequest(
  pool: pg.Pool,
  conversationId: string,
  replyToMessageId: string,
  iteration: number,
  calls: { toolCallId: string; toolName: string; arguments: string }[]
): Promise<Message> {
  const toolCallsJson = JSON.stringify(
    calls.map((c) => ({ id: c.toolCallId, name: c.toolName, arguments: c.arguments }))
  );
  const { rows } = await pool.query<Message>(
    `INSERT INTO messages (conversation_id, role, content, status, reply_to_message_id, tool_calls, iteration)
     VALUES ($1, 'assistant', '', 'done', $2, $3::jsonb, $4)
     ON CONFLICT (reply_to_message_id, iteration) WHERE role = 'assistant' AND tool_calls IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [conversationId, replyToMessageId, toolCallsJson, iteration]
  );
  if (rows[0]) return rows[0];
  const { rows: existingRows } = await pool.query<Message>(
    `SELECT * FROM messages
     WHERE reply_to_message_id = $1 AND iteration = $2 AND role = 'assistant' AND tool_calls IS NOT NULL`,
    [replyToMessageId, iteration]
  );
  return existingRows[0];
}

/**
 * Idempotent persist of a single tool call's result (Phase 3). Call
 * immediately after the tool finishes executing (or immediately after
 * deciding not to execute it, e.g. the finish_reason==='length' truncation
 * case), before the next tool executes or the next LLM call is made.
 * idx_messages_tool_result_unique makes re-persisting the same
 * (turn, tool_call_id) a no-op, so a resumed worker re-running this step
 * can't create a duplicate result row.
 */
export async function insertToolResult(
  pool: pg.Pool,
  conversationId: string,
  replyToMessageId: string,
  record: Pick<ToolExchangeRecord, "toolCallId" | "toolName" | "result" | "isError">
): Promise<Message> {
  const { rows } = await pool.query<Message>(
    `INSERT INTO messages
       (conversation_id, role, content, status, reply_to_message_id, tool_call_id, tool_name, tool_is_error)
     VALUES ($1, 'tool', $2, 'done', $3, $4, $5, $6)
     ON CONFLICT (reply_to_message_id, tool_call_id) WHERE role = 'tool'
     DO NOTHING
     RETURNING *`,
    [conversationId, record.result, replyToMessageId, record.toolCallId, record.toolName, record.isError]
  );
  if (rows[0]) return rows[0];
  const { rows: existingRows } = await pool.query<Message>(
    `SELECT * FROM messages WHERE reply_to_message_id = $1 AND tool_call_id = $2 AND role = 'tool'`,
    [replyToMessageId, record.toolCallId]
  );
  return existingRows[0];
}

export interface InsertCompactionInput {
  id: string;
  conversationId: string;
  summary: string;
  firstKeptMessageId: string;
  /** id of the first row included in the summarized span - the source
   * range's start, paired with firstKeptMessageId as its end/retained
   * boundary (Phase 4). */
  sourceStartMessageId: string;
  /** id of the user-turn row whose processing produced this compaction pass
   * - this turn's identity, and this call's idempotency key (Phase 4). */
  triggeredByMessageId: string;
  tokensBefore: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

/**
 * Durable, idempotent persist of one compaction pass (Phase 4). A single
 * INSERT is already atomic in Postgres - either every column commits
 * together or none do, so there is no explicit BEGIN/COMMIT needed and no
 * window where a partial/corrupt row could be observed by a reader.
 *
 * Rejects an empty/whitespace-only summary before ever reaching the
 * database (compactions_summary_not_blank backs this up at the schema
 * level too) - callers must treat that as a failed compaction, never a
 * usable one, and must not call this at all in that case (see
 * buildCompactedMessages in packages/worker/src/tool-loop.ts, which checks
 * this before calling its onCompaction hook).
 *
 * idx_compactions_triggered_by_unique makes re-persisting the same turn's
 * compaction (e.g. a crash between this insert and the turn otherwise
 * completing, followed by a retry that recomputes the same boundary) a
 * no-op that returns the original row instead of creating a duplicate.
 */
export async function insertCompaction(
  pool: pg.Pool,
  input: InsertCompactionInput
): Promise<Compaction> {
  if (!input.summary || input.summary.trim().length === 0) {
    throw new Error(
      `insertCompaction: refusing to persist an empty/whitespace-only summary ` +
        `(conversation ${input.conversationId}, turn ${input.triggeredByMessageId})`
    );
  }
  const { rows } = await pool.query<Compaction>(
    `INSERT INTO compactions
       (id, conversation_id, summary, first_kept_message_id, source_start_message_id,
        triggered_by_message_id, tokens_before, prompt_tokens, completion_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (triggered_by_message_id) DO NOTHING
     RETURNING *`,
    [
      input.id,
      input.conversationId,
      input.summary,
      input.firstKeptMessageId,
      input.sourceStartMessageId,
      input.triggeredByMessageId,
      input.tokensBefore,
      input.promptTokens,
      input.completionTokens,
    ]
  );
  if (rows[0]) return rows[0];
  const { rows: existingRows } = await pool.query<Compaction>(
    `SELECT * FROM compactions WHERE triggered_by_message_id = $1`,
    [input.triggeredByMessageId]
  );
  if (!existingRows[0]) {
    throw new Error(
      `insertCompaction: unique-index conflict but no existing row found for turn ${input.triggeredByMessageId}`
    );
  }
  return existingRows[0];
}

/**
 * Most recent compaction for a conversation, or null if it has never been
 * compacted. Used by the worker to chain summaries (previousSummary) and
 * find the summarization span's start boundary on the next pass.
 *
 * Excludes blank/whitespace-only summaries: compactions_summary_not_blank
 * is NOT VALID (see schema comment) so a legacy row predating that
 * constraint can still have a blank summary. Feeding that back as
 * previousSummary would hand the model an empty/junk "here's what happened
 * before" block, so it's filtered here even though the row itself is never
 * deleted or rewritten.
 */
export async function getLatestCompaction(
  pool: pg.Pool,
  conversationId: string
): Promise<Compaction | null> {
  const { rows } = await pool.query<Compaction>(
    `SELECT * FROM compactions
     WHERE conversation_id = $1 AND btrim(summary) <> ''
     ORDER BY created_at DESC LIMIT 1`,
    [conversationId]
  );
  return rows[0] ?? null;
}

/**
 * All compactions for a conversation, newest first - what the REST history
 * endpoint surfaces as collapsible "context checkpoint" notes.
 *
 * Excludes blank/whitespace-only summaries for the same reason as
 * getLatestCompaction above: an empty checkpoint note isn't a usable
 * result for the UI. The underlying row is untouched and still visible to
 * direct SQL/audit queries against the compactions table.
 */
export async function getCompactionsForConversation(
  pool: pg.Pool,
  conversationId: string
): Promise<Compaction[]> {
  const { rows } = await pool.query<Compaction>(
    `SELECT * FROM compactions
     WHERE conversation_id = $1 AND btrim(summary) <> ''
     ORDER BY created_at DESC`,
    [conversationId]
  );
  return rows;
}
