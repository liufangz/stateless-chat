import type { ConversationSummary, Message } from '../types';

const API_BASE = '/api';

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
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
    throw new Error(`DELETE /conversations/${conversationId} failed: ${res.status}`);
  }
}

export function getHistory(
  conversationId: string,
): Promise<{ conversationId: string; messages: Message[] }> {
  return jsonFetch(`/conversations/${conversationId}/messages`);
}

export interface StreamHandlers {
  onToken: (chunk: string) => void;
  onDone: (fullContent: string) => void;
  onError: (message: string) => void;
}

export function streamReply(streamUrl: string, handlers: StreamHandlers): () => void {
  const source = new EventSource(`${API_BASE}${streamUrl}`);

  source.addEventListener('token', (event) => {
    const { content } = JSON.parse((event as MessageEvent).data);
    handlers.onToken(content);
  });

  source.addEventListener('done', (event) => {
    const { content } = JSON.parse((event as MessageEvent).data);
    handlers.onDone(content);
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
