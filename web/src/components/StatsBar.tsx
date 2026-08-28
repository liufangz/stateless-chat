import type { CompactionSummary, Message } from '../types';

function formatCompactTokens(n: number): string {
  if (n >= 1000) {
    const k = (n / 1000).toFixed(1).replace(/\.0$/, '');
    return `${k}k tok`;
  }
  return `${n} tok`;
}

export function StatsBar({
  messages,
  sending,
  compactions = [],
}: {
  messages: Message[];
  sending: boolean;
  compactions?: CompactionSummary[];
}) {
  let totalTokens = 0;
  let hasUsage = false;
  let sumCompletionTokens = 0;
  let sumDurationMs = 0;

  for (const m of messages) {
    if (!m.usage) continue;
    hasUsage = true;
    totalTokens += m.usage.promptTokens + m.usage.completionTokens;
    if (m.usage.durationMs && m.usage.durationMs > 0) {
      sumCompletionTokens += m.usage.completionTokens;
      sumDurationMs += m.usage.durationMs;
    }
  }

  // Summarization calls burn real tokens too - pi counts them in session
  // totals, so a compacted conversation's reported usage doesn't silently
  // undercount the LLM calls that ran on its behalf.
  for (const c of compactions) {
    if (c.promptTokens == null || c.completionTokens == null) continue;
    hasUsage = true;
    totalTokens += c.promptTokens + c.completionTokens;
  }

  const totalLabel = hasUsage ? formatCompactTokens(totalTokens) : null;
  const avgSpeed = sumDurationMs > 0 ? Math.round((sumCompletionTokens / (sumDurationMs / 1000)) * 10) / 10 : null;

  const streamingMessage = sending ? messages.find((m) => m.streaming) : undefined;
  const liveSpeedTps = streamingMessage?.liveSpeedTps ?? null;

  let speedLabel: string | null = null;
  if (sending) {
    speedLabel = liveSpeedTps != null ? `${liveSpeedTps.toFixed(1)} tok/s` : null;
  } else if (avgSpeed != null) {
    speedLabel = `avg ${avgSpeed.toFixed(1)} tok/s`;
  }

  const parts = [totalLabel, speedLabel].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;

  return (
    <div className="px-4 pt-1 text-center text-[11px] text-slate-400">{parts.join(' · ')}</div>
  );
}
