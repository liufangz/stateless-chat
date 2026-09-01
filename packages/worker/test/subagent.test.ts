import { describe, it, expect, vi } from "vitest";
import type { Message } from "@stateless-chat/shared";
import { runToolLoop } from "../src/tool-loop.js";
import { Lifecycle } from "../src/lifecycle.js";
import type { AgentEvent } from "../src/lifecycle.js";
import { createSubagentTool, MAX_SUBAGENT_DEPTH } from "../src/tools/subagent.js";
import type { Tool } from "../src/tool-loop.js";

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible streaming client (mirrors lifecycle.test.ts)
// ---------------------------------------------------------------------------

type StreamStep =
  | { kind: "text"; content: string }
  | { kind: "tool_call"; index: number; id?: string; name?: string; argsFragment?: string }
  | { kind: "finish"; reason: "tool_calls" | "stop" | "length" };

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

function makeHistory(content = "parent question"): Message[] {
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

function makeTool(name: string, impl: (args: any) => string | Promise<string>): Tool {
  return {
    name,
    description: `test tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(impl),
  };
}

function collectEvents(lifecycle: Lifecycle): AgentEvent[] {
  const events: AgentEvent[] = [];
  lifecycle.on((e) => void events.push(e));
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("subagent tool", () => {
  it("runs a nested tool loop and returns the child's final answer as the result", async () => {
    // Child: one tool call to `echo`, then a final answer.
    const echo = makeTool("echo", (args) => `echo:${args.value}`);
    const childClient = createFakeClient([
      [toolCall(0, "child_call_1", "echo", '{"value":"hi"}'), finish("tool_calls")],
      [text("Child final answer"), finish("stop")],
    ]);

    // Parent lifecycle: child events get forwarded into it.
    const parentLifecycle = new Lifecycle();
    const events = collectEvents(parentLifecycle);

    const subagent = createSubagentTool({
      client: childClient.client as any,
      lifecycle: parentLifecycle,
      tools: [echo],
      timeoutMs: 60_000,
    });

    // Parent: call subagent, then answer.
    const parentClient = createFakeClient([
      [
        toolCall(0, "parent_call_1", "subagent", '{"task":"Do the thing","tools":["echo"]}'),
        finish("tool_calls"),
      ],
      [text("Parent done"), finish("stop")],
    ]);

    const { content, toolExchange } = await runToolLoop(
      makeHistory(),
      vi.fn(),
      undefined,
      {
        client: parentClient.client as any,
        tools: [subagent],
        lifecycle: parentLifecycle,
      }
    );

    expect(content).toBe("Parent done");
    expect(toolExchange).toHaveLength(1);
    expect(toolExchange[0].toolName).toBe("subagent");
    expect(toolExchange[0].isError).toBe(false);
    // Result contains the child's final answer plus a step count header.
    expect(toolExchange[0].result).toContain("Child final answer");
    expect(toolExchange[0].result).toContain("1 tool steps");

    // Child events were forwarded to the parent lifecycle, tagged per run.
    const childToolStart = events.find(
      (e) => e.type === "tool_execution_start" && (e as any).subagentRunId
    );
    expect(childToolStart).toBeDefined();
    expect((childToolStart as any).toolName).toBe("echo");

    // Progress update fired on the parent lifecycle after the child step.
    const update = events.find((e) => e.type === "tool_execution_update") as any;
    expect(update).toBeDefined();
    expect(update.toolName).toBe("subagent");
    expect(update.partialResult.step).toBe(1);
    expect(update.partialResult.status).toBe("running");

    // The child's tokens were not streamed to the parent's onToken.
    const childCall = childClient.calls[0];
    const parentCall = parentClient.calls[0];
    expect(childCall).toBeDefined();
    expect(parentCall).toBeDefined();
  });

  it("passes the self-contained task (plus context) as the child's only user message", async () => {
    const childClient = createFakeClient([[text("ok"), finish("stop")]]);
    const subagent = createSubagentTool({
      client: childClient.client as any,
      tools: [],
      timeoutMs: 60_000,
    });

    await subagent.execute({ task: "TASK", context: "CTX" });

    const childMessages = childClient.calls[0].messages;
    expect(childMessages).toHaveLength(2); // system + user
    expect(childMessages[0].role).toBe("system");
    expect(childMessages[1].role).toBe("user");
    expect(childMessages[1].content).toContain("TASK");
    expect(childMessages[1].content).toContain("CTX");
  });

  it("restricts the child to the requested tool allowlist", async () => {
    const echo = makeTool("echo", (args) => `echo:${args.value}`);
    const other = makeTool("other", () => "nope");
    const childClient = createFakeClient([
      [toolCall(0, "c1", "echo", '{"value":"x"}'), finish("tool_calls")],
      [text("done"), finish("stop")],
    ]);
    const subagent = createSubagentTool({
      client: childClient.client as any,
      tools: [echo, other],
      timeoutMs: 60_000,
    });

    const result = await subagent.execute({ task: "t", tools: ["echo"] });
    expect(result).toContain("done");
    expect(echo.execute).toHaveBeenCalled();
    expect(other.execute).not.toHaveBeenCalled();
  });

  it("refuses to nest beyond the depth limit without calling the LLM", async () => {
    const childClient = createFakeClient([[text("never"), finish("stop")]]);
    const subagent = createSubagentTool({
      client: childClient.client as any,
      tools: [],
      depth: MAX_SUBAGENT_DEPTH,
      timeoutMs: 60_000,
    });

    const result = await subagent.execute({ task: "deep" });
    expect(result).toContain("depth limit");
    expect(childClient.calls).toHaveLength(0);
  });

  it("throws on a missing/empty task", async () => {
    const subagent = createSubagentTool({ tools: [] });
    await expect(subagent.execute({})).rejects.toThrow(/task/);
    await expect(subagent.execute({ task: "   " })).rejects.toThrow(/task/);
  });

  it("never includes the subagent tool in the child's default allowlist", async () => {
    // The static DEFAULT_TOOLS entry is a subagent; the child default list
    // must exclude it to prevent recursion.
    const childClient = createFakeClient([[text("ok"), finish("stop")]]);
    const subagent = createSubagentTool({ client: childClient.client as any, timeoutMs: 60_000 });
    await subagent.execute({ task: "t" });

    const childMessages = childClient.calls[0].messages;
    const toolNames = (childClient.calls[0].tools ?? []).map((t: any) => t.function.name);
    expect(toolNames).not.toContain("subagent");
    expect(childMessages).toHaveLength(2);
  });
});
