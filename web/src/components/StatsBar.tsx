import type { Message } from '../types';

// The model's context window. Kept in sync by hand with the backend
// (packages/worker/src/tool-loop.ts calls out DeepSeek's 270,000-token
// window in its own comments) - there's no shared package between the web
// client and the backend to source this from at build time.
export const CONTEXT_WINDOW_TOKENS = 270_000;

function formatK(n: number): string {
  if (n >= 1000) {
    const k = (n / 1000).toFixed(1).replace(/\.0$/, '');
    return `${k}k`;
  }
  return `${n}`;
}

export interface ContextStats {
  usedTokens: number;
  capacityTokens: number;
  percent: number;
}

/**
 * Current context occupation - the latest turn's single-call prompt size
 * (usage.contextTokens), not the sum of every LLM call a tool-heavy turn
 * made. The same field is used whether `messages` came from a freshly
 * streamed `done` event or a reloaded historical conversation, since both
 * populate it identically (see MessageUsage.contextTokens).
 */
export function computeContextStats(messages: Message[]): ContextStats | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const used = messages[i].usage?.contextTokens;
    if (used != null) {
      return {
        usedTokens: used,
        capacityTokens: CONTEXT_WINDOW_TOKENS,
        percent: Math.min(100, Math.round((used / CONTEXT_WINDOW_TOKENS) * 100)),
      };
    }
  }
  return null;
}

export function formatContextLabel(stats: ContextStats): string {
  return `${formatK(stats.usedTokens)}/${formatK(stats.capacityTokens)} tok (${stats.percent}%)`;
}

export function StatsBar({ messages, sending }: { messages: Message[]; sending: boolean }) {
  const contextStats = computeContextStats(messages);
  const contextLabel = contextStats ? formatContextLabel(contextStats) : null;

  let sumCompletionTokens = 0;
  let sumDurationMs = 0;
  for (const m of messages) {
    if (!m.usage) continue;
    if (m.usage.durationMs && m.usage.durationMs > 0) {
      sumCompletionTokens += m.usage.completionTokens;
      sumDurationMs += m.usage.durationMs;
    }
  }
  const avgSpeed = sumDurationMs > 0 ? Math.round((sumCompletionTokens / (sumDurationMs / 1000)) * 10) / 10 : null;

  const streamingMessage = sending ? messages.find((m) => m.streaming) : undefined;
  const liveSpeedTps = streamingMessage?.liveSpeedTps ?? null;

  let speedLabel: string | null = null;
  if (sending) {
    speedLabel = liveSpeedTps != null ? `${liveSpeedTps.toFixed(1)} tok/s` : null;
  } else if (avgSpeed != null) {
    speedLabel = `avg ${avgSpeed.toFixed(1)} tok/s`;
  }

  const parts = [contextLabel, speedLabel].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;

  return (
    <div className="px-4 pt-1 text-center text-[11px] text-slate-400">{parts.join(' · ')}</div>
  );
}
