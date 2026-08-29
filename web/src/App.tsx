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
import type { CompactionSummary, ConversationSummary, Message, MessageStep } from './types';
import { MessageList } from './components/MessageList';
import { StatsBar } from './components/StatsBar';
import { Composer } from './components/Composer';
import { Sidebar } from './components/Sidebar';
import { LoginScreen } from './components/LoginScreen';

type InitState = 'loading' | 'ready' | 'error';
type AuthState = 'checking' | 'authenticated' | 'unauthenticated';

/**
 * Appends a streamed text chunk to the in-progress step list, merging into
 * the trailing text step (if any) so consecutive tokens stay in one bubble
 * instead of creating a new message per token.
 */
function appendTextStep(steps: MessageStep[], chunk: string): MessageStep[] {
  const last = steps[steps.length - 1];
  if (last && last.type === 'text') {
    return [...steps.slice(0, -1), { type: 'text', content: last.content + chunk }];
  }
  return [...steps, { type: 'text', content: chunk }];
}

/**
 * A conversation's last message being a 'pending'/'processing'/'failed' user
 * row (instead of an assistant reply) means that turn never resolved on the
 * client that started it - e.g. the tab was closed or reloaded mid-turn, or
 * the worker crashed before writing a reply. Detecting this lets a reload
 * resume or surface that turn instead of silently showing nothing for it
 * (Phase 1 reliability).
 */
function outstandingUserMessage(messages: Message[]): Message | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return null;
  return last.status === 'pending' || last.status === 'processing' || last.status === 'failed'
    ? last
    : null;
}

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
  const [compactions, setCompactions] = useState<CompactionSummary[]>([]);
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
            setCompactions(history.compactions);
            setInitState('ready');
            refreshConversations();
            const outstanding = outstandingUserMessage(history.messages);
            if (outstanding) resumeOutstandingTurn(convId, outstanding);
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
        setCompactions([]);
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
    setCompactions([]);
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
      setCompactions(history.compactions);
      setErrorMessage(null);
      const outstanding = outstandingUserMessage(history.messages);
      if (outstanding) resumeOutstandingTurn(id, outstanding);
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
      setCompactions([]);
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
        setCompactions(history.compactions);
        setErrorMessage(null);
        const outstanding = outstandingUserMessage(history.messages);
        if (outstanding) resumeOutstandingTurn(next.id, outstanding);
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
      setCompactions([]);
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

  // Subscribes to a turn's SSE stream and wires it to the shared streaming
  // UI state. Used both for a message just sent (handleSend) and to resume
  // a turn that was still pending/processing when history loaded (a reload
  // mid-turn, or another client's turn still running) - the stream endpoint
  // is safe to open at any point in a turn's lifecycle. `targetConversationId`
  // is threaded through explicitly rather than read from the `conversationId`
  // state closure, since callers may invoke this in the same tick as
  // setConversationId (before the state update has committed).
  function beginStream(targetConversationId: string, userMessageId: string, streamUrl: string) {
    const assistantId = `pending-${userMessageId}`;
    setMessages((prev) => {
      if (prev.some((m) => m.id === assistantId)) return prev;
      const assistantMessage: Message = {
        id: assistantId,
        role: 'assistant',
        content: '',
        streaming: true,
        steps: [],
        reply_to_message_id: userMessageId,
      };
      return [...prev, assistantMessage];
    });
    setSending(true);
    setErrorMessage(null);

    // Live tok/s estimate: tokens received / seconds since the first
    // token. Throttled to ~300ms so re-renders don't churn on every token.
    let tokenCount = 0;
    let firstTokenAt = 0;
    let lastSpeedRenderAt = 0;

    streamReply(streamUrl, {
      onToken: (chunk) => {
        const now = Date.now();
        tokenCount += 1;
        if (!firstTokenAt) firstTokenAt = now;
        let liveSpeedTps: number | undefined;
        if (now - lastSpeedRenderAt >= 300) {
          lastSpeedRenderAt = now;
          const elapsedSec = (now - firstTokenAt) / 1000;
          if (elapsedSec > 0) liveSpeedTps = Math.round((tokenCount / elapsedSec) * 10) / 10;
        }
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: m.content + chunk,
                  ...(liveSpeedTps !== undefined ? { liveSpeedTps } : {}),
                  steps: appendTextStep(m.steps ?? [], chunk),
                }
              : m,
          ),
        );
      },
      onToolStart: ({ toolCallId, toolName, args }) => {
        const summary = {
          id: toolCallId,
          name: toolName,
          arguments: args !== undefined ? JSON.stringify(args) : undefined,
          running: true,
        };
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  tool_calls: [...(m.tool_calls ?? []), summary],
                  steps: [...(m.steps ?? []), { type: 'tool', ...summary }],
                }
              : m,
          ),
        );
      },
      onToolEnd: ({ toolCallId, isError }) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  tool_calls: (m.tool_calls ?? []).map((tc) =>
                    tc.id === toolCallId ? { ...tc, running: false, isError } : tc,
                  ),
                  steps: (m.steps ?? []).map((s) =>
                    s.type === 'tool' && s.id === toolCallId
                      ? { ...s, running: false, isError }
                      : s,
                  ),
                }
              : m,
          ),
        );
      },
      onDone: async (_fullContent, { speedTps, durationMs, usage }) => {
        setSending(false);
        // Keep the streamed message (with its ordered text/tool steps) as
        // the final rendered turn. Swapping in the grouped history rows
        // here flattens the interleaved tool calls back into "chips above
        // the final message" and drops any text that streamed before a
        // tool call - exactly the regression this UI is meant to avoid.
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  streaming: false,
                  liveSpeedTps: null,
                  speedTps,
                  usage:
                    usage && durationMs != null
                      ? {
                          promptTokens: usage.promptTokens,
                          completionTokens: usage.completionTokens,
                          durationMs,
                        }
                      : m.usage,
                }
              : m,
          ),
        );
        try {
          // Refresh compactions only; keep the in-memory turn above.
          const history = await getHistory(targetConversationId);
          setCompactions(history.compactions);
        } catch {
          // Best-effort refresh - the streamed content already rendered above.
        }
        refreshConversations();
      },
      onError: (message) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: m.content || `Error: ${message}`,
                  streaming: false,
                  // Surface the error even when steps-based rendering is
                  // active (e.g. a mid-stream failure after some tool
                  // steps already rendered).
                  steps:
                    m.steps && m.steps.length > 0
                      ? [...m.steps, { type: 'text', content: `Error: ${message}` }]
                      : m.steps,
                }
              : m,
          ),
        );
        setSending(false);
        refreshConversations();
      },
    });
  }

  // A trailing 'pending'/'processing'/'failed' user row after loading
  // history means that turn never resolved for this client - resume live
  // updates for it (pending/processing) or surface its failure reason
  // (failed) instead of silently showing nothing for it.
  function resumeOutstandingTurn(targetConversationId: string, userMessage: Message) {
    if (userMessage.status === 'failed') {
      const assistantId = `pending-${userMessage.id}`;
      setMessages((prev) => {
        if (prev.some((m) => m.id === assistantId)) return prev;
        const failureMessage: Message = {
          id: assistantId,
          role: 'assistant',
          content: userMessage.last_error
            ? `This reply failed: ${userMessage.last_error}`
            : 'This reply failed.',
          reply_to_message_id: userMessage.id,
        };
        return [...prev, failureMessage];
      });
      return;
    }
    beginStream(
      targetConversationId,
      userMessage.id,
      `/conversations/${targetConversationId}/messages/${userMessage.id}/stream`,
    );
  }

  async function handleSend(content: string) {
    if (!conversationId || sending) return;
    setSending(true);
    setErrorMessage(null);

    try {
      const { messageId, streamUrl } = await sendMessage(conversationId, clientIdRef.current, content);
      const userMessage: Message = { id: messageId, role: 'user', content };
      setMessages((prev) => [...prev, userMessage]);
      refreshConversations();
      beginStream(conversationId, messageId, streamUrl);
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

        {initState === 'ready' && conversationId && (
          <>
            <MessageList messages={messages} conversationId={conversationId} compactions={compactions} />
            {errorMessage && (
              <div className="px-4 py-1 text-center text-xs text-red-500">{errorMessage}</div>
            )}
            <StatsBar messages={messages} sending={sending} compactions={compactions} />
            <Composer onSend={handleSend} disabled={sending} />
          </>
        )}
      </div>
    </div>
  );
}
