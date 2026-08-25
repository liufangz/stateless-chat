import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  checkAuthStatus,
  createConversation,
  deleteConversation,
  getHistory,
  listConversations,
  logout,
  sendMessage,
  streamReply,
} from './lib/api';
import { getOrCreateClientId, getSidebarCollapsed, getStoredConversationId, setSidebarCollapsed, setStoredConversationId } from './lib/storage';
import { useMediaQuery } from './lib/useMediaQuery';
import type { ConversationSummary, Message } from './types';
import { MessageList } from './components/MessageList';
import { Composer } from './components/Composer';
import { Sidebar } from './components/Sidebar';
import { LoginScreen } from './components/LoginScreen';

type InitState = 'loading' | 'ready' | 'error';
type AuthState = 'checking' | 'authenticated' | 'unauthenticated';

function HamburgerIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
      <path
        fillRule="evenodd"
        d="M2 4.75A.75.75 0 0 1 2.75 4h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75Zm0 10.5a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75ZM2 10a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 10Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

export default function App() {
  const clientIdRef = useRef(getOrCreateClientId());
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [initState, setInitState] = useState<InitState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsedState] = useState<boolean>(() => getSidebarCollapsed());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isMobile = useMediaQuery('(max-width: 639.98px)');

  const toggleSidebar = useCallback(() => {
    if (isMobile) {
      setSidebarOpen((prev) => !prev);
      return;
    }
    setSidebarCollapsedState((prev) => {
      const next = !prev;
      setSidebarCollapsed(next);
      return next;
    });
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile && sidebarOpen) setSidebarOpen(false);
  }, [isMobile, sidebarOpen]);

  const refreshConversations = useCallback(async () => {
    try {
      const { conversations: list } = await listConversations(clientIdRef.current);
      setConversations(list);
    } catch (err) {
      if (isUnauthorized(err)) {
        setAuthState('unauthenticated');
        return;
      }
      // Sidebar refresh is best-effort - the active conversation still works
      // even if this fails, so swallow other errors instead of surfacing them.
    } finally {
      setConversationsLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    checkAuthStatus()
      .then(() => {
        if (!cancelled) setAuthState('authenticated');
      })
      .catch(() => {
        if (!cancelled) setAuthState('unauthenticated');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (authState !== 'authenticated') return;
    let cancelled = false;

    async function init() {
      const clientId = clientIdRef.current;
      try {
        let convId = getStoredConversationId();
        if (convId) {
          try {
            const history = await getHistory(convId);
            if (cancelled) return;
            setConversationId(convId);
            setMessages(history.messages);
            setInitState('ready');
            refreshConversations();
            return;
          } catch (err) {
            if (isUnauthorized(err)) throw err;
            convId = null;
          }
        }
        const created = await createConversation(clientId);
        if (cancelled) return;
        setStoredConversationId(created.conversationId);
        setConversationId(created.conversationId);
        setMessages([]);
        setInitState('ready');
        refreshConversations();
      } catch (err) {
        if (cancelled) return;
        if (isUnauthorized(err)) {
          setAuthState('unauthenticated');
          return;
        }
        setErrorMessage(err instanceof Error ? err.message : 'Failed to reach the backend');
        setInitState('error');
      }
    }

    setInitState('loading');
    init();
    return () => {
      cancelled = true;
    };
  }, [authState, refreshConversations]);

  function handleLoginSuccess() {
    setAuthState('authenticated');
  }

  async function handleLogout() {
    try {
      await logout();
    } catch {
      // best-effort - the cookie may already be gone
    }
    setAuthState('unauthenticated');
    setInitState('loading');
    setConversationId(null);
    setMessages([]);
    setConversations([]);
    setConversationsLoading(true);
    setErrorMessage(null);
  }

  async function handleSelectConversation(id: string) {
    if (id === conversationId || sending) return;
    setSidebarOpen(false);
    try {
      const history = await getHistory(id);
      setStoredConversationId(id);
      setConversationId(id);
      setMessages(history.messages);
      setErrorMessage(null);
    } catch (err) {
      if (isUnauthorized(err)) {
        setAuthState('unauthenticated');
        return;
      }
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load conversation');
    }
  }

  async function handleNewChat() {
    if (sending) return;
    setSidebarOpen(false);
    try {
      const created = await createConversation(clientIdRef.current);
      setStoredConversationId(created.conversationId);
      setConversationId(created.conversationId);
      setMessages([]);
      setErrorMessage(null);
      refreshConversations();
    } catch (err) {
      if (isUnauthorized(err)) {
        setAuthState('unauthenticated');
        return;
      }
      setErrorMessage(err instanceof Error ? err.message : 'Failed to start a new chat');
    }
  }

  async function handleDeleteConversation(id: string) {
    try {
      await deleteConversation(id, clientIdRef.current);
    } catch (err) {
      if (isUnauthorized(err)) {
        setAuthState('unauthenticated');
        return;
      }
      setErrorMessage(err instanceof Error ? err.message : 'Failed to delete conversation');
      return;
    }

    const remaining = conversations.filter((c) => c.id !== id);
    setConversations(remaining);

    if (id !== conversationId) return;

    if (remaining.length > 0) {
      const next = remaining[0];
      try {
        const history = await getHistory(next.id);
        setStoredConversationId(next.id);
        setConversationId(next.id);
        setMessages(history.messages);
        setErrorMessage(null);
      } catch (err) {
        if (isUnauthorized(err)) {
          setAuthState('unauthenticated');
          return;
        }
        setErrorMessage(err instanceof Error ? err.message : 'Failed to load conversation');
      }
      return;
    }

    try {
      const created = await createConversation(clientIdRef.current);
      setStoredConversationId(created.conversationId);
      setConversationId(created.conversationId);
      setMessages([]);
      setErrorMessage(null);
      refreshConversations();
    } catch (err) {
      if (isUnauthorized(err)) {
        setAuthState('unauthenticated');
        return;
      }
      setErrorMessage(err instanceof Error ? err.message : 'Failed to start a new chat');
    }
  }

  async function handleSend(content: string) {
    if (!conversationId || sending) return;
    setSending(true);
    setErrorMessage(null);

    try {
      const { messageId, streamUrl } = await sendMessage(conversationId, clientIdRef.current, content);

      const userMessage: Message = { id: messageId, role: 'user', content };
      const assistantId = `pending-${messageId}`;
      const assistantMessage: Message = { id: assistantId, role: 'assistant', content: '', streaming: true };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      refreshConversations();

      streamReply(streamUrl, {
        onToken: (chunk) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + chunk } : m)),
          );
        },
        onDone: (fullContent) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: fullContent, streaming: false } : m)),
          );
          setSending(false);
          refreshConversations();
        },
        onError: (message) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: m.content || `Error: ${message}`, streaming: false }
                : m,
            ),
          );
          setSending(false);
          refreshConversations();
        },
      });
    } catch (err) {
      if (isUnauthorized(err)) {
        setAuthState('unauthenticated');
        setSending(false);
        return;
      }
      setErrorMessage(err instanceof Error ? err.message : 'Failed to send message');
      setSending(false);
    }
  }

  if (authState === 'checking') {
    return (
      <div className="flex h-dvh items-center justify-center bg-slate-50 text-sm text-slate-400">
        Loading…
      </div>
    );
  }

  if (authState === 'unauthenticated') {
    return <LoginScreen onSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="flex h-dvh bg-slate-50">
      <Sidebar
        conversations={conversations}
        currentId={conversationId}
        loading={conversationsLoading}
        disabled={sending}
        collapsed={sidebarCollapsed}
        mobileOpen={sidebarOpen}
        onSelect={handleSelectConversation}
        onNewChat={handleNewChat}
        onDelete={handleDeleteConversation}
        onLogout={handleLogout}
        onMobileClose={() => setSidebarOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-w-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 shadow-sm">
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={isMobile ? (sidebarOpen ? 'Close sidebar' : 'Open sidebar') : sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={isMobile ? sidebarOpen : !sidebarCollapsed}
            title={isMobile ? (sidebarOpen ? 'Hide conversations' : 'Show conversations') : sidebarCollapsed ? 'Show conversations' : 'Hide conversations'}
            className="-ml-1 shrink-0 rounded-lg p-2.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 sm:p-1.5"
          >
            <HamburgerIcon />
          </button>
          <h1 className="truncate text-lg font-semibold text-slate-800">Stateless Chat</h1>
        </header>

        {initState === 'loading' && (
          <div className="flex flex-1 items-center justify-center text-slate-400 text-sm">Loading conversation…</div>
        )}

        {initState === 'error' && (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-red-500">
            Could not reach the backend: {errorMessage}
          </div>
        )}

        {initState === 'ready' && (
          <>
            <MessageList messages={messages} />
            {errorMessage && (
              <div className="px-4 py-1 text-center text-xs text-red-500">{errorMessage}</div>
            )}
            <Composer onSend={handleSend} disabled={sending} />
          </>
        )}
      </div>
    </div>
  );
}
