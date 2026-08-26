import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message } from '../types';
import { ToolCalls } from './ToolCalls';

const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ ...props }) => (
          <a {...props} target="_blank" rel="noopener noreferrer" className="underline decoration-1 underline-offset-2 hover:text-indigo-600" />
        ),
        p: ({ ...props }) => <p {...props} className="mb-2 last:mb-0" />,
        ul: ({ ...props }) => <ul {...props} className="mb-2 list-disc space-y-1 pl-5 last:mb-0" />,
        ol: ({ ...props }) => <ol {...props} className="mb-2 list-decimal space-y-1 pl-5 last:mb-0" />,
        li: ({ ...props }) => <li {...props} className="pl-0.5" />,
        h1: ({ ...props }) => <h1 {...props} className="mb-2 mt-1 text-xl font-semibold first:mt-0" />,
        h2: ({ ...props }) => <h2 {...props} className="mb-2 mt-1 text-lg font-semibold first:mt-0" />,
        h3: ({ ...props }) => <h3 {...props} className="mb-1.5 mt-1 text-base font-semibold first:mt-0" />,
        blockquote: ({ ...props }) => (
          <blockquote {...props} className="mb-2 border-l-2 border-slate-300 pl-3 italic text-slate-600 last:mb-0" />
        ),
        hr: ({ ...props }) => <hr {...props} className="my-2 border-slate-200" />,
        table: ({ ...props }) => (
          <div className="mb-2 overflow-x-auto last:mb-0">
            <table {...props} className="border-collapse text-sm" />
          </div>
        ),
        th: ({ ...props }) => <th {...props} className="border border-slate-300 px-2 py-1 text-left font-semibold" />,
        td: ({ ...props }) => <td {...props} className="border border-slate-300 px-2 py-1" />,
        code: ({ className, children, ...props }) => {
          const isBlock = /language-/.test(className ?? '') || String(children).includes('\n');
          if (!isBlock) {
            return (
              <code
                {...props}
                className="rounded bg-slate-900/8 px-1 py-0.5 font-mono text-[0.85em]"
              >
                {children}
              </code>
            );
          }
          return (
            <code {...props} className={`font-mono text-[0.85em] ${className ?? ''}`}>
              {children}
            </code>
          );
        },
        pre: ({ ...props }) => (
          <pre
            {...props}
            className="mb-2 overflow-x-auto rounded-lg bg-slate-900 px-3 py-2.5 text-slate-100 last:mb-0"
          />
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

export function MessageBubble({ message, conversationId }: { message: Message; conversationId: string }) {
  const isUser = message.role === 'user';
  const hasToolCalls = !isUser && !!message.tool_calls && message.tool_calls.length > 0;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[95%] min-w-0 rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed break-words shadow-sm ${
          isUser
            ? 'bg-indigo-600 text-white rounded-br-sm whitespace-pre-wrap'
            : 'bg-white text-slate-800 border border-slate-200 rounded-bl-sm'
        }`}
      >
        {isUser ? (
          message.content
        ) : (
          message.content && <MarkdownContent content={message.content} />
        )}
        {message.streaming && (
          <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-slate-400 align-middle" />
        )}
        {hasToolCalls && (
          <ToolCalls
            conversationId={conversationId}
            toolCalls={message.tool_calls!}
            replyToMessageId={message.reply_to_message_id ?? message.id}
          />
        )}
      </div>
    </div>
  );
}
