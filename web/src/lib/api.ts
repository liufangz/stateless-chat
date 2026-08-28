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
  if (!res.ok && res.status !== 404) {
    throw new ApiError(res.status, `DELETE /conversations/${conversationId} failed: ${res.status}`);
  }
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
}

export interface StreamHandlers {
  onToken: (chunk: string) => void;
  onDone: (fullContent: string, meta: { usage: DoneUsage | null; speedTps: number | null; durationMs: number | null }) => void;
  onError: (message: string) => void;
  onToolStart?: (info: { toolCallId: string; toolName: string; args?: unknown }) => void;
  onToolEnd?: (info: { toolCallId: string; toolName: string; isError: boolean }) => void;
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
    const raw = (event as MessageEvent).data;
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
