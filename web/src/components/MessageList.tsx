import { useEffect, useRef } from 'react';
import type { CompactionSummary, Message } from '../types';
import { MessageBubble } from './MessageBubble';
import { CompactionNotes } from './CompactionNotes';

export function MessageList({
  messages,
  conversationId,
  compactions = [],
}: {
  messages: Message[];
  conversationId: string;
  compactions?: CompactionSummary[];
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (messages.length === 0 && compactions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-slate-400 text-sm">
        Say hello to start the conversation.
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-2 overflow-y-auto px-4 py-6">
      <CompactionNotes compactions={compactions} />
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} conversationId={conversationId} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
