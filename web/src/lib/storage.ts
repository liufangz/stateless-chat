const CLIENT_ID_KEY = 'stateless-chat:clientId';
const CONVERSATION_ID_KEY = 'stateless-chat:conversationId';

export function getOrCreateClientId(): string {
  let clientId = localStorage.getItem(CLIENT_ID_KEY);
  if (!clientId) {
    clientId = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, clientId);
  }
  return clientId;
}

export function getStoredConversationId(): string | null {
  return localStorage.getItem(CONVERSATION_ID_KEY);
}

export function setStoredConversationId(conversationId: string): void {
  localStorage.setItem(CONVERSATION_ID_KEY, conversationId);
}
