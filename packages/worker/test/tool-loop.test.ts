import { describe, it, expect, vi } from "vitest";
import type { Message } from "@stateless-chat/shared";
import {
  runToolLoop,
  DEFAULT_TOOLS,
  HISTORY_LIMIT,
  sliceHistoryAtTurnBoundaries,
  rowToChatMessage,
} from "../src/tool-loop.js";

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible streaming client
// ---------------------------------------------------------------------------

type StreamStep =
  | { kind: "text"; content: string }
  | { kind: "tool_call"; index: number; id?: string; name?: string; argsFragment?: string }
  | { kind: "finish"; reason: "tool_calls" | "stop" | "length" }
  | { kind: "usage"; usage: { prompt_tokens: number; completion_tokens: number; total_tokens?: number } }
  | { kind: "delay"; ms: number };

function delay(ms: number): StreamStep {
  return { kind: "delay", ms };
}

function text(content: string): StreamStep {
  return { kind: "text", content };
}

function toolCallStart(index: number, id: string, name: string, argsFragment = ""): StreamStep {
  return { kind: "tool_call", index, id, name, argsFragment };
}

function toolCallArgs(index: number, argsFragment: string): StreamStep {
  return { kind: "tool_call", index, argsFragment };
}

function finish(reason: "tool_calls" | "stop" | "length"): StreamStep {
  return { kind: "finish", reason };
}

function usageChunk(usage: {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
}): StreamStep {
  return { kind: "usage", usage };
}

function chunkFromStep(step: StreamStep) {
  switch (step.kind) {
    case "delay":
      throw new Error("delay steps must be handled by makeStream, not chunked");
    case "finish":
      return { choices: [{ delta: {}, finish_reason: step.reason }] };
    case "usage":
      // Mirrors DeepSeek's real behavior: usage arrives on a trailing chunk
      // with an EMPTY choices array, not attached to the finish chunk.
      return { choices: [], usage: step.usage };
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
  for (const step of steps) {
    if (step.kind === "delay") {
      await new Promise((resolve) => setTimeout(resolve, step.ms));
      continue;
    }
    yield chunkFromStep(step);
  }
}

/**
 * scripts[i] is used for the (i+1)th create() call; the last script is
 * reused for any further calls (used to simulate "keeps calling forever").
 */
function createFakeClient(scripts: StreamStep[][]) {
  const calls: any[] = [];
  const create = vi.fn().mockImplementation(async (params: any) => {
    calls.push(params);
    const script = scripts[Math.min(calls.length - 1, scripts.length - 1)];
    return makeStream(script);
  });
  return { client: { chat: { completions: { create } } }, calls, create };
}

// ---------------------------------------------------------------------------
// Fake tools
// ---------------------------------------------------------------------------

interface FakeTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (args: any) => Promise<string> | string;
}

function makeTool(name: string, impl: (args: any) => string | Promise<string>): FakeTool {
  return {
    name,
    description: `test tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(impl),
  };
}

function makeHistory(content = "hello"): Message[] {
  return [
    {
      id: "msg-1",
      conversation_id: "conv-1",
      role: "user",
      content,
      status: "processing",
      reply_to_message_id: null,
      created_at: new Date().toISOString(),
    },
  ];
}

const FALLBACK = "I wasn't able to finish that using my tools — could you rephrase?";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runToolLoop", () => {
  it("a) malformed JSON tool args: feeds a role:tool error back and still returns a final answer", async () => {
    const echo = makeTool("echo", () => "ok");
    const { client, calls } = createFakeClient([
      [toolCallStart(0, "call_1", "echo", '{"bad": '), finish("tool_calls")],
      [text("Done"), finish("stop")],
    ]);
    const onToken = vi.fn();

    const { content } = await runToolLoop(makeHistory(), onToken, undefined, {
      client: client as any,
      tools: [echo] as any,
    });

    expect(content).toBe("Done");
    expect(echo.execute).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    const toolMsg = calls[1].messages.find(
      (m: any) => m.role === "tool" && m.tool_call_id === "call_1"
    );
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toMatch(/error/i);
  });

  it("b) model keeps emitting tool_calls forever: stops at the wall-clock deadline and answers via answer-now retry", async () => {
    const echo = makeTool("echo", () => "ok");
    // No iteration cap - each round eats into the 25ms deadline via its own
    // 10ms delay, so the 3rd round's delay pushes elapsed time past it.
    const toolOnly = () => [delay(10), toolCallStart(0, "call_x", "echo", "{}"), finish("tool_calls")];
    const { client, create, calls } = createFakeClient([
      toolOnly(),
      toolOnly(),
      toolOnly(),
      [text("Retry answer"), finish("stop")],
    ]);
    const tokens: string[] = [];
    const onToken = vi.fn((t: string) => tokens.push(t));

    const { content, toolExchange } = await runToolLoop(makeHistory(), onToken, undefined, {
      client: client as any,
      tools: [echo] as any,
      timeoutMs: 25,
    });

    // 3 deadline-bound tool rounds + 1 answer-now retry call.
    expect(create).toHaveBeenCalledTimes(4);
    expect(content).toBe("Retry answer");
    expect(tokens.join("")).toBe("Retry answer");
    expect(toolExchange).toHaveLength(3);
    expect(toolExchange.every((r) => r.toolCallId === "call_x" && !r.isError)).toBe(true);

    const retryCall = calls[3];
    expect(retryCall.tools).toBeUndefined();
    const lastMessage = retryCall.messages[retryCall.messages.length - 1];
    expect(lastMessage).toMatchObject({ role: "user" });
    expect(lastMessage.content).toMatch(/tool budget exhausted/i);
    expect(lastMessage.content).toMatch(/do not call any tools/i);
  });

  it("b2) answer-now retry itself fails: falls back to the fallback message", async () => {
    const echo = makeTool("echo", () => "ok");
    let calls = 0;
    const create = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls <= 3) {
        return makeStream([delay(10), toolCallStart(0, "call_x", "echo", "{}"), finish("tool_calls")]);
      }
      throw new Error("retry network fail");
    });
    const client = { chat: { completions: { create } } };

    const { content } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      timeoutMs: 25,
    });

    expect(create).toHaveBeenCalledTimes(4);
    expect(content).toBe(FALLBACK);
  });

  it("c) tool execute() throws: error fed back, loop continues to a final answer", async () => {
    const boom = makeTool("boom", () => {
      throw new Error("kaboom");
    });
    const { client, calls } = createFakeClient([
      [toolCallStart(0, "call_1", "boom", "{}"), finish("tool_calls")],
      [text("ok after error"), finish("stop")],
    ]);
    const onToolEvent = vi.fn();

    const { content, toolExchange } = await runToolLoop(makeHistory(), vi.fn(), onToolEvent, {
      client: client as any,
      tools: [boom] as any,
    });

    expect(content).toBe("ok after error");
    const toolMsg = calls[1].messages.find(
      (m: any) => m.role === "tool" && m.tool_call_id === "call_1"
    );
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toMatch(/error/i);
    expect(onToolEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tool_end", toolCallId: "call_1", isError: true })
    );
    expect(toolExchange).toEqual([
      expect.objectContaining({
        iteration: 0,
        toolCallId: "call_1",
        toolName: "boom",
        isError: true,
        result: expect.stringMatching(/error/i),
      }),
    ]);
  });

  it("d) tool returns an empty string result: handled, final answer returned", async () => {
    const empty = makeTool("empty", () => "");
    const { client, calls } = createFakeClient([
      [toolCallStart(0, "call_1", "empty", "{}"), finish("tool_calls")],
      [text("final"), finish("stop")],
    ]);

    const { content } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [empty] as any,
    });

    expect(content).toBe("final");
    const toolMsg = calls[1].messages.find(
      (m: any) => m.role === "tool" && m.tool_call_id === "call_1"
    );
    expect(toolMsg).toBeDefined();
    expect(typeof toolMsg.content).toBe("string");
  });

  it("e) unknown tool name: error fed back, loop continues", async () => {
    const echo = makeTool("echo", () => "ok");
    const { client, calls } = createFakeClient([
      [toolCallStart(0, "call_1", "not_a_real_tool", "{}"), finish("tool_calls")],
      [text("answer"), finish("stop")],
    ]);

    const { content } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
    });

    expect(content).toBe("answer");
    expect(echo.execute).not.toHaveBeenCalled();
    const toolMsg = calls[1].messages.find(
      (m: any) => m.role === "tool" && m.tool_call_id === "call_1"
    );
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toMatch(/error/i);
  });

  it("f) LLM request throws: runToolLoop rejects", async () => {
    const create = vi.fn().mockRejectedValue(new Error("network fail"));
    const client = { chat: { completions: { create } } };

    await expect(
      runToolLoop(makeHistory(), vi.fn(), undefined, { client: client as any })
    ).rejects.toThrow();
  });

  it("g) no tool calls (finish_reason stop): returns text, onToken streamed, onToolEvent never called", async () => {
    const { client } = createFakeClient([[text("Hi"), text(" there"), finish("stop")]]);
    const tokens: string[] = [];
    const onToken = vi.fn((t: string) => tokens.push(t));
    const onToolEvent = vi.fn();

    const { content, toolExchange } = await runToolLoop(makeHistory(), onToken, onToolEvent, {
      client: client as any,
    });

    expect(content).toBe("Hi there");
    expect(tokens.join("")).toBe("Hi there");
    expect(onToolEvent).not.toHaveBeenCalled();
    expect(toolExchange).toEqual([]);
  });

  it("h) tool_start/tool_end emitted per call, in order, with correct isError", async () => {
    const echo = makeTool("echo", () => "ok");
    const boom = makeTool("boom", () => {
      throw new Error("bad");
    });
    const { client } = createFakeClient([
      [
        toolCallStart(0, "call_1", "echo", '{"a":'),
        toolCallArgs(0, "1}"),
        toolCallStart(1, "call_2", "boom", "{}"),
        finish("tool_calls"),
      ],
      [text("done"), finish("stop")],
    ]);
    const events: any[] = [];
    const onToolEvent = vi.fn((e: any) => events.push(e));

    const { content, toolExchange } = await runToolLoop(makeHistory(), vi.fn(), onToolEvent, {
      client: client as any,
      tools: [echo, boom] as any,
    });

    expect(content).toBe("done");

    for (const [id, expectedError] of [
      ["call_1", false],
      ["call_2", true],
    ] as const) {
      const startIdx = events.findIndex((e) => e.type === "tool_start" && e.toolCallId === id);
      const endIdx = events.findIndex((e) => e.type === "tool_end" && e.toolCallId === id);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThan(startIdx);
      expect(events[endIdx].isError).toBe(expectedError);
    }

    expect(toolExchange).toHaveLength(2);
    expect(toolExchange.map((r) => r.toolCallId)).toEqual(["call_1", "call_2"]);
    expect(toolExchange[0]).toMatchObject({
      iteration: 0,
      toolName: "echo",
      arguments: '{"a":1}',
      args: { a: 1 },
      result: "ok",
      isError: false,
    });
    expect(toolExchange[1]).toMatchObject({
      iteration: 0,
      toolName: "boom",
      isError: true,
    });
    expect(toolExchange[1].result).toMatch(/error/i);
  });

  it("i) wall-clock deadline: loop exits gracefully mid-survey and answers via answer-now retry (no rejection)", async () => {
    const echo = makeTool("echo", () => "ok");
    const { client, create } = createFakeClient([
      // Iteration 0 runs (deadline not yet passed), but takes long enough
      // that the top-of-iteration check on iteration 1 sees the deadline
      // has passed, and breaks before making another tool-only call.
      [delay(30), toolCallStart(0, "call_1", "echo", "{}"), finish("tool_calls")],
      [text("Answer from retry"), finish("stop")],
    ]);
    const tokens: string[] = [];
    const onToken = vi.fn((t: string) => tokens.push(t));

    const { content } = await runToolLoop(makeHistory(), onToken, undefined, {
      client: client as any,
      tools: [echo] as any,
      timeoutMs: 10,
    });

    // Exactly one tool-only iteration, then the answer-now retry - never a
    // second tool-only round, and never a rejection.
    expect(create).toHaveBeenCalledTimes(2);
    expect(content).toBe("Answer from retry");
    expect(tokens.join("")).toBe("Answer from retry");
  });

  it("j) final answer contains only final text; resolved string equals what onToken received", async () => {
    const echo = makeTool("echo", () => "ok");
    const { client } = createFakeClient([
      [toolCallStart(0, "call_1", "echo", "{}"), finish("tool_calls")],
      [text("Answer: "), text("42"), finish("stop")],
    ]);
    const tokens: string[] = [];
    const onToken = vi.fn((t: string) => tokens.push(t));

    const { content } = await runToolLoop(makeHistory(), onToken, undefined, {
      client: client as any,
      tools: [echo] as any,
    });

    expect(content).toBe("Answer: 42");
    expect(tokens.join("")).toBe(content);
    expect(content).not.toMatch(/error/i);
    expect(content).not.toContain("call_1");
  });

  it("k) finish_reason length with pending tool calls: auto-failed as error, loop continues", async () => {
    const echo = makeTool("echo", () => "ok");
    const { client, calls } = createFakeClient([
      [toolCallStart(0, "call_1", "echo", "{}"), finish("length")],
      [text("recovered"), finish("stop")],
    ]);

    const { content, toolExchange } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
    });

    expect(content).toBe("recovered");
    expect(echo.execute).not.toHaveBeenCalled();
    const toolMsg = calls[1].messages.find(
      (m: any) => m.role === "tool" && m.tool_call_id === "call_1"
    );
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toMatch(/error/i);

    expect(toolExchange).toEqual([
      expect.objectContaining({
        iteration: 0,
        toolCallId: "call_1",
        toolName: "echo",
        isError: true,
        result: expect.stringMatching(/truncated/i),
      }),
    ]);
  });

  it("l) usage chunk (empty choices) is accumulated, not skipped by the choices?.[0] continue-check", async () => {
    const { client } = createFakeClient([
      [
        text("Answer"),
        finish("stop"),
        usageChunk({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
      ],
    ]);

    const { content, usage } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
    });

    expect(content).toBe("Answer");
    expect(usage).not.toBeNull();
    expect(usage).toMatchObject({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    expect(usage!.streamMs).toBeGreaterThanOrEqual(0);
    expect(usage!.firstTokenMs).toBeGreaterThanOrEqual(0);
  });

  it("m) usage accumulates across multiple tool-loop iterations", async () => {
    const echo = makeTool("echo", () => "ok");
    const { client } = createFakeClient([
      [
        toolCallStart(0, "call_1", "echo", "{}"),
        finish("tool_calls"),
        usageChunk({ prompt_tokens: 20, completion_tokens: 3 }),
      ],
      [
        text("done"),
        finish("stop"),
        usageChunk({ prompt_tokens: 30, completion_tokens: 7 }),
      ],
    ]);

    const { usage } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
    });

    expect(usage).toMatchObject({
      promptTokens: 50,
      completionTokens: 10,
      totalTokens: 60,
    });
  });

  it("n) no usage chunk delivered: usage is null, not zeroed", async () => {
    const { client } = createFakeClient([[text("Hi"), finish("stop")]]);

    const { content, usage } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
    });

    expect(content).toBe("Hi");
    expect(usage).toBeNull();
  });
});

describe("DEFAULT_TOOLS", () => {
  it("exposes get_current_datetime and calculator with the Tool shape", () => {
    // Length depends on env: bash is appended when TOOL_BASH_ENABLED=true
    const names = DEFAULT_TOOLS.map((t) => t.name);
    expect(names).toContain("get_current_datetime");
    expect(names).toContain("calculator");
    if (process.env.TOOL_BASH_ENABLED === "true") {
      expect(names).toContain("bash");
    }
    for (const tool of DEFAULT_TOOLS) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("includes each file tool only when its own env flag is set", () => {
    const names = DEFAULT_TOOLS.map((t) => t.name);
    const flags: Array<[string, string]> = [
      ["TOOL_READ_FILE_ENABLED", "read_file"],
      ["TOOL_WRITE_FILE_ENABLED", "write_file"],
      ["TOOL_EDIT_FILE_ENABLED", "edit_file"],
    ];
    for (const [envVar, toolName] of flags) {
      if (process.env[envVar] === "true") {
        expect(names).toContain(toolName);
      } else {
        expect(names).not.toContain(toolName);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Turn-boundary-aware history slicing
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
  return {
    ...rowBase("assistant"),
    content: "",
    tool_calls: [{ id: callId, name: toolName, arguments: args }],
  };
}

function toolResultRow(callId: string, toolName: string, content: string): Message {
  return {
    ...rowBase("tool"),
    content,
    tool_call_id: callId,
    tool_name: toolName,
  };
}

function assistantTextRow(content: string): Message {
  return { ...rowBase("assistant"), content };
}

/** One full turn: user question -> one tool call -> final text answer. */
function fullToolTurn(i: number): Message[] {
  return [
    userRow(`question ${i}`),
    toolCallAssistantRow(`call_${i}`, "echo", "{}"),
    toolResultRow(`call_${i}`, "echo", `result ${i}`),
    assistantTextRow(`answer ${i}`),
  ];
}

/** Asserts no dangling 'tool' row and no split tool-call exchange group. */
function assertStructurallyValid(rows: Message[]) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].role === "tool") {
      const prev = rows[i - 1];
      expect(prev, `tool row at ${i} has no preceding row`).toBeDefined();
      expect(prev.role).toBe("assistant");
      const ids = (prev.tool_calls ?? []).map((tc) => tc.id);
      expect(ids).toContain(rows[i].tool_call_id);
    }
    if (rows[i].role === "assistant" && rows[i].tool_calls && rows[i].tool_calls!.length > 0) {
      const expectedIds = rows[i].tool_calls!.map((tc) => tc.id);
      const following = rows.slice(i + 1, i + 1 + expectedIds.length);
      expect(following.every((r) => r.role === "tool")).toBe(true);
      expect(following.map((r) => r.tool_call_id)).toEqual(expectedIds);
    }
  }
}

describe("sliceHistoryAtTurnBoundaries", () => {
  it("expands the window backward to the enclosing user row when the raw cut lands inside a tool exchange", () => {
    rowSeq = 0;
    // 6 full tool turns (4 rows each, 24 rows) + one plain turn (2 rows) = 26
    // rows. history.length - HISTORY_LIMIT (20) = 6, which lands exactly on
    // turn 1's 'tool' row (rows 4-7 = user, assistant tool_calls, tool,
    // assistant final) - the classic dangling-tool-row cut.
    const history: Message[] = [
      ...Array.from({ length: 6 }, (_, i) => fullToolTurn(i)).flat(),
      userRow("question 6"),
      assistantTextRow("answer 6"),
    ];
    expect(history.length).toBe(26);
    expect(history.length - HISTORY_LIMIT).toBe(6);
    expect(history[6].role).toBe("tool");

    const sliced = sliceHistoryAtTurnBoundaries(history, HISTORY_LIMIT);

    // Backward expansion must walk back to turn 1's user row (index 4), not
    // stop mid-exchange or include turn 0 at all.
    expect(sliced[0].role).toBe("user");
    expect(sliced[0].content).toBe("question 1");
    expect(sliced).not.toContainEqual(expect.objectContaining({ content: "question 0" }));

    assertStructurallyValid(sliced);
  });

  it("is a no-op when history is at or under the limit", () => {
    rowSeq = 0;
    const history = [...fullToolTurn(0), ...fullToolTurn(1)];
    const sliced = sliceHistoryAtTurnBoundaries(history, HISTORY_LIMIT);
    expect(sliced).toEqual(history);
  });

  it("never produces a ChatMessage sequence with a dangling tool message when mapped and sent to the LLM, exactly at the HISTORY_LIMIT boundary", async () => {
    rowSeq = 0;
    const history: Message[] = [
      ...Array.from({ length: 6 }, (_, i) => fullToolTurn(i)).flat(),
      userRow("question 6"),
      assistantTextRow("answer 6"),
    ];

    const { client, calls } = createFakeClient([[text("final answer"), finish("stop")]]);

    await runToolLoop(history, vi.fn(), undefined, { client: client as any });

    expect(calls).toHaveLength(1);
    const sent = calls[0].messages as Array<{
      role: string;
      tool_call_id?: string;
      tool_calls?: Array<{ id: string }>;
    }>;
    expect(sent[0]).toMatchObject({ role: "system" });

    for (let i = 0; i < sent.length; i++) {
      if (sent[i].role === "tool") {
        const prev = sent[i - 1];
        expect(prev).toBeDefined();
        expect(prev.role).toBe("assistant");
        expect((prev.tool_calls ?? []).map((tc) => tc.id)).toContain(sent[i].tool_call_id);
      }
    }

    // Sanity: matches directly mapping the same slice through rowToChatMessage.
    const expectedSlice = sliceHistoryAtTurnBoundaries(history, HISTORY_LIMIT);
    expect(sent.slice(1)).toEqual(expectedSlice.map(rowToChatMessage));
  });
});
