import pg from "pg";
import { env } from "./env.js";
import type { Conversation, ConversationSummary, Message } from "./types.js";

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
       WHERE messages.conversation_id = c.id
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

export async function getReply(
  pool: pg.Pool,
  userMessageId: string
): Promise<Message | null> {
  const { rows } = await pool.query<Message>(
    `SELECT * FROM messages WHERE reply_to_message_id = $1 AND role = 'assistant'`,
    [userMessageId]
  );
  return rows[0] ?? null;
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

export async function insertAssistantMessage(
  pool: pg.Pool,
  conversationId: string,
  replyToMessageId: string,
  content: string
): Promise<Message> {
  const { rows } = await pool.query<Message>(
    `INSERT INTO messages (conversation_id, role, content, status, reply_to_message_id)
     VALUES ($1, 'assistant', $2, 'done', $3)
     RETURNING *`,
    [conversationId, content, replyToMessageId]
  );
  return rows[0];
}
