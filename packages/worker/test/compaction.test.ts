import { describe, it, expect, vi } from "vitest";
import type { Message } from "@stateless-chat/shared";
import { runToolLoop, rowToChatMessage, HISTORY_LIMIT, sliceHistoryAtTurnBoundaries } from "../src/tool-loop.js";
import {
  estimateTokens,
  estimateMessagesTokens,
  findTurnCutPoint,
  findAssistantCutPoint,
  findLastUserIndex,
  applyCompaction,
} from "../src/compaction.js";

// ---------------------------------------------------------------------------
// Row helpers (mirrors packages/worker/test/tool-loop.test.ts's pattern)
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
function assistantTextRow(content: string): Message {
  return { ...rowBase("assistant"), content };
}
function toolCallAssistantRow(callId: string, toolName: string, args = "{}"): Message {
  return { ...rowBase("assistant"), content: "", tool_calls: [{ id: callId, name: toolName, arguments: args }] };
}
function toolResultRow(callId: string, toolName: string, content: string): Message {
  return { ...rowBase("tool"), content, tool_call_id: callId, tool_name: toolName };
}
function fullTextTurn(i: number, pad = 0): Message[] {
  const padding = pad > 0 ? " " + "x".repeat(pad) : "";
  return [userRow(`question ${i}${padding}`), assistantTextRow(`answer ${i}${padding}`)];
}

// ---------------------------------------------------------------------------
// Fake streaming client (copied minimally from tool-loop.test.ts)
// ---------------------------------------------------------------------------

type StreamStep =
  | { kind: "text"; content: string }
  | { kind: "tool_call"; index: number; id?: string; name?: string; argsFragment?: string }
  | { kind: "finish"; reason: "tool_calls" | "stop" | "length" };

function text(content: string): StreamStep {
  return { kind: "text", content };
}
function toolCallStart(index: number, id: string, name: string, argsFragment = ""): StreamStep {
  return { kind: "tool_call", index, id, name, argsFragment };
}
function finish(reason: "tool_calls" | "stop" | "length"): StreamStep {
  return { kind: "finish", reason };
}

function chunkFromStep(step: StreamStep) {
  switch (step.kind) {
    case "finish":
      return { choices: [{ delta: {}, finish_reason: step.reason }] };
    case "text":
      return { choices: [{ delta: { content: step.content }, finish_reason: null }] };
    case "tool_call": {
      const toolCall: Record<string, unknown> = { index: step.index };
      if (step.id !== undefined) toolCall.id = step.id;
      if (step.name !== undefined) {
        toolCall.type = "function";
        toolCall.function = { name: step.name, arguments: step.argsFragment ?? "" };
      } else if (step.argsFragment !== undefined) {
        toolCall.function = { arguments: step.argsFragment };
      }
      return { choices: [{ delta: { tool_calls: [toolCall] }, finish_reason: null }] };
    }
  }
}

async function* makeStream(steps: StreamStep[]) {
  for (const step of steps) yield chunkFromStep(step);
}

interface SummaryScript {
  content: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/**
 * A single fake client whose `create` answers BOTH the tool loop's streaming
 * calls (`params.stream === true`) and compaction's non-streaming
 * summarization calls (no `stream` field) - mirrors the real OpenAI SDK
 * client, which is reused as-is for both call shapes in production.
 */
function createCombinedFakeClient(
  streamScripts: StreamStep[][],
  summaryScripts: Array<SummaryScript | Error>
) {
  const streamCalls: any[] = [];
  const summaryCalls: any[] = [];
  const create = vi.fn().mockImplementation(async (params: any) => {
    if (params.stream) {
      streamCalls.push(params);
      const script = streamScripts[Math.min(streamCalls.length - 1, streamScripts.length - 1)];
      return makeStream(script);
    }
    summaryCalls.push(params);
    const script = summaryScripts[Math.min(summaryCalls.length - 1, summaryScripts.length - 1)];
    if (script instanceof Error) throw script;
    return {
      choices: [{ message: { content: script.content } }],
      usage: script.usage ?? { prompt_tokens: 50, completion_tokens: 20 },
    };
  });
  return { client: { chat: { completions: { create } } }, streamCalls, summaryCalls, create };
}

function makeEcho() {
  return {
    name: "echo",
    description: "test tool",
    parameters: { type: "object", properties: {} },
    execute: vi.fn(() => "ok"),
  };
}

// ---------------------------------------------------------------------------
// Unit tests: token estimation
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("estimates ASCII text at ~4 chars/token", () => {
    expect(estimateTokens("hello world")).toBe(Math.ceil(11 / 4));
  });

  it("estimates non-ASCII (CJK) text at ~1.5 chars/token - denser than ASCII", () => {
    const cjk = "你好世界"; // 4 characters
    expect(estimateTokens(cjk)).toBe(Math.ceil(4 / 1.5));
    // Same character count, CJK costs more tokens than ASCII would.
    expect(estimateTokens(cjk)).toBeGreaterThan(estimateTokens("abcd"));
  });

  it("handles mixed ASCII/non-ASCII content", () => {
    const mixed = "hi 你好"; // "hi " = 3 ascii, "你好" = 2 non-ascii
    expect(estimateTokens(mixed)).toBe(Math.ceil(3 / 4 + 2 / 1.5));
  });

  it("empty string is zero tokens", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: findTurnCutPoint (pre-turn, row-based)
// ---------------------------------------------------------------------------

describe("findTurnCutPoint", () => {
  it("cuts only at 'user' rows, never mid-turn", () => {
    rowSeq = 0;
    const history = [...fullTextTurn(0, 500), ...fullTextTurn(1, 500), userRow("current question")];
    const cut = findTurnCutPoint(history, 1 /* tiny budget -> cuts as early as possible */);
    expect(cut).not.toBeNull();
    expect(history[cut!.index].role).toBe("user");
  });

  it("always keeps the newest 'user' row (current turn) - never cuts into it", () => {
    rowSeq = 0;
    const history = [...fullTextTurn(0, 500), ...fullTextTurn(1, 500), userRow("current question")];
    const lastUserIndex = history.length - 1;
    const cut = findTurnCutPoint(history, 1);
    expect(cut).not.toBeNull();
    expect(cut!.index).toBeLessThanOrEqual(lastUserIndex);
    // With a near-zero budget, the cut collapses to keeping only the
    // current turn - everything else gets summarized.
    expect(cut!.index).toBe(lastUserIndex);
    expect(cut!.rowId).toBe(history[lastUserIndex].id);
  });

  it("respects a prior compaction boundary - never returns a cut before startIndex", () => {
    rowSeq = 0;
    const history = [...fullTextTurn(0, 500), ...fullTextTurn(1, 500), ...fullTextTurn(2, 500)];
    const boundaryIndex = 2; // start of turn 1
    const cut = findTurnCutPoint(history, 1, boundaryIndex);
    expect(cut).not.toBeNull();
    expect(cut!.index).toBeGreaterThanOrEqual(boundaryIndex);
    expect(cut!.index).toBe(4); // start of turn 2, the newest turn
  });

  it("returns null when the span to summarize would be empty (whole span fits the budget)", () => {
    rowSeq = 0;
    const history = [...fullTextTurn(0), userRow("current question")];
    // keepRecentTokens far larger than the whole history - nothing crosses
    // the budget, so the cut collapses to the first row and there's nothing
    // before it to summarize.
    const cut = findTurnCutPoint(history, 1_000_000);
    expect(cut).toBeNull();
  });

  it("returns null when startIndex is already at/after the only user row", () => {
    rowSeq = 0;
    const history = [userRow("current question")];
    const cut = findTurnCutPoint(history, 1, 0);
    expect(cut).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit tests: findAssistantCutPoint (mid-loop, ChatMessage-based)
// ---------------------------------------------------------------------------

describe("findAssistantCutPoint", () => {
  it("cuts only at 'assistant' rows, never at a 'tool' row", () => {
    const messages = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "q" },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{ id: "c1", function: { name: "echo", arguments: "{}" } }],
      },
      { role: "tool" as const, content: "x".repeat(4000), tool_call_id: "c1" },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{ id: "c2", function: { name: "echo", arguments: "{}" } }],
      },
      { role: "tool" as const, content: "y".repeat(4000), tool_call_id: "c2" },
    ];
    const cut = findAssistantCutPoint(messages, 1, 500);
    expect(cut).not.toBeNull();
    expect(messages[cut!.index].role).toBe("assistant");
    expect(cut!.index).toBe(4);
  });

  it("returns null when only the turn's first assistant row is available (empty prefix)", () => {
    const messages = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "q" },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{ id: "c1", function: { name: "echo", arguments: "{}" } }],
      },
      { role: "tool" as const, content: "x".repeat(4000), tool_call_id: "c1" },
    ];
    const cut = findAssistantCutPoint(messages, 1, 1);
    expect(cut).toBeNull();
  });

  it("returns null when there is no assistant row in the turn yet", () => {
    const messages = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "q" },
    ];
    expect(findAssistantCutPoint(messages, 1, 1)).toBeNull();
  });
});

describe("findLastUserIndex", () => {
  it("finds the newest user-role message", () => {
    const messages = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "a" },
      { role: "assistant" as const, content: "b" },
      { role: "user" as const, content: "c" },
    ];
    expect(findLastUserIndex(messages)).toBe(3);
  });

  it("returns -1 when there is no user message", () => {
    expect(findLastUserIndex([{ role: "system" as const, content: "sys" }])).toBe(-1);
  });
});

describe("applyCompaction", () => {
  it("replaces messages[keepPrefixCount..cutIndex) with a single summary message", () => {
    const messages = ["a", "b", "c", "d", "e"];
    expect(applyCompaction(messages, 3, "SUMMARY", 1)).toEqual(["a", "SUMMARY", "d", "e"]);
  });

  it("preserves a longer prefix when keepPrefixCount > 1 (existing summary message)", () => {
    const messages = ["sys", "existing-summary", "c", "d", "e"];
    expect(applyCompaction(messages, 3, "NEW", 2)).toEqual(["sys", "existing-summary", "NEW", "d", "e"]);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: pre-turn compaction via runToolLoop
// ---------------------------------------------------------------------------

describe("runToolLoop pre-turn compaction", () => {
  it("over-threshold: summarizes once with the right span, inserts a summary message, and reports usage via onCompaction", async () => {
    rowSeq = 0;
    const history = [...fullTextTurn(0, 3000), ...fullTextTurn(1, 3000), userRow("current question")];
    const fullChat = [{ role: "system" as const, content: "sys" }, ...history.map(rowToChatMessage)];
    const thresholdTokens = estimateMessagesTokens(fullChat as any) - 1; // guarantee over-threshold

    const { client, streamCalls, summaryCalls } = createCombinedFakeClient(
      [[text("final answer"), finish("stop")]],
      [{ content: "SUMMARY TEXT", usage: { prompt_tokens: 123, completion_tokens: 45 } }]
    );

    const onCompaction = vi.fn();
    const { content } = await runToolLoop(history, vi.fn(), undefined, {
      client: client as any,
      compaction: {
        enabled: true,
        thresholdTokens,
        keepRecentTokens: 1, // tiny -> keeps only the current turn
        previousSummary: null,
        onCompaction,
      },
    });

    expect(content).toBe("final answer");
    expect(summaryCalls).toHaveLength(1);
    const summaryPrompt = summaryCalls[0].messages[1].content as string;
    expect(summaryPrompt).toContain("question 0");
    expect(summaryPrompt).toContain("question 1");
    expect(summaryPrompt).not.toContain("current question");

    expect(onCompaction).toHaveBeenCalledTimes(1);
    expect(onCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "SUMMARY TEXT",
        firstKeptMessageId: history[history.length - 1].id,
        promptTokens: 123,
        completionTokens: 45,
      })
    );

    expect(streamCalls).toHaveLength(1);
    const sentMessages = streamCalls[0].messages;
    expect(sentMessages).toHaveLength(3); // system, summary, current-question
    expect(sentMessages[1]).toMatchObject({ role: "system" });
    expect(sentMessages[1].content).toContain("SUMMARY TEXT");
    expect(sentMessages[2]).toMatchObject({ role: "user", content: "current question" });
  });

  it("chains a previous summary and only summarizes the span after its kept boundary", async () => {
    rowSeq = 0;
    const history = [...fullTextTurn(0, 3000), ...fullTextTurn(1, 3000), userRow("current question")];
    const fullChat = [{ role: "system" as const, content: "sys" }, ...history.map(rowToChatMessage)];
    const thresholdTokens = estimateMessagesTokens(fullChat as any) - 1;
    const boundaryId = history[2].id; // start of turn 1

    const { client, summaryCalls } = createCombinedFakeClient(
      [[text("final answer"), finish("stop")]],
      [{ content: "UPDATED SUMMARY" }]
    );

    await runToolLoop(history, vi.fn(), undefined, {
      client: client as any,
      compaction: {
        enabled: true,
        thresholdTokens,
        keepRecentTokens: 1,
        previousSummary: "PRIOR SUMMARY TEXT",
        previousSummaryFirstKeptMessageId: boundaryId,
      },
    });

    expect(summaryCalls).toHaveLength(1);
    const summaryPrompt = summaryCalls[0].messages[1].content as string;
    expect(summaryPrompt).toContain("<previous-summary>");
    expect(summaryPrompt).toContain("PRIOR SUMMARY TEXT");
    expect(summaryPrompt).toContain("question 1"); // turn 1, after the boundary
    expect(summaryPrompt).not.toContain("question 0"); // turn 0, before the boundary - already summarized
  });

  it("under-threshold: never calls summarize, messages are identical to the uncompacted array", async () => {
    rowSeq = 0;
    const history = [...fullTextTurn(0), userRow("current question")];

    const { client, streamCalls, summaryCalls } = createCombinedFakeClient(
      [[text("ok"), finish("stop")]],
      []
    );

    await runToolLoop(history, vi.fn(), undefined, {
      client: client as any,
      compaction: {
        enabled: true,
        thresholdTokens: 1_000_000,
        keepRecentTokens: 20_000,
        previousSummary: null,
      },
    });

    expect(summaryCalls).toHaveLength(0);
    const sentMessages = streamCalls[0].messages;
    expect(sentMessages).toHaveLength(1 + history.length);
    expect(sentMessages.slice(1)).toEqual(history.map(rowToChatMessage));
  });

  it("compaction disabled: falls back to exactly today's row-slice behavior", async () => {
    rowSeq = 0;
    const history: Message[] = [
      ...Array.from({ length: 12 }, (_, i) => fullTextTurn(i)).flat(),
      userRow("question 12"),
      assistantTextRow("answer 12"),
    ];
    expect(history.length).toBeGreaterThan(HISTORY_LIMIT);

    const { client, streamCalls, summaryCalls } = createCombinedFakeClient(
      [[text("final answer"), finish("stop")]],
      []
    );

    await runToolLoop(history, vi.fn(), undefined, { client: client as any });

    expect(summaryCalls).toHaveLength(0);
    const expectedSlice = sliceHistoryAtTurnBoundaries(history, HISTORY_LIMIT);
    expect(streamCalls[0].messages.slice(1)).toEqual(expectedSlice.map(rowToChatMessage));
  });
});

// ---------------------------------------------------------------------------
// Integration test: mid-loop split-turn compaction
// ---------------------------------------------------------------------------

describe("runToolLoop mid-loop split-turn compaction", () => {
  it("splits an over-budget open turn: summarizes the prefix, keeps the tail, tool results stay glued to their call", async () => {
    rowSeq = 0;
    const history = [userRow("do the thing")];
    const echo = makeEcho();

    const { client, streamCalls, summaryCalls } = createCombinedFakeClient(
      [
        // iteration 0: small tool call + small result - not enough to cross
        // the budget on its own, and only one assistant row exists yet so a
        // split wouldn't have anywhere useful to cut anyway.
        [toolCallStart(0, "call_a", "echo", "{}"), finish("tool_calls")],
        // iteration 1: another tool call whose (large) result pushes the
        // array over threshold, so the split triggers at the top of
        // iteration 2.
        [toolCallStart(0, "call_b", "echo", "{}"), finish("tool_calls")],
        // iteration 2: sees the split-compacted messages, finishes normally.
        [text("done"), finish("stop")],
      ],
      [{ content: "PREFIX SUMMARY" }]
    );

    echo.execute = vi.fn().mockImplementationOnce(() => "small result").mockImplementationOnce(() => "z".repeat(4000));

    const { content, toolExchange } = await runToolLoop(history, vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      compaction: {
        enabled: true,
        thresholdTokens: 800,
        keepRecentTokens: 500,
        previousSummary: null,
      },
    });

    expect(content).toBe("done");
    expect(toolExchange).toHaveLength(2); // both tool calls still executed and recorded

    expect(streamCalls).toHaveLength(3);
    expect(summaryCalls).toHaveLength(1); // only the mid-loop split, no pre-turn compaction

    // The mid-loop summarization prompt covers the turn's early part -
    // the user message and the first (small) tool exchange - not the
    // second, retained one.
    const prefixPrompt = summaryCalls[0].messages[1].content as string;
    expect(prefixPrompt).toContain("do the thing");
    expect(prefixPrompt).toContain("small result");
    expect(prefixPrompt).not.toContain("zzzz");

    // iteration 2's outbound messages: system, turn-prefix summary, then the
    // retained assistant tool-call + its tool result - never a dangling
    // tool row, never a tool-result row used as a cut point.
    const sentMessages = streamCalls[2].messages;
    expect(sentMessages[0]).toMatchObject({ role: "system" });
    expect(sentMessages[1]).toMatchObject({ role: "system" });
    expect(sentMessages[1].content).toContain("PREFIX SUMMARY");
    expect(sentMessages[2].role).toBe("assistant");
    expect(sentMessages[2].tool_calls?.[0]?.id).toBe("call_b");
    expect(sentMessages[3]).toMatchObject({ role: "tool", tool_call_id: "call_b" });
    expect(sentMessages).toHaveLength(4);

    for (let i = 0; i < sentMessages.length; i++) {
      if (sentMessages[i].role === "tool") {
        expect(sentMessages[i - 1].role).toBe("assistant");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Integration test: summarization failure is non-fatal
// ---------------------------------------------------------------------------

describe("runToolLoop compaction failure handling", () => {
  it("pre-turn: a throwing summarize call is skipped gracefully, loop continues uncompacted", async () => {
    rowSeq = 0;
    const history = [...fullTextTurn(0, 3000), ...fullTextTurn(1, 3000), userRow("current question")];
    const fullChat = [{ role: "system" as const, content: "sys" }, ...history.map(rowToChatMessage)];
    const thresholdTokens = estimateMessagesTokens(fullChat as any) - 1;

    const { client, streamCalls, summaryCalls } = createCombinedFakeClient(
      [[text("final answer"), finish("stop")]],
      [new Error("summarization backend down")]
    );

    const onCompaction = vi.fn();
    const { content } = await runToolLoop(history, vi.fn(), undefined, {
      client: client as any,
      compaction: {
        enabled: true,
        thresholdTokens,
        keepRecentTokens: 1,
        previousSummary: null,
        onCompaction,
      },
    });

    expect(content).toBe("final answer"); // turn completes despite the failure
    expect(summaryCalls).toHaveLength(1);
    expect(onCompaction).not.toHaveBeenCalled();

    const sentMessages = streamCalls[0].messages;
    expect(sentMessages.slice(1)).toEqual(history.map(rowToChatMessage)); // fell back to uncompacted
  });
});
