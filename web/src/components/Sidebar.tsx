import type { ConversationSummary } from '../types';

interface SidebarProps {
  conversations: ConversationSummary[];
  currentId: string | null;
  loading: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
  onNewChat: () => void;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function Sidebar({ conversations, currentId, loading, disabled, onSelect, onNewChat }: SidebarProps) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="border-b border-slate-200 p-3">
        <button
          type="button"
          onClick={onNewChat}
          disabled={disabled}
          className="w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          + New chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && conversations.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-slate-400">Loading…</div>
        )}

        {!loading && conversations.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-slate-400">No conversations yet</div>
        )}

        {conversations.map((conversation) => {
          const isActive = conversation.id === currentId;
          const snippet = conversation.last_message
            ? `${conversation.last_message_role === 'assistant' ? 'AI: ' : ''}${conversation.last_message}`
            : 'New conversation';

          return (
            <button
              key={conversation.id}
              type="button"
              onClick={() => onSelect(conversation.id)}
              disabled={disabled}
              className={`block w-full border-b border-slate-100 px-3 py-2.5 text-left transition disabled:cursor-not-allowed ${
                isActive ? 'bg-indigo-50' : 'hover:bg-slate-50'
              }`}
            >
              <div className={`truncate text-sm ${isActive ? 'font-medium text-indigo-700' : 'text-slate-700'}`}>
                {snippet}
              </div>
              <div className="mt-0.5 text-xs text-slate-400">{formatTimestamp(conversation.updated_at)}</div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
