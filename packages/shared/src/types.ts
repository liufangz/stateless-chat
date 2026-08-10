export type Role = "user" | "assistant";

export type MessageStatus = "pending" | "processing" | "done" | "failed";

export interface Conversation {
  id: string;
  client_id: string;
  created_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: Role;
  content: string;
  status: MessageStatus;
  reply_to_message_id: string | null;
  created_at: string;
}

// Payloads published on Redis.

export interface NewMessageNotification {
  messageId: string;
  conversationId: string;
}

export type StreamEvent =
  | { type: "token"; content: string }
  | { type: "done"; messageId: string; content: string }
  | { type: "error"; message: string };
