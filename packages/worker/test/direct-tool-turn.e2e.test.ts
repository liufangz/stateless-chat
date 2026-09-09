// End-to-end test of runDirectToolTurn against real Postgres, same
// convention as crash-recovery.e2e.test.ts / turn-recovery.test.ts.
//
//   DATABASE_URL=postgres://chat:chat@localhost:5433/chat_test \
//     npx vitest run packages/worker/test/direct-tool-turn.e2e.test.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  env,
  createPool,
  initSchema,
  createConversation,
  insertUserMessage,
  claimPendingMessages,
  getMessage,
  getMessagesByReplyTo,
} from "@stateless-chat/shared";
import type { Message } from "@stateless-chat/shared";
import { parseDirectInvocation, runDirectToolTurn } from "../src/direct-tool.js";
import type { Tool } from "../src/tool-loop.js";
import { requireDisposableTestDatabase } from "./support/require-test-database.js";

requireDisposableTestDatabase(env.databaseUrl);

const pool = createPool();

beforeAll(async () => {
  await initSchema(pool);
  await pool.query("TRUNCATE messages, conversations RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await pool.end();
});

const CALCULATOR_PARAMS = {
  type: "object" as const,
  properties: { expression: { type: "string", description: "test" } },
  required: ["expression"],
};

function makeCalculatorTool(impl: (args: { expression?: unknown }) => string): Tool {
  return {
    name: "calculator",
    description: "test",
    parameters: CALCULATOR_PARAMS,
    readOnly: true,
    execute: impl as Tool["execute"],
  };
}

// Claims the row the same way the worker's real claim loop does, so
// stillOwnsLease (checked internally by runDirectToolTurn) sees a match -
// runDirectToolTurn always checks against env.workerId, not an injectable
// id, so tests claim with that same singleton to stay consistent with it.
async function claimedTurn(content: string): Promise<Message> {
  const conv = await createConversation(pool, "test-client");
  await insertUserMessage(pool, conv.id, content);
  const [claimed] = await claimPendingMessages(pool, env.workerId, 60_000, 1);
  return claimed;
}

function fakePublisher() {
  const published: { channel: string; event: Record<string, unknown> }[] = [];
  return {
    published,
    publish: async (channel: string, message: string) => {
      published.push({ channel, event: JSON.parse(message) });
    },
  };
}

describe("runDirectToolTurn", () => {
  it("persists request+result rows, marks the message done, and publishes tool_start/tool_end/done with empty content - no LLM follow-up row", async () => {
    const message = await claimedTurn("/calculator 1+1");
    const calculatorTool = makeCalculatorTool((args) => (args.expression === "1+1" ? "2" : "?"));
    const toolsByName = new Map([["calculator", calculatorTool]]);
    const invocation = parseDirectInvocation(message.content)!;
    const publisher = fakePublisher();

    await runDirectToolTurn(pool, message, "chan", publisher, toolsByName, invocation, () => {});

    const rows = await getMessagesByReplyTo(pool, message.id);
    const requestRow = rows.find((r) => r.role === "assistant" && r.tool_calls && r.tool_calls.length > 0);
    expect(requestRow).toBeDefined();
    expect(requestRow!.tool_calls![0]).toMatchObject({ name: "calculator", arguments: '{"expression":"1+1"}' });

    const resultRow = rows.find((r) => r.role === "tool");
    expect(resultRow).toBeDefined();
    expect(resultRow!.content).toBe("2");
    expect(resultRow!.tool_is_error).toBe(false);

    // "One result is the whole turn": never a plain final-text assistant row.
    const finalTextRow = rows.find((r) => r.role === "assistant" && (!r.tool_calls || r.tool_calls.length === 0));
    expect(finalTextRow).toBeUndefined();

    const updated = await getMessage(pool, message.id);
    expect(updated!.status).toBe("done");

    expect(publisher.published.map((p) => p.event.type)).toEqual(["tool_start", "tool_end", "done"]);
    const doneEvent = publisher.published.find((p) => p.event.type === "done")!.event;
    expect(doneEvent).toMatchObject({ content: "", usage: null, speedTps: null, durationMs: null });
  });

  it("a tool that throws still completes the turn - isError result row and a done event, not a failed message", async () => {
    const message = await claimedTurn("/calculator nope");
    const throwingTool = makeCalculatorTool(() => {
      throw new Error("bad expression");
    });
    const toolsByName = new Map([["calculator", throwingTool]]);
    const invocation = parseDirectInvocation(message.content)!;
    const publisher = fakePublisher();

    await runDirectToolTurn(pool, message, "chan", publisher, toolsByName, invocation, () => {});

    const rows = await getMessagesByReplyTo(pool, message.id);
    const resultRow = rows.find((r) => r.role === "tool");
    expect(resultRow!.tool_is_error).toBe(true);
    expect(resultRow!.content).toMatch(/bad expression/);

    const updated = await getMessage(pool, message.id);
    expect(updated!.status).toBe("done");

    const events = publisher.published.map((p) => p.event.type);
    expect(events).toContain("done");
    const toolEnd = publisher.published.find((p) => p.event.type === "tool_end")!.event;
    expect(toolEnd.isError).toBe(true);
  });

  it("resolves argsText via the single-arg shorthand for a plain (non-JSON) trailing text", async () => {
    const message = await claimedTurn("/calculator (2 + 3) * 4");
    let capturedArgs: unknown;
    const calculatorTool = makeCalculatorTool((args) => {
      capturedArgs = args;
      return "20";
    });
    const toolsByName = new Map([["calculator", calculatorTool]]);
    const invocation = parseDirectInvocation(message.content)!;
    const publisher = fakePublisher();

    await runDirectToolTurn(pool, message, "chan", publisher, toolsByName, invocation, () => {});

    expect(capturedArgs).toEqual({ expression: "(2 + 3) * 4" });
  });

  it("stops before persisting anything once the lease has already been lost to another worker", async () => {
    const message = await claimedTurn("/calculator 1+1");
    // Simulate another worker reclaiming the row before execution starts.
    await pool.query("UPDATE messages SET worker_id = 'someone-else' WHERE id = $1", [message.id]);

    const calculatorTool = makeCalculatorTool(() => "2");
    const toolsByName = new Map([["calculator", calculatorTool]]);
    const invocation = parseDirectInvocation(message.content)!;
    const publisher = fakePublisher();

    await runDirectToolTurn(pool, message, "chan", publisher, toolsByName, invocation, () => {});

    const rows = await getMessagesByReplyTo(pool, message.id);
    expect(rows).toHaveLength(0);

    const updated = await getMessage(pool, message.id);
    expect(updated!.status).not.toBe("done");

    // tool_start is published best-effort before the first lease check (same
    // as the real tool loop's onToolEvent calls have no lease guard), but
    // completion events never fire once the lease check fails.
    const events = publisher.published.map((p) => p.event.type);
    expect(events).not.toContain("tool_end");
    expect(events).not.toContain("done");
  });
});
