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
  // Token usage + timing (Phase: usage stats) - set only on a turn's final
  // text assistant row; NULL on tool-call/tool rows and legacy rows.
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  duration_ms?: number | null;
}

// One executed tool call produced by the worker's tool loop, in execution
// order. `iteration` groups calls issued in the same LLM round-trip - this is
// what lets persistence reconstruct exactly which tool-call assistant row
// each result belongs to (see insertToolExchange in db.ts).
export interface ToolExchangeRecord {
  iteration: number;
  toolCallId: string;
  toolName: string;
  arguments: string;
  args?: unknown;
  result: string;
  isError: boolean;
}

// pi-style token-budgeted auto-compaction: one row per compaction pass. See
// packages/worker/src/compaction.ts for the summarization logic that
// produces these.
export interface Compaction {
  id: string;
  conversation_id: string;
  summary: string;
  first_kept_message_id: string;
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
}

export type StreamEvent =
  | { type: "token"; content: string }
  | {
      type: "done";
      messageId: string;
      content: string;
      usage: Pick<UsageStats, "promptTokens" | "completionTokens" | "totalTokens"> | null;
      speedTps: number | null;
      durationMs: number | null;
    }
  | { type: "error"; message: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean };
