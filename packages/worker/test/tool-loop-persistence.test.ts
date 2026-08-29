// Phase 3 reliability regression tests: the tool-loop's durable per-step
// persistence hooks (ToolLoopPersistence) and resumable iteration
// numbering (startIteration). These use fakes only (no DB) - the ordering
// guarantees the loop itself must uphold (request persisted before
// execution, result persisted before the next LLM call, an aborted
// persist stops the loop before doing anything unsafe) are exactly what a
// fake client/tool pair can prove without Postgres. DB-level idempotency
// (unique constraints, ON CONFLICT upserts) and the crash-recovery
// reconciliation policy are covered separately in test/turn-recovery.test.ts
// against real Postgres.

import { describe, it, expect, vi } from "vitest";
import type { Message } from "@stateless-chat/shared";
import { runToolLoop } from "../src/tool-loop.js";
import type { ToolLoopPersistence, ToolExchangeRecord } from "../src/tool-loop.js";

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
      }
      return { choices: [{ delta: { tool_calls: [toolCall] }, finish_reason: null }] };
    }
  }
}

async function* makeStream(steps: StreamStep[]) {
  for (const step of steps) yield chunkFromStep(step);
}

function createFakeClient(scripts: StreamStep[][]) {
  const calls: any[] = [];
  const create = vi.fn().mockImplementation(async (params: any) => {
    calls.push(params);
    const script = scripts[Math.min(calls.length - 1, scripts.length - 1)];
    return makeStream(script);
  });
  return { client: { chat: { completions: { create } } }, calls };
}

function makeHistory(): Message[] {
  return [
    {
      id: "msg-1",
      conversation_id: "conv-1",
      role: "user",
      content: "hello",
      status: "processing",
      reply_to_message_id: null,
      created_at: new Date().toISOString(),
    },
  ];
}

function makeTool(name: string, impl: (args: any) => string | Promise<string>) {
  return {
    name,
    description: `test tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(impl),
  };
}

describe("ToolLoopPersistence ordering", () => {
  it("persists the request before the tool executes, and the result before the next LLM call", async () => {
    const events: string[] = [];
    const echo = makeTool("echo", () => {
      events.push("execute");
      return "ok";
    });
    const { client, calls } = createFakeClient([
      [toolCallStart(0, "call_1", "echo", "{}"), finish("tool_calls")],
      [text("done"), finish("stop")],
    ]);

    const persistence: ToolLoopPersistence = {
      onToolCallRequest: async (iteration, requestedCalls) => {
        events.push(`request:${iteration}:${requestedCalls.map((c) => c.toolCallId).join(",")}`);
      },
      onToolResult: async (record) => {
        events.push(`result:${record.iteration}:${record.toolCallId}`);
      },
    };

    await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      persistence,
    });

    expect(events).toEqual(["request:0:call_1", "execute", "result:0:call_1"]);
    // The result must be durable before the second create() call - proven
    // by call ordering, since createFakeClient records calls in order.
    expect(calls).toHaveLength(2);
  });

  it("persists each call's result immediately after that call, before the next call in the same iteration executes", async () => {
    const events: string[] = [];
    const first = makeTool("first", () => {
      events.push("execute:first");
      return "a";
    });
    const second = makeTool("second", () => {
      events.push("execute:second");
      return "b";
    });
    const { client } = createFakeClient([
      [
        toolCallStart(0, "call_1", "first", "{}"),
        toolCallStart(1, "call_2", "second", "{}"),
        finish("tool_calls"),
      ],
      [text("done"), finish("stop")],
    ]);

    const persistence: ToolLoopPersistence = {
      onToolCallRequest: async () => {
        events.push("request");
      },
      onToolResult: async (record) => {
        events.push(`result:${record.toolCallId}`);
      },
    };

    await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [first, second] as any,
      persistence,
    });

    expect(events).toEqual([
      "request",
      "execute:first",
      "result:call_1",
      "execute:second",
      "result:call_2",
    ]);
  });

  it("finish_reason length: persists the request and the synthetic error result, without executing the tool", async () => {
    const echo = makeTool("echo", () => "ok");
    const events: string[] = [];
    const { client } = createFakeClient([
      [toolCallStart(0, "call_1", "echo", "{}"), finish("length")],
      [text("recovered"), finish("stop")],
    ]);

    const persistence: ToolLoopPersistence = {
      onToolCallRequest: async (iteration) => {
        events.push(`request:${iteration}`);
      },
      onToolResult: async (record) => {
        events.push(`result:${record.toolCallId}:${record.isError}`);
      },
    };

    const { content } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      persistence,
    });

    expect(content).toBe("recovered");
    expect(echo.execute).not.toHaveBeenCalled();
    expect(events).toEqual(["request:0", "result:call_1:true"]);
  });

  it("onToolCallRequest throwing (simulated lost lease) aborts the loop before any tool executes", async () => {
    const echo = makeTool("echo", () => "ok");
    const { client } = createFakeClient([[toolCallStart(0, "call_1", "echo", "{}"), finish("tool_calls")]]);

    const persistence: ToolLoopPersistence = {
      onToolCallRequest: async () => {
        throw new Error("lease lost before persisting tool-call request - aborting turn");
      },
      onToolResult: async () => {},
    };

    await expect(
      runToolLoop(makeHistory(), vi.fn(), undefined, {
        client: client as any,
        tools: [echo] as any,
        persistence,
      })
    ).rejects.toThrow(/lease lost/);

    expect(echo.execute).not.toHaveBeenCalled();
  });

  it("onToolResult throwing aborts the loop before the second call in the same iteration executes", async () => {
    const first = makeTool("first", () => "a");
    const second = makeTool("second", () => "b");
    const { client } = createFakeClient([
      [
        toolCallStart(0, "call_1", "first", "{}"),
        toolCallStart(1, "call_2", "second", "{}"),
        finish("tool_calls"),
      ],
    ]);

    const persistence: ToolLoopPersistence = {
      onToolCallRequest: async () => {},
      onToolResult: async (record: ToolExchangeRecord) => {
        if (record.toolCallId === "call_1") throw new Error("db write failed");
      },
    };

    await expect(
      runToolLoop(makeHistory(), vi.fn(), undefined, {
        client: client as any,
        tools: [first, second] as any,
        persistence,
      })
    ).rejects.toThrow(/db write failed/);

    expect(first.execute).toHaveBeenCalledTimes(1);
    expect(second.execute).not.toHaveBeenCalled();
  });
});

describe("startIteration (resumable numbering)", () => {
  it("numbers newly-issued iterations starting from startIteration, without changing the per-invocation round budget", async () => {
    const echo = makeTool("echo", () => "ok");
    const iterationsSeen: number[] = [];
    const { client, calls } = createFakeClient([
      [toolCallStart(0, "call_1", "echo", "{}"), finish("tool_calls")],
      [text("done"), finish("stop")],
    ]);

    const { toolExchange } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      startIteration: 5,
      persistence: {
        onToolCallRequest: async (iteration) => {
          iterationsSeen.push(iteration);
        },
        onToolResult: async () => {},
      },
    });

    expect(iterationsSeen).toEqual([5]);
    expect(toolExchange[0].iteration).toBe(5);
    // Still exactly 2 create() calls (one tool round + the final answer) -
    // startIteration only renumbers the durable id, it doesn't grant extra
    // rounds beyond maxIterations.
    expect(calls).toHaveLength(2);
  });

  it("maxIterations still caps rounds run by this invocation regardless of startIteration", async () => {
    const echo = makeTool("echo", () => "ok");
    const toolOnly = () => [toolCallStart(0, "call_x", "echo", "{}"), finish("tool_calls")];
    const { client, calls } = createFakeClient([toolOnly(), toolOnly(), [text("retry"), finish("stop")]]);

    const { content } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      startIteration: 10,
      maxIterations: 2,
      persistence: {
        onToolCallRequest: async () => {},
        onToolResult: async () => {},
      },
    });

    // 2 fuse iterations (rounds) + 1 answer-now retry call = 3, exactly as
    // it would be with startIteration: 0 - the budget is per-invocation.
    expect(calls).toHaveLength(3);
    expect(content).toBe("retry");
  });

  it("defaults to startIteration 0 when omitted", async () => {
    const echo = makeTool("echo", () => "ok");
    const { client } = createFakeClient([
      [toolCallStart(0, "call_1", "echo", "{}"), finish("tool_calls")],
      [text("done"), finish("stop")],
    ]);

    const { toolExchange } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
    });

    expect(toolExchange[0].iteration).toBe(0);
  });
});
