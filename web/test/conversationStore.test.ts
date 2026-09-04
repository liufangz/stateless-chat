import { describe, it, expect, vi } from 'vitest';
import {
  EMPTY_CONVERSATION_ENTRY,
  appendTextStep,
  conversationsReducer,
  findOutstandingUserMessage,
  type ConversationsState,
} from '../src/lib/conversationStore';
import type { Message } from '../src/types';

function userMsg(id: string, status?: Message['status']): Message {
  return { id, role: 'user', content: 'hi', status };
}

describe('appendTextStep', () => {
  it('merges consecutive text chunks into the trailing text step', () => {
    const steps = appendTextStep(appendTextStep([], 'hel'), 'lo');
    expect(steps).toEqual([{ type: 'text', content: 'hello' }]);
  });

  it('starts a new text step after a tool step', () => {
    const steps = appendTextStep(
      [{ type: 'text', content: 'before' }, { type: 'tool', id: 't1', name: 'calc', running: false }],
      'after'
    );
    expect(steps).toEqual([
      { type: 'text', content: 'before' },
      { type: 'tool', id: 't1', name: 'calc', running: false },
      { type: 'text', content: 'after' },
    ]);
  });
});

describe('findOutstandingUserMessage', () => {
  it('returns null when the conversation has no messages', () => {
    expect(findOutstandingUserMessage([])).toBeNull();
  });

  it('returns null once the last user turn has a final reply', () => {
    const messages: Message[] = [userMsg('u1', 'done'), { id: 'a1', role: 'assistant', content: 'hi there' }];
    expect(findOutstandingUserMessage(messages)).toBeNull();
  });

  it('finds a pending/processing/failed user row even when it is the very last row', () => {
    expect(findOutstandingUserMessage([userMsg('u1', 'pending')])?.id).toBe('u1');
    expect(findOutstandingUserMessage([userMsg('u1', 'processing')])?.id).toBe('u1');
    expect(findOutstandingUserMessage([userMsg('u1', 'failed')])?.id).toBe('u1');
  });

  it('finds the outstanding user row even when a tool-call-request row (assistant, no final text) is now the last row - the tool-heavy-turn case a naive "last row" check misses', () => {
    const messages: Message[] = [
      userMsg('u1', 'processing'),
      { id: 'a1', role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read_file' }] },
    ];
    expect(findOutstandingUserMessage(messages)?.id).toBe('u1');
  });

  it('ignores an older failed turn once a newer turn in the same conversation has completed', () => {
    const messages: Message[] = [
      userMsg('u0', 'done'),
      { id: 'a0', role: 'assistant', content: 'old reply' },
      userMsg('u1', 'done'),
      { id: 'a1', role: 'assistant', content: 'new reply' },
    ];
    expect(findOutstandingUserMessage(messages)).toBeNull();
  });
});

describe('conversationsReducer: per-conversation isolation (no cross-contamination)', () => {
  it('two simultaneous streams update only their own conversation entry', () => {
    let state: ConversationsState = {};
    const closeA = vi.fn();
    const closeB = vi.fn();

    state = conversationsReducer(state, {
      type: 'turn/started',
      id: 'conv-a',
      userMessage: userMsg('u-a'),
      assistantId: 'pending-u-a',
      closeStream: closeA,
    });
    state = conversationsReducer(state, {
      type: 'turn/started',
      id: 'conv-b',
      userMessage: userMsg('u-b'),
      assistantId: 'pending-u-b',
      closeStream: closeB,
    });

    state = conversationsReducer(state, { type: 'turn/token', id: 'conv-a', assistantId: 'pending-u-a', chunk: 'Hello A' });
    state = conversationsReducer(state, { type: 'turn/token', id: 'conv-b', assistantId: 'pending-u-b', chunk: 'Hello B' });
    state = conversationsReducer(state, { type: 'turn/token', id: 'conv-a', assistantId: 'pending-u-a', chunk: '!' });

    const aAssistant = state['conv-a'].messages.find((m) => m.id === 'pending-u-a')!;
    const bAssistant = state['conv-b'].messages.find((m) => m.id === 'pending-u-b')!;
    expect(aAssistant.content).toBe('Hello A!');
    expect(bAssistant.content).toBe('Hello B');

    // Neither conversation's message list contains the other's rows.
    expect(state['conv-a'].messages.some((m) => m.id === 'pending-u-b')).toBe(false);
    expect(state['conv-b'].messages.some((m) => m.id === 'pending-u-a')).toBe(false);
    expect(state['conv-a'].sendingMessageId).toBe('u-a');
    expect(state['conv-b'].sendingMessageId).toBe('u-b');
  });

  it('completing one conversation\'s turn does not affect the other\'s in-flight state', () => {
    let state: ConversationsState = {};
    state = conversationsReducer(state, {
      type: 'turn/started',
      id: 'conv-a',
      userMessage: userMsg('u-a'),
      assistantId: 'pending-u-a',
      closeStream: vi.fn(),
    });
    state = conversationsReducer(state, {
      type: 'turn/started',
      id: 'conv-b',
      userMessage: userMsg('u-b'),
      assistantId: 'pending-u-b',
      closeStream: vi.fn(),
    });

    state = conversationsReducer(state, {
      type: 'turn/done',
      id: 'conv-a',
      assistantId: 'pending-u-a',
      speedTps: 12.3,
      usage: null,
    });

    expect(state['conv-a'].sendingMessageId).toBeNull();
    expect(state['conv-a'].closeStream).toBeNull();
    // conv-b is untouched: still sending, stream handle still present.
    expect(state['conv-b'].sendingMessageId).toBe('u-b');
    expect(state['conv-b'].closeStream).not.toBeNull();
  });
});

describe('conversationsReducer: switching mid-stream preserves progress', () => {
  it('a conversation not currently selected keeps accumulating tokens, and shows full progress once selected again', () => {
    let state: ConversationsState = {};
    state = conversationsReducer(state, {
      type: 'turn/started',
      id: 'conv-a',
      userMessage: userMsg('u-a'),
      assistantId: 'pending-u-a',
      closeStream: vi.fn(),
    });

    // Simulate the user switching away (a real switch in App.tsx just
    // changes `conversationId`, which the store knows nothing about) and
    // several more tokens arriving while conv-a is not selected.
    for (const chunk of ['One', ' two', ' three']) {
      state = conversationsReducer(state, { type: 'turn/token', id: 'conv-a', assistantId: 'pending-u-a', chunk });
    }

    const assistant = state['conv-a'].messages.find((m) => m.id === 'pending-u-a')!;
    expect(assistant.content).toBe('One two three');
  });
});

describe('conversationsReducer: stream cleanup', () => {
  it('turn/done clears the stream handle so a stale close() is never called twice by the app', () => {
    let state: ConversationsState = {};
    const close = vi.fn();
    state = conversationsReducer(state, {
      type: 'turn/started',
      id: 'conv-a',
      userMessage: userMsg('u-a'),
      assistantId: 'pending-u-a',
      closeStream: close,
    });
    expect(state['conv-a'].closeStream).toBe(close);

    state = conversationsReducer(state, { type: 'turn/done', id: 'conv-a', assistantId: 'pending-u-a', speedTps: null, usage: null });
    expect(state['conv-a'].closeStream).toBeNull();
  });

  it('turn/error also clears the stream handle', () => {
    let state: ConversationsState = {};
    state = conversationsReducer(state, {
      type: 'turn/started',
      id: 'conv-a',
      userMessage: userMsg('u-a'),
      assistantId: 'pending-u-a',
      closeStream: vi.fn(),
    });
    state = conversationsReducer(state, { type: 'turn/error', id: 'conv-a', assistantId: 'pending-u-a', message: 'boom' });
    expect(state['conv-a'].closeStream).toBeNull();
    expect(state['conv-a'].sendingMessageId).toBeNull();
  });

  it('conversation/removed drops the entry entirely, so nothing in the store still references its stream handle', () => {
    let state: ConversationsState = {};
    state = conversationsReducer(state, {
      type: 'turn/started',
      id: 'conv-a',
      userMessage: userMsg('u-a'),
      assistantId: 'pending-u-a',
      closeStream: vi.fn(),
    });
    state = conversationsReducer(state, { type: 'conversation/removed', id: 'conv-a' });
    expect(state['conv-a']).toBeUndefined();
    expect('conv-a' in state).toBe(false);
  });

  it('conversation/reset (logout) drops every entry', () => {
    let state: ConversationsState = {};
    state = conversationsReducer(state, {
      type: 'turn/started',
      id: 'conv-a',
      userMessage: userMsg('u-a'),
      assistantId: 'pending-u-a',
      closeStream: vi.fn(),
    });
    state = conversationsReducer(state, {
      type: 'turn/started',
      id: 'conv-b',
      userMessage: userMsg('u-b'),
      assistantId: 'pending-u-b',
      closeStream: vi.fn(),
    });
    state = conversationsReducer(state, { type: 'conversation/reset' });
    expect(state).toEqual({});
  });
});

describe('conversationsReducer: same-conversation send blocking is per-conversation', () => {
  it('sendingMessageId being set is what App.tsx uses to block a second send - scoped to one conversation only', () => {
    let state: ConversationsState = {};
    state = conversationsReducer(state, {
      type: 'turn/started',
      id: 'conv-a',
      userMessage: userMsg('u-a'),
      assistantId: 'pending-u-a',
      closeStream: vi.fn(),
    });

    // conv-a is blocked (sending in progress)...
    expect(state['conv-a'].sendingMessageId).not.toBeNull();
    // ...but conv-b, having never started a turn, is not - unaffected by
    // conv-a's activity, matching "never a global account/UI lock".
    expect((state['conv-b'] ?? EMPTY_CONVERSATION_ENTRY).sendingMessageId).toBeNull();

    state = conversationsReducer(state, {
      type: 'turn/started',
      id: 'conv-b',
      userMessage: userMsg('u-b'),
      assistantId: 'pending-u-b',
      closeStream: vi.fn(),
    });
    expect(state['conv-b'].sendingMessageId).not.toBeNull();
  });

  it('a second turn/started for the same assistant id (duplicate dispatch) is a no-op, not a duplicate message', () => {
    let state: ConversationsState = {};
    const closeFirst = vi.fn();
    state = conversationsReducer(state, {
      type: 'turn/started',
      id: 'conv-a',
      userMessage: userMsg('u-a'),
      assistantId: 'pending-u-a',
      closeStream: closeFirst,
    });
    const messageCountBefore = state['conv-a'].messages.length;

    state = conversationsReducer(state, {
      type: 'turn/started',
      id: 'conv-a',
      userMessage: userMsg('u-a'),
      assistantId: 'pending-u-a',
      closeStream: vi.fn(),
    });

    expect(state['conv-a'].messages.length).toBe(messageCountBefore);
  });
});

describe('conversationsReducer: tool call lifecycle and per-conversation errors', () => {
  it('tool_start/tool_end update the right assistant message only', () => {
    let state: ConversationsState = {};
    state = conversationsReducer(state, {
      type: 'turn/started',
      id: 'conv-a',
      userMessage: userMsg('u-a'),
      assistantId: 'pending-u-a',
      closeStream: vi.fn(),
    });
    state = conversationsReducer(state, {
      type: 'turn/toolStart',
      id: 'conv-a',
      assistantId: 'pending-u-a',
      toolCallId: 'call-1',
      toolName: 'read_file',
      args: { path: 'a.txt' },
    });
    let assistant = state['conv-a'].messages.find((m) => m.id === 'pending-u-a')!;
    expect(assistant.tool_calls?.[0]).toMatchObject({ id: 'call-1', name: 'read_file', running: true });

    state = conversationsReducer(state, {
      type: 'turn/toolEnd',
      id: 'conv-a',
      assistantId: 'pending-u-a',
      toolCallId: 'call-1',
      isError: false,
    });
    assistant = state['conv-a'].messages.find((m) => m.id === 'pending-u-a')!;
    expect(assistant.tool_calls?.[0]).toMatchObject({ id: 'call-1', running: false, isError: false });
  });

  it('an error set on one conversation never appears on another', () => {
    let state: ConversationsState = {};
    state = conversationsReducer(state, { type: 'error/set', id: 'conv-a', error: 'boom in A' });
    expect(state['conv-a'].error).toBe('boom in A');
    expect((state['conv-b'] ?? EMPTY_CONVERSATION_ENTRY).error).toBeNull();
  });

  it('error/cleared only clears the named conversation', () => {
    let state: ConversationsState = {};
    state = conversationsReducer(state, { type: 'error/set', id: 'conv-a', error: 'boom' });
    state = conversationsReducer(state, { type: 'error/set', id: 'conv-b', error: 'also boom' });
    state = conversationsReducer(state, { type: 'error/cleared', id: 'conv-a' });
    expect(state['conv-a'].error).toBeNull();
    expect(state['conv-b'].error).toBe('also boom');
  });
});

describe('conversationsReducer: resuming an outstanding turn on reload', () => {
  it('turn/attached appends a live assistant placeholder to already-loaded history without duplicating the user row', () => {
    let state: ConversationsState = {};
    state = conversationsReducer(state, {
      type: 'history/loaded',
      id: 'conv-a',
      messages: [userMsg('u-a', 'processing')],
      compactions: [],
    });
    state = conversationsReducer(state, {
      type: 'turn/attached',
      id: 'conv-a',
      assistantId: 'pending-u-a',
      replyToMessageId: 'u-a',
      closeStream: vi.fn(),
    });

    expect(state['conv-a'].messages).toHaveLength(2);
    expect(state['conv-a'].sendingMessageId).toBe('u-a');
  });

  it('turn/failed surfaces a permanently-failed outstanding turn as an assistant-shaped message, without a live stream', () => {
    let state: ConversationsState = {};
    state = conversationsReducer(state, {
      type: 'history/loaded',
      id: 'conv-a',
      messages: [userMsg('u-a', 'failed')],
      compactions: [],
    });
    state = conversationsReducer(state, {
      type: 'turn/failed',
      id: 'conv-a',
      assistantId: 'pending-u-a',
      replyToMessageId: 'u-a',
      content: 'This reply failed: boom',
    });

    expect(state['conv-a'].messages).toHaveLength(2);
    expect(state['conv-a'].messages[1].content).toBe('This reply failed: boom');
    expect(state['conv-a'].sendingMessageId).toBeNull();
  });
});

describe('conversationsReducer: rapid double-submit guard (submitting flag)', () => {
  it('send/started marks the conversation submitting synchronously, before any server response exists', () => {
    let state: ConversationsState = {};
    state = conversationsReducer(state, { type: 'send/started', id: 'conv-a' });
    expect(state['conv-a'].submitting).toBe(true);
    // No sendingMessageId yet - that only exists once the server has
    // confirmed a real message id (turn/started). submitting is what
    // covers the gap before that.
    expect(state['conv-a'].sendingMessageId).toBeNull();
  });

  it('a second send/started while already submitting is what App.tsx\'s handleSend guard checks for - the flag stays true, not toggled', () => {
    let state: ConversationsState = {};
    state = conversationsReducer(state, { type: 'send/started', id: 'conv-a' });
    state = conversationsReducer(state, { type: 'send/started', id: 'conv-a' });
    expect(state['conv-a'].submitting).toBe(true);
  });

  it('turn/started (the server confirmed a real messageId) clears submitting and sets sendingMessageId - the handoff from the pre-response guard to the confirmed one', () => {
    let state: ConversationsState = {};
    state = conversationsReducer(state, { type: 'send/started', id: 'conv-a' });
    state = conversationsReducer(state, {
      type: 'turn/started',
      id: 'conv-a',
      userMessage: userMsg('u-a'),
      assistantId: 'pending-u-a',
      closeStream: vi.fn(),
    });
    expect(state['conv-a'].submitting).toBe(false);
    expect(state['conv-a'].sendingMessageId).toBe('u-a');
  });

  it('send/failed clears submitting (so a subsequent send is not permanently blocked) and records the error', () => {
    let state: ConversationsState = {};
    state = conversationsReducer(state, { type: 'send/started', id: 'conv-a' });
    state = conversationsReducer(state, { type: 'send/failed', id: 'conv-a', error: 'network down' });
    expect(state['conv-a'].submitting).toBe(false);
    expect(state['conv-a'].error).toBe('network down');
    expect(state['conv-a'].sendingMessageId).toBeNull();
  });

  it('submitting is per-conversation, exactly like sendingMessageId - never a global lock', () => {
    let state: ConversationsState = {};
    state = conversationsReducer(state, { type: 'send/started', id: 'conv-a' });
    expect(state['conv-a'].submitting).toBe(true);
    expect((state['conv-b'] ?? EMPTY_CONVERSATION_ENTRY).submitting).toBe(false);
  });

  it('models App.tsx\'s exact handleSend guard: two "clicks" issued before either request resolves - only the first proceeds', async () => {
    // Mirrors App.tsx's dispatchSync pattern: a ref-like variable advanced
    // synchronously via the pure reducer, checked-and-set BEFORE any
    // `await`, so a second call in the same synchronous window sees the
    // guard immediately rather than a value that's still pending an
    // effect/render to catch up.
    let stateRef: ConversationsState = {};
    function dispatchSync(action: Parameters<typeof conversationsReducer>[1]) {
      stateRef = conversationsReducer(stateRef, action);
    }

    let sendCallCount = 0;
    async function handleSend(id: string): Promise<void> {
      const entry = stateRef[id];
      if (entry?.sendingMessageId || entry?.submitting) return;
      dispatchSync({ type: 'send/started', id });
      sendCallCount++;
      await Promise.resolve(); // simulates the network round trip
      dispatchSync({
        type: 'turn/started',
        id,
        userMessage: userMsg('u-a'),
        assistantId: 'pending-u-a',
        closeStream: vi.fn(),
      });
    }

    // Two "clicks" fired back-to-back, in the same synchronous tick,
    // before either has had a chance to await anything yet.
    await Promise.all([handleSend('conv-a'), handleSend('conv-a')]);

    expect(sendCallCount).toBe(1);
    expect(stateRef['conv-a'].sendingMessageId).toBe('u-a');
  });

  it('the same guard does not block a DIFFERENT conversation\'s simultaneous send', async () => {
    let stateRef: ConversationsState = {};
    function dispatchSync(action: Parameters<typeof conversationsReducer>[1]) {
      stateRef = conversationsReducer(stateRef, action);
    }
    const started: string[] = [];
    async function handleSend(id: string): Promise<void> {
      const entry = stateRef[id];
      if (entry?.sendingMessageId || entry?.submitting) return;
      dispatchSync({ type: 'send/started', id });
      started.push(id);
    }

    await Promise.all([handleSend('conv-a'), handleSend('conv-b')]);
    expect(started.sort()).toEqual(['conv-a', 'conv-b']);
  });
});
