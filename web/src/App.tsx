import { useCallback, useEffect, useRef, useState } from 'react';
import { createConversation, deleteConversation, getHistory, listConversations, sendMessage, streamReply } from './lib/api';
import { getOrCreateClientId, getStoredConversationId, setStoredConversationId } from './lib/storage';
import type { ConversationSummary, Message } from './types';
import { MessageList } from './components/MessageList';
import { Composer } from './components/Composer';
import { Sidebar } from './components/Sidebar';

type InitState = 'loading' | 'ready' | 'error';

export default function App() {
  const clientIdRef = useRef(getOrCreateClientId());
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [initState, setInitState] = useState<InitState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);

  const refreshConversations = useCallback(async () => {
    try {
      const { conversations: list } = await listConversations(clientIdRef.current);
      setConversations(list);
    } catch {
      // Sidebar refresh is best-effort - the active conversation still works
      // even if this fails, so swallow the error instead of surfacing it.
    } finally {
      setConversationsLoading(false);
    }
  }, []);

  useEffect(() => {
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
          } catch {
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
        setErrorMessage(err instanceof Error ? err.message : 'Failed to reach the backend');
        setInitState('error');
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [refreshConversations]);

  async function handleSelectConversation(id: string) {
    if (id === conversationId || sending) return;
    try {
      const history = await getHistory(id);
      setStoredConversationId(id);
      setConversationId(id);
      setMessages(history.messages);
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load conversation');
    }
  }

  async function handleNewChat() {
    if (sending) return;
    try {
      const created = await createConversation(clientIdRef.current);
      setStoredConversationId(created.conversationId);
      setConversationId(created.conversationId);
      setMessages([]);
      setErrorMessage(null);
      refreshConversations();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to start a new chat');
    }
  }

  async function handleDeleteConversation(id: string) {
    try {
      await deleteConversation(id, clientIdRef.current);
    } catch (err) {
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
      setErrorMessage(err instanceof Error ? err.message : 'Failed to send message');
      setSending(false);
    }
  }

  return (
    <div className="flex h-dvh bg-slate-50">
      <Sidebar
        conversations={conversations}
        currentId={conversationId}
        loading={conversationsLoading}
        disabled={sending}
        onSelect={handleSelectConversation}
        onNewChat={handleNewChat}
        onDelete={handleDeleteConversation}
      />

      <div className="flex flex-1 flex-col">
        <header className="border-b border-slate-200 bg-white px-4 py-3 shadow-sm">
          <h1 className="text-lg font-semibold text-slate-800">Stateless Chat</h1>
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
