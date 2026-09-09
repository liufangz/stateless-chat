// Slash-invoked tools (docs/FEATURE-slash-tools.md): a pure, dependency-free
// manifest describing every tool the worker CAN run, independent of whether
// this deployment's env flags currently enable it. No `execute`, no host
// imports - safe for the gateway (which never touches host resources) to
// import directly.
//
// Worker tool files (packages/worker/src/tools/*.ts) import their own entry
// from TOOL_MANIFESTS and build their JSON-Schema `parameters` from it via
// `manifestToJsonSchema` - that's what keeps the manifest and the real tool
// definitions from drifting apart, rather than being two hand-maintained
// copies of the same argument list. See packages/worker/test/tool-manifests.test.ts
// for the guard that fails loudly if a tool file and this manifest disagree
// on name/args anyway (e.g. a tool file edited without updating this file).

export interface ToolArgManifest {
  /** Must match the worker tool's JSON-Schema parameter property name. */
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  required: boolean;
  /** Shown in the composer's arg-entry field and sent to the LLM as the JSON-Schema property description. */
  description: string;
  /** Concrete example shown as the arg field's placeholder text. */
  placeholder: string;
}

export interface ToolManifest {
  name: string;
  /** Sent to the LLM as the tool's function-calling description, and shown (CSS-truncated to one line) in the slash picker. */
  description: string;
  /**
   * Mirrors the worker Tool's own `readOnly` flag (tool-loop.ts) - true for
   * a tool with no side effect outside the DB rows this feature itself
   * writes. The composer uses this to decide whether typing "/name args"
   * and hitting Enter may submit immediately (read-only) or must go through
   * the explicit arg-entry step first (mutating) - see
   * docs/FEATURE-slash-tools.md §4.4/§6 on why the wire format alone can't
   * tell "talking about bash" from "invoking bash".
   */
  readOnly: boolean;
  args: ToolArgManifest[];
}

export const TOOL_MANIFESTS: ToolManifest[] = [
  {
    name: "get_current_datetime",
    description: "Get the current date and time, optionally formatted for a specific IANA timezone.",
    readOnly: true,
    args: [
      {
        name: "timezone",
        type: "string",
        required: false,
        description: "IANA timezone name, e.g. 'America/New_York'. Defaults to UTC when omitted.",
        placeholder: "America/New_York",
      },
    ],
  },
  {
    name: "calculator",
    description: "Evaluate a basic arithmetic expression. Supports + - * / ^ (power), sqrt(), and parentheses.",
    readOnly: true,
    args: [
      {
        name: "expression",
        type: "string",
        required: true,
        description: "Arithmetic expression, e.g. '(2 + 3) * 4' or 'sqrt(16)'",
        placeholder: "(2 + 3) * 4",
      },
    ],
  },
  {
    name: "bash",
    description:
      "Run an unrestricted shell command on the host as ubuntu. This is NOT a sandbox: " +
      "ubuntu has passwordless sudo/docker access and commands may read or modify the " +
      "entire machine, not just /home/ubuntu. Default cwd and HOME: /home/ubuntu.",
    readOnly: false,
    args: [
      {
        name: "command",
        type: "string",
        required: true,
        description: "Shell command to run (bash) on the host",
        placeholder: "ls -la /home/ubuntu",
      },
    ],
  },
  {
    name: "read_file",
    description:
      "Read any text file under /home/ubuntu. Output is truncated to 200 lines or 4000 chars, " +
      "whichever is hit first. Use offset/limit to page through a large file. Dotfiles, credentials, " +
      "repository metadata, and files in any project are accessible in full-host mode.",
    readOnly: true,
    args: [
      {
        name: "path",
        type: "string",
        required: true,
        description:
          "File path. Relative paths resolve under /home/ubuntu; absolute paths under /home/ubuntu " +
          "are accepted. /repo/... is a legacy alias for /home/ubuntu/....",
        placeholder: "/home/ubuntu/README.md",
      },
      {
        name: "offset",
        type: "number",
        required: false,
        description: "1-indexed line to start reading from",
        placeholder: "1",
      },
      {
        name: "limit",
        type: "number",
        required: false,
        description: "Max number of lines to read",
        placeholder: "200",
      },
    ],
  },
  {
    name: "write_file",
    description:
      "Write content to any file under /home/ubuntu, creating parent directories as needed. " +
      "Overwrites the file if it already exists, including dotfiles, .env, .git, node_modules, " +
      "and files belonging to any project. " +
      "Coordinates with other in-flight write_file/edit_file calls (including from other worker " +
      "processes) via a shared lock, so two concurrent writers to the same path never interleave. " +
      "To safely overwrite a file you have already read, pass 'expected_hash' (the sha256 hex digest " +
      "of the content you read) - if the file has changed since then, the write is rejected instead " +
      "of silently discarding whoever changed it. Omit 'expected_hash' when creating a new file, or " +
      "when you intentionally want to overwrite unconditionally.",
    readOnly: false,
    args: [
      {
        name: "path",
        type: "string",
        required: true,
        description:
          "File path under /home/ubuntu. Relative paths resolve there; absolute paths under /home/ubuntu " +
          "are accepted. /repo/... is a legacy alias for /home/ubuntu/.... No filename class is " +
          "blocked inside the allowed root.",
        placeholder: "/home/ubuntu/notes.txt",
      },
      {
        name: "content",
        type: "string",
        required: true,
        description: "Full file content (overwrites if the file exists)",
        placeholder: "hello world",
      },
      {
        name: "expected_hash",
        type: "string",
        required: false,
        description:
          "Optional sha256 hex digest of the file's current content, as it was when you last read it. " +
          "Only checked when the file already exists. If the file's actual current content doesn't " +
          "match, the write fails clearly instead of discarding a change made since your last read.",
        placeholder: "sha256 hex digest",
      },
    ],
  },
  {
    name: "edit_file",
    description:
      "Edit any file under /home/ubuntu by replacing exact text. 'old_string' must match the file's " +
      "content exactly once. Dotfiles, .env, .git, node_modules, and files in any project are included. " +
      "Coordinates with other in-flight write_file/edit_file calls (including " +
      "from other worker processes) via a shared lock: the file is re-read fresh once the lock is " +
      "held, so if its content changed since you last saw it, 'old_string' simply won't match anymore " +
      "and this fails clearly instead of applying against stale content.",
    readOnly: false,
    args: [
      {
        name: "path",
        type: "string",
        required: true,
        description: "File path under /home/ubuntu (same rules as write_file)",
        placeholder: "/home/ubuntu/notes.txt",
      },
      {
        name: "old_string",
        type: "string",
        required: true,
        description: "Exact text to replace. Must match exactly once in the file.",
        placeholder: "old text",
      },
      {
        name: "new_string",
        type: "string",
        required: true,
        description: "Replacement text",
        placeholder: "new text",
      },
    ],
  },
  {
    name: "subagent",
    description:
      "Delegate a self-contained task to a subagent that runs its own tool loop " +
      "and returns a complete written answer. The `task` argument MUST include ALL " +
      "context the subagent needs - it has no access to this conversation's history " +
      "or your other tool results. Only the final answer text comes back to you, so " +
      "instruct the subagent to return everything you need in its answer. The optional " +
      "`tools` argument restricts which tools the subagent may use; omit it for the " +
      "full tool set (the subagent tool itself is never available to a subagent, so " +
      "nesting cannot recurse infinitely).",
    readOnly: false,
    args: [
      {
        name: "task",
        type: "string",
        required: true,
        description:
          "Self-contained instruction for the subagent, including all context it needs. " +
          "Ask for a complete, self-contained final answer.",
        placeholder: "Summarize this repo's README in 3 bullets",
      },
      {
        name: "context",
        type: "string",
        required: false,
        description: "Optional extra context appended to the task (e.g. file excerpts, findings).",
        placeholder: "File excerpts or prior findings to hand the subagent",
      },
      {
        name: "tools",
        type: "array",
        required: false,
        description:
          'Optional allowlist of tool names the subagent may use, e.g. ["read_file", "bash"]. ' +
          "Omit to allow all non-subagent tools.",
        placeholder: "read_file, bash",
      },
    ],
  },
];

/** Tools with no env gate - always part of DEFAULT_TOOLS regardless of deployment config. */
const ALWAYS_ENABLED_TOOLS = new Set(["get_current_datetime", "calculator", "subagent"]);

/**
 * Maps a gated tool's manifest name to the env flag that enables it -
 * exactly the flags DEFAULT_TOOLS checks (packages/worker/src/tools/index.ts).
 * `envLike` is deliberately structural (not `typeof env`) so the gateway,
 * which never needs the rest of `env`'s required-secret fields, can pass a
 * plain object built from process.env or a test fake without pulling in
 * env.ts's `required()` throws.
 */
const ENV_FLAG_BY_TOOL: Record<string, string> = {
  bash: "toolBashEnabled",
  read_file: "toolReadFileEnabled",
  write_file: "toolWriteFileEnabled",
  edit_file: "toolEditFileEnabled",
};

// `Record<string, unknown>` (not `Record<string, boolean>`): callers pass
// the real `env` object (gateway's route, worker's DEFAULT_TOOLS), which has
// plenty of non-boolean fields (openaiApiKey, gatewayPort, ...) alongside
// the tool flags - only `=== true` is ever checked below, so the extra
// fields are simply ignored rather than needing an exact-shape argument.
export function toolEnabled(name: string, envLike: Record<string, unknown>): boolean {
  if (ALWAYS_ENABLED_TOOLS.has(name)) return true;
  const flag = ENV_FLAG_BY_TOOL[name];
  return flag !== undefined && envLike[flag] === true;
}

/** The manifests whose env flag is currently on, in TOOL_MANIFESTS order. */
export function enabledToolManifests(envLike: Record<string, unknown>): ToolManifest[] {
  return TOOL_MANIFESTS.filter((m) => toolEnabled(m.name, envLike));
}

/**
 * Builds a worker Tool's JSON-Schema `parameters` from its manifest entry -
 * the single source of truth a tool file's `parameters` is derived from, so
 * the manifest (UI-facing) and the real function-calling schema (LLM-facing)
 * cannot independently drift. `array`-typed args are always an array of
 * strings (the only shape any current tool needs - see subagent's `tools`
 * arg); extend here if a future tool needs a different item type.
 */
export function manifestToJsonSchema(manifest: ToolManifest): {
  type: "object";
  properties: Record<string, { type: string; description: string; items?: { type: string } }>;
  required: string[];
} {
  const properties: Record<string, { type: string; description: string; items?: { type: string } }> = {};
  for (const arg of manifest.args) {
    properties[arg.name] =
      arg.type === "array"
        ? { type: "array", items: { type: "string" }, description: arg.description }
        : { type: arg.type, description: arg.description };
  }
  return {
    type: "object",
    properties,
    required: manifest.args.filter((a) => a.required).map((a) => a.name),
  };
}
