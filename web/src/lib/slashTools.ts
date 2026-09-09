// Slash-invoked tools (docs/FEATURE-slash-tools.md §4.4): pure, UI-free
// helpers the Composer's slash-picker state machine builds on. No React
// here so these are trivial to unit test directly.
import type { ToolManifest } from '../types';

/**
 * Filters `tools` for the dropdown as the user types after `/`. Prefix
 * matches (the common case - typing a tool's name from the start) sort
 * before substring-only matches, both case-insensitive; ties keep
 * TOOL_MANIFESTS order. An empty token matches every tool (the freshly
 * opened, unfiltered list).
 */
export function matchTools(token: string, tools: ToolManifest[]): ToolManifest[] {
  const needle = token.toLowerCase();
  if (needle === '') return tools;

  const prefixMatches: ToolManifest[] = [];
  const substringMatches: ToolManifest[] = [];
  for (const tool of tools) {
    const name = tool.name.toLowerCase();
    if (name.startsWith(needle)) {
      prefixMatches.push(tool);
    } else if (name.includes(needle)) {
      substringMatches.push(tool);
    }
  }
  return [...prefixMatches, ...substringMatches];
}

/**
 * Builds the args object the command carries, from the arg-entry form's raw
 * string values. Every arg type serializes its typed text as-is EXCEPT
 * `array`, which splits on commas and trims/drops empty entries (the only
 * array-typed arg today, subagent's `tools`, is a list of tool names - see
 * packages/shared/src/tools.ts's "Arg-value serialization" note). An empty
 * value (after trim) is omitted entirely, whether or not the arg is
 * required - a missing required arg is an accepted call per spec §1.5, not
 * something this layer needs to block.
 */
export function buildArgsJson(tool: ToolManifest, values: Record<string, string>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of tool.args) {
    const raw = (values[arg.name] ?? '').trim();
    if (raw === '') continue;
    if (arg.type === 'array') {
      const items = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      if (items.length > 0) args[arg.name] = items;
    } else {
      args[arg.name] = raw;
    }
  }
  return args;
}

/** Builds the literal command text sent as the message: `/name` alone when no arg has a value, else `/name {json}`. */
export function buildCommand(tool: ToolManifest, args: Record<string, unknown>): string {
  return Object.keys(args).length === 0 ? `/${tool.name}` : `/${tool.name} ${JSON.stringify(args)}`;
}

/**
 * Resolves what typing `/name rest` and hitting Enter directly (no popup)
 * should send, for a bound tool found by name. A single-arg tool sends the
 * trailing text raw (the worker's own resolveDirectArgs applies the same
 * single-arg shorthand server-side, so this only needs to match what the
 * server will do with the text as typed - it doesn't need to pre-encode
 * anything). A multi-arg tool has no unambiguous single-string mapping, so
 * this returns null for it - the caller (Composer) opens the arg-entry
 * popup instead rather than guessing which text goes in which field.
 */
export function resolveFreehand(toolName: string, rest: string, tools: ToolManifest[]): string | null {
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) return null;
  if (tool.args.length > 1) return null;
  return rest.trim() === '' ? `/${tool.name}` : `/${tool.name} ${rest.trim()}`;
}
