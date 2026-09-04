import type { CompactionSummary, ConversationSummary, Message, ToolCallDetail } from '../types';

const API_BASE = '/api';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    throw new ApiError(res.status, `${init?.method ?? 'GET'} ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function checkAuthStatus(): Promise<{ authenticated: boolean }> {
  return jsonFetch('/auth/status');
}

export async function login(password: string): Promise<void> {
  const res = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    let message = 'Login failed';
    try {
      const body = await res.json();
      message = typeof body?.error === 'string' ? body.error : message;
    } catch {
      // non-JSON error body, fall back to default message
    }
    throw new ApiError(res.status, message);
  }
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/logout`, { method: 'POST' });
}

export function createConversation(clientId: string): Promise<{ conversationId: string }> {
  return jsonFetch('/conversations', {
    method: 'POST',
    body: JSON.stringify({ clientId }),
  });
}

export function sendMessage(
  conversationId: string,
  clientId: string,
  content: string,
): Promise<{ conversationId: string; messageId: string; streamUrl: string }> {
  return jsonFetch(`/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ clientId, content }),
  });
}

export function listConversations(clientId: string): Promise<{ conversations: ConversationSummary[] }> {
  return jsonFetch(`/conversations?clientId=${encodeURIComponent(clientId)}`);
}

export async function deleteConversation(conversationId: string, clientId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/conversations/${conversationId}?clientId=${encodeURIComponent(clientId)}`, {
    method: 'DELETE',
  });
  if (res.ok || res.status === 404) return; // 404 = already gone, treat as a successful delete
  // 409 = a reply is still in flight (deterministic conflict, not a race
  // the client has to interpret) - surface the server's own clear message
  // rather than a bare status code, same as login's error handling.
  let message = `DELETE /conversations/${conversationId} failed: ${res.status}`;
  try {
    const body = await res.json();
    if (typeof body?.error === 'string') message = body.error;
  } catch {
    // non-JSON error body, fall back to the default message
  }
  throw new ApiError(res.status, message);
}

export function getHistory(
  conversationId: string,
): Promise<{ conversationId: string; messages: Message[]; compactions: CompactionSummary[] }> {
  return jsonFetch(`/conversations/${conversationId}/messages`);
}

export function fetchToolCalls(
  conversationId: string,
  userMessageId: string,
): Promise<ToolCallDetail[]> {
  return jsonFetch<{ toolCalls: ToolCallDetail[] }>(
    `/conversations/${conversationId}/messages/${userMessageId}/tools`,
  ).then((body) => body.toolCalls);
}

export interface DoneUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Current context occupation: the turn's latest single-call prompt size. */
  contextTokens: number;
}

export interface StreamHandlers {
  onToken: (chunk: string) => void;
  onDone: (fullContent: string, meta: { usage: DoneUsage | null; speedTps: number | null; durationMs: number | null }) => void;
  onError: (message: string) => void;
  onToolStart?: (info: { toolCallId: string; toolName: string; args?: unknown }) => void;
  onToolEnd?: (info: { toolCallId: string; toolName: string; isError: boolean }) => void;
}

/**
 * Distinguishes a genuine server-sent `event: error` SSE message (a
 * MessageEvent carrying a JSON payload - the gateway/worker's own signal
 * that this turn failed, see packages/gateway/src/index.ts's `deliver()`)
 * from the browser's native EventSource connection-failure event (a plain
 * Event with no `data`, fired for network drops, server restarts, etc.).
 * Both dispatch through the SAME `addEventListener('error', ...)` listener
 * - EventSource does not reserve "error" as a name a server-sent event
 * can't collide with - so without this check, a transient network blip
 * would be indistinguishable from (and handled identically to) an actual
 * worker-side turn failure.
 */
export function isServerSentErrorEvent(event: Event): event is MessageEvent {
  return typeof (event as MessageEvent).data === 'string';
}

export function streamReply(streamUrl: string, handlers: StreamHandlers): () => void {
  const source = new EventSource(`${API_BASE}${streamUrl}`);

  source.addEventListener('token', (event) => {
    const { content } = JSON.parse((event as MessageEvent).data);
    handlers.onToken(content);
  });

  source.addEventListener('tool_start', (event) => {
    const { toolCallId, toolName, args } = JSON.parse((event as MessageEvent).data);
    handlers.onToolStart?.({ toolCallId, toolName, args });
  });

  source.addEventListener('tool_end', (event) => {
    const { toolCallId, toolName, isError } = JSON.parse((event as MessageEvent).data);
    handlers.onToolEnd?.({ toolCallId, toolName, isError });
  });

  source.addEventListener('done', (event) => {
    const { content, usage, speedTps, durationMs } = JSON.parse((event as MessageEvent).data);
    handlers.onDone(content, { usage: usage ?? null, speedTps: speedTps ?? null, durationMs: durationMs ?? null });
    source.close();
  });

  source.addEventListener('error', (event) => {
    if (!isServerSentErrorEvent(event)) {
      // A native connection failure, not a server-sent `event: error`
      // message - the browser's EventSource retries this automatically on
      // its own (per the SSE spec) unless it has fully given up
      // (readyState CLOSED, e.g. after a non-retryable HTTP status or
      // repeated failures). Do NOT close() here - that would permanently
      // kill the built-in retry - and do not report a terminal failure for
      // something that may still resolve on its own: the stream endpoint
      // is safe to reconnect to at any point in a turn's lifecycle, so a
      // resumed connection picks up right where it left off (durably
      // persisted tool progress is replayed, and a since-finished reply is
      // read back from Postgres instead of requiring the live stream at
      // all - see the gateway's stream handler).
      if (source.readyState === EventSource.CLOSED) {
        handlers.onError('Lost connection to the server and could not reconnect.');
      }
      return;
    }
    const raw = event.data;
    let message = 'Stream error';
    if (raw) {
      try {
        message = JSON.parse(raw).message ?? message;
      } catch {
        // non-JSON error payload, fall back to default message
      }
    }
    handlers.onError(message);
    source.close();
  });

  return () => source.close();
}
