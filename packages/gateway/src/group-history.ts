import { estimateHistoricalContextTokens } from "@stateless-chat/shared";
import type { Compaction, Message } from "@stateless-chat/shared";

export interface ClientToolCallSummary {
  id: string;
  name: string;
  arguments: string;
  isError: boolean;
}

export interface ClientMessageUsage {
  // Cumulative across every LLM round-trip the turn made - kept for the
  // avg tok/s calculation, never shown to the user as a token count (see
  // contextTokens below for what the UI displays as "context occupied").
  promptTokens: number;
  completionTokens: number;
  durationMs: number | null;
  /**
   * Current context occupation: the turn's latest single-call prompt size,
   * not the cumulative sum above. For a row persisted before context_tokens
   * existed, this is a from-scratch estimate of the actually-retained
   * history (system prompt + rows since the latest compaction boundary),
   * NEVER the legacy cumulative promptTokens - see
   * estimateHistoricalContextTokens in packages/shared/src/context-estimate.ts.
   * Null only when the row has no usage at all.
   */
  contextTokens: number | null;
}

export type ClientMessage = Omit<
  Message,
  | "tool_calls"
  | "tool_call_id"
  | "tool_name"
  | "tool_is_error"
  | "prompt_tokens"
  | "completion_tokens"
  | "duration_ms"
  | "context_tokens"
  | "worker_id"
  | "lease_expires_at"
  | "iteration"
> & {
  tool_calls?: ClientToolCallSummary[] | null;
  usage?: ClientMessageUsage | null;
  speedTps?: number | null;
};

function usageFromRow(
  row: Message,
  rows: Message[],
  latestCompaction: Compaction | null
): { usage: ClientMessageUsage | null; speedTps: number | null } {
  if (row.prompt_tokens == null || row.completion_tokens == null) {
    return { usage: null, speedTps: null };
  }
  const durationMs = row.duration_ms ?? null;
  const usage: ClientMessageUsage = {
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    durationMs,
    // NEVER row.prompt_tokens here - that's the cumulative sum across every
    // LLM round-trip the turn made, which can vastly overstate context on a
    // tool-heavy turn (see the shared estimator's doc comment).
    contextTokens: row.context_tokens ?? estimateHistoricalContextTokens(rows, row.id, latestCompaction),
  };
  const speedTps =
    durationMs && durationMs > 0
      ? Math.round((row.completion_tokens / (durationMs / 1000)) * 10) / 10
      : null;
  return { usage, speedTps };
}

/**
 * Turns raw `messages` rows into what the frontend renders: standalone
 * role='tool' rows are consumed into the preceding tool-call assistant
 * row's `tool_calls` summaries (name + arguments + isError, no result
 * content - results are fetched on demand from the /tools endpoint) and
 * omitted from the output. Ordering (user, assistant msg(s), ...) is
 * otherwise unchanged.
 *
 * `latestCompaction` (the conversation's most recent compaction, if any) is
 * only needed for the historical context-occupation fallback on rows
 * lacking context_tokens - pass null when the caller hasn't loaded one
 * (e.g. no compaction has ever run for this conversation).
 */
export function groupMessagesForClient(
  rows: Message[],
  latestCompaction: Compaction | null = null
): ClientMessage[] {
  const isErrorByCall = new Map<string, boolean>();
  for (const row of rows) {
    if (row.role === "tool" && row.tool_call_id) {
      isErrorByCall.set(`${row.reply_to_message_id ?? ""}:${row.tool_call_id}`, !!row.tool_is_error);
    }
  }

  const result: ClientMessage[] = [];
  for (const row of rows) {
    if (row.role === "tool") continue;

    if (row.role === "assistant" && row.tool_calls && row.tool_calls.length > 0) {
      const {
        tool_calls,
        tool_call_id,
        tool_name,
        tool_is_error,
        prompt_tokens,
        completion_tokens,
        duration_ms,
        context_tokens,
        worker_id,
        lease_expires_at,
        iteration,
        ...rest
      } = row;
      result.push({
        ...rest,
        tool_calls: tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          isError: isErrorByCall.get(`${row.reply_to_message_id ?? ""}:${tc.id}`) ?? false,
        })),
      });
    } else {
      const {
        tool_calls: _toolCalls,
        prompt_tokens,
        completion_tokens,
        duration_ms,
        context_tokens,
        worker_id,
        lease_expires_at,
        iteration,
        ...rest
      } = row;
      const { usage, speedTps } = usageFromRow(row, rows, latestCompaction);
      result.push({ ...rest, usage, speedTps });
    }
  }
  return result;
}
