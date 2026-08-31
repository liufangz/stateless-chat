import { describe, it, expect } from 'vitest';
import { computeContextStats, formatContextLabel, CONTEXT_WINDOW_TOKENS } from '../src/components/StatsBar';
import type { Message } from '../src/types';

function assistantMsg(id: string, usage: Message['usage']): Message {
  return { id, role: 'assistant', content: 'reply', usage };
}

describe('computeContextStats', () => {
  it('with no messages, or no message carrying usage, reports no context occupation', () => {
    expect(computeContextStats([])).toBeNull();
    expect(computeContextStats([{ id: 'u1', role: 'user', content: 'hi' }])).toBeNull();
  });

  it('a tool-heavy turn: uses contextTokens, not the (much larger) promptTokens + completionTokens sum', () => {
    // Cumulative API usage across many tool-loop round-trips: ~15,000 tokens.
    // What the last call actually sent (context occupation): 1,200 tokens.
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'do a lot of tool calls' },
      assistantMsg('a1', {
        promptTokens: 14000,
        completionTokens: 900,
        durationMs: 8000,
        contextTokens: 1200,
      }),
    ];

    const stats = computeContextStats(messages);
    expect(stats).not.toBeNull();
    expect(stats!.usedTokens).toBe(1200);
    // The cumulative sum would be ~14900 - assert we're nowhere near it.
    expect(stats!.usedTokens).toBeLessThan(messages[1].usage!.promptTokens + messages[1].usage!.completionTokens);
  });

  it('a freshly completed turn and a reloaded historical conversation derive the same metric from the same field', () => {
    const freshlyStreamed: Message[] = [
      { id: 'u1', role: 'user', content: 'hi' },
      assistantMsg('a1', { promptTokens: 500, completionTokens: 20, durationMs: 1000, contextTokens: 340 }),
    ];
    // A page reload re-fetches history - same shape, same field, populated
    // by the same backend logic (see packages/gateway/src/group-history.ts).
    const reloadedHistorical: Message[] = [
      { id: 'u1', role: 'user', content: 'hi', status: 'done' },
      { ...assistantMsg('a1', { promptTokens: 500, completionTokens: 20, durationMs: 1000, contextTokens: 340 }), status: 'done' },
    ];

    expect(computeContextStats(freshlyStreamed)).toEqual(computeContextStats(reloadedHistorical));
  });

  it('picks only the most recent turn with usage, not a sum across the conversation', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'first' },
      assistantMsg('a1', { promptTokens: 1000, completionTokens: 50, durationMs: 500, contextTokens: 400 }),
      { id: 'u2', role: 'user', content: 'second' },
      assistantMsg('a2', { promptTokens: 1200, completionTokens: 60, durationMs: 600, contextTokens: 550 }),
    ];

    const stats = computeContextStats(messages);
    expect(stats!.usedTokens).toBe(550); // latest turn only, not 400 + 550
  });

  it('clamps the reported percentage at 100 when used exceeds capacity', () => {
    const messages: Message[] = [assistantMsg('a1', { promptTokens: 1, completionTokens: 1, durationMs: 1, contextTokens: CONTEXT_WINDOW_TOKENS * 2 })];
    const stats = computeContextStats(messages)!;
    expect(stats.percent).toBe(100);
  });
});

describe('formatContextLabel', () => {
  it('shows used/capacity with the 270k capacity visible, plus a percentage', () => {
    const label = formatContextLabel({ usedTokens: 82345, capacityTokens: CONTEXT_WINDOW_TOKENS, percent: 30 });
    expect(label).toContain('270k');
    expect(label).toMatch(/82\.3k/);
    expect(label).toMatch(/\(30%\)/);
  });

  it('never renders as a bare cumulative-usage token count with no capacity/percentage', () => {
    const label = formatContextLabel({ usedTokens: 1234, capacityTokens: CONTEXT_WINDOW_TOKENS, percent: 0 });
    // The old cumulative label was just "<n>k tok" - the new one must always
    // carry the capacity and a percentage alongside the used figure.
    expect(label).toContain('/');
    expect(label).toContain('%');
  });
});
