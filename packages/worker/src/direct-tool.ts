/**
 * Slash-invoked tools (docs/FEATURE-slash-tools.md): a user can pick a bound
 * tool from the composer's `/` picker and have it execute exactly like one
 * iteration of a normal LLM tool call - same persisted rows, same SSE chips,
 * same expandable transcript - but with NO LLM follow-up: the tool's result
 * is the entire turn. This module owns detecting that shape in a message's
 * raw content and running that one-iteration turn.
 *
 * Persistence mirrors the two durable checkpoints runToolLoop's persistence
 * hooks use (see tool-loop.ts's ToolLoopPersistence doc comment and
 * packages/worker/src/index.ts's onToolCallRequest/onToolResult), plus the
 * same final "did we still own the lease when we finished" guard
 * processMessage uses before its own markMessageDone/publish - so a direct
 * turn is recoverable by turn-recovery.ts using the exact same dangling-row
 * logic a normal LLM turn's tool-call-request row gets, no new semantics.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { env, insertToolCallRequest, insertToolResult, markMessageDone, stillOwnsLease } from "@stateless-chat/shared";
import type { Message } from "@stateless-chat/shared";
import { executeToolCall } from "./tool-loop.js";
import type { Tool } from "./tool-loop.js";

export interface DirectInvocation {
  toolName: string;
  argsText: string;
}

/**
 * Pure syntactic parse of "/toolName argsText" from a message's raw content.
 * Deliberately does NOT check whether toolName is a real/bound/enabled tool
 * - that needs a live tools list, which callers already have in different
 * shapes (a Tool[] in reconcileTurnState, a Map in processMessage), so it's
 * left to them. Keeping this pure and tool-list-free is what makes it a
 * trivial, host-free unit-test target.
 *
 * "/calculator (2 + 3) * 4" -> { toolName: "calculator", argsText: "(2 + 3) * 4" }
 * "/write_file {...}"       -> { toolName: "write_file", argsText: "{...}" }
 * "/calculator"              -> { toolName: "calculator", argsText: "" }
 * "/not_a_tool hello"        -> { toolName: "not_a_tool", argsText: "hello" } (caller rejects unknown names)
 * "text" / "2 + 3" / ""      -> null
 */
export function parseDirectInvocation(content: string): DirectInvocation | null {
  if (!content.startsWith("/")) return null;
  const rest = content.slice(1);
  const spaceIndex = rest.search(/\s/);
  const toolName = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex);
  if (!toolName) return null;
  const argsText = spaceIndex === -1 ? "" : rest.slice(spaceIndex + 1).trim();
  return { toolName, argsText };
}

/**
 * Resolves a direct invocation's trailing text into the args object the
 * tool executes with (docs/FEATURE-slash-tools.md §4.3 step 2):
 *   - empty (after trim) -> {}
 *   - starts with '{' and parses as a JSON object -> that object
 *   - else, if the tool declares exactly one arg -> { [thatArgName]: argsText }
 *   - else -> {} (a multi-arg tool then fails its own validation - an
 *     accepted call producing an isError result, never a failed turn)
 */
export function resolveDirectArgs(tool: Tool, argsText: string): Record<string, unknown> {
  const trimmed = argsText.trim();
  if (trimmed === "") return {};

  if (trimmed.startsWith("{")) {
    // Leading '{' means any successful JSON.parse is necessarily a plain
    // object (JSON grammar ties a leading '{' to the object production) -
    // no Array.isArray/typeof guard needed, only the parse can fail.
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Not valid JSON - fall through to the single-arg shorthand below.
    }
  }

  const properties = (tool.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  const argNames = Object.keys(properties);
  if (argNames.length === 1) {
    return { [argNames[0]]: trimmed };
  }
  return {};
}

/**
 * Runs one direct-tool turn end to end and returns once the turn is fully
 * complete (or abandoned because the lease was lost). Caller is responsible
 * for having already confirmed `invocation.toolName` is a bound, enabled
 * tool present in `toolsByName`.
 */
export async function runDirectToolTurn(
  pool: pg.Pool,
  message: Message,
  channel: string,
  publisher: { publish(channel: string, message: string): Promise<unknown> },
  toolsByName: Map<string, Tool>,
  invocation: DirectInvocation,
  log: (...args: unknown[]) => void
): Promise<void> {
  const tool = toolsByName.get(invocation.toolName);
  if (!tool) {
    throw new Error(`runDirectToolTurn: '${invocation.toolName}' is not in toolsByName - caller must validate first`);
  }

  const args = resolveDirectArgs(tool, invocation.argsText);
  const toolCallId = randomUUID();
  const argumentsJson = JSON.stringify(args);

  publisher
    .publish(channel, JSON.stringify({ type: "tool_start", toolCallId, toolName: tool.name, args }))
    .catch((err) => log("publish tool_start failed", err));

  // Durable checkpoint #1, same as the tool loop's onToolCallRequest: the
  // request must be persisted before the call executes.
  if (!(await stillOwnsLease(pool, message.id, env.workerId))) {
    log("lease no longer owned before persisting direct tool-call request - aborting turn");
    return;
  }
  await insertToolCallRequest(pool, message.conversation_id, message.id, 0, [
    { toolCallId, toolName: tool.name, arguments: argumentsJson },
  ]);

  const result = await executeToolCall({ id: toolCallId, name: tool.name, arguments: argumentsJson }, toolsByName);

  // Durable checkpoint #2, same as the tool loop's onToolResult: the result
  // must be persisted before anything downstream (here, completing the turn)
  // is allowed to happen.
  if (!(await stillOwnsLease(pool, message.id, env.workerId))) {
    log("lease no longer owned before persisting direct tool result - aborting turn");
    return;
  }
  await insertToolResult(pool, message.conversation_id, message.id, {
    toolCallId,
    toolName: tool.name,
    result: result.content,
    isError: result.isError,
  });

  publisher
    .publish(
      channel,
      JSON.stringify({ type: "tool_end", toolCallId, toolName: tool.name, isError: result.isError })
    )
    .catch((err) => log("publish tool_end failed", err));

  // Final ownership guard, same as processMessage's normal completion path:
  // if another worker reclaimed this row while we were executing, its own
  // run (or turn-recovery's already-final-direct branch, since our result
  // row above is already durably committed) is authoritative - don't also
  // markMessageDone/publish "done" here.
  if (!(await stillOwnsLease(pool, message.id, env.workerId))) {
    log("lease no longer owned after direct tool result - not completing the turn");
    return;
  }

  // "One result is the whole turn": no insertAssistantMessage, no
  // maybeGenerateTitle, no compaction, no LLM call - just complete it.
  await markMessageDone(pool, message.id);
  await publisher.publish(
    channel,
    JSON.stringify({
      type: "done",
      messageId: message.id,
      content: "",
      usage: null,
      speedTps: null,
      durationMs: null,
    })
  );
}
