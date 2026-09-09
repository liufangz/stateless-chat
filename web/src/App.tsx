import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  ApiError,
  checkAuthStatus,
  createConversation,
  deleteConversation,
  fetchToolCalls,
  getBoundTools,
  getHistory,
  listConversations,
  logout,
  sendMessage,
  streamReply,
} from './lib/api';
import { getOrCreateClientId, getSidebarCollapsed, getStoredConversationId, setSidebarCollapsed, setStoredConversationId } from './lib/storage';
import { useMediaQuery } from './lib/useMediaQuery';
import {
  EMPTY_CONVERSATION_ENTRY,
  conversationsReducer,
  estimateVisibleTokens,
  findOutstandingUserMessage,
  type ConversationAction,
  type ConversationsState,
} from './lib/conversationStore';
import type { ConversationSummary, Message, ToolManifest } from './types';
import { MessageList } from './components/MessageList';
import { StatsBar } from './components/StatsBar';
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
  // `conversationId` is purely the SELECTED/viewed conversation - separate
  // from the per-conversation data store below. A conversation's messages,
  // stream, and sending state all live in `convState` independently of
  // whether it's currently selected, which is what lets a background
  // conversation keep streaming while a different one is in view.
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Slash-invoked tools (docs/FEATURE-slash-tools.md): the bound-tool set for
  // whichever conversation is currently selected. null while not yet loaded
  // (or for a conversation whose fetch failed) - Composer treats that the
  // same as "no tools", never blocking a normal send.
  const [tools, setTools] = useState<ToolManifest[] | null>(null);
  const [initState, setInitState] = useState<InitState>('loading');
  // Only for failures with no conversation to attach them to yet (initial
  // load, creating a brand-new chat) - everything else is a per-conversation
  // error in convState, so one conversation's error never blanks another's.
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsedState] = useState<boolean>(() => getSidebarCollapsed());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isMobile = useMediaQuery('(max-width: 639.98px)');

  const [convState, dispatch] = useReducer(conversationsReducer, {} as ConversationsState);
  // Long-lived stream callbacks and background-resume/guard logic need to
  // read the LATEST per-conversation state without re-subscribing on every
  // change or waiting for a render - `convState` itself only reflects
  // React's committed state as of the last render, which can lag behind a
  // dispatch that was JUST issued in the same synchronous call stack (e.g.
  // a second rapid click landing before React re-renders). `dispatchSync`
  // is the single choke point every dispatch in this component goes
  // through: it advances `convStateRef.current` immediately, via the exact
  // same pure reducer React itself will apply, so any guard that reads
  // `convStateRef.current` right after a dispatch always sees the
  // up-to-date result - never a stale pre-dispatch value.
  const convStateRef = useRef<ConversationsState>(convState);
  const dispatchSync = useCallback((action: ConversationAction) => {
    convStateRef.current = conversationsReducer(convStateRef.current, action);
    dispatch(action);
  }, []);
  // Synchronous (not render-cycle-dependent) guard against starting two
  // background resumes for the same conversation.
  const resumingRef = useRef<Set<string>>(new Set());

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

  // Slash-invoked tools: refetch (cached per-conversation in api.ts, so this
  // is a cache hit after the first load) whenever the selected conversation
  // changes. Best-effort - a failed fetch just leaves `tools` null, which
  // Composer treats as "no picker available", never blocking a normal send.
  useEffect(() => {
    if (!conversationId) {
      setTools(null);
      return;
    }
    let cancelled = false;
    getBoundTools(conversationId)
      .then((fetched) => {
        if (!cancelled) setTools(fetched);
      })
      .catch(() => {
        if (!cancelled) setTools(null);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Subscribes to a turn's SSE stream and wires it to this conversation's
  // entry in convState - regardless of whether that conversation is
  // currently selected. Used both for a message just sent (handleSend) and
  // to resume a turn that was still pending/processing when history loaded
  // (a reload mid-turn, another client's turn, or a different conversation
  // discovered via the sidebar list) - the stream endpoint is safe to open
  // at any point in a turn's lifecycle.
  const beginStream = useCallback(
    (targetConversationId: string, replyToMessageId: string, streamUrl: string, userMessage?: Message) => {
      const assistantId = `pending-${replyToMessageId}`;

      // Live tok/s estimate. SSE events are text chunks, not tokens, so
      // derive a conservative estimate from the accumulated visible text
      // rather than counting one token per event.
      let streamedText = '';
      let firstTokenAt = 0;
      let lastSpeedRenderAt = 0;

      const closeStream = streamReply(streamUrl, {
        onToken: (chunk) => {
          const now = Date.now();
          streamedText += chunk;
          if (!firstTokenAt) firstTokenAt = now;
          let liveSpeedTps: number | undefined;
          if (now - lastSpeedRenderAt >= 300) {
            lastSpeedRenderAt = now;
            const elapsedSec = (now - firstTokenAt) / 1000;
            if (elapsedSec > 0) {
              liveSpeedTps = Math.round((estimateVisibleTokens(streamedText) / elapsedSec) * 10) / 10;
            }
          }
          dispatchSync({ type: 'turn/token', id: targetConversationId, assistantId, chunk, liveSpeedTps });
        },
        onToolStart: ({ toolCallId, toolName, args }) => {
          dispatchSync({ type: 'turn/toolStart', id: targetConversationId, assistantId, toolCallId, toolName, args });
        },
        onToolEnd: ({ toolCallId, isError }) => {
          dispatchSync({ type: 'turn/toolEnd', id: targetConversationId, assistantId, toolCallId, isError });
        },
        onDone: async (_fullContent, { speedTps, durationMs, usage }) => {
          dispatchSync({
            type: 'turn/done',
            id: targetConversationId,
            assistantId,
            speedTps,
            usage:
              usage && durationMs != null
                ? {
                    promptTokens: usage.promptTokens,
                    completionTokens: usage.completionTokens,
                    durationMs,
                    contextTokens: usage.contextTokens,
                  }
                : null,
          });
          try {
            // Refresh compactions only; keep the in-memory turn above.
            const history = await getHistory(targetConversationId);
            dispatchSync({ type: 'compactions/refreshed', id: targetConversationId, compactions: history.compactions });
          } catch {
            // Best-effort refresh - the streamed content already rendered above.
          }
          try {
            // Materializes a missed tool chip from the DB
            // (docs/FEATURE-slash-tools.md §4.4): a direct-tool turn is fast
            // enough that tool_start/tool_end can race ahead of the
            // EventSource attach, which would otherwise leave a stale
            // "running" chip with no tool_end to ever clear it. Scoped to
            // this ONE message (turn/toolsReconciled merges into it, unlike
            // history/loaded's full-array replace) so it can't race a second
            // turn's optimistic messages if the user has already moved on by
            // the time this resolves.
            const toolCalls = await fetchToolCalls(targetConversationId, replyToMessageId);
            dispatchSync({
              type: 'turn/toolsReconciled',
              id: targetConversationId,
              assistantId,
              toolCalls: toolCalls.map((tc) => ({
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
                isError: tc.isError,
              })),
            });
          } catch {
            // Best-effort - a live tool_start/tool_end pair already rendered
            // above in the common (non-racing) case.
          }
          refreshConversations();
        },
        onError: (message) => {
          dispatchSync({ type: 'turn/error', id: targetConversationId, assistantId, message });
          refreshConversations();
        },
      });

      if (userMessage) {
        dispatchSync({ type: 'turn/started', id: targetConversationId, userMessage, assistantId, closeStream });
      } else {
        dispatchSync({ type: 'turn/attached', id: targetConversationId, assistantId, replyToMessageId, closeStream });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Loads one conversation's full history and, if it has a turn that never
  // resolved (still pending/processing, or permanently failed), resumes or
  // surfaces it - independent of whether this conversation is selected.
  const loadConversation = useCallback(
    async (id: string): Promise<void> => {
      dispatchSync({ type: 'history/loading', id });
      const history = await getHistory(id);
      dispatchSync({ type: 'history/loaded', id, messages: history.messages, compactions: history.compactions });

      const outstanding = findOutstandingUserMessage(history.messages);
      if (!outstanding) return;

      if (outstanding.status === 'failed') {
        dispatchSync({
          type: 'turn/failed',
          id,
          assistantId: `pending-${outstanding.id}`,
          replyToMessageId: outstanding.id,
          content: outstanding.last_error ? `This reply failed: ${outstanding.last_error}` : 'This reply failed.',
        });
        return;
      }

      beginStream(id, outstanding.id, `/conversations/${id}/messages/${outstanding.id}/stream`);
    },
    [beginStream, dispatchSync]
  );

  // Ensures a conversation's history is loaded at least once, even under
  // concurrent callers - used for VIEWING a conversation (initial load,
  // selecting one, the delete fallback). Deliberately does NOT re-run once
  // `historyLoaded` is true, even if that conversation's live stream has
  // since died - re-attaching a dead stream for an outstanding turn is
  // ensureOutstandingAttached's job below, not this one's, because loading
  // history unconditionally on every call would wastefully re-fetch and
  // re-render an already-current, still-healthy conversation on every
  // refresh.
  const ensureLoaded = useCallback(
    async (id: string): Promise<void> => {
      if (convStateRef.current[id]?.historyLoaded) return;
      if (resumingRef.current.has(id)) return;
      resumingRef.current.add(id);
      try {
        await loadConversation(id);
      } finally {
        resumingRef.current.delete(id);
      }
    },
    [loadConversation]
  );

  // Ensures a conversation with a server-reported outstanding turn
  // (`outstandingMessageId`, from listConversations) currently has a LIVE
  // attachment to it - re-running loadConversation even for an
  // already-loaded conversation if it does not. This is deliberately keyed
  // on "are we attached to THIS outstanding turn specifically"
  // (sendingMessageId matching it, with a stream handle present), not on
  // `historyLoaded`: a conversation whose stream silently died (e.g. the
  // browser's EventSource gave up reconnecting after a real network
  // outage) keeps historyLoaded=true forever, so gating reattachment on
  // that flag would mean a dead background stream is never retried once
  // the conversation has been loaded once - exactly the "not permanently
  // lost" guarantee this exists to uphold.
  const ensureOutstandingAttached = useCallback(
    async (id: string, outstandingMessageId: string): Promise<void> => {
      const entry = convStateRef.current[id];
      if (entry?.sendingMessageId === outstandingMessageId && entry.closeStream) return;
      if (resumingRef.current.has(id)) return;
      resumingRef.current.add(id);
      try {
        await loadConversation(id);
      } finally {
        resumingRef.current.delete(id);
      }
    },
    [loadConversation]
  );

  const refreshConversations = useCallback(async () => {
    try {
      const { conversations: list } = await listConversations(clientIdRef.current);
      setConversations(list);
      // Multi-conversation resume: reconnect (or surface the failure of)
      // every conversation with a turn still in flight, not only the
      // selected one - best-effort, same as the rest of this refresh.
      for (const c of list) {
        if (!c.outstanding_message_id) continue;
        void ensureOutstandingAttached(c.id, c.outstanding_message_id).catch(() => {});
      }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureOutstandingAttached]);

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
            await ensureLoaded(convId);
            if (cancelled) return;
            setConversationId(convId);
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
        dispatchSync({ type: 'history/loaded', id: created.conversationId, messages: [], compactions: [] });
        setInitState('ready');
        refreshConversations();
      } catch (err) {
        if (cancelled) return;
        if (isUnauthorized(err)) {
          setAuthState('unauthenticated');
          return;
        }
        setGlobalError(err instanceof Error ? err.message : 'Failed to reach the backend');
        setInitState('error');
      }
    }

    setInitState('loading');
    init();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState]);

  // Close every open stream on unmount - a defensive backstop alongside the
  // done/error/delete/logout cleanup paths below.
  useEffect(() => {
    return () => {
      for (const entry of Object.values(convStateRef.current)) {
        entry.closeStream?.();
      }
    };
  }, []);

  // Periodic background refresh: the usual triggers (send/done/error/new
  // chat) cover the common cases, but a conversation whose stream died
  // while the user was doing nothing else (idle on a different tab, or a
  // network blip severe enough that the browser's EventSource fully gave
  // up - see api.ts's isServerSentErrorEvent) would otherwise wait
  // indefinitely for the next unrelated trigger. This is what makes "not
  // permanently lost" hold even in that idle case.
  useEffect(() => {
    if (authState !== 'authenticated' || initState !== 'ready') return;
    const interval = setInterval(() => {
      void refreshConversations();
    }, 20_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState, initState]);

  function handleLoginSuccess() {
    setAuthState('authenticated');
  }

  async function handleLogout() {
    for (const entry of Object.values(convStateRef.current)) {
      entry.closeStream?.();
    }
    try {
      await logout();
    } catch {
      // best-effort - the cookie may already be gone
    }
    setAuthState('unauthenticated');
    setInitState('loading');
    setConversationId(null);
    dispatchSync({ type: 'conversation/reset' });
    setConversations([]);
    setConversationsLoading(true);
    setGlobalError(null);
  }

  // Switching conversations never depends on any other conversation's
  // activity - only this conversation's own outstanding-turn state (via
  // convState, read at render time) disables its own composer.
  async function handleSelectConversation(id: string) {
    if (id === conversationId) return;
    setSidebarOpen(false);
    setStoredConversationId(id);
    setConversationId(id);
    try {
      await ensureLoaded(id);
      // If the sidebar's last-known summary says this conversation still
      // has a turn outstanding, make sure we're actually attached to it -
      // ensureLoaded above only loads history the FIRST time, so this is
      // what catches a conversation whose background stream silently died
      // (e.g. a real network outage) before the user ever selected it: the
      // user clicking into it is itself a good moment to double-check,
      // without waiting for the next refreshConversations poll.
      const summary = conversations.find((c) => c.id === id);
      if (summary?.outstanding_message_id) {
        await ensureOutstandingAttached(id, summary.outstanding_message_id);
      }
    } catch (err) {
      if (isUnauthorized(err)) {
        setAuthState('unauthenticated');
        return;
      }
      dispatchSync({ type: 'error/set', id, error: err instanceof Error ? err.message : 'Failed to load conversation' });
    }
  }

  async function handleNewChat() {
    setSidebarOpen(false);
    try {
      const created = await createConversation(clientIdRef.current);
      setStoredConversationId(created.conversationId);
      setConversationId(created.conversationId);
      dispatchSync({ type: 'history/loaded', id: created.conversationId, messages: [], compactions: [] });
      refreshConversations();
    } catch (err) {
      if (isUnauthorized(err)) {
        setAuthState('unauthenticated');
        return;
      }
      setGlobalError(err instanceof Error ? err.message : 'Failed to start a new chat');
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
      dispatchSync({ type: 'error/set', id, error: err instanceof Error ? err.message : 'Failed to delete conversation' });
      return;
    }

    convStateRef.current[id]?.closeStream?.();
    dispatchSync({ type: 'conversation/removed', id });

    const remaining = conversations.filter((c) => c.id !== id);
    setConversations(remaining);

    if (id !== conversationId) return;

    if (remaining.length > 0) {
      const next = remaining[0];
      setStoredConversationId(next.id);
      setConversationId(next.id);
      try {
        await ensureLoaded(next.id);
      } catch (err) {
        if (isUnauthorized(err)) {
          setAuthState('unauthenticated');
          return;
        }
        dispatchSync({
          type: 'error/set',
          id: next.id,
          error: err instanceof Error ? err.message : 'Failed to load conversation',
        });
      }
      return;
    }

    await handleNewChat();
  }

  async function handleSend(content: string) {
    const targetId = conversationId;
    if (!targetId) return;
    // Blocked, not queued: this conversation's own outstanding turn, and
    // only this conversation's - never a global/account-wide lock. Checking
    // BOTH sendingMessageId (an already-confirmed turn) and submitting
    // (a send whose POST hasn't resolved yet) is what makes this robust to
    // a rapid double-click: sendingMessageId isn't set until after the
    // `await sendMessage` below resolves, so relying on it alone would
    // leave the gap between click and response completely unguarded.
    // `submitting` is set synchronously, before that await, via
    // dispatchSync - so a second call landing in that exact gap (even in
    // the same tick) still sees it and bails out here.
    const entry = convStateRef.current[targetId];
    if (entry?.sendingMessageId || entry?.submitting) return;
    dispatchSync({ type: 'send/started', id: targetId });

    try {
      const { messageId, streamUrl } = await sendMessage(targetId, clientIdRef.current, content);
      const userMessage: Message = { id: messageId, role: 'user', content };
      beginStream(targetId, messageId, streamUrl, userMessage);
      refreshConversations();
    } catch (err) {
      // Always clear `submitting` first, regardless of outcome - otherwise
      // a 401 caught here would leave this conversation permanently unable
      // to send again after the user re-authenticates (conversation/reset
      // only fires on an explicit logout, not on this kind of mid-action
      // auth failure).
      dispatchSync({
        type: 'send/failed',
        id: targetId,
        error: err instanceof Error ? err.message : 'Failed to send message',
      });
      if (isUnauthorized(err)) {
        setAuthState('unauthenticated');
      }
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

  const activeEntry = conversationId ? convState[conversationId] ?? EMPTY_CONVERSATION_ENTRY : EMPTY_CONVERSATION_ENTRY;
  const sending = activeEntry.sendingMessageId !== null || activeEntry.submitting;

  return (
    <div className="flex h-dvh bg-slate-50">
      <Sidebar
        conversations={conversations}
        currentId={conversationId}
        loading={conversationsLoading}
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
            Could not reach the backend: {globalError}
          </div>
        )}

        {initState === 'ready' && conversationId && (
          <>
            <MessageList messages={activeEntry.messages} conversationId={conversationId} compactions={activeEntry.compactions} />
            {activeEntry.error && (
              <div className="px-4 py-1 text-center text-xs text-red-500">{activeEntry.error}</div>
            )}
            <StatsBar messages={activeEntry.messages} sending={sending} />
            <Composer onSend={handleSend} disabled={sending} tools={tools} />
          </>
        )}
      </div>
    </div>
  );
}
