import { useState } from 'react';
import { fetchToolCalls } from '../lib/api';
import type { ToolCallDetail, ToolCallSummary } from '../types';

function formatArgs(raw: string | undefined): string {
  if (!raw) return '(no arguments)';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function shortArgs(raw: string | undefined): string {
  if (!raw) return '';
  const inline = raw.replace(/\s+/g, ' ').trim();
  return inline.length > 40 ? `${inline.slice(0, 40)}…` : inline;
}

function Spinner() {
  return (
    <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-slate-500" />
  );
}

function ToolChip({
  call,
  expanded,
  onToggle,
}: {
  call: ToolCallSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      disabled={call.running}
      onClick={onToggle}
      className={`flex max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition ${
        call.running
          ? 'cursor-default border-slate-200 bg-slate-50 text-slate-500'
          : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'
      } ${expanded ? 'rounded-b-none border-b-transparent' : ''}`}
    >
      {call.running ? (
        <Spinner />
      ) : call.isError ? (
        <span className="shrink-0 text-red-500">✗</span>
      ) : (
        <span className="shrink-0 text-emerald-600">✓</span>
      )}
      <span className="min-w-0 truncate font-mono font-medium">{call.name}</span>
      {call.arguments && <span className="min-w-0 truncate text-slate-400">{shortArgs(call.arguments)}</span>}
    </button>
  );
}

export function ToolCalls({
  conversationId,
  toolCalls,
  replyToMessageId,
}: {
  conversationId: string;
  toolCalls: ToolCallSummary[];
  replyToMessageId?: string | null;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ToolCallDetail>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (toolCalls.length === 0) return null;

  async function toggle(call: ToolCallSummary) {
    if (call.running) return;
    if (expandedId === call.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(call.id);
    setError(null);
    if (details[call.id] || !replyToMessageId) return;

    setLoadingId(call.id);
    try {
      const list = await fetchToolCalls(conversationId, replyToMessageId);
      setDetails((prev) => {
        const next = { ...prev };
        for (const item of list) next[item.id] = item;
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tool result');
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <div className="mb-2 flex max-w-full min-w-0 flex-col items-start gap-1">
      {toolCalls.map((call) => {
        const expanded = expandedId === call.id;
        const detail = details[call.id];
        return (
          <div key={call.id} className="max-w-full min-w-0">
            <ToolChip call={call} expanded={expanded} onToggle={() => toggle(call)} />
            {expanded && (
              <div className="max-w-md rounded-b-lg rounded-tr-lg border border-slate-200 bg-slate-50 p-2.5 text-xs text-slate-700">
                {loadingId === call.id && !detail && <div className="text-slate-400">Loading…</div>}
                {error && !detail && <div className="text-red-500">{error}</div>}
                {detail && (
                  <>
                    <div className="mb-1 font-medium text-slate-500">Arguments</div>
                    <pre className="mb-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px]">
                      {formatArgs(detail.arguments)}
                    </pre>
                    <div className="mb-1 font-medium text-slate-500">Result</div>
                    <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px]">
                      {detail.result}
                    </pre>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
