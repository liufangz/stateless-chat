import { describe, it, expect, vi } from "vitest";
import type { Message } from "@stateless-chat/shared";
import { runToolLoop, DEFAULT_TOOLS } from "../src/tool-loop.js";
import { Lifecycle, createLoggingHooks, createMessageSignalLogger } from "../src/lifecycle.js";
import type { AgentEvent, LifecycleMessage } from "../src/lifecycle.js";

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible streaming client (mirrors tool-loop.test.ts)
// ---------------------------------------------------------------------------

type StreamStep =
  | { kind: "text"; content: string }
  | { kind: "tool_call"; index: number; id?: string; name?: string; argsFragment?: string }
  | { kind: "finish"; reason: "tool_calls" | "stop" | "length" }
  | { kind: "usage"; usage: { prompt_tokens: number; completion_tokens: number } };

function text(content: string): StreamStep {
  return { kind: "text", content };
}

function toolCall(index: number, id: string, name: string, argsFragment = ""): StreamStep {
  return { kind: "tool_call", index, id, name, argsFragment };
}

function finish(reason: "tool_calls" | "stop" | "length"): StreamStep {
  return { kind: "finish", reason };
}

function chunkFromStep(step: StreamStep) {
  switch (step.kind) {
    case "finish":
      return { choices: [{ delta: {}, finish_reason: step.reason }] };
    case "usage":
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
  for (const step of steps) yield chunkFromStep(step);
}

function createFakeClient(scripts: StreamStep[][]) {
  const calls: any[] = [];
  const create = vi.fn().mockImplementation(async (params: any) => {
    calls.push(params);
    const script = scripts[Math.min(calls.length - 1, scripts.length - 1)];
    return makeStream(script);
  });
  return { client: { chat: { completions: { create } } }, calls, create };
}

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

function collectEvents(lifecycle: Lifecycle): AgentEvent[] {
  const events: AgentEvent[] = [];
  lifecycle.on((e) => void events.push(e));
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pi-style lifecycle", () => {
  it("emits turn/message/tool events in pi's order for a tool-call turn", async () => {
    const echo = makeTool("echo", (args) => `echo:${args.value}`);
    const { client } = createFakeClient([
      [toolCall(0, "call_1", "echo", '{"value":"hi"}'), finish("tool_calls")],
      [text("Done"), finish("stop")],
    ]);
    const lifecycle = new Lifecycle();
    const events = collectEvents(lifecycle);

    const { content, toolExchange } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      lifecycle,
    });

    expect(content).toBe("Done");
    expect(toolExchange).toHaveLength(1);
    expect(toolExchange[0].result).toBe("echo:hi");
    // Types, in order: turn_start -> assistant msg (tool-only) ->
    // tool_execution_start/end -> tool result msg -> second assistant msg
    // (streamed text) -> turn_end.
    expect(events.map((e) => e.type)).toEqual([
      "turn_start",
      "message_start",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "message_start",
      "message_end",
      "message_start",
      "message_update",
      "message_end",
      "turn_end",
    ]);

    const [turnStart, ...rest] = events;
    expect(turnStart).toEqual({ type: "turn_start" });

    const assistantStart = rest[0] as Extract<AgentEvent, { type: "message_start" }>;
    expect(assistantStart.message.role).toBe("assistant");
    expect(assistantStart.message.toolCalls).toEqual([
      { id: "call_1", name: "echo", arguments: '{"value":"hi"}' },
    ]);

    const toolExecStart = rest[2] as Extract<AgentEvent, { type: "tool_execution_start" }>;
    expect(toolExecStart).toMatchObject({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "echo",
      args: { value: "hi" },
    });

    const toolExecEnd = rest[3] as Extract<AgentEvent, { type: "tool_execution_end" }>;
    expect(toolExecEnd).toMatchObject({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "echo",
      result: "echo:hi",
      isError: false,
    });

    const toolMsg = rest[4] as Extract<AgentEvent, { type: "message_start" }>;
    expect(toolMsg.message).toEqual({ role: "tool", content: "echo:hi", toolCallId: "call_1" });

    const update = events[8] as Extract<AgentEvent, { type: "message_update" }>;
    expect(update.contentDelta).toBe("Done");
    expect(update.message.content).toBe("Done");

    const turnEnd = events[10] as Extract<AgentEvent, { type: "turn_end" }>;
    expect(turnEnd.message).toEqual({ role: "assistant", content: "Done" });
    expect(turnEnd.toolResults).toHaveLength(1);
  });

  it("beforeToolCall can veto a call (tool never executes, call fails)", async () => {
    const echo = makeTool("echo", () => "should not run");
    const { client } = createFakeClient([
      [toolCall(0, "call_1", "echo", "{}"), finish("tool_calls")],
      [text("Recovered"), finish("stop")],
    ]);
    const lifecycle = new Lifecycle();
    const events = collectEvents(lifecycle);

    const { content, toolExchange } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      lifecycle,
      hooks: {
        beforeToolCall: async ({ toolName }) => {
          if (toolName === "echo") return { stop: true, reason: "echo is banned" };
          return undefined;
        },
      },
    });

    expect(echo.execute).not.toHaveBeenCalled();
    expect(content).toBe("Recovered");
    expect(toolExchange[0]).toMatchObject({
      toolName: "echo",
      result: "Error: echo is banned",
      isError: true,
    });
    const execEnd = events.find((e) => e.type === "tool_execution_end") as Extract<
      AgentEvent,
      { type: "tool_execution_end" }
    >;
    expect(execEnd.isError).toBe(true);
    expect(execEnd.result).toBe("Error: echo is banned");
  });

  it("beforeToolCall patches args and afterToolCall patches the result", async () => {
    const echo = makeTool("echo", (args) => `got:${args.value}`);
    const { client } = createFakeClient([
      [toolCall(0, "call_1", "echo", '{"value":"original"}'), finish("tool_calls")],
      [text("Done"), finish("stop")],
    ]);
    const lifecycle = new Lifecycle();
    const events = collectEvents(lifecycle);

    const { toolExchange } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      lifecycle,
      hooks: {
        beforeToolCall: async () => ({ args: { value: "patched" } }),
        afterToolCall: async () => ({ result: "rewritten by hook" }),
      },
    });

    // Executed with the patched args...
    expect(echo.execute).toHaveBeenCalledWith({ value: "patched" });
    // ...but the result the model saw was rewritten by afterToolCall.
    expect(toolExchange[0]).toMatchObject({ args: { value: "patched" }, result: "rewritten by hook" });
    const execEnd = events.find((e) => e.type === "tool_execution_end") as Extract<
      AgentEvent,
      { type: "tool_execution_end" }
    >;
    expect(execEnd.result).toBe("rewritten by hook");
    expect(execEnd.isError).toBe(false);
  });

  it("shouldStopAfterTurn stops the loop and routes through the answer-now wrap-up", async () => {
    const echo = makeTool("echo", () => "ok");
    const { client, calls } = createFakeClient([
      [toolCall(0, "call_1", "echo", "{}"), finish("tool_calls")],
      [text("wrapped up"), finish("stop")],
    ]);
    const lifecycle = new Lifecycle();

    const { content } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      lifecycle,
      hooks: {
        shouldStopAfterTurn: async () => true,
      },
    });

    expect(content).toBe("wrapped up");
    // Two create calls: the initial tool-call iteration, then the
    // answer-now retry (no further tool iterations).
    expect(calls).toHaveLength(2);
  });

  it("prepareNextTurn injects context before the next iteration", async () => {
    const echo = makeTool("echo", () => "ok");
    const { client, calls } = createFakeClient([
      [toolCall(0, "call_1", "echo", "{}"), finish("tool_calls")],
      [text("Done"), finish("stop")],
    ]);
    const lifecycle = new Lifecycle();

    const { content } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      lifecycle,
      hooks: {
        prepareNextTurn: async () => [
          { role: "user", content: "context injected by prepareNextTurn" } satisfies LifecycleMessage,
        ],
      },
    });

    expect(content).toBe("Done");
    expect(calls).toHaveLength(2);
    expect(calls[1].messages.some((m: any) => m.content === "context injected by prepareNextTurn")).toBe(
      true
    );
  });

  it("listeners are awaited in subscription order and a throwing listener fails the turn (pi settlement)", async () => {
    const lifecycle = new Lifecycle();
    const order: string[] = [];
    lifecycle.on(async () => {
      order.push("first");
    });
    lifecycle.on(async () => {
      order.push("second");
      throw new Error("listener failed");
    });
    const { client } = createFakeClient([[text("Done"), finish("stop")]]);

    await expect(
      runToolLoop(makeHistory(), vi.fn(), undefined, {
        client: client as any,
        lifecycle,
      })
    ).rejects.toThrow("listener failed");

    // The first listener ran and settled before the second one threw.
    expect(order).toEqual(["first", "second"]);
  });

  it("shouldStopAfterTurn and prepareNextTurn are not invoked on the first iteration", async () => {
    const { client } = createFakeClient([[text("Done"), finish("stop")]]);
    const lifecycle = new Lifecycle();
    const shouldStopAfterTurn = vi.fn().mockResolvedValue(false);
    const prepareNextTurn = vi.fn().mockResolvedValue(undefined);

    const { content } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      lifecycle,
      hooks: { shouldStopAfterTurn, prepareNextTurn },
    });

    // No tool calls in the single iteration, so the loop returns before ever
    // reaching round 1 - both hooks are gated on `round > 0`.
    expect(content).toBe("Done");
    expect(shouldStopAfterTurn).not.toHaveBeenCalled();
    expect(prepareNextTurn).not.toHaveBeenCalled();
  });

  it("afterToolCall is not called when the tool itself errors (only beforeToolCall runs)", async () => {
    const failing = makeTool("failing", () => {
      throw new Error("boom");
    });
    const { client } = createFakeClient([
      [toolCall(0, "call_1", "failing", "{}"), finish("tool_calls")],
      [text("Recovered"), finish("stop")],
    ]);
    const lifecycle = new Lifecycle();
    const beforeToolCall = vi.fn().mockResolvedValue(undefined);
    const afterToolCall = vi.fn();

    const { toolExchange } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [failing] as any,
      lifecycle,
      hooks: { beforeToolCall, afterToolCall },
    });

    expect(toolExchange[0].isError).toBe(true);
    expect(beforeToolCall).toHaveBeenCalledTimes(1);
    expect(afterToolCall).not.toHaveBeenCalled();
  });

  it("beforeToolCall veto also skips afterToolCall entirely", async () => {
    const echo = makeTool("echo", () => "should not run");
    const { client } = createFakeClient([
      [toolCall(0, "call_1", "echo", "{}"), finish("tool_calls")],
      [text("Recovered"), finish("stop")],
    ]);
    const lifecycle = new Lifecycle();
    const afterToolCall = vi.fn();

    await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      lifecycle,
      hooks: {
        beforeToolCall: async () => ({ stop: true, reason: "vetoed" }),
        afterToolCall,
      },
    });

    expect(echo.execute).not.toHaveBeenCalled();
    expect(afterToolCall).not.toHaveBeenCalled();
  });

  it("beforeToolCall returning undefined (or an empty object) runs the tool unmodified", async () => {
    const echo = makeTool("echo", (args) => `echo:${args.value}`);
    const { client } = createFakeClient([
      [toolCall(0, "call_1", "echo", '{"value":"hi"}'), finish("tool_calls")],
      [text("Done"), finish("stop")],
    ]);
    const lifecycle = new Lifecycle();

    const { toolExchange } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      lifecycle,
      hooks: { beforeToolCall: async () => ({}) },
    });

    expect(echo.execute).toHaveBeenCalledWith({ value: "hi" });
    expect(toolExchange[0]).toMatchObject({ args: { value: "hi" }, result: "echo:hi", isError: false });
  });

  it("beforeToolCall/afterToolCall apply independently per tool call in the same iteration", async () => {
    const echo = makeTool("echo", (args) => `echo:${args.value}`);
    const boom = makeTool("boom", () => "should not run");
    const { client } = createFakeClient([
      [
        toolCall(0, "call_1", "echo", '{"value":"hi"}'),
        toolCall(1, "call_2", "boom", "{}"),
        finish("tool_calls"),
      ],
      [text("Done"), finish("stop")],
    ]);
    const lifecycle = new Lifecycle();

    const { toolExchange } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo, boom] as any,
      lifecycle,
      hooks: {
        beforeToolCall: async ({ toolName }) =>
          toolName === "boom" ? { stop: true, reason: "boom is banned" } : undefined,
      },
    });

    expect(boom.execute).not.toHaveBeenCalled();
    expect(echo.execute).toHaveBeenCalledWith({ value: "hi" });
    expect(toolExchange).toHaveLength(2);
    expect(toolExchange.find((t) => t.toolName === "echo")).toMatchObject({
      result: "echo:hi",
      isError: false,
    });
    expect(toolExchange.find((t) => t.toolName === "boom")).toMatchObject({
      result: "Error: boom is banned",
      isError: true,
    });
  });

  it("shouldStopAfterTurn stopping the loop skips prepareNextTurn for that same round", async () => {
    const echo = makeTool("echo", () => "ok");
    const { client, calls } = createFakeClient([
      [toolCall(0, "call_1", "echo", "{}"), finish("tool_calls")],
      [text("wrapped up"), finish("stop")],
    ]);
    const lifecycle = new Lifecycle();
    const prepareNextTurn = vi.fn().mockResolvedValue(undefined);

    const { content } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      lifecycle,
      hooks: {
        shouldStopAfterTurn: async () => true,
        prepareNextTurn,
      },
    });

    expect(content).toBe("wrapped up");
    expect(calls).toHaveLength(2);
    expect(prepareNextTurn).not.toHaveBeenCalled();
  });

  it("shouldStopAfterTurn and prepareNextTurn receive correct context (iteration/lastAssistantText/toolExchange/nextIteration/messages)", async () => {
    const echo = makeTool("echo", () => "ok");
    const { client } = createFakeClient([
      [text("thinking out loud"), toolCall(0, "call_1", "echo", "{}"), finish("tool_calls")],
      [text("Done"), finish("stop")],
    ]);
    const lifecycle = new Lifecycle();
    const stopContexts: any[] = [];
    const prepareContexts: any[] = [];

    await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      lifecycle,
      startIteration: 5,
      hooks: {
        shouldStopAfterTurn: async (ctx) => {
          stopContexts.push(ctx);
          return false;
        },
        prepareNextTurn: async (ctx) => {
          prepareContexts.push(ctx);
          return undefined;
        },
      },
    });

    // Round 1 is the first round hooks fire on (round 0 is never checked);
    // durable iteration = startIteration + round = 5 + 1 = 6.
    expect(stopContexts).toHaveLength(1);
    expect(stopContexts[0].iteration).toBe(6);
    expect(stopContexts[0].lastAssistantText).toBe("thinking out loud");
    expect(stopContexts[0].toolExchange).toHaveLength(1);
    expect(stopContexts[0].toolExchange[0].toolName).toBe("echo");

    expect(prepareContexts).toHaveLength(1);
    expect(prepareContexts[0].iteration).toBe(6);
    expect(prepareContexts[0].nextIteration).toBe(7);
    // Messages passed to prepareNextTurn are the loop's own history so far,
    // converted to LifecycleMessage shape (user seed + assistant turns +
    // tool result), not just the latest turn.
    expect(prepareContexts[0].messages.some((m: LifecycleMessage) => m.role === "user")).toBe(true);
    expect(prepareContexts[0].messages.some((m: LifecycleMessage) => m.role === "tool")).toBe(true);
  });

  it("a throwing beforeToolCall hook propagates and aborts the turn", async () => {
    const echo = makeTool("echo", () => "ok");
    const { client } = createFakeClient([[toolCall(0, "call_1", "echo", "{}"), finish("tool_calls")]]);
    const lifecycle = new Lifecycle();

    await expect(
      runToolLoop(makeHistory(), vi.fn(), undefined, {
        client: client as any,
        tools: [echo] as any,
        lifecycle,
        hooks: {
          beforeToolCall: async () => {
            throw new Error("hook exploded");
          },
        },
      })
    ).rejects.toThrow("hook exploded");

    expect(echo.execute).not.toHaveBeenCalled();
  });

  it("a truncated tool call (finish_reason length) bypasses beforeToolCall/afterToolCall entirely", async () => {
    const echo = makeTool("echo", () => "should not run");
    const { client } = createFakeClient([
      [toolCall(0, "call_1", "echo", '{"value":'), finish("length")],
      [text("Recovered"), finish("stop")],
    ]);
    const lifecycle = new Lifecycle();
    const beforeToolCall = vi.fn();
    const afterToolCall = vi.fn();

    const { toolExchange } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      lifecycle,
      hooks: { beforeToolCall, afterToolCall },
    });

    expect(echo.execute).not.toHaveBeenCalled();
    expect(beforeToolCall).not.toHaveBeenCalled();
    expect(afterToolCall).not.toHaveBeenCalled();
    expect(toolExchange[0].isError).toBe(true);
    expect(toolExchange[0].result).toMatch(/truncated/);
  });
});

// ---------------------------------------------------------------------------
// createLoggingHooks - the logging hook implementation actually wired into
// worker/index.ts's runToolLoop call.
// ---------------------------------------------------------------------------

describe("createLoggingHooks", () => {
  it("beforeToolCall logs the call and passes it through unmodified", async () => {
    const log = vi.fn();
    const hooks = createLoggingHooks(log);

    const result = await hooks.beforeToolCall!({
      toolCallId: "call_1",
      toolName: "echo",
      args: { value: "hi" },
    });

    expect(result).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("beforeToolCall");
    expect(log.mock.calls[0][0]).toContain("echo");
    expect(log.mock.calls[0][0]).toContain("call_1");
    expect(log.mock.calls[0][1]).toEqual({ value: "hi" });
  });

  it("afterToolCall logs the outcome and passes the result through unmodified", async () => {
    const log = vi.fn();
    const hooks = createLoggingHooks(log);

    const result = await hooks.afterToolCall!({
      toolCallId: "call_1",
      toolName: "echo",
      args: { value: "hi" },
      result: "echo:hi",
      isError: false,
    });

    expect(result).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    const [msg] = log.mock.calls[0];
    expect(msg).toContain("afterToolCall");
    expect(msg).toContain("echo");
    expect(msg).toContain("7 chars"); // "echo:hi".length
    expect(msg).toContain("isError=false");
  });

  it("shouldStopAfterTurn logs the iteration and never stops the loop", async () => {
    const log = vi.fn();
    const hooks = createLoggingHooks(log);

    const stop = await hooks.shouldStopAfterTurn!({
      iteration: 3,
      lastAssistantText: "thinking",
      toolExchange: [{ iteration: 2, toolCallId: "c1", toolName: "echo", arguments: "{}", result: "ok", isError: false }],
    });

    expect(stop).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    const [msg] = log.mock.calls[0];
    expect(msg).toContain("shouldStopAfterTurn");
    expect(msg).toContain("iteration=3");
    expect(msg).toContain("toolCallsSoFar=1");
  });

  it("prepareNextTurn logs the iteration and injects nothing", async () => {
    const log = vi.fn();
    const hooks = createLoggingHooks(log);

    const injected = await hooks.prepareNextTurn!({
      iteration: 3,
      nextIteration: 4,
      messages: [],
    });

    expect(injected).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    const [msg] = log.mock.calls[0];
    expect(msg).toContain("prepareNextTurn");
    expect(msg).toContain("iteration=3");
    expect(msg).toContain("nextIteration=4");
  });

  it("wired into a real tool-call turn via runToolLoop: fires for every tool call/iteration and changes nothing about the result", async () => {
    const echo = makeTool("echo", (args) => `echo:${args.value}`);
    const scripts = [
      [toolCall(0, "call_1", "echo", '{"value":"hi"}'), finish("tool_calls")],
      [text("Done"), finish("stop")],
    ];

    // Baseline run with no hooks at all, to prove the logging hooks are
    // non-invasive (identical content/toolExchange with hooks attached).
    const { client: baselineClient } = createFakeClient(scripts);
    const baseline = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: baselineClient as any,
      tools: [echo] as any,
    });

    const log = vi.fn();
    const { client } = createFakeClient(scripts);
    const { content, toolExchange } = await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      hooks: createLoggingHooks(log),
    });

    expect(content).toBe(baseline.content);
    expect(toolExchange).toEqual(baseline.toolExchange);

    const messages = log.mock.calls.map((c) => c[0] as string);
    // beforeToolCall + afterToolCall fire once for the single tool call;
    // shouldStopAfterTurn/prepareNextTurn only fire from round 1 onward,
    // and this turn resolves on round 1 (a plain "Done" reply, no more
    // tool calls), so both fire exactly once too.
    expect(messages.filter((m) => m.includes("beforeToolCall"))).toHaveLength(1);
    expect(messages.filter((m) => m.includes("afterToolCall"))).toHaveLength(1);
    expect(messages.filter((m) => m.includes("shouldStopAfterTurn"))).toHaveLength(1);
    expect(messages.filter((m) => m.includes("prepareNextTurn"))).toHaveLength(1);
    // beforeToolCall must run before afterToolCall for the same call.
    expect(messages.indexOf(messages.find((m) => m.includes("beforeToolCall"))!)).toBeLessThan(
      messages.indexOf(messages.find((m) => m.includes("afterToolCall"))!)
    );
  });
});

// ---------------------------------------------------------------------------
// createMessageSignalLogger - example listener that signals on real
// (non-tool-result) messages only.
// ---------------------------------------------------------------------------

describe("createMessageSignalLogger", () => {
  it("logs the final assistant message but skips the tool-result message", async () => {
    const log = vi.fn();
    const lifecycle = new Lifecycle();
    lifecycle.on(createMessageSignalLogger(log));

    const echo = makeTool("echo", () => "tool output, should never be logged as a signal");
    const { client } = createFakeClient([
      [toolCall(0, "call_1", "echo", "{}"), finish("tool_calls")],
      [text("final answer"), finish("stop")],
    ]);

    await runToolLoop(makeHistory(), vi.fn(), undefined, {
      client: client as any,
      tools: [echo] as any,
      lifecycle,
    });

    const messages = log.mock.calls.map((c) => c.join(" "));
    // Three message_end events fire in this turn: the tool-only assistant
    // message (content null, requests the call), the tool-result message,
    // and the final text assistant message. Only the two assistant ones
    // should signal - the tool-result one must be skipped.
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.includes("role=assistant"))).toBe(true);
    expect(messages.some((m) => m.includes("final answer"))).toBe(true);
    expect(messages.some((m) => m.includes("tool output"))).toBe(false);
  });

  it("logs nothing for a turn with no tool calls at all except the one final message", async () => {
    const log = vi.fn();
    const lifecycle = new Lifecycle();
    lifecycle.on(createMessageSignalLogger(log));
    const { client } = createFakeClient([[text("just an answer"), finish("stop")]]);

    await runToolLoop(makeHistory(), vi.fn(), undefined, { client: client as any, lifecycle });

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe('[signal] message: role=assistant chars=14 "just an answer"');
  });
});
