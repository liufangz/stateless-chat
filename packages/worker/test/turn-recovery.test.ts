// Phase 3 reliability regression tests: crash-window recovery
// (reconcileTurnState) and the durable per-step idempotency it depends on
// (insertToolCallRequest / insertToolResult / insertAssistantMessage).
//
// Real Postgres, same convention as db-lease.test.ts - point DATABASE_URL at
// a disposable database, NEVER the production `chat` database:
//
//   DATABASE_URL=postgres://chat:chat@localhost:5433/chat_test \
//     npx vitest run packages/worker/test/turn-recovery.test.ts

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
  getMessagesByReplyTo,
  getReply,
} from "@stateless-chat/shared";
import type { Tool } from "../src/tool-loop.js";
import { reconcileTurnState } from "../src/turn-recovery.js";
import { requireDisposableTestDatabase } from "./support/require-test-database.js";

// Refuses to run against anything but an obviously-disposable database -
// this file TRUNCATEs shared tables, and DATABASE_URL defaults to the local
// dev `chat` database (not a real production DB, but still not something a
// test run should ever silently wipe).
requireDisposableTestDatabase(env.databaseUrl);

const pool = createPool();

async function freshTurn(): Promise<{ conversationId: string; userMessageId: string }> {
  const conv = await createConversation(pool, "test-client");
  const msg = await insertUserMessage(pool, conv.id, "hi");
  return { conversationId: conv.id, userMessageId: msg.id };
}

function makeTool(name: string, readOnly: boolean, impl: (args: any) => string = () => "ok"): Tool {
  return {
    name,
    description: "test",
    parameters: { type: "object", properties: {} },
    readOnly,
    execute: impl,
  };
}

beforeAll(async () => {
  await initSchema(pool);
  await pool.query("TRUNCATE messages, conversations RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await pool.end();
});

describe("reconcileTurnState", () => {
  it("a fresh turn with no prior rows is 'ready' at iteration 0", async () => {
    const { conversationId, userMessageId } = await freshTurn();
    const result = await reconcileTurnState(pool, [], conversationId, userMessageId);
    expect(result).toEqual({ kind: "ready", startIteration: 0 });
  });

  it("a turn whose final reply is already durably persisted is 'already-final'", async () => {
    const { conversationId, userMessageId } = await freshTurn();
    await insertAssistantMessage(pool, conversationId, userMessageId, "the answer", {
      promptTokens: 10,
      completionTokens: 5,
      durationMs: 100,
    });

    const result = await reconcileTurnState(pool, [], conversationId, userMessageId);
    expect(result.kind).toBe("already-final");
    if (result.kind === "already-final") {
      expect(result.reply.content).toBe("the answer");
    }
  });

  it("a fully-resolved dangling row (request + all results present) is 'ready' at the next iteration", async () => {
    const { conversationId, userMessageId } = await freshTurn();
    await insertToolCallRequest(pool, conversationId, userMessageId, 0, [
      { toolCallId: "call_1", toolName: "echo", arguments: "{}" },
    ]);
    await insertToolResult(pool, conversationId, userMessageId, {
      toolCallId: "call_1",
      toolName: "echo",
      result: "ok",
      isError: false,
    });

    const result = await reconcileTurnState(pool, [], conversationId, userMessageId);
    expect(result).toEqual({ kind: "ready", startIteration: 1 });
  });

  it("a dangling row with a pending READ-ONLY call is resolved automatically and becomes 'ready'", async () => {
    const { conversationId, userMessageId } = await freshTurn();
    let executed = 0;
    const readOnlyTool = makeTool("get_time", true, () => {
      executed++;
      return "2026-08-28T00:00:00Z";
    });
    await insertToolCallRequest(pool, conversationId, userMessageId, 0, [
      { toolCallId: "call_1", toolName: "get_time", arguments: "{}" },
    ]);

    const result = await reconcileTurnState(pool, [readOnlyTool], conversationId, userMessageId);
    expect(result).toEqual({ kind: "ready", startIteration: 1 });
    expect(executed).toBe(1);

    const rows = await getMessagesByReplyTo(pool, userMessageId);
    const resultRow = rows.find((r) => r.role === "tool" && r.tool_call_id === "call_1");
    expect(resultRow).toBeDefined();
    expect(resultRow!.content).toBe("2026-08-28T00:00:00Z");
    expect(resultRow!.tool_is_error).toBe(false);
  });

  it("a dangling row with a pending MUTATING call is blocked, not executed, and no result is persisted", async () => {
    const { conversationId, userMessageId } = await freshTurn();
    let executed = 0;
    const mutatingTool = makeTool("write_file", false, () => {
      executed++;
      return "wrote file";
    });
    await insertToolCallRequest(pool, conversationId, userMessageId, 0, [
      { toolCallId: "call_1", toolName: "write_file", arguments: '{"path":"/tmp/x"}' },
    ]);

    const result = await reconcileTurnState(pool, [mutatingTool], conversationId, userMessageId);
    expect(result.kind).toBe("blocked-mutation");
    if (result.kind === "blocked-mutation") {
      expect(result.reason).toMatch(/write_file/);
      expect(result.reason).toMatch(/scripts\/resolve-tool-call\.ts/);
    }
    expect(executed).toBe(0);

    const rows = await getMessagesByReplyTo(pool, userMessageId);
    expect(rows.some((r) => r.role === "tool")).toBe(false);
  });

  it("an unknown tool name (not in the registry) defaults to unsafe and is blocked, not executed", async () => {
    const { conversationId, userMessageId } = await freshTurn();
    await insertToolCallRequest(pool, conversationId, userMessageId, 0, [
      { toolCallId: "call_1", toolName: "some_removed_tool", arguments: "{}" },
    ]);

    const result = await reconcileTurnState(pool, [], conversationId, userMessageId);
    expect(result.kind).toBe("blocked-mutation");
  });

  it("mixed pending calls in the same iteration (one read-only, one mutating) block entirely - no partial execution", async () => {
    const { conversationId, userMessageId } = await freshTurn();
    let readOnlyExecuted = 0;
    let mutatingExecuted = 0;
    const readOnlyTool = makeTool("get_time", true, () => {
      readOnlyExecuted++;
      return "now";
    });
    const mutatingTool = makeTool("bash", false, () => {
      mutatingExecuted++;
      return "ran";
    });
    await insertToolCallRequest(pool, conversationId, userMessageId, 0, [
      { toolCallId: "call_1", toolName: "get_time", arguments: "{}" },
      { toolCallId: "call_2", toolName: "bash", arguments: "{}" },
    ]);

    const result = await reconcileTurnState(pool, [readOnlyTool, mutatingTool], conversationId, userMessageId);
    expect(result.kind).toBe("blocked-mutation");
    expect(readOnlyExecuted).toBe(0);
    expect(mutatingExecuted).toBe(0);

    const rows = await getMessagesByReplyTo(pool, userMessageId);
    expect(rows.some((r) => r.role === "tool")).toBe(false);
  });

  it("reconciling the same read-only-pending turn twice does not create a duplicate result row", async () => {
    const { conversationId, userMessageId } = await freshTurn();
    const readOnlyTool = makeTool("get_time", true, () => "t1");
    await insertToolCallRequest(pool, conversationId, userMessageId, 0, [
      { toolCallId: "call_1", toolName: "get_time", arguments: "{}" },
    ]);

    await reconcileTurnState(pool, [readOnlyTool], conversationId, userMessageId);
    // Second reconcile call: the pending call is now resolved, so this
    // should just report 'ready' at the next iteration without touching
    // the tool again.
    const second = await reconcileTurnState(pool, [readOnlyTool], conversationId, userMessageId);
    expect(second).toEqual({ kind: "ready", startIteration: 1 });

    const rows = await getMessagesByReplyTo(pool, userMessageId);
    const resultRows = rows.filter((r) => r.role === "tool" && r.tool_call_id === "call_1");
    expect(resultRows).toHaveLength(1);
  });
});

describe("idempotent persistence primitives", () => {
  it("insertToolCallRequest: a duplicate insert for the same (turn, iteration) is a no-op, not a second row", async () => {
    const { conversationId, userMessageId } = await freshTurn();
    const first = await insertToolCallRequest(pool, conversationId, userMessageId, 0, [
      { toolCallId: "call_1", toolName: "echo", arguments: "{}" },
    ]);
    const second = await insertToolCallRequest(pool, conversationId, userMessageId, 0, [
      { toolCallId: "call_1", toolName: "echo", arguments: "{}" },
    ]);
    expect(second.id).toBe(first.id);

    const rows = await getMessagesByReplyTo(pool, userMessageId);
    const requestRows = rows.filter((r) => r.role === "assistant" && r.tool_calls && r.tool_calls.length > 0);
    expect(requestRows).toHaveLength(1);
  });

  it("insertToolResult: a duplicate insert for the same (turn, tool_call_id) is a no-op, not a second row", async () => {
    const { conversationId, userMessageId } = await freshTurn();
    const first = await insertToolResult(pool, conversationId, userMessageId, {
      toolCallId: "call_1",
      toolName: "echo",
      result: "first result",
      isError: false,
    });
    const second = await insertToolResult(pool, conversationId, userMessageId, {
      toolCallId: "call_1",
      toolName: "echo",
      result: "different result - should be ignored",
      isError: true,
    });
    expect(second.id).toBe(first.id);
    expect(second.content).toBe("first result");

    const rows = await getMessagesByReplyTo(pool, userMessageId);
    const resultRows = rows.filter((r) => r.role === "tool" && r.tool_call_id === "call_1");
    expect(resultRows).toHaveLength(1);
  });

  it("insertAssistantMessage: a duplicate final reply for the same turn is a no-op, returns the original", async () => {
    const { conversationId, userMessageId } = await freshTurn();
    const first = await insertAssistantMessage(pool, conversationId, userMessageId, "answer A", null);
    const second = await insertAssistantMessage(pool, conversationId, userMessageId, "answer B - should be ignored", null);
    expect(second.id).toBe(first.id);
    expect(second.content).toBe("answer A");

    const reply = await getReply(pool, userMessageId);
    expect(reply!.content).toBe("answer A");
  });

  it("concurrent duplicate tool-call-request inserts for the same iteration never produce two rows", async () => {
    const { conversationId, userMessageId } = await freshTurn();
    const calls = [{ toolCallId: "call_1", toolName: "echo", arguments: "{}" }];
    const [a, b] = await Promise.all([
      insertToolCallRequest(pool, conversationId, userMessageId, 0, calls),
      insertToolCallRequest(pool, conversationId, userMessageId, 0, calls),
    ]);
    expect(a.id).toBe(b.id);

    const rows = await getMessagesByReplyTo(pool, userMessageId);
    const requestRows = rows.filter((r) => r.role === "assistant" && r.tool_calls && r.tool_calls.length > 0);
    expect(requestRows).toHaveLength(1);
  });

  it("concurrent duplicate final-reply inserts for the same turn never produce two rows", async () => {
    const { conversationId, userMessageId } = await freshTurn();
    const [a, b] = await Promise.all([
      insertAssistantMessage(pool, conversationId, userMessageId, "race A", null),
      insertAssistantMessage(pool, conversationId, userMessageId, "race B", null),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.content).toBe(b.content);

    const rows = await getMessagesByReplyTo(pool, userMessageId);
    const finalRows = rows.filter((r) => r.role === "assistant" && (!r.tool_calls || r.tool_calls.length === 0));
    expect(finalRows).toHaveLength(1);
  });
});
