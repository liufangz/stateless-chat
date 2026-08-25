const CLIENT_ID_KEY = 'stateless-chat:clientId';
const CONVERSATION_ID_KEY = 'stateless-chat:conversationId';
const SIDEBAR_COLLAPSED_KEY = 'stateless-chat:sidebarCollapsed';

export function getSidebarCollapsed(): boolean {
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
}

export function setSidebarCollapsed(collapsed: boolean): void {
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
}

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
