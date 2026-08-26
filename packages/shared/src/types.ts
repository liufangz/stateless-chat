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

// Payloads published on Redis.

export interface NewMessageNotification {
  messageId: string;
  conversationId: string;
}

export type StreamEvent =
  | { type: "token"; content: string }
  | { type: "done"; messageId: string; content: string }
  | { type: "error"; message: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean };
