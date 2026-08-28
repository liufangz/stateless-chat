import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message, MessageStep, ToolCallSummary } from '../types';
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

/**
 * Groups consecutive steps of the same kind so tool chips from one LLM
 * round-trip render as a single block, while text steps stay separate
 * bubbles that appear "around" the tool calls in stream order.
 */
function groupSteps(steps: MessageStep[]): MessageStep[][] {
  const groups: MessageStep[][] = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (last && last[0].type === step.type) {
      last.push(step);
    } else {
      groups.push([step]);
    }
  }
  return groups;
}

export function MessageBubble({ message, conversationId }: { message: Message; conversationId: string }) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="min-w-0 max-w-[95%] rounded-2xl rounded-br-sm bg-indigo-600 px-4 py-2.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap text-white shadow-sm">
          {message.content}
        </div>
      </div>
    );
  }

  const replyToMessageId = message.reply_to_message_id ?? message.id;

  // Live streaming replies carry an ordered list of text/tool steps, so the
  // tool calls render in the middle of the turn (where they actually happen)
  // instead of piling up above the final message.
  if (message.steps && message.steps.length > 0) {
    return (
      <div className="flex justify-start">
        <div className="flex max-w-[95%] min-w-0 flex-col items-start">
          {groupSteps(message.steps).map((group, index) =>
            group[0].type === 'tool' ? (
              <ToolCalls
                key={`tool-${group[0].id}`}
                conversationId={conversationId}
                toolCalls={group as ToolCallSummary[]}
                replyToMessageId={replyToMessageId}
              />
            ) : (
              <div
                key={`text-${index}`}
                className="mb-2 min-w-0 rounded-2xl rounded-bl-sm border border-slate-200 bg-white px-4 py-2.5 text-[15px] leading-relaxed break-words text-slate-800 shadow-sm last:mb-0"
              >
                {group[0].content && <MarkdownContent content={group[0].content} />}
                {message.streaming && (
                  <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-slate-400 align-middle" />
                )}
                {message.streaming && message.liveSpeedTps != null && (
                  <span className="ml-1.5 align-middle text-xs text-slate-400">
                    {message.liveSpeedTps.toFixed(1)} tok/s
                  </span>
                )}
              </div>
            ),
          )}
        </div>
      </div>
    );
  }

  const hasToolCalls = !!message.tool_calls && message.tool_calls.length > 0;

  return (
    <div className="flex justify-start">
      <div className="flex max-w-[95%] min-w-0 flex-col items-start">
        {hasToolCalls && (
          <ToolCalls
            conversationId={conversationId}
            toolCalls={message.tool_calls!}
            replyToMessageId={replyToMessageId}
          />
        )}
        {(message.content || (message.streaming && !hasToolCalls)) && (
          <div
            className={`min-w-0 rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed break-words shadow-sm ${
              'bg-white text-slate-800 border border-slate-200 rounded-bl-sm'
            }`}
          >
            {message.content && <MarkdownContent content={message.content} />}
            {message.streaming && (
              <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-slate-400 align-middle" />
            )}
            {message.streaming && message.liveSpeedTps != null && (
              <span className="ml-1.5 align-middle text-xs text-slate-400">
                {message.liveSpeedTps.toFixed(1)} tok/s
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
