import { env } from "@stateless-chat/shared";
import type { Tool } from "../tool-loop.js";
import { getCurrentDatetimeTool } from "./datetime.js";
import { calculatorTool } from "./calculator.js";
import { BASH_TOOL } from "./bash.js";
import { READ_FILE_TOOL } from "./read-file.js";
import { WRITE_FILE_TOOL } from "./write-file.js";
import { EDIT_FILE_TOOL } from "./edit-file.js";
import { SUBAGENT_TOOL_NAME, createSubagentTool } from "./subagent.js";

export { getCurrentDatetimeTool } from "./datetime.js";
export { calculatorTool, evaluateExpression } from "./calculator.js";
export { BASH_TOOL, createBashTool, buildBashExecArgs, runBash } from "./bash.js";
export { READ_FILE_TOOL, createReadFileTool } from "./read-file.js";
export { WRITE_FILE_TOOL, createWriteFileTool } from "./write-file.js";
export { EDIT_FILE_TOOL, createEditFileTool } from "./edit-file.js";
export { resolveReadPath, resolveWritePath, canonicalLockKey, type PathJailRoots } from "./file-path-jail.js";
export { createPostgresFileLock, withFileLock, type FileLock } from "./file-lock.js";
export { SUBAGENT_TOOL_NAME, createSubagentTool } from "./subagent.js";

/**
 * Static, unbound subagent: no parent lifecycle (its events go nowhere) and
 * no parent client. The worker's runToolLoop replaces this entry per run
 * with a run-bound subagent (parent lifecycle + client + deadline slice) -
 * see buildRunTools in tool-loop.ts. Kept here so DEFAULT_TOOLS is always
 * complete and self-contained for tests and crash recovery.
 */
export const DEFAULT_SUBAGENT_TOOL = createSubagentTool();

export const DEFAULT_TOOLS: Tool[] = [
  getCurrentDatetimeTool,
  calculatorTool,
  ...(env.toolBashEnabled ? [BASH_TOOL] : []),
  ...(env.toolReadFileEnabled ? [READ_FILE_TOOL] : []),
  ...(env.toolWriteFileEnabled ? [WRITE_FILE_TOOL] : []),
  ...(env.toolEditFileEnabled ? [EDIT_FILE_TOOL] : []),
  DEFAULT_SUBAGENT_TOOL,
];
