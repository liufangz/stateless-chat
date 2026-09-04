import type { CompactionSummary, Message, MessageStep, MessageUsage } from '../types';

/**
 * Per-conversation slice of chat state. Multiple entries can exist - and
 * have live streams attached - at once, independently of which conversation
 * is currently selected/viewed. This is what lets conversation A keep
 * streaming while the user is looking at conversation B: A's entry keeps
 * updating in the background, and switching back to A just renders its
 * already-current entry with nothing lost.
 */
export interface ConversationEntry {
  messages: Message[];
  compactions: CompactionSummary[];
  historyLoaded: boolean;
  historyLoading: boolean;
  /** Per-conversation error - never blanks or is blanked by another conversation's error. */
  error: string | null;
  /**
   * True from the instant a send is dispatched (synchronously, before the
   * POST /messages request even goes out) until the server has confirmed a
   * real messageId (turn/started fires) or the send failed (send/failed
   * fires). This exists SEPARATELY from `sendingMessageId` specifically to
   * close the double-submit window: `sendingMessageId` isn't set until
   * after an await, so a second rapid click that lands before that await
   * resolves would otherwise see no block at all. Combined with a
   * synchronous dispatch (see App.tsx's `dispatchSync`), this makes the
   * guard robust to a same-tick or near-simultaneous second click.
   */
  submitting: boolean;
  /** The user message id whose reply is currently in flight in THIS conversation, or null. Drives the "second send blocked" rule - per conversation, never global. */
  sendingMessageId: string | null;
  /** Cleanup handle for this conversation's currently-open EventSource, if any - closed on done/error, delete, logout, and unmount. */
  closeStream: (() => void) | null;
}

export const EMPTY_CONVERSATION_ENTRY: ConversationEntry = {
  messages: [],
  compactions: [],
  historyLoaded: false,
  historyLoading: false,
  error: null,
  submitting: false,
  sendingMessageId: null,
  closeStream: null,
};

export type ConversationsState = Record<string, ConversationEntry>;

export type ConversationAction =
  | { type: 'history/loading'; id: string }
  | { type: 'history/loaded'; id: string; messages: Message[]; compactions: CompactionSummary[] }
  | { type: 'compactions/refreshed'; id: string; compactions: CompactionSummary[] }
  | { type: 'error/set'; id: string; error: string }
  | { type: 'error/cleared'; id: string }
  | { type: 'send/started'; id: string }
  | { type: 'send/failed'; id: string; error: string }
  | { type: 'turn/started'; id: string; userMessage: Message; assistantId: string; closeStream: () => void }
  | { type: 'turn/attached'; id: string; assistantId: string; replyToMessageId: string; closeStream: () => void }
  | { type: 'turn/token'; id: string; assistantId: string; chunk: string; liveSpeedTps?: number }
  | { type: 'turn/toolStart'; id: string; assistantId: string; toolCallId: string; toolName: string; args?: unknown }
  | { type: 'turn/toolEnd'; id: string; assistantId: string; toolCallId: string; isError: boolean }
  | { type: 'turn/done'; id: string; assistantId: string; speedTps: number | null; usage: MessageUsage | null }
  | { type: 'turn/error'; id: string; assistantId: string; message: string }
  | { type: 'turn/failed'; id: string; assistantId: string; replyToMessageId: string; content: string }
  | { type: 'conversation/removed'; id: string }
  | { type: 'conversation/reset' };

/**
 * Appends a streamed text chunk to the in-progress step list, merging into
 * the trailing text step (if any) so consecutive tokens stay in one bubble
 * instead of creating a new message per token.
 */
export function appendTextStep(steps: MessageStep[], chunk: string): MessageStep[] {
  const last = steps[steps.length - 1];
  if (last && last.type === 'text') {
    return [...steps.slice(0, -1), { type: 'text', content: last.content + chunk }];
  }
  return [...steps, { type: 'text', content: chunk }];
}

/**
 * SSE `token` events are text chunks, not individual model tokens. Use the
 * same conservative character estimate as the worker for the live display;
 * the exact provider usage replaces this estimate when `done` arrives.
 */
export function estimateVisibleTokens(text: string): number {
  if (!text) return 0;
  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! < 128) {
      asciiChars += 1;
    } else {
      nonAsciiChars += 1;
    }
  }
  return Math.ceil(asciiChars / 4 + nonAsciiChars / 1.5);
}

/**
 * The conversation's most recent 'user' row that hasn't resolved yet
 * (pending/processing/failed), or null. Searches backward for the last
 * USER row specifically - not just the last row overall - because once a
 * turn has issued a tool call, the last row in a grouped history is that
 * tool-call assistant row, not the user row, even though the turn is still
 * very much unresolved.
 */
export function findOutstandingUserMessage(messages: Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    return m.status === 'pending' || m.status === 'processing' || m.status === 'failed' ? m : null;
  }
  return null;
}

function getEntry(state: ConversationsState, id: string): ConversationEntry {
  return state[id] ?? EMPTY_CONVERSATION_ENTRY;
}

function setEntry(state: ConversationsState, id: string, entry: ConversationEntry): ConversationsState {
  return { ...state, [id]: entry };
}

function updateMessage(messages: Message[], id: string, updater: (m: Message) => Message): Message[] {
  return messages.map((m) => (m.id === id ? updater(m) : m));
}

export function conversationsReducer(state: ConversationsState, action: ConversationAction): ConversationsState {
  switch (action.type) {
    case 'history/loading': {
      const entry = getEntry(state, action.id);
      return setEntry(state, action.id, { ...entry, historyLoading: true, error: null });
    }

    case 'history/loaded': {
      const entry = getEntry(state, action.id);
      return setEntry(state, action.id, {
        ...entry,
        messages: action.messages,
        compactions: action.compactions,
        historyLoaded: true,
        historyLoading: false,
        error: null,
      });
    }

    case 'compactions/refreshed': {
      const entry = getEntry(state, action.id);
      return setEntry(state, action.id, { ...entry, compactions: action.compactions });
    }

    case 'error/set': {
      const entry = getEntry(state, action.id);
      return setEntry(state, action.id, { ...entry, historyLoading: false, error: action.error });
    }

    case 'error/cleared': {
      const entry = getEntry(state, action.id);
      if (!entry.error) return state;
      return setEntry(state, action.id, { ...entry, error: null });
    }

    case 'send/started': {
      const entry = getEntry(state, action.id);
      return setEntry(state, action.id, { ...entry, submitting: true, error: null });
    }

    case 'send/failed': {
      const entry = getEntry(state, action.id);
      return setEntry(state, action.id, { ...entry, submitting: false, error: action.error });
    }

    case 'turn/started': {
      const entry = getEntry(state, action.id);
      if (entry.messages.some((m) => m.id === action.assistantId)) return state;
      const assistantMessage: Message = {
        id: action.assistantId,
        role: 'assistant',
        content: '',
        streaming: true,
        steps: [],
        reply_to_message_id: action.userMessage.id,
      };
      return setEntry(state, action.id, {
        ...entry,
        messages: [...entry.messages, action.userMessage, assistantMessage],
        submitting: false,
        sendingMessageId: action.userMessage.id,
        error: null,
        closeStream: action.closeStream,
      });
    }

    case 'turn/attached': {
      const entry = getEntry(state, action.id);
      if (entry.messages.some((m) => m.id === action.assistantId)) {
        return setEntry(state, action.id, {
          ...entry,
          sendingMessageId: action.replyToMessageId,
          closeStream: action.closeStream,
        });
      }
      const assistantMessage: Message = {
        id: action.assistantId,
        role: 'assistant',
        content: '',
        streaming: true,
        steps: [],
        reply_to_message_id: action.replyToMessageId,
      };
      return setEntry(state, action.id, {
        ...entry,
        messages: [...entry.messages, assistantMessage],
        sendingMessageId: action.replyToMessageId,
        closeStream: action.closeStream,
      });
    }

    case 'turn/token': {
      const entry = getEntry(state, action.id);
      return setEntry(state, action.id, {
        ...entry,
        messages: updateMessage(entry.messages, action.assistantId, (m) => ({
          ...m,
          content: m.content + action.chunk,
          ...(action.liveSpeedTps !== undefined ? { liveSpeedTps: action.liveSpeedTps } : {}),
          steps: appendTextStep(m.steps ?? [], action.chunk),
        })),
      });
    }

    case 'turn/toolStart': {
      const entry = getEntry(state, action.id);
      const summary = {
        id: action.toolCallId,
        name: action.toolName,
        arguments: action.args !== undefined ? JSON.stringify(action.args) : undefined,
        running: true,
      };
      return setEntry(state, action.id, {
        ...entry,
        messages: updateMessage(entry.messages, action.assistantId, (m) => ({
          ...m,
          tool_calls: [...(m.tool_calls ?? []), summary],
          steps: [...(m.steps ?? []), { type: 'tool', ...summary }],
        })),
      });
    }

    case 'turn/toolEnd': {
      const entry = getEntry(state, action.id);
      return setEntry(state, action.id, {
        ...entry,
        messages: updateMessage(entry.messages, action.assistantId, (m) => ({
          ...m,
          tool_calls: (m.tool_calls ?? []).map((tc) =>
            tc.id === action.toolCallId ? { ...tc, running: false, isError: action.isError } : tc
          ),
          steps: (m.steps ?? []).map((s) =>
            s.type === 'tool' && s.id === action.toolCallId ? { ...s, running: false, isError: action.isError } : s
          ),
        })),
      });
    }

    case 'turn/done': {
      const entry = getEntry(state, action.id);
      return setEntry(state, action.id, {
        ...entry,
        messages: updateMessage(entry.messages, action.assistantId, (m) => ({
          ...m,
          streaming: false,
          liveSpeedTps: null,
          speedTps: action.speedTps,
          usage: action.usage ?? m.usage,
        })),
        sendingMessageId: null,
        closeStream: null,
      });
    }

    case 'turn/error': {
      const entry = getEntry(state, action.id);
      return setEntry(state, action.id, {
        ...entry,
        messages: updateMessage(entry.messages, action.assistantId, (m) => ({
          ...m,
          content: m.content || `Error: ${action.message}`,
          streaming: false,
          steps: m.steps && m.steps.length > 0 ? [...m.steps, { type: 'text', content: `Error: ${action.message}` }] : m.steps,
        })),
        sendingMessageId: null,
        closeStream: null,
      });
    }

    case 'turn/failed': {
      const entry = getEntry(state, action.id);
      if (entry.messages.some((m) => m.id === action.assistantId)) return state;
      const failureMessage: Message = {
        id: action.assistantId,
        role: 'assistant',
        content: action.content,
        reply_to_message_id: action.replyToMessageId,
      };
      return setEntry(state, action.id, { ...entry, messages: [...entry.messages, failureMessage] });
    }

    case 'conversation/removed': {
      if (!(action.id in state)) return state;
      const next = { ...state };
      delete next[action.id];
      return next;
    }

    case 'conversation/reset':
      return {};

    default:
      return state;
  }
}
