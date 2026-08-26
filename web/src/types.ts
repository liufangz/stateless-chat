export type Role = 'user' | 'assistant';

export interface ToolCallSummary {
  id: string;
  name: string;
  arguments?: string;
  isError?: boolean;
  /** Client-only: true while this call's tool_end hasn't arrived yet. */
  running?: boolean;
}

export interface ToolCallDetail {
  id: string;
  name: string;
  arguments: string;
  result: string;
  isError: boolean;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  status?: string;
  streaming?: boolean;
  tool_calls?: ToolCallSummary[];
  reply_to_message_id?: string | null;
}

export interface ConversationSummary {
  id: string;
  client_id: string;
  created_at: string;
  updated_at: string;
  last_message: string | null;
  last_message_role: Role | null;
}
