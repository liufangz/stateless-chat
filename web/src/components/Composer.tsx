import { useState } from 'react';
import type { FormEvent } from 'react';

interface ComposerProps {
  onSend: (content: string) => void;
  disabled?: boolean;
}

export function Composer({ onSend, disabled }: ComposerProps) {
  const [value, setValue] = useState('');

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 border-t border-slate-200 bg-white p-3">
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Message..."
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
