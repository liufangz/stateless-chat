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

export interface MessageUsage {
  // Cumulative across every LLM round-trip the turn made - not shown to the
  // user as a token count (see contextTokens, which the StatsBar displays).
  promptTokens: number;
  completionTokens: number;
  durationMs: number | null;
  /** Current context occupation: the turn's latest single-call prompt size. */
  contextTokens: number | null;
}

/**
 * Client-only ordered step of an in-progress assistant reply. The LLM can
 * interleave text and tool calls within one turn (e.g. "let me check..." ->
 * tool call -> final answer), so a live stream is rendered as a sequence of
 * text/tool steps instead of flattening everything into one bubble.
 */
export type MessageStep =
  | { type: 'text'; content: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      arguments?: string;
      isError?: boolean;
      /** True while this call's tool_end hasn't arrived yet. */
      running?: boolean;
    };

export interface Message {
  id: string;
  role: Role;
  content: string;
  status?: string;
  streaming?: boolean;
  tool_calls?: ToolCallSummary[];
  reply_to_message_id?: string | null;
  usage?: MessageUsage | null;
  speedTps?: number | null;
  /** Client-only: live tok/s while this message is still streaming. */
  liveSpeedTps?: number | null;
  /** Client-only: ordered text/tool steps of an in-progress streaming reply. */
  steps?: MessageStep[];
  /** Set on a 'failed' user row - the reason the worker gave up (Phase 1 reliability). */
  last_error?: string | null;
  /** How many times this row has been claimed (fresh claim or lease reclaim). */
  attempt_count?: number;
}

export interface CompactionSummary {
  id: string;
  summary: string;
  createdAt: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface ConversationSummary {
  id: string;
  client_id: string;
  created_at: string;
  updated_at: string;
  last_message: string | null;
  last_message_role: Role | null;
}
