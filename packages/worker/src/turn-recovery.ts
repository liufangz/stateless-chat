/**
 * Phase 3 reliability: reconciles a claimed turn's durable state before the
 * tool loop (re)starts, so a worker that picks up a turn abandoned mid-flight
 * by a crashed/killed/restarted worker continues from the last committed
 * step instead of blindly re-running the whole turn from the first LLM call.
 *
 * Tool-call requests and their results are persisted incrementally during
 * the loop (see ToolLoopPersistence in tool-loop.ts), so getConversationHistory
 * already contains whatever a previous attempt committed - the only thing
 * this module has to resolve is a "dangling" tool-call-request row: one
 * whose calls don't all have a matching result row yet, which is exactly the
 * shape a crash mid-turn leaves behind. There are three distinguishable
 * crash windows once such a row exists:
 *
 *   1. before tool execution / during tool execution / after execution but
 *      before the result commits - all three look identical from durable
 *      state alone (request row exists, no result row for that call). For a
 *      read-only tool this is safe to retry blind. For a tool that can
 *      mutate host/file state, it is NOT: the side effect may have already
 *      happened, and no amount of database idempotency on our side can tell
 *      us whether it did - that fact lives outside Postgres, in whatever the
 *      tool touched. Retrying blind risks doing it twice; skipping silently
 *      risks the model never learning it might already be done. Neither is
 *      safe to automate, so this case is surfaced as a failure requiring a
 *      human to check and record the real outcome (see
 *      scripts/resolve-tool-call.ts), not silently retried or skipped.
 *   2. after the result commits but before the next LLM call - no dangling
 *      row exists in this case (the result row is there), so reconcile
 *      returns "ready" with no special handling needed; the resumed loop's
 *      next LLM call just sees the fully-resolved exchange like any other
 *      turn.
 *   3. during final-answer persistence - handled by the "already-final"
 *      branch below, not by dangling-row logic at all.
 */
import type pg from "pg";
import { getMessagesByReplyTo, insertToolResult } from "@stateless-chat/shared";
import type { Message } from "@stateless-chat/shared";
import { executeToolCall, isToolCallAssistantRow } from "./tool-loop.js";
import type { Tool } from "./tool-loop.js";

export type ReconcileOutcome =
  /** Nothing pending (fresh turn, or previous attempt's last dangling row was fully read-only and has now been resolved). Start the loop at startIteration. */
  | { kind: "ready"; startIteration: number }
  /** A previous attempt already produced and persisted the turn's final answer - don't call the LLM again, just complete the turn from `reply`. */
  | { kind: "already-final"; reply: Message }
  /**
   * A previous attempt crashed with an unresolved tool call whose execution
   * status is unknown and unsafe to guess (a mutating tool). The turn
   * cannot proceed automatically - `reason` is meant to become the
   * message's last_error so an operator can see exactly what needs manual
   * resolution.
   */
  | { kind: "blocked-mutation"; reason: string };

export async function reconcileTurnState(
  pool: pg.Pool,
  tools: Tool[],
  conversationId: string,
  userMessageId: string
): Promise<ReconcileOutcome> {
  const rows = await getMessagesByReplyTo(pool, userMessageId);

  const finalReply = rows.find((r) => r.role === "assistant" && !isToolCallAssistantRow(r));
  if (finalReply) {
    return { kind: "already-final", reply: finalReply };
  }

  const requestRows = rows
    .filter(isToolCallAssistantRow)
    .sort((a, b) => (a.iteration ?? 0) - (b.iteration ?? 0));

  if (requestRows.length === 0) {
    return { kind: "ready", startIteration: 0 };
  }

  const lastRequest = requestRows[requestRows.length - 1];
  const maxIteration = lastRequest.iteration ?? requestRows.length - 1;
  const resultIds = new Set(
    rows.filter((r) => r.role === "tool" && r.tool_call_id).map((r) => r.tool_call_id as string)
  );
  const pending = (lastRequest.tool_calls ?? []).filter((tc) => !resultIds.has(tc.id));

  if (pending.length === 0) {
    return { kind: "ready", startIteration: maxIteration + 1 };
  }

  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const unsafe = pending.filter((tc) => toolsByName.get(tc.name)?.readOnly !== true);

  if (unsafe.length > 0) {
    const names = [...new Set(unsafe.map((tc) => tc.name))].join(", ");
    return {
      kind: "blocked-mutation",
      reason:
        `Turn interrupted by a worker crash/restart with an unresolved '${names}' tool call ` +
        "still pending. This tool can have effects outside the database, so it was NOT " +
        "automatically retried - whether it actually ran before the crash is unknown, and " +
        "guessing either way (retry or skip) risks a wrong answer or a duplicated side effect. " +
        "Manual verification is required: check whether the call's effect actually happened, " +
        "then record its real outcome with scripts/resolve-tool-call.ts before requeuing this " +
        "message with scripts/requeue-message.ts.",
    };
  }

  // Every pending call in the dangling row is read-only - safe to re-run
  // blind. Persist each result now (idempotent - a concurrent/previous
  // attempt racing to do the same thing just no-ops) so the resumed loop's
  // next LLM call sees a fully-resolved exchange instead of a dangling
  // tool_calls request, which the LLM API would otherwise reject.
  for (const tc of pending) {
    const result = await executeToolCall({ id: tc.id, name: tc.name, arguments: tc.arguments }, toolsByName);
    await insertToolResult(pool, conversationId, userMessageId, {
      toolCallId: tc.id,
      toolName: tc.name,
      result: result.content,
      isError: result.isError,
    });
  }

  return { kind: "ready", startIteration: maxIteration + 1 };
}
