import { describe, it, expect } from "vitest";
import type { Message } from "@stateless-chat/shared";
import { groupMessagesForClient } from "../src/group-history.js";

// ---------------------------------------------------------------------------
// Row helpers (mirrors packages/worker/test/compaction.test.ts's pattern)
// ---------------------------------------------------------------------------

let rowSeq = 0;
function rowBase(role: Message["role"]): Pick<
  Message,
  "id" | "conversation_id" | "role" | "status" | "reply_to_message_id" | "created_at"
> {
  const s = rowSeq++;
  return {
    id: `${role}-${s}`,
    conversation_id: "conv-1",
    role,
    status: "done",
    reply_to_message_id: null,
    created_at: new Date(s * 1000).toISOString(),
  };
}

function userRow(content: string): Message {
  return { ...rowBase("user"), content };
}
function toolCallAssistantRow(callId: string, toolName: string, args = "{}"): Message {
  return { ...rowBase("assistant"), content: "", tool_calls: [{ id: callId, name: toolName, arguments: args }] };
}
function toolResultRow(callId: string, toolName: string, content: string): Message {
  return { ...rowBase("tool"), content, tool_call_id: callId, tool_name: toolName };
}

/** A turn's final text assistant row, as insertAssistantMessage persists it. */
function assistantReplyRow(
  content: string,
  usage: {
    prompt_tokens: number | null;
    completion_tokens: number | null;
    duration_ms: number | null;
    context_tokens?: number | null;
  } | null
): Message {
  return {
    ...rowBase("assistant"),
    content,
    prompt_tokens: usage?.prompt_tokens ?? null,
    completion_tokens: usage?.completion_tokens ?? null,
    duration_ms: usage?.duration_ms ?? null,
    context_tokens: usage?.context_tokens ?? null,
  };
}

describe("groupMessagesForClient: context occupation (usage.contextTokens)", () => {
  it("historical conversation: a reply persisted with context_tokens surfaces it verbatim", () => {
    rowSeq = 0;
    const rows = [
      userRow("hi"),
      assistantReplyRow("hello", {
        prompt_tokens: 500,
        completion_tokens: 20,
        duration_ms: 1000,
        context_tokens: 120,
      }),
    ];

    const [, reply] = groupMessagesForClient(rows);
    expect(reply.usage?.contextTokens).toBe(120);
    // The cumulative fields stay available (backend correctness / avg speed)
    // but are distinct from contextTokens - never the same value here.
    expect(reply.usage?.promptTokens).toBe(500);
    expect(reply.usage?.contextTokens).not.toBe(reply.usage?.promptTokens);
  });

  it("a tool-heavy turn's cumulative prompt_tokens is not reported as context occupation when context_tokens is present", () => {
    rowSeq = 0;
    // Simulates a turn whose tool loop made many round-trips: cumulative
    // prompt_tokens (12000) vastly exceeds what the last call actually sent
    // (context_tokens: 900).
    const rows = [
      userRow("do a lot of tool calls"),
      assistantReplyRow("done", {
        prompt_tokens: 12000,
        completion_tokens: 300,
        duration_ms: 5000,
        context_tokens: 900,
      }),
    ];

    const [, reply] = groupMessagesForClient(rows);
    expect(reply.usage?.contextTokens).toBe(900);
    expect(reply.usage?.contextTokens).toBeLessThan(reply.usage!.promptTokens);
  });

  it("legacy row predating context_tokens: estimates from the actual retained history, NEVER the cumulative prompt_tokens", () => {
    rowSeq = 0;
    const rows = [
      userRow("hi"),
      assistantReplyRow("hello", {
        prompt_tokens: 300,
        completion_tokens: 15,
        duration_ms: 800,
        // context_tokens omitted entirely, as on a pre-migration row.
      }),
    ];

    const [, reply] = groupMessagesForClient(rows);
    // The estimate (system prompt + the "hi" exchange) must reflect actual
    // content, not the legacy cumulative prompt_tokens figure.
    expect(reply.usage?.contextTokens).not.toBe(300);
    expect(reply.usage?.contextTokens).toBeGreaterThan(0);
    expect(reply.usage?.contextTokens).toBeLessThan(200);
  });

  // Regression test: reproduces the reported bug for conversation
  // e3f06c8e-3d9b-49f3-8ae0-8803e1aa5677, whose latest persisted
  // prompt_tokens is 190647 (the SUM of every tool-loop round-trip that
  // turn made) with context_tokens NULL (a legacy row predating that
  // column). The UI must never show 190647 as context occupation.
  it("legacy tool-heavy row: the huge cumulative prompt-token sum is never reported as context occupation", () => {
    rowSeq = 0;
    const rows = [
      userRow("do a big multi-step task"),
      toolCallAssistantRow("call_1", "search", '{"q":"x"}'),
      toolResultRow("call_1", "search", "short result 1"),
      toolCallAssistantRow("call_2", "search", '{"q":"y"}'),
      toolResultRow("call_2", "search", "short result 2"),
      assistantReplyRow("final answer", {
        // Mirrors the real bug report: a tool-heavy turn's cumulative
        // prompt_tokens sum across many round-trips, vastly larger than
        // what the actual (short) retained conversation would estimate to.
        prompt_tokens: 190647,
        completion_tokens: 42,
        duration_ms: 12000,
        // context_tokens omitted - this row predates that column.
      }),
    ];

    // Tool-result rows are consumed into their preceding tool-call
    // assistant row's summaries (see groupMessagesForClient's doc comment),
    // so the final reply is the last element, not a fixed index.
    const clientMessages = groupMessagesForClient(rows);
    const reply = clientMessages[clientMessages.length - 1];
    expect(reply.usage?.contextTokens).not.toBe(190647);
    expect(reply.usage?.contextTokens).not.toBe(reply.usage?.promptTokens);
    // The actual retained history here is a handful of short messages -
    // bounded well under the huge cumulative figure.
    expect(reply.usage?.contextTokens).toBeGreaterThan(0);
    expect(reply.usage?.contextTokens).toBeLessThan(1000);
  });

  it("a row with no usage at all reports no context occupation", () => {
    rowSeq = 0;
    const rows = [userRow("hi"), assistantReplyRow("hello", null)];

    const [, reply] = groupMessagesForClient(rows);
    expect(reply.usage).toBeNull();
  });

  it("no ClientMessage carries the raw context_tokens DB column - only the mapped usage.contextTokens", () => {
    rowSeq = 0;
    const rows = [
      userRow("hi"),
      assistantReplyRow("hello", {
        prompt_tokens: 500,
        completion_tokens: 20,
        duration_ms: 1000,
        context_tokens: 120,
      }),
    ];

    const client = groupMessagesForClient(rows);
    for (const m of client) {
      expect(m as unknown as Record<string, unknown>).not.toHaveProperty("context_tokens");
    }
  });
});
