// Phase 4 durable compaction regression tests: transactional/idempotent
// persistence, empty-summary rejection, source-boundary metadata, and raw
// message preservation.
//
// Exercises real Postgres (the compactions_summary_not_blank CHECK
// constraint and idx_compactions_triggered_by_unique unique index in
// packages/shared/src/db.ts) - a mock can't meaningfully stand in for those
// database-level guarantees. Point DATABASE_URL at a disposable database,
// NEVER the production `chat` database:
//
//   DATABASE_URL=postgres://chat:chat@localhost:5433/chat_test \
//     npx vitest run packages/worker/test/compaction-persistence.test.ts
//
// (see repo root: `docker exec stateless-chat-postgres psql -U chat -d chat
// -c "CREATE DATABASE chat_test;"` to create it once.)
//
// This file TRUNCATEs shared tables in beforeAll, so it refuses to run
// against anything but an obviously-disposable database - see
// test/support/require-test-database.ts.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  env,
  createPool,
  initSchema,
  createConversation,
  insertUserMessage,
  insertAssistantMessage,
  insertToolCallRequest,
  insertToolResult,
  insertCompaction,
  getLatestCompaction,
  getCompactionsForConversation,
  getConversationHistory,
} from "@stateless-chat/shared";
import { requireDisposableTestDatabase } from "./support/require-test-database.js";

requireDisposableTestDatabase(env.databaseUrl);

const pool = createPool();

async function freshConversation(): Promise<string> {
  const conv = await createConversation(pool, "test-client");
  return conv.id;
}

beforeAll(async () => {
  await initSchema(pool);
  await pool.query("TRUNCATE messages, conversations, compactions RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await pool.end();
});

async function compactionCount(conversationId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM compactions WHERE conversation_id = $1",
    [conversationId]
  );
  return Number(rows[0].count);
}

describe("insertCompaction: empty/whitespace summary rejection", () => {
  it("rejects an empty-string summary before touching the database", async () => {
    const conversationId = await freshConversation();
    const userMsg = await insertUserMessage(pool, conversationId, "hi");

    await expect(
      insertCompaction(pool, {
        id: randomUUID(),
        conversationId,
        triggeredByMessageId: userMsg.id,
        summary: "",
        firstKeptMessageId: userMsg.id,
        sourceStartMessageId: userMsg.id,
        tokensBefore: 100,
        promptTokens: 10,
        completionTokens: 5,
      })
    ).rejects.toThrow(/empty\/whitespace-only summary/);

    expect(await compactionCount(conversationId)).toBe(0);
  });

  it("rejects a whitespace-only summary the same way", async () => {
    const conversationId = await freshConversation();
    const userMsg = await insertUserMessage(pool, conversationId, "hi");

    await expect(
      insertCompaction(pool, {
        id: randomUUID(),
        conversationId,
        triggeredByMessageId: userMsg.id,
        summary: "   \n\t  ",
        firstKeptMessageId: userMsg.id,
        sourceStartMessageId: userMsg.id,
        tokensBefore: 100,
        promptTokens: 10,
        completionTokens: 5,
      })
    ).rejects.toThrow(/empty\/whitespace-only summary/);

    expect(await compactionCount(conversationId)).toBe(0);
  });

  it("the DB-level CHECK constraint independently rejects a blank summary inserted directly", async () => {
    const conversationId = await freshConversation();
    const userMsg = await insertUserMessage(pool, conversationId, "hi");

    await expect(
      pool.query(
        `INSERT INTO compactions
           (id, conversation_id, summary, first_kept_message_id, source_start_message_id,
            triggered_by_message_id, tokens_before, prompt_tokens, completion_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [randomUUID(), conversationId, "   ", userMsg.id, userMsg.id, userMsg.id, 100, 10, 5]
      )
    ).rejects.toThrow();

    expect(await compactionCount(conversationId)).toBe(0);
  });

  it("a rejected insert leaves no lingering state that blocks a subsequent valid compaction for the same turn", async () => {
    const conversationId = await freshConversation();
    const userMsg = await insertUserMessage(pool, conversationId, "hi");

    await expect(
      insertCompaction(pool, {
        id: randomUUID(),
        conversationId,
        triggeredByMessageId: userMsg.id,
        summary: "",
        firstKeptMessageId: userMsg.id,
        sourceStartMessageId: userMsg.id,
        tokensBefore: 100,
        promptTokens: 10,
        completionTokens: 5,
      })
    ).rejects.toThrow();

    const committed = await insertCompaction(pool, {
      id: randomUUID(),
      conversationId,
      triggeredByMessageId: userMsg.id,
      summary: "a real summary",
      firstKeptMessageId: userMsg.id,
      sourceStartMessageId: userMsg.id,
      tokensBefore: 100,
      promptTokens: 10,
      completionTokens: 5,
    });

    expect(committed.summary).toBe("a real summary");
    expect(await compactionCount(conversationId)).toBe(1);
  });
});

describe("insertCompaction: idempotency by triggering turn", () => {
  it("a retried insert for the same turn returns the original row instead of creating a duplicate", async () => {
    const conversationId = await freshConversation();
    const userMsg = await insertUserMessage(pool, conversationId, "hi");

    const first = await insertCompaction(pool, {
      id: randomUUID(),
      conversationId,
      triggeredByMessageId: userMsg.id,
      summary: "first attempt summary",
      firstKeptMessageId: userMsg.id,
      sourceStartMessageId: userMsg.id,
      tokensBefore: 100,
      promptTokens: 10,
      completionTokens: 5,
    });

    // Simulate a crash-and-retry of the same turn: a fresh random id (as
    // index.ts's onCompaction closure generates), same triggeredByMessageId.
    const retried = await insertCompaction(pool, {
      id: randomUUID(),
      conversationId,
      triggeredByMessageId: userMsg.id,
      summary: "retried attempt summary",
      firstKeptMessageId: userMsg.id,
      sourceStartMessageId: userMsg.id,
      tokensBefore: 100,
      promptTokens: 10,
      completionTokens: 5,
    });

    expect(retried.id).toBe(first.id);
    expect(retried.summary).toBe("first attempt summary"); // original wins, not silently overwritten
    expect(await compactionCount(conversationId)).toBe(1);
  });

  it("different turns in the same conversation each get their own compaction row", async () => {
    const conversationId = await freshConversation();
    const userMsg1 = await insertUserMessage(pool, conversationId, "first");
    const userMsg2 = await insertUserMessage(pool, conversationId, "second");

    await insertCompaction(pool, {
      id: randomUUID(),
      conversationId,
      triggeredByMessageId: userMsg1.id,
      summary: "summary 1",
      firstKeptMessageId: userMsg1.id,
      sourceStartMessageId: userMsg1.id,
      tokensBefore: 100,
      promptTokens: 10,
      completionTokens: 5,
    });
    await insertCompaction(pool, {
      id: randomUUID(),
      conversationId,
      triggeredByMessageId: userMsg2.id,
      summary: "summary 2",
      firstKeptMessageId: userMsg2.id,
      sourceStartMessageId: userMsg1.id,
      tokensBefore: 200,
      promptTokens: 20,
      completionTokens: 8,
    });

    expect(await compactionCount(conversationId)).toBe(2);
  });
});

describe("insertCompaction: source-boundary metadata", () => {
  it("persists and returns the exact source span + turn identity", async () => {
    const conversationId = await freshConversation();
    const spanStart = await insertUserMessage(pool, conversationId, "span start");
    const triggeringTurn = await insertUserMessage(pool, conversationId, "current turn");

    const inserted = await insertCompaction(pool, {
      id: randomUUID(),
      conversationId,
      triggeredByMessageId: triggeringTurn.id,
      summary: "structured summary",
      firstKeptMessageId: triggeringTurn.id,
      sourceStartMessageId: spanStart.id,
      tokensBefore: 4321,
      promptTokens: 123,
      completionTokens: 45,
    });

    expect(inserted.source_start_message_id).toBe(spanStart.id);
    expect(inserted.first_kept_message_id).toBe(triggeringTurn.id);
    expect(inserted.triggered_by_message_id).toBe(triggeringTurn.id);
    expect(inserted.tokens_before).toBe(4321);
    expect(inserted.created_at).toBeTruthy();

    const latest = await getLatestCompaction(pool, conversationId);
    expect(latest).toMatchObject({
      source_start_message_id: spanStart.id,
      first_kept_message_id: triggeringTurn.id,
      triggered_by_message_id: triggeringTurn.id,
    });

    const all = await getCompactionsForConversation(pool, conversationId);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(inserted.id);
  });
});

describe("compaction preserves raw message history", () => {
  it("original messages (including tool calls/results) survive a compaction untouched", async () => {
    const conversationId = await freshConversation();
    const userMsg = await insertUserMessage(pool, conversationId, "do the thing");
    const toolRequest = await insertToolCallRequest(pool, conversationId, userMsg.id, 0, [
      { toolCallId: "call_1", toolName: "echo", arguments: '{"x":1}' },
    ]);
    const toolResult = await insertToolResult(pool, conversationId, userMsg.id, {
      toolCallId: "call_1",
      toolName: "echo",
      result: "echoed",
      isError: false,
    });
    const reply = await insertAssistantMessage(pool, conversationId, userMsg.id, "final answer", null);

    await insertCompaction(pool, {
      id: randomUUID(),
      conversationId,
      triggeredByMessageId: userMsg.id,
      summary: "a summary of the above",
      firstKeptMessageId: userMsg.id,
      sourceStartMessageId: userMsg.id,
      tokensBefore: 500,
      promptTokens: 50,
      completionTokens: 20,
    });

    const history = await getConversationHistory(pool, conversationId);
    const ids = history.map((r) => r.id);
    expect(ids).toContain(userMsg.id);
    expect(ids).toContain(toolRequest.id);
    expect(ids).toContain(toolResult.id);
    expect(ids).toContain(reply.id);
    expect(history).toHaveLength(4);

    const persistedToolRequest = history.find((r) => r.id === toolRequest.id)!;
    expect(persistedToolRequest.tool_calls).toEqual([
      { id: "call_1", name: "echo", arguments: '{"x":1}' },
    ]);
    const persistedToolResult = history.find((r) => r.id === toolResult.id)!;
    expect(persistedToolResult.content).toBe("echoed");
    expect(persistedToolResult.tool_call_id).toBe("call_1");
    const persistedReply = history.find((r) => r.id === reply.id)!;
    expect(persistedReply.content).toBe("final answer");
  });
});
