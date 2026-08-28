import type { Message } from "@stateless-chat/shared";

export interface ClientToolCallSummary {
  id: string;
  name: string;
  arguments: string;
  isError: boolean;
}

export interface ClientMessageUsage {
  promptTokens: number;
  completionTokens: number;
  durationMs: number | null;
}

export type ClientMessage = Omit<
  Message,
  "tool_calls" | "tool_call_id" | "tool_name" | "tool_is_error" | "prompt_tokens" | "completion_tokens" | "duration_ms"
> & {
  tool_calls?: ClientToolCallSummary[] | null;
  usage?: ClientMessageUsage | null;
  speedTps?: number | null;
};

function usageFromRow(row: Message): { usage: ClientMessageUsage | null; speedTps: number | null } {
  if (row.prompt_tokens == null || row.completion_tokens == null) {
    return { usage: null, speedTps: null };
  }
  const durationMs = row.duration_ms ?? null;
  const usage: ClientMessageUsage = {
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    durationMs,
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
 */
export function groupMessagesForClient(rows: Message[]): ClientMessage[] {
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
      const { tool_calls, tool_call_id, tool_name, tool_is_error, prompt_tokens, completion_tokens, duration_ms, ...rest } = row;
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
      const { tool_calls: _toolCalls, prompt_tokens, completion_tokens, duration_ms, ...rest } = row;
      const { usage, speedTps } = usageFromRow(row);
      result.push({ ...rest, usage, speedTps });
    }
  }
  return result;
}
