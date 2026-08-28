import { useState } from 'react';
import type { CompactionSummary } from '../types';

function relativeDate(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  return `${diffDay}d ago`;
}

function CheckpointIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 shrink-0">
      <path
        fillRule="evenodd"
        d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.39Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0V5.36l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.219Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function CompactionNote({ compaction }: { compaction: CompactionSummary }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-2 rounded-lg border border-slate-200 bg-slate-50/80 text-xs text-slate-500">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:text-slate-700"
        aria-expanded={expanded}
      >
        <CheckpointIcon />
        <span className="truncate">Context checkpoint · {relativeDate(compaction.createdAt)}</span>
        <span className="ml-auto shrink-0 text-slate-400">{expanded ? '−' : '+'}</span>
      </button>
      {expanded && (
        <div className="border-t border-slate-200 px-3 py-2 whitespace-pre-wrap text-slate-600">
          {compaction.summary}
        </div>
      )}
    </div>
  );
}

/** Oldest-first so notes read top-to-bottom in the same order as the conversation. */
export function CompactionNotes({ compactions }: { compactions: CompactionSummary[] }) {
  if (compactions.length === 0) return null;
  const chronological = [...compactions].reverse();
  return (
    <div>
      {chronological.map((c) => (
        <CompactionNote key={c.id} compaction={c} />
      ))}
    </div>
  );
}
