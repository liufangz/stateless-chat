import { useState } from 'react';
import type { ConversationSummary } from '../types';
import { useMediaQuery } from '../lib/useMediaQuery';

interface SidebarProps {
  conversations: ConversationSummary[];
  currentId: string | null;
  loading: boolean;
  disabled: boolean;
  collapsed: boolean;
  mobileOpen: boolean;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  onLogout: () => void;
  onMobileClose: () => void;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function Sidebar({ conversations, currentId, loading, disabled, collapsed, mobileOpen, onSelect, onNewChat, onDelete, onLogout, onMobileClose }: SidebarProps) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const isMobile = useMediaQuery('(max-width: 639.98px)');
  const hidden = isMobile ? !mobileOpen : collapsed;

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onMobileClose}
        className={`fixed inset-0 z-40 bg-slate-900/40 transition-opacity duration-200 ease-in-out sm:hidden ${
          mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <aside
        inert={hidden}
        aria-hidden={hidden}
        className={`fixed inset-y-0 left-0 z-50 flex w-72 shrink-0 flex-col overflow-hidden border-r border-slate-200 bg-white shadow-xl transition-transform duration-200 ease-in-out sm:static sm:z-auto sm:translate-x-0 sm:shadow-none sm:transition-[width] ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        } ${collapsed ? 'sm:w-0' : 'sm:w-64'}`}
      >
        <div className="w-full border-b border-slate-200 p-3 sm:w-64">
          <button
            type="button"
            onClick={onNewChat}
            disabled={disabled}
            className="w-full rounded-lg bg-indigo-600 px-3 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300 sm:py-2"
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
            const isConfirming = confirmingId === conversation.id;
            const snippet = conversation.last_message
              ? `${conversation.last_message_role === 'assistant' ? 'AI: ' : ''}${conversation.last_message}`
              : 'New conversation';

            return (
              <div
                key={conversation.id}
                className={`group relative border-b border-slate-100 ${isActive ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(conversation.id)}
                  disabled={disabled}
                  className="block w-full px-3 py-2.5 pr-9 text-left transition disabled:cursor-not-allowed"
                >
                  <div className={`truncate text-sm ${isActive ? 'font-medium text-indigo-700' : 'text-slate-700'}`}>
                    {snippet}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-400">{formatTimestamp(conversation.updated_at)}</div>
                </button>

                {!isConfirming && (
                  <button
                    type="button"
                    aria-label="Delete conversation"
                    disabled={disabled}
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmingId(conversation.id);
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 opacity-0 transition hover:bg-slate-200 hover:text-red-600 focus:opacity-100 disabled:pointer-events-none group-hover:opacity-100"
                  >
                    <TrashIcon />
                  </button>
                )}

                {isConfirming && (
                  <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmingId(null);
                        onDelete(conversation.id);
                      }}
                      className="rounded bg-red-600 px-1.5 py-0.5 text-xs font-medium text-white hover:bg-red-700"
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmingId(null);
                      }}
                      className="rounded px-1.5 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-200"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="border-t border-slate-200 p-3">
          <button
            type="button"
            onClick={onLogout}
            className="w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
          >
            Log out
          </button>
        </div>
      </aside>
    </>
  );
}

function TrashIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path
        fillRule="evenodd"
        d="M8.75 1a.75.75 0 0 0-.75.75V3H4.5a.75.75 0 0 0 0 1.5h.32l.83 10.79A2.25 2.25 0 0 0 7.9 17.5h4.2a2.25 2.25 0 0 0 2.25-2.21L15.18 4.5h.32a.75.75 0 0 0 0-1.5H12v-1.25a.75.75 0 0 0-.75-.75h-2.5ZM9 6.5a.75.75 0 0 1 .75.75v6a.75.75 0 0 1-1.5 0v-6A.75.75 0 0 1 9 6.5Zm2.75.75a.75.75 0 0 0-1.5 0v6a.75.75 0 0 0 1.5 0v-6Z"
        clipRule="evenodd"
      />
    </svg>
  );
}
