import { describe, it, expect } from 'vitest';
import { matchTools, buildArgsJson, buildCommand, resolveFreehand } from '../src/lib/slashTools';
import type { ToolManifest } from '../src/types';

const CALCULATOR: ToolManifest = {
  name: 'calculator',
  description: 'Evaluate an expression',
  readOnly: true,
  args: [{ name: 'expression', type: 'string', required: true, description: 'expr', placeholder: '(2+3)*4' }],
};

const BASH: ToolManifest = {
  name: 'bash',
  description: 'Run a shell command',
  readOnly: false,
  args: [{ name: 'command', type: 'string', required: true, description: 'cmd', placeholder: 'ls -la' }],
};

const EDIT_FILE: ToolManifest = {
  name: 'edit_file',
  description: 'Edit a file',
  readOnly: false,
  args: [
    { name: 'path', type: 'string', required: true, description: 'path', placeholder: '/x' },
    { name: 'old_string', type: 'string', required: true, description: 'old', placeholder: 'old' },
    { name: 'new_string', type: 'string', required: true, description: 'new', placeholder: 'new' },
  ],
};

const SUBAGENT: ToolManifest = {
  name: 'subagent',
  description: 'Delegate a task',
  readOnly: false,
  args: [
    { name: 'task', type: 'string', required: true, description: 'task', placeholder: 'do x' },
    { name: 'context', type: 'string', required: false, description: 'ctx', placeholder: 'extra' },
    { name: 'tools', type: 'array', required: false, description: 'allowlist', placeholder: 'read_file, bash' },
  ],
};

const TOOLS = [CALCULATOR, BASH, EDIT_FILE, SUBAGENT];

describe('matchTools', () => {
  it('returns every tool for an empty token', () => {
    expect(matchTools('', TOOLS)).toEqual(TOOLS);
  });

  it('ranks prefix matches before substring-only matches', () => {
    const tools: ToolManifest[] = [
      { ...BASH, name: 'sub_bash' }, // substring match for "bash" only
      BASH, // prefix match for "bash"
    ];
    expect(matchTools('bash', tools).map((t) => t.name)).toEqual(['bash', 'sub_bash']);
  });

  it('is case-insensitive', () => {
    expect(matchTools('CALC', TOOLS)).toEqual([CALCULATOR]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(matchTools('zzz', TOOLS)).toEqual([]);
  });
});

describe('buildArgsJson', () => {
  it('includes only non-empty string args, trimmed', () => {
    expect(buildArgsJson(CALCULATOR, { expression: '  (2+3)*4  ' })).toEqual({ expression: '(2+3)*4' });
  });

  it('omits an arg entirely when its value is empty or missing (accepted incomplete call)', () => {
    expect(buildArgsJson(EDIT_FILE, { path: '/x', old_string: '', new_string: 'n' })).toEqual({
      path: '/x',
      new_string: 'n',
    });
    expect(buildArgsJson(CALCULATOR, {})).toEqual({});
  });

  it('splits an array-typed arg on commas, trimming and dropping empty entries', () => {
    expect(buildArgsJson(SUBAGENT, { task: 'do it', tools: 'read_file, bash ,, write_file' })).toEqual({
      task: 'do it',
      tools: ['read_file', 'bash', 'write_file'],
    });
  });

  it('omits an array-typed arg entirely if it resolves to zero items', () => {
    expect(buildArgsJson(SUBAGENT, { task: 'do it', tools: ' , , ' })).toEqual({ task: 'do it' });
  });
});

describe('buildCommand', () => {
  it('builds a bare "/name" when no args are present', () => {
    expect(buildCommand(CALCULATOR, {})).toBe('/calculator');
  });

  it('builds "/name {json}" when any arg is present', () => {
    expect(buildCommand(CALCULATOR, { expression: '1+1' })).toBe('/calculator {"expression":"1+1"}');
  });
});

describe('resolveFreehand', () => {
  it('sends the trailing text raw for a single-arg tool', () => {
    expect(resolveFreehand('calculator', '(2 + 3) * 4', TOOLS)).toBe('/calculator (2 + 3) * 4');
  });

  it('sends a bare "/name" when the trailing text is empty for a single-arg tool', () => {
    expect(resolveFreehand('calculator', '', TOOLS)).toBe('/calculator');
    expect(resolveFreehand('calculator', '   ', TOOLS)).toBe('/calculator');
  });

  it('returns null for a multi-arg tool - no unambiguous single-string mapping', () => {
    expect(resolveFreehand('edit_file', 'foo.txt old new', TOOLS)).toBeNull();
    expect(resolveFreehand('subagent', 'do something', TOOLS)).toBeNull();
  });

  it('returns null for a tool name not found in the given list', () => {
    expect(resolveFreehand('not_a_tool', 'x', TOOLS)).toBeNull();
  });
});
