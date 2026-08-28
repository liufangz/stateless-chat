import pg from "pg";
import { env } from "./env.js";
import type {
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
 * Atomically claims one pending user message for processing. The UPDATE's
 * WHERE clause is re-evaluated under the row lock, so when two workers race
 * on the same row only one UPDATE affects a row and the other gets back
 * null - this is what guarantees exactly-once processing across workers.
 */
export async function claimPendingMessages(
  pool: pg.Pool,
  limit = 5
): Promise<Message[]> {
  const { rows } = await pool.query<Message>(
    `UPDATE messages
     SET status = 'processing'
     WHERE id IN (
       SELECT id FROM messages
       WHERE status = 'pending' AND role = 'user'
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [limit]
  );
  return rows;
}

export async function markMessageStatus(
  pool: pg.Pool,
  messageId: string,
  status: Message["status"]
): Promise<void> {
  await pool.query(`UPDATE messages SET status = $2 WHERE id = $1`, [
    messageId,
    status,
  ]);
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
  return rows[0];
}

/**
 * Persists one turn's tool exchange: for each LLM round-trip that issued
 * tool calls (grouped by `iteration`), one assistant row carrying the
 * `tool_calls` JSONB array, immediately followed by one 'tool' row per call
 * result. Rows are inserted sequentially (iteration order, then call order
 * within an iteration) so `created_at` matches execution order - this is
 * what keeps getConversationHistory's turn-boundary slicing correct.
 * Call this before insertAssistantMessage's final-text row for the same
 * turn, so persisted order is: tool-call exchange rows, then final text.
 */
export async function insertToolExchange(
  pool: pg.Pool,
  conversationId: string,
  replyToMessageId: string,
  toolExchange: ToolExchangeRecord[]
): Promise<void> {
  const byIteration = new Map<number, ToolExchangeRecord[]>();
  for (const record of toolExchange) {
    const group = byIteration.get(record.iteration);
    if (group) {
      group.push(record);
    } else {
      byIteration.set(record.iteration, [record]);
    }
  }

  const iterations = Array.from(byIteration.keys()).sort((a, b) => a - b);
  for (const iteration of iterations) {
    const records = byIteration.get(iteration)!;
    const toolCallsJson = JSON.stringify(
      records.map((r) => ({ id: r.toolCallId, name: r.toolName, arguments: r.arguments }))
    );
    await pool.query(
      `INSERT INTO messages (conversation_id, role, content, status, reply_to_message_id, tool_calls)
       VALUES ($1, 'assistant', '', 'done', $2, $3::jsonb)`,
      [conversationId, replyToMessageId, toolCallsJson]
    );
    for (const record of records) {
      await pool.query(
        `INSERT INTO messages
           (conversation_id, role, content, status, reply_to_message_id, tool_call_id, tool_name, tool_is_error)
         VALUES ($1, 'tool', $2, 'done', $3, $4, $5, $6)`,
        [
          conversationId,
          record.result,
          replyToMessageId,
          record.toolCallId,
          record.toolName,
          record.isError,
        ]
      );
    }
  }
}
