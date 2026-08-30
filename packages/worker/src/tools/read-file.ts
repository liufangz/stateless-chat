import { promises as fs } from "node:fs";
import type { Tool } from "../tool-loop.js";
import { REPO_ROOT } from "./bash.js";
import { resolveReadPath, type PathJailRoots } from "./file-path-jail.js";

const MAX_LINES = 200;
const MAX_CHARS = 4000;

interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "chars" | null;
  outputLines: number;
}

function truncateHead(content: string): TruncationResult {
  const lines = content.length === 0 ? [] : content.split("\n");
  if (lines.length <= MAX_LINES && content.length <= MAX_CHARS) {
    return { content, truncated: false, truncatedBy: null, outputLines: lines.length };
  }

  const kept: string[] = [];
  let charCount = 0;
  let truncatedBy: "lines" | "chars" = "lines";
  for (let i = 0; i < lines.length && i < MAX_LINES; i++) {
    const line = lines[i];
    const lineChars = line.length + (i > 0 ? 1 : 0);
    if (charCount + lineChars > MAX_CHARS) {
      truncatedBy = "chars";
      break;
    }
    kept.push(line);
    charCount += lineChars;
  }
  if (kept.length >= MAX_LINES && charCount <= MAX_CHARS) truncatedBy = "lines";

  return { content: kept.join("\n"), truncated: true, truncatedBy, outputLines: kept.length };
}

export interface ReadFileToolOptions {
  roots?: PathJailRoots;
}

export function createReadFileTool(options?: ReadFileToolOptions): Tool {
  const roots = options?.roots ?? { repoRoot: REPO_ROOT };

  return {
    name: "read_file",
    description:
      `Read a text file's contents. Output is truncated to ${MAX_LINES} lines or ${MAX_CHARS} chars, ` +
      "whichever is hit first. Use offset/limit to page through a large file.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "File path. Relative paths resolve under the project root; absolute paths under the " +
            "project root (or the /repo/ sandbox alias) are also accepted.",
        },
        offset: { type: "number", description: "1-indexed line to start reading from" },
        limit: { type: "number", description: "Max number of lines to read" },
      },
      required: ["path"],
    },
    async execute(args: unknown): Promise<string> {
      const { path: rawPath, offset, limit } = (args ?? {}) as {
        path?: unknown;
        offset?: unknown;
        limit?: unknown;
      };
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        throw new Error("read_file requires a non-empty 'path' string");
      }
      if (offset !== undefined && (typeof offset !== "number" || !Number.isFinite(offset))) {
        throw new Error("read_file 'offset' must be a number");
      }
      if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit))) {
        throw new Error("read_file 'limit' must be a number");
      }

      const realPath = await resolveReadPath(rawPath, roots);
      const buffer = await fs.readFile(realPath);
      const content = buffer.toString("utf-8");
      const allLines = content.split("\n");
      const totalFileLines = allLines.length;

      const startLine = offset ? Math.max(0, offset - 1) : 0;
      if (startLine >= allLines.length) {
        throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
      }
      const startLineDisplay = startLine + 1;

      let selected: string;
      let userLimitedLines: number | undefined;
      if (limit !== undefined) {
        const endLine = Math.min(startLine + limit, allLines.length);
        selected = allLines.slice(startLine, endLine).join("\n");
        userLimitedLines = endLine - startLine;
      } else {
        selected = allLines.slice(startLine).join("\n");
      }

      const truncation = truncateHead(selected);
      const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
      // Untrusted-content delimiter: a file under the project root could contain text
      // engineered to look like tool-call instructions, so wrap it explicitly before it
      // re-enters the conversation. The continuation-hint suffix below is tool metadata,
      // not file content, so it stays outside the delimiter.
      const wrapped = `<file path="${rawPath}" lines="${startLineDisplay}-${endLineDisplay}">\n${truncation.content}\n</file>`;

      if (truncation.truncated) {
        const nextOffset = endLineDisplay + 1;
        const suffix =
          truncation.truncatedBy === "lines"
            ? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
            : `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${MAX_CHARS} char limit). Use offset=${nextOffset} to continue.]`;
        return wrapped + suffix;
      }

      if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        const remaining = allLines.length - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        return `${wrapped}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      }

      return wrapped;
    },
  };
}

export const READ_FILE_TOOL: Tool = createReadFileTool();
