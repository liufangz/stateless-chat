import { describe, it, expect, vi } from "vitest";
import type { Message } from "@stateless-chat/shared";
import { runToolLoop, DEFAULT_TOOLS } from "../src/tool-loop.js";

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible streaming client
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

function toolCallArgs(index: number, argsFragment: string): StreamStep {
  return { kind: "tool_call", index, argsFragment };
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
  for (const step of steps) {
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

    const result = await runToolLoop(makeHistory(), onToken, undefined, {
      client: client as any,
      tools: [echo] as any,
    });

    expect(result).toBe("Done");
    expect(echo.execute).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    const toolMsg = calls[1].messages.find(
      (m: any) => m.role === "tool" && m.tool_call_id === "call_1"
    );
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toMatch(/error/i);
  });

  it("b) model keeps emitting tool_calls forever: stops at maxIterations and returns fallback", async () => {
    const echo = makeTool("echo", () => "ok");
    const { client, create } = createFakeClient([
      [toolCallStart(0, "call_x", "echo", "{}"), finish("tool_calls")],
    ]);

    const result = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      maxIterations: 3,
    });

    expect(create).toHaveBeenCalledTimes(3);
    expect(result).toBe(FALLBACK);
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

    const result = await runToolLoop(makeHistory(), vi.fn(), onToolEvent, {
      client: client as any,
      tools: [boom] as any,
    });

    expect(result).toBe("ok after error");
    const toolMsg = calls[1].messages.find(
      (m: any) => m.role === "tool" && m.tool_call_id === "call_1"
    );
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toMatch(/error/i);
    expect(onToolEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tool_end", toolCallId: "call_1", isError: true })
    );
  });

  it("d) tool returns an empty string result: handled, final answer returned", async () => {
    const empty = makeTool("empty", () => "");
    const { client, calls } = createFakeClient([
      [toolCallStart(0, "call_1", "empty", "{}"), finish("tool_calls")],
      [text("final"), finish("stop")],
    ]);

    const result = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [empty] as any,
    });

    expect(result).toBe("final");
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

    const result = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
    });

    expect(result).toBe("answer");
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

    const result = await runToolLoop(makeHistory(), onToken, onToolEvent, {
      client: client as any,
    });

    expect(result).toBe("Hi there");
    expect(tokens.join("")).toBe("Hi there");
    expect(onToolEvent).not.toHaveBeenCalled();
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

    const result = await runToolLoop(makeHistory(), vi.fn(), onToolEvent, {
      client: client as any,
      tools: [echo, boom] as any,
    });

    expect(result).toBe("done");

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
  });

  it("i) wall-clock timeout: a hung tool causes runToolLoop to reject", async () => {
    const hang = makeTool("hang", () => new Promise<string>(() => {}));
    const { client } = createFakeClient([[toolCallStart(0, "call_1", "hang", "{}"), finish("tool_calls")]]);

    await expect(
      runToolLoop(makeHistory(), vi.fn(), undefined, {
        client: client as any,
        tools: [hang] as any,
        timeoutMs: 100,
      })
    ).rejects.toThrow();
  }, 5000);

  it("j) final answer contains only final text; resolved string equals what onToken received", async () => {
    const echo = makeTool("echo", () => "ok");
    const { client } = createFakeClient([
      [toolCallStart(0, "call_1", "echo", "{}"), finish("tool_calls")],
      [text("Answer: "), text("42"), finish("stop")],
    ]);
    const tokens: string[] = [];
    const onToken = vi.fn((t: string) => tokens.push(t));

    const result = await runToolLoop(makeHistory(), onToken, undefined, {
      client: client as any,
      tools: [echo] as any,
    });

    expect(result).toBe("Answer: 42");
    expect(tokens.join("")).toBe(result);
    expect(result).not.toMatch(/error/i);
    expect(result).not.toContain("call_1");
  });

  it("k) finish_reason length with pending tool calls: auto-failed as error, loop continues", async () => {
    const echo = makeTool("echo", () => "ok");
    const { client, calls } = createFakeClient([
      [toolCallStart(0, "call_1", "echo", "{}"), finish("length")],
      [text("recovered"), finish("stop")],
    ]);

    const result = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
    });

    expect(result).toBe("recovered");
    expect(echo.execute).not.toHaveBeenCalled();
    const toolMsg = calls[1].messages.find(
      (m: any) => m.role === "tool" && m.tool_call_id === "call_1"
    );
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toMatch(/error/i);
  });
});

describe("DEFAULT_TOOLS", () => {
  it("exposes get_current_datetime and calculator with the Tool shape", () => {
    expect(DEFAULT_TOOLS).toHaveLength(2);
    const names = DEFAULT_TOOLS.map((t) => t.name);
    expect(names).toContain("get_current_datetime");
    expect(names).toContain("calculator");
    for (const tool of DEFAULT_TOOLS) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });
});
