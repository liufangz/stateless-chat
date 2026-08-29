// Phase 3 reliability: end-to-end crash-recovery simulation against real
// Postgres. This wires runToolLoop + reconcileTurnState + the db.ts
// persistence primitives together the same way packages/worker/src/index.ts
// does, and injects a controlled failure to simulate a worker process dying
// mid-turn - then starts a fresh "attempt" against the same durable state
// and asserts it continues from the last committed step instead of
// re-running the turn from scratch.
//
//   DATABASE_URL=postgres://chat:chat@localhost:5433/chat_test \
//     npx vitest run packages/worker/test/crash-recovery.e2e.test.ts

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
  getConversationHistory,
  getMessagesByReplyTo,
} from "@stateless-chat/shared";
import { runToolLoop } from "../src/tool-loop.js";
import type { Tool, ToolLoopPersistence } from "../src/tool-loop.js";
import { reconcileTurnState } from "../src/turn-recovery.js";
import { requireDisposableTestDatabase } from "./support/require-test-database.js";

// See turn-recovery.test.ts for why this guard exists - this file also
// TRUNCATEs shared tables in beforeAll.
requireDisposableTestDatabase(env.databaseUrl);

const pool = createPool();

async function freshTurn(): Promise<{ conversationId: string; userMessageId: string }> {
  const conv = await createConversation(pool, "test-client");
  const msg = await insertUserMessage(pool, conv.id, "what tool-derived fact do you have?");
  return { conversationId: conv.id, userMessageId: msg.id };
}

function realPersistence(conversationId: string, userMessageId: string): ToolLoopPersistence {
  return {
    onToolCallRequest: async (iteration, calls) => {
      await insertToolCallRequest(pool, conversationId, userMessageId, iteration, calls);
    },
    onToolResult: async (record) => {
      await insertToolResult(pool, conversationId, userMessageId, record);
    },
  };
}

// --- Fake OpenAI-compatible streaming client, single tool call then a
// final text answer.

function chunkToolCall(id: string, name: string, args: string) {
  return {
    choices: [
      { delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] }, finish_reason: null },
    ],
  };
}
function chunkFinish(reason: string) {
  return { choices: [{ delta: {}, finish_reason: reason }] };
}
function chunkText(content: string) {
  return { choices: [{ delta: { content } }] };
}

async function* toolCallThenStopStream(id: string, name: string, args: string) {
  yield chunkToolCall(id, name, args);
  yield chunkFinish("tool_calls");
}
async function* finalAnswerStream(text: string) {
  yield chunkText(text);
  yield chunkFinish("stop");
}

function clientForFirstCallOnly(id: string, name: string, args: string) {
  return {
    chat: {
      completions: {
        create: async () => toolCallThenStopStream(id, name, args),
      },
    },
  };
}
function clientForFinalAnswer(text: string) {
  return {
    chat: {
      completions: {
        create: async () => finalAnswerStream(text),
      },
    },
  };
}

beforeAll(async () => {
  await initSchema(pool);
  await pool.query("TRUNCATE messages, conversations RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await pool.end();
});

describe("crash window: after tool execution, before result commit", () => {
  it("read-only tool: attempt 1 crashes mid-turn; attempt 2 resumes, re-runs only the dangling call, and completes", async () => {
    const { conversationId, userMessageId } = await freshTurn();
    let executions = 0;
    const getTime: Tool = {
      name: "get_current_datetime",
      description: "test",
      parameters: { type: "object", properties: {} },
      readOnly: true,
      execute: () => {
        executions++;
        return "2026-08-28T00:00:00Z";
      },
    };

    // --- Attempt 1: worker "dies" right after the tool executes, before its
    // result is durably persisted. onToolCallRequest uses the real db
    // function (so the request row IS committed); onToolResult simulates the
    // crash by throwing instead of calling insertToolResult.
    const crashingPersistence: ToolLoopPersistence = {
      onToolCallRequest: async (iteration, calls) => {
        await insertToolCallRequest(pool, conversationId, userMessageId, iteration, calls);
      },
      onToolResult: async () => {
        throw new Error("simulated crash: process died before the tool result was committed");
      },
    };

    const history1 = await getConversationHistory(pool, conversationId);
    await expect(
      runToolLoop(history1, () => {}, undefined, {
        client: clientForFirstCallOnly("call_1", "get_current_datetime", "{}") as any,
        tools: [getTime],
        persistence: crashingPersistence,
      })
    ).rejects.toThrow(/simulated crash/);

    expect(executions).toBe(1); // the tool DID run before the crash
    const rowsAfterCrash = await getMessagesByReplyTo(pool, userMessageId);
    expect(rowsAfterCrash.some((r) => r.role === "assistant" && r.tool_calls?.length)).toBe(true);
    expect(rowsAfterCrash.some((r) => r.role === "tool")).toBe(false); // no result committed

    // --- Attempt 2: a "replacement worker" claims the same row and
    // reconciles durable state before touching the LLM at all.
    const reconciled = await reconcileTurnState(pool, [getTime], conversationId, userMessageId);
    expect(reconciled.kind).toBe("ready");
    expect(executions).toBe(2); // re-run exactly once more (read-only tool, safe to retry)

    if (reconciled.kind !== "ready") throw new Error("unreachable");
    const history2 = await getConversationHistory(pool, conversationId);
    // History already contains the resolved exchange - no dangling tool_calls.
    const toolCallRow = history2.find((r) => r.role === "assistant" && r.tool_calls?.length);
    const toolResultRow = history2.find((r) => r.role === "tool");
    expect(toolCallRow).toBeDefined();
    expect(toolResultRow).toBeDefined();
    expect(toolResultRow!.tool_call_id).toBe(toolCallRow!.tool_calls![0].id);

    const { content } = await runToolLoop(history2, () => {}, undefined, {
      client: clientForFinalAnswer("It's 2026-08-28.") as any,
      tools: [getTime],
      startIteration: reconciled.startIteration,
      persistence: realPersistence(conversationId, userMessageId),
    });
    expect(content).toBe("It's 2026-08-28.");
    expect(executions).toBe(2); // final answer required no further tool calls

    const reply = await insertAssistantMessage(pool, conversationId, userMessageId, content, null);
    expect(reply.content).toBe("It's 2026-08-28.");

    // Turn is now fully resolved - a third reconcile call finds nothing left to do.
    const finalReconcile = await reconcileTurnState(pool, [getTime], conversationId, userMessageId);
    expect(finalReconcile.kind).toBe("already-final");
  });

  it("mutating tool: attempt 1 crashes mid-turn; attempt 2 refuses to auto-retry, and only completes after manual resolution", async () => {
    const { conversationId, userMessageId } = await freshTurn();
    let executions = 0;
    const writeFile: Tool = {
      name: "write_file",
      description: "test",
      parameters: { type: "object", properties: {} },
      // readOnly intentionally omitted - mutating tools must default to unsafe.
      execute: () => {
        executions++;
        return "wrote /tmp/example.txt";
      },
    };

    const crashingPersistence: ToolLoopPersistence = {
      onToolCallRequest: async (iteration, calls) => {
        await insertToolCallRequest(pool, conversationId, userMessageId, iteration, calls);
      },
      onToolResult: async () => {
        throw new Error("simulated crash: process died before the tool result was committed");
      },
    };

    const history1 = await getConversationHistory(pool, conversationId);
    await expect(
      runToolLoop(history1, () => {}, undefined, {
        client: clientForFirstCallOnly("call_1", "write_file", '{"path":"/tmp/example.txt"}') as any,
        tools: [writeFile],
        persistence: crashingPersistence,
      })
    ).rejects.toThrow(/simulated crash/);

    expect(executions).toBe(1); // the (real, side-effecting) write DID run before the crash

    // --- Attempt 2: reconciliation must NOT guess - it blocks instead of
    // silently retrying (which could duplicate the write) or silently
    // skipping (which could hide that the write already happened).
    const reconciled = await reconcileTurnState(pool, [writeFile], conversationId, userMessageId);
    expect(reconciled.kind).toBe("blocked-mutation");
    expect(executions).toBe(1); // NOT retried automatically

    // Reconciling again changes nothing - this is a stable, not a transient, state.
    const reconciledAgain = await reconcileTurnState(pool, [writeFile], conversationId, userMessageId);
    expect(reconciledAgain.kind).toBe("blocked-mutation");
    expect(executions).toBe(1);

    // --- Operator manually verifies the write actually happened (this is
    // what scripts/resolve-tool-call.ts automates) and records the real
    // outcome.
    await insertToolResult(pool, conversationId, userMessageId, {
      toolCallId: "call_1",
      toolName: "write_file",
      result: "operator-verified: file was written successfully",
      isError: false,
    });

    const afterManualFix = await reconcileTurnState(pool, [writeFile], conversationId, userMessageId);
    expect(afterManualFix.kind).toBe("ready");
    if (afterManualFix.kind !== "ready") throw new Error("unreachable");

    const history2 = await getConversationHistory(pool, conversationId);
    const { content } = await runToolLoop(history2, () => {}, undefined, {
      client: clientForFinalAnswer("Done - file written.") as any,
      tools: [writeFile],
      startIteration: afterManualFix.startIteration,
      persistence: realPersistence(conversationId, userMessageId),
    });
    expect(content).toBe("Done - file written.");
    expect(executions).toBe(1); // still exactly once, ever
  });
});
