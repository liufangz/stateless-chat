import { useState } from 'react';
import type { ChangeEvent, FormEvent, KeyboardEvent } from 'react';
import { buildArgsJson, buildCommand, matchTools, resolveFreehand } from '../lib/slashTools';
import type { ToolManifest } from '../types';

interface ComposerProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  /** Tools bound to the current chat (docs/FEATURE-slash-tools.md), or null while not yet loaded. */
  tools?: ToolManifest[] | null;
}

function requiredArgNames(tool: ToolManifest): Set<string> {
  return new Set(tool.args.filter((a) => a.required).map((a) => a.name));
}

function ToolRow({
  tool,
  highlighted,
  onPick,
}: {
  tool: ToolManifest;
  highlighted: boolean;
  onPick: () => void;
}) {
  const required = requiredArgNames(tool);
  return (
    <button
      type="button"
      // Selecting a tool always opens arg-entry (docs/FEATURE-slash-tools.md
      // §4.4) - mousedown, not click/onClick, so it fires before the input's
      // blur would otherwise dismiss the dropdown first.
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      className={`flex w-full min-w-0 flex-col items-start gap-0.5 px-3 py-2 text-left text-sm ${
        highlighted ? 'bg-indigo-50' : 'hover:bg-slate-50'
      }`}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="font-mono font-medium text-slate-800">/{tool.name}</span>
        {tool.args.length > 0 && (
          <span className="min-w-0 truncate font-mono text-xs text-slate-400">
            {tool.args.map((a) => (required.has(a.name) ? `${a.name}*` : a.name)).join(' ')}
          </span>
        )}
      </div>
      <span className="w-full truncate text-xs text-slate-500">{tool.description}</span>
    </button>
  );
}

export function Composer({ onSend, disabled, tools }: ComposerProps) {
  const [value, setValue] = useState('');
  const [forcedPlain, setForcedPlain] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [selectedTool, setSelectedTool] = useState<ToolManifest | null>(null);
  const [argValues, setArgValues] = useState<Record<string, string>>({});

  function resetAll() {
    setValue('');
    setForcedPlain(false);
    setHighlightIndex(0);
    setSelectedTool(null);
    setArgValues({});
  }

  function enterArgEntry(tool: ToolManifest, prefillText: string) {
    const initial: Record<string, string> = {};
    // Courtesy prefill: text already typed after the tool name lands in its
    // one field for a single-arg tool, so switching from freehand typing to
    // the arg-entry view doesn't discard what was typed.
    if (tool.args.length === 1 && prefillText.trim() !== '') {
      initial[tool.args[0].name] = prefillText.trim();
    }
    setSelectedTool(tool);
    setArgValues(initial);
    setValue('');
    setHighlightIndex(0);
  }

  const slashBody = value.startsWith('/') ? value.slice(1) : '';
  const spaceIndex = slashBody.search(/\s/);
  const nameToken = spaceIndex === -1 ? slashBody : slashBody.slice(0, spaceIndex);
  const restText = spaceIndex === -1 ? '' : slashBody.slice(spaceIndex + 1);
  const isSlashCommand = value.startsWith('/') && !forcedPlain && !!tools && !selectedTool;
  const matches = isSlashCommand ? matchTools(nameToken, tools!) : [];
  const exactMatch = isSlashCommand ? tools!.find((t) => t.name === nameToken) : undefined;

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setValue(event.target.value);
    setForcedPlain(false);
    setHighlightIndex(0);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!isSlashCommand) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      setForcedPlain(true);
      return;
    }
    if (matches.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightIndex((i) => (i + 1) % matches.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightIndex((i) => (i - 1 + matches.length) % matches.length);
      return;
    }
    if (event.key === 'Tab' || event.key === 'Enter') {
      event.preventDefault();
      // Keyboard-only fast path: typing the full name of a bound READ-ONLY
      // tool and hitting Enter submits immediately, no popup. Mutating tools
      // never take this path (Tab, or Enter on a mutating tool) - they
      // always land in arg-entry so the argument is seen in its own labeled
      // field before anything runs (docs/FEATURE-slash-tools.md §4.4/§6).
      if (event.key === 'Enter' && exactMatch && exactMatch.readOnly) {
        const freehand = resolveFreehand(exactMatch.name, restText, tools!);
        if (freehand !== null) {
          onSend(freehand);
          resetAll();
          return;
        }
      }
      const pick = matches[Math.min(highlightIndex, matches.length - 1)];
      enterArgEntry(pick, restText);
      return;
    }
  }

  function handleArgEntryKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      resetAll();
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    if (selectedTool) {
      const args = buildArgsJson(selectedTool, argValues);
      onSend(buildCommand(selectedTool, args));
      resetAll();
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed);
    resetAll();
  }

  if (selectedTool) {
    const required = requiredArgNames(selectedTool);
    return (
      <form onSubmit={handleSubmit} className="border-t border-slate-200 bg-white p-3">
        <div onKeyDown={handleArgEntryKeyDown} className="flex flex-col gap-2 rounded-2xl border border-indigo-200 bg-indigo-50/40 p-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-sm font-medium text-indigo-700">/{selectedTool.name}</span>
            <button
              type="button"
              onClick={resetAll}
              className="text-xs text-slate-400 hover:text-slate-600"
            >
              Esc to cancel
            </button>
          </div>
          {selectedTool.args.map((arg, index) => (
            <input
              key={arg.name}
              value={argValues[arg.name] ?? ''}
              onChange={(e) => setArgValues((prev) => ({ ...prev, [arg.name]: e.target.value }))}
              placeholder={`${arg.name}${required.has(arg.name) ? '*' : ''}: ${arg.placeholder}`}
              disabled={disabled}
              autoFocus={index === 0}
              className="min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 disabled:bg-slate-50 disabled:text-slate-400"
            />
          ))}
          <button
            type="submit"
            disabled={disabled}
            className="self-end rounded-full bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Run
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="relative flex gap-2 border-t border-slate-200 bg-white p-3">
      {isSlashCommand && matches.length > 0 && (
        <div className="absolute bottom-full left-3 mb-2 max-h-64 w-[min(28rem,calc(100%-1.5rem))] overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-lg">
          {matches.map((tool, index) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              highlighted={index === highlightIndex}
              onPick={() => enterArgEntry(tool, restText)}
            />
          ))}
        </div>
      )}
      <input
        value={value}
        onChange={handleChange}
        onKeyDown={handleInputKeyDown}
        placeholder="Message... (/ for tools)"
        disabled={disabled}
        autoFocus
        className="min-w-0 flex-1 rounded-full border border-slate-300 px-4 py-2.5 text-[15px] outline-none focus:border-indigo-500 disabled:bg-slate-50 disabled:text-slate-400"
      />
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        className="rounded-full bg-indigo-600 px-5 py-2.5 text-[15px] font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        Send
      </button>
    </form>
  );
}
