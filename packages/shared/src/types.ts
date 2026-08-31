export type Role = "user" | "assistant" | "tool";

export type MessageStatus = "pending" | "processing" | "done" | "failed";

export interface Conversation {
  id: string;
  client_id: string;
  created_at: string;
}

export interface ConversationSummary {
  id: string;
  client_id: string;
  created_at: string;
  updated_at: string;
  last_message: string | null;
  last_message_role: Role | null;
}

// One entry of an assistant message's `tool_calls` JSONB column - mirrors the
// OpenAI wire shape (`arguments` is the raw JSON string, not parsed).
export interface MessageToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: Role;
  content: string;
  status: MessageStatus;
  reply_to_message_id: string | null;
  created_at: string;
  tool_calls?: MessageToolCall[] | null;
  tool_call_id?: string | null;
  tool_name?: string | null;
  tool_is_error?: boolean | null;
  // Phase 3 reliability: which tool-loop round produced this row. Set only
  // on assistant tool-call-request rows (tool_calls non-empty) - this is
  // what lets a resumed turn know the next free iteration number, and lets
  // the DB enforce "at most one request row per (turn, iteration)".
  iteration?: number | null;
  // Token usage + timing (Phase: usage stats) - set only on a turn's final
  // text assistant row; NULL on tool-call/tool rows and legacy rows.
  // prompt_tokens/completion_tokens are cumulative across every LLM
  // round-trip the turn made (can vastly exceed the model's context window
  // on a tool-heavy turn, since each round resends growing history) - kept
  // for backend correctness, never shown to the user as-is.
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  duration_ms?: number | null;
  // Context occupation (Phase: context display): the prompt size of the
  // LAST LLM call this turn made - i.e. what's actually sent as context for
  // the next turn (system + persisted history + active compaction summary),
  // not the cumulative sum above. Provider-reported when available, else a
  // conservative char-based estimate (see estimateMessagesTokens in
  // packages/worker/src/compaction.ts). NULL on legacy rows predating this
  // column and on tool-call/tool rows.
  context_tokens?: number | null;
  // Processing ownership/lease (Phase 1 reliability) - only meaningful on
  // role='user' rows, which are the claimable "job" rows. worker_id +
  // lease_expires_at identify who currently owns a 'processing' row and
  // when that claim expires if not renewed; attempt_count counts every
  // claim (fresh or reclaimed after an expired lease); last_error carries
  // the most recent failure reason for a 'failed' row so it stays
  // diagnosable after reload instead of only existing as a transient SSE
  // event.
  worker_id?: string | null;
  lease_expires_at?: string | null;
  attempt_count?: number;
  last_error?: string | null;
}

// One executed tool call produced by the worker's tool loop, in execution
// order. `iteration` groups calls issued in the same LLM round-trip - this is
// what lets persistence reconstruct exactly which tool-call assistant row
// each result belongs to (see insertToolCallRequest/insertToolResult in
// db.ts, called incrementally per-step rather than in bulk).
export interface ToolExchangeRecord {
  iteration: number;
  toolCallId: string;
  toolName: string;
  arguments: string;
  args?: unknown;
  result: string;
  isError: boolean;
  /**
   * Text the model streamed before this iteration's tool calls, if any.
   * Persisted on the tool-call assistant row so history replay can keep
   * the interleaved text -> tool call -> text ordering instead of
   * dropping everything that came before the final answer.
   */
  text?: string;
}

// pi-style token-budgeted auto-compaction: one row per compaction pass. See
// packages/worker/src/compaction.ts for the summarization logic that
// produces these.
export interface Compaction {
  id: string;
  conversation_id: string;
  summary: string;
  first_kept_message_id: string;
  // Phase 4 durable compaction: source span start + triggering turn.
  // Nullable - NULL on compactions persisted before this field existed.
  source_start_message_id: string | null;
  triggered_by_message_id: string | null;
  tokens_before: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  created_at: string;
}

// Payloads published on Redis.

export interface NewMessageNotification {
  messageId: string;
  conversationId: string;
}

export interface UsageStats {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  streamMs: number;
  firstTokenMs: number;
  /** See Message.context_tokens - the turn's latest single-call prompt size, not the cumulative sum above. */
  contextTokens: number;
}

export type StreamEvent =
  | { type: "token"; content: string }
  | {
      type: "done";
      messageId: string;
      content: string;
      usage: Pick<UsageStats, "promptTokens" | "completionTokens" | "totalTokens" | "contextTokens"> | null;
      speedTps: number | null;
      durationMs: number | null;
    }
  | { type: "error"; message: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean }
  // pi-style lifecycle events, relayed from the worker over the same channel.
  // The web client ignores named events it has no listener for, so these are
  // safe to emit alongside the existing token/tool_start/tool_end events.
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | {
      type: "message_start";
      role: "user" | "assistant" | "tool";
      content: string | null;
      toolCallId?: string;
      toolCalls?: Array<{ id: string; name: string; arguments: string }>;
    }
  | { type: "message_update"; contentDelta: string }
  | {
      type: "message_end";
      role: "user" | "assistant" | "tool";
      content: string | null;
      toolCallId?: string;
    }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: string; isError: boolean };
